using System;
using System.Buffers;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using Microsoft.Diagnostics.Runtime;

namespace Bitmat.GameReader
{
    // Reads what's around the player straight from the running game's memory (read-only, with Microsoft's ClrMD) and
    // prints it as one JSON line a tick, for the bot to use instead of reading the screen: the C# port of what
    // reader-legacy.ps1 did field by field from PowerShell (whose binder made every read slow). reader.ps1 compiles
    // this and calls Run. Every key, fallback and quirk follows reader-legacy.ps1, which stays the specification.
    public static class Reader
    {
        // A tick's read failing this many times in a row, TickRetryMs apart (the game moving memory mid-read: "object
        // is corrupted"), attaches afresh.
        private const int TickRetries = 12;
        private const int TickRetryMs = 50;

        // Reads go straight to the game's live memory; it's attached afresh this often all the same.
        private const int AttachSeconds = 30;

        // BITMAT_READER_TRACE=1: each failed read, with where it failed, goes to stderr (the bot ignores stderr).
        private static readonly bool Trace = Environment.GetEnvironmentVariable("BITMAT_READER_TRACE") == "1";

        public static void Run(int intervalMs, int parentPid)
        {
            Output output = new Output(parentPid);
            ReaderState state = new ReaderState();
            int attachedTo = 0;
            while (true)
            {
                Process[] running = Process.GetProcessesByName("Xtreme");
                Process game = running.FirstOrDefault();
                for (int i = 1; i < running.Length; i++) running[i].Dispose();
                if (game == null)
                {
                    output.Status("Game not running");
                    Thread.Sleep(2000);
                    continue;
                }
                DataTarget target = null;
                try
                {
                    // The walls are sent again for a game started afresh (the old reader sent them on every attach).
                    if (game.Id != attachedTo) state.WallsSent = null;
                    attachedTo = game.Id;
                    target = DataTarget.AttachToProcess(game.Id, false);
                    ClrRuntime runtime = target.ClrVersions[0].CreateRuntime();
                    Session session = new Session(runtime, state);
                    Stopwatch attachedAt = Stopwatch.StartNew();
                    // When the next tick is due: an interval after the last was due, so time lost oversleeping is made
                    // up (but never by more than a tick at once).
                    long due = 0;
                    int failed = 0;
                    while (!game.HasExited && attachedAt.Elapsed.TotalSeconds < AttachSeconds)
                    {
                        int left = (int)(due - attachedAt.ElapsedMilliseconds);
                        if (left > 0) Thread.Sleep(left);
                        long start = attachedAt.ElapsedMilliseconds;
                        try
                        {
                            session.Tick(output);
                            failed = 0;
                        }
                        catch (Exception e)
                        {
                            if (Trace) Console.Error.WriteLine($"{DateTime.Now:HH:mm:ss.fff} tick {failed + 1} failed: {e}");
                            // One bad read (the game moving memory mid-read) skips the tick; only several in a row attach afresh.
                            if (++failed >= TickRetries) throw;
                            if (failed == 1)
                            {
                                // Most often it's objects the game has made in memory it took since the attach, which ClrMD
                                // doesn't know of yet ("object is corrupted, could not determine type"): having it forget
                                // what it knew of the game's memory and heap (and the types and fields looked up from that)
                                // reads them at once (a few ms), without the dozen failed ticks and the attach afresh that
                                // took before (over a second without a reading).
                                target.DataReader.FlushCachedData();
                                runtime.FlushCachedData();
                                session = new Session(runtime, state);
                                due = start;
                                continue;
                            }
                            due = start + TickRetryMs;
                            continue;
                        }
                        // A tick every intervalMs, from the start of one to the start of the next.
                        due = Math.Max(due + intervalMs, start);
                    }
                }
                catch (Exception e)
                {
                    output.Status("Reader error: " + e.Message);
                    Thread.Sleep(500);
                }
                finally
                {
                    target?.Dispose();
                    game.Dispose();
                    // Hand back what the last attach used: hours of re-attaching otherwise let the reader grow to a gigabyte or more.
                    GC.Collect();
                }
            }
        }
    }

    // Lines to stdout: each tick's reading is written into a buffer first and printed whole once it's complete, so a
    // tick that fails halfway prints nothing. Ends the reader once the bot that started it has gone (checked about
    // once a second, as each line goes out).
    internal sealed class Output
    {
        private readonly Stream stdout = Console.OpenStandardOutput();
        private readonly ArrayBufferWriter<byte> buffer = new ArrayBufferWriter<byte>(256 * 1024);
        private readonly int parentPid;
        private readonly Stopwatch parentCheck = Stopwatch.StartNew();
        public readonly Utf8JsonWriter Writer;
        public static readonly JsonWriterOptions WriterOptions = new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, SkipValidation = true };
        public static readonly JsonSerializerOptions NodeOptions = new JsonSerializerOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

        public Output(int parentPid)
        {
            this.parentPid = parentPid;
            Writer = new Utf8JsonWriter(buffer, WriterOptions);
        }

        public Utf8JsonWriter Begin()
        {
            buffer.ResetWrittenCount();
            Writer.Reset(buffer);
            return Writer;
        }

        public void End()
        {
            Writer.Flush();
            ExitIfOrphaned();
            stdout.Write(buffer.WrittenSpan);
            stdout.WriteByte((byte)'\n');
            stdout.Flush();
        }

        // { inGame: false, reason }: the game isn't running, not in game, or the reader failed.
        public void Status(string reason)
        {
            Utf8JsonWriter w = Begin();
            w.WriteStartObject();
            w.WriteBoolean("inGame", false);
            w.WriteString("reason", reason);
            w.WriteEndObject();
            End();
        }

        private void ExitIfOrphaned()
        {
            if (parentPid <= 0 || parentCheck.ElapsedMilliseconds < 1000) return;
            parentCheck.Restart();
            try
            {
                using (Process parent = Process.GetProcessById(parentPid))
                {
                    if (!parent.HasExited) return;
                }
            }
            catch (Exception)
            {
                // Not running (or no longer ours to see).
            }
            Environment.Exit(0);
        }
    }

    // What lasts from one attach to the next: the rarely changing parts (re-sent on every line), the walls and
    // exploration sent so far, and the UI scale.
    internal sealed class ReaderState
    {
        // The rarely changing parts, rendered once when read and re-sent as they are (null: JSON null).
        public byte[] QuestTargets, QuestLog, QuestPending, Gear, Known, Professions, Bloodline, AutoPotion;
        // The part read on the next slow tick, and since when the last round started.
        public int SlowNext;
        public Stopwatch SlowAt;

        // The walls and exploration sent (see Session.ReadMap).
        public string WallsSent, WallsLast, ExploredSent;
        public Stopwatch WallsAt;
        public int WallsChecks;

        // How much the game scales its windows and buttons (RenderingPipelineManager._displayScale): 1 at 1600x900, 1.5
        // at 2560x1440. Controls are laid out unscaled; the map isn't scaled. Set each tick from the game.
        public double UiScale = 1.0;

        // The character's class as a Library.RequiredClass flag, for set bonuses (Session.ReadItemSet).
        public long ClassFlag;

        public static byte[] Render(JsonNode node) => node == null ? null : JsonSerializer.SerializeToUtf8Bytes(node, Output.NodeOptions);
    }
}

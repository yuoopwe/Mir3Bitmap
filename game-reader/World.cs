using System;
using System.Buffers;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Diagnostics.Runtime;

namespace Bitmat.GameReader
{
    // One attach to the game: its runtime, the static fields read from, what's been looked up once (types, the
    // scene's window fields, the Triple Triad cards), and the tick that reads and writes one line.
    internal sealed partial class Session
    {
        // Library.Stat numbers.
        private const int HealthStat = 2;
        private const int ManaStat = 3;
        // How far (in tiles) clicking at the feet picks things up.
        private const int PickUpRadiusStat = 40;
        // The trackers (an item or a scroll) that put elites, bosses and behemoths anywhere on the map on its markers.
        private const int BossTrackerStat = 88;
        private const int EliteTrackerStat = 20108;
        private const int BehemothTrackerStat = 20109;
        // The most weight that may be worn on the body and in hand.
        private const int WearWeightStat = 74;
        private const int HandWeightStat = 75;
        // The stats that decide how fast the character kills and how much it takes, by the names the bot reads them by.
        private static readonly string[] CombatNames = { "minAC", "maxAC", "minMR", "maxMR", "minDC", "maxDC", "minMC", "maxMC", "minSC", "maxSC", "accuracy", "agility", "attackSpeed" };
        private static readonly int[] CombatStats = { 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 };
        // The % stats, which multiply what they're for (HealthPercent 54, MCPercent 67, DCPercent 84, SCPercent 85,
        // MagicDefencePercent 92, PhysicalDefencePercent 93, ManaPercent 94, ACPercent 10031, MRPercent 10032).
        private static readonly int[] PercentStats = { 54, 67, 84, 85, 92, 93, 94, 10031, 10032 };

        // Objects further than this (in tiles, either way) from the player aren't sent, NPCs apart: on a crowded map (300
        // and more monsters) reading and sending them all made readings come too late. The screen shows about 27 either
        // way at 2560x1440.
        private const int ObjectRange = 40;

        private const string UserType = "Client.Models.UserObject";
        private const string NpcType = "Client.Models.NPCObject";
        private static readonly Dictionary<string, string> Kinds = new Dictionary<string, string>
        {
            ["Client.Models.MonsterObject"] = "monster", ["Client.Models.ItemObject"] = "item", ["Client.Models.PlayerObject"] = "player",
            ["Client.Models.NPCObject"] = "npc", ["Client.Models.GatheringNodeObject"] = "node",
        };

        private readonly ClrRuntime runtime;
        private readonly ClrAppDomain domain;
        private readonly ClrModule module;
        private readonly ReaderState state;
        private readonly ClrStaticField sceneField, uiScaleField;
        // The player's own stats, read once a tick (stat number -> value).
        private readonly Dictionary<int, int> userStats = new Dictionary<int, int>();
        // The player, written apart while the objects are (the last UserObject in the list is the one sent).
        private readonly ArrayBufferWriter<byte> userBuffer = new ArrayBufferWriter<byte>(4096);
        private readonly Utf8JsonWriter userWriter;

        public Session(ClrRuntime runtime, ReaderState state)
        {
            this.runtime = runtime;
            this.state = state;
            Mem.Cache = new FieldCache();
            domain = runtime.AppDomains[0];
            module = runtime.EnumerateModules().FirstOrDefault(m => m.Name != null && m.Name.EndsWith("Xtreme.dll", StringComparison.OrdinalIgnoreCase));
            if (module == null) throw new InvalidOperationException("the game's module (Xtreme.dll) isn't loaded");
            ClrType gameScene = module.GetTypeByName("Client.Scenes.GameScene");
            if (gameScene == null) throw new InvalidOperationException("the game's GameScene type wasn't found");
            sceneField = gameScene.GetStaticFieldByName("Game");
            uiScaleField = module.GetTypeByName("Client.Rendering.RenderingPipelineManager")?.GetStaticFieldByName("_displayScale");
            userWriter = new Utf8JsonWriter(userBuffer, Output.WriterOptions);
        }

        private ClrStaticField Static(string type, string field)
        {
            ClrStaticField found = module.GetTypeByName(type)?.GetStaticFieldByName(field);
            if (found == null) throw new InvalidOperationException($"{type}.{field} wasn't found");
            return found;
        }

        // One reading: everything around the player, as one JSON line.
        public void Tick(Output output)
        {
            ClrObject scene = sceneField.ReadObject(domain);
            try
            {
                float k = uiScaleField != null ? uiScaleField.Read<float>(domain) : 0;
                state.UiScale = k > 0 ? k : 1.0;
            }
            catch (Exception)
            {
                state.UiScale = 1.0;
            }
            if (scene.IsNull)
            {
                output.Status("Not in game");
                return;
            }
            Utf8JsonWriter w = output.Begin();
            w.WriteStartObject();
            bool hasUser = WriteObjects(w, scene);
            w.WritePropertyName("user");
            if (hasUser) w.WriteRawValue(userBuffer.WrittenSpan, true);
            else w.WriteNullValue();
            w.WriteBoolean("inGame", hasUser);

            JsonNode triad, collection, map, waypoints, windows, view = null;
            try { triad = ReadTriad(scene); } catch (Exception e) { triad = new JsonObject { ["open"] = true, ["error"] = e.Message }; }
            try { collection = ReadCollection(scene); } catch (Exception e) { collection = new JsonObject { ["error"] = e.Message }; }
            try { map = ReadMap(scene); } catch (Exception) { map = null; state.WallsSent = null; }
            try { waypoints = ReadWaypoints(scene); } catch (Exception e) { waypoints = new JsonObject { ["error"] = e.Message }; }
            try { windows = ReadWindows(scene); } catch (Exception) { windows = null; windowFields = null; }
            ReadSlowPart(scene);
            JsonObject survival = null;
            try { survival = ReadSurvival(scene); } catch (Exception) { }
            if (survival != null)
            {
                try { survival["messages"] = ReadMessageBoxes(); } catch (Exception) { }
            }
            try { view = ReadView(); } catch (Exception) { }

            Write(w, "triad", triad);
            Write(w, "collection", collection);
            Write(w, "map", map);
            Write(w, "waypoints", waypoints);
            Write(w, "windows", windows);
            WriteRaw(w, "questTargets", state.QuestTargets);
            WriteRaw(w, "questLog", state.QuestLog);
            WriteRaw(w, "questPending", state.QuestPending);
            Write(w, "view", view);
            WriteRaw(w, "professions", state.Professions);
            WriteRaw(w, "gear", state.Gear);
            WriteRaw(w, "bloodline", state.Bloodline);
            WriteRaw(w, "autoPotion", state.AutoPotion);
            WriteRaw(w, "known", state.Known);
            Write(w, "survival", survival);
            w.WriteEndObject();
            output.End();
        }

        private static void Write(Utf8JsonWriter w, string name, JsonNode node)
        {
            w.WritePropertyName(name);
            if (node == null) w.WriteNullValue();
            else node.WriteTo(w);
        }

        private static void WriteRaw(Utf8JsonWriter w, string name, byte[] json)
        {
            w.WritePropertyName(name);
            if (json == null) w.WriteNullValue();
            else w.WriteRawValue(json, true);
        }

        // What changes rarely (the quest log, the bag...) is read about once a second, one part a tick: all of them in
        // one tick made that reading come late. The last of each is re-sent on every line.
        private void ReadSlowPart(ClrObject scene)
        {
            if (state.SlowAt != null && state.SlowAt.ElapsedMilliseconds <= 1000 && state.SlowNext == 0) return;
            switch (state.SlowNext)
            {
                case 0:
                    // Pending tasks go out as far as they were read, a failure or not (as the old reader's did).
                    JsonObject pending = new JsonObject { ["regions"] = new JsonArray(), ["talks"] = new JsonArray() };
                    try
                    {
                        ReadQuestTargets(scene, pending, out JsonArray targets, out JsonArray log);
                        state.QuestTargets = ReaderState.Render(targets);
                        state.QuestLog = ReaderState.Render(log);
                    }
                    catch (Exception)
                    {
                        state.QuestTargets = null;
                        state.QuestLog = null;
                    }
                    state.QuestPending = ReaderState.Render(pending);
                    break;
                case 1: state.Gear = Slow(() => ReadGear(scene)); break;
                case 2: state.Known = Slow(() => ReadKnown(scene)); break;
                case 3: state.Professions = Slow(() => ReadProfessions(scene)); break;
                case 4: state.Bloodline = Slow(() => ReadBloodline(scene)); break;
                case 5: state.AutoPotion = Slow(() => ReadAutoPotion(scene)); break;
            }
            if (state.SlowNext == 0) state.SlowAt = Stopwatch.StartNew();
            state.SlowNext = (state.SlowNext + 1) % 6;
        }

        private static byte[] Slow(Func<JsonNode> read)
        {
            try { return ReaderState.Render(read()); } catch (Exception) { return null; }
        }

        // ---- The objects about, and the player ----

        private static void WriteNumberOrNull(Utf8JsonWriter w, string name, double? value)
        {
            if (value.HasValue) w.WriteNumber(name, value.Value);
            else w.WriteNull(name);
        }

        private static void WriteNumberOrNull(Utf8JsonWriter w, string name, long? value)
        {
            if (value.HasValue) w.WriteNumber(name, value.Value);
            else w.WriteNull(name);
        }

        private static void WriteNumberOrNull(Utf8JsonWriter w, string name, int? value)
        {
            if (value.HasValue) w.WriteNumber(name, value.Value);
            else w.WriteNull(name);
        }

        private static void WriteNumberOrNull(Utf8JsonWriter w, string name, byte? value)
        {
            if (value.HasValue) w.WriteNumber(name, value.Value);
            else w.WriteNull(name);
        }

        private int UserStat(int stat) => userStats.TryGetValue(stat, out int value) ? value : 0;

        // The player: where, their level, class, health and mana, their stats, and the rest the bot reads them by.
        private void WriteUser(ClrObject o, ClrObject scene, string name, int x, int y)
        {
            // Every stat at once (the old reader looked each up in the tree).
            Mem.ReadAllStats(o.Obj("_Stats"), userStats);
            userBuffer.ResetWrittenCount();
            userWriter.Reset(userBuffer);
            Utf8JsonWriter w = userWriter;
            w.WriteStartObject();
            w.WriteString("name", name);
            w.WriteNumber("x", x);
            w.WriteNumber("y", y);
            w.WriteNumber("pickUpRadius", UserStat(PickUpRadiusStat));
            w.WriteNumber("level", o.Int("_level"));
            w.WriteNumber("class", o.Byte("_Class"));
            w.WriteBoolean("mounted", o.Byte("horse") != 0);
            w.WriteBoolean("dead", o.Bool("_Dead"));
            WriteNumberOrNull(w, "experience", o.DecimalOrNull("_Experience"));
            WriteNumberOrNull(w, "maxExperience", o.DecimalOrNull("_MaxExperience"));
            bool? hasMount = ReadHasMount(scene);
            if (hasMount.HasValue) w.WriteBoolean("hasMount", hasMount.Value);
            else w.WriteNull("hasMount");
            w.WriteNumber("hp", o.Int("_CurrentHP"));
            w.WriteNumber("maxHp", UserStat(HealthStat));
            // Mana beside health (_CurrentMP; the Mana stat, 3, is the most).
            WriteNumberOrNull(w, "mp", o.IntOrNull("_CurrentMP"));
            w.WriteNumber("maxMp", UserStat(ManaStat));
            w.WriteStartObject("combat");
            for (int i = 0; i < CombatStats.Length; i++) w.WriteNumber(CombatNames[i], UserStat(CombatStats[i]));
            w.WriteEndObject();
            w.WriteStartObject("percents");
            foreach (int stat in PercentStats) w.WriteNumber(stat.ToString(CultureInfo.InvariantCulture), UserStat(stat));
            w.WriteEndObject();
            Write(w, "weights", ReadWeights(o, scene));
            try
            {
                double combatAgo = ReadCombatAgo(o);
                w.WriteNumber("combatAgo", combatAgo);
            }
            catch (Exception)
            {
                w.WriteNull("combatAgo");
            }
            w.WriteStartObject("trackers");
            w.WriteNumber("elite", UserStat(EliteTrackerStat));
            w.WriteNumber("boss", UserStat(BossTrackerStat));
            w.WriteNumber("behemoth", UserStat(BehemothTrackerStat));
            w.WriteEndObject();
            try
            {
                ClrValueType mouse = scene.Obj("MapControl").Struct("MapLocation");
                int mx = mouse.Int("x"), my = mouse.Int("y");
                w.WriteStartObject("mouseTile");
                w.WriteNumber("x", mx);
                w.WriteNumber("y", my);
                w.WriteEndObject();
            }
            catch (Exception)
            {
                w.WriteNull("mouseTile");
            }
            w.WriteEndObject();
            w.Flush();
        }

        // Read-HasMount: whether anything is in the Horse equipment slot (EquipmentSlot.Horse = 18): no mount yet, nothing
        // to get on. Null when it can't be told.
        private static bool? ReadHasMount(ClrObject scene)
        {
            try
            {
                ClrObject equipment = scene.Obj("Equipment");
                if (equipment.IsNull) return null;
                ClrArray slots = equipment.AsArray();
                if (slots.Length <= 18) return null;
                return !slots.GetObjectValue(18).IsNull;
            }
            catch (Exception)
            {
                return null;
            }
        }

        // Read-Weights: weight worn on the body and in hand (the user object's WearWeight and HandWeight, else the
        // scene's), and the most of each. Null when either can't be found.
        private JsonNode ReadWeights(ClrObject user, ClrObject scene)
        {
            try
            {
                int? wear = WornWeight(user, scene, "WearWeight");
                if (wear == null) return null;
                int? hand = WornWeight(user, scene, "HandWeight");
                if (hand == null) return null;
                return new JsonObject { ["wear"] = wear, ["wearMax"] = UserStat(WearWeightStat), ["hand"] = hand, ["handMax"] = UserStat(HandWeightStat) };
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static int? WornWeight(ClrObject user, ClrObject scene, string name)
        {
            string[] names = { name, "<" + name + ">k__BackingField", "_" + name };
            foreach (ClrObject owner in new[] { user, scene })
            {
                foreach (string candidate in names)
                {
                    if (owner.Has(candidate)) return owner.Int(candidate);
                }
            }
            return null;
        }

        // Read-CombatAgo: seconds since the player was last in combat (the game counts you out of combat 10 s after);
        // 9999 when never.
        private const ulong TicksMask = 0x3FFFFFFFFFFFFFFF;
        private ClrStaticField nowField;

        private double ReadCombatAgo(ClrObject user)
        {
            ulong combat = user.Struct("CombatTime").ULong("_dateData") & TicksMask;
            if (nowField == null) nowField = Static("Client.Envir.CEnvir", "Now");
            ulong now = nowField.ReadStruct(domain).ULong("_dateData") & TicksMask;
            if (combat == 0) return 9999;
            return Math.Round(((double)now - (double)combat) / 1e7, 1);
        }

        // ---- The map ----

        // The map: its size, its walls (sent when the map changes, and again on each attach) and its explored blocks
        // (sent when they change). Walls read just after arriving can be the map still loading (all walls): they're read
        // again a few times over the first seconds on a map, and sent again if they've changed.
        private static readonly int[] WallsRecheckMs = { 1500, 4000, 8000 };

        private JsonNode ReadMap(ClrObject scene)
        {
            ClrObject control = scene.Obj("MapControl");
            ClrObject info = control.Obj("_MapInfo");
            if (info.IsNull) return null;
            int index = info.Int("<Index>k__BackingField");
            int width = control.Int("Width"), height = control.Int("Height");
            JsonObject map = new JsonObject { ["index"] = index, ["name"] = info.Str("_Description"), ["width"] = width, ["height"] = height };
            string key = $"{index}/{width}/{height}";
            if (state.WallsSent != key)
            {
                string walls = Convert.ToBase64String(MapReading.Walls(control));
                map["walls"] = walls;
                state.WallsSent = key;
                state.WallsLast = walls;
                state.WallsAt = Stopwatch.StartNew();
                state.WallsChecks = 0;
                state.ExploredSent = null;
            }
            else if (state.WallsAt != null && state.WallsChecks < WallsRecheckMs.Length && state.WallsAt.ElapsedMilliseconds >= WallsRecheckMs[state.WallsChecks])
            {
                state.WallsChecks++;
                string walls = Convert.ToBase64String(MapReading.Walls(control));
                if (walls != state.WallsLast)
                {
                    map["walls"] = walls;
                    state.WallsLast = walls;
                }
            }
            // Exploration is kept per map (and per instance, for dungeons visited this session).
            ClrObject states = scene.Obj("<MapExplorationStore>k__BackingField").Obj("_states");
            ClrArray entries = states.Obj("_entries").AsArray();
            int count = states.Int("_count");
            ClrObject found = default;
            bool haveFound = false;
            for (int i = 0; i < count; i++)
            {
                ClrValueType entry = entries.GetStructValue(i);
                if (entry.Int("next") < -1) continue;
                ClrObject candidate = entry.Obj("value");
                if (candidate.IsNull || candidate.Int("<MapIndex>k__BackingField") != index) continue;
                // An instance's own record (SessionOnly) wins over the map's.
                if (!haveFound || candidate.Bool("<SessionOnly>k__BackingField"))
                {
                    found = candidate;
                    haveFound = true;
                }
            }
            if (haveFound)
            {
                int revision = found.Int("<Revision>k__BackingField");
                map["blockSize"] = found.Int("<BlockSize>k__BackingField");
                map["gridWidth"] = found.Int("<GridWidth>k__BackingField");
                map["gridHeight"] = found.Int("<GridHeight>k__BackingField");
                map["revision"] = revision;
                string sent = $"{key}/{revision}/{found.Address.ToString(CultureInfo.InvariantCulture)}";
                if (state.ExploredSent != sent)
                {
                    ClrArray bits = found.Obj("_exploredBits").AsArray();
                    map["explored"] = Convert.ToBase64String(bits.ReadValues<byte>(0, bits.Length));
                    state.ExploredSent = sent;
                }
            }
            return map;
        }

        // ---- The view ----

        private ClrStaticField gameSizeField, zoomField, offsetXField, offsetYField, pixelXField, pixelYField;

        // Read-View: the game's size (Config.GameSize), its map zoom (Config.MapZoom), and how MapControl places the
        // character's cell (its static OffSetX/OffSetY in cells and PixelOffsetX/PixelOffsetY): a bigger window shows more map.
        private JsonNode ReadView()
        {
            if (gameSizeField == null)
            {
                gameSizeField = Static("Client.Envir.Config", "<GameSize>k__BackingField");
                zoomField = Static("Client.Envir.Config", "_MapZoom");
                offsetXField = Static("Client.Scenes.Views.MapControl", "OffSetX");
                offsetYField = Static("Client.Scenes.Views.MapControl", "OffSetY");
                pixelXField = Static("Client.Scenes.Views.MapControl", "PixelOffsetX");
                pixelYField = Static("Client.Scenes.Views.MapControl", "PixelOffsetY");
            }
            ClrValueType size = gameSizeField.ReadStruct(domain);
            return new JsonObject
            {
                ["width"] = size.Int("width"), ["height"] = size.Int("height"),
                ["zoom"] = zoomField.Read<float>(domain), ["uiScale"] = state.UiScale,
                ["offsetX"] = offsetXField.Read<int>(domain), ["offsetY"] = offsetYField.Read<int>(domain),
                ["pixelX"] = pixelXField.Read<int>(domain), ["pixelY"] = pixelYField.Read<int>(domain),
            };
        }

        // ---- Waypoints ----

        // Read-Waypoints: the ones unlocked (the game fills this in once the waypoint window has been opened), and while
        // the window is open, its rows (name and Activate button) and scrollbar.
        private JsonNode ReadWaypoints(ClrObject scene)
        {
            JsonArray unlocked = new JsonArray();
            foreach (ClrObject point in Mem.ReadList(scene.Obj("_User").Obj("UserWaypoints")))
            {
                if (point.Bool("<IsUnlocked>k__BackingField")) unlocked.Add(new JsonObject { ["name"] = point.Str("<WaypointName>k__BackingField"), ["map"] = point.Int("<MapIndex>k__BackingField") });
            }
            JsonObject out_ = new JsonObject { ["unlocked"] = unlocked, ["open"] = false };
            ClrObject box = scene.Obj("WaypointsBox");
            if (box.IsNull || !box.Bool("_IsVisible")) return out_;
            out_["open"] = true;
            JsonArray rows = new JsonArray();
            ClrArray array = box.Obj("WaypointRows").AsArray();
            for (int i = 0; i < array.Length; i++)
            {
                ClrObject row = array.GetObjectValue(i);
                if (row.IsNull || !row.Bool("_IsVisible")) continue;
                ClrObject info = row.Obj("<WaypointInfo>k__BackingField");
                if (info.IsNull) continue;
                ClrObject catalogue = info.Obj("<Catalogue>k__BackingField");
                rows.Add(new JsonObject { ["name"] = catalogue.IsNull ? null : catalogue.Str("_Name"), ["activate"] = ReadButton(row.Obj("ActivateButton")) });
            }
            out_["rows"] = rows;
            out_["total"] = box.Obj("WaypointSearchResults").Int("_size");
            ClrObject bar = box.Obj("WaypointScrollBar");
            out_["scroll"] = new JsonObject
            {
                ["value"] = bar.Int("_Value"), ["max"] = bar.Int("_MaxValue"), ["up"] = ReadButton(bar.Obj("UpButton")), ["down"] = ReadButton(bar.Obj("DownButton")),
            };
            return out_;
        }

        // ---- Windows ----

        // The scene's fields that hold windows (controls: _IsVisible and _Location), listed once an attach.
        private List<ClrInstanceField> windowFields;

        // Read-Windows: the game's windows showing right now (minimap, quest tracker, any dialog...), as boxes: holding
        // the run button over one doesn't run. Null with none showing (as the old reader sent it); a list otherwise, one
        // window too (the old reader sent a lone window bare, not in a list).
        private JsonNode ReadWindows(ClrObject scene)
        {
            // Looked for again while none has been found (as the old reader did).
            if (windowFields == null || windowFields.Count == 0)
            {
                List<ClrInstanceField> fields = new List<ClrInstanceField>();
                foreach (ClrInstanceField f in scene.Type.Fields)
                {
                    if (!f.IsObjectReference) continue;
                    ClrObject o;
                    try { o = scene.ReadObjectField(f); } catch (Exception) { continue; }
                    if (!o.IsNull && o.Has("_IsVisible") && o.Has("_Location")) fields.Add(f);
                }
                windowFields = fields;
            }
            JsonArray boxes = new JsonArray();
            foreach (ClrInstanceField field in windowFields)
            {
                ClrObject o = scene.ReadObjectField(field);
                if (o.IsNull || !o.Bool("_IsVisible")) continue;
                JsonObject box = ReadBox(o);
                // Not the game world itself (MapControl covers the whole screen), nor empty controls.
                int width = (int)box["width"], height = (int)box["height"];
                if (width <= 0 || height <= 0 || (long)width * height >= 1000000) continue;
                box["name"] = field.Name;
                boxes.Add(box);
            }
            return boxes.Count > 0 ? boxes : null;
        }

        // ---- Monsters known anywhere on the map ----

        // Read-Known: every monster the game knows of on the map, near or far (GameScene.DataDictionary: what the map's
        // markers are drawn from, sub-bosses included wherever they are): which, where, its health, and whether it's dead.
        private JsonNode ReadKnown(ClrObject scene)
        {
            JsonArray out_ = new JsonArray();
            ClrObject set = scene.Obj("DataDictionary").Obj("_set");
            Stack<ClrObject> stack = new Stack<ClrObject>();
            stack.Push(set.Obj("root"));
            while (stack.Count > 0)
            {
                ClrObject node = stack.Pop();
                if (node.IsNull) continue;
                stack.Push(node.Obj("<Left>k__BackingField"));
                stack.Push(node.Obj("<Right>k__BackingField"));
                ClrObject data = node.Struct("<Item>k__BackingField").Obj("value");
                if (data.IsNull) continue;
                ClrObject info = data.Obj("MonsterInfo");
                if (info.IsNull || !string.IsNullOrEmpty(data.Str("PetOwner"))) continue;
                ClrValueType at = data.Struct("Location");
                out_.Add(new JsonObject
                {
                    ["id"] = data.UInt("ObjectID"), ["name"] = info.Str("_MonsterName"), ["map"] = data.Int("MapIndex"),
                    ["x"] = at.Int("x"), ["y"] = at.Int("y"), ["hp"] = data.Int("Health"), ["maxHp"] = data.Int("MaxHealth"), ["dead"] = data.Bool("Dead"),
                });
            }
            return out_;
        }
    }
}

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Diagnostics.Runtime;

namespace Bitmat.GameReader
{
    // The objects about (MapControl.Objects), read fast: a few hundred of them, 20 times a second. Each is read from
    // the game's memory in one go (its type and every field sent) and its name in a second, where reading field by
    // field took a dozen reads an object.
    internal sealed partial class Session
    {
        // Where each field sent lies in an object of a type (bytes from the object's start; -1: the type has none),
        // looked up once a type.
        private sealed class Layout
        {
            public ClrType Type;
            public string Kind;
            public int Bytes;
            public int Id, X, Y, Dead, Level, Name, PetOwner, Experience, MaxExperience, Disposition, Stats, CurrentHp, NodeIndex, NodeKind, Harvested;
        }

        private readonly Dictionary<ulong, Layout> layouts = new Dictionary<ulong, Layout>();
        private IDataReader memory;
        private byte[] objectBytes = new byte[512];
        private readonly byte[] stringBytes = new byte[12 + 2 * 64];
        private ulong[] objectRefs = new ulong[1024];

        // Each monster's Health stat as last read (by its id and Stats object), and when: walking every monster's stats
        // each tick was half of all the reading. It's read again each RecheckHealthMs, should it change.
        private struct KnownHealth
        {
            public ulong Stats;
            public int MaxHp;
            public long At;
        }
        private const int RecheckHealthMs = 1000;
        private readonly Dictionary<uint, KnownHealth> healthOf = new Dictionary<uint, KnownHealth>();
        private readonly System.Diagnostics.Stopwatch clock = System.Diagnostics.Stopwatch.StartNew();

        // A field's place in objects of the type, or -1 when it has none: from the object's start (past its method
        // table pointer, where ClrMD's field offsets start), plus `inner` for a field of a struct field.
        private static int Place(ClrType type, string name, string inner = null)
        {
            ClrInstanceField field = Mem.Cache.Find(type, name);
            if (field == null) return -1;
            int at = field.Offset + IntPtr.Size;
            if (inner == null) return at;
            ClrInstanceField part = field.Type?.GetFieldByName(inner);
            if (part == null) return -1;
            return at + part.Offset;
        }

        private static int Required(ClrType type, string name, string inner = null)
        {
            int at = Place(type, name, inner);
            if (at < 0) throw new ArgumentException($"Type '{type.Name}' does not contain a field named '{name}'");
            return at;
        }

        private Layout LayoutOf(ulong methodTable)
        {
            if (layouts.TryGetValue(methodTable, out Layout layout)) return layout;
            ClrType type = runtime.Heap.GetTypeByMethodTable(methodTable);
            if (type == null) throw new InvalidOperationException($"An object in the map's list is corrupted, could not determine type (method table {methodTable:x}).");
            string name = type.Name ?? "";
            layout = new Layout { Type = type, Kind = name == UserType ? "user" : Kinds.TryGetValue(name, out string kind) ? kind : null };
            // Types not sent aren't read at all.
            if (layout.Kind != null)
            {
                layout.X = Required(type, "_CurrentLocation", "x");
                layout.Y = Required(type, "_CurrentLocation", "y");
                layout.Name = Required(type, "_Name");
                if (layout.Kind != "user")
                {
                    layout.Id = Required(type, "ObjectID");
                    layout.Dead = Required(type, "_Dead");
                    layout.Level = Required(type, "<Level>k__BackingField");
                    layout.PetOwner = Required(type, "_PetOwner");
                    layout.Experience = Place(type, "_Experience");
                    layout.MaxExperience = Place(type, "_MaxExperience");
                    layout.Disposition = Place(type, "<CombatDisposition>k__BackingField");
                    layout.Stats = Place(type, "_Stats");
                    layout.CurrentHp = Place(type, "<CurrentHP>k__BackingField");
                    if (layout.Kind == "node")
                    {
                        layout.NodeIndex = Required(type, "<NodeIndex>k__BackingField");
                        layout.NodeKind = Required(type, "<Kind>k__BackingField");
                        layout.Harvested = Required(type, "_harvested");
                    }
                }
                int end = 0;
                foreach (int at in new[] { layout.Id, layout.X, layout.Y, layout.Dead, layout.Level, layout.Name, layout.PetOwner, layout.Disposition, layout.Stats, layout.CurrentHp, layout.NodeIndex, layout.NodeKind, layout.Harvested })
                {
                    end = Math.Max(end, at + 8);
                }
                foreach (int at in new[] { layout.Experience, layout.MaxExperience }) end = Math.Max(end, at + 16);
                layout.Bytes = end;
            }
            layouts[methodTable] = layout;
            return layout;
        }

        private int I32(int at) => MemoryMarshal.Read<int>(objectBytes.AsSpan(at));
        private ulong Pointer(int at) => MemoryMarshal.Read<ulong>(objectBytes.AsSpan(at));

        // A string object's text (null for none), in one read for most names: the characters as they lie in the read
        // (good until the next string read), so writing a name allocates nothing.
        private ReadOnlySpan<char> ReadChars(ulong address, out bool isNull)
        {
            isNull = address == 0;
            if (isNull) return ReadOnlySpan<char>.Empty;
            int got = ReadSome(address, stringBytes, 12);
            int length = MemoryMarshal.Read<int>(stringBytes.AsSpan(8));
            if (length < 0 || length > 4096) throw new InvalidOperationException($"String {address:x} is corrupted.");
            int bytes = 2 * length;
            if (12 + bytes <= got) return MemoryMarshal.Cast<byte, char>(stringBytes.AsSpan(12, bytes));
            byte[] into = 12 + bytes <= stringBytes.Length ? stringBytes : new byte[12 + bytes];
            if (memory.Read(address, into.AsSpan(0, 12 + bytes)) < 12 + bytes) throw new InvalidOperationException($"String {address:x} could not be read.");
            return MemoryMarshal.Cast<byte, char>(into.AsSpan(12, bytes));
        }

        // Reads as much of `into` as there is from `address`, at least `needed` bytes: a read running past the end of
        // the game's memory there fails whole on Windows (Linux gives what it could), so one that fails is tried again
        // for just what's needed.
        private int ReadSome(ulong address, byte[] into, int needed)
        {
            int got = memory.Read(address, into);
            if (got < needed) got = memory.Read(address, into.AsSpan(0, needed));
            if (got < needed) throw new InvalidOperationException($"Object {address:x} could not be read.");
            return got;
        }

        private string ReadString(ulong address)
        {
            ReadOnlySpan<char> chars = ReadChars(address, out bool isNull);
            return isNull ? null : new string(chars);
        }

        // Writes "objects": the monsters, items, players, NPCs and gathering nodes within ObjectRange (NPCs and the player
        // whatever the distance), as MapControl.Objects lists them; the player is written apart. True when there's a player.
        private bool WriteObjects(Utf8JsonWriter w, ClrObject scene)
        {
            if (memory == null) memory = runtime.DataTarget.DataReader;
            ClrObject list = scene.Obj("MapControl").Obj("Objects");
            int size = list.Int("_size");
            ClrArray items = list.Obj("_items").AsArray();
            if (size > items.Length) throw new InvalidOperationException("The map's object list is being changed.");
            if (objectRefs.Length < size) objectRefs = new ulong[size * 2];
            // Every object's address in one read (an array's items follow its method table and length).
            Span<byte> refBytes = MemoryMarshal.AsBytes(objectRefs.AsSpan(0, size));
            if (size > 0 && memory.Read(items.Address + 2 * (ulong)IntPtr.Size, refBytes) < refBytes.Length) throw new InvalidOperationException("The map's object list could not be read.");
            // Where the player is, for leaving out what's far off.
            bool haveMe = false;
            int meX = 0, meY = 0;
            try
            {
                ClrObject meObject = scene.Obj("_User");
                if (!meObject.IsNull)
                {
                    ClrValueType at = meObject.Struct("_CurrentLocation");
                    meX = at.Int("x");
                    meY = at.Int("y");
                    haveMe = true;
                }
            }
            catch (Exception) { }
            bool hasUser = false;
            w.WritePropertyName("objects");
            w.WriteStartArray();
            for (int i = 0; i < size; i++)
            {
                ulong address = objectRefs[i];
                if (address == 0) continue;
                // Its method table (what type it is) first, with as much of the object as most types need.
                int got = ReadSome(address, objectBytes, IntPtr.Size);
                Layout layout = LayoutOf(Pointer(0) & ~7UL);
                // Not a type that's sent (spells, effects...): skipped, near or far.
                if (layout.Kind == null) continue;
                if (layout.Bytes > got)
                {
                    if (layout.Bytes > objectBytes.Length) objectBytes = new byte[layout.Bytes * 2];
                    got = memory.Read(address, objectBytes.AsSpan(0, layout.Bytes));
                    if (got < layout.Bytes) throw new InvalidOperationException($"Object {address:x} could not be read.");
                }
                int x = I32(layout.X), y = I32(layout.Y);
                string kind = layout.Kind;
                if (haveMe && (Math.Abs(x - meX) > ObjectRange || Math.Abs(y - meY) > ObjectRange) && kind != "npc" && kind != "user") continue;
                ulong nameAt = Pointer(layout.Name);
                if (kind == "user")
                {
                    WriteUser(runtime.Heap.GetObject(address, layout.Type), scene, ReadString(nameAt), x, y);
                    hasUser = true;
                    continue;
                }
                // Read before the name (which takes the buffer's second read): what's left of the object read.
                uint id = MemoryMarshal.Read<uint>(objectBytes.AsSpan(layout.Id));
                bool dead = objectBytes[layout.Dead] != 0;
                double? experience = layout.Experience < 0 ? null : (double)MemoryMarshal.Read<decimal>(objectBytes.AsSpan(layout.Experience));
                double? maxExperience = layout.MaxExperience < 0 ? null : (double)MemoryMarshal.Read<decimal>(objectBytes.AsSpan(layout.MaxExperience));
                int level = I32(layout.Level);
                ulong petOwner = Pointer(layout.PetOwner);
                byte? disposition = layout.Disposition < 0 ? null : objectBytes[layout.Disposition];
                ulong stats = layout.Stats < 0 ? 0 : Pointer(layout.Stats);
                int? currentHp = layout.CurrentHp < 0 ? null : I32(layout.CurrentHp);
                int node = 0, nodeKind = 0;
                bool harvested = false;
                if (kind == "node")
                {
                    node = I32(layout.NodeIndex);
                    nodeKind = I32(layout.NodeKind);
                    harvested = objectBytes[layout.Harvested] != 0;
                }
                bool pet = petOwner != 0 && ReadChars(petOwner, out _).Length > 0;
                w.WriteStartObject();
                w.WriteNumber("id", id);
                w.WriteString("kind", kind);
                ReadOnlySpan<char> name = ReadChars(nameAt, out bool noName);
                if (noName) w.WriteNull("name");
                else w.WriteString("name", name);
                w.WriteNumber("x", x);
                w.WriteNumber("y", y);
                w.WriteBoolean("dead", dead);
                WriteNumberOrNull(w, "experience", experience);
                WriteNumberOrNull(w, "maxExperience", maxExperience);
                w.WriteNumber("level", level);
                w.WriteBoolean("pet", pet);
                // Library.CombatTargetDisposition: 4 Hostile (can be attacked); guards and the like are something else.
                WriteNumberOrNull(w, "disposition", disposition);
                if (kind == "monster")
                {
                    // Health: the most it has (its Health stat), and the damage seen land on it, as 0 going negative (the
                    // client isn't told its real health).
                    int? maxHp = null;
                    if (layout.Stats >= 0)
                    {
                        try { maxHp = stats == 0 ? 0 : MaxHealth(id, stats); } catch (Exception) { }
                    }
                    WriteNumberOrNull(w, "maxHp", maxHp);
                    WriteNumberOrNull(w, "hp", currentHp);
                }
                else if (kind == "node")
                {
                    // Gathering nodes: which node it is (GatheringNodeInfo), plant (0) or ore (1), and whether it's been picked.
                    w.WriteNumber("node", node);
                    w.WriteBoolean("mining", nodeKind == 1);
                    w.WriteBoolean("harvested", harvested);
                }
                w.WriteEndObject();
            }
            w.WriteEndArray();
            return hasUser;
        }

        // A monster's Health stat: as read within the last RecheckHealthMs, or read now.
        private int MaxHealth(uint id, ulong stats)
        {
            long now = clock.ElapsedMilliseconds;
            if (healthOf.TryGetValue(id, out KnownHealth known) && known.Stats == stats && now - known.At < RecheckHealthMs) return known.MaxHp;
            // Monsters long gone are forgotten now and then.
            if (healthOf.Count > 4096) healthOf.Clear();
            int maxHp = HealthOf(stats);
            healthOf[id] = new KnownHealth { Stats = stats, MaxHp = maxHp, At = now };
            return maxHp;
        }

        // A monster's Health stat, from its Stats object (Read-Stat).
        private int HealthOf(ulong stats)
        {
            ClrObject o = runtime.Heap.GetObject(stats);
            ClrObject node = o.Obj("<Values>k__BackingField").Obj("_set").Obj("root");
            while (!node.IsNull)
            {
                ClrValueType pair = node.Struct("<Item>k__BackingField");
                int key = pair.Int("key");
                if (key == HealthStat) return pair.Int("value");
                node = node.Obj(HealthStat < key ? "<Left>k__BackingField" : "<Right>k__BackingField");
            }
            return 0;
        }
    }
}

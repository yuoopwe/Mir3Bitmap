using System;
using System.Collections.Generic;
using Microsoft.Diagnostics.Runtime;

namespace Bitmat.GameReader
{
    // Fields looked up by name once per type and remembered (null: the type has no such field). A read is then a
    // memory read at a known offset, not a search by name, and an optional field the game doesn't have costs one
    // lookup per attach instead of an exception on every read.
    internal sealed class FieldCache
    {
        private readonly Dictionary<ClrType, Dictionary<string, ClrInstanceField>> types = new Dictionary<ClrType, Dictionary<string, ClrInstanceField>>();

        public ClrInstanceField Find(ClrType type, string name)
        {
            if (!types.TryGetValue(type, out Dictionary<string, ClrInstanceField> fields)) types[type] = fields = new Dictionary<string, ClrInstanceField>(StringComparer.Ordinal);
            if (!fields.TryGetValue(name, out ClrInstanceField field)) fields[name] = field = type.GetFieldByName(name);
            return field;
        }
    }

    // Reading fields of the game's objects (and of structs inside them) by name, through the field cache. A field
    // that must be there and isn't throws, as ClrMD's own ReadField does (the reading of that tick fails, as before);
    // the *OrNull readers are for the fields the old reader read inside a try: missing, they give null.
    internal static class Mem
    {
        // Set afresh on every attach: types belong to the runtime they were read from.
        public static FieldCache Cache = new FieldCache();

        private static ClrType TypeOf(ClrObject o)
        {
            ClrType type = o.Type;
            if (type == null) throw new InvalidOperationException($"Object {o.Address:x} is corrupted, could not determine type.");
            return type;
        }

        private static ClrType TypeOf(ClrValueType v)
        {
            ClrType type = v.Type;
            if (type == null) throw new InvalidOperationException($"Value {v.Address:x} has no type.");
            return type;
        }

        private static ClrInstanceField Required(ClrType type, string name)
        {
            ClrInstanceField field = Cache.Find(type, name);
            if (field == null) throw new ArgumentException($"Type '{type.Name}' does not contain a field named '{name}'");
            return field;
        }

        public static ClrInstanceField Field(this ClrObject o, string name) => Required(TypeOf(o), name);

        public static ClrInstanceField Field(this ClrValueType v, string name) => Required(TypeOf(v), name);

        // The field, or null when the object's type has none (or the object is null).
        public static ClrInstanceField FieldOrNull(this ClrObject o, string name)
        {
            if (o.IsNull) return null;
            ClrType type = o.Type;
            return type == null ? null : Cache.Find(type, name);
        }

        public static bool Has(this ClrObject o, string name) => FieldOrNull(o, name) != null;

        // ---- Objects ----

        public static ClrObject Obj(this ClrObject o, string name) => o.ReadObjectField(Field(o, name));
        public static ClrValueType Struct(this ClrObject o, string name) => o.ReadValueTypeField(Field(o, name));
        public static string Str(this ClrObject o, string name) => Field(o, name).ReadString(o.Address, false);
        public static int Int(this ClrObject o, string name) => o.ReadField<int>(Field(o, name));
        public static uint UInt(this ClrObject o, string name) => o.ReadField<uint>(Field(o, name));
        public static long Long(this ClrObject o, string name) => o.ReadField<long>(Field(o, name));
        public static byte Byte(this ClrObject o, string name) => o.ReadField<byte>(Field(o, name));
        public static bool Bool(this ClrObject o, string name) => o.ReadField<bool>(Field(o, name));
        public static float Float(this ClrObject o, string name) => o.ReadField<float>(Field(o, name));

        // A game database object's index (MirDB.DBObject: maps, regions, NPCs, ...): objectIndex since the game's update
        // of 2026-10-25, the Index property's backing field before.
        public static int DbIndex(this ClrObject o) => o.Int(o.Has("objectIndex") ? "objectIndex" : "<Index>k__BackingField");

        // The old reader's $(try { ... } catch { $null }) fields: null when missing, and (as there) when the read fails.
        public static int? IntOrNull(this ClrObject o, string name)
        {
            ClrInstanceField f = FieldOrNull(o, name);
            if (f == null) return null;
            try { return o.ReadField<int>(f); } catch { return null; }
        }

        public static long? LongOrNull(this ClrObject o, string name)
        {
            ClrInstanceField f = FieldOrNull(o, name);
            if (f == null) return null;
            try { return o.ReadField<long>(f); } catch { return null; }
        }

        public static double? DecimalOrNull(this ClrObject o, string name)
        {
            ClrInstanceField f = FieldOrNull(o, name);
            if (f == null) return null;
            try { return (double)o.ReadField<decimal>(f); } catch { return null; }
        }

        public static byte? ByteOrNull(this ClrObject o, string name)
        {
            ClrInstanceField f = FieldOrNull(o, name);
            if (f == null) return null;
            try { return o.ReadField<byte>(f); } catch { return null; }
        }

        public static bool BoolOrFalse(this ClrObject o, string name)
        {
            ClrInstanceField f = FieldOrNull(o, name);
            if (f == null) return false;
            try { return o.ReadField<bool>(f); } catch { return false; }
        }

        // Read-EnumField: an enum (or number) field whatever its size, or null when the type has no such field.
        public static long? Enum(this ClrObject o, string name)
        {
            ClrInstanceField f = Cache.Find(TypeOf(o), name);
            if (f == null) return null;
            switch (f.ElementType)
            {
                case ClrElementType.Int8: return o.ReadField<sbyte>(f);
                case ClrElementType.UInt8: return o.ReadField<byte>(f);
                case ClrElementType.Int16: return o.ReadField<short>(f);
                case ClrElementType.UInt16: return o.ReadField<ushort>(f);
                case ClrElementType.Int64: return o.ReadField<long>(f);
                default: return o.ReadField<int>(f);
            }
        }

        // ---- Structs (a value inside an object: its fields are read where it lies) ----

        public static int Int(this ClrValueType v, string name) => v.ReadField<int>(Field(v, name));
        public static ulong ULong(this ClrValueType v, string name) => v.ReadField<ulong>(Field(v, name));
        public static ClrObject Obj(this ClrValueType v, string name) => v.ReadObjectField(Field(v, name));

        // ---- Lists and arrays ----

        // Read-List: the items of a List<T> or an array of objects.
        public static List<ClrObject> ReadList(ClrObject list)
        {
            List<ClrObject> list_out = new List<ClrObject>();
            if (list.IsNull) return list_out;
            if (list.IsArray)
            {
                ClrArray array = list.AsArray();
                for (int i = 0; i < array.Length; i++) list_out.Add(array.GetObjectValue(i));
                return list_out;
            }
            int size = list.Int("_size");
            ClrArray items = list.Obj("_items").AsArray();
            for (int i = 0; i < size; i++) list_out.Add(items.GetObjectValue(i));
            return list_out;
        }

        // Read-AnyList: also a BindingList / Collection<T> (its inner list is `items`).
        public static List<ClrObject> ReadAnyList(ClrObject list)
        {
            if (list.IsNull) return new List<ClrObject>();
            if (!list.IsArray && !list.Has("_size") && list.Has("items")) return ReadAnyList(list.Obj("items"));
            return ReadList(list);
        }

        // Read-BindingList: a DBBindingList's items (its `items` list).
        public static List<ClrObject> ReadBindingList(ClrObject list) => list.IsNull ? new List<ClrObject>() : ReadList(list.Obj("items"));

        // Read-Number: one element of an array of numbers or enums, whatever their size.
        public static long ReadNumber(ClrArray array, int index)
        {
            switch (array.Type.ComponentSize)
            {
                case 1: return array.GetValue<byte>(index);
                case 2: return array.GetValue<short>(index);
                case 8: return array.GetValue<long>(index);
                default: return array.GetValue<int>(index);
            }
        }

        public static long ReadNumber(ClrArray array, int[] indices)
        {
            switch (array.Type.ComponentSize)
            {
                case 1: return array.GetValue<byte>(indices);
                case 2: return array.GetValue<short>(indices);
                case 8: return array.GetValue<long>(indices);
                default: return array.GetValue<int>(indices);
            }
        }

        // Read-IntList: a List<int> (or an int array) of numbers.
        public static List<long> ReadIntList(ClrObject list)
        {
            List<long> list_out = new List<long>();
            if (list.IsNull) return list_out;
            if (list.IsArray)
            {
                ClrArray array = list.AsArray();
                for (int i = 0; i < array.Length; i++) list_out.Add(ReadNumber(array, i));
                return list_out;
            }
            int size = list.Int("_size");
            ClrArray items = list.Obj("_items").AsArray();
            for (int i = 0; i < size; i++) list_out.Add(ReadNumber(items, i));
            return list_out;
        }

        // ---- Stats ----

        // Read-Stat: one of an object's stats (its _Stats); Stats.Values is a SortedDictionary, i.e. a binary search tree
        // keyed by stat number. 0 when it has none.
        public static int ReadStat(ClrObject owner, int stat)
        {
            ClrObject stats = owner.Obj("_Stats");
            if (stats.IsNull) return 0;
            ClrObject node = stats.Obj("<Values>k__BackingField").Obj("_set").Obj("root");
            while (!node.IsNull)
            {
                ClrValueType pair = node.Struct("<Item>k__BackingField");
                int key = pair.Int("key");
                if (key == stat) return pair.Int("value");
                node = node.Obj(stat < key ? "<Left>k__BackingField" : "<Right>k__BackingField");
            }
            return 0;
        }

        // Read-AllStats: every value in a Stats, stat number -> value (into `into`, emptied first).
        public static void ReadAllStats(ClrObject stats, Dictionary<int, int> into)
        {
            into.Clear();
            if (stats.IsNull) return;
            Stack<ClrObject> stack = new Stack<ClrObject>();
            ClrObject root = stats.Obj("<Values>k__BackingField").Obj("_set").Obj("root");
            if (!root.IsNull) stack.Push(root);
            while (stack.Count > 0)
            {
                ClrObject node = stack.Pop();
                ClrValueType pair = node.Struct("<Item>k__BackingField");
                into[pair.Int("key")] = pair.Int("value");
                ClrObject left = node.Obj("<Left>k__BackingField");
                if (!left.IsNull) stack.Push(left);
                ClrObject right = node.Obj("<Right>k__BackingField");
                if (!right.IsNull) stack.Push(right);
            }
        }
    }
}

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.Diagnostics.Runtime;

namespace Bitmat.GameReader
{
    // The player's buffs and skills, for casting by what the game shows rather than on timers: each buff with its time
    // left and the skill that gave it, each skill with its key on each key set, when it's next ready and what it costs,
    // and the key set in use. The types are the game's own (LibraryCore.dll): Library.ClientBuffInfo,
    // Library.ClientUserMagic, Library.SystemModels.MagicInfo.
    internal sealed partial class Session
    {
        // An enum's names by value, looked up once an enum type (from ClrMD's reading of its metadata).
        private readonly Dictionary<ClrType, Dictionary<long, string>> enumNames = new Dictionary<ClrType, Dictionary<long, string>>();

        // DateTime._dateData: the ticks, and the kind in the top two bits (1 Utc, 2 or 3 Local).
        private const ulong DateTicksMask = 0x3FFFFFFFFFFFFFFF;

        // An enum field's value by name (its number when the enum has no name for it); null when the object has no such
        // field.
        private string EnumName(ClrObject o, string name)
        {
            ClrInstanceField field = o.FieldOrNull(name);
            if (field == null) return null;
            long? value = o.Enum(name);
            if (!value.HasValue) return null;
            ClrType type = field.Type;
            if (type == null || !type.IsEnum) return value.Value.ToString(CultureInfo.InvariantCulture);
            if (!enumNames.TryGetValue(type, out Dictionary<long, string> names))
            {
                names = new Dictionary<long, string>();
                try
                {
                    foreach ((string Name, object Value) entry in type.AsEnum().EnumerateValues())
                    {
                        long key = Convert.ToInt64(entry.Value, CultureInfo.InvariantCulture);
                        if (!names.ContainsKey(key)) names[key] = entry.Name;
                    }
                }
                catch (Exception)
                {
                    // Names not to be had: numbers then.
                }
                enumNames[type] = names;
            }
            return names.TryGetValue(value.Value, out string found) ? found : value.Value.ToString(CultureInfo.InvariantCulture);
        }

        private static long Ticks(ClrValueType timeSpan) => timeSpan.ReadField<long>(timeSpan.Field("_ticks"));

        // "buffs": every buff on the player (UserObject.Buffs, a List<ClientBuffInfo>): its type, the seconds left (null:
        // permanent, TimeSpan.MaxValue), whether it's paused, the skill that gave it (null for none) and the item behind
        // an item's buff (an elixir, say).
        private JsonNode ReadBuffs(ClrObject user)
        {
            if (!user.Has("Buffs")) return null;
            JsonArray out_ = new JsonArray();
            foreach (ClrObject buff in Mem.ReadList(user.Obj("Buffs")))
            {
                if (buff.IsNull) continue;
                long ticks = Ticks(buff.Struct("<RemainingTime>k__BackingField"));
                string source = EnumName(buff, "<SourceMagic>k__BackingField");
                int? item = buff.IntOrNull("<ItemIndex>k__BackingField");
                out_.Add(new JsonObject
                {
                    ["type"] = EnumName(buff, "<Type>k__BackingField"),
                    ["left"] = ticks == long.MaxValue ? null : Math.Round(ticks / 1e7, 1),
                    ["paused"] = buff.BoolOrFalse("<Pause>k__BackingField"),
                    ["source"] = source == null || source == "None" ? null : source,
                    ["item"] = item.HasValue && item.Value > 0 ? item : null,
                });
            }
            return out_;
        }

        // "skills": every skill the player has (UserObject.Magics, a Dictionary<MagicInfo, ClientUserMagic>): its name,
        // MagicType and school, level, its key on each of the four key sets (null for none), the seconds until it's
        // ready (NextCast, on the game's clock: this machine's local time), its delay (ms) and its MP cost as the game
        // works it out (ClientUserMagic.Cost: BaseCost + Level x LevelCost / 5).
        private List<CachedSkill> ReadSkills(ClrObject user)
        {
            if (!user.Has("Magics")) return null;
            ClrObject magics = user.Obj("Magics");
            List<CachedSkill> out_ = new List<CachedSkill>();
            if (magics.IsNull) return out_;
            ClrArray entries = magics.Obj("_entries").AsArray();
            int count = magics.Int("_count");
            for (int i = 0; i < count && i < entries.Length; i++)
            {
                ClrValueType entry = entries.GetStructValue(i);
                // A removed entry (free list).
                if (entry.Int("next") < -1) continue;
                ClrObject magic = entry.Obj("value");
                if (magic.IsNull) continue;
                ClrObject info = magic.Obj("Info");
                if (info.IsNull) continue;
                int level = magic.Int("<Level>k__BackingField");
                JsonArray keys = new JsonArray();
                for (int set = 1; set <= 4; set++)
                {
                    string key = EnumName(magic, $"<Set{set}Key>k__BackingField");
                    keys.Add(key == null || key == "None" ? null : key);
                }
                ulong nextCast = magic.Has("NextCast") ? magic.Struct("NextCast").ULong("_dateData") : 0;
                int baseCost = info.IntOrNull("_BaseCost") ?? 0, levelCost = info.IntOrNull("_LevelCost") ?? 0;
                out_.Add(new CachedSkill
                {
                    Json = new JsonObject
                    {
                        ["name"] = info.Str("_Name"),
                        ["magic"] = EnumName(info, "_Magic"),
                        ["school"] = EnumName(info, "_School"),
                        ["level"] = level,
                        ["keys"] = keys,
                        ["readyIn"] = 0,
                        ["delay"] = info.IntOrNull("_Delay") ?? 0,
                        ["cost"] = baseCost + level * levelCost / 5,
                    },
                    NextCast = nextCast,
                });
            }
            return out_;
        }

        // A skill as last read, and its NextCast (DateTime._dateData; 0: none), for its time until ready each tick.
        private sealed class CachedSkill
        {
            public JsonObject Json;
            public ulong NextCast;
        }

        // The skills are read this many ticks apart (about 4 a second): their names, keys and costs rarely change, and
        // reading them all each tick cost a fair share of the reader's time. Their time until ready is worked out afresh
        // each tick from NextCast as last read.
        private const int SkillsEveryTicks = 5;
        private List<CachedSkill> skillsRead;
        private int skillsTick;

        private JsonNode SkillsNow(ClrObject user)
        {
            if (skillsRead == null || skillsTick++ % SkillsEveryTicks == 0)
            {
                try { skillsRead = ReadSkills(user); } catch (Exception) { skillsRead = null; }
            }
            if (skillsRead == null) return null;
            JsonArray out_ = new JsonArray();
            foreach (CachedSkill skill in skillsRead)
            {
                double readyIn = 0;
                if (skill.NextCast != 0)
                {
                    long next = (long)(skill.NextCast & DateTicksMask);
                    long now = (skill.NextCast >> 62) == 1 ? DateTime.UtcNow.Ticks : DateTime.Now.Ticks;
                    if (next > now) readyIn = Math.Round((next - now) / 1e7, 1);
                }
                skill.Json["readyIn"] = readyIn;
                // (Taken out of last tick's list to go in this one.)
                skill.Json.Parent?.AsArray().Remove(skill.Json);
                out_.Add(skill.Json);
            }
            return out_;
        }

        // The key set the skill bar is on (MagicBarBox._SpellSet, 1-4), or null.
        private static int? ReadSpellSet(ClrObject scene)
        {
            ClrObject bar = scene.Has("MagicBarBox") ? scene.Obj("MagicBarBox") : default;
            return bar.IsNull ? null : bar.IntOrNull("_SpellSet");
        }

        // Buffs, skills and the key set, into the player's object, each left out when it can't be read.
        private void WriteCasting(System.Text.Json.Utf8JsonWriter w, ClrObject user, ClrObject scene)
        {
            JsonNode buffs = null, skills = null;
            int? spellSet = null;
            try { buffs = ReadBuffs(user); } catch (Exception) { }
            try { skills = SkillsNow(user); } catch (Exception) { }
            try { spellSet = ReadSpellSet(scene); } catch (Exception) { }
            if (buffs != null) Write(w, "buffs", buffs);
            if (skills != null) Write(w, "skills", skills);
            if (spellSet.HasValue) w.WriteNumber("spellSet", spellSet.Value);
        }
    }
}

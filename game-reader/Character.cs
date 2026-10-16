using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json.Nodes;
using Microsoft.Diagnostics.Runtime;

namespace Bitmat.GameReader
{
    // The rarely changing parts about the character, read about once a second: the quest log and what its quests still
    // need, gear (worn and in the bag), the bloodline, the game's auto potion and profession levels.
    internal sealed partial class Session
    {
        // ---- Quests ----

        private sealed class TaskEntry
        {
            public ClrObject Task;
            public int Required;
            public long Have;
            public int Stage;
        }

        // Read-QuestTargets: the monsters (and the map, when a task names one) still needed by an unfinished task of a
        // quest in the log, the log itself, and into `pending` the unfinished "go to" and "talk to" tasks (the region and
        // its map, or the NPC). A task's monsters come from QuestTask.MonsterDetails (a DBBindingList).
        private void ReadQuestTargets(ClrObject scene, JsonObject pending, out JsonArray targetsOut, out JsonArray log)
        {
            JsonArray regions = (JsonArray)pending["regions"], talks = (JsonArray)pending["talks"];
            // By monster and map: the first task needing them.
            Dictionary<string, JsonObject> targets = new Dictionary<string, JsonObject>(StringComparer.OrdinalIgnoreCase);
            targetsOut = new JsonArray();
            log = new JsonArray();
            foreach (ClrObject quest in Mem.ReadList(scene.Obj("QuestLog")))
            {
                ClrObject info = quest.Obj("<Quest>k__BackingField");
                string questName = info.IsNull ? "" : info.Str("_QuestName");
                // The quest's tasks (QuestInfo.Tasks), each with its progress: the character's entry for it, which the game
                // only adds once there's been some (a quest just taken has none: nothing done yet, not everything).
                Dictionary<ulong, ClrObject> progressOf = new Dictionary<ulong, ClrObject>();
                foreach (ClrObject p in Mem.ReadList(quest.Obj("<Tasks>k__BackingField")))
                {
                    ClrObject t = p.Obj("<Task>k__BackingField");
                    if (!t.IsNull) progressOf[t.Address] = p;
                }
                List<TaskEntry> tasks = new List<TaskEntry>();
                // A quest can hold the tasks of several versions of itself: the character's are those of the version they
                // took it at (brought in at or before it, and not retired by then; 0: always).
                int accepted = OptionalInt(quest, "<AcceptedContentRevision>k__BackingField");
                if (!info.IsNull)
                {
                    foreach (ClrObject task in Mem.ReadBindingList(info.Obj("<Tasks>k__BackingField")))
                    {
                        if (task.IsNull) continue;
                        int introduced = OptionalInt(task, "_IntroducedRevision");
                        int retired = OptionalInt(task, "_RetiredRevision");
                        if (accepted > 0 && (introduced > accepted || (retired > 0 && retired <= accepted))) continue;
                        bool hasProgress = progressOf.TryGetValue(task.Address, out ClrObject p);
                        // Some quests leave the per-character requirement at 0: the task's own amount is the target then.
                        int required = hasProgress ? p.Int("<RequiredAmount>k__BackingField") : 0;
                        if (required <= 0) required = task.Int("_Amount");
                        long have = hasProgress ? p.Long("<Amount>k__BackingField") : 0;
                        tasks.Add(new TaskEntry { Task = task, Required = required, Have = have, Stage = task.Int("_Stage") });
                    }
                }
                // A staged quest only counts the current stage's tasks (kills before reaching it don't count).
                bool staged = !info.IsNull && info.BoolOrFalse("_Staged");
                int stage = quest.Int("<CurrentStage>k__BackingField");
                // The log: each quest, whether it's been handed in, and whether every task is done (ready to hand in).
                bool completed = quest.Bool("<Completed>k__BackingField");
                bool ready = !completed;
                foreach (TaskEntry entry in tasks)
                {
                    if (entry.Required > 0 && entry.Have < entry.Required) ready = false;
                }
                log.Add(new JsonObject { ["name"] = questName, ["completed"] = completed, ["ready"] = ready });
                if (completed) continue;
                foreach (TaskEntry entry in tasks)
                {
                    if (staged && entry.Stage > 0 && entry.Stage != stage) continue;
                    ClrObject task = entry.Task;
                    int kind = task.Int("_Task");
                    if (entry.Required > 0 && entry.Have >= entry.Required) continue;
                    if (kind == 2)
                    {
                        ClrObject region = task.Obj("_RegionParameter");
                        if (!region.IsNull)
                        {
                            ClrObject map = region.Obj("_Map");
                            regions.Add(new JsonObject { ["quest"] = questName, ["region"] = region.Int("<Index>k__BackingField"), ["map"] = map.IsNull ? null : map.Int("<Index>k__BackingField") });
                        }
                    }
                    else if (kind == 10)
                    {
                        ClrObject npc = task.Obj("_NpcParameter");
                        if (!npc.IsNull) talks.Add(new JsonObject { ["quest"] = questName, ["npc"] = npc.Int("<Index>k__BackingField") });
                    }
                    // Every unfinished task counts, whatever the quest's stage: the game marks those monsters "(Quest)" too.
                    foreach (ClrObject detail in Mem.ReadBindingList(task.Obj("<MonsterDetails>k__BackingField")))
                    {
                        ClrObject monster = detail.Obj("_Monster");
                        if (monster.IsNull) continue;
                        string name = monster.Str("_MonsterName");
                        ClrObject map = detail.Obj("_Map");
                        int? mapIndex = map.IsNull ? null : map.Int("<Index>k__BackingField");
                        string key = name + "|" + (mapIndex.HasValue ? mapIndex.Value.ToString(CultureInfo.InvariantCulture) : "");
                        // With the task's progress: done of need.
                        if (targets.ContainsKey(key)) continue;
                        JsonObject target = new JsonObject { ["name"] = name, ["map"] = mapIndex, ["quest"] = questName, ["done"] = entry.Have, ["need"] = entry.Required };
                        targets[key] = target;
                        targetsOut.Add(target);
                    }
                }
            }
        }

        // An int field some versions of the game don't have: 0 then (or when it can't be read).
        private static int OptionalInt(ClrObject o, string name) => o.IntOrNull(name) ?? 0;

        // ---- Gear ----

        // Library.ItemType numbers of things that are worn: weapon, armour, torch, helmet, necklace, bracelet, ring, shoes,
        // poison, amulet, emblem, shield, wings, belt.
        private static readonly HashSet<long> WearableTypes = new HashSet<long> { 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 26, 27, 28, 30 };
        // Items the bag is counted for, by name (the Boss circuit's quest rewards).
        private static readonly string[] CountedItems = { "Forge Stone", "Phoenix Tear" };
        // Library.ItemType.Consumable: potions, elixirs, scrolls.
        private const long ConsumableType = 1;

        // Read-Gear: what's worn (by Library.EquipmentSlot) and the wearable items in the bag (by bag slot, with their cell
        // on screen while the bag is open), each with its stats as rolled; how many of each consumable and counted item the
        // bag holds; and how many columns the bag's grid has.
        private JsonNode ReadGear(ClrObject scene)
        {
            // The character's class as a Library.RequiredClass flag, for set bonuses (ReadItemSet).
            try
            {
                int c = scene.Obj("_User").Byte("_Class");
                state.ClassFlag = c <= 7 ? 1L << c : c == 8 ? 256 : 512;
            }
            catch (Exception)
            {
                state.ClassFlag = 0;
            }
            JsonArray worn = new JsonArray();
            ClrObject equipment = scene.Obj("Equipment");
            if (!equipment.IsNull)
            {
                ClrArray slots = equipment.AsArray();
                for (int i = 0; i < slots.Length; i++)
                {
                    ClrObject item = slots.GetObjectValue(i);
                    if (item.IsNull) continue;
                    JsonObject read = ReadItem(item, i);
                    if (read != null) worn.Add(read);
                }
            }
            // With the bag open: each bag slot's cell on screen (cells showing only: the open tab, scrolled into view).
            Dictionary<int, JsonObject> cells = new Dictionary<int, JsonObject>();
            ClrObject box = scene.Obj("InventoryBox");
            if (Visible(box))
            {
                ClrObject grid = box.Obj("Grid").Obj("Grid");
                if (!grid.IsNull)
                {
                    ClrArray all = grid.AsArray();
                    for (int i = 0; i < all.Length; i++)
                    {
                        ClrObject cell = all.GetObjectValue(i);
                        if (!Visible(cell)) continue;
                        cells[cell.Int("_Slot")] = ReadBox(cell);
                    }
                }
            }
            JsonArray bag = new JsonArray();
            // How many of each CountedItems the bag holds (stacks added up), and of each consumable.
            Dictionary<string, long> counts = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
            List<string> countOrder = new List<string>();
            foreach (string name in CountedItems)
            {
                counts[name] = 0;
                countOrder.Add(name);
            }
            ClrObject inventory = scene.Obj("Inventory");
            if (!inventory.IsNull)
            {
                ClrArray slots = inventory.AsArray();
                for (int i = 0; i < slots.Length; i++)
                {
                    ClrObject item = slots.GetObjectValue(i);
                    if (item.IsNull) continue;
                    ClrObject info = item.Obj("Info");
                    if (info.IsNull) continue;
                    string itemName = info.Str("_ItemName");
                    long? type = info.Enum("_ItemType");
                    if (IsCounted(itemName) || type == ConsumableType)
                    {
                        if (itemName == null) throw new InvalidOperationException("an item in the bag has no name");
                        long count = 1;
                        try { count = item.Long("<Count>k__BackingField"); } catch (Exception) { }
                        if (!counts.TryGetValue(itemName, out long had))
                        {
                            had = 0;
                            countOrder.Add(itemName);
                        }
                        counts[itemName] = had + count;
                    }
                    if (!type.HasValue || !WearableTypes.Contains(type.Value)) continue;
                    JsonObject read = ReadItem(item, i);
                    if (read == null) continue;
                    if (cells.TryGetValue(i, out JsonObject cellBox)) read["cell"] = cellBox;
                    bag.Add(read);
                }
            }
            // How many columns the bag's grid has (its Main tab starts at bag slot 0, top left, row by row).
            int columns = 0;
            try { columns = scene.Obj("InventoryBox").Obj("Grid").Struct("_GridSize").Int("width"); } catch (Exception) { }
            JsonObject countsOut = new JsonObject();
            foreach (string name in countOrder)
            {
                // The name as first counted (the dictionary ignores case, as the old reader's did).
                if (!countsOut.ContainsKey(name)) countsOut[name] = counts[name];
            }
            return new JsonObject { ["worn"] = worn, ["bag"] = bag, ["counts"] = countsOut, ["columns"] = columns };
        }

        private static bool IsCounted(string name)
        {
            foreach (string counted in CountedItems)
            {
                if (string.Equals(counted, name, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private readonly Dictionary<int, int> statsScratch = new Dictionary<int, int>();

        // A Stats as { "stat number": value }.
        private JsonObject StatsObject(ClrObject stats)
        {
            Mem.ReadAllStats(stats, statsScratch);
            JsonObject out_ = new JsonObject();
            foreach (KeyValuePair<int, int> pair in statsScratch) out_[pair.Key.ToString(CultureInfo.InvariantCulture)] = pair.Value;
            return out_;
        }

        // Read-Item: one item (null when it has no ItemInfo): what it is, who can wear it, its rarity as rolled
        // (Library.Rarity: 0 Common .. 7 Set, else the item's own), its stats (its own and what it rolled on top, by
        // Library.Stat number), its weight and its set.
        private JsonObject ReadItem(ClrObject item, int slot)
        {
            ClrObject info = item.Obj("Info");
            if (info.IsNull) return null;
            long? rolled = item.Enum("<newRarity>k__BackingField");
            JsonObject set = null;
            try { set = ReadItemSet(item, info); } catch (Exception) { }
            return new JsonObject
            {
                ["slot"] = slot, ["name"] = info.Str("_ItemName"), ["type"] = info.Enum("_ItemType"),
                ["rarity"] = rolled.HasValue && rolled.Value != 0 ? rolled : info.Enum("_Rarity"),
                ["lootLevel"] = item.Int("<LootLevel>k__BackingField"),
                ["cls"] = info.Enum("_RequiredClass"), ["needs"] = info.Enum("_RequiredType"), ["needsAmount"] = info.Int("_RequiredAmount"),
                ["flags"] = item.Enum("<Flags>k__BackingField"), ["canSell"] = info.Bool("_CanSell"),
                ["durability"] = item.Int("<CurrentDurability>k__BackingField"), ["maxDurability"] = item.Int("<MaxDurability>k__BackingField"),
                ["base"] = StatsObject(info.Obj("Stats")), ["added"] = StatsObject(item.Obj("<AddedStats>k__BackingField")),
                ["weight"] = info.IntOrNull("_Weight"),
                ["set"] = set,
            };
        }

        // Read-ItemSet: the set an item is part of (its own rolled set, else its ItemInfo's): the set's name and each bonus
        // with the pieces it needs worn (all of the set's pieces when the game doesn't say), fewest pieces first. Not every
        // field name here is confirmed in game: those missing leave the set out.
        private JsonObject ReadItemSet(ClrObject item, ClrObject info)
        {
            ClrObject set = default;
            if (item.Has("<GeneratedSet>k__BackingField")) set = item.Obj("<GeneratedSet>k__BackingField");
            if (set.IsNull && info.Has("_Set")) set = info.Obj("_Set");
            if (set.IsNull) return null;
            int all = Mem.ReadAnyList(set.Obj("<Items>k__BackingField")).Count;
            // Pieces -> stat -> amount, in the order first seen.
            SortedDictionary<long, Dictionary<long, long>> bonuses = new SortedDictionary<long, Dictionary<long, long>>();
            Dictionary<long, List<long>> statOrder = new Dictionary<long, List<long>>();
            void Add(long pieces, long? stat, long? amount)
            {
                if (!stat.HasValue || stat.Value == 0 || !amount.HasValue || amount.Value == 0) return;
                // As the old reader's [int] casts.
                pieces = (int)pieces;
                long amountValue = (int)amount.Value;
                if (!bonuses.TryGetValue(pieces, out Dictionary<long, long> stats))
                {
                    bonuses[pieces] = stats = new Dictionary<long, long>();
                    statOrder[pieces] = new List<long>();
                }
                if (!stats.TryGetValue(stat.Value, out long had)) statOrder[pieces].Add(stat.Value);
                stats[stat.Value] = (int)(had + amountValue);
            }
            // Library.RequiredClass of the character (1 Warrior, 2 Wizard, 4 Taoist...): bonuses for other classes don't count.
            long mine = state.ClassFlag;
            bool ForMe(ClrObject entry)
            {
                long? c = entry.Enum("_RequiredClass") ?? entry.Enum("_Class");
                return !c.HasValue || c.Value == 0 || mine == 0 || (c.Value & mine) != 0;
            }
            // The full set's stats (SetInfoStat), and bonuses at a number of pieces (SetBonusInfo: stat bonuses only).
            foreach (ClrObject entry in Mem.ReadAnyList(set.Obj("<SetStats>k__BackingField")))
            {
                if (entry.IsNull || !ForMe(entry)) continue;
                Add(all, entry.Enum("_Stat"), entry.Enum("_Amount"));
            }
            foreach (ClrObject entry in Mem.ReadAnyList(set.Obj("<Bonuses>k__BackingField")))
            {
                if (entry.IsNull || !ForMe(entry)) continue;
                Add(entry.Enum("_RequiredPieces") ?? 0, entry.Enum("_Stat"), entry.Enum("_Amount"));
            }
            JsonArray bonusesOut = new JsonArray();
            foreach (KeyValuePair<long, Dictionary<long, long>> bonus in bonuses)
            {
                // The stats as an object (the old reader sent them cut short, as the text "System.Collections.Hashtable").
                JsonObject stats = new JsonObject();
                foreach (long stat in statOrder[bonus.Key]) stats[stat.ToString(CultureInfo.InvariantCulture)] = bonus.Value[stat];
                bonusesOut.Add(new JsonObject { ["pieces"] = bonus.Key, ["stats"] = stats });
            }
            return new JsonObject { ["name"] = set.Str("_SetName"), ["pieces"] = all, ["bonuses"] = bonusesOut };
        }

        // ---- The bloodline ----

        // Read-Bloodline: the bloodline (the game's Hermit system: points from levelling bought into stats): the points to
        // spend, what's been bought (by Library.Stat number), and, once the Character window's Bloodline tab has been
        // shown, the grade and each upgrade on offer with its button and hint (name, what it affects, its cost and what it
        // gives, as the game words it).
        private JsonNode ReadBloodline(ClrObject scene)
        {
            ClrObject user = scene.Obj("_User");
            if (user.IsNull) return null;
            JsonArray options = new JsonArray();
            JsonObject out_ = new JsonObject { ["points"] = user.Int("HermitPoints"), ["bought"] = StatsObject(user.Obj("_HermitStats")), ["options"] = options };
            ClrObject box = scene.Obj("CharacterBox");
            if (box.IsNull) return out_;
            ClrObject grade = box.Obj("BloodlineGrade");
            if (!grade.IsNull) out_["grade"] = grade.Str("_Text");
            bool open = box.Bool("_IsVisible");
            out_["open"] = open;
            foreach (ClrObject button in Mem.ReadList(box.Obj("bloodlineButtons")))
            {
                if (button.IsNull) continue;
                string hint = button.Str("_Hint");
                if (string.IsNullOrEmpty(hint)) continue;
                JsonObject option = new JsonObject { ["hint"] = hint, ["enabled"] = button.Bool("_IsEnabled") };
                if (open && button.Bool("_IsVisible")) option["box"] = ReadBox(button);
                options.Add(option);
            }
            ClrObject use = box.Obj("bloodlinePointsToUse");
            if (!use.IsNull && open && use.Bool("_IsVisible")) out_["pointsBox"] = ReadBox(use);
            return out_;
        }

        // ---- The game's auto potion ----

        // Read-AutoPotion: each link's item (ItemInfo index), the HP and MP it's drunk below (0: not for that), and
        // whether it's on. The game drinks these itself.
        private JsonNode ReadAutoPotion(ClrObject scene)
        {
            ClrObject box = scene.Obj("AutoPotionBox");
            if (box.IsNull) return null;
            ClrObject links = box.Obj("Links");
            if (links.IsNull) return null;
            JsonArray out_ = new JsonArray();
            ClrArray all = links.AsArray();
            for (int i = 0; i < all.Length; i++)
            {
                ClrObject link = all.GetObjectValue(i);
                if (link.IsNull) continue;
                int item = link.Int("<LinkInfoIndex>k__BackingField");
                if (item <= 0) continue;
                out_.Add(new JsonObject
                {
                    ["item"] = item, ["health"] = link.Int("<Health>k__BackingField"), ["mana"] = link.Int("<Mana>k__BackingField"), ["enabled"] = link.Bool("<Enabled>k__BackingField"),
                });
            }
            return out_;
        }

        // ---- Professions ----

        // Read-Professions: profession levels (Library.ProfessionId: 1 Fishing, 2 Mining, 3 Harvesting, 4 Taming, 5
        // Cooking, 6 Crafting, 7 Farming). The client only loads them once the Professions window (Ctrl+Shift+P) has been
        // opened: null until then.
        private JsonNode ReadProfessions(ClrObject scene)
        {
            ClrObject box = scene.Obj("ProfessionsBox");
            if (box.IsNull) return null;
            ClrObject snapshot = box.Obj("_snapshot");
            if (snapshot.IsNull) return null;
            JsonArray out_ = new JsonArray();
            foreach (ClrObject p in Mem.ReadList(snapshot.Obj("<Professions>k__BackingField")))
            {
                if (p.IsNull) continue;
                out_.Add(new JsonObject
                {
                    ["id"] = (int)p.Byte("<Profession>k__BackingField"), ["name"] = p.Str("<Name>k__BackingField"),
                    ["level"] = p.Int("<Level>k__BackingField"), ["usable"] = p.Int("<UsableLevel>k__BackingField"),
                    ["exp"] = p.Long("<LevelExperience>k__BackingField"), ["toNext"] = p.Long("<ExperienceToNextLevel>k__BackingField"),
                    ["canGain"] = p.Bool("<CanGainExperience>k__BackingField"), ["lockReason"] = p.Str("<GainExperienceLockReason>k__BackingField"),
                });
            }
            return out_;
        }
    }
}

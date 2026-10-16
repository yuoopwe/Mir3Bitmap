using System;
using System.Collections.Generic;
using System.Text.Json.Nodes;
using Microsoft.Diagnostics.Runtime;

namespace Bitmat.GameReader
{
    // The game's windows and buttons: where they are on screen, the survival panel (Return to Arcadia, the death window,
    // shops, NPC dialogs, quest windows, the bag), message boxes, and the Triple Triad match and card collection.
    internal sealed partial class Session
    {
        // ---- Boxes and buttons ----

        // Read-Box: a control's box on the game's screen: its top-left corner (its own position plus all its parents')
        // and size, its layout scaled by the game's UI scale.
        private JsonObject ReadBox(ClrObject control)
        {
            int x = 0, y = 0;
            ClrValueType size = control.Struct("_Size");
            for (ClrObject at = control; !at.IsNull; at = at.Obj("_Parent"))
            {
                ClrValueType location = at.Struct("_Location");
                x += location.Int("x");
                y += location.Int("y");
            }
            double k = state.UiScale;
            return new JsonObject
            {
                ["x"] = (int)Math.Round(x * k), ["y"] = (int)Math.Round(y * k),
                ["width"] = (int)Math.Round(size.Int("width") * k), ["height"] = (int)Math.Round(size.Int("height") * k),
            };
        }

        // Read-Button: a button: where it is, whether it can be pressed, and what it says. Null for none.
        private JsonObject ReadButton(ClrObject button)
        {
            if (button.IsNull) return null;
            JsonObject box = ReadBox(button);
            box["enabled"] = button.Bool("_IsEnabled") && button.Bool("_IsVisible");
            ClrObject label = button.Obj("<Label>k__BackingField");
            box["text"] = label.IsNull ? "" : label.Str("_Text");
            return box;
        }

        // Find-Button: a visible button somewhere under `control` whose label reads `text` (for buttons the game doesn't
        // keep a field for).
        private JsonObject FindButton(ClrObject control, string text, int depth = 0)
        {
            if (control.IsNull || depth > 6 || !control.Bool("_IsVisible")) return null;
            if (control.Has("<Label>k__BackingField"))
            {
                ClrObject label = control.Obj("<Label>k__BackingField");
                if (!label.IsNull && string.Equals(label.Str("_Text"), text, StringComparison.OrdinalIgnoreCase)) return ReadButton(control);
            }
            ClrObject kids = control.Obj("<Controls>k__BackingField");
            if (kids.IsNull) return null;
            ClrArray items = kids.Obj("_items").AsArray();
            int size = kids.Int("_size");
            for (int i = 0; i < size; i++)
            {
                JsonObject found = FindButton(items.GetObjectValue(i), text, depth + 1);
                if (found != null) return found;
            }
            return null;
        }

        private static bool Visible(ClrObject control) => !control.IsNull && control.Bool("_IsVisible");

        // ---- Staying alive, shops, NPCs and the bag ----

        // Library.Stat.BagWeight: the most the bag holds.
        private const int BagWeightStat = 73;

        // Read-Survival: the Return to Arcadia button, the death window (while it's up), shops and NPC dialogs, quest
        // windows, and how full the bag is (slots used of those unlocked, weight against the BagWeight stat). Each part is
        // left out when it can't be read.
        private JsonObject ReadSurvival(ClrObject scene)
        {
            JsonObject out_ = new JsonObject();
            try { out_["arcadia"] = ReadButton(scene.Obj("MainPanel").Obj("SanctuaryButton")); } catch (Exception) { }
            // An NPC's dialog (what clicking an NPC opens), so a stray one can be closed.
            try { out_["npcDialog"] = Visible(scene.Obj("NPCBox")); } catch (Exception) { }
            try
            {
                // A shop's sell panel while it's open (Select All picks what can be sold from the open bag tab).
                ClrObject sell = scene.Obj("NPCSellBox");
                if (Visible(sell))
                {
                    JsonObject panel = new JsonObject
                    {
                        ["selectAll"] = FindButton(sell, "Select All"), ["sell"] = ReadButton(sell.Obj("SellButton")), ["value"] = sell.Obj("CurrencyLabel").Str("_Text"),
                    };
                    out_["sell"] = panel;
                    ClrObject goods = scene.Obj("NPCGoodsBox");
                    try
                    {
                        if (!goods.IsNull) panel["close"] = ReadButton(goods.Obj("CloseButton"));
                    }
                    catch (Exception) { }
                }
                ClrObject inventory = scene.Obj("InventoryBox");
                if (!inventory.IsNull)
                {
                    out_["inventory"] = new JsonObject
                    {
                        ["open"] = inventory.Bool("_IsVisible"), ["section"] = inventory.Int("_activeSection"), ["mainTab"] = ReadButton(inventory.Obj("MainTabButton")),
                    };
                }
            }
            catch (Exception) { }
            try
            {
                // Talking to an NPC: the Talk / Quests menu some show first, and the quest list (Accept All, Hand In).
                ClrObject radial = scene.Obj("NPCRadialMenuBox");
                if (Visible(radial))
                {
                    out_["npcMenu"] = new JsonObject
                    {
                        ["quests"] = FindButton(radial, "Quests"), ["talk"] = FindButton(radial, "Talk"), ["waypoints"] = FindButton(radial, "Waypoints"),
                    };
                }
                ClrObject list = scene.Obj("NPCQuestListBox");
                if (Visible(list))
                {
                    ClrObject npc = list.Obj("_NPCInfo");
                    JsonArray quests = new JsonArray();
                    foreach (ClrObject q in Mem.ReadList(list.Obj("Quests"))) quests.Add(q.Str("_QuestName"));
                    JsonObject questList = new JsonObject
                    {
                        ["npc"] = npc.IsNull ? null : npc.Int("<Index>k__BackingField"),
                        ["acceptAll"] = ReadButton(list.Obj("AcceptAllButton")), ["handIn"] = ReadButton(list.Obj("HandInAllButton")), ["quests"] = quests,
                    };
                    out_["questList"] = questList;
                    // Its rows, to pick one quest at a time (some, as the Seasonal Supply Hunts, are left out of Accept All).
                    JsonArray rows = new JsonArray();
                    ClrObject cells = list.Obj("Rows");
                    if (!cells.IsNull)
                    {
                        ClrArray array = cells.AsArray();
                        for (int i = 0; i < array.Length; i++)
                        {
                            ClrObject row = array.GetObjectValue(i);
                            if (!Visible(row)) continue;
                            ClrObject info = row.Obj("_QuestInfo");
                            if (info.IsNull) continue;
                            JsonObject box = ReadBox(row);
                            box["name"] = info.Str("_QuestName");
                            box["taken"] = !row.Obj("_UserQuest").IsNull;
                            box["selected"] = row.Bool("_Selected");
                            rows.Add(box);
                        }
                    }
                    questList["rows"] = rows;
                }
                // The chosen quest's window: Accept, and Complete to hand it in.
                ClrObject quest = scene.Obj("NPCQuestBox");
                if (Visible(quest))
                {
                    ClrObject chosen = quest.Obj("_SelectedQuest");
                    ClrObject info = chosen.IsNull ? default : chosen.Obj("_QuestInfo");
                    out_["questBox"] = new JsonObject
                    {
                        ["quest"] = info.IsNull ? null : info.Str("_QuestName"),
                        ["accept"] = ReadButton(quest.Obj("AcceptButton")), ["complete"] = ReadButton(quest.Obj("CompleteButton")),
                    };
                }
            }
            catch (Exception) { }
            try
            {
                ClrObject death = scene.Obj("DeathOptionsBox");
                if (Visible(death)) out_["death"] = new JsonObject { ["returnButton"] = ReadButton(death.Obj("_returnButton")) };
            }
            catch (Exception) { }
            try
            {
                ClrArray slots = scene.Obj("Inventory").AsArray();
                int used = 0;
                for (int i = 0; i < slots.Length; i++)
                {
                    if (!slots.GetObjectValue(i).IsNull) used++;
                }
                ClrObject user = scene.Obj("_User");
                out_["bag"] = new JsonObject
                {
                    ["used"] = used, ["slots"] = scene.Obj("InventoryBox").Int("_lastUnlockedSlots"), ["weight"] = user.Int("BagWeight"), ["maxWeight"] = Mem.ReadStat(user, BagWeightStat),
                };
            }
            catch (Exception) { }
            return out_;
        }

        // ---- Message boxes ----

        private ClrStaticField messageBoxesField;

        // Read-MessageBoxes: the game's message boxes showing (a "sell these?" check, say): their text and buttons (those
        // that can be pressed, by the field that holds them), and how long each ignores clicks once shown.
        private JsonArray ReadMessageBoxes()
        {
            if (messageBoxesField == null) messageBoxesField = Static("Client.Controls.DXControl", "MessageBoxList");
            JsonArray out_ = new JsonArray();
            foreach (ClrObject box in Mem.ReadList(messageBoxesField.ReadObject(domain)))
            {
                if (!box.Bool("_IsVisible")) continue;
                JsonArray buttons = new JsonArray();
                foreach (ClrInstanceField f in box.Type.Fields)
                {
                    if (f.Type?.Name != "Client.Controls.DXButton") continue;
                    JsonObject b = ReadButton(box.ReadObjectField(f));
                    if (b != null && (bool)b["enabled"])
                    {
                        b["name"] = f.Name;
                        buttons.Add(b);
                    }
                }
                // Its text (DXMessageBox.Label is a property: the field behind it).
                ClrObject label = box.Obj("<Label>k__BackingField");
                out_.Add(new JsonObject { ["text"] = label.IsNull ? "" : label.Str("_Text"), ["buttons"] = buttons, ["cooldownMs"] = box.IntOrNull("ButtonCooldownMs") });
            }
            return out_;
        }

        // ---- Triple Triad ----

        // Read-Card: one card (null for none).
        private static JsonObject ReadCard(ClrObject card)
        {
            if (card.IsNull) return null;
            return new JsonObject
            {
                ["name"] = card.Str("<Name>k__BackingField"), ["image"] = card.Int("<ImageIndex>k__BackingField"),
                ["up"] = card.Int("<Up>k__BackingField"), ["right"] = card.Int("<Right>k__BackingField"),
                ["down"] = card.Int("<Down>k__BackingField"), ["left"] = card.Int("<Left>k__BackingField"),
                ["element"] = (int)card.Byte("<Element>k__BackingField"), ["level"] = card.Int("<Level>k__BackingField"),
            };
        }

        // Every Triple Triad card by its picture number (the decks are lists of these), read once an attach (the first card
        // of each picture), in the order the game lists them.
        private Dictionary<long, JsonObject> cardsByImage;
        private List<JsonObject> cardsInOrder;

        // Find-Card: a copy of the card with this picture, or a blank one when it isn't known.
        private JsonObject FindCard(long image)
        {
            if (cardsByImage == null)
            {
                // Kept as far as it was read when reading the cards fails (as the old reader's was).
                cardsByImage = new Dictionary<long, JsonObject>();
                cardsInOrder = new List<JsonObject>();
                ClrObject all = Static("Client.Scenes.Views.TripleTriad.TripleTriadCardDB", "<AllCards>k__BackingField").ReadObject(domain);
                foreach (ClrObject card in Mem.ReadList(all))
                {
                    JsonObject c = ReadCard(card);
                    if (c == null) continue;
                    long key = (int)c["image"];
                    if (cardsByImage.ContainsKey(key)) continue;
                    cardsByImage[key] = c;
                    cardsInOrder.Add(c);
                }
            }
            if (cardsByImage.TryGetValue(image, out JsonObject found)) return (JsonObject)found.DeepClone();
            return new JsonObject { ["image"] = image, ["name"] = "?", ["up"] = 0, ["right"] = 0, ["down"] = 0, ["left"] = 0, ["element"] = 0 };
        }

        // Read-RuleList: the values of a List<TripleTriadRule> (an enum list, so plain numbers); none for anything else.
        private static List<long> ReadRuleList(ClrObject list)
        {
            List<long> out_ = new List<long>();
            if (list.IsNull || list.Type == null || list.Type.Name == null || !list.Type.Name.StartsWith("System.Collections.Generic.List", StringComparison.OrdinalIgnoreCase)) return out_;
            int size = list.Int("_size");
            ClrArray items = list.Obj("_items").AsArray();
            for (int i = 0; i < size; i++) out_.Add(Mem.ReadNumber(items, i));
            return out_;
        }

        private static int IndexOfAddress(List<ClrObject> objects, ulong address)
        {
            for (int i = 0; i < objects.Count; i++)
            {
                if (objects[i].Address == address) return i;
            }
            return -1;
        }

        // Read-Triad: the Triple Triad match on screen, if any: the board, both decks, whose turn it is, and where the
        // hand's cards are.
        private JsonNode ReadTriad(ClrObject scene)
        {
            // The result box's OK button, once a game is over.
            JsonObject ok = null;
            ClrObject result = scene.Obj("_tripleTriadResultBox");
            if (Visible(result))
            {
                ClrObject button = result.Obj("OKButton");
                if (Visible(button)) ok = ReadBox(button);
            }
            ClrObject dialog = scene.Obj("TripleTriadBox");
            if (!Visible(dialog)) return ok != null ? new JsonObject { ["open"] = false, ["ok"] = ok } : null;
            ClrObject game = dialog.Obj("_manager").Obj("<Game>k__BackingField");
            if (game.IsNull) return new JsonObject { ["open"] = true, ["ok"] = ok };
            List<ClrObject> players = Mem.ReadList(game.Obj("<Players>k__BackingField"));
            ClrObject current = game.Obj("<CurrentPlayer>k__BackingField");
            ClrObject board = game.Obj("<Board>k__BackingField");
            ClrArray cells = board.Obj("_cells").AsArray();
            ClrArray elements = board.Obj("_elements").AsArray();
            JsonArray placed = new JsonArray();
            JsonArray boardElements = new JsonArray();
            for (int row = 0; row < 3; row++)
            {
                for (int col = 0; col < 3; col++)
                {
                    int[] at = { row, col };
                    ClrObject cell = cells.GetObjectValue(at);
                    JsonObject card = cell.IsNull ? null : ReadCard(cell.Obj("<Card>k__BackingField"));
                    if (card != null) card["owner"] = IndexOfAddress(players, cell.Obj("<Owner>k__BackingField").Address);
                    placed.Add(card);
                    boardElements.Add(Mem.ReadNumber(elements, at));
                }
            }
            long rules = 0;
            foreach (long rule in ReadRuleList(game.Obj("<ActiveRules>k__BackingField"))) rules |= rule;
            // My hand as drawn (each card and where it is), and where the board's squares are.
            JsonArray hand = new JsonArray();
            ClrArray deckCells = dialog.Obj("_deckCells").AsArray();
            for (int i = 0; i < deckCells.Length; i++)
            {
                ClrObject control = deckCells.GetObjectValue(i);
                if (!Visible(control)) continue;
                JsonObject box = ReadBox(control);
                box["card"] = FindCard(control.Int("_Index"));
                hand.Add(box);
            }
            JsonArray squares = new JsonArray();
            ClrArray boardCells = dialog.Obj("_boardCells").AsArray();
            for (int row = 0; row < 3; row++)
            {
                for (int col = 0; col < 3; col++)
                {
                    ClrObject square = boardCells.GetObjectValue(new[] { row, col });
                    JsonObject box = ReadBox(square);
                    box["image"] = square.Int("_Index");
                    squares.Add(box);
                }
            }
            ClrObject turns = dialog.Obj("_authoritativeTurns");
            JsonArray playersOut = new JsonArray();
            foreach (ClrObject player in players)
            {
                JsonArray deck = new JsonArray();
                foreach (ClrObject card in Mem.ReadList(player.Obj("<Deck>k__BackingField"))) deck.Add(ReadCard(card));
                playersOut.Add(new JsonObject { ["name"] = player.Str("<Name>k__BackingField"), ["ai"] = player.Bool("<IsAI>k__BackingField"), ["deck"] = deck });
            }
            JsonArray myDeck = new JsonArray();
            foreach (long image in Mem.ReadIntList(dialog.Obj("<PlayerDeck>k__BackingField"))) myDeck.Add(FindCard(image));
            JsonArray opponentDeck = new JsonArray();
            foreach (long image in Mem.ReadIntList(dialog.Obj("<OpponentDeck>k__BackingField"))) opponentDeck.Add(FindCard(image));
            return new JsonObject
            {
                ["open"] = true,
                ["ok"] = ok,
                ["rules"] = rules,
                ["current"] = IndexOfAddress(players, current.Address),
                ["stage"] = turns.IsNull ? -1 : turns.Int("_stage"),
                ["complete"] = dialog.Bool("_authoritativeMatchComplete"),
                ["players"] = playersOut,
                ["board"] = placed,
                ["elements"] = boardElements,
                ["hand"] = hand,
                ["squares"] = squares,
                ["myDeck"] = myDeck,
                ["opponentDeck"] = opponentDeck,
                ["playerName"] = dialog.Str("<PlayerName>k__BackingField"),
                ["opponentName"] = dialog.Str("<OpponentName>k__BackingField"),
            };
        }

        // Read-Collection: the card collection window, if open: the cards owned, the deck being edited, and where
        // everything is drawn.
        private JsonNode ReadCollection(ClrObject scene)
        {
            ClrObject dialog = scene.Obj("TripleTriadCollectionBox");
            if (!Visible(dialog)) return null;
            ClrObject user = scene.Obj("_User");
            JsonArray owned = new JsonArray();
            foreach (ClrObject entry in Mem.ReadList(user.Obj("TripleTriadCards")))
            {
                owned.Add(new JsonObject { ["card"] = FindCard(entry.Int("<Index>k__BackingField")), ["count"] = entry.Int("<Count>k__BackingField") });
            }
            JsonArray deckSlots = new JsonArray();
            ClrArray cells = dialog.Obj("_deckCells").AsArray();
            for (int i = 0; i < cells.Length; i++) deckSlots.Add(ReadBox(cells.GetObjectValue(i)));
            JsonArray tabs = new JsonArray();
            ClrObject levelTabs = dialog.Obj("_levelTabs");
            ClrArray entries = levelTabs.Obj("_entries").AsArray();
            int count = levelTabs.Int("_count");
            for (int e = 0; e < count; e++)
            {
                ClrValueType entry = entries.GetStructValue(e);
                ClrObject info = entry.Obj("value");
                if (info.IsNull) continue;
                ClrObject tab = info.Obj("Tab");
                ClrObject panel = info.Obj("CardPanel");
                ClrObject scroll = info.Obj("ScrollBar");
                JsonArray slots = new JsonArray();
                foreach (ClrObject slot in Mem.ReadList(info.Obj("Slots")))
                {
                    ClrObject image = slot.Obj("Image");
                    if (image.IsNull) continue;
                    JsonObject box = ReadBox(image);
                    box["image"] = slot.Int("CardIndex");
                    box["shown"] = slot.Bool("FilteredIn") && image.Bool("_IsVisible");
                    slots.Add(box);
                }
                tabs.Add(new JsonObject
                {
                    ["level"] = entry.Int("key"), ["selected"] = tab.Bool("_Selected"),
                    ["button"] = ReadButton(tab.Obj("<TabButton>k__BackingField")), ["panel"] = ReadBox(panel),
                    ["up"] = scroll.IsNull ? null : ReadButton(scroll.Obj("UpButton")),
                    ["down"] = scroll.IsNull ? null : ReadButton(scroll.Obj("DownButton")),
                    ["slots"] = slots,
                });
            }
            JsonArray saved = new JsonArray();
            foreach (long image in Mem.ReadIntList(user.Obj("TripleTriadDeck"))) saved.Add(image);
            JsonArray draft = new JsonArray();
            foreach (long image in Mem.ReadIntList(dialog.Obj("_draftDeck"))) draft.Add(image);
            JsonObject out_ = new JsonObject
            {
                ["owned"] = owned,
                ["saved"] = saved,
                ["draft"] = draft,
                ["dirty"] = dialog.Bool("_deckDirty"),
                ["selectedSlot"] = dialog.Int("_selectedDeckSlot"),
                ["detail"] = dialog.Int("_selectedDetailCard"),
                ["feedback"] = dialog.Str("_deckFeedback"),
                ["deckSlots"] = deckSlots,
                ["action"] = ReadButton(dialog.Obj("_deckActionButton")),
                ["save"] = ReadButton(dialog.Obj("_saveDeckButton")),
                ["undo"] = ReadButton(dialog.Obj("_revertDeckButton")),
                ["tabs"] = tabs,
            };
            // Every card known (with none read yet this attach: a list of one null, as the old reader sent).
            JsonArray cards = new JsonArray();
            if (cardsInOrder == null) cards.Add(null);
            else foreach (JsonObject card in cardsInOrder) cards.Add(card.DeepClone());
            out_["cards"] = cards;
            return out_;
        }
    }
}

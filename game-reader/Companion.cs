using System;
using System.Text.Json.Nodes;
using Microsoft.Diagnostics.Runtime;

namespace Bitmat.GameReader
{
    // The companion (pet): who it is, how full its bag is, and the game's transfer of that bag into the player's.
    internal sealed partial class Session
    {
        // Read-Companion: the companion out (GameScene._Companion; null for none): its level, hunger and experience, its
        // bag (slots used of those it has, weight of the most, from the companion window, which keeps them up to date
        // whether or not it shows), whether a transfer is moving items, and the confirmation box the transfer opens.
        private JsonObject ReadCompanion(ClrObject scene)
        {
            ClrObject companion = scene.Obj("_Companion");
            if (companion.IsNull) return null;
            JsonObject out_ = new JsonObject
            {
                ["name"] = companion.Has("<Name>k__BackingField") ? companion.Str("<Name>k__BackingField") : null,
                ["level"] = companion.IntOrNull("<Level>k__BackingField"),
                ["hunger"] = companion.IntOrNull("<Hunger>k__BackingField"),
                ["experience"] = companion.IntOrNull("<Experience>k__BackingField"),
            };
            int used = 0;
            ClrObject items = companion.Obj("InventoryArray");
            if (!items.IsNull)
            {
                ClrArray array = items.AsArray();
                for (int i = 0; i < array.Length; i++)
                {
                    if (!array.GetObjectValue(i).IsNull) used++;
                }
            }
            ClrObject box = scene.Obj("CompanionBox");
            if (box.IsNull)
            {
                out_["bag"] = new JsonObject { ["used"] = used };
                return out_;
            }
            ClrObject info = box.Has("Info") ? box.Obj("Info") : default;
            if (!info.IsNull)
            {
                out_["maxHunger"] = info.IntOrNull("_MaxHunger") ?? info.IntOrNull("<MaxHunger>k__BackingField");
                out_["maxExperience"] = info.IntOrNull("_MaxExperience") ?? info.IntOrNull("<MaxExperience>k__BackingField");
            }
            out_["bag"] = new JsonObject
            {
                ["used"] = used, ["slots"] = box.IntOrNull("InventorySize"),
                ["weight"] = box.IntOrNull("BagWeight"), ["maxWeight"] = box.IntOrNull("MaxBagWeight"),
                ["transferring"] = box.BoolOrFalse("_transferQueueRunning"),
            };
            out_["window"] = Visible(box);
            // The transfer's "are you sure?" box (also used for dropping the whole bag: its button says which).
            ClrObject confirm = box.Has("_actionConfirmation") ? box.Obj("_actionConfirmation") : default;
            out_["confirm"] = Visible(confirm) && confirm.Has("ConfirmButton") ? ReadButton(confirm.Obj("ConfirmButton")) : null;
            return out_;
        }
    }
}

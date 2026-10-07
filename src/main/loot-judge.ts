/**
 * The loot judge: whether an item in the bag is worth keeping out of the
 * sale. It scores an item for the character's class by its stats (the item's
 * own and what it rolled on top), and compares it with what's worn where it
 * would go: better by a margin is an upgrade. Rare items are kept whatever
 * they score. Pure: no game, no screen.
 */
import type { MemoryItem } from './game-memory';
import { classFlagOf } from './travel';

/** The stats the judge weighs: a pair (min and max, counted at their average) or a single stat, by Library.Stat number. */
const STATS = {
  AC: [4, 5],
  MR: [6, 7],
  DC: [8, 9],
  MC: [10, 11],
  SC: [12, 13],
  HP: [2],
  MP: [3],
  Acc: [14],
  Agil: [15],
  ASpd: [16],
  Luck: [19],
} as const;

type StatKey = keyof typeof STATS;
type Weights = Partial<Record<StatKey, number>>;

/** Every number the judge is tuned by, in one place. */
export const LOOT = {
  /** An item must score this much more than what's worn to be an upgrade (0.05: 5%)... */
  upgradeMargin: 0.05,
  /** ...and this much more to be put on, with "Put on clear upgrades". */
  equipMargin: 0.15,
  /** Items this rare or rarer (Library.Rarity: 3 Legendary) are kept whatever they score: they may be worth something. */
  keepRarity: 3,
  /**
   * What each stat is worth to each class (Library.MirClass), per point. Health and mana come in bigger numbers, so
   * they weigh little a point. Classes not listed use `other`.
   */
  weights: {
    0: { DC: 10, AC: 4, MR: 3, Acc: 3, ASpd: 3, Agil: 2, HP: 0.1, Luck: 2 },
    1: { MC: 10, MR: 4, AC: 3, Agil: 1, Acc: 1, HP: 0.1, MP: 0.05, Luck: 2 },
    2: { SC: 10, MR: 4, AC: 3, Agil: 1, Acc: 1, HP: 0.1, MP: 0.05, Luck: 2 },
    3: { DC: 10, Agil: 4, Acc: 4, ASpd: 3, AC: 3, MR: 3, HP: 0.1, Luck: 2 },
    6: { DC: 10, Acc: 5, Agil: 3, ASpd: 3, AC: 3, MR: 3, HP: 0.1, Luck: 2 },
    7: { DC: 10, ASpd: 4, Acc: 3, Agil: 3, AC: 3, MR: 3, HP: 0.1, Luck: 2 },
  } as Record<number, Weights>,
  /** Summoner, Druid and the rest, whose main stat isn't known yet: every kind of damage counts. */
  other: { DC: 10, MC: 10, SC: 10, AC: 3, MR: 3, Acc: 2, Agil: 2, HP: 0.1, Luck: 2 } as Weights,
};

export const RARITY_NAMES = ['Common', 'Superior', 'Elite', 'Legendary', 'Xtreme', 'Celestial', 'Unique', 'Set'];

/** Where each Library.ItemType is worn (Library.EquipmentSlot): rings and bracelets have two places. */
export const ITEM_SLOTS: Record<number, number[]> = {
  2: [0], 3: [1], 4: [3], 5: [2], 6: [4], 7: [5, 6], 8: [7, 8], 9: [9], 10: [10], 11: [11], 26: [14], 27: [15], 28: [16], 30: [17],
};

const SLOT_NAMES: Record<number, string> = {
  0: 'Weapon', 1: 'Armour', 2: 'Helmet', 3: 'Torch', 4: 'Necklace', 5: 'Bracelet', 6: 'Bracelet', 7: 'Ring', 8: 'Ring', 9: 'Shoes',
  10: 'Poison', 11: 'Amulet', 14: 'Emblem', 15: 'Shield', 16: 'Wings', 17: 'Belt',
};

/** Library.RequiredType stat requirements, and the stat of the character's (MemoryState user.combat) each is checked against. */
const NEEDS_STAT: Record<number, keyof Combat> = { 2: 'maxAC', 3: 'maxMR', 4: 'maxDC', 5: 'maxMC', 6: 'maxSC' };

type Combat = { maxAC: number; maxMR: number; maxDC: number; maxMC: number; maxSC: number };

/** The character: Library.MirClass, level, and (when read) their stats with gear, for stat requirements. */
export interface Wearer {
  cls?: number;
  level?: number;
  combat?: Combat | null;
}

export interface Verdict {
  /** Keep it out of the sale: an upgrade, or rare. */
  keep: boolean;
  upgrade: boolean;
  /** The Library.EquipmentSlot it would go in (the weaker of two), or null for items not worn anywhere known. */
  slot: number | null;
  /** How much better than what's worn there (0.18: 18%); Infinity with nothing worn there; 0 when it can't be worn. */
  gain: number;
  /** Why, for the log: "+18% over Ironforge Blade (DC 16–38 → 20–45, +3 Acc)". */
  reason: string;
}

/** An item's stat, its own and what it rolled on top together. */
function stat(item: MemoryItem, number: number): number {
  return (item.base[number] ?? 0) + (item.added[number] ?? 0);
}

function weightsFor(cls: number | undefined): Weights {
  return (cls !== undefined && LOOT.weights[cls]) || LOOT.other;
}

/** What an item is worth to the class: its weighted stats, min/max pairs at their average. */
export function scoreItem(item: MemoryItem, cls: number | undefined): number {
  let score = 0;
  for (const [key, weight] of Object.entries(weightsFor(cls)) as [StatKey, number][]) {
    const numbers = STATS[key];
    score += (weight * numbers.reduce((sum, n) => sum + stat(item, n), 0)) / numbers.length;
  }
  return score;
}

/** Why the character can't wear it, or null if they can: the class, the level, or a stat it needs. */
export function cantWear(item: MemoryItem, who: Wearer): string | null {
  if (who.cls === undefined || !(item.cls & classFlagOf(who.cls))) return 'not for this class';
  if (item.needs === 0) return (who.level ?? 0) >= item.needsAmount ? null : `needs level ${item.needsAmount}`;
  const needed = NEEDS_STAT[item.needs];
  const have = needed && who.combat?.[needed];
  if (have === undefined || have === null) return 'needs a stat that isn\'t known';
  return have >= item.needsAmount ? null : `needs ${needed.slice(3)} ${item.needsAmount}`;
}

/**
 * The verdict on a bag item, against what's worn (MemoryState gear.worn). It's
 * an upgrade when the character can wear it and it beats what's worn where it
 * goes by LOOT.upgradeMargin (or nothing is worn there); with two places (rings,
 * bracelets), against the weaker. Kept too when it's LOOT.keepRarity or rarer.
 */
export function judgeItem(item: MemoryItem, worn: readonly MemoryItem[], who: Wearer, options: { margin?: number; keepRarity?: number } = {}): Verdict {
  const margin = options.margin ?? LOOT.upgradeMargin;
  const rare = item.rarity >= (options.keepRarity ?? LOOT.keepRarity);
  const rarity = RARITY_NAMES[item.rarity] ?? `rarity ${item.rarity}`;
  const verdict = (upgrade: boolean, slot: number | null, gain: number, why: string): Verdict => ({
    keep: upgrade || rare,
    upgrade,
    slot,
    gain,
    reason: upgrade || !rare ? why : `${rarity} (${why})`,
  });
  const slots = ITEM_SLOTS[item.type];
  if (!slots) return verdict(false, null, 0, 'not worn anywhere known');
  const why = cantWear(item, who);
  if (why) return verdict(false, slots[0], 0, why);

  // The weaker of its places: an empty one first.
  const there = slots.map((slot) => ({ slot, item: worn.find((w) => w.slot === slot), score: 0 }));
  for (const t of there) t.score = t.item ? scoreItem(t.item, who.cls) : -Infinity;
  const weakest = there.reduce((a, b) => (b.score < a.score ? b : a));
  if (!weakest.item) return verdict(true, weakest.slot, Infinity, `nothing worn as ${SLOT_NAMES[weakest.slot] ?? `slot ${weakest.slot}`}`);
  const score = scoreItem(item, who.cls);
  const gain = weakest.score > 0 ? score / weakest.score - 1 : score > 0 ? Infinity : 0;
  const percent = gain === Infinity ? 'better' : `${gain >= 0 ? '+' : ''}${Math.round(gain * 100)}%`;
  const upgrade = gain > margin;
  const changes = describeChanges(weakest.item, item, who.cls);
  return verdict(upgrade, weakest.slot, gain, `${percent} ${upgrade ? 'over' : 'against'} ${weakest.item.name}${changes ? ` (${changes})` : ''}`);
}

/** The stats the class cares about that differ: "DC 16–38 → 20–45, +3 Acc". */
export function describeChanges(from: MemoryItem, to: MemoryItem, cls: number | undefined): string {
  const out: string[] = [];
  for (const key of Object.keys(weightsFor(cls)) as StatKey[]) {
    const numbers = STATS[key];
    const a = numbers.map((n) => stat(from, n));
    const b = numbers.map((n) => stat(to, n));
    if (a.every((v, i) => v === b[i])) continue;
    if (numbers.length === 2) out.push(`${key} ${a[0]}–${a[1]} → ${b[0]}–${b[1]}`);
    else out.push(`${b[0] > a[0] ? '+' : ''}${b[0] - a[0]} ${key}`);
  }
  return out.join(', ');
}

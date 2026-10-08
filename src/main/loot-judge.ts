/**
 * The loot judge: whether an item in the bag is worth keeping out of the
 * sale. It scores an item by its stats (the item's own and what it rolled on
 * top): by what each stat is worth to this character for what they do (the
 * stat guide, stat-values.ts), or without that, by fixed weights for the
 * class. It compares the score with what's worn where the item would go:
 * better by a margin is an upgrade. Rare items are kept whatever they score.
 * Pure: no game, no screen.
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
  /** With the loadout optimiser's advice, "Put on clear upgrades" puts on its best gear when that does this much better (0.02: 2% more of what the character does). */
  equipGearGain: 0.02,
  /** Items this rare or rarer (Library.Rarity: 3 Legendary) are kept whatever they score: they may be worth something. */
  keepRarity: 3,
  /**
   * Without the stat guide's values: what each stat is worth to each class (Library.MirClass), per point. Health and mana come in bigger numbers, so
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

export const SLOT_NAMES: Record<number, string> = {
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

/** What a point of each stat is worth (by Library.Stat number), from the stat guide (stat-values.ts perStat). */
export type PointValues = Readonly<Record<number, number>>;

/**
 * What an item is worth to the character: its stats at `values` (the stat
 * guide's), else at the class's fixed weights, min/max pairs at their average.
 */
export function scoreItem(item: MemoryItem, cls: number | undefined, values?: PointValues | null): number {
  if (values) return Object.entries(values).reduce((sum, [n, value]) => sum + value * stat(item, Number(n)), 0);
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
 * Scored at the stat guide's `values` when given, else the class's weights.
 * Kept also when `planned` says why the loadout optimiser wants it (part of the
 * best gear, or of the best for a boss: loadout.ts), whatever it scores alone.
 */
export function judgeItem(
  item: MemoryItem,
  worn: readonly MemoryItem[],
  who: Wearer,
  options: { margin?: number; keepRarity?: number; values?: PointValues | null; planned?: string | null } = {},
): Verdict {
  const margin = options.margin ?? LOOT.upgradeMargin;
  const rare = item.rarity >= (options.keepRarity ?? LOOT.keepRarity);
  const rarity = RARITY_NAMES[item.rarity] ?? `rarity ${item.rarity}`;
  const planned = options.planned ?? null;
  const verdict = (upgrade: boolean, slot: number | null, gain: number, why: string): Verdict => ({
    keep: upgrade || rare || !!planned,
    upgrade,
    slot,
    gain,
    reason: upgrade ? why : planned ?? (rare ? `${rarity} (${why})` : why),
  });
  const slots = ITEM_SLOTS[item.type];
  if (!slots) return verdict(false, null, 0, 'not worn anywhere known');
  const why = cantWear(item, who);
  if (why) return verdict(false, slots[0], 0, why);

  // The weaker of its places: an empty one first.
  const there = slots.map((slot) => ({ slot, item: worn.find((w) => w.slot === slot), score: 0 }));
  for (const t of there) t.score = t.item ? scoreItem(t.item, who.cls, options.values) : -Infinity;
  const weakest = there.reduce((a, b) => (b.score < a.score ? b : a));
  if (!weakest.item) return verdict(true, weakest.slot, Infinity, `nothing worn as ${SLOT_NAMES[weakest.slot] ?? `slot ${weakest.slot}`}`);
  const score = scoreItem(item, who.cls, options.values);
  // The guide says none of their stats count for what the character does now (armour where nothing gets through, say): the class's weights decide.
  if (options.values && score === 0 && weakest.score === 0) return judgeItem(item, worn, who, { ...options, values: null });
  const gain = weakest.score > 0 ? score / weakest.score - 1 : score > 0 ? Infinity : 0;
  const percent = gain === Infinity ? 'better' : `${gain >= 0 ? '+' : ''}${Math.round(gain * 100)}%`;
  const upgrade = gain > margin;
  const changes = describeChanges(weakest.item, item, who.cls);
  return verdict(upgrade, weakest.slot, gain, `${percent} ${upgrade ? 'over' : 'against'} ${weakest.item.name}${changes ? ` (${changes})` : ''}`);
}

/** Library.EquipmentSlot places worn for fighting (not the horse, nor the profession tools). */
const FIGHT_SLOTS = new Set(Object.values(ITEM_SLOTS).flat());

const STAT_WORDS: [number[], string][] = [[[8, 9], 'DC'], [[10, 11], 'MC'], [[12, 13], 'SC'], [[4, 5], 'AC'], [[6, 7], 'MR'], [[2], 'HP'], [[16], 'Attack Speed'], [[14], 'Accuracy'], [[15], 'Agility']];

/** Worn items that are broken (worn out: they give nothing) and what that costs: "Steelforge Blade is broken: −22–51 DC, repair it". */
export function brokenWorn(worn: readonly MemoryItem[]): string[] {
  return worn
    .filter((item) => FIGHT_SLOTS.has(item.slot) && item.maxDurability > 0 && item.durability <= 0)
    .map((item) => {
      const lost = STAT_WORDS.map(([numbers, word]) => {
        const values = numbers.map((n) => stat(item, n));
        return values.some((v) => v) ? `−${values.join('–')} ${word}` : '';
      }).filter(Boolean);
      return `${item.name} is broken: ${lost.length ? `${lost.join(', ')}, ` : ''}repair it`;
    });
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

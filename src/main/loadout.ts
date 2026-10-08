/**
 * The loadout optimiser: the best set of gear from what's worn and what's in
 * the bag. Adding up items doesn't give the game's totals (broken items, tools
 * and the horse give nothing; class base stats and the bloodline add; % stats
 * multiply; the server has rules of its own), so totals are never rebuilt.
 * They start from what the game shows and change by what a swap takes away and
 * adds, a % stat applied to the sum it multiplies (worked back from the total
 * and the % now). Corrections fitted from real gear changes (GearWatch)
 * adjust those changes. The swaps are put in an order the requirements and
 * weight limits allow (a stat requirement is checked with what's worn at the
 * time). Loadouts are scored by the caller (the combat model and the stat
 * guide) and searched: the best one or two swaps again and again, from what's
 * worn and from the best of a beam over the top few per slot, so thresholds
 * that take two items (both rings, a ring and a bracelet) show. Pure: no game,
 * no screen.
 */
import { elementOf, type Combat, type Fighter } from './combat-model';
import type { MemoryItem, MemoryState } from './game-memory';
import { ITEM_SLOTS, SLOT_NAMES, cantWear } from './loot-judge';

/** Every number the optimiser is tuned by, in one place. */
export const LOADOUT = {
  /** Library.EquipmentSlot: the horse (its stats only count while mounted, and fights are on foot) and the profession tools. */
  horseSlot: 18,
  toolSlots: [28, 29, 30, 31, 32],
  /** Slots whose items weigh on HandWeight (the rest on WearWeight): the weapon. */
  handSlots: [0],
  /** The beam keeps this many loadouts; each slot's best this many items are tried in it and in pair swaps. */
  beamWidth: 4,
  topPerSlot: 3,
  /** A swap must raise the score by more than this (rounding aside); and the search stops after this many rounds. */
  minGain: 1e-6,
  maxRounds: 20,
  // ---- Corrections from real gear changes ----
  /** After a gear change, the totals are read this long after (gear is read once a second, stats can lag it). */
  settleMs: 1500,
  /** ...and only against totals read at most this long before the change (older ones may have changed for other reasons: a buff ending). */
  maxBeforeMs: 10_000,
  /** Each check counts this much less than the next newer one; trusted fully after this many; and capped. */
  recency: 0.9,
  fullTrustChecks: 5,
  minCorrection: 0.5,
  maxCorrection: 1.5,
  /** Checks kept. */
  maxChecks: 50,
};

/** Stats by Library.Stat number. */
export type Stats = Record<number, number>;

/** The stat each stat's % multiplies it by: HP by HealthPercent (54), Mana by ManaPercent (94), AC by ACPercent (10031)... */
export const PERCENT_OF: Readonly<Record<number, number>> = { 2: 54, 3: 94, 4: 10031, 5: 10031, 6: 10032, 7: 10032, 8: 84, 9: 84, 10: 67, 11: 67, 12: 85, 13: 85 };

/** The Combat stats by Library.Stat number. */
const COMBAT_STATS: Record<keyof Combat, number> = {
  minAC: 4, maxAC: 5, minMR: 6, maxMR: 7, minDC: 8, maxDC: 9, minMC: 10, maxMC: 11, minSC: 12, maxSC: 13, accuracy: 14, agility: 15, attackSpeed: 16,
};
const HEALTH = 2;
const WEAR_WEIGHT = 74;
const HAND_WEIGHT = 75;

/** Every slot items are worn in for fighting (ITEM_SLOTS'), in order. */
const FIGHT_SLOTS = [...new Set(Object.values(ITEM_SLOTS).flat())].sort((a, b) => a - b);

/** The character as the optimiser starts from: the game's totals now, the weight worn, class, level, and whether mounted. */
export interface Character {
  /** By Library.Stat number: the combat stats, health (2), the % stats' sums, and the weight limits (WearWeight 74, HandWeight 75). */
  totals: Stats;
  /** Weight worn on the body and in hand (null: not read, so not checked). */
  wear: number | null;
  hand: number | null;
  cls: number;
  level: number;
  mounted: boolean;
}

/** The character from the game's memory, or null without their stats. */
export function characterOf(reading: Pick<MemoryState, 'user'>): Character | null {
  const user = reading.user;
  if (!user?.combat || !user.maxHp || user.class === undefined || user.level === undefined) return null;
  const totals: Stats = { [HEALTH]: user.maxHp };
  for (const [key, n] of Object.entries(COMBAT_STATS) as [keyof Combat, number][]) totals[n] = user.combat[key];
  for (const [n, value] of Object.entries(user.percents ?? {})) totals[Number(n)] = value;
  const weights = user.weights;
  if (weights) Object.assign(totals, { [WEAR_WEIGHT]: weights.wearMax, [HAND_WEIGHT]: weights.handMax });
  return { totals, wear: weights?.wear ?? null, hand: weights?.hand ?? null, cls: user.class, level: user.level, mounted: !!user.mounted };
}

/** Worn out: it gives nothing until repaired. */
export function isBroken(item: MemoryItem): boolean {
  return item.maxDurability > 0 && item.durability <= 0;
}

/** Why an item worn in `slot` gives nothing in a fight (broken, a tool, the horse on foot), or null if it counts. */
export function givesNothing(item: MemoryItem, slot: number, mounted: boolean): string | null {
  if (LOADOUT.toolSlots.includes(slot)) return 'a profession tool';
  if (slot === LOADOUT.horseSlot && !mounted) return 'the horse, not ridden';
  if (isBroken(item)) return 'broken';
  return null;
}

/** An item's stats, its own and what it rolled together. */
export function itemStats(item: MemoryItem): Stats {
  const out: Stats = {};
  for (const stats of [item.base, item.added]) for (const [n, value] of Object.entries(stats)) out[Number(n)] = (out[Number(n)] ?? 0) + value;
  return out;
}

const add = (into: Stats, stats: Stats, sign = 1) => {
  for (const [n, value] of Object.entries(stats)) into[Number(n)] = (into[Number(n)] ?? 0) + sign * value;
  return into;
};

/** Something worn: the item, and the slot it's in. */
export interface Worn {
  slot: number;
  item: MemoryItem;
}

/** The set bonuses for what's worn: each set's bonuses for as many of its pieces as are worn (and give something). */
export function setBonus(worn: readonly Worn[], mounted: boolean): Stats {
  const counts = new Map<string, { pieces: number; set: NonNullable<MemoryItem['set']> }>();
  for (const { slot, item } of worn) {
    if (!item.set || givesNothing(item, slot, mounted)) continue;
    const entry = counts.get(item.set.name) ?? counts.set(item.set.name, { pieces: 0, set: item.set }).get(item.set.name)!;
    entry.pieces++;
  }
  const out: Stats = {};
  for (const { pieces, set } of counts.values()) {
    for (const bonus of set.bonuses) if (bonus.pieces <= pieces) add(out, Object.fromEntries(Object.entries(bonus.stats).map(([n, v]) => [Number(n), v])));
  }
  return out;
}

/** What a set of worn items gives in a fight: what each that counts gives, and the set bonuses. */
export function contribution(worn: readonly Worn[], mounted: boolean): Stats {
  const out = setBonus(worn, mounted);
  for (const { slot, item } of worn) if (!givesNothing(item, slot, mounted)) add(out, itemStats(item));
  return out;
}

/** What wearing `to` instead of `from` would make the totals and the weight worn (corrections: per stat, on the change). */
export interface Prediction {
  totals: Stats;
  wear: number | null;
  hand: number | null;
}

/**
 * The totals with `to` worn instead of `from` (what the character's totals were
 * read with): each stat changes by what `to` gives less what `from` gave; a
 * stat a % multiplies changes as the game works it out, the sum before the %
 * (the total over 1 + % now) with the change, times 1 + the new %, rounded down.
 */
export function predict(char: Character, from: readonly Worn[], to: readonly Worn[], corrections: Stats = {}): Prediction {
  const change = add(contribution(to, char.mounted), contribution(from, char.mounted), -1);
  const totals: Stats = { ...char.totals };
  for (const s of new Set([...Object.keys(char.totals), ...Object.keys(change)].map(Number))) {
    const by = (change[s] ?? 0) * (corrections[s] ?? 1);
    const percent = PERCENT_OF[s];
    const now = char.totals[s] ?? 0;
    if (percent === undefined) {
      totals[s] = now + by;
      continue;
    }
    // The sum before the %, worked back; the change is what the game's rounding (down, in whole %) would make of it.
    const before = 100 + (char.totals[percent] ?? 0);
    const after = before + (change[percent] ?? 0);
    const base = Math.round((now * 100) / before);
    const times = (sum: number, percents: number) => Math.floor((sum * percents) / 100 + 1e-9);
    totals[s] = now + times(base + by, after) - times(base, before);
  }
  const weight = (list: readonly Worn[], hand: boolean) => list.filter((w) => LOADOUT.handSlots.includes(w.slot) === hand).reduce((sum, w) => sum + (w.item.weight ?? 0), 0);
  return {
    totals,
    wear: char.wear === null ? null : char.wear + weight(to, false) - weight(from, false),
    hand: char.hand === null ? null : char.hand + weight(to, true) - weight(from, true),
  };
}

/** The character with these totals, for the combat model; the weapon's element from what's worn. */
export function fighterFrom(char: Character, totals: Stats, worn: readonly Worn[]): Fighter {
  const combat = Object.fromEntries(Object.entries(COMBAT_STATS).map(([key, n]) => [key, totals[n] ?? 0])) as Combat;
  const element = elementOf(worn.filter((w) => !givesNothing(w.item, w.slot, char.mounted)).map((w) => w.item));
  return { ...combat, cls: char.cls, level: char.level, maxHp: totals[HEALTH] ?? 0, ...(element && { element }) };
}

/** Why the character can't put the item on with these totals (class, level, a stat requirement), or null. */
export function cantPutOn(item: MemoryItem, char: Character, totals: Stats): string | null {
  return cantWear(item, { cls: char.cls, level: char.level, combat: { maxAC: totals[5], maxMR: totals[7], maxDC: totals[9], maxMC: totals[11], maxSC: totals[13] } });
}

/** An item to wear: from the bag or worn now (by its key: "w0" worn in slot 0, "b12" in bag slot 12). */
export interface Piece {
  key: string;
  item: MemoryItem;
  worn: boolean;
}

/** What goes in each fighting slot (null: nothing). */
export type Loadout = Map<number, Piece | null>;

/** A loadout as what's worn. */
export function wornOf(loadout: Loadout): Worn[] {
  return [...loadout].filter((entry): entry is [number, Piece] => !!entry[1]).map(([slot, piece]) => ({ slot, item: piece.item }));
}

/** Putting a bag item on in a slot, in place of what's there. */
export interface Swap {
  slot: number;
  item: MemoryItem;
  replaces: MemoryItem | null;
}

/**
 * The swaps from `from` (worn now) to `to`, in an order the game allows: each
 * item's requirement met by the totals with the swaps before it made (the item
 * it replaces still worn as it's checked), and the weight after it within the
 * limits before it. Null when no order does.
 */
export function swapOrder(char: Character, from: Loadout, to: Loadout, corrections: Stats = {}): Swap[] | null {
  const start = wornOf(from);
  const state: Loadout = new Map(from);
  const pending = [...to].filter(([slot, piece]) => piece && piece.key !== state.get(slot)?.key).map(([slot]) => slot);
  const swaps: Swap[] = [];
  while (pending.length) {
    const now = predict(char, start, wornOf(state), corrections);
    const i = pending.findIndex((slot) => {
      const piece = to.get(slot)!;
      if (cantPutOn(piece.item, char, now.totals)) return false;
      const after = predict(char, start, wornOf(new Map(state).set(slot, piece)), corrections);
      const within = (worn: number | null, was: number | null, most: number | undefined) => worn === null || most === undefined || worn <= most || worn <= (was ?? 0);
      return within(after.wear, now.wear, now.totals[WEAR_WEIGHT]) && within(after.hand, now.hand, now.totals[HAND_WEIGHT]);
    });
    if (i < 0) return null;
    const slot = pending.splice(i, 1)[0];
    swaps.push({ slot, item: to.get(slot)!.item, replaces: state.get(slot)?.item ?? null });
    state.set(slot, to.get(slot)!);
  }
  return swaps;
}

/** The best loadout found, the swaps to it, and its score against what's worn now's. */
export interface LoadoutPlan {
  loadout: Loadout;
  swaps: Swap[];
  score: number;
  currentScore: number;
  /** The totals and the character it gives. */
  totals: Stats;
  fighter: Fighter;
}

/**
 * The best loadout from what's worn and the bag, by `score` (higher is better)
 * of the character it gives. Bag items the class can't wear, the level doesn't
 * allow, or that are broken aren't tried; stat requirements are checked in the
 * swaps' order. A worn item stays in its own slot (a ring isn't moved to the
 * other ring place).
 */
export function optimise(char: Character, worn: readonly MemoryItem[], bag: readonly MemoryItem[], score: (fighter: Fighter) => number, corrections: Stats = {}): LoadoutPlan {
  const current: Loadout = new Map(FIGHT_SLOTS.map((slot) => {
    const item = worn.find((w) => w.slot === slot);
    return [slot, item ? { key: `w${slot}`, item, worn: true } : null];
  }));
  const start = wornOf(current);
  // The class and level allow it (stat requirements wait for the swaps' order).
  const pieces: Piece[] = bag
    .filter((item) => ITEM_SLOTS[item.type] && !isBroken(item) && cantPutOn(item, char, { 5: Infinity, 7: Infinity, 9: Infinity, 11: Infinity, 13: Infinity }) === null)
    .map((item) => ({ key: `b${item.slot}`, item, worn: false }));
  const options = (slot: number) => pieces.filter((p) => ITEM_SLOTS[p.item.type].includes(slot));
  const open = FIGHT_SLOTS.filter((slot) => options(slot).length);
  const signature = (l: Loadout) => FIGHT_SLOTS.map((slot) => l.get(slot)?.key ?? '-').join(',');

  // Scores, worked out once per loadout: `raw` whether or not it can be put on, `value` -Infinity when it can't.
  const raws = new Map<string, number>();
  const raw = (l: Loadout) => {
    const key = signature(l);
    if (!raws.has(key)) {
      const to = wornOf(l);
      raws.set(key, score(fighterFrom(char, predict(char, start, to, corrections).totals, to)));
    }
    return raws.get(key)!;
  };
  const values = new Map<string, number>();
  const value = (l: Loadout) => {
    const key = signature(l);
    if (!values.has(key)) values.set(key, swapOrder(char, current, l, corrections) ? raw(l) : -Infinity);
    return values.get(key)!;
  };
  /** The loadout with these slots changed, or null if that would wear a bag item twice. */
  const changed = (l: Loadout, changes: [number, Piece | null][]) => {
    const next: Loadout = new Map(l);
    for (const [slot, piece] of changes) next.set(slot, piece);
    const keys = [...next.values()].filter(Boolean).map((p) => p!.key);
    return new Set(keys).size === keys.length ? next : null;
  };
  // Each slot's best few bag items, each on its own in place of what's worn.
  const tops = new Map(open.map((slot) => [slot, options(slot)
    .map((p) => ({ p, s: raw(changed(current, [[slot, p]]) ?? current) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, LOADOUT.topPerSlot)
    .map((x) => x.p)]));

  /** The best one or two changes at a time (any bag item in one slot; the top few in two), until none helps. */
  const ascend = (from: Loadout) => {
    let best = from;
    let bestValue = value(from);
    for (let round = 0; round < LOADOUT.maxRounds; round++) {
      let next: Loadout | null = null;
      let nextValue = bestValue + LOADOUT.minGain;
      const consider = (l: Loadout | null) => {
        const v = l ? value(l) : -Infinity;
        if (l && v > nextValue) [next, nextValue] = [l, v];
      };
      for (const slot of open) for (const p of options(slot)) if (p.key !== best.get(slot)?.key) consider(changed(best, [[slot, p]]));
      for (const [i, a] of open.entries()) {
        for (const b of open.slice(i + 1)) {
          for (const pa of tops.get(a)!) for (const pb of tops.get(b)!) {
            if (pa.key !== best.get(a)?.key && pb.key !== best.get(b)?.key) consider(changed(best, [[a, pa], [b, pb]]));
          }
        }
      }
      if (!next) break;
      [best, bestValue] = [next, nextValue];
    }
    return best;
  };

  // A beam over the slots: each keeps what it has or takes one of its top few.
  let beam: Loadout[] = [current];
  for (const slot of open) {
    const grown = beam.flatMap((l) => [l, ...tops.get(slot)!.map((p) => changed(l, [[slot, p]])).filter((x): x is Loadout => !!x)]);
    const unique = [...new Map(grown.map((l) => [signature(l), l])).values()];
    beam = unique.sort((a, b) => raw(b) - raw(a)).slice(0, LOADOUT.beamWidth);
  }
  const beamBest = beam.filter((l) => value(l) > -Infinity).sort((a, b) => value(b) - value(a))[0] ?? current;

  const best = [ascend(current), ascend(beamBest)].sort((a, b) => value(b) - value(a))[0];
  const totals = predict(char, start, wornOf(best), corrections).totals;
  return { loadout: best, swaps: swapOrder(char, current, best, corrections)!, score: value(best), currentScore: value(current), totals, fighter: fighterFrom(char, totals, wornOf(best)) };
}

/** "Battle Necklace for Old Necklace (Necklace)". */
export function describeSwap(swap: Swap): string {
  return `${swap.item.name} for ${swap.replaces?.name ?? 'nothing'} (${SLOT_NAMES[swap.slot] ?? `slot ${swap.slot}`})`;
}

// ---- Checking against the game ----

/** A gear change seen in game: health and each combat stat, as [Library.Stat number, before, predicted, read]. */
export interface GearCheck {
  at: number;
  stats: [number, number, number, number][];
}

/** The stats checked, by Library.Stat number: health and the combat stats. */
const CHECKED = [HEALTH, ...Object.values(COMBAT_STATS)];

/** A snapshot of the character and what they wear. */
interface Snapshot {
  at: number;
  gear: string;
  char: Character;
  worn: Worn[];
}

/**
 * Checks predict() against the game: when what's worn changes (level and
 * mount the same), the totals read once they've settled against what
 * predict() made of the change from the totals before it. Each check is kept
 * (and returned, to be said); gearCorrections() fits per-stat corrections.
 */
export class GearWatch {
  checks: GearCheck[];
  /** Recent snapshots (the totals can change a moment before the gear reading does), newest last. */
  private history: Snapshot[] = [];
  private pending: { from: Snapshot; since: number } | null = null;

  constructor(checks: readonly GearCheck[] = []) {
    this.checks = [...checks];
  }

  /** Takes in a reading; a check when one was made. */
  update(reading: Pick<MemoryState, 'user' | 'gear'>, now: number): GearCheck | null {
    const char = characterOf(reading);
    const items = reading.gear?.worn;
    if (!char || !items) return null;
    const worn = items.map((item) => ({ slot: item.slot, item }));
    // Items are told apart by their stats too: two of the same name can roll differently.
    const gear = worn.map((w) => `${w.slot}:${w.item.name}:${isBroken(w.item) ? 0 : 1}:${JSON.stringify(itemStats(w.item))}`).sort().join('|');
    const snap: Snapshot = { at: now, gear, char, worn };
    const last = this.history.at(-1);
    if (last && last.gear !== gear) {
      // From a snapshot of the old gear from before the totals could have changed: settleMs before, else the oldest.
      const old = this.history.filter((h) => h.gear === last.gear);
      this.pending = { from: this.pending?.from ?? old.filter((h) => h.at <= now - LOADOUT.settleMs).at(-1) ?? old[0], since: now };
    }
    this.history = [...this.history.filter((h) => h.at > now - 2 * LOADOUT.settleMs), snap];
    if (!this.pending || now - this.pending.since < LOADOUT.settleMs) return null;
    const { from } = this.pending;
    this.pending = null;
    if (from.char.level !== char.level || from.char.mounted !== char.mounted || now - from.at > LOADOUT.maxBeforeMs + LOADOUT.settleMs * 2) return null;
    const predicted = predict(from.char, from.worn, worn).totals;
    const stats = CHECKED.map((s): [number, number, number, number] => [s, from.char.totals[s] ?? 0, predicted[s] ?? 0, char.totals[s] ?? 0]);
    if (stats.every(([, before, guess, read]) => guess === before && read === before)) return null;
    const check = { at: now, stats };
    this.checks = [...this.checks, check].slice(-LOADOUT.maxChecks);
    return check;
  }
}

/** Per-stat corrections to predicted changes: what was read over what was predicted, newer checks counting most, trusted as far as they go, capped. */
export function gearCorrections(checks: readonly GearCheck[]): Stats {
  const sums = new Map<number, { read: number; predicted: number; weight: number }>();
  [...checks].reverse().forEach((check, rank) => {
    const w = LOADOUT.recency ** rank;
    for (const [s, before, predicted, read] of check.stats) {
      if (predicted === before) continue;
      const sum = sums.get(s) ?? sums.set(s, { read: 0, predicted: 0, weight: 0 }).get(s)!;
      sum.read += w * (read - before);
      sum.predicted += w * (predicted - before);
      sum.weight += w;
    }
  });
  const out: Stats = {};
  for (const [s, sum] of sums) {
    if (sum.predicted === 0) continue;
    const trust = Math.min(1, sum.weight / LOADOUT.fullTrustChecks);
    out[s] = Math.min(LOADOUT.maxCorrection, Math.max(LOADOUT.minCorrection, 1 + trust * (sum.read / sum.predicted - 1)));
  }
  return out;
}

const STAT_LABELS: [number[], string][] = [[[2], 'HP'], [[4, 5], 'AC'], [[6, 7], 'MR'], [[8, 9], 'DC'], [[10, 11], 'MC'], [[12, 13], 'SC'], [[14], 'Accuracy'], [[15], 'Agility'], [[16], 'Attack Speed']];

/** "Gear check: DC 138–194 predicted 158–223, read 158–222; Attack Speed 15 predicted 5, read 5": the stats that changed or were to. */
export function describeCheck(check: GearCheck): string {
  const rows = new Map(check.stats.map((r) => [r[0], r]));
  const parts: string[] = [];
  for (const [stats, label] of STAT_LABELS) {
    const group = stats.map((s) => rows.get(s)).filter((r): r is [number, number, number, number] => !!r);
    if (!group.some(([, before, predicted, read]) => predicted !== before || read !== before)) continue;
    const show = (i: number) => group.map((r) => r[i]).join('–');
    parts.push(`${label} ${show(1)} predicted ${show(2)}, read ${show(3)}`);
  }
  return `Gear check: ${parts.join('; ')}`;
}

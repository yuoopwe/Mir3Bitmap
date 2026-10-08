/**
 * Calibration: the combat model (combat-model.ts) checked against the
 * character's own fights (grind-log.ts kills). Each kill noted with the
 * monster and the character's stats then is worked out again by the model:
 * how long it should have taken, and the health it should have cost in the
 * time it really took. What was measured over what was predicted gives the
 * corrections (damage dealt, damage taken), newer kills counting most, trusted
 * as far as there are kills to go by, and capped. They're kept by level gap
 * too, since the server's level-difference rules aren't in the data. And
 * PotionWatch learns, from the bag's counts and the health after each press of
 * the potion key, which potion the key drinks, what one really heals, and how
 * soon the game lets another be drunk. Pure: no game, no screen.
 */
import { COMBAT, NO_CORRECTION, fight, foeOf, healthPotions, unpackFighter, type Factors } from './combat-model';
import type { Kill } from './grind-log';
import type { MemoryState } from './game-memory';
import type { TravelData } from './travel';

/** Every number calibration is tuned by, in one place. */
export const CALIBRATION = {
  /** Each kill counts this much less than the next newer one. */
  recency: 0.98,
  /** Corrections are trusted fully after this many kills (weighted as above); fewer, they're pulled towards none. */
  fullTrustKills: 20,
  /** ...and a level gap's own after this many there (fewer: the overall ones make up the rest). */
  gapFullTrustKills: 10,
  /** No correction goes beyond these factors. */
  minFactor: 0.5,
  maxFactor: 2,
  /** Kills the model says cost under this share of the most health don't say how hard monsters hit (a factor can't scale nothing). */
  minPredictedLoss: 0.01,
  // ---- Potions ----
  /** After a press of the potion key, the bag's count and the health are watched this long (the bag is read once a second)... */
  watchMs: 3000,
  /** ...and a rise within this long of the press counts as healed at once. */
  instantMs: 700,
  /** The heals kept, newest last. */
  maxHeals: 20,
};

export interface GapCheck {
  /** Levels the monsters were above the character (0: at or below). */
  gap: number;
  kills: number;
  /** Measured kill time over predicted, and measured health lost over predicted (1: as the model says). */
  seconds: number;
  taken: number;
}

export interface Calibration {
  /** The corrections overall, and the kills they're worked out from. */
  factors: Factors;
  kills: number;
  /** How the model did at each level gap. */
  byGap: GapCheck[];
  /** The corrections for fights this many levels above (the gap's own blended with the overall ones). */
  factorsAt(gap: number): Factors;
}

const clamp = (factor: number) => Math.min(CALIBRATION.maxFactor, Math.max(CALIBRATION.minFactor, factor));

/** Sums for one group of kills: predicted and measured seconds and health lost, and the weight. */
interface Sums {
  weight: number;
  predictedSeconds: number;
  measuredSeconds: number;
  predictedLoss: number;
  measuredLoss: number;
}

const emptySums = (): Sums => ({ weight: 0, predictedSeconds: 0, measuredSeconds: 0, predictedLoss: 0, measuredLoss: 0 });

/** A group's corrections at full trust (1 where it has nothing to say), and how far they're trusted. */
function ratios(sums: Sums, fullTrust: number): { damage: number; taken: number; trust: number } {
  return {
    damage: sums.measuredSeconds > 0 ? sums.predictedSeconds / sums.measuredSeconds : 1,
    taken: sums.predictedLoss > 0 ? sums.measuredLoss / sums.predictedLoss : 1,
    trust: Math.min(1, sums.weight / fullTrust),
  };
}

/**
 * The corrections from the character's kills (those noted with the monster
 * and their stats; any order) and what's been learned of their potions.
 */
export function calibrate(data: TravelData, kills: readonly Kill[], potions?: PotionNotes | null): Calibration {
  const all = emptySums();
  const gaps = new Map<number, Sums & { kills: number }>();
  [...kills]
    .sort((a, b) => b.at - a.at)
    .forEach((k, rank) => {
      const me = unpackFighter(k.stats, k.level);
      const foe = k.monster ? foeOf(data, k.monster) : null;
      if (!me || !foe || k.seconds <= 0) return;
      // The kill as the model has it: its whole health (the damage measured may fall short of an overkill's).
      const predicted = fight(me, { ...foe, health: k.damage });
      if (!(predicted.seconds < Infinity)) return;
      const weight = CALIBRATION.recency ** rank;
      const gap = Math.max(0, k.monsterLevel - k.level);
      const group = gaps.get(gap) ?? gaps.set(gap, { ...emptySums(), kills: 0 }).get(gap)!;
      group.kills++;
      for (const sums of [all, group]) {
        sums.weight += weight;
        sums.predictedSeconds += weight * predicted.seconds;
        sums.measuredSeconds += weight * k.seconds;
        // Health lost: what its blows should have taken in the time the fight really took.
        const loss = predicted.takenPerSecond * k.seconds;
        if (loss >= CALIBRATION.minPredictedLoss * me.maxHp) {
          sums.predictedLoss += weight * loss;
          sums.measuredLoss += weight * k.hpLost * me.maxHp;
        }
      }
    });
  const overall = ratios(all, CALIBRATION.fullTrustKills);
  const heal = potionHealFactor(data, potions);
  const factors: Factors = {
    damage: clamp(1 + overall.trust * (overall.damage - 1)),
    taken: clamp(1 + overall.trust * (overall.taken - 1)),
    heal,
  };
  const byGap = [...gaps]
    .sort((a, b) => a[0] - b[0])
    .map(([gap, sums]) => {
      const r = ratios(sums, 1);
      return { gap, kills: sums.kills, seconds: 1 / r.damage, taken: r.taken };
    });
  return {
    factors,
    kills: [...gaps.values()].reduce((n, g) => n + g.kills, 0),
    byGap,
    factorsAt(gap: number): Factors {
      const sums = gaps.get(Math.max(0, gap));
      if (!sums) return factors;
      const own = ratios(sums, CALIBRATION.gapFullTrustKills);
      return {
        damage: clamp(own.trust * own.damage + (1 - own.trust) * factors.damage),
        taken: clamp(own.trust * own.taken + (1 - own.trust) * factors.taken),
        heal,
      };
    },
  };
}

/** No corrections at all: for a character with nothing measured. */
export const UNCALIBRATED: Calibration = { factors: NO_CORRECTION, kills: 0, byGap: [], factorsAt: () => NO_CORRECTION };

/** "kills 12% quicker and hits 10% softer than the model says (40 kills)", or that there's nothing to go by yet. */
export function describeCalibration(calibration: Calibration): string {
  if (!calibration.kills) return 'no fights measured yet: the model as it stands';
  const { damage, taken, heal } = calibration.factors;
  const part = (factor: number, more: string, less: string) => (Math.abs(factor - 1) < 0.03 ? null : `${Math.round(Math.abs(factor - 1) * 100)}% ${factor > 1 ? more : less}`);
  const parts = [part(damage, 'quicker kills', 'slower kills'), part(taken, 'harder hits taken', 'softer hits taken'), part(heal, 'more from potions', 'less from potions')].filter(Boolean);
  return `${parts.length ? parts.join(', ') : 'as predicted'} than the model says (${calibration.kills} kills)`;
}

// ---- Potions ----

/**
 * What's been learned of the potion key: the health potion it drinks (the count
 * that went down after a press), the health each drink was seen to put back
 * (newest last), the share of it that came at once (1: instant; less: over
 * time), and the game's cooldown between drinks, as far as it shows: the
 * shortest gap between two drinks that both went down, and the longest after
 * which a press did nothing.
 */
export interface PotionNotes {
  potion: string | null;
  heals: number[];
  instant: number | null;
  drankAfterMs: number | null;
  refusedAfterMs: number | null;
}

/** Saved notes, if they're sound (else null). */
export function potionNotesFrom(saved: unknown): PotionNotes | null {
  const n = saved as Partial<PotionNotes> | null;
  if (!n || typeof n !== 'object' || !Array.isArray(n.heals) || !n.heals.every((h) => Number.isFinite(h))) return null;
  const numberOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    potion: typeof n.potion === 'string' ? n.potion : null,
    heals: n.heals.slice(-CALIBRATION.maxHeals),
    instant: numberOrNull(n.instant),
    drankAfterMs: numberOrNull(n.drankAfterMs),
    refusedAfterMs: numberOrNull(n.refusedAfterMs),
  };
}

/** What a drink of the potion really heals, as a share of what the game data says (1 with nothing learned). */
function potionHealFactor(data: TravelData, notes?: PotionNotes | null): number {
  const potion = healthPotions(data).find((p) => p.name === notes?.potion);
  if (!potion || !notes?.heals.length) return 1;
  const seen = notes.heals.reduce((sum, h) => sum + h, 0) / notes.heals.length;
  return clamp(seen / potion.heal);
}

/** The time between drinks: the bot's own, or longer when the game was seen to refuse a drink that soon. */
export function drinkMs(notes?: PotionNotes | null): number {
  return Math.max(COMBAT.drinkMs, notes?.refusedAfterMs != null ? notes.refusedAfterMs + 100 : 0);
}

/** What PotionWatch reads: the character's health, and the bag's counts. */
export type PotionReading = Pick<MemoryState, 'user' | 'gear'>;

/**
 * Learns the potion key's potion from what follows each press (see
 * PotionNotes). One press is watched at a time: presses during the watch
 * aren't. Its notes start from what was learned before.
 */
export class PotionWatch {
  notes: PotionNotes;
  private watching: { at: number; hp: number; counts: Record<string, number>; early: number | null; top: number } | null = null;
  /** When the last drink that went down was pressed. */
  private lastDrunk: number | null = null;

  constructor(
    private readonly data: TravelData,
    notes?: PotionNotes | null,
  ) {
    this.notes = notes ?? { potion: null, heals: [], instant: null, drankAfterMs: null, refusedAfterMs: null };
  }

  /** The potion key was pressed. */
  pressed(reading: PotionReading | null, now: number): void {
    const hp = reading?.user?.hp;
    const counts = reading?.gear?.counts;
    if (this.watching || hp === undefined || !counts) return;
    this.watching = { at: now, hp, counts: { ...counts }, early: null, top: hp };
  }

  /** Takes in a reading; true when the notes changed (to be saved). */
  update(reading: PotionReading | null, now: number): boolean {
    const w = this.watching;
    const hp = reading?.user?.hp;
    if (!w || hp === undefined) return false;
    w.top = Math.max(w.top, hp);
    if (w.early === null && now - w.at >= CALIBRATION.instantMs) w.early = hp - w.hp;
    const counts = reading?.gear?.counts ?? {};
    const potions = healthPotions(this.data).map((p) => p.name);
    const used = potions.find((name) => (counts[name] ?? 0) < (w.counts[name] ?? 0));
    if (now - w.at < CALIBRATION.watchMs) return false;
    this.watching = null;
    const notes = { ...this.notes };
    if (used) {
      const rise = Math.max(0, w.top - w.hp);
      notes.potion = used;
      notes.heals = [...notes.heals, rise].slice(-CALIBRATION.maxHeals);
      if (rise > 0) notes.instant = Math.min(1, Math.max(0, (w.early ?? rise) / rise));
      if (this.lastDrunk !== null) notes.drankAfterMs = Math.min(notes.drankAfterMs ?? Infinity, w.at - this.lastDrunk);
      this.lastDrunk = w.at;
    } else if (this.lastDrunk !== null && potions.some((name) => (w.counts[name] ?? 0) > 0)) {
      // A press that did nothing with potions in the bag: too soon after the last drink.
      notes.refusedAfterMs = Math.max(notes.refusedAfterMs ?? 0, w.at - this.lastDrunk);
    } else return false;
    this.notes = notes;
    return true;
  }
}

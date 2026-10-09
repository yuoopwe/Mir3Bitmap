/**
 * Area damage: how much faster the character clears a crowd than one monster
 * at a time, learned from their fights rather than from skill data (every class
 * gets area attacks at some point, cast from whatever keys the user ticked).
 * While hunting, AreaMeter adds up the damage seen land on every hostile
 * monster close to the character (not just the one clicked: a monster softened
 * by an area blow before it's clicked is exactly what this is after), over the
 * time spent fighting, and how many were close. From those samples
 * learnAreaDamage() compares the damage rate in a crowd with the rate alone:
 * effective targets = 1 + gain x (crowd - 1), trusted as the time measured both
 * ways builds up, so a character with no area attack (the same rate either
 * way) keeps today's single-target estimates exactly. learnCrowding() learns
 * how crowded each map gets while grinding it (monsters chase, so more than
 * the spawn density says) and how that relates to spawn density, so a map
 * never ground on still gets an expected crowd. Pure: no game, no screen.
 */
import type { MemoryObject, MemoryState } from './game-memory';

/** Every number area damage is measured and learned by, in one place. */
export const AREA = {
  // ---- Measuring ----
  /**
   * Monsters this many tiles away or nearer (the larger of across and down) count as in the fight: a Warrior's
   * Half Moon hits the 8 tiles round them, a Wizard's or Taoist's 3x3 spell cast at a monster a tile or two off
   * reaches 3; monsters further off are still on their way and aren't being hit yet.
   */
  crowdTiles: 3,
  /** A monster this close to a pet or another player is theirs to fight: its damage and itself don't count (melee reach and a step). */
  reachTiles: 2,
  /** Another player this close to the character could be shooting at what's near them from range: nothing is measured meanwhile. */
  othersTiles: 9,
  /** Time counts as fighting while damage has landed near the character within this long: more than the slowest swing (1.5 s) and a reading's lag, so the walk to the next monster doesn't count. */
  busyMs: 2000,
  /** A reading this long after the last counts at most this much (pauses, a slow reading). */
  maxTickMs: 1000,
  /** A sample is this many seconds of fighting; a part-sample (the map changed, a death) is kept from this many. */
  sampleSeconds: 5,
  minSampleSeconds: 2,
  // ---- Learning the gain ----
  /** A sample with fewer than this many monsters close on average (over its fighting time) was fought alone. */
  aloneBelow: 1.5,
  /** Each sample counts this much less than the next newer one (half as much some 350 samples, half an hour of fighting, on)... */
  recency: 0.998,
  /** ...and this much less for every level between the character's then and now. */
  levelDecay: 0.85,
  /** The gain is trusted fully once this much fighting (seconds, weighted as above) has been measured both alone and in a crowd. */
  fullTrustSeconds: 600,
  /** Gains under this are noise (a character with no area attack measures about 0): taken as none. */
  minGain: 0.15,
  /** Each extra monster is worth at most one more target... */
  maxGain: 1,
  /** ...and no more than this many are counted as hit together: the crowd thins as they die, and a few lucky samples shouldn't promise more. */
  maxTargets: 5,
  // ---- Learning how crowded maps get ----
  /** A map's own measured crowd is trusted fully after this much fighting on it (seconds). */
  mapFullTrustSeconds: 300,
  /** No map is expected to crowd the character with more than this many. */
  maxCrowd: 8,
};

/** The square of tiles counted round the character: (2 x crowdTiles + 1)^2. */
const CROWD_AREA = (2 * AREA.crowdTiles + 1) ** 2;

/** Some seconds of fighting: when (Date.now()), on which map, at what level, the damage landed near the character, and how many monsters were close on average. */
export interface AreaSample {
  at: number;
  map: number;
  level: number;
  seconds: number;
  damage: number;
  crowd: number;
}

/** What the area meter reads: the character, the monsters and people about, and the map. */
export type AreaReading = Pick<MemoryState, 'user' | 'objects' | 'map'>;

const tiles = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** A monster that can be fought: hostile (guards read 0), not anyone's pet. */
const fightable = (o: MemoryObject) => o.kind === 'monster' && !o.pet && (o.disposition === undefined || o.disposition === null || o.disposition === 4);

/**
 * Measures, from each reading, the damage seen land on the hostile monsters
 * within AREA.crowdTiles of the character (each monster's hp, the damage seen
 * so far, going down) and how many there are, over the time spent fighting
 * (damage landed lately), as a sample every AREA.sampleSeconds of it. Monsters
 * near a pet or another player are theirs, and with another player close
 * nothing is measured. An overkill counts only the health that was left.
 */
export class AreaMeter {
  /** The damage last seen on each monster (by id). */
  private readonly seen = new Map<number, number>();
  private window = { seconds: 0, damage: 0, crowdSeconds: 0 };
  private last: { now: number; map: number; level: number } | null = null;
  private damagedAt = -Infinity;

  /** Takes in a reading; a sample when one is complete. */
  update(reading: AreaReading, now: number, at = Date.now()): AreaSample | null {
    const user = reading.user;
    const map = reading.map?.index;
    if (!user || user.dead || map === undefined || user.level === undefined) return this.flush(at, true);
    // A new map: what was measured so far is a sample of the old one.
    const flushed = this.last && this.last.map !== map ? this.flush(at, true) : null;
    const objects = reading.objects ?? [];
    const others = objects.filter((o) => (o.kind === 'player' || o.pet) && !o.dead);
    const watched = others.some((o) => o.kind === 'player' && tiles(o, user) <= AREA.othersTiles);
    let damage = 0;
    let crowd = 0;
    const present = new Set<number>();
    for (const o of objects) {
      if (!fightable(o)) continue;
      present.add(o.id);
      const hp = o.hp ?? 0;
      const before = this.seen.get(o.id);
      this.seen.set(o.id, hp);
      if (tiles(o, user) > AREA.crowdTiles || others.some((p) => tiles(p, o) <= AREA.reachTiles)) continue;
      // Damage seen land since the last reading (a rise is the monster healing); past its health, only what was left.
      if (before !== undefined && hp < before) damage += Math.min(before - hp, o.maxHp ? Math.max(0, o.maxHp + before) : Infinity);
      if (!o.dead) crowd++;
    }
    for (const id of this.seen.keys()) if (!present.has(id)) this.seen.delete(id);
    const tick = this.last ? Math.min(now - this.last.now, AREA.maxTickMs) / 1000 : 0;
    this.last = { now, map, level: user.level };
    if (watched) return flushed;
    if (damage > 0) this.damagedAt = now;
    if ((crowd > 0 || damage > 0) && now - this.damagedAt <= AREA.busyMs) {
      this.window.seconds += tick;
      this.window.damage += damage;
      this.window.crowdSeconds += Math.max(1, crowd) * tick;
    }
    return flushed ?? (this.window.seconds >= AREA.sampleSeconds ? this.flush(at, false) : null);
  }

  /** The window so far as a sample (a part one only when `early`, and long enough), starting a new one. */
  private flush(at: number, early: boolean): AreaSample | null {
    const { seconds, damage, crowdSeconds } = this.window;
    const last = this.last;
    this.window = { seconds: 0, damage: 0, crowdSeconds: 0 };
    if (early) {
      this.last = null;
      this.seen.clear();
    }
    if (!last || seconds <= 0 || (early && seconds < AREA.minSampleSeconds)) return null;
    return { at, map: last.map, level: last.level, seconds, damage, crowd: crowdSeconds / seconds };
  }
}

/** What's been learned of the character's area damage. */
export interface AreaDamage {
  /** Each monster close beyond the first is worth this many targets (0: no area attack seen), and how far that's trusted (0-1). */
  gain: number;
  trust: number;
  /** The gain as measured, before the noise floor and the cap (for the record). */
  measured: number;
  /** Fighting measured, in all and (weighted) alone and in a crowd, seconds. */
  seconds: number;
  aloneSeconds: number;
  crowdSeconds: number;
}

/** Nothing measured: no area damage, and no trust in that. */
export const NO_AREA: AreaDamage = { gain: 0, trust: 0, measured: 0, seconds: 0, aloneSeconds: 0, crowdSeconds: 0 };

/**
 * The area gain from the character's samples (any order), at `level`: the
 * damage rate in a crowd over the rate alone, less 1, over the crowd's extra
 * monsters (crowd - 1). Newer samples and those nearer the level count more.
 * Trusted as far as the lesser of the time alone and in a crowd goes.
 */
export function learnAreaDamage(samples: readonly AreaSample[], level: number): AreaDamage {
  const alone = { seconds: 0, damage: 0 };
  const crowded = { seconds: 0, damage: 0, crowd: 0 };
  let seconds = 0;
  [...samples]
    .sort((a, b) => b.at - a.at)
    .forEach((s, rank) => {
      const w = AREA.recency ** rank * AREA.levelDecay ** Math.abs(level - s.level);
      seconds += s.seconds;
      const bin = s.crowd < AREA.aloneBelow ? alone : crowded;
      bin.seconds += w * s.seconds;
      bin.damage += w * s.damage;
      if (bin === crowded) crowded.crowd += w * s.seconds * s.crowd;
    });
  const result = { ...NO_AREA, seconds, aloneSeconds: alone.seconds, crowdSeconds: crowded.seconds };
  const aloneRate = alone.seconds > 0 ? alone.damage / alone.seconds : 0;
  if (aloneRate <= 0 || crowded.seconds <= 0) return result;
  const extra = crowded.crowd / crowded.seconds - 1;
  const measured = (crowded.damage / crowded.seconds / aloneRate - 1) / extra;
  const gain = Math.min(AREA.maxGain, Math.max(0, measured));
  return { ...result, measured, gain: gain < AREA.minGain ? 0 : gain, trust: Math.min(1, Math.min(alone.seconds, crowded.seconds) / AREA.fullTrustSeconds) };
}

/** How many times as fast a crowd of this many is cleared as one monster at a time: 1 + trusted gain x (crowd - 1), capped. 1 without area damage. */
export function speedUp(area: AreaDamage | null | undefined, crowd: number): number {
  if (!area) return 1;
  return 1 + area.trust * area.gain * Math.max(0, Math.min(crowd, AREA.maxTargets) - 1);
}

/** How crowded maps get: by map, the crowd measured and the fighting time; and the pull (crowd beyond the first per monster the spawn density puts round the character). */
export interface Crowding {
  maps: Map<number, { crowd: number; seconds: number }>;
  pull: number;
  trust: number;
}

/**
 * How crowded each map the samples were taken on got (fighting-time weighted),
 * and the pull: the extra monsters measured round the character over what the
 * spawn density (monsters a tile: `density`, null when unknown) puts in the
 * square counted, over every map measured. 1 (the density as it is) until
 * trusted (by fighting time, AREA.fullTrustSeconds).
 */
export function learnCrowding(samples: readonly AreaSample[], density: (map: number) => number | null): Crowding {
  const sums = new Map<number, { seconds: number; crowdSeconds: number }>();
  for (const s of samples) {
    const sum = sums.get(s.map) ?? sums.set(s.map, { seconds: 0, crowdSeconds: 0 }).get(s.map)!;
    sum.seconds += s.seconds;
    sum.crowdSeconds += s.seconds * s.crowd;
  }
  const maps = new Map([...sums].map(([map, sum]) => [map, { crowd: sum.crowdSeconds / sum.seconds, seconds: sum.seconds }]));
  let extra = 0;
  let expected = 0;
  let seconds = 0;
  for (const [map, m] of maps) {
    const d = density(map);
    if (d === null || d <= 0) continue;
    extra += m.seconds * (m.crowd - 1);
    expected += m.seconds * d * CROWD_AREA;
    seconds += m.seconds;
  }
  const trust = Math.min(1, seconds / AREA.fullTrustSeconds);
  const learned = expected > 0 ? Math.max(0, extra / expected) : 1;
  return { maps, pull: 1 + trust * (learned - 1), trust };
}

/**
 * The crowd to expect fighting on a map: what was measured there, as far as
 * it's trusted (AREA.mapFullTrustSeconds), else the spawn density's (monsters
 * a tile) worth round the character, times the pull learned elsewhere.
 */
export function expectedCrowd(crowding: Crowding | null | undefined, map: number, density: number | null): number {
  const prior = 1 + (crowding?.pull ?? 1) * (density ?? 0) * CROWD_AREA;
  const own = crowding?.maps.get(map);
  const trust = own ? Math.min(1, own.seconds / AREA.mapFullTrustSeconds) : 0;
  return Math.min(AREA.maxCrowd, own ? trust * own.crowd + (1 - trust) * prior : prior);
}

/**
 * What a stint's own samples say (those taken during it): the crowd it fought,
 * the speed-up it measured at that crowd, and how far that's trusted. Null
 * with none.
 */
export function stintArea(samples: readonly AreaSample[], level: number): { crowd: number; area: number; areaTrust: number } | null {
  const seconds = samples.reduce((sum, s) => sum + s.seconds, 0);
  if (seconds <= 0) return null;
  const crowd = samples.reduce((sum, s) => sum + s.seconds * s.crowd, 0) / seconds;
  const own = learnAreaDamage(samples, level);
  return { crowd, area: speedUp({ ...own, trust: 1 }, crowd), areaTrust: own.trust };
}

/** "Area damage: ~3 monsters at once clear 1.8x as fast (40 min measured)", or that none has been seen. */
export function describeArea(area: AreaDamage | null | undefined, crowd: number): string {
  const minutes = Math.round((area?.seconds ?? 0) / 60);
  if (!area || area.seconds <= 0) return 'Area damage: not measured yet';
  const speed = speedUp(area, crowd);
  if (speed < 1.05) return `Area damage: none seen yet (${minutes} min measured)`;
  return `Area damage: ~${Math.round(crowd)} monsters at once clear ${speed.toFixed(1)}x as fast (${minutes} min measured)`;
}

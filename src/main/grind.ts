/**
 * Grind: where to level up. Rates every map the character may enter by the
 * experience an hour of hunting there should bring (from the spawn spots and
 * each monster's level, experience and health in game-data/travel.json), and
 * picks the best one within reach, counting the trip there and sticking with
 * the current map unless another is clearly better. Pure: no game, no screen.
 */
import { mapName, planRoute, type Route, type Start, type TravelData, type TravelMap, type Traveller } from './travel';

/**
 * Every number the planner is tuned by, in one place. Rough by nature: the
 * aim is to rank maps sensibly, not to predict the real exp/h to the digit.
 */
export const GRIND = {
  // ---- How fast monsters die ----
  /** Seconds to kill a monster of the character's own level with the typical health for that level. */
  sameLevelKillSeconds: 5,
  /** The typical health at a level: the median of the (non-boss) monsters within this many levels of it. */
  healthWindowLevels: 2,
  /** ...widened until it holds at least this many monsters. */
  healthSamples: 5,
  /** Damage dealt, relative to a Warrior, by Library.MirClass (missing: 1). A guess: Taoists kill slowest. */
  classDamage: { 0: 1, 1: 1.1, 2: 0.75, 3: 1 } as Record<number, number>,
  /** Seconds lost on every kill besides the fighting: picking a target, lining up, looting. */
  killOverheadSeconds: 2,
  // ---- Getting from one monster to the next ----
  /** Each spawn spot stands for a square this many tiles across (SPAWN_CELL in scripts/travel-data.js). */
  spawnCellTiles: 24,
  /** Tiles run per second, between monsters and when travelling. */
  tilesPerSecond: 2.5,
  /** The walk to the next monster, as a share of the average spacing between monsters (sqrt(area / monsters)). */
  seekShare: 0.7,
  // ---- Monsters far from the character's level ----
  /** Each level a monster is above the character keeps this share of its experience (deaths, potions, slower kills). */
  dangerPerLevel: 0.8,
  /** Maps where more than this share of the monsters are above the allowed level are left out. */
  tooStrongShare: 0.5,
  /** Monsters this many levels below the character still give full experience... */
  outlevelGrace: 10,
  /** ...and lose this share of it for every level beyond that... */
  outlevelPerLevel: 0.1,
  /** ...down to this share. A guess: the server's own rule isn't in the data. */
  outlevelFloor: 0.1,
  /** Maps with fewer monsters than this (bosses and difficulty variants left out) aren't worth a stay. */
  minMonsters: 10,
  /** Maps never ground on, by name: PvP floors. */
  excludedMaps: /\(PvP\)/i,
  // ---- Choosing ----
  /** A trip's time is spread over a stay this long (minutes) when comparing maps. */
  stayMinutes: 60,
  /** Another map must promise this much more (counting the trip) before leaving the current one... */
  switchGain: 1.25,
  /** ...unless the current one makes less than this share of the best one's rate (it's been outgrown). */
  poorShare: 0.5,
};

export interface GrindOptions {
  /** How far above the character's level a monster may be before it counts as too strong. */
  maxLevelsAbove: number;
}

export interface MapRating {
  map: number;
  name: string;
  /** Expected experience per hour of hunting there. */
  rate: number;
  /** Monsters to expect there (bosses and difficulty variants left out). */
  monsters: number;
  /** The median level of those monsters (count-weighted). */
  monsterLevel: number;
  /** Share of them above the allowed level. */
  tooStrong: number;
}

export interface GrindChoice extends MapRating {
  route: Route;
  /** The rate with the trip's time spread over a typical stay. */
  effective: number;
  /** Staying on the current map. */
  stay: boolean;
  /** Why this map, for the status line. */
  reason: string;
}

/** The character: their level and class, and what Travel knows of their waypoints. */
export type Grinder = Traveller & { level: number };

/** "[Heroic] Centipede" is a difficulty-tier copy of "Centipede": the tier and the plain name. */
const TIER = /^\[[^\]]+\]\s*(.+)$/;

const typicalHealthCache = new WeakMap<TravelData, number[]>();

/** The typical health of a non-boss monster at each level (index), never falling as levels rise. */
function typicalHealth(data: TravelData): number[] {
  const cached = typicalHealthCache.get(data);
  if (cached) return cached;
  const spawned = new Set((data.spawnSets ?? []).flat());
  const samples: [number, number][] = [];
  for (const i of spawned) {
    const stats = data.monsterStats?.[i];
    const name = data.monsters?.[i] ?? '';
    if (stats && !stats[3] && stats[2] > 0 && !TIER.test(name)) samples.push([stats[0], stats[2]]);
  }
  const top = Math.max(1, ...samples.map(([level]) => level));
  const table: number[] = [];
  for (let level = 0; level <= top; level++) {
    let near: number[] = [];
    for (let window = GRIND.healthWindowLevels; near.length < GRIND.healthSamples && window <= top; window *= 2) {
      near = samples.filter(([l]) => Math.abs(l - level) <= window).map(([, health]) => health);
    }
    near.sort((a, b) => a - b);
    const median = near.length ? near[Math.floor(near.length / 2)] : 1;
    table.push(Math.max(median, table[level - 1] ?? 0));
  }
  typicalHealthCache.set(data, table);
  return table;
}

/** Whether the level allows the map at all (as planRoute checks it). */
export function levelAllows(map: TravelMap, level: number): boolean {
  return (map.level ?? 0) <= level && !(map.maxLevel && map.maxLevel < level);
}

/**
 * How much experience an hour on this map should bring the character, or why
 * it's left out. Monsters are hunted in proportion to how many spawn: the rate
 * is their total experience over the total time to find and kill them. Bosses
 * don't count, nor do difficulty-tier copies of monsters that spawn there
 * plainly too ("[Heroic] Centipede" beside "Centipede": those are for the
 * instanced dungeons).
 */
export function rateMap(data: TravelData, mapIndex: number, who: Grinder, options: GrindOptions): MapRating | { skip: string } {
  const map = data.maps.find((m) => m.i === mapIndex);
  if (!map) return { skip: 'unknown map' };
  if (!levelAllows(map, who.level)) return { skip: `needs level ${map.level ?? 0}${map.maxLevel ? `-${map.maxLevel}` : '+'}` };
  if (GRIND.excludedMaps.test(map.name)) return { skip: 'excluded' };
  const spots = data.spawns?.[mapIndex];
  if (!spots?.length) return { skip: 'no spawn data' };

  // Monsters expected per monster: a spot's count is shared evenly by the monsters listed there.
  const counts = new Map<number, number>();
  for (const [, , n, set] of spots) {
    const list = data.spawnSets?.[set] ?? [];
    for (const i of list) counts.set(i, (counts.get(i) ?? 0) + n / list.length);
  }
  const names = new Set([...counts.keys()].map((i) => data.monsters?.[i]));
  const level = who.level;
  const health = typicalHealth(data);
  const damage = (health[Math.min(level, health.length - 1)] / GRIND.sameLevelKillSeconds) * (GRIND.classDamage[who.cls ?? 0] ?? 1);
  const hunted: { level: number; exp: number; health: number; n: number }[] = [];
  for (const [i, n] of counts) {
    const stats = data.monsterStats?.[i];
    if (!stats || stats[3]) continue;
    const plain = TIER.exec(data.monsters?.[i] ?? '')?.[1];
    if (plain && names.has(plain)) continue;
    hunted.push({ level: stats[0], exp: stats[1], health: stats[2], n });
  }
  const monsters = hunted.reduce((sum, m) => sum + m.n, 0);
  if (monsters < GRIND.minMonsters) return { skip: 'too few monsters' };
  const tooStrong = hunted.filter((m) => m.level > level + options.maxLevelsAbove).reduce((sum, m) => sum + m.n, 0) / monsters;
  if (tooStrong > GRIND.tooStrongShare) return { skip: `${Math.round(tooStrong * 100)}% of its monsters are too strong` };

  // Between kills: the walk to the next monster, from how thinly they're spread over the spawn area.
  const area = spots.length * GRIND.spawnCellTiles ** 2;
  const seekSeconds = (GRIND.seekShare * Math.sqrt(area / monsters)) / GRIND.tilesPerSecond;
  let exp = 0;
  let seconds = 0;
  for (const m of hunted) {
    const above = m.level - level;
    const below = level - m.level - GRIND.outlevelGrace;
    // Too strong: still met (and fought) on the way, but nothing to count on from it.
    const worth =
      above > options.maxLevelsAbove ? 0
      : above > 0 ? GRIND.dangerPerLevel ** above
      : below > 0 ? Math.max(GRIND.outlevelFloor, 1 - below * GRIND.outlevelPerLevel)
      : 1;
    exp += m.n * m.exp * worth;
    seconds += m.n * (m.health / damage + GRIND.killOverheadSeconds + seekSeconds);
  }
  const byLevel = [...hunted].sort((a, b) => a.level - b.level);
  let seen = 0;
  const median = byLevel.find((m) => (seen += m.n) >= monsters / 2)!.level;
  return { map: mapIndex, name: map.name, rate: (exp / seconds) * 3600, monsters, monsterLevel: median, tooStrong };
}

/** Every map the character may grind on, best rate first (ties by map index, so the order never wavers). Not checked for a route. */
export function rateMaps(data: TravelData, who: Grinder, options: GrindOptions): MapRating[] {
  const out: MapRating[] = [];
  for (const map of data.maps) {
    const rating = rateMap(data, map.i, who, options);
    if ('rate' in rating && rating.rate > 0) out.push(rating);
  }
  return out.sort((a, b) => b.rate - a.rate || a.map - b.map);
}

/** The rate counting the trip: its time spread over a typical stay. */
function withTrip(rating: MapRating, route: Route): number {
  const stay = GRIND.stayMinutes * 60;
  return (rating.rate * stay) / (stay + route.steps / GRIND.tilesPerSecond);
}

/**
 * Where to grind next, from `start`. The best map by its rate counting the
 * trip there; but when `current` (the map being ground on, else the one the
 * player stands on) still suits the level, it's kept unless another is clearly
 * better (switchGain) or it has been outgrown (poorShare). Null if nowhere
 * suits and can be reached.
 */
export function chooseGrindMap(data: TravelData, start: Start, who: Grinder, options: GrindOptions & { current?: number }): GrindChoice | null {
  const rated = rateMaps(data, who, options);
  const route = (rating: MapRating) => planRoute(data, start, { id: `map:${rating.map}`, label: rating.name, map: rating.map }, who);

  // Routes are slow to work out: go down the list by rate, stopping once no map left can beat the best found
  // (the trip only ever lowers a rate).
  let best: GrindChoice | null = null;
  for (const rating of rated) {
    if (best && rating.rate <= best.effective) break;
    const way = route(rating);
    if (!way) continue;
    const effective = withTrip(rating, way);
    if (!best || effective > best.effective) best = { ...rating, route: way, effective, stay: false, reason: '' };
  }
  if (!best) return null;

  const currentIndex = options.current ?? start.map;
  const current = rated.find((r) => r.map === currentIndex);
  const currentWay = current && (current.map === best.map ? best.route : route(current));
  if (!current || !currentWay) {
    // Nothing to stick with: the first choice, or the current map no longer suits (or can't be reached).
    best.reason = options.current !== undefined && options.current !== best.map ? `${mapName(data, options.current)} no longer suits` : 'the best';
    return best;
  }
  const kept: GrindChoice = { ...current, route: currentWay, effective: withTrip(current, currentWay), stay: true, reason: '' };
  if (best.map === current.map) {
    kept.reason = 'still the best';
    return kept;
  }
  // Outgrown: well below the best even before counting the trip there.
  if (current.rate < best.rate * GRIND.poorShare) {
    best.reason = `outgrew ${current.name}`;
    return best;
  }
  const gain = Math.round((best.effective / kept.effective - 1) * 100);
  if (best.effective >= kept.effective * GRIND.switchGain) {
    best.reason = `${gain}% better than ${current.name}`;
    return best;
  }
  kept.reason = `${best.name} is only ${gain}% better`;
  return kept;
}

/** 40k, 1.2M: a rate for the status line. */
export function shortNumber(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(value));
}

/** "Grinding at Death Valley Lv 2: ~40k exp/h for level 34 (still the best)". */
export function describeChoice(choice: GrindChoice, level: number): string {
  return `Grinding at ${choice.name}: ~${shortNumber(choice.rate)} exp/h for level ${level} (${choice.reason})`;
}

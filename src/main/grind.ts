/**
 * Grind: where to level up. Rates every map the character may enter by the
 * experience an hour of hunting there should bring (from the spawn spots and
 * each monster's level, experience and health in game-data/travel.json), and
 * picks the best one within reach, counting the trip there and sticking with
 * the current map unless another is clearly better. Pure: no game, no screen.
 */
import type { Fights, GrindSession, Kill } from './grind-log';
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
  /** Each level a monster is above the character keeps this share of its experience (deaths, potions, slower kills), until the character's own fights say (dangerByGap). */
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
  // ---- Measured rates (grind-log.ts): blended with the estimate ----
  /** This much time measured on a map (weighted as below) and the measurement is trusted fully. */
  measureFullTrustMinutes: 20,
  /** Each stint on a map counts this much less than the next newer one. */
  measureRecency: 0.8,
  /** ...and this much less for every level between the one it was measured at and the character's. */
  measureLevelDecay: 0.85,
  /** A map measured better than estimated rises by at most this factor. */
  measureMaxRatio: 4,
  /** Maps with no measurements of their own go by how the others compared with their estimates, trusted this much as far. */
  elsewhereTrust: 0.5,
  // ---- Measured fighting (grind-log.ts: kills timed, health lost, deaths) ----
  /** Measured damage per second is trusted fully after this many kills at the character's level (none: the estimate alone)... */
  damageFullTrustKills: 30,
  /** ...each kill counting this much less than the next newer one (and measureLevelDecay less per level away). */
  killRecency: 0.98,
  /** Learned danger: monsters some levels above keep (1 - the share of health a kill there costs) of their experience, less this many kills' worth per death (the time dead, getting back)... */
  deathCostKills: 30,
  /** ...trusted fully (over dangerPerLevel) after this many kills that many levels above. */
  dangerFullTrustKills: 10,
  // ---- How far above the level to fight, by itself (autoLevelsAbove) ----
  /** Until a gap is seen to be too costly, at least this many levels above (as the old fixed setting had it). */
  startLevelsAbove: 5,
  /** A level gap counts as seen after this many kills there... */
  dangerMinKills: 5,
  /** ...and as safe while kills there cost under this share of health on average and deaths are rarer than this per fight... */
  safeHpShare: 0.35,
  safeDeathRate: 0.02,
  /** ...and as clearly safe (so the next gap up may be tried) under this share. */
  clearHpShare: 0.15,
  /** After a death, one level less for this long (minutes). */
  deathCooldownMinutes: 30,
  // ---- Quests ----
  /** A map where monsters unfinished quests need spawn rates this much higher (0.3: +30%), so it wins when close to the best... */
  questBonus: 0.3,
  /** ...in full once this share of its monsters are quest targets (less, a part of it). */
  questFullShare: 0.1,
};

/** A monster an unfinished quest task still needs (MemoryState.questTargets): anywhere, or on that map only. */
export interface QuestTarget {
  name: string;
  map: number | null;
  quest: string;
}

export interface GrindOptions {
  /** How far above the character's level a monster may be before it counts as too strong (autoLevelsAbove). */
  maxLevelsAbove: number;
  /** The character's damage per second as measured at their level (measuredDamage): blended with the estimate's as far as its kills go. */
  damage?: { perSecond: number; kills: number } | null;
  /** The share of experience kept fighting monsters this many levels above, as learned (dangerByGap); dangerPerLevel elsewhere. */
  danger?: ReadonlyMap<number, number>;
  /** The character's stints (grind-log.ts), in any order: measured rates blended with the estimates. */
  measured?: readonly GrindSession[];
  /** Monsters unfinished quests still need: maps where they spawn get a bonus. */
  quests?: readonly QuestTarget[];
}

export interface MapRating {
  map: number;
  name: string;
  /** Expected experience per hour of hunting there: the estimate blended with any measurements, and the quest bonus. */
  rate: number;
  /** The estimate from the game data alone. */
  estimate: number;
  /** Measured there (adjusted to the character's level), and how far it's trusted (0-1). */
  measured?: { rate: number; trust: number };
  /** The quests with monsters to kill there, and the bonus they give (1: none). */
  quests: string[];
  questFactor: number;
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
export function rateMap(data: TravelData, mapIndex: number, who: Grinder, options: GrindOptions, stints = estimatedStints(data, who, options)): MapRating | { skip: string } {
  const map = data.maps.find((m) => m.i === mapIndex);
  if (!map) return { skip: 'unknown map' };
  if (!levelAllows(map, who.level)) return { skip: `needs level ${map.level ?? 0}${map.maxLevel ? `-${map.maxLevel}` : '+'}` };
  if (GRIND.excludedMaps.test(map.name)) return { skip: 'excluded' };
  const hunted = huntedOn(data, mapIndex);
  if (!hunted) return { skip: 'no spawn data' };
  const level = who.level;
  const monsters = hunted.reduce((sum, m) => sum + m.n, 0);
  if (monsters < GRIND.minMonsters) return { skip: 'too few monsters' };
  const tooStrong = hunted.filter((m) => m.level > level + options.maxLevelsAbove).reduce((sum, m) => sum + m.n, 0) / monsters;
  if (tooStrong > GRIND.tooStrongShare) return { skip: `${Math.round(tooStrong * 100)}% of its monsters are too strong` };
  const estimate = estimateRate(data, mapIndex, hunted, level, characterDamage(data, level, who.cls, options.damage), options);

  // Measured here: how it compared with its estimate (newest first), trusted as far as it goes. What's not
  // trusted goes by how the other maps compared with theirs, trusted less (elsewhereTrust).
  const own = blendMeasurements(stints.filter((s) => s.map === mapIndex), level);
  const others = blendMeasurements(stints.filter((s) => s.map !== mapIndex), level);
  const elsewhere = others ? 1 + others.trust * GRIND.elsewhereTrust * (others.ratio - 1) : 1;
  const measured = own ? { rate: estimate * own.ratio, trust: own.trust } : undefined;
  const blended = estimate * (own ? own.trust * own.ratio + (1 - own.trust) * elsewhere : elsewhere);

  // Quest targets spawning here (those tied to a map only there), and the share of the monsters they make up.
  const here = (options.quests ?? []).filter((q) => (q.map === null || q.map === mapIndex) && hunted.some((m) => m.name === q.name.toLowerCase()));
  const wanted = new Set(here.map((q) => q.name.toLowerCase()));
  const questShare = hunted.filter((m) => wanted.has(m.name)).reduce((sum, m) => sum + m.n, 0) / monsters;
  const questFactor = here.length ? 1 + GRIND.questBonus * Math.min(1, questShare / GRIND.questFullShare) : 1;
  const quests = [...new Set(here.map((q) => q.quest))];

  const byLevel = [...hunted].sort((a, b) => a.level - b.level);
  let seen = 0;
  const median = byLevel.find((m) => (seen += m.n) >= monsters / 2)!.level;
  return { map: mapIndex, name: map.name, rate: blended * questFactor, estimate, measured, quests, questFactor, monsters, monsterLevel: median, tooStrong };
}

interface Hunted {
  /** Lower case, for matching quest targets. */
  name: string;
  level: number;
  exp: number;
  health: number;
  /** How many to expect. */
  n: number;
}

const huntedCache = new WeakMap<TravelData, Map<number, Hunted[] | null>>();

/**
 * The monsters hunted on a map, with how many to expect (a spot's count is
 * shared evenly by the monsters listed there), leaving out bosses and
 * difficulty-tier copies. Null without spawn data.
 */
function huntedOn(data: TravelData, mapIndex: number): Hunted[] | null {
  const cache = huntedCache.get(data) ?? huntedCache.set(data, new Map()).get(data)!;
  if (cache.has(mapIndex)) return cache.get(mapIndex)!;
  const spots = data.spawns?.[mapIndex];
  let hunted: Hunted[] | null = null;
  if (spots?.length) {
    const counts = new Map<number, number>();
    for (const [, , n, set] of spots) {
      const list = data.spawnSets?.[set] ?? [];
      for (const i of list) counts.set(i, (counts.get(i) ?? 0) + n / list.length);
    }
    const names = new Set([...counts.keys()].map((i) => data.monsters?.[i]));
    hunted = [];
    for (const [i, n] of counts) {
      const stats = data.monsterStats?.[i];
      if (!stats || stats[3]) continue;
      const name = data.monsters?.[i] ?? '';
      const plain = TIER.exec(name)?.[1];
      if (plain && names.has(plain)) continue;
      hunted.push({ name: name.toLowerCase(), level: stats[0], exp: stats[1], health: stats[2], n });
    }
  }
  cache.set(mapIndex, hunted);
  return hunted;
}

/** The character's damage per second, as the estimates have it: the typical health at their level, killed in sameLevelKillSeconds. */
export function damagePerSecond(data: TravelData, level: number, cls: number | undefined): number {
  const health = typicalHealth(data);
  return (health[Math.min(Math.max(level, 0), health.length - 1)] / GRIND.sameLevelKillSeconds) * (GRIND.classDamage[cls ?? 0] ?? 1);
}

/** How far measured damage is trusted: not at all with no kills, fully at damageFullTrustKills. */
export function damageTrust(kills: number): number {
  return Math.min(1, Math.max(0, kills / GRIND.damageFullTrustKills));
}

/** The character's damage per second for the estimates: damagePerSecond, blended with what was measured as far as it's trusted. */
export function characterDamage(data: TravelData, level: number, cls: number | undefined, measured?: GrindOptions['damage']): number {
  const estimate = damagePerSecond(data, level, cls);
  const trust = measured ? damageTrust(measured.kills) : 0;
  return estimate * (1 - trust) + (measured?.perSecond ?? 0) * trust;
}

/**
 * The character's damage per second at `level`, as measured: the damage their
 * kills dealt over what damagePerSecond would have dealt in the same time (each
 * at its own level, so kills from a few levels back still count), applied at
 * `level`. Newer kills count more (killRecency), and those at other levels
 * less, also towards `kills` (the count trust goes by). Null with no kills.
 */
export function measuredDamage(data: TravelData, kills: readonly Kill[], level: number, cls: number | undefined): { perSecond: number; kills: number } | null {
  let dealt = 0;
  let expected = 0;
  let count = 0;
  [...kills]
    .sort((a, b) => b.at - a.at)
    .forEach((k, rank) => {
      const near = GRIND.measureLevelDecay ** Math.abs(level - k.level);
      const weight = GRIND.killRecency ** rank * near;
      dealt += weight * k.damage;
      expected += weight * k.seconds * damagePerSecond(data, k.level, cls);
      count += near;
    });
  if (expected <= 0) return null;
  return { perSecond: (damagePerSecond(data, level, cls) * dealt) / expected, kills: count };
}

/** What fights at a level gap (monster's level less the character's then; at or below the level: 0) showed. */
interface GapFights {
  kills: number;
  /** The share of health a kill cost, on average, and the share of fights that ended in a death (newest counting most). */
  hpLost: number;
  deathRate: number;
}

/** The character's fights by level gap. Kills are weighted by killRecency, newest first; a death as the kills of its time. */
function fightsByGap(fights: Fights): Map<number, GapFights> {
  const sums = new Map<number, { kills: number; weight: number; hpLost: number; deaths: number }>();
  const gapOf = (level: number, monsterLevel: number) => Math.max(0, monsterLevel - level);
  const at = (gap: number) => sums.get(gap) ?? sums.set(gap, { kills: 0, weight: 0, hpLost: 0, deaths: 0 }).get(gap)!;
  const kills = [...fights.kills].sort((a, b) => b.at - a.at);
  kills.forEach((k, rank) => {
    const sum = at(gapOf(k.level, k.monsterLevel));
    const weight = GRIND.killRecency ** rank;
    sum.kills++;
    sum.weight += weight;
    sum.hpLost += weight * k.hpLost;
  });
  for (const d of fights.deaths) {
    if (d.monsterLevel === null) continue;
    at(gapOf(d.level, d.monsterLevel)).deaths += GRIND.killRecency ** kills.filter((k) => k.at > d.at).length;
  }
  const out = new Map<number, GapFights>();
  for (const [gap, sum] of sums) {
    out.set(gap, { kills: sum.kills, hpLost: sum.weight ? sum.hpLost / sum.weight : 0, deathRate: sum.deaths / (sum.weight + sum.deaths) });
  }
  return out;
}

/**
 * The share of experience monsters some levels above the character keep, as
 * learned from their fights: what a kill there costs in health, and in deaths
 * (deathCostKills each). Blended with dangerPerLevel as far as there are kills
 * to go by (dangerFullTrustKills). For estimateRate, by levels above.
 */
export function dangerByGap(fights: Fights): Map<number, number> {
  const out = new Map<number, number>();
  for (const [gap, f] of fightsByGap(fights)) {
    if (gap <= 0) continue;
    const learned = Math.max(0, 1 - f.hpLost) * Math.max(0, 1 - f.deathRate * GRIND.deathCostKills);
    const trust = Math.min(1, f.kills / GRIND.dangerFullTrustKills);
    out.set(gap, GRIND.dangerPerLevel ** gap * (1 - trust) + learned * trust);
  }
  return out;
}

/**
 * How many levels above the character to fight, from their fights, at most
 * `cap`: up to the highest gap seen (dangerMinKills) that's safe, with every
 * gap seen below it safe too (safeHpShare, safeDeathRate); one more when that
 * top gap is clearly safe (clearHpShare), so it can climb. Until a gap is seen
 * to be too costly, never under startLevelsAbove. One less for
 * deathCooldownMinutes after a death fighting above the level, or to who knows
 * what (dying at the level is the death rate's to judge: fighting less far
 * above wouldn't help). `capped`: the cap held it back.
 */
export function autoLevelsAbove(fights: Fights, cap: number, now: number): { levels: number; capped: boolean } {
  const byGap = fightsByGap(fights);
  let top = 0;
  let clear = true;
  let costly = false;
  for (const gap of [...byGap.keys()].sort((a, b) => a - b)) {
    const f = byGap.get(gap)!;
    if (f.kills < GRIND.dangerMinKills) continue;
    if (f.hpLost >= GRIND.safeHpShare || f.deathRate >= GRIND.safeDeathRate) {
      costly = true;
      break;
    }
    top = gap;
    clear = f.hpLost < GRIND.clearHpShare;
  }
  let levels = costly ? top : Math.max(GRIND.startLevelsAbove, top + (clear ? 1 : 0));
  const above = (d: Fights['deaths'][number]) => d.monsterLevel === null || d.monsterLevel > d.level;
  if (fights.deaths.some((d) => above(d) && now - d.at < GRIND.deathCooldownMinutes * 60_000)) levels = Math.max(0, levels - 1);
  return { levels: Math.min(levels, Math.max(cap, 0)), capped: levels > cap };
}

/** A stint with the estimate for it: at its level, and the damage the character dealt then. */
type EstimatedStint = GrindSession & { estimate: number };

/**
 * The character's stints (newest first) with their estimates. Each is worked
 * out with the damage the character dealt then: its own kills' as far as they
 * go, else today's (as a share of the estimate's, at its level). So measuring
 * harder hits now doesn't count twice: a stint that went well because of them
 * doesn't add its ratio on top.
 */
function estimatedStints(data: TravelData, who: Grinder, options: GrindOptions): EstimatedStint[] {
  const share = characterDamage(data, who.level, who.cls, options.damage) / damagePerSecond(data, who.level, who.cls);
  return [...(options.measured ?? [])]
    .sort((a, b) => b.at - a.at)
    .flatMap((s) => {
      const hunted = huntedOn(data, s.map);
      if (!hunted) return [];
      const today = damagePerSecond(data, s.level, who.cls) * share;
      const trust = s.kills && s.dps ? damageTrust(s.kills) : 0;
      const damage = today * (1 - trust) + (s.dps ?? 0) * trust;
      return [{ ...s, estimate: estimateRate(data, s.map, hunted, s.level, damage, options) }];
    });
}

/**
 * The estimated exp/h from the game data for a character of this level
 * dealing `damage` a second: the monsters' total experience over the total time
 * to find and kill them.
 */
function estimateRate(data: TravelData, mapIndex: number, hunted: Hunted[], level: number, damage: number, options: GrindOptions): number {
  const monsters = hunted.reduce((sum, m) => sum + m.n, 0);
  if (!monsters) return 0;
  // Between kills: the walk to the next monster, from how thinly they're spread over the spawn area.
  const area = (data.spawns?.[mapIndex]?.length ?? 0) * GRIND.spawnCellTiles ** 2;
  const seekSeconds = (GRIND.seekShare * Math.sqrt(area / monsters)) / GRIND.tilesPerSecond;
  let exp = 0;
  let seconds = 0;
  for (const m of hunted) {
    const above = m.level - level;
    const below = level - m.level - GRIND.outlevelGrace;
    // Too strong: still met (and fought) on the way, but nothing to count on from it.
    const worth =
      above > options.maxLevelsAbove ? 0
      : above > 0 ? (options.danger?.get(above) ?? GRIND.dangerPerLevel ** above)
      : below > 0 ? Math.max(GRIND.outlevelFloor, 1 - below * GRIND.outlevelPerLevel)
      : 1;
    exp += m.n * m.exp * worth;
    seconds += m.n * (m.health / damage + GRIND.killOverheadSeconds + seekSeconds);
  }
  return (exp / seconds) * 3600;
}

/**
 * How measurements on a map compare with its estimates: `ratio` is the
 * experience measured over what the estimate (at each stint's level) promised
 * for the same time, and `trust` (0-1) how far to go by it. Stints are newest
 * first; each counts less the older it is and the further its level from the
 * character's, both in the ratio and towards full trust. Null with nothing to go on.
 */
export function blendMeasurements(stints: readonly { level: number; ms: number; exp: number; estimate: number }[], level: number): { ratio: number; trust: number } | null {
  let measured = 0;
  let expected = 0;
  let time = 0;
  stints.forEach((s, rank) => {
    if (s.estimate <= 0 || s.ms <= 0) return;
    const weight = GRIND.measureRecency ** rank * GRIND.measureLevelDecay ** Math.abs(level - s.level);
    measured += weight * s.exp;
    expected += (weight * s.estimate * s.ms) / 3_600_000;
    time += weight * s.ms;
  });
  if (expected <= 0) return null;
  return {
    ratio: Math.min(Math.max(measured / expected, 0), GRIND.measureMaxRatio),
    trust: Math.min(1, time / (GRIND.measureFullTrustMinutes * 60_000)),
  };
}

/** Every map the character may grind on, best rate first (ties by map index, so the order never wavers). Not checked for a route. */
export function rateMaps(data: TravelData, who: Grinder, options: GrindOptions): MapRating[] {
  const out: MapRating[] = [];
  const stints = estimatedStints(data, who, options);
  for (const map of data.maps) {
    const rating = rateMap(data, map.i, who, options, stints);
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
 * better (switchGain) or it has been outgrown (poorShare). With `questsFirst`
 * and quest targets about, only maps where they spawn are looked at (all of
 * them again when none can be reached). Null if nowhere suits and can be reached.
 */
export function chooseGrindMap(
  data: TravelData,
  start: Start,
  who: Grinder,
  options: GrindOptions & { current?: number; questsFirst?: boolean },
): GrindChoice | null {
  const rated = rateMaps(data, who, options);
  // Routes are slow to work out: each map's once.
  const routes = new Map<number, Route | null>();
  const route = (rating: MapRating) => {
    if (!routes.has(rating.map)) routes.set(rating.map, planRoute(data, start, { id: `map:${rating.map}`, label: rating.name, map: rating.map }, who));
    return routes.get(rating.map)!;
  };
  const questName = (choice: GrindChoice) => `quest: ${choice.quests.join(', ')}`;

  if (options.questsFirst && options.quests?.length) {
    const choice = pickMap(data, start, rated.filter((r) => r.quests.length), route, options.current);
    if (choice) return { ...choice, reason: questName(choice) };
  }
  const choice = pickMap(data, start, rated, route, options.current);
  // Chosen where quest monsters spawn: say so if the bonus is what decided it.
  if (choice?.quests.length) {
    const without = rated.map((r) => ({ ...r, rate: r.rate / r.questFactor })).sort((a, b) => b.rate - a.rate || a.map - b.map);
    if (pickMap(data, start, without, route, options.current)?.map !== choice.map) choice.reason = questName(choice);
  }
  return choice;
}

/** chooseGrindMap's choice among `rated` (best rate first), with the hysteresis. */
function pickMap(data: TravelData, start: Start, rated: MapRating[], route: (rating: MapRating) => Route | null, current?: number): GrindChoice | null {
  // Down the list by rate, stopping once no map left can beat the best found (the trip only ever lowers a rate).
  let best: GrindChoice | null = null;
  for (const rating of rated) {
    if (best && rating.rate <= best.effective) break;
    const way = route(rating);
    if (!way) continue;
    const effective = withTrip(rating, way);
    if (!best || effective > best.effective) best = { ...rating, route: way, effective, stay: false, reason: '' };
  }
  if (!best) return null;

  const currentIndex = current ?? start.map;
  const kept = rated.find((r) => r.map === currentIndex);
  const keptWay = kept && (kept.map === best.map ? best.route : route(kept));
  if (!kept || !keptWay) {
    // Nothing to stick with: the first choice, or the current map no longer suits (or can't be reached).
    best.reason = current !== undefined && current !== best.map ? `${mapName(data, current)} no longer suits` : 'the best';
    return best;
  }
  const stay: GrindChoice = { ...kept, route: keptWay, effective: withTrip(kept, keptWay), stay: true, reason: '' };
  if (best.map === kept.map) {
    stay.reason = 'still the best';
    return stay;
  }
  // Outgrown: well below the best even before counting the trip there.
  if (kept.rate < best.rate * GRIND.poorShare) {
    best.reason = `outgrew ${kept.name}`;
    return best;
  }
  const gain = Math.round((best.effective / stay.effective - 1) * 100);
  if (best.effective >= stay.effective * GRIND.switchGain) {
    best.reason = `${gain}% better than ${kept.name}`;
    return best;
  }
  stay.reason = `${best.name} is only ${gain}% better`;
  return stay;
}

/** 40k, 1.2M: a rate for the status line. */
export function shortNumber(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(value >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(value));
}

/**
 * "Grinding at Death Valley Lv 2: ~40k exp/h for level 34 (still the best)", and with
 * measurements "~1.2M est, 0.9M measured exp/h"; with `fighting`, "...; fighting up to +4 (auto)".
 */
export function describeChoice(choice: GrindChoice, level: number, fighting?: { levels: number; capped: boolean }): string {
  const rate = choice.measured ? `~${shortNumber(choice.estimate)} est, ${shortNumber(choice.measured.rate)} measured` : `~${shortNumber(choice.estimate)}`;
  const band = fighting ? `; fighting up to +${fighting.levels} (${fighting.capped ? 'cap' : 'auto'})` : '';
  return `Grinding at ${choice.name}: ${rate} exp/h for level ${level} (${choice.reason})${band}`;
}

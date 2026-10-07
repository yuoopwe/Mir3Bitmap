/**
 * Gathering trips: where to gather. Rates every region that grows plants or
 * ore (the gathering spots in game-data/travel.json) by the profession
 * experience an hour there should bring at the character's profession levels,
 * and picks the best one within reach, counting the trip there and sticking
 * with the current spot unless another is clearly better. Pure: no game, no screen.
 */
import { GRIND, levelAllows, type Grinder } from './grind';
import { mapName, planRoute, type GatherNode, type GatherSpot, type Route, type Start, type TravelData } from './travel';

/** Every number the planner (and the trips it plans) is tuned by. Rough by nature: the aim is to rank spots sensibly. */
export const GATHER = {
  /** Seconds a pick takes, the walk to the node included: one character picks at most 3600 / this an hour. */
  pickSeconds: 8,
  /** Nodes that only grow in some weather or light count as this share of one. */
  sometimesShare: 0.2,
  /** A trip's time is spread over a stay this long (minutes) when comparing spots. */
  stayMinutes: 30,
  /** Spots within this share of the best rate are as good: the one with the most nodes wins. */
  closeShare: 0.05,
  /** Another spot must promise this much more (counting the trip) before leaving the current one. */
  switchGain: 1.2,
  // ---- The trips (bot-gather-trips.ts) ----
  /** Plan again after gathering this long at a spot (a new profession level plans again straight away). */
  replanMinutes: 20,
  /** A spot that failed (no way there, nothing found, picks refused) is left out this long. */
  failedMinutes: 30,
  /** Nothing to gather in sight for this long at a spot counts as a failure. */
  nothingFoundMinutes: 3,
};

export type GatherKind = 'plant' | 'ore';

/** Each kind's profession (Library.ProfessionId): Harvesting ("Scavenging" in game) for plants, Mining for ore. */
export const PROFESSION: Record<GatherKind, number> = { plant: 3, ore: 2 };

/** The usable profession level of each kind to plan for; a kind left out (not ticked, or not earning) isn't gathered. */
export type GatherLevels = Partial<Record<GatherKind, number>>;

export interface GatherOptions {
  /** Regions left out (they failed lately). */
  skip?: ReadonlySet<number>;
  /** Nodes the game refused (by node id), with the level they needed there: wherever they need that much or more, they don't count. */
  refused?: ReadonlyMap<number, number>;
  /** The region being gathered in: kept unless another is clearly better. */
  current?: number;
}

export interface SpotRating {
  spot: GatherSpot;
  map: number;
  name: string;
  /** Profession experience an hour there, both kinds together. */
  rate: number;
  /** Nodes there the character can gather, by kind (those that grow only now and then counted whole). */
  plants: number;
  ores: number;
}

export interface GatherChoice extends SpotRating {
  route: Route;
  /** The rate with the trip's time spread over a stay. */
  effective: number;
  /** Staying at the current spot. */
  stay: boolean;
  /** Why this spot, for the status line. */
  reason: string;
}

const nodesCache = new WeakMap<TravelData, Map<number, GatherNode>>();

function nodesById(data: TravelData): Map<number, GatherNode> {
  return nodesCache.get(data) ?? nodesCache.set(data, new Map((data.gathering?.nodes ?? []).map((n) => [n.id, n]))).get(data)!;
}

/**
 * The profession level a node needs in a region. The region's own level (the spawn's ProfessionLevelOverride, 30 in
 * Desert Tunnel say) may or may not keep lower levels from gathering there; it's taken as a requirement to be safe.
 * To loosen that, return node.level here.
 */
export function neededLevel(node: GatherNode, regionLevel: number): number {
  return Math.max(node.level, regionLevel);
}

/** Whether the character can gather this node in a region of this level: its kind is planned for, the level allows it, and it wasn't refused at that level. */
export function canGather(node: GatherNode, regionLevel: number, levels: GatherLevels, refused?: ReadonlyMap<number, number>): boolean {
  const level = levels[node.kind];
  const needed = neededLevel(node, regionLevel);
  if (level === undefined || needed > level) return false;
  const refusedAt = refused?.get(node.id);
  return refusedAt === undefined || needed < refusedAt;
}

/**
 * The experience an hour a spot should bring, or null if there's nothing there
 * to gather. Each node gives at most count x 60 / respawn picks an hour (a
 * picked node takes that long to come back), and the character makes at most
 * 3600 / pickSeconds picks: the ones giving the most experience first.
 */
export function rateSpot(data: TravelData, spot: GatherSpot, levels: GatherLevels, refused?: ReadonlyMap<number, number>): SpotRating | null {
  const nodes = nodesById(data);
  const supply: { exp: number; perHour: number }[] = [];
  let plants = 0;
  let ores = 0;
  for (const [id, count, regionLevel] of spot.nodes) {
    const node = nodes.get(id);
    if (!node || !canGather(node, regionLevel, levels, refused)) continue;
    if (node.kind === 'plant') plants += count;
    else ores += count;
    const share = node.weather || node.light ? GATHER.sometimesShare : 1;
    supply.push({ exp: node.exp, perHour: (count * share * 60) / Math.max(spot.respawn, 1) });
  }
  if (!supply.length) return null;
  let picks = 3600 / GATHER.pickSeconds;
  let rate = 0;
  for (const s of supply.sort((a, b) => b.exp - a.exp)) {
    const taken = Math.min(s.perHour, picks);
    rate += taken * s.exp;
    picks -= taken;
  }
  return { spot, map: spot.map, name: mapName(data, spot.map), rate, plants, ores };
}

/** Every spot the character may gather at (their level allows the map), best rate first, then most nodes. Not checked for a route. */
export function rateSpots(data: TravelData, who: Grinder, levels: GatherLevels, options: GatherOptions = {}): SpotRating[] {
  const maps = new Map(data.maps.map((m) => [m.i, m]));
  const out: SpotRating[] = [];
  for (const spot of data.gathering?.spots ?? []) {
    const map = maps.get(spot.map);
    if (!map || !levelAllows(map, who.level) || GRIND.excludedMaps.test(map.name) || options.skip?.has(spot.region)) continue;
    const rating = rateSpot(data, spot, levels, options.refused);
    if (rating && rating.rate > 0) out.push(rating);
  }
  return out.sort((a, b) => b.rate - a.rate || nodeCount(b) - nodeCount(a) || a.spot.region - b.spot.region);
}

const nodeCount = (r: SpotRating) => r.plants + r.ores;

/** The rate counting the trip: its time spread over a stay. */
function withTrip(rating: SpotRating, route: Route): number {
  const stay = GATHER.stayMinutes * 60;
  return (rating.rate * stay) / (stay + route.steps / GRIND.tilesPerSecond);
}

/**
 * Where to gather next, from `start`: the best spot by its rate counting the
 * trip there (spots within closeShare of it count as as good, and the one with
 * the most nodes wins), leaving out spots with no way there. The current spot
 * is kept unless another is switchGain better. Null if there's nowhere.
 */
export function chooseGatherSpot(data: TravelData, start: Start, who: Grinder, levels: GatherLevels, options: GatherOptions = {}): GatherChoice | null {
  const rated = rateSpots(data, who, levels, options);
  // Routes are slow to work out: each map's once.
  const routes = new Map<number, Route | null>();
  const route = (map: number) => {
    if (!routes.has(map)) routes.set(map, planRoute(data, start, { id: `map:${map}`, label: mapName(data, map), map }, who));
    return routes.get(map)!;
  };
  const choice = (rating: SpotRating, way: Route): GatherChoice => ({ ...rating, route: way, effective: withTrip(rating, way), stay: false, reason: '' });

  // Down the list by rate, until no spot left could come close to the best found (the trip only ever lowers a rate).
  const reached: GatherChoice[] = [];
  let top = 0;
  for (const rating of rated) {
    if (rating.rate < top * (1 - GATHER.closeShare)) break;
    const way = route(rating.map);
    if (!way) continue;
    const c = choice(rating, way);
    reached.push(c);
    top = Math.max(top, c.effective);
  }
  const close = reached.filter((c) => c.effective >= top * (1 - GATHER.closeShare));
  const best = close.sort((a, b) => nodeCount(b) - nodeCount(a) || b.effective - a.effective || a.spot.region - b.spot.region)[0];
  if (!best) return null;

  const kept = options.current === undefined ? undefined : rated.find((r) => r.spot.region === options.current);
  const keptWay = kept && route(kept.map);
  if (!kept || !keptWay) {
    best.reason = options.current !== undefined && options.current !== best.spot.region ? 'the last spot no longer suits' : 'the best';
    return best;
  }
  const stay = { ...choice(kept, keptWay), stay: true };
  if (best.spot.region === kept.spot.region) {
    stay.reason = 'still the best';
    return stay;
  }
  const gain = Math.round((best.effective / stay.effective - 1) * 100);
  if (best.effective >= stay.effective * GATHER.switchGain) {
    best.reason = `${gain}% better than ${kept.name}`;
    return best;
  }
  stay.reason = gain > 0 ? `${best.name} is only ${gain}% better` : 'still the best';
  return stay;
}

/**
 * The nodes (by id) the character may pick on a map: those some spot there
 * lets them gather. Nodes no spot on the map lists go by their own level.
 */
export function gatherableOn(data: TravelData, map: number, levels: GatherLevels, refused?: ReadonlyMap<number, number>): Set<number> {
  const nodes = nodesById(data);
  const listed = new Set<number>();
  const out = new Set<number>();
  for (const spot of data.gathering?.spots ?? []) {
    if (spot.map !== map) continue;
    for (const [id, , regionLevel] of spot.nodes) {
      const node = nodes.get(id);
      listed.add(id);
      if (node && canGather(node, regionLevel, levels, refused)) out.add(id);
    }
  }
  for (const node of nodes.values()) if (!listed.has(node.id) && canGather(node, 0, levels, refused)) out.add(node.id);
  return out;
}

/** The level a node needs on a map: the lowest any spot there asks (its own when none lists it). */
export function levelOn(data: TravelData, map: number, nodeId: number): number | undefined {
  const node = nodesById(data).get(nodeId);
  if (!node) return undefined;
  const levels = (data.gathering?.spots ?? []).filter((s) => s.map === map).flatMap((s) => s.nodes.filter(([id]) => id === nodeId).map(([, , l]) => neededLevel(node, l)));
  return levels.length ? Math.min(...levels) : node.level;
}

/** The node's kind and its own level, from the data. */
export function gatherNode(data: TravelData, nodeId: number): GatherNode | undefined {
  return nodesById(data).get(nodeId);
}

/** "Bichon Province: 118 plants, ~2,250 exp/h". */
export function describeSpot(choice: SpotRating): string {
  const n = (value: number) => Math.round(value).toLocaleString('en-US');
  const counts = [choice.plants && `${n(choice.plants)} plants`, choice.ores && `${n(choice.ores)} ore`].filter(Boolean).join(', ');
  return `${choice.name}: ${counts}, ~${n(choice.rate)} exp/h`;
}

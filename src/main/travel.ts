/**
 * Travel between maps: the links between maps, the NPCs and the waypoints,
 * from game-data/travel.json (scripts/travel-data.js), and the shortest chain
 * of links from where the player is to a map or an NPC. A waypoint teleport is
 * a link too: from a waypoint stone, to wherever that waypoint puts you.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface TravelMap {
  i: number;
  name: string;
  type?: string;
  /** Size, when its map file could be read. */
  w?: number;
  h?: number;
  level?: number;
  maxLevel?: number;
  /** Mounts aren't allowed here. */
  noHorse?: boolean;
}

export interface TravelLink {
  id: number;
  from: number;
  to: number;
  /** The tiles on `from` that take you through, as [x, y]. */
  exit: [number, number][];
  /** Where you arrive on `to`. */
  land: [number, number];
  /** Something the link needs that the bot can't check (an item, an instance): left out of routes. */
  needs?: string;
  /** Only these classes can use it: Library.RequiredClass flags. */
  cls?: number;
  /** From the landing: steps to each exit of `to` (by link id), and to each NPC there (by NPC id). */
  steps?: Record<string, number>;
  npcSteps?: Record<string, number>;
  /** A waypoint teleport: click the stone (NPC `stone`), then pick the waypoint called `name` in the window. */
  waypoint?: { name: string; stone: number; always?: boolean };
}

export interface TravelNpc {
  id: number;
  name: string;
  map: number;
  /** The shop or spot it's in. */
  where: string;
  /** Where it stands; missing for NPCs that wander a big area (head for their map). */
  at?: [number, number];
  /** A waypoint stone: clicking it opens the waypoint window. */
  stone?: boolean;
}

/** Where a waypoint takes you, with the steps from there as for a link's landing. */
export interface TravelWaypoint {
  id: number;
  name: string;
  map: number;
  land: [number, number];
  /** Usable without having been unlocked. */
  always?: boolean;
  cost?: number;
  steps?: Record<string, number>;
  npcSteps?: Record<string, number>;
}

export interface TravelQuest {
  id: number;
  name: string;
  /** Its internal name (what the quest log shows), when different from `name`. */
  key?: string;
  type: string;
  start: number;
  finish: number;
  level?: number;
  cls?: number;
  after?: number[];
  exp?: number;
  /** Only for seasonal characters. */
  seasonal?: boolean;
  /** What it gives besides experience, as [item name, amount]: ["Forge Stone", 100], say. */
  items?: [string, number][];
  tasks: {
    type: string;
    amount: number;
    stage?: number;
    /** [monster name] or [monster name, map index]. */
    monsters?: ([string] | [string, number])[];
    item?: string;
    region?: { id: number; map: number; at: [number, number] };
    npc?: number;
  }[];
}

/** A plant (Harvesting, called Scavenging in game) or ore (Mining) node. */
export interface GatherNode {
  id: number;
  name: string;
  kind: 'plant' | 'ore';
  /** The profession level it needs, and the profession experience one gives. */
  level: number;
  exp: number;
  /** What it gives. */
  item: string;
  /** It only grows in this weather, or this light (Dark, Bright). */
  weather?: string;
  light?: string;
}

/** A region that grows gathering nodes. */
export interface GatherSpot {
  region: number;
  map: number;
  /** Where to look: squares of the region, busiest first, as [x, y, share of the region]. */
  at: [number, number, number][];
  /** Minutes a picked node takes to come back. */
  respawn: number;
  /** [node id, how many, profession level the region sets (0: the node's own)]. */
  nodes: [number, number, number][];
}

export interface TravelData {
  maps: TravelMap[];
  links: TravelLink[];
  npcs: TravelNpc[];
  waypoints?: TravelWaypoint[];
  /** Where monsters spawn: per map, spots as [x, y, monsters expected there, index into spawnSets]. */
  spawns?: Record<string, [number, number, number, number][]>;
  /** Lists of monsters (indices into `monsters`) spawning at a spot. */
  spawnSets?: number[][];
  monsters?: string[];
  /** Per monster (same order as `monsters`): [level, experience per kill, health, 1 if a boss else 0]. */
  monsterStats?: [number, number, number, number][];
  /**
   * Every sub-boss, boss and behemoth that respawns on a map, as [monster (index into ), map, x, y, how many,
   * respawn minutes (once killed), kind (1 sub-boss, 2 boss, 3 behemoth)].
   */
  bossSpawns?: [number, number, number, number, number, number, number][];
  /** Quests picked up from an NPC: giver and taker (NPC ids), level, class mask, quests to have done first, exp reward and tasks. */
  quests?: TravelQuest[];
  /** Where each quest task's region is, by region id: [map, x, y]. */
  questRegions?: Record<string, [number, number, number]>;
  /** Every gathering node, and every region that grows them. */
  gathering?: { nodes: GatherNode[]; spots: GatherSpot[] };
}

/** Somewhere to travel to: a map, or an NPC. `id` is "map:<index>" or "npc:<index>". */
export interface Place {
  id: string;
  label: string;
  map: number;
  npc?: TravelNpc;
}

/** Each map change costs about this many steps (the loading, and lining up on the exit). */
const HOP_STEPS = 10;
/** A waypoint teleport costs about this many steps (clicking the stone, picking it, the teleport). */
const WAYPOINT_STEPS = 40;
/** On maps whose walls weren't read, steps are guessed from the straight distance, times this. */
const DETOUR = 1.4;

let cached: TravelData | null = null;

/** game-data/travel.json (built by scripts/travel-data.js). */
export function loadTravelData(file = path.join(__dirname, '..', '..', 'game-data', 'travel.json')): TravelData {
  if (!cached) {
    cached = JSON.parse(readFileSync(file, 'utf8')) as TravelData;
    cached.links.push(...waypointLinks(cached));
  }
  return cached;
}

/** A link from every waypoint stone to every waypoint elsewhere (ids from 1,000,000 up, so they never clash with the game's). */
export function waypointLinks(data: TravelData): TravelLink[] {
  const out: TravelLink[] = [];
  for (const stone of data.npcs) {
    if (!stone.stone || !stone.at) continue;
    for (const w of data.waypoints ?? []) {
      if (w.map === stone.map) continue;
      out.push({
        id: 1_000_000 + stone.id * 1000 + w.id,
        from: stone.map,
        to: w.map,
        exit: [stone.at],
        land: w.land,
        steps: w.steps,
        npcSteps: w.npcSteps,
        waypoint: { name: w.name, stone: stone.id, always: w.always },
      });
    }
  }
  return out;
}

export function mapName(data: TravelData, index: number): string {
  return data.maps.find((m) => m.i === index)?.name ?? `map ${index}`;
}

/** Every map and NPC, labelled for the search box. */
export function places(data: TravelData): Place[] {
  const maps: Place[] = data.maps.map((m) => ({ id: `map:${m.i}`, label: `${m.name}${m.level ? ` (level ${m.level}+)` : ''}`, map: m.i }));
  const npcs: Place[] = data.npcs.map((n) => ({
    id: `npc:${n.id}`,
    label: `${n.name} - ${mapName(data, n.map)}${n.where && n.where !== n.name ? `, ${n.where}` : ''}`,
    map: n.map,
    npc: n,
  }));
  return [...maps.sort((a, b) => a.label.localeCompare(b.label)), ...npcs.sort((a, b) => a.label.localeCompare(b.label))];
}

export function findPlace(data: TravelData, id: string): Place | undefined {
  // "spot:<map>:<x>:<y>": a tile to walk to (a quest's "go to"), handled like an NPC standing there.
  const spot = /^spot:(\d+):(\d+):(\d+)$/.exec(id);
  if (spot) {
    const [map, x, y] = spot.slice(1).map(Number);
    return { id, label: `a spot on ${mapName(data, map)}`, map, npc: { id: -1, name: '(spot)', map, where: '', at: [x, y] } };
  }
  return places(data).find((p) => p.id === id);
}

/** A MirClass's Library.RequiredClass flag (for class-only links and quests). */
export function classFlagOf(cls: number): number {
  return cls <= 7 ? 1 << cls : cls === 8 ? 256 : cls === 9 ? 512 : 0;
}

/**
 * Places matching what's typed: every word must appear in the label. Labels
 * starting with the text come first, then those with a word starting with it.
 */
export function searchPlaces(list: Place[], query: string, limit = 30): Place[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const q = query.trim().toLowerCase();
  const rank = (label: string) => (label.startsWith(q) ? 0 : label.split(/[\s,(-]+/).some((w) => w.startsWith(words[0])) ? 1 : 2);
  return list
    .map((p) => ({ p, label: p.label.toLowerCase() }))
    .filter(({ label }) => words.every((w) => label.includes(w)))
    .sort((a, b) => rank(a.label) - rank(b.label) || a.label.length - b.label.length)
    .slice(0, limit)
    .map(({ p }) => p);
}

export interface Traveller {
  level?: number;
  /** Library.MirClass (0 Warrior ... 7 BladeDancer, 8 Mimic, 9 Anima); unknown leaves out class-only links. */
  cls?: number;
  /** The waypoints unlocked, by name; unknown (the window not opened yet) counts every waypoint as usable. */
  waypoints?: ReadonlySet<string>;
  /** Waypoints found not to work this trip (not in the window): left out. */
  badWaypoints?: ReadonlySet<string>;
}

/** Where the player is: their map, and the steps from them to each of its exits and NPCs (from the live walls). */
export interface Start {
  map: number;
  steps: Map<number, number>;
  npcSteps?: Map<number, number>;
  /** Their tile, for guessing steps where none were worked out. */
  at?: { x: number; y: number };
}

export interface Route {
  /** The links to take, in order (empty when already on the right map). */
  links: TravelLink[];
  /** Steps it should take, all told. */
  steps: number;
}

/** A MirClass as its Library.RequiredClass flag. */
const classFlag = (cls: number) => (cls <= 7 ? 1 << cls : cls === 8 ? 256 : cls === 9 ? 512 : 0);

const chebyshev = (a: { x: number; y: number }, [x, y]: [number, number]) => Math.max(Math.abs(a.x - x), Math.abs(a.y - y));
const guess = (from: { x: number; y: number } | undefined, tiles: [number, number][]) =>
  from ? Math.round(Math.min(...tiles.map((t) => chebyshev(from, t))) * DETOUR) : 100;

/**
 * The quickest chain of links from `start` to `place`, leaving out links the
 * traveller can't use and maps their level doesn't allow. Null if there's none.
 */
export function planRoute(data: TravelData, start: Start, place: Place, who: Traveller = {}): Route | null {
  const mapsByIndex = new Map(data.maps.map((m) => [m.i, m]));
  const exits = new Map<number, TravelLink[]>();
  const usable = (l: TravelLink) => {
    if (l.needs) return false;
    if (l.waypoint) {
      if (who.badWaypoints?.has(l.waypoint.name)) return false;
      if (!l.waypoint.always && who.waypoints && !who.waypoints.has(l.waypoint.name)) return false;
    }
    if (l.cls !== undefined && (who.cls === undefined || !(l.cls & classFlag(who.cls)))) return false;
    const to = mapsByIndex.get(l.to);
    if (who.level !== undefined && to && ((to.level ?? 0) > who.level || (to.maxLevel && to.maxLevel < who.level))) return false;
    return true;
  };
  for (const l of data.links) if (usable(l)) (exits.get(l.from) ?? exits.set(l.from, []).get(l.from)!).push(l);

  // The last stretch, once on the right map: to the NPC, or nothing.
  const finish = (steps: number | undefined, from: { x: number; y: number } | undefined) => {
    if (!place.npc) return 0;
    if (steps !== undefined) return steps;
    return place.npc.at ? guess(from, [place.npc.at]) : 0;
  };

  // Dijkstra over "just came through link L" (index into data.links), plus the start.
  const best = new Map<number, number>();
  const cameFrom = new Map<number, number | null>();
  const done = new Set<number>();
  let arrived: { cost: number; via: number | null } | null = null;
  if (start.map === place.map) arrived = { cost: finish(start.npcSteps?.get(place.npc?.id ?? -1), start.at), via: null };
  for (const e of exits.get(start.map) ?? []) {
    const steps = start.steps.get(e.id) ?? (start.steps.size ? undefined : guess(start.at, e.exit));
    if (steps === undefined) continue;
    const cost = steps + (e.waypoint ? WAYPOINT_STEPS : HOP_STEPS);
    if (cost < (best.get(e.id) ?? Infinity)) {
      best.set(e.id, cost);
      cameFrom.set(e.id, null);
    }
  }
  const byId = new Map(data.links.map((l) => [l.id, l]));
  while (true) {
    let at: number | null = null;
    for (const [id, cost] of best) if (!done.has(id) && (at === null || cost < best.get(at)!)) at = id;
    if (at === null) break;
    const cost = best.get(at)!;
    if (arrived && cost >= arrived.cost) break;
    done.add(at);
    const link = byId.get(at)!;
    const land = { x: link.land[0], y: link.land[1] };
    if (link.to === place.map) {
      const total = cost + finish(place.npc ? link.npcSteps?.[place.npc.id] : undefined, link.steps ? undefined : land);
      if (!arrived || total < arrived.cost) arrived = { cost: total, via: at };
    }
    for (const e of exits.get(link.to) ?? []) {
      // Worked out from the map file where it could be; else guessed.
      // The stone is an NPC: its steps are with the NPCs'.
      const known = e.waypoint ? link.npcSteps?.[e.waypoint.stone] : link.steps?.[e.id];
      const steps = link.steps ? known : guess(land, e.exit);
      if (steps === undefined) continue;
      const next = cost + steps + (e.waypoint ? WAYPOINT_STEPS : HOP_STEPS);
      if (next < (best.get(e.id) ?? Infinity)) {
        best.set(e.id, next);
        cameFrom.set(e.id, at);
      }
    }
  }
  if (!arrived) return null;
  const links: TravelLink[] = [];
  for (let id = arrived.via; id !== null; id = cameFrom.get(id) ?? null) links.unshift(byId.get(id)!);
  return { links, steps: arrived.cost };
}

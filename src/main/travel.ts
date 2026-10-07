/**
 * Travel between maps: the links between maps and the NPCs, from
 * game-data/travel.json (scripts/travel-data.js), and the shortest chain of
 * links from where the player is to a map or an NPC.
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
}

export interface TravelNpc {
  id: number;
  name: string;
  map: number;
  /** The shop or spot it's in. */
  where: string;
  /** Where it stands; missing for NPCs that wander a big area (head for their map). */
  at?: [number, number];
}

export interface TravelData {
  maps: TravelMap[];
  links: TravelLink[];
  npcs: TravelNpc[];
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
/** On maps whose walls weren't read, steps are guessed from the straight distance, times this. */
const DETOUR = 1.4;

let cached: TravelData | null = null;

/** game-data/travel.json (built by scripts/travel-data.js). */
export function loadTravelData(file = path.join(__dirname, '..', '..', 'game-data', 'travel.json')): TravelData {
  cached ??= JSON.parse(readFileSync(file, 'utf8')) as TravelData;
  return cached;
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
  return places(data).find((p) => p.id === id);
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
    const cost = steps + HOP_STEPS;
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
      const steps = link.steps ? link.steps[e.id] : guess(land, e.exit);
      if (steps === undefined) continue;
      const next = cost + steps + HOP_STEPS;
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

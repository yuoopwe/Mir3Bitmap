/**
 * Quests: what to do next. Hands in what's finished, picks up the quests worth
 * the most experience for the time they take, then works on the ones on the
 * go: spots to reach, NPCs to talk to, monsters to hunt. Whatever map it's on,
 * it does everything useful there before going anywhere else, and between
 * maps it prefers the ones with more to do. Pure: no game, no screen; every
 * choice is the same for the same state.
 */
import { GRIND, damagePerSecond, levelAllows } from './grind';
import { classFlagOf, findPlace, mapName, planRoute, spawnShare, waypointLinks, type TravelData, type TravelQuest, type Traveller } from './travel';

/** Every number the quest planner is tuned by. */
export const QUESTS = {
  /** Kill and collect tasks for monsters more than this many levels above the character are left alone (so are their quests). */
  maxLevelsAbove: 5,
  /** Each level a quest monster is above the character makes it this much slower to kill (share of the time). */
  slowerPerLevelAbove: 0.15,
  /** A "collect" task: kills per item wanted (drop rates aren't in the data). */
  killsPerItem: 3,
  /** Hunting a quest monster with no count to go on: plan for this many kills. */
  huntKills: 10,
  /** Seconds a "talk to" or "go to" takes once there (clicking, the dialogue, finding the spot). */
  taskSeconds: 20,
  /** Steps walked (or run) per minute, for turning route costs into time. */
  stepsPerMinute: GRIND.tilesPerSecond * 60,
  /** Valuing a quest's trips: each change of map (a link or a waypoint) counts as this many steps. */
  stepsPerHop: 150,
  /**
   * Givers whose best quest brings less than this share of the best quest's experience per minute aren't visited.
   * A giver visited hands over all its quests (Accept All), so all of them are counted.
   */
  pickUpMinShare: 0.2,
  /** A finished quest's taker within this many steps is "close": handed in before new quests are picked up. */
  nearSteps: 400,
  /** Choosing where to go: each other useful thing on a map counts as this many steps saved (a trip done once). */
  bundleSteps: 150,
  /** Quest types left out unless asked for. */
  dailyTypes: ['Daily'],
  accountTypes: ['Account'],
  /** The task types the bot can do. */
  doableTasks: ['KillMonster', 'GainItem', 'Region', 'TalkToNPC'],
};

/** What the game's memory says (MemoryState), and where the character is. */
export interface QuestState {
  map: number;
  /** Their tile, for telling which thing on this map is nearest. */
  at?: { x: number; y: number };
  level: number;
  cls?: number;
  /** The quest log: each quest by its internal name, handed in (completed) or not, and whether every task is done (ready). */
  log: readonly { name: string; completed: boolean; ready: boolean }[];
  /** Monsters unfinished kill tasks still need (map: only there). */
  targets: readonly { name: string; map: number | null; quest: string }[];
  /** Unfinished go-to (region) and talk-to (NPC) tasks. */
  pending?: { regions: readonly { quest: string; region: number; map: number | null }[]; talks: readonly { quest: string; npc: number }[] } | null;
  /** The waypoints unlocked, by name (unknown: every one counts). */
  waypoints?: ReadonlySet<string>;
  /**
   * What didn't work this run: "hand:<quest key>", "accept:<npc id>",
   * "region:<region id>", "talk:<npc id>", "hunt:<monster>:<map or null>".
   */
  failed: ReadonlySet<string>;
}

export interface QuestOptions {
  /** Pick up more while fewer than this are on the go. */
  maxActive: number;
  /** Daily and account quests too. */
  dailies?: boolean;
  account?: boolean;
}

export type QuestAction = { reason: string } & (
  /** `keys`: the quests' internal names, as the quest log has them. */
  | { kind: 'handIn'; npc: number; map: number; quests: string[]; keys: string[] }
  | { kind: 'pickUp'; npc: number; map: number; quests: string[] }
  | { kind: 'go'; region: number; map: number; at: [number, number]; quest: string }
  | { kind: 'talk'; npc: number; map: number; quest: string }
  /** `target` is the quest target's own map (null: anywhere), for the failed key. */
  | { kind: 'hunt'; monster: string; map: number; target: number | null; quest: string }
  | { kind: 'none' }
);

/** A quest's internal name, as the quest log has it. */
export const questKey = (q: TravelQuest) => q.key ?? q.name;

// ---- Route costs ----

/** What decides a traveller's routes, as a cache key. */
const travellerKey = (who: Traveller) => `${who.level}:${who.cls}:${who.waypoints ? [...who.waypoints].sort().join(',') : '*'}`;

/**
 * Route costs between maps for one character, worked out once each:
 * `steps` by planRoute (exact, about 85 ms the first time), `estimate` by the
 * fewest changes of map (a breadth-first search per starting map, quick).
 * Keyed by level, class and the waypoints unlocked too, as those decide which ways are open.
 */
export class RouteCosts {
  private readonly exact = new Map<string, number>();
  private readonly hops = new Map<string, Map<number, number>>();

  constructor(private readonly data: TravelData) {}

  /** Steps from one map to another along the quickest route; Infinity if there's none. */
  steps(from: number, to: number, who: Traveller): number {
    if (from === to) return 0;
    const key = `${travellerKey(who)}:${from}>${to}`;
    let steps = this.exact.get(key);
    if (steps === undefined) {
      const place = findPlace(this.data, `map:${to}`);
      steps = (place && planRoute(this.data, { map: from, steps: new Map() }, place, who)?.steps) ?? Infinity;
      this.exact.set(key, steps);
    }
    return steps;
  }

  /** A quick guess at the steps from one map to another (stepsPerHop for each change of map); Infinity if there's no way. */
  estimate(from: number, to: number, who: Traveller): number {
    if (from === to) return 0;
    // Never the exact costs worked out so far: answers mustn't depend on what was asked before.
    const key = `${travellerKey(who)}:${from}`;
    let reach = this.hops.get(key);
    if (!reach) {
      reach = this.hopsFrom(from, who);
      this.hops.set(key, reach);
    }
    const hops = reach.get(to);
    return hops === undefined ? Infinity : hops * QUESTS.stepsPerHop;
  }

  /** Changes of map from `from` to every map it leads to, by the links the character may use (as planRoute picks them). */
  private hopsFrom(from: number, who: Traveller): Map<number, number> {
    const data = this.data;
    const maps = new Map(data.maps.map((m) => [m.i, m]));
    const links = data.links.some((l) => l.waypoint) ? data.links : [...data.links, ...waypointLinks(data)];
    const out = new Map<number, number[]>();
    for (const l of links) {
      if (l.needs || (l.cls !== undefined && (who.cls === undefined || !(l.cls & classFlagOf(who.cls))))) continue;
      if (l.waypoint && !l.waypoint.always && who.waypoints && !who.waypoints.has(l.waypoint.name)) continue;
      const to = maps.get(l.to);
      if (who.level !== undefined && to && !levelAllows(to, who.level)) continue;
      (out.get(l.from) ?? out.set(l.from, []).get(l.from)!).push(l.to);
    }
    const reach = new Map([[from, 0]]);
    for (let frontier = [from], hops = 1; frontier.length; hops++) {
      const next: number[] = [];
      for (const map of frontier) {
        for (const to of out.get(map) ?? []) {
          if (reach.has(to)) continue;
          reach.set(to, hops);
          next.push(to);
        }
      }
      frontier = next;
    }
    return reach;
  }
}

// ---- Monsters ----

interface Spawn {
  map: number;
  /** How many of it to expect there, and the map's spawn spots (for its area). */
  n: number;
  spots: number;
}

interface MonsterInfo {
  level: number;
  health: number;
  spawns: Spawn[];
}

const monsterCache = new WeakMap<TravelData, Map<string, MonsterInfo>>();

/** Each monster (by lower-case name): its level and health, and where it spawns. */
function monsterInfo(data: TravelData): Map<string, MonsterInfo> {
  const cached = monsterCache.get(data);
  if (cached) return cached;
  const out = new Map<string, MonsterInfo>();
  (data.monsters ?? []).forEach((name, i) => {
    const [level, , health] = data.monsterStats?.[i] ?? [0, 0, 0];
    out.set(name.toLowerCase(), { level, health, spawns: [] });
  });
  for (const [map, spots] of Object.entries(data.spawns ?? {})) {
    const counts = new Map<number, number>();
    for (const [, , n, set] of spots) {
      const list = data.spawnSets?.[set] ?? [];
      list.forEach((i, k) => counts.set(i, (counts.get(i) ?? 0) + n * spawnShare(data, set, k)));
    }
    for (const [i, n] of counts) out.get(data.monsters![i].toLowerCase())?.spawns.push({ map: Number(map), n, spots: spots.length });
  }
  monsterCache.set(data, out);
  return out;
}

/** Seconds to find and kill one of these monsters there, hunting only them; null if they don't spawn there or are too strong. */
function killSeconds(data: TravelData, monster: MonsterInfo, map: number, level: number, cls: number | undefined): number | null {
  const spawn = monster.spawns.find((s) => s.map === map);
  const above = monster.level - level;
  if (!spawn || above > QUESTS.maxLevelsAbove) return null;
  const seek = (GRIND.seekShare * Math.sqrt((spawn.spots * GRIND.spawnCellTiles ** 2) / spawn.n)) / GRIND.tilesPerSecond;
  const fight = (monster.health / damagePerSecond(data, level, cls)) * (1 + QUESTS.slowerPerLevelAbove * Math.max(0, above));
  return fight + GRIND.killOverheadSeconds + seek;
}

/**
 * Where to hunt a monster: on `map` if the quest says (when the level allows
 * it), else the spawn map with the least time for `kills` of them counting the
 * trip from `from` (estimated). Null if nowhere will do.
 */
function huntMap(
  data: TravelData,
  routes: RouteCosts,
  name: string,
  map: number | null | undefined,
  kills: number,
  from: number,
  who: Traveller & { level: number },
): { map: number; minutes: number; killMinutes: number } | null {
  const monster = monsterInfo(data).get(name.toLowerCase());
  if (!monster) return null;
  let best: { map: number; minutes: number; killMinutes: number } | null = null;
  const maps = map !== null && map !== undefined ? [map] : monster.spawns.map((s) => s.map).sort((a, b) => a - b);
  for (const m of maps) {
    const info = data.maps.find((x) => x.i === m);
    if (!info || !levelAllows(info, who.level)) continue;
    const seconds = killSeconds(data, monster, m, who.level, who.cls);
    if (seconds === null) continue;
    const killMinutes = (kills * seconds) / 60;
    const minutes = routes.estimate(from, m, who) / QUESTS.stepsPerMinute + killMinutes;
    if (Number.isFinite(minutes) && (!best || minutes < best.minutes)) best = { map: m, minutes, killMinutes };
  }
  return best;
}

// ---- Which quests ----

/** Quests the character could pick up now, with the minutes each should take from its giver and its experience per minute. */
export function availableQuests(data: TravelData, state: QuestState, options: QuestOptions, routes: RouteCosts): { quest: TravelQuest; minutes: number; rate: number }[] {
  const quests = data.quests ?? [];
  const byId = new Map(quests.map((q) => [q.id, q]));
  const inLog = new Set(state.log.map((q) => q.name));
  const done = new Set(state.log.filter((q) => q.completed).map((q) => q.name));
  const out: { quest: TravelQuest; minutes: number; rate: number }[] = [];
  for (const quest of quests) {
    if (inLog.has(questKey(quest)) || state.failed.has(`accept:${quest.start}`)) continue;
    if (!questAllowed(quest, state, options)) continue;
    if (!(quest.after ?? []).every((id) => { const before = byId.get(id); return !before || done.has(questKey(before)); })) continue;
    const minutes = questMinutes(data, quest, state, routes);
    if (minutes === null) continue;
    out.push({ quest, minutes, rate: (quest.exp ?? 0) / minutes });
  }
  return out;
}

/** The quest's type, level and class allow it, and the bot can do all its tasks. */
function questAllowed(quest: TravelQuest, state: QuestState, options: QuestOptions): boolean {
  if (QUESTS.dailyTypes.includes(quest.type) && !options.dailies) return false;
  if (QUESTS.accountTypes.includes(quest.type) && !options.account) return false;
  if ((quest.level ?? 0) > state.level) return false;
  if (quest.cls !== undefined && (state.cls === undefined || !(quest.cls & classFlagOf(state.cls)))) return false;
  return quest.tasks.length > 0 && quest.tasks.every((t) => QUESTS.doableTasks.includes(t.type));
}

/**
 * The minutes a quest should take from its giver: the trips (giver, each
 * task's map in turn, the taker; estimated), the kills, and the talking.
 * Null if a task can't be done: a map the level can't enter or reach, a
 * monster too strong or not in the spawn data, an NPC or spot unknown.
 */
function questMinutes(data: TravelData, quest: TravelQuest, state: QuestState, routes: RouteCosts): number | null {
  const who = { level: state.level, cls: state.cls, waypoints: state.waypoints };
  const npcMap = (id: number) => data.npcs.find((n) => n.id === id)?.map;
  const giver = npcMap(quest.start);
  const taker = npcMap(quest.finish);
  if (giver === undefined || taker === undefined) return null;
  let at = giver;
  let steps = 0;
  let seconds = 0;
  const visit = (map: number) => {
    steps += routes.estimate(at, map, who);
    at = map;
  };
  for (const task of quest.tasks) {
    if (task.type === 'KillMonster' || task.type === 'GainItem') {
      const kills = task.amount * (task.type === 'GainItem' ? QUESTS.killsPerItem : 1);
      // Any of the monsters listed will do: the quickest.
      let best: ReturnType<typeof huntMap> = null;
      for (const [name, map] of task.monsters ?? []) {
        const where = huntMap(data, routes, name, map, kills, at, who);
        if (where && (!best || where.minutes < best.minutes)) best = where;
      }
      if (!best) return null;
      visit(best.map);
      seconds += best.killMinutes * 60;
    } else if (task.type === 'Region') {
      const map = task.region?.map ?? data.questRegions?.[task.region?.id ?? -1]?.[0];
      if (map === undefined) return null;
      visit(map);
      seconds += QUESTS.taskSeconds;
    } else if (task.type === 'TalkToNPC') {
      const map = task.npc !== undefined ? npcMap(task.npc) : undefined;
      if (map === undefined) return null;
      visit(map);
      seconds += QUESTS.taskSeconds;
    }
  }
  visit(taker);
  if (!Number.isFinite(steps)) return null;
  return steps / QUESTS.stepsPerMinute + (seconds + QUESTS.taskSeconds) / 60;
}

// ---- What next ----

const plural = (names: string[]) => (names.length > 2 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(' and '));

/**
 * The next thing to do, in this order:
 * 1. anything on this map: hand-ins, pick-ups (with room for more), people to
 *    talk to and spots to reach, nearest first;
 * 2. hand in finished quests whose taker is close;
 * 3. pick up more (with room): the giver whose quests bring the most
 *    experience per minute, counting the trip there;
 * 4. hand in the rest;
 * 5. people to talk to and spots to reach;
 * 6. monsters to hunt.
 * Between maps, a map with more to do there is preferred (bundleSteps).
 */
export function nextQuestAction(data: TravelData, state: QuestState, options: QuestOptions, routes: RouteCosts = new RouteCosts(data)): QuestAction {
  const who = { level: state.level, cls: state.cls, waypoints: state.waypoints };
  const quests = data.quests ?? [];
  const byKey = new Map(quests.map((q) => [questKey(q), q]));
  const npcs = new Map(data.npcs.map((n) => [n.id, n]));
  const npcName = (id: number) => npcs.get(id)?.name ?? `NPC ${id}`;
  const here = state.map;
  const enterable = (map: number) => {
    const info = data.maps.find((m) => m.i === map);
    return !!info && levelAllows(info, state.level);
  };

  // Hand-ins: the finished quests the data knows, by taker.
  const handIns = new Map<number, TravelQuest[]>();
  for (const entry of state.log) {
    const quest = byKey.get(entry.name);
    if (!entry.ready || entry.completed || !quest || state.failed.has(`hand:${entry.name}`) || !npcs.has(quest.finish)) continue;
    (handIns.get(quest.finish) ?? handIns.set(quest.finish, []).get(quest.finish)!).push(quest);
  }
  // Pick-ups, with room for more: each giver's quests, best value first.
  const active = state.log.filter((q) => !q.completed && !q.ready).length;
  const pickUps = new Map<number, { quests: string[]; exp: number; minutes: number }>();
  if (active < options.maxActive) {
    const available = availableQuests(data, state, options, routes).sort((a, b) => b.rate - a.rate || a.quest.id - b.quest.id);
    const worth = (available[0]?.rate ?? 0) * QUESTS.pickUpMinShare;
    const worthVisiting = new Set(available.filter((a) => a.rate >= worth).map((a) => a.quest.start));
    for (const { quest, minutes } of available) {
      if (!npcs.has(quest.start) || !worthVisiting.has(quest.start)) continue;
      const giver = pickUps.get(quest.start) ?? pickUps.set(quest.start, { quests: [], exp: 0, minutes: 0 }).get(quest.start)!;
      giver.quests.push(quest.name);
      giver.exp += quest.exp ?? 0;
      giver.minutes += minutes;
    }
  }
  // Places to go and people to talk to.
  const spots = (state.pending?.regions ?? [])
    .filter((r) => !state.failed.has(`region:${r.region}`) && data.questRegions?.[r.region])
    .map((r) => {
      const [map, x, y] = data.questRegions![r.region];
      return { ...r, map, at: [x, y] as [number, number] };
    })
    .filter((r) => enterable(r.map));
  const talks = (state.pending?.talks ?? []).filter((t) => !state.failed.has(`talk:${t.npc}`) && npcs.has(t.npc) && enterable(npcs.get(t.npc)!.map));

  const handIn = (npc: number, why: string): QuestAction => {
    const names = handIns.get(npc)!.map((q) => q.name);
    return { kind: 'handIn', npc, map: npcs.get(npc)!.map, quests: names, keys: handIns.get(npc)!.map(questKey), reason: `Handing in ${plural(names)} to ${npcName(npc)} (${why})` };
  };
  const pickUp = (npc: number, why: string): QuestAction => {
    const { quests: names } = pickUps.get(npc)!;
    return { kind: 'pickUp', npc, map: npcs.get(npc)!.map, quests: names, reason: `Picking up ${plural(names)} from ${npcName(npc)} (${why})` };
  };
  const talk = (t: (typeof talks)[number], why: string): QuestAction => ({
    kind: 'talk', npc: t.npc, map: npcs.get(t.npc)!.map, quest: t.quest, reason: `${t.quest}: talking to ${npcName(t.npc)} (${why})`,
  });
  const go = (r: (typeof spots)[number], why: string): QuestAction => ({
    kind: 'go', region: r.region, map: r.map, at: r.at, quest: r.quest, reason: `${r.quest}: going to a spot on ${mapName(data, r.map)} (${why})`,
  });

  // How useful a map is: everything there to hand in, pick up, talk about or reach.
  const usefulOn = (map: number) =>
    [...handIns.keys()].filter((n) => npcs.get(n)!.map === map).length +
    [...pickUps.keys()].filter((n) => npcs.get(n)!.map === map).length +
    talks.filter((t) => npcs.get(t.npc)!.map === map).length +
    spots.filter((r) => r.map === map).length;
  /** Steps there, less bundleSteps for each other useful thing on the map. */
  const cost = (map: number) => routes.steps(here, map, who) - QUESTS.bundleSteps * Math.max(0, usefulOn(map) - 1);
  const away = (at: [number, number] | undefined) => (at && state.at ? Math.max(Math.abs(at[0] - state.at.x), Math.abs(at[1] - state.at.y)) : 0);
  /** The cheapest of `items` by the cost of their map (then the order given, for ties). */
  const cheapest = <T>(items: T[], mapOf: (item: T) => number): T | undefined => {
    let best: { item: T; cost: number } | undefined;
    for (const item of items) {
      const c = cost(mapOf(item));
      if (Number.isFinite(c) && (!best || c < best.cost)) best = { item, cost: c };
    }
    return best?.item;
  };

  // 1. Everything on this map first: hand-ins, then pick-ups, then talking and spots, nearest first.
  type Local = { order: number; at?: [number, number]; action: () => QuestAction };
  const local: Local[] = [
    ...[...handIns.keys()].filter((n) => npcs.get(n)!.map === here).map((n) => ({ order: 0, at: npcs.get(n)!.at, action: () => handIn(n, 'on this map') })),
    ...[...pickUps.keys()].filter((n) => npcs.get(n)!.map === here).map((n) => ({ order: 1, at: npcs.get(n)!.at, action: () => pickUp(n, 'on this map') })),
    ...talks.filter((t) => npcs.get(t.npc)!.map === here).map((t) => ({ order: 2, at: npcs.get(t.npc)!.at, action: () => talk(t, 'on this map') })),
    ...spots.filter((r) => r.map === here).map((r) => ({ order: 2, at: r.at, action: () => go(r, 'on this map') })),
  ];
  local.sort((a, b) => a.order - b.order || away(a.at) - away(b.at));
  if (local.length) return local[0].action();

  // 2. Finished quests whose taker is close.
  const takers = [...handIns.keys()].sort((a, b) => a - b);
  const closeTaker = cheapest(takers.filter((n) => routes.steps(here, npcs.get(n)!.map, who) <= QUESTS.nearSteps), (n) => npcs.get(n)!.map);
  if (closeTaker !== undefined) return handIn(closeTaker, 'close by');

  // 3. More quests: the giver bringing the most experience per minute, the trip there counted.
  let bestGiver: { npc: number; rate: number } | undefined;
  for (const [npc, offer] of [...pickUps].sort((a, b) => a[0] - b[0])) {
    const steps = cost(npcs.get(npc)!.map);
    if (!Number.isFinite(steps)) continue;
    const rate = offer.exp / (Math.max(0, steps) / QUESTS.stepsPerMinute + offer.minutes);
    if (!bestGiver || rate > bestGiver.rate) bestGiver = { npc, rate };
  }
  if (bestGiver) return pickUp(bestGiver.npc, `~${Math.round(bestGiver.rate).toLocaleString('en')} exp/min`);

  // 4. The other finished quests; even with no route known (Travel may still find one; if not, it's marked failed),
  // or Quests' hunting would keep stopping for them.
  const farTaker = cheapest(takers, (n) => npcs.get(n)!.map) ?? takers[0];
  if (farTaker !== undefined) return handIn(farTaker, 'finished');

  // 5. People to talk to and spots to reach: the map with most to do for the trip.
  const errand = cheapest<{ map: number; action: () => QuestAction }>(
    [...talks.map((t) => ({ map: npcs.get(t.npc)!.map, action: () => talk(t, 'next task') })), ...spots.map((r) => ({ map: r.map, action: () => go(r, 'next task') }))],
    (e) => e.map,
  );
  if (errand) return errand.action();

  // 6. Monsters: the target (and map) taking the least time, trip included; more targets on one map count as one trip.
  let hunt: { target: QuestState['targets'][number]; map: number; minutes: number } | undefined;
  for (const target of state.targets) {
    if (state.failed.has(`hunt:${target.name}:${target.map}`)) continue;
    const where = huntMap(data, routes, target.name, target.map, QUESTS.huntKills, here, who);
    if (!where) continue;
    const others = state.targets.filter((t) => t !== target && (t.map === null || t.map === where.map) && monsterInfo(data).get(t.name.toLowerCase())?.spawns.some((s) => s.map === where.map)).length;
    const minutes = where.minutes - (others * QUESTS.bundleSteps) / QUESTS.stepsPerMinute;
    if (!hunt || minutes < hunt.minutes) hunt = { target, map: where.map, minutes };
  }
  if (hunt) {
    const { target, map } = hunt;
    return { kind: 'hunt', monster: target.name, map, target: target.map, quest: target.quest, reason: `${target.quest}: hunting ${target.name} on ${mapName(data, map)}` };
  }
  return { kind: 'none', reason: 'Nothing more to do for now' };
}

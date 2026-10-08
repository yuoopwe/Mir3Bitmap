/**
 * Boss circuit: which sub-bosses and bosses to go for, and in what order. The
 * daily quests it takes (the Seasonal Supply Hunts, the Elite Bounties) want a
 * few kills each of monsters that respawn on a timer at fixed spawns
 * (game-data/travel.json's bossSpawns). This works out what's still needed
 * from the quest log, and orders the spawns into a circuit: the nearest next
 * (by the route there, Return to Arcadia counted as a shortcut), waiting for
 * any not back yet. Pure: no game, no screen.
 */
import { GRIND, levelAllows } from './grind';
import { questKey, type RouteCosts } from './quest-planner';
import { mapName, spawnShare, type TravelData, type TravelQuest, type Traveller } from './travel';

/** Every number the circuit is tuned by. */
export const CIRCUIT = {
  /** The quests the circuit can take (ids): the daily Seasonal Supply Hunts (Grade E to B) and the first Elite Bounties. */
  quests: [1840, 1841, 1842, 1843, 66, 67],
  /** At a spawn, none of its monsters about for this long: cleared (or empty) for now. */
  emptySeconds: 60,
  /** Nothing happening (kills, quest progress) this long at a spawn: plan again. */
  watchdogMinutes: 5,
  /** Return to Arcadia costs about this many steps (the cast, the loading); from there, the routes out of Arcadia. */
  returnSteps: 30,
  /** Arcadia Castle, where Return to Arcadia goes. */
  arcadia: 563,
  /** Behemoths (kind 3) take so long to come back that, unless a quest wants one, they're only fought when met. */
  farmKinds: [1, 2],
  /** Maps never gone to (players fight each other there), and the harder copies of maps (only when there's no plain one). */
  excludedMaps: /\(PvP\)/i,
  warpedMaps: /^Warped /i,
};

/** A spawn of a sub-boss, boss or behemoth: where, how many, and the minutes they take to come back once killed. */
export interface BossSpawn {
  /** "Zuma Keeper@37:142,144", for the cleared times. */
  key: string;
  monster: string;
  level: number;
  health: number;
  map: number;
  mapName: string;
  x: number;
  y: number;
  count: number;
  respawnMinutes: number;
  /** 1 sub-boss, 2 boss, 3 behemoth. */
  kind: number;
}

/**
 * The spawns of these monsters (lower-case names; every boss spawn without),
 * leaving out PvP maps, and Warped copies where the same monster spawns on a
 * plain map too.
 */
export function bossSpawns(data: TravelData, names?: ReadonlySet<string>): BossSpawn[] {
  const out: BossSpawn[] = [];
  for (const [monster, map, x, y, count, respawn, kind] of data.bossSpawns ?? []) {
    const name = data.monsters?.[monster] ?? '';
    if (names && !names.has(name.toLowerCase())) continue;
    const where = mapName(data, map);
    if (CIRCUIT.excludedMaps.test(where)) continue;
    const [level, , health] = data.monsterStats?.[monster] ?? [0, 0, 0];
    out.push({ key: `${name}@${map}:${x},${y}`, monster: name, level, health, map, mapName: where, x, y, count, respawnMinutes: respawn, kind });
  }
  const plain = new Set(out.filter((s) => !CIRCUIT.warpedMaps.test(s.mapName)).map((s) => s.monster));
  return out.filter((s) => !CIRCUIT.warpedMaps.test(s.mapName) || !plain.has(s.monster));
}

/** A quest's kill task: the monster, how many it wants, and how many are done (all of them once the task's finished). */
export interface CircuitTask {
  monster: string;
  need: number;
  done: number;
}

/** What the quest log says of a quest: not taken, on the go, finished (ready to hand in) or handed in (today's done). */
export type QuestStatus = 'none' | 'active' | 'ready' | 'completed';

export function questStatus(quest: TravelQuest, log: readonly { name: string; completed: boolean; ready: boolean }[]): QuestStatus {
  const entry = log.find((q) => q.name === questKey(quest));
  return !entry ? 'none' : entry.completed ? 'completed' : entry.ready ? 'ready' : 'active';
}

/**
 * The quest's kill tasks and how far each has got: an unfinished one is among
 * the quest targets (MemoryState.questTargets, with its count when the reader
 * gives it); one that isn't is done.
 */
export function questTasks(quest: TravelQuest, targets: readonly { name: string; quest: string; done?: number; need?: number }[]): CircuitTask[] {
  const out: CircuitTask[] = [];
  for (const task of quest.tasks) {
    if (task.type !== 'KillMonster' && task.type !== 'GainItem') continue;
    for (const [monster] of task.monsters ?? []) {
      const target = targets.find((t) => t.name.toLowerCase() === monster.toLowerCase() && (t.quest === quest.name || t.quest === questKey(quest)));
      const need = target?.need ?? task.amount;
      out.push({ monster, need, done: target ? Math.min(target.done ?? 0, need) : need });
    }
  }
  return out;
}

/** The character, for routes and how strong a monster they take on. */
export type CircuitWho = Traveller & { map: number; level: number; maxLevelsAbove: number };

export interface CircuitStop {
  spawn: BossSpawn;
  /** Steps there from the stop before (or from the character); by Return to Arcadia when that's the quicker way. */
  steps: number;
  viaArcadia: boolean;
  /** When it's expected back (ms, on the planner's clock): `now` if it's not been cleared, or is back already. */
  readyAt: number;
}

export interface CircuitPlan {
  stops: CircuitStop[];
  /** Spawns left out, and why: too strong, too hard this run, no way there. */
  skipped: { spawn: BossSpawn; why: string }[];
}

/**
 * The circuit: spawns in the order to visit them, from `who.map` at `now`.
 * Each next is the one reached soonest, counting the trip (planRoute's steps,
 * or Return to Arcadia and on from there) and any wait for it to come back
 * (`clearedAt` plus its respawn). Monsters with `need` counts stop being
 * planned once the spawns ordered for them hold that many (none given: every
 * spawn is visited). Monsters more than `who.maxLevelsAbove` above the
 * character, spawns too hard this run, and spawns with no way there are left out.
 */
export function planCircuit(
  data: TravelData,
  spawns: readonly BossSpawn[],
  who: CircuitWho,
  options: { now: number; routes: RouteCosts; clearedAt?: ReadonlyMap<string, number>; tooHard?: ReadonlySet<string>; need?: ReadonlyMap<string, number> },
): CircuitPlan {
  const skipped: CircuitPlan['skipped'] = [];
  const maps = new Map(data.maps.map((m) => [m.i, m]));
  const left: BossSpawn[] = [];
  for (const spawn of spawns) {
    const map = maps.get(spawn.map);
    if (spawn.level > who.level + who.maxLevelsAbove) skipped.push({ spawn, why: `level ${spawn.level}: too strong for level ${who.level} yet` });
    else if (options.tooHard?.has(spawn.key)) skipped.push({ spawn, why: 'too hard this run' });
    else if (map && !levelAllows(map, who.level)) skipped.push({ spawn, why: `${map.name} needs level ${map.level}` });
    else left.push(spawn);
  }
  const need = new Map(options.need);
  const steps = (from: number, to: number) => {
    const direct = options.routes.steps(from, to, who);
    const viaArcadia = from === CIRCUIT.arcadia ? Infinity : CIRCUIT.returnSteps + options.routes.steps(CIRCUIT.arcadia, to, who);
    return viaArcadia < direct ? { steps: viaArcadia, viaArcadia: true } : { steps: direct, viaArcadia: false };
  };
  const stops: CircuitStop[] = [];
  let at = who.map;
  let time = options.now;
  const msPerStep = 1000 / GRIND.tilesPerSecond;
  while (left.length) {
    let best: { i: number; arrive: number; start: number; way: { steps: number; viaArcadia: boolean } } | null = null;
    left.forEach((spawn, i) => {
      if (options.need && !(need.get(spawn.monster.toLowerCase())! > 0)) return;
      const way = steps(at, spawn.map);
      if (way.steps === Infinity) return;
      const arrive = time + way.steps * msPerStep;
      const readyAt = (options.clearedAt?.get(spawn.key) ?? -Infinity) + spawn.respawnMinutes * 60_000;
      const start = Math.max(arrive, readyAt);
      // Soonest started; equal, the nearer.
      if (!best || start < best.start || (start === best.start && way.steps < best.way.steps)) best = { i, arrive, start, way };
    });
    if (!best) break;
    const { i, start, way } = best as { i: number; start: number; way: { steps: number; viaArcadia: boolean } };
    const spawn = left.splice(i, 1)[0];
    const readyAt = Math.max(options.now, (options.clearedAt?.get(spawn.key) ?? -Infinity) + spawn.respawnMinutes * 60_000);
    stops.push({ spawn, steps: way.steps, viaArcadia: way.viaArcadia, readyAt });
    if (options.need) need.set(spawn.monster.toLowerCase(), (need.get(spawn.monster.toLowerCase()) ?? 0) - spawn.count);
    at = spawn.map;
    time = start;
  }
  for (const spawn of left) {
    if (options.need && !(need.get(spawn.monster.toLowerCase())! > 0)) continue;
    skipped.push({ spawn, why: 'no way there' });
  }
  return { stops, skipped };
}

/** A boss that comes only when summoned: kills of `killers` (lower-case names: `every` of them, counted for every player) bring it. */
export interface Summon {
  boss: string;
  every: number;
  killers: string[];
  /** Maps where those monsters spawn, the most first, as [map, how many]. */
  maps: [number, number][];
}

/** How the first of these bosses (lower-case names) that's summoned by kills comes, or null if none is. */
export function summonFor(data: TravelData, names: readonly string[]): Summon | null {
  for (const name of names) {
    const event = (data.bossEvents ?? []).find(([boss]) => (data.monsters?.[boss] ?? '').toLowerCase() === name);
    if (!event) continue;
    const [boss, every, killers] = event;
    const counts = new Map<number, number>();
    for (const [map, spots] of Object.entries(data.spawns ?? {})) {
      for (const [, , n, set] of spots) {
        const list = data.spawnSets?.[set] ?? [];
        const share = list.reduce((sum, i, k) => sum + (killers.includes(i) ? spawnShare(data, set, k) : 0), 0);
        if (share) counts.set(Number(map), (counts.get(Number(map)) ?? 0) + n * share);
      }
    }
    const maps = [...counts].filter(([map]) => !CIRCUIT.excludedMaps.test(mapName(data, map))).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    return { boss: data.monsters![boss], every, killers: killers.map((i) => data.monsters?.[i] ?? '').filter(Boolean), maps };
  }
  return null;
}

/** "Zuma Keeper at Zuma Temple Lv 5 (back in 6 min)". */
export function describeStop(stop: CircuitStop, now: number): string {
  const wait = Math.ceil((stop.readyAt - now) / 60_000);
  return `${stop.spawn.monster} at ${stop.spawn.mapName}${wait > 0 ? ` (back in ${wait} min)` : ''}`;
}

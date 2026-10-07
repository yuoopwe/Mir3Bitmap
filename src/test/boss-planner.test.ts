import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { CIRCUIT, bossSpawns, describeStop, planCircuit, questStatus, questTasks } from '../main/boss-planner';
import { RouteCosts } from '../main/quest-planner';
import { loadTravelData, type TravelData, type TravelQuest } from '../main/travel';

const data = loadTravelData(path.join(__dirname, '..', '..', 'game-data', 'travel.json'));

// ---- A small world: Home, Near (a hop away), Far (past Near, or a hop from Arcadia), a Warped copy, a PvP arena, High (level 60) ----

const ARCADIA = CIRCUIT.arcadia, HOME = 1, NEAR = 2, FAR = 3, WARPED = 4, ARENA = 5, HIGH = 6;
/** A link from one map to another, landing at 5,5 (with `steps` from there to the next map's exits; none, guessed from the distance). */
const link = (id: number, from: number, to: number, steps?: Record<string, number>) => ({ id, from, to, exit: [[5, 5]] as [number, number][], land: [5, 5] as [number, number], steps });
const KEEPER = 0, GUARDIAN = 1, WARLORD = 2, BRUTE = 3;

function world(spawns: TravelData['bossSpawns']): TravelData {
  return {
    maps: [
      { i: ARCADIA, name: 'Arcadia Castle' }, { i: HOME, name: 'Home' }, { i: NEAR, name: 'Near' }, { i: FAR, name: 'Far' },
      { i: WARPED, name: 'Warped Near' }, { i: ARENA, name: 'Arena (PvP)' }, { i: HIGH, name: 'High', level: 60 },
    ],
    links: [
      // Home to Near; on from Near to Far is a long walk (400 steps after landing); Arcadia has a quick way to Far.
      link(1, HOME, NEAR, { 3: 400 }), link(3, NEAR, FAR), link(4, ARCADIA, FAR), link(5, HOME, WARPED), link(6, HOME, ARENA), link(7, HOME, HIGH), link(8, FAR, HOME),
    ],
    npcs: [],
    monsters: ['Keeper', 'Guardian', 'Warlord', 'Brute'],
    monsterStats: [[30, 1000, 3400, 1], [44, 2000, 21500, 1], [40, 1500, 6300, 1], [70, 9000, 90000, 1]],
    bossSpawns: spawns,
  };
}

const ALL: TravelData['bossSpawns'] = [
  [KEEPER, NEAR, 10, 10, 4, 15, 1],
  [KEEPER, WARPED, 10, 10, 4, 15, 1],
  [GUARDIAN, FAR, 20, 20, 8, 15, 1],
  [WARLORD, ARENA, 30, 30, 4, 15, 1],
  [WARLORD, WARPED, 40, 40, 4, 15, 1],
  [BRUTE, HIGH, 50, 50, 1, 60, 2],
];
const who = { map: HOME, level: 45, maxLevelsAbove: 5 };
const NOW = 1_000_000;

test('spawns: never on a PvP map; Warped copies only when there is no plain one', () => {
  const w = world(ALL);
  const spawns = bossSpawns(w);
  assert.deepEqual(spawns.map((s) => s.key), ['Keeper@2:10,10', 'Guardian@3:20,20', 'Warlord@4:40,40', 'Brute@6:50,50']);
  assert.deepEqual(bossSpawns(w, new Set(['guardian'])).map((s) => [s.monster, s.mapName, s.count, s.respawnMinutes, s.level, s.health]), [['Guardian', 'Far', 8, 15, 44, 21500]]);
});

test('order: the nearest next, with Return to Arcadia as a shortcut', () => {
  const w = world(ALL);
  const routes = new RouteCosts(w);
  const plan = planCircuit(w, bossSpawns(w), who, { now: NOW, routes });
  // Near and the Warped map are a hop away (Near first by its place in the list); Far a hop on from Near; back by Home.
  assert.deepEqual(plan.stops.map((s) => [s.spawn.mapName, s.steps, s.viaArcadia]), [['Near', 110, false], ['Far', 110, false], ['Warped Near', 120, false]]);
  // From Home, Far is 520 steps walking through Near, 140 by Return to Arcadia.
  const far = planCircuit(w, bossSpawns(w, new Set(['guardian'])), who, { now: NOW, routes }).stops[0];
  assert.deepEqual([far.steps, far.viaArcadia], [CIRCUIT.returnSteps + 110, true]);
});

test('respawns: a spawn just cleared waits its time, so the others come first; then it says when it is back', () => {
  const w = world(ALL);
  const routes = new RouteCosts(w);
  const cleared = new Map([['Keeper@2:10,10', NOW - 5 * 60_000]]);
  const plan = planCircuit(w, bossSpawns(w, new Set(['keeper', 'guardian'])), who, { now: NOW, routes, clearedAt: cleared });
  assert.deepEqual(plan.stops.map((s) => s.spawn.monster), ['Guardian', 'Keeper']);
  assert.equal(plan.stops[1].readyAt, NOW + 10 * 60_000);
  assert.equal(describeStop(plan.stops[1], NOW), 'Keeper at Near (back in 10 min)');
  assert.equal(describeStop(plan.stops[0], NOW), 'Guardian at Far');
  // Cleared long enough ago: back already.
  const back = planCircuit(w, bossSpawns(w, new Set(['keeper'])), who, { now: NOW, routes, clearedAt: new Map([['Keeper@2:10,10', NOW - 20 * 60_000]]) });
  assert.equal(back.stops[0].readyAt, NOW);
});

test('skips: too strong for the level, too hard this run, a map the level may not enter, no way there; and enough planned for what is needed', () => {
  const w = world(ALL);
  const routes = new RouteCosts(w);
  const plan = planCircuit(w, bossSpawns(w), who, { now: NOW, routes, tooHard: new Set(['Guardian@3:20,20']) });
  assert.deepEqual(plan.skipped.map((s) => [s.spawn.monster, s.why]), [['Guardian', 'too hard this run'], ['Brute', 'level 70: too strong for level 45 yet']]);
  // Allowed further above (from the fights), Brute's map still needs level 60.
  assert.deepEqual(planCircuit(w, bossSpawns(w), { ...who, maxLevelsAbove: 30 }, { now: NOW, routes }).skipped.map((s) => s.why), ['High needs level 60']);
  // Cut off.
  const cut = { ...w, links: [] };
  assert.deepEqual(planCircuit(cut, bossSpawns(cut, new Set(['keeper'])), who, { now: NOW, routes: new RouteCosts(cut) }).skipped.map((s) => s.why), ['no way there']);
  // Three Keepers wanted: one spawn of four is enough; none wanted: not planned.
  const two = world([[KEEPER, NEAR, 10, 10, 2, 15, 1], [KEEPER, FAR, 11, 11, 2, 15, 1], [KEEPER, HOME, 12, 12, 4, 15, 1], [GUARDIAN, FAR, 20, 20, 8, 15, 1]]);
  const need = new Map([['keeper', 3], ['guardian', 0]]);
  const planned = planCircuit(two, bossSpawns(two), who, { now: NOW, routes: new RouteCosts(two), need });
  assert.deepEqual(planned.stops.map((s) => s.spawn.key), ['Keeper@1:12,12']);
  // Two at a spawn of two: another is planned for the third.
  const small = planCircuit(two, bossSpawns(two).filter((s) => s.map !== HOME), who, { now: NOW, routes: new RouteCosts(two), need });
  assert.deepEqual(small.stops.map((s) => s.spawn.key), ['Keeper@2:10,10', 'Keeper@3:11,11']);
});

test('tasks: counted from the quest targets; a task not among them is done', () => {
  const quest: TravelQuest = {
    id: 1, name: 'Supply Hunt', type: 'Daily', start: 237, finish: 237,
    tasks: [{ type: 'KillMonster', amount: 3, monsters: [['Keeper']] }, { type: 'KillMonster', amount: 3, monsters: [['Guardian']] }, { type: 'KillMonster', amount: 3, monsters: [['Warlord']] }],
  };
  const targets = [
    { name: 'Keeper', map: null, quest: 'Supply Hunt', done: 1, need: 3 },
    { name: 'Guardian', map: null, quest: 'Supply Hunt' },
    // Another quest's: not this one's.
    { name: 'Warlord', map: null, quest: 'Something Else', done: 0, need: 5 },
  ];
  assert.deepEqual(questTasks(quest, targets), [{ monster: 'Keeper', need: 3, done: 1 }, { monster: 'Guardian', need: 3, done: 0 }, { monster: 'Warlord', need: 3, done: 3 }]);
  const log = (completed: boolean, ready: boolean) => [{ name: 'Supply Hunt', completed, ready }];
  assert.deepEqual([questStatus(quest, []), questStatus(quest, log(false, false)), questStatus(quest, log(false, true)), questStatus(quest, log(true, true))], ['none', 'active', 'ready', 'completed']);
});

test('the real Supply Hunt (Grade E): its ten sub-bosses, none on PvP or Warped maps, all planned from Arcadia at level 50', () => {
  const quest = data.quests!.find((q) => q.id === 1840)!;
  const tasks = questTasks(quest, []);
  assert.equal(tasks.length, 10);
  const names = new Set(tasks.map((t) => t.monster.toLowerCase()));
  const spawns = bossSpawns(data, names);
  assert.ok(spawns.every((s) => !/\(PvP\)|^Warped /.test(s.mapName)));
  const plan = planCircuit(data, spawns, { map: CIRCUIT.arcadia, level: 50, maxLevelsAbove: 5 }, { now: NOW, routes: new RouteCosts(data), need: new Map([...names].map((n) => [n, 3])) });
  assert.deepEqual(new Set(plan.stops.map((s) => s.spawn.monster.toLowerCase())), names);
  assert.deepEqual(plan.skipped, []);
});

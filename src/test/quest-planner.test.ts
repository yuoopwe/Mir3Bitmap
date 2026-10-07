import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { levelAllows } from '../main/grind';
import { QUESTS, RouteCosts, availableQuests, nextQuestAction, questKey, type QuestAction, type QuestState } from '../main/quest-planner';
import { classFlagOf, loadTravelData, type TravelQuest } from '../main/travel';
import { QuestSim } from './quest-sim';

const data = loadTravelData(path.join(__dirname, '..', '..', 'game-data', 'travel.json'));
const routes = new RouteCosts(data);
const BICHON = 1;
const options = { maxActive: 5 };
const quests = data.quests!;
const byName = new Map(quests.map((q) => [q.name, q]));
const npcMap = (id: number) => data.npcs.find((n) => n.id === id)!.map;
const monsterLevel = (name: string) => data.monsterStats![data.monsters!.findIndex((m) => m.toLowerCase() === name.toLowerCase())][0];

/** Runs the planner on the simulator until there's nothing left (or `steps` actions), checking every pick-up and hunt. */
function play(start: { map: number; level: number; cls?: number; completed?: string[] }, steps = 40): QuestSim {
  const sim = new QuestSim(data, start);
  for (let i = 0; i < steps; i++) {
    const state = sim.state();
    const action = nextQuestAction(data, state, options, routes);
    if (action.kind === 'pickUp') {
      for (const name of action.quests) {
        const quest = byName.get(name)!;
        assert.ok((quest.level ?? 0) <= start.level, `${name} (level ${quest.level}) for level ${start.level}`);
        assert.ok(quest.cls === undefined || (start.cls !== undefined && quest.cls & classFlagOf(start.cls)), `${name} for class ${start.cls}`);
        for (const id of quest.after ?? []) {
          const before = quests.find((q) => q.id === id);
          assert.ok(!before || sim.completed.has(questKey(before)), `${name} after ${before?.name}`);
        }
        assert.ok(!QUESTS.dailyTypes.includes(quest.type) && !QUESTS.accountTypes.includes(quest.type));
      }
    }
    if (action.kind === 'hunt') {
      assert.ok(monsterLevel(action.monster) <= start.level + QUESTS.maxLevelsAbove, `${action.monster} for level ${start.level}`);
      assert.ok(levelAllows(data.maps.find((m) => m.i === action.map)!, start.level));
    }
    sim.apply(action);
    if (action.kind === 'none') break;
  }
  return sim;
}

const fresh = play({ map: BICHON, level: 10, cls: 0 });
const warrior = play({ map: BICHON, level: 24, cls: 0, completed: ['Curing the Poison Pt. 1'].map((n) => questKey(byName.get(n)!)) });

test('a fresh level 10 character and a level 24 Warrior get sensible plans', () => {
  for (const sim of [fresh, warrior]) {
    const kinds = new Set(sim.actions.map((a) => a.kind));
    for (const kind of ['pickUp', 'hunt', 'handIn']) assert.ok(kinds.has(kind as QuestAction['kind']), kind);
    assert.ok(sim.completed.size >= 5, `${sim.completed.size} handed in`);
    // Nothing handed in that wasn't finished (the simulator only hands in finished ones; the planner only asks for those).
    for (const action of sim.actions) if (action.kind === 'handIn') for (const name of action.quests) assert.ok(sim.completed.has(questKey(byName.get(name)!)));
  }
  // The prerequisite done, its follow-up is on offer; without it, not.
  const followUp = (completed: string[]) => availableQuests(data, { map: BICHON, level: 24, cls: 0, log: completed.map((name) => ({ name, completed: true, ready: true })), targets: [], failed: new Set() }, options, routes);
  assert.ok(followUp(['Curing the Poison Pt. 1']).some((a) => a.quest.name === 'Curing the Poison Pt. 2'));
  assert.ok(!followUp([]).some((a) => a.quest.name === 'Curing the Poison Pt. 2'));
});

test('the same state gets the same answer, and the same run the same plan', () => {
  const state = warrior.state();
  assert.deepEqual(nextQuestAction(data, state, options, routes), nextQuestAction(data, state, options, new RouteCosts(data)));
  const again = play({ map: BICHON, level: 10, cls: 0 });
  assert.deepEqual(again.actions, fresh.actions);
});

const atNpc = (id: number) => {
  const [x, y] = data.npcs.find((n) => n.id === id)!.at!;
  return { x, y };
};

/** A state with these quests in the log: finished ones (ready) and done ones. */
function stateWith(map: number, level: number, ready: TravelQuest[], extra: Partial<QuestState> = {}): QuestState {
  return {
    map,
    level,
    cls: 0,
    log: ready.map((q) => ({ name: questKey(q), completed: false, ready: true })),
    targets: [],
    pending: { regions: [], talks: [] },
    failed: new Set(),
    ...extra,
  };
}

test('grouping: a giver hands over all its quests in one visit, and a hand-in and a pick-up at one NPC go together', () => {
  const level = 24;
  /** Standing by an NPC (with these quests in the log). */
  const by = (npc: number, log: QuestState['log'] = []): QuestState => ({ ...stateWith(npcMap(npc), level, []), at: atNpc(npc), log });
  const offers = (log: QuestState['log'] = []) => {
    const out = new Map<number, string[]>();
    for (const { quest } of availableQuests(data, { ...stateWith(BICHON, level, []), log }, options, routes)) out.set(quest.start, [...(out.get(quest.start) ?? []), quest.name].sort());
    return out;
  };

  // Two or more quests from one giver: picked up together.
  const visits = [...offers()].filter(([, names]) => names.length >= 2).map(([npc, names]) => ({ names, action: nextQuestAction(data, by(npc), options, routes) }));
  const together = visits.filter(({ action }) => action.kind === 'pickUp' && action.quests.length >= 2);
  assert.ok(together.length > 0);
  for (const { names, action } of together) assert.deepEqual([...(action as Extract<QuestAction, { kind: 'pickUp' }>).quests].sort(), names);

  // A quest finished whose taker gives more: hand in, then pick up there, without leaving.
  const handedIn = (q: TravelQuest) => [{ name: questKey(q), completed: true, ready: true }];
  const quest = quests.find((q) => {
    if ((q.level ?? 0) > level || !q.exp || !data.npcs.find((n) => n.id === q.finish)?.at) return false;
    const next = nextQuestAction(data, by(q.finish, handedIn(q)), options, routes);
    return next.kind === 'pickUp' && next.npc === q.finish && next.quests.some((name) => !(byName.get(name)!.after ?? []).includes(q.id));
  })!;
  assert.ok(quest, 'a taker who also gives quests');
  // By the taker: the hand-in first, then the pick-up, in the same visit.
  const handIn = nextQuestAction(data, by(quest.finish, [{ name: questKey(quest), completed: false, ready: true }]), options, routes);
  assert.equal(handIn.kind, 'handIn');
  assert.equal((handIn as Extract<QuestAction, { kind: 'handIn' }>).npc, quest.finish);
  const pickUp = nextQuestAction(data, by(quest.finish, handedIn(quest)), options, routes);
  assert.equal((pickUp as Extract<QuestAction, { kind: 'pickUp' }>).npc, quest.finish);
  assert.match(pickUp.reason, /on this map/);
});

test('finished quests are handed in first when the taker is close; a far one waits for pick-ups on the way', () => {
  const level = 24;
  // No waypoints unlocked yet (the always-open ones aside): far is far.
  const waypoints = new Set<string>();
  const who = { level, cls: 0, waypoints };
  // A finished quest whose taker is a map away from one with no NPCs (so nothing to do there).
  const quiet = (map: number) => !data.npcs.some((n) => n.map === map);
  const enterable = (map: number) => levelAllows(data.maps.find((m) => m.i === map)!, level);
  const candidates = quests.filter((q) => (q.level ?? 0) <= level && enterable(npcMap(q.finish)));
  let close: { q: TravelQuest; from: number } | undefined;
  for (const q of candidates) {
    const link = data.links.find((l) => l.to === npcMap(q.finish) && !l.waypoint && quiet(l.from) && enterable(l.from));
    if (link && routes.steps(link.from, npcMap(q.finish), who) <= QUESTS.nearSteps) {
      close = { q, from: link.from };
      break;
    }
  }
  assert.ok(close, 'a taker close to a map with nothing on it');
  const near = nextQuestAction(data, stateWith(close.from, level, [close.q], { waypoints }), options, routes);
  assert.equal(near.kind, 'handIn');
  assert.match(near.reason, /close by/);
  // The same with the taker far away: new quests first.
  const far = candidates.find((q) => routes.estimate(close!.from, npcMap(q.finish), who) >= 4 * QUESTS.stepsPerHop)!;
  assert.ok(Number.isFinite(routes.steps(close.from, npcMap(far.finish), who)) && routes.steps(close.from, npcMap(far.finish), who) > QUESTS.nearSteps);
  const later = nextQuestAction(data, stateWith(close.from, level, [far], { waypoints }), options, routes);
  assert.equal(later.kind, 'pickUp');
  // ...but with no room for more, it's handed in.
  const full = stateWith(close.from, level, [far], { waypoints });
  full.log = [...full.log, ...Array.from({ length: 5 }, (_, i) => ({ name: `busy ${i}`, completed: false, ready: false }))];
  assert.equal(nextQuestAction(data, full, options, routes).kind, 'handIn');
});

test('what failed this run is skipped', () => {
  const level = 24;
  const start = nextQuestAction(data, stateWith(BICHON, level, []), options, routes) as Extract<QuestAction, { kind: 'pickUp' }>;
  assert.equal(start.kind, 'pickUp');
  const skipped = nextQuestAction(data, stateWith(BICHON, level, [], { failed: new Set([`accept:${start.npc}`]) }), options, routes);
  assert.ok(!(skipped.kind === 'pickUp' && skipped.npc === start.npc));

  // A finished quest that wouldn't hand in.
  const done = byName.get('Wolves in Bichon')!;
  const full = (failed: string[]): QuestState => ({
    ...stateWith(npcMap(done.finish), level, [done], { failed: new Set(failed) }),
    log: [{ name: questKey(done), completed: false, ready: true }, ...Array.from({ length: 5 }, (_, i) => ({ name: `busy ${i}`, completed: false, ready: false }))],
  });
  assert.equal(nextQuestAction(data, full([]), options, routes).kind, 'handIn');
  assert.notEqual(nextQuestAction(data, full([`hand:${questKey(done)}`]), options, routes).kind, 'handIn');

  // Spots, talks and hunts.
  const region = Number(Object.keys(data.questRegions!).find((id) => data.questRegions![id][0] === BICHON));
  const talkNpc = data.npcs.find((n) => n.map === BICHON && n.at)!.id;
  const busy = { log: Array.from({ length: 5 }, (_, i) => ({ name: `busy ${i}`, completed: false, ready: false })) };
  const errands = (failed: string[]): QuestState => ({
    ...stateWith(BICHON, level, [], { failed: new Set(failed) }),
    ...busy,
    pending: { regions: [{ quest: 'Q', region, map: BICHON }], talks: [{ quest: 'Q', npc: talkNpc }] },
    targets: [{ name: 'Wolf', map: null, quest: 'Q' }],
  });
  const kinds = (failed: string[]) => nextQuestAction(data, errands(failed), options, routes).kind;
  assert.ok(['go', 'talk'].includes(kinds([])));
  assert.equal(kinds([`region:${region}`, `talk:${talkNpc}`]), 'hunt');
  assert.equal(kinds([`region:${region}`, `talk:${talkNpc}`, 'hunt:Wolf:null']), 'none');
});

test('quests the bot can’t do are left out: too strong, a map the level can’t enter, other classes, dailies unless asked', () => {
  const available = (level: number, cls: number, opts = options) => new Set(availableQuests(data, stateWith(BICHON, level, [], { cls }), opts, routes).map((a) => a.quest));
  for (const quest of available(10, 0)) {
    assert.ok((quest.level ?? 0) <= 10);
    for (const task of quest.tasks) {
      for (const [name, map] of task.monsters ?? []) {
        // Any one of a task's monsters is enough: at least one is within reach.
        if (task.monsters!.length === 1) assert.ok(monsterLevel(name) <= 10 + QUESTS.maxLevelsAbove, `${quest.name}: ${name}`);
        if (map !== undefined && task.monsters!.length === 1) assert.ok(levelAllows(data.maps.find((m) => m.i === map)!, 10));
      }
    }
  }
  // A quest for one class only: on offer to that class, not to another.
  const classOnly = quests.find((q) => q.cls !== undefined && (q.cls & 3) === 0 && available(24, Math.log2(q.cls & -q.cls)).has(q))!;
  assert.ok(classOnly, 'a quest for one class');
  assert.ok(!available(24, 0).has(classOnly) && !available(24, 1).has(classOnly));
  // Dailies only when asked (none in the data can be done by the bot: a doable quest, made a daily).
  const plain = [...available(24, 0)][0];
  const daily = { ...plain, id: -1, name: 'A daily', type: 'Daily' };
  const withDaily = { ...data, quests: [...quests, daily] };
  const dailies = (opts: typeof options & { dailies?: boolean }) => availableQuests(withDaily, stateWith(BICHON, 24, []), opts, routes).some((a) => a.quest === daily);
  assert.ok(!dailies(options));
  assert.ok(dailies({ ...options, dailies: true }));
  // A level 10 isn't sent after level 40 monsters.
  assert.ok(![...available(10, 0)].some((q) => q.tasks.some((t) => t.monsters?.length && t.monsters.every(([name]) => monsterLevel(name) > 10 + QUESTS.maxLevelsAbove))));
});

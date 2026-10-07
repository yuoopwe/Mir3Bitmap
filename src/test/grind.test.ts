import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { blendMeasurements, chooseGrindMap, describeChoice, GRIND, levelAllows, rateMap, rateMaps, type GrindChoice, type MapRating, type QuestTarget } from '../main/grind';
import type { GrindSession } from '../main/grind-log';
import { loadTravelData, planRoute, type Start, type TravelData } from '../main/travel';

const data = loadTravelData(path.join(__dirname, '..', '..', 'game-data', 'travel.json'));
const BICHON = 1;
const options = { maxLevelsAbove: 5 };
const mapOf = (index: number) => data.maps.find((m) => m.i === index)!;
const mapIndex = (name: string) => data.maps.find((m) => m.name === name)!.i;

/** Standing on a map (by default in Bichon Province), with the steps to its exits guessed from where. */
function startOn(map = BICHON, data_: TravelData = data): Start {
  const spot = data_.spawns?.[map]?.[0];
  return { map, steps: new Map(), at: spot ? { x: spot[0], y: spot[1] } : { x: 180, y: 180 } };
}

const choices = new Map<number, GrindChoice>();
for (const level of [1, 10, 20, 35, 50]) choices.set(level, chooseGrindMap(data, startOn(), { level, cls: 0 }, options)!);

test('choices for levels 1 to 50: maps the level may enter, with monsters near the level', () => {
  for (const [level, choice] of choices) {
    assert.ok(choice, `a map for level ${level}`);
    assert.ok(levelAllows(mapOf(choice.map), level), `${choice.name} allows level ${level}`);
    assert.ok(choice.monsterLevel <= level + options.maxLevelsAbove, `${choice.name}'s monsters (${choice.monsterLevel}) not far above level ${level}`);
    assert.ok(choice.monsterLevel >= level - 15, `${choice.name}'s monsters (${choice.monsterLevel}) not far below level ${level}`);
    assert.ok(choice.tooStrong <= 0.5);
    assert.ok(choice.rate > 0 && choice.effective > 0 && choice.effective <= choice.rate);
    // Every map on the way allows the level too.
    for (const link of choice.route.links) assert.ok(levelAllows(mapOf(link.to), level), `${mapOf(link.to).name} on the way allows level ${level}`);
  }
  // A beginner stays at home; the rate grows with the level.
  assert.equal(choices.get(1)!.map, BICHON);
  const rates = [...choices.values()].map((c) => c.rate);
  assert.deepEqual(rates, [...rates].sort((a, b) => a - b));
});

test('the same question always gets the same answer', () => {
  for (const level of [10, 35]) {
    const again = chooseGrindMap(data, startOn(), { level, cls: 0 }, options)!;
    assert.equal(again.map, choices.get(level)!.map);
    assert.equal(again.rate, choices.get(level)!.rate);
    assert.equal(again.reason, choices.get(level)!.reason);
    assert.deepEqual(rateMaps(data, { level, cls: 0 }, options), rateMaps(data, { level, cls: 0 }, options));
  }
});

test('hysteresis: a map nearly as good is kept; one outgrown or no longer allowed is left', () => {
  const level = 35;
  const who = { level, cls: 0 };
  const best = choices.get(level)!;
  const rated = rateMaps(data, who, options);
  // Nearly as good (within the 25%): kept when it's the map being ground on, though the best is nearer.
  const close = rated.find((r) => r.map !== best.map && r.rate < best.rate && r.rate > best.rate * 0.9)!;
  assert.ok(close, 'a map nearly as good as the best');
  const kept = chooseGrindMap(data, startOn(), who, { ...options, current: close.map })!;
  assert.equal(kept.map, close.map);
  assert.ok(kept.stay);
  assert.match(kept.reason, new RegExp(`^${best.name} is only \\d+% better$`));
  // Without one to keep, the best wins.
  assert.equal(chooseGrindMap(data, startOn(), who, { ...options, current: -1 })!.map, best.map);
  // Standing on it counts as grinding there.
  const there = chooseGrindMap(data, startOn(close.map), who, options)!;
  assert.equal(there.map, close.map);
  assert.ok(there.stay);

  // Far worse: leave it.
  const poor = rated.find((r) => r.rate < best.rate * 0.3)!;
  const left = chooseGrindMap(data, startOn(poor.map), who, options)!;
  assert.notEqual(left.map, poor.map);
  assert.ok(!left.stay);
  assert.match(left.reason, /^outgrew /);

  // Its level limit passed (no map in the data has one yet: give the kept one a limit): leave it, and say so.
  const capped: TravelData = { ...data, maps: data.maps.map((m) => (m.i === close.map ? { ...m, maxLevel: level - 1 } : m)) };
  const moved = chooseGrindMap(capped, startOn(close.map), who, { ...options, current: close.map })!;
  assert.notEqual(moved.map, close.map);
  assert.equal(moved.reason, `${close.name} no longer suits`);
});

test('maps with no spawn data are skipped', () => {
  const empty = data.maps.filter((m) => !data.spawns?.[m.i]?.length);
  assert.ok(empty.length > 0);
  for (const m of empty) assert.deepEqual(rateMap(data, m.i, { level: 999 }, options), { skip: 'no spawn data' });
  const rated = new Set(rateMaps(data, { level: 50 }, options).map((r) => r.map));
  for (const m of empty) assert.ok(!rated.has(m.i));
  for (const choice of choices.values()) assert.ok(data.spawns?.[choice.map]?.length);
});

test('maps the level may not enter, or mostly of monsters too strong, are left out', () => {
  assert.match((rateMap(data, mapIndex('Golden Temple Lv 1'), { level: 50 }, options) as { skip: string }).skip, /needs level/);
  const zuma = mapIndex('Zuma Temple Lv 1');
  assert.match((rateMap(data, zuma, { level: 10 }, options) as { skip: string }).skip, /too strong/);
  // Allowing monsters further above the level lets it in.
  assert.ok('rate' in rateMap(data, zuma, { level: 10 }, { maxLevelsAbove: 30 }));
});

test("difficulty-tier copies ([Heroic], [Mythic]...) and bosses don't count", () => {
  // Death Valley lists [Heroic], [Mythic] and [Archaic] copies of its monsters (lv 48 to 214): for the guild dungeons.
  const rating = rateMap(data, mapIndex('Death Valley Lv 2'), { level: 30 }, options);
  assert.ok('rate' in rating);
  assert.ok(rating.monsterLevel <= 25);
  assert.equal(rating.tooStrong, 0);
  // Bichon Province's Oma Chief (a level 10 boss) isn't too strong for level 1: it doesn't count.
  const bichon = rateMap(data, BICHON, { level: 1 }, options);
  assert.ok('rate' in bichon && bichon.tooStrong === 0);
});

test('class-only links are respected', () => {
  // The Chambers of the Fayth are reached by one class only (and have no monsters): give one a lure, a rich monster.
  const link = data.links.find((l) => l.cls !== undefined && data.maps.find((m) => m.i === l.to)?.name.startsWith('Chamber of the Fayth'))!;
  const cls = Math.log2(link.cls!);
  const lure = data.monsters!.length;
  const lured: TravelData = {
    ...data,
    monsters: [...data.monsters!, 'Lure'],
    monsterStats: [...data.monsterStats!, [50, 1_000_000, 5000, 0]],
    spawnSets: [...data.spawnSets!, [lure]],
    spawns: { ...data.spawns, [link.to]: [[30, 30, 50, data.spawnSets!.length]] },
  };
  const start = startOn(BICHON, lured);
  assert.equal(chooseGrindMap(lured, start, { level: 50, cls }, options)!.map, link.to);
  for (const other of [0, 1, 2, undefined]) {
    if (other === cls) continue;
    const choice = chooseGrindMap(lured, start, { level: 50, cls: other }, options)!;
    assert.notEqual(choice.map, link.to);
    assert.ok(choice.route.links.every((l) => l.cls === undefined));
  }
});

test('the status line says where, the rate and why', () => {
  assert.match(describeChoice(choices.get(35)!, 35), /^Grinding at .+: ~[\d.]+[kM]? exp\/h for level 35 \(.+\)$/);
});

// ---- Measured rates ----

const MINUTE = 60_000;
const rated = (map: number, level: number, opts: Parameters<typeof rateMap>[3] = options) => rateMap(data, map, { level, cls: 0 }, opts) as MapRating;
/** A stint on `map` at `level` that brought `share` of what its estimate promised. */
function stint(map: number, level: number, minutes: number, share: number, at = 1): GrindSession {
  return { map, level, ms: minutes * MINUTE, exp: (rated(map, level).estimate * share * minutes) / 60, at };
}

test('blending measurements: none, a little, a lot, an old level, the newest counting most', () => {
  assert.equal(blendMeasurements([], 30), null);
  const est = 1_000_000;
  const half = (minutes: number, level = 30) => ({ level, ms: minutes * MINUTE, exp: (est / 2) * (minutes / 60), estimate: est });
  const little = blendMeasurements([half(5)], 30)!;
  assert.ok(Math.abs(little.ratio - 0.5) < 1e-9);
  assert.ok(Math.abs(little.trust - 5 / GRIND.measureFullTrustMinutes) < 1e-9);
  assert.equal(blendMeasurements([half(40)], 30)!.trust, 1);
  // Measured 15 levels ago: the same ratio, little trust left.
  const old = blendMeasurements([half(40, 15)], 30)!;
  assert.ok(Math.abs(old.ratio - 0.5) < 1e-9);
  assert.ok(old.trust < 0.25);
  // Newest first: a recent good stint outweighs an older poor one of the same length.
  const good = { level: 30, ms: 20 * MINUTE, exp: (est * 20) / 60, estimate: est };
  const mixed = blendMeasurements([good, half(20)], 30)!;
  assert.ok(mixed.ratio > 0.75 && mixed.ratio < 1);
});

test('rates blend the estimate with what was measured there', () => {
  const map = choices.get(35)!.map;
  const plain = rated(map, 35);
  assert.equal(plain.rate, plain.estimate);
  assert.equal(plain.measured, undefined);
  // Other maps' stints change nothing here.
  assert.deepEqual(rated(map, 35, { ...options, measured: [stint(BICHON, 35, 60, 0)] }), plain);
  const little = rated(map, 35, { ...options, measured: [stint(map, 35, 5, 0.5)] });
  assert.ok(little.rate < plain.rate && little.rate > plain.rate * 0.85);
  assert.ok(Math.abs(little.measured!.rate - plain.estimate * 0.5) < plain.estimate * 1e-9);
  const lot = rated(map, 35, { ...options, measured: [stint(map, 35, 30, 0.5)] });
  assert.ok(Math.abs(lot.rate - plain.estimate * 0.5) < plain.estimate * 1e-9);
  // Measured at level 30, as poor: adjusted to level 35's estimate, trusted less.
  const older = rated(map, 35, { ...options, measured: [stint(map, 30, 30, 0.5)] });
  assert.ok(older.rate > lot.rate && older.rate < plain.rate);
  assert.ok(Math.abs(older.measured!.rate - plain.estimate * 0.5) < plain.estimate * 1e-6);
});

test('a map measured much worse than estimated loses to the next best', () => {
  const level = 35;
  const who = { level, cls: 0 };
  const best = choices.get(level)!;
  const measured = [stint(best.map, level, 30, 0.2)];
  // The next best: the choice with that map left out.
  const without: TravelData = { ...data, spawns: { ...data.spawns, [best.map]: [] } };
  const next = chooseGrindMap(without, startOn(), who, options)!;
  const choice = chooseGrindMap(data, startOn(), who, { ...options, measured })!;
  assert.equal(choice.map, next.map);
  // Grinding there: it's left too.
  const moved = chooseGrindMap(data, startOn(best.map), who, { ...options, measured, current: best.map })!;
  assert.notEqual(moved.map, best.map);
  // The status line has both rates.
  const there = chooseGrindMap(data, startOn(best.map), who, { ...options, measured: [stint(best.map, level, 30, 0.95)], current: best.map })!;
  assert.match(describeChoice(there, level), /: ~[\d.]+[kM] est, [\d.]+[kM] measured exp\/h for level 35 \(/);
});

// ---- Quests ----

/** The non-boss monsters spawning on a map (no difficulty-tier copies), most numerous first. */
function monstersOn(map: number): string[] {
  const counts = new Map<string, number>();
  for (const [, , n, set] of data.spawns?.[map] ?? []) {
    for (const i of data.spawnSets![set]) {
      const name = data.monsters![i];
      if (data.monsterStats![i][3] || name.startsWith('[')) continue;
      counts.set(name, (counts.get(name) ?? 0) + n / data.spawnSets![set].length);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

test('quest targets tied to a map count only there; untied ones count wherever they spawn', () => {
  const level = 35;
  const shared = rateMaps(data, { level, cls: 0 }, options).flatMap((a) => monstersOn(a.map).map((name) => ({ name, map: a.map })));
  const twice = shared.find((s) => shared.some((t) => t.name === s.name && t.map !== s.map))!;
  const other = shared.find((t) => t.name === twice.name && t.map !== twice.map)!.map;
  const tied: QuestTarget[] = [{ name: twice.name.toUpperCase(), map: twice.map, quest: 'Tied' }];
  assert.deepEqual(rated(twice.map, level, { ...options, quests: tied }).quests, ['Tied']);
  assert.deepEqual(rated(other, level, { ...options, quests: tied }).quests, []);
  const untied: QuestTarget[] = [{ name: twice.name, map: null, quest: 'Anywhere' }];
  assert.deepEqual(rated(other, level, { ...options, quests: untied }).quests, ['Anywhere']);
  assert.ok(rated(other, level, { ...options, quests: untied }).rate > rated(other, level).rate);
  // Not spawning there: no bonus.
  assert.equal(rated(other, level, { ...options, quests: [{ name: 'Nobody', map: null, quest: 'Q' }] }).questFactor, 1);
});

test('a quest map wins only when close to the best; "Quests first" picks one whenever it can', () => {
  const level = 35;
  const who = { level, cls: 0 };
  const best = choices.get(level)!;
  const bestMonsters = new Set(monstersOn(best.map));
  const reachable = (r: MapRating) => !!planRoute(data, startOn(), { id: `map:${r.map}`, label: r.name, map: r.map }, who);
  const ratings = rateMaps(data, who, options).filter((r) => monstersOn(r.map).some((n) => !bestMonsters.has(n)));
  /** A quest for the commonest monster on `map` that isn't on the best map, tied to `map`. */
  const questOn = (map: number, quest: string): QuestTarget[] => [{ name: monstersOn(map).find((n) => !bestMonsters.has(n))!, map, quest }];
  const close = ratings.find((r) => r.map !== best.map && r.rate > best.rate * 0.9 && reachable(r))!;
  const far = ratings.find((r) => r.rate < best.rate * 0.4 && reachable(r))!;
  assert.ok(close && far);

  const won = chooseGrindMap(data, startOn(), who, { ...options, quests: questOn(close.map, 'Descent into Darkness Pt. 3') })!;
  assert.equal(won.map, close.map);
  assert.equal(won.reason, 'quest: Descent into Darkness Pt. 3');
  assert.match(describeChoice(won, level), /\(quest: Descent into Darkness Pt\. 3\)$/);
  const farQuest = questOn(far.map, 'Far Away');
  const lost = chooseGrindMap(data, startOn(), who, { ...options, quests: farQuest })!;
  assert.equal(lost.map, best.map);
  assert.ok(!lost.reason.startsWith('quest'));

  // Quests first: the quest map, however far behind; back to the best once there are no quests (or none to be had).
  const first = chooseGrindMap(data, startOn(), who, { ...options, quests: farQuest, questsFirst: true })!;
  assert.equal(first.map, far.map);
  assert.equal(first.reason, 'quest: Far Away');
  // ...and it sticks with a quest map while there are quests, though the best is far better.
  assert.equal(chooseGrindMap(data, startOn(far.map), who, { ...options, quests: farQuest, questsFirst: true, current: far.map })!.map, far.map);
  assert.equal(chooseGrindMap(data, startOn(), who, { ...options, quests: [], questsFirst: true })!.map, best.map);
  const nowhere: QuestTarget[] = [{ name: 'Nobody', map: null, quest: 'Q' }];
  assert.equal(chooseGrindMap(data, startOn(), who, { ...options, quests: nowhere, questsFirst: true })!.map, best.map);
});

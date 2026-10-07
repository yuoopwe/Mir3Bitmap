import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { chooseGrindMap, describeChoice, levelAllows, rateMap, rateMaps, type GrindChoice } from '../main/grind';
import { loadTravelData, type Start, type TravelData } from '../main/travel';

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

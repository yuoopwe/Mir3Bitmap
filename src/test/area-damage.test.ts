import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AREA, AreaMeter, NO_AREA, describeArea, expectedCrowd, learnAreaDamage, learnCrowding, speedUp, stintArea, type AreaReading, type AreaSample } from '../main/area-damage';
import type { MemoryObject } from '../main/game-memory';

// ---- Measuring ----

const ZUMA_5 = 37;
/** A monster as the reader has it: hp is the damage seen land so far, from 0 down. */
const monster = (id: number, x: number, y: number, hp: number, more: Partial<MemoryObject> = {}): MemoryObject => ({
  id, kind: 'monster', name: 'Zuma Guardian', x, y, dead: false, level: 29, pet: false, disposition: 4, maxHp: 1300, hp, ...more,
});
const player = (id: number, x: number, y: number): MemoryObject => ({ id, kind: 'player', name: 'Someone', x, y, dead: false, level: 40, pet: false });
/** The character at 0,0 on Zuma Temple Lv 5, level 30. */
const reading = (objects: MemoryObject[], map = ZUMA_5, dead = false): AreaReading => ({
  user: { name: 'A', x: 0, y: 0, level: 30, dead }, objects, map: { index: map, name: 'Zuma', width: 100, height: 100 },
});

/** Feeds readings a second apart (from `start` ms), each from `at(second)`; the samples that came out. */
function feed(meter: AreaMeter, seconds: number, at: (s: number) => AreaReading, start = 0): AreaSample[] {
  const out: AreaSample[] = [];
  for (let s = 0; s <= seconds; s++) {
    const sample = meter.update(at(s), start + s * 1000, 1_000_000 + start + s * 1000);
    if (sample) out.push(sample);
  }
  return out;
}

test('the damage landing on every hostile monster close by counts, the one clicked or not (softened by area blows), with how many were close', () => {
  const meter = new AreaMeter();
  // Two Guardians next to the character take 100 and 80 a second; one 6 tiles off takes damage from who knows what.
  const samples = feed(meter, 5, (s) => reading([monster(1, 1, 0, -100 * s), monster(2, 0, 2, -80 * s), monster(3, 6, 0, -50 * s)]));
  assert.deepEqual(samples, [{ at: 1_005_000, map: ZUMA_5, level: 30, seconds: 5, damage: 900, crowd: 2 }]);
});

test('only time spent fighting counts: the walk up, before any damage lands, and the gap after the last one dies, do not', () => {
  const meter = new AreaMeter();
  // Three seconds with a monster near but nothing landing, then 100 a second for five.
  const samples = feed(meter, 8, (s) => reading([monster(1, 2, 0, s < 3 ? 0 : -100 * (s - 3))]));
  assert.deepEqual(samples.map((x) => [x.seconds, x.damage, x.crowd]), [[5, 500, 1]]);
  // A kill in three blows of 400 on a monster of 1100: the last blow counts (but only the 300 left), its body lying there afterwards doesn't.
  const after = new AreaMeter();
  const out = feed(after, 12, (s) => reading([monster(1, 1, 0, -Math.min(s, 3) * 400, { dead: s >= 3, maxHp: 1100 })]));
  assert.deepEqual(out, []);
  // Its part-sample, on leaving the map: the 3 s it was fought, 1100 damage, on Zuma.
  const part = after.update(reading([], 99), 13_000, 2_000_000)!;
  assert.deepEqual([part.seconds, part.damage, part.map], [3, 1100, ZUMA_5]);
});

test("someone else's fights don't count: monsters by a pet, and nothing at all with another player close", () => {
  const meter = new AreaMeter();
  // A pet (anyone's) fights the monster at 2,2: neither it nor its damage counts; the one at 1,0 is ours.
  const pet = monster(9, 4, 4, 0, { pet: true, name: 'Skeleton' });
  const ours = feed(meter, 5, (s) => reading([monster(1, 1, 0, -100 * s), monster(2, 2, 2, -300 * s), pet]));
  assert.deepEqual(ours.map((x) => [x.damage, x.crowd]), [[500, 1]]);
  // Another player 5 tiles off could be hitting anything near: nothing is measured while they're there.
  const watched = new AreaMeter();
  assert.deepEqual(feed(watched, 10, (s) => reading([monster(1, 1, 0, -100 * s, { maxHp: 5000 }), player(7, 5, 0)])), []);
  // ...and once they've gone, it measures again.
  assert.deepEqual(feed(watched, 6, (s) => reading([monster(1, 1, 0, -1000 - 100 * s, { maxHp: 5000 })]), 11_000).map((x) => x.damage), [500]);
  // Guards (disposition 0) aren't fought.
  const guard = new AreaMeter();
  assert.deepEqual(feed(guard, 6, (s) => reading([monster(1, 1, 0, -100 * s, { disposition: 0 })])), []);
});

test('a death, or another map, ends the sample so far (kept if 2 s or more)', () => {
  const meter = new AreaMeter();
  feed(meter, 3, (s) => reading([monster(1, 1, 0, -100 * s)]));
  const part = meter.update(reading([], ZUMA_5, true), 4000);
  assert.deepEqual(part && [part.seconds, part.damage], [3, 300]);
  // Too short to keep.
  const short = new AreaMeter();
  feed(short, 1, (s) => reading([monster(1, 1, 0, -100 * s)]));
  assert.equal(short.update(reading([], 5), 2000), null);
});

// ---- Learning ----

/** Samples of `seconds` each: alone at `alone` damage a second, in a crowd of `crowd` at `crowded` a second. */
function fights(alone: number, crowded: number, crowd: number, seconds = 700, n = 1, map = ZUMA_5): AreaSample[] {
  const out: AreaSample[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ at: 2 * i, map, level: 30, seconds, damage: alone * seconds, crowd: 1 });
    out.push({ at: 2 * i + 1, map, level: 30, seconds, damage: crowded * seconds, crowd });
  }
  return out;
}

test('no area attack: the same damage rate in a crowd as alone, so exactly no speed-up (and small noise is none)', () => {
  const none = learnAreaDamage(fights(100, 100, 3), 30);
  assert.equal(none.gain, 0);
  for (const crowd of [1, 2, 3, 8]) assert.equal(speedUp(none, crowd), 1);
  // 8% more in crowds (more monsters to hit, nothing more): under the noise floor.
  const noisy = learnAreaDamage(fights(100, 108, 2), 30);
  assert.ok(noisy.measured > 0 && noisy.measured < AREA.minGain);
  assert.equal(speedUp(noisy, 3), 1);
  // Nothing measured, or only alone: no speed-up either.
  assert.deepEqual(learnAreaDamage([], 30), NO_AREA);
  assert.equal(speedUp(learnAreaDamage(fights(100, 100, 1), 30), 4), 1);
  assert.equal(speedUp(null, 4), 1);
});

test('an area attack: crowds go down faster, as 1 + gain x (crowd - 1), trusted as the time measured builds up, capped', () => {
  // Three at once take 2.6 times the damage one does: each extra one is worth 0.8 of a target.
  const area = learnAreaDamage(fights(100, 260, 3), 30);
  assert.ok(Math.abs(area.gain - 0.8) < 1e-9);
  assert.equal(area.trust, 1);
  assert.ok(Math.abs(speedUp(area, 3) - 2.6) < 1e-9);
  assert.ok(Math.abs(speedUp(area, 2) - 1.8) < 1e-9);
  // No more than maxTargets together, whatever the crowd.
  assert.equal(speedUp(area, 20), speedUp(area, AREA.maxTargets));
  // A quarter of the time needed for full trust, a quarter of the gain counts.
  const early = learnAreaDamage(fights(100, 260, 3, AREA.fullTrustSeconds / 4), 30);
  assert.ok(Math.abs(early.trust - 0.25) < 0.01);
  assert.ok(Math.abs(speedUp(early, 3) - (1 + early.trust * 0.8 * 2)) < 1e-9);
  // More than a target's worth a monster can't be.
  assert.equal(learnAreaDamage(fights(100, 1000, 2), 30).gain, AREA.maxGain);
});

test('crowding: how crowded each map got, and the pull over the spawn density, for maps never ground on', () => {
  const samples = [...fights(100, 100, 3, 600, 1, ZUMA_5).slice(1), { at: 9, map: 28, level: 30, seconds: 600, damage: 0, crowd: 1 }];
  const density = (map: number) => (map === ZUMA_5 ? 2 / 49 : map === 28 ? 0.25 / 49 : 1 / 49);
  const crowding = learnCrowding(samples, density);
  // Zuma: 2 more than the target, where the density puts 2; the sparse map: none, where it puts 0.25. Pull: 2 / 2.25.
  assert.deepEqual([crowding.maps.get(ZUMA_5)!.crowd, crowding.maps.get(28)!.crowd], [3, 1]);
  assert.ok(Math.abs(crowding.pull - 2 / 2.25) < 1e-9);
  assert.equal(expectedCrowd(crowding, ZUMA_5, density(ZUMA_5)), 3);
  assert.equal(expectedCrowd(crowding, 28, density(28)), 1);
  // A map never ground on: 1 + the pull times what its density puts round the character.
  assert.ok(Math.abs(expectedCrowd(crowding, 99, 1 / 49) - (1 + 2 / 2.25)) < 1e-9);
  // Nothing learned: the density as it is.
  assert.ok(Math.abs(expectedCrowd(null, 99, 2 / 49) - 3) < 1e-9);
});

test("a stint's own: the crowd it fought, the speed-up it measured there, and the trust in that", () => {
  const own = stintArea(fights(100, 260, 3, AREA.fullTrustSeconds / 2), 30)!;
  assert.equal(own.crowd, 2);
  assert.ok(Math.abs(own.area - 1.8) < 1e-9);
  assert.ok(Math.abs(own.areaTrust - 0.5) < 0.01);
  assert.equal(stintArea([], 30), null);
});

test('the line said: the speed-up at the crowd, the time measured; or none seen', () => {
  assert.equal(describeArea(learnAreaDamage(fights(100, 260, 3, 1200), 30), 3), 'Area damage: ~3 monsters at once clear 2.6x as fast (40 min measured)');
  assert.equal(describeArea(learnAreaDamage(fights(100, 100, 3, 1200), 30), 3), 'Area damage: none seen yet (40 min measured)');
  assert.equal(describeArea(learnAreaDamage([], 30), 3), 'Area damage: not measured yet');
});

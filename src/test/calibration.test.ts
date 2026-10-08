import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CALIBRATION, PotionWatch, calibrate, describeCalibration, drinkMs, potionNotesFrom, type PotionReading } from '../main/calibration';
import { COMBAT, fight, foeOf, packFighter, type Fighter } from '../main/combat-model';
import type { Kill } from '../main/grind-log';
import { loadTravelData } from '../main/travel';

const data = loadTravelData();

/** A Warrior a Zuma Keeper's blows get through to. */
const me: Fighter = {
  cls: 0, level: 48, maxHp: 1500, minAC: 40, maxAC: 60, minMR: 20, maxMR: 30, minDC: 146, maxDC: 215, minMC: 0, maxMC: 0, minSC: 0, maxSC: 0,
  accuracy: 95, agility: 30, attackSpeed: 8,
};
const stats = packFighter({ name: 'A', x: 0, y: 0, class: me.cls, maxHp: me.maxHp, combat: me })!;
const keeper = foeOf(data, 'Zuma Keeper')!;
const predicted = fight(me, keeper);

/**
 * Kills of Zuma Keepers, newest last, `quicker` times as fast as the model says and costing `harder` times the
 * health it says (in the time they took); at `monsterLevel`.
 */
function kills(n: number, quicker: number, harder: number, options: { from?: number; monsterLevel?: number } = {}): Kill[] {
  const seconds = predicted.seconds / quicker;
  const hpLost = (predicted.takenPerSecond * seconds * harder) / me.maxHp;
  return Array.from({ length: n }, (_, i) => ({
    level: 48, monsterLevel: options.monsterLevel ?? keeper.level, maxHp: keeper.health, damage: keeper.health, seconds, hpLost, at: (options.from ?? 0) + i,
    monster: 'Zuma Keeper', stats, potions: 0, healed: 0, lowest: 1 - hpLost, hits: 20,
  }));
}

test('biased fights: the corrections converge on the bias with enough kills, part of the way with few', () => {
  const many = calibrate(data, kills(60, 1.3, 0.8));
  assert.ok(Math.abs(many.factors.damage - 1.3) < 1e-6, `${many.factors.damage}`);
  assert.ok(Math.abs(many.factors.taken - 0.8) < 1e-6, `${many.factors.taken}`);
  assert.equal(many.kills, 60);
  // The model with them reproduces what was measured.
  const corrected = fight(me, keeper, { factors: many.factors });
  assert.ok(Math.abs(corrected.seconds - predicted.seconds / 1.3) / corrected.seconds < 0.05);
  // Five kills: trusted a quarter of the way.
  const few = calibrate(data, kills(5, 1.3, 0.8));
  assert.ok(few.factors.damage > 1 && few.factors.damage < 1.15, `${few.factors.damage}`);
  // Nothing measured: none.
  assert.deepEqual(calibrate(data, []).factors, { damage: 1, taken: 1, heal: 1 });
  assert.equal(describeCalibration(calibrate(data, [])), 'no fights measured yet: the model as it stands');
  assert.equal(describeCalibration(many), '30% quicker kills, 20% softer hits taken than the model says (60 kills)');
});

test('corrections are capped, newer kills count more, and kills without the newer notes are left out', () => {
  const wild = calibrate(data, kills(60, 5, 10));
  assert.deepEqual([wild.factors.damage, wild.factors.taken], [CALIBRATION.maxFactor, CALIBRATION.maxFactor]);
  // Old kills as the model says, the newest 1.5 times as quick: nearer the newest.
  const shifted = calibrate(data, [...kills(60, 1, 1), ...kills(60, 1.5, 1, { from: 1000 })]);
  assert.ok(shifted.factors.damage > 1.3, `${shifted.factors.damage}`);
  // Older kills (no monster, no stats) say nothing.
  const old = kills(60, 2, 1).map(({ monster: _m, stats: _s, ...k }) => k);
  assert.deepEqual(calibrate(data, old).factors, { damage: 1, taken: 1, heal: 1 });
});

test('by level gap: a gap with its own kills goes by them, blended with the overall ones as far as they go', () => {
  const calibration = calibrate(data, [...kills(40, 1, 1, { monsterLevel: 48 }), ...kills(20, 0.6, 1.5, { from: 100, monsterLevel: 51 })]);
  const level = calibration.byGap.map((g) => [g.gap, g.kills, Number(g.seconds.toFixed(3)), Number(g.taken.toFixed(3))]);
  assert.deepEqual(level, [[0, 40, 1, 1], [3, 20, 1.667, 1.5]]);
  // Three above: slower and harder, by its own kills; a gap never fought: the overall.
  assert.ok(Math.abs(calibration.factorsAt(3).damage - 0.6) < 1e-6);
  assert.ok(Math.abs(calibration.factorsAt(3).taken - 1.5) < 1e-6);
  assert.deepEqual(calibration.factorsAt(7), calibration.factors);
});

/** The character's health and the bag's potions, as the potion watch reads them. */
const reading = (hp: number, xl: number): PotionReading => ({ user: { name: 'A', x: 0, y: 0, hp, maxHp: 1500 }, gear: { worn: [], bag: [], counts: { 'Health Potion (XL)': xl, 'Health Potion (M)': 4 } } });

test('potions: which one the key drinks, what it heals and how fast, and how soon the game allows another', () => {
  const watch = new PotionWatch(data);
  // Pressed at 600 HP: an XL goes from the bag, and 500 HP come back at once.
  watch.pressed(reading(600, 10), 0);
  assert.equal(watch.update(reading(1100, 10), 400), false);
  watch.update(reading(1100, 9), 1000);
  assert.equal(watch.update(reading(1100, 9), CALIBRATION.watchMs), true);
  assert.deepEqual(watch.notes, { potion: 'Health Potion (XL)', heals: [500], instant: 1, drankAfterMs: null, refusedAfterMs: null });
  // Pressed again 4 s on: drunk, healing over time (half within the first moment).
  watch.pressed(reading(800, 9), 4000);
  watch.update(reading(900, 9), 4800);
  watch.update(reading(1000, 8), 5600);
  watch.update(reading(1000, 8), 4000 + CALIBRATION.watchMs);
  assert.deepEqual([watch.notes.heals, watch.notes.instant, watch.notes.drankAfterMs], [[500, 200], 0.5, 4000]);
  // Pressed 3.5 s after that one went down: nothing went (the game's cooldown), so drinking waits longer.
  watch.pressed(reading(900, 8), 7500);
  watch.update(reading(900, 8), 7500 + CALIBRATION.watchMs);
  assert.equal(watch.notes.refusedAfterMs, 3500);
  assert.equal(drinkMs(watch.notes), 3600);
  assert.equal(drinkMs(null), COMBAT.drinkMs);
  // Kept and loaded back; junk isn't.
  assert.deepEqual(potionNotesFrom(JSON.parse(JSON.stringify(watch.notes))), watch.notes);
  assert.equal(potionNotesFrom({ heals: 'no' }), null);
  // What an XL really heals feeds the healing correction: (500 + 200) / 2 of 500.
  assert.ok(Math.abs(calibrate(data, [], watch.notes).factors.heal - 0.7) < 1e-9);
});

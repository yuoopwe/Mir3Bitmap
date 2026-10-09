import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemoryObject } from '../main/game-memory';
import { ExperienceMeter, FightTimer, GrindLog, damageDealt, experienceGained, type FightReading, type GrindSession, type Kill } from '../main/grind-log';

test('experience gained within a level, and across a level-up', () => {
  assert.equal(experienceGained({ level: 20, experience: 1000, maxExperience: 5000 }, { level: 20, experience: 1800, maxExperience: 5000 }), 800);
  // Level-up: what was left of level 20 (5000 - 4600), then 300 into level 21.
  assert.equal(experienceGained({ level: 20, experience: 4600, maxExperience: 5000 }, { level: 21, experience: 300, maxExperience: 7000 }), 700);
  // Nothing to go on, or the level went down: nothing counted.
  assert.equal(experienceGained({ level: 20, experience: null }, { level: 20, experience: 100 }), 0);
  assert.equal(experienceGained({ level: 20, experience: 100 }, { level: 20 }), 0);
  assert.equal(experienceGained({ level: 21, experience: 100, maxExperience: 7000 }, { level: 20, experience: 4000 }), 0);
  assert.equal(experienceGained({ experience: 100 }, { level: 20, experience: 200 }), 0);
});

test('the meter adds up readings over a level-up, skipping ones without the numbers', () => {
  const meter = new ExperienceMeter();
  meter.sample({ level: 9, experience: 900, maxExperience: 1000 });
  meter.sample({ level: 9, experience: 950, maxExperience: 1000 });
  meter.sample({ level: 9, experience: null, maxExperience: null });
  meter.sample(null);
  meter.sample({ level: 10, experience: 40, maxExperience: 1500 });
  meter.sample({ level: 10, experience: 140, maxExperience: 1500 });
  assert.equal(meter.gained, 50 + 50 + 40 + 100);
});

test('the log keeps stints per character, saves and loads them, and drops junk', () => {
  let changes = 0;
  const log = new GrindLog(() => changes++);
  const stint: GrindSession = { map: 33, level: 30, ms: 10 * 60_000, exp: 200_000, at: 1000 };
  log.add('Alice', stint);
  log.add('Alice', { ...stint, ms: 5000 });
  log.add('Bob', { ...stint, map: 35 });
  assert.equal(changes, 2);
  assert.deepEqual(log.sessions('Alice'), [stint]);
  assert.deepEqual(log.sessions('Nobody'), []);

  const again = new GrindLog(() => {});
  again.load(JSON.parse(JSON.stringify(log.toJSON())));
  assert.deepEqual(again.toJSON(), log.toJSON());
  const junk = new GrindLog(() => {});
  junk.load({ characters: { Alice: [stint, { map: 'x' }, null], Bob: 'nope' } });
  junk.load(null);
  junk.load('nonsense');
  assert.deepEqual(junk.toJSON(), { characters: { Alice: [stint] } });
});

// ---- Fights ----

/** A monster as the memory reader has it: hp is the damage seen land, from 0 down. */
const monster = (id: number, hp: number, dead = false, name = 'Wolf'): MemoryObject => ({ id, kind: 'monster', name, x: 0, y: 0, dead, level: 22, pet: false, maxHp: 400, hp });
const reading = (objects: MemoryObject[], hp = 1000, dead = false): FightReading => ({ user: { name: 'Alice', x: 0, y: 0, level: 20, hp, maxHp: 1000, dead }, objects });

test('the fight timer times a kill from the first blow to its death, with the health it cost', () => {
  const timer = new FightTimer();
  timer.update(reading([monster(1, 0)]), 0, null);
  timer.attacked(1, reading([monster(1, 0)]), 1000);
  timer.attacked(1, reading([monster(1, -100)]), 1500);
  // Hit for 150, a potion (up, not counted), hit for 50.
  assert.deepEqual(timer.update(reading([monster(1, -200)], 850), 2000, 1).kills, []);
  timer.update(reading([monster(1, -300)], 950), 2500, 1);
  timer.update(reading([monster(1, -350)], 900), 3000, 1);
  // Overkill: no more than its health counts.
  const { kills, death } = timer.update(reading([monster(1, -450, true)], 900), 5000, 1, 42);
  assert.equal(death, null);
  // With what the combat model's calibration goes by: the monster, the health put back and the lowest it got, blows seen land.
  assert.deepEqual(kills, [{ level: 20, monsterLevel: 22, maxHp: 400, damage: 400, seconds: 4, hpLost: 0.2, at: 42, monster: 'Wolf', potions: 0, healed: 0.1, lowest: 0.85, hits: 4 }]);
  // Seen once only.
  assert.deepEqual(timer.update(reading([monster(1, -450, true)]), 5500, null).kills, []);
});

test('a kill is timed from the first blow next to it, not from a click further off (the walk up), or from damage seen land (from range)', () => {
  const timer = new FightTimer();
  const at = (x: number, hp: number, dead = false): MemoryObject => ({ ...monster(1, hp, dead), x });
  // Clicked four tiles off at 0 s, walked up, first blow next to it at 2 s, dead at 5 s.
  timer.attacked(1, reading([at(4, 0)]), 0);
  timer.update(reading([at(3, 0)]), 1000, 1);
  timer.attacked(1, reading([at(1, 0)]), 2000);
  assert.deepEqual(timer.update(reading([at(1, -400, true)]), 5000, 1).kills.map((k) => k.seconds), [3]);
  // From range: clicked four tiles off, damage seen at 1 s, dead at 4 s.
  timer.attacked(2, reading([{ ...monster(2, 0), x: 4 }]), 0);
  timer.update(reading([{ ...monster(2, -100), x: 4 }]), 1000, 2);
  assert.deepEqual(timer.update(reading([{ ...monster(2, -400, true), x: 4 }]), 4000, 2).kills.map((k) => k.seconds), [3]);
});

test("kills someone else helped with, too quick or too slow to time, bosses and ones gone from sight don't count", () => {
  const timer = new FightTimer((name) => name === 'Oma Chief');
  // Hurt before our first blow.
  timer.attacked(1, reading([monster(1, -50)]), 0);
  // Dead within 0.3 s.
  timer.attacked(2, reading([monster(2, 0)]), 0);
  // A boss.
  timer.attacked(3, reading([monster(3, 0, false, 'Oma Chief')]), 0);
  // Out of sight before dying.
  timer.attacked(4, reading([monster(4, 0)]), 0);
  // Dies after two minutes.
  timer.attacked(5, reading([monster(5, 0)]), 0);
  // A good one, for comparison.
  timer.attacked(6, reading([monster(6, 0)]), 0);
  assert.deepEqual(timer.update(reading([monster(2, -400, true), monster(5, -10), monster(6, -10)]), 200, 2).kills, []);
  const later = timer.update(reading([monster(1, -400, true), monster(3, -400, true, 'Oma Chief'), monster(4, -400, true), monster(5, -10), monster(6, -400, true)]), 2000, null).kills;
  assert.deepEqual(later.map((k) => k.seconds), [2]);
  assert.deepEqual(timer.update(reading([monster(5, -400, true)]), 121_000, null).kills, []);
});

test('a death is noted once, with the level of the monster being fought', () => {
  const timer = new FightTimer();
  timer.attacked(1, reading([monster(1, 0)]), 0);
  assert.deepEqual(timer.update(reading([monster(1, -10)], 0, true), 1000, 1, 7).death, { level: 20, monsterLevel: 22, at: 7 });
  assert.equal(timer.update(reading([monster(1, -10)], 0, true), 1500, 1).death, null);
  // Back to life, then dead again with nothing being fought.
  timer.update(reading([], 1000), 2000, null);
  assert.deepEqual(timer.update(reading([], 0, true), 2500, null, 8).death, { level: 20, monsterLevel: null, at: 8 });
});

test('damage dealt: all the damage over all the time', () => {
  const kill = (damage: number, seconds: number): Kill => ({ level: 20, monsterLevel: 20, maxHp: damage, damage, seconds, hpLost: 0, at: 0 });
  assert.equal(damageDealt([]), null);
  assert.deepEqual(damageDealt([kill(300, 2), kill(100, 2)]), { dps: 100, kills: 2 });
});

test('the log keeps fights per character, saves and loads them, and still loads a file from before them', () => {
  const log = new GrindLog(() => {});
  const kill: Kill = { level: 20, monsterLevel: 22, maxHp: 400, damage: 400, seconds: 4, hpLost: 0.2, at: 1 };
  log.addKill('Alice', kill);
  log.addDeath('Alice', { level: 20, monsterLevel: null, at: 2 });
  log.add('Alice', { map: 33, level: 20, ms: 10 * 60_000, exp: 1000, at: 3, kills: 12, dps: 95 });
  assert.deepEqual(log.fights('Alice'), { kills: [kill], deaths: [{ level: 20, monsterLevel: null, at: 2 }] });
  assert.deepEqual(log.fights('Bob'), { kills: [], deaths: [] });
  const again = new GrindLog(() => {});
  again.load(JSON.parse(JSON.stringify(log.toJSON())));
  assert.deepEqual(again.toJSON(), log.toJSON());
  // From before fights were kept: stints only.
  const old = new GrindLog(() => {});
  old.load({ characters: { Alice: [{ map: 33, level: 20, ms: 60_000, exp: 5, at: 1 }] } });
  assert.deepEqual(old.fights('Alice'), { kills: [], deaths: [] });
  assert.deepEqual(old.toJSON(), { characters: { Alice: [{ map: 33, level: 20, ms: 60_000, exp: 5, at: 1 }] } });
  // Junk dropped.
  const junk = new GrindLog(() => {});
  junk.load({ characters: { Alice: [{ map: 33, level: 20, ms: 60_000, exp: 5, at: 1, kills: 'x', dps: 3 }] }, fights: { Alice: { kills: [kill, { level: 'x' }], deaths: [null, { level: 1, monsterLevel: 'x', at: 1 }] }, Bob: 7 } });
  assert.deepEqual(junk.toJSON(), { characters: { Alice: [{ map: 33, level: 20, ms: 60_000, exp: 5, at: 1 }] }, fights: { Alice: { kills: [kill], deaths: [] } } });
});

test("the combat model's notes: a kill's newer fields, Boss circuit time and what's learned of potions are saved and loaded, junk in them dropped", () => {
  const log = new GrindLog(() => {});
  const kill: Kill = { level: 48, monsterLevel: 31, maxHp: 3410, damage: 3410, seconds: 25, hpLost: 0.6, at: 1, monster: 'Zuma Keeper', stats: [1, 2, 3], potions: 3, healed: 0.5, lowest: 0.4, hits: 24 };
  log.addKill('Alice', kill);
  log.addBossTime('Alice', { ms: 60_000, at: 2 });
  log.addBossTime('Alice', { ms: 0, at: 3 });
  log.setPotions('Alice', { potion: 'Health Potion (XL)', heals: [500], instant: 1, drankAfterMs: null, refusedAfterMs: 1500 });
  const again = new GrindLog(() => {});
  again.load(JSON.parse(JSON.stringify(log.toJSON())));
  assert.deepEqual(again.toJSON(), log.toJSON());
  assert.deepEqual(again.bossTime('Alice'), [{ ms: 60_000, at: 2 }]);
  assert.equal(again.potions('Alice')!.refusedAfterMs, 1500);
  log.setGearChecks('Alice', [{ at: 5, stats: [[8, 138, 158, 158]] }]);
  const third = new GrindLog(() => {});
  third.load(JSON.parse(JSON.stringify(log.toJSON())));
  assert.deepEqual(third.gearChecks('Alice'), [{ at: 5, stats: [[8, 138, 158, 158]] }]);
  const junk = new GrindLog(() => {});
  junk.load({ characters: {}, fights: { Alice: { kills: [{ ...kill, monster: 7, stats: ['x'], hits: 'many' }], deaths: [] } }, bossTime: { Alice: [{ ms: 'x' }] }, potions: { Alice: { heals: 'x' } }, gearChecks: { Alice: [{ at: 1, stats: [[8, 'x']] }] } });
  const { monster: _m, stats: _s, hits: _h, ...plain } = kill;
  assert.deepEqual(junk.fights('Alice').kills, [plain]);
  assert.deepEqual(junk.bossTime('Alice'), []);
  assert.equal(junk.potions('Alice'), null);
  assert.deepEqual(junk.gearChecks('Alice'), []);
});

test('area damage samples are saved as versioned rows and loaded back; another version, junk rows and bad stint fields are dropped', () => {
  const log = new GrindLog(() => {});
  const sample = { at: 5, map: 37, level: 30, seconds: 5, damage: 900, crowd: 2.4 };
  log.addAreaSample('Alice', sample);
  log.add('Alice', { map: 37, level: 30, ms: 60_000, exp: 10, at: 6, crowd: 2.4, area: 1.9, areaTrust: 0.3 });
  const saved = JSON.parse(JSON.stringify(log.toJSON()));
  assert.deepEqual(saved.area, { Alice: { v: 1, samples: [[5, 37, 30, 5, 900, 2.4]] } });
  const again = new GrindLog(() => {});
  again.load(saved);
  assert.deepEqual(again.areaSamples('Alice'), [sample]);
  assert.deepEqual(again.sessions('Alice')[0], { map: 37, level: 30, ms: 60_000, exp: 10, at: 6, crowd: 2.4, area: 1.9, areaTrust: 0.3 });
  assert.deepEqual(again.toJSON(), log.toJSON());
  // A file from before area damage loads as before; a later version's samples, and broken rows, aren't taken.
  const old = new GrindLog(() => {});
  old.load({ characters: { Alice: [{ map: 37, level: 30, ms: 60_000, exp: 10, at: 6, crowd: 'x', area: 2, areaTrust: 1 }] } });
  assert.deepEqual([old.areaSamples('Alice'), old.sessions('Alice')[0]], [[], { map: 37, level: 30, ms: 60_000, exp: 10, at: 6 }]);
  const junk = new GrindLog(() => {});
  junk.load({ characters: {}, area: { Alice: { v: 2, samples: [[5, 37, 30, 5, 900, 2.4]] }, Bob: { v: 1, samples: [[1, 2, 3], [5, 37, 30, 5, 'x', 2], [5, 37, 30, 5, 900, 1]] } } });
  assert.deepEqual([junk.areaSamples('Alice'), junk.areaSamples('Bob')], [[], [{ at: 5, map: 37, level: 30, seconds: 5, damage: 900, crowd: 1 }]]);
});

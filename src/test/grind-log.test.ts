import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExperienceMeter, GrindLog, experienceGained, type GrindSession } from '../main/grind-log';

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

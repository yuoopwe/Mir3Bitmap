import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNCALIBRATED } from '../main/calibration';
import type { Fighter, Supplies } from '../main/combat-model';
import { circuitBosses, focusWeights, statValues, type GuideInput } from '../main/stat-values';
import { loadTravelData } from '../main/travel';

const data = loadTravelData();
const ZUMA_5 = 37;
const BROOD = '[Behemoth] Bone Revenant Brood';

/** The Warrior the model was measured with: DC 146-215, Attack Speed 8, Accuracy 95; Zuma monsters don't get through their AC. */
const WARRIOR: Fighter = {
  cls: 0, level: 48, maxHp: 1500, minAC: 55, maxAC: 80, minMR: 20, maxMR: 30, minDC: 146, maxDC: 215, minMC: 0, maxMC: 0, minSC: 0, maxSC: 0,
  accuracy: 95, agility: 30, attackSpeed: 8,
};
const XL = (count: number): Supplies => ({ potion: { name: 'Health Potion (XL)', heal: 500, price: 400, count }, drinkMs: 1500 });

/** Grinding Zuma Temple Lv 5, nothing else. */
const grinding = (changes: Partial<GuideInput> = {}): GuideInput => ({
  data, me: WARRIOR, supplies: XL(100), calibration: UNCALIBRATED, maps: [ZUMA_5], grinder: { level: 48, cls: 0 }, grindOptions: { maxLevelsAbove: 5 },
  bosses: [], rewards: {}, weights: { grind: 1, bosses: 0 }, counts: {}, ...changes,
});
/** Going for the Bone Revenant Brood, nothing else. */
const brood = (me: Fighter, supplies = XL(100)) =>
  statValues(grinding({ me, supplies, maps: [], bosses: [{ name: BROOD, kills: 1, quest: null }], weights: { grind: 0, bosses: 1 } }));
const value = (values: ReturnType<typeof statValues>, name: string) => values.groups.find((g) => g.name === name)!.value;

test('Zuma Temple Lv 5 with this Warrior: Attack Speed and DC are what count; defence and HP are worth nothing here', () => {
  const values = statValues(grinding());
  assert.deepEqual(values.groups.slice(0, 2).map((g) => g.name), ['Attack Speed', 'DC']);
  for (const name of ['AC', 'MR', 'HP']) assert.equal(value(values, name), 0, name);
  assert.ok(value(values, 'Attack Speed') > 5 * value(values, 'DC'));
  assert.match(values.groups[0].line, /^Attack Speed: \+\d\.\d% exp\/h each; \+4\.4% kill speed; you never miss and take no damage here$/);
  assert.equal(values.groups.find((g) => g.name === 'AC')!.line, 'AC: worth nothing here; you take no damage here');
  // For the loot judge: a point of each stat, a pair's halves alike.
  assert.equal(values.perStat[16], value(values, 'Attack Speed'));
  assert.equal(values.perStat[8], value(values, 'DC') / 2);
  assert.equal(values.perStat[9], values.perStat[8]);
  assert.deepEqual(values.locked, []);
  assert.match(values.activities[0], /^Zuma Temple Lv 5 \(~[\d.]+k exp\/h\)$/);
});

test("the Bone Revenant Brood: AC and HP jump in value until it can be survived with potions, then fall away", () => {
  const locked = brood(WARRIOR);
  assert.equal(locked.locked.length, 1);
  assert.equal(locked.locked[0].name, BROOD);
  assert.match(locked.locked[0].why, /^needs \+\d+ AC, or \+\d+ HP, or \d+ Health Potion \(XL\) a kill \(you have 100\) \(a gear gap: levels alone won't close it\)$/);
  const ac = value(locked, 'AC');
  const hp = value(locked, 'HP');
  assert.ok(ac > 0 && hp > 0);
  assert.match(locked.groups.find((g) => g.name === 'AC')!.line, /; \d+ more opens \[Behemoth\] Bone Revenant Brood$/);
  // With the AC to survive it (and potions enough), more AC and HP are worth next to nothing.
  const gap = Number(/\+(\d+) AC/.exec(locked.locked[0].why)![1]);
  const safe = brood({ ...WARRIOR, minAC: WARRIOR.minAC + gap + 20, maxAC: WARRIOR.maxAC + gap + 20 }, XL(1000));
  assert.deepEqual(safe.locked, []);
  assert.ok(value(safe, 'AC') < ac / 20, `${value(safe, 'AC')} against ${ac}`);
  assert.ok(value(safe, 'HP') < hp / 20);
});

test('elixirs: what an hour of each brings, and whether it pays with some in the bag', () => {
  const values = statValues(grinding({ counts: { 'Elixir Of Haste (II)': 25 } }));
  const haste = values.elixirs.find((e) => e.family === 'Haste')!;
  assert.equal(haste.name, 'Elixir Of Haste (II)');
  assert.ok(haste.gain > 0.04 && haste.gain < 0.1, `${haste.gain}`);
  assert.equal(haste.pays, true);
  assert.match(haste.line, /^Haste \(II\): \+\d\.\d% exp\/h for an hour, you have 25$/);
  // None of the others in the bag: the best the level allows, not paying. More HP does nothing here.
  const life = values.elixirs.find((e) => e.family === 'Life')!;
  assert.deepEqual([life.name, life.have, life.pays, life.gain], ['Elixir Of Life (IV)', 0, false, 0]);
  const destruction = values.elixirs.find((e) => e.family === 'Destruction')!;
  assert.ok(destruction.gain > 0 && !destruction.pays);
  assert.equal(values.elixirs[0].family, 'Haste');
});

test('the Boss circuit: its quests\' bosses and rewards; a reward counts only once every boss it wants can be survived', () => {
  const quest = data.quests!.find((q) => q.id === 1840)!;
  const { bosses, rewards } = circuitBosses([quest]);
  assert.equal(bosses.length, 10);
  assert.ok(bosses.every((b) => b.quest === quest.name && b.kills === 3));
  assert.equal(rewards[quest.name], 100);
  // Adding the Brood to the quest: it can't be survived, so the reward hangs on it.
  const withBrood = statValues(grinding({ maps: [], bosses: [...bosses, { name: BROOD, kills: 1, quest: quest.name }], rewards, weights: { grind: 0, bosses: 1 } }));
  assert.deepEqual(withBrood.locked.map((l) => l.name), [BROOD]);
  const without = statValues(grinding({ maps: [], bosses, rewards, weights: { grind: 0, bosses: 1 } }));
  assert.ok(value(withBrood, 'AC') > value(without, 'AC'));
});

test('the weights: the time spent on each lately, or the focus set', () => {
  const now = 10 * 86_400_000;
  const stint = (ms: number, at: number) => ({ map: 1, level: 1, ms, exp: 0, at });
  assert.deepEqual(focusWeights([stint(3_600_000, now - 1000)], [{ ms: 1_200_000, at: now - 1000 }], now), { grind: 0.75, bosses: 0.25 });
  // Older than a week: not counted; nothing at all, half each.
  assert.deepEqual(focusWeights([stint(3_600_000, 0)], [], now), { grind: 0.5, bosses: 0.5 });
  assert.deepEqual(focusWeights([stint(3_600_000, now)], [], now, 80), { grind: 0.19999999999999996, bosses: 0.8 });
});

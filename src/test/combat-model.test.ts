import assert from 'node:assert/strict';
import { test } from 'node:test';
import { COMBAT, blowMoments, describeGap, fight, fighterOf, foeOf, hitsToKill, potionInBag, survivalGap, swingMs, withStats, type Fighter, type Supplies } from '../main/combat-model';
import { loadTravelData } from '../main/travel';

const data = loadTravelData();

/** The Warrior the model was measured with: DC 146-215, Attack Speed 8, Accuracy 95; AC enough that Zuma monsters don't get through. */
const WARRIOR: Fighter = {
  cls: 0, level: 48, maxHp: 1500, minAC: 55, maxAC: 80, minMR: 20, maxMR: 30, minDC: 146, maxDC: 215, minMC: 0, maxMC: 0, minSC: 0, maxSC: 0,
  accuracy: 95, agility: 30, attackSpeed: 8,
};
const XL = (count: number): Supplies => ({ potion: { name: 'Health Potion (XL)', heal: 500, price: 400, count }, drinkMs: 1500 });
const guardian = foeOf(data, 'Zuma Guardian')!;

test('a blow: the attack roll less the defence roll, never under the floor; both rolls even over whole numbers', () => {
  // DC 10 against AC 0-4: 10, 9, 8, 7, 6.
  assert.deepEqual(blowMoments([10, 10], [0, 4]), { mean: 8, square: (100 + 81 + 64 + 49 + 36) / 5 });
  // DC 3 against AC 0-5: 3, 2, 1, then nothing through.
  const weak = blowMoments([3, 3], [0, 5]);
  assert.equal(weak.mean, 1);
  assert.equal(weak.square, 14 / 6);
  // Against the Warrior's AC 55-80, a Zuma Guardian's DC 30-53 never gets through.
  assert.equal(blowMoments([guardian.minDC, guardian.maxDC], [WARRIOR.minAC, WARRIOR.maxAC]).mean, 0);
  // Every pair counted: DC 1-3 against AC 1-2, as a plain average over the six.
  const pairs = [1, 2, 3].flatMap((a) => [1, 2].map((b) => Math.max(0, a - b)));
  assert.equal(blowMoments([1, 3], [1, 2]).mean, pairs.reduce((s, v) => s + v, 0) / 6);
});

test('hits to kill: breakpoints, and the likeliest counts when blows vary', () => {
  assert.equal(hitsToKill(100, 0, 300).mean, 3);
  // A point less and every kill takes a fourth blow.
  assert.equal(hitsToKill(99, 0, 300).mean, 4);
  // Varying blows of 100 on average: three or four, mostly.
  const varied = hitsToKill(100, 400, 300);
  assert.ok(varied.mean > 3 && varied.mean < 4, `${varied.mean}`);
  assert.deepEqual(varied.likely.map(([n]) => n).sort(), [3, 4]);
  assert.equal(hitsToKill(0, 0, 300).mean, Infinity);
});

test('attack speed: 1500 - 47 a point ms between swings, reproducing the 158 dps measured as 162 against a Zuma Guardian', () => {
  assert.equal(swingMs(WARRIOR), 1500 - 47 * 8);
  const outcome = fight(WARRIOR, guardian);
  assert.equal(outcome.hitChance, 1, 'Accuracy 95 against Agility 16: no misses');
  assert.ok(Math.abs(outcome.damagePerSecond - 158) < 1, `${outcome.damagePerSecond}`);
  assert.ok(Math.abs(outcome.damagePerSecond / 162 - 1) < 0.05);
  // A point of Attack Speed: about 4.4% more, worth about 8 DC (min and max).
  const faster = fight(withStats(WARRIOR, { attackSpeed: 1 }), guardian).damagePerSecond / outcome.damagePerSecond - 1;
  assert.ok(Math.abs(faster - 0.044) < 0.002, `${faster}`);
  const dc8 = fight(withStats(WARRIOR, { minDC: 8, maxDC: 8 }), guardian).damagePerSecond / outcome.damagePerSecond - 1;
  assert.ok(Math.abs(dc8 - faster) < 0.01, `${dc8} against ${faster}`);
  // Its health at that rate, the last blow a moment before the kill shows.
  assert.ok(outcome.seconds > 7 && outcome.seconds < 10, `${outcome.seconds}`);
});

test('misses: Accuracy short of the Agility lands that share of swings', () => {
  const clumsy = withStats(WARRIOR, { accuracy: -87 });
  const outcome = fight(clumsy, guardian);
  assert.equal(outcome.hitChance, 0.5);
  assert.ok(Math.abs(outcome.damagePerSecond / fight(WARRIOR, guardian).damagePerSecond - 0.5) < 1e-9);
});

test('survival: a sub-boss that hits through costs health, survived with potions in the bag, at so many potions and so much gold a kill', () => {
  const keeper = foeOf(data, 'Zuma Keeper')!;
  const bare = fight(WARRIOR, keeper);
  assert.ok(bare.takenPerSecond > 0 && bare.hpLost > WARRIOR.maxHp * COMBAT.safeShare);
  assert.equal(bare.survivesWithout, false);
  assert.equal(bare.survives, false, 'no potions');
  const potted = fight(WARRIOR, keeper, { supplies: XL(100) });
  assert.equal(potted.survives, true);
  assert.ok(Math.abs(potted.potionsPerKill - potted.hpLost / 500) < 1e-9);
  assert.ok(Math.abs(potted.goldPerKill - potted.potionsPerKill * 400) < 1e-9);
  assert.ok(Math.abs(potted.potionSeconds - (100 * 500) / (potted.takenPerSecond - WARRIOR.maxHp * COMBAT.regenPerSecond)) < 1e-6);
  // Too few potions for one kill: not survivable.
  assert.equal(fight(WARRIOR, keeper, { supplies: XL(1) }).survives, false);
  // A Zuma Guardian never gets through: survived without any, nothing lost.
  const easy = fight(WARRIOR, guardian);
  assert.deepEqual([easy.survivesWithout, easy.hpLost, easy.potionsPerKill, easy.potionSeconds], [true, 0, 0, Infinity]);
});

test("the gap: a behemoth that can't be survived even with potions, and what would do it: AC, HP, or potions", () => {
  const brood = foeOf(data, '[Behemoth] Bone Revenant Brood')!;
  const supplies = XL(100);
  assert.equal(fight(WARRIOR, brood, { supplies }).survives, false);
  const gap = survivalGap(data, WARRIOR, brood, { supplies })!;
  assert.equal(gap.defence, 'AC');
  // Exactly enough AC: a point less won't do.
  const ac = (n: number) => fight(withStats(WARRIOR, { minAC: n, maxAC: n }), brood, { supplies }).survives;
  assert.ok(gap.more! > 0 && ac(gap.more!) && !ac(gap.more! - 1));
  const hp = (n: number) => fight(withStats(WARRIOR, { maxHp: n }), brood, { supplies }).survives;
  assert.ok(gap.health! > 0 && hp(gap.health!) && !hp(gap.health! - 1));
  // Drinking isn't what's short here, the potions are: it takes more a kill than the bag has.
  assert.equal(gap.potion, 'Health Potion (XL)');
  assert.ok(gap.potionsPerKill > 100);
  assert.equal(describeGap(gap), `needs +${gap.more} AC, or +${gap.health} HP, or ${Math.ceil(gap.potionsPerKill)} Health Potion (XL) a kill (you have 100)`);
  // Survivable already: no gap.
  assert.equal(survivalGap(data, WARRIOR, guardian, { supplies }), null);
  // Drinking faster is the way when the drinking can't keep up.
  const slow = describeGap({ ...gap, more: null, health: null, drinkMs: 2000, drinkingMs: 3000, potionsPerKill: 139.2, have: 30 });
  assert.equal(slow, 'needs Health Potion (XL) every 2 s; it costs about 140 potions a kill (you have 30)');
});

test("the character from the game's memory: stats, class, level, and the weapon's element; the potion in the bag", () => {
  const user = { name: 'A', x: 0, y: 0, level: 48, class: 0, hp: 1000, maxHp: 1500, combat: { ...WARRIOR } };
  const sword = { slot: 0, name: 'Fire Sword', type: 2, rarity: 0, lootLevel: 0, cls: 1, needs: 0, needsAmount: 1, flags: 0, canSell: true, durability: 1, maxDurability: 1, base: { 20: 5 }, added: {} };
  assert.equal(fighterOf(user, [sword])!.element, 'Fire');
  assert.equal(fighterOf(user, [sword])!.elementAttack, 5);
  // Added up over what's worn: two pieces of Lightning beat one bigger piece of Fire.
  const ring = { ...sword, slot: 7, name: 'Spark Ring', base: { 24: 4 } };
  assert.deepEqual([fighterOf(user, [sword, ring, { ...ring, slot: 8 }])!.element, fighterOf(user, [sword, ring, { ...ring, slot: 8 }])!.elementAttack], ['Lightning', 8]);
  assert.equal(fighterOf(user)!.maxHp, 1500);
  assert.equal(fighterOf({ ...user, combat: null }), null);
  // Elemental attack is extra damage on each blow, less the resistance: the Zuma Guardian resists Fire at -50, so
  // 10 Fire attack adds 15 a blow; its Lightning resistance of 50 halves 10 Lightning attack to 5. The blow itself is
  // untouched (Lightning gear didn't halve kills there: measured).
  const per = (element?: string) => fight({ ...WARRIOR, ...(element && { element, elementAttack: 10 }) }, guardian).perSwing;
  const hit = fight(WARRIOR, guardian).hitChance;
  assert.ok(Math.abs(per('Fire') - per() - 15 * hit) < 1e-9);
  assert.ok(Math.abs(per('Lightning') - per() - 5 * hit) < 1e-9);
  assert.deepEqual(potionInBag(data, { 'Health Potion (L)': 5, 'Health Potion (XL)': 0, 'Health Potion (M)': 9 }, 48), { name: 'Health Potion (L)', heal: 300, price: 200, count: 5 });
  // As learned: the M on the key, though bigger ones are in the bag.
  assert.equal(potionInBag(data, { 'Health Potion (L)': 5, 'Health Potion (M)': 9 }, 48, 'Health Potion (M)')!.name, 'Health Potion (M)');
  assert.equal(potionInBag(data, {}, 48), null);
});

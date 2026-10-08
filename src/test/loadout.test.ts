import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNCALIBRATED } from '../main/calibration';
import { fight, foeOf, survivalGap, type Fighter } from '../main/combat-model';
import type { MemoryItem } from '../main/game-memory';
import { GearWatch, bagPlace, cantPutOn, characterOf, contribution, describeCheck, describeSwap, gearCorrections, optimise, predict, setBonus, type Character, type Worn } from '../main/loadout';
import { gain, worthOf, type GuideInput } from '../main/stat-values';
import { loadTravelData } from '../main/travel';

const data = loadTravelData();

/** Library.ItemType and EquipmentSlot. */
const WEAPON = 2, ARMOUR = 3, HELMET = 5, NECKLACE = 6, BRACELET = 7, RING = 8, SHOES = 9;
const DC = (min: number, max: number) => ({ 8: min, 9: max });
const AC = (min: number, max: number) => ({ 4: min, 5: max });

/** An item a Warrior of any level can wear, with these stats. */
function item(name: string, type: number, slot: number, base: Record<number, number>, changes: Partial<MemoryItem> = {}): MemoryItem {
  return { slot, name, type, rarity: 0, lootLevel: 0, cls: 255, needs: 0, needsAmount: 1, flags: 0, canSell: true, durability: 100, maxDurability: 100, base, added: {}, ...changes };
}

// ---- This character, as measured: worn items and bloodline add up to DC 144-222, AC 98-115, Attack Speed 16; the game shows DC 138-194, AC 109-129, Attack Speed 15 ----

/** Worn out (0/32000): gives nothing. */
const BLADE = item('Steelforge Blade', WEAPON, 0, DC(22, 51), { durability: 0, maxDurability: 32000 });
/** The worn Battle Necklace: +10 Attack Speed. */
const WORN_NECKLACE = item('Battle Necklace', NECKLACE, 4, { 16: 10 });
/** A profession tool (slot 28) and the horse (slot 18): nothing in a fight, the horse only while ridden. */
const PICK_AXE = item('Pick Axe', 61, 28, { 16: 1 });
const HORSE = item('Brown Horse', 50, 18, AC(10, 12));
const ARMOUR_ON = item('Plate Armour', ARMOUR, 1, { ...AC(60, 70), ...DC(60, 80) });
const RINGS_ON = [item('Old Ring', RING, 7, DC(2, 4)), item('Fine Ring', RING, 8, { ...DC(30, 40), 16: 5 })];
const WORN = [BLADE, WORN_NECKLACE, PICK_AXE, HORSE, ARMOUR_ON, ...RINGS_ON];
/** The bag's Battle Necklace: +15% DC and +15% HP. */
const BAG_NECKLACE = item('Battle Necklace', NECKLACE, 12, { 84: 15, 54: 15 });

/** The character as the game shows them (no % stats from gear now), a Warrior of level 48, on foot. */
const SHOWN: Character = {
  totals: { 2: 1500, 4: 109, 5: 129, 6: 20, 7: 30, 8: 138, 9: 194, 10: 0, 11: 0, 12: 0, 13: 0, 14: 95, 15: 30, 16: 15, 84: 0, 54: 0, 74: 200, 75: 100 },
  wear: 120, hand: 40, cls: 0, level: 48, mounted: false,
};
const worn = (items: MemoryItem[]): Worn[] => items.map((i) => ({ slot: i.slot, item: i }));
const without = (gone: MemoryItem) => worn(WORN.filter((i) => i !== gone));
const swapped = (out: MemoryItem, into: MemoryItem) => worn(WORN.map((i) => (i === out ? { ...into, slot: out.slot } : i)));

test("summing what's worn doesn't give the game's totals: broken items, tools and the horse on foot give nothing", () => {
  const naive = worn(WORN).reduce((sum, w) => sum + (w.item.base[8] ?? 0), 0);
  assert.equal(naive, 22 + 60 + 2 + 30);
  const counted = contribution(worn(WORN), false);
  // The blade, the pick axe and the horse left out.
  assert.deepEqual([counted[8], counted[9], counted[16], counted[4] ?? 0], [92, 124, 15, 60]);
  assert.equal(contribution(worn(WORN), true)[4], 70, 'ridden, the horse counts');
});

test('the delta maths: changes from the game\'s own totals, by what each swap takes away and adds', () => {
  const at = (to: Worn[], char = SHOWN) => predict(char, worn(WORN), to).totals;
  // Taking off the broken blade, the pick axe, or the horse on foot: nothing changes.
  for (const gone of [BLADE, PICK_AXE, HORSE]) assert.deepEqual(at(without(gone)), SHOWN.totals, gone.name);
  // The blade repaired: its 22-51 DC back.
  const repaired = at(swapped(BLADE, { ...BLADE, durability: 32000 }));
  assert.deepEqual([repaired[8], repaired[9]], [160, 245]);
  // Ridden, the horse's AC goes with it.
  const riding = { ...SHOWN, mounted: true };
  assert.deepEqual([at(without(HORSE), riding)[4], at(without(HORSE), riding)[5]], [99, 117]);
  // A ring for a better one: DC by the difference; Attack Speed too, but only up to the game's cap of 15 (at it already).
  const ring = at(swapped(RINGS_ON[1], item('Haste Ring', RING, 20, { 16: 7 })));
  assert.deepEqual([ring[8], ring[9], ring[16]], [108, 154, 15]);
  // The gear here gives exactly 15 (necklace 10, ring 5; the pick axe nothing): a ring of 2 for the ring of 5 is 12.
  assert.equal(at(swapped(RINGS_ON[1], item('Slow Ring', RING, 20, { 16: 2 })))[16], 12);
  // With the Haste Ring on, the gear gives 17 and the game shows 15: a ring of 5 for it still leaves 15, one of 3 makes 13.
  const haste = swapped(RINGS_ON[1], item('Haste Ring', RING, 20, { 16: 7 }));
  const fromHaste = (into: MemoryItem) => predict(SHOWN, haste, haste.map((w) => (w.item.name === 'Haste Ring' ? { ...w, item: into } : w))).totals[16];
  assert.equal(fromHaste(item('Mid Ring', RING, 20, { 16: 5 })), 15);
  assert.equal(fromHaste(item('Weak Ring', RING, 20, { 16: 3 })), 13);
  // Below the cap it moves by the difference: without the necklace the gear gives 5 (the ring), shown 5; the Haste Ring makes it 7.
  const noNecklace = without(WORN_NECKLACE);
  const slower = { ...SHOWN, totals: { ...SHOWN.totals, 16: 5 } };
  const hasteOn = noNecklace.map((w) => (w.item === RINGS_ON[1] ? { ...w, item: item('Haste Ring', RING, 20, { 16: 7 }) } : w));
  assert.equal(predict(slower, noNecklace, hasteOn).totals[16], 7);
});

test("% stats: the bag necklace's +15% DC and HP on the sum they multiply, worked back from the totals and the % now", () => {
  const next = predict(SHOWN, worn(WORN), swapped(WORN_NECKLACE, BAG_NECKLACE)).totals;
  // 138-194 DC + 15% (rounded down, as the game does), Attack Speed less the worn one's 10, HP + 15%.
  assert.deepEqual([next[8], next[9], next[16], next[2], next[84], next[54]], [158, 223, 5, 1725, 15, 15]);
  // With 10% DC already from elsewhere: the sum before it is 138 / 1.1 (125), then 125 x 1.25.
  const already = { ...SHOWN, totals: { ...SHOWN.totals, 8: 138, 84: 10 } };
  assert.equal(predict(already, worn(WORN), swapped(WORN_NECKLACE, BAG_NECKLACE)).totals[8], 138 + (156 - 137));
  // And a flat stat under a %: 10 more min DC than the Old Ring, at 15%, is 11.5 more, rounded as the game rounds (137 + 10 at 15%).
  const flat = predict({ ...SHOWN, totals: { ...SHOWN.totals, 8: 158, 84: 15 } }, worn(WORN), swapped(RINGS_ON[0], item('Ring', RING, 20, DC(12, 4)))).totals;
  assert.equal(flat[8], 158 + Math.floor(147 * 1.15) - Math.floor(137 * 1.15));
});

/** A scorer: damage (DC both ends), Attack Speed counting as 8 DC, and a little for AC. */
const damage = (f: Fighter) => f.minDC + f.maxDC + 16 * f.attackSpeed + 0.1 * (f.minAC + f.maxAC);

test('rings and bracelets: two places each, the best two of everything (worn rings stay where they are)', () => {
  const bag = [item('Ruby Ring', RING, 10, DC(0, 8)), item('Jade Ring', RING, 11, DC(0, 6)), item('Tin Ring', RING, 12, DC(0, 1)),
    item('Iron Bracelet', BRACELET, 13, AC(1, 2)), item('Gold Bracelet', BRACELET, 14, DC(1, 5))];
  const ringsOnly = [item('Old Ring', RING, 7, DC(0, 2)), item('Fine Ring', RING, 8, DC(0, 5))];
  const plan = optimise(SHOWN, ringsOnly, bag, damage);
  const names = (slots: number[]) => slots.map((s) => plan.loadout.get(s)?.item.name ?? null);
  assert.deepEqual(names([7, 8]).sort(), ['Jade Ring', 'Ruby Ring']);
  assert.deepEqual(names([5, 6]).sort(), ['Gold Bracelet', 'Iron Bracelet']);
  // Each bag ring put on once: one in each ring place.
  assert.equal(plan.swaps.filter((s) => s.item.type === RING).length, 2);
  assert.ok(plan.score > plan.currentScore);
  // Keeping the Fine Ring (0-5) over the Jade (0-6) would be worse: it goes.
  assert.ok(!names([7, 8]).includes('Fine Ring'));
});

test('a requirement that only passes after another swap: the ring that lifts DC to 200 first, then the helmet that needs it', () => {
  const helmet = item('War Helm', HELMET, 10, DC(6, 12), { needs: 4, needsAmount: 200 });
  const ring = item('Power Ring', RING, 11, DC(0, 10));
  // Alone, the helmet can't go on (DC 194).
  const alone = optimise(SHOWN, WORN, [helmet], damage);
  assert.deepEqual(alone.swaps, []);
  const plan = optimise(SHOWN, WORN, [helmet, ring], damage);
  assert.deepEqual(plan.swaps.map((s) => s.item.name), ['Power Ring', 'War Helm']);
  assert.ok(plan.totals[9] >= 194 - 4 + 10, String(plan.totals[9]));
  // The helmet first, its requirement fails: with the ring's 10 max DC it passes.
  assert.equal(cantPutOn(helmet, SHOWN, SHOWN.totals), 'needs DC 200');
  assert.equal(cantPutOn(helmet, SHOWN, predict(SHOWN, worn(WORN), swapped(RINGS_ON[0], ring)).totals), null);
});

test('weight limits: a heavier armour only once lighter shoes make room; a weapon too heavy for the hand never', () => {
  const wornLight = [item('Plate Armour', ARMOUR, 1, AC(10, 10), { weight: 15 }), item('Iron Boots', SHOES, 9, {}, { weight: 10 }), item('Dagger', WEAPON, 0, DC(1, 2), { weight: 10 })];
  const char: Character = { ...SHOWN, wear: 90, hand: 10, totals: { ...SHOWN.totals, 74: 100, 75: 50 } };
  const heavy = item('Dragon Armour', ARMOUR, 10, DC(20, 30), { weight: 30 });
  // 90 - 15 + 30 = 105 > 100: not without help.
  assert.deepEqual(optimise(char, wornLight, [heavy], damage).swaps, []);
  const sandals = item('Sandals', SHOES, 11, {}, { weight: 2 });
  assert.deepEqual(optimise(char, wornLight, [heavy, sandals], damage).swaps.map((s) => s.item.name), ['Sandals', 'Dragon Armour']);
  // A great sword weighing 60 against a HandWeight of 50: left in the bag.
  assert.deepEqual(optimise(char, wornLight, [item('Great Sword', WEAPON, 12, DC(50, 90), { weight: 60 })], damage).swaps, []);
});

test('a pair that only together makes a boss survivable: neither alone does, so both are put on', () => {
  const warlord = foeOf(data, 'Jinchon Warlord')!;
  const char: Character = { ...SHOWN, totals: { ...SHOWN.totals, 4: 170, 5: 190, 8: 100, 9: 150, 14: 40, 15: 30, 16: 4, 2: 1000 } };
  const now = fight(fightFromTotals(char), warlord);
  assert.equal(now.survives, false);
  const needed = survivalGap(data, fightFromTotals(char), warlord, { supplies: { potion: null, drinkMs: 1500 } })!.more!;
  const half = Math.ceil(needed / 2);
  // Rings worn give nothing much; each bag piece gives half the AC it takes.
  const wornRings = [item('Old Ring', RING, 7, {}), item('Bone Bracelet', BRACELET, 5, {})];
  const bag = [item('Guard Ring', RING, 10, AC(half, half)), item('Guard Bracelet', BRACELET, 11, AC(half, half))];
  const survives = (f: Fighter) => (fight(f, warlord).survives ? 1 : 0);
  for (const one of bag) assert.deepEqual(optimise(char, wornRings, [one], survives).swaps, [], one.name);
  const plan = optimise(char, wornRings, bag, survives);
  assert.deepEqual(plan.swaps.map((s) => s.item.name).sort(), ['Guard Bracelet', 'Guard Ring']);
  assert.deepEqual([plan.currentScore, plan.score], [0, 1]);
});

/** The character's Fighter straight from their totals. */
function fightFromTotals(char: Character): Fighter {
  const t = char.totals;
  return { cls: char.cls, level: char.level, maxHp: t[2], minAC: t[4], maxAC: t[5], minMR: t[6], maxMR: t[7], minDC: t[8], maxDC: t[9], minMC: t[10], maxMC: t[11], minSC: t[12], maxSC: t[13], accuracy: t[14], agility: t[15], attackSpeed: t[16] };
}

test("this character's worn Battle Necklace (+10 Attack Speed) is kept over the bag's (+15% DC), by what they do at Zuma Temple Lv 5", () => {
  const input: GuideInput = {
    data, me: fightFromTotals(SHOWN), supplies: { potion: null, drinkMs: 1500 }, calibration: UNCALIBRATED, maps: [37], grinder: { level: 48, cls: 0 },
    grindOptions: { maxLevelsAbove: 5 }, bosses: [], rewards: {}, weights: { grind: 1, bosses: 0 }, counts: {},
  };
  const base = worthOf(input, input.me);
  const score = (f: Fighter) => gain(input, base, worthOf(input, f));
  const plan = optimise(SHOWN, WORN, [BAG_NECKLACE], score);
  assert.deepEqual(plan.swaps, []);
  // The other way round, the bag's would be put on: Attack Speed 15 to 5 costs far more than 15% DC brings.
  const swappedIn = predict(SHOWN, worn(WORN), swapped(WORN_NECKLACE, BAG_NECKLACE)).totals;
  assert.ok(score(fightFromTotals({ ...SHOWN, totals: swappedIn })) < -0.1);
  // A working weapon in the bag replaces the broken blade.
  const sword = item('Iron Sword', WEAPON, 13, DC(10, 20));
  assert.deepEqual(optimise(SHOWN, WORN, [BAG_NECKLACE, sword], score).swaps.map((s) => s.item.name), ['Iron Sword']);
});

test('checked against the game: a gear change compared with what was read once the totals settled, and corrections fitted', () => {
  const watch = new GearWatch();
  const user = (totals: Record<number, number>) => ({
    name: 'A', x: 0, y: 0, level: 48, class: 0, maxHp: totals[2], mounted: false,
    combat: { minAC: totals[4], maxAC: totals[5], minMR: totals[6], maxMR: totals[7], minDC: totals[8], maxDC: totals[9], minMC: 0, maxMC: 0, minSC: 0, maxSC: 0, accuracy: totals[14], agility: totals[15], attackSpeed: totals[16] },
    percents: { 84: totals[84], 54: totals[54] },
  });
  const reading = (items: MemoryItem[], totals: Record<number, number>) => ({ user: user(totals), gear: { worn: items, bag: [] } });
  assert.deepEqual(characterOf(reading(WORN, SHOWN.totals))!.totals[8], 138);
  assert.equal(watch.update(reading(WORN, SHOWN.totals), 0), null);
  assert.equal(watch.update(reading(WORN, SHOWN.totals), 2000), null);
  // The necklaces swapped; the game says DC 158-222 (a point under the prediction), Attack Speed 5, HP 1725.
  const after = WORN.map((i) => (i === WORN_NECKLACE ? { ...BAG_NECKLACE, slot: 4 } : i));
  const read = { ...SHOWN.totals, 8: 158, 9: 222, 16: 5, 2: 1725, 84: 15, 54: 15 };
  assert.equal(watch.update(reading(after, read), 3000), null, 'not settled yet');
  const check = watch.update(reading(after, read), 4600)!;
  assert.ok(check);
  assert.equal(describeCheck(check), 'Gear check: HP 1500 predicted 1725, read 1725; DC 138–194 predicted 158–223, read 158–222; Attack Speed 15 predicted 5, read 5');
  // One check: corrections a fifth of the way (MaxDC read 28 of 29 predicted).
  const corrections = gearCorrections(watch.checks);
  assert.equal(corrections[8], 1);
  assert.ok(Math.abs(corrections[9] - (1 + 0.2 * (28 / 29 - 1))) < 1e-9);
  // Nothing changed: no check.
  assert.equal(watch.update(reading(after, read), 9000), null);
});

test('set bonuses: two pieces of a set worn give its bonus, so a weaker pair can beat two better single items', () => {
  const set = { name: 'Warlord', bonuses: [{ pieces: 2, stats: { 9: 12 } }] };
  const wornPair = [item('Old Ring', RING, 7, DC(0, 6)), item('Fine Ring', RING, 8, DC(0, 6))];
  const bag = [item('Warlord Ring', RING, 10, DC(0, 2), { set }), item('Warlord Bracelet', BRACELET, 11, DC(0, 2), { set })];
  // One piece alone is worse than the ring it replaces; the bracelet with no set mate is just DC 0-2.
  assert.deepEqual(setBonusOf([bag[0]]), {});
  assert.deepEqual(setBonusOf(bag), { 9: 12 });
  const plan = optimise(SHOWN, wornPair, bag, damage);
  assert.deepEqual(plan.swaps.map((s) => s.item.name).sort(), ['Warlord Bracelet', 'Warlord Ring']);
  // The ring 4 max DC less, the bracelet (an empty place) 2 more, and the set 12 more: worth it.
  assert.equal(plan.totals[9], SHOWN.totals[9] - 4 + 2 + 12);
});

const setBonusOf = (items: MemoryItem[]) => setBonus(items.map((i, n) => ({ slot: [7, 5][n], item: i })), false);

test("where a bag item is: row and column in the bag's Main tab, counting from 1 (14 columns unless the game says)", () => {
  assert.deepEqual(bagPlace(0), { row: 1, column: 1 });
  assert.deepEqual(bagPlace(13), { row: 1, column: 14 });
  assert.deepEqual(bagPlace(14), { row: 2, column: 1 });
  assert.deepEqual(bagPlace(31, 10), { row: 4, column: 2 });
  const ring = item('Power Ring', RING, 17, DC(0, 6));
  assert.equal(describeSwap({ slot: 8, item: ring, replaces: RINGS_ON[1], fromBag: true }, 14), 'Power Ring for Fine Ring (Ring), bag row 2, column 4');
  // One already worn, moved to another place: no bag place.
  assert.equal(describeSwap({ slot: 8, item: RINGS_ON[0], replaces: null, fromBag: false }), 'Old Ring for nothing (Ring)');
});

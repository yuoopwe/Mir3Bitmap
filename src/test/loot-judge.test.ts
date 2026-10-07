import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemoryItem } from '../main/game-memory';
import { LOOT, cantWear, describeChanges, judgeItem, scoreItem } from '../main/loot-judge';

const WARRIOR = 0, WIZARD = 1, TAOIST = 2;
/** Library.ItemType. */
const WEAPON = 2, HELMET = 5, RING = 8, BRACELET = 7;
/** Library.Stat: DC 8-9, MC 10-11, SC 12-13, AC 4-5, Accuracy 14. */
const dc = (min: number, max: number) => ({ 8: min, 9: max });
const mc = (min: number, max: number) => ({ 10: min, 11: max });

/** An item anyone of level 1 can wear, with these stats as its own (base) and rolled (added). */
function item(name: string, type: number, base: Record<number, number>, changes: Partial<MemoryItem> = {}): MemoryItem {
  return { slot: 0, name, type, rarity: 0, lootLevel: 0, cls: 255, needs: 0, needsAmount: 1, flags: 0, canSell: true, durability: 100, maxDurability: 100, base, added: {}, ...changes };
}

const warrior = { cls: WARRIOR, level: 30 };
const blade = item('Ironforge Blade', WEAPON, dc(16, 38), { slot: 0 });

test('scores: each class weighs its own stats, min/max pairs at their average, own and rolled stats together', () => {
  const sword = item('Sword', WEAPON, dc(10, 20));
  const wand = item('Wand', WEAPON, mc(10, 20));
  // DC 10-20 averages 15, at the Warrior's weight for DC.
  assert.equal(scoreItem(sword, WARRIOR), 15 * LOOT.weights[WARRIOR].DC!);
  assert.ok(scoreItem(sword, WARRIOR) > scoreItem(wand, WARRIOR));
  assert.ok(scoreItem(wand, WIZARD) > scoreItem(sword, WIZARD));
  // A Taoist cares for neither as much as SC.
  assert.ok(scoreItem(item('Charm', WEAPON, { 12: 10, 13: 20 }), TAOIST) > scoreItem(wand, TAOIST));
  // What it rolled counts with its own.
  assert.equal(scoreItem(item('Rolled', WEAPON, dc(10, 20), { added: { 9: 4 } }), WARRIOR), 17 * LOOT.weights[WARRIOR].DC!);
});

test('wearable: the class, the level, and stat requirements against the character\'s stats', () => {
  assert.equal(cantWear(item('Wand', WEAPON, {}, { cls: 2 }), warrior), 'not for this class');
  assert.equal(cantWear(item('Wand', WEAPON, {}, { cls: 2 }), { cls: WIZARD, level: 30 }), null);
  assert.equal(cantWear(item('Big', WEAPON, {}, { needsAmount: 31 }), warrior), 'needs level 31');
  assert.equal(cantWear(item('Big', WEAPON, {}, { needsAmount: 30 }), warrior), null);
  // Needs DC 20 (Library.RequiredType 4): checked against the character's DC; unknown means no.
  const strong = item('Strong', WEAPON, {}, { needs: 4, needsAmount: 20 });
  assert.equal(cantWear(strong, warrior), "needs a stat that isn't known");
  const combat = { maxAC: 0, maxMR: 0, maxDC: 19, maxMC: 0, maxSC: 0 };
  assert.equal(cantWear(strong, { ...warrior, combat }), 'needs DC 20');
  assert.equal(cantWear(strong, { ...warrior, combat: { ...combat, maxDC: 20 } }), null);
  // Not an upgrade however good, but no harm in saying why.
  const verdict = judgeItem(item('Too big', WEAPON, dc(100, 200), { needsAmount: 50 }), [blade], warrior);
  assert.deepEqual([verdict.keep, verdict.upgrade, verdict.reason], [false, false, 'needs level 50']);
});

test('upgrades: better by the margin than what is worn there, or nothing worn there; the reason says how', () => {
  const better = judgeItem(item('Ironforge Greatblade', WEAPON, dc(20, 45), { base: { ...dc(20, 45), 14: 3 } }), [blade], warrior);
  assert.ok(better.upgrade && better.keep);
  assert.equal(better.slot, 0);
  assert.equal(better.reason, `+${Math.round(better.gain * 100)}% over Ironforge Blade (DC 16–38 → 20–45, +3 Acc)`);
  // 4% better: within the margin, so sold.
  const nearly = judgeItem(item('Nearly', WEAPON, dc(16, 40.16)), [blade], warrior);
  assert.ok(nearly.gain > 0 && nearly.gain < LOOT.upgradeMargin);
  assert.ok(!nearly.upgrade && !nearly.keep);
  assert.match(nearly.reason, /^\+4% against Ironforge Blade \(DC 16–38 → 16–40\.16\)$/);
  // Worse.
  assert.match(judgeItem(item('Worse', WEAPON, dc(1, 2)), [blade], warrior).reason, /^-\d+% against Ironforge Blade/);
  // Nothing worn on the head.
  const helmet = judgeItem(item('Cap', HELMET, { 4: 1, 5: 2 }), [blade], warrior);
  assert.deepEqual([helmet.upgrade, helmet.slot, helmet.gain, helmet.reason], [true, 2, Infinity, 'nothing worn as Helmet']);
  // A margin of its own (putting on wants more).
  const fifth = item('Fifth better', WEAPON, dc(16 * 1.2, 38 * 1.2));
  assert.ok(judgeItem(fifth, [blade], warrior).upgrade);
  assert.ok(judgeItem(fifth, [blade], warrior, { margin: 0.25 }).upgrade === false);
});

test('rings and bracelets: against the weaker of the two worn, or an empty place', () => {
  const strongRing = item('Strong Ring', RING, dc(5, 10), { slot: 7 });
  const weakRing = item('Weak Ring', RING, dc(1, 3), { slot: 8 });
  const middling = judgeItem(item('Middling Ring', RING, dc(2, 5)), [strongRing, weakRing], warrior);
  assert.ok(middling.upgrade);
  assert.equal(middling.slot, 8);
  assert.match(middling.reason, /over Weak Ring/);
  // One place empty: that one.
  const one = judgeItem(item('Any Ring', RING, dc(1, 1)), [strongRing], warrior);
  assert.deepEqual([one.upgrade, one.slot], [true, 8]);
  // Bracelets the same, in their own places.
  assert.equal(judgeItem(item('Bangle', BRACELET, dc(1, 1)), [{ ...strongRing, type: BRACELET, slot: 5 }], warrior).slot, 6);
});

test('rarity: Legendary and rarer are kept even when not an upgrade, and say so', () => {
  const legendary = judgeItem(item('Old Relic', WEAPON, dc(1, 2), { rarity: 3 }), [blade], warrior);
  assert.deepEqual([legendary.keep, legendary.upgrade], [true, false]);
  assert.match(legendary.reason, /^Legendary \(-\d+% against Ironforge Blade/);
  // Elite isn't; nor is a rare item of another class... unless rare enough.
  assert.equal(judgeItem(item('Shiny', WEAPON, dc(1, 2), { rarity: 2 }), [blade], warrior).keep, false);
  const wizardsRelic = judgeItem(item('Staff', WEAPON, mc(50, 90), { rarity: 4, cls: 2 }), [blade], warrior);
  assert.deepEqual([wizardsRelic.keep, wizardsRelic.reason], [true, 'Xtreme (not for this class)']);
  // The threshold can be set.
  assert.equal(judgeItem(item('Shiny', WEAPON, dc(1, 2), { rarity: 2 }), [blade], warrior, { keepRarity: 2 }).keep, true);
});

test('changes: only the stats the class weighs, pairs as ranges, the rest as differences', () => {
  const from = item('A', WEAPON, { ...dc(5, 10), 2: 50, 17: 1 });
  const to = item('B', WEAPON, { ...dc(5, 12), 2: 40, 17: 3 });
  // Light (17) isn't weighed: not mentioned.
  assert.equal(describeChanges(from, to, WARRIOR), 'DC 5–10 → 5–12, -10 HP');
  assert.equal(describeChanges(from, from, WARRIOR), '');
});

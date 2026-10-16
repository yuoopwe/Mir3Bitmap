import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { AREA_INDEX, areaView, searchAreas } from '../main/area-index';
import { fight, foeOf, type Fighter } from '../main/combat-model';
import { loadTravelData } from '../main/travel';

const data = loadTravelData(path.join(__dirname, '..', '..', 'game-data', 'travel.json'));
const mapIndex = (name: string) => data.maps.find((m) => m.name === name)!.i;
const BLACK_PALACE_4 = mapIndex('Black Palace Lv 4');

/** A level 48 Warrior as a kill noted one (the character's own stats then). */
const warrior: Fighter = {
  minAC: 126, maxAC: 131, minMR: 61, maxMR: 121, minDC: 306, maxDC: 392, minMC: 0, maxMC: 0, minSC: 0, maxSC: 0,
  accuracy: 35, agility: 49, attackSpeed: 7, maxHp: 1266, cls: 0, level: 48,
};
const weak: Fighter = { ...warrior, minAC: 5, maxAC: 10, minMR: 2, maxMR: 5, minDC: 20, maxDC: 40, maxHp: 300 };

test('search: maps with monsters only, ranked as Travel ranks them, with their monsters\' levels', () => {
  const found = searchAreas(data, 'black palace');
  assert.ok(found.length > 0);
  assert.ok(found.every((a) => /Black Palace/.test(a.label) && / \(monsters lv \d+(–\d+)?\)$/.test(a.label)), found.map((a) => a.label).join(', '));
  assert.ok(found.some((a) => a.map === BLACK_PALACE_4));
  assert.deepEqual(searchAreas(data, ''), []);
});

test('a map: its monsters most common first, with their stats; what their hits and defence need', () => {
  const view = areaView(data, BLACK_PALACE_4, null)!;
  assert.equal(view.name, 'Black Palace Lv 4');
  assert.ok(view.monsters.length > 0);
  const shares = view.monsters.map((m) => m.share);
  assert.deepEqual(shares, [...shares].sort((a, b) => b - a));
  assert.ok(Math.abs(shares.reduce((a, b) => a + b, 0) - 1) < 0.05);
  for (const m of view.monsters) {
    const foe = foeOf(data, m.name)!;
    assert.deepEqual(m.ac, [foe.minAC, foe.maxAC]);
    assert.ok(m.attack.max >= m.attack.min && m.attack.max > 0);
    assert.equal(m.you, undefined);
  }
  // The hits to block are the strongest of those that make up the map; the defence to pierce likewise.
  const deciding = view.monsters.filter((m) => m.share >= AREA_INDEX.minShare);
  assert.equal(view.needs.blockAC, Math.max(...deciding.filter((m) => m.attack.stat === 'DC').map((m) => m.attack.max)));
  assert.equal(view.needs.pierceAC, Math.max(...deciding.map((m) => m.ac[1])));
  assert.equal(view.you, undefined);
  assert.equal(areaView(data, -1, null), null);
});

test('against the character: each fight as the combat model has it, the defence to go without potions, the attack for quick kills', () => {
  const strong = areaView(data, BLACK_PALACE_4, warrior, 'warrre')!;
  assert.equal(strong.you!.who, 'warrre');
  assert.equal(strong.you!.attack.stat, 'DC');
  for (const m of strong.monsters) assert.equal(m.you!.seconds, fight(warrior, foeOf(data, m.name)!).seconds);
  assert.deepEqual([strong.you!.moreAC, strong.you!.moreMR, strong.you!.beyond], [0, 0, false]);
  // Slower than the quick-kill mark: that much more DC brings it there, a point less doesn't.
  const quick = strong.you!.quickAttack!;
  assert.ok(strong.you!.meanSeconds > AREA_INDEX.quickKillSeconds && quick > 0);
  const atDC = (n: number) => areaView(data, BLACK_PALACE_4, { ...warrior, minDC: warrior.minDC + n, maxDC: warrior.maxDC + n })!.you!;
  assert.ok(atDC(quick).meanSeconds <= AREA_INDEX.quickKillSeconds);
  assert.ok(atDC(quick - 1).meanSeconds > AREA_INDEX.quickKillSeconds);
  assert.equal(atDC(quick).quickAttack, 0);

  // A weak character there: more AC needed, fights marked unsurvivable.
  const hard = areaView(data, BLACK_PALACE_4, weak)!;
  assert.ok(hard.you!.moreAC > 0 || hard.you!.beyond);
  assert.ok(hard.monsters.some((m) => !m.you!.survives));
});

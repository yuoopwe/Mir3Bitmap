import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import type { Point } from '../shared/types';
import { LEADS_ON, findBigMap, readBigMap } from '../main/bigmap';
import { ExplorePlanner, PLANNER_DEFAULTS, PLANNER_NAIVE, PlayerTracker } from '../main/explorer';
import { Hunter, type Decision, type TargetFrame } from '../main/hunter';
import { findItems, findLabels, type Label } from '../main/labels';
import {
  HUD_MASKS,
  PANEL_MASKS,
  PLAYER,
  PLAYER_BAR_TEXT,
  PLAYER_HP_BAR,
  PLAYER_MP_BAR,
  TARGET_HP_BAR,
  TARGET_HP_TEXT,
  TARGET_HP_TEXT_AREA,
} from '../main/layout';
import { locatePlayer, nearestMonster, readMinimap } from '../main/minimap';
import { NameBook } from '../main/names';
import { LabelTracker, isSettled } from '../main/sightings';
import { createFrame, playerHpFill, playerMpFill, readBar, targetHpFill, textSignature } from '../main/vision';
import { simulate } from './explore-sim';
import { loadPng } from './png';

// Screenshots live next to the sources; tests run from dist/test.
const fixture = (name: string) => path.join(__dirname, '..', '..', 'src', 'test', name);
const live = loadPng(fixture('fixture-live.png'));
const field = loadPng(fixture('fixture-field.png'));
const minimap = loadPng(fixture('fixture-minimap.png'));

function countByName(labels: Label[]): number[] {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label.fingerprint, (counts.get(label.fingerprint) ?? 0) + 1);
  return [...counts.values()].sort((a, b) => b - a);
}

function near(labels: Label[], x: number, y: number): Label | undefined {
  return labels.find((label) => Math.abs(label.centre.x - x) <= 4 && Math.abs(label.centre.y - y) <= 4);
}

test('finds every overhead name and gives each name one fingerprint', () => {
  const labels = findLabels(live, HUD_MASKS);
  // Silverleaf x9 (one is under the skill bar), Pig x6, Chicken x3, Cow x2, Chestnut Tree x2, Hooking Cat
  assert.deepEqual(countByName(labels), [9, 6, 3, 2, 2, 1]);

  const cows = [near(labels, 913, 684), near(labels, 1105, 556)];
  assert.ok(cows[0] && cows[1]);
  assert.equal(cows[0].fingerprint, cows[1].fingerprint);

  const tree = near(labels, 530, 671);
  assert.ok(tree?.quest, 'Chestnut Tree has a (Quest) line');
  assert.equal(near(labels, 913, 684)?.quest, false);
});

test('ignores HUD text and other players', () => {
  const labels = findLabels(live, HUD_MASKS);
  for (const label of labels) {
    for (const m of HUD_MASKS) {
      const inside = label.centre.x >= m.left && label.centre.x < m.right && label.centre.y >= m.top && label.centre.y < m.bottom;
      assert.ok(!inside, `label at ${label.centre.x},${label.centre.y} is inside a HUD panel`);
    }
  }
  // The player's own green name and khaki guild line under them.
  assert.equal(near(labels, 799, 383), undefined);
  assert.equal(near(labels, 799, 396), undefined);
});

test('stacked quest monsters share a fingerprint', () => {
  const labels = findLabels(field, HUD_MASKS);
  const omas = [near(labels, 796, 351), near(labels, 796, 415)];
  assert.ok(omas[0] && omas[1]);
  assert.equal(omas[0].fingerprint, omas[1].fingerprint);
  assert.ok(omas[0].quest);
});

test('damage numbers are not names', () => {
  // Build "-66" out of the real "-6" drawn over Oma in the field screenshot.
  const frame = createFrame(live.width, live.height);
  frame.pixels.fill(0xff080808);
  const paste = (fromLeft: number, fromRight: number, toLeft: number) => {
    for (let y = 280; y < 292; y++) {
      for (let x = fromLeft; x < fromRight; x++) {
        frame.pixels[(y + 100) * frame.width + toLeft + (x - fromLeft)] = field.pixels[y * field.width + x];
      }
    }
  };
  paste(788, 802, 500); // "-6"
  paste(794, 802, 514); // another "6" after it
  paste(402, 422, 600); // and a real name for comparison ("Pig", rows 280-292 are just background there)
  for (let y = 38; y < 52; y++) {
    for (let x = 402; x < 422; x++) frame.pixels[(y + 400) * frame.width + 600 + (x - 402)] = field.pixels[y * field.width + x];
  }

  const labels = findLabels(frame, []);
  assert.equal(labels.filter((l) => l.centre.y < 420).length, 0, 'the damage number is skipped');
  assert.equal(labels.filter((l) => l.centre.y > 420).length, 1, 'the name next to it is still found');
});

test('reads the minimap: the player, and monsters but not HP bars', () => {
  // No pets: the player is the one sky-blue marker.
  const alone = readMinimap(live, null);
  assert.deepEqual(alone.self, { x: 1490.5, y: 187.5 });
  assert.ok(alone.monsters.length >= 10);
  assert.ok(alone.monsters.every((m) => m.centre.x > 1300), 'only markers on the map, not the HP bar over the player');

  // Pets cover the player's marker; their blob stands in for it.
  const withPets = readMinimap(minimap, null);
  assert.deepEqual(withPets.self, { x: 1359, y: 99 });
  assert.equal(withPets.monsters.length, 6);
  assert.deepEqual(nearestMonster(withPets)?.centre, { x: 1362.5, y: 114.5 });
});

test('finds item boxes on the ground', () => {
  const items = findItems(minimap, HUD_MASKS);
  const at = items.map((item) => `${item.centre.x},${item.centre.y}`).sort();
  assert.deepEqual(at, ['1181,460', '557,524', '941,460'].sort());
  assert.equal(findItems(live, HUD_MASKS).length, 0);
  // Item names aren't monster names.
  assert.equal(findLabels(minimap, HUD_MASKS).length, 0);
});

test('reads the target and player bars', () => {
  // Live: a dead chicken (-2/4) targeted, 33/40 HP, 58/60 MP.
  assert.equal(readBar(live, TARGET_HP_BAR, targetHpFill, TARGET_HP_TEXT), 0);
  assert.ok(Math.abs(readBar(live, PLAYER_HP_BAR, playerHpFill, PLAYER_BAR_TEXT)! - 33 / 40) < 0.03);
  assert.ok(Math.abs(readBar(live, PLAYER_MP_BAR, playerMpFill, PLAYER_BAR_TEXT)! - 58 / 60) < 0.03);
  // Field: Oma at 18/24.
  assert.ok(Math.abs(readBar(field, TARGET_HP_BAR, targetHpFill, TARGET_HP_TEXT)! - 18 / 24) < 0.05);
  // Grass is not a bar.
  assert.equal(readBar(live, { left: 100, right: 300, y: 400 }, targetHpFill), null);
});

test('names over a spell glow are found, and the target frame only hides names while it shows', () => {
  const dungeon = loadPng(fixture('fixture-dungeon.png'));
  assert.ok(near(findLabels(dungeon, HUD_MASKS), 337, 154), 'the Zuma Sharpshooter in its frost glow');
  // The other one stands where the target frame shows up, but the frame isn't showing.
  assert.ok(near(findLabels(dungeon, PANEL_MASKS), 691, 100));
});

// ---- Following names and fighting ----

/** A label made of the '|'-separated glyphs of `text`, centred at `at`. */
function label(text: string, at: Point): Label {
  const keys = text.split('|');
  const width = keys.length * 6;
  const left = at.x - Math.floor(width / 2);
  return {
    box: { left, top: at.y - 4, right: left + width, bottom: at.y + 4 },
    centre: at,
    glyphs: keys.map((key, i) => ({ key, left: left + i * 6, right: left + i * 6 + 4 })),
    width,
    fingerprint: text,
    quest: false,
  };
}

const at = (dx: number, dy = 0): Point => ({ x: PLAYER.x + dx, y: PLAYER.y + dy });

/** The target frame showing `name` at `hp`. */
const showing = (name: string, hp: number): TargetFrame => ({ hp, name, image: () => `image of ${name}` });

/** Feeds the hunter a scan every 200 ms, like the bot does, attacking with each click (melee). */
class Scene {
  readonly hunter: Hunter;
  readonly tracker = new LabelTracker();
  now = 0;

  constructor(readonly names = new NameBook(() => {})) {
    this.hunter = new Hunter(names, PLAYER);
  }

  scan(labels: Label[], frame: TargetFrame | null): Decision {
    this.now += 200;
    const decision = this.hunter.think(this.tracker.update(labels, this.now), frame, this.now);
    if (decision.kind === 'attack' && !decision.select) this.hunter.attacked();
    return decision;
  }

  /** Scans while the hunter keeps attacking, for up to `ms`. */
  fight(labels: Label[], frame: TargetFrame | null, ms: number): Decision {
    let decision = this.scan(labels, frame);
    for (let spent = 200; decision.kind === 'attack' && spent < ms; spent += 200) decision = this.scan(labels, frame);
    return decision;
  }

  /** Three scans: long enough for new names to be worth attacking. */
  settle(labels: Label[], frame: TargetFrame | null): Decision {
    this.scan(labels, frame);
    this.scan(labels, frame);
    return this.scan(labels, frame);
  }
}

test('waits a moment for new names, then goes for the nearest, preferring known monsters', () => {
  const scene = new Scene();
  const herb = label('h|e|r|b', at(50));
  const pig = label('p|i|g', at(150));
  const first = scene.scan([herb, pig], null);
  assert.ok(first.kind === 'search' && first.pending, 'just appeared: could be combat text');
  scene.scan([herb, pig], null);
  const go = scene.scan([herb, pig], null);
  assert.ok(go.kind === 'attack' && go.select, 'clicks it to bring it up in the target frame');
  assert.equal(scene.hunter.target?.labelFingerprint, 'h|e|r|b');

  // Once pigs are known to die, a pig wins over a nearer unknown name.
  const names = new NameBook(() => {});
  names.see('Pig', () => '');
  names.recordKill('Pig', 'p|i|g');
  const veteran = new Scene(names);
  veteran.settle([herb, pig], null);
  assert.equal(veteran.hunter.target?.labelFingerprint, 'p|i|g');
});

test('floating combat text is never a target', () => {
  const scene = new Scene();
  // "Miss" rising off a monster's head.
  for (let i = 0; i < 6; i++) assert.equal(scene.scan([label('m|i|s|s', at(60, -4 * i))], null).kind, 'search');
});

test('sticks with its target while its name is covered or changes, until the frame shows it dead', () => {
  const scene = new Scene();
  const pig = label('p|i|g', at(60));
  const wolf = label('w|o|l|f', at(200, 60));
  assert.equal(scene.settle([pig, wolf], null).kind, 'attack');
  // (Just after the click the frame may still be about something else.)
  scene.scan([pig, wolf], showing('Pig', 1));
  const confirmed = scene.scan([pig, wolf], showing('Pig', 1));
  assert.ok(confirmed.kind === 'attack' && !confirmed.select, 'the frame shows it: fight it');

  // A damage number runs into its name: still the pig, aimed at its own part of the label.
  const covered = scene.scan([label('p|i|g|-|6', at(66)), wolf], showing('Pig', 0.7));
  assert.ok(covered.kind === 'attack' && Math.abs(covered.point.x - at(60).x) <= 3, JSON.stringify(covered));
  // Its name is hidden for a moment: still fighting it, not switching to the wolf.
  const hidden = scene.scan([wolf], showing('Pig', 0.4));
  assert.ok(hidden.kind === 'attack' && Math.abs(hidden.point.x - at(60).x) <= 10, JSON.stringify(hidden));
  assert.equal(scene.scan([pig, wolf], showing('Pig', 0.2)).kind, 'attack');
  assert.equal(scene.scan([wolf], showing('Pig', 0)).kind, 'killed');

  // Learned: pigs are monsters, and that overhead name is a pig.
  assert.ok(scene.names.isKnownMonster('Pig'));
  assert.equal(scene.names.judgeLabel(pig).kind, 'monster');
  assert.deepEqual(
    scene.names.list().map((entry) => [entry.image, entry.kills]),
    [['image of Pig', 1]],
  );
});

test('a dead previous target still in the frame is not mistaken for the next one', () => {
  const scene = new Scene();
  const pig = label('p|i|g', at(60));
  const dead = showing('Pig', 0);
  scene.settle([pig], dead);
  for (let i = 0; i < 3; i++) {
    const decision = scene.scan([pig], dead);
    assert.ok(decision.kind === 'attack' && decision.select, 'neither confirmed nor a kill');
  }
  assert.equal(scene.scan([pig], showing('Pig', 1)).kind, 'attack');
  scene.scan([pig], showing('Pig', 0.5));
  assert.equal(scene.scan([], showing('Pig', 0)).kind, 'killed');
});

test('something that never loses HP is written off after three fights, then left alone', () => {
  const scene = new Scene();
  const herb = label('h|e|r|b', at(40));
  for (let round = 1; round <= 3; round++) {
    // Long after the last round; the frame still shows the herb from then.
    scene.now += 120_000;
    const before = round === 1 ? null : showing('Silverleaf', 1);
    assert.equal(scene.settle([herb], before).kind, 'attack');
    const decision = scene.fight([herb], showing('Silverleaf', 1), 20_000);
    assert.ok(decision.kind === 'gaveUp' && decision.reason === 'harmless', `round ${round}: ${JSON.stringify(decision)}`);
  }
  assert.equal(scene.names.isAttackable('Silverleaf'), false);
  scene.now += 120_000;
  for (let i = 0; i < 5; i++) assert.equal(scene.scan([herb], showing('Silverleaf', 1)).kind, 'search', 'skipped without clicking it');

  scene.names.setRule('Silverleaf', 'attack');
  assert.equal(scene.scan([herb], null).kind, 'attack', 'unless the user says otherwise');
});

test('a name that brings up nothing when clicked is left alone after two tries', () => {
  const scene = new Scene();
  const rock = label('r|o|c|k', at(40));
  for (let round = 1; round <= 2; round++) {
    scene.now += 120_000;
    assert.equal(scene.settle([rock], null).kind, 'attack');
    const decision = scene.fight([rock], null, 5000);
    assert.ok(decision.kind === 'gaveUp' && decision.reason === 'nothing', JSON.stringify(decision));
  }
  assert.equal(scene.names.judgeLabel(rock).kind, 'harmless');
});

test('HP lost by the monster still in the frame is not credited to what was clicked', () => {
  // Pets finish off a wolf (still in the target frame) while the bot clicks a herb that can't be targeted.
  const scene = new Scene();
  const herb = label('h|e|r|b', at(40));
  scene.settle([herb], showing('Wolf', 0.9));
  scene.scan([herb], showing('Wolf', 0.6));
  scene.scan([herb], showing('Wolf', 0.3));
  scene.scan([herb], showing('Wolf', 0));
  assert.notEqual(scene.names.judgeLabel(herb).kind, 'monster', 'the herb is not taken for a wolf');
});

test("damage the HP bar can't show still counts: the HP text changes", () => {
  // Oma at 18/24 and a dead chicken at -2/4 have different text; the same frame always reads the same.
  assert.equal(textSignature(field, TARGET_HP_TEXT_AREA), textSignature(field, TARGET_HP_TEXT_AREA));
  assert.notEqual(textSignature(field, TARGET_HP_TEXT_AREA), textSignature(live, TARGET_HP_TEXT_AREA));

  // The bar's end is hidden under the text, so the bar reads the same while the numbers go down.
  const scene = new Scene();
  const pig = label('p|i|g', at(40));
  const frame = (text: string): TargetFrame => ({ hp: 0.52, name: 'Pig', hpText: text, image: () => '' });
  scene.settle([pig], null);
  for (let hp = 20; hp > 10; hp--) {
    const decision = scene.fight([pig], frame(`${hp} / 24`), 2000);
    assert.equal(decision.kind, 'attack', `still fighting at ${hp} HP`);
  }
  assert.equal(scene.names.list()[0].strikes, 0);
});

test('gives up on a target whose HP stops going down, and leaves it for a while', () => {
  const scene = new Scene();
  const pig = label('p|i|g', at(100));
  scene.settle([pig], null);
  scene.scan([pig], showing('Pig', 1));
  scene.scan([pig], showing('Pig', 1));
  scene.scan([pig], showing('Pig', 0.8));
  const decision = scene.fight([pig], showing('Pig', 0.8), 20_000);
  assert.ok(decision.kind === 'gaveUp' && decision.reason === 'stuck', JSON.stringify(decision));
  assert.equal(scene.scan([pig], showing('Pig', 0.8)).kind, 'search', 'left alone for a while');
  assert.ok(scene.names.isAttackable('Pig'), 'but not written off');
});

test('a target is not blamed when nothing was attacking it, or it was never in reach', () => {
  // No melee and no attack spell: nothing hurts it, through no fault of its own.
  const names = new NameBook(() => {});
  const hunter = new Hunter(names, PLAYER);
  const tracker = new LabelTracker();
  const herb = label('h|e|r|b', at(40));
  let decision: Decision = { kind: 'search', pending: false };
  for (let now = 200; now <= 30_000 && decision.kind !== 'gaveUp'; now += 200) {
    decision = hunter.think(tracker.update([herb], now), now < 800 ? null : showing('Silverleaf', 1), now);
  }
  assert.ok(decision.kind === 'gaveUp' && decision.reason === 'noDamage', JSON.stringify(decision));
  assert.equal(names.list()[0].strikes, 0);

  // Fighting hand to hand across a wall: the character never gets near it.
  const scene = new Scene();
  const orc = label('o|r|c', at(300));
  scene.settle([orc], null);
  const walled = scene.fight([orc], showing('Orc', 1), 30_000);
  assert.ok(walled.kind === 'gaveUp' && walled.reason === 'noDamage', JSON.stringify(walled));
  assert.equal(scene.names.list()[0].strikes, 0);

  // Casting from afar, the same fight does count against it.
  const caster = new Scene();
  caster.hunter.melee = false;
  caster.settle([orc], null);
  const cast = caster.fight([orc], showing('Orc', 1), 30_000);
  assert.ok(cast.kind === 'gaveUp' && cast.reason === 'harmless', JSON.stringify(cast));
});

test('names run together or partly hidden are judged by the names already known', () => {
  const names = new NameBook(() => {});
  names.see('Chicken', () => '');
  names.recordKill('Chicken', 'c|h|i|c|k|e|n');
  names.see('Silverleaf', () => '');
  for (let i = 0; i < 3; i++) names.recordStrike('Silverleaf', 's|i|l|v|e|r');

  // A pig's name run into a chicken's: aim at the chicken's part.
  const pigChicken = label('p|i|g|c|h|i|c|k|e|n', at(0));
  const merged = names.judgeLabel(pigChicken);
  assert.equal(merged.kind, 'monster');
  assert.equal(merged.label.fingerprint, 'c|h|i|c|k|e|n');
  assert.ok(merged.label.centre.x > pigChicken.centre.x, 'the chicken is the right-hand part');

  // Half of a chicken's name showing; too little of it to tell.
  assert.equal(names.judgeLabel(label('c|h|i|c', at(0))).kind, 'monster');
  assert.equal(names.judgeLabel(label('c|h', at(0))).kind, 'unknown');

  // A herb's name run into an unknown one: the unknown one is still worth a look.
  const herbWolf = names.judgeLabel(label('s|i|l|v|e|r|w|o|l|f', at(0)));
  assert.equal(herbWolf.kind, 'unknown');
  assert.equal(herbWolf.label.fingerprint, 'w|o|l|f');
  assert.equal(names.judgeLabel(label('s|i|l|v|e|r', at(0))).kind, 'harmless');
});

test("names saved by the old version: confirmed kills and the user's rules are kept, guesses dropped", () => {
  const names = new NameBook(() => {});
  names.load([
    { fingerprint: 't|i|g|e|r', glyphs: ['t', 'i', 'g', 'e', 'r'], width: 30, image: 'tiger.png', rule: 'auto', kills: 158, strikes: 1, frameName: 'Tiger Snake' },
    // A pet's kill credited to a herb that had been clicked.
    { fingerprint: 's|t|o|r|m', glyphs: ['s', 't', 'o', 'r', 'm'], width: 30, image: 'storm.png', rule: 'auto', kills: 1, strikes: 0, frameName: 'Tiger Snake' },
    // Wrongly written off.
    { fingerprint: 'p|i|g', glyphs: ['p', 'i', 'g'], width: 18, image: 'pig.png', rule: 'auto', kills: 0, strikes: 2 },
    // The user's pet, set to "Never attack".
    { fingerprint: 'd|a|v|e', glyphs: ['d', 'a', 'v', 'e'], width: 24, image: 'dave.png', rule: 'ignore', kills: 0, strikes: 0 },
  ]);
  const check = (book: NameBook) => {
    assert.equal(book.judgeLabel(label('t|i|g|e|r', at(0))).kind, 'monster');
    assert.equal(book.judgeLabel(label('s|t|o|r|m', at(0))).kind, 'unknown');
    assert.equal(book.judgeLabel(label('p|i|g', at(0))).kind, 'unknown', 'pigs are no longer skipped');
    assert.equal(book.judgeLabel(label('d|a|v|e', at(0))).kind, 'harmless');
    assert.deepEqual(
      book.list().map((entry) => [entry.image, entry.kills, entry.attacking]),
      [['tiger.png', 158, true], ['dave.png', 0, false]],
    );
  };
  check(names);

  // It all survives saving and loading...
  const reloaded = new NameBook(() => {});
  reloaded.load(JSON.parse(JSON.stringify(names.toJSON())));
  check(reloaded);
  // ...and the target frame's own picture of the name replaces the old one once seen.
  reloaded.see('Tiger Snake', () => 'frame.png');
  assert.equal(reloaded.list()[0].image, 'frame.png');
});

test('names are followed from scan to scan even as their pixels change', () => {
  const tracker = new LabelTracker();
  const [pig] = tracker.update([label('p|i|g', { x: 500, y: 400 })], 0);
  // The pig walks a little and a damage number covers part of its name.
  const [covered] = tracker.update([label('p|i|-', { x: 512, y: 404 })], 200);
  assert.equal(covered.id, pig.id);
  // A cow turns up next to it: each keeps its own sighting.
  const both = tracker.update([label('p|i|g', { x: 515, y: 405 }), label('c|o|w', { x: 560, y: 405 })], 400);
  assert.equal(both[0].id, pig.id);
  assert.notEqual(both[1].id, pig.id);
  assert.ok(isSettled(both[0], 400));
  assert.ok(!isSettled(both[1], 400), 'the cow has only just appeared');
});

// ---- Big map ----

test('finds the big map panel only when it is open', () => {
  assert.deepEqual(findBigMap(loadPng(fixture('fixture-bigmap-live.png'))), { left: 393, top: 161, right: 1207, bottom: 767 });
  assert.equal(findBigMap(live), null);
  assert.equal(findBigMap(minimap), null);
});

test('reads how much of the map is explored and where the unexplored edges are', () => {
  // The game said 61% explored here, and 17% on the (slightly scaled) screenshot.
  const liveMap = loadPng(fixture('fixture-bigmap-live.png'));
  const reading = readBigMap(liveMap, findBigMap(liveMap)!);
  assert.ok(Math.abs(reading.explored - 0.55) < 0.05, `explored ${reading.explored}`);
  const near = (x: number, y: number) => reading.frontiers.some((f) => Math.hypot(f.point.x - x, f.point.y - y) < 20);
  assert.ok(near(570, 278), 'the corridor heading up-left past the player');
  assert.ok(near(1026, 614), 'the exit on the right');
  assert.ok(reading.frontiers.length <= 10, 'walls of explored corridors are not edges');

  const early = loadPng(fixture('fixture-bigmap.png'));
  const earlyReading = readBigMap(early, findBigMap(early)!);
  assert.ok(Math.abs(earlyReading.explored - 0.17) < 0.04, `explored ${earlyReading.explored}`);
  assert.ok(earlyReading.frontiers.length >= 3);
});

test('plans a route along the corridors to the nearest unexplored edge', () => {
  const liveMap = loadPng(fixture('fixture-bigmap-live.png'));
  const map = readBigMap(liveMap, findBigMap(liveMap)!);
  // The player (with pets) is near the top-left; the closest edge is the corridor heading up-left.
  const step = new ExplorePlanner().plan(map, { x: 600, y: 312 });
  assert.ok(step);
  assert.ok(Math.hypot(step.target.x - 570, step.target.y - 278) < 20, JSON.stringify(step.target));

  // Skipping that edge picks another one instead...
  const next = new ExplorePlanner().plan(map, { x: 600, y: 312 }, [step.target]);
  assert.ok(next && Math.hypot(next.target.x - step.target.x, next.target.y - step.target.y) >= 30);

  // ...unless every edge is being skipped: then any edge beats standing still.
  const all = map.frontiers.map((f) => f.point);
  assert.ok(new ExplorePlanner().plan(map, { x: 600, y: 312 }, all));

  // Standing in the void (not on the map's ground) far from anything: no route.
  assert.equal(new ExplorePlanner().plan(map, { x: 1150, y: 230 }), null);
});

test('keeps heading for the same edge instead of turning round for one slightly nearer', () => {
  const liveMap = loadPng(fixture('fixture-bigmap-live.png'));
  const map = readBigMap(liveMap, findBigMap(liveMap)!);
  const planner = new ExplorePlanner();
  // From the left-hand corridor, commit to whatever is nearest...
  const first = planner.plan(map, { x: 520, y: 470 })!;
  // ...then from a spot a little way off, where another edge is about as near: stay committed.
  const later = planner.plan(map, { x: 545, y: 455 })!;
  assert.ok(Math.hypot(later.target.x - first.target.x, later.target.y - first.target.y) < 36);
  // A planner that re-picks every time isn't bound by that, but must still return a route.
  assert.ok(new ExplorePlanner(PLANNER_NAIVE).plan(map, { x: 545, y: 455 }));
});

test('steers for the farthest point it can run to in a straight line', () => {
  const liveMap = loadPng(fixture('fixture-bigmap-live.png'));
  const map = readBigMap(liveMap, findBigMap(liveMap)!);
  const self = { x: 1000, y: 640 };
  const sighted = new ExplorePlanner(PLANNER_DEFAULTS).plan(map, self)!;
  const fixed = new ExplorePlanner({ ...PLANNER_DEFAULTS, lineOfSight: false }).plan(map, self)!;
  const reach = (p: { x: number; y: number }) => Math.hypot(p.x - self.x, p.y - self.y);
  assert.ok(reach(sighted.waypoint) >= reach(fixed.waypoint), `${reach(sighted.waypoint)} vs ${reach(fixed.waypoint)}`);
});

test('finds the player on the map, preferring their own marker over the pets around them', () => {
  const panel = { left: 1300, top: 0, right: 1600, bottom: 300 };
  // No pets: the sky-blue marker.
  const alone = locatePlayer(live, panel, null)!;
  assert.ok(Math.hypot(alone.x - 1490.5, alone.y - 187.5) < 2, JSON.stringify(alone));

  // Pets covering the marker: the pets gathered at the last known position.
  const crowd = locatePlayer(minimap, { left: 1280, top: 0, right: 1600, bottom: 240 }, { x: 1359, y: 99 })!;
  assert.ok(Math.hypot(crowd.x - 1359, crowd.y - 99) < 6, JSON.stringify(crowd));

  // Small wobble is smoothed; a big jump (a teleport) is taken as it is.
  const wobble = locatePlayer(live, panel, { x: 1480, y: 185 })!;
  assert.ok(wobble.x > 1480 && wobble.x < 1490.5, JSON.stringify(wobble));
});

test('exploring a real map: the planner beats the old way of steering', () => {
  // A rough simulation on the Zuma Temple capture (see explore-sim.ts): steps to uncover 80%.
  const start = { x: 600, y: 312 };
  const capture = fixture('fixture-bigmap-live.png');
  const run = (planner: typeof PLANNER_DEFAULTS, stretchedSteering: boolean) =>
    simulate(capture, start, { planner, stretchedSteering, goal: 0.8, maxSteps: 900, seed: 1, positionWobble: 12 });
  const old = run(PLANNER_NAIVE, true);
  const now = run(PLANNER_DEFAULTS, false);
  assert.ok(now.reachedGoal, `explored ${now.explored}`);
  assert.ok(now.steps < old.steps, `${now.steps} steps vs ${old.steps} the old way`);
  assert.ok(now.stuckSteps < old.stuckSteps, `${now.stuckSteps} stuck vs ${old.stuckSteps}`);
});

test('a briefly hidden marker (under a map icon) is remembered, then given up on', () => {
  const tracker = new PlayerTracker();
  assert.equal(tracker.update(null, 0).state, 'lost', 'nothing to remember yet');
  assert.deepEqual(tracker.update({ x: 310, y: 468 }, 1000), { position: { x: 310, y: 468 }, state: 'seen' });

  // Standing on an icon: keep planning from the last position so the bot moves off it...
  assert.deepEqual(tracker.update(null, 1300), { position: { x: 310, y: 468 }, state: 'remembered' });
  assert.equal(tracker.update(null, 5000).state, 'remembered');
  // ...but not forever.
  assert.deepEqual(tracker.update(null, 6400), { position: null, state: 'lost' });

  // Seen again: back to normal, with a fresh allowance next time.
  assert.equal(tracker.update({ x: 330, y: 470 }, 7000).state, 'seen');
  assert.equal(tracker.update(null, 11000).state, 'remembered');
});

test('late in a map: every fogged area has an edge, and the estimate matches the game', () => {
  // Zuma Temple Lv4 at 75% and 85% (the game's figures).
  for (const [name, game] of [['fixture-lv4-75.png', 0.75], ['fixture-lv4-85.png', 0.85]] as const) {
    const frame = loadPng(fixture(name));
    const map = readBigMap(frame, findBigMap(frame)!);
    assert.ok(Math.abs(map.explored - game) < 0.04, `${name}: estimate ${map.explored} vs ${game}`);
    // The big fogged area at the bottom left must be found, not just one far-off edge.
    assert.ok(map.frontiers.some((f) => f.point.x < 200 && f.point.y > 440), `${name}: bottom-left fog has an edge`);
    assert.ok(map.frontiers.length >= 6, `${name}: ${map.frontiers.length} edges`);
  }
});

test('an edge already seen from close by is dark ground, not fog, and is left alone', () => {
  const frame = loadPng(fixture('fixture-lv4-85.png'));
  const map = readBigMap(frame, findBigMap(frame)!);
  const planner = new ExplorePlanner();
  const edge = map.frontiers[0].point;
  assert.ok(planner.openFrontiers(map).some((f) => f.point === edge));
  // Having stood right by it (and it still looks fogged), it's no longer worth chasing.
  planner.plan(map, { x: edge.x + 10, y: edge.y });
  assert.ok(!planner.openFrontiers(map).some((f) => f.point === edge));
  // A new map starts with a clean slate.
  planner.reset();
  assert.ok(planner.openFrontiers(map).some((f) => f.point === edge));
});

test("a maze with narrow corridors, in the panel layout with the buttons under the map", () => {
  // Temple of Kings Floor 3: the game said 14% explored. Its corridors are a cell or two wide.
  const frame = loadPng(fixture('fixture-bigmap-narrow.png'));
  const panel = findBigMap(frame)!;
  const map = readBigMap(frame, panel);
  // The map fills the panel here (its buttons are in a bar underneath), so none of it is cut off...
  assert.ok(map.content.top - panel.top <= 4 && panel.bottom - map.content.bottom <= 4, JSON.stringify({ panel, content: map.content }));
  // ...whereas with the buttons over the map, they're left out.
  const overlaid = loadPng(fixture('fixture-bigmap-live.png'));
  assert.equal(readBigMap(overlaid, findBigMap(overlaid)!).content.top - findBigMap(overlaid)!.top, 42);

  assert.ok(Math.abs(map.explored - 0.14) < 0.03, `explored ${map.explored}`);
  // Every corridor leading off the explored part is an edge, not just the odd thick patch.
  assert.ok(map.frontiers.length >= 6, `${map.frontiers.length} edges`);
  assert.ok(map.frontiers.filter((f) => f.reach === LEADS_ON).length >= 4);
});

test('in a maze, side corridors right beside the path walked are still explored', () => {
  const frame = loadPng(fixture('fixture-bigmap-narrow.png'));
  const map = readBigMap(frame, findBigMap(frame)!);
  const planner = new ExplorePlanner();
  const self = { x: 720, y: 505 };
  const step = planner.plan(map, self)!;
  assert.ok(step, 'a route to an unexplored corridor');
  assert.ok(Math.hypot(step.waypoint.x - self.x, step.waypoint.y - self.y) >= 18, 'steers well ahead along the corridor, not a cell at a time');

  // The game only uncovers what's in view, so a corridor branching off one just walked down is still fogged.
  const branch = map.frontiers.find((f) => f.reach === LEADS_ON)!;
  planner.plan(map, { x: branch.point.x + 10, y: branch.point.y });
  assert.ok(planner.openFrontiers(map).includes(branch), 'not written off as dark ground');
});

test('random teleport: used when far from unexplored ground, not when next to it', () => {
  const frame = loadPng(fixture('fixture-lv4-85.png'));
  const map = readBigMap(frame, findBigMap(frame)!);
  const planner = new ExplorePlanner();
  // Up in the top-right, every unexplored area is a long walk away: worth a re-roll.
  assert.equal(planner.shouldReroll(map, { x: 650, y: 150 }), true);
  // Right by an unexplored edge: just walk.
  const edge = map.frontiers[0].point;
  assert.equal(planner.shouldReroll(map, { x: edge.x, y: edge.y - 8 }), false);
});

test('exploring with the free random teleport is quicker late in a map', () => {
  // Zuma Temple Lv4 from 75%, where the random teleport is already unlocked.
  const options = { planner: PLANNER_DEFAULTS, stretchedSteering: false, goal: 0.95, maxSteps: 1500, seed: 2, positionWobble: 12 };
  const start = { x: 310, y: 468 };
  const walking = simulate(fixture('fixture-lv4-75.png'), start, options);
  const rerolling = simulate(fixture('fixture-lv4-75.png'), start, { ...options, reroll: { unlockAt: 0.6, costSteps: 2, maxInRow: 6 } });
  assert.ok(rerolling.reachedGoal);
  assert.ok(rerolling.rerolls > 0);
  assert.ok(rerolling.steps < walking.steps, `${rerolling.steps} steps with re-rolls vs ${walking.steps} walking`);
});

// ---- Game memory ----

import { tileToScreen } from '../main/game-memory';

test("a map tile's place on screen, as measured in game (Co Ords under the mouse)", () => {
  const user = { x: 146, y: 202 };
  // The mouse at (800, 415) is over the player's own tile; one tile right is (848, ...), one down (..., 447).
  const own = tileToScreen(user, 146, 202);
  assert.ok(Math.abs(own.x - 800) < 24 && Math.abs(own.y - 415) < 16, JSON.stringify(own));
  const right = tileToScreen(user, 147, 202);
  assert.ok(Math.abs(right.x - 848) < 24 && Math.abs(right.y - 415) < 16, JSON.stringify(right));
  const below = tileToScreen(user, 146, 203);
  assert.ok(Math.abs(below.x - 800) < 24 && Math.abs(below.y - 447) < 16, JSON.stringify(below));
});

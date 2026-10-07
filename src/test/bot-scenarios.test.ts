/**
 * The bot's real loops (Travel, Explore, Quests, Grind, Hunt) run against the
 * fake game (fake-game.ts): behaviour that only shows when the whole thing
 * runs, checked without the live game. Each scenario is short and seeded.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseGrindMap } from '../main/grind';
import { GrindLog } from '../main/grind-log';
import { VK } from '../main/input';
import { loadTravelData } from '../main/travel';
import { play, testSettings } from './bot-harness';
import { BAG_KEY, FakeGame, RUN_DEAD_ZONE, openMap, type FakeEvent, type FakeGameSetup, type FakeItem } from './fake-game';
import { loadMapFixture } from './map-fixtures';

const data = loadTravelData();
const bichon = loadMapFixture('bichon-province');
const BICHON = 1;
const TOWN_HALL = 2;
const LEFT_WING = 3;
const STONE = data.npcs.find((n) => n.map === BICHON && n.stone)!;

/** A game on Bichon Province (its real walls), the player where the saved map has them unless said. */
function onBichon(setup: Partial<FakeGameSetup> = {}, at: { x: number; y: number } = bichon.player, player: Partial<FakeGameSetup['player']> = {}): FakeGame {
  return new FakeGame({ maps: [bichon.map], ...setup, player: { map: BICHON, ...at, level: 24, ...player } });
}

/** A map no link leads to: 60 x 40, a wall across the middle open at its right-hand end. */
function openMapWithWall() {
  const map = openMap(9001, 'Test Field', 60, 40);
  for (let x = 0; x < 50; x++) {
    const i = 20 * map.width + x;
    map.walls[i >> 3] |= 1 << (i & 7);
  }
  return map;
}

const of = <T extends FakeEvent['type']>(game: FakeGame, type: T) => game.events.filter((e): e is Extract<FakeEvent, { type: T }> => e.type === type);

/** What every run checks: the cursor was never too close to run, and no guard was ever attacked. */
function checkAlways(game: FakeGame): void {
  assert.deepEqual(of(game, 'runTooClose'), [], `the cursor came within ${RUN_DEAD_ZONE} tiles while running`);
  assert.deepEqual(of(game, 'attack').filter((a) => a.disposition === 0), [], 'a guard was attacked');
  // M only ever pressed standing still.
  assert.deepEqual(of(game, 'mount').filter((m) => m.moving), [], 'M pressed mid-move');
}

test('Travel: across three maps by their links, running, and not straight back out on arrival', async () => {
  const game = onBichon();
  const { message } = await play(game, (bot) => bot.startTravel(`map:${LEFT_WING}`));
  assert.equal(message, 'Arrived at Left Wing');
  assert.deepEqual(of(game, 'mapChange').map((c) => [c.from, c.to, c.via]), [[BICHON, TOWN_HALL, 'link'], [TOWN_HALL, LEFT_WING, 'link']]);
  // The Town Hall landing is next to the way back to Bichon: never taken.
  const landing = data.links.find((l) => l.from === BICHON && l.to === TOWN_HALL)!.land;
  const back = data.links.find((l) => l.from === TOWN_HALL && l.to === BICHON)!.exit;
  assert.ok(back.some(([x, y]) => Math.max(Math.abs(x - landing[0]), Math.abs(y - landing[1])) === 1));
  // Runs did the moving, mounted where allowed (Bichon) and on foot indoors.
  const runs = of(game, 'move').filter((m) => m.run);
  assert.ok(runs.length > 10, `${runs.length} strides`);
  assert.ok(runs.some((m) => m.map === BICHON && Math.max(Math.abs(m.to.x - m.from.x), Math.abs(m.to.y - m.from.y)) === 3));
  assert.ok(of(game, 'mount').some((m) => m.mounted && m.map === BICHON));
  checkAlways(game);
});

test("Travel: arriving beside the way back, a spot beyond it is reached round it, not through it", async () => {
  // Town Hall's landing from Bichon is beside its way back (19-21, 51-53); the spot is past it, down and left.
  const game = onBichon();
  const { message } = await play(game, (bot) => bot.startTravel(`spot:${TOWN_HALL}:12:60`));
  assert.match(message, /^Arrived/);
  assert.deepEqual(of(game, 'mapChange').map((c) => [c.from, c.to]), [[BICHON, TOWN_HALL]]);
  assert.ok(Math.max(Math.abs(game.player.x - 12), Math.abs(game.player.y - 60)) <= 2);
  checkAlways(game);
});

test('Travel: by a waypoint stone, also one that asks Waypoints / Quests first', async () => {
  for (const menu of [undefined, ['waypoints', 'quests'] as ('waypoints' | 'quests')[]]) {
    const game = onBichon({ npcs: [{ id: STONE.id, menu }] }, { x: STONE.at![0] + 5, y: STONE.at![1] + 3 });
    const { message } = await play(game, (bot) => bot.startTravel('map:6'));
    assert.equal(message, 'Arrived at Prajna Village', `with menu ${menu}`);
    assert.deepEqual(of(game, 'mapChange').map((c) => [c.from, c.to, c.via]), [[BICHON, 6, 'waypoint']]);
    if (menu) assert.ok(of(game, 'button').some((b) => b.name === 'Waypoints'));
    // Shut once used.
    assert.ok(!game.isOpen('waypoints') && !game.isOpen('npcMenu'));
    checkAlways(game);
  }
});

test("Travel: chickens by the stone don't start a fight, and the window is shut after a waypoint that isn't unlocked", async () => {
  const [sx, sy] = STONE.at!;
  // Chickens round the stone come at the player on the way there.
  const chickens = [[1, 1], [-1, 1], [2, 0], [0, 2], [1, -1], [3, 3]].map(([dx, dy]) => ({ name: 'Chicken', x: sx + dx, y: sy + dy, level: 1, aggressive: true }));
  const game = onBichon({ npcs: [{ id: STONE.id }], monsters: chickens, waypoints: ['Prajna Village'] }, { x: sx + 9, y: sy + 7 });
  const closedAfterTry = () => of(game, 'window').some((w) => w.name === 'waypoints' && !w.open);
  // Bichon Castle by waypoint is quickest, but it isn't unlocked.
  const { met } = await play(game, (bot) => bot.startTravel('map:259'), { settings: { fightInTheWay: true }, until: closedAfterTry, limitMs: 60_000 });
  assert.ok(met, 'the waypoint window was opened and shut again');
  assert.ok(!game.isOpen('waypoints'));
  assert.deepEqual(of(game, 'attack'), []);
  checkAlways(game);
});

test('Travel: a guard in the way is never attacked; other monsters in the way are', async () => {
  const { x, y } = bichon.player;
  const game = onBichon({
    monsters: [
      { name: 'Guard', x: x + 1, y, level: 50, disposition: 0 },
      { name: 'Guard', x, y: y + 1, level: 50, disposition: 0 },
      { name: 'Wolf', x: x - 1, y: y - 1, hits: 2, level: 22 },
      { name: 'Wolf', x: x + 1, y: y - 1, hits: 2, level: 22 },
    ],
  });
  const { message } = await play(game, (bot) => bot.startTravel(`map:${TOWN_HALL}`), { settings: { fightInTheWay: true } });
  assert.equal(message, 'Arrived at Town Hall');
  assert.ok(of(game, 'attack').some((a) => a.name === 'Wolf'));
  checkAlways(game);
});

test('Mount: never on a map that forbids it, nor without a mount; only standing still', async () => {
  // Town Hall is indoors (no horses): Travel within it never presses M.
  const indoors = new FakeGame({ player: { map: TOWN_HALL, x: 30, y: 30, level: 24 } });
  assert.equal((await play(indoors, (bot) => bot.startTravel(`map:${LEFT_WING}`))).message, 'Arrived at Left Wing');
  assert.deepEqual(of(indoors, 'key').filter((k) => k.vk === VK.M), []);
  // No mount equipped.
  const walking = onBichon({}, bichon.player, { hasMount: false });
  assert.equal((await play(walking, (bot) => bot.startTravel(`map:${TOWN_HALL}`))).message, 'Arrived at Town Hall');
  assert.deepEqual(of(walking, 'key').filter((k) => k.vk === VK.M), []);
  checkAlways(indoors);
  checkAlways(walking);
});

const LINDA = data.npcs.find((n) => n.name === 'Linda' && n.map === BICHON)!;
const WOLVES = 'Wolves in Bichon';
/** Next to Linda (her shop's quests: Wolves in Bichon, 30 wolves on Bichon Province). */
const byLinda = { x: LINDA.at![0] + 2, y: LINDA.at![1] + 1 };

test('Quests: a finished quest is handed in', async () => {
  const game = onBichon({ npcs: [{ id: LINDA.id }], quests: [{ key: WOLVES, state: 'ready' }], offers: [] }, byLinda, { level: 10 });
  const { met } = await play(game, (bot) => bot.startQuests(), { until: () => game.questState(WOLVES) === 'completed', limitMs: 60_000 });
  assert.ok(met, 'handed in');
  assert.ok(of(game, 'button').some((b) => b.name === 'Hand In'));
  checkAlways(game);
});

test('Quests: picked up from an NPC who shows the Talk / Quests menu', async () => {
  const game = onBichon({ npcs: [{ id: LINDA.id, menu: ['talk', 'quests'] }], offers: [WOLVES] }, byLinda, { level: 10 });
  const { met } = await play(game, (bot) => bot.startQuests(), { until: () => game.questState(WOLVES) !== undefined, limitMs: 60_000 });
  assert.ok(met, 'picked up');
  assert.deepEqual(of(game, 'button').map((b) => b.name).slice(0, 2), ['Quests', 'Accept All']);
  checkAlways(game);
});

test('Quests: hunts the quest monster until the quest is done, then hands it in', async () => {
  // Wolves about (and chickens, which the quest doesn't want).
  const wolves = Array.from({ length: 8 }, (_, i) => ({ name: 'Wolf', x: byLinda.x - 6 + (i % 4) * 3, y: byLinda.y + 6 + Math.floor(i / 4) * 3, respawn: true }));
  const chickens = [{ name: 'Chicken', x: byLinda.x + 3, y: byLinda.y + 3, respawn: true }];
  const game = onBichon({ npcs: [{ id: LINDA.id }], monsters: [...wolves, ...chickens], quests: [{ key: WOLVES, state: 'active' }], offers: [] }, byLinda, { level: 10 });
  const { met } = await play(game, (bot) => bot.startQuests(), { settings: { questMaxActive: 1 }, until: () => game.questState(WOLVES) === 'completed', limitMs: 20 * 60_000 });
  assert.ok(met, `handed in (${game.questState(WOLVES)})`);
  const kills = of(game, 'attack').filter((a) => a.killed);
  assert.ok(kills.filter((k) => k.name === 'Wolf').length >= 30);
  assert.ok(!kills.some((k) => k.name === 'Chicken'), 'Quests hunts what the quests want');
  checkAlways(game);
});

/** Chickens about the player on Bichon Province, for a level 1 to grind on. */
function grindOnBichon(setup: Partial<FakeGameSetup> = {}): FakeGame {
  const { x, y } = bichon.player;
  const chickens = Array.from({ length: 6 }, (_, i) => ({ name: 'Chicken', x: x - 4 + (i % 3) * 4, y: y + 3 + Math.floor(i / 3) * 3, respawn: true }));
  return onBichon({ monsters: chickens, allNpcs: true, ...setup }, bichon.player, { level: 1 });
}

const backOnBichon = (game: FakeGame, after: FakeEvent['type'], what: (e: FakeEvent) => boolean) => () => {
  const at = game.events.findIndex((e) => e.type === after && what(e));
  return at >= 0 && game.player.map === BICHON && game.events.slice(at).some((e) => e.type === 'attack' && e.killed);
};

test('Grind: a full bag means back to Arcadia, selling to Ludvik, and back to grinding', async () => {
  const game = grindOnBichon({ bag: { used: 38, slots: 40 } });
  const { met, statuses } = await play(game, (bot) => bot.startGrind(), { until: backOnBichon(game, 'sold', () => true), limitMs: 10 * 60_000 });
  assert.ok(met, `back to grinding after selling (${statuses.at(-1)?.message})`);
  assert.ok(of(game, 'mapChange').some((c) => c.to === 563 && c.via === 'arcadia'));
  // The panel takes 30 a round: 36 go in two.
  assert.deepEqual(of(game, 'sold').map((s) => s.items), [30, 6]);
  assert.equal(game.bag.used, 2);
  assert.ok(!game.isOpen('sell'));
  checkAlways(game);
});

test('Grind: after a death, Return, then back to grinding', async () => {
  const game = grindOnBichon();
  let died = false;
  const { met, statuses } = await play(game, (bot) => bot.startGrind(), {
    during: () => {
      if (!died && of(game, 'attack').some((a) => a.killed)) {
        died = true;
        game.kill();
      }
    },
    until: backOnBichon(game, 'mapChange', (e) => e.type === 'mapChange' && e.via === 'revive'),
    limitMs: 10 * 60_000,
  });
  assert.ok(met, `back to grinding after dying (${statuses.at(-1)?.message})`);
  assert.ok(of(game, 'button').some((b) => b.name === 'Return'));
  assert.ok(!game.player.dead);
  checkAlways(game);
});

test('Hunt: the hostile monsters are attacked, never a guard among them', async () => {
  const { x, y } = bichon.player;
  const game = onBichon({
    monsters: [
      { name: 'Guard', x: x + 2, y, level: 50, disposition: 0 },
      { name: 'Wolf', x: x - 2, y: y + 1, hits: 2 },
      { name: 'Wolf', x: x + 3, y: y + 2, hits: 2 },
    ],
  });
  const kills = () => of(game, 'attack').filter((a) => a.killed).length;
  const { met } = await play(game, (bot) => bot.startAttack(), { until: () => kills() >= 2, limitMs: 2 * 60_000 });
  assert.ok(met, 'both wolves killed');
  checkAlways(game);
});

test('Explore: uncovers a small map', async () => {
  // 60 x 40 tiles with a wall across the middle, open at one end.
  const map = openMapWithWall();
  const game = new FakeGame({ maps: [map], player: { map: map.index, x: 5, y: 5, level: 24 } });
  const { message } = await play(game, (bot) => bot.startExplore(), { limitMs: 10 * 60_000 });
  assert.match(message, /explored \(\d+%\)/);
  checkAlways(game);
});

test("Explore: steady progress on Bichon Province's own walls", async () => {
  const game = new FakeGame({ maps: [{ ...bichon.map, explored: null }], player: { map: BICHON, ...bichon.player, level: 24 } });
  const { message } = await play(game, (bot) => bot.startExplore(), { settings: { explorePercent: 25 }, limitMs: 5 * 60_000 });
  assert.equal(message, 'Bichon Province explored (25%)');
  checkAlways(game);
});

test('Scenarios are deterministic: the same run twice gives the same events', async () => {
  const run = async () => {
    const game = onBichon({ npcs: [{ id: STONE.id, menu: ['waypoints', 'quests'] }] }, { x: STONE.at![0] + 8, y: STONE.at![1] - 6 });
    await play(game, (bot) => bot.startTravel('map:6'));
    return JSON.stringify(game.events);
  };
  assert.equal(await run(), await run());
});

test('Hunt, mounted: gets off before fighting at the first try, never mid-stride', async () => {
  // Seeking a wolf out of sight, mounted: the run there ends with getting off to fight.
  const { x, y } = bichon.player;
  const game = onBichon({ monsters: [{ name: 'Wolf', x: x - 12, y: y - 24, level: 20 }] }, bichon.player, { mounted: true });
  const { met } = await play(game, (bot) => bot.startAttack(), {
    settings: { hunt: { ...testSettings().hunt, roam: true } },
    until: () => of(game, 'attack').some((a) => a.killed),
    limitMs: 2 * 60_000,
  });
  assert.ok(met, 'found and killed');
  assert.deepEqual(of(game, 'mount').map((m) => [m.moving, m.mounted]), [[false, false]]);
  checkAlways(game);
});

test('Hunt, seeking: heads for a monster out of sight, and says so', async () => {
  // A wolf the game knows of, well off screen; nothing nearby.
  const { x, y } = bichon.player;
  const game = onBichon({ monsters: [{ name: 'Wolf', x: x + 2, y: y - 28, level: 20 }] });
  const { met, statuses } = await play(game, (bot) => bot.startAttack(), {
    settings: { hunt: { ...testSettings().hunt, roam: true } },
    until: () => of(game, 'attack').some((a) => a.killed),
    limitMs: 2 * 60_000,
  });
  assert.ok(met, 'found and killed');
  // While heading there, the status line says where to (not that it's waiting).
  const lines = statuses.map((s) => s.message);
  const first = lines.findIndex((m) => m.startsWith('Attacking'));
  assert.ok(lines.slice(0, first).includes('Heading for Wolf'), lines.slice(0, first).join(' | '));
  assert.ok(!lines.slice(0, first).some((m) => m.startsWith('Waiting for monsters')), lines.slice(0, first).join(' | '));
  checkAlways(game);
});

// ---- Selling, Return to Arcadia and getting out of combat ----

const ARCADIA = 563;
const LUDVIK = data.npcs.find((n) => n.name === 'Ludvik')!;
const keyDowns = (game: FakeGame, vk: number) => of(game, 'key').filter((k) => k.down && k.vk === vk);
const buttons = (game: FakeGame, name: string) => of(game, 'button').filter((b) => b.name === name);
const sold = (game: FakeGame) => of(game, 'sold').reduce((n, s) => n + s.items, 0);
/** The chickens grindOnBichon puts about, for setups that add monsters of their own. */
function chickensAbout(): FakeGameSetup['monsters'] {
  const { x, y } = bichon.player;
  return Array.from({ length: 6 }, (_, i) => ({ name: 'Chicken', x: x - 4 + (i % 3) * 4, y: y + 3 + Math.floor(i / 3) * 3, respawn: true }));
}

test('Selling: the bag opened with W on its Main tab, Select All and Sell (with Yes) in rounds until nothing is picked, the bag put away', async () => {
  // 86 to sell, 30 a round; the bag window shut, on another tab; every sale asks "are you sure?".
  const game = grindOnBichon({ bag: { used: 88, slots: 90 }, bagWindow: { open: false, section: 2 }, sellConfirm: true });
  const { met } = await play(game, (bot) => bot.startGrind(), { until: () => sold(game) > 0 && game.player.map !== ARCADIA, limitMs: 10 * 60_000 });
  assert.ok(met, 'sold and gone');
  assert.deepEqual(of(game, 'sold').map((s) => s.items), [30, 30, 26]);
  assert.equal(game.bag.used, 2);
  assert.equal(buttons(game, 'YesButton').length, 3);
  // W once to open the bag (before the first Select All), once to put it away after; the Main tab picked once.
  const w = keyDowns(game, BAG_KEY);
  assert.equal(w.length, 2);
  assert.ok(w[0].t < buttons(game, 'Select All')[0].t);
  assert.ok(w[1].t > of(game, 'sold').at(-1)!.t);
  assert.equal(buttons(game, 'Main tab').length, 1);
  assert.ok(!game.bagWindow.open && !game.isOpen('sell'));
  // A Select All that picks nothing ends the rounds: four in all.
  assert.equal(buttons(game, 'Select All').length, 4);
  checkAlways(game);
});

test('Selling: then Return to Arcadia again goes back to where it was pressed, and Grind carries on there without travelling', async () => {
  const game = grindOnBichon({ bag: { used: 38, slots: 40 } });
  const left = { ...game.player };
  const { met } = await play(game, (bot) => bot.startGrind(), { until: backOnBichon(game, 'mapChange', (e) => e.type === 'mapChange' && e.via === 'back'), limitMs: 10 * 60_000 });
  assert.ok(met, 'back and grinding');
  const changes = of(game, 'mapChange');
  assert.deepEqual(changes.map((c) => [c.from, c.to, c.via]), [[BICHON, ARCADIA, 'arcadia'], [ARCADIA, BICHON, 'back']]);
  // Back on the very spot: the first move after it starts from where the player left.
  const back = changes[1];
  const firstMove = of(game, 'move').find((m) => m.t > back.t)!;
  assert.deepEqual(firstMove.from, { x: left.x, y: left.y });
  assert.equal(buttons(game, 'Return to Arcadia').length, 2);
  checkAlways(game);
});

test('Return to Arcadia: monsters close by (weak ones too) are fought off and the 10 s waited out before pressing it', async () => {
  const { x, y } = bichon.player;
  // Chickens come at the player and keep them in combat; the bag is full from the start.
  const attackers = [[1, 1], [-2, 2], [3, -1]].map(([dx, dy]) => ({ name: 'Chicken', x: x + dx, y: y + dy, aggressive: true }));
  const game = grindOnBichon({ bag: { used: 38, slots: 40 }, monsters: [...chickensAbout()!, ...attackers] });
  const { met } = await play(game, (bot) => bot.startGrind(), { until: () => of(game, 'mapChange').some((c) => c.to === ARCADIA), limitMs: 5 * 60_000 });
  assert.ok(met, 'in Arcadia');
  assert.deepEqual(of(game, 'refused'), [], 'pressed while still in combat');
  const arrived = of(game, 'mapChange').find((c) => c.to === ARCADIA)!.t;
  const kills = of(game, 'attack').filter((a) => a.killed && a.t < arrived);
  assert.ok(kills.length >= 3, `${kills.length} killed first`);
  // The last blow more than 10 s before the press (the cast takes a moment more).
  const pressed = buttons(game, 'Return to Arcadia')[0].t;
  assert.ok(pressed - of(game, 'attack').filter((a) => a.t < pressed).at(-1)!.t >= 10_000);
  checkAlways(game);
});

test('Return to Arcadia: still in combat after a minute, the Town Portal scroll, then Arcadia from town', async () => {
  const { x, y } = bichon.player;
  // A monster that can't be beaten keeps the player in combat.
  const golem = { name: 'Rock Golem', x: x + 1, y: y + 1, level: 1, hits: 1_000_000, aggressive: true };
  const game = grindOnBichon({ bag: { used: 38, slots: 40 }, monsters: [golem] });
  const { met } = await play(game, (bot) => bot.startGrind(), { until: () => sold(game) > 0, limitMs: 10 * 60_000 });
  assert.ok(met, 'sold in the end');
  const portal = keyDowns(game, 0x33);
  assert.equal(portal.length, 1, 'the scroll read once');
  assert.ok(portal[0].t >= 60_000, `after a minute (${Math.round(portal[0].t / 1000)} s)`);
  assert.deepEqual(of(game, 'mapChange').slice(0, 2).map((c) => [c.from, c.to, c.via]), [[BICHON, 6, 'portal'], [6, ARCADIA, 'arcadia']]);
  assert.deepEqual(of(game, 'refused'), []);
  checkAlways(game);
});

test("Pickups refused: three items in a row that won't pick up count as a full bag (Hunt, standing)", async () => {
  // The bag says 20 of 40, but takes nothing more until something is sold. Hunt without seeking stays put by the items.
  // (In Grind and Quests seeking runs off between tries: see the pull request.)
  const { x, y } = bichon.player;
  const items = [[0, 1], [1, 0], [-1, -1]].map(([dx, dy], i) => ({ name: `Junk ${i}`, x: x + dx, y: y + dy }));
  const game = onBichon({ allNpcs: true, items, bag: { used: 20, slots: 40, refuse: true } }, bichon.player, { level: 1, pickUpRadius: 1 });
  const { met } = await play(game, (bot) => bot.startAttack(), { settings: { sellItems: true, hunt: { ...testSettings().hunt, loot: true } }, until: () => sold(game) > 0, limitMs: 5 * 60_000 });
  assert.ok(met, 'sold');
  assert.ok(of(game, 'pickup').filter((p) => p.refused).length >= 3);
  assert.ok(of(game, 'mapChange').some((c) => c.to === ARCADIA && c.via === 'arcadia'));
  assert.equal(sold(game), 18);
  checkAlways(game);
});

test("Pickups refused with a near-empty bag: someone else's drops, most likely; no trip to sell", async () => {
  const { x, y } = bichon.player;
  const items = [[0, 1], [1, 0], [-1, -1]].map(([dx, dy], i) => ({ name: `Junk ${i}`, x: x + dx, y: y + dy }));
  const game = onBichon({ allNpcs: true, items, bag: { used: 5, slots: 40, refuse: true } }, bichon.player, { level: 1, pickUpRadius: 1 });
  await play(game, (bot) => bot.startAttack(), { settings: { sellItems: true, hunt: { ...testSettings().hunt, loot: true } }, until: () => false, limitMs: 60_000 });
  assert.ok(of(game, 'pickup').filter((p) => p.refused).length >= 3);
  assert.ok(!of(game, 'mapChange').some((c) => c.to === ARCADIA));
  assert.equal(sold(game), 0);
  checkAlways(game);
});

test('No old selling: with Sell items ticked, Grind and Quests never run the screen routine (no W or B while hunting)', async () => {
  const settings = { sellItems: true };
  const grind = grindOnBichon();
  await play(grind, (bot) => bot.startGrind(), { settings, until: () => of(grind, 'attack').filter((a) => a.killed).length >= 6, limitMs: 3 * 60_000 });
  assert.ok(of(grind, 'attack').filter((a) => a.killed).length >= 6);
  assert.deepEqual([...keyDowns(grind, VK.W), ...keyDowns(grind, VK.B)], []);
  checkAlways(grind);

  const wolves = Array.from({ length: 6 }, (_, i) => ({ name: 'Wolf', x: byLinda.x - 6 + (i % 3) * 4, y: byLinda.y + 6 + Math.floor(i / 3) * 3, respawn: true }));
  const quests = onBichon({ npcs: [{ id: LINDA.id }], monsters: wolves, quests: [{ key: WOLVES, state: 'active' }], offers: [] }, byLinda, { level: 10 });
  await play(quests, (bot) => bot.startQuests(), { settings: { ...settings, questMaxActive: 1 }, until: () => of(quests, 'attack').filter((a) => a.killed).length >= 6, limitMs: 3 * 60_000 });
  assert.ok(of(quests, 'attack').filter((a) => a.killed).length >= 6);
  assert.deepEqual([...keyDowns(quests, VK.W), ...keyDowns(quests, VK.B)], []);
  checkAlways(quests);
});

test('Hunt with the memory reader and Sell items: a full bag sells the new way (Arcadia, Ludvik, back), never the screen routine', async () => {
  // Nothing about at first; chickens turn up once the player is back.
  const { x, y } = bichon.player;
  const game = onBichon({ allNpcs: true, bag: { used: 38, slots: 40 } }, bichon.player, { level: 1 });
  let added = false;
  const { met } = await play(game, (bot) => bot.startAttack(), {
    settings: { sellItems: true, hunt: { ...testSettings().hunt, roam: true } },
    during: () => {
      if (!added && of(game, 'mapChange').some((c) => c.via === 'back')) {
        added = true;
        for (const [dx, dy] of [[-4, 0], [0, -4], [3, -3]]) game.addMonster({ name: 'Chicken', x: x + dx, y: y + dy, map: BICHON });
      }
    },
    until: backOnBichon(game, 'mapChange', (e) => e.type === 'mapChange' && e.via === 'back'),
    limitMs: 10 * 60_000,
  });
  assert.ok(met, 'sold, back and hunting');
  assert.equal(sold(game), 36);
  assert.deepEqual(keyDowns(game, VK.B), []);
  // W only at Ludvik's, to open and put away the bag.
  assert.equal(keyDowns(game, VK.W).length, 2);
  checkAlways(game);
});

// ---- Arriving boxed in ----

test("Travel: arriving on a tile of an exit, the way to an NPC isn't walled in by it, and the exit isn't taken", async () => {
  // Sanctuary's way out of Arcadia is three tiles; the player stands on one of them.
  const exit = data.links.find((l) => l.from === ARCADIA && l.to === 611)!;
  const [x, y] = exit.exit.find(([ex, ey]) => ex === 742 && ey === 84)!;
  const game = new FakeGame({ npcs: [{ id: LUDVIK.id }], player: { map: ARCADIA, x, y, level: 24 } });
  const { message } = await play(game, (bot) => bot.startTravel(`npc:${LUDVIK.id}`));
  assert.equal(message, 'Arrived at Ludvik');
  assert.deepEqual(of(game, 'mapChange'), []);
  checkAlways(game);
});

test('Travel: boxed in by other players and NPCs on arrival, it still finds a way to an NPC (through the people)', async () => {
  const [lx, ly] = LUDVIK.at!;
  const at = { x: lx - 20, y: ly + 15 };
  // Every tile round the player taken: players (who can be walked through) and two NPCs (who can't).
  const ring = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  const players = ring.slice(0, 6).map(([dx, dy], i) => ({ name: `Player ${i}`, x: at.x + dx, y: at.y + dy }));
  const npcs = [{ id: LUDVIK.id }, ...ring.slice(6).map(([dx, dy], i) => ({ id: 9001 + i, name: `Bystander ${i}`, map: ARCADIA, x: at.x + dx, y: at.y + dy }))];
  const game = new FakeGame({ npcs, players, player: { map: ARCADIA, ...at, level: 24 } });
  const { message } = await play(game, (bot) => bot.startTravel(`npc:${LUDVIK.id}`));
  assert.equal(message, 'Arrived at Ludvik');
  assert.deepEqual(of(game, 'mapChange'), []);
  checkAlways(game);
});

// ---- Fights measured for Grind ----

test("Fights are timed from the game's memory: each monster's health going down to its death, and the health it cost", async () => {
  const { x, y } = bichon.player;
  // Wolves of 300 health that bite back (25 a bite) once hit; the player's blows do 60.
  const wolves = [[-2, 1], [3, 2], [1, -3]].map(([dx, dy]) => ({ name: 'Wolf', x: x + dx, y: y + dy, health: 300, damage: 25 }));
  const game = onBichon({ monsters: wolves }, bichon.player, { damage: 60 });
  const grindLog = new GrindLog(() => {});
  const { met } = await play(game, (bot) => bot.startAttack(), { grindLog, until: () => grindLog.fights('Tester').kills.length >= 3, limitMs: 2 * 60_000 });
  assert.ok(met, 'three wolves killed and timed');
  // Five blows each (300 / 60), the fifth killing.
  assert.equal(of(game, 'attack').length, 15);
  const kills = grindLog.fights('Tester').kills;
  assert.equal(kills.length, 3);
  for (const k of kills) {
    assert.deepEqual([k.level, k.monsterLevel, k.maxHp, k.damage], [24, 5, 300, 300]);
    assert.ok(k.seconds >= 1 && k.seconds < 10, `${k.seconds} s`);
  }
  // The bites, shared out among the kills they happened in.
  const bitten = of(game, 'hurt').reduce((sum, h) => sum + h.damage, 0) / 1000;
  assert.ok(bitten > 0 && game.player.hp < 1000);
  assert.ok(Math.abs(kills.reduce((sum, k) => sum + k.hpLost, 0) - bitten) < 1e-9, `${kills.map((k) => k.hpLost)} against ${bitten}`);
  checkAlways(game);
});

test('A death is noted with the level of the monster being fought', async () => {
  const { x, y } = bichon.player;
  const log = new GrindLog(() => {});
  // Too much for the player: one bite (once hit) is the end.
  const game = onBichon({ monsters: [{ name: 'Wolf', x: x - 2, y: y + 1, health: 5000, damage: 2000 }] }, bichon.player, { damage: 10 });
  const { met } = await play(game, (bot) => bot.startAttack(), { grindLog: log, until: () => log.fights('Tester').deaths.length > 0, limitMs: 60_000 });
  assert.ok(met, 'died');
  assert.deepEqual(log.fights('Tester').deaths.map((d) => [d.level, d.monsterLevel]), [[24, 5]]);
  assert.deepEqual(log.fights('Tester').kills, []);
  checkAlways(game);
});

test('Grind: a strong character (quick kills above their level, hardly scratched) moves to a harder map than the estimate alone picks', async () => {
  // Level 24 on Faraway Falls (its monsters are level 22): by the estimate alone it's the best there is, and stays so.
  const FARAWAY = data.maps.find((m) => m.name === 'Faraway Falls')!.i;
  const at = { x: 40, y: 40 };
  // Zuma monsters three to five levels up, dying in three blows of 450, biting for 1% of the health.
  const names = ['Vicious Rat', 'Zuma Fanatic', 'Zuma Guardian'];
  const monsters = Array.from({ length: 9 }, (_, i) => ({ name: names[i % 3], x: at.x - 4 + (i % 3) * 4, y: at.y + 3 + Math.floor(i / 3) * 2, respawn: true, damage: 10 }));
  const game = new FakeGame({ monsters, player: { map: FARAWAY, ...at, level: 24, damage: 450 } });
  // Planning again after two minutes: elsewhere (the run stops there).
  const plans = (lines: { message: string }[]) => lines.map((l) => l.message).filter((m) => m.startsWith('Grinding at '));
  const { met, statuses, grindLog } = await play(game, (bot) => bot.startGrind(), {
    settings: { grind: { ...testSettings().grind, replanMinutes: 2 } },
    until: (lines) => plans(lines).some((p) => !p.startsWith('Grinding at Faraway Falls')),
    limitMs: 6 * 60_000,
  });
  assert.ok(met, plans(statuses).join(' | '));
  const [first, second] = [...new Set(plans(statuses))];
  assert.match(first, /^Grinding at Faraway Falls: .*\(still the best\); fighting up to \+5 \(auto\)$/);
  assert.match(second, /^Grinding at Zuma Temple Lv \d: .*\((\d+% better than|outgrew) Faraway Falls\)/);
  // What it measured: quick kills, a little health each.
  const { kills } = grindLog.fights('Tester');
  assert.ok(kills.length >= 20, `${kills.length} kills`);
  assert.ok(kills.every((k) => k.monsterLevel >= 27 && k.seconds < 3 && k.damage === k.maxHp));
  assert.ok(kills.reduce((sum, k) => sum + k.hpLost, 0) / kills.length < 0.05);
  assert.equal(grindLog.sessions('Tester')[0].kills, kills.length);
  // By the estimate alone (the same band), it stays where it was.
  const start = { map: FARAWAY, steps: new Map(), at };
  assert.equal(chooseGrindMap(data, start, { level: 24, cls: 0 }, { maxLevelsAbove: 5, current: FARAWAY })!.map, FARAWAY);
  checkAlways(game);
});

// ---- Gathering trips ----

const MINING = 2;
const HARVESTING = 3;
const DEAD_PIT = 136;
const QUARTZ_MINE = 593;
const COPPER = 21;
const IRON = 22;
const SILVERLEAF = 1;
const GEODE = 17;
/** Gather with trips: ore only unless said. */
const tripSettings = (changes: Partial<ReturnType<typeof testSettings>> = {}) => ({ gatherTrips: true, gatherPlants: false, gatherOre: true, ...changes });
const picks = (game: FakeGame, map?: number) => of(game, 'gather').filter((g) => !g.refused && (map === undefined || g.map === map));
/** The plans made (each said once more on arriving). */
const plans = (statuses: { message: string }[]) => [...new Set(statuses.map((s) => s.message).filter((m) => m.startsWith('Gathering trip: ')))];
/** Nodes round a tile, one every few tiles. */
const nodesAround = (node: number, map: number, x: number, y: number, n: number, level?: number) =>
  Array.from({ length: n }, (_, i) => ({ node, map, x: x - 4 + (i % 3) * 4, y: y - 3 + Math.floor(i / 3) * 4, level }));

test('Gathering trips: the profession levels unknown, Ctrl+Shift+P opens the Professions window, and it is shut again once they show', async () => {
  const game = onBichon({ professions: { levels: { [MINING]: 5 } } }, bichon.player, { level: 10 });
  // Planned, and off on the trip.
  const { met, statuses } = await play(game, (bot) => bot.startGather(), { settings: tripSettings(), until: () => of(game, 'move').length > 0, limitMs: 60_000 });
  assert.ok(met, 'planned and moving');
  const opened = of(game, 'window').filter((w) => w.name === 'professions');
  assert.deepEqual(opened.map((w) => w.open), [true, false]);
  assert.ok(!game.isOpen('professions'));
  // P pressed twice, each time with Ctrl and Shift down.
  const p = keyDowns(game, VK.P);
  assert.equal(p.length, 2);
  assert.equal(keyDowns(game, VK.CONTROL).length, 2);
  assert.equal(keyDowns(game, VK.SHIFT).length, 2);
  assert.match(plans(statuses)[0], /^Gathering trip: Ore 5 · Dead Pit Lv 1: 4 ore, ~1,200 exp\/h \(the best\)$/);
  checkAlways(game);
});

test('Gathering trips: no levels even with the window open is a clear stop', async () => {
  // The window opens, but the game shows no levels (it never loads them).
  const game = onBichon({ professions: { levels: { [MINING]: 5 }, neverLoads: true } }, bichon.player, { level: 10 });
  const { message } = await play(game, (bot) => bot.startGather(), { settings: tripSettings(), limitMs: 60_000 });
  assert.match(message, /^Couldn't read the profession levels/);
  assert.ok(!game.isOpen('professions'));
});

test('Gathering trips: travels to the best spot for the level and gathers there, only what the level allows', async () => {
  // Ore at 5, level 10: Dead Pit Lv 1's copper, a map away. Iron (level 30) and plants (not ticked) lie among it.
  const nodes = [...nodesAround(COPPER, DEAD_PIT, 228, 204, 3), { node: IRON, map: DEAD_PIT, x: 229, y: 206 }, { node: SILVERLEAF, map: DEAD_PIT, x: 227, y: 202 }];
  const game = onBichon({ nodes, allNpcs: true, professions: { levels: { [MINING]: 5 }, loaded: true } }, bichon.player, { level: 10 });
  const { met, statuses } = await play(game, (bot) => bot.startGather(), { settings: tripSettings(), until: () => picks(game, DEAD_PIT).length >= 3, limitMs: 10 * 60_000 });
  assert.ok(met, `gathered at Dead Pit (${statuses.at(-1)?.message})`);
  // By the Hexa Holy Stone to Dead Pit Lv 2, and on down.
  assert.deepEqual(of(game, 'mapChange').map((c) => [c.from, c.to, c.via]), [[BICHON, 137, 'waypoint'], [137, DEAD_PIT, 'link']]);
  assert.deepEqual(new Set(picks(game).map((g) => g.node)), new Set([COPPER]));
  assert.deepEqual(of(game, 'gather').filter((g) => g.refused), []);
  checkAlways(game);
});

test("Gathering trips: nothing at the spot's busiest square, so on to the next, running there", async () => {
  // Dead Pit Lv 1's squares, busiest first: 228,204 then 108,300. The copper is all at the second.
  const nodes = nodesAround(COPPER, DEAD_PIT, 108, 300, 3);
  const game = new FakeGame({ nodes, professions: { levels: { [MINING]: 5 }, loaded: true }, player: { map: DEAD_PIT, x: 228, y: 204, level: 10 } });
  const { met, statuses } = await play(game, (bot) => bot.startGather(), { settings: tripSettings(), until: () => picks(game).length >= 3, limitMs: 5 * 60_000 });
  assert.ok(met, `gathered at the next square (${statuses.at(-1)?.message})`);
  assert.ok(statuses.some((s) => s.message === 'Nothing to gather in sight: heading for another patch of Dead Pit Lv 1 (108,300)'));
  assert.deepEqual(of(game, 'mapChange'), []);
  // Ran there (about 130 tiles), stepping only round the nodes.
  const strides = of(game, 'move').filter((m) => m.run).length;
  assert.ok(strides > 30, `${strides} strides`);
  checkAlways(game);
});

test('Gathering trips: a full bag means Arcadia, selling to Ludvik, and back to the spot to gather', async () => {
  const nodes = nodesAround(COPPER, DEAD_PIT, 228, 204, 4);
  const game = new FakeGame({ nodes, allNpcs: true, bag: { used: 33, slots: 40 }, professions: { levels: { [MINING]: 5 }, loaded: true }, player: { map: DEAD_PIT, x: 228, y: 204, level: 10 } });
  const backAndPicking = () => {
    const back = of(game, 'mapChange').find((c) => c.via === 'back');
    return !!back && picks(game, DEAD_PIT).some((g) => g.t > back.t);
  };
  const { met, statuses } = await play(game, (bot) => bot.startGather(), { settings: tripSettings(), until: backAndPicking, limitMs: 10 * 60_000 });
  assert.ok(met, `sold and back gathering (${statuses.at(-1)?.message})`);
  assert.deepEqual(of(game, 'mapChange').map((c) => [c.from, c.to, c.via]), [[DEAD_PIT, ARCADIA, 'arcadia'], [ARCADIA, DEAD_PIT, 'back']]);
  // Two picks filled it (35 used: 5 free); all but the two kept sold.
  assert.equal(picks(game).filter((g) => g.t < of(game, 'mapChange')[0].t).length, 2);
  assert.equal(sold(game), 33);
  checkAlways(game);
});

test('Gathering trips: a new profession level opens a better spot, and it moves there', async () => {
  // Level 60, Mining 29: Quartz Mine Lv 1's geodes. At 30 the iron of Dead Pit Lv 1 is worth twice as much.
  const nodes = [...nodesAround(GEODE, QUARTZ_MINE, 36, 36, 6), ...nodesAround(IRON, DEAD_PIT, 228, 204, 3), ...nodesAround(COPPER, DEAD_PIT, 230, 210, 3)];
  const game = new FakeGame({ nodes, allNpcs: true, professions: { levels: { [MINING]: 29 }, loaded: true }, player: { map: QUARTZ_MINE, x: 36, y: 38, level: 60 } });
  let raised = false;
  const { met, statuses } = await play(game, (bot) => bot.startGather(), {
    settings: tripSettings(),
    during: () => {
      if (!raised && picks(game, QUARTZ_MINE).length >= 2) {
        raised = true;
        game.setProfession(MINING, 30);
      }
    },
    until: () => picks(game, DEAD_PIT).some((g) => g.node === IRON),
    limitMs: 15 * 60_000,
  });
  assert.ok(met, `iron picked at Dead Pit (${statuses.at(-1)?.message})`);
  const lines = statuses.map((s) => s.message);
  assert.ok(lines.includes('Mining level 30: planning again'), lines.join(' | '));
  assert.deepEqual(plans(statuses).map((m) => m.split(' · ')[1].split(':')[0]), ['Quartz Mine Lv 1', 'Dead Pit Lv 1']);
  assert.match(plans(statuses)[1], /\(\d+% better than Quartz Mine Lv 1\)$/);
  assert.equal(of(game, 'mapChange').at(-1)!.to, DEAD_PIT);
  checkAlways(game);
});

test("Gathering trips: picks refused where only the region's level said yes: the spot is left and another planned", async () => {
  // Plants at 23 in Arcadia Castle, whose Silverleaf counts as level 20: the game wants 30 of it here.
  const [x, y] = [348, 393];
  const game = new FakeGame({
    nodes: nodesAround(SILVERLEAF, ARCADIA, x, y, 3, 30), allNpcs: true, professions: { levels: { [HARVESTING]: 23 }, loaded: true }, player: { map: ARCADIA, x, y: y + 2, level: 30 },
  });
  const { met, statuses } = await play(game, (bot) => bot.startGather(), {
    settings: tripSettings({ gatherPlants: true, gatherOre: false }),
    until: () => of(game, 'mapChange').some((c) => c.from === ARCADIA),
    limitMs: 10 * 60_000,
  });
  assert.ok(met, `left Arcadia (${statuses.at(-1)?.message})`);
  // Clicked, and once more when nothing came of it.
  assert.deepEqual(of(game, 'gather').map((g) => [g.node, g.refused]), [[SILVERLEAF, true], [SILVERLEAF, true]]);
  const lines = statuses.map((s) => s.message);
  assert.ok(lines.some((m) => m.startsWith("The Silverleaf won't gather at Arcadia Castle")), lines.join(' | '));
  assert.deepEqual(plans(statuses).map((m) => m.split(' · ')[1].split(':')[0]), ['Arcadia Castle', 'Bichon Province']);
  assert.equal(of(game, 'mapChange').at(-1)!.to, BICHON);
  checkAlways(game);
});

test('Gathering trips: with no tool, picks keep failing on nodes the level allows, and it stops saying so', async () => {
  const game = new FakeGame({ nodes: nodesAround(COPPER, DEAD_PIT, 228, 204, 4), noTool: true, professions: { levels: { [MINING]: 5 }, loaded: true }, player: { map: DEAD_PIT, x: 228, y: 204, level: 10 } });
  const { message, statuses } = await play(game, (bot) => bot.startGather(), { settings: tripSettings(), limitMs: 10 * 60_000 });
  assert.equal(message, 'Picking ore keeps failing on nodes your level allows: put a Pick Axe in your Toolbelt.');
  // Three nodes tried (each clicked twice): the first two passed over, the third the last straw.
  assert.equal(statuses.filter((s) => s.message === "The Copper Vein won't gather (the wrong tool?); trying another").length, 2);
  assert.equal(of(game, 'gather').filter((g) => g.refused).length, 6);
  assert.deepEqual(of(game, 'mapChange'), []);
});

test('Gather without trips: as before, whatever is in sight, never the Professions window nor a trip', async () => {
  // A plant and an ore node beside the player; the iron needs more than Mining 1, and is still tried.
  const { x, y } = bichon.player;
  const nodes = [{ node: SILVERLEAF, x: x + 2, y }, { node: COPPER, x: x - 2, y: y + 1 }, { node: IRON, x, y: y - 3 }];
  const game = onBichon({ nodes }, bichon.player, { level: 10 });
  const { met } = await play(game, (bot) => bot.startGather(), { until: () => picks(game).length >= 2 && of(game, 'gather').some((g) => g.refused), limitMs: 3 * 60_000 });
  assert.ok(met, 'both picked, the iron tried');
  assert.deepEqual(keyDowns(game, VK.CONTROL), []);
  assert.deepEqual(of(game, 'mapChange'), []);
  assert.deepEqual(new Set(picks(game).map((g) => g.node)), new Set([SILVERLEAF, COPPER]));
  checkAlways(game);
});

// ---- The loot judge at the shop ----

const SCROLL_LOCK = 0x91;
/** A Warrior's gear: a weak sword and a cap worn; in the bag a clear upgrade, a cap 10% better (kept, not put on), and junk. */
const RUSTY_SWORD = { name: 'Rusty Sword', type: 2, slot: 0, base: { 8: 2, 9: 5 } };
const LEATHER_CAP = { name: 'Leather Cap', type: 5, slot: 2, base: { 4: 10, 5: 10 } };
const IRON_SWORD = { name: 'Iron Sword', type: 2, slot: 3, base: { 8: 4, 9: 9 } };
const BRONZE_CAP = { name: 'Bronze Cap', type: 5, slot: 5, base: { 4: 11, 5: 11 } };
const BENT_SWORD = { name: 'Bent Sword', type: 2, slot: 4, base: { 8: 1, 9: 2 } };
const gearWith = (...bag: FakeItem[]) => ({ worn: [RUSTY_SWORD, LEATHER_CAP], bag });
const locks = (game: FakeGame) => of(game, 'lock');

test('Loot judge: a sell trip locks the upgrade first, sells the rest, and lists what it kept', async () => {
  const game = grindOnBichon({ bag: { used: 38, slots: 40 }, gear: gearWith(IRON_SWORD, BENT_SWORD) });
  const { met, kept, statuses } = await play(game, (bot) => bot.startGrind(), { until: backOnBichon(game, 'sold', () => true), limitMs: 10 * 60_000 });
  assert.ok(met, `back to grinding after selling (${statuses.at(-1)?.message})`);
  // Locked before Select All; the 36 others go but for the two Select All always leaves.
  assert.deepEqual(locks(game).map((l) => [l.name, l.locked]), [['Iron Sword', true]]);
  assert.ok(locks(game)[0].t < buttons(game, 'Select All')[0].t);
  assert.deepEqual(of(game, 'sold').map((s) => s.items), [30, 5]);
  assert.deepEqual(game.gear.bag.map((i) => [i.name, i.flags]), [['Iron Sword', 1]]);
  assert.deepEqual(kept.map((k) => [k.name, k.rarity, k.reason]), [['Iron Sword', 'Common', '+86% over Rusty Sword (DC 2–5 → 4–9)']]);
  assert.ok(statuses.some((s) => s.message === 'Kept Iron Sword: +86% over Rusty Sword (DC 2–5 → 4–9)'));
  assert.equal(statuses.at(-1)!.stats!.session.kept, 1);
  // Nothing put on unless asked.
  assert.deepEqual(of(game, 'equip'), []);
  checkAlways(game);
});

test("Loot judge: the lock doesn't take, so nothing is sold that trip, and hunting goes on", async () => {
  const game = grindOnBichon({ bag: { used: 38, slots: 40 }, gear: gearWith(IRON_SWORD, BENT_SWORD), lockFails: true });
  const { met, statuses } = await play(game, (bot) => bot.startGrind(), { until: backOnBichon(game, 'mapChange', (e) => e.type === 'mapChange' && e.via === 'back'), limitMs: 10 * 60_000 });
  assert.ok(met, `back and grinding (${statuses.at(-1)?.message})`);
  const lines = statuses.map((s) => s.message);
  assert.ok(lines.includes("Couldn't protect Iron Sword: not selling"), lines.join(' | '));
  assert.deepEqual([of(game, 'sold'), buttons(game, 'Select All'), buttons(game, 'Sell')], [[], [], []]);
  assert.ok(keyDowns(game, SCROLL_LOCK).length >= 1);
  assert.ok(!game.isOpen('sell'));
  assert.deepEqual(game.gear.bag.map((i) => i.name), ['Iron Sword', 'Bent Sword']);
  // One trip only: the full bag is let be for a while.
  assert.equal(of(game, 'mapChange').filter((c) => c.via === 'arcadia').length, 1);
  checkAlways(game);
});

test('Loot judge: "Put on clear upgrades" puts the clear one on after selling, and leaves the borderline one in the bag', async () => {
  const game = grindOnBichon({ bag: { used: 38, slots: 40 }, gear: gearWith(IRON_SWORD, BRONZE_CAP, BENT_SWORD) });
  const { met, kept, statuses } = await play(game, (bot) => bot.startGrind(), {
    settings: { hunt: { ...testSettings().hunt, equipUpgrades: true } },
    until: backOnBichon(game, 'sold', () => true),
    limitMs: 10 * 60_000,
  });
  assert.ok(met, `back to grinding (${statuses.at(-1)?.message})`);
  // Both kept (the cap is 10% better: an upgrade, but not a clear one).
  assert.deepEqual(kept.map((k) => k.name).sort(), ['Bronze Cap', 'Iron Sword']);
  assert.deepEqual(of(game, 'equip').map((e) => [e.name, e.slot]), [['Iron Sword', 0]]);
  // After selling, with the shop shut.
  const equipped = of(game, 'equip')[0].t;
  assert.ok(equipped > of(game, 'sold').at(-1)!.t);
  assert.ok(equipped > of(game, 'window').filter((w) => w.name === 'sell' && !w.open).at(-1)!.t);
  assert.deepEqual(game.gear.worn.map((w) => w.name).sort(), ['Iron Sword', 'Leather Cap']);
  assert.ok(game.gear.bag.some((i) => i.name === 'Bronze Cap' && i.flags & 1));
  assert.ok(game.gear.bag.some((i) => i.name === 'Rusty Sword'));
  assert.ok(statuses.some((s) => s.message === 'Put on Iron Sword'));
  checkAlways(game);
});

test("Loot judge: nothing worth keeping, so selling is as before (no lock key at all)", async () => {
  const game = grindOnBichon({ bag: { used: 38, slots: 40 }, gear: gearWith(BENT_SWORD) });
  const { met, kept } = await play(game, (bot) => bot.startGrind(), { until: backOnBichon(game, 'sold', () => true), limitMs: 10 * 60_000 });
  assert.ok(met, 'sold and back');
  assert.deepEqual(of(game, 'sold').map((s) => s.items), [30, 6]);
  assert.deepEqual(keyDowns(game, SCROLL_LOCK), []);
  assert.deepEqual([kept, game.gear.bag], [[], []]);
  checkAlways(game);
});

test("Loot judge: a double-click that doesn't put the upgrade on is given up on, and the trip carries on", async () => {
  const game = grindOnBichon({ bag: { used: 38, slots: 40 }, gear: gearWith(IRON_SWORD, BENT_SWORD), equipFails: true });
  const { met, statuses } = await play(game, (bot) => bot.startGrind(), {
    settings: { hunt: { ...testSettings().hunt, equipUpgrades: true } },
    until: backOnBichon(game, 'sold', () => true),
    limitMs: 10 * 60_000,
  });
  assert.ok(met, `back to grinding (${statuses.at(-1)?.message})`);
  assert.ok(statuses.some((s) => s.message === "Couldn't put on Iron Sword (double-clicking it did nothing); leaving it in the bag"));
  assert.deepEqual(game.gear.worn.map((w) => w.name), ['Rusty Sword', 'Leather Cap']);
  checkAlways(game);
});

/**
 * The bot's real loops (Travel, Explore, Quests, Grind, Hunt) run against the
 * fake game (fake-game.ts): behaviour that only shows when the whole thing
 * runs, checked without the live game. Each scenario is short and seeded.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VK } from '../main/input';
import { loadTravelData } from '../main/travel';
import { play, testSettings } from './bot-harness';
import { FakeGame, RUN_DEAD_ZONE, openMap, type FakeEvent, type FakeGameSetup } from './fake-game';
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
  const chickens = [[1, 1], [-1, 1], [2, 0], [0, 2], [1, -1]].map(([dx, dy]) => ({ name: 'Chicken', x: sx + dx, y: sy + dy, level: 1 }));
  const game = onBichon({ npcs: [{ id: STONE.id }], monsters: chickens, waypoints: ['Prajna Village'] }, { x: sx + 4, y: sy + 4 });
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
  assert.equal(of(game, 'sold')[0].items, 36);
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

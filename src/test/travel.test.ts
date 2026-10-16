import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { canStep } from '../main/map-explorer';
import { nearestApproach, pathBack, pathStats, walkDistances } from '../main/map-path';
import type { MapGrid } from '../main/map-grid';
import { findPlace, loadTravelData, places, planRoute, searchPlaces, type Start } from '../main/travel';
import { loadMapFixture } from './map-fixtures';

const data = loadTravelData(path.join(__dirname, '..', '..', 'game-data', 'travel.json'));
const BICHON = 1;
const mapIndex = (name: string) => data.maps.find((m) => m.name === name)!.i;

/** Standing in Bichon Province with the walls from the saved map: steps to each exit and NPC. */
function startInBichon(): Start {
  const { map, player } = loadMapFixture('bichon-province');
  const dist = walkDistances(map, player);
  const steps = new Map<number, number>();
  for (const l of data.links.filter((l) => l.from === BICHON)) {
    const near = nearestApproach(map, dist, l.exit.map(([x, y]) => ({ x, y })));
    if (near) steps.set(l.id, near.steps);
  }
  return { map: BICHON, steps, at: player };
}

test('search finds maps and NPCs by any part of the name', () => {
  const list = places(data);
  assert.ok(searchPlaces(list, 'kang').some((p) => p.npc?.name === 'Mr. Kang'));
  assert.equal(searchPlaces(list, 'bichon prov')[0].id, `map:${BICHON}`);
  assert.ok(searchPlaces(list, 'weapon bichon').some((p) => p.npc?.name === 'Mr. Kang'));
  assert.deepEqual(searchPlaces(list, '   '), []);
});

test('a route is a chain of links from the current map to the destination', () => {
  const place = findPlace(data, `map:${mapIndex('Death Valley Lv 2')}`)!;
  const route = planRoute(data, startInBichon(), place, { level: 50 })!;
  assert.ok(route.links.length >= 2);
  assert.equal(route.links[0].from, BICHON);
  for (let i = 1; i < route.links.length; i++) assert.equal(route.links[i].from, route.links[i - 1].to);
  assert.equal(route.links.at(-1)!.to, place.map);
});

test('already on the map: nothing to take', () => {
  const route = planRoute(data, startInBichon(), findPlace(data, `map:${BICHON}`)!);
  assert.deepEqual(route?.links, []);
});

test("maps the level doesn't allow are left out", () => {
  const golden = findPlace(data, `map:${mapIndex('Golden Temple Lv 1')}`)!;
  const route = planRoute(data, startInBichon(), golden, { level: 10 });
  assert.ok(!route || route.links.every((l) => (data.maps.find((m) => m.i === l.to)?.level ?? 0) <= 10));
  assert.equal(route, null);
});

test('an NPC on another map: the route ends on its map', () => {
  const npc = data.npcs.find((n) => n.at && n.map !== BICHON && data.links.some((l) => l.to === n.map && l.npcSteps?.[n.id] !== undefined))!;
  const route = planRoute(data, startInBichon(), findPlace(data, `npc:${npc.id}`)!, { level: 999 });
  if (route) assert.equal(route.links.at(-1)?.to ?? BICHON, npc.map);
});

test('waypoints: only unlocked ones (or always-open ones) are used, and ones found missing are left out', () => {
  const place = findPlace(data, `map:${mapIndex('Death Valley Lv 3')}`)!;
  const usesWaypoint = (route: ReturnType<typeof planRoute>) => route?.links.some((l) => l.waypoint?.name === 'Death Valley Lv 3');
  assert.ok(usesWaypoint(planRoute(data, startInBichon(), place, { level: 50, waypoints: new Set(['Death Valley Lv 3']) })));
  assert.ok(!usesWaypoint(planRoute(data, startInBichon(), place, { level: 50, waypoints: new Set(['Bichon Province']) })));
  assert.ok(!usesWaypoint(planRoute(data, startInBichon(), place, { level: 50, badWaypoints: new Set(['Death Valley Lv 3']) })));
  // A waypoint link starts at a stone on its map.
  const link = data.links.find((l) => l.waypoint)!;
  const stone = data.npcs.find((n) => n.id === link.waypoint!.stone)!;
  assert.ok(stone.stone && stone.map === link.from);
});

test('walking paths on a saved map: from the player to an exit, never through a wall or a squeezed corner', () => {
  const { map, player } = loadMapFixture('bichon-province');
  const dist = walkDistances(map, player);
  for (const l of data.links.filter((l) => l.from === BICHON)) {
    const near = nearestApproach(map, dist, l.exit.map(([x, y]) => ({ x, y })));
    if (!near) continue;
    const route = pathBack(map, dist, near.tile);
    assert.deepEqual(route[0], player);
    assert.deepEqual(route.at(-1), near.tile);
    for (let i = 1; i < route.length; i++) {
      const dx = route[i].x - route[i - 1].x, dy = route[i].y - route[i - 1].y;
      assert.ok(Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && canStep(map, route[i - 1].x, route[i - 1].y, dx, dy));
    }
  }
});

test('avoided tiles are walked round', () => {
  const { map, player } = loadMapFixture('bichon-province');
  const dist = walkDistances(map, player);
  const i = dist.indexOf(6);
  const target = { x: i % map.width, y: Math.floor(i / map.width) };
  const plain = pathBack(map, dist, target);
  const avoid = new Set(plain.slice(1, -1).map((t) => t.y * map.width + t.x));
  const round = walkDistances(map, player, avoid);
  const path2 = pathBack(map, round, target);
  assert.ok(path2.slice(1, -1).every((t) => !avoid.has(t.y * map.width + t.x)));
});

/** An 800x800 map (the largest the game has) with a wall every 9th column, a gap in each every 50 rows. */
function bigMap(walls = new Uint8Array((800 * 800) / 8)): MapGrid {
  for (let x = 9; x < 800; x += 9) for (let y = 0; y < 800; y++) if (y % 50 !== 25) walls[(y * 800 + x) >> 3] |= 1 << ((y * 800 + x) & 7);
  return { index: 9100, name: 'Big', width: 800, height: 800, walls, blockSize: 0, gridWidth: 0, gridHeight: 0, explored: null, revision: -1 };
}

test('walking distances asked for again (same walls, start and tiles avoided) are the ones already found; any change searches afresh', () => {
  const map = bigMap();
  const here = { x: 400, y: 400 };
  const before = { ...pathStats };
  const first = walkDistances(map, here, new Set([5, 6]));
  // The same again, the avoided tiles in another order and another set: kept.
  assert.equal(walkDistances(map, here, new Set([6, 5])), first);
  assert.equal(pathStats.searches - before.searches, 1);
  // Another start, other tiles avoided, the map read again (new walls): each its own search, the same answer for the last.
  assert.notEqual(walkDistances(map, { x: 401, y: 400 }, new Set([5, 6])), first);
  assert.notEqual(walkDistances(map, here, new Set([5])), first);
  const again = walkDistances(bigMap(), here, new Set([5, 6]));
  assert.notEqual(again, first);
  assert.deepEqual(again, first);
  assert.equal(pathStats.searches - before.searches, 4);
  // Off the map: nowhere reached, not a tile on it that the index would have named.
  assert.ok(walkDistances(map, { x: -1, y: 401 }).every((d) => d === -1));
});

test('benchmark, 800x800: a seeking tick (a target, its path, the way round monsters, the way back) searches twice, not four times', (t) => {
  const map = bigMap();
  const here = { x: 400, y: 400 };
  const exits = new Set([10, 20, 30]);
  const monsters = new Set([401 * 800 + 401, 399 * 800 + 400]);
  // What bot-hunting's seeking asks for in one tick: three with the exits avoided, one round the monsters too.
  const tick = (x: number) => {
    const at = { x, y: 400 };
    walkDistances(map, at, new Set(exits));
    walkDistances(map, at, new Set(exits));
    walkDistances(map, at, new Set([...exits, ...monsters]));
    walkDistances(map, at, new Set(exits));
  };
  const ticks = 10;
  // Each a new tile (walking): every tick's searches, kept or not.
  let started = performance.now(), searches = pathStats.searches;
  for (let i = 0; i < ticks; i++) tick(300 + i);
  const walking = (performance.now() - started) / ticks;
  assert.equal(pathStats.searches - searches, 2 * ticks);
  // Standing (fighting, waiting): nothing searched again at all.
  tick(500);
  started = performance.now();
  searches = pathStats.searches;
  for (let i = 0; i < ticks; i++) tick(500);
  const standing = (performance.now() - started) / ticks;
  assert.equal(pathStats.searches - searches, 0);
  // Four searches a tick, as before: the same tick with every one fresh.
  started = performance.now();
  for (let i = 0; i < ticks; i++) for (let k = 0; k < 4; k++) walkDistances(map, { x: 600 + i, y: 300 + k }, exits);
  const uncached = (performance.now() - started) / ticks;
  t.diagnostic(`800x800 seeking tick: ${uncached.toFixed(1)} ms with 4 searches (before), ${walking.toFixed(1)} ms walking, ${standing.toFixed(2)} ms standing`);
  assert.ok(walking < uncached * 0.75, `walking ${walking.toFixed(1)} ms vs ${uncached.toFixed(1)} ms`);
  assert.ok(standing < uncached * 0.1, `standing ${standing.toFixed(2)} ms vs ${uncached.toFixed(1)} ms`);
});

test("a spot out of reach on foot (Zuma Temple Lv 5's keeper room): through the map's own teleport, not out and back in", () => {
  const ZUMA_5 = 37;
  const place = findPlace(data, `spot:${ZUMA_5}:142:144`)!;
  // Just in from Lv 4: the way back is a step off, the teleport some 390.
  const start: Start = { map: ZUMA_5, steps: new Map([[2588, 2], [2907, 390], [2589, 538]]), npcSteps: new Map(), at: { x: 14, y: 44 } };
  // Found out of reach from here, and from where coming back in from Lv 4 lands (the same tile); the teleport lands on it.
  const landSteps = new Map(data.links.filter((l) => l.to === ZUMA_5).map((l) => [l.id, l.id === 2907 ? 0 : Infinity]));
  const route = planRoute(data, { ...start, unreachable: true, landSteps }, place, { level: 41 })!;
  assert.deepEqual(route.links.map((l) => l.id), [2907]);
  // Within reach on foot, however long the walk round: never out to Lv 4 and back in to land on the same tile.
  const walk = new Map(data.links.filter((l) => l.to === ZUMA_5).map((l) => [l.id, l.id === 2907 ? 0 : 600]));
  const onFoot = planRoute(data, { ...start, npcSteps: new Map([[place.npc!.id, 600]]), landSteps: walk }, place, { level: 41 })!;
  assert.ok(!onFoot.links.some((l) => l.to !== ZUMA_5), onFoot.links.map((l) => l.id).join(','));
  // With no teleport to take, walked.
  const noTeleport = new Map([...walk].map(([id, steps]) => [id, id === 2907 ? Infinity : steps]));
  const walked = planRoute(data, { ...start, steps: new Map([[2588, 2], [2589, 538]]), npcSteps: new Map([[place.npc!.id, 600]]), landSteps: noTeleport }, place, { level: 41 })!;
  assert.deepEqual(walked.links, []);
  // Without knowing, the walk is guessed from here.
  assert.deepEqual(planRoute(data, start, place, { level: 41 })!.links, []);
});

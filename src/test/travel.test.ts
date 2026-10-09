import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { canStep } from '../main/map-explorer';
import { nearestApproach, pathBack, walkDistances } from '../main/map-path';
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

test("a spot out of reach on foot (Zuma Temple Lv 5's keeper room): through the map's own teleport, not out and back in", () => {
  const ZUMA_5 = 37;
  const place = findPlace(data, `spot:${ZUMA_5}:142:144`)!;
  // Just in from Lv 4: the way back is a step off, the teleport some 390.
  const start: Start = { map: ZUMA_5, steps: new Map([[2588, 2], [2907, 390], [2589, 538]]), npcSteps: new Map(), at: { x: 14, y: 44 } };
  // Found out of reach from here, and from where coming back in from Lv 4 lands (walkable from here).
  const cutOff = new Set(data.links.filter((l) => l.to === ZUMA_5 && l.id !== 2907).map((l) => l.id));
  const route = planRoute(data, { ...start, unreachable: true, cutOff }, place, { level: 41 })!;
  assert.deepEqual(route.links.map((l) => l.id), [2907]);
  // Without knowing, the walk is guessed from here.
  assert.deepEqual(planRoute(data, start, place, { level: 41 })!.links, []);
});

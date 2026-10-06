import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { exploredShare, isBlockExplored, isExplored, isWall, updateMap, type MapGrid, type MapReading } from '../main/map-grid';

/** A map saved from the game by scripts/save-map.js: the reader's map reading plus where the player stood. */
export interface MapFixture extends MapReading {
  player: { x: number; y: number };
}

const folder = path.join(__dirname, '..', '..', 'src', 'test');

export function loadMapFixture(name: string): { map: MapGrid; player: { x: number; y: number } } {
  const fixture = JSON.parse(readFileSync(path.join(folder, `fixture-map-${name}.json`), 'utf8')) as MapFixture;
  return { map: updateMap(null, fixture)!, player: fixture.player };
}

const names = readdirSync(folder)
  .filter((f) => /^fixture-map-.*\.json$/.test(f))
  .map((f) => f.slice('fixture-map-'.length, -'.json'.length));

for (const name of names) {
  test(`saved map ${name}: the player stands on floor, in an explored block`, () => {
    const { map, player } = loadMapFixture(name);
    assert.equal(map.walls.length, Math.ceil((map.width * map.height) / 8));
    assert.ok(map.explored);
    assert.equal(map.gridWidth, Math.ceil(map.width / map.blockSize));
    assert.ok(!isWall(map, player.x, player.y));
    assert.ok(isExplored(map, player.x, player.y));
    const share = exploredShare(map);
    assert.ok(share > 0 && share <= 1);
  });
}

test('off the map is a wall, and unexplored', () => {
  const { map } = loadMapFixture(names[0]);
  assert.ok(isWall(map, -1, 0));
  assert.ok(isWall(map, map.width, 0));
  assert.ok(!isExplored(map, -1, 0));
  assert.ok(!isBlockExplored(map, map.gridWidth, 0));
});

test('updateMap keeps walls until the map changes, and takes explored blocks as they come', () => {
  const walls = Buffer.from([0b00000001, 0, 0, 0, 0, 0, 0, 0]).toString('base64'); // 8x8, wall at 0,0
  const first = updateMap(null, { index: 7, name: 'Test', width: 8, height: 8, walls, blockSize: 4, gridWidth: 2, gridHeight: 2, explored: Buffer.from([0b0001]).toString('base64'), revision: 1 })!;
  assert.ok(isWall(first, 0, 0));
  assert.ok(!isWall(first, 1, 0));
  assert.ok(isExplored(first, 3, 3));
  assert.ok(!isExplored(first, 4, 0));

  // Nothing new: the same grid.
  assert.equal(updateMap(first, { index: 7, name: 'Test', width: 8, height: 8, blockSize: 4, gridWidth: 2, gridHeight: 2, revision: 1 }), first);
  // More explored: block (1, 1) is bit 3.
  const more = updateMap(first, { index: 7, name: 'Test', width: 8, height: 8, blockSize: 4, gridWidth: 2, gridHeight: 2, explored: Buffer.from([0b1001]).toString('base64'), revision: 2 })!;
  assert.ok(isExplored(more, 5, 5));
  assert.ok(isWall(more, 0, 0));
  // Walls sent again for the same map keep the explored blocks.
  assert.ok(isExplored(updateMap(more, { index: 7, name: 'Test', width: 8, height: 8, walls })!, 5, 5));
  // A different map without its walls yet: nothing to go on.
  assert.equal(updateMap(more, { index: 8, name: 'Other', width: 8, height: 8 }), null);
});

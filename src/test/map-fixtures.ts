import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Point } from '../shared/types';
import { isWall, updateMap, type MapGrid, type MapReading } from '../main/map-grid';

/**
 * The maps saved from the game, for the tests. A plain module rather than a
 * test file, as importing a test file would run its tests a second time.
 */

/** A map saved from the game by scripts/save-map.js: the reader's map reading plus where the player stood. */
export interface MapFixture extends MapReading {
  player: { x: number; y: number };
}

const folder = path.join(__dirname, '..', '..', 'src', 'test');

/** The saved maps, by the name in fixture-map-<name>.json. */
export function mapFixtureNames(): string[] {
  return readdirSync(folder)
    .filter((f) => /^fixture-map-.*\.json$/.test(f))
    .map((f) => f.slice('fixture-map-'.length, -'.json'.length));
}

export function loadMapFixture(name: string): { map: MapGrid; player: { x: number; y: number } } {
  const fixture = JSON.parse(readFileSync(path.join(folder, `fixture-map-${name}.json`), 'utf8')) as MapFixture;
  return { map: updateMap(null, fixture)!, player: fixture.player };
}

/**
 * `map` stretched to size x size tiles, for timing on a map as big as the
 * game's largest (about 800x800): no saved map is that big. Each tile copies
 * the original tile under its centre, so a Bichon Province (350x350) tile
 * becomes a patch of 2-3 tiles a side, its corridors get wider and its open
 * fields bigger (the worst case for searching the whole map). Same block size,
 * nothing explored. The player goes to the middle of the patch their tile
 * became, which copies their tile whenever the map grows.
 */
export function stretchMap(map: MapGrid, player: Point, size: number): { map: MapGrid; player: Point } {
  const walls = new Uint8Array(Math.ceil((size * size) / 8));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (isWall(map, Math.floor(((x + 0.5) * map.width) / size), Math.floor(((y + 0.5) * map.height) / size))) walls[i >> 3] |= 1 << (i & 7);
    }
  }
  const grid = Math.ceil(size / map.blockSize);
  const explored = new Uint8Array(Math.ceil((grid * grid) / 8));
  const stretched = { ...map, name: `${map.name} ${size}x${size}`, width: size, height: size, walls, gridWidth: grid, gridHeight: grid, explored, revision: 0 };
  return { map: stretched, player: { x: Math.floor(((player.x + 0.5) * size) / map.width), y: Math.floor(((player.y + 0.5) * size) / map.height) } };
}

/**
 * A map as read from the game's memory: which tiles can be walked on, and
 * which parts have been explored (the fog on the big map). Pure data, so the
 * explore planner can be tested on saved maps (src/test/fixture-map-*.json).
 */

/** The reader's `map` field. Walls and explored come as base64 bits, and only when they change. */
export interface MapReading {
  index: number;
  name: string;
  width: number;
  height: number;
  /** Bit (y * width + x), lowest bit first: set where a tile can't be walked on. */
  walls?: string;
  /** Exploration is kept in square blocks of `blockSize` tiles, gridWidth x gridHeight of them. */
  blockSize?: number;
  gridWidth?: number;
  gridHeight?: number;
  /** Bit (gy * gridWidth + gx), lowest bit first: set where a block has been explored. */
  explored?: string;
  /** Goes up each time the game reveals more of the map. */
  revision?: number;
}

export interface MapGrid {
  index: number;
  name: string;
  width: number;
  height: number;
  walls: Uint8Array;
  blockSize: number;
  gridWidth: number;
  gridHeight: number;
  /** Null until the game has said what's explored (or on maps without exploration). */
  explored: Uint8Array | null;
  revision: number;
}

const bit = (bits: Uint8Array, i: number) => (bits[i >> 3] & (1 << (i & 7))) !== 0;
const decode = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'));

/**
 * Brings `previous` up to date with a reading: a new map needs its walls, and
 * the explored blocks are only sent when they change. Null until the walls of
 * the current map have arrived.
 */
export function updateMap(previous: MapGrid | null, reading: MapReading | null | undefined): MapGrid | null {
  if (!reading) return null;
  const same = previous && previous.index === reading.index && previous.width === reading.width && previous.height === reading.height;
  let map: MapGrid;
  if (reading.walls) {
    map = { index: reading.index, name: reading.name, width: reading.width, height: reading.height, walls: decode(reading.walls), blockSize: 0, gridWidth: 0, gridHeight: 0, explored: null, revision: -1 };
    // Walls re-sent for the same map keep what's known about exploring.
    if (same) map = { ...map, blockSize: previous.blockSize, gridWidth: previous.gridWidth, gridHeight: previous.gridHeight, explored: previous.explored, revision: previous.revision };
  } else if (same) {
    map = previous;
  } else {
    return null;
  }
  if (reading.explored && reading.blockSize && reading.gridWidth && reading.gridHeight) {
    map = { ...map, blockSize: reading.blockSize, gridWidth: reading.gridWidth, gridHeight: reading.gridHeight, explored: decode(reading.explored), revision: reading.revision ?? 0 };
  }
  return map;
}

/** Off the map counts as a wall. */
export function isWall(map: MapGrid, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return true;
  return bit(map.walls, y * map.width + x);
}

/** Whether the block holding tile (x, y) has been explored (false if exploring isn't known). */
export function isExplored(map: MapGrid, x: number, y: number): boolean {
  if (!map.explored || x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  const gx = Math.floor(x / map.blockSize), gy = Math.floor(y / map.blockSize);
  return bit(map.explored, gy * map.gridWidth + gx);
}

/** Whether block (gx, gy) has been explored. */
export function isBlockExplored(map: MapGrid, gx: number, gy: number): boolean {
  if (!map.explored || gx < 0 || gy < 0 || gx >= map.gridWidth || gy >= map.gridHeight) return false;
  return bit(map.explored, gy * map.gridWidth + gx);
}

/** Share (0-1) of the blocks with somewhere to walk that have been explored. */
export function exploredShare(map: MapGrid): number {
  if (!map.explored) return 0;
  let walkable = 0, explored = 0;
  for (let gy = 0; gy < map.gridHeight; gy++) {
    for (let gx = 0; gx < map.gridWidth; gx++) {
      if (!blockHasFloor(map, gx, gy)) continue;
      walkable++;
      if (isBlockExplored(map, gx, gy)) explored++;
    }
  }
  return walkable ? explored / walkable : 1;
}

/** Whether any tile in block (gx, gy) can be walked on. */
export function blockHasFloor(map: MapGrid, gx: number, gy: number): boolean {
  for (let y = gy * map.blockSize; y < (gy + 1) * map.blockSize; y++) {
    for (let x = gx * map.blockSize; x < (gx + 1) * map.blockSize; x++) if (!isWall(map, x, y)) return true;
  }
  return false;
}

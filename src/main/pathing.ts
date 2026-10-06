import type { Point } from '../shared/types';

export interface Tile {
  x: number;
  y: number;
  cost: number;
  /** Estimated distance to the target, ignoring walls. */
  distance: number;
  parent: Tile | null;
}

/** Everything the pathing remembers while walking towards one destination. */
export class Journey {
  active: Tile[] = [];
  visited: Tile[] = [];
  walls: Tile[] = [];
  previousTile: Tile | null = null;

  constructor(public previousPosition: Point) {}
}

function distanceTo(x: number, y: number, target: Point): number {
  return Math.abs(target.x - x) + Math.abs(target.y - y);
}

export function startTile(from: Point, target: Point): Tile {
  return { x: from.x, y: from.y, cost: 0, distance: distanceTo(from.x, from.y, target), parent: null };
}

/** The active tile with the lowest cost + distance; the earliest one wins ties. */
export function cheapestTile(active: Tile[]): Tile {
  let best = active[0];
  for (const tile of active) {
    if (tile.cost + tile.distance < best.cost + best.distance) best = tile;
  }
  return best;
}

/** Sign of the step from `from` towards `to` on each axis. */
export function direction(from: Point, to: Point): Point {
  return { x: Math.sign(to.x - from.x), y: Math.sign(to.y - from.y) };
}

function contains(tiles: Tile[], x: number, y: number): boolean {
  return tiles.some((tile) => tile.x === x && tile.y === y);
}

/** Marks everything between the previous position and `tile` as visited. */
export function markPathVisited(journey: Journey, tile: Tile): void {
  const from = journey.previousPosition;
  const cost = journey.previousTile?.cost ?? 0;
  const stepX = from.x < tile.x ? 1 : -1;
  const stepY = from.y < tile.y ? 1 : -1;
  const visit = (x: number, y: number) => journey.visited.push({ x, y, cost, distance: 0, parent: null });

  if (from.x !== tile.x && from.y === tile.y) {
    for (let x = from.x; x !== tile.x; x += stepX) visit(x, from.y);
  } else if (from.x === tile.x && from.y !== tile.y) {
    for (let y = from.y; y !== tile.y; y += stepY) visit(from.x, y);
  } else if (from.x !== tile.x && from.y !== tile.y) {
    for (let x = from.x; x !== tile.x; x += stepX) {
      for (let y = from.y; y !== tile.y; y += stepY) visit(x, y);
    }
  }
}

// One step of autorun covers roughly 3 map pixels across and 2 down.
const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [3, 0], [3, 2], [0, 2], [3, -2], [0, -2], [-3, 0], [-3, 2], [-3, -2],
];

/**
 * Moves `tile` to where the character actually ended up and replaces the
 * active list with its neighbours that are neither walls nor already visited.
 */
export function expandFrom(journey: Journey, tile: Tile, position: Point, target: Point): void {
  tile.x = position.x;
  tile.y = position.y;

  journey.active.length = 0;
  for (const [dx, dy] of NEIGHBOURS) {
    const x = tile.x + dx;
    const y = tile.y + dy;
    if (contains(journey.walls, x, y) || contains(journey.visited, x, y)) continue;
    journey.active.push({ x, y, cost: tile.cost + 1, distance: distanceTo(x, y, target), parent: tile });
  }
}

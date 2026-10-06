import type { Point } from '../shared/types';
import { canStep, MapExplorer, type ExploreRoute } from '../main/map-explorer';
import type { MapGrid } from '../main/map-grid';

/**
 * A model of exploring a saved map with the memory planner (map-explorer.ts).
 * Nothing is explored but around the start; each step the player walks a run
 * along the planner's path, and the game uncovers the blocks near them.
 */

/** A spot the player got stuck at is avoided for this many steps. */
const BLOCKED_STEPS = 20;

export interface MapSimOptions {
  /** Blocks are uncovered when their centre is within this many blocks of the player. The game's radius is unknown: 3 is a guess. */
  revealRadius?: number;
  /** Tiles walked along the path each step: 2 is one run. */
  tilesPerStep?: number;
  /** Stop once this share of the reachable blocks is explored; 1 runs until the planner says done. */
  goal?: number;
  /**
   * Give up after this many steps. By default, twice the walk of a perfect sweep:
   * one pass uncovers a swath about 2 x radius blocks wide.
   */
  maxSteps?: number;
  /** Tiles the map shows as floor that can't be walked onto, like a monster standing there. */
  obstacles?: Point[];
  /** Sees every route the planner gives, with where the player stood and the map as explored so far. */
  onRoute?: (route: ExploreRoute, player: Point, map: MapGrid) => void;
}

export interface MapSimResult {
  /** Steps (one plan() and one run each) taken until 80% and 95% of the reachable blocks were explored, or null if never. */
  steps80: number | null;
  steps95: number | null;
  steps: number;
  /** Share of the reachable blocks explored at the end. */
  explored: number;
  reachableBlocks: number;
  /** The planner said nothing was left. */
  done: boolean;
  searches: number;
  blocked: number;
  /** Time spent in plan() per call, in ms, timed here as the planner has no clock. */
  planMs: { mean: number; max: number };
}

const bit = (bits: Uint8Array, i: number) => (bits[i >> 3] & (1 << (i & 7))) !== 0;

/** Which blocks hold a tile the player can walk to from `start`: 1 for yes. */
export function reachableBlocks(map: MapGrid, start: Point): Uint8Array {
  const blocks = new Uint8Array(map.gridWidth * map.gridHeight);
  const seen = new Uint8Array(map.width * map.height);
  const queue = [start];
  seen[start.y * map.width + start.x] = 1;
  for (let head = 0; head < queue.length; head++) {
    const { x, y } = queue[head];
    blocks[Math.floor(y / map.blockSize) * map.gridWidth + Math.floor(x / map.blockSize)] = 1;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const next = (y + dy) * map.width + x + dx;
        if ((dx || dy) && canStep(map, x, y, dx, dy) && !seen[next]) {
          seen[next] = 1;
          queue.push({ x: x + dx, y: y + dy });
        }
      }
    }
  }
  return blocks;
}

export function simulateMapExplore(source: MapGrid, start: Point, options: MapSimOptions = {}): MapSimResult {
  const radius = options.revealRadius ?? 3;
  const tilesPerStep = options.tilesPerStep ?? 2;
  const goal = options.goal ?? 0.95;
  const map: MapGrid = { ...source, explored: new Uint8Array(Math.ceil((source.gridWidth * source.gridHeight) / 8)), revision: 0 };
  const reachable = reachableBlocks(map, start);
  const total = reachable.reduce((sum, r) => sum + r, 0);
  const maxSteps = options.maxSteps ?? Math.ceil((total * map.blockSize) / (tilesPerStep * radius));
  const obstacles = new Set((options.obstacles ?? []).map((p) => p.y * map.width + p.x));
  let explored = 0;

  // Uncover every block whose centre is within the radius of the player's tile. Walls don't block the view: the game's is unknown.
  const reveal = (p: Point) => {
    const size = map.blockSize, range = radius * size;
    const pgx = Math.floor(p.x / size), pgy = Math.floor(p.y / size);
    for (let gy = pgy - radius - 1; gy <= pgy + radius + 1; gy++) {
      for (let gx = pgx - radius - 1; gx <= pgx + radius + 1; gx++) {
        const g = gy * map.gridWidth + gx;
        if (gx < 0 || gy < 0 || gx >= map.gridWidth || gy >= map.gridHeight || bit(map.explored!, g)) continue;
        if ((gx * size + size / 2 - (p.x + 0.5)) ** 2 + (gy * size + size / 2 - (p.y + 0.5)) ** 2 > range ** 2) continue;
        map.explored![g >> 3] |= 1 << (g & 7);
        map.revision++;
        if (reachable[g]) explored++;
      }
    }
  };

  const explorer = new MapExplorer();
  const player = { ...start };
  let steps = 0, steps80: number | null = null, steps95: number | null = null;
  let done = false, blocked = 0, planTotal = 0, planMax = 0, calls = 0;
  const record = () => {
    if (steps80 === null && explored >= 0.8 * total) steps80 = steps;
    if (steps95 === null && explored >= 0.95 * total) steps95 = steps;
  };
  reveal(player);
  record();
  while (steps < maxSteps && !(goal < 1 && explored >= goal * total)) {
    const started = performance.now();
    const route = explorer.plan(map, player, steps);
    const ms = performance.now() - started;
    planTotal += ms;
    planMax = Math.max(planMax, ms);
    calls++;
    if (route === 'done' || route === null) {
      done = route === 'done';
      break;
    }
    options.onRoute?.(route, { ...player }, map);

    // Walk a run along the path, stopping short of anything the map doesn't show.
    let moved = 0;
    for (const tile of route.path.slice(1, 1 + tilesPerStep)) {
      if (obstacles.has(tile.y * map.width + tile.x)) break;
      player.x = tile.x;
      player.y = tile.y;
      moved++;
      reveal(player);
    }
    if (moved === 0) {
      explorer.blocked(steps + BLOCKED_STEPS);
      blocked++;
    }
    steps++;
    record();
  }
  return {
    steps80, steps95, steps, explored: explored / total, reachableBlocks: total, done,
    searches: explorer.searches, blocked, planMs: { mean: planTotal / Math.max(1, calls), max: planMax },
  };
}

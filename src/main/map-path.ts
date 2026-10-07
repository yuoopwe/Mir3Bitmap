import type { Point } from '../shared/types';
import { canStep } from './map-explorer';
import type { MapGrid } from './map-grid';

/** The 8 ways to step, straight ones first (see map-explorer's STEPS). */
const STEPS: Point[] = [
  { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 },
  { x: 1, y: 1 }, { x: -1, y: 1 }, { x: -1, y: -1 }, { x: 1, y: -1 },
];

/**
 * Steps from `from` to every tile that can be walked to (-1 where it can't),
 * not stepping on `avoid` (tile indices, y * width + x).
 */
export function walkDistances(map: MapGrid, from: Point, avoid: ReadonlySet<number> = new Set()): Int32Array {
  const { width, height } = map;
  const dist = new Int32Array(width * height).fill(-1);
  if (from.x < 0 || from.y < 0 || from.x >= width || from.y >= height) return dist;
  const queue = new Int32Array(width * height);
  let head = 0, tail = 0;
  dist[from.y * width + from.x] = 0;
  queue[tail++] = from.y * width + from.x;
  while (head < tail) {
    const at = queue[head++], x = at % width, y = (at - x) / width;
    for (const s of STEPS) {
      const nx = x + s.x, ny = y + s.y, n = ny * width + nx;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height || dist[n] >= 0 || avoid.has(n) || !canStep(map, x, y, s.x, s.y)) continue;
      dist[n] = dist[at] + 1;
      queue[tail++] = n;
    }
  }
  return dist;
}

/**
 * The nearest tile that reaches one of `targets`: a target itself, or a floor
 * tile next to one (exits and NPCs can stand on tiles the map calls walls).
 * Null if none can be walked to.
 */
export function nearestApproach(map: MapGrid, dist: Int32Array, targets: Point[]): { tile: Point; steps: number } | null {
  let best: { tile: Point; steps: number } | null = null;
  for (const t of targets) {
    for (const s of [{ x: 0, y: 0 }, ...STEPS]) {
      const x = t.x + s.x, y = t.y + s.y;
      if (x < 0 || y < 0 || x >= map.width || y >= map.height) continue;
      const d = dist[y * map.width + x];
      if (d < 0) continue;
      // Standing next to it, the last step onto it is still to come.
      const steps = d + (s.x || s.y ? 1 : 0);
      if (!best || steps < best.steps) best = { tile: { x, y }, steps };
    }
  }
  return best;
}

/** The tiles from the start of `dist` to `to` (both included), walking back down the distances. */
export function pathBack(map: MapGrid, dist: Int32Array, to: Point): Point[] {
  const path = [to];
  let { x, y } = to;
  for (let d = dist[y * map.width + x]; d > 0; d--) {
    const step = STEPS.find((s) => {
      const px = x - s.x, py = y - s.y;
      return px >= 0 && py >= 0 && px < map.width && py < map.height && dist[py * map.width + px] === d - 1 && canStep(map, px, py, s.x, s.y);
    });
    if (!step) break;
    x -= step.x;
    y -= step.y;
    path.push({ x, y });
  }
  return path.reverse();
}

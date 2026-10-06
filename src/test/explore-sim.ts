import type { Point } from '../shared/types';
import { analyseGrid, Cell, CELL_SIZE, findBigMap, readBigMap } from '../main/bigmap';
import { ExplorePlanner, type PlannerOptions } from '../main/explorer';
import { loadPng } from './png';

/**
 * A rough model of exploring a real big-map capture, for comparing how the
 * planner behaves. The player runs in the game's 8 tile directions, 2 tiles a
 * step, can teleport 6 tiles every 3 seconds, and uncovers the fog within view.
 */

/** Map pixels per tile. The big map keeps the world's proportions (tiles are 48x32 on screen). */
const TILE_X = 2.7;
const TILE_Y = 1.8;
/** Fog within this distance of the player (map pixels) is uncovered: about the screen's view. */
const VIEW_X = 40;
const VIEW_Y = 26;
const RUN_TILES = 2;
const TELEPORT_TILES = 6;
const TELEPORT_COOLDOWN_STEPS = 6;
const STUCK_STEPS = 3;

export interface SimOptions {
  planner: PlannerOptions;
  /** Steer the old way, stretching map directions as if map cells were square tiles. */
  stretchedSteering: boolean;
  /** Stop once this share is explored. */
  goal: number;
  maxSteps: number;
  /** Seed for random choices (sidesteps, position wobble), so runs are repeatable. */
  seed?: number;
  /**
   * How far off (map pixels) the position the planner is given can be. With pets out
   * the bot reads the centre of their light-blue cluster, which wanders around the player.
   */
  positionWobble?: number;
  /** A free random teleport (to anywhere explored) that unlocks at some share explored, as in the game at 60%. */
  reroll?: { unlockAt: number; costSteps: number; maxInRow: number };
  /** Map pixels per tile, if not the usual (maps are drawn at different scales). */
  tile?: { x: number; y: number };
  /** How far the player can see (map pixels), if not the usual. */
  view?: { x: number; y: number };
  /** Called after every step, for debugging. */
  trace?: (step: { step: number; pos: Point; direction: Point; moved: number; target: Point | null; waypoint: Point | null; explored: number }) => void;
}

export interface SimResult {
  steps: number;
  /** Random teleports used. */
  rerolls: number;
  explored: number;
  /** Tiles moved in total. */
  tiles: number;
  /** Steps that went roughly the opposite way to the step before. */
  reversals: number;
  stuckSteps: number;
  reachedGoal: boolean;
}

const DIRECTIONS: Point[] = [
  { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 },
  { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
];

export function simulate(fixture: string, start: Point, options: SimOptions): SimResult {
  const frame = loadPng(fixture);
  const tileX = options.tile?.x ?? TILE_X, tileY = options.tile?.y ?? TILE_Y;
  const viewX = options.view?.x ?? VIEW_X, viewY = options.view?.y ?? VIEW_Y;
  const first = readBigMap(frame, findBigMap(frame)!);
  const { content } = first;
  const grid = { ...first.grid, cells: Uint8Array.from(first.grid.cells) };
  const { cols, rows, cells } = grid;
  const truth = Uint8Array.from(cells);

  // Treat cells right next to void as wall where there's wider floor beside them: the map can't tell
  // walls from floor, but the game can. A corridor only a cell or two wide (mazes) is all floor.
  const besideVoid = (cx: number, cy: number) => {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || truth[ny * cols + nx] === Cell.Void) return true;
    }
    return false;
  };
  const solid = new Uint8Array(cells.length);
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    if (truth[cy * cols + cx] === Cell.Void) {
      solid[cy * cols + cx] = 1;
      continue;
    }
    if (!besideVoid(cx, cy)) continue;
    let widerFloor = false;
    for (let dy = -1; dy <= 1 && !widerFloor; dy++) for (let dx = -1; dx <= 1 && !widerFloor; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && truth[ny * cols + nx] !== Cell.Void && !besideVoid(nx, ny)) widerFloor = true;
    }
    solid[cy * cols + cx] = widerFloor ? 1 : 0;
  }
  const cellAt = (p: Point) => {
    const cx = Math.floor((p.x - content.left) / CELL_SIZE), cy = Math.floor((p.y - content.top) / CELL_SIZE);
    return cx < 0 || cy < 0 || cx >= cols || cy >= rows ? -1 : cy * cols + cx;
  };
  const open = (p: Point) => {
    const cell = cellAt(p);
    return cell >= 0 && !solid[cell];
  };
  const reveal = (p: Point) => {
    for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
      const x = content.left + cx * CELL_SIZE + CELL_SIZE / 2, y = content.top + cy * CELL_SIZE + CELL_SIZE / 2;
      if (((x - p.x) / viewX) ** 2 + ((y - p.y) / viewY) ** 2 <= 1 && cells[cy * cols + cx] === Cell.Fog) cells[cy * cols + cx] = Cell.Explored;
    }
  };
  let seed = options.seed ?? 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  // Move up to `tiles` tiles in direction d, stopping at walls. Returns tiles moved.
  const move = (p: Point, d: Point, tiles: number): number => {
    let moved = 0;
    for (let i = 0; i < tiles; i++) {
      const next = { x: p.x + d.x * tileX, y: p.y + d.y * tileY };
      if (!open(next)) break;
      p.x = next.x;
      p.y = next.y;
      moved++;
    }
    return moved;
  };

  const planner = new ExplorePlanner(options.planner);
  const pos = { ...start };
  // Start on open ground near the given spot.
  if (!open(pos)) {
    let best: Point | null = null;
    for (let r = 1; r < 10 && !best; r++) for (const d of DIRECTIONS) {
      const p = { x: pos.x + d.x * r * CELL_SIZE, y: pos.y + d.y * r * CELL_SIZE };
      if (!best && open(p)) best = p;
    }
    if (best) Object.assign(pos, best);
  }
  reveal(pos);

  let tiles = 0, reversals = 0, stuckSteps = 0, still = 0, nextTeleport = 0, rerolls = 0, rerollsInRow = 0;
  let previous: Point | null = null;
  let map = analyseGrid(content, grid);
  let step = 0;
  for (; step < options.maxSteps && map.explored < options.goal; step++) {
    const wobble = options.positionWobble ?? 0;
    const angle = random() * 2 * Math.PI, radius = Math.sqrt(random()) * wobble;
    const seen = { x: pos.x + Math.cos(angle) * radius, y: pos.y + Math.sin(angle) * radius };
    // A free random teleport, when it's worth it.
    const r = options.reroll;
    if (r && map.explored >= r.unlockAt && rerollsInRow < r.maxInRow && planner.shouldReroll(map, seen)) {
      const landing: number[] = [];
      for (let i = 0; i < cells.length; i++) if (cells[i] === Cell.Explored && !solid[i]) landing.push(i);
      const cell = landing[Math.floor(random() * landing.length)];
      pos.x = content.left + (cell % cols) * CELL_SIZE + CELL_SIZE / 2;
      pos.y = content.top + Math.floor(cell / cols) * CELL_SIZE + CELL_SIZE / 2;
      planner.teleported();
      rerolls++;
      rerollsInRow++;
      step += r.costSteps - 1;
      reveal(pos);
      map = analyseGrid(content, grid);
      continue;
    }
    rerollsInRow = 0;
    const plan = planner.plan(map, seen);
    let d: Point;
    if (!plan) {
      d = DIRECTIONS[Math.floor(random() * 8)];
    } else {
      // Map direction -> where the cursor goes on screen -> the game's tile direction.
      // The bot steers from where it thinks the player is.
      const vx = plan.waypoint.x - seen.x, vy = plan.waypoint.y - seen.y;
      const sx = options.stretchedSteering ? vx * 48 : vx, sy = options.stretchedSteering ? vy * 32 : vy;
      const tx = sx / (tileX / TILE_X) / 48, ty = sy / (tileY / TILE_Y) / 32;
      d = DIRECTIONS[((Math.round(Math.atan2(ty, tx) / (Math.PI / 4)) % 8) + 8) % 8];
    }

    let moved = 0;
    if (plan?.teleport && step >= nextTeleport) {
      // A teleport lands as far along as it can, up to its range.
      moved = move(pos, d, TELEPORT_TILES);
      if (moved > 0) nextTeleport = step + TELEPORT_COOLDOWN_STEPS;
    }
    if (moved === 0) moved = move(pos, d, RUN_TILES);
    if (moved === 0) {
      stuckSteps++;
      if (++still >= STUCK_STEPS) {
        // Step aside, as the bot does when stuck.
        const i = DIRECTIONS.indexOf(d);
        moved = move(pos, DIRECTIONS[(i + (random() < 0.5 ? 2 : 6)) % 8], RUN_TILES);
        still = 0;
      }
    } else {
      still = 0;
    }
    if (moved > 0) {
      if (previous && previous.x * d.x + previous.y * d.y < 0 && Math.abs(previous.x + d.x) + Math.abs(previous.y + d.y) <= 1) reversals++;
      previous = d;
    }
    tiles += moved;
    reveal(pos);
    map = analyseGrid(content, grid);
    options.trace?.({ step, pos: { ...pos }, direction: d, moved, target: plan?.target ?? null, waypoint: plan?.waypoint ?? null, explored: map.explored });
  }
  return { steps: step, rerolls, explored: map.explored, tiles, reversals, stuckSteps, reachedGoal: map.explored >= options.goal };
}

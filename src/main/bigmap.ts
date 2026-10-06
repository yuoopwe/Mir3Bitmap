import type { Point } from '../shared/types';
import type { Rect } from './layout';
import type { Frame } from './vision';

/**
 * The big map (B) is a panel framed by a wood-textured brown border with a
 * thin black margin inside it. Inside, explored ground is drawn normally,
 * unexplored ground is darkened, and the void between corridors is black.
 */
const MIN_PANEL_HEIGHT = 400;
const MIN_PANEL_WIDTH = 300;
/**
 * The panel has two layouts. In one the buttons sit over the top of the map and
 * the route hint and "Explored" bar over its bottom; in the other they're in a
 * bar under the map, which then fills the margin.
 */
const OVERLAID_INSET = { left: 6, top: 42, right: 6, bottom: 48 };
const CLEAR_INSET = { left: 3, top: 3, right: 3, bottom: 3 };
/** Where the "Compact" button's dark red fill is when it sits over the map (from the panel's top left). */
const COMPACT_BUTTON = { left: 12, top: 14, right: 66, bottom: 34 };

/** Brightest channel below this is void; up to EXPLORED is fog-darkened ground; above, explored ground. */
const VOID = 12;
const EXPLORED = 70;
/** The map is judged in cells this size, which smooths out cracks and shadows on explored ground. */
const CELL = 6;
export const CELL_SIZE = CELL;
/** Thick fog this close to explored ground (in cells) is an unexplored edge; the wall strip sits in between. */
const EDGE_REACH = 3;
/**
 * Fog at least this many cells from explored ground is unexplored however thin
 * it is (a maze's corridors can be just a cell or two wide); the shaded walls
 * of explored corridors never reach this far.
 */
const DEEP = 3;
/** How much deep fog (cells) an edge has to lead into to count as a way into unexplored ground rather than a dark patch. */
export const LEADS_ON = 40;

/** What a map cell shows. */
export const enum Cell {
  Void,
  Fog,
  Explored,
}

/** The map judged cell by cell. */
export interface Grid {
  cols: number;
  rows: number;
  cells: Uint8Array;
}

export interface Frontier {
  /** Screen position to route to: a fogged cell next to explored ground. */
  point: Point;
  /** How many fogged cells border explored ground here. */
  size: number;
  /** How much deep fog (cells, up to LEADS_ON) it leads into: a corridor or area running on, rather than a dark patch. */
  reach: number;
}

export interface BigMapReading {
  /** The map area inside the panel. */
  content: Rect;
  /** The map judged cell by cell (void, fog, explored), for planning routes. */
  grid: Grid;
  /** Share of the map's ground that's explored, 0-1. */
  explored: number;
  /** Places where explored ground meets fog, biggest first. */
  frontiers: Frontier[];
}

function isBrown(pixel: number): boolean {
  const r = (pixel >> 16) & 0xff, g = (pixel >> 8) & 0xff, b = pixel & 0xff;
  return r >= 55 && r <= 110 && g >= 40 && g <= 85 && b >= 10 && b <= 50 && r > g && g > b;
}

function isBlack(pixel: number): boolean {
  return (pixel & 0xfcfcfc) === 0; // every channel 0-3
}

/** Share of rows top..bottom where column x is border brown. */
function brownShare(frame: Frame, x: number, top: number, bottom: number): number {
  let brown = 0;
  for (let y = top; y <= bottom; y++) if (isBrown(frame.pixels[y * frame.width + x])) brown++;
  return brown / (bottom - top + 1);
}

/**
 * Finds the open big map's panel (the black margin inside its border), or
 * null if it isn't open: a tall black column with border brown just outside
 * it, on each side.
 */
export function findBigMap(frame: Frame): Rect | null {
  const { width, height, pixels } = frame;
  let left: { x: number; top: number; bottom: number } | null = null;
  let right: { x: number; top: number; bottom: number } | null = null;
  for (let x = 1; x < width - 1; x++) {
    // Longest run of black in this column.
    let bestTop = 0, bestLength = 0, runTop = 0;
    for (let y = 0; y <= height; y++) {
      if (y < height && isBlack(pixels[y * width + x])) continue;
      if (y - runTop > bestLength) {
        bestLength = y - runTop;
        bestTop = runTop;
      }
      runTop = y + 1;
    }
    if (bestLength < MIN_PANEL_HEIGHT) continue;
    const bottom = bestTop + bestLength - 1;
    if (!left && brownShare(frame, x - 1, bestTop, bottom) >= 0.8) left = { x, top: bestTop, bottom };
    if (brownShare(frame, x + 1, bestTop, bottom) >= 0.8) right = { x, top: bestTop, bottom };
  }
  if (!left || !right || right.x - left.x < MIN_PANEL_WIDTH) return null;
  return { left: left.x, top: Math.max(left.top, right.top), right: right.x + 1, bottom: Math.min(left.bottom, right.bottom) + 1 };
}

function classify(pixel: number): Cell {
  const r = (pixel >> 16) & 0xff, g = (pixel >> 8) & 0xff, b = pixel & 0xff;
  const brightest = r > g ? (r > b ? r : b) : g > b ? g : b;
  return brightest < VOID ? Cell.Void : brightest < EXPLORED ? Cell.Fog : Cell.Explored;
}

/** Whether the map's buttons sit over its top (one of the panel's two layouts): the "Compact" button's dark red is there. */
function hasOverlaidButtons(frame: Frame, panel: Rect): boolean {
  let red = 0, total = 0;
  for (let y = panel.top + COMPACT_BUTTON.top; y < panel.top + COMPACT_BUTTON.bottom; y += 2) {
    for (let x = panel.left + COMPACT_BUTTON.left; x < panel.left + COMPACT_BUTTON.right; x += 2) {
      const p = frame.pixels[y * frame.width + x];
      const r = (p >> 16) & 0xff, g = (p >> 8) & 0xff, b = p & 0xff;
      total++;
      if (r >= 18 && r <= 60 && g * 2 <= r + 4 && b * 2 <= r + 2) red++;
    }
  }
  return red >= total * 0.4;
}

/** The map area inside the panel, clear of its buttons and bars. */
export function mapContent(frame: Frame, panel: Rect): Rect {
  const inset = hasOverlaidButtons(frame, panel) ? OVERLAID_INSET : CLEAR_INSET;
  return { left: panel.left + inset.left, top: panel.top + inset.top, right: panel.right - inset.right, bottom: panel.bottom - inset.bottom };
}

/** Reads how much of the map is explored and where the unexplored edges are. */
export function readBigMap(frame: Frame, panel: Rect): BigMapReading {
  const content = mapContent(frame, panel);
  const cols = Math.floor((content.right - content.left) / CELL);
  const rows = Math.floor((content.bottom - content.top) / CELL);
  const cells = new Uint8Array(cols * rows);

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let fog = 0, explored = 0;
      for (let y = 0; y < CELL; y++) {
        const row = (content.top + cy * CELL + y) * frame.width + content.left + cx * CELL;
        for (let x = 0; x < CELL; x++) {
          const kind = classify(frame.pixels[row + x]);
          if (kind === Cell.Fog) fog++;
          else if (kind === Cell.Explored) explored++;
        }
      }
      const total = CELL * CELL;
      // Explored ground still has dark cracks and shadows; a fair share of bright pixels is enough.
      const kind = explored >= total * 0.35 ? Cell.Explored : fog + explored >= total * 0.5 ? Cell.Fog : Cell.Void;
      cells[cy * cols + cx] = kind;
    }
  }
  return analyseGrid(content, { cols, rows, cells });
}

/**
 * Works out the explored share and the unexplored edges from a judged map.
 *
 * The walls along explored corridors are shaded dark enough to look like fog,
 * but only in strips a cell or two thick, right beside explored ground. So
 * fog counts as unexplored if it's thick (some of its cells have fog on every
 * side) or deep (well away from explored ground, as a maze's narrow corridors
 * are once past their entrance). An unexplored edge is thick fog within a few
 * cells of explored ground, or where deep fog starts.
 */
export function analyseGrid(content: Rect, grid: Grid): BigMapReading {
  const { cols, rows, cells } = grid;
  const at = (cx: number, cy: number) => (cx >= 0 && cy >= 0 && cx < cols && cy < rows ? cells[cy * cols + cx] : Cell.Void);

  // How far each cell is from explored ground (in cells, any direction), up to DEEP.
  const fromExplored = new Uint8Array(cells.length).fill(DEEP);
  let ring: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== Cell.Explored) continue;
    fromExplored[i] = 0;
    ring.push(i);
  }
  for (let d = 1; d < DEEP && ring.length; d++) {
    const next: number[] = [];
    for (const cell of ring) {
      const cx = cell % cols, cy = (cell - cx) / cols;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = ny * cols + nx;
        if (fromExplored[n] > d) {
          fromExplored[n] = d;
          next.push(n);
        }
      }
    }
    ring = next;
  }
  const isDeep = (i: number) => cells[i] === Cell.Fog && fromExplored[i] >= DEEP;

  // Fog with fog on all eight sides.
  const core = new Uint8Array(cells.length);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (at(cx, cy) !== Cell.Fog) continue;
      let all = true;
      for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1 && all; dx++) if (at(cx + dx, cy + dy) !== Cell.Fog) all = false;
      if (all) core[cy * cols + cx] = 1;
    }
  }

  // Unexplored ground: the cores and the fog right next to them.
  let thickFog = 0, exploredCells = 0;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const kind = at(cx, cy);
      if (kind === Cell.Explored) exploredCells++;
      if (kind !== Cell.Fog) continue;
      let near = isDeep(cy * cols + cx);
      for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && core[ny * cols + nx]) near = true;
      }
      if (near) thickFog++;
    }
  }

  const nearExplored = (cx: number, cy: number) => {
    for (let dy = -EDGE_REACH; dy <= EDGE_REACH; dy++) for (let dx = -EDGE_REACH; dx <= EDGE_REACH; dx++) if (at(cx + dx, cy + dy) === Cell.Explored) return true;
    return false;
  };
  // Thick fog near explored ground, or the first cells of deep fog.
  const isFrontier = (cx: number, cy: number) => {
    const i = cy * cols + cx;
    return (core[i] === 1 && nearExplored(cx, cy)) || (isDeep(i) && hasCloserFog(cx, cy));
  };
  /** A deep fog cell beside fog that's nearer explored ground: where deep fog starts, coming from explored ground. */
  function hasCloserFog(cx: number, cy: number): boolean {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const n = ny * cols + nx;
      if (cells[n] === Cell.Fog && fromExplored[n] < DEEP) return true;
    }
    return false;
  }
  /** How much deep fog the group's cells lead into, up to LEADS_ON. */
  function reachOf(group: number[]): number {
    const seenDeep = new Set<number>();
    const stack = group.filter(isDeep);
    for (const cell of stack) seenDeep.add(cell);
    while (stack.length && seenDeep.size < LEADS_ON) {
      const cell = stack.pop()!;
      const cx = cell % cols, cy = (cell - cx) / cols;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = ny * cols + nx;
        if (!seenDeep.has(n) && isDeep(n)) {
          seenDeep.add(n);
          stack.push(n);
        }
      }
    }
    return Math.min(seenDeep.size, LEADS_ON);
  }

  // Group touching edge cells; each group is one place to head for.
  const seen = new Uint8Array(cols * rows);
  const frontiers: Frontier[] = [];
  for (let start = 0; start < cells.length; start++) {
    if (seen[start] || !isFrontier(start % cols, Math.floor(start / cols))) continue;
    const group: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const cell = stack.pop()!;
      group.push(cell);
      const cx = cell % cols, cy = (cell - cx) / cols;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const next = ny * cols + nx;
          if (!seen[next] && isFrontier(nx, ny)) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
    }
    // Aim at the group's member closest to its middle, so the point is on the edge itself.
    let sx = 0, sy = 0;
    for (const cell of group) {
      sx += cell % cols;
      sy += Math.floor(cell / cols);
    }
    const mx = sx / group.length, my = sy / group.length;
    let best = group[0], bestDistance = Infinity;
    for (const cell of group) {
      const d = (cell % cols - mx) ** 2 + (Math.floor(cell / cols) - my) ** 2;
      if (d < bestDistance) {
        best = cell;
        bestDistance = d;
      }
    }
    frontiers.push({
      point: { x: content.left + (best % cols) * CELL + CELL / 2, y: content.top + Math.floor(best / cols) * CELL + CELL / 2 },
      size: group.length,
      reach: reachOf(group),
    });
  }
  frontiers.sort((a, b) => b.size - a.size);

  return { content, grid, explored: exploredCells / Math.max(1, thickFog + exploredCells), frontiers };
}

/** Cells this close to void (walls, edges) cost extra, so routes keep to the middle of corridors. */
const WALL_PENALTY = [0, 6, 2];

/** Walking distances from one spot to everywhere on the map's ground (explored or fogged, not void). */
export interface CostField {
  map: BigMapReading;
  /** Cost to reach each cell (Infinity if unreachable). */
  cost: Float64Array;
  /** The previous cell on the cheapest way to each cell, or -1. */
  came: Int32Array;
  /** Distance from each cell to the nearest void, capped at the wall penalty's reach. */
  toVoid: Uint8Array;
  /** Where the walking starts. */
  start: number;
}

export function cellOf(map: BigMapReading, p: Point): number {
  const { cols, rows } = map.grid;
  const cx = Math.min(cols - 1, Math.max(0, Math.floor((p.x - map.content.left) / CELL)));
  const cy = Math.min(rows - 1, Math.max(0, Math.floor((p.y - map.content.top) / CELL)));
  return cy * cols + cx;
}

export function pointOf(map: BigMapReading, cell: number): Point {
  const { cols } = map.grid;
  return { x: map.content.left + (cell % cols) * CELL + CELL / 2, y: map.content.top + Math.floor(cell / cols) * CELL + CELL / 2 };
}

/**
 * Walking distance from each cell to the nearest of `points` (Infinity where
 * none can be reached), e.g. to judge how far each spot is from unexplored ground.
 */
export function distanceTo(map: BigMapReading, points: Point[]): Float64Array {
  const { cells } = map.grid;
  const starts = points.map((p) => cellOf(map, p)).filter((cell) => cells[cell] !== Cell.Void);
  return walk(map, wallDistances(map), starts).cost;
}

/** Distance from each cell to the nearest void cell, capped at the wall penalty's reach. */
function wallDistances(map: BigMapReading): Uint8Array {
  const { cols, rows, cells } = map.grid;
  const toVoid = new Uint8Array(cells.length).fill(255);
  let edge: number[] = [];
  for (let i = 0; i < cells.length; i++) if (cells[i] === Cell.Void) {
    toVoid[i] = 0;
    edge.push(i);
  }
  for (let d = 1; d < WALL_PENALTY.length && edge.length; d++) {
    const next: number[] = [];
    for (const cell of edge) {
      const cx = cell % cols, cy = (cell - cx) / cols;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const n = ny * cols + nx;
        if (toVoid[n] === 255) {
          toVoid[n] = d;
          next.push(n);
        }
      }
    }
    edge = next;
  }
  return toVoid;
}

/** Dijkstra over the map's ground from the given cells. The grid is small (~15k cells), so a simple binary heap is plenty. */
function walk(map: BigMapReading, toVoid: Uint8Array, starts: number[]): { cost: Float64Array; came: Int32Array } {
  const { cols, rows, cells } = map.grid;
  const cost = new Float64Array(cells.length).fill(Infinity);
  const came = new Int32Array(cells.length).fill(-1);
  const heap: [number, number][] = [];
  const push = (item: [number, number]) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent][0] <= heap[i][0]) break;
      [heap[parent], heap[i]] = [heap[i], heap[parent]];
      i = parent;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      while (true) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (const start of starts) {
    cost[start] = 0;
    push([0, start]);
  }
  while (heap.length) {
    const [c, cell] = pop();
    if (c > cost[cell]) continue;
    const cx = cell % cols, cy = (cell - cx) / cols;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const n = ny * cols + nx;
      if (cells[n] === Cell.Void) continue;
      const step = (dx && dy ? Math.SQRT2 : 1) + (WALL_PENALTY[toVoid[n]] ?? 0);
      if (c + step < cost[n]) {
        cost[n] = c + step;
        came[n] = cell;
        push([c + step, n]);
      }
    }
  }
  return { cost, came };
}

/** Dijkstra from `from` over the map's ground. Null if `from` isn't near any ground. */
export function costField(map: BigMapReading, from: Point): CostField | null {
  const { cols, rows, cells } = map.grid;
  const walkable = (cell: number) => cells[cell] !== Cell.Void;
  const toVoid = wallDistances(map);

  // Start from the player's cell, or the nearest ground if the marker sits on a wall.
  let start = cellOf(map, from);
  if (!walkable(start)) {
    let best = -1, bestDistance = Infinity;
    const sx = start % cols, sy = Math.floor(start / cols);
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const nx = sx + dx, ny = sy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || !walkable(ny * cols + nx)) continue;
      if (dx * dx + dy * dy < bestDistance) {
        best = ny * cols + nx;
        bestDistance = dx * dx + dy * dy;
      }
    }
    if (best < 0) return null;
    start = best;
  }
  const { cost, came } = walk(map, toVoid, [start]);
  return { map, cost, came, toVoid, start };
}

/** The cells from the field's start to `goal`, in order. */
export function pathTo(field: CostField, goal: number): number[] {
  const path: number[] = [];
  for (let cell = goal; cell >= 0; cell = field.came[cell]) path.push(cell);
  return path.reverse();
}

/**
 * Whether a straight line between two cells stays on ground at least `margin`
 * cells from void (2: a cell clear of the walls, so running along it doesn't
 * clip one; 1: just on the ground).
 */
export function clearLine(field: CostField, from: number, to: number, margin = 2): boolean {
  const { cols } = field.map.grid;
  const x0 = from % cols, y0 = Math.floor(from / cols), x1 = to % cols, y1 = Math.floor(to / cols);
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps), y = Math.round(y0 + ((y1 - y0) * i) / steps);
    if (field.toVoid[y * cols + x] < margin) return false;
  }
  return true;
}

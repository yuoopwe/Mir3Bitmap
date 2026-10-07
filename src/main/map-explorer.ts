import type { Point } from '../shared/types';
import { blockHasFloor, isBlockExplored, isExplored, isWall, type MapGrid } from './map-grid';

/**
 * Plans exploring from the map in the game's memory (map-grid.ts): head for
 * the nearest unexplored block, by walking distance, until every block that
 * can be walked to has been explored. It keeps no clock of its own (the caller
 * passes the time), so it can be run on saved maps (src/test/map-explore-sim.ts).
 * Replaces the explorer that reads the big map from screenshots (explorer.ts).
 */

/** Aim at most this many tiles ahead, so the waypoint stays on screen to click on (8 tiles is 384x256 px). */
export const WAYPOINT_STEPS = 8;
/** When blocked, walk round this many tiles of the route ahead: a run covers two. */
const BLOCKED_TILES = 2;
/** A small unexplored pocket up to this many steps further than the nearest block is finished first... */
const POCKET_DETOUR = 8;
/** ...when it has at most this many blocks: coming back for it later costs a long walk. */
const POCKET_BLOCKS = 12;

/**
 * The 8 ways to step, straight ones first. pathTo walks back from the target
 * taking the first that fits, so routes start with their diagonal steps and
 * end straight: two long runs in the open.
 */
const STEPS: Point[] = [
  { x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 },
  { x: 1, y: 1 }, { x: -1, y: 1 }, { x: -1, y: -1 }, { x: 1, y: -1 },
];

/**
 * Somewhere to keep away from, in tile coordinates: tile (x, y) not to step on,
 * or with `block`, the block holding it not to head for (it may still be walked through).
 */
export interface Avoid {
  x: number;
  y: number;
  block?: boolean;
}

export interface ExploreRoute {
  /** The tile being headed for: the nearest tile of an unexplored block. */
  target: Point;
  /** Tiles from the player (first) to the target (last), one step apart. */
  path: Point[];
  /**
   * Where to hold the run button: along the path, in a straight line from the
   * player. Only one tile on means the path turns there: walk, as a run of two
   * tiles would carry past the turn.
   */
  waypoint: Point;
}

interface Route {
  target: Point;
  path: Point[];
}

/** An unexplored block the search reached: the index of its nearest tile, and how many steps away. */
interface Candidate {
  tile: number;
  gx: number;
  gy: number;
  steps: number;
}

const inside = (x: number, y: number, width: number, height: number) => x >= 0 && y >= 0 && x < width && y < height;

/**
 * Whether the player can step from (x, y) by (dx, dy), each -1, 0 or 1: onto
 * floor, and not diagonally between two walls. Not checked in the game; if a
 * single wall beside a diagonal step turns out to block it too, make the && an ||.
 */
export function canStep(map: MapGrid, x: number, y: number, dx: number, dy: number): boolean {
  if (isWall(map, x + dx, y + dy)) return false;
  return dx === 0 || dy === 0 || !(isWall(map, x + dx, y) && isWall(map, x, y + dy));
}

export class MapExplorer {
  /** How many times the map has been searched (for tests and measuring). */
  searches = 0;
  /** The walls of the map being explored: a new array means a new map, or the same one sent again. */
  private walls: Uint8Array | null = null;
  /** Which map that is (index and size), to tell the two apart. */
  private mapKey = '';
  /** Steps from the player to each tile in the last search: -1 not reached, -2 avoided. */
  private dist = new Int32Array(0);
  private queue = new Int32Array(0);
  /** 1 for each block with somewhere to walk. */
  private floor = new Uint8Array(0);
  private route: Route | null = null;
  /** The map's revision when the last search found nothing left to explore. */
  private doneAt: number | null = null;
  /** What `blocked` said to keep away from, and until when. */
  private stuck: { avoid: Avoid; until: number }[] = [];
  /** The caller's avoid list at the last call, to tell when it changes. */
  private avoiding = '';

  /** Forgets the map, the route and everything being avoided. */
  reset(): void {
    this.walls = null;
    this.mapKey = '';
    this.route = null;
    this.doneAt = null;
    this.stuck = [];
    this.avoiding = '';
  }

  /**
   * Where to go next: a route to the nearest unexplored block, 'done' when every
   * block that can be walked to is explored, or null when it can't tell (the game
   * hasn't said what's explored, or the player isn't on the map). `now` is on the
   * caller's clock, the same one as `blocked`'s. `avoid` is the caller's own list
   * for now: it applies whenever the map is searched, and a change to it searches
   * again only when the route ahead steps on it (an entry taken off doesn't).
   */
  plan(map: MapGrid, player: Point, now: number, avoid: Avoid[] = []): ExploreRoute | 'done' | null {
    if (!map.explored || !inside(player.x, player.y, map.width, map.height)) return null;
    if (map.walls !== this.walls) this.startMap(map);
    // Nothing more can be found until more is uncovered, or the player gets somewhere that search didn't reach.
    if (this.doneAt === map.revision && this.dist[player.y * map.width + player.x] >= 0) return 'done';
    this.stuck = this.stuck.filter((s) => s.until > now);
    const avoiding = avoid.map((a) => `${a.x},${a.y}${a.block ? 'b' : ''}`).join(' ');
    const changed = avoiding !== this.avoiding;
    this.avoiding = avoiding;
    // stillGood first, so the route is cut to the part ahead. A changed list only matters when that part steps on it.
    if (!this.stillGood(map, player) || (changed && this.inTheWay(map, avoid))) {
      const all = [...avoid, ...this.stuck.map((s) => s.avoid)];
      // Avoiding is only a preference: if it cuts off everything left, go anyway.
      this.route = this.search(map, player, all) ?? (all.length > 0 ? this.search(map, player, []) : null);
      // Done is remembered only while the last search found nothing (a teleport can find more).
      this.doneAt = this.route ? null : map.revision;
    }
    const route = this.route;
    if (!route) return 'done';
    return { target: route.target, path: route.path, waypoint: waypoint(route.path) };
  }

  /**
   * The player hasn't moved: something the map doesn't show is in the way (a
   * monster, another player). Until `until`, walk round the next tiles of the
   * route and head for a different block. `until` is on plan()'s clock: the bot
   * would pass something like Date.now() + 10_000, the simulation its step + 20.
   * It also covers a block the game never marks explored: standing on the
   * target, the waypoint is the player's own tile, the player doesn't move, and
   * blocked() sends them elsewhere.
   */
  blocked(until: number): void {
    if (!this.route) return;
    const { target, path } = this.route;
    for (const tile of path.slice(1, 1 + BLOCKED_TILES)) this.stuck.push({ avoid: tile, until });
    this.stuck.push({ avoid: { ...target, block: true }, until });
    this.route = null;
  }

  private startMap(map: MapGrid): void {
    // The reader sends the walls of the same map again on each attach: keep what blocked() said to avoid.
    const key = `${map.index} ${map.width}x${map.height}`;
    const stuck = key === this.mapKey ? this.stuck : [];
    this.reset();
    this.stuck = stuck;
    this.mapKey = key;
    this.walls = map.walls;
    this.dist = new Int32Array(map.width * map.height);
    this.queue = new Int32Array(map.width * map.height);
    this.floor = new Uint8Array(map.gridWidth * map.gridHeight);
    for (let gy = 0; gy < map.gridHeight; gy++) {
      for (let gx = 0; gx < map.gridWidth; gx++) this.floor[gy * map.gridWidth + gx] = blockHasFloor(map, gx, gy) ? 1 : 0;
    }
  }

  /** Whether last time's route still holds: its target unexplored, and the player on it. Drops the part walked. */
  private stillGood(map: MapGrid, player: Point): boolean {
    if (!this.route) return false;
    const { target, path } = this.route;
    if (isExplored(map, target.x, target.y)) return false;
    const at = path.findIndex((p) => p.x === player.x && p.y === player.y);
    if (at < 0) return false;
    this.route = { target, path: path.slice(at) };
    return true;
  }

  /** Whether the rest of the route steps on a tile to avoid, or heads for a block to avoid. */
  private inTheWay(map: MapGrid, avoid: Avoid[]): boolean {
    const { target, path } = this.route!;
    const block = (p: Point) => Math.floor(p.y / map.blockSize) * map.gridWidth + Math.floor(p.x / map.blockSize);
    return avoid.some((a) => (a.block ? block(a) === block(target) : path.some((p) => p.x === a.x && p.y === a.y)));
  }

  /**
   * A breadth-first search out from the player (every step takes as long),
   * stopping a few steps past the nearest unexplored blocks.
   */
  private search(map: MapGrid, player: Point, avoid: Avoid[]): Route | null {
    this.searches++;
    const { width, height, blockSize, gridWidth, gridHeight } = map;
    const { dist, queue } = this;
    dist.fill(-1);
    const seen = new Uint8Array(gridWidth * gridHeight);
    const avoided = new Uint8Array(gridWidth * gridHeight);
    for (const a of avoid) {
      if (!inside(a.x, a.y, width, height)) continue;
      if (a.block) avoided[Math.floor(a.y / blockSize) * gridWidth + Math.floor(a.x / blockSize)] = 1;
      else dist[a.y * width + a.x] = -2;
    }

    const start = player.y * width + player.x;
    dist[start] = 0;
    queue[0] = start;
    const candidates: Candidate[] = [];
    let head = 0, tail = 1, fallback = -1;
    while (head < tail) {
      const i = queue[head++];
      // Tiles come out nearest first: past the detour, nothing else can win.
      if (candidates.length > 0 && dist[i] > candidates[0].steps + POCKET_DETOUR) break;
      const x = i % width, y = (i - x) / width;
      const gx = Math.floor(x / blockSize), gy = Math.floor(y / blockSize), g = gy * gridWidth + gx;
      if (!seen[g] && !isBlockExplored(map, gx, gy)) {
        seen[g] = 1;
        // A block to avoid is only headed for if no other can be reached.
        if (!avoided[g]) candidates.push({ tile: i, gx, gy, steps: dist[i] });
        else if (fallback < 0) fallback = i;
      }
      for (const step of STEPS) {
        const nx = x + step.x, ny = y + step.y, next = ny * width + nx;
        if (!inside(nx, ny, width, height) || dist[next] !== -1 || !canStep(map, x, y, step.x, step.y)) continue;
        dist[next] = dist[i] + 1;
        queue[tail++] = next;
      }
    }
    const best = candidates.length > 0 ? this.choose(map, candidates) : fallback;
    if (best < 0) return null;
    const target = { x: best % width, y: Math.floor(best / width) };
    return { target, path: this.pathTo(map, target) };
  }

  /**
   * A small pocket close by first, so none is left behind to walk back for.
   * Otherwise the nearest, and of equally near ones, the one with the most
   * unexplored around it: going there uncovers the most for the same walk.
   */
  private choose(map: MapGrid, candidates: Candidate[]): number {
    let pocket: Candidate | null = null, smallest = POCKET_BLOCKS + 1;
    for (const c of candidates) {
      const size = this.pocketSize(map, c.gx, c.gy);
      if (size < smallest) {
        pocket = c;
        smallest = size;
      }
    }
    if (pocket) return pocket.tile;
    let best = candidates[0], bestGain = 0;
    for (const c of candidates) {
      if (c.steps > candidates[0].steps) break;
      const gain = this.unexploredAround(map, c.gx, c.gy);
      if (gain > bestGain) {
        best = c;
        bestGain = gain;
      }
    }
    return best.tile;
  }

  /** Unexplored blocks with floor touching (gx, gy) and each other, counted up to just past POCKET_BLOCKS. */
  private pocketSize(map: MapGrid, gx: number, gy: number): number {
    const pocket: Point[] = [{ x: gx, y: gy }];
    for (let i = 0; i < pocket.length && pocket.length <= POCKET_BLOCKS; i++) {
      for (const step of STEPS) {
        const x = pocket[i].x + step.x, y = pocket[i].y + step.y;
        if (!this.unexplored(map, x, y) || pocket.some((p) => p.x === x && p.y === y)) continue;
        pocket.push({ x, y });
      }
    }
    return pocket.length;
  }

  /** Unexplored blocks with floor among block (gx, gy) and its 8 neighbours. */
  private unexploredAround(map: MapGrid, gx: number, gy: number): number {
    let count = 0;
    for (let y = gy - 1; y <= gy + 1; y++) {
      for (let x = gx - 1; x <= gx + 1; x++) if (this.unexplored(map, x, y)) count++;
    }
    return count;
  }

  /** Block (gx, gy) has somewhere to walk and hasn't been explored (off the map has no floor). */
  private unexplored(map: MapGrid, gx: number, gy: number): boolean {
    return inside(gx, gy, map.gridWidth, map.gridHeight) && this.floor[gy * map.gridWidth + gx] === 1 && !isBlockExplored(map, gx, gy);
  }

  /** Walks back from the target to the player, each time to a tile one step nearer. */
  private pathTo(map: MapGrid, target: Point): Point[] {
    const { dist } = this;
    const path = [target];
    let { x, y } = target;
    while (dist[y * map.width + x] > 0) {
      const d = dist[y * map.width + x];
      const step = STEPS.find((s) => {
        const px = x - s.x, py = y - s.y;
        return inside(px, py, map.width, map.height) && dist[py * map.width + px] === d - 1 && canStep(map, px, py, s.x, s.y);
      })!;
      x -= step.x;
      y -= step.y;
      path.push({ x, y });
    }
    return path.reverse();
  }
}

/**
 * The farthest tile, up to WAYPOINT_STEPS along the path, reached by carrying
 * on the way the first step goes: running toward it follows the path exactly.
 */
export function waypoint(path: Point[]): Point {
  if (path.length < 2) return path[0];
  const dx = path[1].x - path[0].x, dy = path[1].y - path[0].y;
  let i = 1;
  while (i < WAYPOINT_STEPS && i + 1 < path.length && path[i + 1].x - path[i].x === dx && path[i + 1].y - path[i].y === dy) i++;
  return path[i];
}

import type { Point } from '../shared/types';
import { Cell, LEADS_ON, cellOf, clearLine, costField, distanceTo, pathTo, pointOf, type BigMapReading, type CostField, type Frontier } from './bigmap';

/**
 * Which of the planner's habits are on. All on is the real bot; the switches
 * exist so the habits can be compared (see src/test/explore-sim.ts).
 */
export interface PlannerOptions {
  /** Keep heading for the same edge until it's uncovered, instead of re-picking the nearest every time. */
  commit: boolean;
  /** Steer for the farthest point of the route that can be run to in a straight line. */
  lineOfSight: boolean;
  /** Only teleport when the route runs straight for a good way (a teleport overshoots corners). */
  teleportOnStraights: boolean;
  /**
   * With a free random teleport (to anywhere explored): re-roll while the player is further from unexplored
   * ground than this share of explored spots would be. 0.1 means "keep going until in the best tenth".
   */
  rerollQuantile: number;
}

export const PLANNER_DEFAULTS: PlannerOptions = { commit: true, lineOfSight: true, teleportOnStraights: true, rerollQuantile: 0.1 };

/** How the bot used to explore: nearest edge every time, a fixed point ahead, teleport whenever. */
export const PLANNER_NAIVE: PlannerOptions = { commit: false, lineOfSight: false, teleportOnStraights: false, rerollQuantile: 0.1 };

/** A committed edge is still "the same one" if an edge is this close to where it was (map pixels). */
const COMMIT_RADIUS = 36;
/** Switch from the committed edge only if another is clearly better: cheaper than this share of it, less this many cells. */
const SWITCH_RATIO = 0.6;
const SWITCH_SLACK = 10;
/** Farthest along the route to look for a straight run, in cells. */
const MAX_LOOKAHEAD = 30;
/** Fixed lookahead when not using line of sight. */
const FIXED_LOOKAHEAD = 7;
/** A straight run at least this long (map pixels) is safe to teleport along. */
const TELEPORT_STRAIGHT = 24;
/**
 * Fog this close (map pixels, across and down) to anywhere the player has stood would have been uncovered
 * by the game: about 9 tiles, well inside the view. If it still looks like fog, it's dark explored ground.
 */
const SEEN_X = 24;
const SEEN_Y = 16;
/** Remember a spot on the trail every this many map pixels. */
const TRAIL_STEP = 6;
/** Only re-roll if it should save at least this much walking (cells): a re-roll takes about a second. */
const REROLL_MIN_SAVING = 4;

export interface ExploreStep {
  /** The unexplored edge being headed for. */
  target: Point;
  /** Where to steer right now. */
  waypoint: Point;
  /** Whether a teleport towards the waypoint is safe (it won't overshoot a corner). */
  teleport: boolean;
}

interface Candidate {
  point: Point;
  cell: number;
  cost: number;
}

/** Decides where to go next when exploring, from the big map and the player's position on it. */
export class ExplorePlanner {
  private committed: Point | null = null;
  /** Where the player has been on this map. */
  private trail: Point[] = [];

  constructor(private readonly options: PlannerOptions = PLANNER_DEFAULTS) {}

  reset(): void {
    this.committed = null;
    this.trail = [];
  }

  /**
   * Unexplored edges the player hasn't already been within sight of. One that
   * has been seen from close by and still looks fogged is really dark ground,
   * and chasing it would never end.
   */
  openFrontiers(map: BigMapReading): Frontier[] {
    // Except where the fog runs on a long way: a maze's side corridor stays fogged
    // right beside a corridor walked down, as the game only uncovers what's in view.
    return map.frontiers.filter(
      (f) => f.reach >= LEADS_ON || !this.trail.some((t) => ((f.point.x - t.x) / SEEN_X) ** 2 + ((f.point.y - t.y) / SEEN_Y) ** 2 <= 1),
    );
  }

  /**
   * Whether a random teleport (to anywhere explored) is likely to land nearer
   * unexplored ground than walking from here: true while the walk from here is
   * longer than it would be from most explored spots.
   */
  shouldReroll(map: BigMapReading, self: Point): boolean {
    const open = this.openFrontiers(map);
    if (open.length === 0) return false;
    const distance = distanceTo(map, open.map((f) => f.point));
    const { cols, rows, cells } = map.grid;

    // From here: the nearest cell around the marker (it may sit on a wall).
    const at = cellOf(map, self);
    let here = Infinity;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const cx = (at % cols) + dx, cy = Math.floor(at / cols) + dy;
      if (cx >= 0 && cy >= 0 && cx < cols && cy < rows) here = Math.min(here, distance[cy * cols + cx]);
    }

    // From everywhere a random teleport could land.
    const fromExplored: number[] = [];
    for (let i = 0; i < cells.length; i++) if (cells[i] === Cell.Explored && distance[i] < Infinity) fromExplored.push(distance[i]);
    if (fromExplored.length === 0) return false;
    fromExplored.sort((a, b) => a - b);
    const good = fromExplored[Math.floor(this.options.rerollQuantile * (fromExplored.length - 1))];
    return here > good + REROLL_MIN_SAVING;
  }

  /** The player jumped somewhere else: the edge being headed for no longer means anything. */
  teleported(): void {
    this.committed = null;
  }

  /**
   * The next step towards an unexplored edge, or null if none can be reached.
   * Edges near `avoid` are skipped, unless they're all that's left.
   */
  plan(map: BigMapReading, self: Point, avoid: Point[] = [], avoidRadius = 30): ExploreStep | null {
    const last = this.trail[this.trail.length - 1];
    if (!last || Math.hypot(self.x - last.x, self.y - last.y) >= TRAIL_STEP) this.trail.push({ x: self.x, y: self.y });
    const field = costField(map, self);
    if (!field) return null;

    let candidates = this.candidates(field, avoid, avoidRadius);
    if (candidates.length === 0 && avoid.length > 0) candidates = this.candidates(field, [], avoidRadius);
    if (candidates.length === 0) {
      this.committed = null;
      return null;
    }

    // The nearest edge by distance walked; but stick with the one already being
    // headed for unless another is clearly nearer. Re-picking every time makes
    // the bot turn round whenever the edge it's heading for shifts as it's uncovered.
    let chosen = candidates.reduce((a, b) => (b.cost < a.cost ? b : a));
    if (this.options.commit && this.committed) {
      const committed = this.committed;
      const distance = (c: Candidate) => Math.hypot(c.point.x - committed.x, c.point.y - committed.y);
      const same = candidates.filter((c) => distance(c) < COMMIT_RADIUS).sort((a, b) => distance(a) - distance(b))[0];
      if (same && chosen.cost >= same.cost * SWITCH_RATIO - SWITCH_SLACK) chosen = same;
    }
    this.committed = chosen.point;

    const waypoint = this.waypoint(field, pathTo(field, chosen.cell));
    const teleport = !this.options.teleportOnStraights || Math.hypot(waypoint.x - self.x, waypoint.y - self.y) >= TELEPORT_STRAIGHT;
    return { target: chosen.point, waypoint, teleport };
  }

  private candidates(field: CostField, avoid: Point[], avoidRadius: number): Candidate[] {
    const list: Candidate[] = [];
    for (const frontier of this.openFrontiers(field.map)) {
      if (avoid.some((a) => Math.hypot(a.x - frontier.point.x, a.y - frontier.point.y) < avoidRadius)) continue;
      const cell = cellOf(field.map, frontier.point);
      const cost = field.cost[cell];
      if (cost !== Infinity) list.push({ point: frontier.point, cell, cost });
    }
    return list;
  }

  /**
   * Steer for the farthest point of the route that can be run to in a straight
   * line: aiming further along cuts into walls at corners, aiming nearer zigzags.
   */
  private waypoint(field: CostField, path: number[]): Point {
    if (!this.options.lineOfSight) return pointOf(field.map, path[Math.min(FIXED_LOOKAHEAD, path.length - 1)]);
    const nearest = Math.min(2, path.length - 1);
    const farthest = (margin: number) => {
      for (let i = Math.min(MAX_LOOKAHEAD, path.length - 1); i > nearest; i--) if (clearLine(field, field.start, path[i], margin)) return i;
      return -1;
    };
    // Keep a cell clear of the walls where there's room; in corridors only a
    // cell or two wide (mazes) there never is, so just stay off them.
    let best = farthest(2);
    if (best < 0) best = farthest(1);
    return pointOf(field.map, path[best < 0 ? nearest : best]);
  }
}

/** After losing sight of the player's marker, carry on from the last known position for this long. */
const REMEMBER_MS = 5000;

export interface TrackedPosition {
  /** Where to plan from, or null if the player has been lost for too long. */
  position: Point | null;
  /** Seen this time, remembered from a moment ago, or lost. */
  state: 'seen' | 'remembered' | 'lost';
}

/**
 * Keeps the player's position when their marker briefly disappears: usually
 * under a map icon they're standing on. Carrying on from the last known spot
 * moves them off the icon, so the marker comes back; waiting for it would
 * mean waiting forever.
 */
export class PlayerTracker {
  private last: Point | null = null;
  private lostSince: number | null = null;

  reset(): void {
    this.last = null;
    this.lostSince = null;
  }

  /** The last position actually seen (to look for the marker near). */
  get known(): Point | null {
    return this.last;
  }

  update(seen: Point | null, now: number): TrackedPosition {
    if (seen) {
      this.last = seen;
      this.lostSince = null;
      return { position: seen, state: 'seen' };
    }
    if (this.lostSince === null) this.lostSince = now;
    if (this.last && now - this.lostSince < REMEMBER_MS) return { position: this.last, state: 'remembered' };
    return { position: null, state: 'lost' };
  }
}

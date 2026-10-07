/** Exploring: from the game's memory (map-explorer.ts), or the old way by the big map on screen; and Explore's looting. */

import type { Point } from '../shared/types';
import { findBigMap, readBigMap, type BigMapReading } from './bigmap';
import { ExplorePlanner, PlayerTracker } from './explorer';
import { GAME_HEIGHT, GAME_WIDTH, HUD_MASKS, PLAYER, PLAYER_BAR_TEXT, PLAYER_HP_BAR, PLAYER_MP_BAR, type Rect } from './layout';
import { locatePlayer } from './minimap';
import { MapExplorer } from './map-explorer';
import { nearestApproach, pathBack, walkDistances } from './map-path';
import { exploredShare, type MapGrid } from './map-grid';
import type { MemoryState } from './game-memory';
import { playerHpFill, playerMpFill, readBar } from './vision';
import { VK } from './input';
import { BotError, EXPLORE_AVOID_MS, EXPLORE_BLOCKED_MS, FLOOR_CLICKS, FLOOR_CLICK_GAP_MS, ITEM_CLICK_EVERY_MS, LOOT_GIVE_UP_MS, LOOT_SKIP_MS, LOOT_WALK_GIVE_UP_MS, MEMORY_START_MS, RUN_TICK_MS, STEER_ROUND_TILES, Stopped, TELEPORT_JITTER_MS, TELEPORT_PRESS_MS, keyCode } from './bot-shared';
import type { BotContext } from './bot-context';

/** Exploring with "Pick up items": walk to items up to this many tiles beyond pick-up reach. */
const EXPLORE_LOOT_TILES = 8;

/** Time for the big map to appear or disappear after pressing B. */
const BIG_MAP_DELAY_MS = 400;

/** Moving less than this on the big map (pixels) in STUCK_MS means stuck. */
const PROGRESS_PIXELS = 3;

const STUCK_MS = 1500;

/** Stuck this many times heading for one edge, skip it. */
const STUCK_TRIES = 6;

const SIDESTEP_MS = 700;

/** Time for the unstuck teleport to happen before carrying on. */
const TELEPORT_MS = 800;

/** Edges near one that was skipped are skipped too. */
const UNREACHABLE_RADIUS = 30;

/** With no route, wander; every this many tries, give every skipped edge another go. */
const NO_ROUTE_TRIES = 6;

/** No unexplored edges left for this long means the map is done (as far as the map shows). */
const NO_EDGES_MS = 15_000;

/** The explored share dropping by this much means a new map (e.g. down a level): start afresh. */
const NEW_MAP_DROP = 0.15;

/** An edge that kept the player stuck is left alone this long, then tried again. */
const SKIP_EDGE_MS = 30_000;

/** With auto-restart on, wait this long after an error before exploring again. */
const RESTART_DELAY_MS = 3000;

/** If the big map won't open, wait this long and try again. */
const MAP_RETRY_MS = 2000;

const WANDER_MS = 1500;

/** The free random teleport unlocks at 60% explored. */
const RANDOM_TELEPORT_FROM = 0.6;

/** Most random teleports in a row before walking for a while instead. */
const MAX_REROLLS = 6;

const REROLL_PAUSE_MS = 10_000;

/** Time for a random teleport to happen and the map to show it. */
const REROLL_SETTLE_MS = 700;

/** Moving at least this far (map pixels) means the random teleport worked. */
const REROLL_JUMP = 20;

/** If a random teleport did nothing, wait this long before trying again. */
const REROLL_LOCKED_MS = 30_000;

/** Keep the run cursor this far off the map panel. */
const RUN_POINT_MARGIN = 12;

export class Exploring {
  /** The player's position on the big map, kept through moments when the marker is hidden. */
  readonly tracker = new PlayerTracker();
  /** Unexplored edges being skipped for a while, and how often each one got the player stuck. */
  skipped: { point: Point; until: number }[] = [];
  stuckAt: { point: Point; count: number }[] = [];
  /** Explore's looting: items given up on, items in reach and since when, the item being walked to, and the next feet click. */
  private exploreLoot = {
    skipped: new Map<string, number>(),
    inReachSince: new Map<string, number>(),
    walking: null as { key: string; since: number; path: Point[] | null } | null,
    nextClickAt: 0,
  };
  /** Random teleports in a row, and when they may be used again after a pause. */
  rerollsInRow = 0;
  rerollPausedUntil = 0;
  readonly planner = new ExplorePlanner();

  constructor(private readonly bot: BotContext) {}

  /**
   * Shows or hides the big map (B toggles it) and returns its panel when shown.
   * Checks the screen rather than assuming what B did.
   */
  private async setBigMap(open: boolean): Promise<Rect | null> {
    this.bot.capture();
    let panel = findBigMap(this.bot.frame);
    for (let attempt = 0; attempt < 3 && !!panel !== open; attempt++) {
      this.bot.key(VK.B);
      await this.bot.sleep(BIG_MAP_DELAY_MS);
      this.bot.capture();
      panel = findBigMap(this.bot.frame);
    }
    if (!!panel !== open) throw new BotError(open ? 'Could not open the big map (B).' : 'Could not close the big map (B).');
    return panel;
  }

  /** Runs Explore, starting it again after an error if auto-restart is on. Stop always stops it. */
  async exploreWithRestarts(): Promise<string> {
    while (true) {
      try {
        // With the memory reader the map comes straight from the game; without it, from the big map on screen.
        return await (this.bot.options.memory.installed ? this.memoryExploreLoop() : this.exploreLoop());
      } catch (error) {
        if (error instanceof Stopped || !this.bot.settings.exploreAutoRestart) throw error;
        this.bot.stopRunning();
        const reason = error instanceof Error ? error.message : String(error);
        this.bot.status(`Explore stopped (${reason}); restarting in ${RESTART_DELAY_MS / 1000} s`);
        await this.bot.sleep(RESTART_DELAY_MS);
        this.stuckAt = [];
        this.tracker.reset();
        this.planner.reset();
      }
    }
  }

  /** Opens the big map, waiting and trying again for as long as it takes. */
  private async openBigMapPersistently(): Promise<Rect> {
    while (true) {
      try {
        return (await this.setBigMap(true))!;
      } catch (error) {
        if (!(error instanceof BotError)) throw error;
        this.bot.status(`${error.message} Trying again...`);
        await this.bot.sleep(MAP_RETRY_MS);
      }
    }
  }

  /**
   * Uncovers the map without fighting (pets take care of that). The big map
   * stays open the whole time: it shows where the player is and what's still
   * fogged, and the game world around the panel is still there to right-click
   * on to run.
   */
  private async exploreLoop(): Promise<string> {
    let progress = { at: this.bot.clock.now(), self: null as Point | null };
    // When the bot last steered: time paused, or busy reopening the map, isn't time spent stuck.
    let steeredAt = 0;
    let noRoute = 0;
    let noEdgesSince: number | null = null;

    while (true) {
      await this.bot.yieldToEvents();
      this.bot.capture();
      this.bot.hp = readBar(this.bot.frame, PLAYER_HP_BAR, playerHpFill, PLAYER_BAR_TEXT);
      this.bot.mp = readBar(this.bot.frame, PLAYER_MP_BAR, playerMpFill, PLAYER_BAR_TEXT);
      this.bot.drinkPotions();

      let panel = findBigMap(this.bot.frame);
      if (!panel) {
        // Not open yet, or something closed it (a key press, a teleport): open it again.
        this.bot.stopRunning();
        panel = await this.openBigMapPersistently();
        continue;
      }

      const map = readBigMap(this.bot.frame, panel);
      if (this.bot.explored !== null && map.explored < this.bot.explored - NEW_MAP_DROP) {
        // A different map: what was learned about the last one no longer applies.
        this.planner.reset();
        this.skipped = [];
        this.stuckAt = [];
        this.bot.status('New map; exploring it from scratch');
      }
      this.bot.explored = map.explored;
      const tracked = this.tracker.update(locatePlayer(this.bot.frame, panel, this.tracker.known), this.bot.clock.now());
      const self = tracked.position;
      if (!self) {
        // Lost for a while: move about (and teleport) until the marker shows again.
        this.bot.statusEvery("Can't see you on the big map; moving to find you");
        const point = this.runPoint(Math.random() * 2 * Math.PI, panel);
        if (point) this.bot.holdRun(point);
        const vk = this.bot.moves.teleportKey();
        if (vk !== null && this.bot.clock.now() >= this.bot.moves.teleportReadyAt) {
          this.bot.key(vk);
          this.bot.moves.teleportReadyAt = this.bot.clock.now() + TELEPORT_PRESS_MS;
        }
        await this.bot.sleep(WANDER_MS);
        this.bot.stopRunning();
        continue;
      }
      if (tracked.state === 'remembered') this.bot.statusEvery('Your marker is hidden (under a map icon?); carrying on from where you were');

      const percent = Math.round(map.explored * 100);
      // Done when the target is reached, or when no unexplored edges have been left for a while.
      if (this.planner.openFrontiers(map).length > 0) noEdgesSince = null;
      else noEdgesSince ??= this.bot.clock.now();
      if (noEdgesSince !== null && this.bot.clock.now() - noEdgesSince > NO_EDGES_MS) {
        this.bot.stopRunning();
        await this.setBigMap(false);
        return `No unexplored edges left (about ${percent}% uncovered)`;
      }
      if (map.explored * 100 >= this.bot.settings.explorePercent) {
        this.bot.stopRunning();
        await this.setBigMap(false);
        return `Map explored (about ${percent}%)`;
      }
      const now = this.bot.clock.now();
      if (await this.maybeReroll(map, self, panel)) {
        progress = { at: this.bot.clock.now(), self: null };
        continue;
      }
      this.skipped = this.skipped.filter((s) => s.until > now);
      const avoid = this.skipped.map((s) => s.point);
      // Skipped edges are only a preference: if they're all that's left, go for one anyway.
      const plan =
        map.frontiers.length > 0 ? this.planner.plan(map, self, avoid, UNREACHABLE_RADIUS) : null;
      if (!plan) {
        // Nothing to head for right now: too little explored ground at an
        // entrance, or every edge is blocked (often by monsters the pets will
        // soon kill). Wander a little; after a while, retry every edge.
        noRoute++;
        if (noRoute % NO_ROUTE_TRIES === 0) {
          this.skipped = [];
          this.stuckAt = [];
          this.bot.status('No route; trying every edge again');
        } else {
          this.bot.statusEvery(`No route right now; looking around (about ${percent}% uncovered)`);
        }
        const angle = Math.random() * 2 * Math.PI;
        const point = this.runPoint(angle, panel);
        if (point) this.bot.holdRun(point);
        if (this.bot.clock.now() >= this.bot.moves.teleportReadyAt) this.teleport(self, { x: self.x + Math.cos(angle), y: self.y + Math.sin(angle) }, panel);
        await this.bot.sleep(WANDER_MS);
        this.bot.stopRunning();
        continue;
      }
      noRoute = 0;

      // Not getting anywhere for a while: teleport or sidestep, and skip that edge for a bit after a few tries.
      if (!progress.self || now - steeredAt > STUCK_MS || Math.hypot(self.x - progress.self.x, self.y - progress.self.y) >= PROGRESS_PIXELS) {
        progress = { at: now, self };
      } else if (now - progress.at > STUCK_MS) {
        await this.unstick(plan.target, self, plan.waypoint, panel);
        progress = { at: this.bot.clock.now(), self: null };
        continue;
      }

      this.steer(self, plan.waypoint, panel);
      // Teleport only along a straight stretch: it would overshoot a corner and have to come back.
      if (plan.teleport && this.bot.clock.now() >= this.bot.moves.teleportReadyAt) this.teleport(self, plan.waypoint, panel);
      await this.bot.sleep(RUN_TICK_MS);
      steeredAt = this.bot.clock.now();
      this.bot.statusEvery(`Exploring: about ${percent}% uncovered`);
    }
  }

  /**
   * Uncovers the map from the game's memory: its walls and explored blocks
   * (map-grid.ts) and the player's tile. MapExplorer plans a walking route to
   * the nearest unexplored ground; the bot runs (right button held) toward a
   * spot along it, pressing the teleport key on long straight stretches.
   */
  private async memoryExploreLoop(): Promise<string> {
    const memory = this.bot.options.memory;
    memory.start();
    this.exploreLoot = { skipped: new Map(), inReachSince: new Map(), walking: null, nextClickAt: 0 };
    const planner = new MapExplorer();
    const started = this.bot.clock.now();
    let mapIndex: number | null = null;
    let share = { map: null as MapGrid | null, value: 0 };
    let moved = { at: 0, x: NaN, y: NaN };
    // When the character was last driven: time paused, or waiting for the memory, isn't time spent blocked.
    let drivenAt = 0;

    while (true) {
      await this.bot.yieldToEvents();
      this.bot.capture();
      this.bot.hp = readBar(this.bot.frame, PLAYER_HP_BAR, playerHpFill, PLAYER_BAR_TEXT);
      this.bot.mp = readBar(this.bot.frame, PLAYER_MP_BAR, playerMpFill, PLAYER_BAR_TEXT);
      this.bot.drinkPotions();
      const reading = memory.latest();
      const map = memory.map();
      if (!reading || !map?.explored) {
        this.bot.stopRunning();
        this.bot.statusEvery(
          !reading
            ? this.bot.clock.now() - started < MEMORY_START_MS ? 'Starting the memory reader' : `Waiting for the game's memory (${memory.problem})`
            : 'Waiting for the map from the game',
        );
        await this.bot.sleep(300);
        continue;
      }
      if (map.index !== mapIndex) {
        if (mapIndex !== null) this.bot.status(`New map (${map.name}); exploring it`);
        mapIndex = map.index;
      }
      // Worked out again only when more has been uncovered (it looks at every tile).
      if (share.map !== map) share = { map, value: exploredShare(map) };
      const percent = Math.round(share.value * 100);
      this.bot.explored = share.value;
      if (percent >= this.bot.settings.explorePercent) {
        this.bot.stopRunning();
        return `${map.name} explored (${percent}%)`;
      }

      const user = reading.user!;
      const now = this.bot.clock.now();
      if (now - drivenAt > EXPLORE_BLOCKED_MS || this.bot.moves.mountBusyAt > moved.at) moved.at = now;
      // Surrounded, or blocked with monsters about: fight them rather than keep walking into them.
      const stuck = user.x === moved.x && user.y === moved.y && now - moved.at > this.bot.moves.blockedAfterMs();
      if (await this.bot.hunting.fightIfBlocked(reading, user, stuck)) {
        moved = { at: this.bot.clock.now(), x: NaN, y: NaN };
        drivenAt = this.bot.clock.now();
        continue;
      }
      if (user.x !== moved.x || user.y !== moved.y) moved = { at: now, x: user.x, y: user.y };
      else if (now - moved.at > this.bot.moves.blockedAfterMs()) {
        // Not moving: something the map doesn't show (monsters, pets) is in the way, or the game never marks this block explored.
        planner.blocked(now + EXPLORE_AVOID_MS);
        moved.at = now;
        this.bot.statusEvery('Blocked; going round');
      }
      // "Pick up items": what's on the ground first.
      if (await this.lootFromMemory(reading, map, now)) {
        moved = { at: this.bot.clock.now(), x: NaN, y: NaN };
        drivenAt = this.bot.clock.now();
        continue;
      }
      // Routes keep off monsters close by.
      const exits = [...this.bot.travel.exitsToAvoid(map, user)].map((i) => ({ x: i % map.width, y: Math.floor(i / map.width) }));
      const plan = planner.plan(map, { x: user.x, y: user.y }, now, [...exits, ...this.bot.hunting.obstaclesNear(reading, user, STEER_ROUND_TILES).map((m) => ({ x: m.x, y: m.y }))]);
      if (plan === null) {
        this.bot.stopRunning();
        await this.bot.sleep(300);
        continue;
      }
      if (plan === 'done') {
        this.bot.stopRunning();
        return `Nothing left on ${map.name} that can be walked to (${percent}% uncovered)`;
      }

      await this.bot.moves.driveAlong(user, plan.path, now);
      this.bot.statusEvery(`Exploring ${map.name}: ${percent}% uncovered`);
      await this.bot.sleep(RUN_TICK_MS);
      drivenAt = this.bot.clock.now();
    }
  }

  /**
   * With "Pick up items" on: clicks at the feet while items are within pick-up
   * reach (giving up on any still there after LOOT_GIVE_UP_MS), and walks round
   * the walls to the nearest one up to EXPLORE_LOOT_TILES further off. Returns
   * whether it did anything this tick (so exploring waits).
   */
  private async lootFromMemory(reading: MemoryState, map: MapGrid, now: number): Promise<boolean> {
    if (!this.bot.settings.hunt.loot || !reading.user) return false;
    const loot = this.exploreLoot;
    for (const [key, until] of loot.skipped) if (until <= now) loot.skipped.delete(key);
    const here = { x: reading.user.x, y: reading.user.y };
    const reach = reading.user.pickUpRadius ?? 0;
    const items = this.bot.hunting.groundItems(reading, loot.skipped);
    const inReach = items.filter((i) => i.distance <= reach);
    for (const [key, since] of loot.inReachSince) {
      if (!inReach.some((i) => i.key === key)) {
        // Gone from the ground (not just out of reach): picked up, most likely.
        if (!items.some((i) => i.key === key)) {
          this.bot.stats.count('items');
          this.bot.survival.lootRefused = 0;
        }
        loot.inReachSince.delete(key);
      } else if (now - since > LOOT_GIVE_UP_MS) {
        loot.skipped.set(key, now + LOOT_SKIP_MS);
        loot.inReachSince.delete(key);
        this.bot.survival.lootGivenUp(inReach.find((i) => i.key === key)!.distance);
      }
    }
    for (const i of inReach) if (!loot.inReachSince.has(i.key)) loot.inReachSince.set(i.key, now);
    if (loot.inReachSince.size > 0) {
      if (now >= loot.nextClickAt) {
        this.bot.stopRunning();
        await this.bot.clickFloor(FLOOR_CLICKS, FLOOR_CLICK_GAP_MS);
        loot.nextClickAt = this.bot.clock.now() + ITEM_CLICK_EVERY_MS;
        this.bot.statusEvery(`Picking up ${loot.inReachSince.size} item${loot.inReachSince.size === 1 ? '' : 's'}`);
      } else {
        await this.bot.sleep(50);
      }
      return true;
    }

    // The nearest item a little way off: walk to it (the same one until it's reached or given up on).
    const far = items.filter((i) => i.distance > reach && i.distance <= reach + EXPLORE_LOOT_TILES).sort((a, b) => a.distance - b.distance);
    const walk = far.find((i) => i.key === loot.walking?.key) ?? far[0];
    if (!walk) {
      loot.walking = null;
      return false;
    }
    if (loot.walking?.key !== walk.key) loot.walking = { key: walk.key, since: now, path: null };
    if (now - loot.walking.since > LOOT_WALK_GIVE_UP_MS) {
      loot.skipped.set(walk.key, now + LOOT_SKIP_MS);
      loot.walking = null;
      return false;
    }
    const onPath: number = loot.walking.path ? loot.walking.path.findIndex((t) => t.x === here.x && t.y === here.y) : -1;
    loot.walking.path = loot.walking.path && onPath >= 0 ? loot.walking.path.slice(onPath) : null;
    if (!loot.walking.path || loot.walking.path.length < 2) {
      const dist = walkDistances(map, here, this.bot.travel.exitsToAvoid(map, here));
      const near = nearestApproach(map, dist, [walk.at]);
      if (!near || near.steps === 0) {
        // Walled off, or as close as it gets.
        loot.skipped.set(walk.key, now + LOOT_SKIP_MS);
        loot.walking = null;
        return false;
      }
      loot.walking.path = pathBack(map, dist, near.tile);
    }
    await this.bot.moves.driveAlong(here, loot.walking.path, now);
    this.bot.statusEvery(`Walking to an item ${walk.distance} tiles away`);
    await this.bot.sleep(RUN_TICK_MS);
    return true;
  }

  /**
   * Uses the free random teleport (to anywhere explored) when the walk to
   * unexplored ground from here is long compared with from most explored spots.
   * Returns true if it pressed it (whether or not the game teleported).
   */
  private async maybeReroll(map: BigMapReading, self: Point, panel: Rect): Promise<boolean> {
    const vk = keyCode(this.bot.settings.hunt.randomTeleportKey);
    const now = this.bot.clock.now();
    if (vk === null || map.explored < RANDOM_TELEPORT_FROM || now < this.rerollPausedUntil) return false;
    if (!this.planner.shouldReroll(map, self)) {
      this.rerollsInRow = 0;
      return false;
    }
    if (this.rerollsInRow >= MAX_REROLLS) {
      // Unlucky streak: walk for a bit instead.
      this.rerollsInRow = 0;
      this.rerollPausedUntil = now + REROLL_PAUSE_MS;
      return false;
    }

    this.bot.stopRunning();
    this.bot.key(vk);
    await this.bot.sleep(REROLL_SETTLE_MS);
    this.bot.capture();
    // Look for the marker afresh: pets may still be standing where the player was.
    const landed = locatePlayer(this.bot.frame, panel, null);
    if (landed && Math.hypot(landed.x - self.x, landed.y - self.y) >= REROLL_JUMP) {
      this.tracker.reset();
      this.tracker.update(landed, this.bot.clock.now());
      this.planner.teleported();
      this.rerollsInRow++;
      this.bot.status('Random teleport: far from unexplored ground, trying another spot');
    } else {
      // Nothing happened: probably not unlocked yet (my estimate can run a little ahead of the game's).
      this.rerollPausedUntil = this.bot.clock.now() + REROLL_LOCKED_MS;
      this.bot.status('Random teleport did nothing (not unlocked yet?); trying again later');
    }
    return true;
  }

  /** Holds the right button (run) towards where `to` is from `from` on the big map. */
  private steer(from: Point, to: Point, panel: Rect, turn = 0): void {
    // The big map keeps the world's proportions, so its directions are screen directions.
    const angle = Math.atan2(to.y - from.y, to.x - from.x) + turn;
    const point = this.runPoint(angle, panel);
    if (point) this.bot.holdRun(point);
  }

  /**
   * A spot on the game world (not on the map panel or the HUD) in the given
   * direction from the player, for the cursor to run towards.
   */
  private runPoint(angle: number, panel: Rect): Point | null {
    const blocked = [...HUD_MASKS, { left: panel.left - RUN_POINT_MARGIN, top: panel.top - RUN_POINT_MARGIN - 40, right: panel.right + RUN_POINT_MARGIN, bottom: panel.bottom + RUN_POINT_MARGIN }];
    // The game only runs in 8 directions, so a nearby angle does just as well when the exact one is covered.
    for (const nudge of [0, 0.2, -0.2, 0.35, -0.35]) {
      const dx = Math.cos(angle + nudge), dy = Math.sin(angle + nudge);
      for (let t = 40; t < 1200; t += 8) {
        const x = Math.round(PLAYER.x + dx * t), y = Math.round(PLAYER.y + dy * t);
        if (x < 4 || y < 4 || x >= GAME_WIDTH - 4 || y >= GAME_HEIGHT - 4) break;
        if (!blocked.some((r) => x >= r.left && x < r.right && y >= r.top && y < r.bottom)) return { x, y };
      }
    }
    return null;
  }

  /**
   * Presses the teleport key with the cursor pointing where the bot wants to
   * go, keeping the right button held if it was. Pressed often while running
   * (teleporting is faster, and gets past pets) and to get unstuck.
   */
  private teleport(from: Point, to: Point, panel: Rect): void {
    const vk = this.bot.moves.teleportKey();
    if (vk === null) return;
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const point = this.runPoint(angle, panel);
    if (point) {
      if (this.bot.running) this.bot.holdRun(point);
      else this.bot.input.mouseMove(this.bot.hwnd, point.x, point.y);
    }
    this.bot.key(vk);
    // A little random extra, so presses don't land on an exact rhythm.
    this.bot.moves.teleportReadyAt = this.bot.clock.now() + TELEPORT_PRESS_MS + Math.random() * TELEPORT_JITTER_MS;
  }

  /** Stuck on something (often pets or monsters): teleport or run sideways, and skip this edge for a while if it keeps happening. */
  private async unstick(target: Point, self: Point, waypoint: Point, panel: Rect): Promise<void> {
    const key = this.stuckAt.find((s) => Math.hypot(s.point.x - target.x, s.point.y - target.y) < UNREACHABLE_RADIUS);
    if (key) key.count++;
    else this.stuckAt.push({ point: target, count: 1 });
    const tries = key?.count ?? 1;
    if (tries >= STUCK_TRIES) {
      // Usually monsters in the way; the pets will deal with them, so try again later.
      this.skipped.push({ point: target, until: this.bot.clock.now() + SKIP_EDGE_MS });
      this.stuckAt = this.stuckAt.filter((s) => s !== key);
      this.bot.status('Blocked; trying another edge for now');
      return;
    }

    // Alternate: teleport (gets past pets and monsters), then step aside, then teleport again...
    if (this.bot.moves.teleportKey() !== null && tries % 2 === 1) {
      // A teleport towards the cursor gets past whatever is in the way (usually monsters).
      this.bot.status('Stuck; teleporting');
      this.bot.stopRunning();
      this.teleport(self, waypoint, panel);
      await this.bot.sleep(TELEPORT_MS);
      return;
    }

    this.bot.status('Stuck; stepping aside');
    this.steer(self, waypoint, panel, (Math.random() < 0.5 ? 1 : -1) * Math.PI / 2);
    await this.bot.sleep(SIDESTEP_MS);
  }
}

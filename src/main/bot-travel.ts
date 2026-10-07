/** Travel: the route between maps and walking it, waypoint stones, and the ways off a map (exit tiles). */

import type { Point } from '../shared/types';
import { PLAYER_BAR_TEXT, PLAYER_HP_BAR, PLAYER_MP_BAR } from './layout';
import { nearestApproach, pathBack, walkDistances } from './map-path';
import { findPlace, loadTravelData, mapName, planRoute, type TravelData, type TravelLink } from './travel';
import type { MapGrid } from './map-grid';
import { tileToScreen } from './game-memory';
import { playerHpFill, playerMpFill, readBar } from './vision';
import { VK } from './input';
import { BotError, EXPLORE_AVOID_MS, EXPLORE_BLOCKED_MS, MEMORY_START_MS, RUN_TICK_MS, STEER_ROUND_TILES, boxCentre } from './bot-shared';
import type { BotContext } from './bot-context';

/** Travel: this close to the NPC counts as there; blocked this many times on one map means stuck for good. */
const NPC_REACH_TILES = 2;

/** A waypoint stone is clicked from up to this far (the game walks the rest): monsters round it can't keep the bot from it. */
const STONE_REACH_TILES = 4;

/** After arriving on a map, wait this long before planning (the reading of walls and position catches up). */
const ARRIVAL_SETTLE_MS = 1500;

/** With no way through, keep trying this long before giving up. */
const NO_PATH_RETRY_MS = 5000;

const TRAVEL_BLOCKED_LIMIT = 8;

/** Waypoints: how long to wait for the window to open after clicking the stone, and for the teleport after Activate. */
const WAYPOINT_OPEN_MS = 3000;

const WAYPOINT_TELEPORT_MS = 10_000;

/** Giving up on waypoints after this many tries that went wrong. */
const WAYPOINT_FAILURES = 3;

export class Travel {
  /** The tiles of every way off the current map (stepping on one sends you elsewhere), by map. */
  private exitTilesCache: { key: string; tiles: Set<number> } | null = null;

  constructor(private readonly bot: BotContext) {}

  /**
   * The tiles (y * width + x) of every link off this map: paths keep off them, or a step on one
   * takes the player to another map (often straight back where they came from).
   */
  exitTiles(map: MapGrid): Set<number> {
    const key = `${map.index}/${map.width}`;
    if (this.exitTilesCache?.key !== key) {
      const tiles = new Set<number>();
      for (const l of loadTravelData().links) if (l.from === map.index && !l.waypoint) for (const [x, y] of l.exit) tiles.add(y * map.width + x);
      this.exitTilesCache = { key, tiles };
    }
    return this.exitTilesCache.tiles;
  }

  /**
   * exitTiles, less any exit the player is standing on (arriving can put you on one):
   * keeping off its tiles would wall them in. Exits merely next to them still count.
   */
  exitsToAvoid(map: MapGrid, here: Point): Set<number> {
    const all = this.exitTiles(map);
    const near = (x: number, y: number) => x === here.x && y === here.y;
    const mine = loadTravelData().links.filter((l) => l.from === map.index && !l.waypoint && l.exit.some(([x, y]) => near(x, y)));
    if (!mine.length) return all;
    const out = new Set(all);
    for (const l of mine) for (const [x, y] of l.exit) out.delete(y * map.width + x);
    return out;
  }

  /**
   * Goes to a map or an NPC (a place from travel.ts). On each map it plans the
   * quickest chain of links from where the player stands (the links and the
   * steps between them come from game-data/travel.json; the current map's walls
   * from memory), then walks to the next exit. Any map change (expected or not:
   * a wrong turn, a death) plans again from wherever the player is.
   */
  async travelLoop(placeId: string): Promise<string> {
    return this.travelTo(placeId);
  }

  /** Travel's work, for any mode: returns on arrival (what to say about it), leaving the run going. */
  async travelTo(placeId: string): Promise<string> {
    const data = loadTravelData();
    const place = findPlace(data, placeId);
    if (!place) throw new BotError('Pick somewhere to travel to first.');
    const memory = this.bot.options.memory;
    if (!memory.installed) throw new BotError('Travel needs the memory reader (run scripts/setup-game-reader.ps1).');
    memory.start();
    const started = this.bot.clock.now();
    const tile = ([x, y]: [number, number]): Point => ({ x, y });
    const chebyshev = (a: Point, b: Point) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    let route: { map: number; links: TravelLink[]; blocked: number; blockedAt?: Point } | null = null;
    /** The map last seen, when it was first seen, and since when no path has been found. */
    let seen = { map: -1, at: 0 };
    let noPathSince: number | null = null;
    let path: Point[] | null = null;
    /** Tiles to keep off for now (y * width + x), until when: where something the map doesn't show was in the way. */
    const avoid = new Map<number, number>();
    let moved = { at: 0, x: NaN, y: NaN };
    let drivenAt = 0;
    /** Waypoints that turned out not to be in the window (not unlocked), and how many waypoint tries went wrong. */
    const badWaypoints = new Set<string>();
    let waypointFailures = 0;

    while (true) {
      await this.bot.yieldToEvents();
      this.bot.capture();
      this.bot.hp = readBar(this.bot.frame, PLAYER_HP_BAR, playerHpFill, PLAYER_BAR_TEXT);
      this.bot.mp = readBar(this.bot.frame, PLAYER_MP_BAR, playerMpFill, PLAYER_BAR_TEXT);
      this.bot.drinkPotions();
      const reading = memory.latest();
      const map = memory.map();
      if (!reading || !map) {
        this.bot.stopRunning();
        this.bot.statusEvery(
          !reading
            ? this.bot.clock.now() - started < MEMORY_START_MS ? 'Starting the memory reader' : `Waiting for the game's memory (${memory.problem})`
            : 'Waiting for the map from the game',
        );
        await this.bot.sleep(300);
        continue;
      }
      const user = reading.user!;
      const here = { x: user.x, y: user.y };
      const now = this.bot.clock.now();
      // A game window open on the way (a stray click on a stone or an NPC): close it before it catches clicks.
      const survival = reading.survival;
      if (reading.waypoints?.open || survival?.npcMenu || survival?.questList || survival?.sell || survival?.npcDialog) {
        this.bot.stopRunning();
        this.bot.key(VK.ESCAPE);
        await this.bot.sleep(400);
        continue;
      }

      // Just arrived on a map: let the game's memory settle (walls, position) before planning a path.
      if (map.index !== seen.map) seen = { map: map.index, at: this.bot.clock.now() };
      if (this.bot.clock.now() - seen.at < ARRIVAL_SETTLE_MS) {
        this.bot.stopRunning();
        this.bot.statusEvery(`Arrived on ${mapName(data, map.index)}`);
        await this.bot.sleep(200);
        continue;
      }

      // A new map (or the first): plan from here.
      if (!route || route.map !== map.index) {
        path = null;
        avoid.clear();
        if (map.index === place.map && !place.npc) {
          this.bot.stopRunning();
          return `Arrived at ${mapName(data, map.index)}`;
        }
        const dist = walkDistances(map, here, this.exitsToAvoid(map, here));
        const steps = this.exitSteps(data, map, dist);
        const npcSteps = new Map<number, number>();
        if (place.npc?.at && place.map === map.index) {
          const near = nearestApproach(map, dist, [tile(place.npc.at)]);
          if (near) npcSteps.set(place.npc.id, near.steps);
        }
        // The game lists the waypoints unlocked once its window has been opened; until then every one is tried.
        const unlocked = reading.waypoints?.unlocked?.length ? new Set(reading.waypoints.unlocked.map((w) => w.name)) : undefined;
        const planned = planRoute(data, { map: map.index, steps, npcSteps, at: here }, place, { level: user.level, cls: user.class, waypoints: unlocked, badWaypoints });
        if (!planned) throw new BotError(`No way found from ${mapName(data, map.index)} to ${place.label} (your level or class may not allow it).`);
        route = { map: map.index, links: planned.links, blocked: 0 };
        this.bot.status(
          planned.links.length
            ? `Route: ${[map.index, ...planned.links.map((l) => l.to)].map((i) => mapName(data, i)).join(' > ')}`
            : `Heading for ${place.npc?.name}`,
        );
      }

      // Where to head on this map: the next exit, or the NPC (where the game shows it, else where it's placed).
      let targets: Point[];
      const next = route.links[0];
      if (next?.waypoint) {
        // A waypoint: walk up to the stone, click it and pick the waypoint.
        const stone = data.npcs.find((n) => n.id === next.waypoint!.stone)!;
        const placed = tile(stone.at!);
        const seen = reading.objects?.find((o) => o.kind === 'npc' && o.name === stone.name && chebyshev(o, placed) <= 3);
        const at = seen ? { x: seen.x, y: seen.y } : placed;
        if (chebyshev(here, at) <= STONE_REACH_TILES) {
          this.bot.stopRunning();
          const result = await this.useWaypoint(stone.name, at, next.waypoint.name, map.index);
          if (result === 'missing') {
            badWaypoints.add(next.waypoint.name);
            this.bot.status(`The ${next.waypoint.name} waypoint isn't unlocked; finding another way`);
          } else if (result === 'failed' && ++waypointFailures >= WAYPOINT_FAILURES) {
            throw new BotError(`Couldn't use the waypoint stone ${WAYPOINT_FAILURES} times.`);
          }
          // Plan again: from the new map after a teleport, or without that waypoint.
          route = null;
          continue;
        }
        targets = [at];
      } else if (next) {
        targets = next.exit.map(tile);
      } else {
        const npc = place.npc!;
        const seen = reading.objects?.find((o) => o.kind === 'npc' && o.name === npc.name);
        const at = seen ? { x: seen.x, y: seen.y } : npc.at ? tile(npc.at) : null;
        if (!at) {
          this.bot.stopRunning();
          return `Arrived at ${mapName(data, map.index)}; ${npc.name} wanders about this map`;
        }
        if (chebyshev(here, at) <= NPC_REACH_TILES) {
          this.bot.stopRunning();
          return `Arrived at ${npc.name}`;
        }
        targets = [at];
      }

      // Surrounded, or blocked with monsters about: fight them rather than keep walking into them.
      if (now - drivenAt > EXPLORE_BLOCKED_MS || this.bot.moves.mountBusyAt > moved.at) moved.at = now;
      const stuck = here.x === moved.x && here.y === moved.y && now - moved.at > this.bot.moves.blockedAfterMs();
      if (await this.bot.hunting.fightIfBlocked(reading, here, stuck)) {
        path = null;
        moved = { at: this.bot.clock.now(), x: NaN, y: NaN };
        drivenAt = this.bot.clock.now();
        continue;
      }
      // Not moving while trying to: something the map doesn't show is in the way. Time paused doesn't count.
      if (here.x !== moved.x || here.y !== moved.y) moved = { at: now, x: here.x, y: here.y };
      else if (now - moved.at > this.bot.moves.blockedAfterMs()) {
        // Hold-ups with real progress in between are separate: only a run of them without getting anywhere gives up.
        if (route.blockedAt && chebyshev(here, route.blockedAt) > 5) route.blocked = 0;
        route.blockedAt = here;
        if (++route.blocked > TRAVEL_BLOCKED_LIMIT) throw new BotError(`Stuck on ${mapName(data, map.index)} at ${here.x},${here.y}: blocked ${TRAVEL_BLOCKED_LIMIT} times without getting anywhere.`);
        for (const t of (path ?? []).slice(1, 3)) avoid.set(t.y * map.width + t.x, now + EXPLORE_AVOID_MS);
        path = null;
        moved.at = now;
        const aim = this.bot.moves.lastAim;
        this.bot.status(`Blocked at ${here.x},${here.y}${aim ? ` (${aim.running ? 'running' : 'stepping'} to ${aim.tile.x},${aim.tile.y}, screen ${aim.point.x},${aim.point.y})` : ''}; going round`);
      }
      for (const [key, until] of avoid) if (until <= now) avoid.delete(key);

      // Keep to the path while on it (and while no monster stands on the next few tiles); otherwise work out a new one, round them.
      const monsterTiles = new Set(this.bot.hunting.obstaclesNear(reading, here, STEER_ROUND_TILES).map((m) => m.y * map.width + m.x));
      const onPath: number = path ? path.findIndex((t) => t.x === here.x && t.y === here.y) : -1;
      path = path && onPath >= 0 ? path.slice(onPath) : null;
      if (path?.slice(1, 5).some((t) => monsterTiles.has(t.y * map.width + t.x))) path = null;
      if (!path || path.length < 2) {
        let dist = walkDistances(map, here, new Set([...avoid.keys(), ...monsterTiles, ...this.exitsToAvoid(map, here)]));
        let near = nearestApproach(map, dist, targets);
        if (!near && avoid.size) {
          avoid.clear();
          dist = walkDistances(map, here, this.exitsToAvoid(map, here));
          near = nearestApproach(map, dist, targets);
        }
        if (!near) {
          // Last try: only the walls (people standing about, or exits, may have closed every way).
          dist = walkDistances(map, here);
          near = nearestApproach(map, dist, targets);
        }
        if (!near) {
          // Give it a few seconds (people moving off, the reading catching up) before giving up.
          noPathSince ??= this.bot.clock.now();
          if (this.bot.clock.now() - noPathSince < NO_PATH_RETRY_MS) {
            this.bot.stopRunning();
            this.bot.statusEvery('No way through yet; trying again');
            path = null;
            await this.bot.sleep(500);
            continue;
          }
          throw new BotError(`Can't find a way to walk to ${route.links.length ? `the way to ${mapName(data, route.links[0].to)}` : place.npc!.name} from here.`);
        }
        noPathSince = null;
        path = pathBack(map, dist, near.tile);
        // Next to the exit already: step onto it.
        if (path.length < 2) {
          const onto = targets.find((t) => chebyshev(t, here) === 1);
          if (onto) path = [here, onto];
        }
      }
      if (path.length >= 2) await this.bot.moves.driveAlong(here, path, now);
      else this.bot.stopRunning();
      const left = route.links.length;
      this.bot.statusEvery(`Travelling to ${place.label}: ${left ? `${left} map${left === 1 ? '' : 's'} to go` : 'nearly there'}`);
      await this.bot.sleep(RUN_TICK_MS);
      drivenAt = this.bot.clock.now();
    }
  }

  /** Steps from the player (`dist`, from walkDistances) to each way off this map, by link id. */
  exitSteps(data: TravelData, map: MapGrid, dist: Int32Array): Map<number, number> {
    const steps = new Map<number, number>();
    for (const l of data.links) {
      if (l.from !== map.index) continue;
      const near = nearestApproach(map, dist, l.exit.map(([x, y]) => ({ x, y })));
      if (near) steps.set(l.id, near.steps);
    }
    return steps;
  }

  // ---- Waypoint stones ----

  /**
   * At a waypoint stone: clicks it to open the waypoint window, finds the
   * waypoint (scrolling the list if need be) and presses its Activate button,
   * then waits for the teleport. 'missing' when the window doesn't list it.
   */
  private async useWaypoint(stoneName: string, stone: Point, name: string, fromMap: number): Promise<'teleported' | 'missing' | 'failed'> {
    const result = await this.pickWaypoint(stoneName, stone, name, fromMap);
    if (result !== 'teleported' && this.bot.options.memory.latest()?.waypoints?.open) {
      // Close it: left open it covers the screen, and every click after lands on it.
      this.bot.key(VK.ESCAPE);
      await this.bot.sleep(300);
    }
    return result;
  }

  private async pickWaypoint(stoneName: string, stone: Point, name: string, fromMap: number): Promise<'teleported' | 'missing' | 'failed'> {
    const memory = this.bot.options.memory;
    const user = () => memory.latest()?.user;
    // Open the window, unless it already is.
    for (let attempt = 0; attempt < 2 && !memory.latest()?.waypoints?.open; attempt++) {
      const me = user();
      if (!me) return 'failed';
      const tileAt = tileToScreen(me, stone.x, stone.y);
      const point = (await this.bot.aimAt({ key: `stone${stone.x},${stone.y}`, point: tileAt, name: stoneName, tile: tileAt })) ?? tileAt;
      this.bot.status(`Opening the waypoints at the ${stoneName}`);
      await this.bot.click(point, this.bot.delay('menu'));
      for (const since = this.bot.clock.now(); this.bot.clock.now() - since < WAYPOINT_OPEN_MS && !memory.latest()?.waypoints?.open; ) {
        // Some stones ask first (Waypoints / Quests): take Waypoints.
        const menu = memory.latest()?.survival?.npcMenu;
        if (menu?.waypoints?.enabled) {
          await this.bot.click(boxCentre(menu.waypoints), this.bot.delay('menu'));
          await this.bot.sleep(400);
        }
        await this.bot.sleep(100);
      }
    }
    let window = memory.latest()?.waypoints;
    if (!window?.open) return 'failed';

    // Find its row: from the top of the list, a page at a time.
    let scrolledToTop = false;
    for (let tries = 0; tries < 20; tries++) {
      window = (await memory.fresh())?.waypoints;
      if (!window?.open || !window.rows?.length) return 'failed';
      const row = window.rows.find((r) => r.name === name);
      if (row) {
        if (!row.activate.enabled) return 'missing';
        this.bot.status(`Waypoint to ${name}`);
        await this.bot.click(boxCentre(row.activate), this.bot.delay('menu'));
        for (const since = this.bot.clock.now(); this.bot.clock.now() - since < WAYPOINT_TELEPORT_MS; ) {
          await this.bot.sleep(200);
          const map = memory.latest()?.map;
          if (map && map.index !== fromMap) return 'teleported';
        }
        return 'failed';
      }
      if (window.unlocked.length && !window.unlocked.some((w) => w.name === name)) return 'missing';
      const first = window.rows[0].activate;
      const before = window.scroll?.value ?? 0;
      if (!scrolledToTop) {
        this.bot.input.mouseWheel(this.bot.hwnd, first.x - 200, first.y + 60, -50);
        scrolledToTop = true;
      } else {
        if (window.scroll && window.scroll.value >= window.scroll.max - window.rows.length) return 'missing';
        this.bot.input.mouseWheel(this.bot.hwnd, first.x - 200, first.y + 60, 2);
      }
      await this.bot.sleep(150);
      if (scrolledToTop && tries > 0 && (await memory.fresh())?.waypoints?.scroll?.value === before) return 'missing';
    }
    return 'missing';
  }
}

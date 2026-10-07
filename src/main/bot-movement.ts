/** Moving along a path: running and stepping (where to aim the cursor), the teleport key on long runs, and the mount. */

import type { Point } from '../shared/types';
import { waypoint } from './map-explorer';
import { loadTravelData } from './travel';
import { VK } from './input';
import { EXPLORE_BLOCKED_MS, HOVER_SETTLE_MS, TELEPORT_JITTER_MS, TELEPORT_PRESS_MS, keyCode, mouseObjectName } from './bot-shared';
import type { BotContext } from './bot-context';

/**
 * Not a tile moved in this long while running means blocked. The game moves the player a stride at a time (3 tiles
 * on a mount) about every 0.65 s, so this has to be well over one stride.
 */
const BLOCKED_RUNNING_MS = 1100;

/** M gets on and off the mount: how long to wait for the game to show it, and how long to leave it if nothing happened. */
const MOUNT_SETTLE_MS = 1500;

/**
 * M does nothing mid-step: the character must have stayed on one tile this long first (waiting at most STILL_WAIT_MS).
 * Longer than a stride (about 650 ms), as the tile only changes once per stride while running.
 */
const STILL_MS = 700;

const STILL_WAIT_MS = 2000;

/**
 * Running: the cursor is held this many tiles from the character, the way the path goes (tested: 2 tiles
 * away the game doesn't run at all; 4 it does). A step is a click this many tiles off the same way (a click
 * on the tile right next to the character can land on its own body).
 */
const RUN_AIM_TILES = 4;

const STEP_AIM_TILES = 2;

/** How far out a run or step may be aimed to get clear of the character's own sprite. */
const AIM_OUT_TILES = 6;

const MOUNT_RETRY_MS = 30_000;

export class Movement {
  /** When the teleport key is next due. */
  teleportReadyAt = 0;
  /** M did nothing (no mount, or not allowed here): don't try again before this. */
  private mountRetryAt = 0;
  /** Maps where getting on the mount did nothing (on top of those the game data marks as no-mount). */
  private readonly noMountMaps = new Set<number>();
  /** When setMounted last pressed M: time standing still for it isn't time being blocked. */
  mountBusyAt = 0;
  /** Where driveAlong last aimed: the tile and the spot on screen, for telling what a blockage was. */
  lastAim: { tile: Point; point: Point; running: boolean } | null = null;

  constructor(private readonly bot: BotContext) {}

  /**
   * Gets on (or off) the mount with M when the game's memory says it isn't
   * already. If M changes nothing (no mount, or not allowed on this map), it's
   * left alone for a while rather than pressed over and over.
   */
  async setMounted(on: boolean): Promise<void> {
    const memory = this.bot.options.memory;
    const reading = memory.latest();
    const mounted = reading?.user?.mounted;
    if (mounted === undefined || mounted === on || this.bot.clock.now() < this.mountRetryAt) return;
    // No mount equipped (not bought yet, say): nothing to get on.
    if (on && reading?.user?.hasMount === false) return;
    // Mounts aren't allowed on this map (the game's data says so, or M did nothing here before).
    const mapIndex = reading?.map?.index;
    if (on && mapIndex !== undefined && (this.noMountMaps.has(mapIndex) || loadTravelData().maps.find((m) => m.i === mapIndex)?.noHorse)) return;
    try {
      await this.pressMount(on);
    } finally {
      this.mountBusyAt = this.bot.clock.now();
    }
    if (on && mapIndex !== undefined && memory.latest()?.user?.mounted !== true) this.noMountMaps.add(mapIndex);
  }

  /** Presses M (once the character has stopped) until the game shows the mount as wanted, twice at most. */
  private async pressMount(on: boolean): Promise<void> {
    const memory = this.bot.options.memory;
    this.bot.stopRunning();
    this.bot.releaseHold();
    this.bot.statusEvery(on ? 'Getting on the mount' : 'Getting off the mount');
    for (let attempt = 0; attempt < 2; attempt++) {
      // Pressed mid-step, M is ignored: let the character come to a stop first.
      await this.waitUntilStill();
      // A whole key press: M only works on the key coming back up.
      this.bot.input.keyDown(this.bot.hwnd, VK.M);
      this.bot.input.keyUp(this.bot.hwnd, VK.M);
      for (const since = this.bot.clock.now(); this.bot.clock.now() - since < MOUNT_SETTLE_MS; ) {
        if ((await memory.fresh(500))?.user?.mounted === on) return;
      }
    }
    this.mountRetryAt = this.bot.clock.now() + MOUNT_RETRY_MS;
  }

  /** Waits (up to STILL_WAIT_MS) until the game's memory shows the character on the same tile for STILL_MS. */
  async waitUntilStill(): Promise<void> {
    const memory = this.bot.options.memory;
    let tile = memory.latest()?.user;
    let since = this.bot.clock.now();
    for (const started = this.bot.clock.now(); this.bot.clock.now() - started < STILL_WAIT_MS; ) {
      const user = (await memory.fresh(500))?.user;
      if (!user) continue;
      if (!tile || user.x !== tile.x || user.y !== tile.y) {
        tile = user;
        since = this.bot.clock.now();
      } else if (this.bot.clock.now() - since >= STILL_MS) return;
    }
  }

  /**
   * How long without moving a tile counts as blocked: short while running (it
   * covers ground quickly), longer while stepping by clicks.
   */
  blockedAfterMs(): number {
    return this.bot.running ? BLOCKED_RUNNING_MS : EXPLORE_BLOCKED_MS;
  }

  /**
   * One tick along `path` (tiles from the player on): runs (right button held)
   * toward the farthest tile straight ahead that isn't under the HUD, steps by
   * clicking where the path turns, and presses the teleport key (if on) on long
   * straight stretches.
   */
  async driveAlong(user: Point, path: Point[], now: number, mount = true): Promise<void> {
    if (mount) await this.setMounted(true);
    const next = path[1];
    if (!next) return;
    // How much straight path is ahead, from here the way the first step goes.
    const ahead = waypoint(path);
    const straight = Math.max(Math.abs(ahead.x - user.x), Math.abs(ahead.y - user.y));
    // A run moves a whole stride (2 tiles, 3 on a mount) or not at all: with less straight path than that
    // before a turn or a wall, it doesn't go, so step a tile at a time instead.
    const stride = this.bot.options.memory.latest()?.user?.mounted ? 3 : 2;
    // The game moves the way the cursor is from the character, so the cursor goes a few tiles off that way
    // (not on a game window, where holding the button does nothing).
    const dir = { x: Math.sign(next.x - user.x), y: Math.sign(next.y - user.y) };
    const windows = this.bot.options.memory.latest()?.windows ?? [];
    const free = (p: Point) => this.bot.clickable(p) && !windows.some((w) => p.x >= w.x && p.x < w.x + w.width && p.y >= w.y && p.y < w.y + w.height);
    const toward = (tiles: number) => ({ x: user.x + dir.x * tiles, y: user.y + dir.y * tiles });
    const runTile = toward(RUN_AIM_TILES);
    const point = this.bot.toScreen(user, runTile.x, runTile.y);
    // A run can carry a stride past where it was meant to stop: not towards a way off the map close ahead.
    const map = this.bot.options.memory.map();
    const exits = map ? this.bot.travel.exitTiles(map) : null;
    const exitAhead = !!map && !!exits?.size && Array.from({ length: stride * 2 }, (_, k) => toward(k + 1)).some((t) => exits.has(t.y * map.width + t.x));
    let run = straight >= stride && free(point) && !exitAhead;
    // Starting a run: not with the cursor on the character itself (tall when mounted), or nothing happens.
    let runAt = { tile: runTile, point };
    if (run && !this.bot.running) {
      const clear = await this.clearOfMe(user, toward, RUN_AIM_TILES, free);
      if (clear) runAt = clear;
      else run = false;
    }
    if (!run) {
      this.bot.stopRunning();
      // A step: a click a little way off the way the path goes, pushed further out if it would land on the character.
      const clear = await this.clearOfMe(user, toward, STEP_AIM_TILES, free);
      const stepTile = clear?.tile ?? next;
      const stepPoint = clear?.point ?? this.bot.toScreen(user, next.x, next.y);
      this.lastAim = { tile: stepTile, point: stepPoint, running: false };
      await this.bot.click(stepPoint, this.bot.delay('attackClick'));
      return;
    }
    this.lastAim = { tile: runAt.tile, point: runAt.point, running: true };
    this.bot.holdRun(runAt.point);
    const vk = this.teleportKey();
    if (vk !== null && straight >= 6 && now >= this.teleportReadyAt) {
      this.bot.key(vk);
      this.teleportReadyAt = now + TELEPORT_PRESS_MS + Math.random() * TELEPORT_JITTER_MS;
    }
  }

  /**
   * The first spot from `first` tiles out (up to AIM_OUT_TILES) along the way `toward`
   * goes that's on the game world and not on the character itself: the game's title says
   * what's under the mouse, and a mounted character's sprite reaches a couple of tiles up.
   */
  private async clearOfMe(user: Point, toward: (tiles: number) => Point, first: number, free: (p: Point) => boolean): Promise<{ tile: Point; point: Point } | null> {
    const me = this.bot.options.memory.latest()?.user?.name;
    for (let tiles = first; tiles <= AIM_OUT_TILES; tiles++) {
      const tile = toward(tiles);
      const point = this.bot.toScreen(user, tile.x, tile.y);
      if (!free(point)) continue;
      if (!me) return { tile, point };
      this.bot.input.mouseMove(this.bot.hwnd, point.x, point.y);
      await this.bot.clock.wait(HOVER_SETTLE_MS);
      if (mouseObjectName(this.bot.input.windowTitle(this.bot.hwnd)) !== me) return { tile, point };
    }
    return null;
  }

  /** The teleport key, unless it's turned off (not every character has a teleport) or set to none. */
  teleportKey(): number | null {
    return this.bot.settings.exploreTeleport === false ? null : keyCode(this.bot.settings.hunt.unstuckKey);
  }
}

/** What the parts of the bot (bot*.ts) share: constants, small helpers, the errors that end a run, and target shapes. */

import type { Point } from '../shared/types';
import { GAME_HEIGHT, GAME_WIDTH, PANEL_MASKS } from './layout';
import type { MemoryBox, MemoryObject } from './game-memory';
import { VK } from './input';

/** How long Triple Triad waits for a reading from the memory reader (its first, or after a gap) before falling back to the screen. */
export const MEMORY_START_MS = 8000;

/** Exploring from memory: not a tile moved in this long while running means blocked; keep off that spot this long. */
export const EXPLORE_BLOCKED_MS = 1500;

export const EXPLORE_AVOID_MS = 10_000;

/** Paths keep off monsters this close (they move, so not further). */
export const STEER_ROUND_TILES = 8;

export const STATUS_INTERVAL_MS = 250;

/**
 * With "Pick up items" on, clicks at the character's feet (which picks up
 * everything within the character's pick-up radius). Without the game's memory
 * to say where items are: every second, and a few more after each kill.
 */
export const FLOOR_CLICKS = 2;

export const FLOOR_CLICK_GAP_MS = 40;

/** With the game's memory: click the feet this often while an item lies within the pick-up radius. */
export const ITEM_CLICK_EVERY_MS = 300;

/** An item still there after this long can't be picked up (someone else's, or a full bag): leave it alone for a while. */
export const LOOT_GIVE_UP_MS = 5000;

export const LOOT_WALK_GIVE_UP_MS = 8000;

export const LOOT_SKIP_MS = 120_000;

/** How often to re-aim while running. */
export const RUN_TICK_MS = 150;

/**
 * Press the teleport this often while exploring (plus a little random extra).
 * Presses during its cooldown are just refused by the game, so pressing often
 * means it fires the moment it's ready, which matters when pets block the way.
 */
export const TELEPORT_PRESS_MS = 400;

export const TELEPORT_JITTER_MS = 150;

/** How far from the player to click when roaming. */
export const ROAM_DISTANCE = 220;

export const ROAM_DIRECTIONS: Point[] = [
  { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 0 }, { x: 1, y: 1 },
  { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 }, { x: -1, y: -1 },
];

/** Virtual-key code for a bindable key name ('1'-'9', 'A'-'Z', 'F1'-'F12', 'Tab', 'Space', '`'), or null for none. */
export function keyCode(name: string): number | null {
  if (name === 'Tab') return 0x09;
  if (name === 'Space') return 0x20;
  if (name === '`') return 0xc0;
  if (/^[1-9A-Z]$/.test(name)) return name.charCodeAt(0);
  const f = /^F([1-9]|1[0-2])$/.exec(name);
  return f ? VK.F1 + Number(f[1]) - 1 : null;
}

export class Stopped extends Error {}

/** A problem the user can fix; shown as the status message. */
export class BotError extends Error {}

/**
 * The map view can't be worked with (a map zoom other than 100%, not measured yet): shown as the status message
 * like a BotError, but not one, so nothing that gives up on a BotError and carries on swallows it.
 */
export class ViewError extends Error {}

export function wholeSecondsSince(time: number, now: number): number {
  return Math.floor((now - time) / 1000);
}

export interface HuntTarget {
  key: string;
  point: Point;
  name?: string;
  /** From the game's memory: the middle of its map tile on screen, to aim around. */
  tile?: Point;
  /** From the game's memory: its map tile, and how many steps it is to walk there (round the walls). */
  at?: Point;
  steps?: number;
}

/**
 * Where to try the mouse around a monster's tile (from its middle), most likely
 * first. Measured in game: the game counts the mouse as over a monster at and
 * just below its tile's middle (218 of 218 times on the first spot). It shifts as
 * the monster moves, so each spot is still checked with the game before clicking.
 */
export const AIM_SPOTS: [number, number][] = [[4, 8], [4, 0], [4, 16], [16, 8], [-8, 8], [0, -8], [0, -24], [0, -40]];

/** The middle of a box (a button or window part) the game's memory gives. */
export function boxCentre(box: MemoryBox): Point {
  return { x: box.x + Math.round(box.width / 2), y: box.y + Math.round(box.height / 2) };
}

/** On the game's screen at 1600x900, clear of the edges and the HUD panels (BotContext.clickable works from the game's memory). */
export function clickable(point: Point): boolean {
  if (point.x < 20 || point.x > GAME_WIDTH - 20 || point.y < 20 || point.y > GAME_HEIGHT - 80) return false;
  return !PANEL_MASKS.some((m) => point.x >= m.left && point.x < m.right && point.y >= m.top && point.y < m.bottom);
}

/** A monster that can be attacked (guards and the like can't: the game marks them other than hostile). */
export function hostile(o: MemoryObject): boolean {
  return o.disposition === undefined || o.disposition === null || o.disposition === 4;
}

/** How long to let the game update its title after moving the mouse, before reading what's under it. */
export const HOVER_SETTLE_MS = 100;

/** What the game's title says is under the mouse ("Mouse Object: name"), or null. */
export function mouseObjectName(title: string): string | null {
  const match = /Mouse Object: ([^,]*)/.exec(title);
  return match ? match[1].trim() : null;
}

/**
 * Whether a monster's name as the game shows it is one of `names` (lower case): itself, or without a tag in front
 * that the game adds to some ("[Afflicted] RedKektal" is a RedKektal). Names that start with a tag of their own
 * ("[Behemoth] Demonic Kektal") match as they are.
 */
export function nameIn(name: string, names: ReadonlySet<string>): boolean {
  const lower = name.toLowerCase();
  if (names.has(lower)) return true;
  const untagged = /^\[[^\]]+\]\s*(.+)$/.exec(lower);
  return !!untagged && names.has(untagged[1]);
}

/** Whether a monster's name as the game shows it is `name` (lower case), a tag in front or not (see nameIn). */
export const sameName = (seen: string, name: string): boolean => nameIn(seen, new Set([name]));

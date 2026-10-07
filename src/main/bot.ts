import { performance } from 'node:perf_hooks';
import type { Delays, KeyId, Point, Settings, Stats, Status } from '../shared/types';
import { findBigMap, readBigMap, type BigMapReading } from './bigmap';
import { ExplorePlanner, PlayerTracker } from './explorer';
import type { Card } from './triad';
import type { TriadMemory } from './triad-memory';
import { cardOf, decideFromMemory, decideTriad, matchResult, myTurnInMemory, rulesFromFlags, type ReadCard } from './triad-player';
import { HAND_SLOTS, OK as TRIAD_OK, boardSampler, cellCentre, centre, readTriad, type TriadScreen } from './triad-vision';
import { findLabels } from './labels';
import {
  GAME_HEIGHT,
  GAME_WIDTH,
  HUD_MASKS,
  PANEL_MASKS,
  PLAYER,
  PLAYER_BAR_TEXT,
  PLAYER_HP_BAR,
  PLAYER_MP_BAR,
  TARGET_HP_BAR,
  TARGET_HP_TEXT,
  type Rect,
} from './layout';
import { locatePlayer, nearestMonster, readMinimap } from './minimap';
import type { NameBook } from './names';
import { Journey, cheapestTile, direction, expandFrom, markPathVisited, startTile } from './pathing';
import { SessionStats } from './session-stats';
import { MapExplorer, waypoint } from './map-explorer';
import { nearestApproach, pathBack, walkDistances } from './map-path';
import { classFlagOf, findPlace, loadTravelData, mapName, planRoute, type TravelData, type TravelLink, type TravelQuest } from './travel';
import { chooseGrindMap, describeChoice } from './grind';
import { exploredShare, type MapGrid } from './map-grid';
import { LabelTracker, isFloating, type Sighting } from './sightings';
import { tileToScreen, type GameMemory, type MemoryBox, type MemoryCollection, type MemoryObject, type MemoryState, type MemoryTriad } from './game-memory';
import { chooseDeck, deckInputs } from './triad-deck';
import {
  createFrame,
  findCharacterOnMap,
  findMapBottomRight,
  findMapTopLeft,
  isBagFull,
  playerHpFill,
  playerMpFill,
  readBar,
  signatureDifference,
  targetHpFill,
  viewSignature,
  type Frame,
} from './vision';
import * as win from './win32';

const SELL_CHECK_INTERVAL_SECONDS = 10;
/** Triple Triad: how often to look while waiting, the pause between clicking a card and its square, and time for a move to play out. */
const TRIAD_IDLE_MS = 1000;
const TRIAD_POLL_MS = 400;
const TRIAD_CLICK_GAP_MS = 250;
const TRIAD_SETTLE_MS = 1200;
/**
 * Where the mouse waits during Triple Triad: the empty black area under the
 * board. Left over a card, the card's tooltip appears above it, and over the
 * top row that covers the "Your turn" text.
 */
const TRIAD_PARK: Point = { x: 640, y: 625 };
/** How long Triple Triad waits for a reading from the memory reader (its first, or after a gap) before falling back to the screen. */
const MEMORY_START_MS = 8000;
/** Gathering: give up walking to a node after this long, and on a node that hasn't been picked this long after clicking it. */
const GATHER_WALK_GIVE_UP_MS = 15_000;
const GATHER_PICK_GIVE_UP_MS = 8000;
/** A node given up on is left alone this long (out of reach, or needs a higher profession level). */
const GATHER_SKIP_MS = 5 * 60_000;
/** Run (holding the right button) towards nodes further than this many tiles; closer, step by clicking. */
const GATHER_RUN_TILES = 3;
/** Looking for nodes: run one way for 4-8 s, turning sooner if the character hasn't moved a tile in this long. */
const GATHER_WANDER_MS = 4000;
/** Exploring from memory: not a tile moved in this long while running means blocked; keep off that spot this long. */
const EXPLORE_BLOCKED_MS = 1500;
/**
 * Not a tile moved in this long while running means blocked. The game moves the player a stride at a time (3 tiles
 * on a mount) about every 0.65 s, so this has to be well over one stride.
 */
const BLOCKED_RUNNING_MS = 1100;
const EXPLORE_AVOID_MS = 10_000;
/** Travel: this close to the NPC counts as there; blocked this many times on one map means stuck for good. */
const NPC_REACH_TILES = 2;
const TRAVEL_BLOCKED_LIMIT = 8;
/** Travelling and exploring with "Fight monsters in the way": monsters this close when blocked (or two right next to you) get fought. */
const FIGHT_RANGE_TILES = 2;
/** Give up on one monster after this long (out of reach, say), and on fighting altogether after this long. */
const FIGHT_TARGET_GIVE_UP_MS = 15_000;
const FIGHT_GIVE_UP_MS = 60_000;
/** Paths keep off monsters this close (they move, so not further). */
const STEER_ROUND_TILES = 8;
/** M gets on and off the mount: how long to wait for the game to show it, and how long to leave it if nothing happened. */
const MOUNT_SETTLE_MS = 1500;
/** M does nothing mid-step: the character must have stayed on one tile this long first (waiting at most STILL_WAIT_MS). */
const STILL_MS = 400;
const STILL_WAIT_MS = 2000;
/**
 * Running: the cursor is held this many tiles from the character, the way the path goes (tested: 2 tiles
 * away the game doesn't run at all; 4 it does). A step is a click this many tiles off the same way (a click
 * on the tile right next to the character can land on its own body).
 */
const RUN_AIM_TILES = 4;
const STEP_AIM_TILES = 2;
/** Seeking (Hunt with "Seek when idle"): give up on a goal after this long; a spawn spot visited is left this long. */
const SEEK_GIVE_UP_MS = 45_000;
const SPOT_REVISIT_MS = 5 * 60_000;
/** A spawn spot counts as visited this close. */
const SPOT_REACH_TILES = 4;
const MOUNT_RETRY_MS = 30_000;
/** Waypoints: how long to wait for the window to open after clicking the stone, and for the teleport after Activate. */
const WAYPOINT_OPEN_MS = 3000;
const WAYPOINT_TELEPORT_MS = 10_000;
/** Giving up on waypoints after this many tries that went wrong. */
const WAYPOINT_FAILURES = 3;
/** Arcadia Castle's map index, where Return to Arcadia and the death window's Return send you. */
const ARCADIA_MAP = 563;
/** How long to wait for Return to Arcadia (it may take a moment's channelling) and for coming back to life. */
const ARCADIA_WAIT_MS = 20_000;
const REVIVE_WAIT_MS = 30_000;
/** Selling in Arcadia: the shopkeeper who buys (his "Select All" picks what can be sold from the open bag tab). */
const SELL_NPC = { id: 145, name: 'Ludvik' };
const GATHER_BLOCKED_MS = 1200;

/** What the bot keeps track of during one Triple Triad match. */
interface TriadMatch {
  /** Who the opponent is (a signature of their name). */
  opponent: string;
  /** Cells where I put my cards, and what they were. */
  mine: Map<number, ReadCard>;
  /** Cells where she put her cards, and what they are. */
  hers: Map<number, Card>;
  /** Cards that were already down when the bot joined the match. */
  unknown: Set<number>;
  /** My cards whose look on the board has been learned. */
  learned: Set<number>;
}

/** The same cards in the same places (so nothing is mid-move between the two looks). */
function sameTriadLayout(a: TriadScreen, b: TriadScreen): boolean {
  return a.hand.length === b.hand.length && a.board.every((cell, i) => (cell?.owner ?? null) === (b.board[i]?.owner ?? null));
}
const STATUS_INTERVAL_MS = 250;
/** How often to check whether the mouse has left the game window, while paused. */
const PAUSE_POLL_MS = 150;
/** Captures failing this many times in a row stop the bot. */
const MAX_CAPTURE_FAILURES = 20;
/** Minimum time between two drinks of the same potion. */
const POTION_COOLDOWN_MS = 1500;
/**
 * With "Pick up items" on, clicks at the character's feet (which picks up
 * everything within the character's pick-up radius). Without the game's memory
 * to say where items are: every second, and a few more after each kill.
 */
const FLOOR_CLICKS = 2;
const FLOOR_CLICK_GAP_MS = 40;
const FLOOR_CLICK_EVERY_MS = 1000;
const KILL_FLOOR_CLICKS = 3;
/** With the game's memory: click the feet this often while an item lies within the pick-up radius. */
const ITEM_CLICK_EVERY_MS = 300;
/**
 * Items beyond the pick-up radius are walked towards between monsters if they're
 * at most this many tiles further out (any distance, with no monsters about).
 */
const LOOT_DETOUR_TILES = 6;
/** An item still there after this long can't be picked up (someone else's, or a full bag): leave it alone for a while. */
const LOOT_GIVE_UP_MS = 5000;
const LOOT_WALK_GIVE_UP_MS = 8000;
const LOOT_SKIP_MS = 120_000;
/** Exploring with "Pick up items": walk to items up to this many tiles beyond pick-up reach. */
const EXPLORE_LOOT_TILES = 8;
/** Clicking one target this long without it going means it can't be reached (or isn't a monster): skip it for a while. */
const TARGET_GIVE_UP_MS = 20_000;
const TARGET_SKIP_MS = 30_000;
/**
 * A target that stays more than a tile or two away while neither it nor the player gets any closer for this
 * long can't be reached (round a wall, say): it's left alone for TARGET_UNREACHABLE_SKIP_MS.
 */
const TARGET_NO_PROGRESS_MS = 6000;
const TARGET_UNREACHABLE_SKIP_MS = 2 * 60_000;
/** Walking distances for choosing targets are worked out again this often (or when the player moves). */
const HUNT_DIST_MS = 1000;
/**
 * The middle of the tile the character stands on. Names are drawn about a tile
 * above where a character stands (the target brackets around a monster are
 * centred 32px below its name), so the character's tile is centred 32px below
 * their name (y 383).
 */
const FEET: Point = { x: PLAYER.x, y: PLAYER.y + 50 };
/** The character's body, for casting spells on themselves. */
const SELF: Point = { x: PLAYER.x, y: PLAYER.y + 20 };
/** Train mode never casts faster than this. */
const MIN_TRAIN_INTERVAL_MS = 100;
/** Wander this many steps after running into something on the way to a minimap monster. */
const DETOUR_STEPS = 4;

/** Time for the big map to appear or disappear after pressing B. */
const BIG_MAP_DELAY_MS = 400;
/** How often to re-aim while running. */
const RUN_TICK_MS = 150;
/** Moving less than this on the big map (pixels) in STUCK_MS means stuck. */
const PROGRESS_PIXELS = 3;
const STUCK_MS = 1500;
/** Stuck this many times heading for one edge, skip it. */
const STUCK_TRIES = 6;
const SIDESTEP_MS = 700;
/** Time for the unstuck teleport to happen before carrying on. */
const TELEPORT_MS = 800;
/**
 * Press the teleport this often while exploring (plus a little random extra).
 * Presses during its cooldown are just refused by the game, so pressing often
 * means it fires the moment it's ready, which matters when pets block the way.
 */
const TELEPORT_PRESS_MS = 400;
const TELEPORT_JITTER_MS = 150;
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


/** How far from the player to click when roaming. */
const ROAM_DISTANCE = 220;
/** Below this, the view didn't scroll after a roam step: we're blocked. */
const MOVED_THRESHOLD = 4;
const ROAM_DIRECTIONS: Point[] = [
  { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 0 }, { x: 1, y: 1 },
  { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 }, { x: -1, y: -1 },
];

interface KeyAction {
  id: KeyId;
  vk: number;
  /** Pressed on every loop while fighting, ignoring its timer. */
  always?: boolean;
  /** Pause before/after the press so the cast isn't swallowed by another animation. */
  delay?: keyof Delays;
  delayWhen?: 'before' | 'after';
}

// Put the spammable spell on F1 and buffs on F6+.
const KEY_ACTIONS: KeyAction[] = [
  { id: 'F1', vk: win.VK.F1, always: true },
  ...(['F2', 'F3', 'F4', 'F5'] as const).map((id, i): KeyAction => ({ id, vk: win.VK.F1 + 1 + i, delay: 'quickKey', delayWhen: 'after' })),
  ...(['F6', 'F7', 'F8', 'F9', 'F10', 'F11'] as const).map((id, i): KeyAction => ({ id, vk: win.VK.F1 + 5 + i, delay: 'buffKey', delayWhen: 'before' })),
  { id: 'F12', vk: win.VK.F1 + 11, delay: 'buffKey', delayWhen: 'after' },
  { id: 'N1', vk: win.VK.N1, delay: 'itemKey', delayWhen: 'before' },
];

/** Virtual-key code for a bindable key name ('1'-'9', 'A'-'Z', 'F1'-'F12', 'Tab', 'Space', '`'), or null for none. */
function keyCode(name: string): number | null {
  if (name === 'Tab') return 0x09;
  if (name === 'Space') return 0x20;
  if (name === '`') return 0xc0;
  if (/^[1-9A-Z]$/.test(name)) return name.charCodeAt(0);
  const f = /^F([1-9]|1[0-2])$/.exec(name);
  return f ? win.VK.F1 + Number(f[1]) - 1 : null;
}

/** Where to point the mouse to run in each direction, keyed by "signX,signY". */
const RUN_POINTS: Record<string, Point> = {
  '1,1': { x: 1348, y: 700 },
  '-1,1': { x: 256, y: 619 },
  '1,-1': { x: 1290, y: 139 },
  '-1,-1': { x: 324, y: 121 },
  '0,-1': { x: 812, y: 73 },
  '0,1': { x: 823, y: 820 },
  '1,0': { x: 1341, y: 426 },
  '-1,0': { x: 232, y: 444 },
};
const SHOP_RUN_POINTS: Record<string, Point> = { ...RUN_POINTS, '0,1': { x: 809, y: 820 } };

const SHOP_LOCATION: Point = { x: 82, y: 76 };
const TOWN_EXIT: Point = { x: 696, y: 77 };

interface WalkOptions {
  /** Click instead of hovering, for when autorun is off. */
  click: boolean;
  /** Finish when the character stands exactly on the target. */
  stopAtTarget: boolean;
  /** Re-press this key every 30 steps. */
  repeatKey?: number;
}

type WalkResult = 'arrived' | 'mapChanged' | 'noPath';

class Stopped extends Error {}
/** A problem the user can fix; shown as the status message. */
class BotError extends Error {}

function wholeSecondsSince(time: number): number {
  return Math.floor((performance.now() - time) / 1000);
}

export interface BotOptions {
  report: (status: Status) => void;
  names: NameBook;
  /** What's remembered about Triple Triad: how digits look, and opponents' decks. */
  triad: TriadMemory;
  /** Renders part of a frame as a PNG data URL (for showing learned names). */
  imageOf: (frame: Frame, box: Rect) => string;
  /** Reads the game's memory (exact monsters and positions) when installed. */
  memory: GameMemory;
  /** Monster names seen so far, for the window's kill/skip list. */
  monsters?: (names: string[]) => void;
}

/** Something to attack: where to click, and a key to recognise it by from one look to the next. */
interface LootTarget {
  key: string;
  /** Tiles from the character (the larger of across and down). */
  distance: number;
  /** The middle of its tile on screen. */
  point: Point;
  /** Its map tile. */
  at: Point;
}

interface HuntTarget {
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
const AIM_SPOTS: [number, number][] = [[4, 8], [4, 0], [4, 16], [16, 8], [-8, 8], [0, -8], [0, -24], [0, -40]];
/** Time for the game to notice the mouse moved (it updates its title each frame). */
const HOVER_SETTLE_MS = 100;
/** Looks at a monster without finding it under the mouse before leaving it for a moment. */
const AIM_MISSES = 4;
const AIM_MISS_SKIP_MS = 8000;

/** The name of what the game says is under the mouse, from its title ("Mouse Object: <name>, ..."). */
function boxCentre(box: MemoryBox): Point {
  return { x: box.x + Math.round(box.width / 2), y: box.y + Math.round(box.height / 2) };
}

/** On the game's screen, clear of the edges and the HUD panels. */
function clickable(point: Point): boolean {
  if (point.x < 20 || point.x > GAME_WIDTH - 20 || point.y < 20 || point.y > GAME_HEIGHT - 80) return false;
  return !PANEL_MASKS.some((m) => point.x >= m.left && point.x < m.right && point.y >= m.top && point.y < m.bottom);
}

function mouseObjectName(title: string): string | null {
  const match = /Mouse Object: ([^,]*)/.exec(title);
  return match ? match[1].trim() : null;
}

export class Bot {
  private hwnd: win.Handle = null;
  private readonly frame = createFrame(GAME_WIDTH, GAME_HEIGHT);
  private mode: Status['mode'] = 'idle';
  private active = false;

  /** The left button held down on a target (archers), and where it was pressed. */
  private holding: { id: string; point: Point } | null = null;
  /** The spot (relative to its tile) where the current monster was last found under the mouse. */
  private aim: { key: string; offset: [number, number] } | null = null;
  /** Monster names seen in the game's memory this session. */
  private readonly monstersSeen = new Set<string>();
  private readonly sightings = new LabelTracker();
  private mapTopLeft: Point | null = null;
  private mapBottomRight: Point | null = null;
  private readonly lastPressed = new Map<KeyId, number>();
  private lastHpPotion = 0;
  private lastMpPotion = 0;
  private roamDirection = Math.floor(Math.random() * ROAM_DIRECTIONS.length);
  private roamStepsLeft = 0;
  private detourStepsLeft = 0;
  private minimapSelf: Point | null = null;
  private explored: number | null = null;
  /** Where the right button is being held to run, while exploring. */
  private running: Point | null = null;
  /** The player's position on the big map, kept through moments when the marker is hidden. */
  private readonly tracker = new PlayerTracker();
  /** Unexplored edges being skipped for a while, and how often each one got the player stuck. */
  private skipped: { point: Point; until: number }[] = [];
  private stuckAt: { point: Point; count: number }[] = [];
  /** When the teleport key is next due. */
  private teleportReadyAt = 0;
  /** M did nothing (no mount, or not allowed here): don't try again before this. */
  private mountRetryAt = 0;
  /** Quests mode hunting: only quest monsters, whatever the Hunt setting. */
  private forceQuestOnly = false;
  /** Maps where getting on the mount did nothing (on top of those the game data marks as no-mount). */
  private readonly noMountMaps = new Set<number>();
  /** When setMounted last pressed M: time standing still for it isn't time being blocked. */
  private mountBusyAt = 0;
  /** Seeking from memory: where it's heading (a monster the game knows of, or a spawn spot), and the spots seen lately. */
  private seek: { kind: 'monster' | 'spot'; key: string; label: string; target: Point; map: number; since: number; path: Point[] | null; moved: { at: number; x: number; y: number } } | null = null;
  private readonly visitedSpots = new Map<string, number>();
  private readonly seekExplorer = new MapExplorer();
  /** Explore's looting: items given up on, items in reach and since when, the item being walked to, and the next feet click. */
  private exploreLoot = {
    skipped: new Map<string, number>(),
    inReachSince: new Map<string, number>(),
    walking: null as { key: string; since: number; path: Point[] | null } | null,
    nextClickAt: 0,
  };
  /** Walking distances from the player, for telling which monsters can be reached. */
  private huntDist: { map: number; x: number; y: number; at: number; dist: Int32Array } | null = null;
  /** Where driveAlong last aimed: the tile and the spot on screen, for telling what a blockage was. */
  private lastAim: { tile: Point; point: Point; running: boolean } | null = null;
  /** Random teleports in a row, and when they may be used again after a pause. */
  private rerollsInRow = 0;
  private rerollPausedUntil = 0;
  private readonly planner = new ExplorePlanner();

  private captureMs = 0;
  private captureFailures = 0;
  private scanMs = 0;
  private hp: number | null = null;
  private mp: number | null = null;
  private kills = 0;
  /** All the time spent paused (mouse over the game), so loops can leave it out of their give-up timers. */
  private pausedMs = 0;
  /** What's been done this session and in all, for the window's stats panel. */
  private readonly stats = new SessionStats();
  private lastStatusAt = 0;
  /** The rule flags of the last Triple Triad match read from memory: Best deck picks cards for them. */
  private triadRules = 0;

  constructor(
    private settings: Settings,
    private readonly options: BotOptions,
  ) {
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
  }

  stop(): void {
    this.active = false;
  }

  /** Takes the all-time totals the window saved; returns the stats to show. */
  loadStats(saved: unknown): Stats {
    this.stats.restore(saved);
    return this.stats.snapshot(performance.now());
  }

  /** Clears this session's counts (all time keeps them); returns the stats to show. */
  resetStats(): Stats {
    this.stats.reset(performance.now());
    // The status line's kills too, so it agrees with the panel's "this session".
    this.kills = 0;
    return this.stats.snapshot(performance.now());
  }

  startAttack(): void {
    void this.run('attack', () => this.huntLoop());
  }

  startExplore(): void {
    this.skipped = [];
    this.stuckAt = [];
    this.tracker.reset();
    this.explored = null;
    this.planner.reset();
    this.rerollsInRow = 0;
    this.rerollPausedUntil = 0;
    void this.run('explore', () => this.exploreWithRestarts());
  }

  startTriad(): void {
    void this.run('triad', () => this.triadLoop());
  }

  startGather(): void {
    void this.run('gather', () => this.gatherLoop());
  }

  startDeck(): void {
    void this.run('deck', () => this.deckLoop());
  }

  startTrain(): void {
    void this.run('train', () => this.trainLoop());
  }

  startTravel(placeId: string): void {
    void this.run('travel', () => this.travelLoop(placeId));
  }

  startQuests(): void {
    void this.run('quest', () => this.questLoop());
  }

  startGrind(): void {
    void this.run('grind', () => this.grindLoop());
  }

  private async run(mode: Status['mode'], task: () => Promise<string>): Promise<void> {
    if (this.mode !== 'idle') return;
    this.mode = mode;
    this.active = true;
    this.stats.start(performance.now());
    let message = 'Stopped';
    try {
      this.hwnd = win.findWindow(this.settings.windowTitle);
      if (!this.hwnd) throw new BotError(`No window titled "${this.settings.windowTitle}..." found`);
      if (win.isMinimized(this.hwnd)) throw new BotError('The game is minimized; restore it first.');
      const size = win.clientSize(this.hwnd);
      if (size.width !== GAME_WIDTH || size.height !== GAME_HEIGHT) {
        throw new BotError(`The game is ${size.width}x${size.height}; set it to ${GAME_WIDTH}x${GAME_HEIGHT}.`);
      }
      const starting: Record<Status['mode'], string> = { idle: '', attack: 'Hunting', explore: 'Exploring', triad: 'Playing Triple Triad', deck: 'Building a Triple Triad deck', gather: 'Gathering', train: 'Training', travel: 'Travelling', grind: 'Grinding', quest: 'Questing' };
      this.status(starting[mode]);
      message = await task();
    } catch (error) {
      if (error instanceof BotError) message = error.message;
      else if (!(error instanceof Stopped)) message = `Error: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      // Never leave the character running on its own, or a button held down.
      this.stopRunning();
      this.releaseHold();
      this.options.memory.stop();
      this.mode = 'idle';
      this.active = false;
      this.sightings.reset();
      this.stats.stop(performance.now());
      this.status(message);
    }
  }

  private status(message: string): void {
    this.lastStatusAt = performance.now();
    this.options.report({
      mode: this.mode,
      message,
      captureMs: this.captureMs,
      scanMs: this.scanMs,
      hp: this.hp,
      mp: this.mp,
      kills: this.kills,
      explored: this.explored,
      stats: this.stats.snapshot(performance.now()),
    });
  }

  private statusEvery(message: string): void {
    if (performance.now() - this.lastStatusAt > STATUS_INTERVAL_MS) this.status(message);
  }

  private checkpoint(): void {
    if (!this.active) throw new Stopped();
  }

  /** Waits roughly `ms`, randomly varied by the fuzz percentage so actions don't land on a fixed rhythm. */
  private async sleep(ms: number): Promise<void> {
    const fuzz = Math.min(Math.max(this.settings.fuzzPercent, 0), 100) / 100;
    const actual = Math.max(0, ms * (1 + (Math.random() * 2 - 1) * fuzz));
    await new Promise((resolve) => setTimeout(resolve, actual));
    this.checkpoint();
  }

  private delay(name: keyof Delays): number {
    return this.settings.delays[name];
  }

  /** Scales one of the selling routine's original pauses (tuned for a 200 ms menu delay). */
  private menuPause(original: number): number {
    return (original * this.delay('menu')) / 200;
  }

  /** Lets queued events (such as a Stop click) run between loop iterations. */
  private async yieldToEvents(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    this.checkpoint();
    await this.pauseWhileMouseOver();
  }

  /** With "pause while my mouse is over the game" on, waits (hands off the game) until the mouse leaves the window. */
  private async pauseWhileMouseOver(): Promise<void> {
    if (!this.settings.pauseOnMouse || !win.cursorOverWindow(this.hwnd)) return;
    // Let go of everything so the player has full control.
    this.stopRunning();
    this.releaseHold();
    this.status('Paused: your mouse is over the game');
    const since = performance.now();
    try {
      while (this.settings.pauseOnMouse && win.cursorOverWindow(this.hwnd)) {
        await new Promise((resolve) => setTimeout(resolve, PAUSE_POLL_MS));
        this.checkpoint();
      }
    } finally {
      this.pausedMs += performance.now() - since;
    }
    this.status('Resumed');
  }

  private capture(): void {
    const start = performance.now();
    try {
      win.captureClient(this.hwnd, this.settings.capture, GAME_WIDTH, GAME_HEIGHT, this.frame.bytes);
      this.captureFailures = 0;
    } catch (error) {
      // The capture fails now and then; carry on with the last frame unless it keeps failing.
      if (++this.captureFailures > MAX_CAPTURE_FAILURES) {
        throw new BotError(`Can't capture the game window (${error instanceof Error ? error.message : String(error)}); is it minimized?`);
      }
    }
    this.captureMs = performance.now() - start;
  }

  private key(vk: number): void {
    win.keyDown(this.hwnd, vk);
  }

  private async click(point: Point, holdMs: number): Promise<void> {
    win.mouseMove(this.hwnd, point.x, point.y);
    win.leftDown(this.hwnd, point.x, point.y);
    try {
      await this.sleep(holdMs);
    } finally {
      // Let go even when Stop comes mid-click (the sleep throws): the game would keep the button held.
      win.leftUp(this.hwnd, point.x, point.y);
    }
  }

  // ---- Hunting ----

  /**
   * Hunts the simple way: click the nearest monster name until it's gone, then
   * the next nearest. Every couple of seconds, click the ground at the
   * character's feet to pick up loot. A target that takes too long (out of
   * reach, or not really a monster) is skipped for a while.
   *
   * Grind's options: `seek` overrides "Seek when idle"; once `stopWhen` gives a
   * reason, the fight going on is finished and the reason returned.
   */
  private async huntLoop(options: { seek?: boolean; stopWhen?: () => string | null; questOnly?: boolean } = {}): Promise<string> {
    if (options.questOnly) {
      this.forceQuestOnly = true;
      try {
        return await this.huntLoop({ ...options, questOnly: false });
      } finally {
        this.forceQuestOnly = false;
      }
    }
    let lastSellCheck = performance.now();
    let current: { key: string; since: number } | null = null;
    let misses = 0;
    const skipped = new Map<string, number>();
    let nextFloorAt = 0;
    let walkingTo: { key: string; since: number } | null = null;
    /** Items within reach, and when each was first seen there. */
    const inReachSince = new Map<string, number>();
    let nextItemClickAt = 0;
    /** The current target's distance and the player's tile, and since when they've stayed the same. */
    let approach: { state: string; since: number } | null = null;
    let stopping: string | null = null;
    this.huntDist = null;
    this.seek = null;
    this.visitedSpots.clear();
    this.seekExplorer.reset();
    let paused = this.pausedMs;
    this.options.memory.start();

    while (true) {
      await this.yieldToEvents();
      // Time paused doesn't count towards giving up on a target, an item in reach or a walk to one.
      const pause = this.pausedMs - paused;
      paused = this.pausedMs;
      if (pause > 0) {
        if (current) current.since += pause;
        if (walkingTo) walkingTo.since += pause;
        for (const [key, since] of inReachSince) inReachSince.set(key, since + pause);
      }
      this.capture();

      const start = performance.now();
      const targetHp = readBar(this.frame, TARGET_HP_BAR, targetHpFill, TARGET_HP_TEXT);
      // The target frame only hides names while it's showing.
      const labels = findLabels(this.frame, targetHp === null ? PANEL_MASKS : HUD_MASKS);
      this.hp = readBar(this.frame, PLAYER_HP_BAR, playerHpFill, PLAYER_BAR_TEXT);
      this.mp = readBar(this.frame, PLAYER_MP_BAR, playerMpFill, PLAYER_BAR_TEXT);
      this.scanMs = performance.now() - start;
      const now = performance.now();
      const sightings = this.sightings.update(labels, now);
      this.drinkPotions();

      for (const [key, until] of skipped) if (until <= now) skipped.delete(key);
      const memory = this.options.memory.latest();
      const candidates = memory ? this.memoryTargets(memory) : this.screenTargets(sightings, now);
      const live = candidates.filter((c) => !skipped.has(c.key));
      let target: HuntTarget | undefined = current ? live.find((c) => c.key === current!.key) : undefined;
      if (current && !target) {
        // Gone: dead (or, on screen, out of sight). Pick up what it dropped if it died close by.
        // Not a kill if the other source picked it (the memory reading came or went: the keys differ),
        // or if the memory still has it alive (gone under the HUD, say).
        const key = current.key;
        const killed = key.startsWith(memory ? 'm' : 's') && !memory?.objects?.some((o) => `m${o.id}` === key && !o.dead);
        current = null;
        if (killed) {
          this.kills++;
          this.stats.count('kills');
        }
        if (killed && this.settings.hunt.loot && !memory) {
          // Without the memory there's no telling what was picked up: count the try.
          this.stats.count('items');
          this.releaseHold();
          await this.clickFloor(KILL_FLOOR_CLICKS, FLOOR_CLICK_GAP_MS);
          nextFloorAt = performance.now() + FLOOR_CLICK_EVERY_MS;
        }
      }
      // Time to stop: once no fight is going on.
      stopping ??= options.stopWhen?.() ?? null;
      if (stopping && !current) {
        this.stopRunning();
        this.releaseHold();
        return stopping;
      }

      if (memory && this.settings.hunt.loot) {
        const reach = memory.user!.pickUpRadius ?? 0;
        const items = this.groundItems(memory, skipped);
        // Items within reach: click the feet straight away (between attacks), giving up on any that stay put.
        const inReach = items.filter((i) => i.distance <= reach);
        for (const [key, since] of inReachSince) {
          if (!inReach.some((i) => i.key === key)) {
            // Gone from the ground (not just out of reach) without being given up on: picked up, most likely.
            if (!items.some((i) => i.key === key)) this.stats.count('items');
            inReachSince.delete(key);
          } else if (now - since > LOOT_GIVE_UP_MS) {
            skipped.set(key, now + LOOT_SKIP_MS);
            inReachSince.delete(key);
          }
        }
        for (const i of inReach) if (!skipped.has(i.key) && !inReachSince.has(i.key)) inReachSince.set(i.key, now);
        if (inReachSince.size > 0 && now >= nextItemClickAt) {
          this.releaseHold();
          this.stopRunning();
          await this.clickFloor(FLOOR_CLICKS, FLOOR_CLICK_GAP_MS);
          nextItemClickAt = performance.now() + ITEM_CLICK_EVERY_MS;
          this.statusEvery(`Picking up ${inReachSince.size} item${inReachSince.size === 1 ? '' : 's'}`);
        }
        // Between monsters (or with none about), walk towards the nearest item out of reach.
        const far = items
          .filter((i) => i.distance > reach && clickable(i.point) && (live.length === 0 || i.distance <= reach + LOOT_DETOUR_TILES))
          .sort((a, b) => a.distance - b.distance);
        const walk = !target && inReachSince.size === 0 ? (far.find((i) => i.key === walkingTo?.key) ?? far[0]) : undefined;
        if (walk) {
          const since: number = walkingTo && walkingTo.key === walk.key ? walkingTo.since : now;
          walkingTo = { key: walk.key, since };
          if (now - since > LOOT_WALK_GIVE_UP_MS) {
            skipped.set(walk.key, now + LOOT_SKIP_MS);
            walkingTo = null;
            continue;
          }
          this.releaseHold();
          this.stopRunning();
          await this.click(walk.point, this.delay('pickUpClick'));
          await this.sleep(this.delay('runStep'));
          this.statusEvery(`Walking to an item ${walk.distance} tiles away`);
          continue;
        }
        walkingTo = null;
      }
      // Neither the player nor the target getting any closer for a while, with it still out of reach: walled off.
      if (target?.at && memory?.user) {
        const gap = Math.max(Math.abs(target.at.x - memory.user.x), Math.abs(target.at.y - memory.user.y));
        const state = `${target.key} ${memory.user.x},${memory.user.y} ${gap}`;
        if (!approach || approach.state !== state) approach = { state, since: now };
        else if (gap > 2 && now - approach.since > TARGET_NO_PROGRESS_MS) {
          skipped.set(target.key, now + TARGET_UNREACHABLE_SKIP_MS);
          this.status(`Can't get at ${target.name ?? 'that one'}; trying another`);
          target = undefined;
          current = null;
          approach = null;
        }
      }
      if (target && now - current!.since > TARGET_GIVE_UP_MS) {
        skipped.set(target.key, now + TARGET_SKIP_MS);
        this.status('Taking too long on that one; trying another');
        target = undefined;
        current = null;
      }
      if (!target) {
        // Nearest to walk to, where the game's memory says; else nearest on screen.
        const distance = (c: HuntTarget) => (c.steps !== undefined ? c.steps * 48 : Math.hypot(c.point.x - PLAYER.x, c.point.y - PLAYER.y));
        target = live.reduce<HuntTarget | undefined>((best, c) => (!best || distance(c) < distance(best) ? c : best), undefined);
        if (target) {
          current = { key: target.key, since: now };
          misses = 0;
        }
      }

      let point = this.holding && this.holding.id === target?.key ? this.holding.point : target?.point;
      // (An archer already holding the button on this target keeps holding.)
      if (target?.tile && target.name && this.holding?.id !== target.key) {
        // Only click where the game confirms the monster is under the mouse: a miss is a "walk here".
        point = (await this.aimAt(target)) ?? undefined;
        if (!point && ++misses >= AIM_MISSES) {
          skipped.set(target.key, now + AIM_MISS_SKIP_MS);
          current = null;
        }
        if (point) misses = 0;
      }
      if (target && point) {
        this.stopRunning();
        if (memory) await this.setMounted(false);
        if (this.settings.archer) {
          this.hold(point, target.key);
          await this.sleep(this.delay('attackClick'));
        } else {
          await this.click(point, this.delay('attackClick'));
        }
        await this.pressKeys(true);
        this.statusEvery(`Attacking ${target.name ?? ''} (${memory ? 'game memory' : 'screen'})`);
      } else if (target) {
        this.stopRunning();
        this.statusEvery(`Lining up on ${target.name ?? 'a monster'}`);
      } else {
        this.releaseHold();
        await this.pressKeys(false);
        // With the game's memory: head for monsters it knows of, then where they spawn; else the minimap, or wander.
        if ((options.seek ?? this.settings.hunt.roam) && !(memory && (await this.seekFromMemory(memory, skipped)))) await this.seekOrRoam();
        else {
          await this.sleep(150);
          this.statusEvery(`Waiting for monsters (${memory ? 'game memory' : `screen: ${this.options.memory.problem}`})`);
        }
      }

      // Without the game's memory to say where items are, click the ground at the feet now and then.
      if (this.settings.hunt.loot && !memory && performance.now() >= nextFloorAt) {
        this.releaseHold();
        await this.clickFloor(FLOOR_CLICKS, FLOOR_CLICK_GAP_MS);
        nextFloorAt = performance.now() + FLOOR_CLICK_EVERY_MS;
      }

      if (this.settings.sellItems && wholeSecondsSince(lastSellCheck) > SELL_CHECK_INTERVAL_SECONDS) {
        lastSellCheck = performance.now();
        this.releaseHold();
        await this.sellItems();
        this.status('Hunting');
      }
    }
  }

  /** Items on the ground from the game's memory (not skipped), with their distance in tiles and where they are on screen. */
  private groundItems(memory: MemoryState, skipped: Map<string, number>): LootTarget[] {
    const user = memory.user!;
    const items: LootTarget[] = [];
    for (const o of memory.objects ?? []) {
      if (o.kind !== 'item' || skipped.has(`i${o.id}`)) continue;
      const point = tileToScreen(user, o.x, o.y);
      items.push({ key: `i${o.id}`, distance: Math.max(Math.abs(o.x - user.x), Math.abs(o.y - user.y)), point, at: { x: o.x, y: o.y } });
    }
    return items;
  }

  /** Monsters from the game's memory: alive, not anyone's pet, not set to be skipped, and on screen clear of the HUD. */
  private memoryTargets(memory: MemoryState): HuntTarget[] {
    const user = memory.user!;
    // Walking distances from here (worked out again when the player moves, or every so often).
    const map = this.options.memory.map();
    const now = performance.now();
    if (map && (!this.huntDist || this.huntDist.map !== map.index || this.huntDist.x !== user.x || this.huntDist.y !== user.y || now - this.huntDist.at > HUNT_DIST_MS)) {
      this.huntDist = { map: map.index, x: user.x, y: user.y, at: now, dist: walkDistances(map, { x: user.x, y: user.y }) };
    }
    const dist = map && this.huntDist?.map === map.index ? this.huntDist.dist : null;
    const skip = new Set((this.settings.skipMonsters ?? []).map((n) => n.toLowerCase()));
    const wanted = this.questWanted(memory);
    const seen = new Set<string>();
    const targets: HuntTarget[] = [];
    for (const o of memory.objects ?? []) {
      if (o.kind !== 'monster' || o.pet || !o.name) continue;
      seen.add(o.name);
      if (o.dead || skip.has(o.name.toLowerCase())) continue;
      if (wanted && !wanted.has(o.name.toLowerCase())) continue;
      const tile = tileToScreen(user, o.x, o.y);
      const point = { x: tile.x + AIM_SPOTS[0][0], y: tile.y + AIM_SPOTS[0][1] };
      if (!clickable(point)) continue;
      // Walled off (no way to walk next to it): no use attacking.
      let steps: number | undefined;
      if (dist && map) {
        const near = nearestApproach(map, dist, [{ x: o.x, y: o.y }]);
        if (!near) continue;
        steps = near.steps;
      }
      targets.push({ key: `m${o.id}`, point, name: o.name, tile, at: { x: o.x, y: o.y }, steps });
    }
    this.reportMonsters(seen);
    return targets;
  }

  /**
   * Hovers spots around a monster's tile until the game's title says the mouse is
   * over it (by name), starting with the spot that worked last time; null if none did.
   */
  private async aimAt(target: HuntTarget): Promise<Point | null> {
    const remembered = this.aim?.key === target.key ? [this.aim.offset] : [];
    for (const [dx, dy] of [...remembered, ...AIM_SPOTS]) {
      const point = { x: target.tile!.x + dx, y: target.tile!.y + dy };
      win.mouseMove(this.hwnd, point.x, point.y);
      await new Promise((resolve) => setTimeout(resolve, HOVER_SETTLE_MS));
      this.checkpoint();
      if (mouseObjectName(win.windowTitle(this.hwnd)) === target.name) {
        this.aim = { key: target.key, offset: [dx, dy] };
        return point;
      }
    }
    return null;
  }

  /** Overhead names from the screen: not floating combat text, not set to "Never attack". */
  private screenTargets(sightings: Sighting[], now: number): HuntTarget[] {
    return sightings
      .filter((s) => !isFloating(s, now) && this.options.names.judgeLabel(s.label).kind !== 'harmless')
      // Aim at the name's own part if it has run into another name.
      .map((s) => ({ key: `s${s.id}`, point: this.options.names.judgeLabel(s.label).label.centre }));
  }

  /** Tells the window which monsters have been seen (for choosing which to skip), when the list grows. */
  private reportMonsters(seen: Set<string>): void {
    let grew = false;
    for (const name of seen) {
      if (this.monstersSeen.has(name)) continue;
      this.monstersSeen.add(name);
      grew = true;
    }
    if (grew) this.options.monsters?.([...this.monstersSeen].sort());
  }

  /** Holds the left button down on a target (archers), following it as it moves; a new target gets a fresh press. */
  private hold(point: Point, id: string): void {
    if (this.holding && this.holding.id === id) {
      win.mouseMove(this.hwnd, point.x, point.y, win.MK_LBUTTON);
      this.holding.point = point;
      return;
    }
    this.releaseHold();
    win.mouseMove(this.hwnd, point.x, point.y);
    win.leftDown(this.hwnd, point.x, point.y);
    this.holding = { id, point };
  }

  /** Lets go of a held target (before anything else uses the mouse). */
  private releaseHold(): void {
    if (!this.holding) return;
    win.leftUp(this.hwnd, this.holding.point.x, this.holding.point.y);
    this.holding = null;
  }

  private drinkPotions(): void {
    const { hunt } = this.settings;
    const now = performance.now();
    const hpKey = keyCode(hunt.hpPotionKey);
    if (hpKey !== null && this.hp !== null && this.hp * 100 < hunt.hpPotionPercent && now - this.lastHpPotion > POTION_COOLDOWN_MS) {
      this.key(hpKey);
      this.lastHpPotion = now;
    }
    const mpKey = keyCode(hunt.mpPotionKey);
    if (mpKey !== null && this.mp !== null && this.mp * 100 < hunt.mpPotionPercent && now - this.lastMpPotion > POTION_COOLDOWN_MS) {
      this.key(mpKey);
      this.lastMpPotion = now;
    }
  }

  /** Presses the enabled spell and buff keys that are due; returns whether the attack spell (F1) was cast. */
  private async pressKeys(fighting: boolean): Promise<boolean> {
    let cast = false;
    for (const action of KEY_ACTIONS) {
      const setting = this.settings.keys[action.id];
      if (!setting?.enabled) continue;
      if (action.always && !fighting) continue;

      const last = this.lastPressed.get(action.id);
      const due = last === undefined || wholeSecondsSince(last) > setting.seconds;
      if (!action.always && !due) continue;

      if (action.delay && action.delayWhen === 'before') await this.sleep(this.delay(action.delay));
      this.key(action.vk);
      this.lastPressed.set(action.id, performance.now());
      if (action.always) cast = true;
      if (action.delay && action.delayWhen === 'after') await this.sleep(this.delay(action.delay));
    }
    return cast;
  }

  /**
   * Clicks the ground at the character's feet: the character picks up
   * everything within reach, so there's no need to walk to each item (or even
   * to see it: not every drop shows a label).
   */
  private async clickFloor(times: number, gapMs: number): Promise<void> {
    const pickUpKey = keyCode(this.settings.hunt.pickUpKey);
    for (let i = 0; i < times; i++) {
      await this.click(FEET, this.delay('pickUpClick'));
      if (pickUpKey !== null) this.key(pickUpKey);
      await this.sleep(gapMs);
    }
  }

  /**
   * With "Quest monsters only": the names (lower case) of the monsters an
   * unfinished quest task still needs on this map; null when the setting is off
   * or the quest log can't be read (then everything counts).
   */
  private questWanted(reading: MemoryState): Set<string> | null {
    if (!(this.settings.hunt.questOnly || this.forceQuestOnly) || !reading.questTargets) return null;
    const mapIndex = reading.map?.index;
    return new Set(reading.questTargets.filter((t) => t.map === null || t.map === mapIndex).map((t) => t.name.toLowerCase()));
  }

  /** What the quest log wants elsewhere, for the status line ("Skeleton on Bichon Cave Lv 3"). */
  private questElsewhere(reading: MemoryState): string {
    const targets = reading.questTargets ?? [];
    if (!targets.length) return 'Quest monsters only: no unfinished quest needs monsters killed';
    const data = loadTravelData();
    const list = targets.slice(0, 3).map((t) => (t.map === null ? t.name : `${t.name} on ${mapName(data, t.map)}`));
    return `Quest monsters only: none here (the quests want ${list.join(', ')}${targets.length > 3 ? '...' : ''})`;
  }

  /**
   * Hunting with nothing to fight, from the game's memory: walks (a real path
   * round the walls) to the nearest monster the game knows of, even off screen;
   * failing that, to the spot where the most monsters spawn for the walk
   * (from the game's spawn data) that hasn't been visited lately; failing
   * that, to unexplored ground. False when there's nothing to go on.
   */
  private async seekFromMemory(reading: MemoryState, skipped: ReadonlyMap<string, number>): Promise<boolean> {
    const map = this.options.memory.map();
    const user = reading.user;
    if (!map || !user) return false;
    const here = { x: user.x, y: user.y };
    const now = performance.now();
    const away = (a: Point, b: Point) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    const skip = new Set((this.settings.skipMonsters ?? []).map((n) => n.toLowerCase()));
    for (const [key, until] of this.visitedSpots) if (until <= now) this.visitedSpots.delete(key);

    let goal = this.seek && this.seek.map === map.index ? this.seek : null;
    // A monster the game knows of comes first: one that can be walked to, and isn't being left alone.
    const dist = walkDistances(map, here);
    const wanted = this.questWanted(reading);
    if (wanted?.size === 0) {
      // Quest monsters only, and none wanted on this map: say where they are.
      this.stopRunning();
      this.statusEvery(this.questElsewhere(reading));
      await this.sleep(500);
      return true;
    }
    const monsters = (reading.objects ?? []).filter(
      (o) =>
        o.kind === 'monster' && !o.pet && !o.dead && o.name && !skip.has(o.name.toLowerCase()) && (!wanted || wanted.has(o.name.toLowerCase())) &&
        !skipped.has(`m${o.id}`) && nearestApproach(map, dist, [{ x: o.x, y: o.y }]),
    );
    const chased = goal?.kind === 'monster' ? monsters.find((m) => `m${m.id}` === goal!.key) : undefined;
    if (chased) goal!.target = { x: chased.x, y: chased.y };
    else if (monsters.length) {
      const m = monsters.reduce((best, o) => (away(o, here) < away(best, here) ? o : best));
      goal = { kind: 'monster', key: `m${m.id}`, label: m.name, target: { x: m.x, y: m.y }, map: map.index, since: now, path: null, moved: { at: now, x: NaN, y: NaN } };
    }
    // Reached, or taking too long: on to the next.
    if (goal && (away(here, goal.target) <= (goal.kind === 'spot' ? SPOT_REACH_TILES : 1) || now - goal.since > SEEK_GIVE_UP_MS)) {
      if (goal.kind === 'spot') this.visitedSpots.set(goal.key, now + SPOT_REVISIT_MS);
      goal = null;
    }
    if (!goal) goal = this.pickSpawnSpot(map, here, skip, now, wanted);
    if (!goal) {
      // No spawn data for this map: explore instead.
      const plan = this.seekExplorer.plan(map, here, now, this.obstaclesNear(reading, here, STEER_ROUND_TILES).map((o) => ({ x: o.x, y: o.y })));
      if (!plan || plan === 'done') return false;
      await this.driveAlong(here, plan.path, now, false);
      this.statusEvery('Looking for monsters: exploring');
      await this.sleep(RUN_TICK_MS);
      return true;
    }

    // Not moving while trying to: give this one up and pick another next time.
    if (here.x !== goal.moved.x || here.y !== goal.moved.y) goal.moved = { at: now, x: here.x, y: here.y };
    else if (now - goal.moved.at > this.blockedAfterMs() + RUN_TICK_MS * 2) {
      if (goal.kind === 'spot') this.visitedSpots.set(goal.key, now + SPOT_REVISIT_MS);
      this.seek = null;
      return true;
    }
    // Keep to the path while on it (and clear of monsters); otherwise work out a new one.
    const onPath: number = goal.path ? goal.path.findIndex((t) => t.x === here.x && t.y === here.y) : -1;
    goal.path = goal.path && onPath >= 0 ? goal.path.slice(onPath) : null;
    if (!goal.path || goal.path.length < 2) {
      const blocked = new Set(this.obstaclesNear(reading, here, STEER_ROUND_TILES).map((o) => o.y * map.width + o.x));
      const dist = walkDistances(map, here, blocked);
      const near = nearestApproach(map, dist, [goal.target]);
      if (!near || near.steps === 0) {
        if (goal.kind === 'spot') this.visitedSpots.set(goal.key, now + SPOT_REVISIT_MS);
        this.seek = null;
        return true;
      }
      goal.path = pathBack(map, dist, near.tile);
    }
    this.seek = goal;
    await this.driveAlong(here, goal.path, now, false);
    this.statusEvery(goal.kind === 'monster' ? `Heading for ${goal.label}` : `Heading for where ${goal.label} spawn`);
    await this.sleep(RUN_TICK_MS);
    return true;
  }

  /**
   * The best spawn spot on this map not visited lately: near, and with plenty of
   * monsters (not all of them unticked) for the walk. Null without spawn data.
   */
  private pickSpawnSpot(map: MapGrid, here: Point, skip: Set<string>, now: number, wanted: Set<string> | null = null): NonNullable<Bot['seek']> | null {
    const data = loadTravelData();
    const spots = data.spawns?.[map.index];
    if (!spots?.length) return null;
    const names = (set: number) => (data.spawnSets?.[set] ?? []).map((i) => data.monsters?.[i] ?? '?');
    const dist = walkDistances(map, here);
    let best: { spot: (typeof spots)[number]; score: number; steps: number } | null = null;
    for (const spot of spots) {
      const [x, y, n, set] = spot;
      if (this.visitedSpots.has(`${x},${y}`)) continue;
      if (names(set).every((name) => skip.has(name.toLowerCase()))) continue;
      // Quest monsters only: spots where one of them spawns.
      if (wanted && !names(set).some((name) => wanted.has(name.toLowerCase()))) continue;
      const near = nearestApproach(map, dist, [{ x, y }]);
      if (!near) continue;
      // Steps there, less a bonus for how many monsters to expect.
      const score = near.steps - 15 * Math.log2(1 + n);
      if (!best || score < best.score) best = { spot, score, steps: near.steps };
    }
    if (!best) {
      // Every spot seen lately: start the round again.
      if (this.visitedSpots.size) this.visitedSpots.clear();
      return null;
    }
    const [x, y, , set] = best.spot;
    const list = names(set).filter((name) => !skip.has(name.toLowerCase()) && (!wanted || wanted.has(name.toLowerCase())));
    const label = list.slice(0, 3).join(', ') + (list.length > 3 ? '...' : '');
    return { kind: 'spot', key: `${x},${y}`, label, target: { x, y }, map: map.index, since: now, path: null, moved: { at: now, x: NaN, y: NaN } };
  }

  /** With nothing on screen, head for the nearest monster on the minimap, or wander. */
  private async seekOrRoam(): Promise<void> {
    const reading = readMinimap(this.frame, this.minimapSelf);
    if (reading.self) this.minimapSelf = reading.self;
    const monster = this.detourStepsLeft > 0 ? null : nearestMonster(reading);

    if (monster && reading.self) {
      // The minimap keeps the world's proportions, so its directions are screen directions.
      const dx = monster.centre.x - reading.self.x;
      const dy = monster.centre.y - reading.self.y;
      const length = Math.hypot(dx, dy);
      if (length > 0) {
        const point = {
          x: Math.round(PLAYER.x + (dx / length) * ROAM_DISTANCE),
          y: Math.round(PLAYER.y + (dy / length) * ROAM_DISTANCE * 0.75),
        };
        this.statusEvery('Heading for a monster on the minimap');
        // Blocked on the way: wander a little to get around it.
        if (!(await this.step(point))) this.detourStepsLeft = DETOUR_STEPS;
        return;
      }
    }

    if (this.detourStepsLeft > 0) this.detourStepsLeft--;
    await this.roam();
    this.statusEvery(reading.self ? 'Roaming (no monsters on the minimap)' : 'Roaming (minimap not found)');
  }

  /** Takes a step in the current roaming direction, turning when blocked or every so often. */
  private async roam(): Promise<void> {
    if (this.roamStepsLeft <= 0) {
      this.roamDirection = Math.floor(Math.random() * ROAM_DIRECTIONS.length);
      this.roamStepsLeft = 6 + Math.floor(Math.random() * 7);
    }
    const dir = ROAM_DIRECTIONS[this.roamDirection];
    const scale = dir.x && dir.y ? ROAM_DISTANCE / Math.SQRT2 : ROAM_DISTANCE;
    const point = { x: Math.round(PLAYER.x + dir.x * scale), y: Math.round(PLAYER.y + dir.y * scale * 0.75) };
    this.roamStepsLeft--;

    if (!(await this.step(point))) {
      // Blocked: turn somewhere other than straight back into the same wall.
      this.roamDirection = (this.roamDirection + 2 + Math.floor(Math.random() * 5)) % ROAM_DIRECTIONS.length;
      this.roamStepsLeft = 4 + Math.floor(Math.random() * 5);
    }
  }

  /** Clicks towards `point` and reports whether the view moved (i.e. the player wasn't blocked). */
  private async step(point: Point): Promise<boolean> {
    const before = viewSignature(this.frame);
    await this.click(point, this.delay('attackClick'));
    await this.sleep(this.delay('runStep'));
    this.capture();
    return signatureDifference(before, viewSignature(this.frame)) >= MOVED_THRESHOLD;
  }

  // ---- Exploring ----

  /**
   * Shows or hides the big map (B toggles it) and returns its panel when shown.
   * Checks the screen rather than assuming what B did.
   */
  private async setBigMap(open: boolean): Promise<Rect | null> {
    this.capture();
    let panel = findBigMap(this.frame);
    for (let attempt = 0; attempt < 3 && !!panel !== open; attempt++) {
      this.key(win.VK.B);
      await this.sleep(BIG_MAP_DELAY_MS);
      this.capture();
      panel = findBigMap(this.frame);
    }
    if (!!panel !== open) throw new BotError(open ? 'Could not open the big map (B).' : 'Could not close the big map (B).');
    return panel;
  }

  /** Runs Explore, starting it again after an error if auto-restart is on. Stop always stops it. */
  private async exploreWithRestarts(): Promise<string> {
    while (true) {
      try {
        // With the memory reader the map comes straight from the game; without it, from the big map on screen.
        return await (this.options.memory.installed ? this.memoryExploreLoop() : this.exploreLoop());
      } catch (error) {
        if (error instanceof Stopped || !this.settings.exploreAutoRestart) throw error;
        this.stopRunning();
        const reason = error instanceof Error ? error.message : String(error);
        this.status(`Explore stopped (${reason}); restarting in ${RESTART_DELAY_MS / 1000} s`);
        await this.sleep(RESTART_DELAY_MS);
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
        this.status(`${error.message} Trying again...`);
        await this.sleep(MAP_RETRY_MS);
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
    let progress = { at: performance.now(), self: null as Point | null };
    // When the bot last steered: time paused, or busy reopening the map, isn't time spent stuck.
    let steeredAt = 0;
    let noRoute = 0;
    let noEdgesSince: number | null = null;

    while (true) {
      await this.yieldToEvents();
      this.capture();
      this.hp = readBar(this.frame, PLAYER_HP_BAR, playerHpFill, PLAYER_BAR_TEXT);
      this.mp = readBar(this.frame, PLAYER_MP_BAR, playerMpFill, PLAYER_BAR_TEXT);
      this.drinkPotions();

      let panel = findBigMap(this.frame);
      if (!panel) {
        // Not open yet, or something closed it (a key press, a teleport): open it again.
        this.stopRunning();
        panel = await this.openBigMapPersistently();
        continue;
      }

      const map = readBigMap(this.frame, panel);
      if (this.explored !== null && map.explored < this.explored - NEW_MAP_DROP) {
        // A different map: what was learned about the last one no longer applies.
        this.planner.reset();
        this.skipped = [];
        this.stuckAt = [];
        this.status('New map; exploring it from scratch');
      }
      this.explored = map.explored;
      const tracked = this.tracker.update(locatePlayer(this.frame, panel, this.tracker.known), performance.now());
      const self = tracked.position;
      if (!self) {
        // Lost for a while: move about (and teleport) until the marker shows again.
        this.statusEvery("Can't see you on the big map; moving to find you");
        const point = this.runPoint(Math.random() * 2 * Math.PI, panel);
        if (point) this.holdRun(point);
        const vk = this.teleportKey();
        if (vk !== null && performance.now() >= this.teleportReadyAt) {
          this.key(vk);
          this.teleportReadyAt = performance.now() + TELEPORT_PRESS_MS;
        }
        await this.sleep(WANDER_MS);
        this.stopRunning();
        continue;
      }
      if (tracked.state === 'remembered') this.statusEvery('Your marker is hidden (under a map icon?); carrying on from where you were');

      const percent = Math.round(map.explored * 100);
      // Done when the target is reached, or when no unexplored edges have been left for a while.
      if (this.planner.openFrontiers(map).length > 0) noEdgesSince = null;
      else noEdgesSince ??= performance.now();
      if (noEdgesSince !== null && performance.now() - noEdgesSince > NO_EDGES_MS) {
        this.stopRunning();
        await this.setBigMap(false);
        return `No unexplored edges left (about ${percent}% uncovered)`;
      }
      if (map.explored * 100 >= this.settings.explorePercent) {
        this.stopRunning();
        await this.setBigMap(false);
        return `Map explored (about ${percent}%)`;
      }
      const now = performance.now();
      if (await this.maybeReroll(map, self, panel)) {
        progress = { at: performance.now(), self: null };
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
          this.status('No route; trying every edge again');
        } else {
          this.statusEvery(`No route right now; looking around (about ${percent}% uncovered)`);
        }
        const angle = Math.random() * 2 * Math.PI;
        const point = this.runPoint(angle, panel);
        if (point) this.holdRun(point);
        if (performance.now() >= this.teleportReadyAt) this.teleport(self, { x: self.x + Math.cos(angle), y: self.y + Math.sin(angle) }, panel);
        await this.sleep(WANDER_MS);
        this.stopRunning();
        continue;
      }
      noRoute = 0;

      // Not getting anywhere for a while: teleport or sidestep, and skip that edge for a bit after a few tries.
      if (!progress.self || now - steeredAt > STUCK_MS || Math.hypot(self.x - progress.self.x, self.y - progress.self.y) >= PROGRESS_PIXELS) {
        progress = { at: now, self };
      } else if (now - progress.at > STUCK_MS) {
        await this.unstick(plan.target, self, plan.waypoint, panel);
        progress = { at: performance.now(), self: null };
        continue;
      }

      this.steer(self, plan.waypoint, panel);
      // Teleport only along a straight stretch: it would overshoot a corner and have to come back.
      if (plan.teleport && performance.now() >= this.teleportReadyAt) this.teleport(self, plan.waypoint, panel);
      await this.sleep(RUN_TICK_MS);
      steeredAt = performance.now();
      this.statusEvery(`Exploring: about ${percent}% uncovered`);
    }
  }

  /**
   * Uncovers the map from the game's memory: its walls and explored blocks
   * (map-grid.ts) and the player's tile. MapExplorer plans a walking route to
   * the nearest unexplored ground; the bot runs (right button held) toward a
   * spot along it, pressing the teleport key on long straight stretches.
   */
  private async memoryExploreLoop(): Promise<string> {
    const memory = this.options.memory;
    memory.start();
    this.exploreLoot = { skipped: new Map(), inReachSince: new Map(), walking: null, nextClickAt: 0 };
    const planner = new MapExplorer();
    const started = performance.now();
    let mapIndex: number | null = null;
    let share = { map: null as MapGrid | null, value: 0 };
    let moved = { at: 0, x: NaN, y: NaN };
    // When the character was last driven: time paused, or waiting for the memory, isn't time spent blocked.
    let drivenAt = 0;

    while (true) {
      await this.yieldToEvents();
      this.capture();
      this.hp = readBar(this.frame, PLAYER_HP_BAR, playerHpFill, PLAYER_BAR_TEXT);
      this.mp = readBar(this.frame, PLAYER_MP_BAR, playerMpFill, PLAYER_BAR_TEXT);
      this.drinkPotions();
      const reading = memory.latest();
      const map = memory.map();
      if (!reading || !map?.explored) {
        this.stopRunning();
        this.statusEvery(
          !reading
            ? performance.now() - started < MEMORY_START_MS ? 'Starting the memory reader' : `Waiting for the game's memory (${memory.problem})`
            : 'Waiting for the map from the game',
        );
        await this.sleep(300);
        continue;
      }
      if (map.index !== mapIndex) {
        if (mapIndex !== null) this.status(`New map (${map.name}); exploring it`);
        mapIndex = map.index;
      }
      // Worked out again only when more has been uncovered (it looks at every tile).
      if (share.map !== map) share = { map, value: exploredShare(map) };
      const percent = Math.round(share.value * 100);
      this.explored = share.value;
      if (percent >= this.settings.explorePercent) {
        this.stopRunning();
        return `${map.name} explored (${percent}%)`;
      }

      const user = reading.user!;
      const now = performance.now();
      if (now - drivenAt > EXPLORE_BLOCKED_MS || this.mountBusyAt > moved.at) moved.at = now;
      // Surrounded, or blocked with monsters about: fight them rather than keep walking into them.
      const stuck = user.x === moved.x && user.y === moved.y && now - moved.at > this.blockedAfterMs();
      if (this.settings.fightInTheWay && (stuck || this.monstersNear(reading, user, 1).length >= 2) && (await this.clearTheWay())) {
        moved = { at: performance.now(), x: NaN, y: NaN };
        drivenAt = performance.now();
        continue;
      }
      if (user.x !== moved.x || user.y !== moved.y) moved = { at: now, x: user.x, y: user.y };
      else if (now - moved.at > this.blockedAfterMs()) {
        // Not moving: something the map doesn't show (monsters, pets) is in the way, or the game never marks this block explored.
        planner.blocked(now + EXPLORE_AVOID_MS);
        moved.at = now;
        this.statusEvery('Blocked; going round');
      }
      // "Pick up items": what's on the ground first.
      if (await this.lootFromMemory(reading, map, now)) {
        moved = { at: performance.now(), x: NaN, y: NaN };
        drivenAt = performance.now();
        continue;
      }
      // Routes keep off monsters close by.
      const plan = planner.plan(map, { x: user.x, y: user.y }, now, this.obstaclesNear(reading, user, STEER_ROUND_TILES).map((m) => ({ x: m.x, y: m.y })));
      if (plan === null) {
        this.stopRunning();
        await this.sleep(300);
        continue;
      }
      if (plan === 'done') {
        this.stopRunning();
        return `Nothing left on ${map.name} that can be walked to (${percent}% uncovered)`;
      }

      await this.driveAlong(user, plan.path, now);
      this.statusEvery(`Exploring ${map.name}: ${percent}% uncovered`);
      await this.sleep(RUN_TICK_MS);
      drivenAt = performance.now();
    }
  }

  /**
   * Gets on (or off) the mount with M when the game's memory says it isn't
   * already. If M changes nothing (no mount, or not allowed on this map), it's
   * left alone for a while rather than pressed over and over.
   */
  private async setMounted(on: boolean): Promise<void> {
    const memory = this.options.memory;
    const reading = memory.latest();
    const mounted = reading?.user?.mounted;
    if (mounted === undefined || mounted === on || performance.now() < this.mountRetryAt) return;
    // No mount equipped (not bought yet, say): nothing to get on.
    if (on && reading?.user?.hasMount === false) return;
    // Mounts aren't allowed on this map (the game's data says so, or M did nothing here before).
    const mapIndex = reading?.map?.index;
    if (on && mapIndex !== undefined && (this.noMountMaps.has(mapIndex) || loadTravelData().maps.find((m) => m.i === mapIndex)?.noHorse)) return;
    try {
      await this.pressMount(on);
    } finally {
      this.mountBusyAt = performance.now();
    }
    if (on && mapIndex !== undefined && memory.latest()?.user?.mounted !== true) this.noMountMaps.add(mapIndex);
  }

  /** Presses M (once the character has stopped) until the game shows the mount as wanted, twice at most. */
  private async pressMount(on: boolean): Promise<void> {
    const memory = this.options.memory;
    this.stopRunning();
    this.releaseHold();
    this.statusEvery(on ? 'Getting on the mount' : 'Getting off the mount');
    for (let attempt = 0; attempt < 2; attempt++) {
      // Pressed mid-step, M is ignored: let the character come to a stop first.
      await this.waitUntilStill();
      // A whole key press: M only works on the key coming back up.
      win.keyDown(this.hwnd, win.VK.M);
      win.keyUp(this.hwnd, win.VK.M);
      for (const since = performance.now(); performance.now() - since < MOUNT_SETTLE_MS; ) {
        if ((await memory.fresh(500))?.user?.mounted === on) return;
      }
    }
    this.mountRetryAt = performance.now() + MOUNT_RETRY_MS;
  }

  /** Waits (up to STILL_WAIT_MS) until the game's memory shows the character on the same tile for STILL_MS. */
  private async waitUntilStill(): Promise<void> {
    const memory = this.options.memory;
    let tile = memory.latest()?.user;
    let since = performance.now();
    for (const started = performance.now(); performance.now() - started < STILL_WAIT_MS; ) {
      const user = (await memory.fresh(500))?.user;
      if (!user) continue;
      if (!tile || user.x !== tile.x || user.y !== tile.y) {
        tile = user;
        since = performance.now();
      } else if (performance.now() - since >= STILL_MS) return;
    }
  }

  /**
   * How long without moving a tile counts as blocked: short while running (it
   * covers ground quickly), longer while stepping by clicks.
   */
  private blockedAfterMs(): number {
    return this.running ? BLOCKED_RUNNING_MS : EXPLORE_BLOCKED_MS;
  }

  /** What stands in the way within `range` tiles: live monsters, other players and NPCs (pets move aside, and follow us). */
  private obstaclesNear(reading: MemoryState, here: Point, range: number): MemoryObject[] {
    const away = (o: MemoryObject) => Math.max(Math.abs(o.x - here.x), Math.abs(o.y - here.y));
    return (reading.objects ?? []).filter(
      (o) => (o.kind === 'monster' || o.kind === 'player' || o.kind === 'npc') && !o.pet && !o.dead && away(o) <= range && away(o) > 0,
    );
  }

  /** Live monsters (not pets) within `range` tiles, nearest first. */
  private monstersNear(reading: MemoryState, here: Point, range: number): MemoryObject[] {
    const away = (o: MemoryObject) => Math.max(Math.abs(o.x - here.x), Math.abs(o.y - here.y));
    return (reading.objects ?? [])
      .filter((o) => o.kind === 'monster' && !o.pet && !o.dead && away(o) <= range)
      .sort((a, b) => away(a) - away(b));
  }

  /**
   * Fights monsters in the way, as Hunt does (clicks and attack keys): the
   * nearest within FIGHT_RANGE_TILES until none is left there. Returns whether
   * there was anything to fight.
   */
  private async clearTheWay(): Promise<boolean> {
    const memory = this.options.memory;
    const started = performance.now();
    const given = new Set<number>();
    let fought = false;
    let current = null as { id: number; since: number } | null;
    while (performance.now() - started < FIGHT_GIVE_UP_MS) {
      await this.yieldToEvents();
      const reading = memory.latest();
      const user = reading?.user;
      if (!reading || !user) break;
      const monster = this.monstersNear(reading, user, FIGHT_RANGE_TILES).find((o) => !given.has(o.id));
      if (!monster) break;
      const now = performance.now();
      if (current?.id !== monster.id) current = { id: monster.id, since: now };
      else if (now - current.since > FIGHT_TARGET_GIVE_UP_MS) {
        given.add(monster.id);
        continue;
      }
      if (!fought) {
        this.stopRunning();
        await this.setMounted(false);
        fought = true;
      }
      this.capture();
      this.hp = readBar(this.frame, PLAYER_HP_BAR, playerHpFill, PLAYER_BAR_TEXT);
      this.mp = readBar(this.frame, PLAYER_MP_BAR, playerMpFill, PLAYER_BAR_TEXT);
      this.drinkPotions();
      const tile = tileToScreen(user, monster.x, monster.y);
      const point = await this.aimAt({ key: `m${monster.id}`, point: tile, name: monster.name, tile });
      if (point) {
        if (this.settings.archer) {
          this.hold(point, `m${monster.id}`);
          await this.sleep(this.delay('attackClick'));
        } else {
          await this.click(point, this.delay('attackClick'));
        }
      }
      await this.pressKeys(true);
      this.statusEvery(`Fighting ${monster.name} in the way`);
    }
    this.releaseHold();
    return fought;
  }

  /**
   * With "Pick up items" on: clicks at the feet while items are within pick-up
   * reach (giving up on any still there after LOOT_GIVE_UP_MS), and walks round
   * the walls to the nearest one up to EXPLORE_LOOT_TILES further off. Returns
   * whether it did anything this tick (so exploring waits).
   */
  private async lootFromMemory(reading: MemoryState, map: MapGrid, now: number): Promise<boolean> {
    if (!this.settings.hunt.loot || !reading.user) return false;
    const loot = this.exploreLoot;
    for (const [key, until] of loot.skipped) if (until <= now) loot.skipped.delete(key);
    const here = { x: reading.user.x, y: reading.user.y };
    const reach = reading.user.pickUpRadius ?? 0;
    const items = this.groundItems(reading, loot.skipped);
    const inReach = items.filter((i) => i.distance <= reach);
    for (const [key, since] of loot.inReachSince) {
      if (!inReach.some((i) => i.key === key)) {
        // Gone from the ground (not just out of reach): picked up, most likely.
        if (!items.some((i) => i.key === key)) this.stats.count('items');
        loot.inReachSince.delete(key);
      } else if (now - since > LOOT_GIVE_UP_MS) {
        loot.skipped.set(key, now + LOOT_SKIP_MS);
        loot.inReachSince.delete(key);
      }
    }
    for (const i of inReach) if (!loot.inReachSince.has(i.key)) loot.inReachSince.set(i.key, now);
    if (loot.inReachSince.size > 0) {
      if (now >= loot.nextClickAt) {
        this.stopRunning();
        await this.clickFloor(FLOOR_CLICKS, FLOOR_CLICK_GAP_MS);
        loot.nextClickAt = performance.now() + ITEM_CLICK_EVERY_MS;
        this.statusEvery(`Picking up ${loot.inReachSince.size} item${loot.inReachSince.size === 1 ? '' : 's'}`);
      } else {
        await this.sleep(50);
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
      const dist = walkDistances(map, here);
      const near = nearestApproach(map, dist, [walk.at]);
      if (!near || near.steps === 0) {
        // Walled off, or as close as it gets.
        loot.skipped.set(walk.key, now + LOOT_SKIP_MS);
        loot.walking = null;
        return false;
      }
      loot.walking.path = pathBack(map, dist, near.tile);
    }
    await this.driveAlong(here, loot.walking.path, now);
    this.statusEvery(`Walking to an item ${walk.distance} tiles away`);
    await this.sleep(RUN_TICK_MS);
    return true;
  }

  /**
   * One tick along `path` (tiles from the player on): runs (right button held)
   * toward the farthest tile straight ahead that isn't under the HUD, steps by
   * clicking where the path turns, and presses the teleport key (if on) on long
   * straight stretches.
   */
  private async driveAlong(user: Point, path: Point[], now: number, mount = true): Promise<void> {
    if (mount) await this.setMounted(true);
    const next = path[1];
    if (!next) return;
    // How much straight path is ahead, from here the way the first step goes.
    const ahead = waypoint(path);
    const straight = Math.max(Math.abs(ahead.x - user.x), Math.abs(ahead.y - user.y));
    // A run moves a whole stride (2 tiles, 3 on a mount) or not at all: with less straight path than that
    // before a turn or a wall, it doesn't go, so step a tile at a time instead.
    const stride = this.options.memory.latest()?.user?.mounted ? 3 : 2;
    // The game moves the way the cursor is from the character, so the cursor goes a few tiles off that way
    // (not on a game window, where holding the button does nothing).
    const dir = { x: Math.sign(next.x - user.x), y: Math.sign(next.y - user.y) };
    const windows = this.options.memory.latest()?.windows ?? [];
    const free = (p: Point) => clickable(p) && !windows.some((w) => p.x >= w.x && p.x < w.x + w.width && p.y >= w.y && p.y < w.y + w.height);
    const toward = (tiles: number) => ({ x: user.x + dir.x * tiles, y: user.y + dir.y * tiles });
    const runTile = toward(RUN_AIM_TILES);
    const point = tileToScreen(user, runTile.x, runTile.y);
    const run = straight >= stride && free(point);
    if (!run) {
      this.stopRunning();
      const stepTile = free(tileToScreen(user, toward(STEP_AIM_TILES).x, toward(STEP_AIM_TILES).y)) ? toward(STEP_AIM_TILES) : next;
      const stepPoint = tileToScreen(user, stepTile.x, stepTile.y);
      this.lastAim = { tile: stepTile, point: stepPoint, running: false };
      await this.click(stepPoint, this.delay('attackClick'));
      return;
    }
    this.lastAim = { tile: runTile, point, running: true };
    this.holdRun(point);
    const vk = this.teleportKey();
    if (vk !== null && straight >= 6 && now >= this.teleportReadyAt) {
      this.key(vk);
      this.teleportReadyAt = now + TELEPORT_PRESS_MS + Math.random() * TELEPORT_JITTER_MS;
    }
  }

  // ---- Travel ----

  /**
   * Goes to a map or an NPC (a place from travel.ts). On each map it plans the
   * quickest chain of links from where the player stands (the links and the
   * steps between them come from game-data/travel.json; the current map's walls
   * from memory), then walks to the next exit. Any map change (expected or not:
   * a wrong turn, a death) plans again from wherever the player is.
   */
  private async travelLoop(placeId: string): Promise<string> {
    return this.travelTo(placeId);
  }

  /** Travel's work, for any mode: returns on arrival (what to say about it), leaving the run going. */
  private async travelTo(placeId: string): Promise<string> {
    const data = loadTravelData();
    const place = findPlace(data, placeId);
    if (!place) throw new BotError('Pick somewhere to travel to first.');
    const memory = this.options.memory;
    if (!memory.installed) throw new BotError('Travel needs the memory reader (run scripts/setup-game-reader.ps1).');
    memory.start();
    const started = performance.now();
    const tile = ([x, y]: [number, number]): Point => ({ x, y });
    const chebyshev = (a: Point, b: Point) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    let route: { map: number; links: TravelLink[]; blocked: number; blockedAt?: Point } | null = null;
    let path: Point[] | null = null;
    /** Tiles to keep off for now (y * width + x), until when: where something the map doesn't show was in the way. */
    const avoid = new Map<number, number>();
    let moved = { at: 0, x: NaN, y: NaN };
    let drivenAt = 0;
    /** Waypoints that turned out not to be in the window (not unlocked), and how many waypoint tries went wrong. */
    const badWaypoints = new Set<string>();
    let waypointFailures = 0;

    while (true) {
      await this.yieldToEvents();
      this.capture();
      this.hp = readBar(this.frame, PLAYER_HP_BAR, playerHpFill, PLAYER_BAR_TEXT);
      this.mp = readBar(this.frame, PLAYER_MP_BAR, playerMpFill, PLAYER_BAR_TEXT);
      this.drinkPotions();
      const reading = memory.latest();
      const map = memory.map();
      if (!reading || !map) {
        this.stopRunning();
        this.statusEvery(
          !reading
            ? performance.now() - started < MEMORY_START_MS ? 'Starting the memory reader' : `Waiting for the game's memory (${memory.problem})`
            : 'Waiting for the map from the game',
        );
        await this.sleep(300);
        continue;
      }
      const user = reading.user!;
      const here = { x: user.x, y: user.y };
      const now = performance.now();

      // A new map (or the first): plan from here.
      if (!route || route.map !== map.index) {
        path = null;
        avoid.clear();
        if (map.index === place.map && !place.npc) {
          this.stopRunning();
          return `Arrived at ${mapName(data, map.index)}`;
        }
        const dist = walkDistances(map, here);
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
        this.status(
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
        if (chebyshev(here, at) <= NPC_REACH_TILES) {
          this.stopRunning();
          const result = await this.useWaypoint(stone.name, at, next.waypoint.name, map.index);
          if (result === 'missing') {
            badWaypoints.add(next.waypoint.name);
            this.status(`The ${next.waypoint.name} waypoint isn't unlocked; finding another way`);
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
          this.stopRunning();
          return `Arrived at ${mapName(data, map.index)}; ${npc.name} wanders about this map`;
        }
        if (chebyshev(here, at) <= NPC_REACH_TILES) {
          this.stopRunning();
          return `Arrived at ${npc.name}`;
        }
        targets = [at];
      }

      // Surrounded, or blocked with monsters about: fight them rather than keep walking into them.
      if (now - drivenAt > EXPLORE_BLOCKED_MS || this.mountBusyAt > moved.at) moved.at = now;
      const stuck = here.x === moved.x && here.y === moved.y && now - moved.at > this.blockedAfterMs();
      if (this.settings.fightInTheWay && (stuck || this.monstersNear(reading, here, 1).length >= 2) && (await this.clearTheWay())) {
        path = null;
        moved = { at: performance.now(), x: NaN, y: NaN };
        drivenAt = performance.now();
        continue;
      }
      // Not moving while trying to: something the map doesn't show is in the way. Time paused doesn't count.
      if (here.x !== moved.x || here.y !== moved.y) moved = { at: now, x: here.x, y: here.y };
      else if (now - moved.at > this.blockedAfterMs()) {
        // Hold-ups with real progress in between are separate: only a run of them without getting anywhere gives up.
        if (route.blockedAt && chebyshev(here, route.blockedAt) > 5) route.blocked = 0;
        route.blockedAt = here;
        if (++route.blocked > TRAVEL_BLOCKED_LIMIT) throw new BotError(`Stuck on ${mapName(data, map.index)} at ${here.x},${here.y}: blocked ${TRAVEL_BLOCKED_LIMIT} times without getting anywhere.`);
        for (const t of (path ?? []).slice(1, 3)) avoid.set(t.y * map.width + t.x, now + EXPLORE_AVOID_MS);
        path = null;
        moved.at = now;
        const aim = this.lastAim;
        this.status(`Blocked at ${here.x},${here.y}${aim ? ` (${aim.running ? 'running' : 'stepping'} to ${aim.tile.x},${aim.tile.y}, screen ${aim.point.x},${aim.point.y})` : ''}; going round`);
      }
      for (const [key, until] of avoid) if (until <= now) avoid.delete(key);

      // Keep to the path while on it (and while no monster stands on the next few tiles); otherwise work out a new one, round them.
      const monsterTiles = new Set(this.obstaclesNear(reading, here, STEER_ROUND_TILES).map((m) => m.y * map.width + m.x));
      const onPath: number = path ? path.findIndex((t) => t.x === here.x && t.y === here.y) : -1;
      path = path && onPath >= 0 ? path.slice(onPath) : null;
      if (path?.slice(1, 5).some((t) => monsterTiles.has(t.y * map.width + t.x))) path = null;
      if (!path || path.length < 2) {
        let dist = walkDistances(map, here, new Set([...avoid.keys(), ...monsterTiles]));
        let near = nearestApproach(map, dist, targets);
        if (!near && avoid.size) {
          avoid.clear();
          dist = walkDistances(map, here);
          near = nearestApproach(map, dist, targets);
        }
        if (!near) throw new BotError(`Can't find a way to walk to ${route.links.length ? `the way to ${mapName(data, route.links[0].to)}` : place.npc!.name} from here.`);
        path = pathBack(map, dist, near.tile);
        // Next to the exit already: step onto it.
        if (path.length < 2) {
          const onto = targets.find((t) => chebyshev(t, here) === 1);
          if (onto) path = [here, onto];
        }
      }
      if (path.length >= 2) await this.driveAlong(here, path, now);
      else this.stopRunning();
      const left = route.links.length;
      this.statusEvery(`Travelling to ${place.label}: ${left ? `${left} map${left === 1 ? '' : 's'} to go` : 'nearly there'}`);
      await this.sleep(RUN_TICK_MS);
      drivenAt = performance.now();
    }
  }

  /** Steps from the player (`dist`, from walkDistances) to each way off this map, by link id. */
  private exitSteps(data: TravelData, map: MapGrid, dist: Int32Array): Map<number, number> {
    const steps = new Map<number, number>();
    for (const l of data.links) {
      if (l.from !== map.index) continue;
      const near = nearestApproach(map, dist, l.exit.map(([x, y]) => ({ x, y })));
      if (near) steps.set(l.id, near.steps);
    }
    return steps;
  }

  // ---- Grinding ----

  /**
   * Levels the character up: picks the best map for their level and class
   * (grind.ts), travels there and hunts, seeking monsters, until it's time to
   * plan again: every so many minutes, on reaching a new level, or on leaving
   * the map (a death, say). Planning again keeps the map while it's still best.
   */
  private async grindLoop(): Promise<string> {
    const data = loadTravelData();
    const memory = this.options.memory;
    if (!memory.installed) throw new BotError('Grind needs the memory reader (run scripts/setup-game-reader.ps1).');
    memory.start();
    const started = performance.now();
    /** The map being ground on, kept unless another is clearly better. */
    let grinding: number | undefined;

    while (true) {
      await this.yieldToEvents();
      // Quest monsters only would leave most of them alone.
      if (this.settings.hunt.questOnly) throw new BotError('Grind hunts every monster: untick Quest monsters only (Hunt) first.');
      const reading = memory.latest();
      const map = memory.map();
      const user = reading?.user;
      if (!reading || !map || !user || user.level === undefined) {
        this.statusEvery(
          !reading
            ? performance.now() - started < MEMORY_START_MS ? 'Starting the memory reader' : `Waiting for the game's memory (${memory.problem})`
            : !map ? 'Waiting for the map from the game' : "Waiting for the character's level",
        );
        await this.sleep(300);
        continue;
      }
      const level = user.level;
      const here = { x: user.x, y: user.y };
      const unlocked = reading.waypoints?.unlocked?.length ? new Set(reading.waypoints.unlocked.map((w) => w.name)) : undefined;
      const { replanMinutes, maxLevelsAbove } = this.settings.grind;
      const start = { map: map.index, steps: this.exitSteps(data, map, walkDistances(map, here)), at: here };
      const choice = chooseGrindMap(data, start, { level, cls: user.class, waypoints: unlocked }, { maxLevelsAbove, current: grinding });
      if (!choice) throw new BotError(`No map to grind on at level ${level} can be reached from ${mapName(data, map.index)}.`);
      grinding = choice.map;
      const plan = describeChoice(choice, level);
      this.status(plan);
      if (map.index !== choice.map) {
        this.status(await this.travelTo(`map:${choice.map}`));
        this.status(plan);
      }

      // Hunt until it's time to plan again (time paused doesn't count).
      const huntStart = performance.now();
      const pausedBefore = this.pausedMs;
      const why = await this.huntLoop({
        seek: true,
        stopWhen: () => {
          const now = memory.latest();
          if (now?.user?.dead) return 'dead';
          if (this.bagFull(now)) return 'bag';
          const newLevel = now?.user?.level;
          if (newLevel !== undefined && newLevel !== level) return `Level ${newLevel}: planning again`;
          if (now?.map && now.map.index !== choice.map) return `Left ${choice.name}: planning again`;
          const minutes = (performance.now() - huntStart - (this.pausedMs - pausedBefore)) / 60_000;
          return minutes >= replanMinutes ? `${replanMinutes} minutes on ${choice.name}: planning again` : null;
        },
      });
      if (why === 'dead') {
        await this.reviveInArcadia();
        continue;
      }
      if (why === 'bag') {
        await this.emptyBag();
        continue;
      }
      this.status(why);
    }
  }

  /** The bag has too few slots free, or is too near its weight limit (the Hunt settings). */
  private bagFull(reading: MemoryState | null | undefined): boolean {
    const bag = reading?.survival?.bag;
    if (!bag || bag.slots <= 0) return false;
    const freeSlots = bag.slots - bag.used;
    const weightPercent = bag.maxWeight > 0 ? (bag.weight / bag.maxWeight) * 100 : 0;
    return freeSlots <= (this.settings.hunt.bagFreeSlots ?? 5) || weightPercent >= (this.settings.hunt.bagWeightPercent ?? 95);
  }

  /** Dead: presses Return on the death window (back to Arcadia, alive) and waits for it. */
  private async reviveInArcadia(): Promise<void> {
    const memory = this.options.memory;
    this.stopRunning();
    this.releaseHold();
    for (const since = performance.now(); performance.now() - since < REVIVE_WAIT_MS; ) {
      await this.yieldToEvents();
      const reading = memory.latest();
      if (reading?.user && !reading.user.dead) {
        this.status('Back on my feet');
        return;
      }
      const button = reading?.survival?.death?.returnButton;
      if (button?.enabled) {
        this.status('Died: returning to Arcadia');
        await this.click(boxCentre(button), this.delay('menu'));
        await this.sleep(1500);
      } else {
        this.statusEvery('Died: waiting for the death window');
        await this.sleep(300);
      }
    }
    throw new BotError("Died, and couldn't get back on my feet.");
  }

  /** Presses Return to Arcadia (out of combat) and waits to arrive; tries a few times. */
  private async returnToArcadia(why: string): Promise<void> {
    const memory = this.options.memory;
    this.stopRunning();
    this.releaseHold();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (memory.latest()?.map?.index === ARCADIA_MAP) return;
      const button = memory.latest()?.survival?.arcadia;
      if (button?.enabled) {
        this.status(`${why}: returning to Arcadia`);
        await this.click(boxCentre(button), this.delay('menu'));
      } else {
        this.statusEvery(`${why}: waiting for Return to Arcadia`);
      }
      for (const since = performance.now(); performance.now() - since < ARCADIA_WAIT_MS; ) {
        await this.yieldToEvents();
        if (memory.latest()?.map?.index === ARCADIA_MAP) return;
        await this.sleep(300);
      }
    }
    throw new BotError(`${why}, but Return to Arcadia didn't take me there (in combat?).`);
  }

  // ---- Quests ----

  /**
   * Does quests: hands in the ones that are finished, picks up more for the
   * character's level (from the NPCs that give them, while fewer than the
   * setting are on the go), then works on what it has: places to go, people
   * to talk to, and monsters to kill (on the map the quest names, else where
   * they spawn). Deaths and a full bag are dealt with as in Grind.
   */
  private async questLoop(): Promise<string> {
    const data = loadTravelData();
    const memory = this.options.memory;
    if (!memory.installed) throw new BotError('Quests needs the memory reader (run scripts/setup-game-reader.ps1).');
    memory.start();
    const started = performance.now();
    const keyOf = (q: TravelQuest) => q.key ?? q.name;
    const quests = data.quests ?? [];
    const byKey = new Map(quests.map((q) => [keyOf(q), q]));
    const byId = new Map(quests.map((q) => [q.id, q]));
    const doable = new Set(['KillMonster', 'GainItem', 'Region', 'TalkToNPC']);
    /** Things that didn't work this run (an NPC whose quests wouldn't open, a quest that wouldn't hand in, a spot out of reach). */
    const failed = new Set<string>();
    let handedIn = 0;
    let accepted = 0;

    while (true) {
      await this.yieldToEvents();
      const reading = memory.latest();
      const log = reading?.questLog;
      const user = reading?.user;
      if (!reading || !log || !user || user.level === undefined || !memory.map()) {
        this.statusEvery(!reading ? (performance.now() - started < MEMORY_START_MS ? 'Starting the memory reader' : `Waiting for the game's memory (${memory.problem})`) : 'Waiting for the quest log');
        await this.sleep(300);
        continue;
      }
      if (user.dead) {
        await this.reviveInArcadia();
        continue;
      }
      if (this.bagFull(reading)) {
        await this.emptyBag();
        continue;
      }
      const inLog = new Set(log.map((q) => q.name));
      const done = new Set(log.filter((q) => q.completed).map((q) => q.name));

      // 1. Hand in what's finished.
      const ready = log.filter((q) => q.ready && byKey.has(q.name) && !failed.has(`hand:${q.name}`)).map((q) => byKey.get(q.name)!);
      if (ready.length) {
        const npc = ready[0].finish;
        const names = ready.filter((q) => q.finish === npc).map((q) => q.name);
        const n = await this.atQuestNpc(npc, 'handIn', `Handing in ${names.join(', ')}`);
        if (n > 0) handedIn += n;
        else for (const q of ready.filter((r) => r.finish === npc)) failed.add(`hand:${keyOf(q)}`);
        continue;
      }

      // 2. Pick up more, while few are on the go.
      const active = log.filter((q) => !q.completed && !q.ready).length;
      const available = quests.filter(
        (q) =>
          !inLog.has(keyOf(q)) && !failed.has(`accept:${q.start}`) && q.type !== 'Account' && (q.level ?? 0) <= user.level! &&
          (q.cls === undefined || (user.class !== undefined && (q.cls & classFlagOf(user.class)) !== 0)) &&
          (q.after ?? []).every((id) => { const before = byId.get(id); return !before || done.has(keyOf(before)); }) &&
          q.tasks.length > 0 && q.tasks.every((t) => doable.has(t.type)),
      );
      if (active < (this.settings.questMaxActive ?? 5) && available.length) {
        // The giver with the most to offer; one on this map first.
        const count = new Map<number, number>();
        for (const q of available) count.set(q.start, (count.get(q.start) ?? 0) + 1);
        const here = memory.map()!.index;
        const npc = [...count.keys()].sort((a, b) => Number(data.npcs.find((n) => n.id === b)?.map === here) - Number(data.npcs.find((n) => n.id === a)?.map === here) || count.get(b)! - count.get(a)!)[0];
        const names = available.filter((q) => q.start === npc).map((q) => q.name);
        const n = await this.atQuestNpc(npc, 'accept', `Picking up ${names.slice(0, 3).join(', ')}${names.length > 3 ? '...' : ''}`);
        if (n > 0) accepted += n;
        else failed.add(`accept:${npc}`);
        continue;
      }

      // 3. Places to go, and people to talk to.
      const pending = reading.questPending;
      const go = pending?.regions.find((r) => !failed.has(`region:${r.region}`) && data.questRegions?.[r.region]);
      if (go) {
        const [map, x, y] = data.questRegions![go.region];
        this.status(`${go.quest}: going to ${mapName(data, map)}`);
        try {
          this.status(await this.travelTo(`spot:${map}:${x}:${y}`));
          await this.sleep(1500);
        } catch (error) {
          if (error instanceof Stopped) throw error;
          failed.add(`region:${go.region}`);
        }
        // Still pending after getting there: don't keep coming back to it.
        if (memory.latest()?.questPending?.regions.some((r) => r.region === go.region)) failed.add(`region:${go.region}`);
        continue;
      }
      const talk = pending?.talks.find((t) => !failed.has(`talk:${t.npc}`) && data.npcs.some((n) => n.id === t.npc));
      if (talk) {
        await this.talkTo(talk.npc, `${talk.quest}: talking to ${data.npcs.find((n) => n.id === talk.npc)!.name}`);
        if (memory.latest()?.questPending?.talks.some((t) => t.npc === talk.npc)) failed.add(`talk:${talk.npc}`);
        continue;
      }

      // 4. Monsters to kill: on the map the quest names, else the nearest map they spawn on.
      const target = (reading.questTargets ?? []).find((t) => !failed.has(`hunt:${t.name}:${t.map}`));
      if (target) {
        const map = target.map ?? this.spawnMapFor(data, target.name, memory.map()!.index, user.level);
        if (map === null) {
          failed.add(`hunt:${target.name}:${target.map}`);
          continue;
        }
        if (memory.map()!.index !== map) this.status(await this.travelTo(`map:${map}`));
        this.status(`${target.quest}: hunting ${target.name} on ${mapName(data, map)}`);
        const huntStart = performance.now();
        const why = await this.huntLoop({
          seek: true,
          questOnly: true,
          stopWhen: () => {
            const now = memory.latest();
            if (now?.user?.dead) return 'dead';
            if (this.bagFull(now)) return 'bag';
            if (now?.questLog?.some((q) => q.ready && byKey.has(q.name) && !failed.has(`hand:${q.name}`))) return 'A quest is finished';
            if (!now?.questTargets?.some((t) => t.name === target.name && (t.map === null || t.map === map))) return `Done with ${target.name}`;
            if (now?.map && now.map.index !== map) return 'Left the map';
            return performance.now() - huntStart > 20 * 60_000 ? `20 minutes on ${target.name}; trying something else` : null;
          },
        });
        if (why.startsWith('20 minutes')) failed.add(`hunt:${target.name}:${target.map}`);
        if (why === 'dead') await this.reviveInArcadia();
        else if (why === 'bag') await this.emptyBag();
        else this.status(why);
        continue;
      }

      this.stopRunning();
      return `Quests: handed in ${handedIn}, picked up ${accepted}; nothing more to do for now`;
    }
  }

  /** The map nearest by route where `monster` spawns (and the level allows), or null. */
  private spawnMapFor(data: TravelData, monster: string, here: number, level: number): number | null {
    const index = data.monsters?.indexOf(monster) ?? -1;
    if (index < 0 || !data.spawns) return null;
    const maps = Object.entries(data.spawns)
      .filter(([, spots]) => spots.some((s) => data.spawnSets?.[s[3]]?.includes(index)))
      .map(([m]) => Number(m))
      .filter((m) => (data.maps.find((x) => x.i === m)?.level ?? 0) <= level);
    if (maps.includes(here)) return here;
    let best: { map: number; steps: number } | null = null;
    for (const m of maps) {
      const place = findPlace(data, `map:${m}`);
      const route = place && planRoute(data, { map: here, steps: new Map(), at: undefined }, place, { level });
      if (route && (!best || route.steps < best.steps)) best = { map: m, steps: route.steps };
    }
    return best?.map ?? null;
  }

  /**
   * Goes to a quest NPC, opens their quest list (pressing Quests if they show
   * the Talk / Quests menu) and presses Accept All or Hand In. Returns how many
   * quests that took (0 if the list didn't open or the button was off).
   */
  private async atQuestNpc(npcId: number, action: 'accept' | 'handIn', why: string): Promise<number> {
    const memory = this.options.memory;
    const data = loadTravelData();
    const npc = data.npcs.find((n) => n.id === npcId);
    if (!npc) return 0;
    this.status(why);
    try {
      await this.travelTo(`npc:${npcId}`);
    } catch (error) {
      if (error instanceof Stopped) throw error;
      return 0;
    }
    const list = await this.openQuestList(npc.name);
    if (!list) return 0;
    const before = memory.latest()?.questLog?.filter((q) => (action === 'accept' ? true : q.completed)).length ?? 0;
    const button = action === 'accept' ? list.acceptAll : list.handIn;
    if (!button?.enabled) {
      this.key(win.VK.ESCAPE);
      return 0;
    }
    await this.click(boxCentre(button), this.delay('menu'));
    await this.sleep(500);
    // An "are you sure?" or a reward choice: press its Yes / OK.
    const ask = memory.latest()?.survival?.messages?.find((m) => m.buttons.some((b) => /yes|ok|confirm/i.test(b.name)));
    const yes = ask?.buttons.find((b) => /yes|ok|confirm/i.test(b.name));
    if (yes) await this.click(boxCentre(yes), this.delay('menu'));
    // The quest log changes once the server has taken it.
    let after = before;
    for (const since = performance.now(); performance.now() - since < 4000 && after === before; ) {
      await this.sleep(300);
      after = memory.latest()?.questLog?.filter((q) => (action === 'accept' ? true : q.completed)).length ?? before;
    }
    this.key(win.VK.ESCAPE);
    await this.sleep(300);
    return Math.max(0, after - before);
  }

  /** Clicks an NPC (standing next to them) and opens their quest list; null if it didn't open. */
  private async openQuestList(npcName: string): Promise<NonNullable<NonNullable<MemoryState['survival']>['questList']> | null> {
    const memory = this.options.memory;
    const list = () => memory.latest()?.survival?.questList ?? null;
    for (let attempt = 0; attempt < 3 && !list(); attempt++) {
      if (!(await this.clickNpc(npcName))) return null;
      for (const since = performance.now(); performance.now() - since < 3000 && !list(); ) {
        const menu = memory.latest()?.survival?.npcMenu;
        if (menu?.quests?.enabled) {
          await this.click(boxCentre(menu.quests), this.delay('menu'));
          await this.sleep(500);
        }
        await this.sleep(150);
      }
    }
    return list();
  }

  /** Clicks an NPC in view by name (hovering until the game confirms it's under the mouse). */
  private async clickNpc(npcName: string): Promise<boolean> {
    const reading = this.options.memory.latest();
    const npc = reading?.objects?.find((o) => o.kind === 'npc' && o.name === npcName);
    if (!npc || !reading?.user) return false;
    this.stopRunning();
    const tile = tileToScreen(reading.user, npc.x, npc.y);
    const point = (await this.aimAt({ key: `npc${npc.id}`, point: tile, name: npcName, tile })) ?? tile;
    await this.click(point, this.delay('menu'));
    return true;
  }

  /** A quest's "talk to": goes to the NPC, clicks them and presses Talk if they ask. */
  private async talkTo(npcId: number, why: string): Promise<void> {
    const memory = this.options.memory;
    const npc = loadTravelData().npcs.find((n) => n.id === npcId);
    if (!npc) return;
    this.status(why);
    try {
      await this.travelTo(`npc:${npcId}`);
    } catch (error) {
      if (error instanceof Stopped) throw error;
      return;
    }
    if (!(await this.clickNpc(npc.name))) return;
    await this.sleep(800);
    const menu = memory.latest()?.survival?.npcMenu;
    if (menu?.talk?.enabled) await this.click(boxCentre(menu.talk), this.delay('menu'));
    await this.sleep(1500);
    this.key(win.VK.ESCAPE);
    await this.sleep(300);
  }

  /** Bag full: back to Arcadia, over to Ludvik, and sell what he'll take from the Main bag tab. */
  private async emptyBag(): Promise<void> {
    await this.returnToArcadia('Bag full');
    await this.travelTo(`npc:${SELL_NPC.id}`);
    const sold = await this.sellAtShop(SELL_NPC.name);
    if (this.bagFull(this.options.memory.latest())) throw new BotError(`Sold ${sold} items, but the bag is still full (the rest are kept or can't be sold).`);
    this.status(`Sold ${sold} items; back to it`);
  }

  /**
   * At a shopkeeper: clicks them to open the shop, makes sure the bag shows its
   * Main tab (so Select All never picks potions), presses Select All then Sell
   * (and Yes on any "are you sure?"), and closes the shop. Returns how many bag
   * slots it emptied.
   */
  private async sellAtShop(npcName: string): Promise<number> {
    const memory = this.options.memory;
    const sellPanel = () => memory.latest()?.survival?.sell;
    const waitFor = async (ok: () => boolean, ms: number) => {
      for (const since = performance.now(); performance.now() - since < ms; ) {
        if (ok()) return true;
        await this.sleep(100);
      }
      return ok();
    };
    this.stopRunning();
    for (let attempt = 0; attempt < 3 && !sellPanel(); attempt++) {
      const reading = memory.latest();
      const npc = reading?.objects?.find((o) => o.kind === 'npc' && o.name === npcName);
      if (!npc || !reading?.user) throw new BotError(`Can't see ${npcName} to sell to.`);
      const tile = tileToScreen(reading.user, npc.x, npc.y);
      const point = (await this.aimAt({ key: `npc${npc.id}`, point: tile, name: npcName, tile })) ?? tile;
      this.status(`Opening ${npcName}'s shop`);
      await this.click(point, this.delay('menu'));
      await waitFor(() => !!sellPanel(), 3000);
    }
    if (!sellPanel()) throw new BotError(`${npcName}'s shop didn't open.`);
    const before = memory.latest()?.survival?.bag?.used ?? 0;

    // The Main tab only: Select All takes from the open tab, and potions live in Consumables.
    const inventory = memory.latest()?.survival?.inventory;
    if (inventory && inventory.section !== 0 && inventory.mainTab) {
      await this.click(boxCentre(inventory.mainTab), this.delay('menu'));
      await waitFor(() => memory.latest()?.survival?.inventory?.section === 0, 2000);
    }
    if (memory.latest()?.survival?.inventory?.section !== 0) throw new BotError("Couldn't switch the bag to its Main tab to sell from.");

    const selectAll = sellPanel()?.selectAll;
    if (!selectAll?.enabled) throw new BotError("The shop's Select All button isn't there.");
    await this.click(boxCentre(selectAll), this.delay('menu'));
    if (!(await waitFor(() => !!sellPanel()?.sell?.enabled, 2000))) {
      await this.closeShop();
      return 0;
    }
    this.status(`Selling (${sellPanel()?.value ?? '?'} gold)`);
    await this.click(boxCentre(sellPanel()!.sell!), this.delay('menu'));
    // An "are you sure?": press its Yes / OK.
    await this.sleep(500);
    const ask = memory.latest()?.survival?.messages?.find((m) => m.buttons.some((b) => /yes|ok|confirm/i.test(b.name)));
    const yes = ask?.buttons.find((b) => /yes|ok|confirm/i.test(b.name));
    if (yes) await this.click(boxCentre(yes), this.delay('menu'));
    await waitFor(() => (memory.latest()?.survival?.bag?.used ?? before) < before, 3000);
    const after = memory.latest()?.survival?.bag?.used ?? before;
    await this.closeShop();
    return Math.max(0, before - after);
  }

  /** Closes the shop: its close button, else Escape. */
  private async closeShop(): Promise<void> {
    const close = this.options.memory.latest()?.survival?.sell?.close;
    if (close?.enabled && close.width > 0) await this.click(boxCentre(close), this.delay('menu'));
    else this.key(win.VK.ESCAPE);
    await this.sleep(300);
  }

  /**
   * At a waypoint stone: clicks it to open the waypoint window, finds the
   * waypoint (scrolling the list if need be) and presses its Activate button,
   * then waits for the teleport. 'missing' when the window doesn't list it.
   */
  private async useWaypoint(stoneName: string, stone: Point, name: string, fromMap: number): Promise<'teleported' | 'missing' | 'failed'> {
    const memory = this.options.memory;
    const user = () => memory.latest()?.user;
    // Open the window, unless it already is.
    for (let attempt = 0; attempt < 2 && !memory.latest()?.waypoints?.open; attempt++) {
      const me = user();
      if (!me) return 'failed';
      const tileAt = tileToScreen(me, stone.x, stone.y);
      const point = (await this.aimAt({ key: `stone${stone.x},${stone.y}`, point: tileAt, name: stoneName, tile: tileAt })) ?? tileAt;
      this.status(`Opening the waypoints at the ${stoneName}`);
      await this.click(point, this.delay('menu'));
      for (const since = performance.now(); performance.now() - since < WAYPOINT_OPEN_MS && !memory.latest()?.waypoints?.open; ) await this.sleep(100);
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
        this.status(`Waypoint to ${name}`);
        await this.click(boxCentre(row.activate), this.delay('menu'));
        for (const since = performance.now(); performance.now() - since < WAYPOINT_TELEPORT_MS; ) {
          await this.sleep(200);
          const map = memory.latest()?.map;
          if (map && map.index !== fromMap) return 'teleported';
        }
        return 'failed';
      }
      if (window.unlocked.length && !window.unlocked.some((w) => w.name === name)) return 'missing';
      const first = window.rows[0].activate;
      const before = window.scroll?.value ?? 0;
      if (!scrolledToTop) {
        win.mouseWheel(this.hwnd, first.x - 200, first.y + 60, -50);
        scrolledToTop = true;
      } else {
        if (window.scroll && window.scroll.value >= window.scroll.max - window.rows.length) return 'missing';
        win.mouseWheel(this.hwnd, first.x - 200, first.y + 60, 2);
      }
      await this.sleep(150);
      if (scrolledToTop && tries > 0 && (await memory.fresh())?.waypoints?.scroll?.value === before) return 'missing';
    }
    return 'missing';
  }

  /**
   * Uses the free random teleport (to anywhere explored) when the walk to
   * unexplored ground from here is long compared with from most explored spots.
   * Returns true if it pressed it (whether or not the game teleported).
   */
  private async maybeReroll(map: BigMapReading, self: Point, panel: Rect): Promise<boolean> {
    const vk = keyCode(this.settings.hunt.randomTeleportKey);
    const now = performance.now();
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

    this.stopRunning();
    this.key(vk);
    await this.sleep(REROLL_SETTLE_MS);
    this.capture();
    // Look for the marker afresh: pets may still be standing where the player was.
    const landed = locatePlayer(this.frame, panel, null);
    if (landed && Math.hypot(landed.x - self.x, landed.y - self.y) >= REROLL_JUMP) {
      this.tracker.reset();
      this.tracker.update(landed, performance.now());
      this.planner.teleported();
      this.rerollsInRow++;
      this.status('Random teleport: far from unexplored ground, trying another spot');
    } else {
      // Nothing happened: probably not unlocked yet (my estimate can run a little ahead of the game's).
      this.rerollPausedUntil = performance.now() + REROLL_LOCKED_MS;
      this.status('Random teleport did nothing (not unlocked yet?); trying again later');
    }
    return true;
  }

  /** Holds the right button (run) towards where `to` is from `from` on the big map. */
  private steer(from: Point, to: Point, panel: Rect, turn = 0): void {
    // The big map keeps the world's proportions, so its directions are screen directions.
    const angle = Math.atan2(to.y - from.y, to.x - from.x) + turn;
    const point = this.runPoint(angle, panel);
    if (point) this.holdRun(point);
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
    const vk = this.teleportKey();
    if (vk === null) return;
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const point = this.runPoint(angle, panel);
    if (point) {
      if (this.running) this.holdRun(point);
      else win.mouseMove(this.hwnd, point.x, point.y);
    }
    this.key(vk);
    // A little random extra, so presses don't land on an exact rhythm.
    this.teleportReadyAt = performance.now() + TELEPORT_PRESS_MS + Math.random() * TELEPORT_JITTER_MS;
  }

  /** The teleport key, unless it's turned off (not every character has a teleport) or set to none. */
  private teleportKey(): number | null {
    return this.settings.exploreTeleport === false ? null : keyCode(this.settings.hunt.unstuckKey);
  }

  private holdRun(point: Point): void {
    if (this.running) win.mouseMove(this.hwnd, point.x, point.y, win.MK_RBUTTON);
    else {
      // The game takes where the cursor is from mouse moves, not from the button press itself.
      win.mouseMove(this.hwnd, point.x, point.y);
      win.rightDown(this.hwnd, point.x, point.y);
    }
    this.running = point;
  }

  private stopRunning(): void {
    if (!this.running) return;
    win.rightUp(this.hwnd, this.running.x, this.running.y);
    this.running = null;
  }

  /** Stuck on something (often pets or monsters): teleport or run sideways, and skip this edge for a while if it keeps happening. */
  private async unstick(target: Point, self: Point, waypoint: Point, panel: Rect): Promise<void> {
    const key = this.stuckAt.find((s) => Math.hypot(s.point.x - target.x, s.point.y - target.y) < UNREACHABLE_RADIUS);
    if (key) key.count++;
    else this.stuckAt.push({ point: target, count: 1 });
    const tries = key?.count ?? 1;
    if (tries >= STUCK_TRIES) {
      // Usually monsters in the way; the pets will deal with them, so try again later.
      this.skipped.push({ point: target, until: performance.now() + SKIP_EDGE_MS });
      this.stuckAt = this.stuckAt.filter((s) => s !== key);
      this.status('Blocked; trying another edge for now');
      return;
    }

    // Alternate: teleport (gets past pets and monsters), then step aside, then teleport again...
    if (this.teleportKey() !== null && tries % 2 === 1) {
      // A teleport towards the cursor gets past whatever is in the way (usually monsters).
      this.status('Stuck; teleporting');
      this.stopRunning();
      this.teleport(self, waypoint, panel);
      await this.sleep(TELEPORT_MS);
      return;
    }

    this.status('Stuck; stepping aside');
    this.steer(self, waypoint, panel, (Math.random() < 0.5 ? 1 : -1) * Math.PI / 2);
    await this.sleep(SIDESTEP_MS);
  }

  // ---- Triple Triad ----

  /**
   * Plays Triple Triad matches as they come up: waits for the panel, plays
   * each of my turns with the best move it can find, and presses OK at the
   * end. Matches are started by the player, at the card NPC.
   */
  private async triadLoop(): Promise<string> {
    const memory = this.options.triad;
    let matches = 0;
    let wasOver = false;
    let match: TriadMatch | null = null;
    // The game's memory has every card's numbers and whose turn it is; the screen is the fallback.
    this.options.memory.start();
    const started = performance.now();
    // When the reader last gave a reading: a moment's gap mid-match is waited out, not played from the screen.
    let heardAt = started;
    let okPressed = false;
    // The match's last reading with the board: the result box can come up with the board already gone.
    // Cleared once the result is counted, so each match counts once.
    let lastBoard: MemoryTriad | null = null;
    while (true) {
      await this.yieldToEvents();
      if (this.options.memory.latest()) heardAt = performance.now();
      const live = this.options.memory.latest()?.triad;
      if (live?.ok) {
        if (!okPressed) matches++;
        okPressed = true;
        if (lastBoard) {
          this.stats.countMatch(matchResult(live) ?? matchResult(lastBoard));
          lastBoard = null;
        }
        this.status('Game over; pressing OK');
        await this.click(boxCentre(live.ok), this.delay('menu'));
        await this.sleep(TRIAD_SETTLE_MS);
        continue;
      }
      okPressed = false;
      if (live?.open) {
        // Not a finished match still showing after its OK: that one has been counted.
        if (live.board && (lastBoard || !live.complete)) lastBoard = live;
        await this.triadTurnFromMemory(live);
        continue;
      }
      if (this.options.memory.latest()) {
        this.statusEvery(matches ? `Played ${matches} game${matches === 1 ? '' : 's'}; waiting for the next one` : 'Waiting for a Triple Triad match (start one at the card NPC)');
        await this.sleep(TRIAD_POLL_MS);
        continue;
      }
      if (this.options.memory.installed && performance.now() - heardAt < MEMORY_START_MS) {
        this.statusEvery(heardAt === started ? 'Starting the memory reader' : "Waiting for the game's memory");
        await this.sleep(TRIAD_POLL_MS);
        continue;
      }

      // No memory reader: read the screen.
      this.capture();
      const screen = readTriad(this.frame);
      if (!screen.open) {
        wasOver = false;
        match = null;
        this.statusEvery(matches ? `Played ${matches} match${matches === 1 ? '' : 'es'}; waiting for the next one` : 'Waiting for a Triple Triad match (start one at the card NPC)');
        await this.sleep(TRIAD_IDLE_MS);
        continue;
      }
      if (screen.over) {
        if (!wasOver) {
          matches++;
          // The screen doesn't say who won: count it as played only.
          this.stats.countMatch(null);
          // She always plays the same cards: remember the ones she played.
          if (match) memory.remember(match.opponent, [...match.hers.values()]);
          match = null;
        }
        wasOver = true;
        this.status('Match over; pressing OK');
        await this.click(TRIAD_OK, this.delay('menu'));
        await this.sleep(TRIAD_SETTLE_MS);
        continue;
      }
      wasOver = false;
      const fresh = screen.hand.length === 5 && screen.board.every((cell) => !cell);
      if (!match || (fresh && match.mine.size > 0)) {
        // Cards already down when the bot joins a match are of unknown origin.
        const before = screen.board.flatMap((cell, i) => (cell ? [i] : []));
        match = { opponent: screen.opponent, mine: new Map(), hers: new Map(), unknown: new Set(before), learned: new Set() };
      }
      if (!screen.myTurn) {
        // Keep the mouse off the cards: a card's tooltip can cover the "Your turn" text.
        win.mouseMove(this.hwnd, TRIAD_PARK.x, TRIAD_PARK.y);
        this.statusEvery("Opponent's turn");
        await this.sleep(TRIAD_POLL_MS);
        continue;
      }

      // Only act on a settled screen: cards slide into place after each move.
      await this.sleep(TRIAD_POLL_MS);
      this.capture();
      const again = readTriad(this.frame, memory.reader);
      if (!again.myTurn || !sameTriadLayout(screen, again)) continue;
      this.learnFromBoard(again, match);

      const decision = decideTriad(again, { mine: new Set(match.mine.keys()), herDeck: memory.deckOf(match.opponent) });
      if (decision.kind === 'wait') {
        this.statusEvery(decision.reason);
        continue;
      }
      const outlook = decision.expected > 0 ? `should win by ${decision.expected}` : decision.expected < 0 ? `likely to lose by ${-decision.expected}` : 'heading for a draw';
      this.status(`${decision.summary} (${outlook}${decision.guessed ? '; some of her cards are guesses' : ''})`);
      const played = cardOf(again.hand[decision.handIndex]);
      await this.click(centre(HAND_SLOTS[decision.handIndex]), this.delay('menu'));
      await this.sleep(TRIAD_CLICK_GAP_MS);
      await this.click(cellCentre(decision.cell), this.delay('menu'));
      // Move off the card just played, or its tooltip covers the board and the turn text.
      win.mouseMove(this.hwnd, TRIAD_PARK.x, TRIAD_PARK.y);
      await this.sleep(TRIAD_SETTLE_MS);

      // Check the card went down before counting it as played.
      this.capture();
      const after = readTriad(this.frame);
      if (after.board[decision.cell] || after.over || !after.open) match.mine.set(decision.cell, played);
      else this.status('The card did not go down; trying again');
    }
  }

  /** Rests the mouse just below the board, off every card (a card's tooltip can cover the board). */
  private parkOffCards(live: MemoryTriad): void {
    const bottom = live.squares?.[7];
    const at = bottom ? { x: bottom.x + Math.round(bottom.width / 2), y: bottom.y + bottom.height + 30 } : TRIAD_PARK;
    win.mouseMove(this.hwnd, at.x, at.y);
  }

  /** One look at a match through the game's memory: plays my move if it's my turn. */
  private async triadTurnFromMemory(live: MemoryTriad): Promise<void> {
    if (live.rules !== undefined) this.triadRules = live.rules;
    if (!live.players || !live.board) {
      this.statusEvery('Waiting for the game to start');
      await this.sleep(TRIAD_POLL_MS);
      return;
    }
    if (!myTurnInMemory(live)) {
      this.parkOffCards(live);
      this.statusEvery(live.complete ? 'Game over' : "Opponent's turn (game memory)");
      await this.sleep(TRIAD_POLL_MS);
      return;
    }
    const { decision, card } = decideFromMemory(live);
    if (decision.kind === 'wait' || !card) {
      this.statusEvery(decision.kind === 'wait' ? decision.reason : 'No move');
      await this.sleep(TRIAD_POLL_MS);
      return;
    }
    const outlook = decision.expected > 0 ? `should win by ${decision.expected}` : decision.expected < 0 ? `likely to lose by ${-decision.expected}` : 'heading for a draw';
    this.status(`${decision.summary} (${outlook}, game memory)`);
    const square = live.squares?.[decision.cell];
    await this.click(boxCentre(live.hand![decision.handIndex]), this.delay('menu'));
    await this.sleep(TRIAD_CLICK_GAP_MS);
    await this.click(square ? boxCentre(square) : cellCentre(decision.cell), this.delay('menu'));
    this.parkOffCards(live);
    await this.sleep(TRIAD_SETTLE_MS);
    if (!this.options.memory.latest()?.triad?.board?.[decision.cell]) this.status('The card did not go down; trying again');
  }

  /** Learns from the board: how my cards' digits look in their cells, and which cards she has played. */
  private learnFromBoard(screen: TriadScreen, match: TriadMatch): void {
    screen.board.forEach((cell, i) => {
      if (!cell || match.unknown.has(i)) return;
      const mine = match.mine.get(i);
      if (!mine) {
        if (!match.hers.has(i)) match.hers.set(i, cardOf(cell).card);
        return;
      }
      // My card's numbers are known from my hand (where they're always read right).
      if (!mine.unread && !match.learned.has(i)) {
        const { top, left, right, bottom } = mine.card;
        this.options.triad.reader.learnCard(boardSampler(this.frame, i), [top, left, right, bottom]);
        match.learned.add(i);
      }
    });
  }

  // ---- Gathering ----

  /**
   * Gathers plants and ore: walks next to the nearest node on screen (from the
   * game's memory), clicks it and waits until it's picked, then the next. With
   * none in sight it wanders until some come into view. Potions are drunk as
   * when hunting.
   */
  private async gatherLoop(): Promise<string> {
    const memory = this.options.memory;
    if (!memory.installed) throw new BotError('Gathering needs the memory reader (run scripts/setup-game-reader.ps1).');
    if (!this.settings.gatherPlants && !this.settings.gatherOre) throw new BotError('Tick "Gather plants" and/or "Gather ore" first.');
    memory.start();
    const skipped = new Map<number, number>();
    let current: { id: number; since: number; clickedAt: number | null; retried: boolean } | null = null;
    let gathered = 0;
    const started = performance.now();
    // Running about while looking for nodes: which way, until when, and where the character last moved.
    let wander = { direction: 0, until: 0, tile: { x: NaN, y: NaN }, movedAt: 0 };
    let paused = this.pausedMs;

    while (true) {
      await this.yieldToEvents();
      // Time paused doesn't count towards giving up on a node, or towards being blocked while wandering.
      const pause = this.pausedMs - paused;
      paused = this.pausedMs;
      if (pause > 0) {
        const node = current as { since: number; clickedAt: number | null } | null;
        if (node) {
          node.since += pause;
          if (node.clickedAt !== null) node.clickedAt += pause;
        }
        wander = { ...wander, until: wander.until + pause, movedAt: wander.movedAt + pause };
      }
      this.capture();
      this.hp = readBar(this.frame, PLAYER_HP_BAR, playerHpFill, PLAYER_BAR_TEXT);
      this.mp = readBar(this.frame, PLAYER_MP_BAR, playerMpFill, PLAYER_BAR_TEXT);
      this.drinkPotions();
      const now = performance.now();
      for (const [id, until] of skipped) if (until <= now) skipped.delete(id);

      const reading = memory.latest();
      if (!reading) {
        this.stopRunning();
        this.statusEvery(performance.now() - started < MEMORY_START_MS ? 'Starting the memory reader' : `Waiting for the game's memory (${memory.problem})`);
        await this.sleep(300);
        continue;
      }
      const user = reading.user!;
      const nodes = (reading.objects ?? []).filter(
        (o) => o.kind === 'node' && !o.harvested && !skipped.has(o.id) && (o.mining ? this.settings.gatherOre : this.settings.gatherPlants) && clickable(tileToScreen(user, o.x, o.y)),
      );
      const distance = (o: { x: number; y: number }) => Math.max(Math.abs(o.x - user.x), Math.abs(o.y - user.y));

      // The node being gathered: gone or picked means done.
      let node: MemoryObject | undefined = current ? nodes.find((o) => o.id === current!.id) : undefined;
      if (current && !node) {
        if (current.clickedAt !== null) {
          gathered++;
          this.stats.count('gathered');
        }
        current = null;
      }
      if (!node) {
        node = nodes.reduce<MemoryObject | undefined>((best, o) => (!best || distance(o) < distance(best) ? o : best), undefined);
        if (node) current = { id: node.id, since: now, clickedAt: null, retried: false };
      }
      if (!node || !current) {
        // Run (holding the right button) one way, turning now and then, or when blocked.
        if (user.x !== wander.tile.x || user.y !== wander.tile.y) wander = { ...wander, tile: { x: user.x, y: user.y }, movedAt: now };
        const blocked = this.running && now - wander.movedAt > GATHER_BLOCKED_MS;
        if (now > wander.until || blocked) {
          // Blocked: turn somewhere other than straight back into the same wall.
          const direction = blocked
            ? (wander.direction + 2 + Math.floor(Math.random() * 5)) % ROAM_DIRECTIONS.length
            : Math.floor(Math.random() * ROAM_DIRECTIONS.length);
          wander = { ...wander, direction, until: now + GATHER_WANDER_MS * (1 + Math.random()), movedAt: now };
        }
        const dir = ROAM_DIRECTIONS[wander.direction];
        const scale = dir.x && dir.y ? ROAM_DISTANCE / Math.SQRT2 : ROAM_DISTANCE;
        this.holdRun({ x: Math.round(PLAYER.x + dir.x * scale), y: Math.round(PLAYER.y + dir.y * scale * 0.75) });
        this.statusEvery(`Looking for something to gather (${gathered} gathered)`);
        await this.sleep(this.delay('runStep'));
        continue;
      }
      wander.until = 0;

      const away = distance(node);
      if (away > 1) {
        if (now - current.since > GATHER_WALK_GIVE_UP_MS) {
          this.stopRunning();
          skipped.set(node.id, now + GATHER_SKIP_MS);
          this.status(`Couldn't reach the ${node.name}; trying another`);
          current = null;
          continue;
        }
        // Head for the tile next to it, on this side.
        const next = { x: node.x - Math.sign(node.x - user.x), y: node.y - Math.sign(node.y - user.y) };
        const point = tileToScreen(user, next.x, next.y);
        if (away > GATHER_RUN_TILES) this.holdRun(point);
        else {
          this.stopRunning();
          await this.click(point, this.delay('attackClick'));
        }
        this.statusEvery(`Walking to a ${node.name} ${away} tiles away (${gathered} gathered)`);
        await this.sleep(this.delay('runStep'));
        continue;
      }

      this.stopRunning();
      const { clickedAt } = current;
      if (clickedAt !== null && now - clickedAt > GATHER_PICK_GIVE_UP_MS) {
        skipped.set(node.id, now + GATHER_SKIP_MS);
        this.status(`The ${node.name} won't gather (profession level too low, or the wrong tool?); trying another`);
        current = null;
        continue;
      }
      // Click it, and once more if nothing has happened halfway to giving up.
      if (clickedAt === null || (!current.retried && now - clickedAt > GATHER_PICK_GIVE_UP_MS / 2)) {
        const tile = tileToScreen(user, node.x, node.y);
        // Click where the game says the node is under the mouse, else the middle of its tile.
        await this.setMounted(false);
        const point = (await this.aimAt({ key: `n${node.id}`, point: tile, name: node.name, tile })) ?? tile;
        await this.click(point, this.delay('attackClick'));
        if (clickedAt === null) current.clickedAt = performance.now();
        else current.retried = true;
      }
      this.statusEvery(`Gathering a ${node.name} (${gathered} gathered)`);
      await this.sleep(300);
    }
  }

  // ---- Triple Triad deck ----

  /**
   * Puts the best five cards owned into the deck, through the card collection
   * window: for each slot to change, click the slot, then the card (on its
   * level's tab), then "Replace Slot N"; finally "Save Deck".
   */
  private async deckLoop(): Promise<string> {
    const memory = this.options.memory;
    if (!memory.installed) throw new BotError('Building a deck needs the memory reader (run scripts/setup-game-reader.ps1).');
    memory.start();
    let collection: MemoryCollection | null | undefined = null;
    for (const since = performance.now(); !collection; ) {
      await this.sleep(300);
      collection = memory.latest()?.collection;
      if (collection?.error) throw new BotError(`Couldn't read the card collection: ${collection.error}`);
      if (!collection) this.statusEvery(memory.latest() ? 'Open the Triple Triad card collection window' : 'Starting the memory reader');
      if (!collection && performance.now() - since > 120_000) throw new BotError('The card collection window never opened.');
    }

    let allowCopies = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      this.status('Working out the best deck (trying combinations against random decks)...');
      await new Promise((resolve) => setTimeout(resolve, 50));
      const { owned, pool } = deckInputs(collection, allowCopies);
      const choice = chooseDeck(owned, pool, 1, rulesFromFlags(this.triadRules));
      if (!choice) throw new BotError('Not enough cards owned to make a deck of five.');
      const nameOf = (id: number) => owned.find((o) => o.id === id)?.name ?? `card ${id}`;
      const summary = `${choice.deck.map(nameOf).join(', ')} (won ${Math.round(choice.winRate * 100)}% of test games)`;

      // Keep the slots already holding a wanted card; fill the others.
      const draft = collection.draft;
      const wanted = [...choice.deck];
      const keep = [0, 1, 2, 3, 4].map((slot) => {
        const i = wanted.indexOf(draft[slot]);
        if (i < 0) return false;
        wanted.splice(i, 1);
        return true;
      });
      const changes = [0, 1, 2, 3, 4].flatMap((slot) => (keep[slot] ? [] : [{ slot, id: wanted.shift()! }]));
      if (changes.length === 0 && !collection.dirty) return `Your deck is already the best: ${summary}`;

      let failed: string | null = null;
      for (const { slot, id } of changes) {
        this.status(`Putting ${nameOf(id)} in slot ${slot + 1}`);
        failed = await this.replaceDeckSlot(slot, id, nameOf(id));
        if (failed) break;
      }
      if (failed) {
        const current = (await memory.fresh())?.collection;
        if (current?.undo.enabled) await this.click(boxCentre(current.undo), this.delay('menu'));
        // The game may not allow two of the same card: try again without copies.
        if (allowCopies && new Set(choice.deck).size < choice.deck.length) {
          allowCopies = false;
          collection = (await memory.fresh())?.collection ?? collection;
          continue;
        }
        throw new BotError(failed);
      }

      const before = (await memory.fresh())?.collection;
      if (before?.save.enabled) {
        await this.click(boxCentre(before.save), this.delay('menu'));
        await this.sleep(600);
      }
      const after = (await memory.fresh())?.collection;
      const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b).join();
      const saved = after && sorted(after.saved) === sorted(choice.deck);
      // Counted even if the save didn't show: the slots have changed either way.
      this.stats.count('decks');
      return saved ? `Deck saved: ${summary}` : `Deck set but maybe not saved (press Save Deck): ${summary}`;
    }
    throw new BotError("Couldn't build the deck.");
  }

  /** Puts card `id` into deck slot `slot`; returns what went wrong, or null. */
  private async replaceDeckSlot(slot: number, id: number, name: string): Promise<string | null> {
    const memory = this.options.memory;
    let c = (await memory.fresh())?.collection;
    if (!c) return 'The card collection window closed.';
    await this.click(boxCentre(c.deckSlots[slot]), this.delay('menu'));

    // Open the card's level tab.
    const level = c.cards.find((card) => card.image === id)?.level ?? 1;
    let tab = c.tabs.find((t) => t.level === level);
    if (!tab) return `There's no tab for level ${level} cards.`;
    if (!tab.selected) {
      await this.click(boxCentre(tab.button), this.delay('menu'));
      await this.sleep(300);
    }
    c = (await memory.fresh())?.collection;
    tab = c?.tabs.find((t) => t.level === level);
    if (!c || !tab?.selected) return `Couldn't open the level ${level} tab.`;
    if (c.selectedSlot !== slot) return `Couldn't select deck slot ${slot + 1}.`;
    const where = tab.slots.find((s) => s.image === id && s.shown);
    if (!where) return `Can't see ${name} in the collection: clear the search box and filters.`;
    const point = boxCentre(where);
    const { panel } = tab;
    if (point.y < panel.y || point.y > panel.y + panel.height) return `${name} is scrolled out of view: scroll the collection back to the top.`;

    await this.click(point, this.delay('menu'));
    c = (await memory.fresh())?.collection;
    if (!c || c.detail !== id || !c.action.enabled || !c.action.text?.startsWith('Replace')) {
      return `Picking ${name} didn't offer to replace the slot${c?.feedback ? ` (${c.feedback})` : ''}.`;
    }
    await this.click(boxCentre(c.action), this.delay('menu'));
    await this.sleep(200);
    c = (await memory.fresh())?.collection;
    if (c?.draft[slot] !== id) return `${name} didn't go into slot ${slot + 1}${c?.feedback ? ` (${c.feedback})` : ''}.`;
    return null;
  }

  // ---- Training ----

  /**
   * Casts a spell on the character over and over, to train it: the mouse rests
   * on the character so the spell lands there. Potions are drunk as when hunting.
   */
  private async trainLoop(): Promise<string> {
    const vk = keyCode(this.settings.trainKey);
    if (vk === null) throw new BotError('Choose the spell key to train with first.');
    let casts = 0;
    while (true) {
      await this.yieldToEvents();
      this.capture();
      this.hp = readBar(this.frame, PLAYER_HP_BAR, playerHpFill, PLAYER_BAR_TEXT);
      this.mp = readBar(this.frame, PLAYER_MP_BAR, playerMpFill, PLAYER_BAR_TEXT);
      this.drinkPotions();
      win.mouseMove(this.hwnd, SELF.x, SELF.y);
      this.key(vk);
      casts++;
      this.statusEvery(`Training: ${casts} casts`);
      await this.sleep(Math.max(this.settings.trainIntervalMs, MIN_TRAIN_INTERVAL_MS));
    }
  }

  // ---- Selling ----

  private async sellItems(): Promise<void> {
    // Open the bag, look at it, and close it again.
    this.key(win.VK.W);
    await this.sleep(this.menuPause(200));
    this.capture();
    const full = isBagFull(this.frame);
    this.key(win.VK.W);
    await this.sleep(this.menuPause(200));
    if (!full) return;

    this.status('Selling items');
    // Teleport to town, open the map and walk to the shop.
    this.key(win.VK.N2);
    await this.sleep(this.menuPause(200));
    this.key(win.VK.B);
    await this.sleep(this.menuPause(500));
    const start = this.locate();
    if (start) {
      await this.walk(new Journey(start), start, SHOP_LOCATION, { click: true, stopAtTarget: true, repeatKey: win.VK.N2 });
    }
    this.key(win.VK.B);
    await this.sleep(this.menuPause(200));
    this.key(win.VK.B);
    await this.sleep(this.menuPause(200));

    // Talk to the shopkeeper and sell.
    await this.shopClick({ x: 795, y: 318 }, 200);
    await this.shopClick({ x: 80, y: 89 }, 200);
    for (let i = 0; i < 4; i++) {
      await this.shopClick({ x: 294, y: 526 }, 200);
      await this.shopClick({ x: 457, y: 526 }, 200);
    }
    for (let i = 0; i < 4; i++) {
      this.key(win.VK.ESCAPE);
      await this.sleep(this.menuPause(100));
    }
    await this.shopClick({ x: 695, y: 152 }, 100);
    await this.shopClick({ x: 65, y: 130 }, 100);
    await this.shopClick({ x: 1319, y: 314 }, 100);
    await this.shopClick({ x: 135, y: 103 }, 100);
    this.key(win.VK.B);
    await this.sleep(this.menuPause(100));

    // Autorun back out of town; leaving the map means we've arrived.
    this.key(win.VK.D);
    await this.walkUntilMapChanges(TOWN_EXIT);
    this.key(win.VK.D);
    this.key(win.VK.B);
    this.key(win.VK.B);
  }

  private async shopClick(point: Point, pauseAfter: number): Promise<void> {
    win.mouseMove(this.hwnd, point.x, point.y);
    await this.sleep(this.menuPause(200));
    win.leftDown(this.hwnd, point.x, point.y);
    try {
      await this.sleep(this.menuPause(200));
    } finally {
      win.leftUp(this.hwnd, point.x, point.y);
    }
    await this.sleep(this.menuPause(200 + pauseAfter));
  }

  // ---- Walking by the big map (selling) ----

  private async walkUntilMapChanges(target: Point, start = this.locate()): Promise<void> {
    if (!start) return;

    const journey = new Journey(start);
    let position: Point | null = start;
    while (position) {
      const result = await this.walk(journey, position, target, { click: false, stopAtTarget: false });
      if (result === 'mapChanged') return;
      // Out of tiles to try: start again from wherever we are now.
      await this.sleep(50);
      position = this.locate();
    }
  }

  /** Captures the window and finds the character on the big map; null once it's no longer shown. */
  private locate(): Point | null {
    this.capture();
    const start = performance.now();
    this.mapTopLeft = findMapTopLeft(this.frame) ?? this.mapTopLeft;
    this.mapBottomRight = findMapBottomRight(this.frame) ?? this.mapBottomRight;
    if (!this.mapTopLeft || !this.mapBottomRight) {
      throw new BotError('Could not find the map on screen. Open the big map and try again.');
    }
    const position = findCharacterOnMap(this.frame, this.mapTopLeft, this.mapBottomRight);
    this.scanMs = performance.now() - start;
    return position;
  }

  /**
   * Feels its way towards `target`: tries the most promising neighbouring tile,
   * and treats it as a wall if the character didn't move.
   */
  private async walk(journey: Journey, from: Point, target: Point, options: WalkOptions): Promise<WalkResult> {
    journey.active.push(startTile(from, target));
    let step = 0;

    while (journey.active.length > 0) {
      await this.yieldToEvents();
      const tile = cheapestTile(journey.active);

      const position = this.locate();
      if (!position) return 'mapChanged';
      if (options.stopAtTarget && position.x === target.x && position.y === target.y) return 'arrived';

      journey.active.splice(journey.active.indexOf(tile), 1);
      await this.runTowards(position, tile, options.click);

      const after = this.locate();
      if (!after) return 'mapChanged';
      const moved = after.x !== journey.previousPosition.x || after.y !== journey.previousPosition.y;

      if (moved) journey.previousTile = tile;
      journey.visited.push(tile);
      markPathVisited(journey, tile);
      journey.previousPosition = after;

      if (step === 0) {
        journey.previousTile = tile;
        expandFrom(journey, tile, after, target);
      }
      if (moved) expandFrom(journey, tile, after, target);
      else journey.walls.push(tile);

      if (options.repeatKey !== undefined && step > 30) {
        step = 0;
        this.key(options.repeatKey);
        await this.sleep(this.menuPause(200));
      }
      step++;
      if (performance.now() - this.lastStatusAt > STATUS_INTERVAL_MS) this.status(this.mode === 'travel' ? 'Travelling' : 'Selling items');
    }
    return 'noPath';
  }

  private async runTowards(position: Point, tile: Point, click: boolean): Promise<void> {
    const sign = direction(position, tile);
    const point = (click ? SHOP_RUN_POINTS : RUN_POINTS)[`${sign.x},${sign.y}`];
    if (!point) return; // already there

    // Clicked runs used to hold 200 ms and wait 500 ms against a 400 ms hover step; keep those ratios.
    const step = this.delay('runStep');
    if (click) {
      await this.click(point, step / 2);
      await this.sleep(step * 1.25);
    } else {
      win.mouseMove(this.hwnd, point.x, point.y);
      await this.sleep(step);
    }
  }
}

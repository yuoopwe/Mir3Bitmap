import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Point, ReaderSpeed } from '../shared/types';
import { updateMap, type MapGrid, type MapReading } from './map-grid';

/**
 * What's around the player, read straight from the game's memory by
 * game-reader/reader.ps1 (read-only, via Microsoft's ClrMD; the reading itself
 * is the C# beside it) instead of from the screen: exact names, map tiles and
 * whether things are dead.
 */
export interface MemoryObject {
  id: number;
  kind: 'monster' | 'item' | 'player' | 'npc' | 'node';
  name: string;
  /** Map tile. */
  x: number;
  y: number;
  dead: boolean;
  level: number;
  /** Someone's pet (ours or another player's). */
  pet: boolean;
  /** Library.CombatTargetDisposition: 4 = hostile (can be attacked); guards read 0. */
  disposition?: number | null;
  /**
   * Monsters: the most health it has (its Health stat), and hp, the damage the client has seen land on it,
   * as 0 going negative (the client isn't told a monster's real health: -300 means 300 damage taken so far).
   */
  maxHp?: number | null;
  hp?: number | null;
  /** Gathering nodes: which node it is (GatheringNodeInfo index), whether it's ore (else a plant), and whether it's been picked. */
  node?: number;
  mining?: boolean;
  harvested?: boolean;
}

/**
 * An item worn or in the bag, with its stats as rolled. Numbers are the game's own: type is Library.ItemType, rarity
 * Library.Rarity (0 Common, 1 Superior, 2 Elite, 3 Legendary, 4 Xtreme, 5 Celestial, 6 Unique, 7 Set), cls the classes
 * that may wear it (Library.RequiredClass flags: 1 Warrior, 2 Wizard, 4 Taoist, 8 Assassin...), needs what the
 * requirement is (Library.RequiredType: 0 Level, 4 DC, ...) of needsAmount, flags Library.UserItemFlags (1 Locked: the
 * game won't sell or drop it). Stats by Library.Stat number (names in stat-names.ts): base the item's own, added what
 * it rolled on top.
 */
export interface MemoryItem {
  slot: number;
  name: string;
  type: number;
  rarity: number;
  lootLevel: number;
  cls: number;
  needs: number;
  needsAmount: number;
  flags: number;
  canSell: boolean;
  durability: number;
  maxDurability: number;
  base: Record<string, number>;
  added: Record<string, number>;
  /** Its weight (ItemInfo's), against the character's WearWeight (HandWeight for a weapon). */
  weight?: number;
  /** The set it's part of, if any: its name and the bonus at each count of pieces worn (stats by Library.Stat number). */
  set?: { name: string; bonuses: { pieces: number; stats: Record<string, number> }[] } | null;
  /** Bag items, with the bag open and the item's cell showing: where that cell is on the game's screen. */
  cell?: MemoryBox;
}

/** A Triple Triad card as the game holds it. */
export interface MemoryCard {
  name: string;
  /** Its picture: the same number as on the hand card's picture on screen. */
  image: number;
  up: number;
  right: number;
  down: number;
  left: number;
  element: number;
  level?: number;
  /** On the board: the index (in players) of whoever owns it now. */
  owner?: number;
}

/** Something drawn on the game's screen: where it is. */
export interface MemoryBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The Triple Triad match on screen. */
export interface MemoryTriad {
  open: boolean;
  error?: string;
  /** Library.TripleTriadRule flags: Open 1, Same 2, Plus 4, Combo 8, Elemental 16, First 32. */
  rules?: number;
  /** Index in players of whoever's turn it is. */
  current?: number;
  /** The server's view of the turn: 0 my turn, 1 waiting for my move to be accepted, 2 the opponent's turn (-1 unknown). */
  stage?: number;
  complete?: boolean;
  /** Each player's cards still in hand. */
  players?: { name: string; ai: boolean; deck: MemoryCard[] }[];
  /** Cells 0-8, left to right then top to bottom. */
  board?: (MemoryCard | null)[];
  elements?: number[];
  /** My cards still in hand, as drawn. */
  hand?: (MemoryBox & { card: MemoryCard })[];
  /** The board's squares (0-8) as drawn; image is the card's picture there, -1 when empty. */
  squares?: (MemoryBox & { image: number })[];
  /** Both decks as dealt at the start of the game. */
  myDeck?: MemoryCard[];
  opponentDeck?: MemoryCard[];
  /** The OK button of the result box, once a game is over. */
  ok?: MemoryBox | null;
  playerName?: string;
  opponentName?: string;
}

/** A button on screen: where it is, whether it can be pressed, and what it says. */
export type MemoryButton = MemoryBox & { enabled: boolean; text: string | null };

/** The Triple Triad card collection window. */
export interface MemoryCollection {
  error?: string;
  owned: { card: MemoryCard; count: number }[];
  /** The deck as saved, and as being edited in the window (card pictures). */
  saved: number[];
  draft: number[];
  dirty: boolean;
  selectedSlot: number;
  /** The collection card last clicked. */
  detail: number;
  feedback: string | null;
  /** The five deck slots along the top. */
  deckSlots: MemoryBox[];
  /** Says "Replace Slot N" once a slot and a card are picked. */
  action: MemoryButton;
  save: MemoryButton;
  undo: MemoryButton;
  /** One tab per card level; only the open tab's cards are laid out. */
  tabs: { level: number; selected: boolean; button: MemoryButton; panel: MemoryBox; slots: (MemoryBox & { image: number; shown: boolean })[] }[];
  /** Every card in the game. */
  cards: MemoryCard[];
}

/** Waypoints unlocked (known once the waypoint window has been opened), and the window while it's open. */
export interface MemoryWaypoints {
  error?: string;
  unlocked: { name: string; map: number }[];
  open: boolean;
  /** The rows showing (a page of the list), each with its Activate button. */
  rows?: { name: string | null; activate: MemoryButton }[];
  /** How many waypoints the list has in all. */
  total?: number;
  scroll?: { value: number; max: number; up: MemoryButton | null; down: MemoryButton | null };
}

export interface MemoryState {
  inGame: boolean;
  triad?: MemoryTriad | null;
  collection?: MemoryCollection | null;
  reason?: string;
  /** pickUpRadius: how many tiles away clicking at the feet picks things up (the PickUpRadius stat); class is Library.MirClass; mounted: riding (its horse isn't None). */
  user?: {
    name: string; x: number; y: number; pickUpRadius?: number; level?: number; class?: number; mounted?: boolean; hasMount?: boolean | null; dead?: boolean; combatAgo?: number | null; experience?: number | null; maxExperience?: number | null;
    /** Health now and at most. */
    hp?: number; maxHp?: number;
    /** Mana now (null when the game's UserObject has no _CurrentMP) and at most (the Mana stat). */
    mp?: number | null; maxMp?: number;
    /** The player's own object id. */
    id?: number;
    /** The map tile under the mouse (MapControl.MapLocation), and the object under it (GameScene.MouseObject: what the title's "Mouse Object" names) by id, null for none; missing where the reader can't tell. */
    mouseTile?: Point | null;
    mouseObject?: number | null;
    /** The tracker stats (an item or a scroll): over 0, the map's markers (MemoryState.known) show elites, bosses or behemoths anywhere on it. */
    trackers?: { elite: number; boss: number; behemoth: number } | null;
    /** The stats (with gear) that decide how fast the character kills and how much it takes: defence (AC, MR), damage (DC, MC, SC), accuracy, agility, attack speed. */
    combat?: { minAC: number; maxAC: number; minMR: number; maxMR: number; minDC: number; maxDC: number; minMC: number; maxMC: number; minSC: number; maxSC: number; accuracy: number; agility: number; attackSpeed: number } | null;
    /** The % stats' totals (by Library.Stat number: DCPercent 84, ACPercent 10031, HealthPercent 54...), which multiply the stats they're for. */
    percents?: Record<string, number> | null;
    /** Weight worn on the body (WearWeight) and in hand (HandWeight), and the most of each the character may wear. */
    weights?: { wear: number; wearMax: number; hand: number; handMax: number } | null;
  };
  objects?: MemoryObject[];
  /**
   * Every monster the game knows of on the map, however far (what the map's markers are drawn from: sub-bosses
   * wherever they are), read once a second: its object id (as in objects), name, map, tile, health and whether it's dead.
   */
  known?: { id: number; name: string; map: number; x: number; y: number; hp: number; maxHp: number; dead: boolean }[] | null;
  /** The map: walls and explored blocks come only when they change (see GameMemory.map). */
  map?: MapReading | null;
  waypoints?: MemoryWaypoints | null;
  /** The game's windows showing (by the scene's field name): the run button held over one doesn't run. */
  windows?: (MemoryBox & { name: string })[] | null;
  /** Monsters still needed by unfinished quest tasks (map: only those on that map count, when the task says), and the task's progress: done of need. */
  questTargets?: { name: string; map: number | null; quest: string; done?: number; need?: number }[] | null;
  /** The quest log: each quest (by its internal name), handed in or not, and whether every task is done. */
  questLog?: { name: string; completed: boolean; ready: boolean }[] | null;
  /** Unfinished quest tasks to go somewhere (a region, by index, on a map) or talk to someone (an NPC, by index). */
  questPending?: { regions: { quest: string; region: number; map: number | null }[]; talks: { quest: string; npc: number }[] } | null;
  /** The map view: the game's size, its map zoom, and where the character's tile is drawn (see MapView). */
  view?: MapView | null;
  /**
   * What's worn (slot: Library.EquipmentSlot) and the wearable items in the bag (slot: bag slot), read once a second;
   * counts: how many the bag holds, by name, of every consumable (potions, elixirs, scrolls) and of a few other items (Forge Stone, Phoenix Tear).
   */
  gear?: { worn: MemoryItem[]; bag: MemoryItem[]; counts?: Record<string, number>; columns?: number } | null;
  /** The game's own auto potion: each link's item (ItemInfo index), the HP and MP it's drunk below (0: not for that), and whether it's on. */
  autoPotion?: { item: number; health: number; mana: number; enabled: boolean }[] | null;
  /**
   * The bloodline (the game's Hermit system): points to spend, what's been bought (Library.Stat number -> amount),
   * and once the Character window's Bloodline tab has been shown, the grade ("F (High Tier)") and each upgrade on
   * offer: its hint as the game words it ("Focus / Steady offense. / Affects: MinDC / Cost: 2 Bloodline Points per
   * upgrade / You will gain: +2 MinDC (from 2 points)"), and with the tab open, its button and the points-to-use box.
   */
  bloodline?: { points: number; bought: Record<string, number>; grade?: string; open?: boolean; options: { hint: string; enabled: boolean; box?: MemoryBox }[]; pointsBox?: MemoryBox } | null;
  /**
   * Profession levels (id is Library.ProfessionId: 1 Fishing, 2 Mining, 3 Harvesting, 4 Taming, 5 Cooking, 6 Crafting, 7 Farming).
   * usable: the level that counts (it can be held back below level); exp of toNext into this level; canGain false (lockReason says why) when it's not earning.
   * Null until the game's Professions window (Ctrl+Shift+P) has been opened once this session.
   */
  professions?: { id: number; name: string; level: number; usable: number; exp: number; toNext: number; canGain: boolean; lockReason: string | null }[] | null;
  /** The Return to Arcadia button, the death window while it's up, and how full the bag is. */
  survival?: {
    arcadia?: MemoryButton | null;
    death?: { returnButton: MemoryButton | null };
    bag?: { used: number; slots: number; weight: number; maxWeight: number };
    /** A shop's sell panel, while open: Select All (from the open bag tab), Sell, the total, and closing the shop. */
    sell?: { selectAll: MemoryButton | null; sell: MemoryButton | null; value: string | null; close?: MemoryButton | null };
    /** The bag window: whether it's showing, which tab (0 = Main) and the Main tab's button. */
    inventory?: { open: boolean; section: number; mainTab: MemoryButton | null };
    /** An NPC's dialog is open. */
    npcDialog?: boolean;
    /** The Talk / Quests menu some NPCs show when clicked. */
    npcMenu?: { quests: MemoryButton | null; talk: MemoryButton | null; waypoints?: MemoryButton | null };
    /**
     * An NPC's quest list while open: whose (NPC index), Accept All, Hand In, and the quests it lists; and its rows (where
     * each is, whether the character has it, and the one picked), to take one at a time.
     */
    questList?: {
      npc: number | null; acceptAll: MemoryButton | null; handIn: MemoryButton | null; quests: string[];
      rows?: (MemoryBox & { name: string; taken: boolean; selected: boolean })[];
    };
    /** The quest picked from the list, in its own window: its name, Accept, and Complete (to hand it in). */
    questBox?: { quest: string | null; accept: MemoryButton | null; complete: MemoryButton | null };
    /** The game's message boxes showing, with their buttons (by field name, e.g. YesButton). */
    messages?: { text: string; buttons: (MemoryButton & { name: string })[]; cooldownMs?: number | null }[];
  } | null;
}

/**
 * The map view as MapControl has it: the game's size, its map zoom (1 = 100%), and where it draws the character's
 * tile: offsetX/offsetY tiles in from the top left, nudged by pixelX/pixelY. The bigger the window, the more map it
 * shows; tiles stay TILE_WIDTH x TILE_HEIGHT at zoom 1.
 */
export interface MapView {
  width: number;
  height: number;
  zoom: number;
  /** How much the game scales its windows and buttons (1 at 1600x900, 1.5 at 2560x1440): every box the reader sends is already scaled. */
  uiScale?: number;
  offsetX: number;
  offsetY: number;
  pixelX: number;
  pixelY: number;
}

/** A tile's size on screen at map zoom 100%. */
export const TILE_WIDTH = 48;
export const TILE_HEIGHT = 32;

/** The view at 1600x900 and zoom 100%, as measured: for when there's no reading of it (no reader, or older data). */
export const DEFAULT_VIEW: MapView = { width: 1600, height: 900, zoom: 1, offsetX: 16, offsetY: 14, pixelX: 8, pixelY: -48 };

/**
 * The middle of a map tile on screen, given the player's tile and the view (measured at 1600x900 and 2560x1440
 * against the tile under the mouse): the player's own is at (width / 2, height / 2 - 34), (800, 416) at 1600x900.
 */
export function tileToScreen(user: { x: number; y: number }, x: number, y: number, view: MapView = DEFAULT_VIEW): Point {
  return {
    x: (x - user.x + view.offsetX) * TILE_WIDTH + view.pixelX + TILE_WIDTH / 2,
    y: (y - user.y + view.offsetY) * TILE_HEIGHT + view.pixelY + TILE_HEIGHT / 2,
  };
}

/** The map tile a point on screen is in, given the player's tile and the view: the other way from tileToScreen. */
export function screenToTile(user: { x: number; y: number }, point: Point, view: MapView = DEFAULT_VIEW): Point {
  const own = tileToScreen(user, user.x, user.y, view);
  return { x: user.x + Math.round((point.x - own.x) / TILE_WIDTH), y: user.y + Math.round((point.y - own.y) / TILE_HEIGHT) };
}

/** What the bot uses of the memory reader: GameMemory, or a stand-in game in the tests. */
export interface MemorySource {
  readonly installed: boolean;
  start(): void;
  stop(): void;
  latest(maxAgeMs?: number): MemoryState | null;
  map(): MapGrid | null;
  fresh(timeoutMs?: number): Promise<MemoryState | null>;
  readonly problem: string;
  /** How the readings have been coming over the last minute (GameMemory; null without readings). */
  speed?(): ReaderSpeed | null;
  /** Waits for the next reading (true), or `timeoutMs` without one (false). */
  next?(timeoutMs: number): Promise<boolean>;
  /** Something to say once, such as the compiled reader failing and the legacy one taking over (GameMemory). */
  takeNotice?(): string | null;
}

/** How far back the reader's speed is measured. */
const SPEED_WINDOW_MS = 60_000;

/** The reader's speed from when its in-game readings came (ms, oldest first) over the last minute; null with fewer than two. */
export function readerSpeed(arrivals: readonly number[], now: number): ReaderSpeed | null {
  const recent = arrivals.filter((at) => now - at <= SPEED_WINDOW_MS);
  if (recent.length < 2) return null;
  const gaps = recent.slice(1).map((at, i) => at - recent[i]).sort((a, b) => a - b);
  const at = (p: number) => gaps[Math.min(gaps.length - 1, Math.ceil(p * gaps.length) - 1)];
  const span = recent[recent.length - 1] - recent[0];
  return {
    perSecond: span > 0 ? ((recent.length - 1) * 1000) / span : 0,
    ageMs: now - recent[recent.length - 1],
    gaps: { median: at(0.5), p90: at(0.9), p99: at(0.99), max: gaps[gaps.length - 1] },
  };
}

/**
 * The old all-PowerShell reader, run instead of the compiled one when BITMAT_LEGACY_READER=1: slower (5 readings a
 * second at best), kept to compare against (scripts/reader-parity.js) and to fall back on.
 */
export const LEGACY_READER = 'reader-legacy.ps1';

/**
 * The compiled reader sending nothing for this long after starting (the first start compiles it, a few seconds), or
 * ending before it sends anything, falls back on the legacy reader for the rest of the session.
 */
export const READER_FALLBACK_MS = 30_000;

/** How GameMemory runs a reader script: pwsh, unless a test stands one in. */
export type ReaderSpawner = (script: string, parentPid: number) => ChildProcessWithoutNullStreams;

const spawnPwsh: ReaderSpawner = (script, parentPid) =>
  spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ParentPid', String(parentPid)], { windowsHide: true });

/** The last non-empty line of a reader's error output, short enough for the status line. */
function lastLine(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/** Runs the memory reader in the background and keeps its latest reading. */
export class GameMemory implements MemorySource {
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: MemoryState | null = null;
  private stateAt = 0;
  private buffer = '';
  private grid: MapGrid | null = null;
  /** When the in-game readings of the last minute came. */
  private arrivals: number[] = [];
  private speedAt: { at: number; speed: ReaderSpeed | null } | null = null;
  /** Who's waiting for the next reading (next()). */
  private waiting: ((came: boolean) => void)[] = [];

  private script: string;
  /** Said once when the compiled reader failed and the legacy one took over (taken by takeNotice). */
  private notice: string | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly folder: string,
    private readonly options: { spawnReader?: ReaderSpawner; fallbackAfterMs?: number } = {},
  ) {
    this.script = process.env.BITMAT_LEGACY_READER === '1' ? LEGACY_READER : 'reader.ps1';
  }

  /** "New memory reader failed (...); using the old one", once, after it happened; else null. */
  takeNotice(): string | null {
    const notice = this.notice;
    this.notice = null;
    return notice;
  }

  /** Whether the legacy reader is the one running (asked for, or fallen back on). */
  get legacy(): boolean {
    return this.script === LEGACY_READER;
  }

  /** The reader and its libraries are installed (scripts/setup-game-reader.ps1). */
  get installed(): boolean {
    return existsSync(path.join(this.folder, this.script)) && existsSync(path.join(this.folder, 'lib', 'Microsoft.Diagnostics.Runtime.dll'));
  }

  start(): void {
    if (this.child || !this.installed) return;
    // With our process id, so the reader ends itself if this app is closed or killed without stopping it.
    const child = (this.options.spawnReader ?? spawnPwsh)(path.join(this.folder, this.script), process.pid);
    this.child = child;
    // The compiled reader has to show it works: a line of any kind (even "Game not running") before the timeout.
    let heard = false;
    let errors = '';
    const fallBack = (why: string) => {
      if (heard || this.child !== child || this.legacy) return;
      this.clearFallbackTimer();
      this.child = null;
      child.kill();
      this.script = LEGACY_READER;
      this.notice = `New memory reader failed (${why}); using the old one`;
      this.start();
    };
    if (!this.legacy) {
      this.fallbackTimer = setTimeout(() => fallBack(`nothing from it in ${Math.round((this.options.fallbackAfterMs ?? READER_FALLBACK_MS) / 1000)} s`), this.options.fallbackAfterMs ?? READER_FALLBACK_MS);
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (this.take(line) && !heard) {
          heard = true;
          this.clearFallbackTimer();
        }
      }
    });
    // Kept short: the end of it says why a reader that never got going failed (a compile error, say).
    child.stderr.on('data', (chunk: Buffer | string) => {
      errors = (errors + String(chunk)).slice(-2000);
    });
    const ended = (why: string) => {
      if (!heard) fallBack(why);
      if (this.child === child) this.child = null;
    };
    child.on('exit', (code) => ended(lastLine(errors) || `it ended with code ${code}`));
    child.on('error', (error) => ended(error.message));
  }

  private clearFallbackTimer(): void {
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  /** One line from the reader: the latest reading, once it parses (true then). Whoever waits for the next (next()) is woken. */
  take(line: string): boolean {
    if (!line.startsWith('{')) return false;
    try {
      this.state = JSON.parse(line) as MemoryState;
      this.stateAt = performance.now();
      if (this.state.inGame) {
        this.arrivals.push(this.stateAt);
        while (this.arrivals.length > 0 && this.stateAt - this.arrivals[0] > SPEED_WINDOW_MS) this.arrivals.shift();
      }
      this.grid = updateMap(this.grid, this.state.map);
      // Decoded into the grid; no need to keep the text.
      if (this.state.map) {
        delete this.state.map.walls;
        delete this.state.map.explored;
      }
    } catch {
      // A partial or garbled line: the next one will do.
      return false;
    }
    const waiting = this.waiting;
    this.waiting = [];
    for (const wake of waiting) wake(true);
    return true;
  }

  /** Waits for the next reading (true), or `timeoutMs` without one (false). */
  next(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((w) => w !== wake);
        resolve(false);
      }, Math.max(0, timeoutMs));
      const wake = (came: boolean) => {
        clearTimeout(timer);
        resolve(came);
      };
      this.waiting.push(wake);
    });
  }

  stop(): void {
    this.clearFallbackTimer();
    this.child?.kill();
    this.child = null;
    this.state = null;
    this.grid = null;
    this.arrivals = [];
    this.speedAt = null;
  }

  speed(): ReaderSpeed | null {
    // Worked out at most twice a second (it sorts a minute's gaps): asked every tick, it changes slowly.
    const now = performance.now();
    if (!this.speedAt || now - this.speedAt.at > 500) this.speedAt = { at: now, speed: readerSpeed(this.arrivals, now) };
    // The age is now's, though.
    const last = this.arrivals[this.arrivals.length - 1];
    return this.speedAt.speed && last !== undefined ? { ...this.speedAt.speed, ageMs: now - last } : this.speedAt.speed;
  }

  /** The current map's walls and explored blocks, once known. */
  map(): MapGrid | null {
    return this.latest() ? this.grid : null;
  }

  /**
   * The latest reading if it's recent and in game, else null. Readings come every 50 ms (about every 200 ms from the
   * legacy reader), further apart on a map change: a second's grace covers that.
   */
  latest(maxAgeMs = 1000): MemoryState | null {
    if (!this.state || performance.now() - this.stateAt > maxAgeMs) return null;
    return this.state.inGame && this.state.user ? this.state : null;
  }

  /** The first reading taken after now (so it shows the effect of a click just made), or null after `timeoutMs`. */
  async fresh(timeoutMs = 3000): Promise<MemoryState | null> {
    const since = performance.now();
    for (let left = timeoutMs; left > 0; left = timeoutMs - (performance.now() - since)) {
      await this.next(left);
      if (this.stateAt > since) return this.latest();
    }
    return null;
  }

  /** Why there's no usable reading, for the status line. */
  get problem(): string {
    if (!this.installed) return 'memory reader not installed';
    if (!this.child) return 'memory reader not running';
    if (!this.state) return 'memory reader starting';
    return this.state.reason ?? 'no recent reading';
  }
}

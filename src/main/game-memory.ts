import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Point } from '../shared/types';
import { updateMap, type MapGrid, type MapReading } from './map-grid';

/**
 * What's around the player, read straight from the game's memory by
 * game-reader/reader.ps1 (read-only, via Microsoft's ClrMD) instead of from
 * the screen: exact names, map tiles and whether things are dead.
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
  /** Gathering nodes: which node it is (GatheringNodeInfo index), whether it's ore (else a plant), and whether it's been picked. */
  node?: number;
  mining?: boolean;
  harvested?: boolean;
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
  /** pickUpRadius: how many tiles away clicking at the feet picks things up (the PickUpRadius stat); class is Library.MirClass. */
  user?: { name: string; x: number; y: number; pickUpRadius?: number; level?: number; class?: number };
  objects?: MemoryObject[];
  /** The map: walls and explored blocks come only when they change (see GameMemory.map). */
  map?: MapReading | null;
  waypoints?: MemoryWaypoints | null;
}

/** The middle of the player's own tile on screen, and a tile's size (the game client at 1600x900). */
export const PLAYER_TILE: Point = { x: 792, y: 400 };
export const TILE_WIDTH = 48;
export const TILE_HEIGHT = 32;

/** The middle of a map tile on screen, given the player's tile. */
export function tileToScreen(user: { x: number; y: number }, x: number, y: number): Point {
  return { x: PLAYER_TILE.x + (x - user.x) * TILE_WIDTH, y: PLAYER_TILE.y + (y - user.y) * TILE_HEIGHT };
}

/** Runs the memory reader in the background and keeps its latest reading. */
export class GameMemory {
  private child: ChildProcessWithoutNullStreams | null = null;
  private state: MemoryState | null = null;
  private stateAt = 0;
  private buffer = '';
  private grid: MapGrid | null = null;

  constructor(private readonly folder: string) {}

  /** The reader and its libraries are installed (scripts/setup-game-reader.ps1). */
  get installed(): boolean {
    return existsSync(path.join(this.folder, 'reader.ps1')) && existsSync(path.join(this.folder, 'lib', 'Microsoft.Diagnostics.Runtime.dll'));
  }

  start(): void {
    if (this.child || !this.installed) return;
    // With our process id, so the reader ends itself if this app is closed or killed without stopping it.
    const child = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(this.folder, 'reader.ps1'), '-ParentPid', String(process.pid)], { windowsHide: true });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (!line.startsWith('{')) continue;
        try {
          this.state = JSON.parse(line) as MemoryState;
          this.stateAt = performance.now();
          this.grid = updateMap(this.grid, this.state.map);
          // Decoded into the grid; no need to keep the text.
          if (this.state.map) {
            delete this.state.map.walls;
            delete this.state.map.explored;
          }
        } catch {
          // A partial or garbled line: the next one will do.
        }
      }
    });
    child.stderr.on('data', () => {});
    child.on('exit', () => {
      if (this.child === child) this.child = null;
    });
    child.on('error', () => {
      if (this.child === child) this.child = null;
    });
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
    this.state = null;
    this.grid = null;
  }

  /** The current map's walls and explored blocks, once known. */
  map(): MapGrid | null {
    return this.latest() ? this.grid : null;
  }

  /** The latest reading if it's recent and in game, else null. */
  latest(maxAgeMs = 600): MemoryState | null {
    if (!this.state || performance.now() - this.stateAt > maxAgeMs) return null;
    return this.state.inGame && this.state.user ? this.state : null;
  }

  /** The first reading taken after now (so it shows the effect of a click just made), or null after `timeoutMs`. */
  async fresh(timeoutMs = 3000): Promise<MemoryState | null> {
    const since = performance.now();
    while (performance.now() - since < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 40));
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

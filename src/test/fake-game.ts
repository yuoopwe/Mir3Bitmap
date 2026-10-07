/**
 * A stand-in for the game, for running the bot's real loops in tests: the
 * window's input (GameInput), the memory reader (MemorySource) and the time
 * (Clock), all from one simulated world. It moves the player as the game does
 * (running with the right button held, a stride every STRIDE_MS in one of 8
 * directions; a step per left click), changes maps on links' exit tiles, and
 * has monsters, NPCs, the waypoint window, quests, a shop, death, Return to
 * Arcadia, the mount and a bag. Time is virtual: every wait jumps ahead, so a
 * minute of play takes a moment. Everything it saw is in `events`, for the
 * tests to check.
 */
import type { Clock } from '../main/clock';
import { PLAYER_TILE, TILE_HEIGHT, TILE_WIDTH, type MemoryButton, type MemoryObject, type MemorySource, type MemoryState } from '../main/game-memory';
import { VK, type GameInput, type Handle } from '../main/input';
import { GAME_HEIGHT, GAME_WIDTH } from '../main/layout';
import { isWall, type MapGrid } from '../main/map-grid';
import { classFlagOf, loadTravelData, type TravelData, type TravelQuest } from '../main/travel';

/** A run moves a stride (2 tiles, 3 mounted) this often; a click's step takes STEP_MS. Positions change when a move ends. */
export const STRIDE_MS = 650;
export const STEP_MS = 600;
/** After a map change, moving waits this long (the new map loading). */
export const MAP_LOAD_MS = 400;
/** With the cursor this close to the player (in tiles), holding the right button runs nowhere. */
export const RUN_DEAD_ZONE = 2;
/** Return to Arcadia takes this long to cast; Return on the death window this long. */
const ARCADIA_CAST_MS = 1500;
const REVIVE_MS = 500;
/** Dead monsters lie this long, then come back (when they respawn) after RESPAWN_MS more. */
const CORPSE_MS = 2000;
const RESPAWN_MS = 4000;
/** Explored blocks are this many tiles a side; the player uncovers this far around them. */
const BLOCK = 4;
const SIGHT = 12;
/** Every look at the clock costs this much time, so a loop that never waits still lets time pass. */
const CLOCK_TICK_MS = 0.1;
const ARCADIA = { map: 563, x: 647, y: 196 };

export type FakeEvent =
  | { t: number; type: 'move'; map: number; from: { x: number; y: number }; to: { x: number; y: number }; run: boolean }
  | { t: number; type: 'runTooClose'; tiles: number }
  | { t: number; type: 'mapChange'; from: number; to: number; via: 'link' | 'waypoint' | 'arcadia' | 'revive' }
  | { t: number; type: 'attack'; name: string; level: number; disposition: number | null; killed: boolean }
  | { t: number; type: 'mount'; moving: boolean; mounted: boolean; map: number }
  | { t: number; type: 'key'; vk: number; down: boolean }
  | { t: number; type: 'window'; name: string; open: boolean }
  | { t: number; type: 'button'; name: string }
  | { t: number; type: 'quest'; key: string; what: 'accepted' | 'ready' | 'handedIn' }
  | { t: number; type: 'sold'; items: number };

export interface FakeMonster {
  name: string;
  x: number;
  y: number;
  /** Map index (default: the player's at the start). */
  map?: number;
  level?: number;
  /** Library.CombatTargetDisposition: 4 hostile (default), 0 a guard that can't be attacked. */
  disposition?: number;
  /** Clicks to kill (default 1). */
  hits?: number;
  exp?: number;
  /** Comes back after dying. */
  respawn?: boolean;
}

export interface FakeNpcSetup {
  /** The NPC's id in travel.json (its name and spot come from there unless given). */
  id: number;
  name?: string;
  map?: number;
  x?: number;
  y?: number;
  /** The radial menu shown when clicked, instead of going straight to the NPC's window. */
  menu?: ('talk' | 'quests' | 'waypoints')[];
}

export interface FakeGameSetup {
  data?: TravelData;
  /** Map grids by index; any other map the player reaches is open floor, sized as travel.json has it. */
  maps?: MapGrid[];
  player: { map: number; x: number; y: number; level?: number; cls?: number; name?: string; mounted?: boolean; hasMount?: boolean };
  monsters?: FakeMonster[];
  /** NPCs to place, by travel.json id; with `allNpcs`, every NPC on a map is placed when the player gets there too. */
  npcs?: FakeNpcSetup[];
  allNpcs?: boolean;
  /** Waypoints unlocked, by name (default: all of them). */
  waypoints?: string[];
  /** Quests in the log: handed in (completed), finished (ready) or on the go (with kills so far). */
  quests?: { key: string; state: 'completed' | 'ready' | 'active' }[];
  /** Quests the NPCs offer, by key (default: all that the level, class and done quests allow). */
  offers?: string[];
  bag?: { used: number; slots: number };
}

interface Monster extends MemoryObject {
  map: number;
  hits: number;
  taken: number;
  exp: number;
  respawn: boolean;
  home: { x: number; y: number };
  deadAt: number;
}

interface Npc extends MemoryObject {
  map: number;
  npc: number;
  menu?: ('talk' | 'quests' | 'waypoints')[];
}

interface ActiveQuest {
  quest: TravelQuest;
  /** Progress per task (kills, or 1 when done). */
  done: number[];
  completed: boolean;
}

type Window = 'waypoints' | 'npcMenu' | 'questList' | 'sell' | 'dialog';

const button = (x: number, y: number, text: string, enabled = true, width = 90, height = 26): MemoryButton => ({ x, y, width, height, enabled, text });
const inside = (p: { x: number; y: number }, b: { x: number; y: number; width: number; height: number }) => p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
const chebyshev = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** Open floor everywhere (a border of wall), with nothing explored: for maps no test needs the walls of. */
export function openMap(index: number, name: string, width: number, height: number): MapGrid {
  const walls = new Uint8Array(Math.ceil((width * height) / 8));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) walls[(y * width + x) >> 3] |= 1 << ((y * width + x) & 7);
    }
  }
  return withBlocks({ index, name, width, height, walls, blockSize: 0, gridWidth: 0, gridHeight: 0, explored: null, revision: 0 });
}

/** The map with its own exploring (nothing uncovered yet). */
function withBlocks(map: MapGrid): MapGrid {
  const gridWidth = Math.ceil(map.width / BLOCK), gridHeight = Math.ceil(map.height / BLOCK);
  return { ...map, blockSize: BLOCK, gridWidth, gridHeight, explored: new Uint8Array(Math.ceil((gridWidth * gridHeight) / 8)), revision: 0 };
}

export class FakeGame {
  readonly data: TravelData;
  readonly events: FakeEvent[] = [];
  t = 0;
  readonly player: { map: number; x: number; y: number; level: number; cls: number; name: string; mounted: boolean; hasMount: boolean; dead: boolean; experience: number };
  bag: { used: number; slots: number };
  /** Sellable items picked with Select All. */
  private selected = 0;

  private readonly maps = new Map<number, MapGrid>();
  private readonly monsters: Monster[] = [];
  private readonly npcs: Npc[] = [];
  private readonly npcSetups: FakeNpcSetup[];
  private readonly placedMaps = new Set<number>();
  /** Every NPC on a map is placed when the player gets there. */
  private readonly allNpcs: boolean;
  private readonly quests = new Map<string, ActiveQuest>();
  private readonly offers: Set<string> | null;
  private readonly unlocked: Set<string>;
  /** The reader only knows which waypoints are unlocked once the window has been opened. */
  private waypointsKnown = false;
  private nextId = 1;

  // The input as the game sees it.
  private cursor = { x: GAME_WIDTH / 2, y: GAME_HEIGHT / 2 };
  private rightHeld = false;
  private readonly keysDown = new Set<number>();
  /** A stride or step under way: where it ends, and when. */
  private move: { to: { x: number; y: number }; path: { x: number; y: number }[]; at: number; run: boolean } | null = null;
  private loadedAt = 0;
  private lastMoveEnd = -Infinity;
  private arcadiaAt: number | null = null;
  private reviveAt: number | null = null;

  // Windows.
  private readonly open = new Set<Window>();
  private menuNpc: Npc | null = null;
  private listNpc: Npc | null = null;
  private waypointScroll = 0;

  readonly input: GameInput;
  readonly memory: MemorySource;
  readonly clock: Clock;

  constructor(setup: FakeGameSetup) {
    this.data = setup.data ?? loadTravelData();
    for (const map of setup.maps ?? []) this.maps.set(map.index, map.explored ? map : withBlocks(map));
    const p = setup.player;
    this.player = { map: p.map, x: p.x, y: p.y, level: p.level ?? 10, cls: p.cls ?? 0, name: p.name ?? 'Tester', mounted: p.mounted ?? false, hasMount: p.hasMount ?? true, dead: false, experience: 0 };
    this.bag = { ...(setup.bag ?? { used: 10, slots: 40 }) };
    this.offers = setup.offers ? new Set(setup.offers) : null;
    this.unlocked = new Set(setup.waypoints ?? (this.data.waypoints ?? []).map((w) => w.name));
    this.npcSetups = setup.npcs ?? [];
    this.allNpcs = !!setup.allNpcs;
    for (const m of setup.monsters ?? []) this.addMonster(m);
    for (const n of this.npcSetups) this.placeNpc(n);
    if (setup.allNpcs) this.placeAllNpcs(p.map);
    for (const q of setup.quests ?? []) {
      const quest = (this.data.quests ?? []).find((x) => (x.key ?? x.name) === q.key);
      if (!quest) throw new Error(`No quest ${q.key}`);
      this.quests.set(q.key, {
        quest,
        done: quest.tasks.map((t) => (q.state === 'active' ? 0 : t.amount)),
        completed: q.state === 'completed',
      });
    }
    this.reveal();

    const game = this;
    this.clock = {
      now: () => {
        game.t += CLOCK_TICK_MS;
        game.update();
        return game.t;
      },
      wait: (ms: number) => {
        game.t += Math.max(0, ms);
        game.update();
        return new Promise((resolve) => setImmediate(resolve));
      },
    };
    this.input = {
      findWindow: () => 'fake-game',
      windowTitle: () => game.title(),
      cursorOverWindow: () => false,
      clientSize: () => ({ width: GAME_WIDTH, height: GAME_HEIGHT }),
      isMinimized: () => false,
      captureClient: (_hwnd: Handle, _method, _width, _height, out: Uint8Array) => out.fill(0),
      keyDown: (_hwnd, vk) => game.key(vk, true),
      keyUp: (_hwnd, vk) => game.key(vk, false),
      mouseMove: (_hwnd, x, y) => game.mouseMove(x, y),
      rightDown: () => game.right(true),
      rightUp: () => game.right(false),
      leftDown: () => game.leftClick(),
      leftUp: () => {},
      mouseWheel: (_hwnd, x, y, notches) => game.wheel(x, y, notches),
    };
    this.memory = {
      installed: true,
      start: () => {},
      stop: () => {},
      latest: () => game.reading(),
      map: () => game.currentMap(),
      fresh: async (timeoutMs = 3000) => {
        await game.clock.wait(Math.min(40, timeoutMs));
        return game.reading();
      },
      problem: '',
    };
  }

  // ---- The world ----

  currentMap(): MapGrid {
    let map = this.maps.get(this.player.map);
    if (!map) {
      const info = this.data.maps.find((m) => m.i === this.player.map);
      map = openMap(this.player.map, info?.name ?? `map ${this.player.map}`, info?.w ?? 200, info?.h ?? 200);
      this.maps.set(map.index, map);
    }
    return map;
  }

  addMonster(m: FakeMonster): void {
    const index = this.data.monsters?.findIndex((n) => n.toLowerCase() === m.name.toLowerCase()) ?? -1;
    const stats = index >= 0 ? this.data.monsterStats?.[index] : undefined;
    this.monsters.push({
      id: this.nextId++, kind: 'monster', name: m.name, x: m.x, y: m.y, dead: false, level: m.level ?? stats?.[0] ?? 1, pet: false,
      disposition: m.disposition ?? 4, map: m.map ?? this.player.map, hits: m.hits ?? 1, taken: 0, exp: m.exp ?? stats?.[1] ?? 10,
      respawn: m.respawn ?? false, home: { x: m.x, y: m.y }, deadAt: 0,
    });
  }

  private placeNpc(setup: FakeNpcSetup): void {
    const npc = this.data.npcs.find((n) => n.id === setup.id);
    const map = setup.map ?? npc?.map;
    const at = setup.x !== undefined && setup.y !== undefined ? [setup.x, setup.y] : npc?.at;
    if (map === undefined || !at || this.npcs.some((n) => n.npc === setup.id)) return;
    this.npcs.push({ id: 100_000 + setup.id, kind: 'npc', name: setup.name ?? npc!.name, x: at[0], y: at[1], dead: false, level: 0, pet: false, map, npc: setup.id, menu: setup.menu });
  }

  /** Every NPC travel.json has on this map (those set up keep their setup). */
  private placeAllNpcs(map: number): void {
    if (this.placedMaps.has(map)) return;
    this.placedMaps.add(map);
    for (const n of this.data.npcs) if (n.map === map && n.at) this.placeNpc(this.npcSetups.find((s) => s.id === n.id) ?? { id: n.id });
  }

  private floor(x: number, y: number): boolean {
    const map = this.currentMap();
    if (isWall(map, x, y)) return false;
    return !this.monsters.some((m) => m.map === map.index && !m.dead && m.x === x && m.y === y) && !this.npcs.some((n) => n.map === map.index && n.x === x && n.y === y);
  }

  /** The screen point's map tile. */
  private tileAt(point: { x: number; y: number }): { x: number; y: number } {
    return { x: this.player.x + Math.round((point.x - PLAYER_TILE.x) / TILE_WIDTH), y: this.player.y + Math.round((point.y - PLAYER_TILE.y) / TILE_HEIGHT) };
  }

  private objectAt(tile: { x: number; y: number }): Monster | Npc | undefined {
    const map = this.player.map;
    return (
      this.monsters.find((m) => m.map === map && !m.dead && m.x === tile.x && m.y === tile.y) ??
      this.npcs.find((n) => n.map === map && n.x === tile.x && n.y === tile.y)
    );
  }

  /** Brings the world up to now: moves ending, the next stride, casts, corpses and respawns. */
  update(): void {
    for (let guard = 0; guard < 1000; guard++) {
      if (this.move && this.move.at <= this.t) {
        this.finishMove();
        continue;
      }
      if (!this.move && this.rightHeld && !this.player.dead && this.t >= this.loadedAt && this.startStride()) continue;
      break;
    }
    if (this.arcadiaAt !== null && this.t >= this.arcadiaAt) {
      this.arcadiaAt = null;
      this.teleport(ARCADIA.map, ARCADIA.x, ARCADIA.y, 'arcadia');
    }
    if (this.reviveAt !== null && this.t >= this.reviveAt) {
      this.reviveAt = null;
      this.player.dead = false;
      this.teleport(ARCADIA.map, ARCADIA.x, ARCADIA.y, 'revive');
    }
    for (const m of this.monsters) {
      if (!m.dead) continue;
      if (m.respawn && this.t - m.deadAt >= CORPSE_MS + RESPAWN_MS && this.free(m.map, m.home)) Object.assign(m, { dead: false, taken: 0, x: m.home.x, y: m.home.y });
    }
  }

  private free(map: number, tile: { x: number; y: number }): boolean {
    return !(this.player.map === map && this.player.x === tile.x && this.player.y === tile.y);
  }

  /** Holding the right button: a stride the cursor's way, if the cursor isn't on top of the player and the way is clear. */
  private startStride(): boolean {
    const tile = this.tileAt(this.cursor);
    const dx = tile.x - this.player.x, dy = tile.y - this.player.y;
    const away = Math.max(Math.abs(dx), Math.abs(dy));
    if (away <= RUN_DEAD_ZONE) {
      this.events.push({ t: this.t, type: 'runTooClose', tiles: away });
      // Nothing happens; look again in a while.
      this.loadedAt = this.t + STRIDE_MS;
      return false;
    }
    // One of 8 directions, from the angle to the cursor's tile.
    const octant = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
    const dir = { x: Math.round(Math.cos((octant * Math.PI) / 4)), y: Math.round(Math.sin((octant * Math.PI) / 4)) };
    const stride = this.player.mounted ? 3 : 2;
    const path = Array.from({ length: stride }, (_, k) => ({ x: this.player.x + dir.x * (k + 1), y: this.player.y + dir.y * (k + 1) }));
    if (!path.every((t) => this.floor(t.x, t.y))) {
      // Blocked: the character stands; the game tries again a stride later.
      this.loadedAt = this.t + STRIDE_MS;
      return false;
    }
    this.move = { to: path[path.length - 1], path, at: this.t + STRIDE_MS, run: true };
    return true;
  }

  private finishMove(): void {
    const move = this.move!;
    this.move = null;
    this.lastMoveEnd = move.at;
    const from = { x: this.player.x, y: this.player.y };
    // Through an exit tile on the way: off to the other map.
    for (const tile of move.path) {
      const link = this.data.links.find((l) => l.from === this.player.map && !l.waypoint && !l.needs && l.exit.some(([x, y]) => x === tile.x && y === tile.y));
      if (link) {
        this.events.push({ t: this.t, type: 'move', map: this.player.map, from, to: tile, run: move.run });
        this.teleport(link.to, link.land[0], link.land[1], 'link');
        return;
      }
    }
    this.player.x = move.to.x;
    this.player.y = move.to.y;
    this.events.push({ t: this.t, type: 'move', map: this.player.map, from, to: move.to, run: move.run });
    this.reveal();
  }

  private teleport(map: number, x: number, y: number, via: 'link' | 'waypoint' | 'arcadia' | 'revive'): void {
    const from = this.player.map;
    Object.assign(this.player, { map, x, y });
    // Mounts aren't allowed everywhere: off it goes.
    if (this.data.maps.find((m) => m.i === map)?.noHorse) this.player.mounted = false;
    this.move = null;
    this.loadedAt = this.t + MAP_LOAD_MS;
    for (const w of [...this.open]) this.close(w);
    if (this.allNpcs) this.placeAllNpcs(map);
    this.events.push({ t: this.t, type: 'mapChange', from, to: map, via });
    this.reveal();
  }

  /** Uncovers the blocks around the player. */
  private reveal(): void {
    const map = this.currentMap();
    if (!map.explored) return;
    const explored = new Uint8Array(map.explored);
    let changed = false;
    for (let gy = Math.floor((this.player.y - SIGHT) / BLOCK); gy <= Math.floor((this.player.y + SIGHT) / BLOCK); gy++) {
      for (let gx = Math.floor((this.player.x - SIGHT) / BLOCK); gx <= Math.floor((this.player.x + SIGHT) / BLOCK); gx++) {
        if (gx < 0 || gy < 0 || gx >= map.gridWidth || gy >= map.gridHeight) continue;
        const i = gy * map.gridWidth + gx;
        if (!(explored[i >> 3] & (1 << (i & 7)))) {
          explored[i >> 3] |= 1 << (i & 7);
          changed = true;
        }
      }
    }
    if (changed) this.maps.set(map.index, { ...map, explored, revision: map.revision + 1 });
  }

  // ---- Input ----

  private mouseMove(x: number, y: number): void {
    this.cursor = { x, y };
    if (this.rightHeld && this.cursorTiles() <= RUN_DEAD_ZONE) this.events.push({ t: this.t, type: 'runTooClose', tiles: this.cursorTiles() });
  }

  private right(down: boolean): void {
    this.update();
    this.rightHeld = down;
    this.update();
  }

  private key(vk: number, down: boolean): void {
    this.update();
    this.events.push({ t: this.t, type: 'key', vk, down });
    if (down) {
      this.keysDown.add(vk);
      if (vk === VK.ESCAPE) this.escape();
      return;
    }
    const wasDown = this.keysDown.delete(vk);
    // M works on a whole press, and only standing still: not mid-move, nor just after one.
    if (vk === VK.M && wasDown) {
      const moving = !!this.move || this.t - this.lastMoveEnd < 100;
      const noHorse = !!this.data.maps.find((m) => m.i === this.player.map)?.noHorse;
      if (!moving && this.player.hasMount && (this.player.mounted || !noHorse)) this.player.mounted = !this.player.mounted;
      this.events.push({ t: this.t, type: 'mount', moving, mounted: this.player.mounted, map: this.player.map });
    }
  }

  private escape(): void {
    const order: Window[] = ['waypoints', 'questList', 'sell', 'npcMenu', 'dialog'];
    const top = order.find((w) => this.open.has(w));
    if (top) this.close(top);
  }

  private openWindow(name: Window): void {
    if (this.open.has(name)) return;
    this.open.add(name);
    if (name === 'waypoints') this.waypointsKnown = true;
    this.events.push({ t: this.t, type: 'window', name, open: true });
  }

  private close(name: Window): void {
    if (!this.open.delete(name)) return;
    if (name === 'npcMenu') this.menuNpc = null;
    if (name === 'questList') this.listNpc = null;
    if (name === 'sell') this.selected = 0;
    this.events.push({ t: this.t, type: 'window', name, open: false });
  }

  private wheel(x: number, y: number, notches: number): void {
    this.cursor = { x, y };
    if (!this.open.has('waypoints')) return;
    const max = Math.max(0, (this.data.waypoints ?? []).length - WAYPOINT_ROWS);
    this.waypointScroll = Math.min(max, Math.max(0, this.waypointScroll + notches));
  }

  /** A left click where the cursor is: a button, a window (swallowed), something in the world, or a step. */
  private leftClick(): void {
    this.update();
    const point = this.cursor;
    for (const [name, b, press] of this.buttons()) {
      if (b && b.enabled && inside(point, b)) {
        this.events.push({ t: this.t, type: 'button', name });
        press();
        return;
      }
    }
    if (this.windowBoxes().some((w) => inside(point, w))) return;
    if (this.player.dead) return;
    const tile = this.tileAt(point);
    const thing = this.objectAt(tile);
    if (thing?.kind === 'monster') return this.attack(thing as Monster);
    if (thing?.kind === 'npc') return this.clickNpc(thing as Npc);
    this.step(tile);
  }

  /** A step toward the tile (when nothing's under way). */
  private step(tile: { x: number; y: number }): void {
    if (this.move || this.t < this.loadedAt) return;
    const dir = { x: Math.sign(tile.x - this.player.x), y: Math.sign(tile.y - this.player.y) };
    if (!dir.x && !dir.y) return;
    const to = { x: this.player.x + dir.x, y: this.player.y + dir.y };
    if (!this.floor(to.x, to.y)) return;
    this.move = { to, path: [to], at: this.t + STEP_MS, run: false };
  }

  private attack(monster: Monster): void {
    if (chebyshev(monster, this.player) > 1) return this.step(monster);
    const guard = monster.disposition === 0;
    if (!guard) monster.taken++;
    const killed = !guard && monster.taken >= monster.hits;
    this.events.push({ t: this.t, type: 'attack', name: monster.name, level: monster.level, disposition: monster.disposition ?? null, killed });
    if (!killed) return;
    monster.dead = true;
    monster.deadAt = this.t;
    this.player.experience += monster.exp;
    this.credit(monster);
  }

  private clickNpc(npc: Npc): void {
    if (chebyshev(npc, this.player) > 8) return this.step(npc);
    const info = this.data.npcs.find((n) => n.id === npc.npc);
    if (npc.menu?.length) {
      this.menuNpc = npc;
      this.openWindow('npcMenu');
    } else if (info?.stone) this.openWindow('waypoints');
    else if (npc.npc === SHOP_NPC) this.openWindow('sell');
    else if (this.questsAt(npc.npc).offered.length || this.questsAt(npc.npc).ready.length) {
      this.listNpc = npc;
      this.openWindow('questList');
    } else this.openWindow('dialog');
  }

  // ---- Windows and their buttons ----

  /** Every button showing: its name, where, and what pressing it does. */
  private buttons(): [string, MemoryButton | null, () => void][] {
    const out: [string, MemoryButton | null, () => void][] = [];
    const reading = this.survival();
    if (reading.death?.returnButton) out.push(['Return', reading.death.returnButton, () => (this.reviveAt = this.t + REVIVE_MS)]);
    if (this.open.has('waypoints')) {
      this.waypointRows().forEach((row, i) =>
        out.push([`Activate ${row.name}`, row.activate, () => {
          const w = (this.data.waypoints ?? [])[this.waypointScroll + i];
          this.teleport(w.map, w.land[0], w.land[1], 'waypoint');
        }]),
      );
    }
    if (reading.npcMenu) {
      const npc = this.menuNpc!;
      out.push(['Quests', reading.npcMenu.quests, () => { this.close('npcMenu'); this.listNpc = npc; this.openWindow('questList'); }]);
      out.push(['Talk', reading.npcMenu.talk, () => { this.close('npcMenu'); this.talked(npc.npc); this.openWindow('dialog'); }]);
      out.push(['Waypoints', reading.npcMenu.waypoints ?? null, () => { this.close('npcMenu'); this.openWindow('waypoints'); }]);
    }
    if (reading.questList) {
      out.push(['Accept All', reading.questList.acceptAll, () => this.acceptAll(this.listNpc!.npc)]);
      out.push(['Hand In', reading.questList.handIn, () => this.handIn(this.listNpc!.npc)]);
    }
    if (reading.sell) {
      out.push(['Select All', reading.sell.selectAll, () => (this.selected = Math.max(0, this.bag.used - KEPT_ITEMS))]);
      out.push(['Sell', reading.sell.sell, () => {
        this.events.push({ t: this.t, type: 'sold', items: this.selected });
        this.bag.used -= this.selected;
        this.selected = 0;
      }]);
      out.push(['Close shop', reading.sell.close ?? null, () => this.close('sell')]);
    }
    if (reading.arcadia) out.push(['Return to Arcadia', reading.arcadia, () => (this.arcadiaAt ??= this.t + ARCADIA_CAST_MS)]);
    return out;
  }

  private windowBoxes(): { x: number; y: number; width: number; height: number; name: string }[] {
    const boxes: { x: number; y: number; width: number; height: number; name: string }[] = [];
    if (this.open.has('waypoints')) boxes.push({ name: 'WaypointDialog', ...WAYPOINT_BOX });
    if (this.open.has('questList')) boxes.push({ name: 'NPCQuestListDialog', ...QUEST_BOX });
    if (this.open.has('sell')) boxes.push({ name: 'NPCSellDialog', ...SELL_BOX }, { name: 'InventoryDialog', ...BAG_BOX });
    if (this.open.has('dialog')) boxes.push({ name: 'NPCDialog', ...DIALOG_BOX });
    if (this.player.dead) boxes.push({ name: 'DeathDialog', ...DEATH_BOX });
    return boxes;
  }

  private waypointRows(): { name: string | null; activate: MemoryButton }[] {
    return (this.data.waypoints ?? []).slice(this.waypointScroll, this.waypointScroll + WAYPOINT_ROWS).map((w, i) => ({
      name: w.name,
      activate: button(WAYPOINT_BOX.x + 480, WAYPOINT_BOX.y + 40 + i * 40, 'Activate', this.unlocked.has(w.name) || !!w.always),
    }));
  }

  // ---- Quests ----

  private questsAt(npc: number): { offered: TravelQuest[]; ready: ActiveQuest[] } {
    const done = new Set([...this.quests].filter(([, q]) => q.completed).map(([key]) => key));
    const byId = new Map((this.data.quests ?? []).map((q) => [q.id, q]));
    const offered = (this.data.quests ?? []).filter((q) => {
      const key = q.key ?? q.name;
      if (q.start !== npc || this.quests.has(key) || (this.offers && !this.offers.has(key))) return false;
      if ((q.level ?? 0) > this.player.level || (q.cls !== undefined && !(q.cls & classFlagOf(this.player.cls)))) return false;
      return (q.after ?? []).every((id) => { const before = byId.get(id); return !before || done.has(before.key ?? before.name); });
    });
    const ready = [...this.quests.values()].filter((q) => !q.completed && q.quest.finish === npc && this.isReady(q));
    return { offered, ready };
  }

  private isReady(q: ActiveQuest): boolean {
    return q.quest.tasks.every((t, i) => q.done[i] >= t.amount);
  }

  /** The tasks of a quest's current stage (the lowest stage with any left). */
  private currentTasks(q: ActiveQuest): number[] {
    const left = q.quest.tasks.map((t, i) => ({ stage: t.stage ?? 0, i })).filter(({ i }) => q.done[i] < q.quest.tasks[i].amount);
    const stage = Math.min(...left.map((t) => t.stage));
    return left.filter((t) => t.stage === stage).map((t) => t.i);
  }

  private acceptAll(npc: number): void {
    for (const quest of this.questsAt(npc).offered) {
      const key = quest.key ?? quest.name;
      this.quests.set(key, { quest, done: quest.tasks.map(() => 0), completed: false });
      this.events.push({ t: this.t, type: 'quest', key, what: 'accepted' });
    }
  }

  private handIn(npc: number): void {
    for (const q of this.questsAt(npc).ready) {
      q.completed = true;
      this.player.experience += q.quest.exp ?? 0;
      this.events.push({ t: this.t, type: 'quest', key: q.quest.key ?? q.quest.name, what: 'handedIn' });
    }
  }

  /** A kill counts for the kill and collect tasks of the quests on the go that want it (on their map, when they say). */
  private credit(monster: Monster): void {
    for (const q of this.quests.values()) {
      if (q.completed || this.isReady(q)) continue;
      for (const i of this.currentTasks(q)) {
        const task = q.quest.tasks[i];
        if (task.type !== 'KillMonster' && task.type !== 'GainItem') continue;
        if (task.monsters?.some(([name, map]) => name.toLowerCase() === monster.name.toLowerCase() && (map === undefined || map === monster.map))) q.done[i]++;
      }
      if (this.isReady(q)) this.events.push({ t: this.t, type: 'quest', key: q.quest.key ?? q.quest.name, what: 'ready' });
    }
  }

  private talked(npc: number): void {
    for (const q of this.quests.values()) {
      if (q.completed) continue;
      for (const i of this.currentTasks(q)) if (q.quest.tasks[i].type === 'TalkToNPC' && q.quest.tasks[i].npc === npc) q.done[i] = q.quest.tasks[i].amount;
    }
  }

  /** Marks the quest's tasks done (as if the player did them). */
  finishQuest(key: string): void {
    const q = this.quests.get(key);
    if (q) q.done = q.quest.tasks.map((t) => t.amount);
  }

  questState(key: string): 'completed' | 'ready' | 'active' | undefined {
    const q = this.quests.get(key);
    return !q ? undefined : q.completed ? 'completed' : this.isReady(q) ? 'ready' : 'active';
  }

  // ---- Things that happen to the player ----

  kill(): void {
    this.player.dead = true;
    this.rightHeld = false;
    this.move = null;
  }

  // ---- What the memory reader would read ----

  private title(): string {
    const thing = this.objectAt(this.tileAt(this.cursor));
    return `Legend of Mir III - Xtreme Edition - Mouse Object: ${thing ? `${thing.name}, ${thing.x}:${thing.y}` : ''}`;
  }

  private survival(): NonNullable<MemoryState['survival']> {
    const npcMenu = this.open.has('npcMenu') && this.menuNpc
      ? {
          quests: this.menuNpc.menu!.includes('quests') ? button(700, 260, 'Quests') : null,
          talk: this.menuNpc.menu!.includes('talk') ? button(800, 260, 'Talk') : null,
          waypoints: this.menuNpc.menu!.includes('waypoints') ? button(900, 260, 'Waypoints') : null,
        }
      : undefined;
    const atList = this.listNpc ? this.questsAt(this.listNpc.npc) : null;
    return {
      arcadia: this.player.dead ? null : button(1550, 760, 'Return to Arcadia', this.arcadiaAt === null, 36, 36),
      death: this.player.dead ? { returnButton: button(DEATH_BOX.x + 100, DEATH_BOX.y + 100, 'Return', this.reviveAt === null) } : undefined,
      bag: { used: this.bag.used, slots: this.bag.slots, weight: 100, maxWeight: 1000 },
      sell: this.open.has('sell')
        ? {
            selectAll: button(SELL_BOX.x + 20, SELL_BOX.y + 440, 'Select All'),
            sell: button(SELL_BOX.x + 140, SELL_BOX.y + 440, 'Sell', this.selected > 0),
            value: String(this.selected * 10),
            close: button(SELL_BOX.x + SELL_BOX.width - 30, SELL_BOX.y + 6, 'X', true, 20, 20),
          }
        : undefined,
      inventory: { open: this.open.has('sell'), section: 0, mainTab: button(BAG_BOX.x + 10, BAG_BOX.y + 10, 'Main', true, 60, 20) },
      npcDialog: this.open.has('dialog'),
      npcMenu,
      questList: this.open.has('questList') && this.listNpc && atList
        ? {
            npc: this.listNpc.npc,
            acceptAll: button(QUEST_BOX.x + 20, QUEST_BOX.y + 440, 'Accept All', atList.offered.length > 0),
            handIn: button(QUEST_BOX.x + 140, QUEST_BOX.y + 440, 'Hand In', atList.ready.length > 0),
            quests: [...atList.offered.map((q) => q.name), ...atList.ready.map((q) => q.quest.name)],
          }
        : undefined,
      messages: [],
    };
  }

  reading(): MemoryState {
    this.update();
    const p = this.player;
    const map = this.currentMap();
    const targets: NonNullable<MemoryState['questTargets']> = [];
    const regions: { quest: string; region: number; map: number | null }[] = [];
    const talks: { quest: string; npc: number }[] = [];
    for (const q of this.quests.values()) {
      if (q.completed || this.isReady(q)) continue;
      for (const i of this.currentTasks(q)) {
        const task = q.quest.tasks[i];
        if (task.type === 'KillMonster' || task.type === 'GainItem') for (const [name, m] of task.monsters ?? []) targets.push({ name, map: m ?? null, quest: q.quest.name });
        else if (task.type === 'Region' && task.region) regions.push({ quest: q.quest.name, region: task.region.id, map: task.region.map });
        else if (task.type === 'TalkToNPC' && task.npc !== undefined) talks.push({ quest: q.quest.name, npc: task.npc });
      }
    }
    const strip = ({ map: _map, hits: _h, taken: _t, exp: _e, respawn: _r, home: _home, deadAt: _d, npc: _n, menu: _m, ...o }: Partial<Monster & Npc> & MemoryObject): MemoryObject => o;
    return {
      inGame: true,
      user: {
        name: p.name, x: p.x, y: p.y, pickUpRadius: 0, level: p.level, class: p.cls, mounted: p.mounted, hasMount: p.hasMount, dead: p.dead,
        experience: p.experience, maxExperience: 1_000_000_000,
      },
      objects: [...this.monsters.filter((m) => m.map === p.map && (!m.dead || this.t - m.deadAt < CORPSE_MS)), ...this.npcs.filter((n) => n.map === p.map)].map(strip),
      map: { index: map.index, name: map.name, width: map.width, height: map.height },
      waypoints: {
        unlocked: this.waypointsKnown ? (this.data.waypoints ?? []).filter((w) => this.unlocked.has(w.name)).map((w) => ({ name: w.name, map: w.map })) : [],
        open: this.open.has('waypoints'),
        rows: this.open.has('waypoints') ? this.waypointRows() : undefined,
        total: (this.data.waypoints ?? []).length,
        scroll: this.open.has('waypoints') ? { value: this.waypointScroll, max: (this.data.waypoints ?? []).length, up: null, down: null } : undefined,
      },
      windows: this.windowBoxes(),
      questTargets: targets,
      questLog: [...this.quests].map(([name, q]) => ({ name, completed: q.completed, ready: q.completed || this.isReady(q) })),
      questPending: { regions, talks },
      survival: this.survival(),
    };
  }

  // ---- For the tests ----

  get now(): number {
    return this.t;
  }

  /** The tiles from the player to the cursor's tile (larger of across and down). */
  cursorTiles(): number {
    return chebyshev(this.tileAt(this.cursor), this.player);
  }

  isOpen(name: Window): boolean {
    return this.open.has(name);
  }

  monster(name: string): MemoryObject | undefined {
    return this.monsters.find((m) => m.name === name);
  }
}

/** The shopkeeper Grind and Quests sell to (Ludvik, in Arcadia). */
const SHOP_NPC = 145;
/** Items Select All leaves (kept, or can't be sold). */
const KEPT_ITEMS = 2;
const WAYPOINT_ROWS = 10;
const WAYPOINT_BOX = { x: 450, y: 120, width: 600, height: 460 };
const QUEST_BOX = { x: 300, y: 120, width: 400, height: 500 };
const SELL_BOX = { x: 760, y: 120, width: 400, height: 500 };
const BAG_BOX = { x: 1170, y: 120, width: 300, height: 500 };
const DIALOG_BOX = { x: 300, y: 600, width: 500, height: 150 };
const DEATH_BOX = { x: 650, y: 300, width: 300, height: 160 };

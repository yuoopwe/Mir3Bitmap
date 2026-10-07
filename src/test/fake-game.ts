/**
 * A stand-in for the game, for running the bot's real loops in tests: the
 * window's input (GameInput), the memory reader (MemorySource) and the time
 * (Clock), all from one simulated world. It moves the player as the game does
 * (running with the right button held, a stride every STRIDE_MS in one of 8
 * directions; a step per left click; the player's tile changes as a move
 * starts, as the client has it, and the move then takes its time), changes maps on links' exit tiles, and
 * has monsters, NPCs, other players, items on the ground, the waypoint
 * window, quests, a shop (sold in rounds, from the bag window's Main tab),
 * death, Return to Arcadia (only out of combat, and back again from Arcadia),
 * the Town Portal scroll, the mount, a bag, gathering nodes and the profession
 * levels (read only once the Professions window has been opened). Time is virtual: every wait jumps ahead, so a
 * minute of play takes a moment. Everything it saw is in `events`, for the
 * tests to check.
 */
import type { Clock } from '../main/clock';
import { PLAYER_TILE, TILE_HEIGHT, TILE_WIDTH, type MemoryButton, type MemoryObject, type MemorySource, type MemoryState } from '../main/game-memory';
import { VK, type GameInput, type Handle } from '../main/input';
import { GAME_HEIGHT, GAME_WIDTH } from '../main/layout';
import { isWall, type MapGrid } from '../main/map-grid';
import { classFlagOf, loadTravelData, type TravelData, type TravelQuest } from '../main/travel';

/** A run moves a stride (2 tiles, 3 mounted) this often; a click's step takes STEP_MS. Positions change when a move starts. */
export const STRIDE_MS = 650;
export const STEP_MS = 600;
/** After a map change, moving waits this long (the new map loading). */
export const MAP_LOAD_MS = 400;
/** With the cursor this close to the player (in tiles), holding the right button runs nowhere. */
export const RUN_DEAD_ZONE = 2;
/** Return to Arcadia takes this long to cast; Return on the death window this long. */
const ARCADIA_CAST_MS = 1500;
/** Return to Arcadia only works this long after the last combat (the game's 10 s). */
export const OUT_OF_COMBAT_MS = 10_000;
/** The Town Portal scroll takes this long to read. */
const PORTAL_READ_MS = 1000;
/** The W key (the game's InventoryWindow key) opens and closes the bag. */
export const BAG_KEY = 0x57;
const REVIVE_MS = 500;
/** Dead monsters lie this long, then come back (when they respawn) after RESPAWN_MS more. */
const CORPSE_MS = 2000;
/** Aggressive monsters come at a player this close, a tile this often. */
const AGGRO_TILES = 8;
const MONSTER_STEP_MS = 500;
const RESPAWN_MS = 4000;
/** Explored blocks are this many tiles a side; the player uncovers this far around them. */
const BLOCK = 4;
const SIGHT = 12;
/** Every look at the clock costs this much time, so a loop that never waits still lets time pass. */
const CLOCK_TICK_MS = 0.1;
const ARCADIA = { map: 563, x: 647, y: 196 };
/** A pick takes this long; a picked node comes back this long after. */
const PICK_MS = 2000;
const NODE_RESPAWN_MS = 8 * 60_000;
/** Library.ProfessionId 1-7. */
const PROFESSION_NAMES = ['Fishing', 'Mining', 'Harvesting', 'Taming', 'Cooking', 'Crafting', 'Farming'];

export type FakeEvent =
  | { t: number; type: 'move'; map: number; from: { x: number; y: number }; to: { x: number; y: number }; run: boolean }
  | { t: number; type: 'runTooClose'; tiles: number }
  | { t: number; type: 'mapChange'; from: number; to: number; via: Via }
  | { t: number; type: 'attack'; name: string; level: number; disposition: number | null; killed: boolean }
  | { t: number; type: 'mount'; moving: boolean; mounted: boolean; map: number }
  | { t: number; type: 'key'; vk: number; down: boolean }
  | { t: number; type: 'window'; name: string; open: boolean }
  | { t: number; type: 'button'; name: string }
  | { t: number; type: 'quest'; key: string; what: 'accepted' | 'ready' | 'handedIn' }
  | { t: number; type: 'sold'; items: number }
  /** Return to Arcadia pressed while still in combat: the game says no. */
  | { t: number; type: 'refused'; what: 'arcadia'; combatAgo: number }
  | { t: number; type: 'pickup'; items: number; refused: boolean }
  /** A node clicked next to the player: refused (too low a level, or no tool), or picked (once the pick is done). */
  | { t: number; type: 'gather'; node: number; map: number; refused: boolean };

export type Via = 'link' | 'waypoint' | 'arcadia' | 'back' | 'revive' | 'portal';

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
  /** Comes at the player once within AGGRO_TILES, a tile every MONSTER_STEP_MS, and keeps them in combat while next to them. */
  aggressive?: boolean;
  /** Leaves an item of this name where it dies. */
  drops?: string;
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

/** A gathering node (`node`: its GatheringNodeInfo id in travel.json); `level`: the profession level the game asks (default the node's own). */
export interface FakeNode {
  node: number;
  x: number;
  y: number;
  map?: number;
  level?: number;
}

export interface FakeGameSetup {
  data?: TravelData;
  /** Map grids by index; any other map the player reaches is open floor, sized as travel.json has it. */
  maps?: MapGrid[];
  player: { map: number; x: number; y: number; level?: number; cls?: number; name?: string; mounted?: boolean; hasMount?: boolean; pickUpRadius?: number };
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
  /** How full the bag is; `refuse`: it won't take pickups (as when the game counts it full) until something is sold. */
  bag?: { used: number; slots: number; refuse?: boolean };
  /** The bag window: open at the start, and on which tab (0 = Main). */
  bagWindow?: { open?: boolean; section?: number };
  /** Items the sell panel takes in one round (Select All picks at most this many); default 30. */
  sellPerRound?: number;
  /** Selling asks "are you sure?" (a message box with Yes). */
  sellConfirm?: boolean;
  /** Items on the ground. */
  items?: { name: string; x: number; y: number; map?: number }[];
  /** Other players standing about (they don't block the way: in towns you walk through people). */
  players?: { name: string; x: number; y: number; map?: number }[];
  /** Where the Town Portal scroll takes you, and its key (default '3'). */
  townPortal?: { map: number; x: number; y: number; key?: number };
  /**
   * Profession levels by Library.ProfessionId (default 1); `loaded`: read from the start, else only once the Professions
   * window has been opened (`neverLoads`: not even then).
   */
  professions?: { levels?: Record<number, number>; loaded?: boolean; neverLoads?: boolean };
  nodes?: FakeNode[];
  /** No gathering tool in the Toolbelt: every pick is refused. */
  noTool?: boolean;
}

interface Monster extends MemoryObject {
  map: number;
  drops?: string;
  aggressive: boolean;
  nextStepAt: number;
  hits: number;
  taken: number;
  exp: number;
  respawn: boolean;
  home: { x: number; y: number };
  deadAt: number;
}

interface Thing extends MemoryObject {
  map: number;
}

interface GatherPoint extends MemoryObject {
  map: number;
  required: number;
  exp: number;
  /** When the pick under way ends. */
  pickAt: number | null;
  pickedAt: number;
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

type Window = 'waypoints' | 'npcMenu' | 'questList' | 'sell' | 'dialog' | 'professions';

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
  readonly player: { map: number; x: number; y: number; level: number; cls: number; name: string; mounted: boolean; hasMount: boolean; dead: boolean; experience: number; pickUpRadius: number };
  bag: { used: number; slots: number; refuse: boolean };
  /** The bag window, and the tab showing (0 = Main). */
  bagWindow: { open: boolean; section: number };
  /** Sellable items picked with Select All, and "are you sure?" up for them. */
  private selected = 0;
  private confirming = false;
  private readonly sellPerRound: number;
  private readonly sellConfirm: boolean;
  /** When the player was last in combat (hitting a monster, or hit by one). */
  private lastCombatAt = -Infinity;
  /** Where Return to Arcadia was pressed from: pressed again in Arcadia, it takes you back there. */
  private returnTo: { map: number; x: number; y: number } | null = null;
  private portalAt: number | null = null;
  private readonly townPortal: { map: number; x: number; y: number; key: number };
  private readonly items: Thing[] = [];
  private readonly people: Thing[] = [];
  private readonly nodes: GatherPoint[] = [];
  private readonly noTool: boolean;
  /** Profession levels and experience by id; the reader only has them once the Professions window has been opened. */
  private readonly professionLevels = new Map<number, number>();
  private readonly professionExp = new Map<number, number>();
  private professionsLoaded: boolean;
  private readonly professionsNeverLoad: boolean;

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
  private move: { path: { x: number; y: number }[]; at: number; run: boolean } | null = null;
  private loadedAt = 0;
  /** A monster clicked from afar: walked up to, a step at a time, until next to it (or something else is done). */
  private chasing: Monster | null = null;
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
    this.player = {
      map: p.map, x: p.x, y: p.y, level: p.level ?? 10, cls: p.cls ?? 0, name: p.name ?? 'Tester', mounted: p.mounted ?? false, hasMount: p.hasMount ?? true,
      dead: false, experience: 0, pickUpRadius: p.pickUpRadius ?? 0,
    };
    this.bag = { used: 10, slots: 40, refuse: false, ...setup.bag };
    this.bagWindow = { open: setup.bagWindow?.open ?? false, section: setup.bagWindow?.section ?? 0 };
    this.sellPerRound = setup.sellPerRound ?? 30;
    this.sellConfirm = setup.sellConfirm ?? false;
    this.townPortal = { map: 6, x: 190, y: 156, key: 0x33, ...setup.townPortal };
    for (const i of setup.items ?? []) this.addItem(i.name, i.x, i.y, i.map ?? p.map);
    for (const n of setup.nodes ?? []) this.addNode(n);
    this.noTool = !!setup.noTool;
    for (const [id, level] of Object.entries(setup.professions?.levels ?? {})) this.professionLevels.set(Number(id), level);
    this.professionsLoaded = !!setup.professions?.loaded;
    this.professionsNeverLoad = !!setup.professions?.neverLoads;
    for (const o of setup.players ?? []) this.people.push({ id: this.nextId++, kind: 'player', name: o.name, x: o.x, y: o.y, dead: false, level: 30, pet: false, map: o.map ?? p.map });
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
      keyChord: (_hwnd, modifiers, vk) => {
        for (const m of modifiers) game.key(m, true);
        game.key(vk, true);
        game.key(vk, false);
        for (const m of [...modifiers].reverse()) game.key(m, false);
      },
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
      respawn: m.respawn ?? false, home: { x: m.x, y: m.y }, deadAt: 0, aggressive: m.aggressive ?? false, nextStepAt: 0, drops: m.drops,
    });
  }

  addNode(n: FakeNode): void {
    const info = this.data.gathering?.nodes.find((g) => g.id === n.node);
    if (!info) throw new Error(`No gathering node ${n.node}`);
    this.nodes.push({
      id: this.nextId++, kind: 'node', name: info.name, x: n.x, y: n.y, dead: false, level: 0, pet: false, node: n.node, mining: info.kind === 'ore', harvested: false,
      map: n.map ?? this.player.map, required: n.level ?? info.level, exp: info.exp, pickAt: null, pickedAt: 0,
    });
  }

  addItem(name: string, x: number, y: number, map = this.player.map): void {
    this.items.push({ id: this.nextId++, kind: 'item', name, x, y, dead: false, level: 0, pet: false, map });
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

  private objectAt(tile: { x: number; y: number }): Monster | Npc | GatherPoint | undefined {
    const map = this.player.map;
    return (
      this.monsters.find((m) => m.map === map && !m.dead && m.x === tile.x && m.y === tile.y) ??
      this.npcs.find((n) => n.map === map && n.x === tile.x && n.y === tile.y) ??
      this.nodes.find((n) => n.map === map && !n.harvested && n.x === tile.x && n.y === tile.y)
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
      if (!this.move && this.chasing && this.chaseStep()) continue;
      break;
    }
    if (this.arcadiaAt !== null && this.t >= this.arcadiaAt) {
      this.arcadiaAt = null;
      // From Arcadia, back to where it was pressed; else to Arcadia, remembering where from.
      if (this.player.map === ARCADIA.map) {
        const back = this.returnTo;
        this.returnTo = null;
        if (back) this.teleport(back.map, back.x, back.y, 'back');
      } else {
        this.returnTo = { map: this.player.map, x: this.player.x, y: this.player.y };
        this.teleport(ARCADIA.map, ARCADIA.x, ARCADIA.y, 'arcadia');
      }
    }
    if (this.portalAt !== null && this.t >= this.portalAt) {
      this.portalAt = null;
      this.teleport(this.townPortal.map, this.townPortal.x, this.townPortal.y, 'portal');
    }
    if (this.reviveAt !== null && this.t >= this.reviveAt) {
      this.reviveAt = null;
      this.player.dead = false;
      this.teleport(ARCADIA.map, ARCADIA.x, ARCADIA.y, 'revive');
    }
    for (const n of this.nodes) {
      if (n.pickAt !== null && this.t >= n.pickAt) this.picked(n);
      if (n.harvested && this.t - n.pickedAt >= NODE_RESPAWN_MS) n.harvested = false;
    }
    for (const m of this.monsters) {
      if (!m.dead && m.aggressive) this.closeIn(m);
      if (!m.dead) continue;
      if (m.respawn && this.t - m.deadAt >= CORPSE_MS + RESPAWN_MS && this.free(m.map, m.home)) Object.assign(m, { dead: false, taken: 0, x: m.home.x, y: m.home.y });
    }
  }

  /** An aggressive monster near the player steps toward them (up to next to them). */
  private closeIn(m: Monster): void {
    for (; m.nextStepAt <= this.t; m.nextStepAt += MONSTER_STEP_MS) {
      if (m.map !== this.player.map || this.player.dead) {
        m.nextStepAt = this.t + MONSTER_STEP_MS;
        return;
      }
      const away = chebyshev(m, this.player);
      // Next to the player it attacks: still in combat.
      if (away <= 1) this.lastCombatAt = m.nextStepAt;
      if (away <= 1 || away > AGGRO_TILES) continue;
      const to = { x: m.x + Math.sign(this.player.x - m.x), y: m.y + Math.sign(this.player.y - m.y) };
      if (this.floor(to.x, to.y) && !(this.move && this.move.path.some((t) => t.x === to.x && t.y === to.y))) Object.assign(m, to);
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
    this.beginMove(path, STRIDE_MS, true);
    return true;
  }

  /** A move starts: the player's tile changes now (as the client has it), and the move takes `ms` to play out. */
  private beginMove(path: { x: number; y: number }[], ms: number, run: boolean): void {
    this.move = { path, at: this.t + ms, run };
    const from = { x: this.player.x, y: this.player.y };
    // Through an exit tile on the way: off to the other map.
    for (const tile of path) {
      const link = this.data.links.find((l) => l.from === this.player.map && !l.waypoint && !l.needs && l.exit.some(([x, y]) => x === tile.x && y === tile.y));
      if (link) {
        this.events.push({ t: this.t, type: 'move', map: this.player.map, from, to: tile, run });
        this.teleport(link.to, link.land[0], link.land[1], 'link');
        return;
      }
    }
    const to = path[path.length - 1];
    this.player.x = to.x;
    this.player.y = to.y;
    this.events.push({ t: this.t, type: 'move', map: this.player.map, from, to, run });
    this.reveal();
  }

  private finishMove(): void {
    this.lastMoveEnd = this.move!.at;
    this.move = null;
  }

  private teleport(map: number, x: number, y: number, via: Via): void {
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
    if (down) this.chasing = null;
    this.update();
  }

  private key(vk: number, down: boolean): void {
    this.update();
    this.events.push({ t: this.t, type: 'key', vk, down });
    if (down) {
      this.keysDown.add(vk);
      if (vk === VK.ESCAPE) this.escape();
      if (vk === BAG_KEY) this.bagWindow.open = !this.bagWindow.open;
      if (vk === this.townPortal.key && !this.player.dead) this.portalAt ??= this.t + PORTAL_READ_MS;
      // Ctrl+Shift+P opens and shuts the Professions window.
      if (vk === VK.P && this.keysDown.has(VK.CONTROL) && this.keysDown.has(VK.SHIFT)) {
        if (this.open.has('professions')) this.close('professions');
        else this.openWindow('professions');
      }
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
    const order: Window[] = ['waypoints', 'questList', 'sell', 'npcMenu', 'dialog', 'professions'];
    const top = order.find((w) => this.open.has(w));
    if (top) this.close(top);
  }

  private openWindow(name: Window): void {
    if (this.open.has(name)) return;
    this.open.add(name);
    if (name === 'waypoints') this.waypointsKnown = true;
    if (name === 'professions' && !this.professionsNeverLoad) this.professionsLoaded = true;
    this.events.push({ t: this.t, type: 'window', name, open: true });
  }

  private close(name: Window): void {
    if (!this.open.delete(name)) return;
    if (name === 'npcMenu') this.menuNpc = null;
    if (name === 'questList') this.listNpc = null;
    if (name === 'sell') {
      this.selected = 0;
      this.confirming = false;
    }
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
    this.chasing = null;
    if (thing?.kind === 'monster') return this.attack(thing as Monster);
    if (thing?.kind === 'npc') return this.clickNpc(thing as Npc);
    if (thing?.kind === 'node') return this.clickNode(thing as GatherPoint);
    if (tile.x === this.player.x && tile.y === this.player.y) return this.pickUp();
    this.step(tile);
  }

  /** A node clicked: from afar a step toward it; next to it, a pick (refused when the level is too low or there's no tool). */
  private clickNode(node: GatherPoint): void {
    if (chebyshev(node, this.player) > 1) return this.step(node);
    if (node.pickAt !== null) return;
    if (this.noTool || this.profession(node.mining ? 2 : 3) < node.required) {
      this.events.push({ t: this.t, type: 'gather', node: node.node!, map: node.map, refused: true });
      return;
    }
    node.pickAt = this.t + PICK_MS;
  }

  /** A pick done: the node is spent for a while, the bag takes what it gave, and the profession its experience. */
  private picked(node: GatherPoint): void {
    node.pickAt = null;
    node.harvested = true;
    node.pickedAt = this.t;
    this.bag.used++;
    const id = node.mining ? 2 : 3;
    this.professionExp.set(id, (this.professionExp.get(id) ?? 0) + node.exp);
    this.events.push({ t: this.t, type: 'gather', node: node.node!, map: node.map, refused: false });
  }

  private profession(id: number): number {
    return this.professionLevels.get(id) ?? 1;
  }

  /** A click at the feet: picks up what's within reach, unless the bag won't take it. */
  private pickUp(): void {
    const reach = this.items.filter((i) => i.map === this.player.map && chebyshev(i, this.player) <= this.player.pickUpRadius);
    if (!reach.length) return;
    this.events.push({ t: this.t, type: 'pickup', items: reach.length, refused: this.bag.refuse });
    if (this.bag.refuse) return;
    for (const i of reach) this.items.splice(this.items.indexOf(i), 1);
    this.bag.used += reach.length;
  }

  /** A step toward the tile (when nothing's under way). */
  private step(tile: { x: number; y: number }): void {
    if (this.move || this.t < this.loadedAt) return;
    const dir = { x: Math.sign(tile.x - this.player.x), y: Math.sign(tile.y - this.player.y) };
    if (!dir.x && !dir.y) return;
    const to = { x: this.player.x + dir.x, y: this.player.y + dir.y };
    if (!this.floor(to.x, to.y)) return;
    this.beginMove([to], STEP_MS, false);
  }

  /** The next step toward the monster being chased; false when there's no more chasing to do. */
  private chaseStep(): boolean {
    const target = this.chasing!;
    if (target.dead || target.map !== this.player.map || chebyshev(target, this.player) <= 1 || this.t < this.loadedAt) {
      this.chasing = null;
      return false;
    }
    this.step(target);
    if (!this.move) this.chasing = null;
    return !!this.move;
  }

  private attack(monster: Monster): void {
    if (chebyshev(monster, this.player) > 1) {
      // Out of reach: the character walks up to it.
      this.chasing = monster;
      return void this.update();
    }
    const guard = monster.disposition === 0;
    if (!guard) {
      monster.taken++;
      this.lastCombatAt = this.t;
    }
    const killed = !guard && monster.taken >= monster.hits;
    this.events.push({ t: this.t, type: 'attack', name: monster.name, level: monster.level, disposition: monster.disposition ?? null, killed });
    if (!killed) return;
    monster.dead = true;
    monster.deadAt = this.t;
    if (monster.drops) this.addItem(monster.drops, monster.x, monster.y, monster.map);
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
    for (const message of reading.messages ?? []) for (const b of message.buttons) out.push([b.name, b, () => this.sold()]);
    if (reading.sell) {
      // Select All picks from the bag window's open tab (nothing with the bag shut), as many as the panel holds.
      out.push(['Select All', reading.sell.selectAll, () => {
        const sellable = this.bagWindow.open && this.bagWindow.section === 0 ? Math.max(0, this.bag.used - KEPT_ITEMS) : 0;
        this.selected = Math.min(this.sellPerRound, sellable);
      }]);
      out.push(['Sell', reading.sell.sell, () => (this.sellConfirm ? (this.confirming = true) : this.sold())]);
      out.push(['Close shop', reading.sell.close ?? null, () => this.close('sell')]);
    }
    if (reading.inventory?.open) out.push(['Main tab', reading.inventory.mainTab, () => (this.bagWindow.section = 0)]);
    if (reading.arcadia) {
      out.push(['Return to Arcadia', reading.arcadia, () => {
        const ago = this.t - this.lastCombatAt;
        if (ago < OUT_OF_COMBAT_MS) this.events.push({ t: this.t, type: 'refused', what: 'arcadia', combatAgo: ago / 1000 });
        else this.arcadiaAt ??= this.t + ARCADIA_CAST_MS;
      }]);
    }
    return out;
  }

  /** The picked items go, for gold; the bag takes pickups again. */
  private sold(): void {
    this.confirming = false;
    if (!this.selected) return;
    this.events.push({ t: this.t, type: 'sold', items: this.selected });
    this.bag.used -= this.selected;
    this.bag.refuse = false;
    this.selected = 0;
  }

  private windowBoxes(): { x: number; y: number; width: number; height: number; name: string }[] {
    const boxes: { x: number; y: number; width: number; height: number; name: string }[] = [];
    if (this.open.has('waypoints')) boxes.push({ name: 'WaypointDialog', ...WAYPOINT_BOX });
    if (this.open.has('questList')) boxes.push({ name: 'NPCQuestListDialog', ...QUEST_BOX });
    if (this.open.has('sell')) boxes.push({ name: 'NPCSellDialog', ...SELL_BOX });
    if (this.bagWindow.open) boxes.push({ name: 'InventoryDialog', ...BAG_BOX });
    if (this.confirming) boxes.push({ name: 'MessageBox', ...MESSAGE_BOX });
    if (this.open.has('dialog')) boxes.push({ name: 'NPCDialog', ...DIALOG_BOX });
    if (this.player.dead) boxes.push({ name: 'DeathDialog', ...DEATH_BOX });
    if (this.open.has('professions')) boxes.push({ name: 'ProfessionsBox', ...PROFESSIONS_BOX });
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

  /** The profession goes up (or down) to this level. */
  setProfession(id: number, level: number): void {
    this.professionLevels.set(id, level);
  }

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
      inventory: { open: this.bagWindow.open, section: this.bagWindow.section, mainTab: this.bagWindow.open ? button(BAG_BOX.x + 10, BAG_BOX.y + 10, 'Main', true, 60, 20) : null },
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
      messages: this.confirming ? [{ text: 'Sell the selected items?', buttons: [{ ...button(MESSAGE_BOX.x + 40, MESSAGE_BOX.y + 90, 'Yes'), name: 'YesButton' }] }] : [],
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
    const strip = ({ map: _map, hits: _h, taken: _t, exp: _e, respawn: _r, home: _home, deadAt: _d, npc: _n, menu: _m, aggressive: _a, nextStepAt: _s, drops: _dr, required: _rq, pickAt: _pa, pickedAt: _pd, ...o }: Partial<Monster & Npc & GatherPoint> & MemoryObject): MemoryObject => o;
    return {
      inGame: true,
      user: {
        name: p.name, x: p.x, y: p.y, pickUpRadius: p.pickUpRadius, level: p.level, class: p.cls, mounted: p.mounted, hasMount: p.hasMount, dead: p.dead,
        experience: p.experience, maxExperience: 1_000_000_000,
        combatAgo: this.lastCombatAt === -Infinity ? 9999 : Math.round((this.t - this.lastCombatAt) / 100) / 10,
      },
      objects: [
        ...this.monsters.filter((m) => m.map === p.map && (!m.dead || this.t - m.deadAt < CORPSE_MS)),
        ...this.npcs.filter((n) => n.map === p.map),
        ...this.people.filter((o) => o.map === p.map),
        ...this.items.filter((i) => i.map === p.map),
        ...this.nodes.filter((n) => n.map === p.map),
      ].map(strip),
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
      professions: this.professionsLoaded
        ? PROFESSION_NAMES.map((name, i) => {
            const level = this.profession(i + 1);
            return { id: i + 1, name, level, usable: level, exp: this.professionExp.get(i + 1) ?? 0, toNext: 1000, canGain: true, lockReason: null };
          })
        : null,
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

  /** Items still on the ground. */
  get groundItems(): number {
    return this.items.length;
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
const MESSAGE_BOX = { x: 650, y: 500, width: 300, height: 130 };
const PROFESSIONS_BOX = { x: 500, y: 150, width: 600, height: 500 };

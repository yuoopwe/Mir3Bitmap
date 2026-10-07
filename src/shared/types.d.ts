export interface Point {
  x: number;
  y: number;
}

export type KeyId =
  | 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6'
  | 'F7' | 'F8' | 'F9' | 'F10' | 'F11' | 'F12'
  | 'N1';

export interface KeySetting {
  enabled: boolean;
  /** Minimum whole seconds between presses. */
  seconds: number;
}

/** Waits around each kind of action, in milliseconds. */
export interface Delays {
  /** How long the mouse is held on a monster. */
  attackClick: number;
  pickUpClick: number;
  /** After pressing F2-F5. */
  quickKey: number;
  /** Around F6-F12, so buffs aren't swallowed by another cast. */
  buffKey: number;
  /** Before pressing the item key (1). */
  itemKey: number;
  /** Between steps when travelling. */
  runStep: number;
  /** Between clicks and key presses while selling. */
  menu: number;
}

/** A key the bot can press: '1'-'9', 'A'-'Z', 'F1'-'F12', 'Tab', 'Space' or '`'; '' for none. */
export type BindableKey = string;

export interface HuntSettings {
  /** When no monsters are in view, head for one on the minimap (or wander). */
  roam: boolean;
  /** With the memory reader: only attack (and seek) monsters an unfinished quest task still needs. */
  questOnly?: boolean;
  /** Grind: back to Arcadia when the bag has this few slots free (or is this close to its weight limit, in %). */
  bagFreeSlots?: number;
  bagWeightPercent?: number;
  /** Pick up items lying nearby (after kills, and when idle). */
  loot: boolean;
  /** Extra key pressed after walking onto an item, if the client uses one. */
  pickUpKey: BindableKey;
  /** Grind and Quests: the Town Portal scroll's key, used when Return to Arcadia can't be (still in combat after a minute). */
  townPortalKey?: BindableKey;
  hpPotionKey: BindableKey;
  /** Drink when HP falls below this percentage. */
  hpPotionPercent: number;
  mpPotionKey: BindableKey;
  mpPotionPercent: number;
  /** A free random teleport to anywhere explored (unlocks at 60% explored), used while exploring when far from unexplored ground. */
  randomTeleportKey: BindableKey;
  /** A teleport skill, pressed while exploring (aiming where the bot wants to go) when off cooldown and when stuck. */
  unstuckKey: BindableKey;
}

/** Grind mode: levels the character up on the best map for their level (src/main/grind.ts). */
export interface GrindSettings {
  /** Plan again (and maybe move on) after hunting this many minutes on a map; a new level plans again too. */
  replanMinutes: number;
  /**
   * The most levels above the character Grind fights (monsters further above count as too strong): a cap. Within it,
   * Grind picks how far by itself, from what kills above the level cost in health and from deaths (grind.ts autoLevelsAbove).
   */
  maxLevelsAbove: number;
  /** While unfinished quests need monsters killed, grind only where they spawn (when one can be reached). */
  questsFirst?: boolean;
}

export interface Settings {
  windowTitle: string;
  /** 'print' works while the game is covered by other windows; 'blt' is faster but needs it visible. */
  capture: 'print' | 'blt';
  attack: boolean;
  /** Archer: attack by holding the left button down on the target until it dies. */
  archer: boolean;
  /** Pause whatever the bot is doing while the user's mouse is over the game window. */
  pauseOnMouse: boolean;
  /** Monster names Hunt leaves alone (when it reads the game's memory). */
  skipMonsters: string[];
  sellItems: boolean;
  keys: Record<KeyId, KeySetting>;
  delays: Delays;
  /** Every wait is randomly lengthened or shortened by up to this percentage. */
  fuzzPercent: number;
  hunt: HuntSettings;
  /** Explore mode stops once this much of the map is uncovered (or nothing reachable is left). */
  explorePercent: number;
  /** Start Explore again by itself if it stops with an error. */
  exploreAutoRestart: boolean;
  /** Use the teleport key while exploring (not every character has a teleport). */
  exploreTeleport: boolean;
  /** Gather mode: pick plants (Scavenging Dagger) and/or mine ore (Pick Axe). */
  gatherPlants: boolean;
  gatherOre: boolean;
  /** Gather mode: go where the profession levels gather best (src/main/gather-planner.ts) instead of where you stand. */
  gatherTrips?: boolean;
  /** Travel and Explore: fight monsters that block the way (or crowd round) instead of only walking round them. */
  fightInTheWay: boolean;
  /** Train mode: the spell key cast on the character over and over, and how often. */
  trainKey: BindableKey;
  trainIntervalMs: number;
  grind: GrindSettings;
  /** Quests mode: at most this many quests on the go at once (it picks up more as they're handed in). */
  questMaxActive?: number;
}

/** Somewhere Travel can go: a map or an NPC (id "map:<index>" or "npc:<index>"). */
export interface TravelPlace {
  id: string;
  label: string;
}

/**
 * How the bot treats a name it has seen. 'auto' attacks anything that isn't
 * known to be harmless; the others are the user's override.
 */
export type NameRule = 'auto' | 'attack' | 'ignore';

export interface NameEntry {
  /** Identifies the name (how the target frame writes it). */
  fingerprint: string;
  /** PNG data URL of the name as drawn in game. */
  image: string;
  rule: NameRule;
  kills: number;
  /** Fights where it never lost HP (herbs, pets, trees...). */
  strikes: number;
  /** Whether it's currently attacked. */
  attacking: boolean;
}

export interface Status {
  mode: 'idle' | 'attack' | 'explore' | 'triad' | 'deck' | 'gather' | 'train' | 'travel' | 'grind' | 'quest';
  message: string;
  /** Time spent grabbing the last frame from the game window. */
  captureMs?: number;
  /** Time spent scanning the last frame. */
  scanMs?: number;
  /** Player HP and MP from the bottom bars, 0-1. */
  hp?: number | null;
  mp?: number | null;
  kills?: number;
  /** Share of the current map uncovered, 0-1, from the last look at the big map. */
  explored?: number | null;
  stats?: Stats;
}

/** What the bot has done (counted by src/main/session-stats.ts). */
export interface StatCounts {
  /** Targets that died while being attacked; without the memory reader, gone from view (as the kills in Status). */
  kills: number;
  /** Items that were in reach and then gone from the game's memory; without the memory reader, pick-up tries after kills. */
  items: number;
  gathered: number;
  /** Triple Triad matches finished; won, lost or drawn only when the final board was read from the game's memory. */
  triadPlayed: number;
  triadWon: number;
  triadLost: number;
  triadDrawn: number;
  /** Best deck runs that changed the deck (not "already the best"). */
  decks: number;
  /** Time spent running a mode, in milliseconds. */
  runningMs: number;
}

export interface Stats {
  /** Since the app started or Reset was pressed. */
  session: StatCounts;
  /** Everything ever counted: the window keeps it between runs of the app. */
  allTime: StatCounts;
}

export interface BotApi {
  startAttack(): Promise<void>;
  startExplore(): Promise<void>;
  startTriad(): Promise<void>;
  startTrain(): Promise<void>;
  /** Puts the best five cards owned into the Triple Triad deck (the card collection window must be open). */
  startDeck(): Promise<void>;
  /** Walks to gathering nodes on screen and gathers them, wandering when there are none. */
  startGather(): Promise<void>;
  /** Goes to a map or an NPC, by its id from searchPlaces. */
  startTravel(placeId: string): Promise<void>;
  /** Levels the character up: the best map for their level, travelled to and hunted on, moving on when outgrown. */
  startGrind(): Promise<void>;
  /** Picks up quests for your level, does them and hands them in (src/main/bot-quests.ts questLoop). */
  startQuests(): Promise<void>;
  /** Maps and NPCs whose names match what's typed. */
  searchPlaces(query: string): Promise<TravelPlace[]>;
  stop(): Promise<void>;
  updateSettings(settings: Settings): Promise<void>;
  listNames(): Promise<NameEntry[]>;
  setNameRule(fingerprint: string, rule: NameRule): Promise<void>;
  forgetName(fingerprint: string): Promise<void>;
  /** Hands the bot the all-time totals the window saved (anything unreadable is ignored); returns the stats to show. */
  loadStats(saved: unknown): Promise<Stats>;
  /** Clears this session's counts (the all-time totals keep them); returns the stats to show. */
  resetStats(): Promise<Stats>;
  onStatus(listener: (status: Status) => void): void;
  onNames(listener: (names: NameEntry[]) => void): void;
  /** Monster names seen in the game's memory while hunting. */
  onMonsters(listener: (names: string[]) => void): void;
}

/**
 * Runs the real Bot against a FakeGame (src/test/fake-game.ts) for the
 * scenario tests: the settings the app starts with (fuzz off, so waits are
 * exact), a seeded Math.random, and a run with a time limit in game time.
 */
import type { KeyId, Settings, Status } from '../shared/types';
import { Bot } from '../main/bot';
import { GrindLog } from '../main/grind-log';
import { NameBook } from '../main/names';
import { TriadMemory } from '../main/triad-memory';
import type { FakeGame } from './fake-game';

const KEY_IDS: KeyId[] = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'N1'];

/** main.ts's defaults, with no random fuzz and no teleport key (the fake has no teleport). */
export function testSettings(changes: Partial<Settings> = {}): Settings {
  return {
    windowTitle: 'Legend of Mir III - Xtreme Edition',
    capture: 'print',
    attack: false,
    archer: false,
    skipMonsters: [],
    pauseOnMouse: false,
    sellItems: false,
    keys: Object.fromEntries(KEY_IDS.map((id) => [id, { enabled: false, seconds: 0 }])) as Settings['keys'],
    delays: { attackClick: 200, pickUpClick: 50, quickKey: 100, buffKey: 1500, itemKey: 1000, runStep: 400, menu: 200 },
    fuzzPercent: 0,
    explorePercent: 95,
    exploreAutoRestart: false,
    exploreTeleport: false,
    gatherPlants: true,
    gatherOre: true,
    gatherTrips: false,
    fightInTheWay: false,
    trainKey: 'F1',
    trainIntervalMs: 1000,
    questMaxActive: 5,
    grind: { replanMinutes: 15, maxLevelsAbove: 5, questsFirst: false },
    hunt: { roam: false, questOnly: false, bagFreeSlots: 5, bagWeightPercent: 95, loot: false, pickUpKey: '', hpPotionKey: '', hpPotionPercent: 50, mpPotionKey: '', mpPotionPercent: 30, unstuckKey: '', randomTeleportKey: '' },
    ...changes,
  };
}

/** A small, fast, seeded stand-in for Math.random (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Played {
  /** Every status line, in order. */
  statuses: Status[];
  /** How the run ended (the last status line). */
  message: string;
  /** Whether `until` was met (else the run ended by itself, or ran out of time). */
  met: boolean;
  bot: Bot;
}

/**
 * Starts the bot on the game (`start` picks the mode) and lets it run until it
 * stops by itself, `until` holds (checked between the bot's steps; the bot is
 * then stopped), or `limitMs` of game time has passed.
 */
export async function play(
  game: FakeGame,
  start: (bot: Bot) => void,
  options: { settings?: Partial<Settings>; until?: () => boolean; limitMs?: number; seed?: number; during?: () => void } = {},
): Promise<Played> {
  const statuses: Status[] = [];
  const bot = new Bot(testSettings(options.settings), {
    report: (status) => statuses.push(status),
    names: new NameBook(() => {}),
    triad: new TriadMemory(() => {}),
    imageOf: () => '',
    memory: game.memory,
    input: game.input,
    clock: game.clock,
    grindLog: new GrindLog(() => {}),
  });
  const random = Math.random;
  Math.random = seeded(options.seed ?? 1);
  const limit = game.now + (options.limitMs ?? 5 * 60_000);
  let met = false;
  try {
    start(bot);
    await new Promise<void>((resolve) => {
      const tick = () => {
        const last = statuses.at(-1);
        if (statuses.length > 1 && last?.mode === 'idle') return resolve();
        options.during?.();
        if (!met && options.until?.()) {
          met = true;
          bot.stop();
        } else if (game.now > limit) bot.stop();
        setImmediate(tick);
      };
      setImmediate(tick);
    });
  } finally {
    Math.random = random;
  }
  return { statuses, message: statuses.at(-1)?.message ?? '', met, bot };
}

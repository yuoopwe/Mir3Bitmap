/**
 * The bot: what the control window starts and stops (Hunt, Explore, Travel,
 * Gather, Triple Triad, Best deck, Train, Quests, Grind), and its stats. Each
 * mode's work is in its own part (bot-*.ts), sharing a BotContext.
 */

import type { AreaView, Settings, Stats, Status } from '../shared/types';
import { areaView } from './area-index';
import { CLASS_NAMES, fighterOf, unpackFighter } from './combat-model';
import { loadTravelData } from './travel';
import { GAME_HEIGHT, GAME_WIDTH } from './layout';
import { BotError, Stopped, ViewError } from './bot-shared';
import { BotContext, type BotOptions } from './bot-context';
import { Movement } from './bot-movement';
import { Travel } from './bot-travel';
import { Hunting } from './bot-hunting';
import { Exploring } from './bot-explore';
import { Survival } from './bot-survival';
import { Questing } from './bot-quests';
import { Grinding } from './bot-grind';
import { TripleTriad } from './bot-triad';
import { Gathering } from './bot-gathering';
import { GatherTrips } from './bot-gather-trips';
import { Looting } from './bot-loot';
import { BossCircuit } from './bot-circuit';
import { StatGuide } from './bot-guide';
import { Elixirs } from './bot-elixirs';
import { CompanionLoot } from './bot-companion';

export type { BotOptions } from './bot-context';

/** Checking gear: how long to wait for the memory reader's first reading with the character's gear. */
const CHECK_GEAR_WAIT_MS = 15_000;

/** The modes that work at any size of game with the memory reader: they place everything from the map view. */
const MEMORY_MODES: Status['mode'][] = ['attack', 'explore', 'travel', 'gather', 'quest', 'grind', 'circuit', 'triad', 'deck'];

/** What the rest are called, for the message. */
const SCREEN_MODE_NAMES: Partial<Record<Status['mode'], string>> = { train: 'Train' };

export class Bot {
  private readonly ctx: BotContext;

  constructor(settings: Settings, options: BotOptions) {
    const ctx = new BotContext(settings, options);
    ctx.moves = new Movement(ctx);
    ctx.travel = new Travel(ctx);
    ctx.hunting = new Hunting(ctx);
    ctx.explore = new Exploring(ctx);
    ctx.survival = new Survival(ctx);
    ctx.quests = new Questing(ctx);
    ctx.grind = new Grinding(ctx);
    ctx.triad = new TripleTriad(ctx);
    ctx.gathering = new Gathering(ctx);
    ctx.gatherTrips = new GatherTrips(ctx);
    ctx.loot = new Looting(ctx);
    ctx.circuit = new BossCircuit(ctx);
    ctx.guide = new StatGuide(ctx);
    ctx.elixirs = new Elixirs(ctx);
    ctx.companion = new CompanionLoot(ctx);
    this.ctx = ctx;
  }

  updateSettings(settings: Settings): void {
    this.ctx.settings = settings;
  }

  stop(): void {
    this.ctx.active = false;
  }

  /** Takes the all-time totals the window saved; returns the stats to show. */
  loadStats(saved: unknown): Stats {
    this.ctx.stats.restore(saved);
    return this.ctx.stats.snapshot(this.ctx.clock.now());
  }

  /** Clears this session's counts (all time keeps them); returns the stats to show. */
  resetStats(): Stats {
    this.ctx.stats.reset(this.ctx.clock.now());
    // The status line's kills too, so it agrees with the panel's "this session".
    this.ctx.kills = 0;
    this.ctx.loot.reset();
    return this.ctx.stats.snapshot(this.ctx.clock.now());
  }

  startAttack(): void {
    void this.run('attack', () => this.ctx.hunting.huntLoop());
  }

  startExplore(): void {
    this.ctx.explore.skipped = [];
    this.ctx.explore.stuckAt = [];
    this.ctx.explore.tracker.reset();
    this.ctx.explored = null;
    this.ctx.explore.planner.reset();
    this.ctx.explore.rerollsInRow = 0;
    this.ctx.explore.rerollPausedUntil = 0;
    void this.run('explore', () => this.ctx.explore.exploreWithRestarts());
  }

  startTriad(): void {
    void this.run('triad', () => this.ctx.triad.triadLoop());
  }

  startGather(): void {
    void this.run('gather', () => this.ctx.gathering.gatherLoop());
  }

  startDeck(): void {
    void this.run('deck', () => this.ctx.triad.deckLoop());
  }

  startTrain(): void {
    void this.run('train', () => this.ctx.gathering.trainLoop());
  }

  startTravel(placeId: string): void {
    void this.run('travel', () => this.ctx.travel.travelLoop(placeId));
  }

  startQuests(): void {
    void this.run('quest', () => this.ctx.quests.questLoop());
  }

  startCircuit(): void {
    void this.run('circuit', () => this.ctx.circuit.circuitLoop());
  }

  /**
   * Works the stat guide and the best gear out now, from what's worn and the bag, without starting anything: the
   * memory reader is started for it if it isn't running (and stopped again after, if nothing else started meanwhile).
   * Says what it found on the status line; the Stat guide card shows the rest.
   */
  async checkGear(): Promise<void> {
    const memory = this.ctx.options.memory;
    if (!memory.installed) {
      this.ctx.status('Checking gear needs the memory reader (run scripts/setup-game-reader.ps1).');
      return;
    }
    const idle = this.ctx.mode === 'idle';
    if (idle) memory.start();
    this.ctx.status('Checking your gear and bag');
    try {
      const ready = () => !!memory.latest()?.user?.combat && !!memory.latest()?.gear;
      for (const since = Date.now(); !ready() && Date.now() - since < CHECK_GEAR_WAIT_MS; ) await new Promise((resolve) => setTimeout(resolve, 200));
      if (!ready()) {
        this.ctx.status(`Couldn't read your gear (${memory.problem}): is the game running and in game?`);
        return;
      }
      this.ctx.guide.update();
      const advice = this.ctx.guide.gearAdvice();
      const swaps = advice?.plan.swaps.length ?? 0;
      const broken = advice?.broken.length ?? 0;
      const gain = advice && advice.expGain > 0 ? `, about +${Math.round(advice.expGain * 100)}% exp/h` : '';
      this.ctx.status(
        (swaps ? `Better gear: ${swaps} swap${swaps === 1 ? '' : 's'}${gain}` : 'Your gear is already the best of what you have') +
          (broken ? `; ${broken} worn item${broken === 1 ? ' is' : 's are'} broken` : '') +
          ' (Stat guide tab)',
      );
    } finally {
      if (idle && this.ctx.mode === 'idle') memory.stop();
    }
  }

  /**
   * A map for the Areas tab (area-index.ts), against the character as the game's memory has them (while a mode reads
   * it), else as their newest kill noted them; without either, the monsters alone.
   */
  async areaView(map: number): Promise<AreaView | null> {
    const reading = this.ctx.options.memory.latest();
    const user = reading?.user;
    let me = fighterOf(user, reading?.gear?.worn ?? []);
    let who = me && user ? `${user.name}, level ${me.level} ${CLASS_NAMES[me.cls] ?? ''} (now)` : undefined;
    if (!me) {
      const last = this.ctx.options.grindLog.latestKill();
      me = last ? unpackFighter(last.kill.stats, last.kill.level) : null;
      if (me && last) who = `${last.character}, level ${me.level} ${CLASS_NAMES[me.cls] ?? ''} (as of the last kill, ${new Date(last.kill.at).toLocaleString()})`;
    }
    return areaView(loadTravelData(), map, me, who);
  }

  /** Rates the maps for the character now, for the Grind tab's map choice (bot-grind.ts listMaps). */
  listGrindMaps(): Promise<void> {
    return this.ctx.grind.listMaps();
  }

  startGrind(): void {
    void this.run('grind', () => this.ctx.grind.grindLoop());
  }

  /**
   * A game of any size will do for the modes that go by the game's memory (Hunt with the reader, Explore, Travel,
   * Gather, Quests, Grind); the rest read the screen, which is measured at 1600x900 only.
   */
  private checkSize(mode: Status['mode'], size: { width: number; height: number }): void {
    const set = `set the game to ${GAME_WIDTH}x${GAME_HEIGHT}`;
    const game = `The game is ${size.width}x${size.height}`;
    if (!this.ctx.options.memory.installed) {
      throw new BotError(`${game}: without the memory reader the bot reads the screen, which needs ${GAME_WIDTH}x${GAME_HEIGHT}. Either ${set}, or set up the memory reader (scripts/setup-game-reader.ps1).`);
    }
    if (!MEMORY_MODES.includes(mode)) {
      throw new BotError(`${game}: ${SCREEN_MODE_NAMES[mode] ?? mode} reads the screen, which needs ${GAME_WIDTH}x${GAME_HEIGHT}: ${set} (Hunt, Explore, Travel, Gather, Quests, Grind, the Boss circuit, Triple Triad and Best deck work at any size with the memory reader).`);
    }
  }

  private async run(mode: Status['mode'], task: () => Promise<string>): Promise<void> {
    if (this.ctx.mode !== 'idle') return;
    this.ctx.mode = mode;
    this.ctx.active = true;
    this.ctx.stats.start(this.ctx.clock.now());
    this.ctx.companion.reset();
    let message = 'Stopped';
    try {
      this.ctx.hwnd = this.ctx.input.findWindow(this.ctx.settings.windowTitle);
      if (!this.ctx.hwnd) throw new BotError(`No window titled "${this.ctx.settings.windowTitle}..." found`);
      if (this.ctx.input.isMinimized(this.ctx.hwnd)) throw new BotError('The game is minimized; restore it first.');
      const size = this.ctx.input.clientSize(this.ctx.hwnd);
      this.ctx.screenSize = size;
      this.ctx.lastView = null;
      if (!this.ctx.screenReadable) this.checkSize(mode, size);
      const starting: Record<Status['mode'], string> = { idle: '', attack: 'Hunting', explore: 'Exploring', triad: 'Playing Triple Triad', deck: 'Building a Triple Triad deck', gather: 'Gathering', train: 'Training', travel: 'Travelling', grind: 'Grinding', quest: 'Questing', circuit: 'Going round the boss circuit' };
      this.ctx.status(starting[mode]);
      message = await task();
    } catch (error) {
      if (error instanceof BotError || error instanceof ViewError) message = error.message;
      else if (!(error instanceof Stopped)) message = `Error: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      // Never leave the character running on its own, or a button held down.
      this.ctx.stopRunning();
      this.ctx.releaseHold();
      this.ctx.options.memory.stop();
      this.ctx.mode = 'idle';
      this.ctx.active = false;
      this.ctx.hunting.sightings.reset();
      this.ctx.stats.stop(this.ctx.clock.now());
      this.ctx.status(message);
    }
  }
}

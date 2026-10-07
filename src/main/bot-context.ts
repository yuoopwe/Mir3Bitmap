/**
 * What every part of the bot shares: the game window's input, the clock, the
 * memory reader and the settings; the state of the mouse buttons held (running,
 * a held target), the status line, stats and potions; and the small actions
 * everything uses (sleeping, clicking, pressing keys, aiming at something under
 * the mouse). It also holds each part (movement, travel, hunting...), so parts
 * call one another through it and never import each other.
 */

import type { Delays, KeyId, Point, Settings, Status } from '../shared/types';
import type { TriadMemory } from './triad-memory';
import { GAME_HEIGHT, GAME_WIDTH, PLAYER, type Rect } from './layout';
import type { NameBook } from './names';
import { SessionStats } from './session-stats';
import type { GrindLog } from './grind-log';
import type { MemorySource } from './game-memory';
import { createFrame, type Frame } from './vision';
import { realClock, type Clock } from './clock';
import { MK_LBUTTON, MK_RBUTTON, VK, windowsInput, type GameInput, type Handle } from './input';
import { AIM_SPOTS, BotError, type HuntTarget, STATUS_INTERVAL_MS, Stopped, keyCode, wholeSecondsSince } from './bot-shared';
import { HOVER_SETTLE_MS, mouseObjectName } from './bot-shared';
import type { Movement } from './bot-movement';
import type { Travel } from './bot-travel';
import type { Hunting } from './bot-hunting';
import type { Exploring } from './bot-explore';
import type { Survival } from './bot-survival';
import type { Questing } from './bot-quests';
import type { Grinding } from './bot-grind';
import type { TripleTriad } from './bot-triad';
import type { Gathering } from './bot-gathering';
import type { GatherTrips } from './bot-gather-trips';

/** How often to check whether the mouse has left the game window, while paused. */
const PAUSE_POLL_MS = 150;

/** Captures failing this many times in a row stop the bot. */
const MAX_CAPTURE_FAILURES = 20;

/** Minimum time between two drinks of the same potion. */
const POTION_COOLDOWN_MS = 1500;

/**
 * The middle of the tile the character stands on. Names are drawn about a tile
 * above where a character stands (the target brackets around a monster are
 * centred 32px below its name), so the character's tile is centred 32px below
 * their name (y 383).
 */
const FEET: Point = { x: PLAYER.x, y: PLAYER.y + 50 };


/** The name of what the game says is under the mouse, from its title ("Mouse Object: <name>, ..."). */

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
  { id: 'F1', vk: VK.F1, always: true },
  ...(['F2', 'F3', 'F4', 'F5'] as const).map((id, i): KeyAction => ({ id, vk: VK.F1 + 1 + i, delay: 'quickKey', delayWhen: 'after' })),
  ...(['F6', 'F7', 'F8', 'F9', 'F10', 'F11'] as const).map((id, i): KeyAction => ({ id, vk: VK.F1 + 5 + i, delay: 'buffKey', delayWhen: 'before' })),
  { id: 'F12', vk: VK.F1 + 11, delay: 'buffKey', delayWhen: 'after' },
  { id: 'N1', vk: VK.N1, delay: 'itemKey', delayWhen: 'before' },
];

export interface BotOptions {
  report: (status: Status) => void;
  names: NameBook;
  /** What's remembered about Triple Triad: how digits look, and opponents' decks. */
  triad: TriadMemory;
  /** Renders part of a frame as a PNG data URL (for showing learned names). */
  imageOf: (frame: Frame, box: Rect) => string;
  /** Reads the game's memory (exact monsters and positions) when installed: GameMemory, or a stand-in in the tests. */
  memory: MemorySource;
  /** Monster names seen so far, for the window's kill/skip list. */
  monsters?: (names: string[]) => void;
  /** Grind's measurements: the experience each character gained hunting on each map, saved between runs. */
  grindLog: GrindLog;
  /** The game window's mouse, keys, title and pictures: the real window (win32.ts) unless a test gives a stand-in. */
  input?: GameInput;
  /** The time: real time unless a test gives a stand-in. */
  clock?: Clock;
}

export class BotContext {
  hwnd: Handle = null;
  readonly frame = createFrame(GAME_WIDTH, GAME_HEIGHT);
  mode: Status['mode'] = 'idle';
  active = false;
  /** The left button held down on a target (archers), and where it was pressed. */
  holding: { id: string; point: Point } | null = null;
  /** The spot (relative to its tile) where the current monster was last found under the mouse. */
  private aim: { key: string; offset: [number, number] } | null = null;
  private readonly lastPressed = new Map<KeyId, number>();
  private lastHpPotion = 0;
  private lastMpPotion = 0;
  explored: number | null = null;
  /** Where the right button is being held to run, while exploring. */
  running: Point | null = null;
  private captureMs = 0;
  private captureFailures = 0;
  scanMs = 0;
  hp: number | null = null;
  mp: number | null = null;
  kills = 0;
  /** All the time spent paused (mouse over the game), so loops can leave it out of their give-up timers. */
  pausedMs = 0;
  /** What's been done this session and in all, for the window's stats panel. */
  readonly stats = new SessionStats();
  lastStatusAt = 0;
  readonly input: GameInput;
  readonly clock: Clock;
  /** The parts of the bot, set up by Bot: they reach one another through these. */
  moves!: Movement;
  travel!: Travel;
  hunting!: Hunting;
  explore!: Exploring;
  survival!: Survival;
  quests!: Questing;
  grind!: Grinding;
  triad!: TripleTriad;
  gathering!: Gathering;
  gatherTrips!: GatherTrips;

  constructor(
    public settings: Settings,
    readonly options: BotOptions,
  ) {
    this.input = options.input ?? windowsInput();
    this.clock = options.clock ?? realClock;
  }

  status(message: string): void {
    this.lastStatusAt = this.clock.now();
    this.options.report({
      mode: this.mode,
      message,
      captureMs: this.captureMs,
      scanMs: this.scanMs,
      hp: this.hp,
      mp: this.mp,
      kills: this.kills,
      explored: this.explored,
      stats: this.stats.snapshot(this.clock.now()),
    });
  }

  statusEvery(message: string): void {
    if (this.clock.now() - this.lastStatusAt > STATUS_INTERVAL_MS) this.status(message);
  }

  private checkpoint(): void {
    if (!this.active) throw new Stopped();
  }

  /** Waits roughly `ms`, randomly varied by the fuzz percentage so actions don't land on a fixed rhythm. */
  async sleep(ms: number): Promise<void> {
    const fuzz = Math.min(Math.max(this.settings.fuzzPercent, 0), 100) / 100;
    const actual = Math.max(0, ms * (1 + (Math.random() * 2 - 1) * fuzz));
    await this.clock.wait(actual);
    this.checkpoint();
  }

  delay(name: keyof Delays): number {
    return this.settings.delays[name];
  }

  /** Scales one of the selling routine's original pauses (tuned for a 200 ms menu delay). */
  menuPause(original: number): number {
    return (original * this.delay('menu')) / 200;
  }

  /** Lets queued events (such as a Stop click) run between loop iterations. */
  async yieldToEvents(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));
    this.checkpoint();
    await this.pauseWhileMouseOver();
  }

  /** With "pause while my mouse is over the game" on, waits (hands off the game) until the mouse leaves the window. */
  private async pauseWhileMouseOver(): Promise<void> {
    if (!this.settings.pauseOnMouse || !this.input.cursorOverWindow(this.hwnd)) return;
    // Let go of everything so the player has full control.
    this.stopRunning();
    this.releaseHold();
    this.status('Paused: your mouse is over the game');
    const since = this.clock.now();
    try {
      while (this.settings.pauseOnMouse && this.input.cursorOverWindow(this.hwnd)) {
        await this.clock.wait(PAUSE_POLL_MS);
        this.checkpoint();
      }
    } finally {
      this.pausedMs += this.clock.now() - since;
    }
    this.status('Resumed');
  }

  capture(): void {
    const start = this.clock.now();
    try {
      this.input.captureClient(this.hwnd, this.settings.capture, GAME_WIDTH, GAME_HEIGHT, this.frame.bytes);
      this.captureFailures = 0;
    } catch (error) {
      // The capture fails now and then; carry on with the last frame unless it keeps failing.
      if (++this.captureFailures > MAX_CAPTURE_FAILURES) {
        throw new BotError(`Can't capture the game window (${error instanceof Error ? error.message : String(error)}); is it minimized?`);
      }
    }
    this.captureMs = this.clock.now() - start;
  }

  key(vk: number): void {
    this.input.keyDown(this.hwnd, vk);
  }

  async click(point: Point, holdMs: number): Promise<void> {
    this.input.mouseMove(this.hwnd, point.x, point.y);
    this.input.leftDown(this.hwnd, point.x, point.y);
    try {
      await this.sleep(holdMs);
    } finally {
      // Let go even when Stop comes mid-click (the sleep throws): the game would keep the button held.
      this.input.leftUp(this.hwnd, point.x, point.y);
    }
  }

  // ---- Fighting and picking up ----

  /**
   * Hovers spots around a monster's tile until the game's title says the mouse is
   * over it (by name), starting with the spot that worked last time; null if none did.
   */
  async aimAt(target: HuntTarget): Promise<Point | null> {
    const remembered = this.aim?.key === target.key ? [this.aim.offset] : [];
    for (const [dx, dy] of [...remembered, ...AIM_SPOTS]) {
      const point = { x: target.tile!.x + dx, y: target.tile!.y + dy };
      this.input.mouseMove(this.hwnd, point.x, point.y);
      await this.clock.wait(HOVER_SETTLE_MS);
      this.checkpoint();
      if (mouseObjectName(this.input.windowTitle(this.hwnd)) === target.name) {
        this.aim = { key: target.key, offset: [dx, dy] };
        return point;
      }
    }
    return null;
  }

  /** Holds the left button down on a target (archers), following it as it moves; a new target gets a fresh press. */
  hold(point: Point, id: string): void {
    if (this.holding && this.holding.id === id) {
      this.input.mouseMove(this.hwnd, point.x, point.y, MK_LBUTTON);
      this.holding.point = point;
      return;
    }
    this.releaseHold();
    this.input.mouseMove(this.hwnd, point.x, point.y);
    this.input.leftDown(this.hwnd, point.x, point.y);
    this.holding = { id, point };
  }

  /** Lets go of a held target (before anything else uses the mouse). */
  releaseHold(): void {
    if (!this.holding) return;
    this.input.leftUp(this.hwnd, this.holding.point.x, this.holding.point.y);
    this.holding = null;
  }

  drinkPotions(): void {
    const { hunt } = this.settings;
    const now = this.clock.now();
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
  async pressKeys(fighting: boolean): Promise<boolean> {
    let cast = false;
    for (const action of KEY_ACTIONS) {
      const setting = this.settings.keys[action.id];
      if (!setting?.enabled) continue;
      if (action.always && !fighting) continue;

      const last = this.lastPressed.get(action.id);
      const due = last === undefined || wholeSecondsSince(last, this.clock.now()) > setting.seconds;
      if (!action.always && !due) continue;

      if (action.delay && action.delayWhen === 'before') await this.sleep(this.delay(action.delay));
      this.key(action.vk);
      this.lastPressed.set(action.id, this.clock.now());
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
  async clickFloor(times: number, gapMs: number): Promise<void> {
    const pickUpKey = keyCode(this.settings.hunt.pickUpKey);
    for (let i = 0; i < times; i++) {
      await this.click(FEET, this.delay('pickUpClick'));
      if (pickUpKey !== null) this.key(pickUpKey);
      await this.sleep(gapMs);
    }
  }

  holdRun(point: Point): void {
    if (this.running) this.input.mouseMove(this.hwnd, point.x, point.y, MK_RBUTTON);
    else {
      // The game takes where the cursor is from mouse moves, not from the button press itself.
      this.input.mouseMove(this.hwnd, point.x, point.y);
      this.input.rightDown(this.hwnd, point.x, point.y);
    }
    this.running = point;
  }

  stopRunning(): void {
    if (!this.running) return;
    this.input.rightUp(this.hwnd, this.running.x, this.running.y);
    this.running = null;
  }
}

/** Gather mode (plants and ore) and Train mode (a spell cast on yourself). */

import type { Point } from '../shared/types';
import { PLAYER, PLAYER_BAR_TEXT, PLAYER_HP_BAR, PLAYER_MP_BAR } from './layout';
import { tileToScreen, type MemoryObject } from './game-memory';
import { playerHpFill, playerMpFill, readBar } from './vision';
import { BotError, MEMORY_START_MS, ROAM_DIRECTIONS, ROAM_DISTANCE, clickable, keyCode } from './bot-shared';
import type { BotContext } from './bot-context';

/** Gathering: give up walking to a node after this long, and on a node that hasn't been picked this long after clicking it. */
const GATHER_WALK_GIVE_UP_MS = 15_000;

const GATHER_PICK_GIVE_UP_MS = 8000;

/** A node given up on is left alone this long (out of reach, or needs a higher profession level). */
const GATHER_SKIP_MS = 5 * 60_000;

/** Run (holding the right button) towards nodes further than this many tiles; closer, step by clicking. */
const GATHER_RUN_TILES = 3;

/** Looking for nodes: run one way for 4-8 s, turning sooner if the character hasn't moved a tile in this long. */
const GATHER_WANDER_MS = 4000;

const GATHER_BLOCKED_MS = 1200;

/** The character's body, for casting spells on themselves. */
const SELF: Point = { x: PLAYER.x, y: PLAYER.y + 20 };

/** Train mode never casts faster than this. */
const MIN_TRAIN_INTERVAL_MS = 100;

export class Gathering {
  constructor(private readonly bot: BotContext) {}

  /**
   * Gathers plants and ore: walks next to the nearest node on screen (from the
   * game's memory), clicks it and waits until it's picked, then the next. With
   * none in sight it wanders until some come into view. Potions are drunk as
   * when hunting.
   */
  async gatherLoop(): Promise<string> {
    const memory = this.bot.options.memory;
    if (!memory.installed) throw new BotError('Gathering needs the memory reader (run scripts/setup-game-reader.ps1).');
    if (!this.bot.settings.gatherPlants && !this.bot.settings.gatherOre) throw new BotError('Tick "Gather plants" and/or "Gather ore" first.');
    memory.start();
    const skipped = new Map<number, number>();
    let current: { id: number; since: number; clickedAt: number | null; retried: boolean } | null = null;
    let gathered = 0;
    const started = this.bot.clock.now();
    // Running about while looking for nodes: which way, until when, and where the character last moved.
    let wander = { direction: 0, until: 0, tile: { x: NaN, y: NaN }, movedAt: 0 };
    let paused = this.bot.pausedMs;

    while (true) {
      await this.bot.yieldToEvents();
      // Time paused doesn't count towards giving up on a node, or towards being blocked while wandering.
      const pause = this.bot.pausedMs - paused;
      paused = this.bot.pausedMs;
      if (pause > 0) {
        const node = current as { since: number; clickedAt: number | null } | null;
        if (node) {
          node.since += pause;
          if (node.clickedAt !== null) node.clickedAt += pause;
        }
        wander = { ...wander, until: wander.until + pause, movedAt: wander.movedAt + pause };
      }
      this.bot.capture();
      this.bot.hp = readBar(this.bot.frame, PLAYER_HP_BAR, playerHpFill, PLAYER_BAR_TEXT);
      this.bot.mp = readBar(this.bot.frame, PLAYER_MP_BAR, playerMpFill, PLAYER_BAR_TEXT);
      this.bot.drinkPotions();
      const now = this.bot.clock.now();
      for (const [id, until] of skipped) if (until <= now) skipped.delete(id);

      const reading = memory.latest();
      if (!reading) {
        this.bot.stopRunning();
        this.bot.statusEvery(this.bot.clock.now() - started < MEMORY_START_MS ? 'Starting the memory reader' : `Waiting for the game's memory (${memory.problem})`);
        await this.bot.sleep(300);
        continue;
      }
      const user = reading.user!;
      const nodes = (reading.objects ?? []).filter(
        (o) => o.kind === 'node' && !o.harvested && !skipped.has(o.id) && (o.mining ? this.bot.settings.gatherOre : this.bot.settings.gatherPlants) && clickable(tileToScreen(user, o.x, o.y)),
      );
      const distance = (o: { x: number; y: number }) => Math.max(Math.abs(o.x - user.x), Math.abs(o.y - user.y));

      // The node being gathered: gone or picked means done.
      let node: MemoryObject | undefined = current ? nodes.find((o) => o.id === current!.id) : undefined;
      if (current && !node) {
        if (current.clickedAt !== null) {
          gathered++;
          this.bot.stats.count('gathered');
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
        const blocked = this.bot.running && now - wander.movedAt > GATHER_BLOCKED_MS;
        if (now > wander.until || blocked) {
          // Blocked: turn somewhere other than straight back into the same wall.
          const direction = blocked
            ? (wander.direction + 2 + Math.floor(Math.random() * 5)) % ROAM_DIRECTIONS.length
            : Math.floor(Math.random() * ROAM_DIRECTIONS.length);
          wander = { ...wander, direction, until: now + GATHER_WANDER_MS * (1 + Math.random()), movedAt: now };
        }
        const dir = ROAM_DIRECTIONS[wander.direction];
        const scale = dir.x && dir.y ? ROAM_DISTANCE / Math.SQRT2 : ROAM_DISTANCE;
        this.bot.holdRun({ x: Math.round(PLAYER.x + dir.x * scale), y: Math.round(PLAYER.y + dir.y * scale * 0.75) });
        this.bot.statusEvery(`Looking for something to gather (${gathered} gathered)`);
        await this.bot.sleep(this.bot.delay('runStep'));
        continue;
      }
      wander.until = 0;

      const away = distance(node);
      if (away > 1) {
        if (now - current.since > GATHER_WALK_GIVE_UP_MS) {
          this.bot.stopRunning();
          skipped.set(node.id, now + GATHER_SKIP_MS);
          this.bot.status(`Couldn't reach the ${node.name}; trying another`);
          current = null;
          continue;
        }
        // Head for the tile next to it, on this side.
        const next = { x: node.x - Math.sign(node.x - user.x), y: node.y - Math.sign(node.y - user.y) };
        const point = tileToScreen(user, next.x, next.y);
        if (away > GATHER_RUN_TILES) this.bot.holdRun(point);
        else {
          this.bot.stopRunning();
          await this.bot.click(point, this.bot.delay('attackClick'));
        }
        this.bot.statusEvery(`Walking to a ${node.name} ${away} tiles away (${gathered} gathered)`);
        await this.bot.sleep(this.bot.delay('runStep'));
        continue;
      }

      this.bot.stopRunning();
      const { clickedAt } = current;
      if (clickedAt !== null && now - clickedAt > GATHER_PICK_GIVE_UP_MS) {
        skipped.set(node.id, now + GATHER_SKIP_MS);
        this.bot.status(`The ${node.name} won't gather (profession level too low, or the wrong tool?); trying another`);
        current = null;
        continue;
      }
      // Click it, and once more if nothing has happened halfway to giving up.
      if (clickedAt === null || (!current.retried && now - clickedAt > GATHER_PICK_GIVE_UP_MS / 2)) {
        const tile = tileToScreen(user, node.x, node.y);
        // Click where the game says the node is under the mouse, else the middle of its tile.
        await this.bot.moves.setMounted(false);
        const point = (await this.bot.aimAt({ key: `n${node.id}`, point: tile, name: node.name, tile })) ?? tile;
        await this.bot.click(point, this.bot.delay('attackClick'));
        if (clickedAt === null) current.clickedAt = this.bot.clock.now();
        else current.retried = true;
      }
      this.bot.statusEvery(`Gathering a ${node.name} (${gathered} gathered)`);
      await this.bot.sleep(300);
    }
  }

  // ---- Training ----

  /**
   * Casts a spell on the character over and over, to train it: the mouse rests
   * on the character so the spell lands there. Potions are drunk as when hunting.
   */
  async trainLoop(): Promise<string> {
    const vk = keyCode(this.bot.settings.trainKey);
    if (vk === null) throw new BotError('Choose the spell key to train with first.');
    let casts = 0;
    while (true) {
      await this.bot.yieldToEvents();
      this.bot.capture();
      this.bot.hp = readBar(this.bot.frame, PLAYER_HP_BAR, playerHpFill, PLAYER_BAR_TEXT);
      this.bot.mp = readBar(this.bot.frame, PLAYER_MP_BAR, playerMpFill, PLAYER_BAR_TEXT);
      this.bot.drinkPotions();
      this.bot.input.mouseMove(this.bot.hwnd, SELF.x, SELF.y);
      this.bot.key(vk);
      casts++;
      this.bot.statusEvery(`Training: ${casts} casts`);
      await this.bot.sleep(Math.max(this.bot.settings.trainIntervalMs, MIN_TRAIN_INTERVAL_MS));
    }
  }
}

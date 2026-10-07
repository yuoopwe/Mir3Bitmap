/**
 * The loot judge at the shop: keeps what loot-judge.ts says to out of the sale
 * by locking it (the game's ToggleItemLock key over its bag cell: Select All
 * leaves locked items), lists what was kept, and puts on clear upgrades when
 * asked. Neither the key nor double-clicking to put on is confirmed in game,
 * so every step is checked in the game's memory, and the sale is called off
 * when something to keep can't be locked.
 */

import type { KeptItem } from '../shared/types';
import type { MemoryItem, MemoryState } from './game-memory';
import { LOOT, RARITY_NAMES, judgeItem, type Verdict, type Wearer } from './loot-judge';
import { HOVER_SETTLE_MS, boxCentre } from './bot-shared';
import type { BotContext } from './bot-context';

/** The game's ToggleItemLock key: Scroll Lock unless rebound. */
const LOCK_KEY = 0x91;

/** Library.UserItemFlags: locked (the game won't sell or drop it). */
const LOCKED = 1;

/** How long to wait for a cell to show once the bag is open, for a lock, or for what's worn to change (gear is read once a second). */
const CELL_WAIT_MS = 2500;

const LOCK_WAIT_MS = 2500;

const EQUIP_WAIT_MS = 2500;

/** The kept list keeps this many, newest first. */
const KEPT_LIST_LENGTH = 100;

/** A bag item, recognised from one reading to the next by its slot and name. */
const sameItem = (a: MemoryItem) => (b: MemoryItem) => b.slot === a.slot && b.name === a.name;

export class Looting {
  /** What was kept since the app started (or the session was reset), newest first. */
  private kept: KeptItem[] = [];

  constructor(private readonly bot: BotContext) {}

  /** Clears the kept list (with the session's stats). */
  reset(): void {
    this.kept = [];
    this.bot.options.kept?.(this.kept);
  }

  /**
   * Locks every bag item the judge says to keep that the sale could take (not
   * locked yet, and sellable), with the bag open on its Main tab. Returns the
   * first that couldn't be locked (its cell not showing, or the lock not
   * taking), by name: then nothing must be sold. Null when all are safe.
   */
  async protectKeepers(): Promise<string | null> {
    const memory = this.bot.options.memory;
    for (let tries = 0; tries < 100; tries++) {
      const reading = memory.latest();
      const next = this.keepers(reading)[0];
      if (!next) return null;
      const { verdict } = next;
      // Its cell, once the reading shows the bag open; not showing then (scrolled out of sight, say), it can't be protected.
      const cellOf = () => memory.latest()?.gear?.bag.find(sameItem(next.item))?.cell;
      for (const since = this.bot.clock.now(); this.bot.clock.now() - since < CELL_WAIT_MS && !cellOf(); ) await this.bot.sleep(100);
      const item = memory.latest()?.gear?.bag.find(sameItem(next.item)) ?? next.item;
      if (!item.cell) return item.name;
      const point = boxCentre(item.cell);
      this.bot.stopRunning();
      this.bot.input.mouseMove(this.bot.hwnd, point.x, point.y);
      await this.bot.clock.wait(HOVER_SETTLE_MS);
      this.bot.input.keyDown(this.bot.hwnd, LOCK_KEY);
      this.bot.input.keyUp(this.bot.hwnd, LOCK_KEY);
      const locked = () => !!memory.latest()?.gear?.bag.some((b) => sameItem(item)(b) && b.flags & LOCKED);
      for (const since = this.bot.clock.now(); this.bot.clock.now() - since < LOCK_WAIT_MS && !locked(); ) await this.bot.sleep(100);
      if (!locked()) return item.name;
      this.remember(item, verdict);
    }
    return 'the bag';
  }

  /**
   * Puts on clear upgrades (LOOT.equipMargin better than what's worn) from the
   * bag, best first, one at a time: double-clicks its cell and checks that
   * what's worn changed. Never a worn-out item, nor one the character can't
   * wear. The first that doesn't go on ends it. (The bag's AutoEquipButton
   * might do this too, but its rules aren't known: it isn't used.)
   */
  async equipUpgrades(): Promise<void> {
    const memory = this.bot.options.memory;
    for (let tries = 0; tries < 20; tries++) {
      const reading = memory.latest();
      const gear = reading?.gear;
      if (!gear || !reading.user) return;
      const who = this.wearer(reading);
      const best = gear.bag
        .filter((item) => item.cell && !(item.maxDurability > 0 && item.durability <= 0))
        .map((item) => ({ item, verdict: judgeItem(item, gear.worn, who, { margin: LOOT.equipMargin }) }))
        .filter((c) => c.verdict.upgrade)
        .sort((a, b) => b.verdict.gain - a.verdict.gain)[0];
      if (!best) return;
      const before = JSON.stringify(gear.worn.map((w) => [w.slot, w.name]));
      const point = boxCentre(best.item.cell!);
      this.bot.stopRunning();
      this.bot.status(`Putting on ${best.item.name}: ${best.verdict.reason}`);
      this.bot.input.doubleClick(this.bot.hwnd, point.x, point.y);
      const changed = () => {
        const now = memory.latest()?.gear;
        return !!now && JSON.stringify(now.worn.map((w) => [w.slot, w.name])) !== before && !now.bag.some(sameItem(best.item));
      };
      for (const since = this.bot.clock.now(); this.bot.clock.now() - since < EQUIP_WAIT_MS && !changed(); ) await this.bot.sleep(100);
      if (!changed()) {
        this.bot.status(`Couldn't put on ${best.item.name} (double-clicking it did nothing); leaving it in the bag`);
        return;
      }
      this.bot.status(`Put on ${best.item.name}`);
    }
  }

  /** Bag items to keep that the sale could take: the judge says keep, and they're neither locked nor unsellable. Best first. */
  private keepers(reading: MemoryState | null): { item: MemoryItem; verdict: Verdict }[] {
    const gear = reading?.gear;
    if (!gear || !reading.user) return [];
    const who = this.wearer(reading);
    return gear.bag
      .filter((item) => item.canSell && !(item.flags & LOCKED))
      .map((item) => ({ item, verdict: judgeItem(item, gear.worn, who) }))
      .filter((k) => k.verdict.keep)
      .sort((a, b) => b.verdict.gain - a.verdict.gain);
  }

  private wearer(reading: MemoryState): Wearer {
    return { cls: reading.user?.class, level: reading.user?.level, combat: reading.user?.combat };
  }

  /** Into the kept list, the session's count and the log. */
  private remember(item: MemoryItem, verdict: Verdict): void {
    this.kept.unshift({ name: item.name, rarity: RARITY_NAMES[item.rarity] ?? String(item.rarity), reason: verdict.reason, at: Date.now() });
    this.kept.length = Math.min(this.kept.length, KEPT_LIST_LENGTH);
    this.bot.stats.count('kept');
    this.bot.options.kept?.(this.kept);
    this.bot.status(`Kept ${item.name}: ${verdict.reason}`);
  }
}

/**
 * Staying in the game: a full bag (Return to Arcadia, selling to Ludvik, going
 * back), dying, getting out of combat (and the Town Portal scroll); and the old
 * screen selling Hunt uses without the memory reader.
 */

import type { Point } from '../shared/types';
import { Journey, cheapestTile, direction, expandFrom, markPathVisited, startTile } from './pathing';
import { tileToScreen, type MemoryState } from './game-memory';
import { findCharacterOnMap, findMapBottomRight, findMapTopLeft, isBagFull } from './vision';
import { VK } from './input';
import { BotError, STATUS_INTERVAL_MS, boxCentre, keyCode } from './bot-shared';
import type { BotContext } from './bot-context';

/** Arcadia Castle's map index, where Return to Arcadia and the death window's Return send you. */
const ARCADIA_MAP = 563;

/** How long to wait for Return to Arcadia (it may take a moment's channelling) and for coming back to life. */
const ARCADIA_WAIT_MS = 20_000;

/** Return to Arcadia only works out of combat: this long after the last combat (the game's own 10 s, and a little). */
const OUT_OF_COMBAT_S = 10.5;

/** Before returning, monsters this close are fought off; and how long to keep trying to get out of combat. */
const CLEAR_RANGE_TILES = 10;

const OUT_OF_COMBAT_GIVE_UP_MS = 60_000;

/** After the Town Portal scroll, how long to wait for the move to town (it takes a moment to read). */
const TOWN_PORTAL_WAIT_MS = 15_000;

const REVIVE_WAIT_MS = 30_000;

/** Selling in Arcadia: the shopkeeper who buys (his "Select All" picks what can be sold from the open bag tab). */
const SELL_NPC = { id: 145, name: 'Ludvik' };

/** W opens and closes the bag window (the game's InventoryWindow key). */
const INVENTORY_KEY = 0x57;

/** At most this many Select All / Sell rounds (the sell panel holds only so many items at a time). */
const SELL_ROUNDS = 20;

/** This many items in a row that wouldn't pick up count as a full bag. */
const LOOT_REFUSED_FULL = 3;

/** Where to point the mouse to run in each direction, keyed by "signX,signY". */
const RUN_POINTS: Record<string, Point> = {
  '1,1': { x: 1348, y: 700 },
  '-1,1': { x: 256, y: 619 },
  '1,-1': { x: 1290, y: 139 },
  '-1,-1': { x: 324, y: 121 },
  '0,-1': { x: 812, y: 73 },
  '0,1': { x: 823, y: 820 },
  '1,0': { x: 1341, y: 426 },
  '-1,0': { x: 232, y: 444 },
};

const SHOP_RUN_POINTS: Record<string, Point> = { ...RUN_POINTS, '0,1': { x: 809, y: 820 } };

const SHOP_LOCATION: Point = { x: 82, y: 76 };

const TOWN_EXIT: Point = { x: 696, y: 77 };

interface WalkOptions {
  /** Click instead of hovering, for when autorun is off. */
  click: boolean;
  /** Finish when the character stands exactly on the target. */
  stopAtTarget: boolean;
  /** Re-press this key every 30 steps. */
  repeatKey?: number;
}

type WalkResult = 'arrived' | 'mapChanged' | 'noPath';

export class Survival {
  private mapTopLeft: Point | null = null;
  private mapBottomRight: Point | null = null;
  /** Items given up on in a row (they wouldn't pick up); reset by one that does, and by selling. */
  lootRefused = 0;

  constructor(private readonly bot: BotContext) {}

  /** The bag has too few slots free, or is too near its weight limit (the Hunt settings). */
  bagFull(reading: MemoryState | null | undefined): boolean {
    const bag = reading?.survival?.bag;
    if (!bag || bag.slots <= 0) return false;
    const freeSlots = bag.slots - bag.used;
    const weightPercent = bag.maxWeight > 0 ? (bag.weight / bag.maxWeight) * 100 : 0;
    // Items that won't pick up, one after another, mean the game thinks the bag is full whatever the count says.
    if (this.lootRefused >= LOOT_REFUSED_FULL) return true;
    return freeSlots <= (this.bot.settings.hunt.bagFreeSlots ?? 15) || weightPercent >= (this.bot.settings.hunt.bagWeightPercent ?? 95);
  }

  /** Dead: presses Return on the death window (back to Arcadia, alive) and waits for it. */
  async reviveInArcadia(): Promise<void> {
    const memory = this.bot.options.memory;
    this.bot.stopRunning();
    this.bot.releaseHold();
    for (const since = this.bot.clock.now(); this.bot.clock.now() - since < REVIVE_WAIT_MS; ) {
      await this.bot.yieldToEvents();
      const reading = memory.latest();
      if (reading?.user && !reading.user.dead) {
        this.bot.status('Back on my feet');
        return;
      }
      const button = reading?.survival?.death?.returnButton;
      if (button?.enabled) {
        this.bot.status('Died: returning to Arcadia');
        await this.bot.click(boxCentre(button), this.bot.delay('menu'));
        await this.bot.sleep(1500);
      } else {
        this.bot.statusEvery('Died: waiting for the death window');
        await this.bot.sleep(300);
      }
    }
    throw new BotError("Died, and couldn't get back on my feet.");
  }

  /** Presses Return to Arcadia (out of combat) and waits to arrive; tries a few times. */
  private async returnToArcadia(why: string): Promise<void> {
    const memory = this.bot.options.memory;
    this.bot.stopRunning();
    this.bot.releaseHold();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (memory.latest()?.map?.index === ARCADIA_MAP) return;
      await this.getOutOfCombat(why);
      const button = memory.latest()?.survival?.arcadia;
      if (button?.enabled) {
        this.bot.status(`${why}: returning to Arcadia`);
        await this.bot.click(boxCentre(button), this.bot.delay('menu'));
      } else {
        this.bot.statusEvery(`${why}: waiting for Return to Arcadia`);
      }
      for (const since = this.bot.clock.now(); this.bot.clock.now() - since < ARCADIA_WAIT_MS; ) {
        await this.bot.yieldToEvents();
        if (memory.latest()?.map?.index === ARCADIA_MAP) return;
        await this.bot.sleep(300);
      }
    }
    throw new BotError(`${why}, but Return to Arcadia didn't take me there (in combat?).`);
  }

  /**
   * Return to Arcadia needs the player out of combat (10 s since the last): fights
   * off monsters close by, then waits out the rest of the 10 s.
   */
  private async getOutOfCombat(why: string): Promise<void> {
    const memory = this.bot.options.memory;
    let portalled = false;
    for (let since = this.bot.clock.now(); ; ) {
      if (this.bot.clock.now() - since >= OUT_OF_COMBAT_GIVE_UP_MS) {
        // Still in combat after a minute: the Town Portal scroll, then wait out the 10 s in town.
        const vk = keyCode(this.bot.settings.hunt.townPortalKey ?? '3');
        if (portalled || vk === null) return;
        portalled = true;
        this.bot.stopRunning();
        this.bot.releaseHold();
        const from = memory.latest()?.map?.index;
        this.bot.status(`${why}: can't get out of combat; reading a Town Portal scroll`);
        await this.bot.moves.waitUntilStill();
        this.bot.key(vk);
        for (const start = this.bot.clock.now(); this.bot.clock.now() - start < TOWN_PORTAL_WAIT_MS && memory.latest()?.map?.index === from; ) await this.bot.sleep(300);
        since = this.bot.clock.now();
        continue;
      }
      await this.bot.yieldToEvents();
      const reading = memory.latest();
      const ago = reading?.user?.combatAgo;
      if (ago === undefined || ago === null || ago >= OUT_OF_COMBAT_S) return;
      // Anything hostile close by keeps you in combat, however weak.
      if (reading && reading.user && this.bot.hunting.monstersNear(reading, reading.user, CLEAR_RANGE_TILES).length > 0) {
        this.bot.status(`${why}: fighting off what's close before returning`);
        await this.bot.hunting.clearTheWay(CLEAR_RANGE_TILES, true);
        continue;
      }
      this.bot.stopRunning();
      this.bot.statusEvery(`${why}: waiting to be out of combat (${Math.max(0, Math.ceil(OUT_OF_COMBAT_S - ago))} s)`);
      await this.bot.sleep(300);
    }
  }

  /** Bag full: back to Arcadia, over to Ludvik, and sell what he'll take from the Main bag tab. */
  async emptyBag(): Promise<void> {
    const from = this.bot.options.memory.latest()?.map?.index;
    await this.returnToArcadia('Bag full');
    try {
      await this.sellAndGoBack(from);
    } finally {
      this.lootRefused = 0;
    }
  }

  /** Sells to Ludvik, then (from Arcadia) presses Return to Arcadia again, which takes you back to where you were. */
  private async sellAndGoBack(from: number | undefined): Promise<void> {
    await this.bot.travel.travelTo(`npc:${SELL_NPC.id}`);
    const sold = await this.sellAtShop(SELL_NPC.name);
    this.lootRefused = 0;
    if (this.bagFull(this.bot.options.memory.latest())) throw new BotError(`Sold ${sold} items, but the bag is still full (the rest are kept or can't be sold).`);
    this.bot.status(`Sold ${sold} items; back to it`);
    // In Arcadia the same button sends you back to where you left (else the caller plans the way back).
    if (from === undefined || from === ARCADIA_MAP) return;
    const memory = this.bot.options.memory;
    for (let attempt = 0; attempt < 2 && memory.latest()?.map?.index === ARCADIA_MAP; attempt++) {
      const button = memory.latest()?.survival?.arcadia;
      if (!button?.enabled) break;
      this.bot.status('Back to where I was');
      await this.bot.click(boxCentre(button), this.bot.delay('menu'));
      for (const since = this.bot.clock.now(); this.bot.clock.now() - since < ARCADIA_WAIT_MS && memory.latest()?.map?.index === ARCADIA_MAP; ) await this.bot.sleep(300);
    }
  }

  /**
   * At a shopkeeper: clicks them to open the shop, makes sure the bag shows its
   * Main tab (so Select All never picks potions), presses Select All then Sell
   * (and Yes on any "are you sure?"), and closes the shop. Returns how many bag
   * slots it emptied.
   */
  private async sellAtShop(npcName: string): Promise<number> {
    const memory = this.bot.options.memory;
    const sellPanel = () => memory.latest()?.survival?.sell;
    const waitFor = async (ok: () => boolean, ms: number) => {
      for (const since = this.bot.clock.now(); this.bot.clock.now() - since < ms; ) {
        if (ok()) return true;
        await this.bot.sleep(100);
      }
      return ok();
    };
    this.bot.stopRunning();
    for (let attempt = 0; attempt < 3 && !sellPanel(); attempt++) {
      const reading = memory.latest();
      const npc = reading?.objects?.find((o) => o.kind === 'npc' && o.name === npcName);
      if (!npc || !reading?.user) throw new BotError(`Can't see ${npcName} to sell to.`);
      const tile = tileToScreen(reading.user, npc.x, npc.y);
      const point = (await this.bot.aimAt({ key: `npc${npc.id}`, point: tile, name: npcName, tile })) ?? tile;
      this.bot.status(`Opening ${npcName}'s shop`);
      await this.bot.click(point, this.bot.delay('menu'));
      await waitFor(() => !!sellPanel(), 3000);
    }
    if (!sellPanel()) throw new BotError(`${npcName}'s shop didn't open.`);
    const before = memory.latest()?.survival?.bag?.used ?? 0;

    // Select All takes from the bag window's open tab: open the bag (W) if it isn't showing.
    const bagWasOpen = !!memory.latest()?.survival?.inventory?.open;
    if (!bagWasOpen) {
      this.bot.key(INVENTORY_KEY);
      if (!(await waitFor(() => !!memory.latest()?.survival?.inventory?.open, 2000))) throw new BotError("Couldn't open the bag (W) to sell from.");
    }
    // The Main tab only: potions live in Consumables.
    const inventory = memory.latest()?.survival?.inventory;
    if (inventory && inventory.section !== 0 && inventory.mainTab) {
      await this.bot.click(boxCentre(inventory.mainTab), this.bot.delay('menu'));
      await waitFor(() => memory.latest()?.survival?.inventory?.section === 0, 2000);
    }
    if (memory.latest()?.survival?.inventory?.section !== 0) throw new BotError("Couldn't switch the bag to its Main tab to sell from.");

    // The sell panel holds only so many: Select All and Sell again until nothing more is picked, or the bag stops emptying.
    for (let round = 0; round < SELL_ROUNDS; round++) {
      const selectAll = sellPanel()?.selectAll;
      if (!selectAll?.enabled) {
        if (round === 0) throw new BotError("The shop's Select All button isn't there.");
        break;
      }
      await this.bot.click(boxCentre(selectAll), this.bot.delay('menu'));
      if (!(await waitFor(() => !!sellPanel()?.sell?.enabled, 2000))) break;
      const used = memory.latest()?.survival?.bag?.used ?? before;
      this.bot.status(`Selling (${sellPanel()?.value ?? '?'} gold, round ${round + 1})`);
      await this.bot.click(boxCentre(sellPanel()!.sell!), this.bot.delay('menu'));
      // An "are you sure?": press its Yes / OK.
      await this.bot.sleep(500);
      const ask = memory.latest()?.survival?.messages?.find((m) => m.buttons.some((b) => /yes|ok|confirm/i.test(b.name)));
      const yes = ask?.buttons.find((b) => /yes|ok|confirm/i.test(b.name));
      if (yes) await this.bot.click(boxCentre(yes), this.bot.delay('menu'));
      if (!(await waitFor(() => (memory.latest()?.survival?.bag?.used ?? used) < used, 3000))) break;
      await this.bot.sleep(300);
    }
    const after = memory.latest()?.survival?.bag?.used ?? before;
    await this.closeShop();
    // Put the bag away again if it was opened for this.
    if (!bagWasOpen && memory.latest()?.survival?.inventory?.open) this.bot.key(INVENTORY_KEY);
    return Math.max(0, before - after);
  }

  /** Closes the shop: its close button, else Escape. */
  private async closeShop(): Promise<void> {
    const close = this.bot.options.memory.latest()?.survival?.sell?.close;
    if (close?.enabled && close.width > 0) await this.bot.click(boxCentre(close), this.bot.delay('menu'));
    else this.bot.key(VK.ESCAPE);
    await this.bot.sleep(300);
  }

  // ---- Selling the old way, by the screen (Hunt without the memory reader) ----

  async sellItems(): Promise<void> {
    // Open the bag, look at it, and close it again.
    this.bot.key(VK.W);
    await this.bot.sleep(this.bot.menuPause(200));
    this.bot.capture();
    const full = isBagFull(this.bot.frame);
    this.bot.key(VK.W);
    await this.bot.sleep(this.bot.menuPause(200));
    if (!full) return;

    this.bot.status('Selling items');
    // Teleport to town, open the map and walk to the shop.
    this.bot.key(VK.N2);
    await this.bot.sleep(this.bot.menuPause(200));
    this.bot.key(VK.B);
    await this.bot.sleep(this.bot.menuPause(500));
    const start = this.locate();
    if (start) {
      await this.walk(new Journey(start), start, SHOP_LOCATION, { click: true, stopAtTarget: true, repeatKey: VK.N2 });
    }
    this.bot.key(VK.B);
    await this.bot.sleep(this.bot.menuPause(200));
    this.bot.key(VK.B);
    await this.bot.sleep(this.bot.menuPause(200));

    // Talk to the shopkeeper and sell.
    await this.shopClick({ x: 795, y: 318 }, 200);
    await this.shopClick({ x: 80, y: 89 }, 200);
    for (let i = 0; i < 4; i++) {
      await this.shopClick({ x: 294, y: 526 }, 200);
      await this.shopClick({ x: 457, y: 526 }, 200);
    }
    for (let i = 0; i < 4; i++) {
      this.bot.key(VK.ESCAPE);
      await this.bot.sleep(this.bot.menuPause(100));
    }
    await this.shopClick({ x: 695, y: 152 }, 100);
    await this.shopClick({ x: 65, y: 130 }, 100);
    await this.shopClick({ x: 1319, y: 314 }, 100);
    await this.shopClick({ x: 135, y: 103 }, 100);
    this.bot.key(VK.B);
    await this.bot.sleep(this.bot.menuPause(100));

    // Autorun back out of town; leaving the map means we've arrived.
    this.bot.key(VK.D);
    await this.walkUntilMapChanges(TOWN_EXIT);
    this.bot.key(VK.D);
    this.bot.key(VK.B);
    this.bot.key(VK.B);
  }

  private async shopClick(point: Point, pauseAfter: number): Promise<void> {
    this.bot.input.mouseMove(this.bot.hwnd, point.x, point.y);
    await this.bot.sleep(this.bot.menuPause(200));
    this.bot.input.leftDown(this.bot.hwnd, point.x, point.y);
    try {
      await this.bot.sleep(this.bot.menuPause(200));
    } finally {
      this.bot.input.leftUp(this.bot.hwnd, point.x, point.y);
    }
    await this.bot.sleep(this.bot.menuPause(200 + pauseAfter));
  }

  // ---- Walking by the big map (selling) ----

  private async walkUntilMapChanges(target: Point, start = this.locate()): Promise<void> {
    if (!start) return;

    const journey = new Journey(start);
    let position: Point | null = start;
    while (position) {
      const result = await this.walk(journey, position, target, { click: false, stopAtTarget: false });
      if (result === 'mapChanged') return;
      // Out of tiles to try: start again from wherever we are now.
      await this.bot.sleep(50);
      position = this.locate();
    }
  }

  /** Captures the window and finds the character on the big map; null once it's no longer shown. */
  private locate(): Point | null {
    this.bot.capture();
    const start = this.bot.clock.now();
    this.mapTopLeft = findMapTopLeft(this.bot.frame) ?? this.mapTopLeft;
    this.mapBottomRight = findMapBottomRight(this.bot.frame) ?? this.mapBottomRight;
    if (!this.mapTopLeft || !this.mapBottomRight) {
      throw new BotError('Could not find the map on screen. Open the big map and try again.');
    }
    const position = findCharacterOnMap(this.bot.frame, this.mapTopLeft, this.mapBottomRight);
    this.bot.scanMs = this.bot.clock.now() - start;
    return position;
  }

  /**
   * Feels its way towards `target`: tries the most promising neighbouring tile,
   * and treats it as a wall if the character didn't move.
   */
  private async walk(journey: Journey, from: Point, target: Point, options: WalkOptions): Promise<WalkResult> {
    journey.active.push(startTile(from, target));
    let step = 0;

    while (journey.active.length > 0) {
      await this.bot.yieldToEvents();
      const tile = cheapestTile(journey.active);

      const position = this.locate();
      if (!position) return 'mapChanged';
      if (options.stopAtTarget && position.x === target.x && position.y === target.y) return 'arrived';

      journey.active.splice(journey.active.indexOf(tile), 1);
      await this.runTowards(position, tile, options.click);

      const after = this.locate();
      if (!after) return 'mapChanged';
      const moved = after.x !== journey.previousPosition.x || after.y !== journey.previousPosition.y;

      if (moved) journey.previousTile = tile;
      journey.visited.push(tile);
      markPathVisited(journey, tile);
      journey.previousPosition = after;

      if (step === 0) {
        journey.previousTile = tile;
        expandFrom(journey, tile, after, target);
      }
      if (moved) expandFrom(journey, tile, after, target);
      else journey.walls.push(tile);

      if (options.repeatKey !== undefined && step > 30) {
        step = 0;
        this.bot.key(options.repeatKey);
        await this.bot.sleep(this.bot.menuPause(200));
      }
      step++;
      if (this.bot.clock.now() - this.bot.lastStatusAt > STATUS_INTERVAL_MS) this.bot.status(this.bot.mode === 'travel' ? 'Travelling' : 'Selling items');
    }
    return 'noPath';
  }

  private async runTowards(position: Point, tile: Point, click: boolean): Promise<void> {
    const sign = direction(position, tile);
    const point = (click ? SHOP_RUN_POINTS : RUN_POINTS)[`${sign.x},${sign.y}`];
    if (!point) return; // already there

    // Clicked runs used to hold 200 ms and wait 500 ms against a 400 ms hover step; keep those ratios.
    const step = this.bot.delay('runStep');
    if (click) {
      await this.bot.click(point, step / 2);
      await this.bot.sleep(step * 1.25);
    } else {
      this.bot.input.mouseMove(this.bot.hwnd, point.x, point.y);
      await this.bot.sleep(step);
    }
  }
}

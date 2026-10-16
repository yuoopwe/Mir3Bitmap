/**
 * Companion looting: a companion only gains experience from what it picks up,
 * so with "Let my companion loot" ticked the bot leaves the loot to it (while
 * one is out and the Companion Transfer key is set) and, when the companion's
 * bag is nearly full between fights, empties it into the player's bag with the
 * game's Companion Transfer: the key, then Enter on the box it opens, then
 * waiting while the items move one at a time. The game moves what matches the
 * companion's Transfer filter, leaving locked and bound items behind.
 *
 * A transfer that moves nothing with the box confirmed means the player's bag
 * had no room: that counts as a full bag (Survival.bagFull), so the usual sell
 * trip runs and the transfer is tried again after. No box at all means nothing
 * matches the filter: the bot loots for itself for a while, and says why.
 */
import { keyCode } from './bot-shared';
import { VK } from './input';
import type { BotContext } from './bot-context';
import type { MemoryState } from './game-memory';

/** The companion's bag counts as nearly full with this few slots free... */
const FREE_SLOTS = 1;
/** ...or this share of its weight used. */
const WEIGHT_SHARE = 0.9;
/** The confirmation box should be up this soon after the key. */
const CONFIRM_SHOW_MS = 3000;
/** The items move one at a time (each waits for the server): this long at most for the lot. */
const TRANSFER_MS = 30_000;
/** Nothing matching the Transfer filter: the bot loots for itself this long before trying the companion again. */
const NO_MATCH_MS = 10 * 60_000;

type Companion = NonNullable<MemoryState['companion']>;

export class CompanionLoot {
  /** The companion's bag stayed full because the player's had no room: Survival.bagFull counts the bag full until a sell. */
  blocked = false;
  /** Nothing matched the Transfer filter: looting for itself until then. */
  private noMatchUntil = 0;
  /** What's been said, so it's said once a run. */
  private readonly said = new Set<string>();

  constructor(private readonly bot: BotContext) {}

  /** A new run: everything tried afresh. */
  reset(): void {
    this.blocked = false;
    this.noMatchUntil = 0;
    this.said.clear();
  }

  private sayOnce(message: string): void {
    if (this.said.has(message)) return;
    this.said.add(message);
    this.bot.status(message);
  }

  /** The Companion Transfer key, or null when none is set. */
  private key(): number | null {
    return keyCode(this.bot.settings.hunt.companionTransferKey ?? '');
  }

  /**
   * Whether the companion is doing the looting now: the option ticked, a companion out, the key set, and its filter not
   * just found to match nothing. When it isn't (with the option ticked), says why once: the bot loots for itself then.
   */
  looting(reading: MemoryState | null | undefined): boolean {
    if (!this.bot.settings.hunt.companionLoot || !reading?.user) return false;
    if (!reading.companion) {
      this.sayOnce('No companion out: picking up loot myself');
      return false;
    }
    if (this.key() === null) {
      this.sayOnce('Companion looting needs the Companion Transfer key: bind it in the game\'s key settings and pick it on the Hunt tab');
      return false;
    }
    return this.bot.clock.now() >= this.noMatchUntil;
  }

  /** The companion's bag has a free slot or less, or is nearly at its weight. */
  nearlyFull(companion: Companion): boolean {
    const { used, slots, weight, maxWeight } = companion.bag;
    if (slots && slots > 0 && slots - used <= FREE_SLOTS) return true;
    return !!maxWeight && maxWeight > 0 && (weight ?? 0) >= maxWeight * WEIGHT_SHARE;
  }

  /** Time to empty the companion's bag: it's doing the looting, its bag is nearly full, and no transfer is running. */
  wanted(reading: MemoryState | null | undefined): boolean {
    const companion = reading?.companion;
    return !!companion && !this.blocked && this.looting(reading) && !companion.bag.transferring && this.nearlyFull(companion);
  }

  /**
   * Empties the companion's bag into the player's: the Companion Transfer key, Enter on the box it opens, then waiting
   * while the items move. Returns how many moved (null: it couldn't start). Moving none with the box confirmed means the
   * player's bag had no room, so the bag counts as full (`blocked`) until the next sell.
   */
  async transfer(): Promise<number | null> {
    const memory = this.bot.options.memory;
    const vk = this.key();
    const before = memory.latest()?.companion?.bag.used;
    if (vk === null || before === undefined) return null;
    this.bot.releaseHold();
    this.bot.stopRunning();
    this.bot.status(`Moving the companion's bag into mine (${before} item${before === 1 ? '' : 's'})`);
    this.bot.key(vk);
    const shown = await this.bot.waitUntil(() => !!memory.latest()?.companion?.confirm?.enabled, CONFIRM_SHOW_MS);
    const confirm = memory.latest()?.companion?.confirm;
    if (!shown || !confirm) {
      // No box: the game found nothing in the bag matching the companion's Transfer filter.
      this.noMatchUntil = this.bot.clock.now() + NO_MATCH_MS;
      this.bot.status("Nothing in the companion's bag matches its Transfer filter (set one in the game's companion window): picking up loot myself for now");
      return null;
    }
    // Enter confirms it, as it does for the player. Only once the box shows: Enter with nothing up opens the chat, and
    // the keys after it would be typed into it.
    await this.bot.sleep(this.bot.delay('menu'));
    this.bot.key(VK.RETURN);
    // Started (the box gone) and done (nothing moving any more).
    await this.bot.waitUntil(() => {
      const c = memory.latest()?.companion;
      return !!c && !c.confirm && !c.bag.transferring;
    }, TRANSFER_MS);
    const after = memory.latest()?.companion?.bag.used ?? before;
    const moved = Math.max(0, before - after);
    if (moved > 0) {
      this.bot.status(`Moved ${moved} item${moved === 1 ? '' : 's'} from the companion's bag into mine`);
    } else {
      this.blocked = true;
      this.bot.status("Nothing moved from the companion's bag: mine must be full; selling first");
    }
    return moved;
  }
}

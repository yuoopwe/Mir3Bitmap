/** Triple Triad: playing matches, and Best deck. */

import type { Point } from '../shared/types';
import type { Card } from './triad';
import { cardOf, decideFromMemory, decideTriad, matchResult, myTurnInMemory, rulesFromFlags, type ReadCard } from './triad-player';
import { HAND_SLOTS, OK as TRIAD_OK, boardSampler, cellCentre, centre, readTriad, type TriadScreen } from './triad-vision';
import type { MemoryCollection, MemoryTriad } from './game-memory';
import { chooseDeck, deckInputs } from './triad-deck';
import { BotError, MEMORY_START_MS, boxCentre } from './bot-shared';
import type { BotContext } from './bot-context';

/** Triple Triad: how often to look while waiting, the pause between clicking a card and its square, and time for a move to play out. */
const TRIAD_IDLE_MS = 1000;

const TRIAD_POLL_MS = 400;

const TRIAD_CLICK_GAP_MS = 250;

const TRIAD_SETTLE_MS = 1200;

/**
 * Where the mouse waits during Triple Triad: the empty black area under the
 * board. Left over a card, the card's tooltip appears above it, and over the
 * top row that covers the "Your turn" text.
 */
const TRIAD_PARK: Point = { x: 640, y: 625 };

/** What the bot keeps track of during one Triple Triad match. */
interface TriadMatch {
  /** Who the opponent is (a signature of their name). */
  opponent: string;
  /** Cells where I put my cards, and what they were. */
  mine: Map<number, ReadCard>;
  /** Cells where she put her cards, and what they are. */
  hers: Map<number, Card>;
  /** Cards that were already down when the bot joined the match. */
  unknown: Set<number>;
  /** My cards whose look on the board has been learned. */
  learned: Set<number>;
}

/** The same cards in the same places (so nothing is mid-move between the two looks). */
function sameTriadLayout(a: TriadScreen, b: TriadScreen): boolean {
  return a.hand.length === b.hand.length && a.board.every((cell, i) => (cell?.owner ?? null) === (b.board[i]?.owner ?? null));
}

export class TripleTriad {
  /** The rule flags of the last Triple Triad match read from memory: Best deck picks cards for them. */
  private triadRules = 0;

  constructor(private readonly bot: BotContext) {}

  /**
   * Plays Triple Triad matches as they come up: waits for the panel, plays
   * each of my turns with the best move it can find, and presses OK at the
   * end. Matches are started by the player, at the card NPC.
   */
  async triadLoop(): Promise<string> {
    const memory = this.bot.options.triad;
    let matches = 0;
    let wasOver = false;
    let match: TriadMatch | null = null;
    // The game's memory has every card's numbers and whose turn it is; the screen is the fallback.
    this.bot.options.memory.start();
    const started = this.bot.clock.now();
    // When the reader last gave a reading: a moment's gap mid-match is waited out, not played from the screen.
    let heardAt = started;
    let okPressed = false;
    // The match's last reading with the board: the result box can come up with the board already gone.
    // Cleared once the result is counted, so each match counts once.
    let lastBoard: MemoryTriad | null = null;
    while (true) {
      await this.bot.yieldToEvents();
      if (this.bot.options.memory.latest()) heardAt = this.bot.clock.now();
      const live = this.bot.options.memory.latest()?.triad;
      if (live?.ok) {
        if (!okPressed) matches++;
        okPressed = true;
        if (lastBoard) {
          this.bot.stats.countMatch(matchResult(live) ?? matchResult(lastBoard));
          lastBoard = null;
        }
        this.bot.status('Game over; pressing OK');
        await this.bot.click(boxCentre(live.ok), this.bot.delay('menu'));
        await this.bot.sleep(TRIAD_SETTLE_MS);
        continue;
      }
      okPressed = false;
      if (live?.open) {
        // Not a finished match still showing after its OK: that one has been counted.
        if (live.board && (lastBoard || !live.complete)) lastBoard = live;
        await this.triadTurnFromMemory(live);
        continue;
      }
      if (this.bot.options.memory.latest()) {
        this.bot.statusEvery(matches ? `Played ${matches} game${matches === 1 ? '' : 's'}; waiting for the next one` : 'Waiting for a Triple Triad match (start one at the card NPC)');
        await this.bot.sleep(TRIAD_POLL_MS);
        continue;
      }
      if (this.bot.options.memory.installed && this.bot.clock.now() - heardAt < MEMORY_START_MS) {
        this.bot.statusEvery(heardAt === started ? 'Starting the memory reader' : "Waiting for the game's memory");
        await this.bot.sleep(TRIAD_POLL_MS);
        continue;
      }

      // No memory reader: read the screen.
      this.bot.capture();
      const screen = readTriad(this.bot.frame);
      if (!screen.open) {
        wasOver = false;
        match = null;
        this.bot.statusEvery(matches ? `Played ${matches} match${matches === 1 ? '' : 'es'}; waiting for the next one` : 'Waiting for a Triple Triad match (start one at the card NPC)');
        await this.bot.sleep(TRIAD_IDLE_MS);
        continue;
      }
      if (screen.over) {
        if (!wasOver) {
          matches++;
          // The screen doesn't say who won: count it as played only.
          this.bot.stats.countMatch(null);
          // She always plays the same cards: remember the ones she played.
          if (match) memory.remember(match.opponent, [...match.hers.values()]);
          match = null;
        }
        wasOver = true;
        this.bot.status('Match over; pressing OK');
        await this.bot.click(TRIAD_OK, this.bot.delay('menu'));
        await this.bot.sleep(TRIAD_SETTLE_MS);
        continue;
      }
      wasOver = false;
      const fresh = screen.hand.length === 5 && screen.board.every((cell) => !cell);
      if (!match || (fresh && match.mine.size > 0)) {
        // Cards already down when the bot joins a match are of unknown origin.
        const before = screen.board.flatMap((cell, i) => (cell ? [i] : []));
        match = { opponent: screen.opponent, mine: new Map(), hers: new Map(), unknown: new Set(before), learned: new Set() };
      }
      if (!screen.myTurn) {
        // Keep the mouse off the cards: a card's tooltip can cover the "Your turn" text.
        this.bot.input.mouseMove(this.bot.hwnd, TRIAD_PARK.x, TRIAD_PARK.y);
        this.bot.statusEvery("Opponent's turn");
        await this.bot.sleep(TRIAD_POLL_MS);
        continue;
      }

      // Only act on a settled screen: cards slide into place after each move.
      await this.bot.sleep(TRIAD_POLL_MS);
      this.bot.capture();
      const again = readTriad(this.bot.frame, memory.reader);
      if (!again.myTurn || !sameTriadLayout(screen, again)) continue;
      this.learnFromBoard(again, match);

      const decision = decideTriad(again, { mine: new Set(match.mine.keys()), herDeck: memory.deckOf(match.opponent) });
      if (decision.kind === 'wait') {
        this.bot.statusEvery(decision.reason);
        continue;
      }
      const outlook = decision.expected > 0 ? `should win by ${decision.expected}` : decision.expected < 0 ? `likely to lose by ${-decision.expected}` : 'heading for a draw';
      this.bot.status(`${decision.summary} (${outlook}${decision.guessed ? '; some of her cards are guesses' : ''})`);
      const played = cardOf(again.hand[decision.handIndex]);
      await this.bot.click(centre(HAND_SLOTS[decision.handIndex]), this.bot.delay('menu'));
      await this.bot.sleep(TRIAD_CLICK_GAP_MS);
      await this.bot.click(cellCentre(decision.cell), this.bot.delay('menu'));
      // Move off the card just played, or its tooltip covers the board and the turn text.
      this.bot.input.mouseMove(this.bot.hwnd, TRIAD_PARK.x, TRIAD_PARK.y);
      await this.bot.sleep(TRIAD_SETTLE_MS);

      // Check the card went down before counting it as played.
      this.bot.capture();
      const after = readTriad(this.bot.frame);
      if (after.board[decision.cell] || after.over || !after.open) match.mine.set(decision.cell, played);
      else this.bot.status('The card did not go down; trying again');
    }
  }

  /** Rests the mouse just below the board, off every card (a card's tooltip can cover the board). */
  private parkOffCards(live: MemoryTriad): void {
    const bottom = live.squares?.[7];
    const at = bottom ? { x: bottom.x + Math.round(bottom.width / 2), y: bottom.y + bottom.height + 30 } : TRIAD_PARK;
    this.bot.input.mouseMove(this.bot.hwnd, at.x, at.y);
  }

  /** One look at a match through the game's memory: plays my move if it's my turn. */
  private async triadTurnFromMemory(live: MemoryTriad): Promise<void> {
    if (live.rules !== undefined) this.triadRules = live.rules;
    if (!live.players || !live.board) {
      this.bot.statusEvery('Waiting for the game to start');
      await this.bot.sleep(TRIAD_POLL_MS);
      return;
    }
    if (!myTurnInMemory(live)) {
      this.parkOffCards(live);
      this.bot.statusEvery(live.complete ? 'Game over' : "Opponent's turn (game memory)");
      await this.bot.sleep(TRIAD_POLL_MS);
      return;
    }
    const { decision, card } = decideFromMemory(live);
    if (decision.kind === 'wait' || !card) {
      this.bot.statusEvery(decision.kind === 'wait' ? decision.reason : 'No move');
      await this.bot.sleep(TRIAD_POLL_MS);
      return;
    }
    const outlook = decision.expected > 0 ? `should win by ${decision.expected}` : decision.expected < 0 ? `likely to lose by ${-decision.expected}` : 'heading for a draw';
    this.bot.status(`${decision.summary} (${outlook}, game memory)`);
    const square = live.squares?.[decision.cell];
    await this.bot.click(boxCentre(live.hand![decision.handIndex]), this.bot.delay('menu'));
    await this.bot.sleep(TRIAD_CLICK_GAP_MS);
    await this.bot.click(square ? boxCentre(square) : cellCentre(decision.cell), this.bot.delay('menu'));
    this.parkOffCards(live);
    await this.bot.sleep(TRIAD_SETTLE_MS);
    if (!this.bot.options.memory.latest()?.triad?.board?.[decision.cell]) this.bot.status('The card did not go down; trying again');
  }

  /** Learns from the board: how my cards' digits look in their cells, and which cards she has played. */
  private learnFromBoard(screen: TriadScreen, match: TriadMatch): void {
    screen.board.forEach((cell, i) => {
      if (!cell || match.unknown.has(i)) return;
      const mine = match.mine.get(i);
      if (!mine) {
        if (!match.hers.has(i)) match.hers.set(i, cardOf(cell).card);
        return;
      }
      // My card's numbers are known from my hand (where they're always read right).
      if (!mine.unread && !match.learned.has(i)) {
        const { top, left, right, bottom } = mine.card;
        this.bot.options.triad.reader.learnCard(boardSampler(this.bot.frame, i), [top, left, right, bottom]);
        match.learned.add(i);
      }
    });
  }

  // ---- Best deck ----

  /**
   * Puts the best five cards owned into the deck, through the card collection
   * window: for each slot to change, click the slot, then the card (on its
   * level's tab), then "Replace Slot N"; finally "Save Deck".
   */
  async deckLoop(): Promise<string> {
    const memory = this.bot.options.memory;
    if (!memory.installed) throw new BotError('Building a deck needs the memory reader (run scripts/setup-game-reader.ps1).');
    memory.start();
    let collection: MemoryCollection | null | undefined = null;
    for (const since = this.bot.clock.now(); !collection; ) {
      await this.bot.sleep(300);
      collection = memory.latest()?.collection;
      if (collection?.error) throw new BotError(`Couldn't read the card collection: ${collection.error}`);
      if (!collection) this.bot.statusEvery(memory.latest() ? 'Open the Triple Triad card collection window' : 'Starting the memory reader');
      if (!collection && this.bot.clock.now() - since > 120_000) throw new BotError('The card collection window never opened.');
    }

    let allowCopies = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      this.bot.status('Working out the best deck (trying combinations against random decks)...');
      await this.bot.clock.wait(50);
      const { owned, pool } = deckInputs(collection, allowCopies);
      const choice = chooseDeck(owned, pool, 1, rulesFromFlags(this.triadRules));
      if (!choice) throw new BotError('Not enough cards owned to make a deck of five.');
      const nameOf = (id: number) => owned.find((o) => o.id === id)?.name ?? `card ${id}`;
      const summary = `${choice.deck.map(nameOf).join(', ')} (won ${Math.round(choice.winRate * 100)}% of test games)`;

      // Keep the slots already holding a wanted card; fill the others.
      const draft = collection.draft;
      const wanted = [...choice.deck];
      const keep = [0, 1, 2, 3, 4].map((slot) => {
        const i = wanted.indexOf(draft[slot]);
        if (i < 0) return false;
        wanted.splice(i, 1);
        return true;
      });
      const changes = [0, 1, 2, 3, 4].flatMap((slot) => (keep[slot] ? [] : [{ slot, id: wanted.shift()! }]));
      if (changes.length === 0 && !collection.dirty) return `Your deck is already the best: ${summary}`;

      let failed: string | null = null;
      for (const { slot, id } of changes) {
        this.bot.status(`Putting ${nameOf(id)} in slot ${slot + 1}`);
        failed = await this.replaceDeckSlot(slot, id, nameOf(id));
        if (failed) break;
      }
      if (failed) {
        const current = (await memory.fresh())?.collection;
        if (current?.undo.enabled) await this.bot.click(boxCentre(current.undo), this.bot.delay('menu'));
        // The game may not allow two of the same card: try again without copies.
        if (allowCopies && new Set(choice.deck).size < choice.deck.length) {
          allowCopies = false;
          collection = (await memory.fresh())?.collection ?? collection;
          continue;
        }
        throw new BotError(failed);
      }

      const before = (await memory.fresh())?.collection;
      if (before?.save.enabled) {
        await this.bot.click(boxCentre(before.save), this.bot.delay('menu'));
        await this.bot.sleep(600);
      }
      const after = (await memory.fresh())?.collection;
      const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b).join();
      const saved = after && sorted(after.saved) === sorted(choice.deck);
      // Counted even if the save didn't show: the slots have changed either way.
      this.bot.stats.count('decks');
      return saved ? `Deck saved: ${summary}` : `Deck set but maybe not saved (press Save Deck): ${summary}`;
    }
    throw new BotError("Couldn't build the deck.");
  }

  /** Puts card `id` into deck slot `slot`; returns what went wrong, or null. */
  private async replaceDeckSlot(slot: number, id: number, name: string): Promise<string | null> {
    const memory = this.bot.options.memory;
    let c = (await memory.fresh())?.collection;
    if (!c) return 'The card collection window closed.';
    await this.bot.click(boxCentre(c.deckSlots[slot]), this.bot.delay('menu'));

    // Open the card's level tab.
    const level = c.cards.find((card) => card.image === id)?.level ?? 1;
    let tab = c.tabs.find((t) => t.level === level);
    if (!tab) return `There's no tab for level ${level} cards.`;
    if (!tab.selected) {
      await this.bot.click(boxCentre(tab.button), this.bot.delay('menu'));
      await this.bot.sleep(300);
    }
    c = (await memory.fresh())?.collection;
    tab = c?.tabs.find((t) => t.level === level);
    if (!c || !tab?.selected) return `Couldn't open the level ${level} tab.`;
    if (c.selectedSlot !== slot) return `Couldn't select deck slot ${slot + 1}.`;
    const where = tab.slots.find((s) => s.image === id && s.shown);
    if (!where) return `Can't see ${name} in the collection: clear the search box and filters.`;
    const point = boxCentre(where);
    const { panel } = tab;
    if (point.y < panel.y || point.y > panel.y + panel.height) return `${name} is scrolled out of view: scroll the collection back to the top.`;

    await this.bot.click(point, this.bot.delay('menu'));
    c = (await memory.fresh())?.collection;
    if (!c || c.detail !== id || !c.action.enabled || !c.action.text?.startsWith('Replace')) {
      return `Picking ${name} didn't offer to replace the slot${c?.feedback ? ` (${c.feedback})` : ''}.`;
    }
    await this.bot.click(boxCentre(c.action), this.bot.delay('menu'));
    await this.bot.sleep(200);
    c = (await memory.fresh())?.collection;
    if (c?.draft[slot] !== id) return `${name} didn't go into slot ${slot + 1}${c?.feedback ? ` (${c.feedback})` : ''}.`;
    return null;
  }
}

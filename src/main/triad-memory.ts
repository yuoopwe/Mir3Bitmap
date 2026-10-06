import type { Card } from './triad';
import { DigitReader } from './triad-digits';

const DECK_SIZE = 5;
/** Two readings that agree on this many of the four numbers are the same card (a number can be misread now and then). */
const SAME_CARD_SIDES = 3;

/** A card from an opponent's deck, with every reading of its numbers. */
interface DeckCard {
  /** For top, right, bottom and left: how often each number was read. */
  votes: Record<string, number>[];
  /** Matches it was played in. */
  seen: number;
}

const sidesOf = (card: Card) => [card.top, card.right, card.bottom, card.left];

/** The numbers read most often for each side. */
function consensus(card: DeckCard): Card {
  const [top, right, bottom, left] = card.votes.map((votes) => {
    const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    return ranked.length ? Number(ranked[0][0]) : 5;
  });
  return { top, right, bottom, left };
}

/**
 * What the bot remembers about Triple Triad between runs: how digits look on
 * the board, and each opponent's deck (opponents always play the same cards,
 * and those not yet played are face down).
 */
export class TriadMemory {
  readonly reader: DigitReader;
  private readonly decks = new Map<string, DeckCard[]>();

  constructor(private readonly onChange: () => void) {
    this.reader = new DigitReader(onChange);
  }

  /** An opponent's deck as far as it's known: up to five cards, the most played first. */
  deckOf(opponent: string): Card[] {
    const deck = this.decks.get(opponent) ?? [];
    return [...deck].sort((a, b) => b.seen - a.seen).slice(0, DECK_SIZE).map(consensus);
  }

  /** Records the cards an opponent played in a match. */
  remember(opponent: string, cards: Card[]): void {
    if (!opponent || cards.length === 0) return;
    const deck = this.decks.get(opponent) ?? [];
    const matched = new Set<DeckCard>();
    for (const card of cards) {
      const sides = sidesOf(card);
      // Cards from one match are all different cards.
      let entry = deck.find((d) => !matched.has(d) && sidesOf(consensus(d)).filter((v, i) => v === sides[i]).length >= SAME_CARD_SIDES);
      if (!entry) {
        entry = { votes: [{}, {}, {}, {}], seen: 0 };
        deck.push(entry);
      }
      matched.add(entry);
      sides.forEach((value, i) => (entry.votes[i][value] = (entry.votes[i][value] ?? 0) + 1));
      entry.seen++;
    }
    this.decks.set(opponent, deck);
    this.onChange();
  }

  load(saved: unknown): void {
    const data = saved as { digits?: unknown; decks?: Record<string, DeckCard[]> } | null;
    if (!data) return;
    this.reader.load(data.digits);
    for (const [opponent, deck] of Object.entries(data.decks ?? {})) {
      if (Array.isArray(deck)) this.decks.set(opponent, deck);
    }
  }

  toJSON(): { digits: [number, string][]; decks: Record<string, DeckCard[]> } {
    return { digits: this.reader.toJSON(), decks: Object.fromEntries(this.decks) };
  }
}

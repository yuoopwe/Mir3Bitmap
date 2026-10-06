import { BASIC_RULES, rankMoves, searchMove, type Card, type Game, type Placed, type Rules } from './triad';
import type { CardFace, TriadScreen } from './triad-vision';
import type { MemoryCard, MemoryTriad } from './game-memory';

const DECK_SIZE = 5;
/** Stands in for an opponent card that hasn't been seen yet: middling numbers. */
const UNSEEN: Card = { top: 4, right: 4, bottom: 4, left: 4 };
/** A number that couldn't be read is taken to be this (the digits not learned yet are the rarer high ones). */
const UNREAD_NUMBER = 6;

export interface ReadCard {
  card: Card;
  /** Some of its numbers couldn't be read and were guessed. */
  unread: boolean;
}

/** A card's numbers from its printed digits (top, left, right, bottom). */
export function cardOf(face: CardFace): ReadCard {
  const [top, left, right, bottom] = [0, 1, 2, 3].map((slot) => face.digits[slot]?.value ?? null);
  return {
    card: { top: top ?? UNREAD_NUMBER, right: right ?? UNREAD_NUMBER, bottom: bottom ?? UNREAD_NUMBER, left: left ?? UNREAD_NUMBER },
    unread: [top, left, right, bottom].some((value) => value === null),
  };
}

export const sameCard = (a: Card, b: Card) => a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;

export interface TriadContext {
  /** Cells where I've put my cards this match; the other cards on the board are hers. */
  mine?: Set<number>;
  /** Her deck as far as it's known (she always plays the same cards). */
  herDeck?: Card[];
  rules?: Rules;
}

export type TriadDecision =
  | {
      kind: 'move';
      handIndex: number;
      cell: number;
      /**
       * Expected final margin (my cards minus hers): from the screen, if she plays
       * greedily, as NPCs tend to; from memory, if both of us play perfectly.
       */
      expected: number;
      /** Final margin if she plays perfectly, when worked out to the end of the game. */
      worstCase: number | null;
      /** Some numbers were guessed: cards of hers never seen, or digits that couldn't be read. */
      guessed: boolean;
      summary: string;
    }
  | { kind: 'wait'; reason: string };

/** Works out the best move from the cards' numbers as read off the screen. */
export function decideTriad(screen: TriadScreen, context: TriadContext = {}): TriadDecision {
  if (screen.hand.length === 0) return { kind: 'wait', reason: 'No cards in hand' };
  const hand = screen.hand.map(cardOf);
  let unread = hand.some((card) => card.unread);
  const board: (Placed | null)[] = screen.board.map((cell) => {
    if (!cell) return null;
    const read = cardOf(cell);
    unread ||= read.unread;
    return { card: read.card, owner: cell.owner };
  });
  const empty = board.filter((cell) => !cell).length;
  if (empty === 0) return { kind: 'wait', reason: 'The board is full' };

  // Each of us starts with five cards; what's on the board and not mine is hers.
  const myPlaced = DECK_SIZE - hand.length;
  const herPlaced = Math.max(0, 9 - empty - myPlaced);
  const herHandSize = DECK_SIZE - herPlaced;
  const tracked = context.mine && context.mine.size === myPlaced;
  const hersOnBoard = board.flatMap((cell, i) => (cell && (tracked ? !context.mine!.has(i) : cell.owner === 'them') ? [cell.card] : []));
  const herLeft = [...(context.herDeck ?? [])];
  for (const card of hersOnBoard) {
    const i = herLeft.findIndex((c) => sameCard(c, card));
    if (i >= 0) herLeft.splice(i, 1);
  }
  herLeft.splice(herHandSize);
  // Her unseen cards only matter if she still has a move to make after mine.
  const guessedHers = herLeft.length < herHandSize && empty > 1;
  while (herLeft.length < herHandSize) herLeft.push(UNSEEN);

  const game: Game = { board, hands: { me: hand.map((c) => c.card), them: herLeft }, turn: 'me', rules: context.rules ?? BASIC_RULES };
  const best = rankMoves(game)[0];
  if (!best) return { kind: 'wait', reason: 'No move available' };
  const { card } = hand[best.move.card];
  return {
    kind: 'move',
    handIndex: best.move.card,
    cell: best.move.cell,
    expected: best.againstGreedy,
    worstCase: best.worstCase,
    guessed: guessedHers || unread,
    summary: `The ${card.top}-${card.left}-${card.right}-${card.bottom} card to square ${best.move.cell + 1}`,
  };
}

/** Library.TripleTriadRule flags. */
const RULE_SAME = 2;
const RULE_PLUS = 4;
const RULE_COMBO = 8;
export const RULE_ELEMENTAL = 16;

/** Cards and squares use the game's own element numbers, 0 being none (the reader's stand-in for an unknown card has 0 too). */
const cardFromMemory = (c: MemoryCard): Card => ({ top: c.up, right: c.right, bottom: c.down, left: c.left, element: c.element });

/** `from` with one of each of `take`'s cards (by picture) taken out. */
function without(from: MemoryCard[], take: MemoryCard[]): MemoryCard[] {
  const left = [...from];
  for (const card of take) {
    const i = left.findIndex((c) => c.image === card.image);
    if (i >= 0) left.splice(i, 1);
  }
  return left;
}

/**
 * The opponent's cards still in her hand: her deck less the ones she has put
 * down (the board's cards less the ones I put down, which are my deck less my hand).
 */
export function herCardsLeft(triad: MemoryTriad): MemoryCard[] {
  const minePlayed = without(triad.myDeck ?? [], (triad.hand ?? []).map((h) => h.card));
  const onBoard = (triad.board ?? []).filter((c): c is MemoryCard => !!c);
  return without(triad.opponentDeck ?? [], without(onBoard, minePlayed));
}

/** Which of the match's two players is the user (by name, else the one that isn't the computer). */
export function myIndex(triad: MemoryTriad): number {
  const players = triad.players ?? [];
  const byName = players.findIndex((p) => p.name === triad.playerName);
  if (byName >= 0) return byName;
  const human = players.findIndex((p) => !p.ai);
  return human >= 0 ? human : 0;
}

/** Whether it's my move, as the game's memory says. */
export function myTurnInMemory(triad: MemoryTriad): boolean {
  return !triad.complete && triad.current === myIndex(triad) && (triad.stage === 0 || triad.stage === -1);
}

/**
 * Works out the best move from the game's own memory: every number exact, and
 * her remaining cards known, so the whole game can be searched (see
 * searchMove). The decision's handIndex points into my hand in memory; `card`
 * is that card.
 */
export function decideFromMemory(triad: MemoryTriad): { decision: TriadDecision; card?: MemoryCard } {
  const me = myIndex(triad);
  const mine = (triad.hand ?? []).map((h) => h.card);
  const hers = herCardsLeft(triad);
  if (mine.length === 0) return { decision: { kind: 'wait', reason: 'No cards in hand' } };
  const board: (Placed | null)[] = (triad.board ?? []).map((c) => (c ? { card: cardFromMemory(c), owner: c.owner === me ? 'me' : 'them' } : null));
  while (board.length < 9) board.push(null);
  if (board.every((cell) => cell)) return { decision: { kind: 'wait', reason: 'The board is full' } };
  const flags = triad.rules ?? 0;
  const rules: Rules = { same: (flags & RULE_SAME) !== 0, plus: (flags & RULE_PLUS) !== 0, combo: (flags & RULE_COMBO) !== 0 };
  // The squares' elements only count under the Elemental rule.
  const elements = flags & RULE_ELEMENTAL ? triad.elements : undefined;
  const game: Game = { board, hands: { me: mine.map(cardFromMemory), them: hers.map(cardFromMemory) }, turn: 'me', rules, elements };
  const best = searchMove(game);
  if (!best) return { decision: { kind: 'wait', reason: 'No move available' } };
  const card = mine[best.move.card];
  return {
    card,
    decision: {
      kind: 'move',
      handIndex: best.move.card,
      cell: best.move.cell,
      expected: best.margin,
      worstCase: best.exact ? best.margin : null,
      guessed: false,
      summary: `${card.name} (${card.up}-${card.left}-${card.right}-${card.down}) to square ${best.move.cell + 1}`,
    },
  };
}

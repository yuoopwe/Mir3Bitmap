import { BASIC_RULES, greedyMove, play, score, type Card, type Game } from './triad';

/** A card in the collection: its numbers, which card it is, and how many copies are owned. */
export interface OwnedCard {
  id: number;
  name: string;
  card: Card;
  level: number;
  count: number;
}

export interface DeckChoice {
  /** The five cards, by id (a card owned twice can appear twice). */
  deck: number[];
  /** Share of the test games won, 0-1. */
  winRate: number;
  /** Average final margin (my cards minus hers) over the test games. */
  margin: number;
}

const DECK_SIZE = 5;
/** Only the strongest few cards are tried in every combination. */
const SHORTLIST = 10;
/** Every candidate deck plays each of these opponent decks twice (going first, then second). */
const QUICK_OPPONENTS = 60;
/** The leading candidates are then played against more decks, to pick between them. */
const FINALISTS = 10;
const FINAL_OPPONENTS = 300;

/** A small seeded random number generator, so the same collection always gets the same deck. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A quick guess at a card's strength: its numbers, with a bonus for two strong neighbouring sides (good in a corner). */
function quickValue({ top, right, bottom, left }: Card): number {
  return top + right + bottom + left + Math.max(top + right, right + bottom, bottom + left, left + top) / 2;
}

/** Plays a game with both sides moving greedily; returns my final margin. */
function playOut(mine: Card[], hers: Card[], meFirst: boolean): number {
  let game: Game = { board: Array(9).fill(null), hands: { me: mine, them: hers }, turn: meFirst ? 'me' : 'them', rules: BASIC_RULES };
  while (game.board.some((cell) => !cell)) {
    const move = greedyMove(game);
    if (!move) break;
    game = play(game, move);
  }
  return score(game, 'me') - score(game, 'them');
}

function evaluate(deck: OwnedCard[], opponents: Card[][]): { winRate: number; margin: number } {
  const mine = deck.map((c) => c.card);
  let wins = 0;
  let margin = 0;
  for (const hers of opponents) {
    for (const meFirst of [true, false]) {
      const result = playOut(mine, hers, meFirst);
      margin += result;
      if (result > 0) wins++;
    }
  }
  const games = opponents.length * 2;
  return { winRate: wins / games, margin: margin / games };
}

/**
 * The best five cards from the collection: the strongest cards are tried in
 * every combination against random decks drawn from `pool` (the cards
 * opponents might hold), both sides playing the way NPCs do.
 */
export function chooseDeck(owned: OwnedCard[], pool: Card[], seed = 1): DeckChoice | null {
  // One entry per copy owned, strongest first.
  const copies = owned.flatMap((c) => Array.from({ length: Math.max(0, c.count) }, () => c));
  copies.sort((a, b) => quickValue(b.card) - quickValue(a.card));
  if (copies.length < DECK_SIZE || pool.length === 0) return null;
  const shortlist = copies.slice(0, SHORTLIST);

  const rand = random(seed);
  const opponentDecks = (n: number) => Array.from({ length: n }, () => Array.from({ length: DECK_SIZE }, () => pool[Math.floor(rand() * pool.length)]));

  // Every combination of five from the shortlist (identical combinations once).
  const candidates: OwnedCard[][] = [];
  const seen = new Set<string>();
  const pick = (start: number, chosen: OwnedCard[]) => {
    if (chosen.length === DECK_SIZE) {
      const key = chosen.map((c) => c.id).sort((a, b) => a - b).join(',');
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push([...chosen]);
      }
      return;
    }
    for (let i = start; i <= shortlist.length - (DECK_SIZE - chosen.length); i++) pick(i + 1, [...chosen, shortlist[i]]);
  };
  pick(0, []);

  const quick = opponentDecks(QUICK_OPPONENTS);
  const ranked = candidates.map((deck) => ({ deck, ...evaluate(deck, quick) })).sort((a, b) => b.margin - a.margin);
  const final = opponentDecks(FINAL_OPPONENTS);
  const best = ranked
    .slice(0, FINALISTS)
    .map(({ deck }) => ({ deck, ...evaluate(deck, final) }))
    .sort((a, b) => b.margin - a.margin)[0];
  return { deck: best.deck.map((c) => c.id), winRate: best.winRate, margin: best.margin };
}

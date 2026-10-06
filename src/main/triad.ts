/**
 * Triple Triad: a 3x3 board, five cards each, players take turns placing a
 * card. A card's four numbers (1-10, "A" = 10) face up, right, down and left;
 * placing a card captures each adjacent enemy card whose touching number is
 * lower. Whoever owns more cards at the end (board plus hand) wins.
 */

export interface Card {
  top: number;
  right: number;
  bottom: number;
  left: number;
  /** Its element for the Elemental rule (the game's numbering; 0 or missing = none). */
  element?: number;
}

type Side = 'top' | 'right' | 'bottom' | 'left';

export type Player = 'me' | 'them';

export interface Rules {
  /** A card touching two or more cards with equal numbers captures them all. */
  same: boolean;
  /** A card whose numbers add up to the same total with two or more neighbours captures them all. */
  plus: boolean;
  /** Cards captured by Same/Plus go on to capture their own neighbours, as if just placed. */
  combo: boolean;
}

export const BASIC_RULES: Rules = { same: false, plus: false, combo: false };

/** Board cells are numbered 0-8, left to right, top to bottom. */
export interface Placed {
  card: Card;
  owner: Player;
}

export interface Game {
  board: (Placed | null)[];
  hands: Record<Player, Card[]>;
  turn: Player;
  rules: Rules;
  /** Elemental rule: each square's element (cells 0-8, 0 = none). Left out when the rule is off. */
  elements?: number[];
}

export interface Move {
  /** Index into the mover's hand. */
  card: number;
  cell: number;
}

const other = (p: Player): Player => (p === 'me' ? 'them' : 'me');

/** For each cell: its neighbours as [cell, my side facing it, their side facing me]. */
const NEIGHBOURS: [number, Side, Side][][] = Array.from({ length: 9 }, (_, cell) => {
  const r = Math.floor(cell / 3), c = cell % 3;
  const list: [number, Side, Side][] = [];
  if (r > 0) list.push([cell - 3, 'top', 'bottom']);
  if (c < 2) list.push([cell + 1, 'right', 'left']);
  if (r < 2) list.push([cell + 3, 'bottom', 'top']);
  if (c > 0) list.push([cell - 1, 'left', 'right']);
  return list;
});

/**
 * Elemental: whether Same and Plus compare the numbers after the square's
 * +1/-1 (true, as in FF8) or the printed ones (false). Not checked against
 * this game; flip here if it turns out to use the printed numbers.
 */
const ELEMENTAL_AFFECTS_SAME_PLUS = true;

/**
 * A card's number on one side, standing on a square with `element`: +1 if
 * the card's element matches, -1 if it doesn't (or the card has none). Kept
 * to 1-10, the range the printed numbers have (A = 10). No element, no change.
 */
export function sideValue(card: Card, side: Side, element: number | undefined): number {
  if (!element) return card[side];
  const value = card[side] + (card.element === element ? 1 : -1);
  return Math.min(10, Math.max(1, value));
}

/** Places a card and applies captures. Returns the new board (the input isn't changed). */
export function place(board: (Placed | null)[], cell: number, card: Card, owner: Player, rules: Rules, elements: number[] = []): (Placed | null)[] {
  const next = board.slice();
  next[cell] = { card, owner };
  // The number on a side of the card in square n, after its square's element.
  const at = (n: number, side: Side) => sideValue(next[n]!.card, side, elements[n]);

  // Same and Plus look at every neighbour, friend or foe, but only flip foes.
  const special = new Set<number>();
  if (rules.same || rules.plus) {
    const number = ELEMENTAL_AFFECTS_SAME_PLUS ? at : (n: number, side: Side) => next[n]!.card[side];
    const touching = NEIGHBOURS[cell].filter(([n]) => next[n]).map(([n, mine, theirs]) => ({ n, mine: number(cell, mine), theirs: number(n, theirs) }));
    if (rules.same) {
      const equal = touching.filter((t) => t.mine === t.theirs);
      if (equal.length >= 2) for (const t of equal) special.add(t.n);
    }
    if (rules.plus) {
      const sums = new Map<number, number[]>();
      for (const t of touching) sums.set(t.mine + t.theirs, [...(sums.get(t.mine + t.theirs) ?? []), t.n]);
      for (const cells of sums.values()) if (cells.length >= 2) for (const n of cells) special.add(n);
    }
  }

  const flipped: number[] = [];
  for (const n of special) {
    if (next[n]!.owner !== owner) {
      next[n] = { card: next[n]!.card, owner };
      flipped.push(n);
    }
  }
  // Ordinary captures: higher touching number wins.
  for (const [n, mine, theirs] of NEIGHBOURS[cell]) {
    const there = next[n];
    if (there && there.owner !== owner && at(cell, mine) > at(n, theirs)) next[n] = { card: there.card, owner };
  }
  // Combo: cards flipped by Same/Plus capture their weaker neighbours in turn.
  if (rules.combo) {
    const queue = [...flipped];
    while (queue.length) {
      const from = queue.shift()!;
      for (const [n, mine, theirs] of NEIGHBOURS[from]) {
        const there = next[n];
        if (there && there.owner !== owner && at(from, mine) > at(n, theirs)) {
          next[n] = { card: there.card, owner };
          queue.push(n);
        }
      }
    }
  }
  return next;
}

/** Cards owned by `player`: on the board plus still in hand. */
export function score(game: Game, player: Player): number {
  return game.board.filter((p) => p?.owner === player).length + game.hands[player].length;
}

export function play(game: Game, move: Move): Game {
  const hand = game.hands[game.turn];
  const card = hand[move.card];
  return {
    board: place(game.board, move.cell, card, game.turn, game.rules, game.elements),
    hands: { ...game.hands, [game.turn]: hand.filter((_, i) => i !== move.card) },
    turn: other(game.turn),
    rules: game.rules,
    elements: game.elements,
  };
}

export function legalMoves(game: Game): Move[] {
  const moves: Move[] = [];
  const hand = game.hands[game.turn];
  const seen = new Set<string>();
  for (let card = 0; card < hand.length; card++) {
    // Identical cards are the same move.
    const key = cardKey(hand[card]);
    if (seen.has(key)) continue;
    seen.add(key);
    for (let cell = 0; cell < 9; cell++) if (!game.board[cell]) moves.push({ card, cell });
  }
  return moves;
}

/** Card keys worked out already: positions are keyed hundreds of thousands of times in a search. */
const cardKeys = new WeakMap<Card, string>();

function cardKey(c: Card): string {
  let key = cardKeys.get(c);
  if (key === undefined) {
    // The element matters on elemental squares: same numbers, different element, different card.
    key = `${c.top}${c.right}${c.bottom}${c.left}`.replace(/10/g, 'A') + (c.element ? `e${c.element}` : '');
    cardKeys.set(c, key);
  }
  return key;
}

/** A position (the squares' elements stay the same all game, so they're left out). */
function stateKey(game: Game): string {
  const board = game.board.map((p) => (p ? (p.owner === 'me' ? 'm' : 't') + cardKey(p.card) : '-')).join('');
  const hand = (cards: Card[]) => cards.map(cardKey).sort().join(',');
  return `${game.turn}|${board}|${hand(game.hands.me)}|${hand(game.hands.them)}`;
}

export interface Advice {
  move: Move;
  /** My final card count minus theirs with best play from both sides (positive = I win). */
  margin: number;
  /** Moves known to be as good (`move` first): searchMove looks for them, bestMove doesn't. */
  tied: Move[];
}

/**
 * The best move for whoever's turn it is, assuming both sides play perfectly
 * from here (full search with alpha-beta pruning and a memory of positions).
 */
export function bestMove(game: Game): Advice | null {
  return new Solver().best(game);
}

export interface Search extends Advice {
  /** Searched to the end of the game; if not, `margin` is the card count `depth` moves ahead. */
  exact: boolean;
  depth: number;
}

/**
 * Positions the full search may look at for one move before giving up (half
 * a second or so here). The second move of a game, 8 squares empty, mostly
 * fits; with every rule on, now and then it doesn't.
 */
export const SEARCH_POSITIONS = 150_000;
/**
 * How many moves ahead to look when the whole game is too big to search: the
 * opening (about a million positions, seconds). An even number, so both sides
 * have had as many moves when it stops. Under half a second here.
 */
export const LOOKAHEAD = 6;
/** Positions the LOOKAHEAD search may spend after that finding the moves that tie with the best (a fifth of a second or so). */
export const TIE_POSITIONS = 30_000;

/**
 * The best move for whoever's turn it is, assuming both sides play perfectly
 * (both hands known). Searches to the end of the game if it fits in
 * `positions`; otherwise LOOKAHEAD moves ahead, valued there by the cards each
 * side holds. An empty board never fits, so it isn't tried.
 */
export function searchMove(game: Game, positions = SEARCH_POSITIONS): Search | null {
  const filled = game.board.filter((p) => p).length;
  const toEnd = 9 - filled;
  if (filled > 0) {
    const solver = new Solver(9, positions);
    const full = solver.tryBest(game);
    // The ties share the full search's positions: what it didn't need.
    if (full !== undefined) return full && { ...full, tied: solver.tiedWith(game, full), exact: true, depth: toEnd };
  }
  const depth = Math.min(LOOKAHEAD, toEnd);
  const solver = new Solver(filled + depth);
  const advice = solver.best(game);
  return advice && { ...advice, tied: solver.tiedWith(game, advice, TIE_POSITIONS), exact: depth === toEnd, depth };
}

/** Thrown when a search has looked at as many positions as it may. */
class OutOfPositions extends Error {}

/**
 * Perfect-play search (negamax with alpha-beta pruning) with a memory of
 * positions already worked out, which can be shared between searches.
 *
 * The score is the final margin (my cards minus theirs), so a win always
 * beats a draw, a draw beats a loss, and a bigger win beats a smaller one.
 */
export class Solver {
  private readonly memo = new Map<string, { value: number; flag: 0 | 1 | 2 }>(); // 0 exact, 1 lower bound, 2 upper bound

  /**
   * @param horizon stop once the board has this many cards and count the cards each side has (9 = play to the end)
   * @param positions how many positions it may look at before giving up (see tryBest)
   */
  constructor(private readonly horizon = 9, private positions = Infinity) {}

  /** My final card count minus theirs if both sides play perfectly from here. */
  value(game: Game): number {
    const v = this.negamax(game, -Infinity, Infinity);
    return game.turn === 'me' ? v : -v;
  }

  best(game: Game): Advice | null {
    const sign = game.turn === 'me' ? 1 : -1;
    let result: Advice | null = null;
    let alpha = -Infinity;
    for (const { move, next } of orderedMoves(game)) {
      const v = -this.negamax(next, -Infinity, -alpha);
      if (!result || v > result.margin * sign) {
        result = { move, margin: v * sign, tied: [move] };
        alpha = v;
      }
    }
    return result;
  }

  /**
   * The moves as good as `best` (the result of best()), it first, as far as
   * `positions` allow (by default, what's left of the solver's): proving a
   * tie means searching all her replies, so a big position may have more.
   */
  tiedWith(game: Game, best: Advice, positions = this.positions): Move[] {
    const alpha = game.turn === 'me' ? best.margin : -best.margin;
    const tied = [best.move];
    this.positions = positions;
    try {
      for (const { move, next } of orderedMoves(game)) {
        if (move.card === best.move.card && move.cell === best.move.cell) continue;
        // Nothing beats the best, and margins are whole numbers: a move worth at least alpha is worth alpha.
        // Asking only that (a search between alpha - 1 and alpha) is much quicker than its exact value.
        if (-this.negamax(next, -alpha, -(alpha - 1)) >= alpha) tied.push(move);
      }
    } catch (e) {
      if (!(e instanceof OutOfPositions)) throw e;
    }
    return tied;
  }

  /** As best, but undefined if it ran out of positions to look at. */
  tryBest(game: Game): Advice | null | undefined {
    try {
      return this.best(game);
    } catch (e) {
      if (e instanceof OutOfPositions) return undefined;
      throw e;
    }
  }

  /** Value from the point of view of the player to move. */
  private negamax(g: Game, alpha: number, beta: number): number {
    const filled = g.board.filter((p) => p).length;
    if (filled >= this.horizon || g.hands[g.turn].length === 0) {
      const v = score(g, 'me') - score(g, 'them');
      return g.turn === 'me' ? v : -v;
    }
    if (--this.positions < 0) throw new OutOfPositions();
    // A move or two from the end there's too little left for sorting moves or remembering positions to pay.
    if (this.horizon - filled <= 2) {
      let best = -Infinity;
      for (const move of legalMoves(g)) {
        best = Math.max(best, -this.negamax(play(g, move), -beta, -Math.max(alpha, best)));
        if (best >= beta) break;
      }
      return best;
    }
    const key = stateKey(g);
    const hit = this.memo.get(key);
    const alpha0 = alpha;
    if (hit) {
      if (hit.flag === 0) return hit.value;
      if (hit.flag === 1) alpha = Math.max(alpha, hit.value);
      else beta = Math.min(beta, hit.value);
      if (alpha >= beta) return hit.value;
    }
    let best = -Infinity;
    for (const { next } of orderedMoves(g)) {
      const v = -this.negamax(next, -beta, -alpha);
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    this.memo.set(key, { value: best, flag: best <= alpha0 ? 2 : best >= beta ? 1 : 0 });
    return best;
  }
}

/**
 * Every move with the position it leads to, the most promising first by
 * heuristicMove's measure: searching good moves early makes the pruning much
 * more effective.
 */
function orderedMoves(game: Game): { move: Move; next: Game }[] {
  return legalMoves(game)
    .map((move) => {
      const next = play(game, move);
      return { move, next, value: promise(game, next) };
    })
    .sort((a, b) => b.value - a.value);
}

/**
 * How good a move looks without searching: captures count most; then how
 * exposed the mover's placed cards are (weak numbers facing empty cells an
 * opponent could fill).
 */
function promise(before: Game, after: Game): number {
  const mover = before.turn;
  const captured = after.board.filter((p) => p?.owner === mover).length - before.board.filter((p) => p?.owner === mover).length;
  let exposure = 0;
  for (let cell = 0; cell < 9; cell++) {
    const p = after.board[cell];
    if (!p || p.owner !== mover) continue;
    for (const [n, side] of NEIGHBOURS[cell]) if (!after.board[n]) exposure += 10 - sideValue(p.card, side, after.elements?.[cell]);
  }
  return captured * 20 - exposure;
}

/** When the opponent's hand is hidden: the move that looks best now (see promise). */
export function heuristicMove(game: Game): Move | null {
  let best: { move: Move; value: number } | null = null;
  for (const move of legalMoves(game)) {
    const value = promise(game, play(game, move));
    if (!best || value > best.value) best = { move, value };
  }
  return best?.move ?? null;
}

/**
 * How a typical card-game AI moves: grab as many cards as possible right now,
 * and among equal grabs, leave the weakest numbers exposed to empty squares.
 */
export function greedyMove(game: Game): Move | null {
  const owned = (g: Game) => g.board.filter((p) => p?.owner === game.turn).length;
  let best: { move: Move; gain: number; exposure: number } | null = null;
  for (const move of legalMoves(game)) {
    const after = play(game, move);
    const gain = owned(after) - owned(game);
    let exposure = 0;
    const placed = after.board[move.cell]!.card;
    for (const [n, side] of NEIGHBOURS[move.cell]) if (!after.board[n]) exposure += 10 - placed[side];
    if (!best || gain > best.gain || (gain === best.gain && exposure < best.exposure)) best = { move, gain, exposure };
  }
  return best?.move ?? null;
}

export interface RankedMove {
  move: Move;
  /** My final margin if the opponent always plays greedyMove and I reply as well as possible. */
  againstGreedy: number;
  /** My final margin against a perfect opponent (worked out for the leading moves only). */
  worstCase: number | null;
}

/** Most leading moves to work out the worst case for (each is a full search). */
const WORST_CASE_CANDIDATES = 8;

/**
 * Every move for me, ranked: first by the result against a greedy opponent
 * (how NPCs tend to play), then, among the leaders, by the result against a
 * perfect one, so the safest of equally good moves is chosen.
 */
/**
 * My final margin if she always plays greedyMove and I reply as well as
 * possible. With a `horizon`, stops once the board has that many cards and
 * counts the cards each side has, as a depth-limited search does.
 */
function againstGreedy(g: Game, memo: Map<string, number>, horizon = 9): number {
  if (g.board.filter((p) => p).length >= horizon || g.hands[g.turn].length === 0) return score(g, 'me') - score(g, 'them');
  const key = stateKey(g);
  const known = memo.get(key);
  if (known !== undefined) return known;
  let value: number;
  if (g.turn === 'them') value = againstGreedy(play(g, greedyMove(g)!), memo, horizon);
  else {
    value = -Infinity;
    for (const move of legalMoves(g)) value = Math.max(value, againstGreedy(play(g, move), memo, horizon));
  }
  memo.set(key, value);
  return value;
}

/**
 * Of the moves searchMove found equally good against a perfect opponent, the
 * one that does best if she plays greedily instead, as the game's NPCs seem
 * to. Looks as far ahead as the search did (the whole game if it was exact).
 */
export function preferAgainstGreedy(game: Game, search: Search): { move: Move; againstGreedy: number } {
  if (game.turn !== 'me') throw new Error('preferAgainstGreedy is for my turn');
  const horizon = search.exact ? 9 : game.board.filter((p) => p).length + search.depth;
  const memo = new Map<string, number>();
  let best: { move: Move; againstGreedy: number } | null = null;
  for (const move of search.tied) {
    const value = againstGreedy(play(game, move), memo, horizon);
    if (!best || value > best.againstGreedy) best = { move, againstGreedy: value };
  }
  return best!;
}

export function rankMoves(game: Game): RankedMove[] {
  if (game.turn !== 'me') throw new Error('rankMoves is for my turn');
  const memo = new Map<string, number>();
  const ranked: RankedMove[] = orderedMoves(game).map(({ move, next }) => ({ move, againstGreedy: againstGreedy(next, memo), worstCase: null }));
  ranked.sort((a, b) => b.againstGreedy - a.againstGreedy);
  const solver = new Solver();
  for (const r of ranked.filter((r) => r.againstGreedy === ranked[0].againstGreedy).slice(0, WORST_CASE_CANDIDATES)) {
    r.worstCase = solver.value(play(game, r.move));
  }
  return ranked.sort((a, b) => b.againstGreedy - a.againstGreedy || (b.worstCase ?? -Infinity) - (a.worstCase ?? -Infinity));
}

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
}

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
}

export interface Move {
  /** Index into the mover's hand. */
  card: number;
  cell: number;
}

const other = (p: Player): Player => (p === 'me' ? 'them' : 'me');

/** For each cell: its neighbours as [cell, my side facing it, their side facing me]. */
const NEIGHBOURS: [number, keyof Card, keyof Card][][] = Array.from({ length: 9 }, (_, cell) => {
  const r = Math.floor(cell / 3), c = cell % 3;
  const list: [number, keyof Card, keyof Card][] = [];
  if (r > 0) list.push([cell - 3, 'top', 'bottom']);
  if (c < 2) list.push([cell + 1, 'right', 'left']);
  if (r < 2) list.push([cell + 3, 'bottom', 'top']);
  if (c > 0) list.push([cell - 1, 'left', 'right']);
  return list;
});

/** Places a card and applies captures. Returns the new board (the input isn't changed). */
export function place(board: (Placed | null)[], cell: number, card: Card, owner: Player, rules: Rules): (Placed | null)[] {
  const next = board.slice();
  next[cell] = { card, owner };

  // Same and Plus look at every neighbour, friend or foe, but only flip foes.
  const special = new Set<number>();
  if (rules.same || rules.plus) {
    const touching = NEIGHBOURS[cell].filter(([n]) => next[n]).map(([n, mine, theirs]) => ({ n, mine: card[mine], theirs: next[n]!.card[theirs] }));
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
    if (there && there.owner !== owner && card[mine] > there.card[theirs]) next[n] = { card: there.card, owner };
  }
  // Combo: cards flipped by Same/Plus capture their weaker neighbours in turn.
  if (rules.combo) {
    const queue = [...flipped];
    while (queue.length) {
      const from = queue.shift()!;
      const attacker = next[from]!.card;
      for (const [n, mine, theirs] of NEIGHBOURS[from]) {
        const there = next[n];
        if (there && there.owner !== owner && attacker[mine] > there.card[theirs]) {
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
    board: place(game.board, move.cell, card, game.turn, game.rules),
    hands: { ...game.hands, [game.turn]: hand.filter((_, i) => i !== move.card) },
    turn: other(game.turn),
    rules: game.rules,
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

function cardKey(c: Card): string {
  return `${c.top}${c.right}${c.bottom}${c.left}`.replace(/10/g, 'A');
}

function stateKey(game: Game): string {
  const board = game.board.map((p) => (p ? (p.owner === 'me' ? 'm' : 't') + cardKey(p.card) : '-')).join('');
  const hand = (cards: Card[]) => cards.map(cardKey).sort().join(',');
  return `${game.turn}|${board}|${hand(game.hands.me)}|${hand(game.hands.them)}`;
}

export interface Advice {
  move: Move;
  /** My final card count minus theirs with best play from both sides (positive = I win). */
  margin: number;
}

/**
 * The best move for whoever's turn it is, assuming both sides play perfectly
 * from here (full search with alpha-beta pruning and a memory of positions).
 */
export function bestMove(game: Game): Advice | null {
  return new Solver().best(game);
}

/**
 * Perfect-play search (negamax with alpha-beta pruning) with a memory of
 * positions already worked out, which can be shared between searches.
 */
export class Solver {
  private readonly memo = new Map<string, { value: number; flag: 0 | 1 | 2 }>(); // 0 exact, 1 lower bound, 2 upper bound

  /** My final card count minus theirs if both sides play perfectly from here. */
  value(game: Game): number {
    const v = this.negamax(game, -Infinity, Infinity);
    return game.turn === 'me' ? v : -v;
  }

  best(game: Game): Advice | null {
    const sign = game.turn === 'me' ? 1 : -1;
    let result: Advice | null = null;
    let alpha = -Infinity;
    for (const move of orderedMoves(game)) {
      const v = -this.negamax(play(game, move), -Infinity, -alpha);
      if (!result || v > result.margin * sign) {
        result = { move, margin: v * sign };
        alpha = v;
      }
    }
    return result;
  }

  /** Value from the point of view of the player to move. */
  private negamax(g: Game, alpha: number, beta: number): number {
    if (g.board.every((p) => p) || g.hands[g.turn].length === 0) {
      const v = score(g, 'me') - score(g, 'them');
      return g.turn === 'me' ? v : -v;
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
    for (const move of orderedMoves(g)) {
      const v = -this.negamax(play(g, move), -beta, -alpha);
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    this.memo.set(key, { value: best, flag: best <= alpha0 ? 2 : best >= beta ? 1 : 0 });
    return best;
  }
}

/** Captures first: searching good moves early makes the pruning much more effective. */
function orderedMoves(game: Game): Move[] {
  const mine = (g: Game) => g.board.filter((p) => p?.owner === game.turn).length;
  const before = mine(game);
  return legalMoves(game)
    .map((move) => ({ move, gain: mine(play(game, move)) - before }))
    .sort((a, b) => b.gain - a.gain)
    .map((m) => m.move);
}

/**
 * When the opponent's hand is hidden: a move that's good now and leaves little
 * to attack. Captures count most; then how exposed my placed cards are (weak
 * numbers facing empty cells an opponent could fill).
 */
export function heuristicMove(game: Game): Move | null {
  let best: { move: Move; value: number } | null = null;
  for (const move of legalMoves(game)) {
    const after = play(game, move);
    const captured = after.board.filter((p) => p?.owner === game.turn).length - game.board.filter((p) => p?.owner === game.turn).length;
    let exposure = 0;
    for (let cell = 0; cell < 9; cell++) {
      const p = after.board[cell];
      if (!p || p.owner !== game.turn) continue;
      for (const [n, side] of NEIGHBOURS[cell]) if (!after.board[n]) exposure += 10 - p.card[side];
    }
    const value = captured * 20 - exposure;
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
export function rankMoves(game: Game): RankedMove[] {
  if (game.turn !== 'me') throw new Error('rankMoves is for my turn');
  const greedyMemo = new Map<string, number>();
  const againstGreedy = (g: Game): number => {
    if (g.board.every((p) => p) || g.hands[g.turn].length === 0) return score(g, 'me') - score(g, 'them');
    const key = stateKey(g);
    const known = greedyMemo.get(key);
    if (known !== undefined) return known;
    let value: number;
    if (g.turn === 'them') value = againstGreedy(play(g, greedyMove(g)!));
    else {
      value = -Infinity;
      for (const move of legalMoves(g)) value = Math.max(value, againstGreedy(play(g, move)));
    }
    greedyMemo.set(key, value);
    return value;
  };

  const ranked: RankedMove[] = orderedMoves(game).map((move) => ({ move, againstGreedy: againstGreedy(play(game, move)), worstCase: null }));
  ranked.sort((a, b) => b.againstGreedy - a.againstGreedy);
  const solver = new Solver();
  for (const r of ranked.filter((r) => r.againstGreedy === ranked[0].againstGreedy).slice(0, WORST_CASE_CANDIDATES)) {
    r.worstCase = solver.value(play(game, r.move));
  }
  return ranked.sort((a, b) => b.againstGreedy - a.againstGreedy || (b.worstCase ?? -Infinity) - (a.worstCase ?? -Infinity));
}

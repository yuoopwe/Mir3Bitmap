import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BASIC_RULES, bestMove, heuristicMove, place, play, score, type Card, type Game, type Placed } from '../main/triad';

const card = (top: number, right: number, bottom: number, left: number): Card => ({ top, right, bottom, left });
const empty = (): (Placed | null)[] => Array(9).fill(null);

// The hand from the screenshot (top, right, bottom, left).
const MY_HAND = [card(2, 1, 2, 6), card(1, 5, 4, 1), card(1, 3, 3, 5), card(4, 2, 4, 3), card(5, 1, 3, 5)];

test('a higher touching number captures; equal or lower does not', () => {
  const board = empty();
  board[1] = { card: card(5, 5, 5, 3), owner: 'them' };
  board[3] = { card: card(5, 4, 5, 5), owner: 'them' };
  // Placed in the middle: its top (4) beats cell 1's bottom (... 5)? no; its left (6) beats cell 3's right (4).
  const after = place(board, 4, card(4, 1, 1, 6), 'me', BASIC_RULES);
  assert.equal(after[1]!.owner, 'them');
  assert.equal(after[3]!.owner, 'me');
  assert.equal(after[4]!.owner, 'me');
});

test('Same and Plus capture, and Combo carries on', () => {
  const board = empty();
  board[1] = { card: card(1, 1, 3, 1), owner: 'them' }; // touches the middle with 3
  board[5] = { card: card(1, 1, 1, 7), owner: 'them' }; // touches the middle with 7
  board[2] = { card: card(1, 1, 1, 1), owner: 'them' }; // next to cell 1 and 5
  const middle = card(3, 7, 1, 1);
  // Same: 3 = 3 and 7 = 7, so both flip even though neither is beaten.
  const same = place(board, 4, middle, 'me', { same: true, plus: false, combo: false });
  assert.equal(same[1]!.owner, 'me');
  assert.equal(same[5]!.owner, 'me');
  assert.equal(same[2]!.owner, 'them');
  // Combo: a card flipped by Same then captures its own weaker neighbour (cell 1's right 5 beats cell 2's left 1).
  const comboBoard = board.slice();
  comboBoard[1] = { card: card(1, 5, 3, 1), owner: 'them' };
  assert.equal(place(comboBoard, 4, middle, 'me', { same: true, plus: false, combo: false })[2]!.owner, 'them');
  assert.equal(place(comboBoard, 4, middle, 'me', { same: true, plus: false, combo: true })[2]!.owner, 'me');

  // Plus: 2+5 = 3+4.
  const plusBoard = empty();
  plusBoard[1] = { card: card(1, 1, 5, 1), owner: 'them' };
  plusBoard[3] = { card: card(1, 4, 1, 1), owner: 'them' };
  const plus = place(plusBoard, 4, card(2, 1, 1, 3), 'me', { same: false, plus: true, combo: false });
  assert.equal(plus[1]!.owner, 'me');
  assert.equal(plus[3]!.owner, 'me');
});

test('finds the best move with every card known, quickly', () => {
  const game: Game = {
    board: empty(),
    hands: { me: MY_HAND, them: [card(3, 2, 4, 1), card(2, 5, 1, 3), card(4, 1, 3, 2), card(1, 4, 2, 5), card(3, 3, 3, 3)] },
    turn: 'me',
    rules: BASIC_RULES,
  };
  const started = Date.now();
  const advice = bestMove(game);
  const ms = Date.now() - started;
  assert.ok(advice);
  assert.ok(ms < 20000, `took ${ms} ms`);
  console.log(`full search from an empty board: ${ms} ms, margin ${advice.margin}`);

  // Playing it out with perfect play from both sides gives the promised margin.
  let g = game;
  while (g.board.some((p) => !p) && g.hands[g.turn].length) g = play(g, bestMove(g)!.move);
  assert.equal(score(g, 'me') - score(g, 'them'), advice.margin);
});

test('takes a winning capture when one is there', () => {
  const board = empty();
  board[0] = { card: card(9, 1, 9, 9), owner: 'them' }; // weak right side
  const game: Game = { board, hands: { me: [card(1, 1, 1, 9), card(1, 1, 1, 1)], them: [card(5, 5, 5, 5)] }, turn: 'me', rules: BASIC_RULES };
  const advice = bestMove(game)!;
  assert.deepEqual(advice.move, { card: 0, cell: 1 });
  assert.deepEqual(heuristicMove(game), { card: 0, cell: 1 });
});

// ---- Reading the screen ----

import path from 'node:path';
import { DigitReader } from '../main/triad-digits';
import { TriadMemory } from '../main/triad-memory';
import { cardOf, decideTriad } from '../main/triad-player';
import { boardSampler, readTriad, type CardFace } from '../main/triad-vision';
import { loadPng } from './png';

const triadFixture = (name: string) => loadPng(path.join(__dirname, '..', '..', 'src', 'test', name));
const reader = new DigitReader();
/** A card's printed numbers as a string, top-left-right-bottom ('?' where unreadable). */
const printed = (face: CardFace | null) => (face ? face.digits.map((d) => d.value ?? '?').join('') : null);

test('reads the Triple Triad screen: panel, turn, hand, board and the end box', () => {
  assert.equal(readTriad(triadFixture('fixture-triad-closed.png')).open, false);

  const start = readTriad(triadFixture('fixture-triad-start.png'));
  assert.ok(start.open && start.myTurn && !start.over);
  assert.equal(start.hand.length, 5);
  assert.ok(start.board.every((cell) => cell === null));

  // Mid-game: blue borders are mine, red hers (checked against the screenshot).
  const mid = readTriad(triadFixture('fixture-triad-mid.png'));
  assert.equal(mid.hand.length, 1);
  assert.deepEqual(mid.board.map((c) => c?.owner ?? null), ['them', 'me', 'them', null, 'them', 'them', 'me', 'them', 'them']);

  const over = readTriad(triadFixture('fixture-triad-over.png'));
  assert.ok(over.open && over.over && !over.myTurn);
});

test("an empty square next to a card isn't taken for that card (the last card can be played)", () => {
  // One card left; square 8 is empty, between my Imp and my Anacondaur.
  const last = readTriad(triadFixture('fixture-triad-lastcard.png'));
  assert.deepEqual(last.board.map((c) => c?.owner ?? null), ['me', 'them', 'them', 'them', 'them', 'them', 'me', null, 'me']);
  const decision = decideTriad(readTriad(triadFixture('fixture-triad-lastcard.png'), reader));
  assert.ok(decision.kind === 'move' && decision.cell === 7 && decision.handIndex === 0, JSON.stringify(decision));
});

test("reads the cards' numbers, in the hand and on the board", () => {
  // Two different decks (top, left, right, bottom as printed).
  assert.deepEqual(readTriad(triadFixture('fixture-triad-hand2.png'), reader).hand.map(printed), ['2612', '6211', '1154', '2414', '5325']);
  assert.deepEqual(readTriad(triadFixture('fixture-triad-start.png'), reader).hand.map(printed), ['2612', '1154', '1533', '4324', '5513']);

  // The board is drawn slanted, bigger towards the bottom.
  const mid = readTriad(triadFixture('fixture-triad-mid.png'), reader);
  assert.deepEqual(mid.board.map(printed), ['5454', '2612', '1533', null, '5364', '6435', '5513', '5445', '1154']);
  // Printed top-left-right-bottom; played as top, right, bottom, left.
  assert.deepEqual(cardOf(mid.board[4]!).card, { top: 5, right: 6, bottom: 4, left: 3 });

  // A card half under a tooltip: what can't be read is left unread rather than guessed wrong.
  const covered = readTriad(triadFixture('fixture-triad-lastcard.png'), reader).board[4]!;
  assert.ok(covered.digits.some((d) => d.value === null));
  assert.ok(cardOf(covered).unread);
});

test('plans moves from the numbers on screen', () => {
  const start = decideTriad(readTriad(triadFixture('fixture-triad-start.png'), reader));
  assert.ok(start.kind === 'move' && start.guessed, 'her cards are unknown at the start of a first match');

  // One card left and one empty square: the only move, with nothing guessed.
  const mid = decideTriad(readTriad(triadFixture('fixture-triad-mid.png'), reader));
  assert.ok(mid.kind === 'move', JSON.stringify(mid));
  assert.equal(mid.cell, 3);
  assert.equal(mid.handIndex, 0);
  assert.equal(mid.guessed, false);
});

test("an opponent's deck is remembered between matches, outvoting the odd misread", () => {
  const memory = new TriadMemory(() => {});
  const card = (top: number, right: number, bottom: number, left: number) => ({ top, right, bottom, left });
  memory.remember('selka', [card(5, 5, 4, 4), card(5, 6, 4, 3), card(6, 3, 5, 4), card(5, 4, 5, 4)]);
  // Next match: the same cards (one misread), plus the fifth one at last.
  memory.remember('selka', [card(5, 5, 4, 4), card(5, 6, 4, 8), card(6, 3, 5, 4), card(5, 4, 5, 4), card(7, 2, 3, 1)]);
  memory.remember('selka', [card(5, 6, 4, 3)]);
  const deck = memory.deckOf('selka');
  assert.equal(deck.length, 5);
  assert.ok(deck.some((c) => c.top === 5 && c.right === 6 && c.bottom === 4 && c.left === 3), 'the misread was outvoted');
  assert.ok(deck.some((c) => c.top === 7));
  assert.deepEqual(memory.deckOf('someone else'), []);

  // Survives saving and loading.
  const reloaded = new TriadMemory(() => {});
  reloaded.load(JSON.parse(JSON.stringify(memory.toJSON())));
  assert.deepEqual(reloaded.deckOf('selka'), deck);
});

test("a card's look on the board is learned from my own cards", () => {
  const learning = new DigitReader();
  // A frame the bundled examples don't come from: my Imp (1-1-5-4 as printed) in square 7.
  const frame = triadFixture('fixture-triad-lastcard.png');
  learning.learnCard(boardSampler(frame, 6), [1, 1, 5, 4]);
  const saved = learning.toJSON();
  assert.ok(saved.length <= 4);
  // Learned looks are saved, and read back the same.
  const reloaded = new DigitReader();
  reloaded.load(JSON.parse(JSON.stringify(saved)));
  assert.equal(printed(readTriad(frame, reloaded).board[6]), '1154');
});

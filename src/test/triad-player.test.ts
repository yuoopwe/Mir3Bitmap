import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { MemoryCard, MemoryTriad } from '../main/game-memory';
import { decideFromMemory, herCardsLeft, matchResult, myIndex, myTurnInMemory, RULE_ELEMENTAL } from '../main/triad-player';

/**
 * Hand-built readings shaped like the memory reader's (real cards' numbers;
 * made-up pictures and element numbers):
 * - start: a new match, nothing played, her move first. I'm player 1.
 * - mid: she went first and has played Gayla (2), Blobra (9) and Geezard (4); I've played Cockatrice (8),
 *   which her Blobra took, and Caterchipillar (6), which took the Blobra back. She has a second Gayla left.
 * - last: I went first and have one card left (Funguar) for the last square (5). I'm player 0.
 */
const fixture = (name: string): MemoryTriad => JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'src', 'test', `fixture-memory-${name}.json`), 'utf8'));
const names = (cards: MemoryCard[]) => cards.map((c) => c.name);

const FIRE = 1;
const memoryCard = (name: string, image: number, up: number, right: number, down: number, left: number, element = 0): MemoryCard => ({ name, image, up, right, down, left, element });
const box = { x: 0, y: 0, width: 10, height: 10 };

test('decideFromMemory plays the Elemental rule with the squares and cards from memory', () => {
  const plain = memoryCard('Plain', 1, 5, 1, 1, 5);
  const fiery = memoryCard('Fiery', 2, 5, 1, 1, 5, FIRE);
  const filler = memoryCard('Filler', 3, 1, 1, 1, 1);
  // Her cards show 5 to the middle and As everywhere else.
  const hers = [memoryCard('Top', 11, 10, 10, 5, 10), memoryCard('Left', 12, 10, 5, 10, 10), memoryCard('Spare', 13, 1, 1, 1, 1)];
  const triad: MemoryTriad = {
    open: true,
    rules: RULE_ELEMENTAL,
    current: 0,
    stage: 0,
    players: [{ name: 'Me', ai: false, deck: [] }, { name: 'Her', ai: true, deck: [] }],
    // Hers above and left of the middle, mine in the corner; only the middle has an element.
    board: [null, { ...hers[0], owner: 1 }, null, { ...hers[1], owner: 1 }, null, null, null, null, { ...filler, owner: 0 }],
    elements: [0, 0, 0, 0, FIRE, 0, 0, 0, 0],
    hand: [{ ...box, card: plain }, { ...box, card: fiery }],
    myDeck: [plain, fiery, filler],
    opponentDeck: hers,
    playerName: 'Me',
  };
  // Only the fire card in the middle (6 against both 5s) takes both of her cards.
  const { decision } = decideFromMemory(triad);
  assert.ok(decision.kind === 'move', JSON.stringify(decision));
  assert.equal(decision.handIndex, 1);
  assert.equal(decision.cell, 4);
});

// ---- Reading the match from memory ----

test("herCardsLeft: her deck less the cards she has put down, whoever owns them now", () => {
  // Empty board: her whole deck, both Gaylas.
  assert.deepEqual(names(herCardsLeft(fixture('start'))), ['Gayla', 'Gayla', 'Geezard', 'Blobra', 'Fire Minotaur']);
  // Mid-game: her Blobra is mine now and my Cockatrice is hers, but neither changes whose deck they came from;
  // one of her two Gaylas is down, the other still in hand.
  assert.deepEqual(names(herCardsLeft(fixture('mid'))), ['Gayla', 'Fire Minotaur']);
  // My last card: she has one left (I went first).
  assert.deepEqual(names(herCardsLeft(fixture('last'))), ['Gayla']);
  // Both Gaylas down: none left.
  const mid = fixture('mid');
  const bothDown = { ...mid, board: mid.board!.map((c, i) => (i === 0 ? { ...mid.opponentDeck![0], owner: 0 } : c)) };
  assert.deepEqual(names(herCardsLeft(bothDown)), ['Fire Minotaur']);
});

test('myIndex: the player with my name, else the one that is not the computer', () => {
  assert.equal(myIndex(fixture('mid')), 1);
  assert.equal(myIndex(fixture('last')), 0);
  assert.equal(myIndex({ ...fixture('mid'), playerName: 'Someone else' }), 1);
  assert.equal(myIndex({ ...fixture('last'), playerName: undefined }), 0);
  const mid = fixture('mid');
  assert.equal(myIndex({ ...mid, playerName: 'Someone else', players: mid.players!.map((p) => ({ ...p, ai: true })) }), 0);
});

test("myTurnInMemory: my move only when it's my turn and the server isn't busy with one", () => {
  const mid = fixture('mid'); // current = me
  assert.equal(myTurnInMemory({ ...mid, stage: 0 }), true);
  assert.equal(myTurnInMemory({ ...mid, stage: 1 }), false, 'my move is waiting to be accepted');
  assert.equal(myTurnInMemory({ ...mid, stage: 2 }), false, "the server says it's hers");
  assert.equal(myTurnInMemory({ ...mid, stage: -1 }), true, 'stage unknown: go by whose turn the game says it is');
  assert.equal(myTurnInMemory({ ...mid, stage: -1, current: 0 }), false);
  assert.equal(myTurnInMemory({ ...mid, complete: true }), false, 'the match is over');
  // She goes first.
  assert.equal(myTurnInMemory(fixture('start')), false);
  assert.equal(myTurnInMemory({ ...fixture('start'), current: 1, stage: 0 }), true);
});

test('decideFromMemory: a card from my hand to an empty square', () => {
  for (const triad of [{ ...fixture('start'), current: 1, stage: 0 }, fixture('mid'), fixture('last')]) {
    const { decision, card } = decideFromMemory(triad);
    assert.ok(decision.kind === 'move', JSON.stringify(decision));
    assert.ok(decision.handIndex >= 0 && decision.handIndex < triad.hand!.length);
    assert.equal(card, triad.hand![decision.handIndex].card);
    assert.equal(triad.board![decision.cell], null);
  }
  const full = fixture('last');
  full.board![4] = { ...full.hand![0].card, owner: 0 };
  assert.equal(decideFromMemory(full).decision.kind, 'wait');
});

test('decideFromMemory: the rule flags reach the search', () => {
  const mid = fixture('mid');
  const decide = (rules: number) => decideFromMemory({ ...mid, rules }).decision;
  const plain = decide(0);
  assert.ok(plain.kind === 'move' && plain.worstCase === 2);
  // Open (1) and First (32) don't change the play.
  assert.deepEqual(decide(1), plain);
  assert.deepEqual(decide(32), plain);
  // Under Same only a card in the middle still wins by 2 (anywhere else her Gayla gets a Same).
  const same = decide(2);
  assert.ok(same.kind === 'move' && same.cell === 4 && same.worstCase === 2, JSON.stringify(same));
  // With Same, Plus and Combo she can always hold me to a draw.
  const all = decide(2 | 4 | 8);
  assert.ok(all.kind === 'move' && all.cell === 4 && all.worstCase === 0, JSON.stringify(all));
  // The squares' elements count only under Elemental: fire on every empty square weakens my cards
  // (they have none) and strengthens her Fire Minotaur, and the win becomes a draw.
  const fiery = { ...mid, elements: [1, 0, 1, 0, 1, 0, 1, 0, 0] };
  assert.deepEqual(decideFromMemory({ ...fiery, rules: 0 }).decision, plain);
  const elemental = decideFromMemory({ ...fiery, rules: RULE_ELEMENTAL }).decision;
  assert.ok(elemental.kind === 'move' && elemental.worstCase === 0, JSON.stringify(elemental));
});

test('decideFromMemory: cards that have changed hands count for whoever owns them now', () => {
  // Before my last card: mine are squares 3, 4 (her Gayla, taken) and 7, plus the Funguar in hand: 4.
  // Hers are 1 (my Ant Healer, taken), 2, 6, 8, 9 (my Caterchipillar, taken), plus her Gayla in hand: 6.
  // The Funguar's 5 takes the Geezard above it (1); nothing else: 5 each.
  const { decision } = decideFromMemory(fixture('last'));
  assert.ok(decision.kind === 'move');
  assert.equal(decision.cell, 4);
  assert.equal(decision.expected, 0);
  assert.equal(decision.worstCase, 0);
});

test('matchResult: cards owned on the full board plus those left in hand', () => {
  // My last card (Funguar) to the middle, taking the Geezard above it: 5 on the board to her 4,
  // but she went second and still holds her Gayla, so it's 5 each.
  const last = fixture('last');
  const funguar = last.players![0].deck[0];
  const board = last.board!.map((c, i) => (i === 4 ? { ...funguar, owner: 0 } : i === 1 ? { ...c!, owner: 0 } : c));
  const final: MemoryTriad = { ...last, complete: true, board, hand: [], players: [{ ...last.players![0], deck: [] }, last.players![1]] };
  assert.equal(matchResult(final), 'drawn');
  // Had the Geezard stayed hers: 4 to 6.
  const lost = { ...final, board: board.map((c, i) => (i === 1 ? { ...c!, owner: 1 } : c)) };
  assert.equal(matchResult(lost), 'lost');
  // Taking her Fire Minotaur too: 6 to 4.
  assert.equal(matchResult({ ...final, board: board.map((c, i) => (i === 5 ? { ...c!, owner: 0 } : c)) }), 'won');
  // Seen from her side.
  assert.equal(matchResult({ ...lost, playerName: '[Card Guild] Siren Selka' }), 'won');
  assert.equal(matchResult({ ...final, playerName: '[Card Guild] Siren Selka' }), 'drawn');
});

test('matchResult: no result without the full board', () => {
  assert.equal(matchResult(fixture('start')), null);
  assert.equal(matchResult(fixture('last')), null, 'the last square is still empty');
  // Once the match's window has closed, the reader sends the result box's OK button alone.
  assert.equal(matchResult({ open: false, ok: box }), null);
});

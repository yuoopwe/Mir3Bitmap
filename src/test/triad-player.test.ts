import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MemoryCard, MemoryTriad } from '../main/game-memory';
import { decideFromMemory, RULE_ELEMENTAL } from '../main/triad-player';

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

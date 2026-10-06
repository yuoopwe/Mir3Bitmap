import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { MemoryCollection } from '../main/game-memory';
import { chooseDeck, deckInputs } from '../main/triad-deck';

/** A hand-built card collection window: Funguar and Geezard owned twice, Gayla seen but not owned. */
const collection = (): MemoryCollection => JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'src', 'test', 'fixture-memory-collection.json'), 'utf8'));
const countOf = (deck: number[], id: number) => deck.filter((d) => d === id).length;

test('chooseDeck: no deck from fewer than five cards', () => {
  const few = collection();
  few.owned = few.owned.slice(0, 3).map((o) => ({ ...o, count: 1 })); // Ant Healer, Cockatrice, Bite Bug
  few.owned.push({ card: collection().owned[4].card, count: 1 }); // and one Funguar
  const { owned, pool } = deckInputs(few);
  assert.equal(chooseDeck(owned, pool), null);
  // Four different cards, but two copies of one, make five.
  few.owned[3].count = 2;
  assert.ok(chooseDeck(deckInputs(few).owned, pool));
});

test('chooseDeck: a card goes in at most as many times as it is owned', () => {
  const { owned, pool } = deckInputs(collection());
  // Only the levels I have count as her cards: the level 2 and 4 cards are left out.
  assert.equal(pool.length, 8);
  const choice = chooseDeck(owned, pool)!;
  assert.equal(choice.deck.length, 5);
  for (const o of owned) assert.ok(countOf(choice.deck, o.id) <= o.count, `${o.name} owned ${o.count}, used ${countOf(choice.deck, o.id)}`);
  assert.equal(countOf(choice.deck, 201), 0, 'Gayla is not owned');

  // When the game won't take two of a card, each goes in once.
  const single = deckInputs(collection(), false);
  const once = chooseDeck(single.owned, single.pool)!;
  assert.equal(new Set(once.deck).size, 5);
});

test('chooseDeck: the same seed gives the same deck', () => {
  const { owned, pool } = deckInputs(collection());
  assert.deepEqual(chooseDeck(owned, pool, 7), chooseDeck(owned, pool, 7));
});

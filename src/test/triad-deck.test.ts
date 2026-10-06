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

test("chooseDeck: her cards are taken from the levels of the cards I actually own", () => {
  // A level 4 card listed with none owned (as Gayla is) mustn't bring stronger cards into her pool.
  const listed = collection();
  listed.owned.push({ card: listed.cards.find((c) => c.name === 'Bomb')!, count: 0 });
  assert.equal(deckInputs(listed).pool.length, 8);
});

const SAME = { same: true, plus: false, combo: false };
const PLUS = { same: false, plus: true, combo: false };
const nameOf = (owned: { id: number; name: string }[]) => (id: number) => owned.find((o) => o.id === id)!.name;

test('chooseDeck: plays its test games under the rules given', () => {
  const { owned, pool } = deckInputs(collection());
  const names = (rules?: typeof SAME) => chooseDeck(owned, pool, 1, rules)!.deck.map(nameOf(owned)).sort();
  const basic = names();
  // Same changes which cards are worth having (Cockatrice in for Caterchipillar).
  assert.notDeepEqual(names(SAME), basic);
  // Same, Plus and Combo: Ant Healer's four 3s match the 3s on five of the eight level 1 cards she may hold; it never makes a basic deck.
  assert.ok(!basic.includes('Ant Healer'));
  assert.ok(names({ same: true, plus: true, combo: true }).includes('Ant Healer'));
  // With a Gayla owned as well, Plus alone changes the deck too (Blobra in for Caterchipillar).
  const withGayla = collection();
  withGayla.owned.find((o) => o.card.name === 'Gayla')!.count = 1;
  const more = deckInputs(withGayla);
  const deck = (rules?: typeof SAME) => chooseDeck(more.owned, more.pool, 1, rules)!.deck.map(nameOf(more.owned)).sort();
  assert.deepEqual(deck(), ['Caterchipillar', 'Funguar', 'Funguar', 'Gayla', 'Geezard']);
  assert.deepEqual(deck(PLUS), ['Blobra', 'Funguar', 'Funguar', 'Gayla', 'Geezard']);
  // Without rules it's the basic game, as before.
  assert.deepEqual(chooseDeck(owned, pool, 1, { same: false, plus: false, combo: false }), chooseDeck(owned, pool));
});

test("chooseDeck: the squares' elements count, with each card's element from memory", () => {
  // A fire Cockatrice gets +1 on fire squares while every other card (hers too) gets -1: on an all-fire board it's in.
  const fiery = collection();
  fiery.owned.find((o) => o.card.name === 'Cockatrice')!.card.element = 1;
  const { owned, pool } = deckInputs(fiery);
  assert.equal(owned.find((o) => o.name === 'Cockatrice')!.card.element, 1);
  assert.ok(!chooseDeck(owned, pool)!.deck.map(nameOf(owned)).includes('Cockatrice'));
  assert.ok(chooseDeck(owned, pool, 1, undefined, Array(9).fill(1))!.deck.map(nameOf(owned)).includes('Cockatrice'));
});

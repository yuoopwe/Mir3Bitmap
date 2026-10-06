import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noCounts, SessionStats } from '../main/session-stats';

test('a count goes into both this session and all time', () => {
  const stats = new SessionStats();
  stats.count('kills');
  stats.count('kills');
  stats.count('gathered');
  const { session, allTime } = stats.snapshot(0);
  assert.deepEqual(session, { ...noCounts(), kills: 2, gathered: 1 });
  assert.deepEqual(allTime, session);
});

test('a finished match counts as played, and as won, lost or drawn when known', () => {
  const stats = new SessionStats();
  stats.countMatch('won');
  stats.countMatch('drawn');
  stats.countMatch('won');
  stats.countMatch(null);
  const { session } = stats.snapshot(0);
  assert.deepEqual(session, { ...noCounts(), triadPlayed: 4, triadWon: 2, triadDrawn: 1 });
});

test('time counts only while a mode runs, up to the moment asked', () => {
  const stats = new SessionStats();
  assert.equal(stats.snapshot(5000).session.runningMs, 0);
  stats.start(10_000);
  assert.equal(stats.snapshot(12_500).session.runningMs, 2500);
  // Asking again doesn't add the same time twice.
  assert.equal(stats.snapshot(13_000).session.runningMs, 3000);
  stats.stop(14_000);
  assert.equal(stats.snapshot(60_000).session.runningMs, 4000);
  stats.start(100_000);
  stats.stop(101_000);
  const { session, allTime } = stats.snapshot(200_000);
  assert.equal(session.runningMs, 5000);
  assert.equal(allTime.runningMs, 5000);
});

test('Reset clears this session; all time keeps everything', () => {
  const stats = new SessionStats();
  stats.count('items');
  stats.start(0);
  stats.reset(3000);
  // Still running: the session's time starts again from the reset.
  stats.count('kills');
  const { session, allTime } = stats.snapshot(4000);
  assert.deepEqual(session, { ...noCounts(), kills: 1, runningMs: 1000 });
  assert.deepEqual(allTime, { ...noCounts(), items: 1, kills: 1, runningMs: 4000 });
});

test('restore takes the saved totals and ignores anything unreadable', () => {
  const stats = new SessionStats();
  stats.restore({ kills: 120, items: 'many', gathered: -3, decks: Infinity, runningMs: 7_200_000, unknown: 5 });
  stats.count('kills');
  const { session, allTime } = stats.snapshot(0);
  assert.deepEqual(session, { ...noCounts(), kills: 1 });
  assert.deepEqual(allTime, { ...noCounts(), kills: 121, runningMs: 7_200_000 });
  for (const junk of [null, undefined, 'text', 42]) {
    const fresh = new SessionStats();
    fresh.restore(junk);
    assert.deepEqual(fresh.snapshot(0).allTime, noCounts());
  }
});

test('restore keeps counts already higher (the window reloaded and saved a little behind)', () => {
  const stats = new SessionStats();
  stats.restore({ kills: 10, gathered: 4 });
  stats.count('kills');
  // What the window saved before the last kill.
  stats.restore({ kills: 10, gathered: 4 });
  assert.equal(stats.snapshot(0).allTime.kills, 11);
});

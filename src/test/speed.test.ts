import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readerSpeed } from '../main/game-memory';
import { play } from './bot-harness';
import { FakeGame } from './fake-game';
import { loadMapFixture } from './map-fixtures';

test("the reader's speed over the last minute: readings a second, the latest's age, the gaps' median, p90, p99 and max", () => {
  // A minute and a half of readings 50 ms apart, but for one map change of 400 ms; only the last minute counts.
  const arrivals: number[] = [];
  for (let at = 0; at <= 90_000; at += at === 60_000 ? 400 : 50) arrivals.push(at);
  const now = arrivals.at(-1)! + 20;
  const speed = readerSpeed(arrivals, now)!;
  assert.equal(speed.ageMs, 20);
  assert.deepEqual(speed.gaps, { median: 50, p90: 50, p99: 50, max: 400 });
  // 1193 gaps in the 59.98 s from the first reading of the minute to the last.
  assert.ok(Math.abs(speed.perSecond - 19.9) < 0.1, String(speed.perSecond));
  // Fewer than two readings in the minute: nothing to say.
  assert.equal(readerSpeed([0], 10), null);
  assert.equal(readerSpeed(arrivals, now + 120_000), null);
});

test("a mode's steps are timed: their length start to start, and the work in them (what wasn't waiting)", async () => {
  const bichon = loadMapFixture('bichon-province');
  const { x, y } = bichon.player;
  const game = new FakeGame({ maps: [bichon.map], player: { map: 1, x, y, level: 24 }, monsters: [{ name: 'Wolf', x: x - 2, y: y + 1, hits: 30 }] });
  const { statuses } = await play(game, (bot) => bot.startAttack(), { until: (s) => s.filter((x) => x.speed?.tick).length > 5, limitMs: 60_000 });
  const tick = statuses.filter((s) => s.speed?.tick).at(-1)!.speed!.tick!;
  assert.ok(tick.ms > 0 && tick.busyMs >= 0 && tick.busyMs <= tick.ms, JSON.stringify(tick));
  // The fake game's memory doesn't time its readings.
  assert.equal(statuses.at(-1)!.speed?.reader ?? null, null);
});

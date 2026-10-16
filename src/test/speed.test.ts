import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { GameMemory, readerSpeed } from '../main/game-memory';
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

test('next() wakes on the next reading from the reader, or gives up after its time; fresh() is the first reading after now', async () => {
  const memory = new GameMemory('.');
  const line = (x: number) => JSON.stringify({ inGame: true, user: { name: 'A', x, y: 0 } });
  const started = performance.now();
  const next = memory.next(5000);
  setTimeout(() => memory.take(line(1)), 20);
  assert.equal(await next, true);
  assert.ok(performance.now() - started < 1000);
  assert.equal(await memory.next(30), false);
  const fresh = memory.fresh(5000);
  setTimeout(() => memory.take(line(2)), 20);
  assert.equal((await fresh)?.user?.x, 2);
  // A line that doesn't parse wakes no one.
  const garbled = memory.next(60);
  memory.take('{"inGame": tr');
  assert.equal(await garbled, false);
});

test('Hunt, idle: a monster turning up is gone for with the next reading, not a tick later', async () => {
  const bichon = loadMapFixture('bichon-province');
  const { x, y } = bichon.player;
  const game = new FakeGame({ maps: [bichon.map], player: { map: 1, x, y, level: 24 } });
  // The wolf turns up at a moment the bot didn't choose: while it's waiting, part way through.
  const at = 5037;
  const wait = game.clock.wait;
  game.clock.wait = async (ms: number) => {
    const before = game.now;
    await wait(ms);
    if (before < at && game.now >= at) game.addMonster({ name: 'Wolf', x: x + 2, y, hits: 2 });
  };
  const { met } = await play(game, (bot) => bot.startAttack(), { until: () => game.events.some((e) => e.type === 'attack'), limitMs: 60_000 });
  assert.ok(met, 'attacked');
  const attacked = game.events.find((e) => e.type === 'attack')!.t;
  // Seen within a reading (the rest is hovering to check it's under the mouse, and the click): 499 ms when the
  // loop looked every 150 ms.
  assert.ok(attacked - at < 450, `${Math.round(attacked - at)} ms from the wolf turning up to the first blow`);
});

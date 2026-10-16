import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HealthTrend, TREND } from '../main/health-trend';
import { VK } from '../main/input';
import { play, testSettings } from './bot-harness';
import { FakeGame } from './fake-game';
import { loadMapFixture } from './map-fixtures';

test('the health trend: the fall a second over the last readings, and where it heads; steady or rising heads nowhere lower', () => {
  const trend = new HealthTrend();
  assert.equal(trend.ahead(1000), null);
  // A reading every 50 ms, losing 10% of the most each 500 ms blow: 20% a second.
  for (let t = 0; t <= 2000; t += 50) trend.add(t, 1 - 0.1 * Math.floor(t / 500));
  assert.ok(Math.abs(trend.fallPerSecond() - 0.2) < 0.03, String(trend.fallPerSecond()));
  assert.ok(Math.abs(trend.ahead(1000)! - (0.6 - trend.fallPerSecond())) < 1e-9);
  // Only the last TREND.windowMs count: steady since, no fall.
  for (let t = 2050; t <= 2000 + TREND.windowMs + 100; t += 50) trend.add(t, 0.6);
  assert.equal(trend.fallPerSecond(), 0);
  assert.equal(trend.ahead(1000), 0.6);
  // Rising (a potion): no fall either.
  const healing = new HealthTrend();
  for (let t = 0; t <= 1000; t += 50) healing.add(t, 0.3 + t / 5000);
  assert.equal(healing.fallPerSecond(), 0);
  // Too few readings, or too short a stretch, say nothing yet.
  const early = new HealthTrend();
  early.add(0, 1);
  early.add(50, 0.5);
  assert.equal(early.fallPerSecond(), 0);
});

test('the HP potion is drunk while health is still over the line, when blows are taking it under within a second', async () => {
  const bichon = loadMapFixture('bichon-province');
  const { x, y } = bichon.player;
  // Two hard-hitting wolves that take a while to kill: health goes down blow by blow.
  const game = new FakeGame({
    maps: [bichon.map], player: { map: 1, x, y, level: 24, hp: 1000 },
    monsters: [{ name: 'Wolf', x: x + 1, y, hits: 200, damage: 60, aggressive: true }, { name: 'Wolf', x: x - 1, y, hits: 200, damage: 60, aggressive: true }],
  });
  const potionKey = VK.F1 + 3;
  const pressed = () => game.events.find((e) => e.type === 'key' && e.down && e.vk === potionKey);
  const hunt = { ...testSettings().hunt, hpPotionKey: 'F4', hpPotionPercent: 50 };
  const { met } = await play(game, (bot) => bot.startAttack(), { settings: { hunt }, until: () => !!pressed(), limitMs: 60_000 });
  assert.ok(met, 'potion key pressed');
  // Health when it was pressed: the last blow's before it.
  const blows = game.events.filter((e) => e.type === 'hurt' && e.t <= pressed()!.t);
  const hp = blows.length ? (blows.at(-1) as { hp: number }).hp : 1000;
  assert.ok(hp >= 500, `pressed at ${hp} of 1000, already under the line`);
});

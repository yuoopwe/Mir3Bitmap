/**
 * Casting by what the game shows (skill-casting.ts): the real bot hunting in the fake game, whose character has
 * skills on its spell keys, buffs that run out, and MP the casts spend.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { KeyId, KeySetting, Settings } from '../shared/types';
import { VK } from '../main/input';
import { play, testSettings } from './bot-harness';
import { FakeGame, type FakeEvent, type FakeGameSetup, type FakeSkill } from './fake-game';
import { loadMapFixture } from './map-fixtures';

const bichon = loadMapFixture('bichon-province');
const { x, y } = bichon.player;

const SHIELD_WALL: FakeSkill = { name: 'Shield Wall', magic: 'ShieldWall', level: 4, keys: 'Spell02', cost: 20, buff: { type: 'ShieldWall', seconds: 60 } };
const SLAYING: FakeSkill = { name: 'Slaying', magic: 'Slaying', school: 'Passive', level: 6, keys: 'Spell06' };
const SURGE: FakeSkill = { name: 'Destructive Surge', magic: 'DestructiveSurge', school: 'WeaponSkills', level: 5, keys: 'Spell03', cost: 10 };

/** Hunting on Bichon: a wolf that takes `hits` clicks, the character with these skills and MP. */
function hunting(skills: FakeSkill[], options: { hits?: number; mp?: number; setup?: Partial<FakeGameSetup> } = {}): FakeGame {
  return new FakeGame({
    maps: [bichon.map], player: { map: 1, x, y, level: 40, mp: options.mp ?? 5000 },
    monsters: [{ name: 'Wolf', x: x + 2, y, hits: options.hits ?? 600 }], skills, ...options.setup,
  });
}

/** The settings with these keys set (the others off). */
function keys(changes: Partial<Record<KeyId, KeySetting>>): Partial<Settings> {
  return { keys: { ...testSettings().keys, ...changes } };
}

const auto: KeySetting = { enabled: true, seconds: 0, when: 'auto' };
const of = <T extends FakeEvent['type']>(game: FakeGame, type: T) => game.events.filter((e): e is Extract<FakeEvent, { type: T }> => e.type === type);
const presses = (game: FakeGame, n: number) => of(game, 'key').filter((k) => k.down && k.vk === VK.F1 + n - 1);
const casts = (game: FakeGame, name: string) => of(game, 'cast').filter((c) => c.name === name);
const run = (game: FakeGame, settings: Partial<Settings>, ms: number) => play(game, (bot) => bot.startAttack(), { settings, until: () => game.now > ms, limitMs: ms + 60_000 });

test('a buff is cast again when it runs low, not before: once a duration, in a fight and out of one', async () => {
  // A wolf soon dead, then nothing about: most of the time it's out of a fight.
  const game = hunting([SHIELD_WALL], { hits: 3 });
  await run(game, keys({ F2: auto }), 200_000);
  const times = casts(game, 'Shield Wall').map((c) => c.t);
  // 60 s a buff over 200 s: cast at the start, then again only with a few seconds left.
  assert.ok(times.length >= 4 && times.length <= 5, `${times.length} casts`);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] > 54_000 && times[i] - times[i - 1] < 60_000, `${Math.round((times[i] - times[i - 1]) / 1000)} s between casts`);
  // Every press cast it: none wasted while it was up.
  assert.equal(presses(game, 2).length, times.length);
});

test('a passive skill is never pressed', async () => {
  const game = hunting([SLAYING]);
  const { statuses } = await run(game, keys({ F6: auto }), 30_000);
  assert.deepEqual(presses(game, 6), []);
  assert.equal(statuses.filter((s) => s.keys).at(-1)?.keys?.keys.F6?.kind, 'passive');
});

test('an attack skill is pressed in a fight as soon as the game says it is ready, never while it is cooling down', async () => {
  // A cooldown the game shows (NextCast), and one it doesn't (the skill's delay): no press is refused either way.
  for (const skill of [{ ...SURGE, cooldownMs: 3000 }, { ...SURGE, delay: 2000 }]) {
    const game = hunting([skill]);
    await run(game, keys({ F3: auto }), 40_000);
    const times = casts(game, 'Destructive Surge').map((c) => c.t);
    assert.ok(times.length >= 10, `${times.length} casts`);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 2000, 'cast again within its cooldown');
    // Pressed as soon as ready: not much later than that.
    const gaps = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b);
    assert.ok(gaps[Math.floor(gaps.length / 2)] < (skill.cooldownMs ?? skill.delay!) + 800, `median ${gaps[Math.floor(gaps.length / 2)]} ms between casts`);
    assert.equal(presses(game, 3).length, times.length, 'a press that the game refused');
  }
});

test('with too little MP for it, the skill waits, and the Keys tab says so', async () => {
  const game = hunting([SURGE], { mp: 5 });
  const { statuses } = await run(game, keys({ F3: auto }), 20_000);
  assert.deepEqual(presses(game, 3), []);
  assert.equal(statuses.filter((s) => s.keys).at(-1)?.keys?.keys.F3?.note, 'waiting for MP');
});

test("a key whose presses don't take is pressed three times, then left alone a while, said once", async () => {
  const game = hunting([{ ...SHIELD_WALL, fails: true }]);
  const { statuses } = await run(game, keys({ F2: auto }), 50_000);
  // Three presses (the readings never showing the buff, the MP spent or a cooldown), then nothing for a minute.
  assert.equal(presses(game, 2).length, 3);
  const said = statuses.filter((s) => s.message.includes("isn't taking"));
  assert.equal(said.length, 1);
  assert.match(said[0].message, /^Shield Wall \(F2\) isn't taking: no sign of it in the game/);
});

test('Every N s presses exactly as before, and a key saved before there was a choice behaves as it did', async () => {
  const timesWith = async (setting: KeySetting) => {
    const game = hunting([SHIELD_WALL]);
    await run(game, keys({ F2: setting }), 60_000);
    return presses(game, 2).map((k) => k.t);
  };
  const before = await timesWith({ enabled: true, seconds: 10 });
  assert.ok(before.length >= 5, `${before.length} presses`);
  assert.deepEqual(await timesWith({ enabled: true, seconds: 10, when: 'every' }), before);
  // Saved unticked, with a skill on it: still never pressed.
  assert.deepEqual(await timesWith({ enabled: false, seconds: 0 }), []);
  assert.deepEqual(await timesWith({ enabled: false, seconds: 10, when: 'off' }), []);
});

test("the Keys tab is told each key's skill, its kind and its buff's time left, and skills on keys the bot does not press", async () => {
  const game = hunting([SHIELD_WALL, SLAYING, SURGE, { name: 'Scan', magic: 'Scan', keys: 'Spell14' }], { setup: { buffs: [{ type: 'ShieldWall', seconds: 30, source: 'ShieldWall' }] } });
  const { statuses } = await run(game, keys({ F2: auto }), 5000);
  const view = statuses.filter((s) => s.keys).at(-1)!.keys!;
  assert.deepEqual(Object.keys(view.keys).sort(), ['F2', 'F3', 'F6']);
  assert.equal(view.keys.F2!.kind, 'buff');
  assert.ok(view.keys.F2!.left! > 20 && view.keys.F2!.left! <= 30);
  assert.deepEqual([view.keys.F3!.kind, view.keys.F3!.skill, view.keys.F3!.level], ['attack', 'Destructive Surge', 5]);
  assert.deepEqual(view.elsewhere, ['Scan (Spell14)']);
});

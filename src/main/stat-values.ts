/**
 * The stat guide: what a point of each stat, and each elixir, is worth to the
 * character for what they actually do. What they do is Grind (the map it
 * chose and the next best) and the Boss circuit (the bosses its quests want),
 * weighed by the time they spend on each (or a focus the user sets). Each is
 * worked out by the combat model (combat-model.ts, corrected by
 * calibration.ts): Grind's exp/h with the model's kill times, the circuit's
 * haul (exp, Forge Stone drops, quest rewards) per hour. A stat's value is how
 * much a point more raises that weighted whole, as a share. Survival is a
 * threshold: what can't be survived even with potions brings nothing, so a
 * stat that would make it survivable is worth that activity's whole worth,
 * shared over the points it takes; once it's safe, more defence is worth next
 * to nothing. Pure: no game, no screen.
 */
import { describeGap, fight, foeOf, levelClosesGap, survivalGap, swingMs, withStats, type Combat, type Fighter, type FightOutcome, type Foe, type Supplies } from './combat-model';
import type { Calibration } from './calibration';
import { mapMonsters, rateMap, shortNumber, type GrindOptions, type Grinder, type MapMonster } from './grind';
import type { BossStint, GrindSession } from './grind-log';
import { mapName, type TravelData } from './travel';

/** Every number the guide is tuned by, in one place. */
export const GUIDE = {
  /** A boss kill's trip there and wait for it, besides the fight (seconds), for the circuit's worth per hour. */
  bossOverheadSeconds: 240,
  /** A Forge Stone drops from about this share of sub-boss and boss kills... */
  forgeStoneChance: 0.1,
  /** ...and is weighed as this much experience, so drops and quest rewards add up with exp. A guess: it only ranks. */
  stoneExp: 10_000,
  /** The time share between Grind and the Boss circuit goes by this many days of logs; with none, half each. */
  shareDays: 7,
  /** An elixir pays when it raises what the character does by at least this share. */
  elixirMinGain: 0.02,
  /** Health is valued by steps of this many points (a single point is lost in the rounding). */
  healthStep: 10,
  /** A locked activity is opened up by at most this many points of a stat (health: maxUnlockHealth). */
  maxUnlockPoints: 1000,
  maxUnlockHealth: 100_000,
};

type StatKey = keyof Combat | 'maxHp';

/** The stats valued, as the groups that rise together on items: a name, the Library.Stat numbers, and the Fighter fields. */
export const STAT_GROUPS: { name: string; stats: number[]; keys: StatKey[] }[] = [
  { name: 'Attack Speed', stats: [16], keys: ['attackSpeed'] },
  { name: 'DC', stats: [8, 9], keys: ['minDC', 'maxDC'] },
  { name: 'MC', stats: [10, 11], keys: ['minMC', 'maxMC'] },
  { name: 'SC', stats: [12, 13], keys: ['minSC', 'maxSC'] },
  { name: 'Accuracy', stats: [14], keys: ['accuracy'] },
  { name: 'Agility', stats: [15], keys: ['agility'] },
  { name: 'AC', stats: [4, 5], keys: ['minAC', 'maxAC'] },
  { name: 'MR', stats: [6, 7], keys: ['minMR', 'maxMR'] },
  { name: 'HP', stats: [2], keys: ['maxHp'] },
];

/** A boss the circuit goes for: its name, the kills a round of its quests wants, and the quest whose reward hangs on it (null: none). */
export interface WantedBoss {
  name: string;
  kills: number;
  quest: string | null;
}

export interface GuideInput {
  data: TravelData;
  me: Fighter;
  supplies: Supplies;
  calibration: Calibration;
  /** Grind: the maps weighed (the chosen one and the next best), and how it rates them (the level band, quests). */
  maps: readonly number[];
  grinder: Grinder;
  grindOptions: GrindOptions;
  /** The Boss circuit: the bosses its quests want, and each quest's reward in Forge Stones. */
  bosses: readonly WantedBoss[];
  rewards: Readonly<Record<string, number>>;
  /** How much Grind and the circuit each count (adding up to 1). */
  weights: { grind: number; bosses: number };
  /** The bag's counts (MemoryState gear.counts), for elixirs. */
  counts: Readonly<Record<string, number>>;
}

export interface ElixirAdvice {
  name: string;
  /** Its kind: 'Haste', 'Destruction', ... (the game's effect, less "Elixir"). */
  family: string;
  /** How much it raises what the character does (0.09: 9%), for how long (seconds); how many are in the bag, and its price. */
  gain: number;
  seconds: number;
  have: number;
  price: number;
  /** Worth keeping up: it raises it by GUIDE.elixirMinGain or more, and there are some in the bag. */
  pays: boolean;
  /** "Haste (II): +9% exp/h for an hour, you have 25". */
  line: string;
}

export interface StatValues {
  /** What a point of each Library.Stat is worth (a share of what the character does), for the loot judge. */
  perStat: Record<number, number>;
  /** Each stat group's worth a point (both of a pair), best first, and a line on why. */
  groups: { name: string; value: number; line: string }[];
  /** What can't be survived yet, and what it would take. */
  locked: { name: string; why: string }[];
  elixirs: ElixirAdvice[];
  /** What was weighed: "Zuma Temple Lv 5 (~1.2M exp/h)", "Zuma Keeper (boss)". */
  activities: string[];
  /** What a kill costs in potions and gold, where it costs any: each boss, and each map (on average over its monsters). */
  costs: { name: string; potions: number; gold: number }[];
}

/** How Grind and the circuit are weighed: the user's focus (0 all levelling, 100 all bosses), else the time spent on each lately. */
export function focusWeights(grind: readonly GrindSession[], bosses: readonly BossStint[], now: number, focus: number | null = null): { grind: number; bosses: number } {
  if (focus !== null) {
    const b = Math.min(1, Math.max(0, focus / 100));
    return { grind: 1 - b, bosses: b };
  }
  const since = now - GUIDE.shareDays * 24 * 3_600_000;
  const g = grind.filter((s) => s.at >= since).reduce((sum, s) => sum + s.ms, 0);
  const b = bosses.filter((s) => s.at >= since).reduce((sum, s) => sum + s.ms, 0);
  return g + b > 0 ? { grind: g / (g + b), bosses: b / (g + b) } : { grind: 0.5, bosses: 0.5 };
}

/** What the character does is worth: Grind's best exp/h among the maps, and the circuit's haul per hour (exp, stones as exp). */
export interface Worth {
  grind: number;
  bosses: number;
}

/** The model's fights for one character, by monster (lower-case name), worked out once. */
class Fights {
  private readonly cache = new Map<string, { foe: Foe; outcome: FightOutcome } | null>();

  constructor(
    private readonly input: GuideInput,
    readonly me: Fighter,
  ) {}

  of(name: string): { foe: Foe; outcome: FightOutcome } | null {
    const key = name.toLowerCase();
    if (!this.cache.has(key)) {
      const foe = foeOf(this.input.data, key);
      const factors = foe ? this.input.calibration.factorsAt(foe.level - this.me.level) : undefined;
      this.cache.set(key, foe ? { foe, outcome: fight(this.me, foe, { supplies: this.input.supplies, factors }) } : null);
    }
    return this.cache.get(key)!;
  }

  survives(name: string): boolean {
    return this.of(name)?.outcome.survives ?? true;
  }
}

/** Grind's rate on a map with these fights (0 when it's left out); `open`: its monsters all counted as survivable. */
function mapRate(input: GuideInput, fights: Fights, map: number, open = false, why?: (m: MapMonster) => string | null): number | { skip: string } {
  const rating = rateMap(input.data, map, { ...input.grinder, level: fights.me.level }, {
    ...input.grindOptions,
    killSeconds: (m) => fights.of(m.name)?.outcome.seconds ?? null,
    cantSurvive: open ? undefined : (m) => (fights.survives(m.name) ? null : (why?.(m) ?? 'no')),
  });
  return 'rate' in rating ? rating.rate : rating;
}

/** What the character does is worth with these fights; activities in `open` ("map:37", "boss:zuma keeper") counted as survivable. */
function worth(input: GuideInput, fights: Fights, open: ReadonlySet<string> = new Set()): Worth {
  let grind = 0;
  for (const map of input.maps) {
    const rate = mapRate(input, fights, map, open.has(`map:${map}`));
    if (typeof rate === 'number') grind = Math.max(grind, rate);
  }
  // The circuit: a round of its bosses (those that can be fought), and the quest rewards when every boss a quest wants can be.
  let exp = 0;
  let seconds = 0;
  const questsOk = new Map<string, boolean>();
  for (const boss of input.bosses) {
    const f = fights.of(boss.name);
    const ok = !!f && f.outcome.seconds < Infinity && (f.outcome.survives || open.has(`boss:${boss.name.toLowerCase()}`));
    if (boss.quest) questsOk.set(boss.quest, (questsOk.get(boss.quest) ?? true) && ok);
    if (!ok) continue;
    const index = input.data.monsters?.findIndex((n) => n.toLowerCase() === boss.name.toLowerCase()) ?? -1;
    const bossExp = input.data.monsterStats?.[index]?.[1] ?? 0;
    exp += boss.kills * (bossExp + GUIDE.forgeStoneChance * GUIDE.stoneExp);
    seconds += boss.kills * (f!.outcome.seconds + GUIDE.bossOverheadSeconds);
  }
  for (const [quest, ok] of questsOk) if (ok) exp += (input.rewards[quest] ?? 0) * GUIDE.stoneExp;
  return { grind, bosses: seconds > 0 ? (exp / seconds) * 3600 : 0 };
}

/**
 * What the character does is worth with these stats (another loadout's, say):
 * Grind's best exp/h and the circuit's haul an hour; and the circuit's bosses
 * that can be survived (lower-case names).
 */
export function worthOf(input: GuideInput, me: Fighter): Worth & { survivable: string[] } {
  const fights = new Fights(input, me);
  const survivable = input.bosses.filter((b) => fights.of(b.name)?.outcome.survives).map((b) => b.name.toLowerCase());
  return { ...worth(input, fights), survivable: [...new Set(survivable)] };
}

/** How much better `now` is than `before`, weighted: a share (an activity going from nothing to something counts as 1). */
export function gain(input: GuideInput, before: Worth, now: Worth): number {
  const rel = (n: number, b: number) => (b > 0 ? n / b - 1 : n > 0 ? 1 : 0);
  return input.weights.grind * rel(now.grind, before.grind) + input.weights.bosses * rel(now.bosses, before.bosses);
}

/** The smallest whole number of points from 1 to `most` for which `ok` holds (and every one above it), or null. */
function pointsTo(most: number, ok: (n: number) => boolean): number | null {
  if (!ok(most)) return null;
  let low = 1;
  let high = most;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (ok(mid)) high = mid;
    else low = mid + 1;
  }
  return low;
}

const percent = (share: number) => {
  const p = share * 100;
  return `${p >= 0 ? '+' : ''}${Math.abs(p) >= 10 ? p.toFixed(0) : Math.abs(p) >= 1 ? p.toFixed(1) : p.toFixed(2)}%`;
};

/** The character with `n` more of each of a group's stats. */
const raised = (me: Fighter, keys: readonly StatKey[], n: number) => withStats(me, Object.fromEntries(keys.map((k) => [k, n])));

/**
 * Why a monster can't be survived even with potions, and whether levels or
 * gear would close the gap: "needs +76 AC, or ... (a gear gap: levels alone
 * won't close it)"; null when it can be.
 */
export function cantSurvive(data: TravelData, me: Fighter, foe: Foe, supplies: Supplies, calibration: Calibration): string | null {
  const options = { supplies, factors: calibration.factorsAt(foe.level - me.level) };
  const gap = survivalGap(data, me, foe, options);
  if (!gap) return null;
  const level = levelClosesGap(data, me, foe, options);
  return `${describeGap(gap)} (${level !== null ? `levelling to ${level} would do it` : 'a gear gap: levels alone won\'t close it'})`;
}

const whyNot = (input: GuideInput, me: Fighter, foe: Foe) => cantSurvive(input.data, me, foe, input.supplies, input.calibration) ?? 'can be survived';

/** The guide: every stat group's worth, what's locked and what it would take, and the elixirs. */
export function statValues(input: GuideInput): StatValues {
  const me = input.me;
  const here = new Fights(input, me);
  const base = worth(input, here);
  const unit = input.weights.grind >= input.weights.bosses ? 'exp/h' : 'from bosses';

  // What's locked: maps left out as unsurvivable, bosses that can't be survived; and what opening each would bring.
  const locked: { key: string; name: string; why: string; gain: number; opens: (f: Fights) => boolean }[] = [];
  for (const map of input.maps) {
    const rate = mapRate(input, here, map, false, (m) => {
      const f = here.of(m.name);
      return f ? whyNot(input, me, f.foe) : null;
    });
    if (typeof rate === 'number' || !rate.skip.startsWith("can't be survived")) continue;
    const opened = gain(input, base, worth(input, here, new Set([`map:${map}`])));
    locked.push({ key: `map:${map}`, name: mapName(input.data, map), why: rate.skip, gain: opened, opens: (f) => typeof mapRate(input, f, map) === 'number' });
  }
  for (const boss of input.bosses) {
    const f = here.of(boss.name);
    if (!f || f.outcome.survives || locked.some((l) => l.key === `boss:${boss.name.toLowerCase()}`)) continue;
    const opened = gain(input, base, worth(input, here, new Set([`boss:${boss.name.toLowerCase()}`])));
    locked.push({ key: `boss:${boss.name.toLowerCase()}`, name: f.foe.name, why: whyNot(input, me, f.foe), gain: opened, opens: (g) => g.survives(boss.name) });
  }

  // The fight that says why: Grind's main monster on its best map, or the circuit's first boss that can be fought.
  const main = mainFight(input, here);

  const groups = STAT_GROUPS.map((group) => {
    const step = group.name === 'HP' ? GUIDE.healthStep : 1;
    const marginal = gain(input, base, worth(input, new Fights(input, raised(me, group.keys, step)))) / step;
    let unlock = 0;
    const opens: string[] = [];
    for (const l of locked) {
      const most = group.name === 'HP' ? GUIDE.maxUnlockHealth : GUIDE.maxUnlockPoints;
      const points = pointsTo(most, (n) => l.opens(new Fights(input, raised(me, group.keys, n))));
      if (points === null) continue;
      unlock += l.gain / points;
      opens.push(`${points} more opens ${l.name}`);
    }
    const value = Math.max(0, marginal) + unlock;
    const why = [note(group.name, me, main), ...opens].filter(Boolean).join('; ');
    const each = group.name === 'HP' ? 'a point' : group.keys.length === 2 ? 'each (min and max)' : 'each';
    return { name: group.name, value, line: `${group.name}: ${value > 0 ? `${percent(value)} ${unit} ${each}` : 'worth nothing here'}${why ? `; ${why}` : ''}` };
  }).sort((a, b) => b.value - a.value);

  const perStat: Record<number, number> = {};
  for (const group of STAT_GROUPS) {
    const value = groups.find((g) => g.name === group.name)!.value;
    for (const stat of group.stats) perStat[stat] = value / group.stats.length;
  }

  const activities = [
    ...input.maps.map((map) => {
      const rate = mapRate(input, here, map);
      return `${mapName(input.data, map)} (${typeof rate === 'number' ? `~${shortNumber(rate)} exp/h` : 'locked'})`;
    }),
    ...input.bosses.map((b) => `${here.of(b.name)?.foe.name ?? b.name} (boss)`),
  ];
  return { perStat, groups, locked: locked.map(({ name, why }) => ({ name, why })), elixirs: elixirAdvice(input, here, base, unit), activities, costs: potionCosts(input, here) };
}

/** What a kill costs in potions: each boss that can be survived, and each map on average over the monsters within reach. */
function potionCosts(input: GuideInput, fights: Fights): StatValues['costs'] {
  const out: StatValues['costs'] = [];
  const level = fights.me.level + input.grindOptions.maxLevelsAbove;
  for (const map of input.maps) {
    let n = 0;
    let potions = 0;
    let gold = 0;
    for (const m of mapMonsters(input.data, map) ?? []) {
      const f = fights.of(m.name);
      if (m.level > level || !f?.outcome.survives) continue;
      n += m.n;
      potions += m.n * f.outcome.potionsPerKill;
      gold += m.n * f.outcome.goldPerKill;
    }
    if (n > 0) out.push({ name: mapName(input.data, map), potions: potions / n, gold: gold / n });
  }
  for (const boss of input.bosses) {
    const f = fights.of(boss.name);
    if (f?.outcome.survives) out.push({ name: f.foe.name, potions: f.outcome.potionsPerKill, gold: f.outcome.goldPerKill });
  }
  return out.filter((c) => c.potions >= 0.05);
}

/** The fight the stat lines speak of. */
function mainFight(input: GuideInput, fights: Fights): FightOutcome | null {
  if (input.weights.grind >= input.weights.bosses) {
    let best: { rate: number; map: number } | null = null;
    for (const map of input.maps) {
      const rate = mapRate(input, fights, map);
      if (typeof rate === 'number' && (!best || rate > best.rate)) best = { rate, map };
    }
    const monsters = best ? [...(mapMonsters(input.data, best.map) ?? [])].sort((a, b) => b.n - a.n) : [];
    const level = fights.me.level + input.grindOptions.maxLevelsAbove;
    const main = monsters.find((m) => m.level <= level && fights.of(m.name));
    if (main) return fights.of(main.name)!.outcome;
  }
  const boss = input.bosses.find((b) => fights.of(b.name)?.outcome.survives);
  return boss ? fights.of(boss.name)!.outcome : null;
}

/** A word on why a stat group is worth what it is, from the main fight. */
function note(group: string, me: Fighter, main: FightOutcome | null): string {
  if (group === 'Attack Speed') {
    const quicker = swingMs(me) / swingMs(withStats(me, { attackSpeed: 1 })) - 1;
    if (quicker <= 0) return 'your swings are as quick as they get (or you cast)';
    const safe = main && main.hitChance >= 1 && main.takenPerSecond <= 0 ? '; you never miss and take no damage here' : '';
    return `${percent(quicker)} kill speed${safe}`;
  }
  if (!main) return '';
  if (group === 'Accuracy') return main.hitChance >= 1 ? 'you never miss here' : `${Math.round(main.hitChance * 100)}% of your swings land`;
  if (group === 'AC' || group === 'MR' || group === 'Agility' || group === 'HP') {
    if (main.takenPerSecond <= 0) return 'you take no damage here';
    return `a kill costs ${Math.round((main.hpLost / me.maxHp) * 100)}% of your HP without potions`;
  }
  return '';
}

/** Each elixir family the level allows: the best one in the bag (else the best on sale), what it would bring, and whether it pays. */
function elixirAdvice(input: GuideInput, fights: Fights, base: Worth, unit: string): ElixirAdvice[] {
  const me = fights.me;
  const families = new Map<string, NonNullable<TravelData['consumables']>>();
  for (const c of input.data.consumables ?? []) {
    const family = /^(\w+)Elixir$/.exec(c.effect ?? '')?.[1];
    if (!family || (c.level ?? 0) > me.level || !c.stats.Duration) continue;
    families.set(family, [...(families.get(family) ?? []), c]);
  }
  const fields: Record<string, StatKey> = {
    AttackSpeed: 'attackSpeed', MinDC: 'minDC', MaxDC: 'maxDC', MinMC: 'minMC', MaxMC: 'maxMC', MinSC: 'minSC', MaxSC: 'maxSC',
    MinAC: 'minAC', MaxAC: 'maxAC', MinMR: 'minMR', MaxMR: 'maxMR', Health: 'maxHp', Accuracy: 'accuracy', Agility: 'agility',
  };
  const out: ElixirAdvice[] = [];
  for (const [family, tiers] of families) {
    const byStrength = [...tiers].sort((a, b) => b.price - a.price);
    const elixir = byStrength.find((c) => (input.counts[c.name] ?? 0) > 0) ?? byStrength[0];
    const more = Object.fromEntries(Object.entries(elixir.stats).filter(([k]) => fields[k]).map(([k, v]) => [fields[k], v]));
    const g = gain(input, base, worth(input, new Fights(input, withStats(me, more))));
    const have = input.counts[elixir.name] ?? 0;
    const hours = elixir.stats.Duration / 3600;
    const short = elixir.name.replace(/^Elixir Of /, '');
    const time = hours === 1 ? 'an hour' : `${Number(hours.toFixed(1))} hours`;
    out.push({
      name: elixir.name, family, gain: g, seconds: elixir.stats.Duration, have, price: elixir.price, pays: have > 0 && g >= GUIDE.elixirMinGain,
      line: `${short}: ${g > 0.0005 ? `${percent(g)} ${unit}` : 'nothing'} for ${time}, you have ${have}`,
    });
  }
  return out.sort((a, b) => b.gain - a.gain);
}

/** The circuit's bosses for a set of its quests: each quest's kill tasks (monster, count) and its Forge Stone reward. */
export function circuitBosses(quests: readonly { name: string; items?: [string, number][]; tasks: { type: string; amount: number; monsters?: ([string] | [string, number])[] }[] }[]): { bosses: WantedBoss[]; rewards: Record<string, number> } {
  const bosses: WantedBoss[] = [];
  const rewards: Record<string, number> = {};
  for (const quest of quests) {
    rewards[quest.name] = (quest.items ?? []).filter(([item]) => item === 'Forge Stone').reduce((sum, [, n]) => sum + n, 0);
    for (const task of quest.tasks) {
      if (task.type !== 'KillMonster' && task.type !== 'GainItem') continue;
      for (const [monster] of task.monsters ?? []) bosses.push({ name: monster, kills: task.amount, quest: quest.name });
    }
  }
  return { bosses, rewards };
}

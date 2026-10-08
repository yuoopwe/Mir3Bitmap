/**
 * The combat model: one fight, the character against a monster, worked out
 * from both sides' stats. The character's blows (their damage roll less the
 * monster's defence, how often they land, how fast they come) against its
 * health; the monster's blows against the character's defence and health; and
 * what potions and regeneration put back. From that: how long a kill takes,
 * the health it costs, the potions it takes and whether it can be survived;
 * and for a fight that can't, how far off it is. What the data can't say (the
 * server's miss roll, crits, potion cooldowns) are COMBAT's guesses, corrected
 * by what the character's own fights measure (calibration.ts). Pure: no game,
 * no screen.
 */
import type { MemoryItem, MemoryState } from './game-memory';
import type { TravelData } from './travel';

/** Every number the model is tuned by, in one place. */
export const COMBAT = {
  // ---- The character's blows ----
  /** Milliseconds between swings: this, less swingPerAttackSpeedMs for each point of Attack Speed (measured in game)... */
  swingBaseMs: 1500,
  swingPerAttackSpeedMs: 47,
  /**
   * ...never quicker than this (the client's floor: Attack Speed past 15 does nothing, 1500 - 47 x 15 = 795; the game
   * shows a character with 16 from gear as 15).
   */
  minSwingMs: 800,
  /** Spell casters (Wizard: MC, Taoist: SC, against MR) cast about this often, whatever their Attack Speed; spells don't miss. A guess. */
  castMs: 1200,
  /** A blow (its roll less the defence's roll) does at least this much: 0, as fights where nothing gets through show. */
  minDamage: 0,
  /**
   * Elemental attack (FireAttack...) is extra damage of that element on each blow, as much as the stat; each point of the
   * monster's resistance to it takes this share off that extra (negative: adds). The blow itself isn't touched: kills
   * measured against Zuma monsters (Lightning resistance 50) with Lightning gear took the time the plain blow says, not
   * twice it. How big the extra really is isn't known: small next to the blow either way.
   */
  resistancePerPoint: 0.01,
  /**
   * ...and the share of that extra counted: 0 until fights measure it (a guess shouldn't decide gear; set from kills
   * with and without elemental gear against the same monsters).
   */
  elementShare: 0,
  /** A kill shows this many swings before the last would end: the last blow lands N-1 swings on, its death is seen a moment later. */
  lastSwingShare: 0.5,
  // ---- Health ----
  /** Health regained each second, as a share of the most. A guess. */
  regenPerSecond: 0.002,
  /** The bot drinks a health potion at most this often (POTION_COOLDOWN_MS in bot-context.ts), or as the game's cooldown allows (learned). */
  drinkMs: 1500,
  /** The quickest drinking the advice goes down to. */
  fastestDrinkMs: 500,
  /** A fight can be survived when it takes no more than this share of the most health (the rest is the margin for bad luck). */
  safeShare: 0.7,
  // ---- Gaps ----
  /** A gap is looked for up to this much more of a stat (health counts this many times over). */
  maxExtra: 2000,
  healthScale: 50,
  /** Levels looked ahead for the class's own stats (game-data baseStats) to close a gap. */
  levelsAhead: 10,
};

/** Library.MirClass by number, as travel.json's baseStats names them. */
export const CLASS_NAMES = ['Warrior', 'Wizard', 'Taoist', 'Assassin', 'Summoner', 'Druid', 'Archer', 'BladeDancer'];

/** The stats from the game's memory (MemoryState user.combat) the model goes by. */
export type Combat = NonNullable<NonNullable<MemoryState['user']>['combat']>;

/** The character: their stats with gear, class (Library.MirClass), level, most health, and their weapon's element ('Fire'...), if any. */
export type Fighter = Combat & { cls: number; level: number; maxHp: number; element?: string; elementAttack?: number };

/** A monster: its stats (travel.json's monsterCombat), level and health, the milliseconds between its attacks, and its resistances by element. */
export type Foe = Combat & { name: string; level: number; health: number; attackDelay: number; resist: Record<string, number> };

/** A health potion: how much it heals, its price, and how many are in the bag. */
export interface Potion {
  name: string;
  heal: number;
  price: number;
  count: number;
}

/** What the fight has to heal with: the potion drunk, and the time between drinks. */
export interface Supplies {
  potion: Potion | null;
  drinkMs: number;
}

/** Corrections from measured fights (calibration.ts): damage dealt, damage taken and potions' healing, each a factor. */
export interface Factors {
  damage: number;
  taken: number;
  heal: number;
}

export const NO_CORRECTION: Factors = { damage: 1, taken: 1, heal: 1 };

export interface FightOutcome {
  /** The character's swings: the share that land, the damage one does on average (misses counted), swings a second, and damage a second. */
  hitChance: number;
  perSwing: number;
  swingsPerSecond: number;
  damagePerSecond: number;
  /** Swings to kill: on average, and the likeliest counts with their chances (the breakpoints). */
  hits: { mean: number; likely: [number, number][] };
  /** Seconds a kill takes. */
  seconds: number;
  /** The monster's (or monsters') share of blows that land and damage a second, and the most one blow can do. */
  foeHitChance: number;
  takenPerSecond: number;
  worstBlow: number;
  /** Health a kill costs with no potions (regeneration counted). */
  hpLost: number;
  /** Potions a kill takes to put that back, and their cost in gold. */
  potionsPerKill: number;
  goldPerKill: number;
  survivesWithout: boolean;
  /** With the potions in the bag, drunk as often as `drinkMs` allows. */
  survives: boolean;
  /** Seconds of such fighting until the potions run out (Infinity: none are needed, or there's no running out). */
  potionSeconds: number;
}

const PHYSICAL_CLASSES = [0, 3, 6, 7];
const ELEMENTS = ['Fire', 'Ice', 'Lightning', 'Wind', 'Holy', 'Dark', 'Shadow'];
/** Library.Stat numbers of the elements' attack stats, in ELEMENTS' order. */
const ELEMENT_ATTACKS = [20, 22, 24, 26, 28, 30, 32];

/** The strongest elemental attack in all that's worn, added up by element ('Fire'...), and how much; null with none. */
export function elementAttackOf(worn: readonly MemoryItem[]): { element: string; amount: number } | null {
  const totals = ELEMENT_ATTACKS.map((n) => worn.reduce((sum, item) => sum + (item.base[n] ?? 0) + (item.added[n] ?? 0), 0));
  const best = totals.reduce((b, amount, i) => (amount > totals[b] ? i : b), 0);
  return totals[best] > 0 ? { element: ELEMENTS[best], amount: totals[best] } : null;
}

/** The element of the strongest elemental attack in what's worn ('Fire'...), if any. */
export function elementOf(worn: readonly MemoryItem[]): string | undefined {
  return elementAttackOf(worn)?.element;
}

/** The character from the game's memory, or null without their stats. `worn` gives the weapon's element. */
export function fighterOf(user: MemoryState['user'], worn: readonly MemoryItem[] = []): Fighter | null {
  if (!user?.combat || !user.maxHp || user.class === undefined || user.level === undefined) return null;
  const element = elementAttackOf(worn);
  return { ...user.combat, cls: user.class, level: user.level, maxHp: user.maxHp, ...(element && { element: element.element, elementAttack: element.amount }) };
}

/** The Combat stats in a fixed order, for a kill's note of the character's stats then (grind-log.ts Kill.stats). */
const COMBAT_KEYS: (keyof Combat)[] = ['minAC', 'maxAC', 'minMR', 'maxMR', 'minDC', 'maxDC', 'minMC', 'maxMC', 'minSC', 'maxSC', 'accuracy', 'agility', 'attackSpeed'];

/** The character's stats as a kill notes them: COMBAT_KEYS' values, then the most health and the class; undefined without them. */
export function packFighter(user: MemoryState['user']): number[] | undefined {
  if (!user?.combat || !user.maxHp || user.class === undefined) return undefined;
  return [...COMBAT_KEYS.map((key) => user.combat![key]), user.maxHp, user.class];
}

/** The character back from a kill's note (packFighter), at the kill's level; null if it isn't one. */
export function unpackFighter(stats: readonly number[] | undefined, level: number): Fighter | null {
  if (!stats || stats.length !== COMBAT_KEYS.length + 2) return null;
  const combat = Object.fromEntries(COMBAT_KEYS.map((key, i) => [key, stats[i]])) as Combat;
  return { ...combat, maxHp: stats[COMBAT_KEYS.length], cls: stats[COMBAT_KEYS.length + 1], level };
}

const foeCache = new WeakMap<TravelData, Map<string, Foe>>();

/** A monster by name (any case), from travel.json's monsterCombat, or null if it has no stats there. */
export function foeOf(data: TravelData, name: string): Foe | null {
  let byName = foeCache.get(data);
  if (!byName) {
    byName = new Map();
    foeCache.set(data, byName);
    (data.monsters ?? []).forEach((monster, i) => {
      const combat = data.monsterCombat?.[i];
      const [level, , health] = data.monsterStats?.[i] ?? [0, 0, 0];
      if (!combat || byName!.has(monster.toLowerCase())) return;
      const s = (key: string) => combat.stats[key] ?? 0;
      const resist = Object.fromEntries(ELEMENTS.map((e) => [e, s(`${e}Resistance`)]));
      byName!.set(monster.toLowerCase(), {
        name: monster, level, health: s('Health') || health, attackDelay: combat.attackDelay, resist,
        minAC: s('MinAC'), maxAC: s('MaxAC'), minMR: s('MinMR'), maxMR: s('MaxMR'), minDC: s('MinDC'), maxDC: s('MaxDC'),
        minMC: s('MinMC'), maxMC: s('MaxMC'), minSC: s('MinSC'), maxSC: s('MaxSC'), accuracy: s('Accuracy'), agility: s('Agility'), attackSpeed: 0,
      });
    });
  }
  return byName.get(name.toLowerCase()) ?? null;
}

/** Health potions (travel.json's consumables that heal at once: no Duration), smallest first. */
export function healthPotions(data: TravelData): { name: string; heal: number; price: number; level: number; sold: boolean }[] {
  return (data.consumables ?? [])
    .filter((c) => c.stats.Health > 0 && !c.stats.Duration && /Potion/.test(c.name))
    .map((c) => ({ name: c.name, heal: c.stats.Health, price: c.price, level: c.level ?? 0, sold: !!c.sellers?.length }))
    .sort((a, b) => a.heal - b.heal);
}

/**
 * The potion drunk: `name` (as learned, calibration.ts) when it's known, else the
 * biggest health potion in the bag the level allows; null with none in the bag.
 */
export function potionInBag(data: TravelData, counts: Readonly<Record<string, number>>, level: number, name?: string | null): Potion | null {
  const potions = healthPotions(data).filter((p) => p.level <= level && (counts[p.name] ?? 0) > 0);
  const chosen = potions.find((p) => p.name === name) ?? potions.at(-1);
  return chosen ? { name: chosen.name, heal: chosen.heal, price: chosen.price, count: counts[chosen.name] } : null;
}

/** The two sides of a blow: the attack's roll and the defence's roll, by who's hitting. */
function attackOf(who: Combat & { cls?: number }, physical: boolean): [number, number] {
  if (physical) return [who.minDC, who.maxDC];
  return who.maxMC >= who.maxSC ? [who.minMC, who.maxMC] : [who.minSC, who.maxSC];
}

/** Whether the character hits with DC (else a spell: MC or SC), by class; a class not known yet goes by its biggest. */
function physicalClass(me: Fighter): boolean {
  if (PHYSICAL_CLASSES.includes(me.cls)) return true;
  if (me.cls === 1 || me.cls === 2) return false;
  return me.maxDC >= Math.max(me.maxMC, me.maxSC);
}

/** Whether a monster hits with DC against AC (else with MC or SC against MR): by its biggest. */
function physicalFoe(foe: Foe): boolean {
  return foe.maxDC >= Math.max(foe.maxMC, foe.maxSC);
}

/**
 * A blow's damage, max(floor, attack roll - defence roll), each roll a whole
 * number evenly from min to max: its mean and its mean square. Worked out a
 * value of the attack at a time (the defence rolls under it summed as a run).
 */
export function blowMoments(attack: [number, number], defence: [number, number], floor = COMBAT.minDamage): { mean: number; square: number } {
  const [a0, a1] = [Math.round(Math.min(...attack)), Math.round(Math.max(...attack))];
  const [b0, b1] = [Math.round(Math.min(...defence)), Math.round(Math.max(...defence))];
  const nb = b1 - b0 + 1;
  // Sums of x and x^2 for x from 0 to n.
  const squares = (n: number) => (n < 0 ? 0 : (n * (n + 1) * (2 * n + 1)) / 6);
  let sum = 0;
  let square = 0;
  for (let a = a0; a <= a1; a++) {
    // Defence rolls up to a - floor let a - b through; the rest leave the floor.
    const top = Math.min(b1, a - floor);
    const through = Math.max(0, top - b0 + 1);
    if (through > 0) {
      const high = a - b0;
      const low = a - top;
      sum += ((high + low) * through) / 2;
      square += squares(high) - squares(low - 1);
    }
    sum += (nb - through) * floor;
    square += (nb - through) * floor * floor;
  }
  const n = (a1 - a0 + 1) * nb;
  return { mean: sum / n, square: square / n };
}

/** The standard normal distribution's P(Z < z) (Abramowitz and Stegun 7.1.26). */
function normal(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/**
 * Swings to take `health` off, each doing `mean` on average with `variance`:
 * the expected count (the sum of the chances that n swings still fall short,
 * by whole points), and the likeliest counts. Breakpoints show: a point more
 * damage can take a swing off every kill. Very long fights go by the average.
 */
export function hitsToKill(mean: number, variance: number, health: number): { mean: number; likely: [number, number][] } {
  if (mean <= 0) return { mean: Infinity, likely: [] };
  if (health / mean > 2000) return { mean: health / mean + 0.5, likely: [] };
  let expected = 0;
  let before = 1;
  const likely: [number, number][] = [];
  for (let n = 1; before > 1e-6; n++) {
    expected += before;
    const gap = health - 0.5 - n * mean;
    const short = variance > 0 ? normal(gap / Math.sqrt(n * variance)) : gap > 0 ? 1 : 0;
    if (before - short >= 0.01) likely.push([n, before - short]);
    before = short;
  }
  return { mean: expected, likely: likely.sort((a, b) => b[1] - a[1]).slice(0, 3) };
}

/** Milliseconds between the character's swings (or casts). */
export function swingMs(me: Fighter): number {
  if (!physicalClass(me)) return COMBAT.castMs;
  return Math.max(COMBAT.minSwingMs, COMBAT.swingBaseMs - COMBAT.swingPerAttackSpeedMs * me.attackSpeed);
}

/**
 * One fight: the character against `foe` (`together` of them hitting at once,
 * killed one by one), healing with `supplies`, corrected by `factors`.
 */
export function fight(me: Fighter, foe: Foe, options: { supplies?: Supplies; factors?: Factors; together?: number } = {}): FightOutcome {
  const factors = options.factors ?? NO_CORRECTION;
  const together = options.together ?? 1;
  // The character's blows.
  const physical = physicalClass(me);
  const hitChance = physical ? Math.min(1, me.accuracy / Math.max(1, foe.agility)) : 1;
  // Elemental attack: extra damage on each blow, less the monster's resistance to that element.
  const resist = me.element ? (foe.resist[me.element] ?? 0) : 0;
  const extra = me.element ? (me.elementAttack ?? 0) * Math.max(0, 1 - resist * COMBAT.resistancePerPoint) * COMBAT.elementShare : 0;
  const scale = factors.damage;
  const blow = blowMoments(attackOf(me, physical), physical ? [foe.minAC, foe.maxAC] : [foe.minMR, foe.maxMR]);
  const perSwing = hitChance * (blow.mean + extra) * scale;
  const variance = (hitChance * (blow.square + 2 * extra * blow.mean + extra * extra) - (hitChance * (blow.mean + extra)) ** 2) * scale * scale;
  const swing = swingMs(me) / 1000;
  const hits = hitsToKill(perSwing, Math.max(0, variance), foe.health);
  const seconds = Math.max(hits.mean - COMBAT.lastSwingShare, COMBAT.lastSwingShare) * swing;
  // The monster's.
  const foePhysical = physicalFoe(foe);
  const foeHitChance = foePhysical ? Math.min(1, foe.accuracy / Math.max(1, me.agility)) : 1;
  const defence: [number, number] = foePhysical ? [me.minAC, me.maxAC] : [me.minMR, me.maxMR];
  const attack = attackOf(foe, foePhysical);
  const taken = blowMoments(attack, defence).mean * foeHitChance * factors.taken;
  const takenPerSecond = (together * taken) / (Math.max(100, foe.attackDelay) / 1000);
  const worstBlow = together * Math.max(COMBAT.minDamage, attack[1] - defence[0]) * factors.taken;
  // Health: regeneration, then potions.
  const regen = me.maxHp * COMBAT.regenPerSecond;
  const drain = takenPerSecond - regen;
  const hpLost = drain > 0 ? drain * seconds : 0;
  const safe = me.maxHp * COMBAT.safeShare;
  // A monster that can't be killed (nothing gets through) can't be fought, whatever it does.
  const survivesWithout = seconds < Infinity && hpLost <= safe && worstBlow <= safe;
  const potion = options.supplies?.potion ?? null;
  const heal = potion ? potion.heal * factors.heal : 0;
  const potionsPerKill = heal > 0 ? hpLost / heal : hpLost > 0 ? Infinity : 0;
  const healPerSecond = potion ? heal / (Math.max(options.supplies!.drinkMs, 1) / 1000) : 0;
  const potionSeconds = drain <= 0 ? Infinity : heal > 0 ? (potion!.count * heal) / drain : 0;
  const survives =
    survivesWithout ||
    (!!potion && seconds < Infinity && worstBlow <= safe && potionsPerKill <= potion.count && Math.max(0, drain - healPerSecond) * seconds <= safe);
  return {
    hitChance, perSwing, swingsPerSecond: 1 / swing, damagePerSecond: perSwing / swing, hits, seconds,
    foeHitChance, takenPerSecond, worstBlow, hpLost, potionsPerKill, goldPerKill: potion ? potionsPerKill * potion.price : 0,
    survivesWithout, survives, potionSeconds,
  };
}

/** How far a fight is from survivable: each on its own would do. */
export interface SurvivalGap {
  /** The defence stat that counts against this monster ('AC' or 'MR'), and how much more of it (min and max both); null: more than COMBAT.maxExtra. */
  defence: 'AC' | 'MR';
  more: number | null;
  /** How much more health. */
  health: number | null;
  /** Drinking `potion` (the biggest the level allows) this often (ms) instead, with enough of them; null: faster than COMBAT.fastestDrinkMs. */
  potion: string | null;
  drinkMs: number | null;
  /** Potions a kill takes, drinking so, how many of them are in the bag, and how often the bot drinks now (ms). */
  potionsPerKill: number;
  have: number;
  drinkingMs: number;
  /** No damage gets through its defence: it can't be killed at all. */
  noDamage: boolean;
}

/** The smallest whole amount from 0 to `most` for which `ok` holds (it holds from there on up), or null. */
function smallest(most: number, ok: (n: number) => boolean): number | null {
  if (!ok(most)) return null;
  let low = 0;
  let high = most;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (ok(mid)) high = mid;
    else low = mid + 1;
  }
  return low;
}

/** The character with some stats raised (by name, as Fighter has them). */
export function withStats(me: Fighter, more: Partial<Record<keyof Combat | 'maxHp', number>>): Fighter {
  const out = { ...me };
  for (const [key, amount] of Object.entries(more) as [keyof Combat | 'maxHp', number][]) out[key] += amount;
  return out;
}

/**
 * What it would take to survive the fight, even with potions: more defence, or
 * more health, or the biggest potion the level allows drunk faster (and
 * enough of them). Null when it can be survived already. `potions`: every
 * health potion (healthPotions), for the drinking advice.
 */
export function survivalGap(data: TravelData, me: Fighter, foe: Foe, options: { supplies: Supplies; factors?: Factors; together?: number }): SurvivalGap | null {
  const now = fight(me, foe, options);
  if (now.survives) return null;
  const defence = physicalFoe(foe) ? 'AC' : 'MR';
  const survivesWith = (more: Partial<Record<keyof Combat | 'maxHp', number>>) => fight(withStats(me, more), foe, options).survives;
  const more = smallest(COMBAT.maxExtra, (n) => survivesWith(defence === 'AC' ? { minAC: n, maxAC: n } : { minMR: n, maxMR: n }));
  const health = smallest(COMBAT.maxExtra * COMBAT.healthScale, (n) => survivesWith({ maxHp: n }));
  // The biggest potion the level allows (in the bag or sold), drunk as slowly as will do with plenty of them.
  const best = [...healthPotions(data)].reverse().find((p) => p.level <= me.level && (p.sold || p.name === options.supplies.potion?.name));
  let drinkMs: number | null = null;
  let potionsPerKill = now.potionsPerKill;
  if (best) {
    const plenty = (ms: number): Supplies => ({ potion: { name: best.name, heal: best.heal, price: best.price, count: Infinity }, drinkMs: ms });
    const slowest = COMBAT.maxExtra * 10;
    const steps = smallest(slowest - COMBAT.fastestDrinkMs, (n) => fight(me, foe, { ...options, supplies: plenty(slowest - n) }).survives);
    if (steps !== null) {
      drinkMs = slowest - steps;
      potionsPerKill = fight(me, foe, { ...options, supplies: plenty(drinkMs) }).potionsPerKill;
    }
  }
  return {
    defence, more, health, potion: best?.name ?? null, drinkMs, potionsPerKill, drinkingMs: options.supplies.drinkMs,
    have: best ? (options.supplies.potion?.name === best.name ? options.supplies.potion.count : 0) : 0,
    noDamage: now.perSwing <= 0,
  };
}

/**
 * "needs +90 AC, or +600 HP, or Health Potion (XL) every 2 s; it costs about 140 potions a kill (you have 30)"; when
 * drinking as now would do, given the potions: "..., or 140 Health Potion (XL) a kill (you have 30)".
 */
export function describeGap(gap: SurvivalGap): string {
  if (gap.noDamage) return 'no damage gets through its defence';
  const ways: string[] = [];
  if (gap.more !== null) ways.push(`+${gap.more} ${gap.defence}`);
  if (gap.health !== null) ways.push(`+${gap.health} HP`);
  const potions = Math.ceil(gap.potionsPerKill);
  let cost = '';
  if (gap.drinkMs !== null && gap.potion && gap.drinkMs >= gap.drinkingMs) ways.push(`${potions} ${gap.potion} a kill (you have ${gap.have})`);
  else if (gap.drinkMs !== null && gap.potion) {
    ways.push(`${gap.potion} every ${Number((gap.drinkMs / 1000).toFixed(1))} s`);
    cost = `; it costs about ${potions} potions a kill (you have ${gap.have})`;
  }
  if (!ways.length) return `out of reach (more than +${COMBAT.maxExtra} ${gap.defence} would do)`;
  return `needs ${ways.join(', or ')}${cost}`;
}

/**
 * Whether levelling alone (the class's own stats, travel.json's baseStats)
 * would close the gap within COMBAT.levelsAhead levels: the level it would,
 * or null (it's a gear gap).
 */
export function levelClosesGap(data: TravelData, me: Fighter, foe: Foe, options: { supplies: Supplies; factors?: Factors }): number | null {
  const table = data.baseStats?.[CLASS_NAMES[me.cls] ?? ''];
  const at = (level: number) => table?.find((row) => row[0] === level);
  const base = at(me.level);
  if (!base) return null;
  for (let level = me.level + 1; level <= me.level + COMBAT.levelsAhead; level++) {
    const row = at(level);
    if (!row) break;
    const d = (i: number) => row[i] - base[i];
    const later = withStats({ ...me, level }, {
      maxHp: d(1), minAC: d(3), maxAC: d(4), minMR: d(5), maxMR: d(6), minDC: d(7), maxDC: d(8), minMC: d(9), maxMC: d(10), minSC: d(11), maxSC: d(12), accuracy: d(13), agility: d(14),
    });
    if (fight(later, foe, options).survives) return level;
  }
  return null;
}

/**
 * The stat guide for the bot: the combat model's inputs (the character's stats
 * and potions from the game's memory, the corrections from their fights in the
 * grind log), the guide worked out at each Grind and Boss circuit plan
 * (stat-values.ts) and shown on its card, and what the other parts ask of it:
 * whether a monster can be survived (Grind, the circuit), what a stat point is
 * worth (the loot judge), and whether an elixir pays (Elixirs). With it, the
 * best gear from what's worn and the bag (loadout.ts), and the best for each
 * boss the circuit wants that it would make survivable: the loot judge keeps
 * those, and "Put on clear upgrades" follows its swaps. It also watches what
 * follows each health potion drunk (calibration.ts PotionWatch), and each gear
 * change against what the optimiser would have predicted (GearWatch).
 */
import type { StatGuideView } from '../shared/types';
import { calibrate, describeCalibration, drinkMs, PotionWatch, type Calibration } from './calibration';
import { CLASS_NAMES, fighterOf, foeOf, potionInBag, type Fighter, type Supplies } from './combat-model';
import { autoLevelsAbove, rateMaps, spawnDensity } from './grind';
import { describeArea, expectedCrowd, learnAreaDamage, learnCrowding } from './area-damage';
import { cantSurvive, circuitBosses, focusWeights, gain, statValues, worthOf, type ElixirAdvice, type GuideInput, type StatValues } from './stat-values';
import { GearWatch, LOADOUT, characterOf, describeCheck, describeSwap, fighterFrom, gearCorrections, optimise, type LoadoutPlan } from './loadout';
import { brokenWorn } from './loot-judge';
import type { MemoryItem } from './game-memory';
import { loadTravelData, type TravelQuest } from './travel';
import { keyCode } from './bot-shared';
import type { BotContext } from './bot-context';

/** The model's inputs are read again after this long (the corrections take a moment to work out). */
const MODEL_REFRESH_MS = 30_000;

/** Grind's chosen map and this many of the next best are weighed. */
const GRIND_CANDIDATES = 3;

/** The best gear: the plan, what it brings (Grind's exp/h over now's, the bosses it makes survivable), the bag items wanted and why, and what's broken. */
export interface GearAdvice {
  plan: LoadoutPlan;
  expGain: number;
  opens: string[];
  /** Bag items (by bagKey) the best gear, or a boss's best gear, wants: "part of the best gear (+12% exp/h)", "for Zuma Keeper". */
  wanted: Map<string, string>;
  broken: string[];
}

/** A bag item, recognised from one reading to the next: its bag slot and name. */
export const bagKey = (item: MemoryItem) => `${item.slot}:${item.name}`;

/** The model's inputs for one character. */
interface Model {
  character: string;
  me: Fighter;
  supplies: Supplies;
  calibration: Calibration;
  counts: Record<string, number>;
  at: number;
}

export class StatGuide {
  private model: Model | null = null;
  /** Monsters asked about since the model was read: why each can't be survived (null: it can). */
  private readonly verdicts = new Map<string, string | null>();
  private latest: StatValues | null = null;
  private potionWatch: { character: string; watch: PotionWatch } | null = null;
  private gearWatch: { character: string; watch: GearWatch } | null = null;
  /** What the guide was last worked out with, for scoring gear; and the gear advice from it. */
  private input: GuideInput | null = null;
  private gear: GearAdvice | null = null;
  /** The area damage line for the card, at the crowd expected on Grind's map (area-damage.ts describeArea). */
  private areaLine = 'Area damage: not measured yet';

  constructor(private readonly bot: BotContext) {}

  /** The model's inputs now (read again every MODEL_REFRESH_MS, or with `fresh`); null without the character's stats. */
  private current(fresh = false): Model | null {
    const reading = this.bot.options.memory.latest();
    const user = reading?.user;
    const me = fighterOf(user, reading?.gear?.worn ?? []);
    if (!me || !user) return null;
    const now = this.bot.clock.now();
    if (!fresh && this.model?.character === user.name && now - this.model.at < MODEL_REFRESH_MS) return { ...this.model, me };
    const log = this.bot.options.grindLog;
    const notes = log.potions(user.name);
    const counts = reading?.gear?.counts ?? {};
    // Drunk by the bot's potion key, or by the game's own auto potion (a health potion link that's on); neither: none are.
    const data = loadTravelData();
    const auto = (reading?.autoPotion ?? []).find((l) => l.enabled && l.health > 0 && data.consumables?.some((c) => c.id === l.item && c.stats.Health > 0));
    const autoName = auto ? data.consumables!.find((c) => c.id === auto.item)!.name : null;
    const potion = keyCode(this.bot.settings.hunt.hpPotionKey) !== null || autoName ? potionInBag(data, counts, me.level, notes?.potion ?? autoName) : null;
    this.model = { character: user.name, me, supplies: { potion, drinkMs: drinkMs(notes) }, calibration: calibrate(loadTravelData(), log.fights(user.name).kills, notes), counts, at: now };
    this.verdicts.clear();
    return this.model;
  }

  /** Why the model says a monster can't be survived even with potions, and what it would take; null when it can (or there's no telling). */
  cantSurvive(name: string): string | null {
    const model = this.current();
    if (!model) return null;
    const key = name.toLowerCase();
    if (!this.verdicts.has(key)) {
      const foe = foeOf(loadTravelData(), name);
      this.verdicts.set(key, foe ? cantSurvive(loadTravelData(), model.me, foe, model.supplies, model.calibration) : null);
    }
    return this.verdicts.get(key)!;
  }

  /** What a point of each stat is worth (Library.Stat numbers), for the loot judge; null until the guide has been worked out. */
  values(): Record<number, number> | null {
    return this.latest?.perStat ?? null;
  }

  /** The guide's word on an elixir kind ('Haste'...), or null until it's been worked out. */
  elixir(family: string): ElixirAdvice | null {
    return this.latest?.elixirs.find((e) => e.family === family) ?? null;
  }

  /**
   * Works the guide out again and shows it: Grind's maps (`grinding`, the one
   * ground on, and the best for the level) and the circuit's bosses, weighed as
   * the settings say. Nothing without the character's stats.
   */
  update(grinding?: number): void {
    const data = loadTravelData();
    const model = this.current(true);
    const reading = this.bot.options.memory.latest();
    const user = reading?.user;
    if (!model || !user) return;
    const log = this.bot.options.grindLog;
    const { me } = model;
    const band = autoLevelsAbove(log.fights(user.name), this.bot.settings.grind.maxLevelsAbove, Date.now());
    const grinder = { level: me.level, cls: me.cls };
    // Grind's maps rated as Grind rates them: with the area damage learned, crowds going down faster.
    const samples = log.areaSamples(user.name);
    const area = { damage: learnAreaDamage(samples, me.level), crowding: learnCrowding(samples, (m) => spawnDensity(data, m)) };
    const grindOptions = { maxLevelsAbove: band.levels, quests: reading?.questTargets ?? undefined, area };
    const best = rateMaps(data, grinder, grindOptions).slice(0, GRIND_CANDIDATES).map((r) => r.map);
    const maps = [...new Set([...(grinding !== undefined ? [grinding] : []), ...best])];
    const top = maps[0];
    this.areaLine = describeArea(area.damage, top === undefined ? 1 : expectedCrowd(area.crowding, top, spawnDensity(data, top)));
    const quests = (this.bot.settings.circuit?.quests ?? [])
      .map((id) => data.quests?.find((q) => q.id === id))
      .filter((q): q is TravelQuest => !!q && (q.level ?? 0) <= me.level);
    const { bosses, rewards } = circuitBosses(quests);
    const guide = this.bot.settings.guide ?? { auto: true, focus: 50 };
    const weights = focusWeights(log.sessions(user.name), log.bossTime(user.name), Date.now(), guide.auto ? null : guide.focus);
    this.input = { data, me, supplies: model.supplies, calibration: model.calibration, maps, grinder, grindOptions, bosses, rewards, weights, counts: model.counts };
    this.latest = statValues(this.input);
    this.refreshGear();
    this.bot.options.statGuide?.(this.view(model, this.latest, weights, guide.auto));
  }

  /** The gear advice as last worked out (null: never, or no stats). */
  gearAdvice(): GearAdvice | null {
    return this.gear;
  }

  /** Why the best gear wants a bag item (null: it doesn't, or there's no advice). */
  planned(item: MemoryItem): string | null {
    return this.gear?.wanted.get(bagKey(item)) ?? null;
  }

  /**
   * Works the best gear out again from what's worn and the bag now, scored by
   * what the character does as the guide last weighed it; and for each boss
   * the circuit wants that can't be survived, the best gear for that boss
   * alone, when it would make it survivable. Null without the stats, or before
   * the guide has been worked out.
   */
  refreshGear(): GearAdvice | null {
    const reading = this.bot.options.memory.latest();
    const char = reading ? characterOf(reading) : null;
    const gear = reading?.gear;
    if (!char || !gear || !this.input || !reading?.user) {
      this.gear = null;
      return null;
    }
    const corrections = gearCorrections(this.bot.options.grindLog.gearChecks(reading.user.name));
    const me = fighterFrom(char, char.totals, gear.worn.map((item) => ({ slot: item.slot, item })));
    const best = (input: GuideInput) => {
      const base = worthOf(input, me);
      const plan = optimise(char, gear.worn, gear.bag, (f) => gain(input, base, worthOf(input, f)), corrections);
      return { plan, base, after: worthOf(input, plan.fighter) };
    };
    const input = { ...this.input, me };
    const found = best(input);
    const { base } = found;
    // Not worth it (a near tie): what's worn stays the advice.
    const worth = found.plan.score - found.plan.currentScore >= LOADOUT.worthSwapping;
    const plan = worth ? found.plan : { ...found.plan, swaps: [] };
    const after = worth ? found.after : base;
    const expGain = base.grind > 0 ? after.grind / base.grind - 1 : 0;
    const opens = after.survivable.filter((b) => !base.survivable.includes(b));
    const wanted = new Map<string, string>();
    const why = `part of the best gear (${describeGain(plan.score, expGain, opens, this.input)})`;
    for (const swap of plan.swaps) wanted.set(bagKey(swap.item), why);
    // Each boss the circuit wants that can't be survived: its own best gear, kept if that would do it.
    for (const boss of new Map(input.bosses.map((b) => [b.name.toLowerCase(), b])).values()) {
      if (base.survivable.includes(boss.name.toLowerCase())) continue;
      const solo = best({ ...input, maps: [], bosses: [boss], weights: { grind: 0, bosses: 1 } });
      if (!solo.after.survivable.includes(boss.name.toLowerCase())) continue;
      for (const swap of solo.plan.swaps) if (!wanted.has(bagKey(swap.item))) wanted.set(bagKey(swap.item), `for ${boss.name} (it makes it survivable)`);
    }
    this.gear = { plan, expGain, opens, wanted, broken: brokenWorn(gear.worn) };
    return this.gear;
  }

  /** Each reading: a gear change is checked against what the optimiser would have predicted, said, and kept for its corrections. */
  watchGear(): void {
    const reading = this.bot.options.memory.latest();
    const name = reading?.user?.name;
    if (!reading || !name) return;
    if (this.gearWatch?.character !== name) this.gearWatch = { character: name, watch: new GearWatch(this.bot.options.grindLog.gearChecks(name)) };
    const check = this.gearWatch.watch.update(reading, this.bot.clock.now());
    if (!check) return;
    this.bot.options.grindLog.setGearChecks(name, this.gearWatch.watch.checks);
    this.bot.status(describeCheck(check));
  }

  /** The card. */
  private view(model: Model, values: StatValues, weights: { grind: number; bosses: number }, auto: boolean): StatGuideView {
    const { me, supplies } = model;
    let potions = "No health potion key set (Keys & potions) and no health potion on the game's auto potion, or none in the bag: no potions are counted on.";
    if (supplies.potion) {
      const costs = values.costs.map((c) => `${c.name} ${c.potions.toFixed(c.potions < 10 ? 1 : 0)} (${Math.round(c.gold)} gold)`);
      potions =
        `${supplies.potion.name}, ${supplies.potion.count} in the bag, one every ${Number((supplies.drinkMs / 1000).toFixed(1))} s at most. ` +
        (costs.length ? `Potions a kill: ${costs.join(', ')}.` : 'Nothing here costs potions.');
    }
    return {
      character: `Level ${me.level} ${CLASS_NAMES[me.cls] ?? 'character'}`,
      activities: values.activities,
      weights: { ...weights, auto },
      stats: values.groups.map((g) => g.line),
      locked: values.locked,
      elixirs: values.elixirs.map((e) => ({ line: e.line, pays: e.pays })),
      potions,
      calibration: describeCalibration(model.calibration),
      area: this.areaLine,
      gear: {
        swaps: this.gear?.plan.swaps.map((swap) => describeSwap(swap, this.bot.options.memory.latest()?.gear?.columns)) ?? [],
        gain: this.gear ? (this.gear.plan.swaps.length ? describeGain(this.gear.plan.score, this.gear.expGain, this.gear.opens, this.input!) : "what's worn is the best found") : 'not worked out (the gear and stats not read yet)',
        broken: this.gear?.broken ?? [],
      },
    };
  }

  /** After each potion check (`drank`: a health potion was just drunk): learns from what follows, keeping it in the grind log. */
  watchPotions(drank: boolean): void {
    const reading = this.bot.options.memory.latest();
    const name = reading?.user?.name;
    if (!name) return;
    if (this.potionWatch?.character !== name) this.potionWatch = { character: name, watch: new PotionWatch(loadTravelData(), this.bot.options.grindLog.potions(name)) };
    const now = this.bot.clock.now();
    if (drank) this.potionWatch.watch.pressed(reading, now);
    if (this.potionWatch.watch.update(reading, now)) this.bot.options.grindLog.setPotions(name, this.potionWatch.watch.notes);
  }
}

/** "+12% exp/h; makes Zuma Keeper survivable", or the weighted gain when Grind doesn't count. */
function describeGain(score: number, expGain: number, opens: string[], input: GuideInput): string {
  const percent = (share: number) => `${share >= 0 ? '+' : ''}${(share * 100).toFixed(Math.abs(share) >= 0.1 ? 0 : 1)}%`;
  const names = opens.map((o) => input.bosses.find((b) => b.name.toLowerCase() === o)?.name ?? o);
  const parts = [input.weights.grind > 0 ? `${percent(expGain)} exp/h` : `${percent(score)} from bosses`, ...(names.length ? [`makes ${names.join(', ')} survivable`] : [])];
  return parts.join('; ');
}

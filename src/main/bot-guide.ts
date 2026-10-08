/**
 * The stat guide for the bot: the combat model's inputs (the character's stats
 * and potions from the game's memory, the corrections from their fights in the
 * grind log), the guide worked out at each Grind and Boss circuit plan
 * (stat-values.ts) and shown on its card, and what the other parts ask of it:
 * whether a monster can be survived (Grind, the circuit), what a stat point is
 * worth (the loot judge), and whether an elixir pays (Elixirs). It also watches
 * what follows each health potion drunk (calibration.ts PotionWatch).
 */
import type { StatGuideView } from '../shared/types';
import { calibrate, describeCalibration, drinkMs, PotionWatch, type Calibration } from './calibration';
import { CLASS_NAMES, fighterOf, foeOf, potionInBag, type Fighter, type Supplies } from './combat-model';
import { autoLevelsAbove, rateMaps } from './grind';
import { cantSurvive, circuitBosses, focusWeights, statValues, type ElixirAdvice, type StatValues } from './stat-values';
import { loadTravelData, type TravelQuest } from './travel';
import { keyCode } from './bot-shared';
import type { BotContext } from './bot-context';

/** The model's inputs are read again after this long (the corrections take a moment to work out). */
const MODEL_REFRESH_MS = 30_000;

/** Grind's chosen map and this many of the next best are weighed. */
const GRIND_CANDIDATES = 3;

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
    // Without a potion key, none are drunk.
    const potion = keyCode(this.bot.settings.hunt.hpPotionKey) !== null ? potionInBag(loadTravelData(), counts, me.level, notes?.potion) : null;
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
    const grindOptions = { maxLevelsAbove: band.levels, quests: reading?.questTargets ?? undefined };
    const best = rateMaps(data, grinder, grindOptions).slice(0, GRIND_CANDIDATES).map((r) => r.map);
    const maps = [...new Set([...(grinding !== undefined ? [grinding] : []), ...best])];
    const quests = (this.bot.settings.circuit?.quests ?? [])
      .map((id) => data.quests?.find((q) => q.id === id))
      .filter((q): q is TravelQuest => !!q && (q.level ?? 0) <= me.level);
    const { bosses, rewards } = circuitBosses(quests);
    const guide = this.bot.settings.guide ?? { auto: true, focus: 50 };
    const weights = focusWeights(log.sessions(user.name), log.bossTime(user.name), Date.now(), guide.auto ? null : guide.focus);
    this.latest = statValues({ data, me, supplies: model.supplies, calibration: model.calibration, maps, grinder, grindOptions, bosses, rewards, weights, counts: model.counts });
    this.bot.options.statGuide?.(this.view(model, this.latest, weights, guide.auto));
  }

  /** The card. */
  private view(model: Model, values: StatValues, weights: { grind: number; bosses: number }, auto: boolean): StatGuideView {
    const { me, supplies } = model;
    let potions = 'No health potion key set (Keys & potions), or none in the bag: no potions are counted on.';
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

/** Grind mode: the best map for the level (grind.ts), travelled to and hunted on, measuring the experience. */

import { walkDistances } from './map-path';
import { loadTravelData, mapName } from './travel';
import { autoLevelsAbove, chooseGrindMap, dangerByGap, describeChoice, measuredDamage, rateMap, rateMaps, spawnDensity, type GrindOptions } from './grind';
import { describeArea, learnAreaDamage, learnCrowding, stintArea } from './area-damage';
import { ExperienceMeter, damageDealt } from './grind-log';
import { BotError, MEMORY_START_MS } from './bot-shared';
import type { BotContext } from './bot-context';

export class Grinding {
  constructor(private readonly bot: BotContext) {}

  /**
   * Levels the character up: picks the best map for their level and class
   * (grind.ts), travels there and hunts, seeking monsters, until it's time to
   * plan again: every so many minutes, on reaching a new level, or on leaving
   * the map (a death, say). Planning again keeps the map while it's still best.
   */
  async grindLoop(): Promise<string> {
    const data = loadTravelData();
    const memory = this.bot.options.memory;
    if (!memory.installed) throw new BotError('Grind needs the memory reader (run scripts/setup-game-reader.ps1).');
    memory.start();
    const started = this.bot.clock.now();
    /** The map being ground on, kept unless another is clearly better. */
    let grinding: number | undefined;
    /** Maps said to be skipped as unsurvivable (said once a run, while the reason holds). */
    const said = new Set<string>();
    this.bot.elixirs.reset();

    while (true) {
      await this.bot.yieldToEvents();
      // Quest monsters only would leave most of them alone.
      if (this.bot.settings.hunt.questOnly) throw new BotError('Grind hunts every monster: untick Quest monsters only (Hunt) first.');
      const reading = memory.latest();
      const map = memory.map();
      const user = reading?.user;
      if (!reading || !map || !user || user.level === undefined) {
        this.bot.statusEvery(
          !reading
            ? this.bot.clock.now() - started < MEMORY_START_MS ? 'Starting the memory reader' : `Waiting for the game's memory (${memory.problem})`
            : !map ? 'Waiting for the map from the game' : "Waiting for the character's level",
        );
        await this.bot.sleep(300);
        continue;
      }
      const level = user.level;
      const here = { x: user.x, y: user.y };
      const unlocked = reading.waypoints?.unlocked?.length ? new Set(reading.waypoints.unlocked.map((w) => w.name)) : undefined;
      const { replanMinutes, maxLevelsAbove, questsFirst } = this.bot.settings.grind;
      const start = { map: map.index, steps: this.bot.travel.exitSteps(data, map, walkDistances(map, here)), at: here };
      // What the character's fights have shown: how hard they hit, and how far above their level is safe (the setting is the cap).
      const log = this.bot.options.grindLog;
      const fights = log.fights(user.name);
      const band = autoLevelsAbove(fights, maxLevelsAbove, Date.now());
      const who = { level, cls: user.class, waypoints: unlocked };
      const options: GrindOptions = {
        maxLevelsAbove: band.levels,
        damage: measuredDamage(data, fights.kills, level, user.class),
        danger: dangerByGap(fights),
        measured: log.sessions(user.name),
        quests: reading.questTargets ?? undefined,
        // How much faster crowds go down (none seen: one at a time, as before), and how crowded each map gets.
        area: {
          damage: learnAreaDamage(log.areaSamples(user.name), level),
          crowding: learnCrowding(log.areaSamples(user.name), (m) => spawnDensity(data, m)),
        },
      };
      // Maps the combat model says can't be survived even with potions are left out (once they can, they're back).
      const cantSurvive: GrindOptions['cantSurvive'] = (m) => this.bot.guide.cantSurvive(m.name);
      const choice = chooseGrindMap(data, start, who, { ...options, cantSurvive, current: grinding, questsFirst });
      if (!choice) throw new BotError(`No map to grind on at level ${level} can be reached from ${mapName(data, map.index)}.`);
      grinding = choice.map;
      for (const better of rateMaps(data, who, options).filter((r) => r.rate > choice.rate)) {
        const rating = rateMap(data, better.map, who, { ...options, cantSurvive });
        if (!('skip' in rating) || said.has(`${better.map}:${rating.skip}`)) continue;
        said.add(`${better.map}:${rating.skip}`);
        this.bot.status(`Skipping ${better.name}: ${rating.skip}`);
      }
      this.bot.guide.update(choice.map);
      const plan = describeChoice(choice, level, band);
      this.bot.status(plan);
      this.bot.status(describeArea(options.area?.damage, choice.crowd));
      if (map.index !== choice.map) {
        this.bot.status(await this.bot.travel.travelTo(`map:${choice.map}`));
        this.bot.status(plan);
      }

      // Hunt until it's time to plan again (time paused doesn't count), measuring the experience it brings.
      const huntStart = this.bot.clock.now();
      const huntStartAt = Date.now();
      const pausedBefore = this.bot.pausedMs;
      const meter = new ExperienceMeter();
      meter.sample(memory.latest()?.user);
      const why = await this.bot.hunting.huntLoop({
        seek: true,
        stopWhen: () => {
          const now = memory.latest();
          meter.sample(now?.user);
          if (now?.user?.dead) return 'dead';
          if (this.bot.survival.bagFull(now)) return 'bag';
          const newLevel = now?.user?.level;
          if (newLevel !== undefined && newLevel !== level) return `Level ${newLevel}: planning again`;
          if (now?.map && now.map.index !== choice.map) return `Left ${choice.name}: planning again`;
          const minutes = (this.bot.clock.now() - huntStart - (this.bot.pausedMs - pausedBefore)) / 60_000;
          return minutes >= replanMinutes ? `${replanMinutes} minutes on ${choice.name}: planning again` : null;
        },
      });
      meter.sample(memory.latest()?.user);
      const ms = this.bot.clock.now() - huntStart - (this.bot.pausedMs - pausedBefore);
      // With the damage the kills timed on it took: the estimate it's checked against goes by that.
      const timed = damageDealt(log.fights(user.name).kills.filter((k) => k.at >= huntStartAt));
      // ...and with the area damage it measured, which its experience has in it too.
      const own = stintArea(log.areaSamples(user.name).filter((s) => s.at >= huntStartAt && s.map === choice.map), level);
      log.add(user.name, { map: choice.map, level, ms, exp: meter.gained, at: Date.now(), ...(timed && { kills: timed.kills, dps: timed.dps }), ...own });
      if (why === 'dead') {
        await this.bot.survival.reviveInArcadia();
        continue;
      }
      if (why === 'bag') {
        await this.bot.survival.emptyBag();
        continue;
      }
      this.bot.status(why);
    }
  }
}

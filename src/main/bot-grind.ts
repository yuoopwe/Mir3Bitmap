/** Grind mode: the best map for the level (grind.ts), travelled to and hunted on, measuring the experience. */

import { walkDistances } from './map-path';
import { loadTravelData, mapName } from './travel';
import { chooseGrindMap, describeChoice } from './grind';
import { ExperienceMeter } from './grind-log';
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
      const choice = chooseGrindMap(data, start, { level, cls: user.class, waypoints: unlocked }, {
        maxLevelsAbove,
        current: grinding,
        measured: this.bot.options.grindLog.sessions(user.name),
        quests: reading.questTargets ?? undefined,
        questsFirst,
      });
      if (!choice) throw new BotError(`No map to grind on at level ${level} can be reached from ${mapName(data, map.index)}.`);
      grinding = choice.map;
      const plan = describeChoice(choice, level);
      this.bot.status(plan);
      if (map.index !== choice.map) {
        this.bot.status(await this.bot.travel.travelTo(`map:${choice.map}`));
        this.bot.status(plan);
      }

      // Hunt until it's time to plan again (time paused doesn't count), measuring the experience it brings.
      const huntStart = this.bot.clock.now();
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
      this.bot.options.grindLog.add(user.name, { map: choice.map, level, ms, exp: meter.gained, at: Date.now() });
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

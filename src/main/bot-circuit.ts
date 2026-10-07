/**
 * Boss circuit: the daily boss quests (the Seasonal Supply Hunt, the Elite
 * Bounties) taken, done and handed in, going round the sub-boss and boss
 * spawns in the order boss-planner.ts gives; and, with "Keep hunting bosses",
 * round the same spawns for their drops once the quests are done for the day.
 * The quests go through Quests' NPC steps, the trips through Travel, the
 * fighting through Hunt (just the monster wanted at each spawn), and a full
 * bag, a death or a fight going badly through Survival.
 */
import type { CircuitView } from '../shared/types';
import { loadTravelData, mapName, type TravelQuest } from './travel';
import { RouteCosts } from './quest-planner';
import { autoLevelsAbove, levelAllows } from './grind';
import { CIRCUIT, bossSpawns, describeStop, planCircuit, questStatus, questTasks, summonFor, type CircuitPlan, type CircuitStop, type Summon } from './boss-planner';
import type { MemoryState } from './game-memory';
import { BotError, MEMORY_START_MS, Stopped } from './bot-shared';
import type { BotContext } from './bot-context';

/** A quest the NPC didn't give (done today, or not for this character) isn't asked for again for this long. */
const NOT_OFFERED_RETRY_MS = 60 * 60_000;

/** A monster with less than this share of its health left is nearly dead: not a reason to run, however low the HP. */
const NEARLY_DEAD_SHARE = 0.2;

/** Hand-ins that don't take, this many times over, stop the circuit. */
const HAND_IN_TRIES = 3;

/** The item the circuit is for: counted in the bag to say how many it brought. */
const FORGE_STONE = 'Forge Stone';

const DEFAULTS = { quests: [1840], keepHunting: false, retreatHpPercent: 35 };

/** Summoning a boss (killing what brings it) is given up after this long, and that boss left for the run. */
const SUMMON_GIVE_UP_MS = 60 * 60_000;

export class BossCircuit {
  constructor(private readonly bot: BotContext) {}

  /**
   * Goes round: hands in what's finished, takes the circuit's quests on offer,
   * then visits the spawns of the monsters still wanted, nearest (and back)
   * first, fighting just those there, until every task is done. Spawns cleared
   * or found empty wait their respawn time; one where the HP ran low is left
   * for the run. With the quests done for the day, it stops, or with "Keep
   * hunting bosses" goes round the same spawns for their drops.
   */
  async circuitLoop(): Promise<string> {
    const data = loadTravelData();
    const memory = this.bot.options.memory;
    if (!memory.installed) throw new BotError('The Boss circuit needs the memory reader (run scripts/setup-game-reader.ps1).');
    memory.start();
    const started = this.bot.clock.now();
    const routes = new RouteCosts(data);
    /** When each spawn was last cleared or found empty, and the spawns left for this run. */
    const clearedAt = new Map<string, number>();
    const tooHard = new Set<string>();
    /** Bosses summoned by kills that were given up on (too long, too hard, nowhere to summon them), for this run. */
    const summonsGivenUp = new Set<string>();
    /** Quests the NPC didn't give, until when; hand-ins that didn't take. */
    const notOffered = new Map<number, number>();
    let handInFailures = 0;
    /** Forge Stones in the bag when the run started (once read). */
    let stonesAtStart: number | null = null;
    /** Spawns already said to be skipped (said once a run). */
    const said = new Set<string>();

    while (true) {
      await this.bot.yieldToEvents();
      const reading = memory.latest();
      const map = memory.map();
      const user = reading?.user;
      if (!reading || !map || !user || user.level === undefined || !reading.questLog) {
        this.bot.statusEvery(
          !reading
            ? this.bot.clock.now() - started < MEMORY_START_MS ? 'Starting the memory reader' : `Waiting for the game's memory (${memory.problem})`
            : !reading.questLog ? 'Waiting for the quest log' : 'Waiting for the map from the game',
        );
        await this.bot.sleep(300);
        continue;
      }
      if (user.dead) {
        await this.bot.survival.reviveInArcadia();
        continue;
      }
      if (this.bot.survival.bagFull(reading)) {
        await this.bot.survival.emptyBag();
        continue;
      }
      stonesAtStart ??= this.stones(reading);
      const now = this.bot.clock.now();
      for (const [id, until] of notOffered) if (until <= now) notOffered.delete(id);
      const settings = { ...DEFAULTS, ...this.bot.settings.circuit };
      const chosen = settings.quests.map((id) => data.quests?.find((q) => q.id === id)).filter((q): q is TravelQuest => !!q);
      const quests = chosen.filter((q) => (q.level ?? 0) <= user.level!);
      const log = reading.questLog;

      // 1. Hand in what's finished.
      const ready = quests.find((q) => questStatus(q, log) === 'ready');
      if (ready) {
        if (await this.handIn(ready)) handInFailures = 0;
        else if (++handInFailures >= HAND_IN_TRIES) throw new BotError(`Couldn't hand in ${ready.name} (${HAND_IN_TRIES} tries).`);
        continue;
      }
      // 2. Take what's on offer.
      const take = quests.find((q) => questStatus(q, log) === 'none' && !notOffered.has(q.id));
      if (take) {
        await this.toNpcMap(take.start, `Taking ${take.name}`);
        await this.bot.quests.atQuestNpc(take.start, 'accept', `Taking ${take.name}`);
        if (questStatus(take, memory.latest()?.questLog ?? []) === 'none') {
          notOffered.set(take.id, this.bot.clock.now() + NOT_OFFERED_RETRY_MS);
          this.bot.status(`${take.name} isn't on offer (done today?)`);
        }
        continue;
      }

      // 3. What's wanted: the unfinished kills of the quests on the go; else, with "Keep hunting bosses", every circuit monster.
      const active = quests.filter((q) => questStatus(q, log) === 'active');
      const tasks = active.flatMap((q) => questTasks(q, reading.questTargets ?? []));
      const need = new Map<string, number>();
      for (const t of tasks) need.set(t.monster.toLowerCase(), (need.get(t.monster.toLowerCase()) ?? 0) + t.need - t.done);
      const wanted = [...need].filter(([, n]) => n > 0).map(([name]) => name);
      const farming = !wanted.length;
      if (farming && !settings.keepHunting) {
        this.bot.stopRunning();
        if (!quests.length) return chosen.length ? `None of the circuit's quests is open to level ${user.level} yet.` : 'Tick a quest for the circuit first (Boss circuit tab).';
        return `${quests.map((q) => shortName(q)).join(', ')} done for today; next one after reset.`;
      }
      const names = new Set(farming ? quests.flatMap((q) => questTasks(q, [])).map((t) => t.monster.toLowerCase()) : wanted);
      const spawns = bossSpawns(data, names).filter((s) => !farming || CIRCUIT.farmKinds.includes(s.kind));
      const fights = this.bot.options.grindLog.fights(user.name);
      const band = autoLevelsAbove(fights, this.bot.settings.grind.maxLevelsAbove, Date.now());
      const unlocked = reading.waypoints?.unlocked?.length ? new Set(reading.waypoints.unlocked.map((w) => w.name)) : undefined;

      // A wanted boss with no spawn of its own comes when summoned (the Elite Bounties' behemoths): kill what brings it, by it.
      const summon = farming ? null : summonFor(data, wanted.filter((n) => !spawns.some((s) => s.monster.toLowerCase() === n) && !summonsGivenUp.has(n)));
      if (summon) {
        const bossLevel = data.monsterStats?.[data.monsters!.indexOf(summon.boss)]?.[0] ?? 0;
        const who = { map: map.index, level: user.level, cls: user.class, waypoints: unlocked };
        const where = summon.maps.find(([m]) => {
          const info = data.maps.find((x) => x.i === m);
          return info && levelAllows(info, user.level!) && routes.steps(map.index, m, who) < Infinity;
        });
        if (bossLevel > user.level + band.levels || !where) {
          summonsGivenUp.add(summon.boss.toLowerCase());
          this.bot.status(`Skipping ${summon.boss}: ${!where ? 'nowhere to summon it' : `level ${bossLevel}: too strong for level ${user.level} yet`}`);
          continue;
        }
        const result = await this.summonAt(summon, where[0], settings.retreatHpPercent);
        if (result === 'danger') await this.bot.survival.retreat(`HP low fighting ${summon.boss}`);
        if (result === 'danger' || result === 'timeout' || result === 'unreachable') summonsGivenUp.add(summon.boss.toLowerCase());
        continue;
      }

      // 4. The circuit from here, as far above the level as the character's fights say is safe.
      const plan = planCircuit(data, spawns, { map: map.index, level: user.level, cls: user.class, waypoints: unlocked, maxLevelsAbove: band.levels }, {
        now, routes, clearedAt, tooHard, need: farming ? undefined : need,
      });
      const progress = farming ? 'Hunting bosses' : `${active.map(shortName).join(', ')} ${sum(tasks, 'done')}/${sum(tasks, 'need')}`;
      this.show(plan, tasks, farming ? null : active.map((q) => q.name).join(', '), reading, stonesAtStart, now);
      for (const { spawn, why } of plan.skipped) {
        if (said.has(`${spawn.key}:${why}`)) continue;
        said.add(`${spawn.key}:${why}`);
        this.bot.status(`Skipping ${spawn.monster} at ${spawn.mapName}: ${why}`);
      }
      const stop = plan.stops[0];
      if (!stop) {
        const why = plan.skipped.map((s) => `${s.spawn.monster} (${s.why})`).join(', ');
        throw new BotError(`Nothing on the circuit can be done${why ? `: ${why}` : ''}.`);
      }
      this.bot.status(`${progress} · next: ${describeStop(stop, now)}`);

      // 5. There: by Return to Arcadia when that's the quicker way; a trip that fails means trying the others first.
      try {
        if (stop.viaArcadia && map.index !== CIRCUIT.arcadia) await this.bot.survival.returnToArcadia(`On to ${stop.spawn.monster}`);
        if (memory.latest()?.user?.dead) continue;
        this.bot.status(await this.bot.travel.travelTo(`spot:${stop.spawn.map}:${stop.spawn.x}:${stop.spawn.y}`));
      } catch (error) {
        if (error instanceof Stopped || !(error instanceof BotError)) throw error;
        clearedAt.set(stop.spawn.key, this.bot.clock.now());
        this.bot.status(`Couldn't get to ${stop.spawn.monster} at ${stop.spawn.mapName} (${error.message}); planning again`);
        continue;
      }

      // 6. Fight there.
      const why = await this.fightAt(stop, farming ? null : need, settings.retreatHpPercent, progress);
      if (why === 'empty') clearedAt.set(stop.spawn.key, this.bot.clock.now());
      if (why === 'stalled') {
        clearedAt.set(stop.spawn.key, this.bot.clock.now());
        this.bot.status(`Nothing happening at ${stop.spawn.mapName} for ${CIRCUIT.watchdogMinutes} minutes; planning again`);
      }
      if (why === 'danger') {
        tooHard.add(stop.spawn.key);
        await this.bot.survival.retreat(`HP low fighting ${stop.spawn.monster}`);
        this.bot.status(`${stop.spawn.monster} at ${stop.spawn.mapName} is too hard: left for this run`);
      }
      // A death, a full bag: dealt with at the top.
    }
  }

  /**
   * Fights the stop's monster at its spawn until it's done there: the task is
   * finished ('done'), none have been about for CIRCUIT.emptySeconds ('empty'),
   * nothing has happened for CIRCUIT.watchdogMinutes ('stalled'), the HP ran
   * low ('danger'), or a death, a full bag or leaving the map. A spawn not back
   * yet is waited at (fighting any that turn up).
   */
  private async fightAt(stop: CircuitStop, need: ReadonlyMap<string, number> | null, retreatHpPercent: number, progress: string): Promise<string> {
    const memory = this.bot.options.memory;
    const data = loadTravelData();
    const { spawn } = stop;
    const name = spawn.monster.toLowerCase();
    const start = this.bot.clock.now();
    let seenAt = Math.max(start, stop.readyAt);
    let progressAt = start;
    let kills = this.bot.kills;
    let left = need?.get(name) ?? 0;
    /** The damage seen on the monsters wanted here, added up: changing, the fight is going somewhere (a long one too). */
    let damage = 0;
    this.bot.status(`${progress} · ${spawn.monster} at ${spawn.mapName}${stop.readyAt > start ? `: waiting for them to come back` : ''}`);
    return this.bot.hunting.huntLoop({
      seek: true,
      only: [spawn.monster],
      // HP low fighting one, with none of them nearly dead: away, mid-fight.
      breakOff: () => {
        const reading = memory.latest();
        const user = reading?.user;
        if (user?.dead) return 'dead';
        const low = user?.hp !== undefined && !!user.maxHp && (user.hp / user.maxHp) * 100 < retreatHpPercent;
        return low && this.losing(reading!, name) ? 'danger' : null;
      },
      stopWhen: () => {
        const reading = memory.latest();
        if (this.bot.survival.bagFull(reading)) return 'bag';
        if (reading?.map && reading.map.index !== spawn.map) return 'left';
        const now = this.bot.clock.now();
        if (need && reading) {
          const stillWanted = this.left(reading, name);
          if (stillWanted <= 0) return 'done';
          if (stillWanted !== left) progressAt = now;
          left = stillWanted;
        }
        if (this.bot.kills !== kills) {
          kills = this.bot.kills;
          progressAt = now;
        }
        const seen = (reading?.objects ?? []).filter((o) => o.kind === 'monster' && o.name.toLowerCase() === name).reduce((sum, o) => sum + (o.hp ?? 0), 0);
        if (seen !== damage) {
          damage = seen;
          progressAt = now;
        }
        if ((reading?.objects ?? []).some((o) => o.kind === 'monster' && !o.dead && o.name.toLowerCase() === name)) seenAt = Math.max(seenAt, now);
        if (now - seenAt > CIRCUIT.emptySeconds * 1000) return 'empty';
        return now - Math.max(progressAt, stop.readyAt) > CIRCUIT.watchdogMinutes * 60_000 ? 'stalled' : null;
      },
    }).then((why) => {
      if (why === 'done') this.bot.status(`Done with ${spawn.monster} (${mapName(data, spawn.map)})`);
      return why;
    });
  }

  /**
   * Summons a boss that comes by kills: on `map`, kills the monsters that bring it (and it, once it's there) until
   * the quest has it ('done'), or for SUMMON_GIVE_UP_MS ('timeout'), or the HP runs low against it ('danger').
   */
  private async summonAt(summon: Summon, map: number, retreatHpPercent: number): Promise<string> {
    const memory = this.bot.options.memory;
    const data = loadTravelData();
    const boss = summon.boss.toLowerCase();
    try {
      this.bot.status(await this.bot.travel.travelTo(`map:${map}`));
    } catch (error) {
      if (error instanceof Stopped || !(error instanceof BotError)) throw error;
      this.bot.status(`Couldn't get to ${mapName(data, map)} to summon ${summon.boss} (${error.message})`);
      return 'unreachable';
    }
    const start = this.bot.clock.now();
    this.bot.status(`Summoning ${summon.boss} at ${mapName(data, map)}: killing ${summon.killers.join(', ')} (it comes every ${summon.every} kills, counted for everyone, by whoever makes the last)`);
    const why = await this.bot.hunting.huntLoop({
      seek: true,
      seekSpots: true,
      only: [summon.boss, ...summon.killers],
      breakOff: () => {
        const reading = memory.latest();
        const user = reading?.user;
        if (user?.dead) return 'dead';
        const low = user?.hp !== undefined && !!user.maxHp && (user.hp / user.maxHp) * 100 < retreatHpPercent;
        return low && this.losing(reading!, boss) ? 'danger' : null;
      },
      stopWhen: () => {
        const reading = memory.latest();
        if (reading && this.left(reading, boss) <= 0) return 'done';
        if (this.bot.survival.bagFull(reading)) return 'bag';
        if (reading?.map && reading.map.index !== map) return 'left';
        return this.bot.clock.now() - start > SUMMON_GIVE_UP_MS ? 'timeout' : null;
      },
    });
    if (why === 'done') this.bot.status(`${summon.boss} done`);
    if (why === 'timeout') this.bot.status(`No ${summon.boss} after ${SUMMON_GIVE_UP_MS / 60_000} minutes at ${mapName(data, map)}: left for this run`);
    return why;
  }

  /** How many more of a monster the quests on the go want, by the quest targets now. */
  private left(reading: MemoryState, name: string): number {
    const targets = (reading.questTargets ?? []).filter((t) => t.name.toLowerCase() === name);
    return targets.reduce((sum, t) => sum + Math.max(0, (t.need ?? 1) - (t.done ?? 0)), 0);
  }

  /**
   * In a fight with the monster (one within 2 tiles) and none of those nearly dead (worth finishing whatever the HP).
   * The monster's hp reads as the damage seen land on it, going negative from 0.
   */
  private losing(reading: MemoryState, name: string): boolean {
    const user = reading.user!;
    const close = (reading.objects ?? []).filter(
      (o) => o.kind === 'monster' && !o.dead && o.name.toLowerCase() === name && Math.max(Math.abs(o.x - user.x), Math.abs(o.y - user.y)) <= 2,
    );
    const nearlyDead = (o: (typeof close)[number]) => !!o.maxHp && o.hp !== null && o.hp !== undefined && (o.maxHp + o.hp) / o.maxHp < NEARLY_DEAD_SHARE;
    return close.length > 0 && !close.some(nearlyDead);
  }

  /** Hands a quest in at its NPC (Quests' steps) and says what it brought: the Forge Stones counted in the bag, and its rewards. */
  private async handIn(quest: TravelQuest): Promise<boolean> {
    const memory = this.bot.options.memory;
    const before = this.stones(memory.latest());
    await this.toNpcMap(quest.finish, `Handing in ${quest.name}`);
    const n = await this.bot.quests.atQuestNpc(quest.finish, 'handIn', `Handing in ${quest.name}`);
    if (!n) return false;
    // The bag is read once a second.
    let after = this.stones(memory.latest());
    for (const since = this.bot.clock.now(); this.bot.clock.now() - since < 3000 && before !== null && after === before; ) {
      await this.bot.sleep(300);
      after = this.stones(memory.latest());
    }
    const stones = before !== null && after !== null ? ` +${after - before} Forge Stones;` : '';
    const rewards = (quest.items ?? []).map(([item, amount]) => `${amount} ${item}`).join(', ');
    this.bot.status(`Handed in ${quest.name}:${stones} rewards ${rewards || 'experience'}`);
    return true;
  }

  /** Quest NPCs in Arcadia (both the circuit's are): Return to Arcadia first, from anywhere else. */
  private async toNpcMap(npcId: number, why: string): Promise<void> {
    const npc = loadTravelData().npcs.find((n) => n.id === npcId);
    const here = this.bot.options.memory.latest()?.map?.index;
    if (npc?.map === CIRCUIT.arcadia && here !== undefined && here !== CIRCUIT.arcadia) await this.bot.survival.returnToArcadia(why);
  }

  /** Forge Stones in the bag, when the reader counts them. */
  private stones(reading: MemoryState | null): number | null {
    return reading?.gear?.counts?.[FORGE_STONE] ?? null;
  }

  /** The window's Circuit card: each task's count, each spawn's next time, what was skipped, and the stones gained. */
  private show(plan: CircuitPlan, tasks: { monster: string; need: number; done: number }[], quest: string | null, reading: MemoryState, stonesAtStart: number | null, now: number): void {
    const stones = this.stones(reading);
    const view: CircuitView = {
      quest,
      tasks,
      stops: plan.stops.map((s) => ({ monster: s.spawn.monster, map: s.spawn.mapName, backIn: Math.max(0, Math.ceil((s.readyAt - now) / 60_000)) })),
      skipped: plan.skipped.map((s) => ({ monster: s.spawn.monster, map: s.spawn.mapName, why: s.why })),
      stones: stones !== null && stonesAtStart !== null ? stones - stonesAtStart : null,
    };
    this.bot.options.circuit?.(view);
  }
}

/** "Supply Hunt - Grade E", for the status line. */
function shortName(quest: TravelQuest): string {
  return quest.name.replace(/^Seasonal /, '');
}

function sum(tasks: { need: number; done: number }[], key: 'need' | 'done'): number {
  return tasks.reduce((total, t) => total + t[key], 0);
}

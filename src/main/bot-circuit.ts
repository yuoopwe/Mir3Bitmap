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
import { nearestApproach, walkDistances } from './map-path';
import { BotError, MEMORY_START_MS, Stopped, sameName } from './bot-shared';
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

/** The tracker that puts a spawn's kind (1 sub-boss, 2 boss, 3 behemoth) on the map's markers wherever they are. */
const TRACKERS = { 1: 'elite', 2: 'boss', 3: 'behemoth' } as const;
/** Arrived on a tracked boss's map: the markers are given this long to show them (the reader reads them once a second). */
const MARKERS_SETTLE_MS = 3000;
/**
 * With the tracker, no damage landing on what's wanted for this long while the map's markers show one alive: off to it
 * (out of sight, or in sight but walled off).
 */
const MARKED_ELSEWHERE_MS = 15_000;

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
    /** Marked bosses (object ids) found out of reach this run: not headed for again. */
    const outOfReach = new Set<number>();
    /** Quests the NPC didn't give, until when; hand-ins that didn't take. */
    const notOffered = new Map<number, number>();
    let handInFailures = 0;
    /** Forge Stones in the bag when the run started (once read). */
    let stonesAtStart: number | null = null;
    /** Spawns already said to be skipped (said once a run). */
    const said = new Set<string>();
    this.bot.elixirs.reset();

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
        await this.bot.quests.atQuestNpc(take.start, 'accept', `Taking ${take.name}`, take);
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
        const deadly = this.bot.guide.cantSurvive(summon.boss);
        if (bossLevel > user.level + band.levels || !where || deadly) {
          summonsGivenUp.add(summon.boss.toLowerCase());
          this.bot.status(`Skipping ${summon.boss}: ${!where ? 'nowhere to summon it' : deadly ?? `level ${bossLevel}: too strong for level ${user.level} yet`}`);
          continue;
        }
        const result = await this.summonAt(summon, where[0], settings.retreatHpPercent);
        if (result === 'danger') await this.bot.survival.retreat(`HP low fighting ${summon.boss}`);
        if (result === 'danger' || result === 'timeout' || result === 'unreachable') summonsGivenUp.add(summon.boss.toLowerCase());
        continue;
      }

      // 4. The circuit from here, as far above the level as the character's fights say is safe, without what the combat model says can't be survived.
      const plan = planCircuit(data, spawns, { map: map.index, level: user.level, cls: user.class, waypoints: unlocked, maxLevelsAbove: band.levels }, {
        now, routes, clearedAt, tooHard, need: farming ? undefined : need, cantSurvive: (s) => this.bot.guide.cantSurvive(s.monster),
      });
      this.bot.guide.update();
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
      const tripStart = this.bot.clock.now();
      const tripPaused = this.bot.pausedMs;
      const logTrip = () => this.bot.options.grindLog.addBossTime(user.name, { ms: this.bot.clock.now() - tripStart - (this.bot.pausedMs - tripPaused), at: Date.now() });
      // With the tracker for its kind (an item or a scroll), the map's markers say where they are: to the map, then
      // straight to a live one; none alive, on to the next ready elsewhere, or (nowhere else) waiting here for them.
      const tracked = this.tracks(stop.spawn.kind);
      try {
        if (stop.viaArcadia && map.index !== CIRCUIT.arcadia) await this.bot.survival.returnToArcadia(`On to ${stop.spawn.monster}`);
        if (memory.latest()?.user?.dead) continue;
        if (!tracked) this.bot.status(await this.bot.travel.travelTo(`spot:${stop.spawn.map}:${stop.spawn.x}:${stop.spawn.y}`));
        else {
          if (memory.latest()?.map?.index !== stop.spawn.map) this.bot.status(await this.bot.travel.travelTo(`map:${stop.spawn.map}`));
          const live = await this.marked(stop.spawn.map, stop.spawn.monster, outOfReach);
          if (live) {
            try {
              this.bot.status(await this.bot.travel.travelTo(`spot:${stop.spawn.map}:${live.x}:${live.y}`));
            } catch (error) {
              if (error instanceof Stopped || !(error instanceof BotError)) throw error;
              // That one can't be got to: the others the markers show (or the spawn) next time round.
              outOfReach.add(live.id);
              this.bot.status(`Couldn't get to the ${stop.spawn.monster} at ${live.x},${live.y} (${error.message}); trying another`);
              logTrip();
              continue;
            }
          } else if (plan.stops.some((s) => s.spawn.map !== stop.spawn.map && s.readyAt <= this.bot.clock.now())) {
            clearedAt.set(stop.spawn.key, this.bot.clock.now());
            this.bot.status(`No ${stop.spawn.monster} alive on ${stop.spawn.mapName} (the map's markers); on to the next`);
            logTrip();
            continue;
          } else this.bot.status(`No ${stop.spawn.monster} alive on ${stop.spawn.mapName} (the map's markers), and nowhere else to go: waiting here`);
        }
      } catch (error) {
        if (error instanceof Stopped || !(error instanceof BotError)) throw error;
        clearedAt.set(stop.spawn.key, this.bot.clock.now());
        this.bot.status(`Couldn't get to ${stop.spawn.monster} at ${stop.spawn.mapName} (${error.message}); planning again`);
        logTrip();
        continue;
      }

      // 6. Fight there (the time going to the stat guide's weighing of the circuit against Grind).
      const why = await this.fightAt(stop, farming ? null : need, settings.retreatHpPercent, progress);
      logTrip();
      if (why === 'empty') clearedAt.set(stop.spawn.key, this.bot.clock.now());
      if (why === 'marked') this.bot.status(`None about here; off to a ${stop.spawn.monster} the map's markers show`);
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

  /** Whether the character has the tracker (an item or a scroll) that puts this kind of spawn on the map's markers. */
  private tracks(kind: number): boolean {
    const trackers = this.bot.options.memory.latest()?.user?.trackers;
    const which = TRACKERS[kind as keyof typeof TRACKERS];
    return !!trackers && !!which && trackers[which] > 0;
  }

  /**
   * On `map`, the live `monster` the map's markers show nearest (to walk to, else as the crow flies), once they've had
   * a moment to come in; null when none is alive.
   */
  private async marked(map: number, monster: string, outOfReach: ReadonlySet<number> = new Set()): Promise<{ id: number; x: number; y: number } | null> {
    const memory = this.bot.options.memory;
    const name = monster.toLowerCase();
    const shown = () => (memory.latest()?.known ?? []).filter((k) => k.map === map && sameName(k.name, name) && !outOfReach.has(k.id));
    for (const since = this.bot.clock.now(); this.bot.clock.now() - since < MARKERS_SETTLE_MS && !shown().some((k) => !k.dead); ) await this.bot.sleep(300);
    const live = shown().filter((k) => !k.dead);
    const user = memory.latest()?.user;
    const grid = memory.map();
    if (!live.length || !user) return live[0] ?? null;
    const dist = grid?.index === map ? walkDistances(grid, { x: user.x, y: user.y }) : null;
    const cost = (k: { x: number; y: number }) => {
      const near = dist && grid ? nearestApproach(grid, dist, [k]) : null;
      return near ? near.steps : 1e6 + Math.max(Math.abs(k.x - user.x), Math.abs(k.y - user.y));
    };
    return live.reduce((best, k) => (cost(k) < cost(best) ? k : best));
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
    const tracked = this.tracks(spawn.kind);
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
        const seen = (reading?.objects ?? []).filter((o) => o.kind === 'monster' && sameName(o.name, name)).reduce((sum, o) => sum + (o.hp ?? 0), 0);
        if (seen !== damage) {
          damage = seen;
          progressAt = now;
        }
        // About, or (with the tracker for them) alive somewhere else on the map, as its markers show (walked to by the hunt's seeking).
        const about = (reading?.objects ?? []).some((o) => o.kind === 'monster' && !o.dead && sameName(o.name, name)) ||
          (tracked && (reading?.known ?? []).some((k) => k.map === spawn.map && !k.dead && sameName(k.name, name)));
        if (about) seenAt = Math.max(seenAt, now);
        // With the tracker: nothing landing on what's wanted here, but the markers show one alive on the map: off to it
        // (the circuit travels there, through the map's teleports if need be; the hunt's seeking only walks).
        const marked = tracked && (reading?.known ?? []).some((k) => k.map === spawn.map && !k.dead && sameName(k.name, name));
        if (marked && now - Math.max(progressAt, start) > MARKED_ELSEWHERE_MS) return 'marked';
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
      (o) => o.kind === 'monster' && !o.dead && sameName(o.name, name) && Math.max(Math.abs(o.x - user.x), Math.abs(o.y - user.y)) <= 2,
    );
    const nearlyDead = (o: (typeof close)[number]) => !!o.maxHp && o.hp !== null && o.hp !== undefined && (o.maxHp + o.hp) / o.maxHp < NEARLY_DEAD_SHARE;
    return close.length > 0 && !close.some(nearlyDead);
  }

  /** Hands a quest in at its NPC (Quests' steps) and says what it brought: the Forge Stones counted in the bag, and its rewards. */
  private async handIn(quest: TravelQuest): Promise<boolean> {
    const memory = this.bot.options.memory;
    const before = this.stones(memory.latest());
    await this.toNpcMap(quest.finish, `Handing in ${quest.name}`);
    const n = await this.bot.quests.atQuestNpc(quest.finish, 'handIn', `Handing in ${quest.name}`, quest);
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

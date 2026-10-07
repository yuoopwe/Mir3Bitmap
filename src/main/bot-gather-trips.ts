/**
 * Gathering trips: Gather as a way to level the gathering professions. Reads
 * the profession levels (opening the game's Professions window once if need
 * be), picks the best spot for them (gather-planner.ts), travels there and
 * gathers, walking from square to square of the spot when nothing is in
 * sight. A full bag is sold as Grind sells it; a new profession level, a while
 * at the spot, or the spot failing plans again.
 */
import type { Point } from '../shared/types';
import { nearestApproach, pathBack, walkDistances } from './map-path';
import type { MapGrid } from './map-grid';
import { loadTravelData, mapName, type GatherSpot } from './travel';
import { GATHER, PROFESSION, chooseGatherSpot, describeSpot, gatherNode, gatherableOn, levelOn, type GatherChoice, type GatherKind, type GatherLevels } from './gather-planner';
import type { MemoryState } from './game-memory';
import { VK } from './input';
import { BotError, MEMORY_START_MS, RUN_TICK_MS } from './bot-shared';
import type { BotContext } from './bot-context';

/** The Professions window: Ctrl+Shift+P opens and shuts it, and the game's windows list it by this name. */
const PROFESSIONS_KEYS = { modifiers: [VK.CONTROL, VK.SHIFT], vk: VK.P };

const PROFESSIONS_WINDOW = 'ProfessionsBox';

/** How long to wait for the levels once the window is open, and for it to shut. */
const PROFESSIONS_WAIT_MS = 3000;

const CLOSE_WAIT_MS = 1500;

/** This many picks in a row refused on nodes the level can't be the reason for means the tool is missing. */
const TOOL_FAILURES = 3;

/** A message box that talks of a tool: what the game might say when the tool is missing (its wording isn't known). */
const TOOL_WORDS = /tool|pick ?axe|dagger/i;

const TOOLS: Record<GatherKind, string> = { plant: 'Scavenging Dagger', ore: 'Pick Axe' };

const KIND_NAMES: Record<GatherKind, string> = { plant: 'plants', ore: 'ore' };

/** Walking to a square of the spot: this close is there (most of the square is then on screen). */
const ARRIVED_TILES = 3;

type Professions = NonNullable<MemoryState['professions']>;

export class GatherTrips {
  /** Picks refused in a row that the level can't explain, by kind. */
  private toolFailures: Record<GatherKind, number> = { plant: 0, ore: 0 };
  /** The next square to visit at each spot (by region), so planning again doesn't start the round over. */
  private readonly squares = new Map<number, number>();
  /** The square being walked to, the way there, where and when the character last moved, and when it last stepped this way. */
  private heading: { region: number; target: Point; path: Point[]; moved: { at: number; x: number; y: number }; tickAt: number } | null = null;

  constructor(private readonly bot: BotContext) {}

  /**
   * Gathers where the profession levels gather best: plans, travels there and
   * gathers until it's time to plan again (a new level, GATHER.replanMinutes
   * at the spot, or the spot failing), selling when the bag is full and coming
   * back to life after a death. Spots that failed are left out for a while.
   */
  async tripLoop(): Promise<string> {
    const data = loadTravelData();
    const memory = this.bot.options.memory;
    const started = this.bot.clock.now();
    /** Regions that failed lately, until when; nodes the game refused, with the level they needed there. */
    const failed = new Map<number, number>();
    const refused = new Map<number, number>();
    let current: number | undefined;
    this.toolFailures = { plant: 0, ore: 0 };

    while (true) {
      await this.bot.yieldToEvents();
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
      if (user.dead) {
        await this.bot.survival.reviveInArcadia();
        continue;
      }
      if (this.bot.survival.bagFull(reading)) {
        await this.bot.survival.emptyBag();
        continue;
      }
      const { levels, said } = this.levels(reading.professions ?? (await this.openProfessions()));
      const now = this.bot.clock.now();
      for (const [region, until] of failed) if (until <= now) failed.delete(region);

      const here = { x: user.x, y: user.y };
      const unlocked = reading.waypoints?.unlocked?.length ? new Set(reading.waypoints.unlocked.map((w) => w.name)) : undefined;
      const start = { map: map.index, steps: this.bot.travel.exitSteps(data, map, walkDistances(map, here)), at: here };
      const choice = chooseGatherSpot(data, start, { level: user.level, cls: user.class, waypoints: unlocked }, levels, { skip: new Set(failed.keys()), refused, current });
      if (!choice) throw new BotError(`Nowhere to gather for ${said} can be reached from ${mapName(data, map.index)}${failed.size ? ` (${failed.size} spots failed lately)` : ''}.`);
      current = choice.spot.region;
      const plan = `Gathering trip: ${said} · ${describeSpot(choice)} (${choice.reason})`;
      this.bot.status(plan);
      if (map.index !== choice.map) {
        try {
          this.bot.status(await this.bot.travel.travelTo(`map:${choice.map}`));
        } catch (error) {
          if (!(error instanceof BotError)) throw error;
          failed.set(choice.spot.region, this.bot.clock.now() + GATHER.failedMinutes * 60_000);
          this.bot.status(`Couldn't get to ${choice.name} (${error.message}); planning again`);
          continue;
        }
        this.bot.status(plan);
      }
      const result = await this.gatherAt(choice, levels, refused);
      if (result.failed) failed.set(choice.spot.region, this.bot.clock.now() + GATHER.failedMinutes * 60_000);
      this.bot.status(result.why);
    }
  }

  /**
   * Gathers at the spot (only nodes the planner says the levels allow) until
   * it's time to plan again: why, for the status line, and whether the spot
   * failed (nothing to find there, or the game refused a node there).
   */
  private async gatherAt(choice: GatherChoice, levels: GatherLevels, refused: Map<number, number>): Promise<{ why: string; failed: boolean }> {
    const data = loadTravelData();
    const spot = choice.spot;
    const allowed = gatherableOn(data, spot.map, levels, refused);
    // Time at the spot, time paused left out.
    const started = this.bot.clock.now();
    const pausedBefore = this.bot.pausedMs;
    const elapsed = () => this.bot.clock.now() - started - (this.bot.pausedMs - pausedBefore);
    let seenAt = 0;
    let failed = false;
    const why = await this.bot.gathering.gatherHere({
      canPick: (o) => o.node !== undefined && allowed.has(o.node),
      fight: true,
      picked: (o) => {
        const node = o.node === undefined ? undefined : gatherNode(data, o.node);
        if (node) this.toolFailures[node.kind] = 0;
      },
      stopWhen: (reading) => {
        if (reading.user?.dead) return 'Died';
        if (this.bot.survival.bagFull(reading)) return 'Bag full';
        if (reading.map && reading.map.index !== spot.map) return `Left ${choice.name}: planning again`;
        const raised = this.raised(reading.professions, levels);
        if (raised) return `${raised}: planning again`;
        const t = elapsed();
        if ((reading.objects ?? []).some((o) => o.kind === 'node' && !o.harvested && o.node !== undefined && allowed.has(o.node))) seenAt = t;
        if (t - seenAt >= GATHER.nothingFoundMinutes * 60_000) {
          failed = true;
          return `Nothing to gather at ${choice.name} for ${GATHER.nothingFoundMinutes} minutes: trying elsewhere`;
        }
        return t >= GATHER.replanMinutes * 60_000 ? `${GATHER.replanMinutes} minutes at ${choice.name}: planning again` : null;
      },
      idle: () => this.walkOn(spot, choice.name),
      refused: (o, reading) => {
        const node = o.node === undefined ? undefined : gatherNode(data, o.node);
        if (!node) return null;
        const needed = levelOn(data, spot.map, node.id) ?? node.level;
        const toolSaid = reading.survival?.messages?.some((m) => TOOL_WORDS.test(m.text));
        if (!toolSaid && needed > node.level) {
          // Only the region's own level said it could be gathered here: that guess was wrong (see neededLevel).
          refused.set(node.id, Math.min(refused.get(node.id) ?? Infinity, needed));
          failed = true;
          return `The ${o.name} won't gather at ${choice.name} (it needs more than level ${levels[node.kind]} here?): trying elsewhere`;
        }
        // The level allows it for sure: the tool, most likely.
        if (++this.toolFailures[node.kind] >= TOOL_FAILURES) {
          throw new BotError(`Picking ${KIND_NAMES[node.kind]} keeps failing on nodes your level allows: put a ${TOOLS[node.kind]} in your Toolbelt.`);
        }
        this.bot.status(`The ${o.name} won't gather (the wrong tool?); trying another`);
        return null;
      },
    });
    return { why, failed };
  }

  /**
   * Nothing in sight: a step of the walk to the spot's next square (busiest
   * first, round and round), mounted where allowed. A step at a time, so
   * nodes coming into view on the way are gathered straight away. Squares that
   * can't be walked to from here are passed over, and one is given up when
   * blocked on the way (after fighting what's there, with "Fight monsters in the way").
   */
  private async walkOn(spot: GatherSpot, name: string): Promise<void> {
    const memory = this.bot.options.memory;
    const map = memory.map();
    const user = memory.latest()?.user;
    if (!map || !user || map.index !== spot.map) {
      await this.bot.sleep(300);
      return;
    }
    const here = { x: user.x, y: user.y };
    const now = this.bot.clock.now();
    let heading = this.heading?.region === spot.region && Math.max(Math.abs(here.x - this.heading.target.x), Math.abs(here.y - this.heading.target.y)) > ARRIVED_TILES ? this.heading : null;
    if (heading) {
      // Back to walking after gathering (or anything else): the time stood still doesn't count as blocked.
      if (now - heading.tickAt > RUN_TICK_MS * 4 || here.x !== heading.moved.x || here.y !== heading.moved.y) heading.moved = { at: now, x: here.x, y: here.y };
      else if (now - heading.moved.at > this.bot.moves.blockedAfterMs() + RUN_TICK_MS * 2) {
        const reading = memory.latest();
        if (reading && (await this.bot.hunting.fightIfBlocked(reading, here, true))) {
          heading.moved.at = this.bot.clock.now();
          return;
        }
        heading = null;
      }
    }
    // Keep to the path while on it; off it (gathering on the way, say), a new one to the same square.
    const distances = () => walkDistances(map, here, this.bot.travel.exitsToAvoid(map, here));
    if (heading) {
      const on = heading.path.findIndex((t) => t.x === here.x && t.y === here.y);
      const path = on >= 0 && heading.path.length - on >= 2 ? heading.path.slice(on) : this.pathTo(map, distances(), heading.target);
      heading = path ? { ...heading, path } : null;
    }
    heading ??= this.nextSquare(spot, map, distances(), here, now);
    this.heading = heading;
    if (!heading) {
      this.bot.statusEvery(`Nothing to gather in sight at ${name}, and no other patch to walk to`);
      await this.bot.sleep(1000);
      return;
    }
    await this.bot.moves.driveAlong(here, heading.path, now);
    heading.tickAt = this.bot.clock.now();
    this.bot.statusEvery(`Nothing to gather in sight: heading for another patch of ${name} (${heading.target.x},${heading.target.y})`);
    await this.bot.sleep(RUN_TICK_MS);
  }

  /** The next square of the spot that can be walked to from where `dist` was worked out, and the way there; null if none (or all are here). */
  private nextSquare(spot: GatherSpot, map: MapGrid, dist: Int32Array, here: Point, now: number): GatherTrips['heading'] {
    for (let tries = 0; tries < spot.at.length; tries++) {
      const visit = this.squares.get(spot.region) ?? 0;
      this.squares.set(spot.region, visit + 1);
      const [x, y] = spot.at[visit % spot.at.length];
      const path = this.pathTo(map, dist, { x, y });
      if (path) return { region: spot.region, target: { x, y }, path, moved: { at: now, x: here.x, y: here.y }, tickAt: now };
    }
    return null;
  }

  /** The way to a square (to the nearest tile that can be walked to), or null if there's none or it's already close. */
  private pathTo(map: MapGrid, dist: Int32Array, target: Point): Point[] | null {
    const near = nearestApproach(map, dist, [target]);
    return near && near.steps > ARRIVED_TILES ? pathBack(map, dist, near.tile) : null;
  }

  /**
   * The levels to plan for (the kinds ticked, of professions earning
   * experience), and how to say them: "Plants 23, ore 5 (not gaining: ...)".
   */
  private levels(professions: Professions): { levels: GatherLevels; said: string } {
    const levels: GatherLevels = {};
    const parts: string[] = [];
    for (const kind of ['plant', 'ore'] as const) {
      if (!(kind === 'plant' ? this.bot.settings.gatherPlants : this.bot.settings.gatherOre)) continue;
      const profession = professions.find((p) => p.id === PROFESSION[kind]);
      if (!profession) parts.push(`${KIND_NAMES[kind]} unknown`);
      else if (!profession.canGain) parts.push(`${KIND_NAMES[kind]} ${profession.usable} (not gaining: ${profession.lockReason ?? 'locked'})`);
      else {
        levels[kind] = profession.usable;
        parts.push(`${KIND_NAMES[kind]} ${profession.usable}`);
      }
    }
    const said = parts.join(', ').replace(/^./, (c) => c.toUpperCase());
    if (levels.plant === undefined && levels.ore === undefined) throw new BotError(`Nothing to gather for: ${said}.`);
    return { levels, said };
  }

  /** A profession planned for that has gone up a level since: "Mining level 30", or null. */
  private raised(professions: MemoryState['professions'], levels: GatherLevels): string | null {
    for (const kind of ['plant', 'ore'] as const) {
      const now = professions?.find((p) => p.id === PROFESSION[kind]);
      const was = levels[kind];
      if (now && was !== undefined && now.usable > was) return `${now.name} level ${now.usable}`;
    }
    return null;
  }

  /**
   * The profession levels: the game only loads them once its Professions
   * window has been opened, so it's opened (Ctrl+Shift+P) until they show, and
   * shut again (checked in the game's windows: left open, it catches clicks).
   */
  private async openProfessions(): Promise<Professions> {
    const memory = this.bot.options.memory;
    const shown = () => {
      const windows = memory.latest()?.windows;
      return windows ? windows.some((w) => w.name === PROFESSIONS_WINDOW) : null;
    };
    const waitFor = async (ok: () => boolean, ms: number) => {
      for (const since = this.bot.clock.now(); this.bot.clock.now() - since < ms && !ok(); ) await this.bot.sleep(200);
      return ok();
    };
    const press = () => this.bot.input.keyChord(this.bot.hwnd, PROFESSIONS_KEYS.modifiers, PROFESSIONS_KEYS.vk);
    this.bot.stopRunning();
    this.bot.status('Reading the profession levels: opening the Professions window (Ctrl+Shift+P)');
    press();
    const loaded = await waitFor(() => !!memory.latest()?.professions, PROFESSIONS_WAIT_MS);
    const professions = memory.latest()?.professions;
    // Shut it again: the same keys, else Escape.
    if (shown() ?? loaded) {
      press();
      if (!(await waitFor(() => shown() !== true, CLOSE_WAIT_MS))) {
        this.bot.key(VK.ESCAPE);
        if (!(await waitFor(() => shown() !== true, CLOSE_WAIT_MS))) throw new BotError("The Professions window won't shut (Ctrl+Shift+P, Escape).");
      }
    }
    if (!professions) throw new BotError("Couldn't read the profession levels: open the Professions window (Ctrl+Shift+P) once in game, then start again.");
    return professions;
  }
}

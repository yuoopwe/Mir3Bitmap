/** Hunting: the hunt loop, its targets (from memory or the screen), seeking monsters when idle, and fighting what's in the way. */

import type { Point } from '../shared/types';
import { findLabels } from './labels';
import { HUD_MASKS, PANEL_MASKS, TARGET_HP_BAR, TARGET_HP_TEXT } from './layout';
import { nearestMonster, readMinimap } from './minimap';
import { MapExplorer } from './map-explorer';
import { nearestApproach, pathBack, walkDistances } from './map-path';
import { loadTravelData, mapName } from './travel';
import type { MapGrid } from './map-grid';
import { LabelTracker, isFloating, type Sighting } from './sightings';
import type { MemoryObject, MemoryState } from './game-memory';
import { FightTimer } from './grind-log';
import { readBar, signatureDifference, targetHpFill, viewSignature } from './vision';
import { AIM_SPOTS, FLOOR_CLICKS, FLOOR_CLICK_GAP_MS, type HuntTarget, ITEM_CLICK_EVERY_MS, LOOT_GIVE_UP_MS, LOOT_SKIP_MS, LOOT_WALK_GIVE_UP_MS, ROAM_DIRECTIONS, ROAM_DISTANCE, RUN_TICK_MS, STEER_ROUND_TILES, hostile, wholeSecondsSince } from './bot-shared';
import type { BotContext } from './bot-context';

const SELL_CHECK_INTERVAL_SECONDS = 10;

/** Travelling and exploring with "Fight monsters in the way": monsters this close when blocked (or two right next to you) get fought. */
const FIGHT_RANGE_TILES = 2;

/** Monsters more than this many levels below the player don't count as crowding round (they're still fought if they block the way). */
const THREAT_LEVELS = 10;

/** Give up on one monster after this long (out of reach, say), and on fighting altogether after this long. */
const FIGHT_TARGET_GIVE_UP_MS = 15_000;

const FIGHT_GIVE_UP_MS = 60_000;

/** Seeking (Hunt with "Seek when idle"): give up on a goal after this long; a spawn spot visited is left this long. */
const SEEK_GIVE_UP_MS = 45_000;

const SPOT_REVISIT_MS = 5 * 60_000;

/** A spawn spot counts as visited this close. */
const SPOT_REACH_TILES = 4;

const FLOOR_CLICK_EVERY_MS = 1000;

const KILL_FLOOR_CLICKS = 3;

/**
 * Items beyond the pick-up radius are walked towards between monsters if they're
 * at most this many tiles further out (any distance, with no monsters about).
 */
const LOOT_DETOUR_TILES = 6;

/** Clicking one target this long without it going means it can't be reached (or isn't a monster): skip it for a while. */
const TARGET_GIVE_UP_MS = 20_000;

const TARGET_SKIP_MS = 30_000;

/**
 * A target that stays more than a tile or two away while neither it nor the player gets any closer for this
 * long can't be reached (round a wall, say): it's left alone for TARGET_UNREACHABLE_SKIP_MS.
 */
const TARGET_NO_PROGRESS_MS = 6000;

const TARGET_UNREACHABLE_SKIP_MS = 2 * 60_000;

/** Walking distances for choosing targets are worked out again this often (or when the player moves). */
const HUNT_DIST_MS = 1000;

/** Wander this many steps after running into something on the way to a minimap monster. */
const DETOUR_STEPS = 4;

/** Below this, the view didn't scroll after a roam step: we're blocked. */
const MOVED_THRESHOLD = 4;

/** Something to attack: where to click, and a key to recognise it by from one look to the next. */
interface LootTarget {
  key: string;
  /** Tiles from the character (the larger of across and down). */
  distance: number;
  /** The middle of its tile on screen. */
  point: Point;
  /** Its map tile. */
  at: Point;
}

/** Looks at a monster without finding it under the mouse before leaving it for a moment. */
const AIM_MISSES = 4;

const AIM_MISS_SKIP_MS = 8000;

let bossNames: Set<string> | null = null;

/** Bosses (by name, from the game data): their kills aren't timed for Grind. */
function isBoss(name: string): boolean {
  if (!bossNames) {
    const data = loadTravelData();
    bossNames = new Set((data.monsters ?? []).filter((_, i) => data.monsterStats?.[i]?.[3]).map((n) => n.toLowerCase()));
  }
  return bossNames.has(name.toLowerCase());
}

/** The game id of a target from the game's memory ("m123"), else null. */
const memoryId = (key: string | undefined): number | null => (key?.startsWith('m') ? Number(key.slice(1)) : null);

export class Hunting {
  /** Monster names seen in the game's memory this session. */
  private readonly monstersSeen = new Set<string>();
  readonly sightings = new LabelTracker();
  private roamDirection = Math.floor(Math.random() * ROAM_DIRECTIONS.length);
  private roamStepsLeft = 0;
  private detourStepsLeft = 0;
  private minimapSelf: Point | null = null;
  /** Quests mode hunting: only quest monsters, whatever the Hunt setting. */
  private forceQuestOnly = false;
  /** Boss circuit hunting: only these monsters (lower-case names), and no wandering off to look for them. */
  private onlyNames: Set<string> | null = null;
  /** Seeking from memory: where it's heading (a monster the game knows of, or a spawn spot), and the spots seen lately. */
  private seek: { kind: 'monster' | 'spot'; key: string; label: string; target: Point; map: number; since: number; path: Point[] | null; moved: { at: number; x: number; y: number } } | null = null;
  private readonly visitedSpots = new Map<string, number>();
  private readonly seekExplorer = new MapExplorer();
  /** Walking distances from the player, for telling which monsters can be reached. */
  private huntDist: { map: number; x: number; y: number; at: number; dist: Int32Array } | null = null;

  constructor(private readonly bot: BotContext) {}

  /**
   * Hunts the simple way: click the nearest monster name until it's gone, then
   * the next nearest. Every couple of seconds, click the ground at the
   * character's feet to pick up loot. A target that takes too long (out of
   * reach, or not really a monster) is skipped for a while.
   *
   * Grind's options: `seek` overrides "Seek when idle"; once `stopWhen` gives a
   * reason, the fight going on is finished and the reason returned; once
   * `breakOff` gives one, it's returned straight away, mid-fight (to get away).
   * `only`: just these monsters (by name), sought only where the game knows of them.
   */
  async huntLoop(options: { seek?: boolean; stopWhen?: () => string | null; breakOff?: () => string | null; questOnly?: boolean; only?: string[] } = {}): Promise<string> {
    if (options.only) {
      this.onlyNames = new Set(options.only.map((n) => n.toLowerCase()));
      try {
        return await this.huntLoop({ ...options, only: undefined });
      } finally {
        this.onlyNames = null;
      }
    }
    if (options.questOnly) {
      this.forceQuestOnly = true;
      try {
        return await this.huntLoop({ ...options, questOnly: false });
      } finally {
        this.forceQuestOnly = false;
      }
    }
    let lastSellCheck = this.bot.clock.now();
    let current: { key: string; since: number } | null = null;
    let misses = 0;
    const skipped = new Map<string, number>();
    let nextFloorAt = 0;
    let walkingTo: { key: string; since: number } | null = null;
    /** Items within reach, and when each was first seen there. */
    const inReachSince = new Map<string, number>();
    let nextItemClickAt = 0;
    /** The current target's distance and the player's tile, and since when they've stayed the same. */
    let approach: { state: string; since: number } | null = null;
    let stopping: string | null = null;
    /** Each fight timed, for Grind's measurements (kept in the grind log, by character). */
    const fights = new FightTimer(isBoss);
    this.huntDist = null;
    this.seek = null;
    this.visitedSpots.clear();
    this.seekExplorer.reset();
    let paused = this.bot.pausedMs;
    this.bot.options.memory.start();

    while (true) {
      await this.bot.yieldToEvents();
      // Time paused doesn't count towards giving up on a target, an item in reach or a walk to one.
      const pause = this.bot.pausedMs - paused;
      paused = this.bot.pausedMs;
      if (pause > 0) {
        if (current) current.since += pause;
        if (walkingTo) walkingTo.since += pause;
        for (const [key, since] of inReachSince) inReachSince.set(key, since + pause);
      }
      this.bot.capture();

      const start = this.bot.clock.now();
      const targetHp = readBar(this.bot.frame, TARGET_HP_BAR, targetHpFill, TARGET_HP_TEXT);
      // The target frame only hides names while it's showing.
      const labels = findLabels(this.bot.frame, targetHp === null ? PANEL_MASKS : HUD_MASKS);
      this.bot.readVitals();
      this.bot.scanMs = this.bot.clock.now() - start;
      const now = this.bot.clock.now();
      const sightings = this.sightings.update(labels, now);
      this.bot.drinkPotions();

      for (const [key, until] of skipped) if (until <= now) skipped.delete(key);
      const memory = this.bot.options.memory.latest();
      // In a game of another size the screen can't be read: wait for the memory rather than go by the screen.
      if (!memory && !this.bot.screenReadable) {
        this.bot.stopRunning();
        this.bot.releaseHold();
        this.bot.statusEvery(`Waiting for the game's memory (${this.bot.options.memory.problem}; the screen is only read at 1600x900)`);
        await this.bot.sleep(300);
        continue;
      }
      if (memory) {
        const { kills, death } = fights.update(memory, now, memoryId(current?.key));
        const name = memory.user?.name ?? '';
        for (const kill of kills) this.bot.options.grindLog.addKill(name, kill);
        if (death) this.bot.options.grindLog.addDeath(name, death);
      }
      const candidates = memory ? this.memoryTargets(memory) : this.screenTargets(sightings, now);
      const live = candidates.filter((c) => !skipped.has(c.key));
      let target: HuntTarget | undefined = current ? live.find((c) => c.key === current!.key) : undefined;
      if (current && !target) {
        // Gone: dead (or, on screen, out of sight). Pick up what it dropped if it died close by.
        // Not a kill if the other source picked it (the memory reading came or went: the keys differ),
        // or if the memory still has it alive (gone under the HUD, say).
        const key = current.key;
        const killed = key.startsWith(memory ? 'm' : 's') && !memory?.objects?.some((o) => `m${o.id}` === key && !o.dead);
        current = null;
        if (killed) {
          this.bot.kills++;
          this.bot.stats.count('kills');
        }
        if (killed && this.bot.settings.hunt.loot && !memory) {
          // Without the memory there's no telling what was picked up: count the try.
          this.bot.stats.count('items');
          this.bot.releaseHold();
          await this.bot.clickFloor(KILL_FLOOR_CLICKS, FLOOR_CLICK_GAP_MS);
          nextFloorAt = this.bot.clock.now() + FLOOR_CLICK_EVERY_MS;
        }
      }
      // Time to stop: straight away to break off, else once no fight is going on.
      const breaking = options.breakOff?.();
      if (breaking) {
        this.bot.stopRunning();
        this.bot.releaseHold();
        return breaking;
      }
      stopping ??= options.stopWhen?.() ?? null;
      if (stopping && !current) {
        this.bot.stopRunning();
        this.bot.releaseHold();
        return stopping;
      }

      if (memory && this.bot.settings.hunt.loot) {
        const reach = memory.user!.pickUpRadius ?? 0;
        const items = this.groundItems(memory, skipped);
        // Items within reach: click the feet straight away (between attacks), giving up on any that stay put.
        const inReach = items.filter((i) => i.distance <= reach);
        for (const [key, since] of inReachSince) {
          if (!inReach.some((i) => i.key === key)) {
            // Gone from the ground (not just out of reach) without being given up on: picked up, most likely.
            if (!items.some((i) => i.key === key)) {
              this.bot.stats.count('items');
              this.bot.survival.lootRefused = 0;
            }
            inReachSince.delete(key);
          } else if (now - since > LOOT_GIVE_UP_MS) {
            skipped.set(key, now + LOOT_SKIP_MS);
            inReachSince.delete(key);
            this.bot.survival.lootGivenUp(inReach.find((i) => i.key === key)!.distance);
          }
        }
        for (const i of inReach) if (!skipped.has(i.key) && !inReachSince.has(i.key)) inReachSince.set(i.key, now);
        if (inReachSince.size > 0 && now >= nextItemClickAt) {
          this.bot.releaseHold();
          this.bot.stopRunning();
          await this.bot.clickFloor(FLOOR_CLICKS, FLOOR_CLICK_GAP_MS);
          nextItemClickAt = this.bot.clock.now() + ITEM_CLICK_EVERY_MS;
          this.bot.statusEvery(`Picking up ${inReachSince.size} item${inReachSince.size === 1 ? '' : 's'}`);
        }
        // Between monsters (or with none about), walk towards the nearest item out of reach.
        const far = items
          .filter((i) => i.distance > reach && this.bot.clickable(i.point) && (live.length === 0 || i.distance <= reach + LOOT_DETOUR_TILES))
          .sort((a, b) => a.distance - b.distance);
        const walk = !target && inReachSince.size === 0 ? (far.find((i) => i.key === walkingTo?.key) ?? far[0]) : undefined;
        if (walk) {
          const since: number = walkingTo && walkingTo.key === walk.key ? walkingTo.since : now;
          walkingTo = { key: walk.key, since };
          if (now - since > LOOT_WALK_GIVE_UP_MS) {
            skipped.set(walk.key, now + LOOT_SKIP_MS);
            walkingTo = null;
            continue;
          }
          this.bot.releaseHold();
          this.bot.stopRunning();
          await this.bot.click(walk.point, this.bot.delay('pickUpClick'));
          await this.bot.sleep(this.bot.delay('runStep'));
          this.bot.statusEvery(`Walking to an item ${walk.distance} tiles away`);
          continue;
        }
        walkingTo = null;
      }
      // Neither the player nor the target getting any closer for a while, with it still out of reach: walled off.
      if (target?.at && memory?.user) {
        const gap = Math.max(Math.abs(target.at.x - memory.user.x), Math.abs(target.at.y - memory.user.y));
        const state = `${target.key} ${memory.user.x},${memory.user.y} ${gap}`;
        if (!approach || approach.state !== state) approach = { state, since: now };
        else if (gap > 2 && now - approach.since > TARGET_NO_PROGRESS_MS) {
          skipped.set(target.key, now + TARGET_UNREACHABLE_SKIP_MS);
          this.bot.status(`Can't get at ${target.name ?? 'that one'}; trying another`);
          target = undefined;
          current = null;
          approach = null;
        }
      }
      if (target && now - current!.since > TARGET_GIVE_UP_MS) {
        skipped.set(target.key, now + TARGET_SKIP_MS);
        this.bot.status('Taking too long on that one; trying another');
        target = undefined;
        current = null;
      }
      if (!target) {
        // Nearest to walk to, where the game's memory says; else nearest on screen.
        const player = this.bot.player();
        const distance = (c: HuntTarget) => (c.steps !== undefined ? c.steps * 48 : Math.hypot(c.point.x - player.x, c.point.y - player.y));
        target = live.reduce<HuntTarget | undefined>((best, c) => (!best || distance(c) < distance(best) ? c : best), undefined);
        if (target) {
          current = { key: target.key, since: now };
          misses = 0;
        }
      }

      let point = this.bot.holding && this.bot.holding.id === target?.key ? this.bot.holding.point : target?.point;
      // (An archer already holding the button on this target keeps holding.)
      if (target?.tile && target.name && this.bot.holding?.id !== target.key) {
        // Only click where the game confirms the monster is under the mouse: a miss is a "walk here".
        point = (await this.bot.aimAt(target)) ?? undefined;
        if (!point && ++misses >= AIM_MISSES) {
          skipped.set(target.key, now + AIM_MISS_SKIP_MS);
          current = null;
        }
        if (point) misses = 0;
      }
      if (target && point) {
        this.bot.stopRunning();
        if (memory) await this.bot.moves.setMounted(false);
        const id = memoryId(target.key);
        if (memory && id !== null) fights.attacked(id, memory, this.bot.clock.now());
        if (this.bot.settings.archer) {
          this.bot.hold(point, target.key);
          await this.bot.sleep(this.bot.delay('attackClick'));
        } else {
          await this.bot.click(point, this.bot.delay('attackClick'));
        }
        await this.bot.pressKeys(true);
        this.bot.statusEvery(`Attacking ${target.name ?? ''} (${memory ? 'game memory' : 'screen'})`);
      } else if (target) {
        this.bot.stopRunning();
        this.bot.statusEvery(`Lining up on ${target.name ?? 'a monster'}`);
      } else {
        this.bot.releaseHold();
        await this.bot.pressKeys(false);
        // With the game's memory: head for monsters it knows of, then where they spawn; else the minimap, or wander.
        // (Seeking from memory moves and reports for itself.)
        const seek = options.seek ?? this.bot.settings.hunt.roam;
        if (seek && memory && (await this.seekFromMemory(memory, skipped))) {
          // Heading somewhere.
        } else if (seek && this.bot.screenReadable && !this.onlyNames) await this.seekOrRoam();
        else {
          await this.bot.sleep(150);
          this.bot.statusEvery(`Waiting for monsters (${memory ? 'game memory' : `screen: ${this.bot.options.memory.problem}`})`);
        }
      }

      // Without the game's memory to say where items are, click the ground at the feet now and then.
      if (this.bot.settings.hunt.loot && !memory && this.bot.clock.now() >= nextFloorAt) {
        this.bot.releaseHold();
        await this.bot.clickFloor(FLOOR_CLICKS, FLOOR_CLICK_GAP_MS);
        nextFloorAt = this.bot.clock.now() + FLOOR_CLICK_EVERY_MS;
      }

      // Selling. Grind and Quests (which pass stopWhen) sell their own way when the bag fills; Hunt with the
      // memory reader does the same (Arcadia, Ludvik, back); only Hunt without it uses the old screen routine.
      if (this.bot.settings.sellItems && !options.stopWhen) {
        if (memory) {
          if (!current && this.bot.survival.bagFull(memory)) {
            this.bot.releaseHold();
            await this.bot.survival.emptyBag();
            this.bot.status('Hunting');
          }
        } else if (wholeSecondsSince(lastSellCheck, this.bot.clock.now()) > SELL_CHECK_INTERVAL_SECONDS) {
          lastSellCheck = this.bot.clock.now();
          this.bot.releaseHold();
          await this.bot.survival.sellItems();
          this.bot.status('Hunting');
        }
      }
    }
  }

  /** Items on the ground from the game's memory (not skipped), with their distance in tiles and where they are on screen. */
  groundItems(memory: MemoryState, skipped: Map<string, number>): LootTarget[] {
    const user = memory.user!;
    const items: LootTarget[] = [];
    for (const o of memory.objects ?? []) {
      if (o.kind !== 'item' || skipped.has(`i${o.id}`)) continue;
      const point = this.bot.toScreen(user, o.x, o.y);
      items.push({ key: `i${o.id}`, distance: Math.max(Math.abs(o.x - user.x), Math.abs(o.y - user.y)), point, at: { x: o.x, y: o.y } });
    }
    return items;
  }

  /** Monsters from the game's memory: alive, not anyone's pet, not set to be skipped, and on screen clear of the HUD. */
  private memoryTargets(memory: MemoryState): HuntTarget[] {
    const user = memory.user!;
    // Walking distances from here (worked out again when the player moves, or every so often).
    const map = this.bot.options.memory.map();
    const now = this.bot.clock.now();
    if (map && (!this.huntDist || this.huntDist.map !== map.index || this.huntDist.x !== user.x || this.huntDist.y !== user.y || now - this.huntDist.at > HUNT_DIST_MS)) {
      this.huntDist = { map: map.index, x: user.x, y: user.y, at: now, dist: walkDistances(map, { x: user.x, y: user.y }, this.bot.travel.exitsToAvoid(map, { x: user.x, y: user.y })) };
    }
    const dist = map && this.huntDist?.map === map.index ? this.huntDist.dist : null;
    const skip = new Set((this.bot.settings.skipMonsters ?? []).map((n) => n.toLowerCase()));
    const wanted = this.questWanted(memory);
    const seen = new Set<string>();
    const targets: HuntTarget[] = [];
    for (const o of memory.objects ?? []) {
      if (o.kind !== 'monster' || o.pet || !o.name || !hostile(o)) continue;
      seen.add(o.name);
      if (o.dead || skip.has(o.name.toLowerCase())) continue;
      if (wanted && !wanted.has(o.name.toLowerCase())) continue;
      const tile = this.bot.toScreen(user, o.x, o.y);
      const point = { x: tile.x + AIM_SPOTS[0][0], y: tile.y + AIM_SPOTS[0][1] };
      if (!this.bot.clickable(point)) continue;
      // Walled off (no way to walk next to it): no use attacking.
      let steps: number | undefined;
      if (dist && map) {
        const near = nearestApproach(map, dist, [{ x: o.x, y: o.y }]);
        if (!near) continue;
        steps = near.steps;
      }
      targets.push({ key: `m${o.id}`, point, name: o.name, tile, at: { x: o.x, y: o.y }, steps });
    }
    this.reportMonsters(seen);
    return targets;
  }

  /** Overhead names from the screen: not floating combat text, not set to "Never attack". */
  private screenTargets(sightings: Sighting[], now: number): HuntTarget[] {
    return sightings
      .filter((s) => !isFloating(s, now) && this.bot.options.names.judgeLabel(s.label).kind !== 'harmless')
      // Aim at the name's own part if it has run into another name.
      .map((s) => ({ key: `s${s.id}`, point: this.bot.options.names.judgeLabel(s.label).label.centre }));
  }

  /** Tells the window which monsters have been seen (for choosing which to skip), when the list grows. */
  private reportMonsters(seen: Set<string>): void {
    let grew = false;
    for (const name of seen) {
      if (this.monstersSeen.has(name)) continue;
      this.monstersSeen.add(name);
      grew = true;
    }
    if (grew) this.bot.options.monsters?.([...this.monstersSeen].sort());
  }

  /**
   * With "Quest monsters only": the names (lower case) of the monsters an
   * unfinished quest task still needs on this map; null when the setting is off
   * or the quest log can't be read (then everything counts).
   */
  private questWanted(reading: MemoryState): Set<string> | null {
    if (this.onlyNames) return this.onlyNames;
    if (!(this.bot.settings.hunt.questOnly || this.forceQuestOnly) || !reading.questTargets) return null;
    const mapIndex = reading.map?.index;
    return new Set(reading.questTargets.filter((t) => t.map === null || t.map === mapIndex).map((t) => t.name.toLowerCase()));
  }

  /** What the quest log wants elsewhere, for the status line ("Skeleton on Bichon Cave Lv 3"). */
  private questElsewhere(reading: MemoryState): string {
    const targets = reading.questTargets ?? [];
    if (!targets.length) return 'Quest monsters only: no unfinished quest needs monsters killed';
    const data = loadTravelData();
    const list = targets.slice(0, 3).map((t) => (t.map === null ? t.name : `${t.name} on ${mapName(data, t.map)}`));
    return `Quest monsters only: none here (the quests want ${list.join(', ')}${targets.length > 3 ? '...' : ''})`;
  }

  /**
   * Hunting with nothing to fight, from the game's memory: walks (a real path
   * round the walls) to the nearest monster the game knows of, even off screen;
   * failing that, to the spot where the most monsters spawn for the walk
   * (from the game's spawn data) that hasn't been visited lately; failing
   * that, to unexplored ground. False when there's nothing to go on.
   */
  private async seekFromMemory(reading: MemoryState, skipped: ReadonlyMap<string, number>): Promise<boolean> {
    const map = this.bot.options.memory.map();
    const user = reading.user;
    if (!map || !user) return false;
    const here = { x: user.x, y: user.y };
    const now = this.bot.clock.now();
    const away = (a: Point, b: Point) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    const skip = new Set((this.bot.settings.skipMonsters ?? []).map((n) => n.toLowerCase()));
    for (const [key, until] of this.visitedSpots) if (until <= now) this.visitedSpots.delete(key);

    let goal = this.seek && this.seek.map === map.index ? this.seek : null;
    // A monster the game knows of comes first: one that can be walked to, and isn't being left alone.
    const dist = walkDistances(map, here, this.bot.travel.exitsToAvoid(map, here));
    const wanted = this.questWanted(reading);
    if (wanted?.size === 0) {
      // Quest monsters only, and none wanted on this map: say where they are.
      this.bot.stopRunning();
      this.bot.statusEvery(this.questElsewhere(reading));
      await this.bot.sleep(500);
      return true;
    }
    const monsters = (reading.objects ?? []).filter(
      (o) =>
        o.kind === 'monster' && !o.pet && !o.dead && hostile(o) && o.name && !skip.has(o.name.toLowerCase()) && (!wanted || wanted.has(o.name.toLowerCase())) &&
        !skipped.has(`m${o.id}`) && nearestApproach(map, dist, [{ x: o.x, y: o.y }]),
    );
    const chased = goal?.kind === 'monster' ? monsters.find((m) => `m${m.id}` === goal!.key) : undefined;
    if (chased) goal!.target = { x: chased.x, y: chased.y };
    else if (monsters.length) {
      const m = monsters.reduce((best, o) => (away(o, here) < away(best, here) ? o : best));
      goal = { kind: 'monster', key: `m${m.id}`, label: m.name, target: { x: m.x, y: m.y }, map: map.index, since: now, path: null, moved: { at: now, x: NaN, y: NaN } };
    }
    // Reached, or taking too long: on to the next.
    if (goal && (away(here, goal.target) <= (goal.kind === 'spot' ? SPOT_REACH_TILES : 1) || now - goal.since > SEEK_GIVE_UP_MS)) {
      if (goal.kind === 'spot') this.visitedSpots.set(goal.key, now + SPOT_REVISIT_MS);
      goal = null;
    }
    // Only certain monsters (the Boss circuit, at their spawn): none known of, nowhere else to look.
    if (!goal && this.onlyNames) return false;
    if (!goal) goal = this.pickSpawnSpot(map, here, skip, now, wanted);
    if (!goal) {
      // No spawn data for this map: explore instead.
      const plan = this.seekExplorer.plan(map, here, now, this.obstaclesNear(reading, here, STEER_ROUND_TILES).map((o) => ({ x: o.x, y: o.y })));
      if (!plan || plan === 'done') return false;
      await this.bot.moves.driveAlong(here, plan.path, now, false);
      this.bot.statusEvery('Looking for monsters: exploring');
      await this.bot.sleep(RUN_TICK_MS);
      return true;
    }

    // Not moving while trying to: give this one up and pick another next time.
    if (here.x !== goal.moved.x || here.y !== goal.moved.y) goal.moved = { at: now, x: here.x, y: here.y };
    else if (now - goal.moved.at > this.bot.moves.blockedAfterMs() + RUN_TICK_MS * 2) {
      if (goal.kind === 'spot') this.visitedSpots.set(goal.key, now + SPOT_REVISIT_MS);
      this.seek = null;
      return true;
    }
    // Keep to the path while on it (and clear of monsters); otherwise work out a new one.
    const onPath: number = goal.path ? goal.path.findIndex((t) => t.x === here.x && t.y === here.y) : -1;
    goal.path = goal.path && onPath >= 0 ? goal.path.slice(onPath) : null;
    if (!goal.path || goal.path.length < 2) {
      const blocked = new Set([...this.bot.travel.exitsToAvoid(map, here), ...this.obstaclesNear(reading, here, STEER_ROUND_TILES).map((o) => o.y * map.width + o.x)]);
      const dist = walkDistances(map, here, blocked);
      const near = nearestApproach(map, dist, [goal.target]);
      if (!near || near.steps === 0) {
        if (goal.kind === 'spot') this.visitedSpots.set(goal.key, now + SPOT_REVISIT_MS);
        this.seek = null;
        return true;
      }
      goal.path = pathBack(map, dist, near.tile);
    }
    this.seek = goal;
    await this.bot.moves.driveAlong(here, goal.path, now, false);
    this.bot.statusEvery(goal.kind === 'monster' ? `Heading for ${goal.label}` : `Heading for where ${goal.label} spawn`);
    await this.bot.sleep(RUN_TICK_MS);
    return true;
  }

  /**
   * The best spawn spot on this map not visited lately: near, and with plenty of
   * monsters (not all of them unticked) for the walk. Null without spawn data.
   */
  private pickSpawnSpot(map: MapGrid, here: Point, skip: Set<string>, now: number, wanted: Set<string> | null = null): NonNullable<Hunting['seek']> | null {
    const data = loadTravelData();
    const spots = data.spawns?.[map.index];
    if (!spots?.length) return null;
    const names = (set: number) => (data.spawnSets?.[set] ?? []).map((i) => data.monsters?.[i] ?? '?');
    const dist = walkDistances(map, here, this.bot.travel.exitsToAvoid(map, here));
    let best: { spot: (typeof spots)[number]; score: number; steps: number } | null = null;
    for (const spot of spots) {
      const [x, y, n, set] = spot;
      if (this.visitedSpots.has(`${x},${y}`)) continue;
      if (names(set).every((name) => skip.has(name.toLowerCase()))) continue;
      // Quest monsters only: spots where one of them spawns.
      if (wanted && !names(set).some((name) => wanted.has(name.toLowerCase()))) continue;
      const near = nearestApproach(map, dist, [{ x, y }]);
      if (!near) continue;
      // Steps there, less a bonus for how many monsters to expect.
      const score = near.steps - 15 * Math.log2(1 + n);
      if (!best || score < best.score) best = { spot, score, steps: near.steps };
    }
    if (!best) {
      // Every spot seen lately: start the round again.
      if (this.visitedSpots.size) this.visitedSpots.clear();
      return null;
    }
    const [x, y, , set] = best.spot;
    const list = names(set).filter((name) => !skip.has(name.toLowerCase()) && (!wanted || wanted.has(name.toLowerCase())));
    const label = list.slice(0, 3).join(', ') + (list.length > 3 ? '...' : '');
    return { kind: 'spot', key: `${x},${y}`, label, target: { x, y }, map: map.index, since: now, path: null, moved: { at: now, x: NaN, y: NaN } };
  }

  /** With nothing on screen, head for the nearest monster on the minimap, or wander. */
  private async seekOrRoam(): Promise<void> {
    const reading = readMinimap(this.bot.frame, this.minimapSelf);
    if (reading.self) this.minimapSelf = reading.self;
    const monster = this.detourStepsLeft > 0 ? null : nearestMonster(reading);

    if (monster && reading.self) {
      // The minimap keeps the world's proportions, so its directions are screen directions.
      const dx = monster.centre.x - reading.self.x;
      const dy = monster.centre.y - reading.self.y;
      const length = Math.hypot(dx, dy);
      if (length > 0) {
        const player = this.bot.player();
        const point = {
          x: Math.round(player.x + (dx / length) * ROAM_DISTANCE),
          y: Math.round(player.y + (dy / length) * ROAM_DISTANCE * 0.75),
        };
        this.bot.statusEvery('Heading for a monster on the minimap');
        // Blocked on the way: wander a little to get around it.
        if (!(await this.step(point))) this.detourStepsLeft = DETOUR_STEPS;
        return;
      }
    }

    if (this.detourStepsLeft > 0) this.detourStepsLeft--;
    await this.roam();
    this.bot.statusEvery(reading.self ? 'Roaming (no monsters on the minimap)' : 'Roaming (minimap not found)');
  }

  /** Takes a step in the current roaming direction, turning when blocked or every so often. */
  private async roam(): Promise<void> {
    if (this.roamStepsLeft <= 0) {
      this.roamDirection = Math.floor(Math.random() * ROAM_DIRECTIONS.length);
      this.roamStepsLeft = 6 + Math.floor(Math.random() * 7);
    }
    const dir = ROAM_DIRECTIONS[this.roamDirection];
    const scale = dir.x && dir.y ? ROAM_DISTANCE / Math.SQRT2 : ROAM_DISTANCE;
    const player = this.bot.player();
    const point = { x: Math.round(player.x + dir.x * scale), y: Math.round(player.y + dir.y * scale * 0.75) };
    this.roamStepsLeft--;

    if (!(await this.step(point))) {
      // Blocked: turn somewhere other than straight back into the same wall.
      this.roamDirection = (this.roamDirection + 2 + Math.floor(Math.random() * 5)) % ROAM_DIRECTIONS.length;
      this.roamStepsLeft = 4 + Math.floor(Math.random() * 5);
    }
  }

  /** Clicks towards `point` and reports whether the view moved (i.e. the player wasn't blocked). */
  private async step(point: Point): Promise<boolean> {
    const before = viewSignature(this.bot.frame);
    await this.bot.click(point, this.bot.delay('attackClick'));
    await this.bot.sleep(this.bot.delay('runStep'));
    this.bot.capture();
    return signatureDifference(before, viewSignature(this.bot.frame)) >= MOVED_THRESHOLD;
  }

  // ---- Fighting what's in the way (travel, explore, getting out of combat) ----

  /** What stands in the way within `range` tiles: live monsters, other players and NPCs (pets move aside, and follow us). */
  obstaclesNear(reading: MemoryState, here: Point, range: number): MemoryObject[] {
    const away = (o: MemoryObject) => Math.max(Math.abs(o.x - here.x), Math.abs(o.y - here.y));
    return (reading.objects ?? []).filter(
      (o) => (o.kind === 'monster' || o.kind === 'player' || o.kind === 'npc') && !o.pet && !o.dead && away(o) <= range && away(o) > 0,
    );
  }

  /**
   * Monsters near enough to matter in a fight: within `range` and no more than
   * THREAT_LEVELS below the player (chickens round a level 24 aren't a reason to stop).
   */
  threatsNear(reading: MemoryState, here: Point, range: number): MemoryObject[] {
    const level = reading.user?.level ?? 0;
    return this.monstersNear(reading, here, range).filter((o) => !o.level || o.level >= level - THREAT_LEVELS);
  }

  /**
   * On the way somewhere (Travel, Explore, Gathering trips): fights what's in the way, returning whether it did.
   * Stuck (not moving while trying to) with monsters close by: always, however weak they are, or it would stand
   * there for ever. Otherwise, with "Fight monsters in the way", threats crowding round (two right next to you).
   */
  async fightIfBlocked(reading: MemoryState, here: Point, stuck: boolean): Promise<boolean> {
    if (stuck && this.monstersNear(reading, here, FIGHT_RANGE_TILES).length > 0) return this.clearTheWay(FIGHT_RANGE_TILES, true);
    if (this.bot.settings.fightInTheWay && (stuck || this.threatsNear(reading, here, 1).length >= 2)) return this.clearTheWay();
    return false;
  }

  /** Live monsters (not pets) within `range` tiles, nearest first. */
  monstersNear(reading: MemoryState, here: Point, range: number): MemoryObject[] {
    const away = (o: MemoryObject) => Math.max(Math.abs(o.x - here.x), Math.abs(o.y - here.y));
    return (reading.objects ?? [])
      .filter((o) => o.kind === 'monster' && !o.pet && !o.dead && hostile(o) && away(o) <= range)
      .sort((a, b) => away(a) - away(b));
  }

  /**
   * Fights monsters in the way, as Hunt does (clicks and attack keys): the
   * nearest within FIGHT_RANGE_TILES until none is left there. Returns whether
   * there was anything to fight.
   */
  async clearTheWay(range = FIGHT_RANGE_TILES, weakToo = false): Promise<boolean> {
    const memory = this.bot.options.memory;
    const started = this.bot.clock.now();
    const given = new Set<number>();
    let fought = false;
    let current = null as { id: number; since: number } | null;
    while (this.bot.clock.now() - started < FIGHT_GIVE_UP_MS) {
      await this.bot.yieldToEvents();
      const reading = memory.latest();
      const user = reading?.user;
      if (!reading || !user) break;
      // Monsters far below the player aren't worth stopping for: they're walked round instead.
      const monster = (weakToo ? this.monstersNear(reading, user, range) : this.threatsNear(reading, user, range)).find((o) => !given.has(o.id));
      if (!monster) break;
      const now = this.bot.clock.now();
      if (current?.id !== monster.id) current = { id: monster.id, since: now };
      else if (now - current.since > FIGHT_TARGET_GIVE_UP_MS) {
        given.add(monster.id);
        continue;
      }
      if (!fought) {
        this.bot.stopRunning();
        await this.bot.moves.setMounted(false);
        fought = true;
      }
      this.bot.capture();
      this.bot.readVitals();
      this.bot.drinkPotions();
      const tile = this.bot.toScreen(user, monster.x, monster.y);
      const point = await this.bot.aimAt({ key: `m${monster.id}`, point: tile, name: monster.name, tile });
      if (point) {
        if (this.bot.settings.archer) {
          this.bot.hold(point, `m${monster.id}`);
          await this.bot.sleep(this.bot.delay('attackClick'));
        } else {
          await this.bot.click(point, this.bot.delay('attackClick'));
        }
      }
      await this.bot.pressKeys(true);
      this.bot.statusEvery(`Fighting ${monster.name} in the way`);
    }
    this.bot.releaseHold();
    return fought;
  }
}

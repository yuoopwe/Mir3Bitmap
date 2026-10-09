/**
 * Grind's measurements: the experience each character really gained hunting
 * on each map, and for how long; and their fights (each kill timed, the health
 * it cost, and deaths; and the damage landing round them, for area damage). Kept between runs (saved by main.ts as
 * userData/grind.json). The planner (grind.ts) blends them with its estimates.
 */
import type { MemoryState } from './game-memory';
import { packFighter } from './combat-model';
import { potionNotesFrom, type PotionNotes } from './calibration';
import type { GearCheck } from './loadout';
import type { AreaSample } from './area-damage';

/** One stint of hunting on a map: how long (not travelling, not paused), and the experience it brought. */
export interface GrindSession {
  map: number;
  /** The character's level when it started. */
  level: number;
  ms: number;
  exp: number;
  /** When it ended (Date.now()), to put the newest first. */
  at: number;
  /** The kills timed during it, and the damage per second they took: what its estimate is worked out with (grind.ts). */
  kills?: number;
  dps?: number;
  /**
   * Its area damage (area-damage.ts stintArea), for its estimate too: the crowd fought, the speed-up measured at it,
   * and how far that's trusted. Older stints lack them.
   */
  crowd?: number;
  area?: number;
  areaTrust?: number;
}

/** A kill, timed from the first blow to its death. */
export interface Kill {
  /** The character's level, and the monster's. */
  level: number;
  monsterLevel: number;
  /** The monster's health (its Health stat), and the damage dealt to it (at most that). */
  maxHp: number;
  damage: number;
  seconds: number;
  /** The character's health lost while fighting it, as a share of their most. */
  hpLost: number;
  /** When it died (Date.now()). */
  at: number;
  /**
   * Noted since the combat model (older kills lack them): the monster; the character's stats then (combat-model.ts
   * packFighter); health potions drunk, the health put back meanwhile and the lowest it got (shares of the most);
   * and the blows seen land on it.
   */
  monster?: string;
  stats?: number[];
  potions?: number;
  healed?: number;
  lowest?: number;
  hits?: number;
}

/** The character died: their level, and the level of the monster being fought (null: none). */
export interface Death {
  level: number;
  monsterLevel: number | null;
  at: number;
}

/** A stint on the Boss circuit (travelling and fighting): how long, and when it ended (Date.now()). */
export interface BossStint {
  ms: number;
  at: number;
}

/** A character's fights: kills and deaths, oldest first. */
export interface Fights {
  kills: Kill[];
  deaths: Death[];
}

/** What the game's memory says of the character's experience. */
export interface ExperienceReading {
  level?: number;
  /** Experience into the current level, and the amount it takes to reach the next. */
  experience?: number | null;
  maxExperience?: number | null;
}

/** Stints shorter than this say too little to keep. */
const MIN_SESSION_MS = 30_000;
/** At most this many stints are kept per character (the oldest go first). */
const MAX_SESSIONS = 200;
/** ...and this many kills and deaths. */
const MAX_KILLS = 300;
const MAX_DEATHS = 50;
/** ...and this many Boss circuit stints. */
const MAX_BOSS_STINTS = 200;
/** ...and this many area damage samples (5 s of fighting each: over an hour and a half). */
const MAX_AREA_SAMPLES = 1000;
/** Area samples are saved as rows of numbers in this order, under this version (a file with another loads none). */
const AREA_FIELDS = ['at', 'map', 'level', 'seconds', 'damage', 'crowd'] as const;
const AREA_VERSION = 1;
/** Kills quicker than this (seconds) can't be timed; slower ones weren't one fight (out of reach, run off). */
const MIN_KILL_SECONDS = 0.3;
const MAX_KILL_SECONDS = 120;

/**
 * Experience gained between two readings. Within a level it's the difference;
 * across a level-up the count starts again, so it's what was left of the old
 * level (its maxExperience less the old experience) plus the new experience.
 * Levels skipped in between aren't known, so aren't counted. 0 when either
 * reading lacks the numbers, or the level went down.
 */
export function experienceGained(before: ExperienceReading, after: ExperienceReading): number {
  if (before.level === undefined || after.level === undefined) return 0;
  if (before.experience == null || after.experience == null) return 0;
  if (after.level === before.level) return after.experience - before.experience;
  if (after.level < before.level || before.maxExperience == null) return 0;
  return Math.max(0, before.maxExperience - before.experience) + after.experience;
}

/** Adds up the experience gained over a run of readings (each one against the last with the numbers). */
export class ExperienceMeter {
  gained = 0;
  private last: ExperienceReading | null = null;

  sample(reading: ExperienceReading | null | undefined): void {
    if (!reading || reading.level === undefined || reading.experience == null) return;
    if (this.last) this.gained += experienceGained(this.last, reading);
    this.last = { level: reading.level, experience: reading.experience, maxExperience: reading.maxExperience };
  }
}

/** The damage per second in a run of kills (all their damage over all their time), and how many; null without any. */
export function damageDealt(kills: readonly Kill[]): { dps: number; kills: number } | null {
  const seconds = kills.reduce((sum, k) => sum + k.seconds, 0);
  return seconds > 0 ? { dps: kills.reduce((sum, k) => sum + k.damage, 0) / seconds, kills: kills.length } : null;
}

/** What the fight timer reads: the character, and the monsters about. */
export type FightReading = Pick<MemoryState, 'user' | 'objects'>;

/** A fight going on: when first clicked, since when timed, whether someone else hurt it first; the health lost and put back, the lowest it got, potions, blows landed. */
interface Fight {
  clicked: number;
  since: number | null;
  helped: boolean;
  hpLost: number;
  healed: number;
  lowest: number;
  potions: number;
  hits: number;
  /** The damage last seen on it. */
  seen: number;
}

/**
 * Times the hunt loop's fights from the game's memory. A monster's fight is
 * timed from the first blow struck next to it (a click from further off has the
 * character walk up first), or from the first damage seen land on it (blows
 * from range), until it's dead; if someone else had hurt it before our first
 * click, it doesn't count. The character's health lost meanwhile goes to the
 * monster being fought (rises, from regeneration or potions, only move the
 * mark, and count as put back), as do the potions drunk. Kills too quick or
 * too slow to time, and bosses, don't count. So kills hurt first by the
 * character's own area blows are dropped too: these times are one monster at a
 * time, and area damage is measured on its own (area-damage.ts AreaMeter).
 */
export class FightTimer {
  /** Monsters attacked, by id. */
  private readonly fights = new Map<number, Fight>();
  private lastHp: number | null = null;
  private dead = false;

  constructor(private readonly isBoss: (name: string) => boolean = () => false) {}

  /** A blow struck at monster `id` (the first next to it starts the clock). */
  attacked(id: number, reading: FightReading, now: number): void {
    const monster = reading.objects?.find((o) => o.id === id);
    if (!monster) return;
    const user = reading.user;
    const lowest = user?.hp !== undefined && user.maxHp ? user.hp / user.maxHp : 1;
    const fight =
      this.fights.get(id) ??
      this.fights.set(id, { clicked: now, since: null, helped: (monster.hp ?? 0) < 0, hpLost: 0, healed: 0, lowest, potions: 0, hits: 0, seen: monster.hp ?? 0 }).get(id)!;
    if (fight.since === null && user && Math.max(Math.abs(monster.x - user.x), Math.abs(monster.y - user.y)) <= 1) fight.since = now;
  }

  /** A health potion drunk while fighting monster `engaged`. */
  drank(engaged: number | null): void {
    const fight = engaged !== null ? this.fights.get(engaged) : undefined;
    if (fight) fight.potions++;
  }

  /** Takes in a reading (`engaged`: the monster being fought); returns the kills it ended, and a death. */
  update(reading: FightReading, now: number, engaged: number | null, at = Date.now()): { kills: Kill[]; death: Death | null } {
    const user = reading.user;
    if (user?.hp !== undefined && user.maxHp) {
      const fight = engaged !== null ? this.fights.get(engaged) : undefined;
      if (fight && this.lastHp !== null && user.hp < this.lastHp) fight.hpLost += (this.lastHp - user.hp) / user.maxHp;
      if (fight && this.lastHp !== null && user.hp > this.lastHp) fight.healed += (user.hp - this.lastHp) / user.maxHp;
      if (fight) fight.lowest = Math.min(fight.lowest, user.hp / user.maxHp);
      this.lastHp = user.hp;
    }
    let death: Death | null = null;
    if (user?.dead && !this.dead) {
      const foe = engaged !== null ? reading.objects?.find((o) => o.id === engaged) : undefined;
      death = { level: user.level ?? 0, monsterLevel: foe ? foe.level : null, at };
      this.fights.clear();
    }
    this.dead = !!user?.dead;
    const kills: Kill[] = [];
    for (const [id, fight] of this.fights) {
      const monster = reading.objects?.find((o) => o.id === id);
      if (fight.since === null && (monster?.hp ?? 0) < 0) fight.since = now;
      if (monster && (monster.hp ?? 0) < fight.seen) {
        fight.hits++;
        fight.seen = monster.hp!;
      }
      const seconds = fight.since === null ? 0 : (now - fight.since) / 1000;
      // Out of sight, or too long to have been one fight: forgotten.
      if (!monster || (now - fight.clicked) / 1000 > MAX_KILL_SECONDS) {
        this.fights.delete(id);
        continue;
      }
      if (!monster.dead) continue;
      this.fights.delete(id);
      const damage = Math.min(monster.maxHp ?? 0, -(monster.hp ?? 0));
      if (fight.helped || seconds < MIN_KILL_SECONDS || damage <= 0 || user?.level === undefined || this.isBoss(monster.name)) continue;
      const stats = packFighter(user);
      kills.push({
        level: user.level, monsterLevel: monster.level, maxHp: monster.maxHp!, damage, seconds, hpLost: fight.hpLost, at,
        monster: monster.name, ...(stats && { stats }), potions: fight.potions, healed: fight.healed, lowest: fight.lowest, hits: fight.hits,
      });
    }
    return { kills, death };
  }
}

const finite = (o: unknown, keys: string[]) => !!o && keys.every((key) => Number.isFinite((o as Record<string, unknown>)[key]));

/** A saved kill with only the newer fields that are sound (older files have none). */
function cleanKill({ monster, stats, potions, healed, lowest, hits, ...kill }: Kill): Kill {
  const numbers = Object.entries({ potions, healed, lowest, hits }).filter(([, v]) => Number.isFinite(v));
  return {
    ...kill,
    ...(typeof monster === 'string' && { monster }),
    ...(Array.isArray(stats) && stats.every((v) => Number.isFinite(v)) && { stats }),
    ...Object.fromEntries(numbers),
  };
}

/** Every character's stints and fights, by character name. */
export class GrindLog {
  private readonly characters = new Map<string, GrindSession[]>();
  private readonly fightLog = new Map<string, Fights>();
  private readonly bossStints = new Map<string, BossStint[]>();
  private readonly potionNotes = new Map<string, PotionNotes>();
  private readonly gearCheckLog = new Map<string, GearCheck[]>();
  private readonly areaLog = new Map<string, AreaSample[]>();

  constructor(private readonly onChange: () => void) {}

  /** A character's stints, oldest first. */
  sessions(character: string): GrindSession[] {
    return this.characters.get(character) ?? [];
  }

  /** Records a stint (too short ones are dropped). */
  add(character: string, session: GrindSession): void {
    if (!character || session.ms < MIN_SESSION_MS || !Number.isFinite(session.exp)) return;
    const list = [...this.sessions(character), session].slice(-MAX_SESSIONS);
    this.characters.set(character, list);
    this.onChange();
  }

  /** A character's kills and deaths. */
  fights(character: string): Fights {
    return this.fightLog.get(character) ?? { kills: [], deaths: [] };
  }

  addKill(character: string, kill: Kill): void {
    if (!character) return;
    const fights = this.fights(character);
    this.fightLog.set(character, { ...fights, kills: [...fights.kills, kill].slice(-MAX_KILLS) });
    this.onChange();
  }

  addDeath(character: string, death: Death): void {
    if (!character) return;
    const fights = this.fights(character);
    this.fightLog.set(character, { ...fights, deaths: [...fights.deaths, death].slice(-MAX_DEATHS) });
    this.onChange();
  }

  /** A character's Boss circuit stints, oldest first. */
  bossTime(character: string): BossStint[] {
    return this.bossStints.get(character) ?? [];
  }

  addBossTime(character: string, stint: BossStint): void {
    if (!character || !(stint.ms > 0)) return;
    this.bossStints.set(character, [...this.bossTime(character), stint].slice(-MAX_BOSS_STINTS));
    this.onChange();
  }

  /** What's been learned of a character's health potions (calibration.ts PotionWatch), if anything. */
  potions(character: string): PotionNotes | null {
    return this.potionNotes.get(character) ?? null;
  }

  setPotions(character: string, notes: PotionNotes): void {
    if (!character) return;
    this.potionNotes.set(character, notes);
    this.onChange();
  }

  /** A character's gear changes checked against the game (loadout.ts GearWatch), oldest first. */
  gearChecks(character: string): GearCheck[] {
    return this.gearCheckLog.get(character) ?? [];
  }

  setGearChecks(character: string, checks: GearCheck[]): void {
    if (!character) return;
    this.gearCheckLog.set(character, checks);
    this.onChange();
  }

  /** A character's area damage samples (area-damage.ts), oldest first. */
  areaSamples(character: string): AreaSample[] {
    return this.areaLog.get(character) ?? [];
  }

  addAreaSample(character: string, sample: AreaSample): void {
    if (!character) return;
    this.areaLog.set(character, [...this.areaSamples(character), sample].slice(-MAX_AREA_SAMPLES));
    this.onChange();
  }

  /** Takes what toJSON saved (fights are newer than stints: a file without them loads as before). */
  load(saved: unknown): void {
    const data = saved as {
      characters?: Record<string, unknown>; fights?: Record<string, unknown>; bossTime?: Record<string, unknown>; potions?: Record<string, unknown>; gearChecks?: Record<string, unknown>;
      area?: Record<string, unknown>;
    } | null;
    if (!data || typeof data.characters !== 'object' || !data.characters) return;
    for (const [name, list] of Object.entries(data.characters)) {
      if (!Array.isArray(list)) continue;
      const valid = list
        .filter((s): s is GrindSession => finite(s, ['map', 'level', 'ms', 'exp', 'at']))
        .map(({ kills, dps, crowd, area, areaTrust, ...s }) => ({
          ...s,
          ...(Number.isFinite(kills) && Number.isFinite(dps) && { kills, dps }),
          ...(Number.isFinite(crowd) && Number.isFinite(area) && Number.isFinite(areaTrust) && { crowd, area, areaTrust }),
        }));
      this.characters.set(name, valid.slice(-MAX_SESSIONS));
    }
    for (const [name, fights] of Object.entries(data.fights && typeof data.fights === 'object' ? data.fights : {})) {
      if (!fights || typeof fights !== 'object') continue;
      const { kills, deaths } = fights as { kills?: unknown; deaths?: unknown };
      this.fightLog.set(name, {
        kills: (Array.isArray(kills) ? kills : [])
          .filter((k): k is Kill => finite(k, ['level', 'monsterLevel', 'maxHp', 'damage', 'seconds', 'hpLost', 'at']))
          .map(cleanKill)
          .slice(-MAX_KILLS),
        deaths: (Array.isArray(deaths) ? deaths : [])
          .filter((d): d is Death => finite(d, ['level', 'at']) && ((d as Death).monsterLevel === null || Number.isFinite((d as Death).monsterLevel)))
          .slice(-MAX_DEATHS),
      });
    }
    for (const [name, list] of Object.entries(data.bossTime && typeof data.bossTime === 'object' ? data.bossTime : {})) {
      if (Array.isArray(list)) this.bossStints.set(name, list.filter((s): s is BossStint => finite(s, ['ms', 'at'])).slice(-MAX_BOSS_STINTS));
    }
    for (const [name, notes] of Object.entries(data.potions && typeof data.potions === 'object' ? data.potions : {})) {
      const valid = potionNotesFrom(notes);
      if (valid) this.potionNotes.set(name, valid);
    }
    const row = (r: unknown) => Array.isArray(r) && r.length === 4 && r.every((v) => Number.isFinite(v));
    for (const [name, list] of Object.entries(data.gearChecks && typeof data.gearChecks === 'object' ? data.gearChecks : {})) {
      if (!Array.isArray(list)) continue;
      this.gearCheckLog.set(name, list.filter((c): c is GearCheck => finite(c, ['at']) && Array.isArray((c as GearCheck).stats) && (c as GearCheck).stats.every(row)));
    }
    for (const [name, saved] of Object.entries(data.area && typeof data.area === 'object' ? data.area : {})) {
      const { v, samples } = (saved ?? {}) as { v?: unknown; samples?: unknown };
      if (v !== AREA_VERSION || !Array.isArray(samples)) continue;
      const rows = samples.filter((r): r is number[] => Array.isArray(r) && r.length === AREA_FIELDS.length && r.every((x) => Number.isFinite(x)));
      this.areaLog.set(name, rows.map((r) => Object.fromEntries(AREA_FIELDS.map((f, i) => [f, r[i]])) as unknown as AreaSample).slice(-MAX_AREA_SAMPLES));
    }
  }

  toJSON(): {
    characters: Record<string, GrindSession[]>; fights?: Record<string, Fights>; bossTime?: Record<string, BossStint[]>; potions?: Record<string, PotionNotes>;
    gearChecks?: Record<string, GearCheck[]>; area?: Record<string, { v: number; samples: number[][] }>;
  } {
    return {
      characters: Object.fromEntries(this.characters),
      ...(this.fightLog.size ? { fights: Object.fromEntries(this.fightLog) } : {}),
      ...(this.bossStints.size ? { bossTime: Object.fromEntries(this.bossStints) } : {}),
      ...(this.potionNotes.size ? { potions: Object.fromEntries(this.potionNotes) } : {}),
      ...(this.gearCheckLog.size ? { gearChecks: Object.fromEntries(this.gearCheckLog) } : {}),
      ...(this.areaLog.size ? { area: Object.fromEntries([...this.areaLog].map(([name, list]) => [name, { v: AREA_VERSION, samples: list.map((x) => AREA_FIELDS.map((f) => x[f])) }])) } : {}),
    };
  }
}

/**
 * Grind's measurements: the experience each character really gained hunting
 * on each map, and for how long; and their fights (each kill timed, the health
 * it cost, and deaths). Kept between runs (saved by main.ts as
 * userData/grind.json). The planner (grind.ts) blends them with its estimates.
 */
import type { MemoryState } from './game-memory';

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
}

/** The character died: their level, and the level of the monster being fought (null: none). */
export interface Death {
  level: number;
  monsterLevel: number | null;
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

/**
 * Times the hunt loop's fights from the game's memory. A monster's fight starts
 * with the first blow at it (unless someone else had hurt it already: then it
 * doesn't count) and ends when it's dead; the character's health lost meanwhile
 * goes to the monster being fought (rises, from regeneration or potions, only
 * move the mark). Kills too quick or too slow to time, and bosses, don't count.
 */
export class FightTimer {
  /** Monsters attacked, by id: since when, whether someone else hurt it first, and the health lost fighting it. */
  private readonly fights = new Map<number, { since: number; helped: boolean; hpLost: number }>();
  private lastHp: number | null = null;
  private dead = false;

  constructor(private readonly isBoss: (name: string) => boolean = () => false) {}

  /** A blow struck at monster `id` (the first starts its fight). */
  attacked(id: number, reading: FightReading, now: number): void {
    if (this.fights.has(id)) return;
    const monster = reading.objects?.find((o) => o.id === id);
    if (monster) this.fights.set(id, { since: now, helped: (monster.hp ?? 0) < 0, hpLost: 0 });
  }

  /** Takes in a reading (`engaged`: the monster being fought); returns the kills it ended, and a death. */
  update(reading: FightReading, now: number, engaged: number | null, at = Date.now()): { kills: Kill[]; death: Death | null } {
    const user = reading.user;
    if (user?.hp !== undefined && user.maxHp) {
      const fight = engaged !== null ? this.fights.get(engaged) : undefined;
      if (fight && this.lastHp !== null && user.hp < this.lastHp) fight.hpLost += (this.lastHp - user.hp) / user.maxHp;
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
      const seconds = (now - fight.since) / 1000;
      // Out of sight, or too long to have been one fight: forgotten.
      if (!monster || seconds > MAX_KILL_SECONDS) {
        this.fights.delete(id);
        continue;
      }
      if (!monster.dead) continue;
      this.fights.delete(id);
      const damage = Math.min(monster.maxHp ?? 0, -(monster.hp ?? 0));
      if (fight.helped || seconds < MIN_KILL_SECONDS || damage <= 0 || user?.level === undefined || this.isBoss(monster.name)) continue;
      kills.push({ level: user.level, monsterLevel: monster.level, maxHp: monster.maxHp!, damage, seconds, hpLost: fight.hpLost, at });
    }
    return { kills, death };
  }
}

const finite = (o: unknown, keys: string[]) => !!o && keys.every((key) => Number.isFinite((o as Record<string, unknown>)[key]));

/** Every character's stints and fights, by character name. */
export class GrindLog {
  private readonly characters = new Map<string, GrindSession[]>();
  private readonly fightLog = new Map<string, Fights>();

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

  /** Takes what toJSON saved (fights are newer than stints: a file without them loads as before). */
  load(saved: unknown): void {
    const data = saved as { characters?: Record<string, unknown>; fights?: Record<string, unknown> } | null;
    if (!data || typeof data.characters !== 'object' || !data.characters) return;
    for (const [name, list] of Object.entries(data.characters)) {
      if (!Array.isArray(list)) continue;
      const valid = list
        .filter((s): s is GrindSession => finite(s, ['map', 'level', 'ms', 'exp', 'at']))
        .map(({ kills, dps, ...s }) => (Number.isFinite(kills) && Number.isFinite(dps) ? { ...s, kills, dps } : s));
      this.characters.set(name, valid.slice(-MAX_SESSIONS));
    }
    for (const [name, fights] of Object.entries(data.fights && typeof data.fights === 'object' ? data.fights : {})) {
      if (!fights || typeof fights !== 'object') continue;
      const { kills, deaths } = fights as { kills?: unknown; deaths?: unknown };
      this.fightLog.set(name, {
        kills: (Array.isArray(kills) ? kills : []).filter((k): k is Kill => finite(k, ['level', 'monsterLevel', 'maxHp', 'damage', 'seconds', 'hpLost', 'at'])).slice(-MAX_KILLS),
        deaths: (Array.isArray(deaths) ? deaths : [])
          .filter((d): d is Death => finite(d, ['level', 'at']) && ((d as Death).monsterLevel === null || Number.isFinite((d as Death).monsterLevel)))
          .slice(-MAX_DEATHS),
      });
    }
  }

  toJSON(): { characters: Record<string, GrindSession[]>; fights?: Record<string, Fights> } {
    return { characters: Object.fromEntries(this.characters), ...(this.fightLog.size ? { fights: Object.fromEntries(this.fightLog) } : {}) };
  }
}

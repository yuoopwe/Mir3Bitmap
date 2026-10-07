/**
 * Grind's measurements: the experience each character really gained hunting
 * on each map, and for how long, kept between runs (saved by main.ts as
 * userData/grind.json). The planner (grind.ts) blends them with its estimates.
 */

/** One stint of hunting on a map: how long (not travelling, not paused), and the experience it brought. */
export interface GrindSession {
  map: number;
  /** The character's level when it started. */
  level: number;
  ms: number;
  exp: number;
  /** When it ended (Date.now()), to put the newest first. */
  at: number;
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

/** Every character's stints, by character name. */
export class GrindLog {
  private readonly characters = new Map<string, GrindSession[]>();

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

  load(saved: unknown): void {
    const data = saved as { characters?: Record<string, unknown> } | null;
    if (!data || typeof data.characters !== 'object' || !data.characters) return;
    for (const [name, list] of Object.entries(data.characters)) {
      if (!Array.isArray(list)) continue;
      const valid = list.filter(
        (s): s is GrindSession => !!s && ['map', 'level', 'ms', 'exp', 'at'].every((key) => Number.isFinite((s as Record<string, unknown>)[key])),
      );
      this.characters.set(name, valid.slice(-MAX_SESSIONS));
    }
  }

  toJSON(): { characters: Record<string, GrindSession[]> } {
    return { characters: Object.fromEntries(this.characters) };
  }
}

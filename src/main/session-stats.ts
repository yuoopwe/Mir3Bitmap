import type { StatCounts, Stats } from '../shared/types';
import type { MatchResult } from './triad-player';

/** The counts that go up one at a time (the time running is kept by SessionStats itself). */
export type StatName = Exclude<keyof StatCounts, 'runningMs'>;

const RESULT_STAT: Record<MatchResult, StatName> = { won: 'triadWon', lost: 'triadLost', drawn: 'triadDrawn' };

export function noCounts(): StatCounts {
  return { kills: 0, items: 0, gathered: 0, kept: 0, triadPlayed: 0, triadWon: 0, triadLost: 0, triadDrawn: 0, decks: 0, runningMs: 0 };
}

/**
 * What the bot has done this session (since the app started or Reset was
 * pressed) and in all. Everything counted goes into both, so Reset only
 * clears the session's. The all-time totals are saved by the window, which
 * hands them back through restore() when the app starts.
 */
export class SessionStats {
  private session = noCounts();
  private allTime = noCounts();
  /** While a mode runs: the time up to which its running time has been added in. */
  private timedTo: number | null = null;

  count(name: StatName): void {
    this.session[name]++;
    this.allTime[name]++;
  }

  /** A finished Triple Triad match, and how it ended when that's known. */
  countMatch(result: MatchResult | null): void {
    this.count('triadPlayed');
    if (result) this.count(RESULT_STAT[result]);
  }

  /** A mode started running; `now` in milliseconds, as for every time here. */
  start(now: number): void {
    this.timedTo = now;
  }

  stop(now: number): void {
    this.addTime(now);
    this.timedTo = null;
  }

  /** Clears the session's counts; the all-time totals keep everything (including the time run so far). */
  reset(now: number): void {
    this.addTime(now);
    this.session = noCounts();
  }

  /**
   * Takes the all-time totals saved by the window. A count already higher here
   * is kept: the window was reloaded while the app ran, and saved a little
   * before the latest counts.
   */
  restore(saved: unknown): void {
    if (typeof saved !== 'object' || !saved) return;
    const totals = saved as Record<string, unknown>;
    for (const name of Object.keys(this.allTime) as (keyof StatCounts)[]) {
      const value = totals[name];
      if (typeof value === 'number' && Number.isFinite(value) && value > this.allTime[name]) this.allTime[name] = value;
    }
  }

  /** The counts as they stand, with the running time up to `now`. */
  snapshot(now: number): Stats {
    this.addTime(now);
    return { session: { ...this.session }, allTime: { ...this.allTime } };
  }

  /** Adds the time run since it was last added, while a mode runs. */
  private addTime(now: number): void {
    if (this.timedTo === null) return;
    this.session.runningMs += now - this.timedTo;
    this.allTime.runningMs += now - this.timedTo;
    this.timedTo = now;
  }
}

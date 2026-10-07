/**
 * The time the bot goes by: real time in the app; in the tests, a stand-in
 * that jumps ahead on every wait, so a minute of play takes a moment.
 */
import { performance } from 'node:perf_hooks';

export interface Clock {
  /** Milliseconds, as performance.now(). */
  now(): number;
  /** Resolves `ms` later. */
  wait(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => performance.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

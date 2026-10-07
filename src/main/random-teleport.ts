/**
 * Random teleport scrolls on the way somewhere: one puts the character on a
 * random floor tile of the map, so it's worth reading when the walk from here
 * is clearly longer than the walk from where a random landing should leave
 * them. Pure: no game, no screen.
 */
import type { Point } from '../shared/types';
import { isWall, type MapGrid } from './map-grid';
import { walkDistances } from './map-path';

/** Every number the choice is tuned by. */
export const RANDOM_TELEPORT = {
  /** Walks shorter than this are walked. */
  minSteps: 80,
  /** The walk must be this many times what a teleport should leave (casts counted)... */
  gain: 1.4,
  /** ...a cast costing about as long as this many steps (reading it, landing, the game catching up). */
  castSteps: 8,
  /** At most this many on one leg (to one exit, stone or NPC), lucky or not. */
  perLeg: 3,
};

/**
 * What a random landing on the map leaves to walk to `to`: the average steps
 * from the floor tiles that can reach it, and the share of the floor that can
 * (a landing elsewhere, walled off, means another cast).
 */
export function teleportOdds(map: MapGrid, to: Point): { mean: number; reach: number } {
  // Walking is the same both ways: the steps from `to` are the steps to it.
  const dist = walkDistances(map, to);
  let floor = 0, reached = 0, total = 0;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (isWall(map, x, y)) continue;
      floor++;
      const d = dist[y * map.width + x];
      if (d < 0) continue;
      reached++;
      total += d;
    }
  }
  return { mean: reached ? total / reached : Infinity, reach: floor ? reached / floor : 0 };
}

/** What reading scrolls until one lands where `to` can be reached should leave to walk, the casts counted as steps. */
export function expectedAfterTeleport(odds: { mean: number; reach: number }): number {
  return odds.reach > 0 ? odds.mean + RANDOM_TELEPORT.castSteps / odds.reach : Infinity;
}

/** Whether to read a scroll rather than walk `steps`. */
export function worthTeleporting(steps: number, odds: { mean: number; reach: number }): boolean {
  return steps >= RANDOM_TELEPORT.minSteps && steps > RANDOM_TELEPORT.gain * expectedAfterTeleport(odds);
}

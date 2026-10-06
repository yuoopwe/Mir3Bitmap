import type { Point } from '../shared/types';
import type { Label } from './labels';

/**
 * An overhead name followed from scan to scan. A name's pixels change as other
 * names, damage numbers and effects pass over it, so names are followed by
 * where they are (and how alike they look), not by their exact pixels.
 */
export interface Sighting {
  /** Stays the same while the name is followed. */
  id: number;
  /** The name as read in the latest scan. */
  label: Label;
  firstSeenAt: number;
  lastSeenAt: number;
  /** How many scans it has been seen in. */
  scans: number;
  /** Where it first appeared. */
  origin: Point;
}

/** A name has to stay on screen this long to be worth attacking; damage numbers and other combat text come and go. */
const SETTLE_MS = 400;
/** A name out of sight for longer than this is forgotten. */
const KEEP_MS = 1500;
/**
 * How far a name can move between scans and still be the same name: a base
 * plus some per millisecond since it was last seen (the view scrolls while
 * the player runs, moving every name at once).
 */
const MATCH_BASE = 30;
const MATCH_PER_MS = 0.2;
const MATCH_MAX = 150;
/** How much a closer likeness counts for, in pixels of distance. */
const LIKENESS_WEIGHT = 20;
/** Text that rises straight up this far soon after appearing is floating combat text. */
const FLOAT_RISE = 6;
const FLOAT_DRIFT = 3;
const FLOAT_WINDOW_MS = 2000;

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 1 for the same text, otherwise the share of glyphs the two have in common. */
function likeness(a: Label, b: Label): number {
  if (a.fingerprint === b.fingerprint) return 1;
  const keys = new Set(b.glyphs.map((glyph) => glyph.key));
  let shared = 0;
  for (const glyph of a.glyphs) if (keys.has(glyph.key)) shared++;
  return shared / Math.max(a.glyphs.length, b.glyphs.length, 1);
}

/** Follows overhead names across scans. */
export class LabelTracker {
  private sightings: Sighting[] = [];
  private nextId = 1;

  /** Matches this scan's names to the ones seen before and returns the sightings on screen now. */
  update(labels: Label[], now: number): Sighting[] {
    this.sightings = this.sightings.filter((sighting) => now - sighting.lastSeenAt <= KEEP_MS);

    // Every plausible pairing, best first; then take them greedily.
    const pairs: { index: number; sighting: Sighting; cost: number }[] = [];
    labels.forEach((label, index) => {
      for (const sighting of this.sightings) {
        const d = distance(label.centre, sighting.label.centre);
        const reach = Math.min(MATCH_BASE + (now - sighting.lastSeenAt) * MATCH_PER_MS, MATCH_MAX);
        if (d <= reach) pairs.push({ index, sighting, cost: d - likeness(label, sighting.label) * LIKENESS_WEIGHT });
      }
    });
    pairs.sort((a, b) => a.cost - b.cost);

    const placed = new Set<number>();
    const taken = new Set<Sighting>();
    const current: Sighting[] = [];
    for (const { index, sighting } of pairs) {
      if (placed.has(index) || taken.has(sighting)) continue;
      placed.add(index);
      taken.add(sighting);
      sighting.label = labels[index];
      sighting.lastSeenAt = now;
      sighting.scans++;
      current.push(sighting);
    }
    labels.forEach((label, index) => {
      if (placed.has(index)) return;
      const sighting: Sighting = { id: this.nextId++, label, firstSeenAt: now, lastSeenAt: now, scans: 1, origin: label.centre };
      this.sightings.push(sighting);
      current.push(sighting);
    });
    return current;
  }

  reset(): void {
    this.sightings = [];
  }
}

/** Rising straight up since it appeared, the way damage numbers and "Miss" float away. */
export function isFloating(sighting: Sighting, now: number): boolean {
  if (now - sighting.firstSeenAt > FLOAT_WINDOW_MS) return false;
  const { origin, label } = sighting;
  return origin.y - label.centre.y >= FLOAT_RISE && Math.abs(origin.x - label.centre.x) <= FLOAT_DRIFT;
}

/** On screen for long enough, and not floating away: a name worth considering. */
export function isSettled(sighting: Sighting, now: number): boolean {
  return sighting.scans >= 2 && now - sighting.firstSeenAt >= SETTLE_MS && !isFloating(sighting, now);
}

import type { Point } from '../shared/types';
import type { Rect } from './layout';
import type { Frame } from './vision';

/**
 * Minimap markers are small solid squares in exact colours. Finding them by
 * colour and shape works wherever the map panel is and however big it is.
 */
const MONSTER_COLOURS = [0xff4500, 0xffff00]; // orange-red, yellow
const SELF = 0x87ceeb; // sky blue
const PET = 0xadd8e6; // light blue: pets stand on top of (and around) the player's dot

/** A marker is 4x4; overlapping markers make bigger blobs. Thin lines (HP bars) aren't markers. */
const MIN_SIZE = 3;
const MAX_SIZE = 16;

export interface Marker {
  centre: Point;
  pixels: number;
}

export interface MinimapReading {
  /** The player's marker, or null if it can't be told apart. */
  self: Point | null;
  monsters: Marker[];
}

const MARKER_COLOURS = [...MONSTER_COLOURS, SELF, PET];

/** Finds solid blobs of the marker colours that look like map markers, grouped by colour. */
function findMarkers(frame: Frame): Map<number, Marker[]> {
  const { width, height, pixels } = frame;
  const seen = new Uint8Array(width * height);
  const found = new Map<number, Marker[]>(MARKER_COLOURS.map((colour) => [colour, []]));
  const stack: number[] = [];
  for (let i = 0; i < pixels.length; i++) {
    const colour = pixels[i] & 0xffffff;
    // Cheap reject first: sky blue is the lowest marker colour, and most pixels are below it.
    if (colour < SELF) continue;
    const markers = found.get(colour);
    if (!markers || seen[i]) continue;
    let minX = width, maxX = -1, minY = height, maxY = -1, count = 0;
    seen[i] = 1;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % width;
      const y = (j - x) / width;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const k of [j - 1, j + 1, j - width, j + width]) {
        if (k >= 0 && k < pixels.length && !seen[k] && (pixels[k] & 0xffffff) === colour) {
          seen[k] = 1;
          stack.push(k);
        }
      }
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    if (w < MIN_SIZE || h < MIN_SIZE || w > MAX_SIZE || h > MAX_SIZE) continue;
    if (count < w * h * 0.5) continue;
    markers.push({ centre: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, pixels: count });
  }
  return found;
}

function nearest(markers: Marker[], to: Point): Marker | null {
  let best: Marker | null = null;
  let bestDistance = Infinity;
  for (const marker of markers) {
    const d = Math.hypot(marker.centre.x - to.x, marker.centre.y - to.y);
    if (d < bestDistance) {
      best = marker;
      bestDistance = d;
    }
  }
  return best;
}

/** How far the player's marker can move between two readings and still be tracked. */
const TRACK_RADIUS = 30;
/** Monsters this far from the player's marker belong to something else on screen. */
const MAX_RANGE = 450;

/**
 * Reads the minimap. `previousSelf` (the last reading's player position)
 * keeps the right marker when several look alike.
 */
export function readMinimap(frame: Frame, previousSelf: Point | null, area?: Rect): MinimapReading {
  const markers = findMarkers(frame);
  if (area) {
    // Only markers inside the given map panel.
    for (const [colour, list] of markers) {
      markers.set(colour, list.filter((m) => m.centre.x >= area.left && m.centre.x < area.right && m.centre.y >= area.top && m.centre.y < area.bottom));
    }
  }
  const selves = markers.get(SELF)!;
  const pets = markers.get(PET)!;

  let self: Marker | null = null;
  if (previousSelf) {
    const tracked = nearest([...selves, ...pets], previousSelf);
    if (tracked && Math.hypot(tracked.centre.x - previousSelf.x, tracked.centre.y - previousSelf.y) <= TRACK_RADIUS) self = tracked;
  }
  if (!self && selves.length === 1) self = selves[0];
  if (!self && selves.length === 0 && pets.length > 0) {
    // Pets hide the player's own marker; the biggest pet blob is where they're all gathered.
    self = pets.reduce((a, b) => (b.pixels > a.pixels ? b : a));
  }
  if (!self) return { self: null, monsters: [] };

  const centre = self.centre;
  const monsters = MONSTER_COLOURS.flatMap((colour) => markers.get(colour)!).filter(
    (m) => Math.hypot(m.centre.x - centre.x, m.centre.y - centre.y) <= MAX_RANGE,
  );
  return { self: centre, monsters };
}

/** The monster marker closest to the player, or null. */
export function nearestMonster(reading: MinimapReading): Marker | null {
  return reading.self ? nearest(reading.monsters, reading.self) : null;
}

/** Pet pixels this close to the player's last position (map pixels) are taken as gathered round the player. */
const NEAR_PLAYER = 14;
/** A reading this close to the last one is wobble (pets shuffling), so it's smoothed; further is a real jump. */
const WOBBLE = 20;
/** Sky-blue pixels this close together are one marker. */
const MARKER_REACH = 6;

/**
 * Where the player is on a map panel, as precisely as the markers allow.
 * The player's own sky-blue marker is exact, even when pets cover most of
 * it (just after a teleport it's in the clear); otherwise the pets near the
 * last known position stand in for it. `previous` is the last result.
 */
export function locatePlayer(frame: Frame, area: Rect, previous: Point | null): Point | null {
  const { width, pixels } = frame;
  // Start from the last position, or failing that the clearest marker on the map.
  const seed = previous ?? readMinimap(frame, null, area).self;
  if (!seed) return null;

  const sky: Point[] = [];
  let px = 0, py = 0, petCount = 0;
  for (let y = area.top; y < area.bottom; y++) {
    for (let x = area.left; x < area.right; x++) {
      const colour = pixels[y * width + x] & 0xffffff;
      const distance = Math.hypot(x - seed.x, y - seed.y);
      if (colour === SELF && distance <= TRACK_RADIUS * 2) sky.push({ x, y });
      else if (colour === PET && distance <= NEAR_PLAYER) {
        px += x;
        py += y;
        petCount++;
      }
    }
  }

  let found: Point;
  if (sky.length > 0) {
    // The player's marker: the sky-blue pixels around the one nearest the seed
    // (other sky-blue markers further off belong to someone else).
    const closest = sky.reduce((a, b) => (Math.hypot(b.x - seed.x, b.y - seed.y) < Math.hypot(a.x - seed.x, a.y - seed.y) ? b : a));
    const own = sky.filter((p) => Math.hypot(p.x - closest.x, p.y - closest.y) <= MARKER_REACH);
    found = { x: own.reduce((s, p) => s + p.x, 0) / own.length, y: own.reduce((s, p) => s + p.y, 0) / own.length };
  } else if (petCount >= 4) {
    found = { x: px / petCount, y: py / petCount };
  } else {
    const fallback = readMinimap(frame, previous, area).self;
    if (!fallback) return null;
    found = fallback;
  }

  if (previous && Math.hypot(found.x - previous.x, found.y - previous.y) <= WOBBLE) {
    return { x: (found.x + previous.x) / 2, y: (found.y + previous.y) / 2 };
  }
  return found;
}

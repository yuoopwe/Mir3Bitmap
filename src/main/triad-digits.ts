import { DIGIT_TEMPLATES } from './triad-digit-templates';
import type { Frame } from './vision';

/**
 * Reading the numbers printed on Triple Triad cards. Digits are white with a
 * black outline, and the card picture behind them is often just as light, so
 * they're matched by the pattern of their outline.
 *
 * Hand cards are drawn the same way every time, so each digit has one average
 * pattern. Board cards are drawn slanted and at different sizes per row, and
 * read through a flattened copy; a digit looks a little different in each cell,
 * so every distinct example seen is kept and a digit is read as its closest
 * example. Examples from my own cards on the board (whose numbers are known
 * from my hand) are added as matches are played.
 */

/** Hand cards are drawn flat; board cards are drawn slanted, and are read through a flattened copy. */
export type Layout = 'hand' | 'board';

/** Each digit's box (left, top) in layout units: screen pixels for hand cards, flattened units for board cards. Top, left, right, bottom. */
const BOXES: Record<Layout, [number, number][]> = {
  hand: [[7, 0], [0, 15], [15, 15], [7, 30]],
  board: [[11, 3], [1, 17], [18, 17], [11, 30]],
};
export const BOX_WIDTH = 17;
export const BOX_HEIGHT = 18;
/** How far (in layout units) a digit may sit from its usual place. */
const SHIFT = 2;
/** The best match must be at least this good, and this much better than any other digit, to count. */
const MIN_SCORE = 0.55;
const MIN_MARGIN = 0.03;
/** Examples this alike add nothing. */
const SAME_EXAMPLE = 0.98;
const MAX_LEARNED = 1500;

/** Brightness at a point of a card, in layout units. */
export type CardSampler = (u: number, v: number) => number;

function luminance(pixel: number): number {
  return ((pixel >> 16) & 0xff) * 0.3 + ((pixel >> 8) & 0xff) * 0.59 + (pixel & 0xff) * 0.11;
}

/** Brightness anywhere in a frame, blending the four nearest pixels. */
export function brightnessAt(frame: Frame, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const at = (dx: number, dy: number) => luminance(frame.pixels[(y0 + dy) * frame.width + x0 + dx]);
  return (at(0, 0) * (1 - fx) + at(1, 0) * fx) * (1 - fy) + (at(0, 1) * (1 - fx) + at(1, 1) * fx) * fy;
}

/**
 * How much of an outline each spot of an area is: how much darker it is than
 * the brightest spot next to it, 0 to 1. The digits' black outlines run right
 * along their white fill, so they stand out whatever the picture behind is like;
 * flat areas of the picture, light or dark, come out as 0.
 */
export function outlineMap(sample: CardSampler, left: number, top: number, width: number, height: number): Float32Array {
  // Brightness with a one-unit margin all round, for the neighbours.
  const w = width + 2, h = height + 2;
  const light = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) light[y * w + x] = sample(left - 1 + x, top - 1 + y);
  const map = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let brightest = 0;
      for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) brightest = Math.max(brightest, light[(y + dy) * w + x + dx]);
      map[y * width + x] = Math.min(1, Math.max(0, (brightest - light[(y + 1) * w + x + 1] - 40) / 150));
    }
  }
  return map;
}

/** Normalised correlation of two equal-sized maps: 1 for the same pattern. */
export function correlation(a: Float32Array, b: Float32Array): number {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= a.length;
  mb /= b.length;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    ab += da * db;
    aa += da * da;
    bb += db * db;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/** The outline maps of a card's digit `slot` at every allowed shift (the unshifted one in the middle). */
export function digitMaps(sample: CardSampler, layout: Layout, slot: number): Float32Array[] {
  const [left, top] = BOXES[layout][slot];
  const width = BOX_WIDTH + 2 * SHIFT, height = BOX_HEIGHT + 2 * SHIFT;
  const area = outlineMap(sample, left - SHIFT, top - SHIFT, width, height);
  const maps: Float32Array[] = [];
  for (let dy = 0; dy <= 2 * SHIFT; dy++) {
    for (let dx = 0; dx <= 2 * SHIFT; dx++) {
      const map = new Float32Array(BOX_WIDTH * BOX_HEIGHT);
      for (let y = 0; y < BOX_HEIGHT; y++) for (let x = 0; x < BOX_WIDTH; x++) map[y * BOX_WIDTH + x] = area[(y + dy) * width + x + dx];
      maps.push(map);
    }
  }
  return maps;
}

export interface DigitReading {
  /** 1-9, or 10 for "A"; null if it couldn't be read with confidence. */
  value: number | null;
  score: number;
  /** How much better than the next best digit. */
  margin: number;
}

interface Example {
  digit: number;
  map: Float32Array;
  /** The map less its average and scaled to length 1, so comparing two is a dot product. */
  unit: Float32Array;
}

function unitOf(map: Float32Array): Float32Array {
  let mean = 0;
  for (const v of map) mean += v;
  mean /= map.length;
  const unit = map.map((v) => v - mean);
  let length = 0;
  for (const v of unit) length += v * v;
  length = Math.sqrt(length);
  return length > 0 ? unit.map((v) => v / length) : unit;
}

function dot(a: Float32Array, b: Float32Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += a[i] * b[i];
  return total;
}

const example = (digit: number, map: Float32Array): Example => ({ digit, map, unit: unitOf(map) });

const unpack = (base64: string) => Float32Array.from(Buffer.from(base64, 'base64'), (v) => v / 255);
const pack = (map: Float32Array) => Buffer.from(Array.from(map, (v) => Math.round(v * 255))).toString('base64');

/** The best score each digit gets against the maps. */
function scoresFor(maps: Float32Array[], examples: Iterable<Example>): Map<number, number> {
  const units = maps.map(unitOf);
  const scores = new Map<number, number>();
  for (const { digit, unit } of examples) {
    let best = scores.get(digit) ?? -1;
    for (const candidate of units) best = Math.max(best, dot(candidate, unit));
    scores.set(digit, best);
  }
  return scores;
}

function verdict(scores: Map<number, number>): DigitReading {
  const ranked = [...scores].sort((a, b) => b[1] - a[1]);
  const [first, second] = ranked;
  if (!first) return { value: null, score: 0, margin: 0 };
  const margin = first[1] - (second?.[1] ?? 0);
  return { value: first[1] >= MIN_SCORE && margin >= MIN_MARGIN ? first[0] : null, score: first[1], margin };
}

export class DigitReader {
  private readonly hand: Example[];
  private readonly board: Example[];
  private learned: Example[] = [];

  constructor(private readonly onLearn: () => void = () => {}) {
    this.hand = Object.entries(DIGIT_TEMPLATES.hand).map(([digit, base64]) => example(Number(digit), unpack(base64)));
    this.board = DIGIT_TEMPLATES.board.map(([digit, base64]) => example(digit, unpack(base64)));
  }

  /** Reads all four digits of a card: top, left, right, bottom. */
  readCard(sample: CardSampler, layout: Layout): DigitReading[] {
    const examples = layout === 'hand' ? this.hand : [...this.board, ...this.learned];
    return BOXES[layout].map((_, slot) => verdict(scoresFor(digitMaps(sample, layout, slot), examples)));
  }

  /**
   * Remembers how a board card whose numbers are known (one of mine) looks in
   * its cell, so the same digits are read better there from now on.
   */
  learnCard(sample: CardSampler, digits: number[]): void {
    let added = false;
    digits.forEach((digit, slot) => {
      const maps = digitMaps(sample, 'board', slot);
      const same = [...this.board, ...this.learned].filter((example) => example.digit === digit);
      // Line it up with the examples of that digit there are already.
      let best = maps[Math.floor(maps.length / 2)], bestScore = -2;
      for (const map of maps) {
        for (const example of same) {
          const score = correlation(map, example.map);
          if (score > bestScore) [best, bestScore] = [map, score];
        }
      }
      if (bestScore > SAME_EXAMPLE) return;
      this.learned.push(example(digit, best));
      added = true;
    });
    if (!added) return;
    if (this.learned.length > MAX_LEARNED) this.learned = this.learned.slice(-MAX_LEARNED);
    this.onLearn();
  }

  load(saved: unknown): void {
    if (!Array.isArray(saved)) return;
    for (const entry of saved) {
      if (Array.isArray(entry) && typeof entry[0] === 'number' && typeof entry[1] === 'string') this.learned.push(example(entry[0], unpack(entry[1])));
    }
  }

  toJSON(): [number, string][] {
    return this.learned.map(({ digit, map }) => [digit, pack(map)]);
  }
}

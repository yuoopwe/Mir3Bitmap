import type { Point } from '../shared/types';
import type { Rect } from './layout';
import { brightnessAt, type CardSampler, type DigitReader, type DigitReading } from './triad-digits';
import { textSignature, type Frame } from './vision';

/**
 * The Triple Triad panel at 1600x900, measured from recordings. The board is
 * drawn in perspective: its rows are level but grow towards the bottom, and
 * its columns lean outwards. Each card has a 3px coloured border; these are
 * the outer edges of those borders.
 */
const ROW_EDGES: [number, number][] = [[235, 326], [332, 437], [443, 564]];
/** Each column's left and right edge, as straight lines: [left x at y=235, left x at y=564, right x at y=235, right x at y=564]. */
const COLUMN_EDGES: [number, number, number, number][] = [
  [516.87, 477.73, 596.97, 582.87],
  [598.79, 586.04, 678.21, 690.96],
  [680.03, 694.13, 760.13, 799.27],
];
const EDGE_Y0 = 235;
const EDGE_Y1 = 564;
/** Board cards are read through a flattened copy this many units across and down. */
export const FLAT_WIDTH = 96;
export const FLAT_HEIGHT = 110;

function edgeX(x0: number, x1: number, y: number): number {
  return x0 + ((x1 - x0) * (y - EDGE_Y0)) / (EDGE_Y1 - EDGE_Y0);
}

/** A board cell's left and right edges at height `y`. */
function cellSpan(cell: number, y: number): [number, number] {
  const [l0, l1, r0, r1] = COLUMN_EDGES[cell % 3];
  return [edgeX(l0, l1, y), edgeX(r0, r1, y)];
}

/** The middle of a board cell, for clicking. */
export function cellCentre(cell: number): Point {
  const [top, bottom] = ROW_EDGES[Math.floor(cell / 3)];
  const y = (top + bottom) / 2;
  const [left, right] = cellSpan(cell, y);
  return { x: Math.round((left + right) / 2), y: Math.round(y) };
}

/** A board card's brightness at flattened coordinates (0-96 across, 0-110 down). */
export function boardSampler(frame: Frame, cell: number): CardSampler {
  const [top, bottom] = ROW_EDGES[Math.floor(cell / 3)];
  return (u, v) => {
    const y = top + ((bottom - top) * v) / FLAT_HEIGHT;
    const [left, right] = cellSpan(cell, y);
    return brightnessAt(frame, left + ((right - left) * u) / FLAT_WIDTH, y);
  };
}

/** Hand cards stack from the top; played cards leave no gap. */
export const HAND_SLOTS: Rect[] = [0, 1, 2, 3, 4].map((i) => ({ left: 245, top: 156 + 94 * i, right: 328, bottom: 245 + 94 * i }));

/** A hand card's brightness in pixels from its top-left corner. */
export function handSampler(frame: Frame, slot: number): CardSampler {
  const { left, top } = HAND_SLOTS[slot];
  return (u, v) => brightnessAt(frame, left + u, top + v);
}

const CLOSE_BUTTON: Point = { x: 1114, y: 64 };
const TURN_TEXT: Rect = { left: 560, top: 205, right: 720, bottom: 225 };
const OK_BUTTON: Rect = { left: 770, top: 480, right: 830, bottom: 495 };
/** The opponent's name, top right. */
const OPPONENT_NAME: Rect = { left: 940, top: 134, right: 1126, bottom: 153 };

export function centre(r: Rect): Point {
  return { x: Math.round((r.left + r.right) / 2), y: Math.round((r.top + r.bottom) / 2) };
}

const rgb = (p: number) => [(p >> 16) & 0xff, (p >> 8) & 0xff, p & 0xff];

/** A card's picture boiled down to a 4x4 grid of average colours, taken from its lower right (clear of the numbers). */
export function fingerprint(frame: Frame, r: Rect): number[] {
  const w = r.right - r.left, h = r.bottom - r.top;
  const out: number[] = [];
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      const x0 = Math.round(r.left + w * (0.35 + (0.57 * gx) / 4)), x1 = Math.round(r.left + w * (0.35 + (0.57 * (gx + 1)) / 4));
      const y0 = Math.round(r.top + h * (0.4 + (0.52 * gy) / 4)), y1 = Math.round(r.top + h * (0.4 + (0.52 * (gy + 1)) / 4));
      let sr = 0, sg = 0, sb = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const [cr, cg, cb] = rgb(frame.pixels[y * frame.width + x]);
        sr += cr; sg += cg; sb += cb; n++;
      }
      out.push(sr / n, sg / n, sb / n);
    }
  }
  return out;
}

export function difference(a: number[], b: number[]): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

export type Owner = 'me' | 'them';

/** A card as printed: its numbers top, left, right, bottom (null where unreadable). */
export interface CardFace {
  digits: DigitReading[];
}

export interface TriadScreen {
  /** The Triple Triad panel is showing. */
  open: boolean;
  myTurn: boolean;
  /** The "you won/lost" box with its OK button is up. */
  over: boolean;
  /** The cards in my hand, top to bottom. */
  hand: CardFace[];
  /** Each cell's card and who owns it (by its border colour), or null if empty. */
  board: ((CardFace & { owner: Owner }) | null)[];
  /** The opponent's name, as a signature of its pixels (the same opponent always gives the same one). */
  opponent: string;
}

/** My cards are framed in (30,144,255), the opponent's in red. (Empty cells have cyan grid lines, 0,255,255.) */
const isMine = ([r, g, b]: number[]) => Math.abs(r - 30) < 25 && Math.abs(g - 144) < 30 && b > 225;
const isTheirs = ([r, g, b]: number[]) => r > 180 && g < 60 && b < 60;

/**
 * Who owns the card in a cell, from its own border: the middle of each of its
 * four sides is checked, so a neighbour's border (only a pixel away sideways)
 * can't be mistaken for it. A tooltip may cover a side or two.
 */
export function cellOwner(frame: Frame, cell: number): Owner | null {
  const [top, bottom] = ROW_EDGES[Math.floor(cell / 3)];
  const sides: Point[][] = [[], [], [], []];
  for (let i = 1; i <= 9; i++) {
    const t = 0.25 + (0.5 * i) / 10;
    const [topLeft, topRight] = cellSpan(cell, top + 1);
    const [bottomLeft, bottomRight] = cellSpan(cell, bottom - 1);
    sides[0].push({ x: topLeft + (topRight - topLeft) * t, y: top + 1 });
    sides[1].push({ x: bottomLeft + (bottomRight - bottomLeft) * t, y: bottom - 1 });
    const y = top + (bottom - top) * t;
    const [left, right] = cellSpan(cell, y);
    sides[2].push({ x: left + 1, y });
    sides[3].push({ x: right - 1, y });
  }
  let mine = 0, theirs = 0;
  for (const side of sides) {
    let blue = 0, red = 0;
    for (const p of side) {
      const colour = rgb(frame.pixels[Math.round(p.y) * frame.width + Math.round(p.x)]);
      if (isMine(colour)) blue++;
      else if (isTheirs(colour)) red++;
    }
    if (blue >= 6) mine++;
    else if (red >= 6) theirs++;
  }
  if (mine >= 2 && mine > theirs) return 'me';
  if (theirs >= 2 && theirs > mine) return 'them';
  return null;
}

/** Reads the panel; the cards' numbers only with a `reader` (it takes a little longer). */
export function readTriad(frame: Frame, reader?: DigitReader): TriadScreen {
  const at = (p: Point) => rgb(frame.pixels[p.y * frame.width + p.x]);
  const [cr, cg, cb] = at(CLOSE_BUTTON);
  const open = Math.abs(cr - 101) < 25 && Math.abs(cg - 77) < 25 && Math.abs(cb - 48) < 25;

  let yellow = 0;
  for (let y = TURN_TEXT.top; y < TURN_TEXT.bottom; y++) for (let x = TURN_TEXT.left; x < TURN_TEXT.right; x++) {
    const [r, g, b] = rgb(frame.pixels[y * frame.width + x]);
    if (r > 200 && g > 170 && b < 90) yellow++;
  }
  // "Your turn" is about 168 yellow pixels; "Opponent turn" about 245.
  const myTurn = yellow > 120 && yellow < 205;

  let darkRed = 0;
  for (let y = OK_BUTTON.top; y < OK_BUTTON.bottom; y++) for (let x = OK_BUTTON.left; x < OK_BUTTON.right; x++) {
    const [r, g, b] = rgb(frame.pixels[y * frame.width + x]);
    if (r > 55 && r < 110 && g < 35 && b < 35) darkRed++;
  }
  const over = darkRed > 100;

  const hand: CardFace[] = [];
  if (open) {
    for (let slot = 0; slot < HAND_SLOTS.length; slot++) {
      const r = HAND_SLOTS[slot];
      // A card's frame has a bright top edge (white, or yellow when selected).
      const [red, green, blue] = at({ x: centre(r).x, y: r.top });
      if (red + green + blue < 450) break;
      hand.push({ digits: reader ? reader.readCard(handSampler(frame, slot), 'hand') : [] });
    }
  }

  const board = Array.from({ length: 9 }, (_, cell) => {
    const owner = open ? cellOwner(frame, cell) : null;
    return owner ? { owner, digits: reader ? reader.readCard(boardSampler(frame, cell), 'board') : [] } : null;
  });
  return { open, myTurn, over, hand, board, opponent: open ? textSignature(frame, OPPONENT_NAME) : '' };
}

export const OK = centre(OK_BUTTON);

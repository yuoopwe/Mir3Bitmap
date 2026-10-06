import type { Point } from '../shared/types';
import type { Rect } from './layout';
import type { Frame } from './vision';

/**
 * Overhead names (monsters, NPCs, herbs...) are drawn from a fixed five-step
 * grey palette with a dark outline, identically wherever they appear. The
 * pure-white (255) glyph cores are rare in scenery, so they anchor detection.
 */
const NAME_GREYS = [255, 236, 218, 199, 177];
const CORE = 0xffffff;
const ORANGE = 0xffa500; // "(Quest)" under quest monsters and objects

/** Pixels are grouped into cells this size before joining them into labels. */
const CELL = 3;
const MIN_WIDTH = 12; // narrower than this is a damage number
const MAX_WIDTH = 160;
const MIN_HEIGHT = 5;
const MAX_HEIGHT = 14;
const MIN_CORE_PIXELS = 6;
/** Extra room around a group of cells, for core pixels without an outline beside them. */
const MARGIN = 2;

/** One character (or a few touching ones) of a label, cut at blank columns. */
export interface Glyph {
  /** The glyph's exact pixels and its height above the baseline: the same character always gives the same key. */
  key: string;
  left: number;
  right: number;
}

export interface Label {
  /** Bounding box of the label's pure-white pixels. */
  box: Rect;
  centre: Point;
  /** The label's characters, left to right. */
  glyphs: Glyph[];
  /** Width of the whole name in pixels (more than the box if part of it is hidden). */
  width: number;
  /**
   * Identifies the exact text: its glyph keys in order. The game draws a given
   * name identically wherever it appears.
   */
  fingerprint: string;
  /** Has an orange "(Quest)" line underneath. */
  quest: boolean;
}

/** Where `needle` first appears as a run in `haystack`, or -1. */
export function indexOfRun(haystack: string[], needle: string[]): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function isNameGrey(pixel: number): boolean {
  const r = (pixel >> 16) & 0xff;
  if (r < 176) return false;
  const g = (pixel >> 8) & 0xff;
  const b = pixel & 0xff;
  if (Math.abs(r - g) > 1 || Math.abs(r - b) > 1) return false;
  for (const grey of NAME_GREYS) if (Math.abs(r - grey) <= 1) return true;
  return false;
}

/** Close to a name grey: the letters' soft edges pick up a tint from a glow behind them. */
function isNearNameGrey(pixel: number): boolean {
  const r = (pixel >> 16) & 0xff;
  const g = (pixel >> 8) & 0xff;
  const b = pixel & 0xff;
  if (Math.max(r, g, b) - Math.min(r, g, b) > 6) return false;
  for (const grey of NAME_GREYS) if (Math.abs(r - grey) <= 4) return true;
  return false;
}

function isCore(pixel: number): boolean {
  return (pixel & 0xffffff) === CORE;
}

function masked(x: number, y: number, masks: Rect[]): boolean {
  for (const m of masks) if (x >= m.left && x < m.right && y >= m.top && y < m.bottom) return true;
  return false;
}

/** Finds every overhead name in the frame, skipping anything inside `masks`. */
export function findLabels(frame: Frame, masks: Rect[]): Label[] {
  const { width, height, pixels } = frame;
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const cells = new Uint8Array(cols * rows);

  // Mark cells holding a glyph core pixel that has a dark outline beside it.
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      if (!isCore(pixels[row + x])) continue;
      if (!hasDarkNeighbour(pixels, row + x, width)) continue;
      cells[Math.floor(y / CELL) * cols + Math.floor(x / CELL)] = 1;
    }
  }

  // Join marked cells into groups. Letters and words are a few pixels apart,
  // and some glyphs only have cores on their top and bottom rows, so bridge
  // small gaps both ways; stacked names are split apart again afterwards.
  const labels: Label[] = [];
  const seen = new Uint8Array(cols * rows);
  const stack: number[] = [];
  for (let start = 0; start < cells.length; start++) {
    if (!cells[start] || seen[start]) continue;
    let minCol = cols, maxCol = -1, minRow = rows, maxRow = -1;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const cell = stack.pop()!;
      const cx = cell % cols;
      const cy = (cell - cx) / cols;
      if (cx < minCol) minCol = cx;
      if (cx > maxCol) maxCol = cx;
      if (cy < minRow) minRow = cy;
      if (cy > maxRow) maxRow = cy;
      for (let dy = -2; dy <= 2; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= rows) continue;
        for (let dx = -3; dx <= 3; dx++) {
          const nx = cx + dx;
          if (nx < 0 || nx >= cols) continue;
          const next = ny * cols + nx;
          if (cells[next] && !seen[next]) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }
    }

    const group = {
      left: Math.max(minCol * CELL - MARGIN, 0),
      top: minRow * CELL,
      right: Math.min((maxCol + 1) * CELL + MARGIN, width),
      bottom: Math.min((maxRow + 1) * CELL, height),
    };
    for (const line of splitLines(frame, group)) {
      const label = measureLabel(frame, line);
      if (label && !masked(label.centre.x, label.centre.y, masks)) labels.push(label);
    }
  }
  return labels;
}

/**
 * Splits an area into text lines. Every row of a line has some name-coloured
 * pixels (anti-aliased letter edges), apart from the odd row above a
 * descender's tail, so two or more empty rows separate two lines.
 */
function splitLines(frame: Frame, area: Rect): Rect[] {
  const { width, pixels } = frame;
  const lines: Rect[] = [];
  let lineTop = -1;
  let lastNameRow = -1;
  for (let y = area.top; y < area.bottom; y++) {
    let hasName = false;
    for (let x = area.left; x < area.right && !hasName; x++) hasName = isNameGrey(pixels[y * width + x]);
    if (!hasName) continue;
    if (lineTop >= 0 && y - lastNameRow > 2) {
      lines.push({ left: area.left, top: lineTop, right: area.right, bottom: lastNameRow + 1 });
      lineTop = -1;
    }
    if (lineTop < 0) lineTop = y;
    lastNameRow = y;
  }
  if (lineTop >= 0) lines.push({ left: area.left, top: lineTop, right: area.right, bottom: lastNameRow + 1 });
  return lines;
}

function hasDarkNeighbour(pixels: Uint32Array, i: number, width: number): boolean {
  for (const n of [i - 1, i + 1, i - width, i + width]) {
    const p = pixels[n];
    if (((p >> 16) & 0xff) < 60 && ((p >> 8) & 0xff) < 60 && (p & 0xff) < 60) return true;
  }
  return false;
}

/** Tightens a candidate box to its glyph cores and decides whether it's a name. */
function measureLabel(frame: Frame, area: Rect): Label | null {
  const { width, pixels } = frame;
  let left = area.right, right = -1, top = area.bottom, bottom = -1, count = 0;
  for (let y = area.top; y < area.bottom; y++) {
    for (let x = area.left; x < area.right; x++) {
      if (!isCore(pixels[y * width + x])) continue;
      count++;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (count < MIN_CORE_PIXELS) return null;
  const w = right - left + 1;
  const h = bottom - top + 1;
  if (w < MIN_WIDTH || w > MAX_WIDTH || h < MIN_HEIGHT || h > MAX_HEIGHT) return null;

  // Most of the box's light grey pixels should come from the name palette;
  // scenery that happens to contain white fails this. Coloured light (a
  // spell's glow behind the name) doesn't count either way.
  let bright = 0, palette = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const p = pixels[y * width + x];
      const r = (p >> 16) & 0xff, g = (p >> 8) & 0xff, b = p & 0xff;
      if (r < 150 || g < 150 || b < 150 || Math.max(r, g, b) - Math.min(r, g, b) > 24) continue;
      bright++;
      if (isNearNameGrey(p)) palette++;
    }
  }
  if (palette < bright * 0.75) return null;

  const box = { left, top, right: right + 1, bottom: bottom + 1 };
  if (startsWithDash(frame, box)) return null;
  const glyphs = glyphsOf(frame, box);
  return {
    box,
    centre: { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) },
    glyphs,
    width: box.right - box.left,
    fingerprint: glyphs.map((glyph) => glyph.key).join('|'),
    quest: hasQuestLine(frame, box),
  };
}

/**
 * Cuts a label into glyphs at columns without any pure-white pixels. Each
 * glyph's key records its pixels and how high it sits relative to the line's
 * baseline, so a word gives the same keys even when part of the label is hidden.
 */
function glyphsOf(frame: Frame, box: Rect): Glyph[] {
  const { width, pixels } = frame;
  const runs: { left: number; right: number; top: number; bottom: number }[] = [];
  let run: (typeof runs)[number] | null = null;
  for (let x = box.left; x < box.right; x++) {
    let top = -1, bottom = -1;
    for (let y = box.top; y < box.bottom; y++) {
      if (!isCore(pixels[y * width + x])) continue;
      if (top < 0) top = y;
      bottom = y;
    }
    if (top < 0) {
      run = null;
      continue;
    }
    if (!run) {
      run = { left: x, right: x, top, bottom };
      runs.push(run);
    } else {
      run.right = x;
      run.top = Math.min(run.top, top);
      run.bottom = Math.max(run.bottom, bottom);
    }
  }

  // The baseline is where most glyphs end (descenders like g and y go lower).
  const bottoms = new Map<number, number>();
  for (const r of runs) bottoms.set(r.bottom, (bottoms.get(r.bottom) ?? 0) + 1);
  let baseline = box.bottom - 1, most = 0;
  for (const [bottom, count] of bottoms) {
    if (count > most || (count === most && bottom < baseline)) {
      baseline = bottom;
      most = count;
    }
  }

  return runs.map((r) => {
    const glyphBox = { left: r.left, top: r.top, right: r.right + 1, bottom: r.bottom + 1 };
    return { key: `${r.top - baseline}:${fingerprint(frame, glyphBox)}`, left: r.left, right: r.right };
  });
}

/**
 * Damage numbers use the same white font as names but start with a minus
 * sign: a first character only a row or two tall. Names start with a
 * full-height capital.
 */
function startsWithDash(frame: Frame, box: Rect): boolean {
  const { width, height, pixels } = frame;
  const top = Math.max(box.top - 1, 0);
  const bottom = Math.min(box.bottom + 1, height);
  let glyphTop = Infinity, glyphBottom = -1;
  for (let x = Math.max(box.left - 1, 0); x < box.right; x++) {
    let columnHasInk = false;
    for (let y = top; y < bottom; y++) {
      if (!isNameGrey(pixels[y * width + x])) continue;
      columnHasInk = true;
      if (y < glyphTop) glyphTop = y;
      if (y > glyphBottom) glyphBottom = y;
    }
    // The first empty column after some ink ends the first character.
    if (!columnHasInk && glyphBottom >= 0) break;
  }
  return glyphBottom >= 0 && glyphBottom - glyphTop + 1 <= 2;
}

/** The pure-white pixel layout of `box` as a compact string. */
export function fingerprint(frame: Frame, box: Rect): string {
  const { width, pixels } = frame;
  const bits: number[] = [];
  let byte = 0, count = 0;
  for (let y = box.top; y < box.bottom; y++) {
    for (let x = box.left; x < box.right; x++) {
      byte = (byte << 1) | (isCore(pixels[y * width + x]) ? 1 : 0);
      if (++count === 8) {
        bits.push(byte);
        byte = 0;
        count = 0;
      }
    }
  }
  if (count) bits.push(byte << (8 - count));
  return `${box.right - box.left}x${box.bottom - box.top}:${Buffer.from(bits).toString('base64')}`;
}

function hasQuestLine(frame: Frame, box: Rect): boolean {
  const { width, height, pixels } = frame;
  let orange = 0;
  for (let y = box.bottom; y < Math.min(box.bottom + 16, height); y++) {
    for (let x = Math.max(box.left - 20, 0); x < Math.min(box.right + 20, width); x++) {
      if ((pixels[y * width + x] & 0xffffff) === ORANGE && ++orange >= 8) return true;
    }
  }
  return false;
}

/** Finds the white text inside `area` (e.g. the target frame's name) as a single label. */
export function readText(frame: Frame, area: Rect): { box: Rect; fingerprint: string } | null {
  const { width, pixels } = frame;
  let left = area.right, right = -1, top = area.bottom, bottom = -1;
  for (let y = area.top; y < area.bottom; y++) {
    for (let x = area.left; x < area.right; x++) {
      if (!isCore(pixels[y * width + x])) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) return null;
  const box = { left, top, right: right + 1, bottom: bottom + 1 };
  return { box, fingerprint: fingerprint(frame, box) };
}

/** Items on the ground have their name in a box; the border colour shows the rarity. */
const ITEM_BORDERS = new Map<number, number>([
  [0xb8bec2, 0], // common: light grey
  [0x87cefa, 1], // light sky blue
  [0x9acd32, 2], // yellow-green
  [0xffd700, 3], // gold
]);
const MIN_ITEM_WIDTH = 16;
const MIN_ITEM_HEIGHT = 10;
const MAX_ITEM_HEIGHT = 24;

export interface Item {
  centre: Point;
  /** 0 for common items, higher for rarer border colours. */
  rarity: number;
}

/** Finds item labels (boxed names on the ground), skipping anything inside `masks`. */
export function findItems(frame: Frame, masks: Rect[]): Item[] {
  const { width, height, pixels } = frame;
  const items: Item[] = [];
  for (let y = 1; y < height - MIN_ITEM_HEIGHT; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const colour = pixels[row + x] & 0xffffff;
      // Every border colour has a green channel of at least 0xbe; most pixels don't.
      if (((colour >> 8) & 0xff) < 0xbe) continue;
      const rarity = ITEM_BORDERS.get(colour);
      if (rarity === undefined) continue;

      // A horizontal run of border colour: maybe the top edge of a box.
      const left = x;
      while (x + 1 < width && (pixels[row + x + 1] & 0xffffff) === colour) x++;
      const right = x;
      if (right - left + 1 < MIN_ITEM_WIDTH) continue;
      // Only top edges: the row above isn't border.
      if ((pixels[row - width + left + 1] & 0xffffff) === colour) continue;

      const item = findBoxBottom(pixels, width, height, colour, left, right, y);
      if (item && !masked(item.x, item.y, masks)) items.push({ centre: item, rarity });
    }
  }
  return items;
}

/** Given a box's top edge, finds its bottom edge and returns the box centre. */
function findBoxBottom(pixels: Uint32Array, width: number, height: number, colour: number, left: number, right: number, top: number): Point | null {
  const is = (x: number, y: number) => (pixels[y * width + x] & 0xffffff) === colour;
  for (let h = MIN_ITEM_HEIGHT; h <= MAX_ITEM_HEIGHT && top + h < height; h++) {
    const bottom = top + h;
    // Corners are sometimes clipped, so check just inside them.
    if (!is(left + 1, bottom) || !is(right - 1, bottom) || !is((left + right) >> 1, bottom)) continue;
    if (!is(left, top + (h >> 1)) || !is(right, top + (h >> 1))) continue;
    return { x: (left + right) >> 1, y: top + (h >> 1) };
  }
  return null;
}

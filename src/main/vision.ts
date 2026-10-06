import type { Point } from '../shared/types';

/** A captured frame: top-down 32-bit BGRA, readable per byte or per pixel. */
export interface Frame {
  width: number;
  height: number;
  bytes: Uint8Array;
  /** One little-endian uint32 per pixel: 0xAARRGGBB. */
  pixels: Uint32Array;
}

export function createFrame(width: number, height: number): Frame {
  const buffer = new ArrayBuffer(width * height * 4);
  return { width, height, bytes: new Uint8Array(buffer), pixels: new Uint32Array(buffer) };
}

const RGB = 0x00ffffff;
const BLACK = 0x000000;
const MAP_BORDER = 0xc6a663; // R198 G166 B99
const MAP_CHARACTER = 0x00ffff; // R0 G255 B255

/** Top-left corner of the big map's border, searched in the top-left of the frame. */
export function findMapTopLeft(frame: Frame): Point | null {
  const { width, height, pixels } = frame;
  const maxY = Math.min(Math.floor(height / 4) + 300, height - 1);
  const maxX = Math.min(Math.floor(width / 4) + 300, width - 1);
  for (let y = 0; y < maxY; y++) {
    for (let x = 0; x < maxX; x++) {
      const i = y * width + x;
      if (
        (pixels[i] & RGB) === MAP_BORDER &&
        (pixels[i + 1] & RGB) === MAP_BORDER &&
        (pixels[i + width] & RGB) === MAP_BORDER &&
        (pixels[i + width + 1] & RGB) === BLACK
      ) {
        return { x, y };
      }
    }
  }
  return null;
}

/** Bottom-right corner of the big map's border, searched in the bottom-right of the frame. */
export function findMapBottomRight(frame: Frame): Point | null {
  const { width, height, pixels } = frame;
  for (let y = Math.floor(height / 2); y < height - 1; y++) {
    for (let x = Math.floor(width / 2); x < width - 1; x++) {
      const i = y * width + x;
      if (
        (pixels[i] & RGB) === BLACK &&
        (pixels[i + 1] & RGB) === MAP_BORDER &&
        (pixels[i + width] & RGB) === MAP_BORDER &&
        (pixels[i + width + 1] & RGB) === MAP_BORDER
      ) {
        return { x, y };
      }
    }
  }
  return null;
}

/** Position of the player marker, in map coordinates (relative to the map's top-left). */
export function findCharacterOnMap(frame: Frame, topLeft: Point, bottomRight: Point): Point | null {
  const { width, pixels } = frame;
  const mapWidth = bottomRight.x - topLeft.x;
  const mapHeight = bottomRight.y - topLeft.y;
  for (let y = 0; y < mapHeight - 1; y++) {
    const row = (topLeft.y + y) * width + topLeft.x;
    for (let x = 0; x < mapWidth - 1; x++) {
      if ((pixels[row + x] & RGB) === MAP_CHARACTER) return { x, y };
    }
  }
  return null;
}

/** With the bag open, the last slot shows its empty background colour unless it holds an item. */
export function isBagFull(frame: Frame): boolean {
  const i = (497 * frame.width + 1558) * 4;
  const { bytes } = frame;
  return bytes[i] !== 12 && bytes[i + 1] !== 12 && bytes[i + 2] !== 24;
}

/** Which pixels count as the filled part of a bar. */
export type FillTest = (pixel: number) => boolean;

export const targetHpFill: FillTest = (p) => {
  const r = (p >> 16) & 0xff;
  return r >= 50 && ((p >> 8) & 0xff) * 2.2 <= r && (p & 0xff) * 2.2 <= r;
};
export const playerHpFill: FillTest = (p) => ((p >> 16) & 0xff) >= 80 && ((p >> 8) & 0xff) <= 40 && (p & 0xff) <= 40;
export const playerMpFill: FillTest = (p) => (p & 0xff) >= 90 && ((p >> 16) & 0xff) <= 40;

function isBarEmpty(p: number): boolean {
  return ((p >> 16) & 0xff) <= 20 && ((p >> 8) & 0xff) <= 20 && (p & 0xff) <= 20;
}

/**
 * How full a horizontal bar is, from 0 to 1, or null if the bar isn't on
 * screen. Pixels between `skip.from` and `skip.to` (the "hp / max" text
 * drawn over the bar) are ignored.
 */
export function readBar(
  frame: Frame,
  bar: { left: number; right: number; y: number },
  isFill: FillTest,
  skip?: { from: number; to: number },
): number | null {
  const row = bar.y * frame.width;
  let known = 0, other = 0, lastFill = -1;
  for (let x = bar.left; x <= bar.right; x++) {
    if (skip && x >= skip.from && x < skip.to) continue;
    const p = frame.pixels[row + x];
    if (isFill(p)) {
      known++;
      lastFill = x;
    } else if (isBarEmpty(p)) {
      known++;
    } else {
      other++;
    }
  }
  if (known < (known + other) * 0.85) return null;
  if (lastFill < 0) return 0;

  // If the fill stops just before the text and is empty right after it, the
  // real edge is somewhere under the text: call it the middle.
  if (skip && lastFill === skip.from - 1 && !isFill(frame.pixels[row + skip.to])) {
    lastFill = Math.round((skip.from + skip.to) / 2);
  }
  return Math.min(1, (lastFill - bar.left + 1) / (bar.right - bar.left + 1));
}

/** The light (text) pixels of an area as a string: equal strings mean the same text. */
export function textSignature(frame: Frame, area: { left: number; top: number; right: number; bottom: number }): string {
  const { width, pixels } = frame;
  const bits: number[] = [];
  let byte = 0, count = 0;
  for (let y = area.top; y < area.bottom; y++) {
    for (let x = area.left; x < area.right; x++) {
      const p = pixels[y * width + x];
      const light = ((p >> 16) & 0xff) >= 160 && ((p >> 8) & 0xff) >= 160 && (p & 0xff) >= 160;
      byte = (byte << 1) | (light ? 1 : 0);
      if (++count === 8) {
        bits.push(byte);
        byte = 0;
        count = 0;
      }
    }
  }
  if (count) bits.push(byte << (8 - count));
  return Buffer.from(bits).toString('base64');
}

/**
 * A coarse sample of the play area, for telling whether the view scrolled
 * (i.e. the player actually moved) between two frames.
 */
export function viewSignature(frame: Frame): Uint8Array {
  const samples: number[] = [];
  for (let y = 140; y < 780; y += 20) {
    for (let x = 320; x < 1280; x += 20) samples.push((frame.pixels[y * frame.width + x] >> 8) & 0xff);
  }
  return Uint8Array.from(samples);
}

/** Average per-sample difference between two view signatures (0-255). */
export function signatureDifference(a: Uint8Array, b: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return total / a.length;
}

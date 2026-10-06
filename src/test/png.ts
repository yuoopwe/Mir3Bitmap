import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { createFrame, type Frame } from '../main/vision';

/** Minimal decoder for 8-bit RGB/RGBA, non-interlaced PNGs (enough for test screenshots). */
export function loadPng(path: string): Frame {
  const data = readFileSync(path);
  let offset = 8;
  let width = 0, height = 0, channels = 0;
  const idat: Buffer[] = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [bitDepth, colourType, , , interlace] = body.subarray(8, 13);
      if (bitDepth !== 8 || interlace !== 0 || (colourType !== 2 && colourType !== 6)) {
        throw new Error(`Unsupported PNG: depth ${bitDepth}, colour type ${colourType}, interlace ${interlace}`);
      }
      channels = colourType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(body);
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const current = Buffer.alloc(stride);
  const previous = Buffer.alloc(stride);
  const frame = createFrame(width, height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? current[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      current[i] = value & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      frame.bytes[o] = current[x * channels + 2];
      frame.bytes[o + 1] = current[x * channels + 1];
      frame.bytes[o + 2] = current[x * channels];
      frame.bytes[o + 3] = 255;
    }
    current.copy(previous);
  }
  return frame;
}

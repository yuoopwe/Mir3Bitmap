// Saves what the bot sees of the game whenever the screen changes, for calibrating new screens
// (e.g. a Triple Triad match). Run from the project folder:
//   npm run build && npx electron scripts/record-frames.js [minutes]
// Frames go to recordings/<time>/; stop early with Ctrl+C.
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const minutes = Number(process.argv[2]) || 5;
const INTERVAL_MS = 700;
/** Average per-sample change (0-255) needed to save a new frame. */
const CHANGED = 1.5;

app.whenReady().then(async () => {
  const win = require('../dist/main/win32.js');
  const { createFrame } = require('../dist/main/vision.js');
  const hwnd = win.findWindow('Legend of Mir III - Xtreme Edition');
  if (!hwnd) {
    console.log('Game window not found');
    return app.quit();
  }
  const folder = path.join('recordings', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(folder, { recursive: true });
  const frame = createFrame(1600, 900);
  let last = null;
  let saved = 0;
  const until = Date.now() + minutes * 60_000;
  console.log(`Recording for ${minutes} min into ${folder} (Ctrl+C to stop)`);
  while (Date.now() < until) {
    try {
      win.captureClient(hwnd, 'print', 1600, 900, frame.bytes);
    } catch {
      // The capture fails now and then (e.g. while the game is minimized): try again shortly.
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
      continue;
    }
    const sample = [];
    for (let i = 0; i < frame.pixels.length; i += 997) sample.push((frame.pixels[i] >> 8) & 0xff);
    const change = last ? sample.reduce((s, v, i) => s + Math.abs(v - last[i]), 0) / sample.length : Infinity;
    if (change >= CHANGED) {
      const copy = Buffer.from(frame.bytes);
      for (let i = 3; i < copy.length; i += 4) copy[i] = 255;
      const name = path.join(folder, `${String(++saved).padStart(4, '0')}.png`);
      fs.writeFileSync(name, nativeImage.createFromBitmap(copy, { width: 1600, height: 900 }).toPNG());
      last = sample;
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  console.log(`Saved ${saved} frames to ${folder}`);
  app.quit();
});

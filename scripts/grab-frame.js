// Saves what the bot sees of the game window to frame-print.png and frame-blt.png.
// Run with: npm run build && npx electron scripts/grab-frame.js
const { app, nativeImage } = require('electron');
const fs = require('node:fs');

app.whenReady().then(() => {
  const win = require('../dist/main/win32.js');
  const hwnd = win.findWindow(process.argv[2] || 'Legend of Mir III - Xtreme Edition');
  if (!hwnd) {
    console.log('Game window not found');
    return app.quit();
  }
  const { width, height } = win.clientSize(hwnd);
  for (const method of ['print', 'blt']) {
    const buf = Buffer.alloc(width * height * 4);
    const start = performance.now();
    win.captureClient(hwnd, method, width, height, buf);
    const ms = performance.now() - start;
    for (let i = 3; i < buf.length; i += 4) buf[i] = 255;
    fs.writeFileSync(`frame-${method}.png`, nativeImage.createFromBitmap(buf, { width, height }).toPNG());
    console.log(`${method}: ${width}x${height} in ${ms.toFixed(1)} ms -> frame-${method}.png`);
  }
  app.quit();
});

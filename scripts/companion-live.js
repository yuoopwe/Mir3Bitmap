// Runs the memory reader and prints, about once a second, the companion as the bot sees it: whether one is out, its
// bag (slots used of those it has, weight of the most), whether a transfer is moving items, and the transfer's
// confirmation box. For checking the reading against the game while pressing the Companion Transfer key by hand.
//
//   node scripts/companion-live.js [seconds]
const { spawn } = require('node:child_process');
const path = require('node:path');

const seconds = Number(process.argv[2] ?? 60);
const reader = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'game-reader', 'reader.ps1'), '-ParentPid', String(process.pid)], {
  windowsHide: true,
});
let buffer = '';
let last = '';
let shownAt = 0;
reader.stdout.setEncoding('utf8');
reader.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line.startsWith('{')) continue;
    let reading;
    try {
      reading = JSON.parse(line);
    } catch {
      continue;
    }
    if (!reading.inGame) continue;
    const c = reading.companion;
    const text = !c
      ? 'No companion out'
      : `${c.name ?? 'Companion'} lv ${c.level} (exp ${c.experience}${c.maxExperience ? `/${c.maxExperience}` : ''}, hunger ${c.hunger}${c.maxHunger ? `/${c.maxHunger}` : ''}): ` +
        `bag ${c.bag?.used}/${c.bag?.slots ?? '?'} slots, weight ${c.bag?.weight ?? '?'}/${c.bag?.maxWeight ?? '?'}` +
        `${c.bag?.transferring ? ', transferring' : ''}${c.window ? ', window open' : ''}` +
        `${c.confirm ? `; confirm box: "${c.confirm.text}" at ${c.confirm.x},${c.confirm.y} ${c.confirm.width}x${c.confirm.height}${c.confirm.enabled ? '' : ' (disabled)'}` : ''}`;
    // Every change at once, and the same once a second.
    if (text !== last || Date.now() - shownAt > 1000) {
      console.log(`${new Date().toLocaleTimeString()}  ${text}`);
      last = text;
      shownAt = Date.now();
    }
  }
});
setTimeout(() => {
  reader.kill();
  process.exit(0);
}, seconds * 1000);

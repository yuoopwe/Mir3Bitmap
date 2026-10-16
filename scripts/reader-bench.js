// Measures the memory reader against the running game: readings a second, the gaps between them (median, p90, p99,
// max, and the share over 100 ms; also without the gaps around a map change, which reads the new map's walls), and
// how much of one CPU core the reader takes.
// Usage: node scripts/reader-bench.js [seconds=60] [--legacy]   (--legacy: the old all-PowerShell reader)
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const legacy = process.argv.includes('--legacy');
const seconds = Number(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 60);
const script = path.join(__dirname, '..', 'game-reader', legacy ? 'reader-legacy.ps1' : 'reader.ps1');

/** CPU time (ms) the process has used so far (on Linux with the processes it started: pwsh can be a launcher there). */
function cpuMs(pid) {
  if (process.platform === 'linux') {
    const stats = new Map();
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const fields = fs.readFileSync(`/proc/${entry}/stat`, 'utf8').split(') ')[1].split(' ');
        // Parent, and utime and stime in clock ticks (100 a second).
        stats.set(Number(entry), { parent: Number(fields[1]), ms: ((Number(fields[11]) + Number(fields[12])) * 1000) / 100 });
      } catch {
        // Gone meanwhile.
      }
    }
    const tree = new Set([pid]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [id, s] of stats) if (!tree.has(id) && tree.has(s.parent)) tree.add(id), (grew = true);
    }
    return [...tree].reduce((sum, id) => sum + (stats.get(id)?.ms ?? 0), 0);
  }
  const out = execFileSync('pwsh', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`], { encoding: 'utf8', windowsHide: true });
  return Number(out.trim());
}

const child = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ParentPid', String(process.pid)], { windowsHide: true });
/** In-game readings: when each came, and whether it came with a map's walls (a new map, or the first reading). */
const readings = [];
let buffer = '';
let started = null;
let lastReason = 'no reading';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line.startsWith('{')) continue;
    let state;
    try {
      state = JSON.parse(line);
    } catch {
      continue;
    }
    if (!state.inGame) {
      lastReason = state.reason ?? lastReason;
      continue;
    }
    const at = performance.now();
    // Timed from the first reading in game (the reader's start-up, compiling and attaching, isn't counted).
    if (!started) {
      started = { at, cpu: cpuMs(child.pid) };
      setTimeout(finish, seconds * 1000);
      console.log(`${legacy ? 'Legacy' : 'New'} reader in game; measuring for ${seconds} s...`);
    }
    readings.push({ at, walls: Boolean(state.map && state.map.walls) });
  }
});
let errors = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => (errors = (errors + chunk).slice(-4000)));
const giveUp = setTimeout(() => {
  if (started) return;
  console.log(`No reading in game within 60 s (${lastReason}). Is the game running, and are you in game?`);
  if (errors) console.log(`The reader's errors:\n${errors.trim()}`);
  child.kill();
  process.exit(1);
}, 60_000);

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : NaN);

function describe(label, gaps) {
  const sorted = [...gaps].sort((a, b) => a - b);
  const over = gaps.filter((g) => g > 100).length;
  const f = (ms) => `${Math.round(ms)} ms`;
  console.log(`${label}: median ${f(percentile(sorted, 50))}, p90 ${f(percentile(sorted, 90))}, p99 ${f(percentile(sorted, 99))}, max ${f(sorted.at(-1) ?? NaN)}; over 100 ms: ${((over / Math.max(1, gaps.length)) * 100).toFixed(1)}%`);
}

function finish() {
  clearTimeout(giveUp);
  const elapsed = performance.now() - started.at;
  const cpu = cpuMs(child.pid) - started.cpu;
  child.kill();
  const gaps = [];
  const quiet = [];
  for (let i = 1; i < readings.length; i++) {
    const gap = readings[i].at - readings[i - 1].at;
    gaps.push(gap);
    // The gap that brought a new map's walls, and the one after, are the map change's.
    if (!readings[i].walls && !readings[i - 1].walls) quiet.push(gap);
  }
  console.log(`Readings: ${readings.length} in ${(elapsed / 1000).toFixed(1)} s = ${((readings.length - 1) / (elapsed / 1000)).toFixed(1)} a second`);
  describe('Gaps', gaps);
  describe('Gaps outside map changes', quiet);
  if (process.env.BENCH_GAPS) console.log('Longest gaps (s into the run: ms):', readings.slice(1).map((r, i) => [((r.at - started.at) / 1000).toFixed(1), Math.round(r.at - readings[i].at)]).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t, g]) => `${t}: ${g}`).join(', '));
  console.log(`CPU: ${((cpu / elapsed) * 100).toFixed(1)}% of one core`);
  process.exit(0);
}

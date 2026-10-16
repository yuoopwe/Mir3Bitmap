// Runs the memory reader (game-reader/reader.ps1) and the old all-PowerShell one (reader-legacy.ps1) side by side
// against the running game, and says where their readings differ: keys missing on one side, types that differ, and
// values that should agree. Each old reading is paired with the new one taken closest in time. Things that move
// (positions, health, what's about) are allowed a little: positions 2 tiles, the objects about a 90% overlap of ids.
// Stand somewhere quiet-ish, open a few windows (bag, a shop, the quest list) while it runs for a fuller check.
// Usage: node scripts/reader-parity.js [seconds=60]
const { spawn } = require('node:child_process');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const seconds = Number(process.argv[2] ?? 60);
const folder = path.join(__dirname, '..', 'game-reader');
/** A pair is only compared when its readings were taken this close (ms). */
const PAIR_MS = 150;
/** Within this many tiles, a position counts as the same. */
const TILES = 2;
/** Paths that differ in more than this share of the pairs are reported as mismatches (a window opening between two
 * readings makes a few pairs differ, as it should). */
const REPORT_SHARE = 0.05;

// Sent only when they change (walls, explored blocks), or taken at a moment that differs from one reader to the other.
const SKIPPED = new Set([
  'map.walls', 'map.explored', 'map.revision', 'user.combatAgo', 'user.mouseTile', 'user.experience', 'user.hp', 'user.dead',
  // Only the new reader sends these.
  'user.mp', 'user.maxMp', 'user.id', 'user.mouseObject',
  'objects', 'known',
  // The old reader cut set bonuses' stats short, to the text "System.Collections.Hashtable".
  'gear.worn[].set.bonuses[].stats', 'gear.bag[].set.bonuses[].stats',
]);
// Lists whose order says nothing (the old reader kept these in a hashtable): compared as sets.
const UNORDERED = new Set(['questTargets', 'gear.counts', 'collection.cards', 'gear.worn[].set.bonuses', 'gear.bag[].set.bonuses']);
// Read about once a second, a part a tick, by both: either can be up to a second behind the other. These match when
// any new reading within SLOW_MS of the old one has the same.
const SLOW = ['questTargets', 'questLog', 'questPending', 'gear', 'known', 'professions', 'bloodline', 'autoPotion'];
const SLOW_MS = 1500;

function start(script) {
  const readings = [];
  /** What it printed on stderr (the last of it), for saying why there were no readings. */
  const errors = [];
  const child = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(folder, script), '-ParentPid', String(process.pid)], { windowsHide: true });
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith('{')) continue;
      try {
        readings.push({ at: performance.now(), state: JSON.parse(line) });
      } catch {
        // Cut short: skipped.
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    errors.push(chunk);
    if (errors.length > 20) errors.shift();
  });
  return { child, readings, errors };
}

const kind = (v) => (v === null || v === undefined ? 'null' : Array.isArray(v) ? 'array' : typeof v);
const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

/** path -> { pairs differing, an example } */
const differences = new Map();
/** The differences found by the comparison running now (path, and an example). */
let found = [];
function differ(where, what, legacy, fresh) {
  found.push([where, `${what}: legacy ${short(legacy)} / new ${short(fresh)}`]);
}
function count(list) {
  for (const [where, example] of new Map(list)) {
    const d = differences.get(where) ?? { count: 0, example };
    d.count++;
    differences.set(where, d);
  }
}
const short = (v) => {
  const s = v === undefined ? 'missing' : JSON.stringify(v);
  return s.length > 120 ? s.slice(0, 117) + '...' : s;
};

/** Compares one value of each reading, by path ("a.b[].c"); notes where they differ. */
function compare(legacy, fresh, where) {
  if (SKIPPED.has(where)) return;
  if (legacy === undefined || fresh === undefined) {
    if (legacy !== fresh) differ(where, legacy === undefined ? 'missing in legacy' : 'missing in new', legacy, fresh);
    return;
  }
  if (kind(legacy) !== kind(fresh)) return differ(where, 'type differs', legacy, fresh);
  if (kind(legacy) === 'array') {
    // The old reader sent a deck of two cards or more as [null] (a PowerShell pipeline quirk).
    if (where === 'triad.players[].deck' && legacy.length === 1 && legacy[0] === null && fresh.length > 1) return;
    if (UNORDERED.has(where)) {
      // Set bonuses: by the pieces they need only, as the old reader's stats came cut short.
      const key = where.endsWith('set.bonuses') ? (x) => String(x?.pieces) : canonical;
      const a = legacy.map(key).sort(), b = fresh.map(key).sort();
      if (a.join('\n') !== b.join('\n')) differ(where, 'values differ', legacy, fresh);
      return;
    }
    if (legacy.length !== fresh.length) return differ(where, 'lengths differ', legacy, fresh);
    for (let i = 0; i < legacy.length; i++) compare(legacy[i], fresh[i], `${where}[]`);
    return;
  }
  if (kind(legacy) === 'object') {
    if (UNORDERED.has(where)) {
      if (canonical(legacy) !== canonical(fresh)) differ(where, 'values differ', legacy, fresh);
      return;
    }
    for (const key of new Set([...Object.keys(legacy), ...Object.keys(fresh)])) compare(legacy[key], fresh[key], where ? `${where}.${key}` : key);
    return;
  }
  if (where === 'user.x' || where === 'user.y') {
    if (Math.abs(legacy - fresh) > TILES) differ(where, 'more than 2 tiles apart', legacy, fresh);
    return;
  }
  if (legacy !== fresh) differ(where, 'values differ', legacy, fresh);
}

/** The objects about: ids that overlap, and those in both the same but for where they are and their health. */
let overlapLow = 0, overlapSum = 0;
function compareObjects(legacy, fresh) {
  const a = new Map((legacy ?? []).map((o) => [o.id, o]));
  const b = new Map((fresh ?? []).map((o) => [o.id, o]));
  const both = [...a.keys()].filter((id) => b.has(id));
  const overlap = Math.max(a.size, b.size) === 0 ? 1 : both.length / Math.max(a.size, b.size);
  overlapSum += overlap;
  if (overlap < 0.9) overlapLow++;
  for (const id of both) {
    const x = a.get(id), y = b.get(id);
    for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
      const where = `objects[].${key}`;
      if (key === 'x' || key === 'y') {
        if (Math.abs(x[key] - y[key]) > TILES) differ(where, 'more than 2 tiles apart', x[key], y[key]);
      } else if (key !== 'hp' && key !== 'dead') compare(x[key], y[key], where);
    }
  }
}

const legacy = start('reader-legacy.ps1');
const fresh = start('reader.ps1');
console.log(`Reading for ${seconds} s with both readers...`);
setTimeout(() => {
  legacy.child.kill();
  fresh.child.kill();
  report();
}, seconds * 1000);

function report() {
  const inGame = (r) => r.state.inGame && r.state.user;
  const news = fresh.readings.filter(inGame);
  let pairs = 0;
  let j = 0;
  for (const old of legacy.readings.filter(inGame)) {
    while (j + 1 < news.length && Math.abs(news[j + 1].at - old.at) <= Math.abs(news[j].at - old.at)) j++;
    const near = news[j];
    if (!near || Math.abs(near.at - old.at) > PAIR_MS) continue;
    pairs++;
    // The old reader sent one window bare, not in a list.
    const oldState = { ...old.state, windows: old.state.windows && !Array.isArray(old.state.windows) ? [old.state.windows] : old.state.windows };
    found = [];
    compare(
      Object.fromEntries(Object.entries(oldState).filter(([k]) => !SLOW.includes(k))),
      Object.fromEntries(Object.entries(near.state).filter(([k]) => !SLOW.includes(k))),
      '',
    );
    compareObjects(oldState.objects, near.state.objects);
    const pairFound = found;
    for (const key of SLOW) {
      // The nearest new reading's differences, unless another close by has none.
      found = [];
      compare(oldState[key], near.state[key], key);
      if (found.length === 0) continue;
      const nearest = found;
      const close = news.filter((r) => Math.abs(r.at - old.at) <= SLOW_MS);
      if (close.some((r) => ((found = []), compare(oldState[key], r.state[key], key), found.length === 0))) continue;
      pairFound.push(...nearest);
    }
    count(pairFound);
  }
  console.log(`Readings: legacy ${legacy.readings.length} (${legacy.readings.filter(inGame).length} in game), new ${fresh.readings.length} (${news.length} in game); pairs compared: ${pairs}`);
  if (pairs === 0) {
    const reason = (r) => r.readings.at(-1)?.state.reason ?? 'no reading';
    console.log(`Nothing to compare (legacy: ${reason(legacy)}; new: ${reason(fresh)}). Is the game running, and are you in game?`);
    for (const [name, r] of [['legacy', legacy], ['new', fresh]]) if (r.errors.length) console.log(`${name} reader's errors:\n${r.errors.join('').trim()}`);
    process.exit(1);
  }
  console.log(`Objects about: ids overlap ${Math.round((overlapSum / pairs) * 100)}% on average, under 90% in ${overlapLow} of ${pairs} pairs`);
  const rows = [...differences.entries()].sort((a, b) => b[1].count - a[1].count);
  const reported = rows.filter(([, d]) => d.count / pairs > REPORT_SHARE);
  const minor = rows.length - reported.length;
  if (reported.length === 0) console.log('No key path differs in more than 5% of the pairs.');
  for (const [where, d] of reported) console.log(`  ${where}: ${d.count} of ${pairs} pairs (${Math.round((d.count / pairs) * 100)}%). ${d.example}`);
  if (minor > 0) console.log(`(${minor} more path(s) differ in 5% of the pairs or fewer: things that changed between the two readings.)`);
  for (const [where, d] of rows.filter(([, d]) => d.count / pairs <= REPORT_SHARE).slice(0, 10)) console.log(`    ${where}: ${d.count}. ${d.example}`);
  process.exit(reported.length === 0 && overlapLow <= pairs * REPORT_SHARE ? 0 : 1);
}

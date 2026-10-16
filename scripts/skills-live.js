// Prints, about once a second, what the memory reader says of the character's skills and buffs: the key set in use,
// each key's skill on it (its kind, level, how soon it's ready, its MP cost) and each timed buff's time left. For
// checking the reading against the game's own skill bar and buff icons before letting the bot cast by it.
// Usage: node scripts/skills-live.js [seconds=60]
const { spawn } = require('node:child_process');
const path = require('node:path');

const seconds = Number(process.argv[2] ?? 60);
const reader = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'game-reader', 'reader.ps1'), '-ParentPid', String(process.pid)], { windowsHide: true });
let buffer = '';
let latest = null;
let reason = 'no reading yet';
reader.stdout.setEncoding('utf8');
reader.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line.startsWith('{')) continue;
    try {
      const state = JSON.parse(line);
      if (state.inGame && state.user) latest = state;
      else reason = state.reason ?? reason;
    } catch {
      // Cut short: the next one will do.
    }
  }
});
reader.stderr.on('data', () => {});

/** The F-key a SpellKey is (Spell01-Spell12 are F1-F12), or the SpellKey itself for the rest. */
const keyName = (spellKey) => {
  const n = /^Spell(\d+)$/.exec(spellKey ?? '');
  return n && Number(n[1]) <= 12 ? `F${Number(n[1])}` : spellKey;
};

function show() {
  const user = latest?.user;
  if (!user) return console.log(`(${reason})`);
  if (!user.skills) return console.log('The reading has no skills (the game has no UserObject.Magics, or the reader is the legacy one).');
  const set = user.spellSet ?? 1;
  const buffs = user.buffs ?? [];
  const lines = [`Key set ${set}${user.spellSet === undefined ? ' (not read: assumed)' : ''}; MP ${user.mp ?? '?'} of ${user.maxMp ?? '?'}`];
  const bound = user.skills.filter((s) => s.keys?.[set - 1]).sort((a, b) => (a.keys[set - 1] < b.keys[set - 1] ? -1 : 1));
  for (const s of bound) {
    const buff = buffs.find((b) => b.source === s.magic);
    const kind = s.school === 'Passive' ? 'passive' : buff ? 'buff' : 'castable';
    const ready = s.readyIn > 0 ? `ready in ${s.readyIn.toFixed(1)} s` : 'ready';
    const left = buff ? `, its buff ${buff.left === null ? 'permanent' : `${buff.left.toFixed(1)} s left`}${buff.paused ? ' (paused)' : ''}` : '';
    lines.push(`  ${keyName(s.keys[set - 1]).padEnd(7)} ${s.name} (lv ${s.level}, ${s.school}) ${kind}: ${ready}, ${s.cost} MP, delay ${s.delay} ms${left}`);
  }
  const unbound = user.skills.filter((s) => !s.keys?.[set - 1]).map((s) => s.name);
  if (unbound.length) lines.push(`  Not on this key set: ${unbound.join(', ')}`);
  const timed = buffs.filter((b) => b.left !== null);
  lines.push(`  Buffs: ${timed.length ? timed.map((b) => `${b.type}${b.source ? ` (from ${b.source})` : ''}${b.item ? ` (item ${b.item})` : ''} ${b.left.toFixed(1)} s${b.paused ? ' paused' : ''}`).join(', ') : 'none timed'}${buffs.length > timed.length ? `; ${buffs.length - timed.length} permanent` : ''}`);
  console.log(lines.join('\n') + '\n');
}

const timer = setInterval(show, 1000);
setTimeout(() => {
  clearInterval(timer);
  reader.kill();
  process.exit(0);
}, seconds * 1000);

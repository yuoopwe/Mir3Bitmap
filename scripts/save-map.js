// Saves the map the player is on (walls, explored blocks, where the player is)
// from the game's memory to src/test/fixture-map-<name>.json, for testing the
// explore planner on real maps. Usage: node scripts/save-map.js
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const reader = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, '..', 'game-reader', 'reader.ps1')], { windowsHide: true });
let buffer = '';
let walls = null;
const timeout = setTimeout(() => finish('No map reading within 60 s (is the game running, and are you in game?)'), 60_000);

reader.stdout.setEncoding('utf8');
reader.stdout.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line.startsWith('{')) continue;
    const state = JSON.parse(line);
    const map = state.map;
    if (!state.inGame || !map) continue;
    // Walls come once per map; explored blocks whenever they change.
    if (map.walls) walls = { index: map.index, walls: map.walls };
    if (!walls || walls.index !== map.index || !map.explored) continue;
    const slug = map.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const file = path.join(__dirname, '..', 'src', 'test', `fixture-map-${slug}.json`);
    const fixture = { ...map, walls: walls.walls, player: { x: state.user.x, y: state.user.y } };
    fs.writeFileSync(file, JSON.stringify(fixture, null, 1) + '\n');
    finish(`Saved ${map.name} (${map.width}x${map.height}, player at ${state.user.x},${state.user.y}) to ${path.relative(process.cwd(), file)}`);
  }
});

function finish(message) {
  clearTimeout(timeout);
  console.log(message);
  reader.kill();
  process.exit(0);
}

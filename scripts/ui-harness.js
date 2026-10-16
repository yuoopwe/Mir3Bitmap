// Writes dist/ui-harness/index.html: the control window (src/renderer/index.html) with a stand-in bot
// (scripts/ui-stub.js) in front of the renderer, for trying the window in a browser without Electron or
// the game. Travel searches the real places in game-data/travel.json.
//
//   npm run ui-harness      (builds, writes the page and prints its address)
//
// In the page, uiStub (in the console) sends statuses, monsters and names, and lists the calls made.
// Not part of the app.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist', 'ui-harness');

if (!fs.existsSync(path.join(root, 'dist', 'renderer', 'renderer.js'))) {
  console.error('Build first: npm run build');
  process.exit(1);
}

const page = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const renderer = page.match(/<script src="[^"]*renderer\.js"><\/script>/);
if (!renderer) throw new Error("Can't find the renderer's <script> in src/renderer/index.html");
// Relative addresses resolve as they do for the real page; the stub goes in just before the renderer.
const harness = page
  .replace('<head>', '<head>\n    <base href="../../src/renderer/">')
  .replace(renderer[0], ['<script src="../../dist/ui-harness/places.js"></script>', '<script src="../../scripts/ui-stub.js"></script>', renderer[0]].join('\n    '));

const { loadTravelData, places } = require('../dist/main/travel.js');
const data = loadTravelData(path.join(root, 'game-data', 'travel.json'));
const list = places(data).map(({ id, label }) => ({ id, label }));
// The Areas tab: every map with monsters, and how a level 48 Warrior would fare on each.
const { searchAreas, areaView } = require('../dist/main/area-index.js');
const SAMPLE_WARRIOR = {
  minAC: 126, maxAC: 131, minMR: 61, maxMR: 121, minDC: 306, maxDC: 392, minMC: 0, maxMC: 0, minSC: 0, maxSC: 0,
  accuracy: 35, agility: 49, attackSpeed: 7, maxHp: 1266, cls: 0, level: 48,
};
const areas = data.maps.flatMap((m) => searchAreas(data, m.name, 1000).filter((a) => a.map === m.i));
const views = Object.fromEntries(areas.map((a) => [a.map, areaView(data, a.map, SAMPLE_WARRIOR, 'Level 48 Warrior (sample)')]));

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), harness);
fs.writeFileSync(
  path.join(out, 'places.js'),
  `window.uiStubPlaces = ${JSON.stringify(list)};\nwindow.uiStubAreas = ${JSON.stringify(areas)};\nwindow.uiStubAreaViews = ${JSON.stringify(views)};\n`,
);
console.log(pathToFileURL(path.join(out, 'index.html')).href);

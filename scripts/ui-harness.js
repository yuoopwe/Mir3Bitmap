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
const list = places(loadTravelData(path.join(root, 'game-data', 'travel.json'))).map(({ id, label }) => ({ id, label }));

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), harness);
fs.writeFileSync(path.join(out, 'places.js'), `window.uiStubPlaces = ${JSON.stringify(list)};\n`);
console.log(pathToFileURL(path.join(out, 'index.html')).href);

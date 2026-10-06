// Builds the Triple Triad digit templates (src/main/triad-digit-templates.ts) from labelled
// screenshots, and reports how well each digit is told apart (leave-one-out). Run after a build:
//   npm run build && node scripts/triad-templates.js [more recording folders...]
// Labels come from the list below, plus any card recognised by its picture in triad-cards.ts, plus
// scripts/triad-labels.json if it exists: a list of ["path/to/frame.png", "hand" | "board", slot or cell (0-8,
// left to right, top to bottom), [top, left, right, bottom]], with "A" written as 10.
const fs = require('node:fs');
const path = require('node:path');
const { loadPng } = require('../dist/test/png.js');
const { handSampler, boardSampler, cellOwner, fingerprint, difference } = require('../dist/main/triad-vision.js');
const { digitMaps, correlation, BOX_WIDTH, BOX_HEIGHT } = require('../dist/main/triad-digits.js');
const { KNOWN_CARDS } = require('../dist/main/triad-cards.js');

/** Cards labelled by hand: [file, 'hand' | 'board', slot or cell, [top, left, right, bottom]]. */
const LABELLED = [
  ['src/test/fixture-triad-hand2.png', 'hand', 0, [2, 6, 1, 2]],
  ['src/test/fixture-triad-hand2.png', 'hand', 1, [6, 2, 1, 1]],
  ['src/test/fixture-triad-hand2.png', 'hand', 2, [1, 1, 5, 4]],
  ['src/test/fixture-triad-hand2.png', 'hand', 3, [2, 4, 1, 4]],
  ['src/test/fixture-triad-hand2.png', 'hand', 4, [5, 3, 2, 5]],
  ['src/test/fixture-triad-lastcard.png', 'board', 0, [2, 6, 1, 2]],
  ['src/test/fixture-triad-lastcard.png', 'board', 1, [7, 5, 2, 3]],
  ['src/test/fixture-triad-lastcard.png', 'board', 2, [5, 4, 4, 5]],
  ['src/test/fixture-triad-lastcard.png', 'board', 3, [4, 3, 2, 4]],
  ['src/test/fixture-triad-lastcard.png', 'board', 5, [7, 4, 3, 4]],
  ['src/test/fixture-triad-lastcard.png', 'board', 6, [1, 1, 5, 4]],
  ['src/test/fixture-triad-lastcard.png', 'board', 8, [5, 5, 1, 3]],
  ...(JSON.parse(fs.existsSync('scripts/triad-labels.json') ? fs.readFileSync('scripts/triad-labels.json', 'utf8') : '[]')),
];

// Older screenshots: label the cards the picture library knows (positions as measured before).
const OLD_BOARD = [
  { top: 238, bottom: 323, columns: [[515, 592], [600, 677], [685, 762]] },
  { top: 335, bottom: 434, columns: [[503, 588], [596, 681], [689, 774]] },
  { top: 446, bottom: 561, columns: [[488, 583], [592, 685], [694, 789]] },
].flatMap((row) => row.columns.map(([left, right]) => ({ left, top: row.top, right, bottom: row.bottom })));
const OLD_HAND = [0, 1, 2, 3, 4].map((i) => ({ left: 245, top: 156 + 94 * i, right: 328, bottom: 245 + 94 * i }));
const printed = (card) => [card.top, card.left, card.right, card.bottom];

function identify(fp, where) {
  let best = null, bestDifference = Infinity;
  for (const known of KNOWN_CARDS) {
    const reference = where === 'hand' ? known.hand : known.board;
    if (!reference) continue;
    const d = difference(fp, reference);
    if (d < bestDifference) [best, bestDifference] = [known, d];
  }
  return bestDifference <= 8 ? best : null;
}

const autoFiles = [
  'src/test/fixture-triad-start.png',
  'src/test/fixture-triad-mid.png',
  'src/test/fixture-triad-over.png',
  ...['recordings/2026-10-04T11-09-05-835Z', ...process.argv.slice(2)].flatMap((dir) =>
    fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.png')).map((f) => path.join(dir, f)) : [],
  ),
];
const samples = []; // { layout, digit, maps, source }
const frames = new Map();
const frameOf = (file) => {
  if (!frames.has(file)) frames.set(file, loadPng(file));
  return frames.get(file);
};
function addCard(file, layout, index, digits) {
  const frame = frameOf(file);
  const sampler = layout === 'hand' ? handSampler(frame, index) : boardSampler(frame, index);
  digits.forEach((digit, slot) => samples.push({ layout, digit, group: `${layout} ${index} ${digits.join('')}`, row: layout === 'board' ? Math.floor(index / 3) : -1, maps: digitMaps(sampler, layout, slot), source: `${path.basename(file)} ${layout} ${index}.${slot}` }));
}

for (const [file, layout, index, digits] of LABELLED) addCard(file, layout, index, digits);
let auto = 0;
for (const file of autoFiles) {
  const frame = frameOf(file);
  OLD_HAND.forEach((rect, slot) => {
    const known = identify(fingerprint(frame, rect), 'hand');
    if (known) {
      addCard(file, 'hand', slot, printed(known.card));
      auto++;
    }
  });
  OLD_BOARD.forEach((rect, cell) => {
    if (!cellOwner(frame, cell)) return;
    const known = identify(fingerprint(frame, rect), 'board');
    if (known) {
      addCard(file, 'board', cell, printed(known.card));
      auto++;
    }
  });
  frames.delete(file);
}
console.log(`${samples.length} digit samples (${auto} cards recognised by picture)`);

/** Averages a digit's samples, each at the shift that best lines it up with the average so far. */
function build(list) {
  let template = list[0].maps[Math.floor(list[0].maps.length / 2)];
  for (let round = 0; round < 4; round++) {
    const sum = new Float32Array(template.length);
    for (const sample of list) {
      let best = null, bestScore = -2;
      for (const map of sample.maps) {
        const score = correlation(map, template);
        if (score > bestScore) [best, bestScore] = [map, score];
      }
      for (let i = 0; i < sum.length; i++) sum[i] += best[i];
    }
    template = sum.map((v) => v / list.length);
  }
  return template;
}

function classify(sample, templates) {
  const scores = [...templates].map(([digit, template]) => [digit, Math.max(...sample.maps.map((m) => correlation(m, template)))]);
  scores.sort((a, b) => b[1] - a[1]);
  return scores;
}

const output = { hand: {}, board: [] };
const centreMap = (sample) => sample.maps[Math.floor(sample.maps.length / 2)];

// Hand cards are drawn the same way every time: one average per digit.
{
  const mine = samples.filter((s) => s.layout === 'hand');
  const digits = [...new Set(mine.map((s) => s.digit))].sort((a, b) => a - b);
  console.log(`
hand: ${mine.length} samples (${digits.map((d) => `${d}: ${mine.filter((s) => s.digit === d).length}`).join(', ')})`);
  let right = 0, worstMargin = Infinity;
  for (const sample of mine) {
    const others = mine.filter((s) => s.group !== sample.group);
    const templates = new Map(digits.filter((d) => others.some((s) => s.digit === d)).map((d) => [d, build(others.filter((s) => s.digit === d))]));
    const [first, second] = classify(sample, templates);
    if (first[0] === sample.digit) {
      right++;
      worstMargin = Math.min(worstMargin, first[1] - (second?.[1] ?? 0));
    } else console.log(`  misread ${sample.source}: ${sample.digit} read as ${first[0]}`);
  }
  console.log(`  leaving each card out: ${right}/${mine.length} right, smallest winning margin ${worstMargin.toFixed(3)}`);
  for (const digit of digits) output.hand[digit] = Buffer.from(build(mine.filter((s) => s.digit === digit)).map((v) => Math.round(v * 255))).toString('base64');
}

// Board cards look a little different in each cell: keep every distinct example and read by the closest one.
{
  const mine = samples.filter((s) => s.layout === 'board');
  const nearest = (sample, pool) => {
    let best = null, bestScore = -2;
    for (const other of pool) {
      const reference = centreMap(other);
      for (const map of sample.maps) {
        const score = correlation(map, reference);
        if (score > bestScore) [best, bestScore] = [other.digit, score];
      }
    }
    return best;
  };
  let right = 0;
  for (const sample of mine) {
    if (nearest(sample, mine.filter((s) => s.group !== sample.group)) === sample.digit) right++;
    else console.log(`  misread ${sample.source}: ${sample.digit} read as ${nearest(sample, mine.filter((s) => s.group !== sample.group))}`);
  }
  console.log(`
board: ${mine.length} samples; leaving each card out: ${right}/${mine.length} right`);
  const kept = [];
  for (const sample of mine) {
    const map = centreMap(sample);
    if (kept.some((k) => k.digit === sample.digit && correlation(k.map, map) > 0.98)) continue;
    kept.push({ digit: sample.digit, map });
  }
  output.board = kept.map(({ digit, map }) => [digit, Buffer.from(map.map((v) => Math.round(v * 255))).toString('base64')]);
  console.log(`  kept ${kept.length} distinct examples`);
}

const file = path.join('src', 'main', 'triad-digit-templates.ts');
fs.writeFileSync(
  file,
  `// Average darkness maps of each digit (see triad-digits.ts), built by scripts/triad-templates.js
// from labelled screenshots: an average per digit for hand cards, and every distinct example for board cards.
// Each map is ${BOX_WIDTH} x ${BOX_HEIGHT} bytes, 0 to 255, base64.
export const DIGIT_TEMPLATES: { hand: Record<string, string>; board: [number, string][] } = ${JSON.stringify(output)};
`,
);
console.log(`\nWrote ${file}`);

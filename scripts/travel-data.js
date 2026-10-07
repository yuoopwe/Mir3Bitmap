// Builds game-data/travel.json for the Travel mode from the game database export
// (scripts/export-game-db.ps1) and the game's map files: every map, every link
// between maps (the tiles to step on and where you land), every placed NPC, and
// how many steps it is from each landing to each exit and NPC on that map (from
// the map files' walls), plus the waypoint stones and where each waypoint takes you. Run: node scripts/travel-data.js [game folder]
const fs = require('node:fs');
const path = require('node:path');

const GAME = process.argv[2] ?? 'E:\\Games\\Mir3 Servers\\Mir 3 - Xtreme Edition (All in One)';
const EXPORT = path.join(__dirname, '..', '_work', 'gamedb', 'export');
const OUT = path.join(__dirname, '..', 'game-data', 'travel.json');
/** NPCs placed in a region bigger than this wander about it: only their map is kept. */
const NPC_REGION_MAX = 60;

/** Library.RequiredClass: which classes may use a link (flags). */
const CLASS_FLAGS = { None: 0, Warrior: 1, Wizard: 2, Taoist: 4, WizTao: 6, WarWizTao: 7, Assassin: 8, Summoner: 16, SCOnly: 20, Druid: 32, MCOnly: 34, SumDru: 48, AllMinus: 55, Archer: 64, BladeDancer: 128, AssWarDan: 137, All: 255, Mimic: 256, AllIncludingMimic: 511, Anima: 512, AllIncludingSpecials: 1023 };
const classMask = (text) => String(text).split(/,s*/).reduce((mask, name) => mask | (CLASS_FLAGS[name] ?? 0), 0);

const read = (table) => fs.readFileSync(path.join(EXPORT, `${table}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const byIndex = (rows) => new Map(rows.map((r) => [r.Index, r]));
const maps = byIndex(read('MapInfo'));
const regions = byIndex(read('MapRegion'));

// ---- Map files: size and walls (the format MapControl reads; walls checked against the game's memory) ----
const files = new Map();
function mapFile(map) {
  const name = map.RuntimeFileName || map.FileName;
  if (files.has(name)) return files.get(name);
  let grid = null;
  const file = path.join(GAME, 'Map', `${name}.map`);
  if (fs.existsSync(file)) {
    const b = fs.readFileSync(file);
    const width = b[22] | (b[23] << 8), height = b[24] | (b[25] << 8);
    const base = 28 + Math.floor((width * height) / 4) * 3;
    // Anything else is a format this doesn't know: no walls for that map.
    if (width > 0 && height > 0 && Math.abs(base + width * height * 14 - b.length) <= 2) {
      const walls = new Uint8Array(width * height);
      for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) {
          const off = base + (x * height + y) * 14;
          const flag = off < b.length ? b[off] : 0;
          walls[y * width + x] = (flag & 1) !== 1 || (flag & 2) !== 2 ? 1 : 0;
        }
      }
      grid = { width, height, walls };
    }
  }
  files.set(name, grid);
  return grid;
}

/** A region's tiles: listed, or as bits over the map's width. */
function regionTiles(region) {
  if (!region) return [];
  if (region.PointRegion?.length) return region.PointRegion;
  if (region.BitRegion?.length) {
    const grid = mapFile(maps.get(region.Map?.Index) ?? {});
    if (!grid) return [];
    return region.BitRegion.map((i) => [i % grid.width, Math.floor(i / grid.width)]);
  }
  return [];
}

/** The floor tile nearest the middle of some tiles (where you'd be put, or stand). */
function middle(tiles, grid) {
  const cx = tiles.reduce((s, t) => s + t[0], 0) / tiles.length, cy = tiles.reduce((s, t) => s + t[1], 0) / tiles.length;
  const floor = grid ? tiles.filter(([x, y]) => !grid.walls[y * grid.width + x]) : tiles;
  const pool = floor.length ? floor : tiles;
  return pool.reduce((best, t) => (Math.hypot(t[0] - cx, t[1] - cy) < Math.hypot(best[0] - cx, best[1] - cy) ? t : best));
}

// ---- Links ----
const links = [];
for (const mv of read('MovementInfo')) {
  const source = regions.get(mv.SourceRegion?.Index), dest = regions.get(mv.DestinationRegion?.Index);
  const from = maps.get(source?.Map?.Index), to = maps.get(dest?.Map?.Index);
  if (!from || !to) continue;
  const exit = regionTiles(source), landing = regionTiles(dest);
  if (!exit.length || !landing.length) continue;
  const link = { id: mv.Index, from: from.Index, to: to.Index, exit, land: middle(landing, mapFile(to)) };
  // Links that need something the bot can't check are left out of routes.
  if (mv.NeedItem) link.needs = `item: ${mv.NeedItem.Name}`;
  else if (mv.NeedInstance || mv.NeedSpawn) link.needs = 'an instance or a spawn';
  // Only some classes (a mask of Library.RequiredClass); left out when every class may.
  const mask = classMask(mv.RequiredClass ?? 'All');
  if (mask && (mask & 1023) !== 1023 && (mask & 255) !== 255) link.cls = mask;
  links.push(link);
}

// ---- NPCs ----
// Waypoint stones: NPCs whose first page opens the waypoint window.
const summonPages = new Set(read('NPCAction').filter((a) => /SummonWaypointMenu/.test(a.ActionType)).map((a) => a.Page?.Index));
const npcs = [];
for (const n of read('NPCInfo')) {
  const region = regions.get(n.Region?.Index);
  const map = maps.get(region?.Map?.Index);
  if (!map || !n.NPCName) continue;
  const tiles = region.Size <= NPC_REGION_MAX ? regionTiles(region) : [];
  if (region.Size <= NPC_REGION_MAX && !tiles.length) continue;
  const npc = { id: n.Index, name: n.NPCName.replace(/\s+/g, ' ').trim(), map: map.Index, where: region.Description ?? '' };
  if (tiles.length) npc.at = middle(tiles, mapFile(map));
  if (summonPages.has(n.EntryPage?.Index)) npc.stone = true;
  npcs.push(npc);
}

// ---- Waypoints (where each takes you; picked in the window a stone opens) ----
const waypoints = [];
for (const w of read('WaypointInfo')) {
  const map = maps.get(w.Map?.Index);
  if (!map || w.DestinationKind !== 'WorldMap') continue;
  const tiles = w.X || w.Y ? [[w.X, w.Y]] : regionTiles(regions.get(w.Region?.Index));
  if (!tiles.length) continue;
  const waypoint = { id: w.Index, name: w.Name.trim(), map: map.Index, land: middle(tiles, mapFile(map)) };
  if (w.IsAlwaysAvailable) waypoint.always = true;
  if (w.Cost) waypoint.cost = w.Cost;
  waypoints.push(waypoint);
}

// ---- Maps ----
const used = new Set([...links.flatMap((l) => [l.from, l.to]), ...npcs.map((n) => n.map), ...waypoints.map((w) => w.map)]);
const mapList = [...used].map((i) => maps.get(i)).map((m) => {
  const grid = mapFile(m);
  const out = { i: m.Index, name: (m.Description || m.FileName).trim(), type: m.Type };
  if (grid) Object.assign(out, { w: grid.width, h: grid.height });
  if (m.MinimumLevel > 0) out.level = m.MinimumLevel;
  if (m.MaximumLevel > 0) out.maxLevel = m.MaximumLevel;
  return out;
});

// ---- Steps from each landing to each exit and NPC on its map ----
const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
function distances(grid, [sx, sy]) {
  const { width, height, walls } = grid;
  const dist = new Int32Array(width * height).fill(-1);
  const queue = new Int32Array(width * height);
  let head = 0, tail = 0;
  dist[sy * width + sx] = 0;
  queue[tail++] = sy * width + sx;
  while (head < tail) {
    const at = queue[head++], x = at % width, y = (at - x) / width;
    for (const [dx, dy] of STEPS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = ny * width + nx;
      if (dist[n] >= 0 || walls[n]) continue;
      // No squeezing diagonally between two walls (as map-explorer's canStep).
      if (dx && dy && walls[y * width + nx] && walls[ny * width + x]) continue;
      dist[n] = dist[at] + 1;
      queue[tail++] = n;
    }
  }
  return dist;
}
/** Steps to the nearest of `tiles`, or to a floor tile next to one (exits and NPCs can stand on walls). */
function stepsTo(grid, dist, tiles) {
  let best = -1;
  for (const [x, y] of tiles) {
    for (const [dx, dy] of [[0, 0], ...STEPS]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
      const d = dist[ny * grid.width + nx];
      if (d >= 0 && (best < 0 || d + (dx || dy ? 1 : 0) < best)) best = d + (dx || dy ? 1 : 0);
    }
  }
  return best;
}
const exitsOf = new Map();
for (const l of links) (exitsOf.get(l.from) ?? exitsOf.set(l.from, []).get(l.from)).push(l);
const npcsOf = new Map();
for (const n of npcs) if (n.at) (npcsOf.get(n.map) ?? npcsOf.set(n.map, []).get(n.map)).push(n);
let searched = 0;
// Waypoints have landings too: the same steps from where they put you.
for (const l of [...links, ...waypoints.map((w) => Object.assign(w, { to: w.map }))]) {
  const grid = mapFile(maps.get(l.to));
  if (!grid) continue;
  const dist = distances(grid, l.land);
  searched++;
  l.steps = {};
  for (const e of exitsOf.get(l.to) ?? []) {
    const s = stepsTo(grid, dist, e.exit);
    if (s >= 0) l.steps[e.id] = s;
  }
  l.npcSteps = {};
  for (const n of npcsOf.get(l.to) ?? []) {
    const s = stepsTo(grid, dist, [n.at]);
    if (s >= 0) l.npcSteps[n.id] = s;
  }
}

for (const w of waypoints) delete w.to;
fs.writeFileSync(OUT, JSON.stringify({ maps: mapList, links, npcs, waypoints }));
console.log(`travel.json: ${mapList.length} maps, ${links.length} links, ${npcs.length} NPCs (${npcs.filter((n) => n.stone).length} waypoint stones), ${waypoints.length} waypoints, ${searched} landings searched, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);

// Builds game-data/travel.json for the Travel mode from the game database export
// (scripts/export-game-db.ps1) and the game's map files: every map, every link
// between maps (the tiles to step on and where you land), every placed NPC, and
// how many steps it is from each landing to each exit and NPC on that map (from
// the map files' walls), plus the waypoint stones and where each waypoint takes you, and where monsters
// spawn on each map (for Hunt's seeking). Run: node scripts/travel-data.js [game folder]
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

// ---- Where monsters spawn: per map, squares of SPAWN_CELL tiles with how many monsters to expect there ----
const SPAWN_CELL = 24;
const monsterInfo = byIndex(read('MonsterInfo'));
/** Real monsters worth hunting: not guards, resource nodes or placeholders. */
const huntable = (m) => m && m.AI >= 0 && !m.Resource && m.Level > 0 && m.Level < 900 && m.MonsterName;
const monsterNames = [];
/** Per monster (same order as monsterNames): [level, experience per kill, health, 1 if a boss else 0]. */
const monsterStats = [];
const healthOf = new Map();
for (const st of read('MonsterInfoStat')) if (st.Stat === 'Health') healthOf.set(st.Monster?.Index, st.Amount);
const monsterIndex = new Map();
const nameIndex = (name, monster) => {
  if (!monsterIndex.has(name)) {
    monsterIndex.set(name, monsterNames.push(name) - 1);
    monsterStats.push([monster.Level, Number(monster.Experience) || 0, healthOf.get(monster.Index) ?? 0, monster.IsBoss || monster.IsSubBoss || monster.IsBehemoth ? 1 : 0]);
  }
  return monsterIndex.get(name);
};
// Each region's tiles, counted per square, with the floor tile nearest the square's middle.
const regionCells = new Map();
function cellsOf(region, grid) {
  if (regionCells.has(region.Index)) return regionCells.get(region.Index);
  const cells = new Map();
  let total = 0;
  for (const [x, y] of regionTiles(region)) {
    if (grid && grid.walls[y * grid.width + x]) continue;
    total++;
    const key = Math.floor(x / SPAWN_CELL) + ',' + Math.floor(y / SPAWN_CELL);
    const cx = (Math.floor(x / SPAWN_CELL) + 0.5) * SPAWN_CELL, cy = (Math.floor(y / SPAWN_CELL) + 0.5) * SPAWN_CELL;
    const d = Math.abs(x - cx) + Math.abs(y - cy);
    const cell = cells.get(key);
    if (!cell) cells.set(key, { tiles: 1, at: [x, y], d });
    else {
      cell.tiles++;
      if (d < cell.d) Object.assign(cell, { at: [x, y], d });
    }
  }
  const out = { cells, total };
  regionCells.set(region.Index, out);
  return out;
}
const spawnsByMap = new Map();
for (const r of read('RespawnInfo')) {
  if (r.EventSpawn) continue;
  const monster = monsterInfo.get(r.Monster?.Index);
  const region = regions.get(r.Region?.Index);
  const map = maps.get(region?.Map?.Index);
  if (!huntable(monster) || !map) continue;
  const { cells, total } = cellsOf(region, mapFile(map));
  if (!total) continue;
  const spots = spawnsByMap.get(map.Index) ?? spawnsByMap.set(map.Index, new Map()).get(map.Index);
  for (const [key, cell] of cells) {
    const spot = spots.get(key) ?? spots.set(key, { at: cell.at, n: 0, monsters: new Set() }).get(key);
    spot.n += ((r.Count || 1) * cell.tiles) / total;
    spot.monsters.add(nameIndex(monster.MonsterName, monster));
  }
}
// Each spot as [x, y, monsters expected, index into spawnSets]: the same few lists of monsters repeat a lot.
const spawns = {};
const spawnSets = [];
const setIndex = new Map();
for (const [mapIndex, spots] of spawnsByMap) {
  const list = [...spots.values()].filter((p) => p.n >= 0.2).map((p) => {
    const set = [...p.monsters].sort((a, b) => a - b);
    const key = set.join(',');
    if (!setIndex.has(key)) setIndex.set(key, spawnSets.push(set) - 1);
    return [p.at[0], p.at[1], Math.round(p.n * 10) / 10, setIndex.get(key)];
  });
  if (list.length) spawns[mapIndex] = list;
}

// ---- Quests picked up from an NPC (the rest start by themselves on entering a map) ----
// Each: who gives and takes it, the level and class it needs, the quests to have done first, its experience
// reward, and its tasks: kill (or collect drops from) monsters, go somewhere, or talk to someone.
const questTasks = new Map();
for (const t of read('QuestTask')) (questTasks.get(t.Quest?.Index) ?? questTasks.set(t.Quest?.Index, []).get(t.Quest?.Index)).push(t);
const taskMonsters = new Map();
for (const m of read('QuestTaskMonsterDetails')) (taskMonsters.get(m.Task?.Index) ?? taskMonsters.set(m.Task?.Index, []).get(m.Task?.Index)).push(m);
const questReqs = new Map();
for (const r of read('QuestRequirement')) (questReqs.get(r.Quest?.Index) ?? questReqs.set(r.Quest?.Index, []).get(r.Quest?.Index)).push(r);
const questExp = new Map();
for (const r of read('QuestReward')) if (r.Item?.Name === 'Experience') questExp.set(r.Quest?.Index, (questExp.get(r.Quest?.Index) ?? 0) + (r.Amount || 0));
const quests = [];
for (const q of read('QuestInfo')) {
  if (q.ActivationMode !== 'Manual' || !q.StartNPC || !q.FinishNPC || q.SeasonalOnly) continue;
  const quest = { id: q.Index, name: (q.DisplayName || q.QuestName || '').trim(), type: q.QuestType, start: q.StartNPC.Index, finish: q.FinishNPC.Index };
  // The quest log knows a quest by its internal name.
  if (q.QuestName && q.QuestName.trim() !== quest.name) quest.key = q.QuestName.trim();
  for (const r of questReqs.get(q.Index) ?? []) {
    if (r.Requirement === 'MinLevel') quest.level = Math.max(quest.level ?? 0, r.IntParameter1 || 0);
    else if (r.Requirement === 'HaveCompleted' && r.QuestParameter) (quest.after ??= []).push(r.QuestParameter.Index);
    else if (r.Requirement === 'Class' && r.Class && r.Class !== 'None') quest.cls = classMask(r.Class);
  }
  const exp = questExp.get(q.Index);
  if (exp) quest.exp = exp;
  quest.tasks = (questTasks.get(q.Index) ?? []).map((t) => {
    const task = { type: t.Task, amount: t.Amount || 0 };
    if (t.Stage) task.stage = t.Stage;
    const monsters = (taskMonsters.get(t.Index) ?? []).filter((m) => m.Monster?.Name);
    if (monsters.length) task.monsters = monsters.map((m) => (m.Map ? [m.Monster.Name, m.Map.Index] : [m.Monster.Name]));
    if (t.ItemParameter?.Name) task.item = t.ItemParameter.Name;
    if (t.RegionParameter) {
      const region = regions.get(t.RegionParameter.Index);
      const tiles = regionTiles(region);
      if (region && tiles.length) task.region = { id: region.Index, map: region.Map?.Index, at: middle(tiles, mapFile(maps.get(region.Map?.Index) ?? {})) };
    }
    if (t.NpcParameter) task.npc = t.NpcParameter.Index;
    return task;
  });
  quests.push(quest);
}

// Every region a quest task sends you to (automatic quests too), as id: [map, x, y], for "go to" tasks.
const questRegions = {};
for (const t of read('QuestTask')) {
  const region = regions.get(t.RegionParameter?.Index);
  if (!region || questRegions[region.Index]) continue;
  const tiles = regionTiles(region);
  if (!tiles.length) continue;
  const at = middle(tiles, mapFile(maps.get(region.Map?.Index) ?? {}));
  questRegions[region.Index] = [region.Map?.Index, at[0], at[1]];
}

// ---- Maps ----
const used = new Set([...links.flatMap((l) => [l.from, l.to]), ...npcs.map((n) => n.map), ...waypoints.map((w) => w.map)]);
const mapList = [...used].map((i) => maps.get(i)).map((m) => {
  const grid = mapFile(m);
  const out = { i: m.Index, name: (m.Description || m.FileName).trim(), type: m.Type };
  if (grid) Object.assign(out, { w: grid.width, h: grid.height });
  if (m.MinimumLevel > 0) out.level = m.MinimumLevel;
  if (m.MaximumLevel > 0) out.maxLevel = m.MaximumLevel;
  // Mounts aren't allowed (caves, mostly).
  if (m.CanHorse === false) out.noHorse = true;
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
fs.writeFileSync(OUT, JSON.stringify({ maps: mapList, links, npcs, waypoints, monsters: monsterNames, monsterStats, spawnSets, spawns, quests, questRegions }));
console.log(`travel.json: ${mapList.length} maps, ${links.length} links, ${npcs.length} NPCs (${npcs.filter((n) => n.stone).length} waypoint stones), ${waypoints.length} waypoints, spawn areas on ${Object.keys(spawns).length} maps, ${quests.length} NPC quests, ${searched} landings searched, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);

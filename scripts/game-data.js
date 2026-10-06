// Turns the game database export (scripts/export-game-db.ps1 -> _work/gamedb/export/*.jsonl) into readable
// summaries in game-data/: the in-game guide, where to level, maps, monsters, quests, NPCs, dungeons, items,
// skills, recipes and Triple Triad cards. Run: node scripts/game-data.js
const fs = require('node:fs');
const path = require('node:path');

const EXPORT = path.join(__dirname, '..', '_work', 'gamedb', 'export');
const OUT = path.join(__dirname, '..', 'game-data');
fs.mkdirSync(OUT, { recursive: true });

const read = (table) => {
  const file = path.join(EXPORT, `${table}.jsonl`);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').trim();
  return text ? text.split('\n').map((line) => JSON.parse(line)) : [];
};
const byIndex = (rows) => new Map(rows.map((r) => [r.Index, r]));
const groupBy = (rows, key) => {
  const map = new Map();
  for (const r of rows) {
    const k = key(r);
    if (k === undefined || k === null) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
};
const ref = (r) => r?.Index;
/** Game text: drop colour tags like {AC:Cyan}, player placeholders and Windows line ends. */
const clean = (s) =>
  String(s ?? '')
    .replace(/\{([^{}:]+):[^{}]+\}/g, '$1')
    .replace(/\[PLAYERNAME\]/g, 'you')
    .replace(/\r/g, '')
    .trim();
const oneLine = (s) => clean(s).replace(/\s*\n\s*/g, ' ');
const write = (name, text) => {
  fs.writeFileSync(path.join(OUT, name), text.replace(/\n{3,}/g, '\n\n'));
  console.log(`${name}: ${(text.length / 1024).toFixed(0)} KB`);
};
const num = (n) => Number(n).toLocaleString('en-GB');

// ---- Tables ----
const maps = byIndex(read('MapInfo'));
const regions = byIndex(read('MapRegion'));
const monsters = byIndex(read('MonsterInfo'));
const monsterStats = groupBy(read('MonsterInfoStat'), (r) => ref(r.Monster));
const respawns = read('RespawnInfo');
const drops = read('DropInfo');
const items = byIndex(read('ItemInfo'));
const itemStats = groupBy(read('ItemInfoStat'), (r) => ref(r.Item));
const quests = byIndex(read('QuestInfo'));
const questReqs = groupBy(read('QuestRequirement'), (r) => ref(r.Quest));
const questTasks = groupBy(read('QuestTask'), (r) => ref(r.Quest));
const taskMonsters = groupBy(read('QuestTaskMonsterDetails'), (r) => ref(r.Task));
const questRewards = groupBy(read('QuestReward'), (r) => ref(r.Quest));
const questStages = groupBy(read('QuestStageInfo'), (r) => ref(r.Quest));
const npcs = byIndex(read('NPCInfo'));
const goods = groupBy(read('NPCGood'), (r) => ref(r.Page));
const movements = read('MovementInfo');
const instances = read('InstanceInfo');
const instanceMaps = groupBy(read('InstanceMapInfo'), (r) => ref(r.Instance));

const mapOfRegion = (regionRef) => {
  const region = regions.get(ref(regionRef));
  return region ? maps.get(ref(region.Map)) : undefined;
};
const mapName = (map) => map?.Description ?? '?';
const regionLabel = (regionRef) => {
  const region = regions.get(ref(regionRef));
  if (!region) return '?';
  return `${mapName(maps.get(ref(region.Map)))}${region.Description ? ` (${region.Description})` : ''}`;
};
const health = (m) => monsterStats.get(m.Index)?.find((s) => s.Stat === 'Health')?.Amount ?? 0;
/** Real monsters worth hunting: not guards, nodes, or placeholders. */
const huntable = (m) => m && m.AI >= 0 && !m.Resource && m.Level > 0 && m.Level < 900 && m.MonsterName;

// Where each monster spawns, per map.
const spawnsByMap = new Map(); // map index -> Map(monster index -> count)
const spawnsByMonster = new Map(); // monster index -> Map(map index -> count)
for (const r of respawns) {
  if (r.EventSpawn) continue;
  const map = mapOfRegion(r.Region);
  const monster = monsters.get(ref(r.Monster));
  if (!map || !huntable(monster)) continue;
  const add = (outer, a, b) => {
    if (!outer.has(a)) outer.set(a, new Map());
    outer.get(a).set(b, (outer.get(a).get(b) ?? 0) + (r.Count || 1));
  };
  add(spawnsByMap, map.Index, monster.Index);
  add(spawnsByMonster, monster.Index, map.Index);
}

// ---- Guide (HelpInfo -> pages -> entries) ----
{
  const helps = read('HelpInfo').sort((a, b) => a.Order - b.Order);
  const pages = groupBy(read('HelpPageInfo'), (r) => ref(r.Help));
  const entries = groupBy(read('HelpItemInfo'), (r) => ref(r.Page));
  let out = '# In-game guide\n\nFrom the game\'s Help/Guide pages.\n';
  for (const help of helps) {
    out += `\n## ${help.Title}\n\n${clean(help.Description)}\n`;
    for (const page of (pages.get(help.Index) ?? []).sort((a, b) => a.Order - b.Order)) {
      out += `\n### ${page.Title}\n`;
      for (const entry of (entries.get(page.Index) ?? []).sort((a, b) => a.Order - b.Order)) out += `\n- **${entry.Title}**: ${oneLine(entry.Content)}`;
      out += '\n';
    }
  }
  write('guide.md', out);
}

// ---- Maps and where to level ----
const mapSummaries = [];
for (const [mapIndex, mobs] of spawnsByMap) {
  const map = maps.get(mapIndex);
  const list = [...mobs].map(([mi, count]) => ({ m: monsters.get(mi), count })).filter((x) => x.m);
  const total = list.reduce((s, x) => s + x.count, 0);
  if (!total) continue;
  // Count-weighted level spread of what you'll actually meet.
  const levels = list.flatMap((x) => Array(Math.min(x.count, 500)).fill(x.m.Level)).sort((a, b) => a - b);
  const median = levels[Math.floor(levels.length / 2)];
  const expPerKill = list.reduce((s, x) => s + Number(x.m.Experience) * x.count, 0) / total;
  mapSummaries.push({
    map,
    list: list.sort((a, b) => b.count - a.count),
    total,
    median,
    low: levels[Math.floor(levels.length * 0.1)],
    high: levels[Math.floor(levels.length * 0.9)],
    expPerKill,
    bosses: list.filter((x) => x.m.IsBoss || x.m.IsSubBoss || x.m.IsBehemoth).map((x) => x.m.MonsterName),
  });
}
const mapLine = (s) => {
  const m = s.map;
  const req = m.MinimumLevel > 0 ? ` | needs level ${m.MinimumLevel}${m.MaximumLevel > 0 ? `-${m.MaximumLevel}` : '+'}` : '';
  const rates = m.ExperienceRate ? ` | exp ${m.ExperienceRate > 0 ? '+' : ''}${m.ExperienceRate}%` : '';
  return `${mapName(m)} [${m.Type}] - monsters lv ${s.low}-${s.high} (mostly ${s.median}), ~${num(Math.round(s.expPerKill))} exp/kill${req}${rates}`;
};
{
  let out = '# Where to level\n\nMaps grouped by the level of the monsters you\'ll mostly meet (count-weighted median; 10th-90th percentile shown).\n'
    + 'Exp/kill is the average base experience per monster there. Fight things around your level: much higher hits hard, much lower gives little.\n';
  const bands = [[1, 10], [11, 20], [21, 30], [31, 40], [41, 50], [51, 60], [61, 70], [71, 80], [81, 90], [91, 100], [101, 120], [121, 150], [151, 200], [201, 999]];
  for (const [lo, hi] of bands) {
    const here = mapSummaries.filter((s) => s.median >= lo && s.median <= hi).sort((a, b) => b.expPerKill - a.expPerKill);
    if (!here.length) continue;
    out += `\n## Level ${lo}-${hi}\n\n`;
    for (const s of here) out += `- ${mapLine(s)}\n`;
  }
  write('leveling.md', out);
}
{
  // Map connections (doors, stairs, portals).
  const links = new Map();
  for (const mv of movements) {
    const from = mapOfRegion(mv.SourceRegion), to = mapOfRegion(mv.DestinationRegion);
    if (!from || !to || from === to) continue;
    if (!links.has(from.Index)) links.set(from.Index, new Set());
    links.get(from.Index).add(mapName(to));
  }
  const summaryOf = new Map(mapSummaries.map((s) => [s.map.Index, s]));
  let out = '# Maps\n\nEvery map: level requirement, rates, exits, and the monsters that spawn there (count = how many at once).\n';
  const all = [...maps.values()].sort((a, b) => mapName(a).localeCompare(mapName(b)));
  for (const m of all) {
    const s = summaryOf.get(m.Index);
    const exits = links.get(m.Index);
    if (!s && !exits && !(m.MinimumLevel > 0)) continue;
    out += `\n## ${mapName(m)}\n\n- File ${m.FileName}, type ${m.Type}${m.Biome && m.Biome !== 'None' ? `, ${m.Biome}` : ''}`;
    if (m.MinimumLevel > 0) out += `\n- Needs level ${m.MinimumLevel}${m.MaximumLevel > 0 ? ` (max ${m.MaximumLevel})` : ''}`;
    const rates = ['ExperienceRate', 'DropRate', 'GoldRate', 'MonsterHealth', 'MonsterDamage'].filter((k) => m[k]).map((k) => `${k} ${m[k] > 0 ? '+' : ''}${m[k]}%`);
    if (rates.length) out += `\n- Rates: ${rates.join(', ')}`;
    if (m.RequiredClass && m.RequiredClass !== 'None' && m.RequiredClass !== 'All') out += `\n- Class: ${m.RequiredClass}`;
    if (exits) out += `\n- Leads to: ${[...exits].sort().join(', ')}`;
    if (s) {
      out += `\n- Monsters lv ${s.low}-${s.high} (mostly ${s.median}), ~${num(Math.round(s.expPerKill))} exp/kill`;
      if (s.bosses.length) out += `\n- Bosses: ${[...new Set(s.bosses)].join(', ')}`;
      out += '\n\n| Monster | Lv | HP | Exp | Count |\n|---|---|---|---|---|\n';
      for (const x of s.list.slice(0, 40)) out += `| ${x.m.MonsterName}${x.m.IsBoss ? ' (boss)' : ''} | ${x.m.Level} | ${num(health(x.m))} | ${num(x.m.Experience)} | ${x.count} |\n`;
    }
    out += '\n';
  }
  write('maps.md', out);
}

// ---- Monsters ----
const dropsByMonster = groupBy(drops, (r) => ref(r.Monster));
const dropsByItem = groupBy(drops, (r) => ref(r.Item));
{
  let out = '# Monsters\n\nLevel, HP, experience, where they spawn and what they drop. Drop chance is "1 in N" per kill.\n';
  const list = [...monsters.values()].filter(huntable).sort((a, b) => a.Level - b.Level || a.MonsterName.localeCompare(b.MonsterName));
  for (const m of list) {
    const where = [...(spawnsByMonster.get(m.Index) ?? [])].sort((a, b) => b[1] - a[1]).map(([mi, c]) => `${mapName(maps.get(mi))} (${c})`);
    const loot = (dropsByMonster.get(m.Index) ?? []).filter((d) => d.Item?.Name && d.Chance > 0).sort((a, b) => a.Chance - b.Chance);
    const flags = [m.IsBoss && 'boss', m.IsSubBoss && 'sub-boss', m.IsBehemoth && 'behemoth', m.Undead && 'undead', m.Difficulty !== 'Normal' && m.Difficulty].filter(Boolean);
    out += `\n## ${m.MonsterName} (lv ${m.Level})\n\n- HP ${num(health(m))}, exp ${num(m.Experience)}${flags.length ? `, ${flags.join(', ')}` : ''}`;
    if (where.length) out += `\n- Spawns: ${where.slice(0, 12).join(', ')}${where.length > 12 ? `, +${where.length - 12} more` : ''}`;
    if (loot.length) out += `\n- Drops: ${loot.slice(0, 25).map((d) => `${d.Item.Name} (1/${d.Chance})`).join(', ')}${loot.length > 25 ? `, +${loot.length - 25} more` : ''}`;
    out += '\n';
  }
  write('monsters.md', out);
}

// ---- NPCs ----
const npcPlace = (npc) => npc?.RegionName ?? regionLabel(npc?.Region);
{
  const startBy = groupBy([...quests.values()], (q) => ref(q.StartNPC));
  let out = '# NPCs\n\nWhere every NPC stands, and the quests they hand out.\n';
  const byMap = groupBy([...npcs.values()].filter((n) => n.NPCName), (n) => mapName(mapOfRegion(n.Region)));
  for (const [map, list] of [...byMap].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    out += `\n## ${map}\n\n`;
    for (const n of list.sort((a, b) => a.NPCName.localeCompare(b.NPCName))) {
      const qs = (startBy.get(n.Index) ?? []).map((q) => q.DisplayName || q.QuestName);
      out += `- **${n.NPCName}** - ${npcPlace(n)}${qs.length ? ` | quests: ${qs.slice(0, 10).join('; ')}${qs.length > 10 ? ` (+${qs.length - 10})` : ''}` : ''}\n`;
    }
  }
  write('npcs.md', out);
}

// ---- Quests ----
{
  const taskText = (t) => {
    const parts = [];
    const n = t.Amount > 1 ? `${t.Amount}x ` : '';
    switch (t.Task) {
      case 'KillMonster': {
        const mobs = (taskMonsters.get(t.Index) ?? []).map((d) => `${d.Monster?.Name}${d.Map?.Name ? ` in ${d.Map.Name}` : ''}`);
        parts.push(`Kill ${n}${t.MobDescription || mobs.join(' / ') || 'monsters'}${t.MobDescription && mobs.length ? ` (${mobs.join(' / ')})` : ''}`);
        break;
      }
      case 'GainItem': parts.push(`Collect ${n}${t.ItemParameter?.Name}`); break;
      case 'TalkToNPC': parts.push(`Talk to ${t.NpcParameter?.Name ?? 'NPC'}${t.NpcParameter ? ` (${npcPlace(npcs.get(ref(t.NpcParameter)))})` : ''}`); break;
      case 'Region': parts.push(`Go to ${regionLabel(t.RegionParameter)}`); break;
      case 'MapExploration': parts.push(`Explore ${t.MapParameter?.Name ?? 'the map'}${t.Amount ? ` (${t.Amount}%)` : ''}`); break;
      case 'InstanceComplete': parts.push(`Complete ${t.InstanceParameter?.Name ?? 'a dungeon'}${t.Amount > 1 ? ` ${t.Amount} times` : ''}`); break;
      default: parts.push(`${t.Task}${t.Amount ? ` x${t.Amount}` : ''}${t.MobDescription ? ` (${t.MobDescription})` : ''}`);
    }
    return parts.join(' ');
  };
  const minLevel = (q) => Math.max(0, ...(questReqs.get(q.Index) ?? []).filter((r) => r.Requirement === 'MinLevel').map((r) => r.IntParameter1));
  const prereqs = (q) => (questReqs.get(q.Index) ?? []).filter((r) => r.Requirement === 'HaveCompleted').map((r) => r.QuestParameter?.Name).filter(Boolean);
  const classReq = (q) => (questReqs.get(q.Index) ?? []).filter((r) => r.Requirement === 'Class').map((r) => r.Class);
  const live = (x) => !x.RetiredRevision;
  let out = '# Quests\n\nGrouped by storyline. Level = minimum level to accept. Rewards show experience and items.\n';
  const byAct = groupBy([...quests.values()], (q) => q.StoryAct || q.QuestType || 'Other');
  const index = [];
  for (const [act, list] of [...byAct].sort((a, b) => Math.min(...a[1].map(minLevel)) - Math.min(...b[1].map(minLevel)))) {
    out += `\n## ${act}\n`;
    for (const q of list.sort((a, b) => (a.StoryChapter ?? 0) - (b.StoryChapter ?? 0) || minLevel(a) - minLevel(b) || a.Index - b.Index)) {
      const name = q.DisplayName || q.QuestName;
      index.push({ level: minLevel(q), name, act, type: q.QuestType, start: q.StartNPC ? npcPlace(npcs.get(ref(q.StartNPC))) : '' });
      out += `\n### ${name}\n\n- Type ${q.QuestType}${minLevel(q) ? `, level ${minLevel(q)}+` : ''}${classReq(q).length ? `, class ${classReq(q).join('/')}` : ''}${q.PrimaryMap ? `, map ${q.PrimaryMap.Name}` : ''}`;
      if (prereqs(q).length) out += `\n- After: ${prereqs(q).join('; ')}`;
      if (q.StartNPC) out += `\n- Start: ${q.StartNPC.Name} - ${npcPlace(npcs.get(ref(q.StartNPC)))}`;
      if (q.FinishNPC && ref(q.FinishNPC) !== ref(q.StartNPC)) out += `\n- Hand in: ${q.FinishNPC.Name} - ${npcPlace(npcs.get(ref(q.FinishNPC)))}`;
      const tasks = (questTasks.get(q.Index) ?? []).filter(live).sort((a, b) => a.Stage - b.Stage);
      if (tasks.length) out += `\n- Tasks: ${tasks.map(taskText).join('; ')}`;
      const rewards = (questRewards.get(q.Index) ?? []).filter(live).map((r) => `${r.Item?.Name === 'Experience' ? `${num(r.Amount)} exp` : `${r.Amount > 1 ? `${num(r.Amount)}x ` : ''}${r.Item?.Name}`}${r.Choice ? ' (choice)' : ''}${r.Class && r.Class !== 'All' ? ` [${r.Class}]` : ''}`);
      if (rewards.length) out += `\n- Rewards: ${rewards.join(', ')}`;
      const text = oneLine(q.AcceptText || (questStages.get(q.Index) ?? [])[0]?.JournalText || '');
      if (text) out += `\n- "${text.slice(0, 400)}${text.length > 400 ? '...' : ''}"`;
      out += '\n';
    }
  }
  write('quests.md', out);
  let byLevel = '# Quests by level\n\nEvery quest by the level it opens at, with where it starts.\n\n';
  for (const q of index.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))) byLevel += `- ${q.level || '-'}: ${q.name} [${q.act}]${q.start ? ` - ${q.start}` : ''}\n`;
  write('quests-by-level.md', byLevel);
}

// ---- Dungeons ----
{
  let out = '# Dungeons and instances\n\nLevel limits, group size, cooldowns and maps.\n';
  for (const inst of instances.sort((a, b) => (a.MinPlayerLevel || 0) - (b.MinPlayerLevel || 0))) {
    const ims = (instanceMaps.get(inst.Index) ?? []).map((im) => im.Map?.Name).filter(Boolean);
    out += `\n## ${inst.Name}\n\n- Type ${inst.Type}${inst.Category && inst.Category !== 'None' ? `, ${inst.Category}` : ''}`;
    out += `, level ${inst.MinPlayerLevel || 1}${inst.MaxPlayerLevel ? `-${inst.MaxPlayerLevel}` : '+'}, players ${inst.MinPlayerCount}-${inst.MaxPlayerCount}`;
    if (inst.CooldownTimeInMinutes) out += `, cooldown ${inst.CooldownTimeInMinutes} min`;
    if (inst.TimeLimitInMinutes) out += `, time limit ${inst.TimeLimitInMinutes} min`;
    if (inst.RequiredItem) out += `\n- Needs item: ${inst.RequiredItem.Name}`;
    if (inst.ConnectRegion) out += `\n- Entrance: ${regionLabel(inst.ConnectRegion)}`;
    if (ims.length) out += `\n- Maps: ${[...new Set(ims)].join(', ')}`;
    out += '\n';
  }
  write('dungeons.md', out);
}

// ---- Items ----
{
  const recipesByResult = groupBy(read('RecipeInfo'), (r) => ref(r.ResultItem));
  const soldAt = new Map();
  for (const [pageIndex, list] of goods) for (const g of list) {
    if (!soldAt.has(ref(g.Item))) soldAt.set(ref(g.Item), []);
    soldAt.get(ref(g.Item)).push(`${g.Page?.Name} (${num(g.Cost)})`);
  }
  let out = '# Items\n\nType, requirements, stats, where to get them (drops "1 in N", shops, crafting).\n';
  const list = [...items.values()].filter((i) => i.ItemName).sort((a, b) => a.ItemType.localeCompare(b.ItemType) || a.ItemName.localeCompare(b.ItemName));
  let type = '';
  for (const it of list) {
    if (it.ItemType !== type) {
      type = it.ItemType;
      out += `\n# ${type}\n`;
    }
    const stats = (itemStats.get(it.Index) ?? []).map((s) => `${s.Stat} ${s.Amount}`);
    const from = (dropsByItem.get(it.Index) ?? []).filter((d) => d.Monster?.Name && d.Chance > 0).sort((a, b) => a.Chance - b.Chance);
    out += `\n## ${it.ItemName}\n\n- ${it.Rarity}${it.RequiredClass && it.RequiredClass !== 'All' ? `, ${it.RequiredClass}` : ''}${it.RequiredAmount ? `, needs ${it.RequiredType} ${it.RequiredAmount}` : ''}`;
    if (stats.length) out += `\n- Stats: ${stats.join(', ')}`;
    if (it.Description) out += `\n- ${oneLine(it.Description)}`;
    if (from.length) out += `\n- Dropped by: ${from.slice(0, 12).map((d) => `${d.Monster.Name} (1/${d.Chance})`).join(', ')}${from.length > 12 ? `, +${from.length - 12} more` : ''}`;
    if (soldAt.has(it.Index)) out += `\n- Sold: ${[...new Set(soldAt.get(it.Index))].slice(0, 6).join(', ')}`;
    if (recipesByResult.has(it.Index)) out += `\n- Crafted: ${recipesByResult.get(it.Index).map((r) => r.Name).join(', ')}`;
    out += '\n';
  }
  write('items.md', out);
}

// ---- Skills, recipes, cards ----
{
  let out = '# Skills\n\nBy class: the level each skill can be learned at (and trained further), and what it does.\n';
  for (const [cls, list] of groupBy(read('MagicInfo'), (m) => m.Class)) {
    out += `\n## ${cls}\n\n`;
    for (const m of list.sort((a, b) => a.NeedLevel1 - b.NeedLevel1)) {
      out += `- **${m.Name}** (learn at ${m.NeedLevel1}; levels ${m.NeedLevel1}/${m.NeedLevel2}/${m.NeedLevel3}${m.BaseCost ? `; MP ${m.BaseCost}` : ''}, ${m.School}): ${oneLine(m.Description).slice(0, 500)}\n`;
    }
  }
  write('skills.md', out);

  out = '# Crafting recipes\n\nIngredients (9 slots), level and profession requirements.\n';
  for (const r of read('RecipeInfo').sort((a, b) => (a.RequiredProfessionLevel || 0) - (b.RequiredProfessionLevel || 0))) {
    const slots = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => r[`Slot${i}`]?.Name).filter(Boolean);
    const counts = {};
    for (const s of slots) counts[s] = (counts[s] ?? 0) + 1;
    out += `\n## ${r.Name}\n\n- ${r.Category}, level ${r.RequiredLevel}, profession ${r.RequiredProfessionLevel}${r.ResultItem ? `, makes ${r.ResultItem.Name}` : ''}`;
    out += `\n- Needs: ${Object.entries(counts).map(([n, c]) => `${c}x ${n}`).join(', ')}`;
    if (r.UnlockHint) out += `\n- Unlock: ${oneLine(r.UnlockHint)}`;
    if (r.Description) out += `\n- ${oneLine(r.Description)}`;
    out += '\n';
  }
  write('recipes.md', out);

  out = '# Triple Triad cards\n\nUp / Right / Down / Left.\n\n| Card | Level | Up | Right | Down | Left | Element | Set |\n|---|---|---|---|---|---|---|---|\n';
  for (const c of read('TTCardInfo').sort((a, b) => a.Level - b.Level || a.Name.localeCompare(b.Name))) out += `| ${c.Name} | ${c.Level} | ${c.Up} | ${c.Right} | ${c.Down} | ${c.Left} | ${c.Element} | ${c.Set} |\n`;
  write('triple-triad-cards.md', out);
}

// ---- Gathering (plants and ore) ----
{
  const nodes = byIndex(read('GatheringNodeInfo'));
  // How many of each node each map grows, and at what profession level (spawn points can override the node's own).
  const where = new Map();
  for (const s of read('GatheringNodeSpawnInfo')) {
    const node = nodes.get(ref(s.BaselineNode));
    if (!node) continue;
    const map = mapName(mapOfRegion(s.Region));
    const level = s.ProfessionLevelOverride || node.RequiredProfessionLevel;
    const key = `${node.Index}|${map}|${level}`;
    const entry = where.get(key) ?? { node, map, level, count: 0, respawn: s.RespawnMinutes, regions: new Set() };
    entry.count += s.Count;
    if (s.Region?.Name) entry.regions.add(s.Region.Name);
    where.set(key, entry);
  }
  const spots = [...where.values()];

  let out = '# Gathering\n\nPlants (Harvesting, with a Scavenging Dagger) and ore (Mining, with a Pick Axe): what each node needs and gives, and where it grows. Counts are how many nodes a map spawns (they respawn after the minutes shown). The Gather mode picks whatever is on screen.\n';
  out += '\n## Best maps by profession level\n\nThe maps with the most nodes you can gather, for each level bracket.\n';
  for (const [kind, label] of [['Harvesting', 'Plants'], ['Mining', 'Ore']]) {
    out += `\n### ${label}\n\n`;
    for (let top = 10; top <= 150; top += 10) {
      const usable = spots.filter((e) => e.node.Kind === kind && e.level <= top && e.level > top - 10);
      if (!usable.length) continue;
      usable.sort((a, b) => b.count - a.count);
      out += `- **Level ${top - 9}-${top}**: ${usable.slice(0, 5).map((e) => `${e.map} (${e.count} ${e.node.Name}, level ${e.level})`).join('; ')}\n`;
    }
  }
  out += '\n## Nodes\n';
  for (const node of [...nodes.values()].sort((a, b) => a.Kind.localeCompare(b.Kind) || a.RequiredProfessionLevel - b.RequiredProfessionLevel)) {
    const conditions = [node.RequiredWeather !== 'None' ? `weather ${node.RequiredWeather}` : '', node.RequiredLight !== 'Any' ? `light ${node.RequiredLight}` : ''].filter(Boolean).join(', ');
    out += `\n### ${node.Name}\n\n- ${node.Kind}, profession level ${node.RequiredProfessionLevel}, ${node.ProfessionExperience} XP, gives ${node.MinimumYield}-${node.MaximumYield} ${node.Ingredient?.Name ?? '?'}${conditions ? ` (only in ${conditions})` : ''}\n`;
    const at = spots.filter((e) => e.node.Index === node.Index).sort((a, b) => b.count - a.count);
    if (at.length) out += `- Grows at: ${at.slice(0, 12).map((e) => `${e.map} ${e.count}${e.level !== node.RequiredProfessionLevel ? ` (level ${e.level})` : ''}`).join(', ')}${at.length > 12 ? `, +${at.length - 12} more` : ''}\n`;
    else out += `- Grows: wherever the "${node.PoolKey}" pool spawns (${node.Biome}, ${node.MapScope})\n`;
  }
  write('gathering.md', out);
}

console.log(`Wrote ${OUT}`);

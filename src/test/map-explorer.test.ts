import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Point } from '../shared/types';
import { canStep, MapExplorer, WAYPOINT_STEPS, type ExploreRoute } from '../main/map-explorer';
import { isExplored, isWall, updateMap, type MapGrid } from '../main/map-grid';
import { reachableBlocks, simulateMapExplore, type MapSimResult } from './map-explore-sim';
import { loadMapFixture, mapFixtureNames, stretchMap } from './map-fixtures';

/**
 * A small map drawn as text, one tile per block: '#' wall, '.' explored floor,
 * '+' unexplored floor, '@' the player (on explored floor).
 */
function drawnMap(rows: string[]): { map: MapGrid; player: Point } {
  const width = rows[0].length, height = rows.length;
  const walls = new Uint8Array(Math.ceil((width * height) / 8));
  const explored = new Uint8Array(Math.ceil((width * height) / 8));
  let player = { x: -1, y: -1 };
  rows.forEach((row, y) => [...row].forEach((c, x) => {
    const i = y * width + x;
    if (c === '#') walls[i >> 3] |= 1 << (i & 7);
    if (c !== '+') explored[i >> 3] |= 1 << (i & 7);
    if (c === '@') player = { x, y };
  }));
  const map = { index: 1, name: 'Drawn', width, height, walls, blockSize: 1, gridWidth: width, gridHeight: height, explored, revision: 1 };
  return { map, player };
}

const route = (plan: ExploreRoute | 'done' | null) => {
  assert.ok(plan && plan !== 'done', `expected a route, got ${plan}`);
  return plan;
};
const onPath = (plan: ExploreRoute, tile: Point) => plan.path.some((p) => p.x === tile.x && p.y === tile.y);

/**
 * Checked without the planner's own rule (canStep): one tile at a time, never
 * onto a wall or diagonally between two. If the rule changes, change it here too.
 */
function assertWalkable(map: MapGrid, plan: ExploreRoute, player: Point) {
  assert.deepEqual(plan.path[0], player);
  for (let i = 1; i < plan.path.length; i++) {
    const a = plan.path[i - 1], b = plan.path[i], dx = b.x - a.x, dy = b.y - a.y;
    assert.equal(Math.max(Math.abs(dx), Math.abs(dy)), 1, `from ${a.x},${a.y} to ${b.x},${b.y}`);
    assert.ok(!isWall(map, b.x, b.y), `into a wall at ${b.x},${b.y}`);
    assert.ok(!(dx && dy && isWall(map, a.x + dx, a.y) && isWall(map, a.x, a.y + dy)), `between two walls at ${a.x},${a.y}`);
  }
  // It ends at the target, in a block still to explore.
  assert.deepEqual(plan.path[plan.path.length - 1], plan.target);
  assert.ok(!isExplored(map, plan.target.x, plan.target.y));
  // The waypoint is on the path, straight ahead of the player.
  const at = plan.path.findIndex((p) => p.x === plan.waypoint.x && p.y === plan.waypoint.y);
  assert.ok(at >= Math.min(1, plan.path.length - 1) && at <= WAYPOINT_STEPS);
  for (let i = 1; i <= at; i++) assert.deepEqual({ x: plan.path[i].x - plan.path[i - 1].x, y: plan.path[i].y - plan.path[i - 1].y }, { x: plan.path[1].x - player.x, y: plan.path[1].y - player.y });
}

test('a diagonal step may pass one wall but not squeeze between two', () => {
  const { map } = drawnMap(['####', '#..#', '#.##', '####']);
  assert.ok(canStep(map, 1, 1, 1, 0));
  assert.ok(!canStep(map, 1, 1, -1, 0), 'into a wall');
  assert.ok(canStep(map, 2, 1, -1, 1), 'past one wall');
  const pinch = drawnMap(['####', '#.##', '##.#', '####']).map;
  assert.ok(!canStep(pinch, 1, 1, 1, 1), 'between two walls');
});

test('heads for the nearest unexplored block by walking, not as the crow flies', () => {
  const { map, player } = drawnMap([
    '################',
    '#.@#+..........#',
    '#..###########.#',
    '#..............#',
    '#++............#',
    '################',
  ]);
  const plan = route(new MapExplorer().plan(map, player, 0));
  assert.equal(plan.target.y, 4);
  assertWalkable(map, plan, player);
});

test('of equally near blocks, heads for the one with the most unexplored around it', () => {
  // Both areas are too big to count as pockets; the left one is entered through a gap.
  const rows = [
    '###################',
    '#+++++#.....++++++#',
    '#+++++#.....++++++#',
    '#++++++..@..++++++#',
    '#+++++#.....++++++#',
    '#+++++#.....++++++#',
    '###################',
  ];
  const { map, player } = drawnMap(rows);
  assert.equal(route(new MapExplorer().plan(map, player, 0)).target.x, 12);
  // Turned round, so it isn't just the block the search happens to reach first.
  const turned = drawnMap(rows.map((row) => [...row].reverse().join('')).reverse());
  assert.equal(route(new MapExplorer().plan(turned.map, turned.player, 0)).target.x, 6);
});

test('finishes a small pocket close by before a big area', () => {
  const near = drawnMap([
    '####################',
    '#++++++++#.........#',
    '#++++++++#.........#',
    '#++++++++..@.....++#',
    '#++++++++#.........#',
    '#++++++++#.........#',
    '####################',
  ]);
  assert.deepEqual(route(new MapExplorer().plan(near.map, near.player, 0)).target, { x: 17, y: 3 });
  // Too far out of the way: the big area first.
  const far = drawnMap([
    '##############################',
    '#++++++++#...................#',
    '#++++++++..@...............++#',
    '#++++++++#...................#',
    '##############################',
  ]);
  assert.ok(route(new MapExplorer().plan(far.map, far.player, 0)).target.x < 10);
});

test('done when nothing that can be walked to is unexplored', () => {
  const sealed = drawnMap(['########', '#@...#+#', '#....###', '########']);
  assert.equal(new MapExplorer().plan(sealed.map, sealed.player, 0), 'done');
  const pinched = drawnMap(['#####', '#@###', '##.+#', '#####']);
  assert.equal(new MapExplorer().plan(pinched.map, pinched.player, 0), 'done', 'only through a squeeze between two walls');
  const open = drawnMap(['########', '#@....+#', '########']);
  assert.notEqual(new MapExplorer().plan(open.map, open.player, 0), 'done');
  // Done is remembered until more is uncovered, or the player turns up where that search didn't reach (a teleport).
  const rooms = drawnMap(['#########', '#@..#...#', '#...#..+#', '#########']);
  const explorer = new MapExplorer();
  assert.equal(explorer.plan(rooms.map, rooms.player, 0), 'done');
  assert.deepEqual(route(explorer.plan(rooms.map, { x: 5, y: 1 }, 1)).target, { x: 7, y: 2 });
  assert.deepEqual(route(explorer.plan(rooms.map, { x: 5, y: 1 }, 2)).target, { x: 7, y: 2 }, 'and keeps it after that');
  const unknown = { ...open.map, explored: null };
  assert.equal(new MapExplorer().plan(unknown, open.player, 0), null, "can't tell before the game says what's explored");
});

test('the waypoint is straight ahead along the path, up to a few tiles', () => {
  const corridor = drawnMap(['######################', '#@..................+#', '######################']);
  assert.deepEqual(route(new MapExplorer().plan(corridor.map, corridor.player, 0)).waypoint, { x: 1 + WAYPOINT_STEPS, y: 1 });
  const corner = drawnMap(['#######', '#@...##', '####.##', '####+##', '#######']);
  assert.deepEqual(route(new MapExplorer().plan(corner.map, corner.player, 0)).waypoint, { x: 3, y: 1 }, 'stops where the path turns');
  // In the open the path starts with its diagonal steps.
  const room = drawnMap(['########', '#@.....#', '#......#', '#.....+#', '########']);
  const plan = route(new MapExplorer().plan(room.map, room.player, 0));
  assert.deepEqual(plan.waypoint, { x: 3, y: 3 });
  assertWalkable(room.map, plan, room.player);
});

test('keeps its route while the player follows it; searches again when the target is explored or the player strays', () => {
  const { map, player } = drawnMap(['##############', '#@...........#', '#...........+#', '##############']);
  const explorer = new MapExplorer();
  const first = route(explorer.plan(map, player, 0));
  const second = route(explorer.plan(map, first.path[3], 1));
  assert.equal(explorer.searches, 1);
  assert.deepEqual(second.target, first.target);
  assert.deepEqual(second.path, first.path.slice(3));
  route(explorer.plan(map, { x: 5, y: 1 }, 2));
  assert.equal(explorer.searches, 2, 'off the path');
  const target = 2 * map.width + 12;
  map.explored![target >> 3] |= 1 << (target & 7);
  map.revision++;
  assert.equal(explorer.plan(map, { x: 5, y: 1 }, 3), 'done');
  assert.equal(explorer.plan(map, { x: 5, y: 1 }, 4), 'done');
  assert.equal(explorer.searches, 3, 'done is remembered until more is uncovered');
});

test('blocked: walks round the tiles ahead and heads somewhere else for a while', () => {
  // The way to the other block passes the tile ahead unless that's walked round.
  const { map, player } = drawnMap([
    '#########',
    '#.......#',
    '#@.###..#',
    '#.......#',
    '#...+..+#',
    '#########',
  ]);
  const explorer = new MapExplorer();
  const first = route(explorer.plan(map, player, 0));
  explorer.blocked(10);
  const second = route(explorer.plan(map, player, 1));
  assert.ok(!onPath(second, first.path[1]), JSON.stringify(second.path));
  assert.notDeepEqual(second.target, first.target);
  assertWalkable(map, second, player);
  // Once the time is up, a fresh search may go that way again.
  const again = route(explorer.plan(map, { x: 1, y: 1 }, 11));
  assert.deepEqual(again.target, first.target);
});

test('blocked: still kept away from when the reader sends the same walls again', () => {
  const { map, player } = drawnMap(['#########', '#.......#', '#@.###..#', '#.......#', '#...+..+#', '#########']);
  const explorer = new MapExplorer();
  const first = route(explorer.plan(map, player, 0));
  explorer.blocked(10);
  route(explorer.plan(map, player, 1));
  // The reader sends the walls again on each attach: a new array for the same map.
  const resent = updateMap(map, { index: map.index, name: map.name, width: map.width, height: map.height, walls: Buffer.from(map.walls).toString('base64') })!;
  assert.notEqual(resent.walls, map.walls);
  const second = route(explorer.plan(resent, player, 2));
  assert.ok(!onPath(second, first.path[1]), JSON.stringify(second.path));
  assert.notDeepEqual(second.target, first.target);
});

test('blocked with one block left: heads there anyway, round the tiles ahead if it can', () => {
  const { map, player } = drawnMap(['#######', '#@...+#', '#######']);
  const explorer = new MapExplorer();
  const first = route(explorer.plan(map, player, 0));
  explorer.blocked(10);
  assert.deepEqual(route(explorer.plan(map, player, 1)).path, first.path, 'the only way');
  const room = drawnMap(['#######', '#@...+#', '#.....#', '#######']);
  const inRoom = new MapExplorer();
  const ahead = route(inRoom.plan(room.map, room.player, 0));
  inRoom.blocked(10);
  const round = route(inRoom.plan(room.map, room.player, 1));
  assert.deepEqual(round.target, ahead.target);
  assert.ok(!onPath(round, ahead.path[1]), JSON.stringify(round.path));
  assertWalkable(room.map, round, room.player);
});

test("keeps away from the caller's tiles and blocks", () => {
  const { map, player } = drawnMap(['#########', '#.......#', '#@.###.+#', '#.......#', '#...+...#', '#########']);
  const plain = route(new MapExplorer().plan(map, player, 0));
  const round = route(new MapExplorer().plan(map, player, 0, [plain.path[1]]));
  assert.ok(!onPath(round, plain.path[1]));
  const elsewhere = route(new MapExplorer().plan(map, player, 0, [{ ...plain.target, block: true }]));
  assert.notDeepEqual(elsewhere.target, plain.target);
  // A tile added to the list while on the way: planned again.
  const explorer = new MapExplorer();
  const first = route(explorer.plan(map, player, 0));
  const later = route(explorer.plan(map, player, 1, [first.path[1]]));
  assert.ok(!onPath(later, first.path[1]));
  route(explorer.plan(map, player, 2, [first.path[1]]));
  assert.equal(explorer.searches, 2, 'the same list again: no new search');
  // A change away from the route ahead (a monster elsewhere): no new search either.
  const away = { x: 7, y: 1 };
  assert.ok(!onPath(later, away));
  route(explorer.plan(map, player, 3, [first.path[1], away]));
  assert.equal(explorer.searches, 2, 'a change off the route');
  // The block headed for, now to avoid: planned again.
  const other = route(explorer.plan(map, player, 4, [first.path[1], { ...later.target, block: true }]));
  assert.equal(explorer.searches, 3);
  assert.notDeepEqual(other.target, later.target);
});

/** For the PR, printed once every test has run: a table row for each simulation, then other figures. */
const table: string[] = [];
const notes: string[] = [];

function addRow(map: MapGrid, label: string, radius: number, result: MapSimResult) {
  const cells = [label, `${map.width}x${map.height}`, radius, result.reachableBlocks, result.steps80 ?? '–', result.steps95 ?? '–',
    result.done ? result.steps : '–', result.searches, result.planMs.mean.toFixed(3), result.planMs.max.toFixed(1)];
  table.push(`| ${cells.join(' | ')} |`);
}

after(() => {
  console.log([
    '| Map | Size | Reveal radius (blocks) | Reachable blocks | Steps to 80% | Steps to 95% | Steps to done | Searches | Mean ms per plan() | Worst ms |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...table,
    '',
    ...notes,
  ].join('\n'));
});

const summarise = (result: MapSimResult) =>
  `${result.reachableBlocks} blocks, 80% after ${result.steps80} steps, 95% after ${result.steps95}, ${result.done ? `done after ${result.steps}` : 'not done'}; ` +
  `${result.searches} searches, ${result.planMs.mean.toFixed(3)} ms a call (worst ${result.planMs.max.toFixed(1)} ms)`;

for (const name of mapFixtureNames()) {
  for (const revealRadius of [2, 3, 5]) {
    test(`saved map ${name}: explores 95% uncovering ${revealRadius} blocks around, and says done only once all is explored`, (t) => {
      const { map, player } = loadMapFixture(name);
      // Within the default limit: twice the walk of a sweep that uncovers a swath 2 x radius blocks wide.
      const result = simulateMapExplore(map, player, { revealRadius, goal: 1, onRoute: (plan, at, seen) => assertWalkable(seen, plan, at) });
      assert.ok(result.steps95 !== null, `${Math.round(result.explored * 100)}% after ${result.steps} steps`);
      assert.ok(result.done, `not done after ${result.steps} steps`);
      assert.equal(result.explored, 1);
      addRow(map, map.name, revealRadius, result);
      t.diagnostic(`${name}, radius ${revealRadius}: ${summarise(result)}`);
    });
  }

  test(`saved map ${name}: gets round things the map doesn't show`, (t) => {
    const { map, player } = loadMapFixture(name);
    // About one floor tile in 200, picked by a fixed pattern.
    const obstacles: Point[] = [];
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) if (!isWall(map, x, y) && (x * 7 + y * 13) % 211 === 0 && (x !== player.x || y !== player.y)) obstacles.push({ x, y });
    }
    const result = simulateMapExplore(map, player, { obstacles });
    assert.ok(result.steps95 !== null, `${Math.round(result.explored * 100)}% after ${result.steps} steps`);
    assert.ok(result.blocked > 0);
    addRow(map, `${map.name}, ${obstacles.length} unseen obstacles (blocked ${result.blocked} times)`, 3, result);
    t.diagnostic(`${name} with ${obstacles.length} unseen obstacles: ${summarise(result)}; blocked ${result.blocked} times`);
  });
}

/** The largest saved map stretched to 800x800, about the size of the game's largest (unless it's that big already). */
function bigMap(): { map: MapGrid; player: Point } {
  const largest = mapFixtureNames().map((name) => loadMapFixture(name)).reduce((a, b) => (b.map.width * b.map.height > a.map.width * a.map.height ? b : a));
  if (largest.map.width >= 800 && largest.map.height >= 800) return largest;
  const big = stretchMap(largest.map, largest.player, 800);
  assert.ok(!isWall(big.map, big.player.x, big.player.y), 'the player on floor after stretching');
  return big;
}

// Time limits are about 10x what was measured: the machine is shared, and the test files run side by side.
// One radius only: each run takes 2-3 s, and the saved maps cover radius 2 and 5.
test('an 800x800 map: explores it all uncovering 3 blocks around, planning quickly', (t) => {
  const { map, player } = bigMap();
  const result = simulateMapExplore(map, player, { revealRadius: 3, goal: 1, onRoute: (plan, at, seen) => assertWalkable(seen, plan, at) });
  assert.ok(result.steps95 !== null, `${Math.round(result.explored * 100)}% after ${result.steps} steps`);
  assert.ok(result.done, `not done after ${result.steps} steps`);
  assert.equal(result.explored, 1);
  // Every call, searching or not; the worst includes setting up for the map and the last search, which finds nothing.
  assert.ok(result.planMs.mean < 2, `${result.planMs.mean} ms a call`);
  assert.ok(result.planMs.max < 250, `worst ${result.planMs.max} ms`);
  addRow(map, map.name, 3, result);
  t.diagnostic(`${map.name}, radius 3: ${summarise(result)}`);
});

test('an 800x800 map: a search of the whole map is quick, and the calls in between search nothing', (t) => {
  const { map, player } = bigMap();
  // The worst case: all explored but the reachable block farthest away, so the search covers the whole map.
  const reachable = reachableBlocks(map, player);
  let far = -1;
  const distance = (g: number) => Math.hypot((g % map.gridWidth) * map.blockSize - player.x, Math.floor(g / map.gridWidth) * map.blockSize - player.y);
  for (let g = 0; g < reachable.length; g++) if (reachable[g] && (far < 0 || distance(g) > distance(far))) far = g;
  map.explored!.fill(255);
  map.explored![far >> 3] &= ~(1 << (far & 7));
  map.revision++;
  const explorer = new MapExplorer();
  let started = performance.now();
  const worst = route(explorer.plan(map, player, 0));
  const worstMs = performance.now() - started;
  assert.ok(worstMs < 250, `${worstMs} ms`);
  started = performance.now();
  for (let i = 0; i < 1000; i++) explorer.plan(map, player, 1);
  const cachedMs = (performance.now() - started) / 1000;
  assert.ok(cachedMs < 0.1, `${cachedMs} ms`);
  assert.equal(explorer.searches, 1);
  // Nothing left: a whole-map search to be sure, then remembered.
  map.explored!.fill(255);
  map.revision++;
  started = performance.now();
  assert.equal(explorer.plan(map, player, 2), 'done');
  const doneMs = performance.now() - started;
  assert.ok(doneMs < 250, `${doneMs} ms`);
  for (let i = 0; i < 1000; i++) explorer.plan(map, player, 3);
  assert.equal(explorer.searches, 2);
  const summary = `${map.name}: a search of the whole map takes ${worstMs.toFixed(1)} ms (a route of ${worst.path.length} tiles), ` +
    `finding it done ${doneMs.toFixed(1)} ms, and a call that keeps the route ${cachedMs.toFixed(4)} ms.`;
  notes.push(summary);
  t.diagnostic(summary);
});

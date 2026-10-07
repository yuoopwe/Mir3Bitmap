import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MapGrid } from '../main/map-grid';
import { RANDOM_TELEPORT, expectedAfterTeleport, teleportOdds, worthTeleporting } from '../main/random-teleport';

/** A map of open floor, `walls` (as x,y) walled. */
function grid(width: number, height: number, walls: [number, number][] = []): MapGrid {
  const bits = new Uint8Array(Math.ceil((width * height) / 8));
  for (const [x, y] of walls) bits[(y * width + x) >> 3] |= 1 << ((y * width + x) & 7);
  return { index: 1, name: 'Test', width, height, walls: bits, blockSize: 0, gridWidth: 0, gridHeight: 0, explored: null, revision: -1 };
}

test('teleportOdds: the average walk from a random floor tile, and the share of the floor that reaches the spot', () => {
  // A 3x1 corridor, the spot at one end: 0, 1 and 2 steps.
  assert.deepEqual(teleportOdds(grid(3, 1), { x: 0, y: 0 }), { mean: 1, reach: 1 });
  // A wall cutting off the last tile: a third of the floor can't get there.
  const odds = teleportOdds(grid(4, 1, [[2, 0]]), { x: 0, y: 0 });
  assert.equal(odds.mean, 0.5);
  assert.equal(odds.reach, 2 / 3);
});

test('worthTeleporting: only long walks, and only when a landing should leave clearly less', () => {
  const odds = { mean: 100, reach: 1 };
  const expected = expectedAfterTeleport(odds);
  assert.equal(expected, 100 + RANDOM_TELEPORT.castSteps);
  // Far over: a scroll; about the same: walk.
  assert.ok(worthTeleporting(300, odds));
  assert.ok(!worthTeleporting(130, odds));
  // Short walks are walked whatever the odds.
  assert.ok(!worthTeleporting(RANDOM_TELEPORT.minSteps - 1, { mean: 1, reach: 1 }));
  // Most landings walled off from it: the casts that takes count against it.
  assert.ok(!worthTeleporting(300, { mean: 100, reach: 0.05 }));
  // Nowhere reaches it: never.
  assert.ok(!worthTeleporting(1000, { mean: Infinity, reach: 0 }));
});

test('Open ground is walked; a long winding way (a maze, a cave) is worth a scroll', () => {
  // A 200x200 open map: to a corner, a random landing leaves about 133 steps (8-way steps: the mean of max(x, y)), so
  // even the far corner (199) is only just worth one; to the middle (about 67), the far corner's 100 isn't.
  const open = grid(200, 200);
  const corner = teleportOdds(open, { x: 0, y: 0 });
  assert.ok(Math.abs(corner.mean - 132.8) < 1, String(corner.mean));
  assert.ok(!worthTeleporting(180, corner));
  assert.ok(!worthTeleporting(100, teleportOdds(open, { x: 100, y: 100 })));
  // A 40x40 maze of rows joined at alternate ends: from the far end it's a long way round, and a landing halves it.
  const walls: [number, number][] = [];
  for (let y = 1; y < 40; y += 2) {
    const gap = ((y - 1) / 2) % 2 === 0 ? 39 : 0;
    for (let x = 0; x < 40; x++) if (x !== gap) walls.push([x, y]);
  }
  const maze = grid(40, 40, walls);
  const odds = teleportOdds(maze, { x: 0, y: 0 });
  assert.equal(odds.reach, 1);
  const far = 39 * 20 - 1;
  assert.ok(odds.mean < far / 1.6, String(odds.mean));
  assert.ok(worthTeleporting(far, odds));
});

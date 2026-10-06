import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Journey, cheapestTile, direction, expandFrom, markPathVisited, startTile } from '../main/pathing';
import { createFrame, findCharacterOnMap, findMapBottomRight, findMapTopLeft, isBagFull, type Frame } from '../main/vision';

const WHITE = [255, 255, 255] as const;
const BLACK = [0, 0, 0] as const;
const BORDER = [198, 166, 99] as const;

function blankFrame(): Frame {
  const frame = createFrame(1600, 900);
  frame.pixels.fill(0xff336699);
  return frame;
}

function set(frame: Frame, x: number, y: number, [r, g, b]: readonly [number, number, number]): void {
  const i = (y * frame.width + x) * 4;
  frame.bytes[i] = b;
  frame.bytes[i + 1] = g;
  frame.bytes[i + 2] = r;
}

test('finds the map corners and the character inside them', () => {
  const frame = blankFrame();
  assert.equal(findMapTopLeft(frame), null);
  assert.equal(findMapBottomRight(frame), null);

  set(frame, 200, 100, BORDER);
  set(frame, 201, 100, BORDER);
  set(frame, 200, 101, BORDER);
  set(frame, 201, 101, BLACK);

  set(frame, 1200, 700, BLACK);
  set(frame, 1201, 700, BORDER);
  set(frame, 1200, 701, BORDER);
  set(frame, 1201, 701, BORDER);

  const topLeft = findMapTopLeft(frame);
  const bottomRight = findMapBottomRight(frame);
  assert.deepEqual(topLeft, { x: 200, y: 100 });
  assert.deepEqual(bottomRight, { x: 1200, y: 700 });

  assert.equal(findCharacterOnMap(frame, topLeft!, bottomRight!), null);
  set(frame, 200 + 75, 100 + 92, [0, 255, 255]);
  assert.deepEqual(findCharacterOnMap(frame, topLeft!, bottomRight!), { x: 75, y: 92 });
});

test('reads the last bag slot', () => {
  const frame = blankFrame();
  set(frame, 1558, 497, [24, 12, 12]);
  assert.equal(isBagFull(frame), false);
  set(frame, 1558, 497, WHITE);
  assert.equal(isBagFull(frame), true);
});

test('pathing expands to unvisited, unblocked neighbours and prefers the closest', () => {
  const target = { x: 30, y: 10 };
  const journey = new Journey({ x: 10, y: 10 });
  const start = startTile({ x: 10, y: 10 }, target);
  assert.equal(start.distance, 20);

  journey.walls.push({ x: 13, y: 10, cost: 0, distance: 0, parent: null });
  expandFrom(journey, start, { x: 10, y: 10 }, target);
  assert.equal(journey.active.length, 7);

  const next = cheapestTile(journey.active);
  assert.deepEqual([next.x, next.y], [13, 12]);
  assert.deepEqual(direction({ x: 10, y: 10 }, next), { x: 1, y: 1 });

  markPathVisited(journey, { ...next, y: 10 });
  assert.deepEqual(journey.visited.map((tile) => tile.x), [10, 11, 12]);
});

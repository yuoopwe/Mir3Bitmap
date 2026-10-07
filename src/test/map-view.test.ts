import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_VIEW, screenToTile, tileToScreen, type MapView } from '../main/game-memory';
import { MAIN_PANEL, TARGET_FRAME, hudPanels } from '../main/layout';

/** The map view as the reader gave it in game, at both sizes measured (zoom 100%). */
const VIEW_1600: MapView = { width: 1600, height: 900, zoom: 1, offsetX: 16, offsetY: 14, pixelX: 8, pixelY: -48 };
const VIEW_2560: MapView = { width: 2560, height: 1440, zoom: 1, offsetX: 26, offsetY: 22, pixelX: 8, pixelY: -34 };
const user = { x: 146, y: 202 };

test('the default view is the one measured at 1600x900', () => {
  assert.deepEqual(DEFAULT_VIEW, VIEW_1600);
});

test("the player's tile: the middle across, 34 px above the middle down, at both sizes", () => {
  for (const view of [VIEW_1600, VIEW_2560]) {
    assert.deepEqual(tileToScreen(user, user.x, user.y, view), { x: view.width / 2, y: view.height / 2 - 34 });
  }
  assert.deepEqual(tileToScreen(user, user.x, user.y), { x: 800, y: 416 });
  assert.deepEqual(tileToScreen(user, user.x, user.y, VIEW_2560), { x: 1280, y: 686 });
  // Wherever the player is.
  assert.deepEqual(tileToScreen({ x: 3, y: 900 }, 3, 900, VIEW_2560), { x: 1280, y: 686 });
});

test('other tiles: 48 x 32 pixels apart, from the offsets and the nudge', () => {
  // x = (tx - ux + offsetX) * 48 + pixelX + 24, y = (ty - uy + offsetY) * 32 + pixelY + 16.
  assert.deepEqual(tileToScreen(user, user.x + 3, user.y - 2, VIEW_1600), { x: 944, y: 352 });
  assert.deepEqual(tileToScreen(user, user.x - 5, user.y + 4, VIEW_2560), { x: 1040, y: 814 });
  // The top-left tile on screen: offsetX tiles left and offsetY up from the player's.
  assert.deepEqual(tileToScreen(user, user.x - 16, user.y - 14, VIEW_1600), { x: 32, y: -32 });
  assert.deepEqual(tileToScreen(user, user.x - 26, user.y - 22, VIEW_2560), { x: 32, y: -18 });
});

test('the tile under the mouse: every pixel of a tile maps back to it, at both sizes', () => {
  for (const view of [VIEW_1600, VIEW_2560]) {
    for (const [dx, dy] of [[0, 0], [7, -4], [-12, 9], [20, 3]]) {
      const tile = { x: user.x + dx, y: user.y + dy };
      const middle = tileToScreen(user, tile.x, tile.y, view);
      // The tile's own pixels: 24 either side across (less one on the right), 16 up and down.
      for (const [px, py] of [[0, 0], [-24, -16], [23, 15], [-24, 15], [23, -16]]) {
        assert.deepEqual(screenToTile(user, { x: middle.x + px, y: middle.y + py }, view), tile, `${view.width}: tile ${dx},${dy} at ${px},${py}`);
      }
    }
  }
});

test('the main panel and the target frame keep their place in a bigger game', () => {
  assert.deepEqual(hudPanels(1600, 900), [MAIN_PANEL, TARGET_FRAME]);
  const [panel, frame] = hudPanels(2560, 1440);
  // The panel along the bottom, still in the middle; the frame along the top.
  assert.deepEqual(panel, { left: 760, top: 1368, right: 1796, bottom: 1440 });
  assert.deepEqual(frame, { left: 1016, top: 46, right: 1224, bottom: 106 });
});

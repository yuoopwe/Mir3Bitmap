import type { Point } from '../shared/types';

/**
 * Screen positions for the Zircon client at 1600x900 with the default HUD,
 * measured from captured frames. Everything here is in client-area pixels.
 * With the memory reader the bot works at other sizes too: the map and the
 * game's windows come from memory then, and only the main panel and the
 * target frame are placed from here (see hudPanels).
 */
export const GAME_WIDTH = 1600;
export const GAME_HEIGHT = 900;

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Where the player's character stands (just below the overhead HP/MP bars)... */
export const PLAYER: Point = { x: 800, y: 365 };
/** ...this far above the middle of their tile (which the map view gives at any size). */
export const PLAYER_ABOVE_TILE = 51;

/** The target frame, when it's showing: at the top, a little left of the middle. */
export const TARGET_FRAME: Rect = { left: 536, top: 46, right: 744, bottom: 106 };

/** The main HUD panel, at the bottom in the middle. */
export const MAIN_PANEL: Rect = { left: 280, top: 828, right: 1316, bottom: 900 };

/** HUD panels whose text would otherwise look like monster names (apart from the target frame, which comes and goes). */
export const PANEL_MASKS: Rect[] = [
  { left: 0, top: 0, right: 85, bottom: 48 }, // top-left buttons
  { left: 900, top: 0, right: 1080, bottom: 32 }, // buff icons
  { left: 1300, top: 0, right: 1600, bottom: 292 }, // minimap
  { left: 1268, top: 236, right: 1600, bottom: 408 }, // quest tracker
  { left: 1226, top: 420, right: 1592, bottom: 594 }, // world quest
  { left: 1200, top: 656, right: 1548, bottom: 842 }, // hunters panel
  { left: 20, top: 788, right: 610, bottom: 834 }, // chat bar
  MAIN_PANEL,
  { left: 1536, top: 836, right: 1600, bottom: 900 }, // bottom-right button
  { left: 8, top: 300, right: 256, bottom: 382 }, // social hub notice
  { left: 20, top: 520, right: 210, bottom: 570 }, // attack mode buttons
  { left: 0, top: 0, right: 545, bottom: 52 }, // skill bar
];

/** Every HUD panel, the target frame included. */
export const HUD_MASKS: Rect[] = [...PANEL_MASKS, TARGET_FRAME];

/**
 * The main panel and the target frame in a game of another size: the panel keeps its place against the bottom
 * middle of the screen, the frame against the top middle.
 */
export function hudPanels(width: number, height: number): Rect[] {
  const dx = Math.round((width - GAME_WIDTH) / 2);
  const dy = height - GAME_HEIGHT;
  return [
    { left: MAIN_PANEL.left + dx, top: MAIN_PANEL.top + dy, right: MAIN_PANEL.right + dx, bottom: MAIN_PANEL.bottom + dy },
    { left: TARGET_FRAME.left + dx, top: TARGET_FRAME.top, right: TARGET_FRAME.right + dx, bottom: TARGET_FRAME.bottom },
  ];
}

/** A horizontal bar that fills from `left` towards `right`. */
export interface Bar {
  left: number;
  right: number;
  y: number;
}

/** The selected target's HP bar in the frame at the top of the screen. */
export const TARGET_HP_BAR: Bar = { left: 586, right: 712, y: 83 };
/** The target's "hp / max" text sits over the middle of the bar. */
export const TARGET_HP_TEXT = { from: 630, to: 674 };
/** All of that text (it changes whenever the HP does, even while the bar's end is hidden under it). */
export const TARGET_HP_TEXT_AREA: Rect = { left: 600, top: 77, right: 700, bottom: 89 };
/** Where the target's name is written in the target frame. */
export const TARGET_NAME: Rect = { left: 582, top: 55, right: 730, bottom: 73 };

export const PLAYER_HP_BAR: Bar = { left: 362, right: 540, y: 853 };
export const PLAYER_MP_BAR: Bar = { left: 362, right: 540, y: 871 };

/** The player's "hp / max" and "mp / max" text over their bars. */
export const PLAYER_BAR_TEXT = { from: 430, to: 470 };

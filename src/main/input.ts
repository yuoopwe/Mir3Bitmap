/**
 * What the bot does to the game window and reads from it (src/main/win32.ts
 * for the real game), behind an interface so tests can drive the bot against a
 * stand-in game (src/test/fake-game.ts).
 */
import type * as Win32 from './win32';

export type Handle = unknown;

export interface GameInput {
  /** A visible window whose title starts with `titlePrefix`. */
  findWindow(titlePrefix: string): Handle | null;
  /** Its whole title: the game shows "Mouse Object: <name>" there for what's under the mouse. */
  windowTitle(hwnd: Handle): string;
  /** Whether the user's own mouse is over it. */
  cursorOverWindow(hwnd: Handle): boolean;
  clientSize(hwnd: Handle): { width: number; height: number };
  isMinimized(hwnd: Handle): boolean;
  /** Copies the top-left width x height of the client area into `out` (32-bit BGRA, top-down). */
  captureClient(hwnd: Handle, method: 'print' | 'blt', width: number, height: number, out: Uint8Array): void;
  keyDown(hwnd: Handle, vk: number): void;
  keyUp(hwnd: Handle, vk: number): void;
  /** `flags`: the MK_* buttons held while moving. */
  mouseMove(hwnd: Handle, x: number, y: number, flags?: number): void;
  rightDown(hwnd: Handle, x: number, y: number): void;
  rightUp(hwnd: Handle, x: number, y: number): void;
  leftDown(hwnd: Handle, x: number, y: number, flags?: number): void;
  leftUp(hwnd: Handle, x: number, y: number, flags?: number): void;
  /** Turns the wheel over (x, y): down (positive) or up (negative). */
  mouseWheel(hwnd: Handle, x: number, y: number, notches: number): void;
}

/** The key codes the bot presses, as win32.ts has them (repeated here so tests needn't load the Windows libraries). */
export const VK = {
  SHIFT: 0x10,
  ESCAPE: 0x1b,
  N1: 0x31,
  N2: 0x32,
  B: 0x42,
  D: 0x44,
  M: 0x4d,
  W: 0x57,
  F1: 0x70,
} as const;

/** Mouse message flags: the left or right button is held. */
export const MK_LBUTTON = 0x0001;
export const MK_RBUTTON = 0x0002;

/** The real game window, through win32.ts (loaded on first use: it needs Windows). */
export function windowsInput(): GameInput {
  return require('./win32') as typeof Win32;
}

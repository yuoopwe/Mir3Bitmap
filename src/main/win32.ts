import * as koffi from 'koffi';

const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const kernel32 = koffi.load('kernel32.dll');

const HANDLE = koffi.pointer('HANDLE', koffi.opaque());
export type Handle = unknown;

const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32',
  biWidth: 'int32',
  biHeight: 'int32',
  biPlanes: 'uint16',
  biBitCount: 'uint16',
  biCompression: 'uint32',
  biSizeImage: 'uint32',
  biXPelsPerMeter: 'int32',
  biYPelsPerMeter: 'int32',
  biClrUsed: 'uint32',
  biClrImportant: 'uint32',
});

const FindWindowExW = user32.func('__stdcall', 'FindWindowExW', HANDLE, [HANDLE, HANDLE, 'str16', 'str16']);
const GetWindowTextW = user32.func('__stdcall', 'GetWindowTextW', 'int', [HANDLE, 'void *', 'int']);
const IsWindowVisible = user32.func('__stdcall', 'IsWindowVisible', 'int', [HANDLE]);
const SendMessageW = user32.func('__stdcall', 'SendMessageW', 'intptr_t', [HANDLE, 'uint32', 'uintptr_t', 'intptr_t']);
const GetDC = user32.func('__stdcall', 'GetDC', HANDLE, [HANDLE]);
const PrintWindow = user32.func('__stdcall', 'PrintWindow', 'int', [HANDLE, HANDLE, 'uint32']);
const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const GetClientRect = user32.func('__stdcall', 'GetClientRect', 'int', [HANDLE, koffi.out(koffi.pointer(RECT))]);
const IsIconic = user32.func('__stdcall', 'IsIconic', 'int', [HANDLE]);
const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
const GetCursorPos = user32.func('__stdcall', 'GetCursorPos', 'int', [koffi.out(koffi.pointer(POINT))]);
const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'int', [HANDLE, koffi.out(koffi.pointer(RECT))]);
const ClientToScreen = user32.func('__stdcall', 'ClientToScreen', 'int', [HANDLE, koffi.inout(koffi.pointer(POINT))]);
const GetWindowThreadProcessId = user32.func('__stdcall', 'GetWindowThreadProcessId', 'uint32', [HANDLE, 'void *']);
const AttachThreadInput = user32.func('__stdcall', 'AttachThreadInput', 'int', ['uint32', 'uint32', 'int']);
const GetKeyboardState = user32.func('__stdcall', 'GetKeyboardState', 'int', ['void *']);
const SetKeyboardState = user32.func('__stdcall', 'SetKeyboardState', 'int', ['void *']);
const GetCurrentThreadId = kernel32.func('__stdcall', 'GetCurrentThreadId', 'uint32', []);
const ReleaseDC = user32.func('__stdcall', 'ReleaseDC', 'int', [HANDLE, HANDLE]);

const CreateCompatibleDC = gdi32.func('__stdcall', 'CreateCompatibleDC', HANDLE, [HANDLE]);
const CreateCompatibleBitmap = gdi32.func('__stdcall', 'CreateCompatibleBitmap', HANDLE, [HANDLE, 'int', 'int']);
const SelectObject = gdi32.func('__stdcall', 'SelectObject', HANDLE, [HANDLE, HANDLE]);
const BitBlt = gdi32.func('__stdcall', 'BitBlt', 'int', [HANDLE, 'int', 'int', 'int', 'int', HANDLE, 'int', 'int', 'uint32']);
const GetDIBits = gdi32.func('__stdcall', 'GetDIBits', 'int', [HANDLE, HANDLE, 'uint32', 'uint32', 'void *', koffi.pointer(BITMAPINFOHEADER), 'uint32']);
const DeleteDC = gdi32.func('__stdcall', 'DeleteDC', 'int', [HANDLE]);
const DeleteObject = gdi32.func('__stdcall', 'DeleteObject', 'int', [HANDLE]);

const SRCCOPY = 0x00cc0020;
const DIB_RGB_COLORS = 0;
const BI_RGB = 0;

const WM_KEYDOWN = 0x0100;
const WM_MOUSEMOVE = 0x0200;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_LBUTTONDBLCLK = 0x0203;
const WM_KEYUP = 0x0101;
const WM_RBUTTONDOWN = 0x0204;
const WM_RBUTTONUP = 0x0205;
const WM_MOUSEWHEEL = 0x020a;
/** Mouse message flag: the left button is held. */
export const MK_LBUTTON = 0x0001;
/** Mouse message flag: the right button is held. */
export const MK_RBUTTON = 0x0002;
/** Mouse message flag: Shift is held. */
export const MK_SHIFT = 0x0004;

export const VK = {
  SHIFT: 0x10,
  CONTROL: 0x11,
  ESCAPE: 0x1b,
  N1: 0x31,
  N2: 0x32,
  B: 0x42,
  D: 0x44,
  M: 0x4d,
  P: 0x50,
  W: 0x57,
  F1: 0x70,
} as const;

const TITLE_CHARS = 512;

/**
 * Finds a visible top-level window whose title starts with `titlePrefix`.
 * The game appends live stats (FPS, ping...) to its title, so it can't be matched exactly.
 */
export function findWindow(titlePrefix: string): Handle | null {
  const prefix = titlePrefix.trim().toLowerCase();
  if (!prefix) return null;

  const text = Buffer.alloc(TITLE_CHARS * 2);
  let hwnd: Handle | null = null;
  while ((hwnd = FindWindowExW(null, hwnd, null, null))) {
    if (!IsWindowVisible(hwnd)) continue;
    const length = GetWindowTextW(hwnd, text, TITLE_CHARS);
    if (text.toString('utf16le', 0, length * 2).toLowerCase().startsWith(prefix)) return hwnd;
  }
  return null;
}

/** The window's whole title. The game shows debug details in it, such as "Mouse Object: <name>" for what's under the mouse. */
export function windowTitle(hwnd: Handle): string {
  const text = Buffer.alloc(2048 * 2);
  const length = GetWindowTextW(hwnd, text, 2048);
  return text.toString('utf16le', 0, length * 2);
}

/** Whether the real mouse cursor is over the window (the bot's own clicks are messages and don't move it). */
export function cursorOverWindow(hwnd: Handle): boolean {
  const cursor = { x: 0, y: 0 };
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!GetCursorPos(cursor) || !GetWindowRect(hwnd, rect)) return false;
  return cursor.x >= rect.left && cursor.x < rect.right && cursor.y >= rect.top && cursor.y < rect.bottom;
}

export type CaptureMethod = 'print' | 'blt';

// Ask the window to render its client area into our bitmap, including
// DirectX content, so it works even when other windows cover the game.
const PW_CLIENTONLY = 0x1;
const PW_RENDERFULLCONTENT = 0x2;

export function clientSize(hwnd: Handle): { width: number; height: number } {
  const rect = { left: 0, top: 0, right: 0, bottom: 0 };
  if (!GetClientRect(hwnd, rect)) throw new Error('GetClientRect failed (has the game window closed?)');
  return { width: rect.right - rect.left, height: rect.bottom - rect.top };
}

export function isMinimized(hwnd: Handle): boolean {
  return IsIconic(hwnd) !== 0;
}

/**
 * Copies the top-left width x height of the window's client area into `out`
 * as top-down 32-bit BGRA.
 *  - 'print' asks the game to draw itself (works while covered by other windows)
 *  - 'blt' copies what's on screen (the game must be visible)
 */
export function captureClient(hwnd: Handle, method: CaptureMethod, width: number, height: number, out: Uint8Array): void {
  const hdcSrc = GetDC(hwnd);
  if (!hdcSrc) throw new Error('GetDC failed (has the game window closed?)');
  const hdcDest = CreateCompatibleDC(hdcSrc);
  const hBitmap = CreateCompatibleBitmap(hdcSrc, width, height);
  try {
    const hOld = SelectObject(hdcDest, hBitmap);
    const copied =
      method === 'print'
        ? PrintWindow(hwnd, hdcDest, PW_CLIENTONLY | PW_RENDERFULLCONTENT)
        : BitBlt(hdcDest, 0, 0, width, height, hdcSrc, 0, 0, SRCCOPY);
    // GetDIBits requires the bitmap not to be selected into a DC.
    SelectObject(hdcDest, hOld);
    if (!copied) throw new Error(method === 'print' ? 'PrintWindow failed' : 'BitBlt failed');

    const header = {
      biSize: 40,
      biWidth: width,
      biHeight: -height, // negative = top-down rows
      biPlanes: 1,
      biBitCount: 32,
      biCompression: BI_RGB,
      biSizeImage: 0,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0,
    };
    const lines = GetDIBits(hdcSrc, hBitmap, 0, height, out, header, DIB_RGB_COLORS);
    if (lines !== height) throw new Error('GetDIBits failed');
  } finally {
    DeleteObject(hBitmap);
    DeleteDC(hdcDest);
    ReleaseDC(hwnd, hdcSrc);
  }
}

const VK_LSHIFT = 0xa0;

/**
 * Runs `action` with Shift held as far as the game can tell. Sent key
 * messages don't change the keyboard state the game reads modifiers from, so
 * briefly share our input state with the game's thread and set Shift there.
 */
export async function withShift(hwnd: Handle, action: () => Promise<void>): Promise<void> {
  const ours = GetCurrentThreadId();
  const theirs = GetWindowThreadProcessId(hwnd, null);
  const attached = theirs !== 0 && theirs !== ours && AttachThreadInput(ours, theirs, 1) !== 0;
  const original = Buffer.alloc(256);
  GetKeyboardState(original);
  const held = Buffer.from(original);
  held[VK.SHIFT] |= 0x80;
  held[VK_LSHIFT] |= 0x80;
  try {
    SetKeyboardState(held);
    keyDown(hwnd, VK.SHIFT);
    await action();
  } finally {
    keyUp(hwnd, VK.SHIFT);
    original[VK.SHIFT] &= 0x7f;
    original[VK_LSHIFT] &= 0x7f;
    SetKeyboardState(original);
    if (attached) AttachThreadInput(ours, theirs, 0);
  }
}

/** Each modifier's left-hand key, which the keyboard state holds as well (Shift, Ctrl, Alt). */
const LEFT_KEY: Record<number, number> = { 0x10: VK_LSHIFT, 0x11: 0xa2, 0x12: 0xa4 };

/** A key pressed and let go with `modifiers` held as far as the game can tell (Ctrl+Shift+P, say): as withShift does it. */
export function keyChord(hwnd: Handle, modifiers: number[], vk: number): void {
  const ours = GetCurrentThreadId();
  const theirs = GetWindowThreadProcessId(hwnd, null);
  const attached = theirs !== 0 && theirs !== ours && AttachThreadInput(ours, theirs, 1) !== 0;
  const original = Buffer.alloc(256);
  GetKeyboardState(original);
  const held = Buffer.from(original);
  for (const m of modifiers) {
    held[m] |= 0x80;
    if (LEFT_KEY[m]) held[LEFT_KEY[m]] |= 0x80;
  }
  try {
    SetKeyboardState(held);
    for (const m of modifiers) keyDown(hwnd, m);
    keyDown(hwnd, vk);
    keyUp(hwnd, vk);
  } finally {
    for (const m of [...modifiers].reverse()) keyUp(hwnd, m);
    for (const m of modifiers) {
      original[m] &= 0x7f;
      if (LEFT_KEY[m]) original[LEFT_KEY[m]] &= 0x7f;
    }
    SetKeyboardState(original);
    if (attached) AttachThreadInput(ours, theirs, 0);
  }
}

function pointParam(x: number, y: number): number {
  return ((y << 16) | (x & 0xffff)) >>> 0;
}

export function keyDown(hwnd: Handle, vk: number): void {
  SendMessageW(hwnd, WM_KEYDOWN, vk, 0);
}

export function keyUp(hwnd: Handle, vk: number): void {
  // Bits 30 and 31: the key was down and is being released.
  SendMessageW(hwnd, WM_KEYUP, vk, 0xc0000001);
}

/** `flags` are the MK_* buttons held while moving (e.g. MK_RBUTTON to keep running). */
export function mouseMove(hwnd: Handle, x: number, y: number, flags = 0): void {
  SendMessageW(hwnd, WM_MOUSEMOVE, flags, pointParam(x, y));
}

/** Right button: in this game, holding it runs towards the cursor. */
export function rightDown(hwnd: Handle, x: number, y: number): void {
  SendMessageW(hwnd, WM_RBUTTONDOWN, MK_RBUTTON, pointParam(x, y));
}

export function rightUp(hwnd: Handle, x: number, y: number): void {
  SendMessageW(hwnd, WM_RBUTTONUP, 0, pointParam(x, y));
}

/** `flags` are the MK_* modifier bits held during the click. */
export function leftDown(hwnd: Handle, x: number, y: number, flags = 0): void {
  SendMessageW(hwnd, WM_LBUTTONDOWN, flags | 0x0001, pointParam(x, y));
}

export function leftUp(hwnd: Handle, x: number, y: number, flags = 0): void {
  SendMessageW(hwnd, WM_LBUTTONUP, flags, pointParam(x, y));
}

/** A double-click as Windows delivers one: down, up, the double-click message (in place of the second down), up. */
export function doubleClick(hwnd: Handle, x: number, y: number): void {
  mouseMove(hwnd, x, y);
  leftDown(hwnd, x, y);
  leftUp(hwnd, x, y);
  SendMessageW(hwnd, WM_LBUTTONDBLCLK, 0x0001, pointParam(x, y));
  leftUp(hwnd, x, y);
}

/** Turns the mouse wheel over (x, y) in the window:  down (positive) or up (negative). */
export function mouseWheel(hwnd: Handle, x: number, y: number, notches: number): void {
  mouseMove(hwnd, x, y);
  // The wheel message takes screen coordinates.
  const point = { x, y };
  ClientToScreen(hwnd, point);
  const delta = (-notches * 120) & 0xffff;
  SendMessageW(hwnd, WM_MOUSEWHEEL, (delta << 16) >>> 0, pointParam(point.x, point.y));
}

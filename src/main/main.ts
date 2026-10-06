import { app, BrowserWindow, ipcMain, nativeImage } from 'electron';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Area, Destination, KeyId, NameRule, Settings, Status } from '../shared/types';
import { Bot } from './bot';
import type { Rect } from './layout';
import { NameBook } from './names';
import { TriadMemory } from './triad-memory';
import { GameMemory } from './game-memory';
import type { Frame } from './vision';

const KEY_IDS: KeyId[] = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12', 'N1'];

const defaultSettings: Settings = {
  windowTitle: 'Legend of Mir III - Xtreme Edition',
  capture: 'print',
  attack: false,
  archer: false,
  skipMonsters: [],
  pauseOnMouse: false,
  sellItems: false,
  keys: Object.fromEntries(KEY_IDS.map((id) => [id, { enabled: false, seconds: 0 }])) as Settings['keys'],
  delays: { attackClick: 200, pickUpClick: 50, quickKey: 100, buffKey: 1500, itemKey: 1000, runStep: 400, menu: 200 },
  fuzzPercent: 20,
  explorePercent: 95,
  exploreAutoRestart: true,
  exploreTeleport: true,
  gatherPlants: true,
  gatherOre: true,
  trainKey: 'F1',
  trainIntervalMs: 1000,
  hunt: { roam: false, loot: true, pickUpKey: '', hpPotionKey: '', hpPotionPercent: 50, mpPotionKey: '', mpPotionPercent: 30, unstuckKey: 'F2', randomTeleportKey: '1' },
};

const areasDir = path.join(app.getAppPath(), 'areas');
let window: BrowserWindow | null = null;

// ---- Learned names, saved between runs ----

const namesFile = path.join(app.getPath('userData'), 'names.json');
let namesTimer: NodeJS.Timeout | null = null;

const names = new NameBook(() => {
  // Changes come in bursts (a new screen full of names), so batch them.
  if (namesTimer) return;
  namesTimer = setTimeout(() => {
    namesTimer = null;
    writeFileSync(namesFile, JSON.stringify(names.toJSON()));
    window?.webContents.send('names', names.list());
  }, 500);
});

try {
  const saved: unknown = JSON.parse(readFileSync(namesFile, 'utf8'));
  // Names saved by the old version are converted (and mostly dropped): keep the original.
  if (Array.isArray(saved)) copyFileSync(namesFile, path.join(app.getPath('userData'), 'names-old.json'));
  names.load(saved);
} catch {
  // First run, or the file is unreadable: start learning from scratch.
}

// ---- Triple Triad memory (how digits look on the board, opponents' decks), saved between runs ----

const triadFile = path.join(app.getPath('userData'), 'triad.json');
let triadTimer: NodeJS.Timeout | null = null;

const triad = new TriadMemory(() => {
  if (triadTimer) return;
  triadTimer = setTimeout(() => {
    triadTimer = null;
    writeFileSync(triadFile, JSON.stringify(triad.toJSON()));
  }, 1000);
});

try {
  triad.load(JSON.parse(readFileSync(triadFile, 'utf8')));
} catch {
  // Nothing learned yet.
}

/** Crops `box` out of a frame and returns it as a PNG data URL. */
function imageOf(frame: Frame, box: Rect): string {
  const left = Math.max(box.left, 0);
  const top = Math.max(box.top, 0);
  const width = Math.min(box.right, frame.width) - left;
  const height = Math.min(box.bottom, frame.height) - top;
  const crop = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((top + y) * frame.width + left) * 4;
    crop.set(frame.bytes.subarray(from, from + width * 4), y * width * 4);
  }
  for (let i = 3; i < crop.length; i += 4) crop[i] = 255;
  return nativeImage.createFromBitmap(crop, { width, height }).toDataURL();
}

const bot = new Bot(defaultSettings, {
  names,
  triad,
  memory: new GameMemory(path.join(app.getAppPath(), 'game-reader')),
  monsters: (list: string[]) => window?.webContents.send('monsters', list),
  imageOf,
  report: (status: Status) => window?.webContents.send('bot:status', status),
});

// ---- Areas ----

async function listAreas(): Promise<string[]> {
  const files = await readdir(areasDir);
  return files.filter((file) => file.toLowerCase().endsWith('.json')).map((file) => file.slice(0, -'.json'.length));
}

interface AreaFile {
  Name: string;
  Areas: { Name: string; Location: { X: number; Y: number } }[];
}

async function loadArea(name: string): Promise<Area> {
  // Only open files that are actually in the areas folder.
  if (!(await listAreas()).includes(name)) throw new Error(`Unknown area "${name}"`);
  const text = await readFile(path.join(areasDir, `${name}.json`), 'utf8');
  // Files saved from Visual Studio start with a byte order mark.
  const file: AreaFile = JSON.parse(text.replace(/^﻿/, ''));
  return {
    name: file.Name,
    destinations: file.Areas.map((area) => ({ name: area.Name, location: { x: area.Location.X, y: area.Location.Y } })),
  };
}

ipcMain.handle('bot:attack', () => bot.startAttack());
ipcMain.handle('bot:explore', () => bot.startExplore());
ipcMain.handle('bot:triad', () => bot.startTriad());
ipcMain.handle('bot:train', () => bot.startTrain());
ipcMain.handle('bot:deck', () => bot.startDeck());
ipcMain.handle('bot:gather', () => bot.startGather());
ipcMain.handle('bot:travel', (_event, destination: Destination) => bot.startTravel(destination));
ipcMain.handle('bot:stop', () => bot.stop());
ipcMain.handle('settings:update', (_event, settings: Settings) => bot.updateSettings({ ...defaultSettings, ...settings }));
ipcMain.handle('areas:list', () => listAreas());
ipcMain.handle('areas:load', (_event, name: string) => loadArea(name));
ipcMain.handle('names:list', () => names.list());
ipcMain.handle('names:rule', (_event, fingerprint: string, rule: NameRule) => names.setRule(fingerprint, rule));
ipcMain.handle('names:forget', (_event, fingerprint: string) => names.forget(fingerprint));
ipcMain.handle('stats:load', (_event, saved: unknown) => bot.loadStats(saved));
ipcMain.handle('stats:reset', () => bot.resetStats());

app.whenReady().then(() => {
  window = new BrowserWindow({
    width: 760,
    height: 800,
    title: 'Bitmat Bot',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.on('closed', () => {
    window = null;
  });
  void window.loadFile(path.join(app.getAppPath(), 'src', 'renderer', 'index.html'));
});

app.on('window-all-closed', () => {
  bot.stop();
  if (namesTimer) writeFileSync(namesFile, JSON.stringify(names.toJSON()));
  if (triadTimer) writeFileSync(triadFile, JSON.stringify(triad.toJSON()));
  app.quit();
});

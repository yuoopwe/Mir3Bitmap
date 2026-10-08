import { contextBridge, ipcRenderer } from 'electron';
import type { BotApi } from '../shared/types';

const api: BotApi = {
  startAttack: () => ipcRenderer.invoke('bot:attack'),
  startExplore: () => ipcRenderer.invoke('bot:explore'),
  startTriad: () => ipcRenderer.invoke('bot:triad'),
  startTrain: () => ipcRenderer.invoke('bot:train'),
  startDeck: () => ipcRenderer.invoke('bot:deck'),
  startGather: () => ipcRenderer.invoke('bot:gather'),
  startTravel: (placeId) => ipcRenderer.invoke('bot:travel', placeId),
  startGrind: () => ipcRenderer.invoke('bot:grind'),
  startQuests: () => ipcRenderer.invoke('bot:quests'),
  startCircuit: () => ipcRenderer.invoke('bot:circuit'),
  checkGear: () => ipcRenderer.invoke('bot:check-gear'),
  searchPlaces: (query) => ipcRenderer.invoke('travel:search', query),
  stop: () => ipcRenderer.invoke('bot:stop'),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  listNames: () => ipcRenderer.invoke('names:list'),
  setNameRule: (fingerprint, rule) => ipcRenderer.invoke('names:rule', fingerprint, rule),
  forgetName: (fingerprint) => ipcRenderer.invoke('names:forget', fingerprint),
  loadStats: (saved) => ipcRenderer.invoke('stats:load', saved),
  resetStats: () => ipcRenderer.invoke('stats:reset'),
  onStatus: (listener) => {
    ipcRenderer.on('bot:status', (_event, status) => listener(status));
  },
  onMonsters: (listener) => {
    ipcRenderer.on('monsters', (_event, names) => listener(names));
  },
  onCircuit: (listener) => {
    ipcRenderer.on('circuit', (_event, view) => listener(view));
  },
  onStatGuide: (listener) => {
    ipcRenderer.on('stat-guide', (_event, view) => listener(view));
  },
  onKept: (listener) => {
    ipcRenderer.on('kept', (_event, items) => listener(items));
  },
  onNames: (listener) => {
    ipcRenderer.on('names', (_event, names) => listener(names));
  },
};

contextBridge.exposeInMainWorld('bot', api);

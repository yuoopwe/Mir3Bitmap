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
  searchPlaces: (query) => ipcRenderer.invoke('travel:search', query),
  stop: () => ipcRenderer.invoke('bot:stop'),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
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
  onNames: (listener) => {
    ipcRenderer.on('names', (_event, names) => listener(names));
  },
};

contextBridge.exposeInMainWorld('bot', api);

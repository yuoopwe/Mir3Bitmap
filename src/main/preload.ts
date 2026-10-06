import { contextBridge, ipcRenderer } from 'electron';
import type { BotApi } from '../shared/types';

const api: BotApi = {
  startAttack: () => ipcRenderer.invoke('bot:attack'),
  startExplore: () => ipcRenderer.invoke('bot:explore'),
  startTriad: () => ipcRenderer.invoke('bot:triad'),
  startTrain: () => ipcRenderer.invoke('bot:train'),
  startDeck: () => ipcRenderer.invoke('bot:deck'),
  startGather: () => ipcRenderer.invoke('bot:gather'),
  startTravel: (destination) => ipcRenderer.invoke('bot:travel', destination),
  stop: () => ipcRenderer.invoke('bot:stop'),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  listAreas: () => ipcRenderer.invoke('areas:list'),
  loadArea: (name) => ipcRenderer.invoke('areas:load', name),
  listNames: () => ipcRenderer.invoke('names:list'),
  setNameRule: (fingerprint, rule) => ipcRenderer.invoke('names:rule', fingerprint, rule),
  forgetName: (fingerprint) => ipcRenderer.invoke('names:forget', fingerprint),
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

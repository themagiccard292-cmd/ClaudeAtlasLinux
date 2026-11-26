// Sandboxed preload: it may only `require('electron')`, so shared modules are imported as TYPES only
// (erased at compile time). The allow-list of channels lives in main (only registered handlers answer).
import { contextBridge, ipcRenderer } from 'electron';
import type { AtlasApi, AtlasEvent } from '../shared/ipc';

const CHANNEL = /^[a-z]+:[A-Za-z]+$/;

const api: AtlasApi = {
  invoke: (channel, ...args) => {
    if (!CHANNEL.test(channel)) return Promise.reject(new Error(`Blocked IPC channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  send: (channel, ...args) => {
    if (CHANNEL.test(channel)) ipcRenderer.send(channel, ...args);
  },
  onEvent: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, event: AtlasEvent) => cb(event);
    ipcRenderer.on('atlas:event', handler);
    return () => ipcRenderer.removeListener('atlas:event', handler);
  },
};

contextBridge.exposeInMainWorld('atlas', api);

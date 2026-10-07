// Lectern — preload for the tab strip.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lecternTabs', {
  onTabs: (cb) => ipcRenderer.on('tabs', (_e, data) => cb(data)),
  ready: () => ipcRenderer.send('tabs-ready'),
  activate: (id) => ipcRenderer.send('tabs-activate', id),
  close: (id) => ipcRenderer.send('tabs-close', id),
  newTab: () => ipcRenderer.send('tabs-new'),
  reorder: (ids) => ipcRenderer.send('tabs-reorder', ids),
});

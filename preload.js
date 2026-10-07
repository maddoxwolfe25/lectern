// Lectern — preload: the small, explicit bridge between the page and the desktop shell.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('lectern', {
  isDesktop: true,
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  // Open a document in another window (several PDFs side by side). Pass {path} or {name, data}.
  openWindow: (payload) => ipcRenderer.invoke('open-window', payload || null),
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  openDialogMulti: () => ipcRenderer.invoke('open-dialog-multi'),
  getInitialFile: () => ipcRenderer.invoke('initial-file'),
  saveFile: (name, data, defaultPath, kind) => ipcRenderer.invoke('save-file', { name, data, defaultPath, kind }),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_event, payload) => cb(payload)),
  saveMany: (files, title) => ipcRenderer.invoke('save-many', { files, title }),
  printUrl: (url) => ipcRenderer.invoke('print-url', { url }),

  // Offline neural voices (Piper). Voices download once into the app's data folder.
  tts: {
    list: () => ipcRenderer.invoke('tts-list'),
    download: (id) => ipcRenderer.invoke('tts-download', id),
    remove: (id) => ipcRenderer.invoke('tts-remove', id),
    synth: (voice, text) => ipcRenderer.invoke('tts-synth', { voice, text }),
    stop: () => ipcRenderer.invoke('tts-stop'),
    onProgress: (cb) => ipcRenderer.on('tts-progress', (_event, info) => cb(info)),
  },
});

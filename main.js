// Lectern — Electron main process
const { app, BaseWindow, BrowserWindow, WebContentsView, Menu, dialog, ipcMain, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { autoUpdater } = require('electron-updater');

app.setName('Lectern');                       // same data folder in development and when packaged

const APP_ROOT = __dirname;

/* ======================= Windows and tabs =======================
   A window is a BaseWindow holding a tab strip (one WebContentsView) and one document view per tab.
   Each document view runs the full reader, so tabs never interfere with each other. */

const TAB_H = 38;
const windows = new Set();                    // BaseWindow
const winInfo = new Map();                    // BaseWindow -> { tabsView, tabs: [tab], active: tab | null, forceClose }
const ownerOf = new Map();                    // webContents.id -> BaseWindow
const pendingOpens = new Map();               // webContents.id -> file path or { name, path, data } to open once ready
let mainWin = null;                           // the first window; the build checks run against its first tab
let mainTab = null;

const focusedWin = () => BaseWindow.getFocusedWindow() || [...windows][0] || null;
const infoOf = (win) => winInfo.get(win);
const activeTab = (win = focusedWin()) => (win && infoOf(win) ? infoOf(win).active : null);
const winOfSender = (e) => ownerOf.get(e.sender.id) || focusedWin();
const tabOfSender = (e) => { const w = ownerOf.get(e.sender.id); const info = w && infoOf(w); return info ? info.tabs.find((t) => t.id === e.sender.id) : null; };
const msg = (opts) => { const w = focusedWin(); return w ? dialog.showMessageBox(w, opts) : dialog.showMessageBox(opts); };
async function hasDocument(tab) {
  if (!tab) return false;
  try { return !!(await tab.wc.executeJavaScript('!!(window.LecternApp && window.LecternApp.state && window.LecternApp.state.pdf)')); }
  catch { return false; }
}

/* ======================= Updates (GitHub Releases) ======================= */

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = null;
let updatePromptShown = false;
autoUpdater.on('update-downloaded', (info) => {
  if (!windows.size || updatePromptShown) return;
  updatePromptShown = true;
  msg({
    type: 'info', title: 'Update ready',
    message: `Lectern ${info.version} is ready to install.`,
    detail: 'Restart now to update, or it will install the next time you close Lectern.',
    buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
  }).then(({ response }) => { if (response === 0) { stopEngines(); autoUpdater.quitAndInstall(); } });
});
autoUpdater.on('error', (err) => console.warn('[updater]', err?.message || err));

function startUpdateChecks() {
  if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) return;      // the portable exe cannot replace itself
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}
async function checkForUpdatesManually() {
  if (!app.isPackaged) { msg({ type: 'info', title: 'Updates', message: 'Updates only apply to the installed app.' }); return; }
  if (process.env.PORTABLE_EXECUTABLE_DIR) { msg({ type: 'info', title: 'Updates', message: 'The portable version does not update itself.', detail: 'Download the newest Lectern-portable.exe from the releases page and replace this file.' }); return; }
  try {
    const r = await autoUpdater.checkForUpdates();
    const remote = r?.updateInfo?.version;
    const available = typeof r?.isUpdateAvailable === 'boolean' ? r.isUpdateAvailable : (remote && remote !== app.getVersion());
    if (available) msg({ type: 'info', title: 'Update found', message: `Lectern ${remote} is downloading.`, detail: 'You will be asked to restart when it is ready.' });
    else msg({ type: 'info', title: 'Up to date', message: `Lectern ${app.getVersion()} is the latest version.` });
  } catch (err) {
    msg({ type: 'warning', title: 'Could not check for updates', message: err?.message || String(err) });
  }
}

// Serve the renderer over a privileged custom scheme so fetch(), workers and localStorage
// behave exactly as they do on the web version.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

function pdfFromArgv(argv) {
  return argv.slice(1).find((a) => /\.pdf$/i.test(a) && !a.startsWith('-') && fs.existsSync(a)) || null;
}

function readPdf(filePath) {
  try {
    return { name: path.basename(filePath), path: filePath, data: fs.readFileSync(filePath) };
  } catch (err) {
    dialog.showErrorBox('Could not open file', `${filePath}\n\n${err.message}`);
    return null;
  }
}

// Open a path: in the active tab if it is empty, otherwise in a new tab of the focused window.
async function openPath(filePath, { replace = false, win = focusedWin() } = {}) {
  if (!win) { createWindow({ open: filePath }); return; }
  const tab = activeTab(win);
  if (!tab || (!replace && await hasDocument(tab))) { addTab(win, { open: filePath }); return; }
  const payload = readPdf(filePath);
  if (payload) tab.wc.send('open-file', { ...payload, replace: true });
}

async function openDialog(multi = false, parent = focusedWin()) {
  const opts = {
    title: multi ? 'Choose PDFs to merge' : 'Open PDF',
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
  };
  const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  if (r.canceled || !r.filePaths[0]) return null;
  if (multi) return r.filePaths.map(readPdf).filter(Boolean);
  app.addRecentDocument(r.filePaths[0]);
  return readPdf(r.filePaths[0]);
}

/* ======================= Natural voices (Piper, offline) ======================= */

const PIPER_DIR = app.isPackaged ? path.join(process.resourcesPath, 'piper') : path.join(APP_ROOT, 'vendor', 'piper');
const PIPER_EXE = path.join(PIPER_DIR, 'piper.exe');
const VOICES_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/';
const VOICE_CATALOGUE = [
  { id: 'en_US-hfc_female-medium', name: 'HFC female', lang: 'en-US', quality: 'medium', mb: 63, dir: 'en/en_US/hfc_female/medium' },
  { id: 'en_US-hfc_male-medium', name: 'HFC male', lang: 'en-US', quality: 'medium', mb: 63, dir: 'en/en_US/hfc_male/medium' },
  { id: 'en_US-amy-medium', name: 'Amy', lang: 'en-US', quality: 'medium', mb: 63, dir: 'en/en_US/amy/medium' },
  { id: 'en_US-lessac-high', name: 'Lessac', lang: 'en-US', quality: 'high', mb: 115, dir: 'en/en_US/lessac/high' },
  { id: 'en_US-ryan-high', name: 'Ryan', lang: 'en-US', quality: 'high', mb: 115, dir: 'en/en_US/ryan/high' },
  { id: 'en_GB-cori-high', name: 'Cori', lang: 'en-GB', quality: 'high', mb: 115, dir: 'en/en_GB/cori/high' },
  { id: 'en_GB-alan-medium', name: 'Alan', lang: 'en-GB', quality: 'medium', mb: 63, dir: 'en/en_GB/alan/medium' },
  { id: 'en_GB-alba-medium', name: 'Alba', lang: 'en-GB', quality: 'medium', mb: 63, dir: 'en/en_GB/alba/medium' },
  { id: 'en_GB-northern_english_male-medium', name: 'Northern English male', lang: 'en-GB', quality: 'medium', mb: 63, dir: 'en/en_GB/northern_english_male/medium' },
];
const voicesDir = () => path.join(app.getPath('userData'), 'voices');
const voiceFiles = (id) => ({ model: path.join(voicesDir(), id + '.onnx'), config: path.join(voicesDir(), id + '.onnx.json') });
function voiceInstalled(id) {
  const f = voiceFiles(id);
  try { return fs.statSync(f.model).size > 1_000_000 && fs.existsSync(f.config); } catch { return false; }
}
function listVoices() {
  return {
    available: fs.existsSync(PIPER_EXE),
    voices: VOICE_CATALOGUE.map((v) => ({ ...v, installed: voiceInstalled(v.id) })),
  };
}

const activeDownloads = new Map();
async function downloadFile(url, dest, onProgress) {
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path.basename(dest)}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = dest + '.part';
  const fd = fs.openSync(tmp, 'w');
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      fs.writeSync(fd, value);
      received += value.length;
      onProgress(received, total);
    }
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, dest);
}
async function downloadVoice(id, sender) {
  const v = VOICE_CATALOGUE.find((x) => x.id === id);
  if (!v) return { ok: false, error: 'Unknown voice' };
  if (voiceInstalled(id)) return { ok: true };
  if (activeDownloads.has(id)) return activeDownloads.get(id);
  const job = (async () => {
    fs.mkdirSync(voicesDir(), { recursive: true });
    const f = voiceFiles(id);
    const report = (received, total, extra = {}) => { try { sender.send('tts-progress', { id, received, total, ...extra }); } catch { /* window gone */ } };
    try {
      await downloadFile(`${VOICES_BASE}${v.dir}/${id}.onnx.json`, f.config, () => {});
      await downloadFile(`${VOICES_BASE}${v.dir}/${id}.onnx`, f.model, report);
      report(1, 1, { done: true });
      return { ok: true };
    } catch (err) {
      for (const p of [f.model, f.model + '.part', f.config]) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
      report(0, 0, { error: err.message });
      return { ok: false, error: err.message };
    } finally { activeDownloads.delete(id); }
  })();
  activeDownloads.set(id, job);
  return job;
}
function removeVoice(id) {
  const f = voiceFiles(id);
  stopEngines();
  for (const p of [f.model, f.config]) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  return { ok: true };
}

// One resident Piper process per voice (only the most recent one is kept alive).
const engines = new Map();
let synthCounter = 0;
function stopEngines(except = null) {
  for (const [id, eng] of engines) {
    if (id === except) continue;
    try { eng.proc.stdin.end(); eng.proc.kill(); } catch { /* ignore */ }
    for (const job of eng.queue) job.reject(new Error('voice stopped'));
    if (eng.current) eng.current.reject(new Error('voice stopped'));
    engines.delete(id);
  }
}
function getEngine(id) {
  if (engines.has(id)) return engines.get(id);
  stopEngines(id);
  if (!voiceInstalled(id)) throw new Error('That voice is not installed');
  const f = voiceFiles(id);
  const outDir = path.join(os.tmpdir(), 'lectern-tts');
  fs.mkdirSync(outDir, { recursive: true });
  const proc = spawn(PIPER_EXE, [
    '--model', f.model, '--config', f.config, '--output_dir', outDir, '--json-input', '--quiet',
    '--espeak_data', path.join(PIPER_DIR, 'espeak-ng-data'), '--sentence_silence', '0.12',
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const eng = { id, proc, queue: [], current: null, outDir, idleTimer: 0 };
  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
      if (!line || !eng.current) continue;
      const job = eng.current; eng.current = null;
      clearTimeout(job.timer);
      try {
        const wav = fs.readFileSync(job.file);
        try { fs.unlinkSync(job.file); } catch { /* ignore */ }
        job.resolve(wav);
      } catch (err) { job.reject(err); }
      pump(eng);
    }
  });
  proc.stderr.on('data', (d) => { const s = d.toString(); if (/error/i.test(s)) console.error('[piper]', s.trim()); });
  proc.on('exit', () => {
    if (engines.get(id) === eng) engines.delete(id);
    if (eng.current) eng.current.reject(new Error('voice process exited'));
    for (const job of eng.queue) job.reject(new Error('voice process exited'));
    eng.queue = [];
  });
  engines.set(id, eng);
  return eng;
}
function pump(eng) {
  clearTimeout(eng.idleTimer);
  if (eng.current || !eng.queue.length) {
    if (!eng.queue.length) eng.idleTimer = setTimeout(() => stopEngines(), 5 * 60 * 1000);   // free memory when idle
    return;
  }
  const job = eng.queue.shift();
  eng.current = job;
  job.file = path.join(eng.outDir, `${process.pid}-${++synthCounter}.wav`);
  job.timer = setTimeout(() => { if (eng.current === job) { eng.current = null; job.reject(new Error('voice timed out')); try { eng.proc.kill(); } catch { /* ignore */ } } }, 45000);
  try { eng.proc.stdin.write(JSON.stringify({ text: job.text, output_file: job.file }) + '\n'); }
  catch (err) { eng.current = null; job.reject(err); }
}
function synthesize(voice, text) {
  return new Promise((resolve, reject) => {
    let eng;
    try { eng = getEngine(voice); } catch (err) { reject(err); return; }
    eng.queue.push({ text: String(text).replace(/\s+/g, ' ').trim(), resolve, reject });
    pump(eng);
  });
}

/* ======================= Window and tab management ======================= */

function layoutViews(win) {
  const info = infoOf(win); if (!info || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  info.tabsView.setBounds({ x: 0, y: 0, width: w, height: TAB_H });
  for (const t of info.tabs) t.view.setBounds({ x: 0, y: TAB_H, width: w, height: Math.max(0, h - TAB_H) });
}

function pushTabs(win) {
  const info = infoOf(win); if (!info || win.isDestroyed()) return;
  const tabs = info.tabs.map((t) => ({ id: t.id, title: (t.title || 'Lectern').replace(/ · Lectern$/, '') || 'Lectern', dirty: t.dirty, active: t === info.active }));
  try { info.tabsView.webContents.send('tabs', { tabs }); } catch { /* not ready yet */ }
  buildMenu();
}

function activateTab(win, tab) {
  const info = infoOf(win); if (!info || !info.tabs.includes(tab)) return;
  info.active = tab;
  for (const t of info.tabs) t.view.setVisible(t === tab);
  win.setTitle((tab.title || 'Lectern').replace(/ · Lectern$/, '') === 'Lectern' ? 'Lectern' : tab.title);
  try { tab.wc.focus(); } catch { /* ignore */ }
  pushTabs(win);
}

function addTab(win, { open = null, activate = true } = {}) {
  const info = infoOf(win); if (!info) return null;
  const view = new WebContentsView({
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false,
    },
  });
  view.setBackgroundColor('#171c24');
  const wc = view.webContents;
  const tab = { id: wc.id, view, wc, title: 'Lectern', dirty: false };
  info.tabs.push(tab);
  ownerOf.set(wc.id, win);
  if (open) pendingOpens.set(wc.id, open);
  if (!mainTab) mainTab = tab;
  wc.setWindowOpenHandler(({ url }) => { if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  wc.on('page-title-updated', (_e, title) => { tab.title = title; if (info.active === tab) win.setTitle(title); pushTabs(win); });
  wc.on('will-prevent-unload', (e) => {
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning', title: 'Unsaved edits', buttons: ['Close without saving', 'Keep editing'], defaultId: 1, cancelId: 1,
      message: `${(tab.title || 'This document').replace(/ · Lectern$/, '')} has edits that have not been saved.`, detail: 'Close the tab anyway?',
    });
    if (r === 1) e.preventDefault();
  });
  wc.on('destroyed', () => removeTab(win, tab, true));
  win.contentView.addChildView(view);
  wc.loadURL('app://lectern/index.html');
  layoutViews(win);
  if (activate) activateTab(win, tab); else view.setVisible(false);
  pushTabs(win);
  return tab;
}

function removeTab(win, tab, destroyed = false) {
  const info = infoOf(win); if (!info) return;
  const i = info.tabs.indexOf(tab); if (i < 0) return;
  info.tabs.splice(i, 1);
  ownerOf.delete(tab.wc.id); pendingOpens.delete(tab.wc.id);
  if (mainTab === tab) mainTab = null;
  try { win.contentView.removeChildView(tab.view); } catch { /* ignore */ }
  if (!destroyed) { try { tab.wc.close(); } catch { /* ignore */ } }
  if (!info.tabs.length) { info.forceClose = true; if (!win.isDestroyed()) win.close(); return; }
  if (info.active === tab) activateTab(win, info.tabs[Math.min(i, info.tabs.length - 1)]);
  pushTabs(win);
}

function closeTab(win, tab) { if (tab && !tab.wc.isDestroyed()) tab.wc.close(); }   // beforeunload may ask about unsaved edits

function createWindow({ open = null } = {}) {
  const prev = focusedWin();
  const bounds = prev && !prev.isDestroyed() ? prev.getBounds() : null;
  const win = new BaseWindow({
    width: 1380, height: 880, minWidth: 720, minHeight: 480,
    ...(bounds ? { x: bounds.x + 32, y: bounds.y + 32, width: bounds.width, height: bounds.height } : {}),
    backgroundColor: '#0e1217',
    title: 'Lectern',
    icon: path.join(APP_ROOT, 'icon.png'),
    autoHideMenuBar: true,
    show: false,
  });
  const tabsView = new WebContentsView({ webPreferences: { preload: path.join(APP_ROOT, 'tabs-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  tabsView.setBackgroundColor('#0e1217');
  const info = { tabsView, tabs: [], active: null, forceClose: false };
  winInfo.set(win, info); windows.add(win); ownerOf.set(tabsView.webContents.id, win);
  if (!mainWin) mainWin = win;
  win.contentView.addChildView(tabsView);
  tabsView.webContents.loadURL('app://lectern/tabs.html');
  tabsView.webContents.on('did-finish-load', () => pushTabs(win));
  win.on('resize', () => layoutViews(win));
  win.on('focus', () => buildMenu());
  win.on('close', (e) => {
    const dirty = info.tabs.filter((t) => t.dirty);
    if (info.forceClose || !dirty.length) return;
    e.preventDefault();
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning', title: 'Unsaved edits', buttons: ['Close without saving', 'Keep editing'], defaultId: 1, cancelId: 1,
      message: dirty.length === 1 ? `${dirty[0].title.replace(/ · Lectern$/, '')} has edits that have not been saved.` : `${dirty.length} documents have edits that have not been saved.`,
      detail: 'Close the window anyway?',
    });
    if (r === 0) { info.forceClose = true; win.close(); }
  });
  win.on('closed', () => {
    for (const t of info.tabs) { try { if (!t.wc.isDestroyed()) t.wc.close(); } catch { /* ignore */ } ownerOf.delete(t.wc.id); pendingOpens.delete(t.wc.id); }
    ownerOf.delete(tabsView.webContents.id);
    windows.delete(win); winInfo.delete(win);
    if (mainWin === win) { mainWin = null; mainTab = null; }
    buildMenu();
  });

  const first = addTab(win, { open });
  first.wc.once('did-finish-load', () => { if (!win.isDestroyed() && !win.isVisible()) win.show(); });
  if (win === mainWin && process.argv.some((a) => a.startsWith('--smoke'))) attachSmoke(win, first);
  layoutViews(win);
  buildMenu();
  return win;
}

// `lectern --smoke [file.pdf]` boots headlessly, reports renderer errors, and exits: used by the build check.
// `--smoke-tts` synthesises a sentence; `--smoke-play` also plays it; `--smoke-ocr` recognises page 1;
// `--smoke-update` asks the update feed for the latest version; `--smoke-tabs` opens a second tab and captures the strip.
function attachSmoke(win, tab) {
  const errors = [];
  const wc = tab.wc;
  wc.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });
  wc.on('did-fail-load', (_e, code, desc) => errors.push(`did-fail-load ${code} ${desc}`));
  wc.once('did-finish-load', () => {
    setTimeout(async () => {
      const probe = await wc.executeJavaScript(
        `({ title: document.title, doc: document.getElementById('app').dataset.doc, pages: document.querySelectorAll('.page').length, rendered: document.querySelectorAll('.page.is-rendered').length, desktop: !!window.lectern, voices: speechSynthesis.getVoices().length, voiceOptions: document.getElementById('voiceSelect').options.length })`
      ).catch((e) => ({ error: String(e) }));
      if (process.argv.includes('--smoke-tts')) {
        const installed = listVoices().voices.filter((v) => v.installed);
        if (installed.length) {
          try { const t0 = Date.now(); const wav = await synthesize(installed[0].id, 'This is a natural voice test from Lectern.'); probe.tts = { voice: installed[0].id, bytes: wav.length, ms: Date.now() - t0 }; }
          catch (err) { probe.tts = { error: err.message }; errors.push('tts: ' + err.message); }
        } else probe.tts = { error: 'no installed voices' };
      }
      if (process.argv.includes('--smoke-play')) {
        const installed = listVoices().voices.filter((v) => v.installed);
        probe.play = installed.length ? await wc.executeJavaScript(
          `(async () => { try { const data = await window.lectern.tts.synth(${JSON.stringify(installed[0].id)}, 'Playback test.'); const url = URL.createObjectURL(new Blob([data], { type: 'audio/wav' })); const a = new Audio(url); const result = await new Promise((resolve) => { const t = setTimeout(() => resolve('timeout'), 8000); a.onplaying = () => { clearTimeout(t); resolve('playing'); }; a.onerror = () => { clearTimeout(t); resolve('error:' + (a.error && a.error.code)); }; a.play().catch((e) => { clearTimeout(t); resolve('play rejected: ' + e.message); }); }); a.pause(); return { result, bytes: data.length }; } catch (err) { return { error: String(err && err.message || err) }; } })()`
        ).catch((e) => ({ error: String(e) })) : { error: 'no installed voices' };
        if (probe.play.error || probe.play.result !== 'playing') errors.push('play: ' + (probe.play.error || probe.play.result));
      }
      if (process.argv.includes('--smoke-ocr')) {
        probe.ocr = await wc.executeJavaScript(
          `(async () => { const app = window.LecternApp; const t0 = performance.now(); try { const n = await app.pro.debug.recognizePages([app.state.pages[0]]); const items = app.pro.debug.ocrItems()[0] || []; return { pages: n, words: items.filter((i) => i.str.trim()).length, sample: items.slice(0, 6).map((i) => i.str).join(''), ms: Math.round(performance.now() - t0) }; } catch (err) { return { error: String(err && err.message || err) }; } })()`
        ).catch((e) => ({ error: String(e) }));
        if (probe.ocr.error) errors.push('ocr: ' + probe.ocr.error);
      }
      if (process.argv.includes('--smoke-update')) {
        try {
          autoUpdater.autoDownload = false;
          const r = await autoUpdater.checkForUpdates();
          probe.update = { current: app.getVersion(), latest: r?.updateInfo?.version, available: r?.isUpdateAvailable, files: (r?.updateInfo?.files || []).map((f) => f.url) };
        } catch (err) { probe.update = { error: err?.message || String(err) }; errors.push('update: ' + (err?.message || err)); }
      }
      if (process.argv.includes('--smoke-tabs')) {
        const second = addTab(win, { open: pendingOpensSource || null });
        await new Promise((r) => second.wc.once('did-finish-load', r));
        await new Promise((r) => setTimeout(r, 2500));
        const info = infoOf(win);
        probe.tabs = { count: info.tabs.length, active: info.tabs.indexOf(info.active), titles: info.tabs.map((t) => t.title), stripTabs: await info.tabsView.webContents.executeJavaScript('document.querySelectorAll(".tab").length').catch((e) => String(e)) };
        try {
          const outDir = path.join(APP_ROOT, 'dist'); fs.mkdirSync(outDir, { recursive: true });
          fs.writeFileSync(path.join(outDir, 'smoke-tabs.png'), (await info.tabsView.webContents.capturePage()).toPNG());
          fs.writeFileSync(path.join(outDir, 'smoke-doc.png'), (await second.wc.capturePage()).toPNG());
          probe.tabs.captures = true;
        } catch (err) { probe.tabs.captures = String(err?.message || err); }
        // switch back to the first tab and close the second
        activateTab(win, tab);
        closeTab(win, second);
        await new Promise((r) => setTimeout(r, 600));
        probe.tabs.afterClose = infoOf(win).tabs.length;
      }
      console.log('SMOKE ' + JSON.stringify({ ...probe, errors }));
      stopEngines();
      app.exit(errors.length || probe.error ? 1 : 0);
    }, 3500);
  });
}
let pendingOpensSource = null;

function buildMenu() {
  const fw = BaseWindow.getFocusedWindow();
  const windowItems = [...windows].filter((w) => !w.isDestroyed()).map((w) => ({
    label: (w.getTitle() || 'Lectern').replace(/ · Lectern$/, '') || 'Lectern',
    type: 'checkbox', checked: w === fw,
    click: () => { if (w.isMinimized()) w.restore(); w.focus(); },
  }));
  const cycle = (dir) => { const w = focusedWin(); const info = w && infoOf(w); if (!info || info.tabs.length < 2) return; const i = info.tabs.indexOf(info.active); activateTab(w, info.tabs[(i + dir + info.tabs.length) % info.tabs.length]); };
  const template = [
    {
      label: '&File',
      submenu: [
        { label: 'Open PDF…', accelerator: 'CmdOrCtrl+O', click: async () => { const f = await openDialog(); if (f) openPath(f.path); } },
        { label: 'Open PDF in this tab…', accelerator: 'CmdOrCtrl+Shift+O', click: async () => { const f = await openDialog(); if (f) openPath(f.path, { replace: true }); } },
        { label: 'New tab', accelerator: 'CmdOrCtrl+T', click: () => { const w = focusedWin(); if (w) addTab(w); else createWindow(); } },
        { label: 'New window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { type: 'separator' },
        { label: 'Open voices folder', click: () => { fs.mkdirSync(voicesDir(), { recursive: true }); shell.openPath(voicesDir()); } },
        { type: 'separator' },
        { label: 'Close tab', accelerator: 'CmdOrCtrl+W', click: () => { const w = focusedWin(); if (w) closeTab(w, activeTab(w)); } },
        { label: 'Close window', accelerator: 'CmdOrCtrl+Shift+W', click: () => focusedWin()?.close() },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Next tab', accelerator: 'CmdOrCtrl+Tab', click: () => cycle(1) },
        { label: 'Previous tab', accelerator: 'CmdOrCtrl+Shift+Tab', click: () => cycle(-1) },
        { type: 'separator' },
        { label: 'Toggle full screen', accelerator: 'F11', click: () => { const w = focusedWin(); if (w) w.setFullScreen(!w.isFullScreen()); } },
        { type: 'separator' },
        { label: 'Reload tab', accelerator: 'CmdOrCtrl+R', click: () => activeTab()?.wc.reload() },
        { label: 'Toggle developer tools', accelerator: 'CmdOrCtrl+Shift+I', click: () => activeTab()?.wc.toggleDevTools() },
      ],
    },
    {
      label: '&Window',
      submenu: [
        { label: 'Minimize', accelerator: 'CmdOrCtrl+M', click: () => focusedWin()?.minimize() },
        { type: 'separator' },
        ...(windowItems.length ? windowItems : [{ label: 'No windows', enabled: false }]),
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Check for updates…', click: checkForUpdatesManually },
        { label: 'Release notes', click: () => shell.openExternal('https://github.com/maddoxwolfe25/lectern/releases') },
        { type: 'separator' },
        {
          label: 'About Lectern',
          click: () => msg({
            type: 'info', title: 'About Lectern',
            message: `Lectern ${app.getVersion()}`,
            detail: 'A PDF reader that reads aloud. System voices come from Windows; natural voices use the open-source Piper engine and run offline on this computer.\n\nShortcuts: Space play/pause · Shift+←/→ sentence · ←/→ page · Ctrl+F find · Ctrl+O open · Ctrl+T new tab · Ctrl+Tab next tab · Ctrl+W close tab · E edit.',
          }),
        },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  for (const w of windows) { if (!w.isDestroyed()) { try { w.setMenu(menu); w.setAutoHideMenuBar(true); } catch { /* ignore */ } } }
}

/* ======================= App lifecycle ======================= */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const f = pdfFromArgv(argv);
    const w = focusedWin();
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
    if (f) openPath(f, { win: w || undefined });
    else if (!w) createWindow();
  });

  app.whenReady().then(() => {
    protocol.handle('app', (req) => {
      let rel = decodeURIComponent(new URL(req.url).pathname);
      if (rel === '/' || rel === '') rel = '/index.html';
      const file = path.normalize(path.join(APP_ROOT, rel));
      if (!file.startsWith(APP_ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return new Response('Not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(file).toString());
    });

    // tab strip
    ipcMain.on('tabs-ready', (e) => { const w = winOfSender(e); if (w) pushTabs(w); });
    ipcMain.on('tabs-activate', (e, id) => { const w = winOfSender(e); const t = w && infoOf(w)?.tabs.find((x) => x.id === id); if (t) activateTab(w, t); });
    ipcMain.on('tabs-close', (e, id) => { const w = winOfSender(e); const t = w && infoOf(w)?.tabs.find((x) => x.id === id); if (t) closeTab(w, t); });
    ipcMain.on('tabs-new', async (e) => { const w = winOfSender(e); if (!w) return; const f = await openDialog(false, w); if (f) addTab(w, { open: f.path }); });
    ipcMain.on('tabs-reorder', (e, ids) => {
      const w = winOfSender(e); const info = w && infoOf(w); if (!info || !Array.isArray(ids)) return;
      const byId = new Map(info.tabs.map((t) => [t.id, t]));
      const next = ids.map((id) => byId.get(id)).filter(Boolean);
      if (next.length === info.tabs.length) { info.tabs = next; pushTabs(w); }
    });
    // document views
    ipcMain.on('tab-dirty', (e, dirty) => { const w = winOfSender(e); const t = tabOfSender(e); if (t) { t.dirty = !!dirty; pushTabs(w); } });
    ipcMain.handle('open-tab', (e, payload) => {
      const w = winOfSender(e) || createWindow();
      if (payload && typeof payload.path === 'string' && fs.existsSync(payload.path)) addTab(w, { open: payload.path });
      else if (payload && payload.data) addTab(w, { open: { name: payload.name || 'document.pdf', path: '', data: Buffer.from(payload.data) } });
      else addTab(w);
      return true;
    });
    ipcMain.handle('open-dialog', (e) => openDialog(false, winOfSender(e)));
    ipcMain.handle('open-dialog-multi', (e) => openDialog(true, winOfSender(e)));
    ipcMain.handle('initial-file', (e) => {
      const pending = pendingOpens.get(e.sender.id);
      pendingOpens.delete(e.sender.id);
      if (!pending) return null;
      return typeof pending === 'string' ? readPdf(pending) : pending;
    });
    const KIND_FILTERS = {
      pdf: ['PDF documents', ['pdf']], markdown: ['Markdown', ['md']], zip: ['Zip archive', ['zip']], docx: ['Word document', ['docx']],
      txt: ['Text file', ['txt']], html: ['Web page', ['html']], png: ['PNG image', ['png']], jpg: ['JPEG image', ['jpg', 'jpeg']], any: ['All files', ['*']],
    };
    ipcMain.handle('save-file', async (e, { name, data, defaultPath, kind }) => {
      const [label, exts] = KIND_FILTERS[kind] || KIND_FILTERS.pdf;
      const parent = winOfSender(e);
      const opts = {
        title: kind === 'markdown' ? 'Save Markdown' : kind && kind !== 'pdf' ? `Save ${label}` : 'Save PDF',
        defaultPath: defaultPath || name || `document.${exts[0]}`,
        filters: [{ name: label, extensions: exts }],
      };
      const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
      if (r.canceled || !r.filePath) return { ok: false };
      try { fs.writeFileSync(r.filePath, typeof data === 'string' ? data : Buffer.from(data)); return { ok: true, path: r.filePath }; }
      catch (err) { dialog.showErrorBox('Could not save', err.message); return { ok: false }; }
    });
    // Save several files into a folder the user picks (page images, split documents).
    ipcMain.handle('save-many', async (e, { files, title }) => {
      const parent = winOfSender(e);
      const opts = { title: title || 'Choose a folder', properties: ['openDirectory', 'createDirectory'] };
      const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
      if (r.canceled || !r.filePaths[0]) return { ok: false };
      const dir = r.filePaths[0];
      let count = 0;
      try {
        for (const f of files) { fs.writeFileSync(path.join(dir, path.basename(f.name)), typeof f.data === 'string' ? f.data : Buffer.from(f.data)); count++; }
        return { ok: true, dir, count };
      } catch (err) { dialog.showErrorBox('Could not save', err.message); return { ok: false, error: err.message }; }
    });
    // Create a PDF from a web page by printing it in a hidden window.
    ipcMain.handle('print-url', async (_e, { url }) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('Enter a full web address starting with http:// or https://');
      const w = new BrowserWindow({ show: false, width: 1100, height: 1400, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, images: true } });
      try {
        w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        await w.loadURL(url);
        await new Promise((r) => setTimeout(r, 1500));                      // let web fonts and lazy images settle
        const pdf = await w.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' }, preferCSSPageSize: false });
        const title = (w.webContents.getTitle() || new URL(url).hostname).replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80);
        return { name: (title || 'web page') + '.pdf', data: pdf };
      } finally { w.destroy(); }
    });
    ipcMain.handle('tts-list', () => listVoices());
    ipcMain.handle('tts-download', (e, id) => downloadVoice(String(id), e.sender));
    ipcMain.handle('tts-remove', (_e, id) => removeVoice(String(id)));
    ipcMain.handle('tts-synth', async (_e, { voice, text }) => {
      if (!VOICE_CATALOGUE.some((v) => v.id === voice)) throw new Error('Unknown voice');
      return synthesize(voice, text);
    });
    ipcMain.handle('tts-stop', () => { stopEngines(); return true; });

    const first = pdfFromArgv(process.argv);
    pendingOpensSource = first;
    createWindow({ open: first });
    if (!process.argv.some((a) => a.startsWith('--smoke'))) startUpdateChecks();

    app.on('activate', () => { if (!windows.size) createWindow(); });
  });
}

app.on('before-quit', () => { for (const info of winInfo.values()) info.forceClose = true; stopEngines(); });
app.on('window-all-closed', () => app.quit());

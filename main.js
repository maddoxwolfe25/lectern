// Lectern — Electron main process
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { autoUpdater } = require('electron-updater');

app.setName('Lectern');                       // same data folder in development and when packaged

/* ======================= Updates (GitHub Releases) ======================= */

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = null;
let updatePromptShown = false;
autoUpdater.on('update-downloaded', (info) => {
  if (!win || updatePromptShown) return;
  updatePromptShown = true;
  dialog.showMessageBox(win, {
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
  if (!app.isPackaged) { dialog.showMessageBox(win, { type: 'info', title: 'Updates', message: 'Updates only apply to the installed app.' }); return; }
  if (process.env.PORTABLE_EXECUTABLE_DIR) { dialog.showMessageBox(win, { type: 'info', title: 'Updates', message: 'The portable version does not update itself.', detail: 'Download the newest Lectern-portable.exe from the releases page and replace this file.' }); return; }
  try {
    const r = await autoUpdater.checkForUpdates();
    const remote = r?.updateInfo?.version;
    const available = typeof r?.isUpdateAvailable === 'boolean' ? r.isUpdateAvailable : (remote && remote !== app.getVersion());
    if (available) dialog.showMessageBox(win, { type: 'info', title: 'Update found', message: `Lectern ${remote} is downloading.`, detail: 'You will be asked to restart when it is ready.' });
    else dialog.showMessageBox(win, { type: 'info', title: 'Up to date', message: `Lectern ${app.getVersion()} is the latest version.` });
  } catch (err) {
    dialog.showMessageBox(win, { type: 'warning', title: 'Could not check for updates', message: err?.message || String(err) });
  }
}

const APP_ROOT = __dirname;
let win = null;
let pendingFile = null;

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

function sendFile(filePath) {
  const payload = readPdf(filePath);
  if (payload && win) win.webContents.send('open-file', payload);
}

async function openDialog(multi = false) {
  const r = await dialog.showOpenDialog(win, {
    title: multi ? 'Choose PDFs to merge' : 'Open PDF',
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
  });
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

/* ======================= Window and app lifecycle ======================= */

function createWindow() {
  win = new BrowserWindow({
    width: 1380, height: 880, minWidth: 720, minHeight: 480,
    backgroundColor: '#171c24',
    title: 'Lectern',
    icon: path.join(APP_ROOT, 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(APP_ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });

  // `lectern --smoke [file.pdf]` boots headlessly, reports renderer errors, and exits: used by the build check.
  // `--smoke-tts` additionally synthesises a sentence with the first installed natural voice;
  // `--smoke-update` asks the update feed what the latest version is (without downloading).
  const smoke = process.argv.some((a) => a.startsWith('--smoke'));
  if (smoke) {
    const errors = [];
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });
    win.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`did-fail-load ${code} ${desc}`));
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const probe = await win.webContents.executeJavaScript(
          `({ title: document.title, doc: document.getElementById('app').dataset.doc, pages: document.querySelectorAll('.page').length, rendered: document.querySelectorAll('.page.is-rendered').length, desktop: !!window.lectern, voices: speechSynthesis.getVoices().length, voiceOptions: document.getElementById('voiceSelect').options.length })`
        ).catch((e) => ({ error: String(e) }));
        if (process.argv.includes('--smoke-tts')) {
          const installed = listVoices().voices.filter((v) => v.installed);
          if (installed.length) {
            try { const t0 = Date.now(); const wav = await synthesize(installed[0].id, 'This is a natural voice test from Lectern.'); probe.tts = { voice: installed[0].id, bytes: wav.length, ms: Date.now() - t0 }; }
            catch (err) { probe.tts = { error: err.message }; errors.push('tts: ' + err.message); }
          } else probe.tts = { error: 'no installed voices' };
        }
        if (process.argv.includes('--smoke-ocr')) {
          probe.ocr = await win.webContents.executeJavaScript(
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
        console.log('SMOKE ' + JSON.stringify({ ...probe, errors }));
        stopEngines();
        app.exit(errors.length || probe.error ? 1 : 0);
      }, 3500);
    });
  }

  win.loadURL('app://lectern/index.html');
}

function buildMenu() {
  const template = [
    {
      label: '&File',
      submenu: [
        { label: 'Open PDF…', accelerator: 'CmdOrCtrl+O', click: async () => { const f = await openDialog(); if (f && win) win.webContents.send('open-file', f); } },
        { type: 'separator' },
        { label: 'Open voices folder', click: () => { fs.mkdirSync(voicesDir(), { recursive: true }); shell.openPath(voicesDir()); } },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
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
          click: () => dialog.showMessageBox(win, {
            type: 'info', title: 'About Lectern',
            message: `Lectern ${app.getVersion()}`,
            detail: 'A PDF reader that reads aloud. System voices come from Windows; natural voices use the open-source Piper engine and run offline on this computer.\n\nShortcuts: Space play/pause · Shift+←/→ sentence · ←/→ page · Ctrl+F find · Ctrl+O open · E edit.',
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const f = pdfFromArgv(argv);
    if (f) sendFile(f);
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

    ipcMain.handle('open-dialog', () => openDialog(false));
    ipcMain.handle('open-dialog-multi', () => openDialog(true));
    ipcMain.handle('initial-file', () => { const f = pendingFile; pendingFile = null; return f ? readPdf(f) : null; });
    const KIND_FILTERS = {
      pdf: ['PDF documents', ['pdf']], markdown: ['Markdown', ['md']], zip: ['Zip archive', ['zip']], docx: ['Word document', ['docx']],
      txt: ['Text file', ['txt']], html: ['Web page', ['html']], png: ['PNG image', ['png']], jpg: ['JPEG image', ['jpg', 'jpeg']],
    };
    ipcMain.handle('save-file', async (_e, { name, data, defaultPath, kind }) => {
      const [label, exts] = KIND_FILTERS[kind] || KIND_FILTERS.pdf;
      const r = await dialog.showSaveDialog(win, {
        title: kind === 'markdown' ? 'Save Markdown' : kind && kind !== 'pdf' ? `Save ${label}` : 'Save PDF',
        defaultPath: defaultPath || name || `document.${exts[0]}`,
        filters: [{ name: label, extensions: exts }],
      });
      if (r.canceled || !r.filePath) return { ok: false };
      try { fs.writeFileSync(r.filePath, typeof data === 'string' ? data : Buffer.from(data)); return { ok: true, path: r.filePath }; }
      catch (err) { dialog.showErrorBox('Could not save', err.message); return { ok: false }; }
    });
    // Save several files into a folder the user picks (page images, split documents).
    ipcMain.handle('save-many', async (_e, { files, title }) => {
      const r = await dialog.showOpenDialog(win, { title: title || 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
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

    pendingFile = pdfFromArgv(process.argv);
    buildMenu();
    createWindow();
    if (!process.argv.some((a) => a.startsWith('--smoke'))) startUpdateChecks();

    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}

app.on('before-quit', () => stopEngines());
app.on('window-all-closed', () => app.quit());

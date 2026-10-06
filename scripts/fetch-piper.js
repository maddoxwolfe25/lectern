// Downloads the Piper text-to-speech engine (Windows build) into vendor/piper if it is not there yet.
// Runs automatically before `npm run dist`. The binaries are not kept in git.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const URL = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';
const dir = path.join(__dirname, '..', 'vendor', 'piper');
const exe = path.join(dir, 'piper.exe');

if (fs.existsSync(exe)) { console.log('Piper engine already present in vendor/piper'); process.exit(0); }
if (process.platform !== 'win32') { console.log('Skipping Piper download: Windows build only'); process.exit(0); }

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, 'piper.zip');
  console.log('Downloading Piper engine (about 22 MB)…');
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading Piper`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  // Windows ships bsdtar, which understands zip files (Git Bash's GNU tar does not).
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(fs.existsSync(tar) ? tar : 'tar', ['-xf', zip, '-C', dir], { stdio: 'inherit' });
  // The zip has a top-level piper/ folder. Copy its contents up one level (copying, not renaming:
  // OneDrive and antivirus scanners often hold freshly extracted folders open for a moment).
  const inner = path.join(dir, 'piper');
  if (fs.existsSync(inner)) {
    const retry = (fn, tries = 8) => { for (let i = 0; ; i++) { try { return fn(); } catch (err) { if (i >= tries) throw err; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400 * (i + 1)); } } };
    for (const f of fs.readdirSync(inner)) retry(() => fs.cpSync(path.join(inner, f), path.join(dir, f), { recursive: true, force: true }));
    retry(() => fs.rmSync(inner, { recursive: true, force: true }));
  }
  fs.rmSync(zip, { force: true });
  fs.rmSync(path.join(dir, 'pkgconfig'), { recursive: true, force: true });
  if (!fs.existsSync(exe)) throw new Error('piper.exe missing after extraction');
  console.log('Piper engine ready');
})().catch((err) => { console.error(err.message || err); process.exit(1); });

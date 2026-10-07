// Source for vendor/encrypt-worker.js (bundled by scripts/build-workers.js).
// Runs qpdf (WebAssembly) in a Web Worker to password-protect a finished PDF.
import createModule from '@neslinesli93/qpdf-wasm';

self.onmessage = async (e) => {
  const { bytes, user, owner, permissions = {} } = e.data;
  let log = '';
  try {
    const qpdf = await createModule({
      locateFile: (f) => (f.endsWith('.wasm') ? 'qpdf.wasm' : f),
      noInitialRun: true,
      print: (s) => { log += s + '\n'; },
      printErr: (s) => { log += s + '\n'; },
    });
    qpdf.FS.writeFile('/in.pdf', new Uint8Array(bytes));
    const yn = (v) => (v ? 'y' : 'n');
    const args = [
      '--encrypt', user, owner || user, '256',
      '--print=' + (permissions.printing ? 'full' : 'none'),
      '--extract=' + yn(permissions.copying),
      '--modify=' + (permissions.modifying ? 'all' : 'none'),
      '--annotate=' + yn(permissions.annotating),
      '--form=' + yn(permissions.fillingForms !== false),
      '--accessibility=' + yn(permissions.contentAccessibility !== false),
      '--assemble=' + yn(permissions.documentAssembly),
      '--', '/in.pdf', '/out.pdf',
    ];
    let code = 0;
    try { code = qpdf.callMain(args); }
    catch (err) { if (err && typeof err.status === 'number') code = err.status; else throw err; }
    if (code !== 0) throw new Error(log.trim() || `qpdf exited with code ${code}`);
    const out = qpdf.FS.readFile('/out.pdf');
    self.postMessage({ ok: true, bytes: out.buffer }, [out.buffer]);
  } catch (err) {
    self.postMessage({ ok: false, error: (err && err.message) || String(err) || log });
  }
};

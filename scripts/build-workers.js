// Bundles the password-protection worker (qpdf WebAssembly) into vendor/. Runs before `npm run dist`.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
(async () => {
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'encrypt-worker-src.js')],
    bundle: true, minify: true, format: 'iife', platform: 'browser', target: 'es2020',
    outfile: path.join(root, 'vendor', 'encrypt-worker.js'),
    external: ['fs', 'path', 'crypto', 'module', 'url', 'worker_threads', 'child_process', 'vm'],
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
  fs.copyFileSync(path.join(root, 'node_modules', '@neslinesli93', 'qpdf-wasm', 'dist', 'qpdf.wasm'), path.join(root, 'vendor', 'qpdf.wasm'));
  const size = fs.statSync(path.join(root, 'vendor', 'encrypt-worker.js')).size + fs.statSync(path.join(root, 'vendor', 'qpdf.wasm')).size;
  console.log(`Encryption worker ready (${Math.round(size / 1024)} KB)`);
})().catch((err) => { console.error(err.message || err); process.exit(1); });

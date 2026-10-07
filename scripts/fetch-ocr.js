// Assembles vendor/ocr for offline text recognition (Tesseract.js) and vendor/jszip.min.js.
// Copies the engine from node_modules and downloads the English language data once.
// Runs automatically before `npm run dist`; the result is not kept in git.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nm = path.join(root, 'node_modules');
const out = path.join(root, 'vendor', 'ocr');
const LANG_URL = 'https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz';

(async () => {
  fs.mkdirSync(path.join(out, 'core'), { recursive: true });
  fs.mkdirSync(path.join(out, 'lang'), { recursive: true });
  fs.copyFileSync(path.join(nm, 'jszip', 'dist', 'jszip.min.js'), path.join(root, 'vendor', 'jszip.min.js'));
  fs.copyFileSync(path.join(nm, 'tesseract.js', 'dist', 'tesseract.min.js'), path.join(out, 'tesseract.min.js'));
  fs.copyFileSync(path.join(nm, 'tesseract.js', 'dist', 'worker.min.js'), path.join(out, 'worker.min.js'));
  // Tesseract picks the core build that matches the CPU (SIMD or not); ship the LSTM variants it can choose from.
  for (const f of fs.readdirSync(path.join(nm, 'tesseract.js-core'))) {
    if (/^tesseract-core(-simd)?-lstm\.(js|wasm|wasm\.js)$/.test(f)) fs.copyFileSync(path.join(nm, 'tesseract.js-core', f), path.join(out, 'core', f));
  }
  const lang = path.join(out, 'lang', 'eng.traineddata.gz');
  if (!fs.existsSync(lang) || fs.statSync(lang).size < 1_000_000) {
    console.log('Downloading English OCR data (about 11 MB)…');
    const res = await fetch(LANG_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading OCR language data`);
    fs.writeFileSync(lang, Buffer.from(await res.arrayBuffer()));
  }
  const total = [...fs.readdirSync(path.join(out, 'core')).map((f) => path.join(out, 'core', f)), lang].reduce((a, f) => a + fs.statSync(f).size, 0);
  console.log(`OCR engine ready (${Math.round(total / 1048576)} MB in vendor/ocr)`);
})().catch((err) => { console.error(err.message || err); process.exit(1); });

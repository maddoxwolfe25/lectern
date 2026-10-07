/* Lectern — Tools: organize pages, create PDFs, export, page marks, protect and clean up, OCR, attachments.
   Everything here works on top of the viewer (app.js) and the editor (edit.js) through their public hooks. */
(() => {
  'use strict';
  const app = window.LecternApp;
  if (!app || !window.PDFLib) return;
  const { state, el, store } = app;
  const L = PDFLib;
  const desktop = app.desktop;
  const $ = (id) => document.getElementById(id);

  const freshState = () => ({
    marks: { watermark: { text: '', size: 72, opacity: 0.18, color: '#e9475f', angle: 45 }, header: { left: '', center: '', right: '' }, footer: { left: '', center: '', right: '' }, bates: { prefix: '', start: 1, digits: 6 }, fontSize: 10 },
    attachments: [], sanitize: null, compress: null, ocr: {}, encrypt: null,
  });
  const P = Object.assign({ externalDirty: false, encryptWorkerOk: null }, freshState());

  const fmtMB = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
  const baseName = () => (state.name || 'document').replace(/\.pdf$/i, '');
  const livePages = () => state.pages.filter((p) => !p.deleted);
  const hexToRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
  const marksActive = () => !!(P.marks.watermark.text.trim() || ['left', 'center', 'right'].some((k) => P.marks.header[k].trim() || P.marks.footer[k].trim()));
  const toU8 = (buf) => (buf instanceof Uint8Array ? buf : new Uint8Array(buf));

  /* ======================= dialogs ======================= */

  function dialog({ title, hint, body, actions = [{ label: 'Close', value: null }], width = 560, onOpen }) {
    return new Promise((resolve) => {
      const modal = document.createElement('div'); modal.className = 'modal pro-modal';
      const card = document.createElement('div'); card.className = 'modal-card'; card.style.width = `min(100%, ${width}px)`;
      const h = document.createElement('h3'); h.textContent = title; card.append(h);
      if (hint) { const p = document.createElement('p'); p.className = 'modal-hint'; p.textContent = hint; card.append(p); }
      if (body) card.append(body);
      const row = document.createElement('div'); row.className = 'modal-actions';
      const sp = document.createElement('span'); sp.className = 'spacer'; row.append(sp);
      let closed = false;
      const close = (v) => { if (closed) return; closed = true; modal.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
      for (const a of actions) {
        const b = document.createElement('button'); b.type = 'button';
        b.className = 'btn' + (a.primary ? ' btn-accent' : ''); b.textContent = a.label;
        b.addEventListener('click', async () => {
          if (!a.onClick) { close(a.value); return; }
          b.disabled = true;
          try { const r = await a.onClick({ close, card }); if (r === false) { b.disabled = false; return; } close(r === undefined ? a.value : r); }
          catch (err) { b.disabled = false; app.toast(err?.message || String(err)); }
        });
        row.append(b);
      }
      card.append(row); modal.append(card); document.body.append(modal);
      modal.addEventListener('click', (e) => { if (e.target === modal) close(null); });
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') { const primary = row.querySelector('.btn-accent'); if (primary && !primary.disabled) { e.preventDefault(); primary.click(); } } });
      document.addEventListener('keydown', onKey, true);
      const first = card.querySelector('input:not([type=file]), select, textarea'); if (first) first.focus();
      if (onOpen) onOpen({ modal, card, close });
    });
  }

  function buildForm(fields) {
    const form = document.createElement('div'); form.className = 'pro-form';
    const inputs = {};
    for (const f of fields) {
      if (f.type === 'static') { const p = document.createElement('p'); p.className = 'pro-static'; p.textContent = f.text; form.append(p); continue; }
      const wrap = document.createElement('label'); wrap.className = 'pro-field' + (f.type === 'checkbox' ? ' is-check' : '') + (f.wide ? ' is-wide' : '');
      const lab = document.createElement('span'); lab.className = 'pro-label'; lab.textContent = f.label;
      let input;
      if (f.type === 'select') {
        input = document.createElement('select'); input.className = 'select wide';
        for (const [v, t] of f.options) { const o = document.createElement('option'); o.value = v; o.textContent = t; input.append(o); }
        input.value = f.value ?? f.options[0][0];
      } else if (f.type === 'textarea') { input = document.createElement('textarea'); input.rows = f.rows || 6; input.value = f.value || ''; if (f.placeholder) input.placeholder = f.placeholder; }
      else if (f.type === 'checkbox') { input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!f.value; }
      else if (f.type === 'file') { input = document.createElement('input'); input.type = 'file'; if (f.accept) input.accept = f.accept; if (f.multiple) input.multiple = true; }
      else if (f.type === 'range') { input = document.createElement('input'); input.type = 'range'; input.min = f.min; input.max = f.max; input.step = f.step || 1; input.value = f.value; }
      else { input = document.createElement('input'); input.type = f.type || 'text'; input.value = f.value ?? ''; if (f.placeholder) input.placeholder = f.placeholder; if (f.min != null) input.min = f.min; if (f.max != null) input.max = f.max; if (f.step != null) input.step = f.step; }
      inputs[f.key] = input;
      if (f.type === 'checkbox') wrap.append(input, lab); else wrap.append(lab, input);
      if (f.type === 'range') { const out = document.createElement('output'); out.textContent = f.format ? f.format(input.value) : input.value; input.addEventListener('input', () => { out.textContent = f.format ? f.format(input.value) : input.value; }); lab.append(' ', out); }
      if (f.hint) { const s = document.createElement('span'); s.className = 'pro-hint'; s.textContent = f.hint; wrap.append(s); }
      form.append(wrap);
    }
    const values = () => {
      const out = {};
      for (const f of fields) {
        const i = inputs[f.key]; if (!i) continue;
        out[f.key] = f.type === 'checkbox' ? i.checked : f.type === 'file' ? [...i.files] : f.type === 'number' || f.type === 'range' ? Number(i.value) : i.value;
      }
      return out;
    };
    return { form, inputs, values };
  }

  async function prompt(opts) {
    const { form, values, inputs } = buildForm(opts.fields);
    if (opts.setup) opts.setup(inputs, form);
    return dialog({
      title: opts.title, hint: opts.hint, body: form, width: opts.width,
      actions: [{ label: opts.cancel || 'Cancel', value: null }, { label: opts.ok || 'OK', primary: true, onClick: async () => { const v = values(); if (opts.validate) { const err = await opts.validate(v); if (err) { app.toast(err); return false; } } return v; } }],
    });
  }

  // A modal progress box with a cancel button. Returns { set(frac, text), done() , cancelled }.
  function progressBox(title) {
    const body = document.createElement('div');
    const bar = document.createElement('div'); bar.className = 'voice-progress'; bar.style.height = '20px';
    const fill = document.createElement('div'); fill.className = 'bar'; const txt = document.createElement('span'); bar.append(fill, txt);
    const detail = document.createElement('p'); detail.className = 'pro-hint'; detail.style.marginTop = '8px';
    body.append(bar, detail);
    const box = { cancelled: false, set(frac, text, sub) { fill.style.width = Math.round(frac * 100) + '%'; txt.textContent = text || ''; if (sub != null) detail.textContent = sub; }, done() { box.close?.(true); } };
    dialog({ title, body, width: 460, actions: [{ label: 'Cancel', onClick: () => { box.cancelled = true; return null; } }], onOpen: ({ close }) => { box.close = close; } });
    return box;
  }

  /* ======================= shared helpers ======================= */

  async function currentDoc() {
    const bytes = await app.currentBytes();
    if (!bytes) throw new Error('Open a PDF first.');
    return L.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  }
  function parseRanges(str, max) {
    const out = new Set();
    for (const part of String(str || '').split(/[,\s]+/).filter(Boolean)) {
      const m = /^(\d+)?\s*-\s*(\d+)?$/.exec(part);
      if (m) { const a = Math.max(1, Number(m[1] || 1)), b = Math.min(max, Number(m[2] || max)); for (let i = a; i <= b; i++) out.add(i); }
      else if (/^\d+$/.test(part)) { const n = Number(part); if (n >= 1 && n <= max) out.add(n); }
    }
    return [...out].sort((a, b) => a - b);
  }
  async function reopen(bytes, name) {
    await app.openData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), name || state.name, state.path);
    P.externalDirty = true;
    app.refreshDirty?.();
  }
  async function deliverFiles(files, title) {
    if (!files.length) return;
    if (desktop?.saveMany) { const r = await desktop.saveMany(files, title); if (r?.ok) app.toast(`Saved ${r.count} file${r.count === 1 ? '' : 's'} to ${r.dir}`); return; }
    if (files.length === 1) { await app.saveBytesAs(files[0].data, files[0].name, files[0].kind || 'pdf'); return; }
    const zip = new JSZip();
    for (const f of files) zip.file(f.name, f.data);
    const blob = await zip.generateAsync({ type: 'uint8array' });
    await app.saveBytesAs(blob, `${baseName()}.zip`, 'zip');
  }
  const fileBytes = async (file) => new Uint8Array(await file.arrayBuffer());
  const need = () => { if (!state.pdf) { app.toast('Open a PDF first.'); return false; } return true; };

  /* ======================= Tools menu ======================= */

  const sections = () => [
    { title: 'Organize pages', items: [
      ['Reorder pages', 'Drag thumbnails up or down in the Pages panel', reorderHint, true],
      ['Insert pages from a PDF…', 'Add another document\'s pages at a chosen position', insertFromPdf, true],
      ['Insert a blank page', 'After the current page', insertBlank, true],
      ['Extract pages…', 'Save chosen pages as a new PDF', extractPages, true],
      ['Split into several files…', 'Every N pages, or at pages you choose', splitDocument, true],
    ] },
    { title: 'Create a PDF', items: [
      ['From images…', 'JPEG, PNG, WebP, one page per image', createFromImages, false],
      ['From text or Markdown…', 'Paste text or pick a .txt or .md file', createFromText, false],
      desktop ? ['From a web page…', 'Enter a web address', createFromWeb, false] : null,
    ].filter(Boolean) },
    { title: 'Export', items: [
      ['Pages as images…', 'PNG or JPEG at the resolution you choose', exportImages, true],
      ['Text (.txt)', 'Plain text of the whole document', exportTxt, true],
      ['Web page (.html)', 'Headings, paragraphs and lists', exportHtml, true],
      ['Word document (.docx)', 'Opens in Word, Google Docs, LibreOffice', exportDocx, true],
      ['Markdown (.md)', 'Same as the toolbar button', () => $('btnMarkdown').click(), true],
    ] },
    { title: 'Page marks', items: [
      ['Watermark, header, footer, page numbers…', 'Applied to every page when you save', marksDialog, true],
    ] },
    { title: 'Protect and clean up', items: [
      ['Password protect…', 'Require a password to open; limit printing or copying', passwordDialog, true],
      ['Remove hidden information…', 'Metadata, comments, attachments, scripts', sanitizeDialog, true],
      ['Reduce file size…', 'Recompress photos and compact the file', compressDialog, true],
    ] },
    { title: 'Scanned documents', items: [
      ['Recognize text (OCR)…', 'Make scans searchable and readable aloud', ocrDialog, true],
    ] },
    { title: 'Attachments', items: [
      ['Attached files…', 'See, save or add files embedded in the PDF', attachmentsDialog, true],
    ] },
  ];

  const menu = document.createElement('div');
  menu.className = 'tools-menu'; menu.hidden = true; menu.setAttribute('role', 'menu');
  document.body.append(menu);
  function renderMenu() {
    menu.textContent = '';
    for (const sec of sections()) {
      const h = document.createElement('div'); h.className = 'tm-title'; h.textContent = sec.title; menu.append(h);
      for (const [label, hint, fn, needsDoc] of sec.items) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'tm-item'; b.setAttribute('role', 'menuitem');
        b.disabled = needsDoc && !state.pdf;
        const l = document.createElement('span'); l.className = 'tm-label'; l.textContent = label;
        const s = document.createElement('span'); s.className = 'tm-hint'; s.textContent = hint;
        b.append(l, s);
        b.addEventListener('click', () => { closeMenu(); fn(); });
        menu.append(b);
      }
    }
  }
  function openMenu() {
    renderMenu();
    const r = $('btnTools').getBoundingClientRect();
    menu.style.left = Math.min(r.left, window.innerWidth - 380) + 'px';
    menu.style.top = r.bottom + 6 + 'px';
    menu.hidden = false;
    $('btnTools').setAttribute('aria-expanded', 'true');
    setTimeout(() => document.addEventListener('pointerdown', outside, { once: true }), 0);
  }
  function closeMenu() { menu.hidden = true; $('btnTools').setAttribute('aria-expanded', 'false'); }
  function outside(e) { if (!menu.contains(e.target) && e.target !== $('btnTools')) closeMenu(); else if (!menu.hidden) setTimeout(() => document.addEventListener('pointerdown', outside, { once: true }), 0); }
  $('btnTools').addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) closeMenu(); });

  /* ======================= Organize pages ======================= */

  function reorderHint() {
    if (!need()) return;
    if (el.app.classList.contains('hide-sidebar')) $('btnSidebar').click();
    app.selectSideTab('thumbs');
    app.toast('Drag a page thumbnail up or down to move it. Changes apply when you save.');
  }

  // Drag to reorder thumbnails
  let dragFrom = null;
  function decorateThumbsForDrag() {
    for (const p of state.pages) {
      const t = p.thumb; if (!t || t.dataset.dnd) continue;
      t.dataset.dnd = '1'; t.draggable = true;
      t.addEventListener('dragstart', (e) => { dragFrom = p.num; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(p.num)); t.classList.add('is-dragging'); });
      t.addEventListener('dragend', () => { t.classList.remove('is-dragging'); el.thumbs.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after')); dragFrom = null; });
      t.addEventListener('dragover', (e) => { if (dragFrom == null) return; e.preventDefault(); const r = t.getBoundingClientRect(); const after = e.clientY > r.top + r.height / 2; t.classList.toggle('drop-after', after); t.classList.toggle('drop-before', !after); });
      t.addEventListener('dragleave', () => t.classList.remove('drop-before', 'drop-after'));
      t.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = dragFrom; const after = t.classList.contains('drop-after');
        t.classList.remove('drop-before', 'drop-after');
        if (from == null || from === p.num) return;
        const order = state.pages.map((x) => x.num).filter((n) => n !== from);
        const at = order.indexOf(p.num) + (after ? 1 : 0);
        order.splice(at, 0, from);
        app.reorderPages(order);
        app.toast(`Moved page ${from}. Save PDF to keep the new order.`);
      });
    }
  }
  app.on('thumbs-built', decorateThumbsForDrag);

  async function insertFromPdf() {
    if (!need()) return;
    const res = await prompt({
      title: 'Insert pages from a PDF', hint: 'Your pending edits are applied first, then the pages are added.',
      fields: [
        { key: 'files', label: 'PDF files', type: 'file', accept: 'application/pdf,.pdf', multiple: true },
        { key: 'where', label: 'Position', type: 'select', value: 'after', options: [['after', `After page ${state.current}`], ['start', 'At the beginning'], ['end', 'At the end']] },
      ], ok: 'Insert',
      validate: (v) => (v.files.length ? null : 'Choose at least one PDF.'),
    });
    if (!res) return;
    try {
      const doc = await currentDoc();
      let idx = res.where === 'start' ? 0 : res.where === 'end' ? doc.getPageCount() : livePages().findIndex((p) => p.num === state.current) + 1;
      let added = 0;
      for (const f of res.files) {
        const src = await L.PDFDocument.load(await fileBytes(f), { ignoreEncryption: true });
        const copied = await doc.copyPages(src, src.getPageIndices());
        for (const pg of copied) { doc.insertPage(idx++, pg); added++; }
      }
      await reopen(await doc.save());
      app.toast(`Inserted ${added} page${added === 1 ? '' : 's'}. Save PDF to keep them.`);
    } catch (err) { app.toast('Could not insert: ' + (err.message || err)); }
  }

  async function insertBlank() {
    if (!need()) return;
    try {
      const doc = await currentDoc();
      const idx = livePages().findIndex((p) => p.num === state.current) + 1;
      const ref = doc.getPage(Math.max(0, idx - 1));
      const { width, height } = ref.getSize();
      const pg = doc.insertPage(idx, [width, height]);
      pg.setRotation(ref.getRotation());
      await reopen(await doc.save());
      app.toast(`Blank page added after page ${idx}.`);
    } catch (err) { app.toast('Could not insert: ' + (err.message || err)); }
  }

  async function extractPages() {
    if (!need()) return;
    const n = livePages().length;
    const res = await prompt({
      title: 'Extract pages', hint: `Pages are numbered as shown now (1 to ${n}). Example: 1-3, 7, 10-`,
      fields: [
        { key: 'range', label: 'Pages', type: 'text', value: String(state.current), placeholder: '1-3, 7' },
        { key: 'open', label: 'Open the result instead of saving it', type: 'checkbox', value: false },
      ], ok: 'Extract',
      validate: (v) => (parseRanges(v.range, n).length ? null : 'Enter at least one valid page number.'),
    });
    if (!res) return;
    try {
      const doc = await currentDoc();
      const idxs = parseRanges(res.range, n).map((x) => x - 1);
      const out = await L.PDFDocument.create();
      (await out.copyPages(doc, idxs)).forEach((pg) => out.addPage(pg));
      const bytes = await out.save();
      const name = `${baseName()} pages ${res.range.replace(/[^\d,\-]/g, '')}.pdf`;
      if (res.open) await app.openData(bytes.buffer, name); else await app.saveBytesAs(bytes, name, 'pdf');
    } catch (err) { app.toast('Could not extract: ' + (err.message || err)); }
  }

  async function splitDocument() {
    if (!need()) return;
    const n = livePages().length;
    const res = await prompt({
      title: 'Split into several files',
      fields: [
        { key: 'mode', label: 'Split', type: 'select', value: 'every', options: [['every', 'Every N pages'], ['at', 'Before the pages listed']] },
        { key: 'every', label: 'N pages per file', type: 'number', value: 1, min: 1, max: n },
        { key: 'at', label: 'Start new files before pages', type: 'text', value: '', placeholder: 'for example 4, 9' },
      ], ok: 'Split',
    });
    if (!res) return;
    try {
      const doc = await currentDoc();
      let starts;
      if (res.mode === 'every') { const k = Math.max(1, Math.min(n, res.every || 1)); starts = []; for (let i = 0; i < n; i += k) starts.push(i); }
      else { starts = [0, ...parseRanges(res.at, n).map((x) => x - 1).filter((x) => x > 0)]; starts = [...new Set(starts)].sort((a, b) => a - b); }
      const files = [];
      for (let i = 0; i < starts.length; i++) {
        const from = starts[i], to = i + 1 < starts.length ? starts[i + 1] : n;
        const out = await L.PDFDocument.create();
        (await out.copyPages(doc, Array.from({ length: to - from }, (_, k) => from + k))).forEach((pg) => out.addPage(pg));
        files.push({ name: `${baseName()} part ${String(i + 1).padStart(2, '0')}.pdf`, data: await out.save(), kind: 'pdf' });
      }
      await deliverFiles(files, 'Choose a folder for the parts');
    } catch (err) { app.toast('Could not split: ' + (err.message || err)); }
  }

  /* ======================= Create a PDF ======================= */

  async function createFromImages() {
    const res = await prompt({
      title: 'Create a PDF from images',
      fields: [
        { key: 'files', label: 'Images', type: 'file', accept: 'image/*', multiple: true },
        { key: 'size', label: 'Page size', type: 'select', value: 'image', options: [['image', 'Match each image'], ['a4', 'A4'], ['letter', 'Letter']] },
      ], ok: 'Create',
      validate: (v) => (v.files.length ? null : 'Choose at least one image.'),
    });
    if (!res) return;
    try {
      const doc = await L.PDFDocument.create();
      for (const f of res.files) {
        let img;
        if (/jpe?g$/i.test(f.type) || /\.jpe?g$/i.test(f.name)) img = await doc.embedJpg(await fileBytes(f));
        else if (/png$/i.test(f.type) || /\.png$/i.test(f.name)) img = await doc.embedPng(await fileBytes(f));
        else {
          const bmp = await createImageBitmap(f);
          const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
          c.getContext('2d').drawImage(bmp, 0, 0);
          const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
          img = await doc.embedPng(await blob.arrayBuffer());
        }
        const iw = img.width * 72 / 96, ih = img.height * 72 / 96;
        if (res.size === 'image') { doc.addPage([iw, ih]).drawImage(img, { x: 0, y: 0, width: iw, height: ih }); continue; }
        let [pw, ph] = res.size === 'a4' ? [595.28, 841.89] : [612, 792];
        if (iw > ih) [pw, ph] = [ph, pw];
        const m = 36, s = Math.min((pw - 2 * m) / iw, (ph - 2 * m) / ih);
        const w = iw * s, h = ih * s;
        doc.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
      }
      doc.setTitle(res.files.length === 1 ? res.files[0].name.replace(/\.[^.]+$/, '') : 'Images');
      const bytes = await doc.save();
      await app.openData(bytes.buffer, (res.files.length === 1 ? res.files[0].name.replace(/\.[^.]+$/, '') : 'images') + '.pdf');
      app.toast(`Created a ${doc.getPageCount()}-page PDF. Save PDF to keep it.`);
    } catch (err) { app.toast('Could not create the PDF: ' + (err.message || err)); }
  }

  async function createFromText() {
    const res = await prompt({
      title: 'Create a PDF from text or Markdown', hint: 'Headings (#), lists (- or 1.) and paragraphs are laid out on A4 pages.',
      fields: [
        { key: 'title', label: 'Title', type: 'text', value: '' },
        { key: 'text', label: 'Text', type: 'textarea', rows: 10, placeholder: '# Heading\n\nParagraph text…' },
        { key: 'file', label: 'Or pick a file', type: 'file', accept: '.txt,.md,text/plain,text/markdown' },
      ], ok: 'Create', width: 640,
      validate: (v) => (v.text.trim() || v.file.length ? null : 'Type some text or choose a file.'),
    });
    if (!res) return;
    try {
      let text = res.text;
      if (res.file.length) text = await res.file[0].text();
      const bytes = await textToPdf(text, res.title || (res.file[0]?.name.replace(/\.[^.]+$/, '') || 'Document'));
      await app.openData(bytes.buffer, (res.title || res.file[0]?.name.replace(/\.[^.]+$/, '') || 'document') + '.pdf');
      app.toast('Created the PDF. Save PDF to keep it.');
    } catch (err) { app.toast('Could not create the PDF: ' + (err.message || err)); }
  }

  function parseMarkdownLite(text) {
    const blocks = [];
    let para = [];
    const flush = () => { if (para.length) { blocks.push({ type: 'p', text: para.join(' ') }); para = []; } };
    for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.trimEnd();
      let m;
      if (!line.trim()) { flush(); continue; }
      if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) { flush(); blocks.push({ type: 'h', level: m[1].length, text: m[2].trim() }); }
      else if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) { flush(); blocks.push({ type: 'ul', text: m[1].trim() }); }
      else if ((m = /^\s*(\d+)[.)]\s+(.*)$/.exec(line))) { flush(); blocks.push({ type: 'ol', n: Number(m[1]), text: m[2].trim() }); }
      else para.push(line.trim());
    }
    flush();
    return blocks;
  }

  async function textToPdf(text, title) {
    const doc = await L.PDFDocument.create();
    const R = await doc.embedFont(L.StandardFonts.Helvetica), B = await doc.embedFont(L.StandardFonts.HelveticaBold);
    const W = 595.28, H = 841.89, M = 56;
    let page = doc.addPage([W, H]); let y = H - M;
    const clean = (s) => s.replace(/[^\x20-\x7E -ÿ]/g, '?').replace(/\*\*|__|`/g, '');
    const newPage = () => { page = doc.addPage([W, H]); y = H - M; };
    const write = (str, { font, size, indent = 0, bullet = '' }) => {
      const maxW = W - 2 * M - indent;
      const words = clean(str).split(/\s+/);
      let line = '';
      const lines = [];
      for (const w of words) { const t = line ? line + ' ' + w : w; if (font.widthOfTextAtSize(t, size) <= maxW || !line) line = t; else { lines.push(line); line = w; } }
      lines.push(line);
      lines.forEach((ln, i) => {
        if (y - size < M) newPage();
        if (i === 0 && bullet) page.drawText(bullet, { x: M + indent - font.widthOfTextAtSize(bullet, size) - 4, y: y - size, size, font });
        page.drawText(ln, { x: M + indent, y: y - size, size, font });
        y -= size * 1.45;
      });
    };
    if (title) { write(title, { font: B, size: 22 }); y -= 10; }
    for (const b of parseMarkdownLite(text)) {
      if (b.type === 'h') { y -= 6; write(b.text, { font: B, size: [20, 16, 13][b.level - 1] }); y -= 4; }
      else if (b.type === 'ul') write(b.text, { font: R, size: 11, indent: 18, bullet: '•' });
      else if (b.type === 'ol') write(b.text, { font: R, size: 11, indent: 22, bullet: b.n + '.' });
      else { write(b.text, { font: R, size: 11 }); y -= 6; }
    }
    if (title) doc.setTitle(title);
    return doc.save();
  }

  async function createFromWeb() {
    const res = await prompt({ title: 'Create a PDF from a web page', fields: [{ key: 'url', label: 'Web address', type: 'url', value: 'https://', placeholder: 'https://example.com/article' }], ok: 'Create' });
    if (!res || !res.url.trim()) return;
    const url = /^[a-z]+:/i.test(res.url) ? res.url.trim() : 'https://' + res.url.trim();
    app.toast('Loading the page…');
    try {
      const r = await desktop.printUrl(url);
      await app.openData(r.data.buffer.slice(r.data.byteOffset, r.data.byteOffset + r.data.byteLength), r.name);
      app.toast('Created the PDF. Save PDF to keep it.');
    } catch (err) { app.toast('Could not create the PDF: ' + (err.message || err)); }
  }

  /* ======================= Export ======================= */

  async function exportImages() {
    if (!need()) return;
    const n = livePages().length;
    const res = await prompt({
      title: 'Export pages as images',
      fields: [
        { key: 'format', label: 'Format', type: 'select', value: 'png', options: [['png', 'PNG'], ['jpg', 'JPEG']] },
        { key: 'dpi', label: 'Resolution', type: 'select', value: '150', options: [['72', '72 dpi (screen)'], ['150', '150 dpi'], ['300', '300 dpi (print)']] },
        { key: 'range', label: 'Pages', type: 'text', value: `1-${n}` },
      ], ok: 'Export',
    });
    if (!res) return;
    const nums = parseRanges(res.range, n);
    if (!nums.length) { app.toast('No valid pages.'); return; }
    const live = livePages();
    const box = progressBox('Rendering pages');
    const files = [];
    try {
      for (let i = 0; i < nums.length; i++) {
        if (box.cancelled) return;
        const p = live[nums[i] - 1];
        box.set(i / nums.length, `Page ${nums[i]}`, `${i} of ${nums.length} done`);
        const vp = p.pdfPage.getViewport({ scale: Number(res.dpi) / 72, rotation: (p.pdfPage.rotate + p.rot) % 360 });
        const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const ctx = c.getContext('2d', { alpha: false }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await p.pdfPage.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
        const blob = await new Promise((r) => c.toBlob(r, res.format === 'jpg' ? 'image/jpeg' : 'image/png', 0.9));
        files.push({ name: `${baseName()} page ${String(nums[i]).padStart(String(n).length, '0')}.${res.format}`, data: new Uint8Array(await blob.arrayBuffer()), kind: res.format });
        c.width = 0; c.height = 0;
      }
      box.done();
      await deliverFiles(files, 'Choose a folder for the images');
    } catch (err) { box.done(); app.toast('Could not export: ' + (err.message || err)); }
  }

  async function docBlocks() {
    const md = await app.exportMarkdown();
    if (md == null) return null;
    return md.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean).map((b) => {
      let m;
      if ((m = /^(#{1,3})\s+(.*)$/s.exec(b))) return { type: 'h', level: m[1].length, text: m[2] };
      if ((m = /^(\d+)\.\s+(.*)$/s.exec(b))) return { type: 'ol', n: Number(m[1]), text: m[2] };
      if ((m = /^-\s+(.*)$/s.exec(b))) return { type: 'ul', text: m[1] };
      return { type: 'p', text: b };
    });
  }
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  async function exportTxt() {
    if (!need()) return;
    const blocks = await docBlocks(); if (!blocks) return;
    const txt = blocks.map((b) => (b.type === 'h' ? b.text.toUpperCase() : b.type === 'ul' ? '- ' + b.text : b.type === 'ol' ? `${b.n}. ${b.text}` : b.text)).join('\n\n') + '\n';
    await app.saveBytesAs(new TextEncoder().encode(txt), baseName() + '.txt', 'txt');
  }
  async function exportHtml() {
    if (!need()) return;
    const blocks = await docBlocks(); if (!blocks) return;
    const body = blocks.map((b) => (b.type === 'h' ? `<h${b.level}>${esc(b.text)}</h${b.level}>` : b.type === 'ul' ? `<ul><li>${esc(b.text)}</li></ul>` : b.type === 'ol' ? `<ol start="${b.n}"><li>${esc(b.text)}</li></ol>` : `<p>${esc(b.text)}</p>`)).join('\n').replace(/<\/ul>\n<ul>/g, '\n').replace(/<\/ol>\n<ol start="\d+">/g, '\n');
    const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${esc(baseName())}</title>\n<style>body{max-width:72ch;margin:3rem auto;padding:0 1.25rem;font:17px/1.6 Georgia,serif;color:#222}h1,h2,h3{font-family:system-ui,sans-serif;line-height:1.2}li{margin:.25em 0}</style></head>\n<body>\n${body}\n</body></html>\n`;
    await app.saveBytesAs(new TextEncoder().encode(html), baseName() + '.html', 'html');
  }
  async function exportDocx() {
    if (!need()) return;
    const bytes = await docxBytes(); if (!bytes) return;
    await app.saveBytesAs(bytes, baseName() + '.docx', 'docx');
  }
  async function docxBytes() {
    const blocks = await docBlocks(); if (!blocks) return null;
    const para = (text, style, extra = '') => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
    const body = blocks.map((b) => (b.type === 'h' ? para(b.text, `Heading${b.level}`) : b.type === 'ul' ? para('• ' + b.text, 'ListParagraph') : b.type === 'ol' ? para(`${b.n}. ${b.text}`, 'ListParagraph') : para(b.text))).join('');
    const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${[['Heading1', 32], ['Heading2', 26], ['Heading3', 24]].map(([id, sz], i) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="heading ${i + 1}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="${360 - i * 80}" w:after="120"/><w:outlineLvl w:val="${i}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${sz}"/></w:rPr></w:style>`).join('')}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720"/><w:spacing w:after="60"/></w:pPr></w:style></w:styles>`;
    const zip = new JSZip();
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
    zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    zip.file('word/document.xml', document);
    zip.file('word/styles.xml', styles);
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  }

  /* ======================= Page marks: watermark, header, footer, numbers ======================= */

  async function marksDialog() {
    if (!need()) return;
    const m = P.marks;
    const res = await prompt({
      title: 'Watermark, header, footer and page numbers',
      hint: 'Tokens: {page} {pages} {date} {title} {bates}. Leave a field empty to skip it. Marks are drawn on every page when you save.',
      width: 640,
      fields: [
        { key: 'wm', label: 'Watermark text', type: 'text', value: m.watermark.text, placeholder: 'DRAFT' },
        { key: 'wmSize', label: 'Watermark size', type: 'range', min: 24, max: 200, value: m.watermark.size, format: (v) => v + ' pt' },
        { key: 'wmOpacity', label: 'Watermark opacity', type: 'range', min: 0.05, max: 0.6, step: 0.05, value: m.watermark.opacity, format: (v) => Math.round(v * 100) + '%' },
        { key: 'wmAngle', label: 'Watermark angle', type: 'select', value: String(m.watermark.angle), options: [['45', 'Diagonal'], ['0', 'Horizontal'], ['-45', 'Diagonal, other way']] },
        { key: 'wmColor', label: 'Watermark colour', type: 'select', value: m.watermark.color, options: [['#e9475f', 'Red'], ['#8a94a6', 'Grey'], ['#3f8cff', 'Blue'], ['#1c1300', 'Black']] },
        { key: 'hl', label: 'Header left', type: 'text', value: m.header.left }, { key: 'hc', label: 'Header centre', type: 'text', value: m.header.center }, { key: 'hr', label: 'Header right', type: 'text', value: m.header.right },
        { key: 'fl', label: 'Footer left', type: 'text', value: m.footer.left }, { key: 'fc', label: 'Footer centre', type: 'text', value: m.footer.center, placeholder: 'Page {page} of {pages}' }, { key: 'fr', label: 'Footer right', type: 'text', value: m.footer.right },
        { key: 'bp', label: 'Bates prefix', type: 'text', value: m.bates.prefix, placeholder: 'ABC-' }, { key: 'bs', label: 'Bates start', type: 'number', value: m.bates.start, min: 0 }, { key: 'bd', label: 'Bates digits', type: 'number', value: m.bates.digits, min: 1, max: 12 },
        { key: 'fs', label: 'Header and footer text size', type: 'number', value: m.fontSize, min: 6, max: 18 },
      ], ok: 'Apply',
    });
    if (!res) return;
    P.marks = {
      watermark: { text: res.wm.trim(), size: res.wmSize, opacity: res.wmOpacity, color: res.wmColor, angle: Number(res.wmAngle) },
      header: { left: res.hl, center: res.hc, right: res.hr }, footer: { left: res.fl, center: res.fc, right: res.fr },
      bates: { prefix: res.bp, start: res.bs || 0, digits: res.bd || 6 }, fontSize: res.fs || 10,
    };
    app.refreshDirty?.();
    for (const p of state.pages) if (p.rendered) renderMarks(p);
    app.toast(marksActive() ? 'Page marks set. They are drawn when you save.' : 'Page marks cleared.');
  }

  function markText(tpl, i, total) {
    if (!tpl) return '';
    const b = P.marks.bates;
    return tpl.replace(/\{page\}/gi, i + 1).replace(/\{pages\}/gi, total).replace(/\{date\}/gi, new Date().toLocaleDateString()).replace(/\{title\}/gi, baseName()).replace(/\{bates\}/gi, b.prefix + String((b.start || 0) + i).padStart(b.digits || 6, '0'));
  }

  function renderMarks(p) {
    let layer = p.el.querySelector('.marks-layer');
    if (!marksActive()) { if (layer) layer.remove(); return; }
    if (!layer) { layer = document.createElement('div'); layer.className = 'marks-layer'; p.el.append(layer); }
    layer.textContent = '';
    if (!p.vp) return;
    const s = p.vp.scale, W = p.vp.width, H = p.vp.height;
    const live = livePages(); const i = live.indexOf(p); if (i < 0) return;
    const m = P.marks;
    const put = (text, x, y, align) => { if (!text) return; const d = document.createElement('div'); d.className = 'mark-text'; d.style.cssText = `left:${x}px;top:${y}px;font-size:${m.fontSize * s}px;transform:translate(${align === 'center' ? '-50%' : align === 'right' ? '-100%' : '0'},0)`; d.textContent = text; layer.append(d); };
    put(markText(m.header.left, i, live.length), 36 * s, 20 * s, 'left'); put(markText(m.header.center, i, live.length), W / 2, 20 * s, 'center'); put(markText(m.header.right, i, live.length), W - 36 * s, 20 * s, 'right');
    put(markText(m.footer.left, i, live.length), 36 * s, H - 32 * s, 'left'); put(markText(m.footer.center, i, live.length), W / 2, H - 32 * s, 'center'); put(markText(m.footer.right, i, live.length), W - 36 * s, H - 32 * s, 'right');
    if (m.watermark.text) {
      const d = document.createElement('div'); d.className = 'mark-wm';
      d.style.cssText = `left:${W / 2}px;top:${H / 2}px;font-size:${m.watermark.size * s}px;color:${m.watermark.color};opacity:${m.watermark.opacity};transform:translate(-50%,-50%) rotate(${-m.watermark.angle}deg)`;
      d.textContent = m.watermark.text; layer.append(d);
    }
  }
  app.on('page-rendered', (p) => renderMarks(p));
  app.on('layout', () => { for (const p of state.pages) if (p.rendered) renderMarks(p); });

  const visualToUser = (rot, pw, ph, vx, vy) => (rot === 90 ? [vy, vx] : rot === 180 ? [pw - vx, vy] : rot === 270 ? [pw - vy, ph - vx] : [vx, ph - vy]);

  // Draws marks and OCR text into the export document (pages indexed by original position).
  async function applyPageMarks(doc, pages, Lb) {
    const live = livePages();
    const fontR = (marksActive() || Object.keys(P.ocr).length) ? await doc.embedFont(Lb.StandardFonts.Helvetica) : null;
    if (marksActive()) {
      const fontB = await doc.embedFont(Lb.StandardFonts.HelveticaBold);
      const m = P.marks;
      const clean = (t) => t.replace(/[^\x20-\x7E -ÿ]/g, '?');
      live.forEach((p, i) => {
        const page = pages[p.src]; if (!page) return;
        const { width: pw, height: ph } = page.getSize();
        const rot = ((page.getRotation().angle || 0) + p.rot) % 360;
        const vw = rot % 180 ? ph : pw, vh = rot % 180 ? pw : ph;
        const v2u = (vx, vy) => visualToUser(rot, pw, ph, vx, vy);
        const drawAt = (text, vx, vy, align, font, size, color, opacity, angleDeg = 0) => {
          if (!text) return;
          text = clean(text);
          const tw = font.widthOfTextAtSize(text, size);
          const a = (angleDeg * Math.PI) / 180;
          const dir = [Math.cos(a), -Math.sin(a)], up = [-Math.sin(a), -Math.cos(a)];
          let sx = vx, sy = vy;
          if (align === 'center') { sx -= (tw / 2) * dir[0] + (size * 0.35) * up[0]; sy -= (tw / 2) * dir[1] + (size * 0.35) * up[1]; }
          else if (align === 'right') { sx -= tw; }
          const [ux, uy] = v2u(sx, sy);
          page.drawText(text, { x: ux, y: uy, size, font, color: Lb.rgb(...hexToRgb(color)), opacity, rotate: Lb.degrees(rot + angleDeg) });
        };
        const grey = '#444444';
        drawAt(markText(m.header.left, i, live.length), 36, 20 + m.fontSize, 'left', fontR, m.fontSize, grey, 1);
        drawAt(markText(m.header.center, i, live.length), vw / 2, 20 + m.fontSize, 'center-baseline', fontR, m.fontSize, grey, 1);
        drawAt(markText(m.header.right, i, live.length), vw - 36, 20 + m.fontSize, 'right', fontR, m.fontSize, grey, 1);
        drawAt(markText(m.footer.left, i, live.length), 36, vh - 24, 'left', fontR, m.fontSize, grey, 1);
        drawAt(markText(m.footer.center, i, live.length), vw / 2, vh - 24, 'center-baseline', fontR, m.fontSize, grey, 1);
        drawAt(markText(m.footer.right, i, live.length), vw - 36, vh - 24, 'right', fontR, m.fontSize, grey, 1);
        if (m.watermark.text) drawAt(m.watermark.text, vw / 2, vh / 2, 'center', fontB, m.watermark.size, m.watermark.color, m.watermark.opacity, m.watermark.angle);
      });
    }
    // OCR results become an invisible, searchable text layer
    for (const [src, items] of Object.entries(P.ocr)) {
      const page = pages[Number(src)]; if (!page || !items?.length) continue;
      const key = page.node.newFontDictionary('LecternOCR', fontR.ref);
      const ops = [Lb.pushGraphicsState(), Lb.beginText(), Lb.setTextRenderingMode(Lb.TextRenderingMode.Invisible), Lb.setFontAndSize(key, 1)];
      let kept = 0;
      for (const it of items) {
        if (!it.str || !it.str.trim()) continue;
        let enc; try { enc = fontR.encodeText(it.str); } catch { try { enc = fontR.encodeText(it.str.replace(/[^\x20-\x7E -ÿ]/g, ' ')); } catch { continue; } }
        const [a, b, c, d, e, f] = it.transform;
        ops.push(Lb.setTextMatrix(a, b, c, d, e, f), Lb.showText(enc)); kept++;
      }
      ops.push(Lb.endText(), Lb.popGraphicsState());
      if (kept) page.pushOperators(...ops);
    }
  }

  /* ======================= Protect and clean up ======================= */

  async function passwordDialog() {
    if (!need()) return;
    if (P.encryptWorkerOk === null) { try { P.encryptWorkerOk = (await fetch('vendor/encrypt-worker.js', { method: 'HEAD' })).ok; } catch { P.encryptWorkerOk = false; } }
    if (!P.encryptWorkerOk) { app.toast('Password protection is not available in this build.'); return; }
    const res = await prompt({
      title: 'Password protect', hint: 'Applied when you save. Anyone opening the saved file will need the password. Keep a copy: there is no way to recover it.',
      fields: [
        { key: 'user', label: 'Password to open', type: 'password', value: P.encrypt?.user || '' },
        { key: 'confirm', label: 'Confirm password', type: 'password', value: P.encrypt?.user || '' },
        { key: 'owner', label: 'Permissions password (optional)', type: 'password', value: P.encrypt?.owner || '', hint: 'Lets someone change the restrictions below. Defaults to the open password.' },
        { key: 'print', label: 'Allow printing', type: 'checkbox', value: P.encrypt ? !!P.encrypt.print : true },
        { key: 'copy', label: 'Allow copying text', type: 'checkbox', value: P.encrypt ? !!P.encrypt.copy : true },
        { key: 'modify', label: 'Allow editing and commenting', type: 'checkbox', value: P.encrypt ? !!P.encrypt.modify : false },
      ], ok: P.encrypt ? 'Update' : 'Protect on save',
      validate: (v) => (!v.user ? 'Enter a password.' : v.user !== v.confirm ? 'The passwords do not match.' : null),
    });
    if (!res) return;
    P.encrypt = { user: res.user, owner: res.owner || res.user, print: res.print, copy: res.copy, modify: res.modify };
    app.refreshDirty?.();
    app.toast('The file will be password protected when you save.');
  }
  function encryptBytes(bytes) {
    return new Promise((resolve, reject) => {
      const w = new Worker('vendor/encrypt-worker.js');
      const t = setTimeout(() => { w.terminate(); reject(new Error('Encryption timed out')); }, 120000);
      w.onmessage = (e) => { clearTimeout(t); w.terminate(); if (e.data.ok) resolve(new Uint8Array(e.data.bytes)); else reject(new Error(e.data.error || 'Encryption failed')); };
      w.onerror = (e) => { clearTimeout(t); w.terminate(); reject(new Error(e.message || 'Encryption failed')); };
      const copy = bytes.slice();
      w.postMessage({ bytes: copy, user: P.encrypt.user, owner: P.encrypt.owner, permissions: { printing: P.encrypt.print ? 'highResolution' : false, copying: P.encrypt.copy, modifying: P.encrypt.modify, annotating: P.encrypt.modify, fillingForms: true, contentAccessibility: true, documentAssembly: P.encrypt.modify } }, [copy.buffer]);
    });
  }

  async function sanitizeDialog() {
    if (!need()) return;
    const s = P.sanitize || {};
    const res = await prompt({
      title: 'Remove hidden information', hint: 'Removed from the saved file. Your own marks from this session are kept.',
      fields: [
        { key: 'metadata', label: 'Document properties (author, title, creation software, keywords)', type: 'checkbox', value: s.metadata ?? true },
        { key: 'comments', label: 'Existing comments and markup from other people', type: 'checkbox', value: s.comments ?? true },
        { key: 'attachments', label: 'Embedded file attachments', type: 'checkbox', value: s.attachments ?? true },
        { key: 'scripts', label: 'Scripts and automatic actions', type: 'checkbox', value: s.scripts ?? true },
        { key: 'links', label: 'Web links', type: 'checkbox', value: s.links ?? false },
      ], ok: 'Remove on save',
    });
    if (!res) return;
    P.sanitize = Object.values(res).some(Boolean) ? res : null;
    app.refreshDirty?.();
    app.toast(P.sanitize ? 'Hidden information will be removed when you save.' : 'Nothing selected.');
  }

  // Runs on the export document before Lectern adds its own marks.
  async function prepareExport(doc, pages, Lb) {
    const s = P.sanitize; if (!s) return;
    const N = (k) => Lb.PDFName.of(k);
    if (s.metadata) {
      const infoRef = doc.context.trailerInfo.Info;
      const info = infoRef ? doc.context.lookup(infoRef) : null;
      if (info instanceof Lb.PDFDict) for (const k of [...info.keys()]) if (k !== N('LecternTabs')) info.delete(k);
      doc.catalog.delete(N('Metadata'));
      doc.catalog.delete(N('PieceInfo'));
    }
    const commentTypes = new Set(['Text', 'FreeText', 'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Ink', 'Square', 'Circle', 'Line', 'Polygon', 'PolyLine', 'Stamp', 'Caret', 'FileAttachment', 'Popup', 'Sound', 'Redact'].map((t) => N(t)));
    for (const page of pages) {
      if (s.scripts) page.node.delete(N('AA'));
      const arr = page.node.Annots?.(); if (!arr) continue;
      for (let i = arr.size() - 1; i >= 0; i--) {
        const d = doc.context.lookup(arr.get(i)); if (!(d instanceof Lb.PDFDict)) continue;
        const sub = d.get(N('Subtype'));
        if (s.comments && commentTypes.has(sub)) { arr.remove(i); continue; }
        if (s.links && sub === N('Link') && !d.has(N('LecternTab'))) { const A = d.get(N('A')); const act = A ? doc.context.lookup(A) : null; if (act instanceof Lb.PDFDict && act.get(N('S')) === N('URI')) { arr.remove(i); continue; } }
        if (s.scripts) { d.delete(N('AA')); const A = d.get(N('A')); const act = A ? doc.context.lookup(A) : null; if (act instanceof Lb.PDFDict && act.get(N('S')) === N('JavaScript')) arr.remove(i); }
      }
    }
    const names = doc.catalog.get(N('Names')) ? doc.context.lookup(doc.catalog.get(N('Names'))) : null;
    if (s.attachments && names instanceof Lb.PDFDict) names.delete(N('EmbeddedFiles'));
    if (s.scripts) {
      doc.catalog.delete(N('OpenAction')); doc.catalog.delete(N('AA'));
      if (names instanceof Lb.PDFDict) names.delete(N('JavaScript'));
    }
  }

  async function compressDialog() {
    if (!need()) return;
    const c = P.compress || {};
    const res = await prompt({
      title: 'Reduce file size', hint: `Current size: ${fmtMB(state.bytes.length)}. Photos are recompressed and the file is compacted when you save. Line art, text and transparent images are left untouched.`,
      fields: [
        { key: 'quality', label: 'Photo quality', type: 'select', value: String(c.quality || 0.75), options: [['0.85', 'High (modest saving)'], ['0.75', 'Good (recommended)'], ['0.6', 'Lower (smallest)']] },
        { key: 'maxDim', label: 'Largest photo dimension', type: 'select', value: String(c.maxDim || 1600), options: [['2400', '2400 px (print)'], ['1600', '1600 px (screen and office printing)'], ['1200', '1200 px (email)']] },
      ], ok: 'Reduce on save',
    });
    if (!res) return;
    P.compress = { quality: Number(res.quality), maxDim: Number(res.maxDim) };
    app.refreshDirty?.();
    app.toast('The file will be compacted when you save.');
  }

  async function finalizeExport(doc, Lb) {
    const N = (k) => Lb.PDFName.of(k);
    // attachments
    for (const a of P.attachments) {
      try { await doc.attach(a.bytes, a.name, { mimeType: a.mime || 'application/octet-stream', description: 'Attached in Lectern', creationDate: new Date(), modificationDate: new Date() }); }
      catch (err) { console.warn('attach', err); }
    }
    // photo recompression
    if (P.compress) {
      const seen = new Set();
      let saved = 0;
      for (const page of doc.getPages()) {
        const res = page.node.Resources?.(); if (!res) continue;
        const xo = res.get(N('XObject')) ? doc.context.lookup(res.get(N('XObject'))) : null;
        if (!(xo instanceof Lb.PDFDict)) continue;
        for (const [, ref] of xo.entries()) {
          if (!(ref instanceof Lb.PDFRef) || seen.has(ref.objectNumber)) continue;
          seen.add(ref.objectNumber);
          const stream = doc.context.lookup(ref);
          if (!(stream instanceof Lb.PDFRawStream)) continue;
          const d = stream.dict;
          if (d.get(N('Subtype')) !== N('Image')) continue;
          const filter = d.get(N('Filter'));
          const isJpeg = filter === N('DCTDecode') || (filter instanceof Lb.PDFArray && filter.size() === 1 && filter.get(0) === N('DCTDecode'));
          if (!isJpeg || d.has(N('SMask')) || d.has(N('Mask')) || d.has(N('Decode'))) continue;
          const cs = d.get(N('ColorSpace'));
          const csName = cs instanceof Lb.PDFArray ? cs.get(0) : cs;
          if (!(csName === N('DeviceRGB') || csName === N('DeviceGray') || csName === N('ICCBased'))) continue;
          try {
            const before = stream.contents.length;
            const bmp = await createImageBitmap(new Blob([stream.contents], { type: 'image/jpeg' }));
            const scale = Math.min(1, P.compress.maxDim / Math.max(bmp.width, bmp.height));
            const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * scale)); c.height = Math.max(1, Math.round(bmp.height * scale));
            c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
            bmp.close?.();
            const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', P.compress.quality));
            const bytes = new Uint8Array(await blob.arrayBuffer());
            c.width = 0; c.height = 0;
            if (bytes.length >= before * 0.92) continue;        // not worth it
            const dict = { Type: 'XObject', Subtype: 'Image', Width: c.width || Math.round(bmp.width * scale), Height: Math.round(bmp.height * scale), ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' };
            const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
            dict.Width = w; dict.Height = h;
            doc.context.assign(ref, doc.context.stream(bytes, dict));
            saved += before - bytes.length;
          } catch (err) { console.warn('image', err); }
        }
      }
      P.lastImageSaving = saved;
    }
  }

  async function postProcess(bytes) {
    if (P.compress) {
      const before = state.bytes.length, after = bytes.length;
      app.toast(after < before ? `File size ${fmtMB(before)} → ${fmtMB(after)}` : `No further reduction possible (${fmtMB(after)}).`);
    }
    if (P.encrypt) bytes = await encryptBytes(bytes);
    return bytes;
  }

  /* ======================= OCR ======================= */

  let tesseractLoaded = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve();
    if (tesseractLoaded) return tesseractLoaded;
    tesseractLoaded = new Promise((resolve, reject) => {
      const s = document.createElement('script'); s.src = 'vendor/ocr/tesseract.min.js';
      s.onload = () => resolve(); s.onerror = () => reject(new Error('The OCR engine is missing from this build.'));
      document.head.append(s);
    });
    return tesseractLoaded;
  }

  async function ocrDialog() {
    if (!need()) return;
    await app.extractAll();
    const missing = livePages().filter((p) => p.text.trim().length < 20 && !P.ocr[p.src]);
    const res = await prompt({
      title: 'Recognize text (OCR)',
      hint: `Reads the words off scanned pages so they can be searched, selected and read aloud. ${missing.length} page${missing.length === 1 ? ' has' : 's have'} no text yet. English only in this build; about 2 to 6 seconds per page.`,
      fields: [{ key: 'which', label: 'Pages', type: 'select', value: missing.length ? 'missing' : 'current', options: [['missing', `Pages without text (${missing.length})`], ['current', `Current page (${state.current})`], ['all', `All pages (${livePages().length})`]] }],
      ok: 'Recognize',
    });
    if (!res) return;
    const targets = res.which === 'all' ? livePages() : res.which === 'current' ? [state.pages[state.current - 1]] : missing;
    if (!targets.length) { app.toast('Nothing to do.'); return; }
    const box = progressBox('Recognizing text');
    let worker = null;
    try {
      box.set(0, 'Loading the OCR engine…');
      await loadTesseract();
      const base = new URL('vendor/ocr/', location.href).href;
      worker = await Tesseract.createWorker('eng', 1, { workerPath: base + 'worker.min.js', corePath: base + 'core/', langPath: base + 'lang', workerBlobURL: false, gzip: true, logger: () => {} });
      let done = 0;
      for (const p of targets) {
        if (box.cancelled) break;
        box.set(done / targets.length, `Page ${p.num}`, `${done} of ${targets.length} pages done`);
        const rot = (p.pdfPage.rotate + p.rot) % 360;
        const vp = p.pdfPage.getViewport({ scale: 300 / 72, rotation: rot });
        const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        const ctx = c.getContext('2d', { alpha: false }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        await p.pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
        const { data } = await worker.recognize(c);
        c.width = 0; c.height = 0;
        const items = [];
        for (const line of data.lines || []) {
          const words = (line.words || []).filter((w) => w.text && w.text.trim());
          words.forEach((w, wi) => {
            const bx = w.bbox;
            const baseY = w.baseline ? (w.baseline.y0 + w.baseline.y1) / 2 : bx.y1;
            const p0 = vp.convertToPdfPoint(bx.x0, baseY), p1 = vp.convertToPdfPoint(bx.x1, baseY);
            const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
            const len = Math.hypot(dx, dy) || 1;
            const ax = dx / len, ay = dy / len;
            const fs = Math.max(4, (bx.y1 - bx.y0) / vp.scale);
            items.push({ str: w.text, transform: [fs * ax, fs * ay, -fs * ay, fs * ax, p0[0], p0[1]], width: len, height: fs, fontName: 'ocr', hasEOL: wi === words.length - 1 });
            if (wi < words.length - 1) items.push({ str: ' ', transform: [fs * ax, fs * ay, -fs * ay, fs * ax, p1[0], p1[1]], width: fs * 0.3, height: fs, fontName: 'ocr', hasEOL: false });
          });
        }
        P.ocr[p.src] = items;
        app.applyOcr(p, items);
        done++;
      }
      box.done();
      app.refreshDirty?.();
      app.toast(`Recognized text on ${done} page${done === 1 ? '' : 's'}. Save PDF to keep it searchable.`);
    } catch (err) {
      box.done();
      app.toast('OCR failed: ' + (err.message || err));
    } finally { try { await worker?.terminate(); } catch { /* ignore */ } }
  }

  /* ======================= Attachments ======================= */

  async function attachmentsDialog() {
    if (!need()) return;
    let existing = {};
    try { existing = (await state.pdf.getAttachments()) || {}; } catch { existing = {}; }
    const body = document.createElement('div');
    const list = document.createElement('ul'); list.className = 'merge-list';
    const render = () => {
      list.textContent = '';
      for (const [key, a] of Object.entries(existing)) {
        const li = document.createElement('li');
        li.innerHTML = `<span class="m-index">📎</span><span class="m-name"></span><span></span><span class="m-actions"></span>`;
        li.querySelector('.m-name').textContent = a.filename || key;
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn'; b.textContent = 'Save'; b.style.height = '28px';
        b.addEventListener('click', () => app.saveBytesAs(a.content, a.filename || key, 'any'));
        li.querySelector('.m-actions').append(b);
        list.append(li);
      }
      P.attachments.forEach((a, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="m-index">＋</span><span class="m-name"></span><span></span><span class="m-actions"></span>`;
        li.querySelector('.m-name').textContent = a.name + ' (added, saved with the PDF)';
        const b = document.createElement('button'); b.type = 'button'; b.title = 'Remove'; b.innerHTML = '<svg><use href="#i-trash"/></svg>';
        b.addEventListener('click', () => { P.attachments.splice(i, 1); app.refreshDirty?.(); render(); });
        li.querySelector('.m-actions').append(b);
        list.append(li);
      });
      if (!list.children.length) { const li = document.createElement('li'); li.textContent = 'No attachments.'; li.style.color = 'var(--muted)'; list.append(li); }
    };
    render();
    const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.hidden = true;
    input.addEventListener('change', async () => {
      for (const f of input.files) P.attachments.push({ name: f.name, mime: f.type || 'application/octet-stream', bytes: await fileBytes(f) });
      input.value = ''; app.refreshDirty?.(); render();
    });
    body.append(list, input);
    await dialog({ title: 'Attached files', body, width: 600, actions: [{ label: 'Attach a file…', onClick: () => { input.click(); return false; } }, { label: 'Done', value: true, primary: true }] });
  }

  /* ======================= state hooks for edit.js ======================= */

  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  app.pro = {
    prompt, dialog,
    get compact() { return !!P.compress; },
    snapshot: () => ({
      marks: P.marks, sanitize: P.sanitize, compress: P.compress, ocr: P.ocr, encrypt: P.encrypt, externalDirty: P.externalDirty,
      attachments: P.attachments.filter((a) => a.bytes.length < 3_000_000).map((a) => ({ name: a.name, mime: a.mime, b64: b64(a.bytes) })),
    }),
    restore: (s) => {
      const f = freshState();
      if (!s) { Object.assign(P, f, { externalDirty: false }); }
      else {
        P.marks = s.marks || f.marks; P.sanitize = s.sanitize || null; P.compress = s.compress || null; P.ocr = s.ocr || {}; P.encrypt = s.encrypt || null; P.externalDirty = !!s.externalDirty;
        P.attachments = (s.attachments || []).map((a) => ({ name: a.name, mime: a.mime, bytes: unb64(a.b64) }));
        for (const p of state.pages) if (P.ocr[p.src] && !p.ocrItems) app.applyOcr(p, P.ocr[p.src]);
      }
      for (const p of state.pages) if (p.rendered) renderMarks(p);
    },
    reset: () => { Object.assign(P, freshState(), { externalDirty: false }); },
    hasChanges: () => marksActive() || P.attachments.length > 0 || !!P.sanitize || !!P.compress || Object.keys(P.ocr).length > 0 || !!P.encrypt || P.externalDirty,
    changeCount: () => (marksActive() ? 1 : 0) + P.attachments.length + (P.sanitize ? 1 : 0) + (P.compress ? 1 : 0) + Object.keys(P.ocr).length + (P.encrypt ? 1 : 0) + (P.externalDirty ? 1 : 0),
    prepareExport, applyPageMarks, finalizeExport, postProcess,
    debug: { docxBytes, docBlocks, textToPdf, parseRanges },
  };
})();

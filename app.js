/* Lectern — a PDF reader that reads aloud.
   Rendering: PDF.js. Speech: the browser's Web Speech API (system voices). */
(() => {
  'use strict';

  const desktop = window.lectern || null;          // present when running inside the Electron app
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  const $ = (id) => document.getElementById(id);
  const el = {
    app: $('app'), viewer: $('viewer'), pages: $('pages'), emptyNote: $('emptyNote'),
    docName: $('docName'), pageInput: $('pageInput'), pageCount: $('pageCount'), zoomSelect: $('zoomSelect'),
    thumbs: $('thumbs'), outline: $('outline'), outlineTab: $('outlineTab'),
    rpStatus: $('rpStatus'), voiceSelect: $('voiceSelect'), rate: $('rate'), rateVal: $('rateVal'),
    pitch: $('pitch'), pitchVal: $('pitchVal'), pitchField: $('pitchField'), follow: $('follow'), skipNumbers: $('skipNumbers'), skipFootnotes: $('skipFootnotes'),
    onlyHighlights: $('onlyHighlights'), voiceHint: $('voiceHint'), voiceProgress: $('voiceProgress'), voiceProgressBar: $('voiceProgressBar'), voiceProgressText: $('voiceProgressText'),
    readSelBtn: $('readSelBtn'),
    transcript: $('transcript'), transcriptTitle: $('transcriptTitle'),
    nowLabel: $('nowLabel'), nowText: $('nowText'), transportPage: $('transportPage'), transportProgress: $('transportProgress'),
    searchInput: $('searchInput'), searchCount: $('searchCount'), toast: $('toast'), fileInput: $('fileInput'),
    btnPlay: $('btnPlay'), btnSidebar: $('btnSidebar'), btnReadPanel: $('btnReadPanel'),
  };

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Small event bus + API so optional modules (edit.js) can plug into the viewer.
  const listeners = {};
  const api = window.LecternApp = {
    on(evt, fn) { (listeners[evt] = listeners[evt] || []).push(fn); },
    emit(evt, ...args) { for (const fn of listeners[evt] || []) { try { fn(...args); } catch (err) { console.error(err); } } },
    editActive: false,      // set by edit.js while a drawing tool owns the page
    exportBytes: null,      // set by edit.js: async () => Uint8Array | null (null = nothing to apply)
  };

  /* ---------------- persistence ---------------- */

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const settings = Object.assign(
    { voice: '', rate: 1, pitch: 1, follow: true, skipNumbers: true, skipFootnotes: true, onlyHighlights: false, sidebar: true, readPanel: true, zoom: 'width' },
    store.get('lectern:settings', {})
  );
  const saveSettings = () => { const { onlyHighlights, ...persisted } = settings; store.set('lectern:settings', persisted); };
  settings.onlyHighlights = false;                 // per session: it silently skips everything in a file without highlights

  /* ---------------- state ---------------- */

  const state = {
    pdf: null, name: '', bytes: null, docKey: '',
    pages: [], numPages: 0,
    zoom: settings.zoom, scale: 1, rotation: 0,
    current: 1, visible: new Set(),
    search: { q: '', hits: [], idx: -1 },
    speaking: null,              // sentence currently lit
    extractAllPromise: null,
    totalSentences: 0, sentenceOffsets: [],
  };

  /* ---------------- helpers ---------------- */

  let toastTimer = 0;
  function toast(msg, action) {
    el.toast.textContent = msg;
    if (action) {
      const b = document.createElement('button');
      b.textContent = action.label;
      b.onclick = () => { hideToast(); action.run(); };
      el.toast.append(b);
    }
    el.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 8000 : 3200);
  }
  function hideToast() { el.toast.classList.remove('is-visible'); }

  const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
  const isTyping = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || !!document.activeElement?.isContentEditable;

  function setStatus(msg) { el.rpStatus.textContent = msg; }

  /* ================= Document loading ================= */

  async function openFile(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('That file is not a PDF.'); return; }
    openData(await file.arrayBuffer(), file.name);
  }

  async function openUrl(url) {
    const name = decodeURIComponent(url.split('/').pop().split('?')[0]) || 'document.pdf';
    el.app.dataset.doc = 'loading';
    el.emptyNote.textContent = 'Loading ' + name + '…';
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
      openData(await res.arrayBuffer(), name);
    } catch (err) {
      el.app.dataset.doc = 'none';
      el.emptyNote.textContent = 'Could not load ' + name + '. ' + (err.message || '');
    }
  }

  async function openData(buffer, name, path = '') {
    closeDoc();
    state.path = path;
    el.app.dataset.doc = 'loading';
    el.emptyNote.textContent = 'Opening ' + name + '…';
    const bytes = new Uint8Array(buffer);
    state.bytes = bytes.slice();                  // PDF.js takes ownership of the buffer it is given
    const task = pdfjsLib.getDocument({
      data: bytes,
      cMapUrl: 'vendor/cmaps/', cMapPacked: true,
      standardFontDataUrl: 'vendor/standard_fonts/',
    });
    task.onPassword = (cb, reason) => {
      const msg = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
        ? 'That password did not work. Try again:' : 'This PDF is password protected. Enter the password:';
      const pw = prompt(msg);
      if (pw == null) { task.destroy(); return; }
      cb(pw);
    };
    task.onProgress = ({ loaded, total }) => {
      if (total) el.emptyNote.textContent = `Opening ${name}… ${Math.round(100 * loaded / total)}%`;
    };
    let pdf;
    try { pdf = await task.promise; }
    catch (err) {
      el.app.dataset.doc = 'none';
      el.emptyNote.textContent = /password/i.test(err?.message || '') ? 'Open cancelled: the PDF needs a password.' : 'Could not open ' + name + '. ' + (err?.message || '');
      return;
    }
    await setupDocument(pdf, name);
  }

  async function setupDocument(pdf, name) {
    state.pdf = pdf;
    state.name = name;
    state.numPages = pdf.numPages;
    state.docKey = 'lectern:doc:' + name + ':' + state.bytes.length;
    el.docName.textContent = name; el.docName.title = name;
    document.title = name + ' · Lectern';
    el.pageCount.textContent = 'of ' + pdf.numPages;
    el.pageInput.max = pdf.numPages;

    const pdfPages = [];
    for (let n = 1; n <= pdf.numPages; n += 25) {
      const batch = [];
      for (let k = n; k < Math.min(n + 25, pdf.numPages + 1); k++) batch.push(pdf.getPage(k));
      pdfPages.push(...await Promise.all(batch));
    }
    if (state.pdf !== pdf) return;                 // another document was opened meanwhile
    try { const fields = await pdf.getFieldObjects(); state.hasForms = !!(fields && Object.keys(fields).length); } catch { state.hasForms = false; }
    if (state.pdf !== pdf) return;

    const frag = document.createDocumentFragment();
    state.pages = pdfPages.map((pdfPage, i) => {
      const div = document.createElement('div');
      div.className = 'page'; div.dataset.page = i + 1;
      const canvas = document.createElement('canvas');
      const layer = document.createElement('div'); layer.className = 'textLayer';
      const annotSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); annotSvg.setAttribute('class', 'annot-svg');
      const editHtml = document.createElement('div'); editHtml.className = 'edit-html';
      const formLayer = document.createElement('div'); formLayer.className = 'form-layer';
      const num = document.createElement('div'); num.className = 'page-num'; num.textContent = i + 1;
      div.append(canvas, layer, annotSvg, editHtml, formLayer, num);
      frag.append(div);
      return { num: i + 1, src: i, pdfPage, el: div, canvas, layer, annotSvg, editHtml, formLayer, vp: null, rendered: false, rendering: false, renderTask: null,
               textPromise: null, text: '', items: [], offsets: [], styles: {}, spans: [], sentences: [], thumb: null,
               rot: 0, deleted: false };          // src = index in the original file; num = position in the current order
    });
    el.pages.append(frag);
    el.app.dataset.doc = 'open';

    state.pages.forEach((p) => pageObserver.observe(p.el));
    layout();
    buildThumbnails();
    buildOutline(pdf);
    api.emit('doc-open', state);

    const saved = store.get(state.docKey, null);
    if (saved && saved.page > 1 && saved.page <= state.numPages) {
      scrollToPage(saved.page, false);
      if (saved.cursor) player.cursor = saved.cursor;
      toast(`Resumed at page ${saved.page}`, { label: 'Start over', run: () => { player.cursor = null; scrollToPage(1); } });
    }
    setStatus('Preparing text…');
    renderTranscript(state.current);
    extractAll().then(() => { if (state.pdf === pdf) updateProgressMeta(); });
    el.viewer.focus({ preventScroll: true });
  }

  function closeDoc() {
    if (state.pdf) api.emit('doc-close', state);
    player.stop(true);
    state.path = ''; state.hasForms = false;
    if (state.pdf) { try { state.pdf.destroy(); } catch { /* ignore */ } }
    state.pages.forEach((p) => { pageObserver.unobserve(p.el); if (p.renderTask) p.renderTask.cancel(); });
    thumbObserver.disconnect();
    state.pdf = null; state.pages = []; state.numPages = 0; state.current = 1; state.visible.clear();
    state.search = { q: '', hits: [], idx: -1 }; state.speaking = null; state.extractAllPromise = null;
    state.totalSentences = 0; state.sentenceOffsets = [];
    el.pages.innerHTML = ''; el.thumbs.innerHTML = ''; el.outline.innerHTML = ''; el.transcript.innerHTML = '';
    el.viewer.scrollTop = 0;
    el.outlineTab.hidden = true; selectSideTab('thumbs');
    el.docName.textContent = ''; el.pageCount.textContent = 'of 0'; el.pageInput.value = 1;
    el.searchCount.textContent = ''; el.searchCount.classList.remove('is-empty');
    el.transportPage.textContent = ''; el.transportProgress.textContent = '';
    el.nowLabel.textContent = 'Ready'; el.nowText.textContent = 'Press play to start at the current page, or click a sentence.';
    document.title = 'Lectern';
    el.app.dataset.doc = 'none';
  }

  /* ================= Layout, zoom, rendering ================= */

  const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

  function computeScale() {
    const first = state.pages[0];
    if (!first) return 1;
    const vp = first.pdfPage.getViewport({ scale: 1, rotation: (first.pdfPage.rotate + state.rotation + first.rot) % 360 });
    const availW = el.viewer.clientWidth - 48;
    const availH = el.viewer.clientHeight - 40;
    if (state.zoom === 'width') return clamp(availW / vp.width, 0.2, 6);
    if (state.zoom === 'page') return clamp(Math.min(availW / vp.width, availH / vp.height), 0.2, 6);
    return Number(state.zoom) || 1;
  }

  function layout() {
    if (!state.pages.length) return;
    if (el.viewer.clientWidth < 200) { requestAnimationFrame(layout); return; }   // pane not sized yet
    const anchor = state.pages[state.current - 1];
    const anchorRel = anchor ? (el.viewer.scrollTop - anchor.el.offsetTop) / Math.max(1, anchor.el.offsetHeight) : 0;
    state.scale = computeScale();
    for (const p of state.pages) {
      p.vp = p.pdfPage.getViewport({ scale: state.scale, rotation: (p.pdfPage.rotate + state.rotation + p.rot) % 360 });   // intrinsic + view + per-page
      p.el.style.width = p.vp.width + 'px';
      p.el.style.height = p.vp.height + 'px';
      p.el.hidden = p.deleted;
      invalidate(p);
    }
    if (anchor) el.viewer.scrollTop = anchor.el.offsetTop + anchorRel * anchor.el.offsetHeight;
    syncZoomSelect();
    renderVisible();
    refreshHighlightsAll();
    api.emit('layout', state);
  }

  function syncZoomSelect() {
    const sel = el.zoomSelect;
    const val = typeof state.zoom === 'string' && isNaN(state.zoom) ? state.zoom : String(Number(state.zoom));
    let opt = [...sel.options].find((o) => o.value === val);
    if (!opt) {
      opt = document.createElement('option');
      opt.value = val; opt.textContent = Math.round(Number(val) * 100) + '%'; opt.dataset.custom = '1';
      sel.append(opt);
    }
    [...sel.options].forEach((o) => { if (o.dataset.custom && o !== opt) o.remove(); });
    sel.value = val;
    const fit = state.zoom === 'width' || state.zoom === 'page';
    if (fit) opt.textContent = (state.zoom === 'width' ? 'Fit width' : 'Fit page') + ` (${Math.round(state.scale * 100)}%)`;
  }

  function setZoom(z) {
    state.zoom = z; settings.zoom = z; saveSettings();
    layout();
  }
  function zoomStep(dir) {
    const cur = state.scale;
    const next = dir > 0 ? ZOOM_STEPS.find((s) => s > cur + 0.01) : [...ZOOM_STEPS].reverse().find((s) => s < cur - 0.01);
    if (next) setZoom(next);
  }

  function invalidate(p) {
    if (p.renderTask) { p.renderTask.cancel(); p.renderTask = null; }
    p.rendered = false; p.rendering = false;
    p.el.classList.remove('is-rendered');
  }
  function release(p) {
    invalidate(p);
    p.canvas.width = 0; p.canvas.height = 0;
    p.layer.innerHTML = ''; p.spans = [];
    api.emit('page-released', p);
  }

  async function renderPage(p) {
    if (p.rendered || p.rendering || !p.vp) return;
    p.rendering = true;
    const vp = p.vp;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const canvas = p.canvas;
    canvas.width = Math.floor(vp.width * dpr); canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = vp.width + 'px'; canvas.style.height = vp.height + 'px';
    const ctx = canvas.getContext('2d', { alpha: false });
    const renderOpts = { canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null };
    if (state.hasForms) renderOpts.annotationMode = pdfjsLib.AnnotationMode.ENABLE_FORMS;   // skip widget appearances: edit.js draws live fields
    const task = p.pdfPage.render(renderOpts);
    p.renderTask = task;
    try { await task.promise; }
    catch (err) {
      p.rendering = false;
      if (err?.name !== 'RenderingCancelledException') console.error(err);
      return;
    }
    if (p.renderTask !== task) return;
    p.renderTask = null; p.rendering = false; p.rendered = true;
    p.el.classList.add('is-rendered');
    await ensureText(p);
    if (!p.rendered || p.vp !== vp) return;
    buildTextLayer(p);
    applyHighlights(p);
    api.emit('page-rendered', p);
  }

  function renderVisible() {
    for (const n of state.visible) { const p = state.pages[n - 1]; if (p) renderPage(p); }
  }

  // Re-extract text and redraw one page (after OCR added text to it).
  function rerenderPage(p) {
    p.textPromise = null; p.sentences = []; p.items = []; p.offsets = [];
    state.extractAllPromise = null;
    invalidate(p);
    if (state.visible.has(p.num)) renderPage(p);
    extractAll().then(() => { updateProgressMeta(); if (state.current === p.num) renderTranscript(p.num); });
  }
  function applyOcr(p, items) { p.ocrItems = items; rerenderPage(p); }

  // Put the pages in a new order (array of current page numbers). Marks and bookmarks follow their pages.
  function reorderPages(order) {
    if (!state.pdf || order.length !== state.pages.length) return;
    player.stop(true);
    const arr = order.map((n) => state.pages[n - 1]);
    const map = new Map(arr.map((p, i) => [p.num, i + 1]));
    arr.forEach((p, i) => {
      p.num = i + 1; p.el.dataset.page = String(i + 1);
      p.el.querySelector('.page-num').textContent = String(i + 1);
      el.pages.append(p.el);
    });
    state.pages = arr;
    state.speaking = null; state.search = { q: '', hits: [], idx: -1 }; el.searchCount.textContent = '';
    state.sentenceOffsets = state.pages.map((p) => 0); state.extractAllPromise = null;
    api.emit('pages-reordered', map);
    layout(); buildThumbnails();
    setCurrent(pageAtScroll()); renderTranscript(state.current); savePosition();
    extractAll().then(updateProgressMeta);
  }

  async function saveBytesAs(bytes, name, kind = 'pdf') {
    if (desktop) { const r = await desktop.saveFile(name, bytes, '', kind); if (r?.ok) toast('Saved ' + r.path); return !!r?.ok; }
    const mime = { pdf: 'application/pdf', markdown: 'text/markdown', zip: 'application/zip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain', html: 'text/html', png: 'image/png', jpg: 'image/jpeg' }[kind] || 'application/octet-stream';
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  }

  const pageObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const n = Number(e.target.dataset.page);
      const p = state.pages[n - 1];
      if (!p) continue;
      if (e.isIntersecting) { state.visible.add(n); renderPage(p); }
      else { state.visible.delete(n); release(p); }
    }
  }, { root: null, rootMargin: '700px 0px' });

  /* --- text layer: one transparent span per PDF text item, positioned over the canvas --- */

  const measureCtx = document.createElement('canvas').getContext('2d');

  function buildTextLayer(p) {
    const vp = p.vp;
    const frag = document.createDocumentFragment();
    p.spans = new Array(p.items.length);
    p.items.forEach((item, i) => {
      if (!item.str) return;
      const style = p.styles[item.fontName] || {};
      const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
      let angle = Math.atan2(tx[1], tx[0]);
      if (style.vertical) angle += Math.PI / 2;
      const fontHeight = Math.hypot(tx[2], tx[3]);
      let ascent = fontHeight;
      if (style.ascent) ascent = style.ascent * fontHeight;
      else if (style.descent) ascent = (1 + style.descent) * fontHeight;
      let left, top;
      if (angle === 0) { left = tx[4]; top = tx[5] - ascent; }
      else { left = tx[4] + ascent * Math.sin(angle); top = tx[5] - ascent * Math.cos(angle); }
      const span = document.createElement('span');
      span.textContent = item.str;
      span.dataset.i = i;
      const family = style.fontFamily || 'sans-serif';
      span.style.cssText = `left:${left.toFixed(2)}px;top:${top.toFixed(2)}px;font-size:${fontHeight.toFixed(2)}px;font-family:${family}`;
      let transform = '';
      if (angle) transform += `rotate(${angle}rad) `;
      if (item.str.trim()) {
        measureCtx.font = `${fontHeight}px ${family}`;
        const measured = measureCtx.measureText(item.str).width;
        const target = (style.vertical ? item.height : item.width) * vp.scale;
        if (measured > 0 && target > 0) transform += `scaleX(${(target / measured).toFixed(4)})`;
      }
      if (transform) span.style.transform = transform;
      p.spans[i] = span;
      frag.append(span);
    });
    p.layer.innerHTML = '';
    p.layer.append(frag);
  }

  /* --- highlights (speaking sentence + search hits) --- */

  function applyHighlights(p) {
    if (!p.spans.length) return;
    for (const s of p.spans) if (s) s.className = '';
    for (const hit of state.search.hits) {
      if (hit.page !== p.num) continue;
      const cur = state.search.hits[state.search.idx] === hit;
      for (const i of hit.itemIdxs) p.spans[i]?.classList.add(cur ? 'hit-current' : 'hit');
    }
    const sp = state.speaking;
    const idxs = sp && (sp.page === p.num ? sp.itemIdxs : sp.multi?.get(p.num));
    if (idxs) for (const i of idxs) p.spans[i]?.classList.add('speaking');
  }
  function refreshHighlightsAll() { for (const n of state.visible) { const p = state.pages[n - 1]; if (p?.rendered) applyHighlights(p); } }

  /* --- page tracking --- */

  function pageAtScroll() {
    const pages = state.pages.filter((p) => !p.deleted);
    if (!pages.length) return 1;
    const y = el.viewer.scrollTop + el.viewer.clientHeight * 0.4;
    let lo = 0, hi = pages.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pages[mid].el.offsetTop <= y) lo = mid; else hi = mid - 1;
    }
    return pages[lo].num;
  }

  let scrollRaf = 0;
  el.viewer.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; setCurrent(pageAtScroll()); });
  });

  let transcriptTimer = 0;
  function setCurrent(n) {
    if (n === state.current || !state.pages.length) return;
    state.current = n;
    el.pageInput.value = n;
    const thumb = state.pages[n - 1].thumb;
    el.thumbs.querySelector('.thumb.is-current')?.classList.remove('is-current');
    if (thumb) { thumb.classList.add('is-current'); thumb.scrollIntoView({ block: 'nearest' }); }
    savePosition();
    api.emit('current-page', n);
    if (player.status === 'idle') {
      clearTimeout(transcriptTimer);
      transcriptTimer = setTimeout(() => renderTranscript(n), 250);
    }
  }

  function scrollToPage(n, smooth = false) {
    let p = state.pages[n - 1];
    if (!p) return;
    if (p.deleted) {                               // skip over removed pages in the direction of travel
      const dir = n >= state.current ? 1 : -1;
      let k = n;
      while (state.pages[k - 1] && state.pages[k - 1].deleted) k += dir;
      p = state.pages[k - 1];
      if (!p) return;
      n = k;
    }
    el.viewer.scrollTo({ top: p.el.offsetTop - 16, behavior: smooth && !reducedMotion ? 'smooth' : 'auto' });
    setCurrent(n);
  }

  function savePosition() {
    if (!state.docKey) return;
    store.set(state.docKey, { page: state.current, cursor: player.queue ? player.docCursor : player.cursor });
  }

  /* ================= Thumbnails and outline ================= */

  const thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      thumbObserver.unobserve(e.target);
      renderThumb(state.pages[Number(e.target.dataset.page) - 1]);
    }
  }, { root: el.thumbs, rootMargin: '300px 0px' });

  function buildThumbnails() {
    el.thumbs.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const p of state.pages) {
      const b = document.createElement('button');
      b.className = 'thumb' + (p.num === state.current ? ' is-current' : '') + (p.deleted ? ' is-deleted' : '');
      b.dataset.page = p.num;
      b.title = 'Page ' + p.num;
      const vp = p.pdfPage.getViewport({ scale: 1, rotation: (p.pdfPage.rotate + state.rotation + p.rot) % 360 });
      const ph = document.createElement('div');
      ph.className = 'thumb-ph';
      ph.style.aspectRatio = `${vp.width} / ${vp.height}`;
      const label = document.createElement('span'); label.textContent = p.num;
      b.append(ph, label);
      b.addEventListener('click', () => scrollToPage(p.num));
      p.thumb = b;
      frag.append(b);
      thumbObserver.observe(b);
    }
    el.thumbs.append(frag);
    api.emit('thumbs-built', state);
  }

  async function renderThumb(p) {
    if (!p || !p.thumb) return;
    const width = 150;
    const rotation = (p.pdfPage.rotate + state.rotation + p.rot) % 360;
    const base = p.pdfPage.getViewport({ scale: 1, rotation });
    const vp = p.pdfPage.getViewport({ scale: width / base.width, rotation });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width * 2); canvas.height = Math.floor(vp.height * 2);
    try {
      await p.pdfPage.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp, transform: [2, 0, 0, 2, 0, 0] }).promise;
    } catch { return; }
    const ph = p.thumb.querySelector('.thumb-ph');
    if (ph) ph.replaceWith(canvas);
  }

  async function buildOutline(pdf) {
    let outline = null;
    try { outline = await pdf.getOutline(); } catch { /* no outline */ }
    if (state.pdf !== pdf) return;
    el.outline.innerHTML = '';
    if (!outline || !outline.length) { el.outlineTab.hidden = true; return; }
    el.outlineTab.hidden = false;
    const build = (items) => {
      const ul = document.createElement('ul');
      for (const it of items) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.textContent = it.title || 'Untitled';
        b.addEventListener('click', () => goToDest(it.dest));
        li.append(b);
        if (it.items?.length) li.append(build(it.items));
        ul.append(li);
      }
      return ul;
    };
    el.outline.append(build(outline));
  }

  async function goToDest(dest) {
    try {
      let d = dest;
      if (typeof d === 'string') d = await state.pdf.getDestination(d);
      if (!Array.isArray(d) || !d[0]) return;
      const idx = typeof d[0] === 'object' ? await state.pdf.getPageIndex(d[0]) : d[0];
      scrollToPage(idx + 1, true);
    } catch { toast('That bookmark points nowhere.'); }
  }

  function selectSideTab(name) {
    document.querySelectorAll('.side-tab').forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('is-active', on); t.setAttribute('aria-selected', on);
    });
    document.querySelectorAll('.side-pane').forEach((pane) => { pane.hidden = pane.id !== name; });
    api.emit('side-tab', name);
  }
  document.querySelectorAll('.side-tab').forEach((t) => t.addEventListener('click', () => selectSideTab(t.dataset.tab)));

  /* ================= Text extraction and sentences ================= */

  const ABBREV = /(?:^|[\s(])(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|cf|fig|figs|no|nos|vol|pp|ed|eds|al|inc|ltd|co|corp|approx|dept|est|min|max|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|[a-z])\.$/i;

  function segment(text) {
    const out = [];
    const n = text.length;
    let start = 0;
    const push = (s, e) => { if (text.slice(s, e).trim()) out.push({ start: s, end: e }); };
    for (let i = 0; i < n; i++) {
      const c = text[i];
      let boundary = false;
      if (c === '.' || c === '!' || c === '?') {
        let j = i + 1;
        while (j < n && /["'”’)\]]/.test(text[j])) j++;
        if (j >= n || /\s/.test(text[j])) {
          let ok = true;
          if (c === '.') {
            if (ABBREV.test(text.slice(Math.max(start, i - 8), i + 1))) ok = false;
            if (/^(\d{1,3}|[a-z]|[ivx]{1,4})\.$/i.test(text.slice(start, i + 1).trim())) ok = false;   // list marker: "1." / "a." / "iv."
            let k = j; while (k < n && /\s/.test(text[k])) k++;
            if (k < n && /[a-z]/.test(text[k])) ok = false;
          }
          if (ok) { push(start, j); start = j; i = j - 1; boundary = true; }
        }
      } else if (c === '\n' && text[i + 1] === '\n') {
        push(start, i); start = i; boundary = true;
      }
      if (!boundary && i - start > 320) {
        // Overlong run without punctuation: break at the last comma/semicolon/newline so utterances stay short.
        const chunk = text.slice(start, i);
        const cut = Math.max(chunk.lastIndexOf(', '), chunk.lastIndexOf('; '), chunk.lastIndexOf('\n'));
        if (cut > 60) { push(start, start + cut + 1); start = start + cut + 1; }
      }
    }
    if (start < n) push(start, n);
    return out;
  }

  const cleanText = (raw) => raw
    .replace(/(\w)-\n(?=[a-z])/g, '$1')      // re-join words hyphenated across lines
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[­​]/g, '')
    .trim();

  const isJunk = (t) =>
    /^\s*(page\s*)?\d{1,5}(\s*(of|\/|-|–)\s*\d{1,5})?\s*\.?\s*$/i.test(t) ||
    /^[\s\d.,;:–\-()|•·]*$/.test(t) ||
    /^[ivxlcdm]{1,6}\.?$/i.test(t.trim());

  function itemsInRange(p, start, end) {
    const out = [];
    for (let i = 0; i < p.items.length; i++) {
      const off = p.offsets[i], len = p.items[i].str.length;
      if (off >= end) break;
      if (off + len > start && p.items[i].str.trim()) out.push(i);
    }
    return out;
  }

  function ensureText(p) {
    if (p.textPromise) return p.textPromise;
    p.textPromise = (async () => {
      let tc;
      if (p.ocrItems) tc = { items: p.ocrItems, styles: { ocr: { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2 } } };   // recognised text from OCR
      else { try { tc = await p.pdfPage.getTextContent(); } catch { tc = { items: [], styles: {} }; } }
      const raw = tc.items.filter((it) => it.str !== undefined);
      const items = [], offsets = [];
      let text = '';
      const fontSize = (it) => Math.hypot(it.transform[2], it.transform[3]) || Math.abs(it.transform[0]) || 0;
      for (let k = 0; k < raw.length; k++) {
        const it = raw[k];
        items.push(it); offsets.push(text.length);
        text += it.str;
        if (!it.hasEOL) continue;
        // Decide whether this line end is a plain wrap or a real break (heading, paragraph, list item):
        // a change in font size, or a vertical gap much larger than the line height, both mean "new block".
        // PDF.js often carries the EOL flag on an empty item, so compare the surrounding real text items.
        let prev = null, next = null;
        for (let j = k; j >= 0; j--) if (raw[j].str.trim()) { prev = raw[j]; break; }
        for (let j = k + 1; j < raw.length; j++) if (raw[j].str.trim()) { next = raw[j]; break; }
        let block = false;
        if (prev && next) {
          const a = fontSize(prev), b = fontSize(next);
          if (a && b && Math.abs(a - b) / Math.max(a, b) > 0.12) block = true;
          const gap = Math.abs(prev.transform[5] - next.transform[5]);
          if (a && gap > a * 2.1) block = true;
        }
        if (!/\s$/.test(text)) text += block ? '\n\n' : '\n';
        else if (block) text += '\n';
      }
      p.items = items; p.offsets = offsets; p.text = text; p.styles = tc.styles || {};

      // Footnotes and reference markers. Body size = the font size that covers the median character.
      // A footnote block is small text sitting below every line of body text in the lower part of the page;
      // a marker is a tiny run of digits or symbols (superscripts). Markers are blanked in the spoken text.
      const fsOf = (it) => Math.hypot(it.transform[2], it.transform[3]) || it.height || 0;
      const sized = items.filter((it) => it.str.trim());
      const weights = sized.map((it) => ({ s: fsOf(it), n: it.str.length })).sort((a, b) => a.s - b.s);
      const totalChars = weights.reduce((a, x) => a + x.n, 0);
      let acc = 0, body = 0;
      for (const w of weights) { acc += w.n; if (acc >= totalChars / 2) { body = w.s; break; } }
      const spoken = text.split('');
      if (body > 0) {
        const view = p.pdfPage.view, pageH = view[3] - view[1], bottom = view[1];
        const small = (it) => { const s = fsOf(it); return s > 0 && s <= body * 0.82; };
        const bodyMinY = Math.min(Infinity, ...sized.filter((it) => !small(it) && it.transform[5] > bottom + pageH * 0.06).map((it) => it.transform[5]));
        items.forEach((it, i) => {
          if (!it.str.trim()) return;
          if (fsOf(it) <= body * 0.72 && /^[\d*†‡§¶]{1,3}$/.test(it.str.trim())) {
            it.marker = true;
            for (let k = offsets[i]; k < offsets[i] + it.str.length; k++) spoken[k] = ' ';
            return;
          }
          const y = it.transform[5];
          if (small(it) && y < bodyMinY - 2 && y < bottom + pageH * 0.4) it.footnote = true;
        });
      }
      p.spoken = spoken.join('');

      p.sentences = segment(p.spoken).map((s, i) => {
        const itemIdxs = itemsInRange(p, s.start, s.end);
        const real = itemIdxs.filter((k) => !items[k].marker);
        return { page: p.num, i, start: s.start, end: s.end, text: cleanText(p.spoken.slice(s.start, s.end)), itemIdxs, footnote: real.length > 0 && real.every((k) => items[k].footnote) };
      }).filter((s) => s.text);
      p.sentences.forEach((s, i) => { s.i = i; });
      return p;
    })();
    return p.textPromise;
  }

  function extractAll() {
    if (state.extractAllPromise) return state.extractAllPromise;
    const pdf = state.pdf;
    state.extractAllPromise = (async () => {
      const pages = state.pages;
      let done = 0;
      const worker = async () => {
        for (;;) {
          const p = pages[done++];
          if (!p || state.pdf !== pdf) return;
          await ensureText(p);
          if (done % 5 === 0 || done >= pages.length) setStatus(`Preparing text… ${Math.min(done, pages.length)} of ${pages.length}`);
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      if (state.pdf !== pdf) return;
      let total = 0;
      state.sentenceOffsets = pages.map((p) => { const o = total; total += p.sentences.length; return o; });
      state.totalSentences = total;
      setStatus(total ? `${total.toLocaleString()} sentences across ${pages.length} page${pages.length > 1 ? 's' : ''}.`
                      : 'This PDF has no readable text. It may be a scan; run it through an OCR tool first.');
    })();
    return state.extractAllPromise;
  }

  /* ================= Speech player ================= */

  const synth = window.speechSynthesis;

  // Natural voices (desktop only): synthesised offline by Piper in the main process and played as audio clips.
  const neural = {
    available: false, catalogue: [], cache: new Map(), current: null, raf: 0,
    installed(id) { return !!this.catalogue.find((v) => v.id === id)?.installed; },
    async init() {
      if (!desktop?.tts) return;
      try { const r = await desktop.tts.list(); this.available = !!r.available; this.catalogue = r.voices || []; } catch { this.available = false; }
      desktop.tts.onProgress((info) => {
        if (info.error || !info.total) return;
        setVoiceProgress(info.received / info.total, `${Math.round(info.received / 1048576)} of ${Math.round(info.total / 1048576)} MB`);
      });
      loadVoices();
    },
    async clipUrl(voice, text) {
      const k = voice + '\u0000' + text;
      if (this.cache.has(k)) return this.cache.get(k);
      const job = (async () => {
        const data = await desktop.tts.synth(voice, text);
        return URL.createObjectURL(new Blob([data], { type: 'audio/wav' }));
      })();
      this.cache.set(k, job);
      job.catch(() => this.cache.delete(k));
      if (this.cache.size > 16) {
        const oldest = this.cache.keys().next().value;
        const old = this.cache.get(oldest); this.cache.delete(oldest);
        old.then((u) => URL.revokeObjectURL(u)).catch(() => {});
      }
      return job;
    },
    prefetch(voice, text) { this.clipUrl(voice, text).catch(() => {}); },
    async speak(voice, text, { stillCurrent, onBoundary, onEnd, onError }) {
      let url;
      try { url = await this.clipUrl(voice, text); } catch (err) { if (stillCurrent()) onError(err); return; }
      if (!stillCurrent()) return;
      this.cancel();
      const a = new Audio(url);
      a.preservesPitch = true;
      a.playbackRate = settings.rate;
      this.current = a;
      a.onended = () => { if (this.current === a) this.current = null; if (stillCurrent()) onEnd(); };
      a.onerror = () => { if (this.current === a) this.current = null; if (stillCurrent()) onError(new Error('Audio playback failed')); };
      const tick = () => {
        if (this.current !== a) return;
        if (a.duration > 0 && !a.paused) onBoundary(Math.min(text.length - 1, Math.floor((a.currentTime / a.duration) * text.length)));
        this.raf = requestAnimationFrame(tick);
      };
      try { await a.play(); } catch (err) { if (this.current === a) this.current = null; if (stillCurrent()) onError(err); return; }
      tick();
    },
    cancel() {
      cancelAnimationFrame(this.raf);
      const a = this.current;
      if (a) { this.current = null; try { a.pause(); a.removeAttribute('src'); a.load(); } catch { /* ignore */ } }
    },
    setRate(r) { if (this.current) this.current.playbackRate = r; },
  };

  const player = {
    status: 'idle',         // idle | playing | paused
    cursor: null,           // { page, i }
    queue: null,            // ad hoc list of sentences while reading a selection
    docCursor: null,        // where the document reading was before the selection started
    token: 0,
    voices: [],

    currentVoice() {
      return this.voices.find((v) => v.name === settings.voice) || this.voices.find((v) => v.default) || this.voices[0] || null;
    },
    neuralVoiceId() {
      if (!settings.voice || !settings.voice.startsWith('piper:')) return null;
      const id = settings.voice.slice(6);
      return neural.available && neural.installed(id) ? id : null;
    },
    passes(s) {
      if (settings.skipFootnotes && s.footnote) return false;
      return !settings.onlyHighlights || !api.sentenceFilter || api.sentenceFilter(s);
    },

    async sentenceAt(c) {
      if (this.queue) return this.queue[c.i] || null;
      const p = state.pages[c.page - 1];
      if (!p) return null;
      await ensureText(p);
      return p.sentences[c.i] || null;
    },

    async step(c, dir) {
      if (this.queue) { const i = c.i + dir; return i >= 0 && i < this.queue.length ? { page: this.queue[i].page, i } : null; }
      let { page, i } = c;
      i += dir;
      for (;;) {
        if (page < 1 || page > state.numPages) return null;
        const p = state.pages[page - 1];
        if (!p.deleted) {
          await ensureText(p);
          while (i >= 0 && i < p.sentences.length) {
            if (this.passes(p.sentences[i])) return { page, i };
            i += dir;
          }
        }
        if (dir > 0) { page++; i = 0; }
        else {
          page--;
          const q = state.pages[page - 1];
          if (q && !q.deleted) { await ensureText(q); i = q.sentences.length - 1; } else i = -1;
        }
      }
    },

    playSelection() {
      const info = currentSelectionInfo();
      if (!info) return;
      const firstPage = Math.min(...info.pages.keys());
      const list = segment(info.text)
        .map((seg, i) => ({ page: firstPage, i, text: cleanText(info.text.slice(seg.start, seg.end)), itemIdxs: info.pages.get(firstPage) || [], multi: info.pages }))
        .filter((s) => s.text);
      if (!list.length) return;
      if (!this.queue) this.docCursor = this.cursor;
      this.queue = list;
      window.getSelection()?.removeAllRanges();
      el.readSelBtn.hidden = true;
      this.start({ page: firstPage, i: 0 });
    },
    leaveQueue() { if (this.queue) { this.queue = null; this.cursor = this.docCursor; this.docCursor = null; } },

    async prefetchNext(nid) {
      const next = await this.step(this.cursor, 1);
      if (!next) return;
      const s = await this.sentenceAt(next);
      if (s && !(settings.skipNumbers && isJunk(s.text))) neural.prefetch(nid, s.text);
    },

    async start(cursor) {
      if (!state.pdf) return;
      this.cancelSpeech();
      this.cursor = cursor;
      this.status = 'playing';
      updateTransport();
      this.speak();
    },

    async speak() {
      const tok = ++this.token;
      let s = await this.sentenceAt(this.cursor);
      if (tok !== this.token) return;
      while (s && ((settings.skipNumbers && isJunk(s.text)) || (!this.queue && !this.passes(s)))) {
        const next = await this.step(this.cursor, 1);
        if (tok !== this.token) return;
        if (!next) { s = null; break; }
        this.cursor = next; s = await this.sentenceAt(next);
      }
      if (!s) { this.finish(); return; }
      setSpeaking(s);
      const nid = this.neuralVoiceId();
      if (nid) {
        const stillCurrent = () => tok === this.token;
        el.nowLabel.textContent = 'Preparing…';
        neural.speak(nid, s.text, {
          stillCurrent,
          onBoundary: (ci) => markWord(ci, 0),
          onEnd: () => this.advance(1, true),
          onError: (err) => {
            console.warn('natural voice', err);
            toast('The natural voice could not play. Switching to a system voice.');
            settings.voice = this.currentVoice()?.name || ''; saveSettings(); loadVoices();
            if (stillCurrent()) this.speak();
          },
        }).then(() => { if (stillCurrent()) { el.nowLabel.textContent = this.queue ? 'Selection' : `Page ${s.page}`; this.prefetchNext(nid); } });
        return;
      }
      if (!synth) { setStatus('This browser has no speech engine.'); this.stop(); return; }
      const u = new SpeechSynthesisUtterance(s.text);
      const v = this.currentVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = settings.rate; u.pitch = settings.pitch;
      u.onend = () => { if (tok === this.token) this.advance(1, true); };
      u.onerror = (e) => {
        if (tok !== this.token || e.error === 'interrupted' || e.error === 'canceled') return;
        console.warn('speech error', e.error);
        if (e.error === 'not-allowed' || e.error === 'audio-busy' || e.error === 'synthesis-failed') { toast('The speech engine could not speak. Try another voice.'); this.pause(); return; }
        this.advance(1, true);
      };
      u.onboundary = (e) => { if (tok === this.token && e.name === 'word') markWord(e.charIndex, e.charLength || 0); };
      this.utter = u;                         // keep a reference: Chrome garbage-collects live utterances otherwise
      setTimeout(() => { if (tok === this.token) synth.speak(u); }, 30);
    },

    async advance(dir, auto = false) {
      if (!state.pdf || !this.cursor) return;
      this.token++;
      const next = await this.step(this.cursor, dir);
      if (!next) { if (dir > 0) this.finish(); return; }
      this.cursor = next;
      if (this.status === 'playing') { if (!auto) this.cancelSpeech(); this.speak(); }
      else { const s = await this.sentenceAt(next); if (s) setSpeaking(s); }
      savePosition();
    },

    toggle() {
      if (!state.pdf) return;
      if (this.status === 'playing') this.pause();
      else if (this.status === 'paused') { this.status = 'playing'; updateTransport(); this.speak(); }
      else if (currentSelectionInfo()) this.playSelection();
      else this.start(this.cursor || { page: state.current, i: 0 });
    },

    pause() {
      // Pausing is implemented as cancel + remember: resuming re-reads the sentence from its start.
      // (The engine's own pause/resume is unreliable after a few seconds on several platforms.)
      this.cancelSpeech();
      this.status = 'paused';
      updateTransport();
    },

    stop(silent = false) {
      this.cancelSpeech();
      this.status = 'idle';
      const wasSelection = !!this.queue;
      this.leaveQueue();
      clearSpeaking();
      updateTransport();
      if (!silent) {
        el.nowLabel.textContent = 'Stopped';
        el.nowText.textContent = wasSelection ? 'Press play to continue the document from where you were.' : 'Press play to continue from the same sentence.';
      }
    },

    finish() {
      this.cancelSpeech();
      this.status = 'idle';
      const wasSelection = !!this.queue;
      this.leaveQueue();
      if (!wasSelection) this.cursor = null;
      clearSpeaking();
      updateTransport();
      el.nowLabel.textContent = 'Finished';
      el.nowText.textContent = wasSelection ? 'Read the selected text. Press play to continue the document.'
        : settings.onlyHighlights ? 'Reached the end of the highlighted text.' : 'Reached the end of the document.';
      savePosition();
    },

    cancelSpeech() {
      this.token++;
      neural.cancel();
      if (synth) { try { synth.cancel(); } catch { /* ignore */ } }
    },
  };

  const pagesOf = (s) => (s ? [s.page, ...(s.multi ? s.multi.keys() : [])] : []);
  function setSpeaking(s) {
    const prev = state.speaking;
    state.speaking = s;
    for (const n of new Set([...pagesOf(prev), ...pagesOf(s)])) { const p = state.pages[n - 1]; if (p?.rendered) applyHighlights(p); }
    el.nowLabel.textContent = player.queue ? 'Selection' : `Page ${s.page}`;
    el.nowText.textContent = s.text;
    updateProgressMeta();
    if (settings.follow) revealSentence(s);
    if (player.queue) return;
    if (transcriptPage !== s.page) renderTranscript(s.page);
    else markTranscriptCurrent(s);
  }

  function clearSpeaking() {
    const prev = state.speaking;
    state.speaking = null;
    for (const n of pagesOf(prev)) { const p = state.pages[n - 1]; if (p?.rendered) applyHighlights(p); }
    el.transcript.querySelector('p.is-current')?.classList.remove('is-current');
    el.transcript.querySelectorAll('mark').forEach((m) => m.replaceWith(m.textContent));
  }

  function revealSentence(s) {
    const p = state.pages[s.page - 1];
    if (!p || !p.vp) return;
    const item = p.items[s.itemIdxs[0]];
    let y = 0;
    if (item) {
      const [, py] = p.vp.convertToViewportPoint(item.transform[4], item.transform[5]);
      y = py;
    }
    const absY = p.el.offsetTop + y;
    const top = el.viewer.scrollTop, h = el.viewer.clientHeight;
    if (absY < top + h * 0.15 || absY > top + h * 0.8) {
      el.viewer.scrollTo({ top: absY - h * 0.35, behavior: reducedMotion ? 'auto' : 'smooth' });
    }
  }

  function updateTransport() {
    const playing = player.status === 'playing';
    el.app.dataset.playing = playing;
    el.btnPlay.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (player.status === 'paused') el.nowLabel.textContent = 'Paused';
  }

  function updateProgressMeta() {
    if (player.queue) {
      el.transportPage.textContent = 'Selection';
      el.transportProgress.textContent = state.speaking ? `${state.speaking.i + 1} of ${player.queue.length}` : '';
      return;
    }
    const s = state.speaking || (player.cursor && { page: player.cursor.page, i: player.cursor.i });
    if (!s) { el.transportPage.textContent = ''; el.transportProgress.textContent = ''; return; }
    el.transportPage.textContent = `Page ${s.page} of ${state.numPages}`;
    if (state.totalSentences) {
      const idx = state.sentenceOffsets[s.page - 1] + s.i;
      el.transportProgress.textContent = Math.round(100 * idx / state.totalSentences) + '%';
    }
  }

  function wordAt(text, charIndex, len) {
    if (charIndex == null || charIndex < 0 || charIndex >= text.length) return null;
    let start = charIndex;
    if (!len) while (start > 0 && !/\s/.test(text[start - 1])) start--;      // estimated positions land mid-word
    const end = len ? charIndex + len : text.slice(start).search(/\s|$/) + start;
    if (end <= start) return null;
    return { start, end };
  }

  function markWord(charIndex, len) {
    const s = state.speaking;
    if (!s) return;
    const w = wordAt(s.text, charIndex, len);
    const render = (node) => {
      if (!node) return;
      node.textContent = '';
      if (!w) { node.textContent = s.text; return; }
      const m = document.createElement('mark');
      m.textContent = s.text.slice(w.start, w.end);
      node.append(s.text.slice(0, w.start), m, s.text.slice(w.end));
    };
    render(el.nowText);
    render(el.transcript.querySelector('p.is-current'));
  }

  /* --- transcript (teleprompter) --- */

  let transcriptPage = 0;

  async function renderTranscript(n) {
    const p = state.pages[n - 1];
    if (!p) { el.transcript.innerHTML = ''; return; }
    await ensureText(p);
    if (state.pages[n - 1] !== p) return;
    transcriptPage = n;
    el.transcriptTitle.textContent = `Transcript · page ${n}`;
    el.transcript.innerHTML = '';
    if (!p.sentences.length) {
      const e = document.createElement('p'); e.className = 'transcript-empty';
      e.textContent = 'No readable text on this page.';
      el.transcript.append(e);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const s of p.sentences) {
      const para = document.createElement('p');
      para.textContent = s.text;
      para.dataset.i = s.i;
      if (isJunk(s.text) || s.footnote) { para.classList.add('is-junk'); para.title = s.footnote ? 'Footnote (skipped when Skip footnotes is on)' : 'Page number (skipped when Skip page numbers is on)'; }
      para.addEventListener('click', () => player.start({ page: n, i: s.i }));
      frag.append(para);
    }
    el.transcript.append(frag);
    if (state.speaking && state.speaking.page === n) markTranscriptCurrent(state.speaking);
    else el.transcript.scrollTop = 0;
  }

  function markTranscriptCurrent(s) {
    el.transcript.querySelector('p.is-current')?.classList.remove('is-current');
    const para = el.transcript.querySelector(`p[data-i="${s.i}"]`);
    if (!para) return;
    para.textContent = s.text;
    para.classList.add('is-current');
    const r = para.getBoundingClientRect(), box = el.transcript.getBoundingClientRect();
    if (r.top < box.top + 40 || r.bottom > box.bottom - 40) {
      el.transcript.scrollTop += r.top - box.top - box.height * 0.3;
    }
  }

  /* --- voices --- */

  const voiceLabel = (v) => `${v.name} · ${v.lang}${v.installed ? '' : ` · download, ~${v.mb} MB`}`;
  function loadVoices() {
    const sel = el.voiceSelect;
    sel.innerHTML = '';
    if (neural.available && neural.catalogue.length) {
      const g = document.createElement('optgroup'); g.label = 'Natural voices (offline)';
      for (const v of neural.catalogue) { const o = document.createElement('option'); o.value = 'piper:' + v.id; o.textContent = voiceLabel(v); g.append(o); }
      sel.append(g);
    }
    const vs = synth ? synth.getVoices() : [];
    const lang = (navigator.language || 'en').toLowerCase();
    const score = (v) => (v.lang.toLowerCase() === lang ? 0 : v.lang.toLowerCase().startsWith(lang.slice(0, 2)) ? 1 : 2) + (v.localService ? 0 : 0.5);
    player.voices = vs.slice().sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
    if (player.voices.length) {
      const g = document.createElement('optgroup'); g.label = neural.available ? 'System voices' : 'Voices';
      for (const v of player.voices) {
        const o = document.createElement('option');
        o.value = v.name;
        o.textContent = `${v.name.replace(/^Microsoft |^Google /, '')} · ${v.lang}${v.localService ? '' : ' · online'}`;
        g.append(o);
      }
      sel.append(g);
    }
    if (!sel.options.length) sel.innerHTML = '<option value="">No voices found</option>';
    if (!settings.voice) {                       // first run: prefer an installed natural voice, else the system default
      const inst = neural.catalogue.find((v) => v.installed);
      settings.voice = inst ? 'piper:' + inst.id : (player.currentVoice()?.name || '');
    }
    sel.value = settings.voice;
    if (sel.value !== settings.voice) { settings.voice = player.currentVoice()?.name || ''; sel.value = settings.voice; }
    syncVoiceUi();
  }
  function syncVoiceUi() {
    const nid = player.neuralVoiceId();
    el.pitchField.hidden = !!nid;
    if (desktop && neural.available) el.voiceHint.textContent = nid ? 'Natural voice. Runs offline on this computer.' : 'Natural voices sound far less robotic. Pick one above; it downloads once, then works offline.';
    else if (desktop) el.voiceHint.textContent = 'The natural voice engine is missing from this install.';
    else el.voiceHint.textContent = 'For natural voices, use the desktop app.';
  }
  function setVoiceProgress(frac, text) {
    el.voiceProgress.hidden = false;
    el.voiceProgressBar.style.width = Math.round(frac * 100) + '%';
    el.voiceProgressText.textContent = text;
  }
  const restartNow = () => { if (player.status === 'playing') { player.cancelSpeech(); player.speak(); } };
  async function chooseVoice(value, previous) {
    if (!value.startsWith('piper:')) { settings.voice = value; saveSettings(); syncVoiceUi(); restartNow(); return; }
    const id = value.slice(6);
    const v = neural.catalogue.find((x) => x.id === id);
    if (!v) return;
    if (v.installed) { settings.voice = value; saveSettings(); syncVoiceUi(); restartNow(); return; }
    el.voiceSelect.disabled = true;
    setVoiceProgress(0, `Downloading ${v.name}…`);
    try {
      const r = await desktop.tts.download(id);
      if (!r?.ok) throw new Error(r?.error || 'download failed');
      v.installed = true;
      settings.voice = value; saveSettings();
      toast(`${v.name} is ready.`);
    } catch (err) {
      toast('Could not download the voice: ' + (err.message || err));
      settings.voice = previous;
    } finally {
      el.voiceSelect.disabled = false;
      el.voiceProgress.hidden = true;
      loadVoices();
      restartNow();
    }
  }
  if (synth) { synth.addEventListener('voiceschanged', loadVoices); setTimeout(loadVoices, 1500); }
  loadVoices();
  neural.init();

  /* ================= Search ================= */

  let searchTimer = 0;
  async function runSearch(q, jump = true) {
    q = q.trim();
    state.search = { q, hits: [], idx: -1 };
    if (!q) { refreshHighlightsAll(); el.searchCount.textContent = ''; el.searchCount.classList.remove('is-empty'); return; }
    el.searchCount.textContent = '…';
    await extractAll();
    if (state.search.q !== q) return;
    const needle = q.toLowerCase();
    const hits = [];
    for (const p of state.pages) {
      const hay = p.text.toLowerCase().replace(/\n/g, ' ');
      let pos = 0;
      while ((pos = hay.indexOf(needle, pos)) !== -1 && hits.length < 5000) {
        hits.push({ page: p.num, start: pos, end: pos + needle.length, itemIdxs: itemsInRange(p, pos, pos + needle.length) });
        pos += needle.length;
      }
    }
    state.search.hits = hits;
    if (!hits.length) { el.searchCount.textContent = 'No matches'; el.searchCount.classList.add('is-empty'); refreshHighlightsAll(); return; }
    el.searchCount.classList.remove('is-empty');
    let first = hits.findIndex((h) => h.page >= state.current);
    if (first < 0) first = 0;
    if (jump) goToHit(first); else { state.search.idx = first; updateSearchCount(); refreshHighlightsAll(); }
  }

  // Every occurrence of a phrase, with the text items it touches (used by edit.js for "redact every…").
  async function findText(q) {
    q = (q || '').trim();
    if (!q || !state.pdf) return [];
    await extractAll();
    const needle = q.toLowerCase();
    const hits = [];
    for (const p of state.pages) {
      const hay = p.text.toLowerCase().replace(/\n/g, ' ');
      let pos = 0;
      while ((pos = hay.indexOf(needle, pos)) !== -1 && hits.length < 20000) {
        hits.push({ page: p.num, start: pos, end: pos + needle.length, itemIdxs: itemsInRange(p, pos, pos + needle.length) });
        pos += needle.length;
      }
    }
    return hits;
  }

  function updateSearchCount() {
    const { hits, idx } = state.search;
    el.searchCount.textContent = hits.length ? `${idx + 1} of ${hits.length}` : '';
  }

  function goToHit(idx) {
    const { hits } = state.search;
    if (!hits.length) return;
    state.search.idx = (idx + hits.length) % hits.length;
    const hit = hits[state.search.idx];
    updateSearchCount();
    refreshHighlightsAll();
    const p = state.pages[hit.page - 1];
    const item = p.items[hit.itemIdxs[0]];
    let y = 0;
    if (item && p.vp) y = p.vp.convertToViewportPoint(item.transform[4], item.transform[5])[1];
    el.viewer.scrollTo({ top: p.el.offsetTop + y - el.viewer.clientHeight * 0.4, behavior: reducedMotion ? 'auto' : 'smooth' });
    setCurrent(hit.page);
  }

  el.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(el.searchInput.value), 350);
  });
  $('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.search.q !== el.searchInput.value.trim()) runSearch(el.searchInput.value);
    else goToHit(state.search.idx + 1);
  });
  el.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); goToHit(state.search.idx - 1); }
    if (e.key === 'Escape') { el.searchInput.value = ''; runSearch(''); el.viewer.focus(); }
  });
  $('searchNext').addEventListener('click', () => goToHit(state.search.idx + 1));
  $('searchPrev').addEventListener('click', () => goToHit(state.search.idx - 1));

  /* ================= Toolbar wiring ================= */

  const fromDesktop = (f) => openData(f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength), f.name, f.path || '');
  async function chooseFile() {
    if (desktop) {
      const f = await desktop.openDialog();
      if (f) fromDesktop(f);
    } else el.fileInput.click();
  }

  // Bytes to hand out for Save / Print: the original file with any pending edits applied.
  async function currentBytes() {
    if (api.exportBytes) {
      try { const b = await api.exportBytes(); if (b) return b; }
      catch (err) { console.error(err); toast('Could not apply the edits: ' + (err.message || err)); return null; }
    }
    return state.bytes;
  }
  $('btnOpen').addEventListener('click', chooseFile);
  $('btnOpenEmpty').addEventListener('click', chooseFile);
  el.fileInput.addEventListener('change', () => { openFile(el.fileInput.files[0]); el.fileInput.value = ''; });
  $('btnSample').addEventListener('click', () => openUrl('sample.pdf'));

  $('btnPrev').addEventListener('click', () => scrollToPage(state.current - 1));
  $('btnNext').addEventListener('click', () => scrollToPage(state.current + 1));
  el.pageInput.addEventListener('change', () => {
    const n = clamp(Number(el.pageInput.value) || 1, 1, state.numPages || 1);
    el.pageInput.value = n; scrollToPage(n); el.viewer.focus();
  });
  el.pageInput.addEventListener('focus', () => el.pageInput.select());

  $('btnZoomIn').addEventListener('click', () => zoomStep(1));
  $('btnZoomOut').addEventListener('click', () => zoomStep(-1));
  el.zoomSelect.addEventListener('change', () => setZoom(el.zoomSelect.value));
  $('btnRotate').addEventListener('click', () => {
    state.rotation = (state.rotation + 90) % 360;
    layout();
    buildThumbnails();
  });

  el.viewer.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !state.pdf) return;
    e.preventDefault();
    zoomStep(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  async function saveDocument() {
    if (!state.bytes) return false;
    const bytes = await currentBytes();
    if (!bytes) return false;
    if (desktop) {
      const r = await desktop.saveFile(state.name, bytes, state.path || '');
      if (r?.ok) { toast('Saved ' + r.path); api.emit('saved', r.path); }
      return !!r?.ok;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a'); a.href = url; a.download = state.name || 'document.pdf'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    api.emit('saved', state.name);
    return true;
  }
  $('btnDownload').addEventListener('click', saveDocument);

  /* --- export the text as Markdown --- */

  async function exportMarkdown() {
    if (!state.pdf) return null;
    await extractAll();
    const live = state.pages.filter((p) => !p.deleted);
    const fontSize = (it) => Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
    // body text size = the size that covers the median character
    const sizes = [];
    for (const p of live) for (const it of p.items) if (it.str.trim()) sizes.push({ s: fontSize(it), n: it.str.length });
    sizes.sort((a, b) => a.s - b.s);
    const total = sizes.reduce((a, x) => a + x.n, 0);
    let acc = 0, body = 10;
    for (const x of sizes) { acc += x.n; if (acc >= total / 2) { body = x.s; break; } }
    // running headers and footers: short blocks repeated on many pages
    const blockText = (raw) => cleanText(raw);
    const seen = new Map();
    for (const p of live) for (const raw of p.text.split(/\n\s*\n/)) { const t = blockText(raw); if (t && t.length < 70) seen.set(t, (seen.get(t) || 0) + 1); }
    const repeated = new Set([...seen].filter(([, n]) => live.length >= 3 && n >= Math.max(3, live.length * 0.5)).map(([t]) => t));
    const out = [];
    let haveTitle = false;
    for (const p of live) {
      let cursor = 0;
      for (const raw of p.text.split(/\n\s*\n/)) {
        const start = p.text.indexOf(raw, cursor); cursor = start + raw.length;
        const text = blockText(raw);
        if (!text || repeated.has(text) || isJunk(text)) continue;
        let size = body;
        for (let i = 0; i < p.items.length; i++) if (p.offsets[i] + p.items[i].str.length > start && p.items[i].str.trim()) { size = fontSize(p.items[i]); break; }
        const ratio = size / body;
        if (ratio >= 1.12 && text.length < 140 && !/[.,;:]$/.test(text)) {       // headings may end in ? or !
          const level = ratio >= 1.6 ? 1 : ratio >= 1.3 ? 2 : 3;
          if (level === 1) haveTitle = true;
          out.push('#'.repeat(level) + ' ' + text);
          continue;
        }
        const numbered = /^(\d{1,3})[.)]\s+(.+)$/s.exec(text);
        const bullet = /^[•\-–*]\s+(.+)$/s.exec(text);
        if (numbered) out.push(`${numbered[1]}. ${numbered[2]}`);
        else if (bullet) out.push(`- ${bullet[1]}`);
        else out.push(text);
      }
    }
    const heading = haveTitle ? '' : `# ${state.name.replace(/\.pdf$/i, '')}\n\n`;
    return heading + out.join('\n\n').replace(/\n{3,}/g, '\n\n') + '\n';
  }

  async function saveMarkdown() {
    if (!state.pdf) { toast('Open a PDF first.'); return; }
    const md = await exportMarkdown();
    if (md == null) return;
    if (!md.trim().replace(/^#.*$/m, '').trim()) { toast('This PDF has no readable text to export. It may be a scan.'); return; }
    const name = state.name.replace(/\.pdf$/i, '') + '.md';
    if (desktop) {
      const r = await desktop.saveFile(name, md, state.path ? state.path.replace(/\.pdf$/i, '.md') : '', 'markdown');
      if (r?.ok) toast('Saved ' + r.path);
      return;
    }
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  $('btnMarkdown').addEventListener('click', saveMarkdown);

  $('btnPrint').addEventListener('click', async () => {
    if (!state.bytes) return;
    const bytes = await currentBytes();
    if (!bytes) return;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none';
    frame.src = url;
    frame.onload = () => { try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch { toast('Printing is not available here. Save a copy and print it from your PDF app.'); } };
    document.body.append(frame);
    setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 120000);
  });

  $('btnFullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  });

  function setSidebar(on) {
    settings.sidebar = on; saveSettings();
    el.app.classList.toggle('hide-sidebar', !on);
    el.btnSidebar.setAttribute('aria-pressed', on);
    if (state.zoom === 'width' || state.zoom === 'page') layout();
  }
  function setReadPanel(on) {
    settings.readPanel = on; saveSettings();
    el.app.classList.toggle('hide-read', !on);
    el.btnReadPanel.setAttribute('aria-pressed', on);
    if (state.zoom === 'width' || state.zoom === 'page') layout();
  }
  el.btnSidebar.addEventListener('click', () => setSidebar(!settings.sidebar));
  el.btnReadPanel.addEventListener('click', () => setReadPanel(!settings.readPanel));
  $('btnReadClose').addEventListener('click', () => setReadPanel(false));
  setSidebar(settings.sidebar);
  setReadPanel(settings.readPanel);

  /* --- read panel controls --- */

  el.rate.value = settings.rate; el.pitch.value = settings.pitch;
  el.follow.checked = settings.follow; el.skipNumbers.checked = settings.skipNumbers; el.skipFootnotes.checked = settings.skipFootnotes;
  const fmtRate = () => { el.rateVal.textContent = Number(settings.rate).toFixed(2).replace(/0$/, '') + '×'; };
  const fmtPitch = () => { el.pitchVal.textContent = Number(settings.pitch).toFixed(2).replace(/0$/, ''); };
  fmtRate(); fmtPitch();

  // System voices need the utterance restarted to pick up a new rate or pitch; natural voices change live.
  const restartIfPlaying = () => { if (player.status === 'playing' && !player.neuralVoiceId()) { player.cancelSpeech(); player.speak(); } };
  el.rate.addEventListener('input', () => { settings.rate = Number(el.rate.value); fmtRate(); saveSettings(); neural.setRate(settings.rate); });
  el.rate.addEventListener('change', restartIfPlaying);
  el.pitch.addEventListener('input', () => { settings.pitch = Number(el.pitch.value); fmtPitch(); saveSettings(); });
  el.pitch.addEventListener('change', restartIfPlaying);
  el.voiceSelect.addEventListener('change', () => chooseVoice(el.voiceSelect.value, settings.voice));
  el.follow.addEventListener('change', () => { settings.follow = el.follow.checked; saveSettings(); if (settings.follow && state.speaking) revealSentence(state.speaking); });
  el.skipNumbers.addEventListener('change', () => { settings.skipNumbers = el.skipNumbers.checked; saveSettings(); });
  el.skipFootnotes.addEventListener('change', () => { settings.skipFootnotes = el.skipFootnotes.checked; saveSettings(); if (player.status === 'playing' && !player.queue) { player.cancelSpeech(); player.speak(); } });
  el.onlyHighlights.addEventListener('change', () => {
    if (el.onlyHighlights.checked && api.hasHighlights && !api.hasHighlights()) {
      el.onlyHighlights.checked = false;
      toast('Nothing is highlighted yet. Turn on Edit, choose Highlight, and mark some text first.');
      return;
    }
    settings.onlyHighlights = el.onlyHighlights.checked;
    if (player.status === 'playing' && !player.queue) { player.cancelSpeech(); player.speak(); }
  });
  $('btnReadPage').addEventListener('click', () => player.start({ page: state.current, i: 0 }));

  /* --- transport --- */

  el.btnPlay.addEventListener('click', () => player.toggle());
  $('btnStop').addEventListener('click', () => player.stop());
  $('btnNextSentence').addEventListener('click', () => { if (player.cursor) player.advance(1); else player.start({ page: state.current, i: 0 }); });
  $('btnPrevSentence').addEventListener('click', () => { if (player.cursor) player.advance(-1); });

  /* --- click a sentence on the page to read from it --- */

  el.pages.addEventListener('click', (e) => {
    if (api.editActive) return;                                 // edit tools own clicks on the page
    const span = e.target.closest('.textLayer span');
    if (!span) return;
    if (window.getSelection()?.toString()) return;          // the user was selecting text, not clicking
    const pageEl = span.closest('.page');
    const p = state.pages[Number(pageEl.dataset.page) - 1];
    const idx = Number(span.dataset.i);
    const off = p.offsets[idx];
    const s = p.sentences.find((x) => off >= x.start && off < x.end) || p.sentences.find((x) => x.itemIdxs.includes(idx));
    if (s) player.start({ page: p.num, i: s.i });
  });

  /* --- read just the selected text --- */

  function currentSelectionInfo() {
    if (api.editActive || !state.pdf) return null;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const near = (n) => (n.nodeType === 1 ? n : n.parentElement)?.closest('.textLayer span');
    const a = near(range.startContainer), b = near(range.endContainer);
    if (!a || !b) return null;
    const text = sel.toString().trim();
    if (text.length < 2) return null;
    const p1 = Number(a.closest('.page').dataset.page), p2 = Number(b.closest('.page').dataset.page);
    const pages = new Map();
    for (let n = Math.min(p1, p2); n <= Math.max(p1, p2); n++) {
      const p = state.pages[n - 1];
      if (!p?.spans.length) continue;
      const idxs = [];
      p.spans.forEach((sp, i) => { if (sp && p.items[i].str.trim() && range.intersectsNode(sp)) idxs.push(i); });
      if (idxs.length) pages.set(n, idxs);
    }
    if (!pages.size) return null;
    const rects = range.getClientRects();
    return { text, pages, rect: rects[rects.length - 1] || range.getBoundingClientRect() };
  }
  let selTimer = 0;
  function updateSelectionButton() {
    const info = currentSelectionInfo();
    if (!info) { el.readSelBtn.hidden = true; return; }
    const r = info.rect;
    el.readSelBtn.style.left = clamp(r.left + r.width / 2, 90, window.innerWidth - 90) + 'px';
    el.readSelBtn.style.top = Math.min(r.bottom + 8, window.innerHeight - 48) + 'px';
    el.readSelBtn.hidden = false;
  }
  document.addEventListener('selectionchange', () => { clearTimeout(selTimer); selTimer = setTimeout(updateSelectionButton, 150); });
  el.readSelBtn.addEventListener('mousedown', (e) => e.preventDefault());        // keep the selection alive through the click
  el.readSelBtn.addEventListener('click', () => player.playSelection());
  el.viewer.addEventListener('scroll', () => { if (!el.readSelBtn.hidden) updateSelectionButton(); }, { passive: true });

  /* --- keyboard --- */

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); el.searchInput.focus(); el.searchInput.select(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); chooseFile(); return; }
    if (isTyping()) return;
    if (!state.pdf) return;
    switch (e.key) {
      case ' ': e.preventDefault(); player.toggle(); break;
      case 'ArrowRight': e.preventDefault(); if (e.shiftKey) { if (player.cursor) player.advance(1); } else scrollToPage(state.current + 1); break;
      case 'ArrowLeft': e.preventDefault(); if (e.shiftKey) { if (player.cursor) player.advance(-1); } else scrollToPage(state.current - 1); break;
      case 'PageDown': e.preventDefault(); scrollToPage(state.current + 1); break;
      case 'PageUp': e.preventDefault(); scrollToPage(state.current - 1); break;
      case 'Home': e.preventDefault(); scrollToPage(1); break;
      case 'End': e.preventDefault(); scrollToPage(state.numPages); break;
      case '+': case '=': zoomStep(1); break;
      case '-': zoomStep(-1); break;
      case '0': setZoom('width'); break;
      case 'r': case 'R': $('btnRotate').click(); break;
      case 's': case 'S': setSidebar(!settings.sidebar); break;
      case 'f': case 'F': $('btnFullscreen').click(); break;
      case 'Escape': if (player.status !== 'idle') player.stop(); break;
      default: return;
    }
  });

  /* --- drag and drop --- */

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; el.app.classList.add('is-dragging'); } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; el.app.classList.remove('is-dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; el.app.classList.remove('is-dragging');
    const file = [...e.dataTransfer.files].find((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (file) openFile(file); else toast('Drop a PDF file.');
  });

  /* --- resize --- */

  let resizeTimer = 0;
  new ResizeObserver(() => {
    if (!state.pdf) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.zoom === 'width' || state.zoom === 'page') layout(); }, 120);
  }).observe(el.viewer);

  window.addEventListener('beforeunload', () => { savePosition(); if (synth) synth.cancel(); });

  /* ================= Startup ================= */

  const params = new URLSearchParams(location.search);
  if (desktop) {
    el.emptyNote.textContent = 'Or drop a file anywhere on this window, or right-click a PDF and choose Open with → Lectern.';
    desktop.onOpenFile(fromDesktop);
    desktop.getInitialFile().then((f) => { if (f) fromDesktop(f); });
  } else if (params.get('file')) {
    openUrl(params.get('file'));
  }

  Object.assign(api, { state, el, settings, store, toast, openData, scrollToPage, setCurrent, layout, buildThumbnails, renderThumb, ensureText, saveDocument, player, reducedMotion, isTyping, goToDest, selectSideTab, findText, currentBytes, exportMarkdown, desktop, reorderPages, rerenderPage, applyOcr, saveBytesAs, extractAll, segment, cleanText, isJunk });
  api.emit('ready', api);
})();

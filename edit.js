/* Lectern — Edit mode: comment, mark up, fill and sign.
   Marks live as an overlay in PDF user-space coordinates while you work, and are written into a
   real PDF with pdf-lib when you save. Comments are saved as genuine PDF annotations (so other
   readers show them); everything else is drawn into the page content. */
(() => {
  'use strict';
  const app = window.LecternApp;
  if (!app || !window.PDFLib) return;
  const { state, el, store } = app;
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';

  const COLORS = ['#f0b64a', '#e9475f', '#3f8cff', '#2fb36b', '#8a5cf6', '#1c1300'];
  const E = {
    active: false, tool: 'select',
    color: COLORS[0], width: 3, size: 14,
    annots: [], formValues: {}, widgets: new Map(),   // widgets: page -> [pdf.js widget annotations]
    tabs: [], tabsBaseline: '[]', tabPopup: null,      // binder tabs: [{id,label,color,page}], baseline = what the file already contains
    links: new Map(),                                  // page -> [pdf.js link annotations] for click-to-follow
    managedRefs: new Map(),                            // page -> Set(objectNumber) of imported comments we re-write
    selected: null, editingText: null, notePopup: null,
    undo: [], redo: [], dirty: false, savedAt: 0,
    signature: store.get('lectern:signature', null),
    draft: null,                                       // in-progress drawing { page, type, ... }
  };
  let uid = Date.now() % 100000;
  const nextId = () => 'a' + (uid++).toString(36);

  const ui = {
    bar: $('editbar'), btnEdit: $('btnEdit'), status: $('editStatus'), undo: $('btnUndo'), redo: $('btnRedo'),
    swatches: $('swatches'), width: $('strokeWidth'), size: $('fontSize'), widthField: $('widthField'), sizeField: $('sizeField'),
    sigModal: $('sigModal'), sigCanvas: $('sigCanvas'),
    redactField: $('redactField'), redactQuery: $('redactQuery'), redactAll: $('redactAll'),
  };
  const isRedactTool = (t) => t === 'mark-redact' || t === 'redact-area';

  /* ---------------- geometry helpers (PDF user space <-> page CSS pixels) ---------------- */

  const toPdf = (p, x, y) => p.vp.convertToPdfPoint(x, y);
  const toView = (p, x, y) => p.vp.convertToViewportPoint(x, y);
  const normRect = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  // PDF rect -> page-local CSS box {x,y,w,h}
  function rectToView(p, r) {
    const c1 = toView(p, r[0], r[1]), c2 = toView(p, r[2], r[3]);
    const n = normRect(c1, c2);
    return { x: n[0], y: n[1], w: n[2] - n[0], h: n[3] - n[1] };
  }
  function pagePoint(p, ev) {
    const r = p.el.getBoundingClientRect();
    return [ev.clientX - r.left, ev.clientY - r.top];
  }
  const pageOf = (node) => { const pe = node?.closest?.('.page'); return pe ? state.pages[Number(pe.dataset.page) - 1] : null; };
  const hexToRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
  // Total rotation the saved page will display with (intrinsic + user rotation), in degrees.
  const savedRotation = (p) => ((p.pdfPage.rotate || 0) + p.rot) % 360;

  /* ---------------- mode and tools ---------------- */

  function setActive(on) {
    if (!state.pdf && on) { app.toast('Open a PDF first.'); return; }
    E.active = on;
    ui.bar.hidden = !on;
    ui.btnEdit.setAttribute('aria-pressed', on);
    el.app.classList.toggle('editing', on);
    app.editActive = on;
    if (!on) { setTool('select'); clearSelection(); closeNotePopup(); finishTextEdit(); }
    else setTool(E.tool);
    if (state.zoom === 'width' || state.zoom === 'page') app.layout();
  }

  function setTool(tool) {
    if (tool === 'image' && !E.signature) { openSignaturePad(() => setTool('image')); return; }
    E.tool = tool;
    el.app.dataset.tool = tool;
    ui.bar.querySelectorAll('.tool').forEach((b) => b.setAttribute('aria-pressed', b.dataset.tool === tool));
    ui.widthField.hidden = !/^(ink|rect|ellipse|arrow)$/.test(tool) && !(E.selected && /^(ink|rect|ellipse|arrow)$/.test(byId(E.selected)?.type));
    ui.sizeField.hidden = tool !== 'text' && !(E.selected && byId(E.selected)?.type === 'text');
    ui.redactField.hidden = !isRedactTool(tool);
    if (tool !== 'select') { clearSelection(); closeNotePopup(); finishTextEdit(); closeTabPopup(); }
    if (tool.startsWith('mark-')) window.getSelection()?.removeAllRanges();
  }

  const byId = (id) => E.annots.find((a) => a.id === id);

  /* ---------------- history and dirty state ---------------- */

  function snapshot() {
    return JSON.stringify({ annots: E.annots, formValues: E.formValues, tabs: E.tabs, pages: state.pages.map((p) => [p.rot, p.deleted]) });
  }
  function restore(json) {
    const s = JSON.parse(json);
    E.annots = s.annots; E.formValues = s.formValues; E.tabs = s.tabs || [];
    closeTabPopup();
    let pagesChanged = false;
    state.pages.forEach((p, i) => { const [rot, del] = s.pages[i] || [0, false]; if (p.rot !== rot || p.deleted !== del) { p.rot = rot; p.deleted = del; pagesChanged = true; } });
    clearSelection(); closeNotePopup();
    if (pagesChanged) { app.layout(); app.buildThumbnails(); }
    renderAll(); renderAllForms();
  }
  function commit(mutate, { relayout = false } = {}) {
    E.undo.push(snapshot()); if (E.undo.length > 100) E.undo.shift();
    E.redo = [];
    mutate();
    if (relayout) { app.layout(); app.buildThumbnails(); }
    markDirty();
    renderAll();
  }
  function undo() { if (!E.undo.length) return; E.redo.push(snapshot()); restore(E.undo.pop()); markDirty(); }
  function redo() { if (!E.redo.length) return; E.undo.push(snapshot()); restore(E.redo.pop()); markDirty(); }

  const tabsChanged = () => JSON.stringify(E.tabs) !== E.tabsBaseline;
  const hasChanges = () => E.annots.length > 0 || Object.keys(E.formValues).length > 0 || state.pages.some((p) => p.rot || p.deleted) || [...E.managedRefs.values()].some((s) => s.size) || tabsChanged();
  function markDirty() {
    E.dirty = hasChanges();
    ui.undo.disabled = !E.undo.length; ui.redo.disabled = !E.redo.length;
    const n = E.annots.length + Object.keys(E.formValues).length + state.pages.filter((p) => p.rot || p.deleted).length + (tabsChanged() ? 1 : 0);
    ui.status.textContent = !E.dirty ? (E.savedAt ? 'Saved' : 'No changes') : `${n} edit${n === 1 ? '' : 's'} not saved`;
    ui.status.classList.toggle('is-dirty', E.dirty);
    persistDraft();
  }

  function persistDraft() {
    if (!state.docKey) return;
    const key = state.docKey + ':edits';
    if (!hasChanges()) { try { localStorage.removeItem(key); } catch { /* ignore */ } return; }
    try { localStorage.setItem(key, snapshot()); } catch { /* quota: edits still live in memory */ }
  }

  /* ---------------- rendering the overlay ---------------- */

  function renderAll() { for (const p of state.pages) if (p.rendered) renderPage(p); updateSelectionBox(); renderTabList(); }

  function renderPage(p) {
    if (!p.vp) return;
    const svg = p.annotSvg, html = p.editHtml;
    svg.setAttribute('width', p.vp.width); svg.setAttribute('height', p.vp.height);
    svg.setAttribute('viewBox', `0 0 ${p.vp.width} ${p.vp.height}`);
    html.style.width = p.vp.width + 'px'; html.style.height = p.vp.height + 'px';
    svg.textContent = '';
    for (const node of [...html.children]) if (!node.classList.contains('note-popup')) node.remove();
    for (const a of E.annots) if (a.page === p.num) drawAnnot(p, a, svg, html);
    if (E.draft && E.draft.page === p.num) drawAnnot(p, E.draft, svg, html, true);
    renderTabs(p);
  }

  /* ---------------- binder tabs: markers on the edge of every page ---------------- */

  const TAB_TOP = 40, TAB_GAP = 6, TAB_W = 20, TAB_W_ACTIVE = 28, TAB_FONT = 9, TAB_STRIP = 44;
  const tabById = (id) => E.tabs.find((t) => t.id === id);
  const liveTabs = () => E.tabs.filter((t) => state.pages[t.page - 1] && !state.pages[t.page - 1].deleted);
  function tabLayout(n, visualHeight) {
    const h = Math.max(18, Math.min(72, (visualHeight - TAB_TOP * 2 - TAB_GAP * (n - 1)) / n));
    return Array.from({ length: n }, (_, i) => ({ top: TAB_TOP + i * (h + TAB_GAP), h }));
  }
  const textColorFor = (hex) => { const [r, g, b] = hexToRgb(hex); return 0.299 * r + 0.587 * g + 0.114 * b > 0.6 ? [0.11, 0.08, 0] : [1, 1, 1]; };
  const rgbCss = ([r, g, b]) => `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;

  function tabsLayerFor(p) {
    let layer = p.el.querySelector('.tabs-layer');
    if (!layer) {
      layer = document.createElement('div'); layer.className = 'tabs-layer';
      layer.addEventListener('click', onTabsLayerClick);
      p.el.append(layer);
    }
    return layer;
  }

  function renderTabs(p) {
    const layer = tabsLayerFor(p);
    layer.textContent = '';
    if (!p.vp) return;
    const s = p.vp.scale, W = p.vp.width, H = p.vp.height;
    // Tabs that are already painted into the file sit under our overlay; blank them so moved or
    // removed tabs do not linger until the next save.
    let baseline = [];
    try { baseline = JSON.parse(E.tabsBaseline); } catch { baseline = []; }
    if (baseline.length) {
      const lay = tabLayout(baseline.length, H / s);
      const last = lay[lay.length - 1];
      const cover = document.createElement('div');
      cover.className = 'tabs-cover';
      cover.style.cssText = `left:${W - TAB_STRIP * s}px;top:${(TAB_TOP - 4) * s}px;width:${TAB_STRIP * s}px;height:${(last.top + last.h - TAB_TOP + 8) * s}px`;
      layer.append(cover);
    }
    // links already in the PDF (not ours) become clickable
    for (const a of E.links.get(p.num) || []) {
      const v = rectToView(p, a.rect);
      if (baseline.length && v.x >= W - TAB_STRIP * s) continue;          // that is one of our own saved tabs
      const d = document.createElement('div');
      d.className = 'pdf-link'; d.dataset.link = a.id;
      d.title = a.url || 'Go to page';
      d.style.cssText = `left:${v.x}px;top:${v.y}px;width:${v.w}px;height:${v.h}px`;
      layer.append(d);
    }
    const tabs = E.tabs;
    if (!tabs.length) return;
    const lay = tabLayout(tabs.length, H / s);
    tabs.forEach((t, i) => {
      const dead = !state.pages[t.page - 1] || state.pages[t.page - 1].deleted;
      const active = t.page === p.num;
      const w = (active ? TAB_W_ACTIVE : TAB_W) * s;
      const d = document.createElement('div');
      d.className = 'ptab' + (active ? ' is-current' : '') + (dead ? ' is-dead' : '');
      d.dataset.id = t.id; d.dataset.page = t.page;
      d.title = `${t.label} · page ${t.page}`;
      d.style.cssText = `left:${W - w}px;top:${lay[i].top * s}px;width:${w}px;height:${lay[i].h * s}px;background:${t.color};color:${rgbCss(textColorFor(t.color))};font-size:${TAB_FONT * s}px;padding:${4 * s}px 0`;
      d.textContent = t.label;
      layer.append(d);
    });
  }

  function onTabsLayerClick(e) {
    const tabEl = e.target.closest('.ptab');
    if (tabEl) {
      const t = tabById(tabEl.dataset.id); if (!t) return;
      if (E.active && E.tool === 'eraser') { deleteTab(t.id); return; }
      if (E.active && E.tool === 'select') { openTabPopup(t.id); return; }
      app.scrollToPage(t.page, true);
      return;
    }
    const linkEl = e.target.closest('.pdf-link');
    if (linkEl && !E.active) {
      const p = pageOf(linkEl);
      const a = (E.links.get(p?.num) || []).find((x) => x.id === linkEl.dataset.link);
      if (!a) return;
      const url = a.url || a.unsafeUrl;
      if (url) { if (/^https?:|^mailto:/i.test(url)) window.open(url, '_blank', 'noopener'); else app.toast('Blocked a link to ' + url); }
      else if (a.dest) app.goToDest(a.dest);
    }
  }

  function addTabForPage(page, withPopup = true) {
    if (!state.pdf) return;
    const t = { id: nextId(), label: `Page ${page}`, color: E.color, page };
    commit(() => E.tabs.push(t));
    if (!E.active) setActive(true);
    setTool('select');
    if (withPopup) openTabPopup(t.id);
    return t;
  }
  function deleteTab(id) { closeTabPopup(); commit(() => { E.tabs = E.tabs.filter((t) => t.id !== id); }); }
  function moveTab(id, dir) {
    const i = E.tabs.findIndex((t) => t.id === id), j = i + dir;
    if (i < 0 || j < 0 || j >= E.tabs.length) return;
    commit(() => { const [t] = E.tabs.splice(i, 1); E.tabs.splice(j, 0, t); });
  }

  function openTabPopup(id, attempt = 0) {
    closeTabPopup();
    const t = tabById(id); if (!t) return;
    const p = state.pages[state.current - 1];
    const host = p?.rendered && p.el.querySelector(`.ptab[data-id="${id}"]`) ? p : state.pages[t.page - 1];
    if (!host?.rendered) {
      // the page may still be re-rendering (for example right after Edit mode re-laid out the view)
      if (attempt === 0) app.scrollToPage(t.page);
      if (attempt < 12) setTimeout(() => openTabPopup(id, attempt + 1), 250);
      return;
    }
    const before = snapshot();
    const tabEl = host.el.querySelector(`.ptab[data-id="${id}"]`);
    const pop = document.createElement('div');
    pop.className = 'tab-popup';
    pop.style.left = Math.max(8, host.vp.width - TAB_W_ACTIVE * host.vp.scale - 262) + 'px';
    pop.style.top = Math.min(Math.max(8, tabEl ? tabEl.offsetTop : 40), Math.max(8, host.vp.height - 230)) + 'px';
    const lab = document.createElement('label'); lab.append('Label');
    const inp = document.createElement('input'); inp.type = 'text'; inp.maxLength = 40; inp.value = t.label; lab.append(inp);
    const sw = document.createElement('div'); sw.className = 'swatches';
    for (const c of COLORS) { const b = document.createElement('button'); b.type = 'button'; b.className = 'swatch'; b.style.background = c; b.setAttribute('aria-checked', c === t.color); b.title = c; b.addEventListener('click', () => { t.color = c; E.color = c; syncSwatches(); sw.querySelectorAll('.swatch').forEach((x) => x.setAttribute('aria-checked', x === b)); renderAll(); }); sw.append(b); }
    const pg = document.createElement('label'); pg.append('Goes to page');
    const pgIn = document.createElement('input'); pgIn.type = 'number'; pgIn.min = 1; pgIn.max = state.numPages; pgIn.value = t.page; pg.append(pgIn);
    const row = document.createElement('div'); row.className = 'tp-row';
    const del = document.createElement('button'); del.type = 'button'; del.className = 'tp-del'; del.textContent = 'Delete bookmark';
    const sp = document.createElement('span'); sp.className = 'spacer';
    const done = document.createElement('button'); done.type = 'button'; done.className = 'btn'; done.textContent = 'Done';
    row.append(del, sp, done);
    pop.append(lab, sw, pg, row);
    pop.addEventListener('pointerdown', (e) => e.stopPropagation());
    pop.addEventListener('click', (e) => e.stopPropagation());
    inp.addEventListener('input', () => { t.label = inp.value; for (const pp of state.pages) if (pp.rendered) renderTabs(pp); renderTabList(); });
    pgIn.addEventListener('change', () => { const n = Math.min(state.numPages, Math.max(1, Number(pgIn.value) || t.page)); pgIn.value = n; t.page = n; renderAll(); });
    const finish = () => { if (!t.label.trim()) t.label = `Page ${t.page}`; closeTabPopup(); if (snapshot() !== before) { E.undo.push(before); E.redo = []; markDirty(); } renderAll(); };
    done.addEventListener('click', finish);
    del.addEventListener('click', () => { E.tabPopup = null; pop.remove(); E.undo.push(before); E.redo = []; E.tabs = E.tabs.filter((x) => x.id !== id); markDirty(); renderAll(); });
    pop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); finish(); } e.stopPropagation(); });
    E.tabPopup = { el: pop, finish };
    host.el.append(pop);
    inp.focus(); inp.select();
  }
  function closeTabPopup() { if (!E.tabPopup) return; const tp = E.tabPopup; E.tabPopup = null; tp.el.remove(); }

  function renderTabList() {
    const pane = $('tabs'); if (!pane) return;
    pane.textContent = '';
    if (!state.pdf) { const e = document.createElement('p'); e.className = 'tabs-hint'; e.textContent = 'Open a document to add bookmarks.'; pane.append(e); return; }
    const add = document.createElement('button'); add.className = 'btn wide tabs-add'; add.textContent = `Add a bookmark for page ${state.current}`;
    add.addEventListener('click', () => addTabForPage(state.current, true));
    pane.append(add);
    if (!E.tabs.length) {
      const hint = document.createElement('p'); hint.className = 'tabs-hint';
      hint.textContent = 'Bookmarks sit on the right edge of every page, like index tabs in a binder, and jump to their page when clicked. They are saved into the PDF as clickable markers and as entries in the bookmark list, so they work in Adobe Reader and other apps too.';
      pane.append(hint);
      return;
    }
    E.tabs.forEach((t, i) => {
      const dead = !state.pages[t.page - 1] || state.pages[t.page - 1].deleted;
      const item = document.createElement('div');
      item.className = 'tab-item' + (t.page === state.current ? ' is-current' : '');
      item.dataset.id = t.id; item.tabIndex = 0; item.setAttribute('role', 'button');
      const chip = document.createElement('span'); chip.className = 'chip'; chip.style.background = t.color;
      const text = document.createElement('span');
      const label = document.createElement('span'); label.className = 'tab-label'; label.textContent = t.label;
      const page = document.createElement('span'); page.className = 'tab-page'; page.textContent = dead ? `page ${t.page} (removed)` : `page ${t.page}`;
      text.append(label, page);
      const actions = document.createElement('span'); actions.className = 'tab-actions';
      const mk = (icon, title, fn, disabled) => { const b = document.createElement('button'); b.type = 'button'; b.title = title; b.innerHTML = `<svg><use href="#${icon}"/></svg>`; b.disabled = !!disabled; b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
      actions.append(
        mk('i-arrow-up', 'Move up', () => moveTab(t.id, -1), i === 0),
        mk('i-arrow-down', 'Move down', () => moveTab(t.id, 1), i === E.tabs.length - 1),
        mk('i-edit', 'Rename or recolour', () => { if (!E.active) setActive(true); setTool('select'); app.scrollToPage(t.page); setTimeout(() => openTabPopup(t.id), 350); }),
        mk('i-trash', 'Delete bookmark', () => deleteTab(t.id)),
      );
      item.append(chip, text, actions);
      item.addEventListener('click', () => app.scrollToPage(t.page, true));
      item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); app.scrollToPage(t.page, true); } });
      pane.append(item);
    });
  }

  app.on('current-page', (n) => {
    document.querySelectorAll('.ptab').forEach((d) => d.classList.toggle('is-current', Number(d.dataset.page) === n));
    document.querySelectorAll('.tab-item').forEach((d) => { const t = tabById(d.dataset.id); d.classList.toggle('is-current', !!t && t.page === n); });
    const add = document.querySelector('.tabs-add'); if (add) add.textContent = `Add a bookmark for page ${n}`;
  });

  function drawAnnot(p, a, svg, html, isDraft = false) {
    const s = p.vp.scale;
    const mk = (tag, attrs) => { const n = document.createElementNS(SVG, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
    const group = (children) => { const g = mk('g', { 'data-id': a.id }); if (isDraft) g.setAttribute('opacity', '0.8'); children.forEach((c) => g.append(c)); svg.append(g); return g; };
    switch (a.type) {
      case 'redact': {
        group(a.rects.map((r) => { const v = rectToView(p, r); return mk('rect', { x: v.x, y: v.y, width: v.w, height: v.h, class: 'mark redact' }); }));
        break;
      }
      case 'highlight': case 'underline': case 'strike': {
        const kids = a.rects.map((r) => {
          let rr = r;
          if (a.type === 'underline') rr = [r[0], r[1], r[2], r[1] + 1.4];
          if (a.type === 'strike') { const m = (r[1] + r[3]) / 2; rr = [r[0], m - 0.8, r[2], m + 0.8]; }
          const v = rectToView(p, rr);
          return mk('rect', { x: v.x, y: v.y, width: v.w, height: v.h, fill: a.color, class: `mark mark-${a.type}` });
        });
        group(kids); break;
      }
      case 'ink': {
        const pts = a.points.map(([x, y]) => toView(p, x, y).map((n) => n.toFixed(1)).join(',')).join(' ');
        group([mk('polyline', { points: pts, class: 'hitarea' }), mk('polyline', { points: pts, class: 'shape', stroke: a.color, 'stroke-width': a.width * s })]);
        break;
      }
      case 'rect': { const v = rectToView(p, a.rect); group([mk('rect', { x: v.x, y: v.y, width: v.w, height: v.h, class: 'hitarea' }), mk('rect', { x: v.x, y: v.y, width: v.w, height: v.h, class: 'shape', stroke: a.color, 'stroke-width': a.width * s })]); break; }
      case 'ellipse': { const v = rectToView(p, a.rect); const e = { cx: v.x + v.w / 2, cy: v.y + v.h / 2, rx: v.w / 2, ry: v.h / 2 }; group([mk('ellipse', { ...e, class: 'hitarea' }), mk('ellipse', { ...e, class: 'shape', stroke: a.color, 'stroke-width': a.width * s })]); break; }
      case 'arrow': {
        const A = toView(p, a.from[0], a.from[1]), B = toView(p, a.to[0], a.to[1]);
        const kids = [mk('line', { x1: A[0], y1: A[1], x2: B[0], y2: B[1], class: 'hitarea' }), mk('line', { x1: A[0], y1: A[1], x2: B[0], y2: B[1], class: 'shape', stroke: a.color, 'stroke-width': a.width * s })];
        const ang = Math.atan2(B[1] - A[1], B[0] - A[0]), L = Math.max(8, a.width * s * 4);
        for (const d of [-1, 1]) {
          const t = ang + d * (Math.PI * 0.8);
          kids.push(mk('line', { x1: B[0], y1: B[1], x2: B[0] + L * Math.cos(t), y2: B[1] + L * Math.sin(t), class: 'shape', stroke: a.color, 'stroke-width': a.width * s }));
        }
        group(kids); break;
      }
      case 'text': {
        const v = rectToView(p, a.rect);
        const d = document.createElement('div');
        d.className = 'ann ann-text'; d.dataset.id = a.id;
        d.style.cssText = `left:${v.x}px;top:${v.y}px;width:${v.w}px;min-height:${v.h}px;font-size:${a.size * s}px;color:${a.color}`;
        d.textContent = a.text;
        if (E.editingText === a.id) { d.contentEditable = 'plaintext-only'; d.classList.add('is-editing'); }
        if (E.selected === a.id) d.classList.add('is-selected');
        html.append(d);
        if (E.editingText === a.id) { d.focus(); placeCaretEnd(d); }
        break;
      }
      case 'image': {
        const v = rectToView(p, a.rect);
        const img = document.createElement('img');
        img.className = 'ann ann-img'; img.dataset.id = a.id; img.draggable = false;
        img.style.cssText = `left:${v.x}px;top:${v.y}px;width:${v.w}px;height:${v.h}px`;
        img.src = a.src; img.alt = 'Signature';
        if (E.selected === a.id) img.classList.add('is-selected');
        html.append(img);
        break;
      }
      case 'note': {
        const [x, y] = toView(p, a.at[0], a.at[1]);
        const d = document.createElement('div');
        d.className = 'ann ann-note'; d.dataset.id = a.id; d.title = a.text || 'Comment';
        d.style.cssText = `left:${x}px;top:${y}px;background:${a.color}`;
        d.innerHTML = '<svg><use href="#i-note"/></svg>';
        if (E.selected === a.id) d.classList.add('is-selected');
        html.append(d);
        break;
      }
      default: break;
    }
  }

  function placeCaretEnd(node) {
    const r = document.createRange(); r.selectNodeContents(node); r.collapse(false);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  }

  /* ---------------- selection, move, resize, delete ---------------- */

  function select(id) {
    E.selected = id;
    const a = byId(id);
    if (a) { E.color = a.color || E.color; syncSwatches(); if (a.width) { E.width = a.width; ui.width.value = a.width; } if (a.size) { E.size = a.size; ui.size.value = a.size; } }
    ui.widthField.hidden = !(a && /^(ink|rect|ellipse|arrow)$/.test(a.type));
    ui.sizeField.hidden = !(a && a.type === 'text');
    renderAll();
  }
  function clearSelection() { if (E.selected) { E.selected = null; renderAll(); } }

  function annotBounds(a) {
    switch (a.type) {
      case 'highlight': case 'underline': case 'strike': case 'redact': return a.rects.reduce((b, r) => [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])], [Infinity, Infinity, -Infinity, -Infinity]);
      case 'ink': return a.points.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
      case 'arrow': return normRect(a.from, a.to);
      case 'note': return [a.at[0], a.at[1] - 20, a.at[0] + 20, a.at[1]];
      default: return a.rect;
    }
  }
  function translate(a, dx, dy) {
    const mv = (pt) => [pt[0] + dx, pt[1] + dy];
    if (a.rects) a.rects = a.rects.map((r) => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]);
    if (a.points) a.points = a.points.map(mv);
    if (a.from) { a.from = mv(a.from); a.to = mv(a.to); }
    if (a.at) a.at = mv(a.at);
    if (a.rect) a.rect = [a.rect[0] + dx, a.rect[1] + dy, a.rect[2] + dx, a.rect[3] + dy];
  }
  const resizable = (a) => /^(rect|ellipse|text|image)$/.test(a.type);

  function updateSelectionBox() {
    document.querySelectorAll('.ann-sel').forEach((n) => n.remove());
    const a = E.selected && byId(E.selected);
    if (!a || !E.active) return;
    const p = state.pages[a.page - 1];
    if (!p?.rendered) return;
    const v = rectToView(p, annotBounds(a));
    const pad = a.type === 'ink' || a.type === 'arrow' ? (a.width || 2) * p.vp.scale : 2;
    const box = document.createElement('div');
    box.className = 'ann-sel';
    box.style.cssText = `left:${v.x - pad}px;top:${v.y - pad}px;width:${v.w + pad * 2}px;height:${v.h + pad * 2}px`;
    const del = document.createElement('button'); del.className = 'sel-del'; del.title = 'Delete (Del)'; del.innerHTML = '<svg><use href="#i-trash"/></svg>';
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteSelected(); });
    box.append(del);
    if (resizable(a)) { const h = document.createElement('div'); h.className = 'handle'; h.dataset.handle = '1'; box.append(h); }
    box.addEventListener('pointerdown', (e) => startDrag(e, a, p, e.target.dataset.handle ? 'resize' : 'move'));
    box.addEventListener('dblclick', () => { if (a.type === 'text') beginTextEdit(a.id); if (a.type === 'note') openNotePopup(a.id); });
    p.editHtml.append(box);
  }

  function startDrag(e, a, p, mode) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const before = snapshot();
    const start = toPdf(p, ...pagePoint(p, e));
    const orig = JSON.parse(JSON.stringify(a));
    const bounds = annotBounds(orig);
    const anchorView = rectToView(p, bounds);                       // screen top-left stays fixed while resizing
    const anchorPdf = toPdf(p, anchorView.x, anchorView.y);
    let moved = false;
    const onMove = (ev) => {
      const cur = toPdf(p, ...pagePoint(p, ev));
      moved = true;
      const live = byId(a.id);
      Object.assign(live, JSON.parse(JSON.stringify(orig)));
      if (mode === 'move') translate(live, cur[0] - start[0], cur[1] - start[1]);
      else {
        const r = normRect(anchorPdf, cur);
        if (r[2] - r[0] > 4 && r[3] - r[1] > 4) live.rect = r;
      }
      renderPage(p); updateSelectionBox();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp);
      if (moved) { E.undo.push(before); E.redo = []; markDirty(); }
    };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
  }

  function deleteSelected() {
    const id = E.selected; if (!id) return;
    closeNotePopup();
    commit(() => { E.annots = E.annots.filter((a) => a.id !== id); E.selected = null; });
  }
  function deleteAnnot(id) { commit(() => { E.annots = E.annots.filter((a) => a.id !== id); if (E.selected === id) E.selected = null; }); }

  /* ---------------- text boxes ---------------- */

  function beginTextEdit(id) {
    finishTextEdit();
    E.editingText = id;
    renderAll();
  }
  function finishTextEdit() {
    const id = E.editingText; if (!id) return;
    const a = byId(id);
    const node = document.querySelector(`.ann-text[data-id="${id}"]`);
    E.editingText = null;
    if (!a) return;
    const text = (node?.innerText || '').replace(/\n$/, '');
    if (!text.trim()) { E.annots = E.annots.filter((x) => x.id !== id); if (E.selected === id) E.selected = null; markDirty(); renderAll(); return; }
    if (text !== a.text) { E.undo.push(snapshot()); E.redo = []; a.text = text; markDirty(); }
    // grow the box to fit what was typed
    if (node) { const p = state.pages[a.page - 1]; const h = node.scrollHeight / p.vp.scale; if (h > a.rect[3] - a.rect[1]) a.rect[1] = a.rect[3] - h; }
    renderAll();
  }
  document.addEventListener('focusout', (e) => { if (e.target.classList?.contains('ann-text') && e.target.dataset.id === E.editingText) setTimeout(() => { if (document.activeElement !== e.target) finishTextEdit(); }, 0); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && E.editingText) { e.preventDefault(); finishTextEdit(); }
  }, true);

  /* ---------------- comments (sticky notes) ---------------- */

  function openNotePopup(id) {
    closeNotePopup();
    const a = byId(id); if (!a) return;
    const p = state.pages[a.page - 1]; if (!p?.rendered) return;
    const [x, y] = toView(p, a.at[0], a.at[1]);
    const pop = document.createElement('div');
    pop.className = 'note-popup';
    pop.style.left = Math.min(x + 28, p.vp.width - 250) + 'px';
    pop.style.top = Math.max(0, y - 4) + 'px';
    const ta = document.createElement('textarea'); ta.placeholder = 'Write a comment'; ta.value = a.text || '';
    const row = document.createElement('div'); row.className = 'np-row';
    const who = document.createElement('span'); who.textContent = a.author ? a.author : 'Comment';
    const del = document.createElement('button'); del.className = 'np-del'; del.textContent = 'Delete';
    const done = document.createElement('button'); done.textContent = 'Done';
    row.append(who, del, done);
    pop.append(ta, row);
    pop.addEventListener('pointerdown', (e) => e.stopPropagation());
    const save = () => { const live = byId(id); if (live && ta.value !== (live.text || '')) { E.undo.push(snapshot()); E.redo = []; live.text = ta.value; markDirty(); } };
    ta.addEventListener('input', () => { const live = byId(id); if (live) { const node = document.querySelector(`.ann-note[data-id="${id}"]`); if (node) node.title = ta.value; } });
    done.addEventListener('click', () => { save(); closeNotePopup(); renderAll(); });
    del.addEventListener('click', () => { closeNotePopup(); deleteAnnot(id); });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') { save(); closeNotePopup(); } });
    E.notePopup = { el: pop, save };
    p.editHtml.append(pop);
    ta.focus();
  }
  function closeNotePopup() { if (!E.notePopup) return; E.notePopup.save(); E.notePopup.el.remove(); E.notePopup = null; }

  /* ---------------- pointer handling on pages ---------------- */

  el.pages.addEventListener('pointerdown', (e) => {
    if (!E.active || e.button !== 0) return;
    const p = pageOf(e.target); if (!p || !p.vp) return;
    const tool = E.tool;
    const annNode = e.target.closest('[data-id]');
    const id = annNode?.dataset.id;

    if (tool === 'eraser') { if (id && byId(id)) { e.preventDefault(); deleteAnnot(id); } return; }
    if (tool === 'tab') { e.preventDefault(); addTabForPage(p.num, true); return; }

    if (tool === 'select') {
      if (e.target.closest('.ann-sel, .note-popup, .form-layer')) return;
      if (id && byId(id)) {
        if (E.editingText === id) return;
        e.preventDefault();
        select(id);
        const a = byId(id);
        if (a.type === 'note') openNotePopup(id); else closeNotePopup();
        startDrag(e, a, p, 'move');
      } else if (!e.target.closest('.textLayer')) {
        finishTextEdit(); closeNotePopup(); clearSelection();
      }
      return;
    }
    if (tool.startsWith('mark-')) return;                 // native text selection; handled on mouseup

    e.preventDefault();
    finishTextEdit(); closeNotePopup();
    const [vx, vy] = pagePoint(p, e);
    const start = toPdf(p, vx, vy);

    if (tool === 'note') {
      const a = { id: nextId(), type: 'note', page: p.num, at: start, text: '', color: E.color };
      commit(() => E.annots.push(a));
      setTool('select'); select(a.id); openNotePopup(a.id);
      return;
    }
    if (tool === 'text') {
      const w = 220, h = E.size * 1.3;
      const a = { id: nextId(), type: 'text', page: p.num, rect: [start[0], start[1] - h, start[0] + w, start[1]], text: '', color: E.color, size: E.size };
      commit(() => E.annots.push(a));
      setTool('select'); E.selected = a.id; beginTextEdit(a.id);
      return;
    }
    if (tool === 'image') {
      const sig = E.signature; if (!sig) return;
      const w = 160, h = w * sig.h / sig.w;
      const a = { id: nextId(), type: 'image', page: p.num, rect: [start[0] - w / 2, start[1] - h / 2, start[0] + w / 2, start[1] + h / 2], src: sig.src };
      commit(() => E.annots.push(a));
      setTool('select'); select(a.id);
      return;
    }
    // drag-drawn shapes
    const draft = { id: nextId(), page: p.num, color: E.color, width: E.width };
    if (tool === 'ink') { draft.type = 'ink'; draft.points = [start]; }
    else if (tool === 'arrow') { draft.type = 'arrow'; draft.from = start; draft.to = start; }
    else if (tool === 'redact-area') { draft.type = 'redact'; draft.color = '#000000'; draft.rects = [[start[0], start[1], start[0], start[1]]]; }
    else { draft.type = tool; draft.rect = [start[0], start[1], start[0], start[1]]; }
    E.draft = draft;
    p.el.setPointerCapture?.(e.pointerId);
    const onMove = (ev) => {
      const cur = toPdf(p, ...pagePoint(p, ev));
      if (draft.type === 'ink') { const last = draft.points[draft.points.length - 1]; if (Math.hypot(cur[0] - last[0], cur[1] - last[1]) > 0.7) draft.points.push(cur); }
      else if (draft.type === 'arrow') draft.to = cur;
      else if (draft.type === 'redact') draft.rects = [normRect(start, cur)];
      else draft.rect = normRect(start, cur);
      renderPage(p);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp);
      E.draft = null;
      const box = draft.rect || (draft.rects && draft.rects[0]);
      const big = draft.type === 'ink' ? draft.points.length > 1 : draft.type === 'arrow' ? Math.hypot(draft.to[0] - draft.from[0], draft.to[1] - draft.from[1]) > 3 : (box[2] - box[0] > 3 && box[3] - box[1] > 3);
      if (big) { commit(() => E.annots.push(draft)); if (draft.type === 'redact') redactNotice(); } else renderPage(p);
    };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
  });

  el.pages.addEventListener('dblclick', (e) => {
    if (!E.active || E.tool !== 'select') return;
    const id = e.target.closest('[data-id]')?.dataset.id; const a = id && byId(id);
    if (a?.type === 'text') beginTextEdit(id);
  });

  // Text markup: apply to whatever the user just selected in the text layer.
  document.addEventListener('mouseup', () => {
    if (!E.active || !E.tool.startsWith('mark-')) return;
    setTimeout(applyMarkup, 0);
  });
  function applyMarkup() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!pageOf(range.startContainer.parentElement)) return;
    const type = E.tool.slice(5);
    const perPage = new Map();
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const p = state.pages.find((pg) => pg.rendered && (() => { const b = pg.el.getBoundingClientRect(); return cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom; })());
      if (!p) continue;
      const b = p.el.getBoundingClientRect();
      const c1 = toPdf(p, r.left - b.left, r.top - b.top), c2 = toPdf(p, r.right - b.left, r.bottom - b.top);
      const rect = normRect(c1, c2);
      if (type === 'redact') { rect[0] -= 1.5; rect[1] -= 1.5; rect[2] += 1.5; rect[3] += 1.5; }
      const list = perPage.get(p.num) || []; perPage.set(p.num, list);
      // merge with a rect on the same line to avoid seams between adjacent spans
      const same = list.find((q) => Math.abs(q[1] - rect[1]) < 1.5 && Math.abs(q[3] - rect[3]) < 1.5 && rect[0] <= q[2] + 2 && rect[2] >= q[0] - 2);
      if (same) { same[0] = Math.min(same[0], rect[0]); same[2] = Math.max(same[2], rect[2]); } else list.push(rect);
    }
    sel.removeAllRanges();
    if (!perPage.size) return;
    const color = type === 'redact' ? '#000000' : E.color;
    commit(() => { for (const [page, rects] of perPage) E.annots.push({ id: nextId(), type, page, rects, color }); });
    if (type === 'redact') redactNotice();
  }

  /* ---------------- redaction ---------------- */

  let redactNoticeShown = false;
  function redactNotice() {
    if (redactNoticeShown) return;
    redactNoticeShown = true;
    app.toast('Redactions are applied when you save: those pages become images so the hidden words cannot be recovered.');
  }

  const measureCanvas = document.createElement('canvas').getContext('2d');
  // Bounding box in PDF space of the characters [ls, le) of a text item, measured proportionally.
  function itemSliceBox(p, item, ls, le, pad = 0) {
    const [a, b, c, d, e, f] = item.transform;
    const h = Math.hypot(c, d) || item.height || 10, w = item.width;
    const style = p.styles[item.fontName] || {};
    measureCanvas.font = `${h}px ${style.fontFamily || 'sans-serif'}`;
    const full = measureCanvas.measureText(item.str).width || 1;
    const f0 = Math.max(0, measureCanvas.measureText(item.str.slice(0, ls)).width / full);
    const f1 = Math.min(1, measureCanvas.measureText(item.str.slice(0, le)).width / full);
    const alongLen = Math.hypot(a, b) || 1, upLen = Math.hypot(c, d) || 1;
    const along = [a / alongLen, b / alongLen], up = [c / upLen, d / upLen];
    const pt = (u, v) => [e + u * along[0] + v * up[0], f + u * along[1] + v * up[1]];
    const corners = [pt(w * f0 - pad, -0.26 * h - pad), pt(w * f1 + pad, -0.26 * h - pad), pt(w * f0 - pad, 0.95 * h + pad), pt(w * f1 + pad, 0.95 * h + pad)];
    return corners.reduce((r, [x, y]) => [Math.min(r[0], x), Math.min(r[1], y), Math.max(r[2], x), Math.max(r[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
  }

  async function redactEverywhere(q) {
    q = (q || '').trim();
    if (!q) { ui.redactQuery.focus(); return; }
    if (!state.pdf) return;
    ui.redactAll.disabled = true;
    try {
      const hits = await app.findText(q);
      if (!hits.length) { app.toast(`"${q}" was not found.`); return; }
      const perPage = new Map();
      for (const h of hits) {
        const p = state.pages[h.page - 1];
        for (const idx of h.itemIdxs) {
          const item = p.items[idx], off = p.offsets[idx];
          const ls = Math.max(0, h.start - off), le = Math.min(item.str.length, h.end - off);
          if (le <= ls) continue;
          (perPage.get(h.page) || perPage.set(h.page, []).get(h.page)).push(itemSliceBox(p, item, ls, le, 1.2));
        }
      }
      commit(() => { for (const [page, rects] of perPage) E.annots.push({ id: nextId(), type: 'redact', page, rects, color: '#000000', query: q }); });
      app.toast(`Marked ${hits.length} occurrence${hits.length === 1 ? '' : 's'} of "${q}" on ${perPage.size} page${perPage.size === 1 ? '' : 's'}. Check them, then save.`);
      redactNotice();
      const first = Math.min(...perPage.keys());
      if (!state.visible.has(first)) app.scrollToPage(first, true);
    } finally { ui.redactAll.disabled = false; }
  }
  ui.redactAll.addEventListener('click', () => redactEverywhere(ui.redactQuery.value));
  ui.redactQuery.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); redactEverywhere(ui.redactQuery.value); } });

  // Pages with redactions are re-rendered as images (black boxes burned in) so the text underneath is gone.
  // Text outside the boxes is written back invisibly, which keeps search and read-aloud working.
  async function rasterizeRedactions(doc, redactPages, L) {
    const mid = await doc.save();
    const pdfDoc = await pdfjsLib.getDocument({ data: mid.slice() }).promise;
    const out = await L.PDFDocument.load(mid, { ignoreEncryption: true, updateMetadata: false });
    const font = await out.embedFont(L.StandardFonts.Helvetica);
    const N = (k) => L.PDFName.of(k);
    const overlaps = (r, b) => r[0] < b[2] && r[2] > b[0] && r[1] < b[3] && r[3] > b[1];
    try {
      for (const p of redactPages) {
        const idx = p.num - 1;
        const old = out.getPage(idx);
        const pg = await pdfDoc.getPage(p.num);
        const base = pg.getViewport({ scale: 1, rotation: 0 });
        const scale = Math.min(220 / 72, 4000 / Math.max(base.width, base.height));
        const vp = pg.getViewport({ scale, rotation: 0 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        await pg.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
        const rects = E.annots.filter((a) => a.type === 'redact' && a.page === p.num).flatMap((a) => a.rects);
        ctx.fillStyle = '#000';
        for (const r of rects) {
          const [x1, y1, x2, y2] = vp.convertToViewportRectangle(r);
          ctx.fillRect(Math.floor(Math.min(x1, x2)) - 1, Math.floor(Math.min(y1, y2)) - 1, Math.ceil(Math.abs(x2 - x1)) + 2, Math.ceil(Math.abs(y2 - y1)) + 2);
        }
        const img = await out.embedJpg(canvas.toDataURL('image/jpeg', 0.88));
        canvas.width = 0; canvas.height = 0;
        const w = base.width, h = base.height;
        const fresh = out.insertPage(idx, [w, h]);
        fresh.setRotation(old.getRotation());
        fresh.drawImage(img, { x: 0, y: 0, width: w, height: h });
        // keep the comments (sticky notes) that were on this page
        const oldAnnots = old.node.Annots?.();
        if (oldAnnots) for (let i = 0; i < oldAnnots.size(); i++) { const ref = oldAnnots.get(i); const d = out.context.lookup(ref); if (d instanceof L.PDFDict && d.get(N('Subtype')) === N('Text')) fresh.node.addAnnot(ref); }
        // invisible text outside the boxes
        const tc = await pg.getTextContent();
        const fontKey = fresh.node.newFontDictionary('LecternF', font.ref);
        const ops = [L.pushGraphicsState(), L.beginText(), L.setTextRenderingMode(L.TextRenderingMode.Invisible), L.setFontAndSize(fontKey, 1)];
        const [ox, oy] = [base.viewBox[0], base.viewBox[1]];
        let kept = 0;
        const safeEncode = (s) => { try { return font.encodeText(s); } catch { try { return font.encodeText(s.replace(/[^\x20-\x7E -ÿ]/g, ' ')); } catch { return null; } } };
        for (const it of tc.items) {
          if (!it.str || !it.str.trim()) continue;
          const [a, b, c, d, e, f] = it.transform;
          const whole = itemSliceBox(p, it, 0, it.str.length, 0.5);
          // runs of characters that lie outside every redaction box; a whole item is the common case
          const runs = [];
          if (!rects.some((r) => overlaps(r, whole))) runs.push([0, it.str.length]);
          else {
            let start = -1;
            for (let k = 0; k <= it.str.length; k++) {
              const hidden = k === it.str.length || rects.some((r) => overlaps(r, itemSliceBox(p, it, k, k + 1, 0.3)));
              if (!hidden && start < 0) start = k;
              if (hidden && start >= 0) { runs.push([start, k]); start = -1; }
            }
          }
          const alongLen = Math.hypot(a, b) || 1;
          for (const [s0, s1] of runs) {
            const text = it.str.slice(s0, s1);
            if (!text.trim()) continue;
            const enc = safeEncode(text); if (!enc) continue;
            let dx = 0, dy = 0;
            if (s0 > 0) {   // shift the run along the baseline by the measured width of what precedes it
              const h = Math.hypot(c, d) || 10;
              measureCanvas.font = `${h}px ${(p.styles[it.fontName] || {}).fontFamily || 'sans-serif'}`;
              const full = measureCanvas.measureText(it.str).width || 1;
              const off = it.width * (measureCanvas.measureText(it.str.slice(0, s0)).width / full);
              dx = (a / alongLen) * off; dy = (b / alongLen) * off;
            }
            ops.push(L.setTextMatrix(a, b, c, d, e + dx - ox, f + dy - oy), L.showText(enc));
            kept++;
          }
        }
        ops.push(L.endText(), L.popGraphicsState());
        if (kept) fresh.pushOperators(...ops);
        out.removePage(idx + 1);
      }
    } finally { try { pdfDoc.destroy(); } catch { /* ignore */ } }
    return { doc: out, pages: out.getPages() };
  }

  /* ---------------- signature pad ---------------- */

  let sigDone = null;
  function openSignaturePad(onDone) {
    sigDone = onDone || null;
    const c = ui.sigCanvas, ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ui.sigModal.hidden = false;
    ui.sigModal.dataset.drawn = '';
  }
  (() => {
    const c = ui.sigCanvas, ctx = c.getContext('2d');
    let drawing = false, last = null;
    const pt = (e) => { const r = c.getBoundingClientRect(); return [(e.clientX - r.left) * c.width / r.width, (e.clientY - r.top) * c.height / r.height]; };
    c.addEventListener('pointerdown', (e) => { drawing = true; last = pt(e); c.setPointerCapture(e.pointerId); ui.sigModal.dataset.drawn = '1'; ctx.beginPath(); ctx.arc(last[0], last[1], 1.6, 0, Math.PI * 2); ctx.fillStyle = '#101418'; ctx.fill(); });
    c.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const cur = pt(e);
      ctx.strokeStyle = '#101418'; ctx.lineWidth = 3.2 + (e.pressure ? e.pressure * 2 : 0); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(cur[0], cur[1]); ctx.stroke();
      last = cur;
    });
    const stop = () => { drawing = false; };
    c.addEventListener('pointerup', stop); c.addEventListener('pointercancel', stop);
    $('sigClear').addEventListener('click', () => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ui.sigModal.dataset.drawn = ''; });
    $('sigCancel').addEventListener('click', () => { ui.sigModal.hidden = true; sigDone = null; });
    ui.sigModal.addEventListener('click', (e) => { if (e.target === ui.sigModal) { ui.sigModal.hidden = true; sigDone = null; } });
    $('sigUse').addEventListener('click', () => {
      if (!ui.sigModal.dataset.drawn) { app.toast('Draw your signature first.'); return; }
      // trim to the inked bounds and make the background transparent
      const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
      let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        const dark = d[i] < 200;
        if (dark) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); d[i + 3] = 255 - d[i]; }
        else d[i + 3] = 0;
        d[i] = 16; d[i + 1] = 20; d[i + 2] = 24;
      }
      const pad = 8, w = x1 - x0 + 1 + pad * 2, h = y1 - y0 + 1 + pad * 2;
      const out = document.createElement('canvas'); out.width = w; out.height = h;
      const octx = out.getContext('2d');
      octx.putImageData(img, pad - x0, pad - y0);
      E.signature = { src: out.toDataURL('image/png'), w, h };
      store.set('lectern:signature', E.signature);
      ui.sigModal.hidden = true;
      app.toast('Click on the page to place your signature.');
      const cb = sigDone; sigDone = null; if (cb) cb();
    });
  })();

  /* ---------------- form fields ---------------- */

  function renderForms(p) {
    const layer = p.formLayer;
    layer.textContent = '';
    const widgets = E.widgets.get(p.num);
    if (!widgets || !p.vp) return;
    layer.style.width = p.vp.width + 'px'; layer.style.height = p.vp.height + 'px';
    for (const w of widgets) {
      const v = rectToView(p, w.rect);
      let node;
      const name = w.fieldName;
      const val = (name in E.formValues) ? E.formValues[name] : initialValue(w);
      if (w.fieldType === 'Tx') {
        node = document.createElement(w.multiLine ? 'textarea' : 'input');
        if (!w.multiLine) node.type = 'text';
        node.value = val == null ? '' : String(val);
        node.style.fontSize = ((w.defaultAppearanceData?.fontSize || 0) ? w.defaultAppearanceData.fontSize * p.vp.scale : Math.max(8, v.h * 0.62)) + 'px';
        if (w.maxLen) node.maxLength = w.maxLen;
        node.addEventListener('input', () => setFormValue(name, node.value));
      } else if (w.fieldType === 'Btn' && w.checkBox) {
        node = document.createElement('input'); node.type = 'checkbox';
        node.checked = val === true || (typeof val === 'string' && val !== 'Off' && (val === w.exportValue || val === w.buttonValue));
        node.addEventListener('change', () => setFormValue(name, node.checked));
      } else if (w.fieldType === 'Btn' && w.radioButton) {
        node = document.createElement('input'); node.type = 'radio'; node.name = 'f_' + name;
        node.checked = val === w.buttonValue;
        node.addEventListener('change', () => { if (node.checked) setFormValue(name, w.buttonValue); });
      } else if (w.fieldType === 'Ch') {
        node = document.createElement('select');
        if (!w.combo && w.multiSelect) node.multiple = true;
        for (const o of w.options || []) { const op = document.createElement('option'); op.value = o.exportValue; op.textContent = o.displayValue; node.append(op); }
        const vals = Array.isArray(val) ? val : [val];
        for (const op of node.options) op.selected = vals.includes(op.value);
        node.style.fontSize = Math.max(8, v.h * 0.6) + 'px';
        node.addEventListener('change', () => setFormValue(name, node.multiple ? [...node.selectedOptions].map((o) => o.value) : node.value));
      } else continue;
      node.className = 'field';
      node.style.left = v.x + 'px'; node.style.top = v.y + 'px'; node.style.width = v.w + 'px'; node.style.height = v.h + 'px';
      if (w.readOnly) node.disabled = true;
      node.title = w.alternativeText || name;
      layer.append(node);
    }
  }
  function initialValue(w) {
    if (w.fieldType === 'Btn' && w.checkBox) return typeof w.fieldValue === 'string' && w.fieldValue !== 'Off';
    return w.fieldValue == null ? '' : w.fieldValue;
  }
  function setFormValue(name, value) {
    if (!(name in E.formValues)) { E.undo.push(snapshot()); E.redo = []; }
    E.formValues[name] = value;
    markDirty();
    for (const p of state.pages) if (p.rendered && (E.widgets.get(p.num) || []).some((w) => w.fieldName === name && (w.radioButton || w.checkBox))) renderForms(p);
  }
  function renderAllForms() { for (const p of state.pages) if (p.rendered) renderForms(p); }

  /* ---------------- importing what is already in the PDF ---------------- */

  async function importExisting() {
    const pdf = state.pdf;
    E.widgets = new Map(); E.managedRefs = new Map(); E.links = new Map();
    // Tabs saved by Lectern earlier are described in the document info, so they stay editable.
    const draftHadTabs = E.tabs.length > 0;
    pdf.getMetadata().then(({ info }) => {
      if (state.pdf !== pdf) return;
      let fileTabs = [];
      try { const raw = info?.Custom?.LecternTabs; if (raw) fileTabs = JSON.parse(raw); } catch { fileTabs = []; }
      if (!Array.isArray(fileTabs)) fileTabs = [];
      fileTabs = fileTabs.filter((t) => t && typeof t.label === 'string' && Number.isInteger(t.page)).map((t) => ({ id: String(t.id || nextId()), label: t.label.slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : COLORS[0], page: Math.min(Math.max(1, t.page), state.numPages) }));
      E.tabsBaseline = JSON.stringify(fileTabs);
      if (!draftHadTabs) E.tabs = fileTabs;
      markDirty(); renderAll();
    }).catch(() => {});
    const imported = [];
    const pages = state.pages.slice();
    let k = 0;
    const worker = async () => {
      for (;;) {
        const p = pages[k++]; if (!p || state.pdf !== pdf) return;
        let annots = [];
        try { annots = await p.pdfPage.getAnnotations({ intent: 'display' }); } catch { /* ignore */ }
        if (state.pdf !== pdf) return;
        const widgets = annots.filter((a) => a.subtype === 'Widget' && a.fieldName && !a.hidden);
        if (widgets.length) E.widgets.set(p.num, widgets);
        const links = annots.filter((a) => a.subtype === 'Link' && !a.hidden && (a.dest || a.url || a.unsafeUrl));
        if (links.length) E.links.set(p.num, links);
        for (const a of annots) {
          if (a.subtype !== 'Text' || a.hidden) continue;
          const m = /^(\d+)R/.exec(a.id || '');
          const text = a.contentsObj?.str ?? a.contents ?? '';
          const author = a.titleObj?.str ?? a.title ?? '';
          const color = a.color ? '#' + [...a.color].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('') : COLORS[0];
          imported.push({ id: nextId(), type: 'note', page: p.num, at: [a.rect[0], a.rect[3]], text, author, color, imported: true });
          if (m) { const set = E.managedRefs.get(p.num) || new Set(); set.add(Number(m[1])); E.managedRefs.set(p.num, set); }
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (state.pdf !== pdf) return;
    // only add comments that a restored draft did not already bring back
    if (!E.annots.some((a) => a.imported)) E.annots.push(...imported);
    renderAll(); renderAllForms();
  }

  /* ---------------- export with pdf-lib ---------------- */

  async function exportPdf() {
    const L = PDFLib;
    const doc = await L.PDFDocument.load(state.bytes, { ignoreEncryption: true, updateMetadata: false });
    const pages = doc.getPages();
    const font = await doc.embedFont(L.StandardFonts.Helvetica);
    const imageCache = new Map();

    // Form values
    const names = Object.keys(E.formValues);
    if (names.length) {
      try {
        const form = doc.getForm();
        for (const name of names) {
          const f = form.getFieldMaybe(name); if (!f) continue;
          const v = E.formValues[name];
          try {
            if (f instanceof L.PDFTextField) f.setText(v == null ? '' : String(v));
            else if (f instanceof L.PDFCheckBox) { if (v) f.check(); else f.uncheck(); }
            else if (f instanceof L.PDFRadioGroup) { if (v) f.select(String(v)); }
            else if (f instanceof L.PDFDropdown) f.select(Array.isArray(v) ? v : String(v));
            else if (f instanceof L.PDFOptionList) f.select(Array.isArray(v) ? v : [String(v)]);
          } catch (err) { console.warn('field', name, err); }
        }
        try { form.updateFieldAppearances(font); } catch (err) { console.warn(err); }
      } catch (err) { console.warn('form', err); }
    }

    for (const p of state.pages) {
      const page = pages[p.num - 1]; if (!page) continue;
      // Drop the comments we imported; they are re-added below in their current state.
      const managed = E.managedRefs.get(p.num);
      if (managed?.size) {
        const arr = page.node.Annots?.();
        if (arr) for (let i = arr.size() - 1; i >= 0; i--) { const ref = arr.get(i); if (ref instanceof L.PDFRef && managed.has(ref.objectNumber)) arr.remove(i); }
      }
      const rot = savedRotation(p);
      for (const a of E.annots) {
        if (a.page !== p.num) continue;
        const color = L.rgb(...hexToRgb(a.color || '#000000'));
        switch (a.type) {
          case 'highlight':
            for (const r of a.rects) page.drawRectangle({ x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1], color, opacity: 0.5, blendMode: L.BlendMode.Multiply });
            break;
          case 'underline':
            for (const r of a.rects) page.drawLine({ start: { x: r[0], y: r[1] + 0.7 }, end: { x: r[2], y: r[1] + 0.7 }, thickness: 1.4, color });
            break;
          case 'strike':
            for (const r of a.rects) { const m = (r[1] + r[3]) / 2; page.drawLine({ start: { x: r[0], y: m }, end: { x: r[2], y: m }, thickness: 1.6, color }); }
            break;
          case 'ink': {
            const [r, g, b] = hexToRgb(a.color);
            const ops = [L.pushGraphicsState(), L.setStrokingColor(L.rgb(r, g, b)), L.setLineWidth(a.width), L.setLineCap(L.LineCapStyle.Round), L.setLineJoin(L.LineJoinStyle.Round)];
            a.points.forEach(([x, y], i) => ops.push(i ? L.lineTo(x, y) : L.moveTo(x, y)));
            if (a.points.length === 1) ops.push(L.lineTo(a.points[0][0] + 0.1, a.points[0][1]));
            ops.push(L.stroke(), L.popGraphicsState());
            page.pushOperators(...ops);
            break;
          }
          case 'rect':
            page.drawRectangle({ x: a.rect[0], y: a.rect[1], width: a.rect[2] - a.rect[0], height: a.rect[3] - a.rect[1], borderColor: color, borderWidth: a.width });
            break;
          case 'ellipse':
            page.drawEllipse({ x: (a.rect[0] + a.rect[2]) / 2, y: (a.rect[1] + a.rect[3]) / 2, xScale: (a.rect[2] - a.rect[0]) / 2, yScale: (a.rect[3] - a.rect[1]) / 2, borderColor: color, borderWidth: a.width });
            break;
          case 'arrow': {
            page.drawLine({ start: { x: a.from[0], y: a.from[1] }, end: { x: a.to[0], y: a.to[1] }, thickness: a.width, color, lineCap: L.LineCapStyle.Round });
            const ang = Math.atan2(a.to[1] - a.from[1], a.to[0] - a.from[0]), len = Math.max(8, a.width * 4);
            for (const d of [-1, 1]) { const t = ang + d * Math.PI * 0.8; page.drawLine({ start: { x: a.to[0], y: a.to[1] }, end: { x: a.to[0] + len * Math.cos(t), y: a.to[1] + len * Math.sin(t) }, thickness: a.width, color, lineCap: L.LineCapStyle.Round }); }
            break;
          }
          case 'text': drawTextBox(page, a, font, color, rot, L); break;
          case 'image': {
            if (!imageCache.has(a.src)) imageCache.set(a.src, await doc.embedPng(a.src));
            const img = imageCache.get(a.src);
            const [x1, y1, x2, y2] = a.rect, w = x2 - x1, h = y2 - y1;
            const place = { 0: { x: x1, y: y1, width: w, height: h }, 90: { x: x2, y: y1, width: h, height: w }, 180: { x: x2, y: y2, width: w, height: h }, 270: { x: x1, y: y2, width: h, height: w } }[rot];
            page.drawImage(img, { ...place, rotate: L.degrees(rot) });
            break;
          }
          case 'note': {
            const [x, y] = a.at;
            const now = new Date();
            const pdfDate = `D:${now.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
            const dict = doc.context.obj({
              Type: 'Annot', Subtype: 'Text', Rect: [x, y - 20, x + 20, y],
              Contents: L.PDFHexString.fromText(a.text || ''), T: L.PDFHexString.fromText(a.author || 'Lectern'),
              Name: 'Comment', C: hexToRgb(a.color || COLORS[0]), F: 4, Open: false, M: L.PDFString.of(pdfDate), CreationDate: L.PDFString.of(pdfDate),
            });
            page.node.addAnnot(doc.context.register(dict));
            break;
          }
          default: break;                                   // 'redact' is handled by rasterizeRedactions
        }
      }
    }
    const redactPages = state.pages.filter((p) => !p.deleted && E.annots.some((a) => a.type === 'redact' && a.page === p.num));
    let outDoc = doc, outPages = pages;
    if (redactPages.length) ({ doc: outDoc, pages: outPages } = await rasterizeRedactions(doc, redactPages, L));
    await exportTabs(outDoc, outPages, L);
    for (const p of state.pages) {
      if (!p.rot || p.deleted) continue;
      const pg = outPages[p.num - 1];
      pg.setRotation(L.degrees(((pg.getRotation().angle || 0) + p.rot) % 360));
    }
    for (let i = state.pages.length - 1; i >= 0; i--) if (state.pages[i].deleted) outDoc.removePage(i);
    if (outDoc.getPageCount() === 0) throw new Error('every page was removed');
    return outDoc.save();
  }

  // Binder tabs: a Link annotation with its own appearance on every page (clickable in any reader),
  // matching bookmarks in the outline, and the definitions in the document info for later editing.
  async function exportTabs(doc, pages, L) {
    const N = (k) => L.PDFName.of(k);
    // remove whatever an earlier save of ours put there
    for (const page of pages) {
      const arr = page.node.Annots?.();
      if (!arr) continue;
      for (let i = arr.size() - 1; i >= 0; i--) {
        const d = doc.context.lookup(arr.get(i));
        if (d instanceof L.PDFDict && d.has(N('LecternTab'))) arr.remove(i);
      }
    }
    removeLecternBookmarks(doc, L);
    const tabs = liveTabs();
    let baselineCount = 0;
    try { baselineCount = JSON.parse(E.tabsBaseline).length; } catch { baselineCount = 0; }
    if (tabs.length) {
      const font = await doc.embedFont(L.StandardFonts.Helvetica);
      const visualToUser = (rot, pw, ph, vx, vy) => rot === 90 ? [vy, vx] : rot === 180 ? [pw - vx, vy] : rot === 270 ? [pw - vy, ph - vx] : [vx, ph - vy];
      const encode = (s) => { try { return font.encodeText(s); } catch { return font.encodeText(s.replace(/[^\x20-\x7E -ÿ]/g, '?')); } };
      const fitLabel = (label, maxW) => { let s = label; while (s && font.widthOfTextAtSize(s.replace(/[^\x20-\x7E -ÿ]/g, '?'), TAB_FONT) > maxW) s = s.slice(0, -1); return s === label ? s : s.slice(0, -1) + '…'.replace('…', '.'); };
      for (const p of state.pages) {
        if (p.deleted) continue;
        const page = pages[p.num - 1];
        const { width: pw, height: ph } = page.getSize();
        const rot = savedRotation(p);
        const vw = rot % 180 ? ph : pw, vh = rot % 180 ? pw : ph;
        const lay = tabLayout(tabs.length, vh);
        tabs.forEach((t, i) => {
          const active = t.page === p.num;
          const sw = active ? TAB_W_ACTIVE : TAB_W;
          const v2u = (vx, vy) => visualToUser(rot, pw, ph, vx, vy);
          const r = normRect(v2u(vw - sw, lay[i].top), v2u(vw, lay[i].top + lay[i].h));
          const fill = hexToRgb(t.color), tc = textColorFor(t.color);
          const label = fitLabel(t.label, lay[i].h - 10);
          const theta = ((rot - 90) * Math.PI) / 180;                   // text reads top to bottom on screen
          const [tx, ty] = v2u(vw - sw / 2 - TAB_FONT * 0.36, lay[i].top + 5);
          const ops = [
            L.pushGraphicsState(),
            L.setFillingColor(L.rgb(...fill)), L.rectangle(r[0], r[1], r[2] - r[0], r[3] - r[1]), L.fill(),
            L.beginText(), L.setFillingColor(L.rgb(...tc)), L.setFontAndSize('F1', TAB_FONT),
            L.setTextMatrix(Math.cos(theta), Math.sin(theta), -Math.sin(theta), Math.cos(theta), tx, ty),
            L.showText(encode(label)), L.endText(),
            L.popGraphicsState(),
          ];
          const ap = doc.context.formXObject(ops, { BBox: doc.context.obj(r), Resources: doc.context.obj({ Font: doc.context.obj({ F1: font.ref }) }) });
          const dict = doc.context.obj({
            Type: 'Annot', Subtype: 'Link', Rect: r, Border: [0, 0, 0], F: 4, LecternTab: true,
            Dest: [pages[t.page - 1].ref, 'Fit'], AP: { N: doc.context.register(ap) },
            Contents: L.PDFHexString.fromText(t.label),
          });
          page.node.addAnnot(doc.context.register(dict));
        });
      }
      addLecternBookmarks(doc, tabs.map((t) => ({ title: t.label, pageRef: pages[t.page - 1].ref })), L);
    }
    if (tabs.length || baselineCount) {
      let infoRef = doc.context.trailerInfo.Info;
      let info = infoRef ? doc.context.lookup(infoRef) : null;
      if (!(info instanceof L.PDFDict)) { info = doc.context.obj({}); doc.context.trailerInfo.Info = doc.context.register(info); }
      info.set(N('LecternTabs'), L.PDFHexString.fromText(JSON.stringify(tabs.map((t) => ({ id: t.id, label: t.label, color: t.color, page: t.page })))));
    }
  }

  function outlineRoot(doc, L, create) {
    const N = (k) => L.PDFName.of(k);
    let ref = doc.catalog.get(N('Outlines'));
    let dict = ref ? doc.context.lookup(ref) : null;
    if (!(dict instanceof L.PDFDict)) {
      if (!create) return null;
      dict = doc.context.obj({ Type: 'Outlines', Count: 0 });
      ref = doc.context.register(dict);
      doc.catalog.set(N('Outlines'), ref);
    }
    return { ref, dict };
  }
  function outlineCount(root, L) { const c = root.dict.get(L.PDFName.of('Count')); return c instanceof L.PDFNumber ? c.asNumber() : 0; }
  function removeLecternBookmarks(doc, L) {
    const root = outlineRoot(doc, L, false); if (!root) return;
    const N = (k) => L.PDFName.of(k);
    let prevRef = null, prev = null, curRef = root.dict.get(N('First')), removed = 0, guard = 0;
    while (curRef && guard++ < 10000) {
      const cur = doc.context.lookup(curRef);
      if (!(cur instanceof L.PDFDict)) break;
      const nextRef = cur.get(N('Next'));
      if (cur.has(N('LecternTab'))) {
        if (prev) { if (nextRef) prev.set(N('Next'), nextRef); else prev.delete(N('Next')); }
        else if (nextRef) root.dict.set(N('First'), nextRef); else root.dict.delete(N('First'));
        if (nextRef) { const nx = doc.context.lookup(nextRef); if (nx instanceof L.PDFDict) { if (prevRef) nx.set(N('Prev'), prevRef); else nx.delete(N('Prev')); } }
        else if (prevRef) root.dict.set(N('Last'), prevRef); else root.dict.delete(N('Last'));
        removed++;
      } else { prevRef = curRef; prev = cur; }
      curRef = nextRef;
    }
    if (removed) root.dict.set(N('Count'), L.PDFNumber.of(Math.max(0, outlineCount(root, L) - removed)));
  }
  function addLecternBookmarks(doc, items, L, managed = true) {
    const root = outlineRoot(doc, L, true);
    const N = (k) => L.PDFName.of(k);
    let lastRef = root.dict.get(N('Last')) || null;
    if (lastRef && !(doc.context.lookup(lastRef) instanceof L.PDFDict)) lastRef = null;
    for (const it of items) {
      const entry = { Title: L.PDFHexString.fromText(it.title), Parent: root.ref, Dest: [it.pageRef, 'Fit'] };
      if (managed) entry.LecternTab = true;              // managed entries are rewritten on every save
      const d = doc.context.obj(entry);
      const ref = doc.context.register(d);
      if (lastRef) { d.set(N('Prev'), lastRef); doc.context.lookup(lastRef).set(N('Next'), ref); }
      else root.dict.set(N('First'), ref);
      lastRef = ref;
    }
    root.dict.set(N('Last'), lastRef);
    root.dict.set(N('Count'), L.PDFNumber.of(outlineCount(root, L) + items.length));
  }

  // Draw a wrapped text box upright on screen regardless of the page's rotation.
  function drawTextBox(page, a, font, color, rot, L) {
    const [x1, y1, x2, y2] = a.rect;
    const size = a.size, lineH = size * 1.2, ascent = size * 0.92;
    const maxW = rot % 180 === 0 ? x2 - x1 : y2 - y1;
    const clean = (s) => { try { font.encodeText(s); return s; } catch { return s.replace(/[^\x20-\x7E -ÿ]/g, '?'); } };
    const lines = [];
    for (const para of (a.text || '').split('\n')) {
      let line = '';
      for (const word of para.split(' ')) {
        const test = line ? line + ' ' + word : word;
        if (font.widthOfTextAtSize(clean(test), size) <= maxW || !line) line = test; else { lines.push(line); line = word; }
      }
      lines.push(line);
    }
    // origin of the first baseline and the "down one line" step, per rotation
    const start = { 0: [x1, y2 - ascent], 90: [x1 + ascent, y1], 180: [x2, y1 + ascent], 270: [x2 - ascent, y2] }[rot];
    const down = { 0: [0, -lineH], 90: [lineH, 0], 180: [0, lineH], 270: [-lineH, 0] }[rot];
    lines.forEach((ln, i) => {
      page.drawText(clean(ln), { x: start[0] + down[0] * i, y: start[1] + down[1] * i, size, font, color, rotate: L.degrees(rot) });
    });
  }

  app.exportBytes = async () => (hasChanges() ? exportPdf() : null);

  // Used by the player's "read only highlighted text" option.
  app.hasHighlights = () => E.annots.some((a) => a.type === 'highlight');
  app.sentenceFilter = (s) => {
    const hl = E.annots.filter((a) => a.type === 'highlight' && a.page === s.page);
    if (!hl.length) return false;
    const p = state.pages[s.page - 1];
    if (!p) return false;
    for (const idx of s.itemIdxs) {
      const item = p.items[idx]; if (!item) continue;
      const box = itemSliceBox(p, item, 0, item.str.length, 0);
      // count the item as highlighted when a mark covers a meaningful part of it
      const h = box[3] - box[1];
      for (const a of hl) for (const r of a.rects) {
        const ox = Math.min(r[2], box[2]) - Math.max(r[0], box[0]);
        const oy = Math.min(r[3], box[3]) - Math.max(r[1], box[1]);
        if (ox > 2 && oy > h * 0.3) return true;
      }
    }
    return false;
  };

  /* ---------------- merge PDFs ---------------- */

  const mergeUi = { modal: $('mergeModal'), list: $('mergeList'), add: $('mergeAdd'), input: $('mergeInput'), cancel: $('mergeCancel'), go: $('mergeGo') };
  const merge = { files: [], busy: false };

  async function describePdf(entry) {
    try { entry.pages = (await PDFLib.PDFDocument.load(entry.bytes, { ignoreEncryption: true })).getPageCount(); }
    catch { entry.error = 'Cannot read this file'; }
  }
  async function openMergeDialog() {
    merge.files = [];
    if (state.pdf) {
      const bytes = await app.currentBytes();
      if (bytes) { const entry = { name: state.name, bytes, current: true }; await describePdf(entry); merge.files.push(entry); }
    }
    renderMergeList();
    mergeUi.modal.hidden = false;
    if (!merge.files.length) addMergeFiles();
  }
  function closeMergeDialog() { mergeUi.modal.hidden = true; merge.files = []; }
  async function addMergeFiles() {
    if (app.desktop?.openDialogMulti) {
      const picked = await app.desktop.openDialogMulti();
      if (picked) await addMergeEntries(picked.map((f) => ({ name: f.name, bytes: new Uint8Array(f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength)) })));
    } else mergeUi.input.click();
  }
  async function addMergeEntries(entries) {
    for (const e of entries) { await describePdf(e); merge.files.push(e); }
    renderMergeList();
  }
  function renderMergeList() {
    const ul = mergeUi.list;
    ul.textContent = '';
    merge.files.forEach((f, i) => {
      const li = document.createElement('li');
      const idx = document.createElement('span'); idx.className = 'm-index'; idx.textContent = i + 1;
      const name = document.createElement('span'); name.className = 'm-name'; name.textContent = f.name + (f.current ? ' (open now)' : '');
      const pages = document.createElement('span'); pages.className = 'm-pages' + (f.error ? ' is-error' : ''); pages.textContent = f.error || `${f.pages} page${f.pages === 1 ? '' : 's'}`;
      name.append(pages);
      const actions = document.createElement('span'); actions.className = 'm-actions';
      const mk = (icon, title, fn, disabled) => { const b = document.createElement('button'); b.type = 'button'; b.title = title; b.innerHTML = `<svg><use href="#${icon}"/></svg>`; b.disabled = !!disabled; b.addEventListener('click', fn); return b; };
      actions.append(
        mk('i-arrow-up', 'Move up', () => { [merge.files[i - 1], merge.files[i]] = [merge.files[i], merge.files[i - 1]]; renderMergeList(); }, i === 0),
        mk('i-arrow-down', 'Move down', () => { [merge.files[i + 1], merge.files[i]] = [merge.files[i], merge.files[i + 1]]; renderMergeList(); }, i === merge.files.length - 1),
        mk('i-trash', 'Remove from the list', () => { merge.files.splice(i, 1); renderMergeList(); }),
      );
      li.append(idx, name, document.createElement('span'), actions);
      ul.append(li);
    });
    const usable = merge.files.filter((f) => !f.error);
    mergeUi.go.disabled = merge.busy || usable.length < 2;
    mergeUi.go.textContent = merge.busy ? 'Merging…' : usable.length >= 2 ? `Merge ${usable.length} files and open` : 'Merge and open';
  }
  async function doMerge() {
    const files = merge.files.filter((f) => !f.error);
    if (files.length < 2 || merge.busy) return;
    merge.busy = true; renderMergeList();
    try {
      const L = PDFLib;
      const out = await L.PDFDocument.create();
      const marks = [];
      for (const f of files) {
        const src = await L.PDFDocument.load(f.bytes, { ignoreEncryption: true });
        const copied = await out.copyPages(src, src.getPageIndices());
        copied.forEach((pg) => out.addPage(pg));
        if (copied[0]) marks.push({ title: f.name.replace(/\.pdf$/i, ''), pageRef: copied[0].ref });
      }
      addLecternBookmarks(out, marks, L, false);
      out.setTitle(files.map((f) => f.name.replace(/\.pdf$/i, '')).join(' + '));
      const bytes = await out.save();
      const total = out.getPageCount();
      closeMergeDialog();
      await app.openData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), 'merged.pdf');
      app.toast(`Merged ${files.length} files into ${total} pages. Use Save PDF to keep the result.`);
    } catch (err) {
      console.error(err);
      app.toast('Could not merge: ' + (err.message || err));
    } finally { merge.busy = false; renderMergeList(); }
  }
  $('btnMerge').addEventListener('click', openMergeDialog);
  $('btnMergeEmpty').addEventListener('click', openMergeDialog);
  mergeUi.add.addEventListener('click', addMergeFiles);
  mergeUi.input.addEventListener('change', async () => {
    const entries = [];
    for (const file of mergeUi.input.files) entries.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    mergeUi.input.value = '';
    addMergeEntries(entries);
  });
  mergeUi.cancel.addEventListener('click', closeMergeDialog);
  mergeUi.go.addEventListener('click', doMerge);
  mergeUi.modal.addEventListener('click', (e) => { if (e.target === mergeUi.modal && !merge.busy) closeMergeDialog(); });
  // dropping PDFs onto the dialog adds them instead of opening them
  mergeUi.modal.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); mergeUi.modal.querySelector('.modal-card').classList.add('is-dropping'); });
  mergeUi.modal.addEventListener('dragleave', () => mergeUi.modal.querySelector('.modal-card').classList.remove('is-dropping'));
  mergeUi.modal.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopImmediatePropagation();
    mergeUi.modal.querySelector('.modal-card').classList.remove('is-dropping');
    const entries = [];
    for (const file of e.dataTransfer.files) if (/\.pdf$/i.test(file.name)) entries.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    if (entries.length) addMergeEntries(entries);
  }, true);

  /* ---------------- thumbnails: rotate and remove pages ---------------- */

  function decorateThumbs() {
    for (const p of state.pages) {
      const t = p.thumb; if (!t || t.querySelector('.thumb-actions')) continue;
      const box = document.createElement('span'); box.className = 'thumb-actions';
      const rot = document.createElement('button'); rot.type = 'button'; rot.title = 'Rotate this page'; rot.innerHTML = '<svg><use href="#i-rotate"/></svg>';
      const del = document.createElement('button'); del.type = 'button';
      const setDel = () => { del.title = p.deleted ? 'Restore this page' : 'Remove this page'; del.innerHTML = `<svg><use href="#${p.deleted ? 'i-restore' : 'i-trash'}"/></svg>`; };
      setDel();
      rot.addEventListener('click', (e) => { e.stopPropagation(); commit(() => { p.rot = (p.rot + 90) % 360; }, { relayout: true }); });
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!p.deleted && state.pages.filter((q) => !q.deleted).length <= 1) { app.toast('A PDF needs at least one page.'); return; }
        commit(() => { p.deleted = !p.deleted; }, { relayout: true });
        if (p.deleted) app.toast(`Page ${p.num} removed`, { label: 'Undo', run: undo });
      });
      box.append(rot, del);
      t.append(box);
    }
  }

  /* ---------------- toolbar wiring ---------------- */

  ui.btnEdit.addEventListener('click', () => setActive(!E.active));
  ui.bar.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  for (const c of COLORS) {
    const b = document.createElement('button'); b.className = 'swatch'; b.style.background = c; b.dataset.color = c; b.title = c; b.setAttribute('role', 'radio');
    b.addEventListener('click', () => { E.color = c; syncSwatches(); const a = E.selected && byId(E.selected); if (a && a.type !== 'image') commit(() => { a.color = c; }); });
    ui.swatches.append(b);
  }
  function syncSwatches() { ui.swatches.querySelectorAll('.swatch').forEach((b) => b.setAttribute('aria-checked', b.dataset.color === E.color)); }
  syncSwatches();
  ui.width.addEventListener('input', () => { E.width = Number(ui.width.value); });
  ui.width.addEventListener('change', () => { const a = E.selected && byId(E.selected); if (a && a.width) commit(() => { a.width = E.width; }); });
  ui.size.addEventListener('change', () => { E.size = Number(ui.size.value); const a = E.selected && byId(E.selected); if (a?.type === 'text') commit(() => { a.size = E.size; }); });
  ui.undo.addEventListener('click', undo);
  ui.redo.addEventListener('click', redo);
  $('btnSave').addEventListener('click', () => { finishTextEdit(); closeNotePopup(); app.saveDocument(); });

  app.on('saved', () => { E.savedAt = Date.now(); E.dirty = false; ui.status.textContent = 'Saved'; ui.status.classList.remove('is-dirty'); });

  document.addEventListener('keydown', (e) => {
    if (!state.pdf) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); finishTextEdit(); closeNotePopup(); app.saveDocument(); return; }
    if (app.isTyping()) return;
    if (e.key.toLowerCase() === 'e' && !mod) { setActive(!E.active); return; }
    if (!E.active) return;
    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if ((mod && e.key.toLowerCase() === 'y') || (mod && e.shiftKey && e.key.toLowerCase() === 'z')) { e.preventDefault(); redo(); return; }
    if (mod) return;
    switch (e.key) {
      case 'Delete': case 'Backspace': if (E.selected) { e.preventDefault(); deleteSelected(); } break;
      case 'Escape': if (E.selected || E.tool !== 'select') { e.preventDefault(); e.stopImmediatePropagation(); clearSelection(); closeNotePopup(); setTool('select'); } break;
      case 'v': case 'V': setTool('select'); break;
      case 'h': case 'H': setTool('mark-highlight'); break;
      case 'u': case 'U': setTool('mark-underline'); break;
      case 'x': case 'X': setTool('mark-redact'); break;
      case 'n': case 'N': setTool('note'); break;
      case 'b': case 'B': setTool('tab'); break;
      case 't': case 'T': setTool('text'); break;
      case 'd': case 'D': setTool('ink'); break;
      default: break;
    }
  }, true);

  window.addEventListener('beforeunload', (e) => { if (E.dirty) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------------- document lifecycle ---------------- */

  app.on('doc-open', () => {
    E.annots = []; E.formValues = {}; E.tabs = []; E.tabsBaseline = '[]'; E.undo = []; E.redo = []; E.selected = null; E.dirty = false; E.savedAt = 0; E.draft = null;
    const draft = store.get(state.docKey + ':edits', null);
    if (draft) {
      try {
        E.annots = draft.annots || []; E.formValues = draft.formValues || {}; E.tabs = draft.tabs || [];
        let relayout = false;
        state.pages.forEach((p, i) => { const [rot, del] = draft.pages?.[i] || [0, false]; if (rot || del) { p.rot = rot; p.deleted = del; relayout = true; } });
        if (relayout) { app.layout(); app.buildThumbnails(); }
        app.toast('Restored edits you had not saved', { label: 'Discard', run: () => { commit(() => { E.annots = []; E.formValues = {}; try { E.tabs = JSON.parse(E.tabsBaseline); } catch { E.tabs = []; } state.pages.forEach((p) => { p.rot = 0; p.deleted = false; }); }, { relayout: true }); } });
      } catch { E.annots = []; E.formValues = {}; }
    }
    markDirty();
    importExisting();
    decorateThumbs();
    if (state.hasForms) app.toast('This PDF has form fields you can fill in.');
  });
  app.on('doc-close', () => { closeNotePopup(); closeTabPopup(); finishTextEdit(); E.annots = []; E.formValues = {}; E.tabs = []; E.tabsBaseline = '[]'; E.links = new Map(); E.widgets = new Map(); E.managedRefs = new Map(); E.selected = null; E.dirty = false; if (E.active) setActive(false); markDirty(); renderTabList(); });
  app.on('page-rendered', (p) => { renderPage(p); renderForms(p); updateSelectionBox(); });
  app.on('page-released', (p) => { p.annotSvg.textContent = ''; p.editHtml.textContent = ''; p.formLayer.textContent = ''; const tl = p.el.querySelector('.tabs-layer'); if (tl) tl.textContent = ''; });
  renderTabList();
  app.on('layout', () => { renderAll(); renderAllForms(); });
  app.on('thumbs-built', decorateThumbs);
})();

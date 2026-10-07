// Lectern — tab strip renderer. The main process owns the tab list; this page just draws it.
(() => {
  'use strict';
  const api = window.lecternTabs;
  const list = document.getElementById('tabs');
  let tabs = [];
  let dragId = null;

  function render() {
    list.textContent = '';
    for (const t of tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (t.active ? ' is-active' : '') + (t.dirty ? ' is-dirty' : '');
      el.dataset.id = t.id; el.setAttribute('role', 'tab'); el.setAttribute('aria-selected', String(t.active)); el.tabIndex = 0;
      el.title = t.title + (t.dirty ? ' (unsaved edits)' : '');
      el.draggable = true;
      const dot = document.createElement('span'); dot.className = 'dot';
      const title = document.createElement('span'); title.className = 'title'; title.textContent = t.title;
      const close = document.createElement('button'); close.className = 'close'; close.type = 'button'; close.textContent = '×'; close.title = 'Close tab (Ctrl+W)'; close.setAttribute('aria-label', `Close ${t.title}`);
      close.addEventListener('click', (e) => { e.stopPropagation(); api.close(t.id); });
      el.append(dot, title, close);
      el.addEventListener('click', () => api.activate(t.id));
      el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); api.close(t.id); } });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); api.activate(t.id); } if (e.key === 'Delete') api.close(t.id); });
      el.addEventListener('dragstart', (e) => { dragId = t.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(t.id)); el.classList.add('is-dragging'); });
      el.addEventListener('dragend', () => { el.classList.remove('is-dragging'); list.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after')); dragId = null; });
      el.addEventListener('dragover', (e) => { if (dragId == null || dragId === t.id) return; e.preventDefault(); const r = el.getBoundingClientRect(); const after = e.clientX > r.left + r.width / 2; el.classList.toggle('drop-after', after); el.classList.toggle('drop-before', !after); });
      el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        const after = el.classList.contains('drop-after');
        el.classList.remove('drop-before', 'drop-after');
        if (dragId == null || dragId === t.id) return;
        const ids = tabs.map((x) => x.id).filter((id) => id !== dragId);
        ids.splice(ids.indexOf(t.id) + (after ? 1 : 0), 0, dragId);
        api.reorder(ids);
      });
      list.append(el);
    }
    const active = list.querySelector('.is-active');
    if (active) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  api.onTabs((data) => { tabs = data.tabs || []; render(); });
  document.getElementById('newTab').addEventListener('click', () => api.newTab());
  document.getElementById('strip').addEventListener('dblclick', (e) => { if (e.target === e.currentTarget || e.target === list) api.newTab(); });
  api.ready();
})();

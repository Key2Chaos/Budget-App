// The picker: choose from a list, or type a new name to create one. Used to choose a group (for a
// payee, a payment or an import row) and a payee to merge. Opens as a second dialog over the sheet.
//
//   pick({ title, items: [{ id, label, sub?, section? }], suggested: [id], create: 'Group' | null, name })
//     → Promise of { id } | { create: 'typed name' } | null (cancelled)
//
// Typing filters the list. A name that matches an item exactly (ignoring case) picks that item
// rather than creating a second one with the same name.
import { state, esc } from './core.js';

let open = null; // the picker showing, if any

export function pick({ title, items, suggested = [], create = null, name = '', placeholder = 'Search or type a new name' }) {
  open?.finish(null);
  const dlg = document.createElement('dialog');
  dlg.id = 'picker';
  dlg.setAttribute('aria-label', title);
  document.body.append(dlg);
  const sugg = suggested.map(id => items.find(x => x.id === id)).filter(Boolean).slice(0, 3);
  let q = '';
  return new Promise(resolve => {
    const finish = v => {
      if (!dlg.isConnected) return;
      open = null;
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    open = { finish };
    const draw = () => {
      const t = q.trim().toLowerCase();
      const exact = t ? items.find(x => x.label.toLowerCase() === t) : null;
      const match = x => !t || x.label.toLowerCase().includes(t) || (x.sub || '').toLowerCase().includes(t);
      const shown = items.filter(match);
      const row = x => `<button type="button" class="row pick-row ${x === exact ? 'exact' : ''}" data-pick="${esc(x.id)}">
          <div class="row-main"><div class="row-title">${esc(x.label)}</div>${x.sub ? `<div class="row-sub">${esc(x.sub)}</div>` : ''}</div>
          ${x === exact ? '<span class="pill good">matches</span>' : ''}</button>`;
      const sections = [];
      const top = sugg.filter(match);
      if (top.length && !t) sections.push(['Suggested', top]);
      const rest = t ? shown : shown.filter(x => !top.includes(x));
      const bySection = new Map();
      for (const x of rest) {
        const s = x.section || 'All';
        if (!bySection.has(s)) bySection.set(s, []);
        bySection.get(s).push(x);
      }
      sections.push(...bySection);
      const newName = q.trim() || name;
      list.innerHTML = `
        ${create && newName && !exact ? `<section class="card list"><button type="button" class="row pick-row" data-create>
          <div class="row-main"><div class="row-title accent">+ Create “${esc(newName)}”</div>
          <div class="row-sub">A new ${esc(create.toLowerCase())}</div></div></button></section>` : ''}
        ${sections.map(([label, xs]) => `<div class="group-title">${esc(label)}</div>
          <section class="card list">${xs.map(row).join('')}</section>`).join('')}
        ${!shown.length && !(create && newName) ? '<p class="empty-small">Nothing matches.</p>' : ''}`;
    };
    dlg.innerHTML = `
      <div class="sheet-head">
        <button type="button" class="link" data-cancel>Cancel</button>
        <h2 tabindex="-1">${esc(title)}</h2>
        <span></span>
      </div>
      <div class="sheet-body">
        <input type="search" class="pick-search" placeholder="${esc(placeholder)}" autocomplete="off" enterkeyhint="done" aria-label="${esc(placeholder)}">
        <div class="pick-list"></div>
      </div>`;
    const input = dlg.querySelector('.pick-search');
    const list = dlg.querySelector('.pick-list');
    draw();
    input.addEventListener('input', () => { q = input.value; draw(); });
    input.addEventListener('keydown', ev => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const t = q.trim().toLowerCase();
      const exact = t && items.find(x => x.label.toLowerCase() === t);
      if (exact) finish({ id: exact.id });
      else if (create && q.trim()) finish({ create: q.trim() });
    });
    dlg.addEventListener('click', ev => {
      if (ev.target.closest('[data-cancel]')) return finish(null);
      const p = ev.target.closest('[data-pick]');
      if (p) return finish({ id: p.dataset.pick });
      if (ev.target.closest('[data-create]')) return finish({ create: q.trim() || name });
    });
    dlg.addEventListener('cancel', ev => { ev.preventDefault(); finish(null); });
    dlg.showModal();
    dlg.querySelector('h2').focus();
  });
}

/**
 * Choose a group, or type a name for a new one.
 *   type      — 'expense' | 'income': that type's groups come first; the other type's follow (as refunds).
 *   suggested — group ids to offer first (up to 3).
 *   exclude   — group ids not to offer (e.g. the one it's already in).
 *   name      — the name offered for a new group before anything is typed.
 *   create    — false to offer only existing groups (no "+ Create").
 */
export function pickGroup({ title = 'Choose a payee group', type = 'expense', suggested = [], exclude = [], name = '', create = true } = {}) {
  const other = type === 'income' ? 'expense' : 'income';
  const label = { expense: 'Expenses', income: 'Income' };
  const groups = state.entries.filter(e => !exclude.includes(e.id)).sort((a, b) => a.name.localeCompare(b.name));
  const items = [
    ...groups.filter(e => e.type === type).map(e => ({ id: e.id, label: e.name, sub: e.category || '', section: label[type] })),
    ...groups.filter(e => e.type === other).map(e => ({ id: e.id, label: e.name, sub: e.category || '',
      section: `${label[other]} (as a refund)` })),
  ];
  return pick({ title, items, suggested, create: create ? 'Payee group' : null, name, placeholder: create ? undefined : 'Search payee groups' });
}

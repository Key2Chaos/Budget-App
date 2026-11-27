// The "Tidy up groups" sheet (Settings → Bank statements): groups that look like the same thing
// twice, to merge in one tap, and categories for groups that have none yet.
import { db } from './db.js';
import * as C from './calc.js';
import * as Bank from './bank.js';
import { categoryOptions, state, $, esc, toast, saveSettings, sheet, closeSheet, keepToast } from './core.js';
import { mergeGroups } from './groups.js';
import { reload } from './render.js';
import { suggestCategory } from './importer.js';

const payeeKeys = e => [...new Set((e.payments || []).map(p => p.payee).filter(Boolean))];

/** Groups with no category that one can be suggested for: [{ e, category }]. */
export function suggestedCategories() {
  return state.entries.filter(e => !e.category && !e.catchAll)
    .map(e => ({ e, category: suggestCategory(e.name, e.type, payeeKeys(e)) }))
    .filter(x => x.category && categoryOptions(x.e.type).includes(x.category))
    .sort((a, b) => a.category.localeCompare(b.category) || a.e.name.localeCompare(b.e.name));
}

const describe = e => {
  const n = (e.payments || []).length;
  return `${n} payment${n === 1 ? '' : 's'} · ${C.FREQ[e.frequency]?.short || C.FREQ[e.frequency]?.label || ''}`;
};

export function openTidy() {
  const dupes = Bank.findDuplicateGroups(state.entries, state.settings.notSameGroups || []);
  const cats = suggestedCategories();
  const cluster = (d, i) => {
    const all = [d.keep, ...d.merge];
    return `<section class="card form tidy-dupe" data-dupe="${i}">
      <div class="tidy-names">${all.map(e => `<div><strong>${esc(e.name)}</strong> <span class="muted small-text">${esc(describe(e))}</span></div>`).join('')}</div>
      <label class="field"><span>Keep</span>
        <select data-keep="${i}" aria-label="Payee group to keep">${all.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</select></label>
      <div class="field tidy-btns">
        <button type="button" class="btn small" data-apart="${i}">Not the same</button>
        <button type="button" class="btn small on-btn" data-merge="${i}">Merge ${all.length === 2 ? 'both' : `all ${all.length}`}</button>
      </div>
    </section>`;
  };
  sheet.innerHTML = `
  <div id="tidy">
    <div class="sheet-head">
      <span></span>
      <h2 tabindex="-1" autofocus>Tidy up payee groups</h2>
      <button type="button" class="link strong" data-close>Done</button>
    </div>
    <div class="sheet-body">
      <div class="group-title">Possible duplicates (${dupes.length})</div>
      ${dupes.length ? `<p class="fine pad-x">These look like the same thing in more than one payee group. Merging moves their
        payments and payees into the group you keep, and removes the others.</p>
        ${dupes.map(cluster).join('')}`
        : '<p class="empty-small">No payee groups look like duplicates.</p>'}

      <div class="group-title">Suggested categories (${cats.length})</div>
      ${cats.length ? `<p class="fine pad-x">Payee groups with no category yet, and one that fits from their name or similar groups.
        Untick any that are wrong.</p>
        <section class="card list">${cats.map(({ e, category }) => `
          <label class="row static tidy-cat">
            <div class="row-main"><div class="row-title">${esc(e.name)}</div><div class="row-sub">${esc(category)}</div></div>
            <input type="checkbox" data-cat="${e.id}" data-category="${esc(category)}" checked aria-label="Set ${esc(e.name)} to ${esc(category)}">
          </label>`).join('')}</section>
        <button type="button" class="btn primary" data-set-cats>Set these categories</button>`
        : '<p class="empty-small">Nothing to suggest.</p>'}
    </div>
  </div>`;

  const root = $('#tidy');
  root.addEventListener('click', async ev => {
    const t = ev.target;
    if (t.closest('[data-close]')) return closeSheet();
    const m = t.closest('[data-merge]');
    if (m) {
      const d = dupes[Number(m.dataset.merge)];
      const all = [d.keep, ...d.merge];
      const keepId = root.querySelector(`[data-keep="${m.dataset.merge}"]`).value;
      let keep = all.find(e => e.id === keepId);
      for (const e of all) if (e !== keep) keep = await mergeGroups(state.entries.find(x => x.id === e.id) || e, keep);
      await reload();
      openTidy();
      toast(`Merged into ${keep.name}`);
      return;
    }
    const a = t.closest('[data-apart]');
    if (a) {
      const d = dupes[Number(a.dataset.apart)];
      const all = [d.keep, ...d.merge];
      const pairs = all.flatMap((x, i) => all.slice(i + 1).map(y => [x.id, y.id]));
      state.settings.notSameGroups = [...(state.settings.notSameGroups || []), ...pairs];
      await saveSettings();
      openTidy();
      toast('Kept apart');
      return;
    }
    if (t.closest('[data-set-cats]')) {
      const picked = [...root.querySelectorAll('[data-cat]:checked')];
      if (!picked.length) return;
      const now = new Date().toISOString();
      const byId = new Map(state.entries.map(e => [e.id, e]));
      await db.putEntries(picked.map(c => ({ ...byId.get(c.dataset.cat), category: c.dataset.category, updatedAt: now })));
      await reload();
      openTidy();
      toast(`${picked.length} categor${picked.length === 1 ? 'y' : 'ies'} set`);
    }
  });
  if (!sheet.open) { document.body.classList.add('modal-open'); sheet.showModal(); }
  keepToast();
}

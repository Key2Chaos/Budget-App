// The Payees page, on a computer (from the sidebar): every payee in a table you can search, filter
// and sort, with several put in a payee group (or ignored, or marked as transfers) at once.
// Clicking a payee opens the same sheet as Settings → Payees, to rename or merge it. A phone uses
// that sheet's list instead (js/sheet-payees.js).
import * as M from './model.js';
import { state, $, esc, money, fmtDate, toast, saveSettings, view, newGroup } from './core.js';
import { render, reload } from './render.js'; // a cycle, but only used once everything has loaded
import { pickGroup } from './picker.js';
import { openSheet } from './sheet-entry.js';
import { payeeList, payeeStatus, isUngrouped, openPayee } from './sheet-payees.js';
import { groupSuggestions, suggestCategory } from './importer.js';
import { movePayments, removeEmptyGroups, removedNote } from './groups.js';

export const freshPayeeView = () => ({ q: '', filter: 'all', sort: 'count', dir: -1, sel: new Set() });
state.payeeView = freshPayeeView();

const FILTERS = [['all', 'All'], ['ungrouped', 'Ungrouped'], ['rules', 'Ignored & transfers']];
const lc = s => String(s ?? '').toLowerCase();
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The payees on show: filtered, searched and sorted, each with what the table shows. */
export function payeeRows(pv = state.payeeView) {
  const all = payeeList().map(r => ({ ...r, title: M.payeeTitle(r.payee), where: payeeStatus(r) }));
  const q = lc(pv.q.trim());
  const shown = all.filter(r => (pv.filter === 'all' || (pv.filter === 'ungrouped' ? isUngrouped(r) : !!r.payee.rule))
    && (!q || [r.title, r.where, ...r.payee.keys].some(f => lc(f).includes(q))));
  const by = r => ({ name: lc(r.title), where: lc(r.where), count: r.pays.length, total: Math.abs(r.total), last: r.last })[pv.sort];
  shown.sort((a, b) => {
    const x = by(a), y = by(b);
    if (x === '' || y === '') return (x === '') - (y === ''); // never paid: last, whichever way
    return (typeof x === 'number' ? x - y : x.localeCompare(y)) * pv.dir || a.title.localeCompare(b.title);
  });
  const counts = { all: all.length, ungrouped: all.filter(isUngrouped).length, rules: all.filter(r => r.payee.rule).length };
  return { all, shown, counts };
}

export function renderPayeesPage() {
  const pv = state.payeeView;
  const { all, shown, counts } = payeeRows(pv);
  for (const id of [...pv.sel]) if (!shown.some(r => r.payee.id === id)) pv.sel.delete(id); // only what's on show
  const sel = shown.filter(r => pv.sel.has(r.payee.id));
  const th = (k, label, cls) => {
    const on = pv.sort === k;
    return `<th class="${cls}" aria-sort="${on ? (pv.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button"
      data-action="p-sort" data-key="${k}">${label}<span class="sort-ind" aria-hidden="true">${on ? (pv.dir > 0 ? '▲' : '▼') : ''}</span></button></th>`;
  };
  const group = r => state.entries.find(e => e.id === r.payee.groupId);
  const row = r => {
    const g = !r.payee.rule && group(r);
    const bank = r.payee.keys[0] || '';
    return `<tr class="${pv.sel.has(r.payee.id) ? 'sel' : ''}" data-action="p-open" data-id="${esc(r.payee.id)}">
      <td class="tx-check"><input type="checkbox" data-psel="${esc(r.payee.id)}" ${pv.sel.has(r.payee.id) ? 'checked' : ''} aria-label="Select ${esc(r.title)}"></td>
      <td class="p-name"><button type="button" class="g-open" data-action="p-open" data-id="${esc(r.payee.id)}">${esc(r.title)}</button>
        <span class="tx-note" title="${esc(r.payee.keys.join(' · '))}">${lc(bank) !== lc(r.title) ? esc(bank) : ''}${r.payee.keys.length > 1 ? `${lc(bank) !== lc(r.title) ? ' · ' : ''}${r.payee.keys.length} spellings` : ''}</span></td>
      <td class="p-where">${g ? `<button type="button" class="link small-link" data-action="p-group" data-id="${esc(g.id)}">${esc(g.name)}</button>`
        : `<span class="${r.payee.rule ? '' : 'p-loose'}">${esc(r.where)}</span>`}</td>
      <td class="p-count">${r.pays.length || '<span class="muted">—</span>'}</td>
      <td class="p-total ${r.total > 0 ? 'neg' : r.total < 0 ? 'pos' : ''}">${r.pays.length ? `${r.total > 0 ? '−' : r.total < 0 ? '+' : ''}${money(Math.abs(r.total))}` : '<span class="muted">—</span>'}</td>
      <td class="p-last">${r.last ? esc(fmtDate(r.last)) : '<span class="muted">—</span>'}</td>
    </tr>`;
  };

  view.innerHTML = `
    <div class="toolbar">
      <div class="seg p-seg">${FILTERS.map(([k, label]) =>
        `<button data-action="p-filter" data-filter="${k}" class="${pv.filter === k ? 'on' : ''}">${label} (${counts[k]})</button>`).join('')}</div>
      <input type="search" id="pSearch" placeholder="Search payees, the bank’s text and payee groups" value="${esc(pv.q)}" autocomplete="off">
    </div>
    ${sel.length ? `<div class="tx-bulk" role="region" aria-label="Selected payees">
      <span><strong>${sel.length}</strong> selected · ${plural(sel.reduce((n, r) => n + r.pays.length, 0), 'payment')}</span>
      <button type="button" class="btn small" data-action="p-put">Put in payee group…</button>
      <button type="button" class="btn small" data-action="p-rule" data-rule="ignore">Always ignore</button>
      <button type="button" class="btn small" data-action="p-rule" data-rule="transfer">Transfer</button>
      <button type="button" class="link small-link" data-action="p-select-none">Clear selection</button>
    </div>` : ''}
    ${shown.length ? `<section class="card tx-card"><table class="tx-table g-table p-table">
      <thead><tr>
        <th class="tx-check"><input type="checkbox" data-psel-all ${sel.length === shown.length ? 'checked' : ''} aria-label="Select all ${shown.length} payees shown"></th>
        ${th('name', 'Payee', 'p-name')}${th('where', 'Payee group', 'p-where')}${th('count', 'Payments', 'p-count')}${th('total', 'Total', 'p-total')}${th('last', 'Last paid', 'p-last')}
      </tr></thead>
      <tbody>${shown.map(row).join('')}</tbody>
    </table></section>`
    : `<p class="empty-small">${all.length ? 'No payees match.' : 'No payees yet. They’re added when you import a bank statement.'}</p>`}
    <p class="fine">A payee is who the bank says you paid, or were paid by. Click one to rename it or merge two spellings.
      Putting payees in a payee group moves their payments there, and future imports follow. <em>Always ignore</em> and
      <em>Transfer</em> apply to future imports; payments already logged stay where they are.</p>`;
}

// ---------- Events (wired up in app.js) ----------

export const payeeActions = {
  'p-sort': t => {
    const k = t.dataset.key, pv = state.payeeView;
    pv.dir = pv.sort === k ? -pv.dir : (k === 'name' || k === 'where' ? 1 : -1);
    pv.sort = k;
    renderPayeesPage();
  },
  'p-filter': t => { state.payeeView.filter = t.dataset.filter; state.payeeView.sel.clear(); renderPayeesPage(); },
  'p-open': t => openPayee(t.dataset.id),
  'p-group': t => { const e = state.entries.find(x => x.id === t.dataset.id); if (e) openSheet(e, 'accounts'); },
  'p-select-none': () => { state.payeeView.sel.clear(); renderPayeesPage(); },
  'p-put': () => putInGroup(),
  'p-rule': t => setRule(t.dataset.rule),
};

export function payeeInput(ev) {
  if (ev.target.id !== 'pSearch') return false;
  state.payeeView.q = ev.target.value;
  state.payeeView.sel.clear();
  const pos = ev.target.selectionStart;
  renderPayeesPage();
  const s = $('#pSearch'); s.focus(); s.setSelectionRange(pos, pos);
  return true;
}

export function payeeChange(ev) {
  const t = ev.target, pv = state.payeeView;
  if (t.matches('[data-psel]')) {
    if (t.checked) pv.sel.add(t.dataset.psel); else pv.sel.delete(t.dataset.psel);
  } else if (t.matches('[data-psel-all]')) {
    pv.sel = t.checked ? new Set(payeeRows().shown.map(r => r.payee.id)) : new Set();
  } else return false;
  renderPayeesPage();
  return true;
}
const selected = () => payeeRows().shown.filter(r => state.payeeView.sel.has(r.payee.id));

/** Put the selected payees in one payee group: their payments move there, and future imports follow. */
async function putInGroup() {
  const rows = selected();
  if (!rows.length) return;
  const total = rows.reduce((n, r) => n + r.total, 0);
  const type = total < 0 ? 'income' : 'expense';
  const name = rows.length === 1 ? rows[0].title : '';
  const choice = await pickGroup({ title: rows.length === 1 ? `Payee group for ${name}` : `Put ${rows.length} payees in`, type, name,
    suggested: groupSuggestions(name || rows[0].title, type) });
  if (!choice) return;
  const pays = rows.flatMap(r => r.pays);
  const start = pays.reduce((d, x) => (x.p.date < d ? x.p.date : d), pays[0]?.p.date || undefined);
  const dest = choice.create
    ? newGroup({ name: choice.create, type, start, category: suggestCategory(choice.create, type), fromImport: true })
    : state.entries.find(e => e.id === choice.id);
  if (!dest) return;
  const sources = [...new Set(rows.flatMap(r => [r.payee.groupId, ...r.pays.map(x => x.e.id)]))].filter(id => id && id !== dest.id);
  await movePayments(pays, dest);
  for (const r of rows) state.settings.payees = M.updatePayee(state.settings, r.payee.id, { groupId: dest.id });
  await saveSettings();
  state.payeeView.sel.clear();
  await reload();
  const removed = await removeEmptyGroups(sources);
  if (removed.length) render();
  toast(`${rows.length === 1 ? name : plural(rows.length, 'payee')} → ${dest.name}${pays.length ? ` · ${plural(pays.length, 'payment')} moved` : ''}${removedNote(removed)}`);
}

/** Set the selected payees to always ignore, or to transfers, on future imports. */
async function setRule(rule) {
  const rows = selected();
  if (!rows.length) return;
  for (const r of rows) state.settings.payees = M.updatePayee(state.settings, r.payee.id, { rule });
  await saveSettings();
  state.payeeView.sel.clear();
  render();
  toast(`${rows.length === 1 ? rows[0].title : plural(rows.length, 'payee')}: ${rule === 'ignore' ? 'always ignored' : 'transfers'} from the next import`);
}

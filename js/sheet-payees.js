// The Payees sheet (Settings → Payees): everyone you've paid or been paid by, from bank imports.
// Rename a payee, choose its group (its payments move there, and future imports follow), set it
// to always ignore or treat as a transfer, or merge two spellings of the same payee.
import { db } from './db.js';
import * as Bank from './bank.js';
import * as M from './model.js';
import { normalizeEntry } from './schema.js';
import { state, $, esc, uid, money, fmtDate, toast, saveSettings, sheet, closeSheet, newGroup, keepToast } from './core.js';
import { reload } from './render.js';
import { pick, pickGroup } from './picker.js';
import { payeeOfPayment } from './sheet-entry.js';
import { groupSuggestions, suggestCategory } from './importer.js';
import { movePayments, removeEmptyGroups, removedNote, homeGroup } from './groups.js';

let view = { q: '', filter: 'all' }; // the list's search and filter, kept while the sheet is open

/** Payees with their payments: [{ payee, pays: [{ p, e }], total, last }], from records and from payments. */
export function payeeList() {
  // Every payee key on an imported payment has a record; older data may have a few without
  const keys = state.entries.flatMap(e => (e.payments || []).map(payeeOfPayment)).filter(Boolean);
  const { payees, added } = M.withPayees(state.settings, keys, uid);
  if (added.length) state.settings.payees = payees; // saved with the next change
  const byKey = new Map();
  for (const p of payees) for (const k of p.keys) byKey.set(k, p);
  const out = new Map(payees.map(p => [p.id, { payee: p, pays: [], total: 0, last: '' }]));
  for (const e of state.entries) for (const p of e.payments || []) {
    const k = payeeOfPayment(p);
    const row = k && out.get(byKey.get(k)?.id);
    if (!row) continue;
    row.pays.push({ p, e });
    row.total += e.type === 'expense' ? p.amount : -p.amount;
    if (p.date > row.last) row.last = p.date;
  }
  return [...out.values()].sort((a, b) => b.pays.length - a.pays.length || M.payeeTitle(a.payee).localeCompare(M.payeeTitle(b.payee)));
}

const groupName = id => state.entries.find(e => e.id === id)?.name;
/** Where a payee's transactions go, in words. */
function status(row) {
  const p = row.payee;
  if (p.rule === 'ignore') return 'Always ignored';
  if (p.rule === 'transfer') return 'Transfer between your accounts';
  if (p.groupId && groupName(p.groupId)) return groupName(p.groupId);
  const where = [...new Set(row.pays.map(x => x.e.name))];
  return where.length ? `Ungrouped · in ${where.slice(0, 2).join(', ')}${where.length > 2 ? '…' : ''}` : 'Ungrouped';
}
const isUngrouped = row => !row.payee.rule && !(row.payee.groupId && groupName(row.payee.groupId));

export function openPayees() {
  const rows = payeeList();
  const q = view.q.trim().toLowerCase();
  const shown = rows.filter(r => (view.filter === 'all' || (view.filter === 'ungrouped' ? isUngrouped(r) : !!r.payee.rule))
    && (!q || M.payeeTitle(r.payee).toLowerCase().includes(q) || r.payee.keys.some(k => k.toLowerCase().includes(q))
      || (groupName(r.payee.groupId) || '').toLowerCase().includes(q)));
  const counts = { all: rows.length, ungrouped: rows.filter(isUngrouped).length, rules: rows.filter(r => r.payee.rule).length };
  sheet.innerHTML = `
  <div id="payees">
    <div class="sheet-head">
      <span></span>
      <h2 tabindex="-1" autofocus>Payees</h2>
      <button type="button" class="link strong" data-close>Done</button>
    </div>
    <div class="sheet-body">
      <input type="search" id="payeeSearch" placeholder="Search payees and groups" value="${esc(view.q)}" autocomplete="off" aria-label="Search payees">
      <div class="seg small grow payee-filter">
        ${[['all', 'All'], ['ungrouped', 'Ungrouped'], ['rules', 'Ignored & transfers']].map(([k, label]) =>
          `<button type="button" data-filter="${k}" class="${view.filter === k ? 'on' : ''}">${label} (${counts[k]})</button>`).join('')}
      </div>
      ${shown.length ? `<section class="card list">${shown.map(r => `
        <button type="button" class="row" data-payee="${esc(r.payee.id)}">
          <div class="row-main"><div class="row-title">${esc(M.payeeTitle(r.payee))}</div>
            <div class="row-sub">${esc(status(r))}${r.payee.keys.length > 1 ? ` · ${r.payee.keys.length} spellings` : ''}</div></div>
          <div class="row-amt">${r.pays.length ? money(Math.abs(r.total)) : ''}<small>${r.pays.length} payment${r.pays.length === 1 ? '' : 's'}</small></div>
        </button>`).join('')}</section>`
        : `<p class="empty-small">${rows.length ? 'No payees match.' : 'No payees yet. They’re added when you import a bank statement.'}</p>`}
      <p class="fine pad-x">A payee is who the bank says you paid, or were paid by. Put payees in a group to see one
        company together when it shows up on your statements in different ways or from different accounts.</p>
    </div>
  </div>`;
  const root = $('#payees');
  const search = $('#payeeSearch');
  search.addEventListener('input', () => {
    view.q = search.value;
    const pos = search.selectionStart;
    openPayees();
    const s = $('#payeeSearch'); s.focus(); s.setSelectionRange(pos, pos);
  });
  root.addEventListener('click', ev => {
    if (ev.target.closest('[data-close]')) { view = { q: '', filter: 'all' }; return closeSheet(); }
    const f = ev.target.closest('[data-filter]');
    if (f) { view.filter = f.dataset.filter; return openPayees(); }
    const p = ev.target.closest('[data-payee]');
    if (p) openPayee(p.dataset.payee);
  });
  if (!sheet.open) { document.body.classList.add('modal-open'); sheet.showModal(); }
  keepToast();
}

/** One payee: name, group, ignore / transfer, spellings and payments. */
export function openPayee(id) {
  const row = payeeList().find(r => r.payee.id === id);
  if (!row) return openPayees();
  const p = row.payee;
  const title = M.payeeTitle(p);
  const kind = p.rule || 'group';
  const g = p.groupId && state.entries.find(e => e.id === p.groupId);
  sheet.innerHTML = `
  <div id="payee">
    <div class="sheet-head">
      <button type="button" class="link" data-back>‹ Payees</button>
      <h2 tabindex="-1" autofocus>${esc(title)}</h2>
      <button type="button" class="link strong" data-close>Done</button>
    </div>
    <div class="sheet-body">
      <section class="card form">
        <label class="field"><span>Name</span>
          <input id="payeeName" value="${esc(p.name || '')}" placeholder="${esc(Bank.payeeName(p.keys[0]))}" autocomplete="off" aria-label="Your name for this payee"></label>
      </section>
      <p class="fine pad-x">Your name is used on imports and for matching. Leave it blank to use the bank's text.</p>

      <div class="seg payee-kind" role="radiogroup" aria-label="What this payee is">
        ${[['group', 'In a group'], ['ignore', 'Always ignore'], ['transfer', 'Transfer']].map(([k, label]) =>
          `<button type="button" role="radio" aria-checked="${kind === k}" data-kind="${k}" class="${kind === k ? 'on' : ''}">${label}</button>`).join('')}
      </div>
      ${kind === 'group' ? `<section class="card form">
        <div class="field"><span>Group</span>
          <span class="acct-val">${g ? esc(g.name) : '<span class="muted">Ungrouped</span>'}</span>
          <button type="button" class="btn small" data-choose-group aria-label="Choose a group for ${esc(title)}">${g ? 'Change…' : 'Choose…'}</button></div>
      </section>
      <p class="fine pad-x">Choosing a group moves this payee's payments there${row.pays.length ? ` (${row.pays.length})` : ''}, and future imports send them there too.
        ${g ? '<button type="button" class="link small-link" data-ungroup>Take out of this group</button>' : ''}</p>`
      : `<p class="fine pad-x">${kind === 'ignore' ? 'Their transactions are skipped on every import.'
        : 'Money between your own accounts isn’t spending or income, so their transactions aren’t logged.'} Payments already logged stay where they are.</p>`}

      <div class="group-title">Bank spellings (${p.keys.length})</div>
      <section class="card list">${p.keys.map(k => `<div class="row static"><div class="row-main"><div class="row-title">${esc(k)}</div></div></div>`).join('')}</section>
      <button type="button" class="link add-price" data-merge>+ Merge another payee into this one…</button>
      <p class="fine pad-x">Merge when the bank writes the same payee two ways. To keep them apart but see them together, put both in the same group.</p>

      ${row.pays.length ? `<div class="group-title">Payments (${row.pays.length})</div>
      <section class="card">${row.pays.sort((a, b) => b.p.date.localeCompare(a.p.date)).slice(0, 50).map(x => `<div class="imp-sub">
        <span class="imp-date">${esc(fmtDate(x.p.date))}</span><span class="imp-sub-desc">${esc(x.e.name)}${x.p.method ? ` <span class="muted">· ${esc(x.p.method)}</span>` : ''}</span>
        <span class="imp-amt">${money(x.p.amount)}</span></div>`).join('')}</section>` : ''}
    </div>
  </div>`;
  const root = $('#payee');
  const nameInput = $('#payeeName');
  nameInput.addEventListener('change', async () => {
    state.settings.payees = M.updatePayee(state.settings, id, { name: nameInput.value });
    await saveSettings();
    toast(nameInput.value.trim() ? `Named “${nameInput.value.trim()}”` : 'Name removed');
  });
  root.addEventListener('click', async ev => {
    if (ev.target.closest('[data-close]')) { view = { q: '', filter: 'all' }; return closeSheet(); }
    if (ev.target.closest('[data-back]')) return openPayees();
    const k = ev.target.closest('[data-kind]');
    if (k) {
      const rule = k.dataset.kind === 'group' ? null : k.dataset.kind;
      state.settings.payees = M.updatePayee(state.settings, id, { rule, ...(rule ? {} : { groupId: null }) });
      await saveSettings();
      return openPayee(id);
    }
    if (ev.target.closest('[data-choose-group]')) return chooseGroup(row);
    if (ev.target.closest('[data-ungroup]')) {
      state.settings.payees = M.updatePayee(state.settings, id, { groupId: null });
      await saveSettings();
      toast('Taken out of the group · its payments stay where they are');
      return openPayee(id);
    }
    if (ev.target.closest('[data-merge]')) return mergeInto(row);
  });
  if (!sheet.open) { document.body.classList.add('modal-open'); sheet.showModal(); }
  keepToast();
}

/** Choose a payee's group: its payments move there (from wherever they are), and so will future ones. */
async function chooseGroup(row) {
  const p = row.payee, title = M.payeeTitle(p);
  const type = row.pays.length && row.total < 0 ? 'income' : 'expense';
  const choice = await pickGroup({ title: `Group for ${title}`, type, name: title, exclude: p.groupId ? [p.groupId] : [],
    suggested: groupSuggestions(title, type, p.groupId ? [p.groupId] : []) });
  if (!choice) return;
  const now = new Date().toISOString();
  const start = row.pays.reduce((d, x) => (x.p.date < d ? x.p.date : d), row.pays[0]?.p.date || undefined);
  const dest = choice.create
    ? newGroup({ name: choice.create, type, start, category: suggestCategory(choice.create, type), fromImport: true })
    : state.entries.find(e => e.id === choice.id);
  if (!dest) return;
  const sources = [...new Set([p.groupId, ...row.pays.map(x => x.e.id)])].filter(Boolean);
  await movePayments(row.pays, dest, now);
  state.settings.payees = M.updatePayee(state.settings, p.id, { groupId: dest.id });
  await saveSettings();
  await reload();
  const removed = await removeEmptyGroups(sources);
  openPayee(p.id);
  toast(`${title} → ${dest.name}${row.pays.length ? ` · ${row.pays.length} payment${row.pays.length === 1 ? '' : 's'} moved` : ''}${removedNote(removed)}`);
}

/** Merge another payee into this one: one payee with both spellings. */
async function mergeInto(row) {
  const others = payeeList().filter(r => r.payee.id !== row.payee.id);
  const title = M.payeeTitle(row.payee);
  const choice = await pick({
    title: `Merge into ${title}`, placeholder: 'Search payees',
    items: others.map(r => ({ id: r.payee.id, label: M.payeeTitle(r.payee), sub: `${status(r)} · ${r.payee.keys.join(', ')}` })),
    suggested: others.filter(r => Bank.similarPayees(title, M.payeeTitle(r.payee))).map(r => r.payee.id),
  });
  if (!choice?.id) return;
  const from = others.find(r => r.payee.id === choice.id);
  const sources = [...new Set([row.payee.groupId, from.payee.groupId, ...row.pays.map(x => x.e.id), ...from.pays.map(x => x.e.id)])].filter(Boolean);
  state.settings.payees = M.mergePayees(state.settings, row.payee.id, choice.id);
  // One payee, one group: all their payments go to its group (or, if it has none, the group that
  // already has most of them), and the payee belongs there from now on
  const merged = M.payeeById(state.settings, row.payee.id);
  const all = [...row.pays, ...from.pays];
  const dest = homeGroup(merged, all);
  if (dest) {
    await movePayments(all, dest);
    if (!merged.rule) state.settings.payees = M.updatePayee(state.settings, merged.id, { groupId: dest.id });
  }
  await saveSettings();
  await reload();
  const removed = await removeEmptyGroups(sources);
  openPayee(row.payee.id);
  toast(`Merged ${M.payeeTitle(from.payee)} into ${title}${dest ? ` · all in ${dest.name}` : ''}${removedNote(removed)}`);
}

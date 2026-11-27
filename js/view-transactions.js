// The Transactions tab: every payment in every payee group in one table you can search, filter and
// sort, with several moved at once. The Overview opens it already filtered ("drill down"), and the
// "By payee group" panel shows how the Overview's figure for the same months is made up.
import * as C from './calc.js';
import * as M from './model.js';
import * as R from './reports.js';
import { state, $, esc, money, fmtDate, monthLong, monthYear, toast, tagFiltered, tagBar, view, newGroup } from './core.js';
import { accountOfPayment, openSheet } from './sheet-entry.js';
import { pickGroup } from './picker.js';
import { groupSuggestions, suggestCategory } from './importer.js';
import { movePayments, removeEmptyGroups, removedNote } from './groups.js';
import { render, reload } from './render.js'; // a cycle, but only used once everything has loaded

/** How many rows to draw before "Show more" (thousands of imported payments are fine to filter, slow to draw). */
const PAGE = 200;

export const PERIODS = [
  ['all', 'All time'], ['month', 'This month'], ['lastmonth', 'Last month'], ['3m', 'Last 3 months'],
  ['12m', 'Last 12 full months'], ['year', 'This year'], ['custom', 'Custom dates'],
];

/** The Sort menu (on a phone, where the table has no column headings to click): 'key:dir'. */
const SORTS = [['date:-1', 'Newest first'], ['date:1', 'Oldest first'], ['amount:-1', 'Biggest money in'],
  ['amount:1', 'Biggest money out'], ['payee:1', 'Payee A–Z'], ['group:1', 'Payee group A–Z']];

/** Filters as they are when the page is first opened. */
export const freshFilters = () => ({
  q: '', period: 'all', from: '', to: '', type: 'all', category: '', group: '', account: '', method: '',
  sort: 'date', dir: -1, sel: new Set(), limit: PAGE, origin: null, panelOpen: null, showFilters: false,
});
state.tx = freshFilters();

const lc = s => String(s ?? '').toLowerCase();
const ym = (y, m) => ({ y: new Date(y, m, 1).getFullYear(), m: new Date(y, m, 1).getMonth() });
const monthsFrom = (y, m, n) => Array.from({ length: n }, (_, i) => ym(y, m + i));

/**
 * The dates a period covers: { from, to, label, months } — months ([{ y, m }]) when it's whole
 * calendar months (so the Overview's figure for them can be shown), else null. from/to '' = open.
 */
export function periodRange(tx, now = new Date()) {
  const y = now.getFullYear(), m = now.getMonth();
  let months = null, label = '';
  const p = tx.period;
  if (p === 'month') months = [ym(y, m)];
  else if (p === 'lastmonth') months = [ym(y, m - 1)];
  else if (p === '3m') months = monthsFrom(y, m - 2, 3);
  else if (p === '12m') months = R.lastTwelveMonths(now);
  else if (p === 'year') months = monthsFrom(y, 0, m + 1);
  else if (/^m:\d{4}-\d{2}$/.test(p)) { const [yy, mm] = p.slice(2).split('-').map(Number); months = [ym(yy, mm - 1)]; }
  if (months) {
    const a = months[0], b = months.at(-1);
    const first = new Date(a.y, a.m, 1), last = new Date(b.y, b.m + 1, 0);
    label = months.length === 1 ? monthLong.format(first)
      : `${monthYear.format(first)} – ${monthYear.format(new Date(b.y, b.m, 1))}`;
    return { from: C.iso(first), to: C.iso(last), label, months };
  }
  if (p === 'custom') {
    label = tx.from && tx.to ? `${fmtDate(tx.from)} – ${fmtDate(tx.to)}` : tx.from ? `From ${fmtDate(tx.from)}` : tx.to ? `Up to ${fmtDate(tx.to)}` : 'All time';
    return { from: tx.from || '', to: tx.to || '', label, months: null };
  }
  return { from: '', to: '', label: 'All time', months: null };
}

const categoryOf = e => e.category || 'Other';
const sign = e => (e.type === 'income' ? 1 : -1);

/** Where a payment came from, as words. */
function accountLabel(p, e) {
  const a = accountOfPayment(p, e);
  return !a ? 'By hand' : a === 'unknown' ? 'Imported' : M.accountName(state.settings, a);
}

/** Every payment, with what the table shows: [{ key, p, e, date, payee, group, category, account, method, amount, mine }]. */
export function allRows(entries = tagFiltered()) {
  const out = [];
  for (const e of entries) for (const p of e.payments || []) {
    const amount = sign(e) * p.amount; // as the bank saw it: money out is −, a refund is +
    out.push({
      key: `${e.id}|${p.id}`, p, e, date: p.date,
      payee: p.payee ? M.keyTitle(state.settings, p.payee) : '',
      group: e.name, category: categoryOf(e), account: accountLabel(p, e),
      method: p.method || (p.source ? '' : e.method || ''),
      amount, mine: amount * C.shareOf(e),
    });
  }
  return out;
}

/** The payee-group filters (type, category, group), which the Overview's figures also respect. */
const groupMatches = (tx, e) => (tx.type === 'all' || e.type === tx.type)
  && (!tx.category || lc(categoryOf(e)) === lc(tx.category))
  && (!tx.group || e.id === tx.group);

/** A column's text as the table shows it (a payment logged by hand shows its group as the payee). */
const shown = (r, k) => (k === 'payee' ? r.payee || r.group : r[k]);

/** Rows passing every filter, sorted. */
export function filterRows(rows, tx, range) {
  const q = lc(tx.q.trim());
  const out = rows.filter(r => groupMatches(tx, r.e)
    && (!range.from || r.date >= range.from) && (!range.to || r.date <= range.to)
    && (!tx.account || r.account === tx.account)
    && (!tx.method || lc(r.method) === lc(tx.method))
    && (!q || [r.payee, r.group, r.category, r.account, r.method, r.p.note, Math.abs(r.amount).toFixed(2)].some(f => lc(f).includes(q))));
  const k = tx.sort, d = tx.dir;
  const cmp = k === 'amount' ? (a, b) => a.amount - b.amount
    : k === 'date' ? (a, b) => a.date.localeCompare(b.date)
    : (a, b) => lc(shown(a, k)).localeCompare(lc(shown(b, k)));
  return out.sort((a, b) => d * cmp(a, b) || d * a.date.localeCompare(b.date) || a.group.localeCompare(b.group));
}

/**
 * How each payee group adds up over the period: what's logged (in the rows shown) and, for whole
 * months, what the Overview counts — the payments, plus the schedule for any days they don't cover.
 * [{ e, logged, count, counted | null }], biggest first.
 */
export function groupBreakdown(entries, rows, tx, range, countable) {
  const by = new Map();
  for (const r of rows) {
    const g = by.get(r.e.id) || { e: r.e, logged: 0, count: 0, counted: null };
    g.logged += r.mine; g.count++;
    by.set(r.e.id, g);
  }
  if (countable && range.months) {
    for (const e of entries.filter(x => groupMatches(tx, x))) {
      const v = range.months.reduce((s, { y, m }) => s + C.monthAmount(e, y, m), 0);
      if (Math.abs(v) < 0.005 && !by.has(e.id)) continue;
      const g = by.get(e.id) || { e, logged: 0, count: 0, counted: null };
      g.counted = sign(e) * v;
      by.set(e.id, g);
    }
  }
  return [...by.values()].sort((a, b) => Math.abs(b.counted ?? b.logged) - Math.abs(a.counted ?? a.logged) || a.e.name.localeCompare(b.e.name));
}

const signedMoney = n => `${n < -0.0049 ? '−' : n > 0.0049 ? '+' : ''}${money(Math.abs(n))}`;
const cls = n => (n < 0 ? 'neg' : 'pos');
const options = (list, cur, all) => `<option value="">${all}</option>${list.map(v =>
  `<option value="${esc(v)}" ${lc(v) === lc(cur) ? 'selected' : ''}>${esc(v)}</option>`).join('')}`;
const uniqSorted = list => [...new Map(list.filter(Boolean).map(v => [lc(v), v])).values()].sort((a, b) => a.localeCompare(b));

export function renderTransactions() {
  const tx = state.tx;
  const entries = tagFiltered();
  const range = periodRange(tx);
  const all = allRows(entries);
  const rows = filterRows(all, tx, range);
  // The Overview's figures are per payee group, so they can't follow the account, method or search filters
  const countable = !tx.account && !tx.method && !tx.q.trim();
  const groups = groupBreakdown(entries, rows, tx, range, countable);
  for (const k of [...tx.sel]) if (!rows.some(r => r.key === k)) tx.sel.delete(k); // only what's on show

  const out = rows.filter(r => r.mine < 0).reduce((s, r) => s - r.mine, 0);
  const inn = rows.filter(r => r.mine > 0).reduce((s, r) => s + r.mine, 0);
  const shared = rows.some(r => C.shareOf(r.e) < 1);
  const sel = rows.filter(r => tx.sel.has(r.key));
  const selTotal = sel.reduce((s, r) => s + r.mine, 0);
  const filtersOn = tx.q || tx.period !== 'all' || tx.type !== 'all' || tx.category || tx.group || tx.account || tx.method;

  const onCount = [tx.period !== 'all', tx.category, tx.group, tx.account, tx.method].filter(Boolean).length;
  const groupOpts = state.entries.filter(e => tx.type === 'all' || e.type === tx.type).sort((a, b) => a.name.localeCompare(b.name));
  const sortBtn = (k, label, extra = '') => {
    const on = tx.sort === k;
    return `<th class="${extra}" aria-sort="${on ? (tx.dir > 0 ? 'ascending' : 'descending') : 'none'}">
      <button type="button" data-action="tx-sort" data-key="${k}">${label}<span class="sort-ind" aria-hidden="true">${on ? (tx.dir > 0 ? '▲' : '▼') : ''}</span></button></th>`;
  };
  const row = r => {
    const s = C.shareOf(r.e) < 1;
    return `<tr class="${tx.sel.has(r.key) ? 'sel' : ''}">
      <td class="tx-check"><input type="checkbox" data-sel="${esc(r.key)}" ${tx.sel.has(r.key) ? 'checked' : ''} aria-label="Select ${esc(r.payee || r.group)} on ${esc(fmtDate(r.date))}"></td>
      <td class="tx-date">${esc(fmtDate(r.date))}</td>
      <td class="tx-payee"><span class="tx-name">${esc(r.payee || r.group)}</span>${r.p.note ? `<span class="tx-note" title="${esc(r.p.note)}">${esc(r.p.note)}</span>` : ''}</td>
      <td class="tx-group"><button type="button" class="link small-link" data-action="tx-open" data-id="${esc(r.e.id)}" title="Open ${esc(r.group)}">${esc(r.group)}</button></td>
      <td class="tx-cat">${esc(r.category)}</td>
      <td class="tx-acct">${esc(r.account)}</td>
      <td class="tx-method">${esc(r.method)}</td>
      <td class="tx-amt ${cls(r.amount)}">${signedMoney(r.amount)}${s ? `<small>yours ${signedMoney(r.mine)}</small>` : ''}</td>
    </tr>`;
  };

  const panel = groups.length ? `<details class="card tx-groups ${countable && range.months ? '' : 'logged-only'}" ${tx.panelOpen ?? !!tx.origin ? 'open' : ''}>
    <summary class="card-head"><h3>By payee group</h3><span class="muted">${esc(range.label)} · ${groups.length} payee group${groups.length === 1 ? '' : 's'}</span></summary>
    <div class="tx-g-head"><span>Payee group</span><span>Logged</span>${countable && range.months ? '<span>Overview</span>' : ''}</div>
    <div class="list">${groups.slice(0, 40).map(g => `<button type="button" class="row tx-g-row ${tx.group === g.e.id ? 'on' : ''}" data-action="tx-group" data-id="${esc(g.e.id)}">
        <span class="row-main"><span class="row-title">${esc(g.e.name)}</span><span class="row-sub">${g.count ? `${g.count} payment${g.count === 1 ? '' : 's'}` : 'none logged'}</span></span>
        <span class="tx-g-v ${g.count ? cls(g.logged) : 'muted'}">${g.count ? signedMoney(g.logged) : '—'}</span>
        ${countable && range.months ? `<span class="tx-g-v ${cls(g.counted ?? 0)}">${g.counted == null ? '—' : signedMoney(g.counted)}</span>` : ''}
      </button>`).join('')}
      ${groups.length > 40 ? `<p class="fine">and ${groups.length - 40} more</p>` : ''}
    </div>
    ${countable && range.months ? (() => {
      const counted = groups.reduce((s, g) => s + (g.counted ?? 0), 0);
      const logged = groups.reduce((s, g) => s + g.logged, 0);
      return `<div class="tx-g-total"><span>Total</span><span class="${cls(logged)}">${signedMoney(logged)}</span><span class="${cls(counted)}">${signedMoney(counted)}</span></div>
      <p class="fine"><strong>Overview</strong> is what the Overview counts for ${esc(range.label)}: the payments logged, plus the
        schedule for any days they don’t cover (so bills not logged yet still count). Your share.</p>`;
    })() : `<p class="fine">Your share of the payments shown.${range.months ? ' The Overview’s figures aren’t shown while filtering by account, method or search.' : ' Pick whole months under Period to compare with the Overview.'}</p>`}
  </details>` : '';

  const origin = tx.origin ? `<div class="tx-origin">
      <button type="button" class="link small-link" data-action="tx-back">‹ Overview</button>
      <span>${esc(tx.origin.label)}${tx.origin.amount != null ? ` · <strong>${money(tx.origin.amount)}</strong>` : ''}</span>
      ${tx.origin.note ? `<span class="muted">${esc(tx.origin.note)}</span>` : ''}
    </div>` : '';

  view.innerHTML = `
    ${origin}
    <div class="toolbar tx-toolbar">
      <div class="seg">
        ${[['all', 'All'], ['expense', 'Money out'], ['income', 'Money in']].map(([v, l]) =>
          `<button data-action="tx-type" data-type="${v}" class="${tx.type === v ? 'on' : ''}">${l}</button>`).join('')}
      </div>
      <input type="search" id="txSearch" placeholder="Search payees, notes, amounts" value="${esc(tx.q)}" autocomplete="off">
      <button type="button" class="btn small tx-filter-btn" data-action="tx-filters" aria-expanded="${tx.showFilters ? 'true' : 'false'}">Filters &amp; sort${onCount ? ` · ${onCount} on` : ''}</button>
      <div class="tx-filters ${tx.showFilters ? 'open' : ''}">
        <label><span>Period</span><select data-tx="period">${PERIODS.map(([v, l]) => `<option value="${v}" ${tx.period === v ? 'selected' : ''}>${l}</option>`).join('')}
          ${tx.period.startsWith('m:') ? `<option value="${esc(tx.period)}" selected>${esc(range.label)}</option>` : ''}</select></label>
        ${tx.period === 'custom' ? `<label><span>From</span><input type="date" data-tx="from" value="${esc(tx.from)}"></label>
          <label><span>To</span><input type="date" data-tx="to" value="${esc(tx.to)}"></label>` : ''}
        <label><span>Category</span><select data-tx="category">${options(uniqSorted(state.entries.map(categoryOf)), tx.category, 'All categories')}</select></label>
        <label><span>Payee group</span><select data-tx="group"><option value="">All payee groups</option>${groupOpts.map(e =>
          `<option value="${esc(e.id)}" ${tx.group === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label>
        <label><span>Account</span><select data-tx="account">${options(uniqSorted(all.map(r => r.account)), tx.account, 'All accounts')}</select></label>
        <label><span>Method</span><select data-tx="method">${options(uniqSorted(all.map(r => r.method)), tx.method, 'All methods')}</select></label>
        <label class="tx-sortby"><span>Sort</span><select data-tx="sortby">${SORTS.map(([v, l]) =>
          `<option value="${v}" ${v === `${tx.sort}:${tx.dir}` ? 'selected' : ''}>${l}</option>`).join('')}
          ${SORTS.some(([v]) => v === `${tx.sort}:${tx.dir}`) ? '' : '<option selected>By column</option>'}</select></label>
        ${filtersOn ? '<button type="button" class="link small-link" data-action="tx-reset">Clear filters</button>' : ''}
      </div>
      ${tagBar()}
    </div>
    <div class="tx-cols">
      <div class="tx-main">
        <div class="tx-sum">
          <span><strong>${rows.length}</strong> payment${rows.length === 1 ? '' : 's'}</span>
          ${out ? `<span>Out <strong class="neg">${money(out)}</strong></span>` : ''}
          ${inn ? `<span>In <strong class="pos">${money(inn)}</strong></span>` : ''}
          ${out && inn ? `<span>Net <strong class="${cls(inn - out)}">${signedMoney(inn - out)}</strong></span>` : ''}
          ${shared ? '<span class="muted">your share</span>' : ''}
        </div>
        ${sel.length ? `<div class="tx-bulk" role="region" aria-label="Selected payments">
          <span><strong>${sel.length}</strong> selected · <span class="${cls(selTotal)}">${signedMoney(selTotal)}</span></span>
          <button type="button" class="btn small" data-action="tx-move">Move to…</button>
          <button type="button" class="link small-link" data-action="tx-select-none">Clear selection</button>
        </div>` : ''}
        ${rows.length ? `<section class="card tx-card"><table class="tx-table">
          <thead><tr>
            <th class="tx-check"><input type="checkbox" data-sel-all ${sel.length === rows.length ? 'checked' : ''} aria-label="Select all ${rows.length} payments shown"></th>
            ${sortBtn('date', 'Date', 'tx-date')}${sortBtn('payee', 'Payee', 'tx-payee')}${sortBtn('group', 'Payee group', 'tx-group')}
            ${sortBtn('category', 'Category', 'tx-cat')}${sortBtn('account', 'Account', 'tx-acct')}${sortBtn('method', 'Method', 'tx-method')}
            ${sortBtn('amount', 'Amount', 'tx-amt')}
          </tr></thead>
          <tbody>${rows.slice(0, tx.limit).map(row).join('')}</tbody>
        </table></section>
        ${rows.length > tx.limit ? `<button type="button" class="btn tx-more" data-action="tx-more">Show more (${rows.length - tx.limit} not shown)</button>` : ''}`
        : `<p class="empty-small">${all.length ? 'No payments match.' : 'No payments yet. They’re added when you import a bank statement, or log a payment in a payee group.'}${groups.length && range.months ? ' The Overview’s figure comes from the payee groups’ schedules, shown alongside.' : ''}</p>`}
      </div>
      <div class="tx-side">${panel}</div>
    </div>`;
  // remember whether "By payee group" is open, so redrawing (sorting, selecting) doesn't close it
  $('.tx-groups', view)?.addEventListener('toggle', ev => { state.tx.panelOpen = ev.target.open; });
}

// ---------- Events (wired up in app.js) ----------

const redraw = (keepSel = false) => { if (!keepSel) state.tx.sel.clear(); state.tx.limit = PAGE; renderTransactions(); };

/** The rows on show now (for selecting all and moving). */
const shownRows = () => filterRows(allRows(), state.tx, periodRange(state.tx));

export const txActions = {
  'tx-type': t => { state.tx.type = t.dataset.type; if (state.tx.group && state.entries.find(e => e.id === state.tx.group)?.type !== t.dataset.type && t.dataset.type !== 'all') state.tx.group = ''; redraw(); },
  'tx-sort': t => {
    const k = t.dataset.key;
    state.tx.dir = state.tx.sort === k ? -state.tx.dir : (k === 'date' || k === 'amount' ? -1 : 1);
    state.tx.sort = k;
    renderTransactions();
  },
  'tx-filters': () => { state.tx.showFilters = !state.tx.showFilters; renderTransactions(); },
  'tx-more': () => { state.tx.limit += PAGE; renderTransactions(); },
  'tx-reset': () => { state.tx = { ...freshFilters(), showFilters: state.tx.showFilters }; renderTransactions(); },
  'tx-group': t => { state.tx.group = state.tx.group === t.dataset.id ? '' : t.dataset.id; redraw(); },
  'tx-open': t => { const e = state.entries.find(x => x.id === t.dataset.id); if (e) openSheet(e, 'transactions'); },
  'tx-select-none': () => { state.tx.sel.clear(); renderTransactions(); },
  'tx-back': () => { state.tab = 'overview'; state.tx.origin = null; window.scrollTo(0, 0); render(); },
  'tx-move': () => moveSelected(),
};

export function txInput(ev) {
  if (ev.target.id !== 'txSearch') return false;
  state.tx.q = ev.target.value;
  const pos = ev.target.selectionStart;
  redraw();
  const s = $('#txSearch'); s.focus(); s.setSelectionRange(pos, pos);
  return true;
}

export function txChange(ev) {
  const t = ev.target;
  if (t.matches('[data-sel]')) {
    if (t.checked) state.tx.sel.add(t.dataset.sel); else state.tx.sel.delete(t.dataset.sel);
    renderTransactions();
    return true;
  }
  if (t.matches('[data-sel-all]')) {
    state.tx.sel = t.checked ? new Set(shownRows().map(r => r.key)) : new Set();
    renderTransactions();
    return true;
  }
  const f = t.dataset.tx;
  if (!f) return false;
  if (f === 'sortby') {
    const [k, d] = t.value.split(':');
    if (d) Object.assign(state.tx, { sort: k, dir: Number(d) });
    renderTransactions();
    return true;
  }
  if (f === 'period' && t.value === 'custom' && state.tx.period !== 'custom') {
    const r = periodRange(state.tx); // start the custom dates from the period that was showing
    Object.assign(state.tx, { from: r.from, to: r.to });
  }
  state.tx[f] = t.value;
  redraw();
  return true;
}

/** Move the selected payments to another payee group (or a new one), then tidy up emptied groups. */
async function moveSelected() {
  const rows = shownRows().filter(r => state.tx.sel.has(r.key));
  if (!rows.length) return;
  const types = new Set(rows.map(r => r.e.type));
  const type = types.size === 1 ? [...types][0] : 'expense';
  const froms = [...new Set(rows.map(r => r.e.id))];
  const payees = [...new Set(rows.map(r => r.payee).filter(Boolean))];
  const name = payees.length === 1 ? payees[0] : '';
  const choice = await pickGroup({ title: `Move ${rows.length} payment${rows.length === 1 ? '' : 's'} to`, type, name,
    exclude: froms.length === 1 ? froms : [], suggested: name ? groupSuggestions(name, type, froms) : [] });
  if (!choice) return;
  const first = rows.reduce((d, r) => (r.date < d ? r.date : d), rows[0].date);
  const dest = choice.create
    ? newGroup({ name: choice.create, type, start: first, fromImport: true, category: suggestCategory(choice.create, type) })
    : state.entries.find(e => e.id === choice.id);
  if (!dest) return;
  await movePayments(rows.map(r => ({ p: r.p, e: r.e })), dest);
  state.tx.sel.clear();
  await reload();
  const removed = await removeEmptyGroups(froms.filter(id => id !== dest.id));
  if (removed.length) render();
  toast(`Moved ${rows.length} payment${rows.length === 1 ? '' : 's'} to ${dest.name}${removedNote(removed)}`);
}

// ---------- Drill down from the Overview ----------

/**
 * Open the Transactions tab filtered to match something on the Overview.
 *   kind   — 'category' | 'group' | 'tag' | 'type' (value: 'income' | 'expense')
 *   period — 'month' | '12m' | 'm:YYYY-MM' | 'all'
 *   label, amount, note — shown at the top, so it's clear where you came from
 */
export function drillDown({ kind, value, period = 'month', type = 'all', label = '', amount = null, note = '' }) {
  const tx = freshFilters();
  tx.period = period;
  tx.type = type;
  if (kind === 'category') tx.category = value;
  else if (kind === 'group') tx.group = value;
  else if (kind === 'type') tx.type = value;
  else if (kind === 'tag' && !state.tags.some(t => lc(t) === lc(value))) state.tags = [...state.tags, value];
  tx.origin = { label, amount, note };
  state.tx = tx;
  state.tab = 'txns';
  window.scrollTo(0, 0);
  render();
}

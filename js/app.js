import { db } from './db.js';
import * as C from './calc.js';
import { buildChart } from './chart.js';
import { APP_ID, SCHEMA_VERSION, normalizeTags, migrateBackup, buildBackup } from './schema.js';

// ---------- Constants ----------
const CATEGORIES = {
  expense: ['Housing', 'Utilities', 'Subscriptions', 'Phone & Internet', 'Insurance', 'Transport',
            'Groceries', 'Health', 'Entertainment', 'Debt', 'Savings', 'Other'],
  income: ['Salary', 'Freelance', 'Benefits', 'Investments', 'Rental', 'Gift', 'Other'],
};
const METHODS = ['Direct debit', 'Standing order', 'Debit card', 'Credit card', 'Apple Pay',
                 'Bank transfer', 'PayPal', 'Cash', 'Other'];
const CURRENCIES = ['GBP', 'USD', 'EUR', 'AUD', 'CAD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'JPY', 'INR', 'SGD', 'ZAR'];
const FORECAST_MONTHS = 3;
const TITLES = { overview: 'Overview', entries: 'Entries', settings: 'Settings' };

function guessCurrency() {
  const region = ((navigator.language || 'en-US').split('-')[1] || '').toUpperCase();
  const map = { GB: 'GBP', US: 'USD', AU: 'AUD', CA: 'CAD', NZ: 'NZD', CH: 'CHF', SE: 'SEK', NO: 'NOK',
    DK: 'DKK', JP: 'JPY', IN: 'INR', SG: 'SGD', ZA: 'ZAR', IE: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR',
    IT: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', PT: 'EUR', FI: 'EUR' };
  return map[region] || 'USD';
}

// ---------- State ----------
const state = {
  entries: [],
  settings: { currency: guessCurrency(), lastBackup: null },
  tab: 'overview',
  filter: 'all',
  search: '',
  range: 12,
  sel: null,
  tags: [],              // active tag filter (entries must have ALL of these)
  breakdown: 'category', // 'category' | 'tag'
};

// ---------- Helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

const fmtCache = new Map();
function money(n, opts = {}) {
  const key = state.settings.currency + JSON.stringify(opts);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.NumberFormat(undefined, { style: 'currency', currency: state.settings.currency, ...opts }));
  return fmtCache.get(key).format(n);
}
const compactMoney = n => money(n, { notation: 'compact', maximumFractionDigits: 1 });

const monthShort = new Intl.DateTimeFormat(undefined, { month: 'short' });
const monthLong = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const monthYear = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
const dayMonth = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const dayMonthYear = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
function fmtDate(s) {
  const d = C.parse(s);
  return (d.getFullYear() === new Date().getFullYear() ? dayMonth : dayMonthYear).format(d);
}
function relDays(n) {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}

// ---------- Tags ----------
const hasTag = (e, t) => (e.tags || []).some(x => x.toLowerCase() === t.toLowerCase());

/** All tags in use, most-used first. */
function allTags() {
  const counts = new Map();
  for (const e of state.entries) for (const t of e.tags || []) {
    const k = t.toLowerCase();
    const cur = counts.get(k) || { name: t, n: 0 };
    cur.n++; counts.set(k, cur);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).map(x => x.name);
}

/** Entries passing the active tag filter. */
const tagFiltered = () => state.entries.filter(e => state.tags.every(t => hasTag(e, t)));

function tagBar() {
  const tags = allTags();
  // drop selections for tags that no longer exist
  state.tags = state.tags.filter(t => tags.some(x => x.toLowerCase() === t.toLowerCase()));
  if (!tags.length) return '';
  return `<div class="tagbar" role="group" aria-label="Filter by tag">
    ${state.tags.length ? '<button class="chip clear" data-action="tags-clear">Clear</button>' : ''}
    ${tags.map(t => `<button class="chip ${state.tags.some(x => x.toLowerCase() === t.toLowerCase()) ? 'on' : ''}"
      data-action="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}
  </div>`;
}

async function saveSettings() { await db.saveSettings(state.settings); }
async function reload() { state.entries = await db.allEntries(); render(); }

// ---------- Rendering ----------
const view = $('#view');

function render() {
  $('#title').textContent = TITLES[state.tab];
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
  if (state.tab === 'overview') renderOverview();
  else if (state.tab === 'entries') renderEntries();
  else renderSettings();
}

// ----- Overview -----
let chartCtl = null;
let chartData = [];

function renderOverview() {
  if (!state.entries.length) {
    view.innerHTML = `
      <div class="empty">
        <div class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>
        </div>
        <h2>Track what comes in and goes out</h2>
        <p>Add your bills, subscriptions, contracts and income. You'll see your monthly budget and how it changes over time.</p>
        <button class="btn primary" data-action="add">Add your first entry</button>
        <button class="btn" data-action="sample">Try it with sample data</button>
      </div>`;
    return;
  }

  const now = new Date();
  const today = C.todayISO();
  const entries = tagFiltered();
  const needsBackup = !state.settings.lastBackup || C.daysBetween(state.settings.lastBackup.slice(0, 10), today) > 30;
  const backupBanner = needsBackup ? `<button class="banner" data-action="go-settings">
      <strong>Back up your data</strong><span>Your budget lives only on this device. Save a copy to iCloud Drive.</span></button>` : '';

  if (!entries.length) {
    view.innerHTML = `${backupBanner}${tagBar()}<p class="empty-small">No entries have all of these tags.</p>`;
    return;
  }
  const cur = C.monthTotals(entries, now.getFullYear(), now.getMonth());

  // Chart range
  let past = state.range;
  if (state.range === 'all') {
    const first = entries.reduce((m, e) => (e.startDate < m ? e.startDate : m), today);
    const f = C.parse(first);
    past = Math.max(2, (now.getFullYear() - f.getFullYear()) * 12 + now.getMonth() - f.getMonth() + 1);
  }
  const start = new Date(now.getFullYear(), now.getMonth() - past + 1, 1);
  chartData = C.series(entries, start.getFullYear(), start.getMonth(), past + FORECAST_MONTHS);
  const currentIdx = past - 1;
  if (state.sel == null || state.sel >= chartData.length) state.sel = currentIdx;

  chartCtl = buildChart(chartData, {
    currentIdx,
    axisFmt: compactMoney,
    monthFmt: d => (d.m === 0 ? String(d.y) : monthShort.format(new Date(d.y, d.m, 1))),
  });

  // Insight: change since start of range
  const first = chartData[0], last = chartData[currentIdx];
  const insight = [];
  const change = (label, a, b, goodUp) => {
    const diff = b - a;
    if (Math.abs(diff) < 0.005) return `<li>${label} unchanged since ${monthYear.format(new Date(first.y, first.m, 1))}</li>`;
    const pct = a > 0 ? ` (${diff > 0 ? '+' : ''}${Math.round((diff / a) * 100)}%)` : '';
    const good = goodUp ? diff > 0 : diff < 0;
    return `<li><span class="${good ? 'pos' : 'neg'}">${label} ${diff > 0 ? 'up' : 'down'} ${money(Math.abs(diff))}/mo${pct}</span> since ${monthYear.format(new Date(first.y, first.m, 1))}</li>`;
  };
  if (currentIdx > 0) {
    insight.push(change('Spending', first.expense, last.expense, false));
    insight.push(change('Income', first.income, last.income, true));
  }

  // Upcoming payments (next 14 days)
  const horizon = C.addDaysISO(today, 14);
  const upcoming = entries
    .map(e => ({ e, due: C.nextDue(e, today) }))
    .filter(x => x.due && x.due <= horizon)
    .sort((a, b) => a.due.localeCompare(b.due))
    .slice(0, 6);

  // Contracts ending soon / recently out of contract
  const contracts = entries
    .filter(e => e.contractEnd && e.frequency !== 'once' && !(e.endDate && e.endDate < today))
    .map(e => ({ e, days: C.daysBetween(today, e.contractEnd) }))
    .filter(x => x.days <= 60 && (x.days >= 0 || (!x.e.endsAtExpiry && x.days >= -60)))
    .sort((a, b) => a.days - b.days);

  // Breakdown of this month's expenses, by category or by tag
  const byTag = state.breakdown === 'tag';
  const cats = {};
  for (const e of entries) {
    if (e.type !== 'expense') continue;
    const v = C.monthAmount(e, now.getFullYear(), now.getMonth());
    if (v <= 0) continue;
    const keys = byTag ? (e.tags?.length ? e.tags.map(t => '#' + t) : ['Untagged']) : [e.category || 'Other'];
    for (const k of keys) cats[k] = (cats[k] || 0) + v;
  }
  const catList = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const catMax = catList.length ? catList[0][1] : 1;
  const filterNote = state.tags.length ? `<p class="fine">Showing only entries tagged ${state.tags.map(t => '#' + esc(t)).join(' + ')}.</p>` : '';

  view.innerHTML = `
    ${backupBanner}
    ${tagBar()}
    ${filterNote}

    <section class="card summary">
      <div class="summary-head">${esc(monthLong.format(now))}</div>
      <div class="summary-grid">
        <div><span class="k">Income</span><span class="v pos">${money(cur.income)}</span></div>
        <div><span class="k">Expenses</span><span class="v neg">${money(cur.expense)}</span></div>
        <div class="net"><span class="k">Left over</span><span class="v ${cur.net >= 0 ? 'pos' : 'neg'}">${money(cur.net)}</span></div>
      </div>
      <p class="fine">Recurring items are spread evenly per month (e.g. yearly ÷ 12).</p>
    </section>

    <section class="card">
      <div class="card-head">
        <h3>Over time</h3>
        <div class="seg small">
          ${[[6, '6M'], [12, '1Y'], [24, '2Y'], ['all', 'All']].map(([v, l]) =>
            `<button data-action="range" data-range="${v}" class="${state.range === v ? 'on' : ''}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="chart">${chartCtl.svg}</div>
      <div class="legend"><span class="sw income"></span>Income <span class="sw expense"></span>Expenses</div>
      <div class="readout" id="readout"></div>
      ${insight.length ? `<ul class="insight">${insight.join('')}</ul>` : ''}
    </section>

    ${contracts.length ? `<section class="card">
      <div class="card-head"><h3>Contracts</h3></div>
      <div class="list">${contracts.map(({ e, days }) => `
        <button class="row" data-action="edit" data-id="${e.id}">
          <div class="row-main">
            <div class="row-title">${esc(e.name)}</div>
            <div class="row-sub">${days >= 0
              ? `Ends ${fmtDate(e.contractEnd)} · ${relDays(days)} · ${e.endsAtExpiry ? 'will stop' : 'then rolls over'}`
              : `Out of contract since ${fmtDate(e.contractEnd)} — worth checking for a better deal`}</div>
          </div>
          <span class="pill ${days < 0 ? 'warn' : days <= 14 ? 'soon' : ''}">${days >= 0 ? `${days}d` : 'Expired'}</span>
        </button>`).join('')}
      </div></section>` : ''}

    ${upcoming.length ? `<section class="card">
      <div class="card-head"><h3>Next 14 days</h3></div>
      <div class="list">${upcoming.map(({ e, due }) => `
        <button class="row" data-action="edit" data-id="${e.id}">
          <div class="row-main">
            <div class="row-title">${esc(e.name)}</div>
            <div class="row-sub">${fmtDate(due)} · ${relDays(C.daysBetween(today, due))}${e.method ? ' · ' + esc(e.method) : ''}</div>
          </div>
          <div class="row-amt ${e.type === 'income' ? 'pos' : 'neg'}">${e.type === 'income' ? '+' : '−'}${money(C.priceOn(e, due))}</div>
        </button>`).join('')}
      </div></section>` : ''}

    ${catList.length ? `<section class="card">
      <div class="card-head"><h3>Where it goes</h3>
        <div class="seg small">
          <button data-action="breakdown" data-by="category" class="${byTag ? '' : 'on'}">Category</button>
          <button data-action="breakdown" data-by="tag" class="${byTag ? 'on' : ''}">Tag</button>
        </div></div>
      <p class="fine">This month${byTag ? ' · an entry with several tags counts towards each' : ''}</p>
      <div class="cats">${catList.map(([name, v]) => `
        <div class="cat">
          <div class="cat-top"><span>${esc(name)}</span><span>${money(v)} <span class="muted">${Math.round((v / cur.expense) * 100)}%</span></span></div>
          <div class="bar"><span style="width:${((v / catMax) * 100).toFixed(1)}%"></span></div>
        </div>`).join('')}
      </div></section>` : ''}
  `;

  const svg = $('.chart-svg', view);
  const select = i => { state.sel = i; chartCtl.highlight(svg, i); updateReadout(currentIdx); };
  select(state.sel);
  const onPointer = ev => select(chartCtl.indexAt(svg, ev.clientX));
  svg.addEventListener('pointerdown', onPointer);
  svg.addEventListener('pointermove', ev => { if (ev.buttons || ev.pointerType === 'touch') onPointer(ev); });
}

function updateReadout(currentIdx) {
  const d = chartData[state.sel];
  if (!d) return;
  const label = monthLong.format(new Date(d.y, d.m, 1)) + (state.sel > currentIdx ? ' (forecast)' : '');
  $('#readout').innerHTML = `
    <div class="ro-month">${esc(label)}</div>
    <div class="ro-grid">
      <span><i class="sw income"></i>${money(d.income)}</span>
      <span><i class="sw expense"></i>${money(d.expense)}</span>
      <span class="${d.net >= 0 ? 'pos' : 'neg'}">Net ${money(d.net)}</span>
    </div>`;
}

// ----- Entries -----
function renderEntries() {
  const today = C.todayISO();
  const q = state.search.trim().toLowerCase();
  const list = tagFiltered()
    .filter(e => state.filter === 'all' || e.type === state.filter)
    .filter(e => !q || [e.name, e.category, e.method, e.notes, ...(e.tags || []).map(t => '#' + t)]
      .some(f => (f || '').toLowerCase().includes(q)));

  const recurring = list.filter(e => e.frequency !== 'once' && !C.isEnded(e, today))
    .sort((a, b) => C.monthlyEquivalent(b) - C.monthlyEquivalent(a));
  const oneOff = list.filter(e => e.frequency === 'once').sort((a, b) => b.startDate.localeCompare(a.startDate));
  const ended = list.filter(e => C.isEnded(e, today)).sort((a, b) => C.stopDate(b).localeCompare(C.stopDate(a)));

  const totalMonthly = type => recurring.filter(e => e.type === type).reduce((s, e) => s + C.monthlyEquivalent(e), 0);

  const row = e => {
    const inc = e.type === 'income';
    const sign = inc ? '+' : '−';
    const price = e.frequency === 'once' ? C.priceOn(e, e.startDate) : C.currentPrice(e);
    const due = C.nextDue(e, today);
    const sub = [
      e.category,
      e.method,
      e.frequency === 'once' ? fmtDate(e.startDate) : C.FREQ[e.frequency].label,
      C.isEnded(e, today) ? `Ended ${fmtDate(C.stopDate(e))}` : (e.frequency !== 'once' && due ? `Next ${fmtDate(due)}` : null),
    ].filter(Boolean).map(esc).join(' · ');
    const perMonth = e.frequency !== 'once' && e.frequency !== 'monthly'
      ? `<small>≈ ${money(C.monthlyEquivalent(e))}/mo</small>` : '';
    const tags = e.tags?.length
      ? `<div class="row-tags">${e.tags.map(t => `<span class="chip tiny">#${esc(t)}</span>`).join('')}</div>` : '';
    return `<button class="row" data-action="edit" data-id="${e.id}">
      <div class="row-main"><div class="row-title">${esc(e.name)}</div><div class="row-sub">${sub}</div>${tags}</div>
      <div class="row-amt ${inc ? 'pos' : 'neg'}">${sign}${money(price)}${perMonth}</div>
    </button>`;
  };
  const group = (title, items, extra = '') => items.length
    ? `<div class="group-title">${title}${extra}</div><section class="card list">${items.map(row).join('')}</section>` : '';

  const totals = state.filter === 'all'
    ? ` <span class="muted">${money(totalMonthly('income') - totalMonthly('expense'))}/mo net</span>`
    : ` <span class="muted">${money(totalMonthly(state.filter))}/mo</span>`;

  view.innerHTML = `
    <div class="toolbar">
      <div class="seg">
        ${[['all', 'All'], ['expense', 'Expenses'], ['income', 'Income']].map(([v, l]) =>
          `<button data-action="filter" data-filter="${v}" class="${state.filter === v ? 'on' : ''}">${l}</button>`).join('')}
      </div>
      <input type="search" id="search" placeholder="Search names, notes, #tags" value="${esc(state.search)}" autocomplete="off">
      ${tagBar()}
    </div>
    ${list.length ? '' : `<p class="empty-small">${state.entries.length ? 'Nothing matches.' : 'No entries yet. Tap + to add one.'}</p>`}
    ${group('Recurring', recurring, recurring.length ? totals : '')}
    ${group('One-off', oneOff)}
    ${group('Ended', ended)}
  `;
}

// ----- Settings -----
async function renderSettings() {
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
  if (state.tab !== 'settings') return; // user switched tabs while awaiting

  view.innerHTML = `
    ${standalone ? '' : `<div class="group-title">Install</div>
    <section class="card pad">
      <p>For the best experience on iPhone, open this page in <strong>Safari</strong>, tap the <strong>Share</strong> button, then <strong>Add to Home Screen</strong>. It will then run full-screen and work offline.</p>
    </section>`}

    <div class="group-title">General</div>
    <section class="card list">
      <label class="row static">
        <div class="row-main"><div class="row-title">Currency</div></div>
        <select id="currency">${CURRENCIES.map(c => `<option ${c === state.settings.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </label>
    </section>

    <div class="group-title">Backup &amp; iCloud</div>
    <section class="card list">
      <button class="row" data-action="export">
        <div class="row-main"><div class="row-title accent">Export backup</div>
        <div class="row-sub">Choose “Save to Files” → iCloud Drive</div></div>
      </button>
      <button class="row" data-action="import">
        <div class="row-main"><div class="row-title accent">Import backup</div>
        <div class="row-sub">Merges a backup file into this device</div></div>
      </button>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
    </section>
    <p class="fine pad-x">${state.entries.length} entries · Last backup: ${state.settings.lastBackup ? fmtDate(state.settings.lastBackup.slice(0, 10)) : 'never'}.
      Your data is stored only on this device. Saving a backup to iCloud Drive lets you restore it on another iPhone, iPad or Mac.</p>

    <div class="group-title">Storage</div>
    <section class="card list">
      <div class="row static">
        <div class="row-main"><div class="row-title">Protected from clean-up</div>
        <div class="row-sub">${persisted === null ? 'Not supported by this browser' : persisted ? 'Yes — the browser won’t clear this data' : 'Not yet — install to Home Screen for best protection'}</div></div>
        ${persisted === false ? '<button class="btn small" data-action="persist">Request</button>' : ''}
      </div>
    </section>

    <div class="group-title">Danger zone</div>
    <section class="card list">
      <button class="row" data-action="erase"><div class="row-main"><div class="row-title danger">Erase all data</div></div></button>
    </section>
    <p class="fine pad-x">Budget · works offline · no account, no tracking.</p>
  `;
}

// ---------- Entry sheet ----------
const sheet = $('#sheet');

function priceRow(p, first) {
  return `<div class="field price-row">
    ${first ? '<span class="pfrom-start">From start</span><input type="hidden" name="pfrom" value="">'
            : `<input type="date" name="pfrom" value="${esc(p.from)}" aria-label="Price changed on">`}
    <input name="pamount" inputmode="decimal" placeholder="0.00" value="${p.amount ?? ''}" aria-label="Amount">
    ${first ? '<span class="pbtn-spacer"></span>' : '<button type="button" class="icon-btn small" data-remove-price aria-label="Remove">−</button>'}
  </div>`;
}

function openSheet(entry = null) {
  const isNew = !entry;
  const e = entry || { type: 'expense', frequency: 'monthly', startDate: C.todayISO(), prices: [{ from: C.todayISO(), amount: '' }] };
  const prices = C.sortedPrices(e);

  sheet.innerHTML = `
  <form id="entryForm" novalidate>
    <div class="sheet-head">
      <button type="button" class="link" data-close>Cancel</button>
      <h2>${isNew ? 'New entry' : 'Edit entry'}</h2>
      <button type="submit" class="link strong">Save</button>
    </div>
    <div class="sheet-body">
      <div class="seg type-seg">
        <label><input type="radio" name="type" value="expense" ${e.type !== 'income' ? 'checked' : ''}><span>Expense</span></label>
        <label><input type="radio" name="type" value="income" ${e.type === 'income' ? 'checked' : ''}><span>Income</span></label>
      </div>

      <section class="card form">
        <label class="field"><span>Name</span>
          <input name="name" placeholder="e.g. Netflix, Rent, Salary" value="${esc(e.name)}" autocomplete="off" enterkeyhint="next"></label>
        ${isNew ? `<label class="field"><span>Amount</span>
          <input name="amount" inputmode="decimal" placeholder="0.00" value="" enterkeyhint="done"></label>` : ''}
        <label class="field"><span>How often</span>
          <select name="frequency">${Object.entries(C.FREQ).map(([k, f]) =>
            `<option value="${k}" ${e.frequency === k ? 'selected' : ''}>${f.label}</option>`).join('')}</select></label>
        <label class="field"><span class="lbl-start">First payment</span>
          <input type="date" name="startDate" value="${esc(e.startDate)}"></label>
      </section>

      ${isNew ? '' : `
      <div class="group-title">Price history <span class="muted">— add a change when the price goes up or down</span></div>
      <section class="card form" id="prices">${prices.map((p, i) => priceRow(p, i === 0)).join('')}</section>
      <button type="button" class="link add-price" data-add-price>+ Add price change</button>`}

      <section class="card form">
        <label class="field"><span>Category</span>
          <input name="category" list="dl-cat" placeholder="Choose or type" value="${esc(e.category)}" autocomplete="off"></label>
        <label class="field"><span>Payment method</span>
          <input name="method" list="dl-method" placeholder="Choose or type" value="${esc(e.method)}" autocomplete="off"></label>
      </section>

      <div class="group-title">Tags <span class="muted">— e.g. work, shared, tax-deductible</span></div>
      <section class="card form">
        <div class="tag-edit" id="tagEdit">
          <span id="tagChips"></span>
          <input id="tagInput" placeholder="Add tag…" autocomplete="off" autocapitalize="none" enterkeyhint="done" aria-label="Add tag">
        </div>
      </section>
      <div class="tag-suggest" id="tagSuggest"></div>

      <section class="card form recurring-only">
        <label class="field"><span>Contract ends</span>
          <input type="date" name="contractEnd" value="${esc(e.contractEnd || '')}"></label>
        <label class="field toggle"><span>Stop when contract ends</span>
          <input type="checkbox" name="endsAtExpiry" ${e.endsAtExpiry ? 'checked' : ''}></label>
        <label class="field"><span>Cancelled on</span>
          <input type="date" name="endDate" value="${esc(e.endDate || '')}"></label>
      </section>
      <p class="fine pad-x recurring-only">Contract end is optional — you'll get a heads-up on the Overview as it approaches. Set “Cancelled on” once you stop paying.</p>

      <section class="card form">
        <label class="field col"><span>Notes</span>
          <textarea name="notes" rows="3" placeholder="Account number, renewal terms…">${esc(e.notes)}</textarea></label>
      </section>

      <p class="form-error" id="formError" role="alert"></p>
      ${isNew ? '' : '<button type="button" class="btn danger-btn" data-delete>Delete entry</button>'}
    </div>
    <datalist id="dl-cat"></datalist>
    <datalist id="dl-method"></datalist>
  </form>`;

  const form = $('#entryForm');
  const syncType = () => {
    const type = form.type.value;
    const used = state.entries.filter(x => x.type === type).map(x => x.category).filter(Boolean);
    $('#dl-cat').innerHTML = [...new Set([...CATEGORIES[type], ...used])].map(c => `<option value="${esc(c)}">`).join('');
    form.classList.toggle('is-income', type === 'income');
  };
  const syncFreq = () => {
    const once = form.frequency.value === 'once';
    form.classList.toggle('is-once', once);
    $('.lbl-start', form).textContent = once ? 'Date' : (form.type.value === 'income' ? 'First received' : 'First payment');
  };
  const usedMethods = state.entries.map(x => x.method).filter(Boolean);
  $('#dl-method').innerHTML = [...new Set([...METHODS, ...usedMethods])].map(c => `<option value="${esc(c)}">`).join('');
  syncType(); syncFreq();

  // Tag editor
  let tags = normalizeTags(e.tags);
  const tagInput = $('#tagInput', form);
  const renderTags = () => {
    $('#tagChips', form).innerHTML = tags.map(t =>
      `<button type="button" class="chip on" data-remove-tag="${esc(t)}" aria-label="Remove tag ${esc(t)}">#${esc(t)} <span aria-hidden="true">×</span></button>`).join('');
    const q = tagInput.value.trim().toLowerCase();
    const suggestions = allTags().filter(t => !tags.some(x => x.toLowerCase() === t.toLowerCase()) && (!q || t.toLowerCase().includes(q))).slice(0, 12);
    $('#tagSuggest', form).innerHTML = suggestions.map(t =>
      `<button type="button" class="chip" data-add-tag="${esc(t)}">+ #${esc(t)}</button>`).join('');
  };
  const addTags = list => { tags = normalizeTags([...tags, ...list]); renderTags(); };
  const commitInput = () => { if (tagInput.value.trim()) { addTags(tagInput.value.split(',')); tagInput.value = ''; renderTags(); } };
  form._commitTags = commitInput;
  form._getTags = () => tags;
  tagInput.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); commitInput(); }
    else if (ev.key === 'Backspace' && !tagInput.value && tags.length) { tags.pop(); renderTags(); }
  });
  tagInput.addEventListener('input', () => {
    if (tagInput.value.includes(',')) {
      const parts = tagInput.value.split(',');
      tagInput.value = parts.pop();
      addTags(parts);
    } else renderTags();
  });
  // Commit typed text when leaving the field — but not when the user is tapping a suggestion chip.
  $('#tagSuggest', form).addEventListener('mousedown', ev => ev.preventDefault());
  tagInput.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== tagInput) commitInput(); }, 200));
  renderTags();

  form.addEventListener('change', ev => {
    if (ev.target.name === 'type') { syncType(); syncFreq(); }
    if (ev.target.name === 'frequency') syncFreq();
  });
  form.addEventListener('click', ev => {
    const rm = ev.target.closest('[data-remove-tag]');
    const add = ev.target.closest('[data-add-tag]');
    if (rm) { tags = tags.filter(t => t !== rm.dataset.removeTag); renderTags(); }
    else if (add) { tagInput.value = ''; addTags([add.dataset.addTag]); }
    else if (ev.target.closest('[data-close]')) closeSheet();
    else if (ev.target.closest('[data-add-price]')) {
      $('#prices', form).insertAdjacentHTML('beforeend', priceRow({ from: C.todayISO(), amount: '' }, false));
      $('#prices .price-row:last-child input[name=pamount]', form).focus();
    } else if (ev.target.closest('[data-remove-price]')) ev.target.closest('.price-row').remove();
    else if (ev.target.closest('[data-delete]')) deleteEntry(entry);
  });
  form.addEventListener('submit', ev => { ev.preventDefault(); saveForm(form, entry); });

  document.body.classList.add('modal-open');
  sheet.showModal();
  sheet.scrollTop = 0;
  if (isNew) setTimeout(() => form.name.focus(), 350);
}

function closeSheet() {
  sheet.close();
}
sheet.addEventListener('close', () => document.body.classList.remove('modal-open'));

async function saveForm(form, existing) {
  const err = msg => { $('#formError').textContent = msg; $('#formError').scrollIntoView({ block: 'center', behavior: 'smooth' }); };
  const f = Object.fromEntries(new FormData(form));
  const name = (f.name || '').trim();
  if (!name) return err('Please enter a name.');
  if (!f.startDate) return err('Please choose a date.');

  let prices;
  if (existing) {
    const froms = [...form.querySelectorAll('[name=pfrom]')].map(i => i.value);
    const amounts = [...form.querySelectorAll('[name=pamount]')].map(i => C.parseAmount(i.value));
    prices = froms.map((from, i) => ({ from: i === 0 ? f.startDate : from, amount: amounts[i] }));
    if (prices.some(p => !p.from)) return err('Each price change needs a date.');
    if (prices.slice(1).some(p => p.from <= f.startDate)) return err('Price changes must be after the first payment date.');
  } else {
    prices = [{ from: f.startDate, amount: C.parseAmount(f.amount) }];
  }
  if (prices.some(p => !(p.amount >= 0))) return err('Please enter a valid amount.');

  const once = f.frequency === 'once';
  if (!once && f.contractEnd && f.contractEnd < f.startDate) return err('Contract end can’t be before the first payment.');
  if (!once && f.endDate && f.endDate < f.startDate) return err('Cancelled date can’t be before the first payment.');

  const now = new Date().toISOString();
  const entry = {
    id: existing?.id || uid(),
    type: f.type === 'income' ? 'income' : 'expense',
    name,
    category: (f.category || '').trim(),
    method: (f.method || '').trim(),
    frequency: f.frequency,
    startDate: f.startDate,
    contractEnd: once ? null : f.contractEnd || null,
    endsAtExpiry: !once && !!f.endsAtExpiry,
    endDate: once ? null : f.endDate || null,
    notes: (f.notes || '').trim(),
    tags: (form._commitTags(), form._getTags()),
    prices: prices.sort((a, b) => a.from.localeCompare(b.from)),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await db.putEntry(entry);
  closeSheet();
  await reload();
  toast(existing ? 'Saved' : 'Added');
}

async function deleteEntry(entry) {
  if (!confirm(`Delete “${entry.name}”? This can’t be undone.`)) return;
  await db.deleteEntry(entry.id);
  closeSheet();
  await reload();
  toast('Deleted');
}

// ---------- Backup ----------
async function exportBackup() {
  const payload = buildBackup(state.entries, state.settings);
  const name = `budget-backup-${C.todayISO()}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
    } else {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  } catch (e) {
    if (e.name === 'AbortError') return; // user closed the share sheet
    alert('Export failed: ' + e.message);
    return;
  }
  state.settings.lastBackup = new Date().toISOString();
  await saveSettings();
  render();
  toast('Backup created');
}

async function importBackup(file) {
  try {
    let data;
    try { data = JSON.parse(await file.text()); } catch { throw new Error('The file isn’t valid JSON.'); }
    const { entries: valid, settings, skipped } = migrateBackup(data);
    const skipNote = skipped ? `\n\n${skipped} damaged entr${skipped === 1 ? 'y' : 'ies'} will be skipped.` : '';
    if (!confirm(`Import ${valid.length} entries? Entries already on this device with the same ID will be replaced.${skipNote}`)) return;
    await db.putEntries(valid);
    if (settings.currency && !state.entries.length) { state.settings.currency = settings.currency; fmtCache.clear(); await saveSettings(); }
    await reload();
    toast(`Imported ${valid.length} entries`);
  } catch (e) {
    alert('Import failed: ' + e.message);
  }
}

// ---------- Sample data ----------
function sampleEntries() {
  const now = new Date();
  const m = (offset, day = 1) => C.iso(new Date(now.getFullYear(), now.getMonth() + offset, day));
  const d = days => C.addDaysISO(C.todayISO(), days);
  const mk = (o) => ({ id: uid(), category: '', method: '', notes: '', contractEnd: null, endsAtExpiry: false, endDate: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...o });
  return [
    mk({ type: 'income', name: 'Salary', category: 'Salary', method: 'Bank transfer', frequency: 'monthly', startDate: m(-26, 28),
         prices: [{ from: m(-26, 28), amount: 2650 }, { from: m(-14, 28), amount: 2780 }, { from: m(-3, 28), amount: 2950 }] }),
    mk({ type: 'income', name: 'Freelance design job', category: 'Freelance', method: 'PayPal', frequency: 'once', startDate: m(-2, 12),
         prices: [{ from: m(-2, 12), amount: 450 }] }),
    mk({ type: 'expense', name: 'Rent', category: 'Housing', method: 'Standing order', frequency: 'monthly', startDate: m(-26, 1),
         prices: [{ from: m(-26, 1), amount: 950 }, { from: m(-12, 1), amount: 1010 }] }),
    mk({ type: 'expense', name: 'Electricity & gas', category: 'Utilities', method: 'Direct debit', frequency: 'monthly', startDate: m(-26, 15),
         prices: [{ from: m(-26, 15), amount: 92 }, { from: m(-16, 15), amount: 128 }, { from: m(-5, 15), amount: 115 }] }),
    mk({ type: 'expense', name: 'Phone contract', category: 'Phone & Internet', method: 'Direct debit', frequency: 'monthly', startDate: m(-23, 9),
         contractEnd: d(24), prices: [{ from: m(-23, 9), amount: 32 }] }),
    mk({ type: 'expense', name: 'Broadband', category: 'Phone & Internet', method: 'Direct debit', frequency: 'monthly', startDate: m(-20, 20),
         contractEnd: d(-18), prices: [{ from: m(-20, 20), amount: 28 }, { from: m(-8, 20), amount: 31.5 }] }),
    mk({ type: 'expense', name: 'Netflix', category: 'Subscriptions', method: 'Credit card', frequency: 'monthly', startDate: m(-26, 4),
         prices: [{ from: m(-26, 4), amount: 10.99 }, { from: m(-10, 4), amount: 12.99 }] }),
    mk({ type: 'expense', name: 'Spotify', category: 'Subscriptions', method: 'Apple Pay', frequency: 'monthly', startDate: m(-18, 7),
         prices: [{ from: m(-18, 1), amount: 11.99 }] }),
    mk({ type: 'expense', name: 'Gym', category: 'Health', method: 'Debit card', frequency: 'monthly', startDate: m(-15, 5),
         endDate: m(-4, 5), prices: [{ from: m(-15, 5), amount: 35 }] }),
    mk({ type: 'expense', name: 'Car insurance', category: 'Insurance', method: 'Credit card', frequency: 'yearly', startDate: m(-21, 18),
         prices: [{ from: m(-21, 18), amount: 540 }, { from: m(-9, 18), amount: 612 }] }),
    mk({ type: 'expense', name: 'Groceries', category: 'Groceries', method: 'Debit card', frequency: 'weekly', startDate: m(-26, 2),
         prices: [{ from: m(-26, 2), amount: 70 }, { from: m(-11, 2), amount: 82 }] }),
    mk({ type: 'expense', name: 'Savings', category: 'Savings', method: 'Standing order', frequency: 'monthly', startDate: m(-6, 1),
         prices: [{ from: m(-6, 1), amount: 200 }] }),
  ].map(e => {
    e.prices[0].from = e.startDate;
    e.tags = {
      'Salary': ['work'], 'Freelance design job': ['work', 'taxable'], 'Rent': ['shared', 'essential'],
      'Electricity & gas': ['shared', 'essential'], 'Broadband': ['shared'], 'Phone contract': ['essential'],
      'Netflix': ['shared', 'streaming'], 'Spotify': ['streaming'], 'Car insurance': ['essential', 'car'],
      'Groceries': ['shared', 'essential'],
    }[e.name] || [];
    return e;
  });
}

// ---------- Global events ----------
const actions = {
  add: () => openSheet(),
  sample: async () => { await db.putEntries(sampleEntries()); await reload(); toast('Sample data added — erase it any time in Settings'); },
  edit: t => openSheet(state.entries.find(e => e.id === t.dataset.id)),
  range: t => { state.range = t.dataset.range === 'all' ? 'all' : Number(t.dataset.range); state.sel = null; render(); },
  filter: t => { state.filter = t.dataset.filter; render(); },
  tag: t => {
    const tag = t.dataset.tag;
    const on = state.tags.some(x => x.toLowerCase() === tag.toLowerCase());
    state.tags = on ? state.tags.filter(x => x.toLowerCase() !== tag.toLowerCase()) : [...state.tags, tag];
    state.sel = null;
    render();
  },
  'tags-clear': () => { state.tags = []; state.sel = null; render(); },
  breakdown: t => { state.breakdown = t.dataset.by; render(); },
  'go-settings': () => { state.tab = 'settings'; render(); },
  export: exportBackup,
  import: () => $('#importFile').click(),
  persist: async () => { const ok = await navigator.storage.persist(); toast(ok ? 'Storage protected' : 'Not granted — add to Home Screen first'); render(); },
  erase: async () => {
    if (!confirm('Erase ALL entries on this device? Export a backup first if you might need them.')) return;
    if (!confirm('Are you sure? This cannot be undone.')) return;
    await db.clearEntries();
    state.settings.lastBackup = null;
    await saveSettings();
    await reload();
    toast('All data erased');
  },
};

view.addEventListener('click', ev => {
  const t = ev.target.closest('[data-action]');
  if (t && actions[t.dataset.action]) actions[t.dataset.action](t, ev);
});
view.addEventListener('input', ev => {
  if (ev.target.id === 'search') {
    state.search = ev.target.value;
    const pos = ev.target.selectionStart;
    renderEntries();
    const s = $('#search'); s.focus(); s.setSelectionRange(pos, pos);
  }
});
view.addEventListener('change', async ev => {
  if (ev.target.id === 'currency') {
    state.settings.currency = ev.target.value;
    fmtCache.clear();
    await saveSettings();
    toast(`Currency set to ${ev.target.value}`);
  } else if (ev.target.id === 'importFile' && ev.target.files[0]) {
    await importBackup(ev.target.files[0]);
    ev.target.value = '';
  }
});
document.querySelector('.tabbar').addEventListener('click', ev => {
  const b = ev.target.closest('button[data-tab]');
  if (!b) return;
  if (state.tab === b.dataset.tab) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  state.tab = b.dataset.tab;
  window.scrollTo(0, 0);
  render();
});
$('#addBtn').addEventListener('click', () => openSheet());

// ---------- Boot ----------
(async function init() {
  try {
    const saved = (await db.getSettings()) || {};
    const stored = await db.allEntries();
    // Data saved by an older version of the app goes through the same upgrade path as old backups.
    const { entries, skipped } = migrateBackup({ app: APP_ID, version: saved.schemaVersion ?? 1, settings: saved, entries: stored });
    Object.assign(state.settings, saved);
    state.entries = entries;
    const before = new Map(stored.map(e => [String(e.id), JSON.stringify(e)]));
    const changed = entries.filter(e => before.get(e.id) !== JSON.stringify(e));
    if (changed.length) await db.putEntries(changed);
    if (skipped) console.warn(`${skipped} stored entries could not be read and were left untouched.`);
    if (state.settings.schemaVersion !== SCHEMA_VERSION) { state.settings.schemaVersion = SCHEMA_VERSION; await saveSettings(); }
  } catch (e) {
    view.innerHTML = `<p class="empty-small">Couldn’t load your data: ${esc(e.message)}</p>`;
    return;
  }
  render();
  // Ask the browser not to evict our data (granted automatically for Home Screen apps on iOS).
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
})();

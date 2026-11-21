import { db } from './db.js';
import * as C from './calc.js';
import { buildChart } from './chart.js';
import * as R from './reports.js';
import * as Bank from './bank.js';
import { APP_ID, SCHEMA_VERSION, migrateBackup, buildBackup, normalizeEntry, normalizeTags, cleanTag, cleanLabel } from './schema.js';

// ---------- Constants ----------
const CATEGORIES = {
  expense: ['Housing', 'Utilities', 'Subscriptions', 'Phone & Internet', 'Insurance', 'Transport',
            'Groceries', 'Health', 'Entertainment', 'Debt', 'Savings', 'Other'],
  income: ['Salary', 'Freelance', 'Benefits', 'Investments', 'Rental', 'Gift', 'Other'],
};
/** The phone's region, e.g. "AU" from "en-AU". */
const REGION = ((navigator.language || 'en-US').split('-')[1] || '').toUpperCase();
/** Payment methods people actually use in each region (suggestions only — anything can be typed). */
const METHODS = [
  'Direct debit',
  ...({
    AU: ['BPAY', 'PayID'], NZ: ['Automatic payment'], GB: ['Standing order'], IE: ['Standing order'],
    US: ['Autopay', 'ACH transfer', 'Check', 'Zelle', 'Venmo'], CA: ['Pre-authorized debit', 'Interac e-Transfer'],
  }[REGION] || ['Standing order']),
  'Debit card', 'Credit card', 'Apple Pay', 'Bank transfer', 'PayPal', 'Cash', 'Other',
];

/** A stored timestamp (UTC) as the phone's local calendar date — e.g. 8am in Sydney is still "today". */
const localDay = ts => C.iso(new Date(ts));
const CURRENCIES = ['GBP', 'USD', 'EUR', 'AUD', 'CAD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'JPY', 'INR', 'SGD', 'ZAR'];
const FORECAST_MONTHS = 3;
const TITLES = { overview: 'Overview', entries: 'Entries', settings: 'Settings' };
const STARTER_TAGS = ['shared', 'essential', 'work', 'tax-deductible', 'cancel-soon', 'bundle', 'streaming', 'cloud-storage'];

// ---------- Labels (category / payment method / tag) ----------
const LABELS = {
  category: { title: 'Categories', noun: 'category', field: 'category' },
  method:   { title: 'Methods', noun: 'payment method', field: 'method' },
  tag:      { title: 'Tags', noun: 'tag' },
};
const labelsOf = (kind, e) => (kind === 'tag' ? e.tags || [] : e[kind] ? [e[kind]] : []);

/** Labels in use, with entry counts, most-used first. Matching ignores capitals. */
function labelCounts(kind) {
  const m = new Map();
  for (const e of state.entries) for (const l of labelsOf(kind, e)) {
    const k = l.toLowerCase();
    const cur = m.get(k) || { name: l, n: 0 };
    cur.n++; m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

/** Unique (ignoring capitals) list, first spelling wins. */
const uniqueCI = list => {
  const seen = new Set();
  return list.filter(x => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
};

/** Snap typed text to an existing spelling: "groceries" → "Groceries" if that's already used. */
function canonicalLabel(value, options) {
  const v = cleanLabel(value).slice(0, 40);
  if (!v) return '';
  return options.find(o => o.toLowerCase() === v.toLowerCase()) || v;
}
const categoryOptions = type => uniqueCI([...labelCounts('category').map(x => x.name), ...CATEGORIES[type]]);
const methodOptions = () => uniqueCI([...labelCounts('method').map(x => x.name), ...METHODS]);

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
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.NumberFormat(undefined, { style: 'currency', currency: state.settings.currency, currencyDisplay: 'narrowSymbol', ...opts }));
  return fmtCache.get(key).format(n);
}
/** Expected amount for one payment on a date — your share, using the estimate for varying bills. */
const dueAmount = (e, dateISO) => C.shareOf(e) * C.estimateOn(e, dateISO);
/** "−£12.99" / "+£2,950.00", with "≈" when the amount varies. */
const signed = (e, n) => (e.variable && Math.abs(n) < 0.005
  ? 'Varies' // no estimate yet — nothing logged
  : `${e.type === 'income' ? '+' : '−'}${e.variable ? '≈' : ''}${money(Math.abs(n))}`);
const compactMoney = n => money(n, { notation: 'compact', maximumFractionDigits: 1 });

const monthShort = new Intl.DateTimeFormat(undefined, { month: 'short' });
const monthLong = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const monthYear = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
const dayMonth = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const dayShort = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' });
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
  // Keep our own reference: the toast may get detached when the sheet's contents are replaced.
  const t = (toast.el ||= $('#toast'));
  // an open <dialog> sits above everything else, so show the toast inside it
  const host = $('#sheet').open ? $('#sheet') : document.body;
  if (t.parentElement !== host) host.append(t);
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
  const needsBackup = !state.settings.lastBackup || C.daysBetween(localDay(state.settings.lastBackup), today) > 30;
  const backupBanner = needsBackup ? `<button class="banner" data-action="go-settings">
      <strong>Back up your data</strong><span>Your budget lives only on this device. Save a copy to iCloud Drive.</span></button>` : '';

  if (!entries.length) {
    view.innerHTML = `${backupBanner}${tagBar()}<p class="empty-small">No entries have all of these tags.</p>`;
    return;
  }
  const cur = C.monthTotals(entries, now.getFullYear(), now.getMonth());
  const yearly = state.settings.period === 'year';
  const per = yearly ? '/yr' : '/mo';
  const k = yearly ? 12 : 1; // multiplier for per-month figures
  const yr = R.annualTotals(entries, today);
  const filtered = state.tags.length > 0;

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
    const p = a > 0 ? (diff / a) * 100 : null;
    const pct = p === null ? '' : Math.abs(p) < 1 ? ' (<1%)' : ` (${p > 0 ? '+' : ''}${Math.round(p)}%)`;
    const good = goodUp ? diff > 0 : diff < 0;
    return `<li><span class="${good ? 'pos' : 'neg'}">${label} ${diff > 0 ? 'up' : 'down'} ${money(Math.abs(diff))}/mo${pct}</span> since ${monthYear.format(new Date(first.y, first.m, 1))}</li>`;
  };
  if (currentIdx > 0) {
    insight.push(change('Spending', first.expense, last.expense, false));
    insight.push(change('Income', first.income, last.income, true));
  }

  // Biggest changes over the same period as the chart
  const sinceISO = C.iso(C.addMonths(now, -(past - 1)));
  const changes = currentIdx > 0 ? R.biggestChanges(entries, sinceISO, today, 6) : [];

  // Budgets (this month, all entries) and until-payday — hidden while a tag filter is on
  const budgets = filtered ? [] : (state.settings.budgets || [])
    .map(b => R.budgetStatus(state.entries, b, now.getFullYear(), now.getMonth()))
    .sort((a, b) => b.pct - a.pct);
  const pd = filtered ? null : R.untilPayday(state.entries, today, state.settings.paydayId);

  // Manual payments to make (overdue + next 14 days)
  const pay = C.toPay(entries, today);

  // Upcoming automatic payments (next 14 days) — manual ones are in "To pay" above
  const horizon = C.addDaysISO(today, 14);
  const upcoming = entries
    .filter(e => !e.manual)
    .map(e => ({ e, due: C.nextDue(e, today) }))
    .filter(x => x.due && x.due <= horizon)
    .sort((a, b) => a.due.localeCompare(b.due))
    .slice(0, 6);

  // Contracts: notice deadline (if set) or end date coming up, or recently out of contract
  const contracts = entries
    .filter(e => e.contractEnd && e.frequency !== 'once' && !(e.endDate && e.endDate < today))
    .map(e => {
      const notice = C.noticeBy(e);
      const endDays = C.daysBetween(today, e.contractEnd);
      const noticeDays = notice ? C.daysBetween(today, notice) : null;
      // count down to the notice deadline while it's still ahead, otherwise to the end date
      const days = noticeDays !== null && noticeDays >= 0 ? noticeDays : endDays;
      return { e, notice, noticeDays, endDays, days };
    })
    .filter(x => x.days <= 60 && (x.endDays >= 0 || (!x.e.endsAtExpiry && x.endDays >= -60)))
    .sort((a, b) => a.days - b.days);

  // Breakdown of this month's expenses, by category or by tag
  const byTag = state.breakdown === 'tag';
  const cats = {};
  for (const e of entries) {
    if (e.type !== 'expense') continue;
    // month: what this calendar month costs (incl. one-offs); year: 12 × today's monthly rate
    const v = yearly ? 12 * R.monthlyAt(e, today) : C.monthAmount(e, now.getFullYear(), now.getMonth());
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

    ${pay.length ? `<section class="card">
      <div class="card-head"><h3>To pay</h3><span class="muted">${pay.filter(x => x.overdue).length ? `${pay.filter(x => x.overdue).length} overdue` : 'manual payments'}</span></div>
      <div class="list">${pay.map(({ e, due, overdue }) => `
        <div class="row pay-item">
          <button class="row-main plain" data-action="edit" data-id="${e.id}">
            <div class="row-title">${esc(e.name)}</div>
            <div class="row-sub ${overdue ? 'neg' : ''}">${overdue ? 'Overdue · was due ' : 'Due '}${fmtDate(due)} · ${relDays(C.daysBetween(today, due))}</div>
          </button>
          <div class="row-amt ${e.type === 'income' ? 'pos' : 'neg'}">${signed(e, dueAmount(e, due))}</div>
          <button class="btn small" data-action="mark-paid" data-id="${e.id}" data-due="${due}">${e.type === 'income' ? 'Received' : 'Mark paid'}</button>
        </div>`).join('')}
      </div></section>` : ''}

    <section class="card summary">
      <div class="summary-top">
        <div class="summary-head">${yearly ? 'Per year at today’s rates' : esc(monthLong.format(now))}</div>
        <div class="seg small">
          <button data-action="period" data-period="month" class="${yearly ? '' : 'on'}">Month</button>
          <button data-action="period" data-period="year" class="${yearly ? 'on' : ''}">Year</button>
        </div>
      </div>
      ${(() => {
        const t = yearly ? yr : cur;
        return `<div class="summary-grid">
        <div><span class="k">Income</span><span class="v pos">${money(t.income)}</span></div>
        <div><span class="k">Expenses</span><span class="v neg">${money(t.expense)}</span></div>
        <div class="net"><span class="k">${filtered ? 'Net for these tags' : 'Left over'}</span><span class="v ${t.net >= 0 ? 'pos' : 'neg'}">${money(t.net)}</span></div>
      </div>`;
      })()}
      <p class="fine">${yearly
        ? 'Everything running today × 12 (one-offs not included).'
        : 'Recurring items are spread evenly per month (e.g. yearly ÷ 12).'}</p>
    </section>

    ${budgets.length ? `<section class="card">
      <div class="card-head"><h3>Budgets</h3><button class="link small-link" data-action="manage-budgets">Edit</button></div>
      <p class="fine">This month</p>
      <div class="cats">${budgets.map(s => `
        <div class="cat">
          <div class="cat-top"><span>${s.budget.kind === 'tag' ? '#' : ''}${esc(s.budget.label)}</span>
            <span>${money(s.spent)} <span class="muted">of ${money(s.budget.amount)}</span></span></div>
          <div class="bar ${s.over ? 'over' : s.near ? 'near' : ''}"><span style="width:${Math.min(100, s.pct * 100).toFixed(1)}%"></span></div>
          <div class="cat-note ${s.over ? 'neg' : ''}">${s.over ? `Over by ${money(-s.left)}` : `${money(s.left)} left`}</div>
        </div>`).join('')}
      </div></section>` : ''}

    ${pd ? (() => {
      const bal = state.settings.balance;
      const balAge = bal ? C.daysBetween(bal.date, today) : 0;
      let running = bal ? bal.amount : 0;
      const rows = pd.items.map(i => {
        running += i.amount;
        return `<div class="pd-row">
          <span class="pd-date">${i.overdue ? '<span class="neg">Overdue</span>' : esc(dayShort.format(C.parse(i.date)))}</span>
          <span class="pd-name">${esc(i.e.name)}</span>
          <span class="pd-amt ${i.amount < 0 ? 'neg' : 'pos'}">${i.amount < 0 ? '−' : '+'}${i.e.variable ? '≈' : ''}${money(Math.abs(i.amount))}</span>
          ${bal ? `<span class="pd-left ${running < 0 ? 'neg' : ''}">${money(running)}</span>` : ''}
        </div>`;
      }).join('');
      const leftAtEnd = bal ? bal.amount + pd.net : null;
      return `<section class="card">
        <div class="card-head"><h3>Until payday</h3><span class="muted">${esc(pd.main.name)} · ${fmtDate(pd.payday)} · ${relDays(pd.days)}</span></div>
        <label class="row static balance-row">
          <div class="row-main"><div class="row-title">Balance now</div>
            <div class="row-sub">${bal ? (balAge > 2 ? `entered ${relDays(-balAge)} — update it for accuracy` : `entered ${relDays(-balAge)}`) : 'Optional — see what’s left after each payment'}</div></div>
          <input id="balance" inputmode="decimal" placeholder="0.00" value="${bal ? bal.amount.toFixed(2) : ''}" aria-label="Current balance">
        </label>
        <div class="pd-summary">
          <div><span class="k">Going out</span><span class="v neg">${money(pd.out)}</span></div>
          ${pd.in ? `<div><span class="k">Coming in</span><span class="v pos">${money(pd.in)}</span></div>` : ''}
          ${bal ? `<div><span class="k">Left before payday</span><span class="v ${leftAtEnd < 0 ? 'neg' : 'pos'}">${money(leftAtEnd)}</span></div>` : ''}
        </div>
        ${pd.items.length ? `<details class="pd-details"${pd.items.length <= 5 ? ' open' : ''}>
          <summary>${pd.items.length} payment${pd.items.length === 1 ? '' : 's'} before payday</summary>
          <div class="pd-list">${rows}</div>
        </details>` : '<p class="fine">Nothing due before payday.</p>'}
      </section>`;
    })() : ''}

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

    ${changes.length ? `<section class="card">
      <div class="card-head"><h3>Biggest changes</h3><span class="muted">since ${monthYear.format(C.parse(sinceISO))}</span></div>
      <div class="list">${changes.map(({ e, before, after, diff, kind }) => {
        const good = e.type === 'income' ? diff > 0 : diff < 0;
        const sub = kind === 'new' ? `New · ${money(after * k)}${per}`
          : kind === 'ended' ? `Ended · was ${money(before * k)}${per}`
          : `${money(before * k)} → ${money(after * k)}${per}`;
        return `<button class="row" data-action="edit" data-id="${e.id}">
          <div class="row-main"><div class="row-title">${esc(e.name)}</div><div class="row-sub">${sub}</div></div>
          <div class="row-amt ${good ? 'pos' : 'neg'}">${diff > 0 ? '+' : '−'}${money(Math.abs(diff) * k)}${per}</div>
        </button>`;
      }).join('')}</div>
      <p class="fine">Change in ${yearly ? 'yearly' : 'monthly'} cost, your share. Green is good for you, red is not.</p>
    </section>` : ''}

    ${contracts.length ? `<section class="card">
      <div class="card-head"><h3>Contracts</h3></div>
      <div class="list">${contracts.map(({ e, notice, noticeDays, endDays, days }) => `
        <button class="row" data-action="edit" data-id="${e.id}">
          <div class="row-main">
            <div class="row-title">${esc(e.name)}</div>
            <div class="row-sub">${endDays < 0
              ? `Out of contract since ${fmtDate(e.contractEnd)} — worth checking for a better deal`
              : noticeDays !== null && noticeDays >= 0
                ? `Give notice by <strong>${fmtDate(notice)}</strong> (${relDays(noticeDays)}) · ends ${fmtDate(e.contractEnd)}`
                : `Ends ${fmtDate(e.contractEnd)} · ${relDays(endDays)} · ${e.endsAtExpiry ? 'will stop' : 'then rolls over'}${notice ? ' · notice date passed' : ''}`}</div>
          </div>
          <span class="pill ${endDays < 0 ? 'warn' : days <= 14 ? 'soon' : ''}">${endDays >= 0 ? `${days}d` : 'Expired'}</span>
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
          <div class="row-amt ${e.type === 'income' ? 'pos' : 'neg'}">${signed(e, dueAmount(e, due))}</div>
        </button>`).join('')}
      </div></section>` : ''}

    ${catList.length ? `<section class="card">
      <div class="card-head"><h3>Where it goes</h3>
        <div class="seg small">
          <button data-action="breakdown" data-by="category" class="${byTag ? '' : 'on'}">Category</button>
          <button data-action="breakdown" data-by="tag" class="${byTag ? 'on' : ''}">Tag</button>
        </div></div>
      <p class="fine">${yearly ? 'Per year at today’s rates' : 'This month'}${byTag ? ' · an entry with several tags counts towards each' : ''}</p>
      <div class="cats">${catList.map(([name, v]) => `
        <div class="cat">
          <div class="cat-top"><span>${esc(name)}</span><span>${money(v)} <span class="muted">${Math.round((v / (yearly ? yr.expense : cur.expense)) * 100)}%</span></span></div>
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
  const yearly = state.settings.period === 'year';
  const per = yearly ? '/yr' : '/mo';
  const k = yearly ? 12 : 1;
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
    const once = e.frequency === 'once';
    const full = once ? (e.payments?.length ? e.payments.reduce((s, p) => s + p.amount, 0) : C.priceOn(e, e.startDate))
                      : C.estimateOn(e, today);
    const due = C.nextDue(e, today);
    const last = C.paymentsOf(e).at(-1);
    const sub = [
      e.category,
      e.method,
      once ? fmtDate(e.startDate) : (C.FREQ[C.freqOn(e, today)].short || C.FREQ[C.freqOn(e, today)].label),
      C.isEnded(e, today) ? `Ended ${fmtDate(C.stopDate(e))}` : (!once && due ? `Next ${fmtDate(due)}` : null),
      e.manual ? 'Paid manually' : null,
      last && !once ? `Last ${money(last.amount)} on ${fmtDate(last.date)}` : null,
    ].filter(Boolean).map(esc).join(' · ');
    const notes = [];
    if (e.share < 100) notes.push(`your ${e.share}% of ${money(full)}`);
    const f = once ? 'once' : C.isIrregular(e, today) ? 'monthly' : C.freqOn(e, today); // no schedule: shown per month
    if (!once && C.isIrregular(e, today) && !yearly) notes.push('about a month');
    // show the per-month (or per-year) figure when it differs from the amount shown
    if (!once && C.monthlyEquivalent(e) > 0 && (yearly ? f !== 'yearly' : f !== 'monthly')) notes.push(`≈ ${money(C.monthlyEquivalent(e) * k)}${per}`);
    const tags = e.tags?.length
      ? `<div class="row-tags">${e.tags.map(t => `<span class="chip tiny">#${esc(t)}</span>`).join('')}</div>` : '';
    return `<button class="row" data-action="edit" data-id="${e.id}">
      <div class="row-main"><div class="row-title">${esc(e.name)}</div><div class="row-sub">${sub}</div>${tags}</div>
      <div class="row-amt ${inc ? 'pos' : 'neg'}">${signed(e, full * C.shareOf(e))}${notes.map(n => `<small>${n}</small>`).join('')}</div>
    </button>`;
  };
  const group = (title, items, extra = '') => items.length
    ? `<div class="group-title">${title}${extra}</div><section class="card list">${items.map(row).join('')}</section>` : '';

  const totals = state.filter === 'all'
    ? ` <span class="muted">${money((totalMonthly('income') - totalMonthly('expense')) * k)}${per} net</span>`
    : ` <span class="muted">${money(totalMonthly(state.filter) * k)}${per}</span>`;

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
      <button class="row" data-action="manage-labels">
        <div class="row-main"><div class="row-title">Manage labels</div>
        <div class="row-sub">Rename, merge or delete categories, payment methods and tags</div></div>
        <span class="chev" aria-hidden="true">›</span>
      </button>
      <button class="row" data-action="manage-budgets">
        <div class="row-main"><div class="row-title">Budgets</div>
        <div class="row-sub">${(state.settings.budgets || []).length
          ? `${state.settings.budgets.length} monthly limit${state.settings.budgets.length === 1 ? '' : 's'}`
          : 'Set monthly limits for a category or tag'}</div></div>
        <span class="chev" aria-hidden="true">›</span>
      </button>
      ${(() => {
        const incomes = state.entries.filter(e => e.type === 'income' && e.frequency !== 'once' && !C.isEnded(e) && !C.isIrregular(e));
        if (!incomes.length) return '';
        return `<label class="row static">
          <div class="row-main"><div class="row-title">Payday</div>
          <div class="row-sub">Used for “Until payday” on the Overview</div></div>
          <select id="payday">
            <option value="">Biggest income</option>
            ${incomes.map(e => `<option value="${e.id}" ${state.settings.paydayId === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
          </select>
        </label>`;
      })()}
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
      <button class="row" data-action="export-csv">
        <div class="row-main"><div class="row-title accent">Export spreadsheet (CSV)</div>
        <div class="row-sub">Entries, payments and monthly totals — opens in Excel or Numbers</div></div>
      </button>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
    </section>
    <p class="fine pad-x">${state.entries.length} entries · Last backup: ${state.settings.lastBackup ? fmtDate(localDay(state.settings.lastBackup)) : 'never'}.
      Your data is stored only on this device. Saving a backup to iCloud Drive lets you restore it on another iPhone, iPad or Mac.</p>

    <div class="group-title">Bank statements</div>
    <section class="card list">
      <button class="row" data-action="import-bank">
        <div class="row-main"><div class="row-title accent">Import bank statement (CSV)</div>
        <div class="row-sub">Match transactions to your bills and log them as payments. CommBank and most banks.</div></div>
      </button>
      <input type="file" id="bankFile" accept=".csv,text/csv,text/comma-separated-values" hidden>
      ${accountKeys().map(k => `<div class="row static label-row">
        <div class="row-main"><div class="row-title">${esc(accountName(k))}</div>
        <div class="row-sub">Imported account</div></div>
        <button type="button" class="btn small" data-action="rename-account" data-key="${esc(k)}" aria-label="Rename ${esc(accountName(k))}">Rename</button>
      </div>`).join('')}
      ${entryRuleCount() ? `<button class="row" data-action="forget-rules">
        <div class="row-main"><div class="row-title accent">Forget remembered matches</div>
        <div class="row-sub">${entryRuleCount()} payee${entryRuleCount() === 1 ? '' : 's'} currently go straight to an entry. “Always ignore” choices are kept.</div></div>
      </button>` : ''}
      ${hasImportData() ? `<button class="row" data-action="undo-imports">
        <div class="row-main"><div class="row-title danger">Undo bank imports…</div>
        <div class="row-sub">Remove imported payments, entries imports added, remembered matches and ignored transactions, to start again.</div></div>
      </button>` : ''}
    </section>
    <p class="fine pad-x">Download a CSV from your bank's website or app first. The file is read on this device only.
      ${Object.keys(state.settings.payeeNames || {}).length ? `${Object.keys(state.settings.payeeNames).length} payees with your own names.` : ''}
      To name a payee, tap <strong>Name</strong> next to it when importing.</p>

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

/** One row of an entry's history: date (or "From the start"), amount and how often. */
function priceRow(p, first) {
  const opts = Object.entries(C.FREQ)
    .filter(([k]) => first || k !== 'once') // only the first row can be a one-off
    .map(([k, f]) => `<option value="${k}" ${p.frequency === k ? 'selected' : ''}>${f.label}</option>`).join('');
  return `<div class="field price-row">
    <div class="pr-top">
      ${first ? '<span class="pfrom-start">From the start</span><input type="hidden" name="pfrom" value="">'
              : `<span class="pr-label">From</span><input type="date" name="pfrom" value="${esc(p.from)}" aria-label="Change starts on">`}
      ${first ? '' : '<button type="button" class="icon-btn small" data-remove-price aria-label="Remove this change">−</button>'}
    </div>
    <div class="pr-bottom">
      <input name="pamount" inputmode="decimal" placeholder="0.00" value="${p.amount ?? ''}" aria-label="Amount">
      <select name="pfreq" aria-label="How often">${opts}</select>
    </div>
  </div>`;
}

/** Which payee an imported payment came from (older payments: worked out from the bank's text in the note). */
const payeeOfPayment = p => (p.source ? p.payee || Bank.payeeKey((p.note || '').split(' · ').at(-1)) : null);
const payeeLabel = key => state.settings.payeeNames?.[key] || Bank.payeeName(key);

/**
 * "Payees" on an entry that has imported payments from more than one payee (e.g. the catch-all
 * "Everyday spending"): each payee's total, with Move to… another entry or a new one of its own.
 */
function payeesSection(entry) {
  const by = new Map();
  for (const p of entry.payments || []) {
    const k = payeeOfPayment(p);
    if (!k) continue;
    const g = by.get(k) || { key: k, n: 0, total: 0, last: '' };
    g.n++; g.total += p.amount; g.last = p.date > g.last ? p.date : g.last;
    by.set(k, g);
  }
  if (by.size < (isCatchAll(entry) ? 1 : 2)) return ''; // a catch-all lists even its last payee
  const groups = [...by.values()].sort((a, b) => b.total - a.total);
  const targets = state.entries.filter(e => e.type === entry.type && e.id !== entry.id && !isCatchAll(e))
    .sort((a, b) => a.name.localeCompare(b.name));
  return `<div class="group-title">Payees (${groups.length})</div>
    <section class="card form">${groups.map(g => `
      <label class="field payee-row"><span>${esc(payeeLabel(g.key))}<br>
        <span class="muted small-text">${g.n} payment${g.n === 1 ? "" : "s"} · ${money(g.total)} · last ${esc(fmtDate(g.last))}</span></span>
        <select data-move-payee="${esc(g.key)}" aria-label="Move ${esc(payeeLabel(g.key))} to">
          <option value="" selected>Move to…</option>
          <option value="new">+ New entry: ${esc(payeeLabel(g.key))}</option>
          ${targets.map(e => `<option value="${esc(e.id)}">${esc(e.name)}</option>`).join('')}
        </select></label>`).join('')}
    </section>
    <p class="fine pad-x">Move a payee's payments to another entry, or into an entry of its own. Future imports send that
      payee there too.</p>`;
}

/** Move all of one payee's imported payments from an entry to another (or a new) entry. */
async function movePayee(from, key, to) {
  const pays = (from.payments || []).filter(p => payeeOfPayment(p) === key);
  if (!pays.length) return;
  const now = new Date().toISOString();
  let dest;
  if (to === 'new') {
    const sorted = [...pays].sort((a, b) => a.date.localeCompare(b.date));
    const one = pays.length === 1;
    const frequency = one ? 'once' : 'irregular';
    const start = sorted[0].date;
    dest = normalizeEntry({
      id: uid(), type: from.type, name: payeeLabel(key), category: '', method: from.method, frequency, startDate: start,
      contractEnd: null, endsAtExpiry: false, endDate: null, notes: `Moved out of ${from.name}`, tags: [], fromImport: true,
      prices: [{ from: start, amount: one ? Math.abs(sorted[0].amount) : null, frequency }],
      variable: !one, manual: false, share: 100, noticeDays: null, payments: [], createdAt: now, updatedAt: now,
    });
  } else {
    dest = state.entries.find(e => e.id === to);
  }
  if (!dest) return;
  const moved = pays.map(p => ({ ...p, payee: key, due: Bank.nearestDue(dest, p.date) }));
  const ids = new Set(pays.map(p => p.id));
  await db.putEntries([
    normalizeEntry({ ...from, payments: from.payments.filter(p => !ids.has(p.id)), updatedAt: now }),
    normalizeEntry({ ...dest, payments: [...(dest.payments || []), ...moved], updatedAt: now }),
  ]);
  if (dest.frequency !== 'once') {
    state.settings.payeeRules = { ...(state.settings.payeeRules || {}), [key]: dest.id };
    await saveSettings();
  }
  await reload();
  const fresh = state.entries.find(e => e.id === from.id);
  if (fresh) openSheet(fresh); // redraw in place, ready to move the next payee
  else closeSheet();
  toast(`Moved ${pays.length} payment${pays.length === 1 ? '' : 's'} to ${dest.name}`); // after the redraw, or it's wiped
}

/** One logged payment: date, Paid/Credit toggle, amount (full bill). */
function payRow(p) {
  const credit = p.amount < 0;
  return `<div class="field pay-row">
    <input type="date" name="paydate" value="${esc(p.date)}" aria-label="Paid on">
    <button type="button" class="chip sign ${credit ? 'credit' : ''}" data-sign aria-label="Payment or credit">${credit ? 'Credit' : 'Paid'}</button>
    <input name="payamount" inputmode="decimal" placeholder="0.00" value="${p.amount === '' ? '' : Math.abs(p.amount).toFixed(2)}" aria-label="Amount">
    <input type="hidden" name="paysign" value="${credit ? -1 : 1}">
    <input type="hidden" name="paydue" value="${esc(p.due || '')}">
    <input type="hidden" name="payid" value="${esc(p.id || '')}">
    <button type="button" class="icon-btn small" data-remove-payment aria-label="Remove payment">−</button>
    ${p.note ? `<div class="pay-note">${esc(p.note)}</div>` : ''}
  </div>`;
}

function openSheet(entry = null) {
  const isNew = !entry;
  const e = entry || { type: 'expense', frequency: 'monthly', startDate: C.todayISO(), prices: [{ from: C.todayISO(), amount: '' }] };
  const all = C.sortedPrices(e);
  const prices = e.frequency === 'once' ? all.slice(0, 1) : all; // a one-off only ever uses its first amount

  sheet.innerHTML = `
  <form id="entryForm" novalidate>
    <div class="sheet-head">
      <button type="button" class="link" data-close>Cancel</button>
      <h2 tabindex="-1" autofocus>${isNew ? 'New entry' : 'Edit entry'}</h2>
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
        ${isNew ? `<label class="field"><span class="lbl-amount">Amount</span>
          <input name="amount" inputmode="decimal" placeholder="0.00" value="" enterkeyhint="done"></label>` : ''}
        ${isNew ? `<label class="field"><span>How often</span>
          <select name="frequency">${Object.entries(C.FREQ).map(([k, f]) =>
            `<option value="${k}" ${e.frequency === k ? 'selected' : ''}>${f.label}</option>`).join('')}</select></label>` : ''}
        <label class="field"><span class="lbl-start">First payment</span>
          <input type="date" name="startDate" value="${esc(e.startDate)}"></label>
      </section>

      ${isNew ? '' : `
      <div class="group-title"><span class="fixed-only">Amount &amp; frequency history</span><span class="variable-only">Frequency history</span></div>
      <section class="card form" id="prices">${prices.map((p, i) => priceRow(p, i === 0)).join('')}</section>
      <p class="fine pad-x recurring-only fixed-only">Add a change when the price goes up or down, or you switch how often you pay
        (e.g. yearly → monthly). For a frequency change, use the date of the first payment on the new schedule.</p>
      <p class="fine pad-x variable-only">${(() => {
        // worked out as a varying bill, so it's right even if the switch is only just being turned on
        const est = C.estimateOn({ ...e, variable: true }, C.todayISO());
        const logged = (e.payments || []).filter(p => p.amount > 0).length;
        const noSchedule = C.isIrregular(e, C.todayISO());
        const now = est <= 0 ? 'No estimate yet. Log a payment below to set one.'
          : noSchedule ? `Current estimate: <strong>≈${money(est)}</strong> a month — ${logged
            ? 'the average of your last three complete months of logged payments.'
            : 'the amount entered earlier, until you log payments.'} With no set schedule there are no due dates.`
          : `Current estimate: <strong>≈${money(est)}</strong> per payment — ${logged
            ? 'worked out from your logged payments (average of the latest three).'
            : 'the amount entered earlier, until you log payments.'}`;
        return `${now}
          Amounts come from the payments you log; add a change here only when how often you pay changes.`;
      })()}</p>
      <button type="button" class="link add-price recurring-only" data-add-price>+ Add change</button>`}

      <div class="group-title">How it's paid</div>
      <section class="card form">
        <label class="field toggle"><span>Amount varies</span>
          <input type="checkbox" name="variable" ${e.variable ? 'checked' : ''}></label>
        <label class="field toggle"><span>Manual payment</span>
          <input type="checkbox" name="manual" ${e.manual ? 'checked' : ''}></label>
        <label class="field"><span>Your share</span>
          <input name="share" inputmode="decimal" value="${e.share ?? 100}" aria-label="Your share in percent"><i class="suffix">%</i></label>
      </section>
      <p class="fine pad-x"><strong>Amount varies</strong> (e.g. utilities): no fixed amount needed — log real payments
        and the estimate is the average of your latest three. <strong>Manual</strong>: it appears under “To pay” with a Mark paid button.
        <strong>Your share</strong>: for split bills, only your part counts in the budget.</p>

      <div class="group-title">Payments made</div>
      <section class="card form" id="payments">${C.paymentsOf(e).reverse().map(payRow).join('')}</section>
      <button type="button" class="link add-price" data-add-payment>+ Log payment</button>
      ${entry ? payeesSection(entry) : ''}

      <section class="card form">
        <label class="field"><span>Category</span>
          <input name="category" list="dl-cat" placeholder="Choose or type" value="${esc(e.category)}" autocomplete="off" maxlength="40"></label>
        <label class="field"><span>Payment method</span>
          <input name="method" list="dl-method" placeholder="Choose or type" value="${esc(e.method)}" autocomplete="off" maxlength="40"></label>
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
        <label class="field"><span>Notice needed</span>
          <input name="noticeDays" inputmode="numeric" placeholder="0" value="${e.noticeDays ?? ''}" aria-label="Notice needed in days"><i class="suffix">days</i></label>
        <label class="field toggle"><span>Stop when contract ends</span>
          <input type="checkbox" name="endsAtExpiry" ${e.endsAtExpiry ? 'checked' : ''}></label>
        <label class="field"><span>Cancelled on</span>
          <input type="date" name="endDate" value="${esc(e.endDate || '')}"></label>
      </section>
      <p class="fine pad-x recurring-only">Contract end is optional — you'll get a heads-up on the Overview as it approaches
        (or as the notice deadline approaches, if the contract needs notice). Set “Cancelled on” once you stop paying.</p>

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
    $('#dl-cat').innerHTML = categoryOptions(type).map(c => `<option value="${esc(c)}">`).join('');
    form.classList.toggle('is-income', type === 'income');
  };
  // New entries pick frequency at the top; existing ones in the first history row.
  const freqSelect = () => form.querySelector('select[name=frequency]') || form.querySelector('select[name=pfreq]');
  const syncFreq = () => {
    const once = freqSelect().value === 'once';
    const irregular = !!C.FREQ[freqSelect().value]?.irregular;
    form.classList.toggle('is-once', once);
    form.classList.toggle('is-irregular', irregular);
    $('.lbl-start', form).textContent = once ? 'Date' : irregular ? 'Started'
      : (form.type.value === 'income' ? 'First received' : 'First payment');
    // No set schedule: amounts always come from the payments logged
    if (irregular && !form.variable.checked) { form.variable.checked = true; syncVariable(); }
    else if (form.amount) syncVariable();
  };
  // "Amount varies": amounts come from logged payments, so they're optional / hidden in the history
  const syncVariable = () => {
    const v = form.variable.checked;
    form.classList.toggle('is-variable', v);
    if (form.amount) {
      const irregular = !!C.FREQ[freqSelect().value]?.irregular;
      $('.lbl-amount', form).textContent = irregular ? 'About per month' : v ? 'Estimate' : 'Amount';
      form.amount.placeholder = v ? 'Optional' : '0.00';
    }
  };
  $('#dl-method').innerHTML = methodOptions().map(c => `<option value="${esc(c)}">`).join('');
  syncType(); syncVariable(); syncFreq();

  // Tag editor
  let tags = normalizeTags(e.tags);
  const tagInput = $('#tagInput', form);
  const renderTags = () => {
    $('#tagChips', form).innerHTML = tags.map(t =>
      `<button type="button" class="chip on" data-remove-tag="${esc(t)}" aria-label="Remove tag ${esc(t)}">#${esc(t)} <span aria-hidden="true">×</span></button>`).join('');
    const q = cleanTag(tagInput.value);
    // your own tags first, then starter ideas you haven't used yet
    const suggestions = [...new Set([...allTags(), ...STARTER_TAGS])]
      .filter(t => !tags.includes(t) && (!q || t.includes(q))).slice(0, 12);
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
    if (ev.target.name === 'frequency' || ev.target.name === 'pfreq') syncFreq();
    if (ev.target.name === 'variable') syncVariable();
  });
  form.addEventListener('click', ev => {
    const rm = ev.target.closest('[data-remove-tag]');
    const add = ev.target.closest('[data-add-tag]');
    if (rm) { tags = tags.filter(t => t !== rm.dataset.removeTag); renderTags(); }
    else if (add) { tagInput.value = ''; addTags([add.dataset.addTag]); }
    else if (ev.target.closest('[data-close]')) closeSheet();
    else if (ev.target.closest('[data-add-price]')) {
      const freqs = [...form.querySelectorAll('select[name=pfreq]')].map(s => s.value).filter(v => v !== 'once');
      const lastFreq = freqs.at(-1) || 'monthly';
      $('#prices', form).insertAdjacentHTML('beforeend', priceRow({ from: C.todayISO(), amount: '', frequency: lastFreq }, false));
      $('#prices .price-row:last-child input[name=pamount]', form).focus();
    } else if (ev.target.closest('[data-remove-price]')) ev.target.closest('.price-row').remove();
    else if (ev.target.closest('[data-add-payment]')) {
      const est = entry ? C.estimateOn(entry, C.todayISO()) : C.parseAmount(form.amount?.value) || 0;
      $('#payments', form).insertAdjacentHTML('afterbegin',
        payRow({ date: C.todayISO(), amount: est ? Math.round(est * 100) / 100 : '' }));
      $('#payments .pay-row input[name=payamount]', form).select();
    } else if (ev.target.closest('[data-remove-payment]')) ev.target.closest('.pay-row').remove();
    else if (ev.target.closest('[data-sign]')) {
      const b = ev.target.closest('[data-sign]');
      const credit = !b.classList.contains('credit');
      b.classList.toggle('credit', credit);
      b.textContent = credit ? 'Credit' : 'Paid';
      b.closest('.pay-row').querySelector('[name=paysign]').value = credit ? -1 : 1;
    }
    else if (ev.target.closest('[data-delete]')) deleteEntry(entry);
  });
  form.addEventListener('submit', ev => { ev.preventDefault(); saveForm(form, entry); });
  form.addEventListener('change', ev => {
    const s = ev.target.closest('select[data-move-payee]');
    if (s && s.value) movePayee(entry, s.dataset.movePayee, s.value);
  });

  document.body.classList.add('modal-open');
  if (!sheet.open) sheet.showModal();
  sheet.scrollTop = 0;
  if (isNew) setTimeout(() => form.name.focus(), 350);
}

// ---------- Budgets sheet ----------
let editingBudget = null;

function openBudgets() {
  const budgets = state.settings.budgets || [];
  const now = new Date();
  const b = editingBudget ? budgets.find(x => x.id === editingBudget) : null;
  const kind = b?.kind || 'category';
  sheet.innerHTML = `
  <div id="budgets">
    <div class="sheet-head"><span></span><h2 tabindex="-1" autofocus>Budgets</h2>
      <button type="button" class="link strong" data-close>Done</button></div>
    <div class="sheet-body">
      <p class="fine manage-help">A monthly limit for a category or a tag. The Overview shows how much of it this month uses,
        and you'll get a warning when a change takes you over.</p>
      ${budgets.length ? `<section class="card list">${budgets.map(x => {
        const s = R.budgetStatus(state.entries, x, now.getFullYear(), now.getMonth());
        return `<div class="row static label-row">
          <div class="row-main"><div class="row-title">${x.kind === 'tag' ? '#' : ''}${esc(x.label)}</div>
            <div class="row-sub ${s.over ? 'neg' : ''}">${money(x.amount)}/mo · ${money(s.spent)} this month</div></div>
          <button type="button" class="btn small" data-edit-budget="${x.id}">Edit</button>
          <button type="button" class="btn small danger" data-delete-budget="${x.id}">Delete</button>
        </div>`;
      }).join('')}</section>` : ''}

      <div class="group-title">${b ? 'Edit budget' : 'Add a budget'}</div>
      <form id="budgetForm" class="card form" novalidate>
        <div class="field"><span>For</span>
          <div class="seg small grow">
            <label><input type="radio" name="kind" value="category" ${kind === 'category' ? 'checked' : ''}><span>Category</span></label>
            <label><input type="radio" name="kind" value="tag" ${kind === 'tag' ? 'checked' : ''}><span>Tag</span></label>
          </div></div>
        <label class="field"><span>Name</span>
          <input name="label" list="dl-budget" placeholder="e.g. Subscriptions" value="${esc(b?.label || '')}" autocomplete="off" autocapitalize="none"></label>
        <label class="field"><span>Monthly limit</span>
          <input name="amount" inputmode="decimal" placeholder="0.00" value="${b ? b.amount.toFixed(2) : ''}"></label>
        <datalist id="dl-budget"></datalist>
      </form>
      <p class="form-error" id="budgetError" role="alert"></p>
      <button type="button" class="btn primary" data-save-budget>${b ? 'Save budget' : 'Add budget'}</button>
      ${b ? '<button type="button" class="btn" data-cancel-edit>Cancel editing</button>' : ''}
    </div>
  </div>`;

  const root = $('#budgets');
  const form = $('#budgetForm');
  const syncList = () => {
    const k = form.kind.value;
    const opts = k === 'tag' ? allTags() : categoryOptions('expense');
    $('#dl-budget').innerHTML = opts.map(o => `<option value="${esc(o)}">`).join('');
    form.label.placeholder = k === 'tag' ? 'e.g. streaming' : 'e.g. Subscriptions';
  };
  syncList();
  form.addEventListener('change', ev => { if (ev.target.name === 'kind') syncList(); });
  form.addEventListener('submit', ev => ev.preventDefault());

  root.addEventListener('click', async ev => {
    const t = ev.target;
    if (t.closest('[data-close]')) { editingBudget = null; return closeSheet(); }
    const ed = t.closest('[data-edit-budget]');
    const del = t.closest('[data-delete-budget]');
    if (ed) { editingBudget = ed.dataset.editBudget; return openBudgets(); }
    if (t.closest('[data-cancel-edit]')) { editingBudget = null; return openBudgets(); }
    if (del) {
      const x = budgets.find(y => y.id === del.dataset.deleteBudget);
      if (!x || !confirm(`Delete the budget for “${x.label}”?`)) return;
      state.settings.budgets = budgets.filter(y => y.id !== x.id);
      await saveSettings();
      toast('Budget deleted');
      return openBudgets();
    }
    if (t.closest('[data-save-budget]')) {
      const k = form.kind.value;
      const label = k === 'tag' ? cleanTag(form.label.value) : canonicalLabel(form.label.value, categoryOptions('expense'));
      const amount = C.parseAmount(form.amount.value);
      const showErr = m => { $('#budgetError').textContent = m; };
      if (!label) return showErr('Please choose a category or tag.');
      if (!(amount > 0)) return showErr('Please enter a monthly limit.');
      const dup = budgets.find(y => y.kind === k && y.label.toLowerCase() === label.toLowerCase() && y.id !== editingBudget);
      if (dup) return showErr(`There's already a budget for “${dup.label}”.`);
      const rec = { id: editingBudget || uid(), kind: k, label, amount: Math.round(amount * 100) / 100 };
      state.settings.budgets = editingBudget ? budgets.map(y => (y.id === editingBudget ? rec : y)) : [...budgets, rec];
      editingBudget = null;
      await saveSettings();
      toast('Budget saved');
      openBudgets();
    }
  });

  if (!sheet.open) { document.body.classList.add('modal-open'); sheet.showModal(); }
}

// ---------- Bank statement import ----------
let imp = null; // the import being reviewed

/**
 * Each import account has catch-all entries, "Everyday spending – <account>" and "Other income –
 * <account>", for transactions that aren't matched to anything. Payees can be moved out of them later.
 */
const catchKey = (account, type) => `${account.toLowerCase()}|${type}`;
const catchName = (account, type) => `${type === 'income' ? 'Other income' : 'Everyday spending'} – ${accountName(account)}`;
const catchEntry = (account, type) => state.entries.find(e => e.catchAll === catchKey(account, type));
const isCatchAll = e => !!e.catchAll;

/**
 * Import accounts are stored by the name first used for them (it's part of each transaction's id).
 * accountNames holds an optional newer display name, so an account can be renamed safely.
 */
const accountKeys = () => state.settings.bankAccounts || [];
const accountName = key => state.settings.accountNames?.[key.toLowerCase()] || key;
const findAccount = name => {
  const n = cleanLabel(name).toLowerCase();
  return accountKeys().find(k => k.toLowerCase() === n || accountName(k).toLowerCase() === n);
};

const entryRuleCount = () => Object.values(state.settings.payeeRules || {}).filter(v => v !== 'ignore').length;
const importedPaymentCount = () => state.entries.reduce((n, e) => n + (e.payments || []).filter(p => p.source).length, 0);

async function forgetRules() {
  const n = entryRuleCount();
  if (!confirm(`Forget the remembered matches for ${n} payee${n === 1 ? '' : 's'}? Payments already logged stay as they are. Payees you chose to always ignore stay ignored.`)) return;
  state.settings.payeeRules = Object.fromEntries(Object.entries(state.settings.payeeRules || {}).filter(([, v]) => v === 'ignore'));
  await saveSettings();
  render();
  toast('Remembered matches forgotten');
}

/** Entries that "Add as entry" created during a bank import. */
const createdByImport = e => !!e.fromImport || /^Added from a bank import/.test(e.notes || '');
const hasImportData = () => importedPaymentCount() > 0 || entryRuleCount() > 0
  || (state.settings.ignoredTxns || []).length > 0 || state.entries.some(createdByImport);

/**
 * "Undo bank imports": shows what imports left behind and removes it, so statements can be
 * imported again from scratch. Entries an import created are listed so you can keep the good ones.
 */
function openUndoImports() {
  const created = state.entries.filter(createdByImport).sort((a, b) => a.name.localeCompare(b.name));
  const pays = importedPaymentCount();
  const rules = entryRuleCount();
  const ignored = (state.settings.ignoredTxns || []).length;
  const n = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  sheet.innerHTML = `
  <form id="undoImports" method="dialog">
    <div class="sheet-head">
      <button type="button" class="link" data-close>Cancel</button>
      <h2 tabindex="-1" autofocus>Undo bank imports</h2>
      <span></span>
    </div>
    <div class="sheet-body">
      <p class="fine pad-x">Removes what bank imports added, so you can import your statements again from scratch.
        Export a backup first if you might want it back.</p>
      <section class="card form">
        <label class="field toggle"><span>Remove ${n(pays, 'imported payment')}</span>
          <input type="checkbox" name="payments" ${pays ? 'checked' : 'disabled'}></label>
        <label class="field toggle"><span>Forget ${n(rules, 'remembered match', 'remembered matches')}</span>
          <input type="checkbox" name="rules" ${rules ? 'checked' : 'disabled'}></label>
        <label class="field toggle"><span>Show ${n(ignored, 'ignored transaction')} again</span>
          <input type="checkbox" name="ignored" ${ignored ? 'checked' : 'disabled'}></label>
      </section>
      ${created.length ? `<div class="group-title">Entries added by imports (${created.length}) — switch off any to keep</div>
      <section class="card form">${created.map(e => `
        <label class="field toggle"><span>${esc(e.name)}<br><span class="muted small-text">${esc(C.FREQ[e.frequency]?.label || '')} · from ${esc(fmtDate(e.startDate))}</span></span>
          <input type="checkbox" name="del" value="${esc(e.id)}" checked></label>`).join('')}
      </section>` : ''}
      <p class="fine pad-x">Kept: payments you logged yourself, your other entries, your names for payees, account names
        and payees you chose to always ignore.</p>
      <button type="button" class="btn primary danger-fill" data-undo>Undo imports</button>
    </div>
  </form>`;
  const form = $('#undoImports');
  form.addEventListener('click', async ev => {
    if (ev.target.closest('[data-close]')) return closeSheet();
    if (!ev.target.closest('[data-undo]')) return;
    const del = new Set([...form.querySelectorAll('[name=del]:checked')].map(x => x.value));
    const what = [
      form.payments.checked && n(pays, 'payment'),
      del.size && n(del.size, 'entry', 'entries'),
    ].filter(Boolean);
    if (what.length && !confirm(`Delete ${what.join(' and ')}? This can't be undone.`)) return;
    const now = new Date().toISOString();
    if (form.payments.checked) {
      const changed = state.entries.filter(e => !del.has(e.id) && (e.payments || []).some(p => p.source)).map(e => ({
        ...e, updatedAt: now,
        // A payment you logged yourself and an import then matched goes back to being yours.
        payments: e.payments.filter(p => !p.source || p.handLogged).map(p => {
          if (!p.source) return p;
          const { source, handLogged, ...mine } = p;
          return mine;
        }),
      }));
      if (changed.length) await db.putEntries(changed);
    }
    for (const id of del) await db.deleteEntry(id);
    const keptRules = Object.entries(state.settings.payeeRules || {})
      .filter(([, v]) => (form.rules.checked ? v === 'ignore' : !del.has(v)));
    state.settings.payeeRules = Object.fromEntries(keptRules);
    if (form.ignored.checked) state.settings.ignoredTxns = [];
    await saveSettings();
    closeSheet();
    await reload();
    toast('Bank imports undone');
  });
  if (!sheet.open) { document.body.classList.add('modal-open'); sheet.showModal(); }
}

/** Give a payee your own name, used on the import screen, for matching and in payment notes. */
async function renamePayee(keys) {
  keys = [].concat(keys); // a row on the import screen can stand for several payees with the same name
  const key = keys[0];
  const names = { ...(state.settings.payeeNames || {}) };
  const sample = imp?.txns.find(t => t.payee === key);
  const current = names[key] || (sample?.oldPayee && names[sample.oldPayee]) || '';
  const input = prompt(`Your name for “${sample?.description || key}”. It's used for this payee from now on. Give two payees the same name to put them together. Leave blank to use the bank's text.`,
    current || Bank.payeeName(key));
  if (input == null) return;
  const name = cleanLabel(input);
  for (const k of keys) {
    const s = imp?.txns.find(t => t.payee === k);
    if (s?.oldPayee) delete names[s.oldPayee];
    if (name) names[k] = name; else delete names[k];
  }
  state.settings.payeeNames = names;
  await saveSettings();
  toast(name ? `Named “${name}”` : 'Name removed');
}

async function renameAccount(key) {
  const from = accountName(key);
  const input = prompt(`Rename the account “${from}” to:`, from);
  if (input == null) return;
  const to = cleanLabel(input);
  if (!to || to === from) return;
  const clash = findAccount(to);
  if (clash && clash !== key) { alert(`There's already an account called “${accountName(clash)}”.`); return; }
  const names = { ...(state.settings.accountNames || {}) };
  if (to.toLowerCase() === key.toLowerCase()) delete names[key.toLowerCase()];
  else names[key.toLowerCase()] = to;
  state.settings.accountNames = names;
  // Entries added from an import use the account as their payment method; keep those in step.
  const now = new Date().toISOString();
  // …and the account's catch-all entries keep its name in theirs.
  const isCatchOf = e => e.catchAll && e.catchAll.startsWith(`${key.toLowerCase()}|`);
  const changed = state.entries.filter(e => (e.method || '').toLowerCase() === from.toLowerCase() || isCatchOf(e))
    .map(e => ({ ...e, method: (e.method || '').toLowerCase() === from.toLowerCase() ? to : e.method,
      name: isCatchOf(e) ? catchName(key, e.catchAll.split('|').at(-1)) : e.name, updatedAt: now }));
  if (changed.length) await db.putEntries(changed);
  await saveSettings();
  await reload();
  toast(changed.length ? `Renamed · ${changed.length} entr${changed.length === 1 ? 'y' : 'ies'} updated` : 'Account renamed');
}

async function startBankImport(file) {
  let text;
  try { text = await file.text(); } catch { alert('Couldn’t read that file.'); return; }
  const rows = Bank.parseCSV(text);
  const fmt = Bank.detectFormat(rows);
  if (!fmt) {
    alert('This file wasn’t recognised as a bank statement. It needs a date, an amount and a description in each row (CommBank CSVs work as they are).');
    return;
  }
  const detected = Bank.detectDateOrder(rows.slice(fmt.hasHeader ? 1 : 0).map(r => r[fmt.date]));
  const order = detected || (REGION === 'US' ? 'MDY' : 'DMY');
  const guess = `${fmt.bank} ${fmt.kind === 'card' ? 'credit card' : 'account'}`;
  // Pick the account this file most likely belongs to: one its transactions were already imported
  // into, else one with the suggested name, else the most recently used.
  const known = new Set(state.entries.flatMap(e => (e.payments || []).map(p => p.source).filter(Boolean)));
  (state.settings.ignoredTxns || []).forEach(id => known.add(id));
  const txns = Bank.toTransactions(rows, fmt, order);
  const seen = accountKeys().find(k => Bank.withIds(txns, k).some(t => known.has(t.id)));
  imp = {
    fileName: file.name, rows, fmt, order, orderDetected: !!detected, guess,
    account: seen || findAccount(guess) || accountKeys()[0] || guess,
    newAccount: !accountKeys().length, newGroups: new Set(),
  };
  buildImport();
  openImport();
}

/** (Re)work out transactions, duplicates, suggestions and recurring groups for the current settings. */
function buildImport() {
  const all = Bank.withIds(Bank.toTransactions(imp.rows, imp.fmt, imp.order), imp.account);
  const known = new Set([
    ...state.entries.flatMap(e => (e.payments || []).map(p => p.source).filter(Boolean)),
    ...(state.settings.ignoredTxns || []),
  ]);
  const fresh = all.filter(t => !known.has(t.id));
  imp.total = all.length;
  imp.already = all.length - fresh.length;
  imp.txns = Bank.suggest(fresh, state.entries.filter(e => !isCatchAll(e) && !C.isEnded(e, C.addDaysISO(C.todayISO(), -90))),
    state.settings.payeeRules || {}, state.settings.payeeNames || {})
    .sort((a, b) => b.date.localeCompare(a.date));
  // Everything imports unless you say otherwise: matches go to their entry, payees that look
  // recurring get an entry of their own, and the rest go to the account's catch-all entry.
  imp.recurring = Bank.findRecurring(imp.txns.filter(t => !t.action));
  imp.offGroups ||= new Set(); // recurring groups you switched off
  imp.newGroups = new Set(imp.recurring.map(g => g.key).filter(k => !imp.offGroups.has(k)));
  const groupOf = new Map(imp.recurring.flatMap(g => g.txns.map(t => [t.id, g.key])));
  const byDefault = t => t.action
    || (imp.newGroups.has(groupOf.get(t.id)) ? `new:${groupOf.get(t.id)}` : `catch:${t.amount < 0 ? 'expense' : 'income'}`);
  // Keep choices the user made by hand when this is a redraw (e.g. after renaming a payee).
  const prev = imp.decision, prevSuggested = imp.suggested;
  imp.suggested = new Map(imp.txns.map(t => [t.id, byDefault(t)]));
  imp.decision = new Map(imp.txns.map(t => [t.id,
    prev?.has(t.id) && prev.get(t.id) !== prevSuggested.get(t.id) ? prev.get(t.id) : imp.suggested.get(t.id)]));
  imp.links = new Map();
  for (const [id, d] of imp.decision) if (d.startsWith('new:') && !imp.newGroups.has(d.slice(4))) imp.decision.set(id, imp.suggested.get(id));
  imp.range = all.length ? [all.reduce((m, t) => (t.date < m ? t.date : m), all[0].date), all.reduce((m, t) => (t.date > m ? t.date : m), all[0].date)] : null;
}

/** Which transactions update a payment the user already logged by hand (for the current choices). */
const importLinks = () => Bank.planLinks(imp.txns, imp.decision, new Map(state.entries.map(e => [e.id, e])));

function openImport() {
  imp.links = importLinks();
  const sample = imp.rows[imp.fmt.hasHeader ? 1 : 0]?.[imp.fmt.date] || '';
  const sampleISO = Bank.parseDate(sample, imp.order);
  const entriesBy = type => state.entries.filter(e => e.type === type && !isCatchAll(e)).sort((a, b) => a.name.localeCompare(b.name));
  const groupOf = new Map(imp.recurring.flatMap(g => g.txns.map(t => [t.id, g])));

  // New entries this import will add, so other payees can be put in with them
  const txById = new Map(imp.txns.map(t => [t.id, t]));
  const pending = new Map();
  for (const [id, v] of imp.decision) {
    if (pending.has(v)) continue;
    const t = txById.get(id);
    if (v.startsWith('new:')) {
      const g = imp.recurring.find(x => x.key === v.slice(4));
      if (g) pending.set(v, { label: `${g.name} (${C.FREQ[g.frequency].label.toLowerCase()})`, out: g.type === 'expense' });
    } else if (v.startsWith('make:')) {
      const lead = imp.txns.find(x => x.payee === v.slice(5)) || t;
      pending.set(v, { label: lead.name || Bank.payeeName(v.slice(5)), out: t.amount < 0 });
    }
  }

  // `d` is the current choice (null when the transactions in a payee row differ)
  const select = (t, { attr = `data-txn="${t.id}"`, d = imp.decision.get(t.id) || '', many = false, label = 'What is this?' } = {}) => {
    const g = groupOf.get(t.id);
    const opt = (v, text) => `<option value="${esc(v)}" ${d === v ? 'selected' : ''}>${esc(text)}</option>`;
    const list = type => entriesBy(type).map(e => opt(e.id, e.name)).join('')
      || '<option disabled>No entries yet</option>';
    // A new entry for this payee: the recurring one spotted, else one with no set schedule (or a
    // one-off if it's the only transaction from them)
    const own = g ? `new:${g.key}` : `make:${t.payee}`;
    const make = g ? opt(own, `+ New entry: ${g.name} (${C.FREQ[g.frequency].label.toLowerCase()})`)
      : opt(own, `+ New entry: ${t.name || Bank.payeeName(t.payee)}`);
    const others = [...pending].filter(([v, p]) => v !== own && p.out === t.amount < 0);
    return `<select ${attr} aria-label="${esc(label)}">
      ${d == null ? '<option value="mixed" selected disabled>Mixed — choose one for all</option>' : ''}
      ${opt('', 'Skip for now')}
      ${opt('ignore', many ? 'Ignore these' : 'Ignore this one')}
      ${opt('ignore-payee', 'Always ignore this payee')}
      ${opt(`catch:${t.amount < 0 ? 'expense' : 'income'}`, catchName(imp.account, t.amount < 0 ? 'expense' : 'income'))}
      ${make}
      ${others.length ? `<optgroup label="New in this import">${others.map(([v, p]) => opt(v, p.label)).join('')}</optgroup>` : ''}
      <optgroup label="${t.amount < 0 ? 'Expenses' : 'Income'}">${list(t.amount < 0 ? 'expense' : 'income')}</optgroup>
      <optgroup label="${t.amount < 0 ? 'Income (as a refund)' : 'Expenses (as a refund)'}">${list(t.amount < 0 ? 'income' : 'expense')}</optgroup>
    </select>`;
  };
  const txRow = t => {
    const d = imp.decision.get(t.id) || '';
    const link = imp.links.get(t.id);
    const tag = (link ? `<span class="pill">already logged${link.date !== t.date ? ` ${esc(fmtDate(link.date))}` : ''}</span>` : '')
      + (t.why === 'rule' ? '<span class="pill">remembered</span>' : t.why === 'match' && d === t.action
        ? `<span class="pill ${t.on.length === 3 ? 'good' : 'soon'}" title="Matched on ${t.on.join(', ')}">${t.on.join(' · ')}</span>` : '');
    return `<div class="imp-row ${d && !d.startsWith('ignore') ? 'chosen' : ''} ${d.startsWith('ignore') ? 'ignored' : ''}">
      <div class="imp-top">
        <span class="imp-date">${esc(fmtDate(t.date))}</span>
        <span class="imp-desc">${t.name ? `<span class="imp-name">${esc(t.name)}</span><span class="imp-raw">${esc(t.description)}</span>` : esc(t.description)}</span>
        <span class="imp-amt ${t.amount < 0 ? 'neg' : 'pos'}">${t.amount < 0 ? '−' : '+'}${money(Math.abs(t.amount))}</span>
      </div>
      <div class="imp-bottom"><button type="button" class="link imp-rename" data-rename-payee="${esc(t.payee)}"
        aria-label="Rename ${esc(t.name || t.description)}">${t.name ? 'Rename' : 'Name'}</button>${tag}${select(t)}</div>
    </div>`;
  };
  const suggested = imp.txns.filter(t => t.action);
  const rest = imp.txns.filter(t => !t.action);
  const chosen = [...imp.decision.values()].filter(v => v && !v.startsWith('ignore')).length;

  // Unmatched transactions, one row per payee (payees you've given the same name share a row):
  // one choice covers all of them.
  const pgroups = new Map();
  for (const t of rest) {
    const name = t.name || Bank.payeeName(t.payee);
    const key = `${t.amount < 0 ? 'out' : 'in'}|${name.toLowerCase()}`;
    if (!pgroups.has(key)) pgroups.set(key, { key, name, named: !!t.name, txns: [], payees: [] });
    const pg = pgroups.get(key);
    pg.txns.push(t);
    if (!pg.payees.includes(t.payee)) pg.payees.push(t.payee);
  }
  imp.pgroups = pgroups;
  imp.openGroups ||= new Set();
  const payeeRow = pg => {
    const ts = pg.txns, t0 = ts[0], one = ts.length === 1;
    const ds = new Set(ts.map(t => imp.decision.get(t.id) || ''));
    const d = ds.size === 1 ? [...ds][0] : null;
    const total = ts.reduce((s, t) => s + t.amount, 0);
    const raws = [...new Set(ts.map(t => t.description))];
    const showName = pg.named || !one;
    const linked = ts.filter(t => imp.links.get(t.id)).length;
    const amt = (a, cls = '') => `<span class="imp-amt ${cls} ${a < 0 ? 'neg' : 'pos'}">${a < 0 ? '−' : '+'}${money(Math.abs(a))}</span>`;
    return `<div class="imp-row imp-payee ${d && d !== 'mixed' && !d.startsWith('ignore') ? 'chosen' : ''} ${d?.startsWith('ignore') ? 'ignored' : ''}">
      <div class="imp-top">
        <span class="imp-date">${one ? esc(fmtDate(t0.date)) : `${ts.length} ×`}</span>
        <span class="imp-desc">${showName ? `<span class="imp-name">${esc(pg.name)}</span><span class="imp-raw">${esc(raws[0])}${raws.length > 1 ? ` + ${raws.length - 1} more` : ''}</span>` : esc(t0.description)}</span>
        ${amt(total)}
      </div>
      <div class="imp-bottom"><button type="button" class="link imp-rename" data-rename-group="${esc(pg.key)}"
        aria-label="Rename ${esc(showName ? pg.name : t0.description)}">${pg.named ? 'Rename' : 'Name'}</button>${linked ? `<span class="pill">${linked} already logged</span>` : ''}${select(t0, {
        attr: `data-pgroup="${esc(pg.key)}"`, d, many: !one, label: `What is ${showName ? pg.name : t0.description}?` })}</div>
      ${one ? '' : `<details class="imp-list" data-pg="${esc(pg.key)}" ${imp.openGroups.has(pg.key) ? 'open' : ''}>
        <summary>${ts.length} transactions · ${esc(fmtDate(ts.at(-1).date))} – ${esc(fmtDate(t0.date))}</summary>
        ${ts.map(t => `<div class="imp-sub"><span class="imp-date">${esc(fmtDate(t.date))}</span>
          <span class="imp-sub-desc">${esc(t.description)}</span>${amt(t.amount)}</div>`).join('')}
      </details>`}
    </div>`;
  };
  const payeeList = [...pgroups.values()].sort((a, b) => b.txns.length - a.txns.length || a.name.localeCompare(b.name));

  sheet.innerHTML = `
  <div id="import">
    <div class="sheet-head">
      <button type="button" class="link" data-close>Cancel</button>
      <h2 tabindex="-1" autofocus>Import statement</h2>
      <button type="button" class="link strong" data-apply>Import</button>
    </div>
    <div class="sheet-body">
      <section class="card form">
        <div class="field"><span>File</span><div class="imp-file">${esc(imp.fileName)}<br><span class="muted">${imp.total} transactions${imp.range ? ` · ${fmtDate(imp.range[0])} – ${fmtDate(imp.range[1])}` : ''}</span></div></div>
        ${accountKeys().length ? `<label class="field"><span>Account</span>
          <select id="impAccountPick" aria-label="Account">
            ${accountKeys().map(k => `<option value="${esc(k)}" ${!imp.newAccount && k === imp.account ? 'selected' : ''}>${esc(accountName(k))}</option>`).join('')}
            <option value="" ${imp.newAccount ? 'selected' : ''}>New account…</option>
          </select></label>` : ''}
        ${imp.newAccount ? `<label class="field"><span>${accountKeys().length ? 'New account' : 'Account'}</span>
          <input id="impAccount" value="${esc(imp.account)}" autocomplete="off" aria-label="Account name"></label>` : ''}
        <div class="field"><span>Dates are</span>
          <div class="seg small grow">
            <button type="button" data-order="DMY" class="${imp.order === 'DMY' ? 'on' : ''}">Day/Month</button>
            <button type="button" data-order="MDY" class="${imp.order === 'MDY' ? 'on' : ''}">Month/Day</button>
          </div></div>
      </section>
      <p class="fine pad-x">${imp.orderDetected ? 'Date order detected from the file.' : '<strong>Check the date order:</strong> this file could be read either way.'}
        ${sample ? `First row: ${esc(sample)} → ${sampleISO ? esc(dayMonthYear.format(C.parse(sampleISO))) : 'not a valid date'}.` : ''}
        Choose the same account each time so transactions you've already imported are recognised.
        You can rename an account in Settings.</p>
      ${imp.already ? `<p class="fine pad-x"><strong>${imp.already}</strong> already imported or ignored — skipped.</p>` : ''}

      ${imp.recurring.length ? `<div class="group-title">Looks recurring — not in your entries yet</div>
      <section class="card list">${imp.recurring.map(g => `
        <div class="row static label-row">
          <div class="row-main"><div class="row-title">${esc(g.name)}</div>
            <div class="row-sub">${g.txns.length} × ${g.variable ? '≈' : ''}${money(g.amount)} · ${C.FREQ[g.frequency].label.toLowerCase()} · ${esc(g.payee)}</div></div>
          <button type="button" class="btn small ${imp.newGroups.has(g.key) ? 'on-btn' : ''}" data-new="${esc(g.key)}">${imp.newGroups.has(g.key) ? '✓ Adding' : 'Add as entry'}</button>
        </div>`).join('')}</section>` : ''}

      ${suggested.length ? `<div class="group-title">Matched (${suggested.length})</div>
      <section class="card">${suggested.map(txRow).join('')}</section>` : ''}

      ${rest.length ? `<div class="group-title">Not matched (${payeeList.length} payee${payeeList.length === 1 ? '' : 's'}, ${rest.length} transaction${rest.length === 1 ? '' : 's'})
        <button type="button" class="link small-link" data-ignore-rest>Ignore all of these</button></div>
      <p class="fine pad-x">These go to <strong>${esc(catchName(imp.account, 'expense'))}</strong> (money out) or
        <strong>${esc(catchName(imp.account, 'income'))}</strong> (money in) unless you choose something else.
        Nothing here needs sorting now — give two payees the same name to put them together, or move them later from that entry.</p>
      <section class="card">${payeeList.map(payeeRow).join('')}</section>` : ''}

      ${!imp.txns.length ? '<p class="empty-small">Nothing new in this file.</p>' : ''}
      <p class="fine pad-x">Matched transactions are logged as payments on that entry. Payees you choose yourself, or that
        match an entry's name, are remembered for next time. Set a remembered one to “Skip for now” to
        forget it. “Skip for now” leaves a transaction to decide on a later import.</p>
      <button type="button" class="btn primary" data-apply>Import ${chosen} payment${chosen === 1 ? '' : 's'}</button>
    </div>
  </div>`;

  const root = $('#import');
  root.addEventListener('toggle', ev => {
    const det = ev.target.closest?.('details[data-pg]');
    if (det) det.open ? imp.openGroups.add(det.dataset.pg) : imp.openGroups.delete(det.dataset.pg);
  }, true);
  root.addEventListener('change', ev => {
    const s = ev.target.closest('select[data-txn], select[data-pgroup]');
    if (s) {
      const v = s.value;
      if (s.dataset.pgroup) imp.pgroups.get(s.dataset.pgroup)?.txns.forEach(x => imp.decision.set(x.id, v));
      else imp.decision.set(s.dataset.txn, v);
      // A new entry takes this payee's other undecided transactions too
      if (v.startsWith('new:')) {
        const g = imp.recurring.find(x => x.key === v.slice(4));
        imp.newGroups.add(g.key);
        imp.offGroups.delete(g.key);
        g.txns.forEach(x => { const cur = imp.decision.get(x.id) || ''; if (!cur || cur.startsWith('catch:')) imp.decision.set(x.id, v); });
      }
      if (v.startsWith('make:')) {
        imp.txns.forEach(x => {
          const cur = imp.decision.get(x.id) || '';
          if (x.payee === v.slice(5) && (!cur || cur.startsWith('catch:'))) imp.decision.set(x.id, v);
        });
      }
      // A recurring payee whose transactions were all sent elsewhere isn't added as an entry
      const used = new Set(imp.decision.values());
      for (const k of [...imp.newGroups]) if (!used.has(`new:${k}`)) { imp.newGroups.delete(k); imp.offGroups.add(k); }
      return openImportKeepScroll();
    }
    if (ev.target.id === 'impAccountPick') {
      const k = ev.target.value;
      imp.newAccount = !k;
      imp.account = k || (findAccount(imp.guess) ? `${imp.guess} 2` : imp.guess);
      buildImport(); return openImportKeepScroll();
    }
    if (ev.target.id === 'impAccount') {
      const name = cleanLabel(ev.target.value);
      if (!name) return openImportKeepScroll();
      const existing = findAccount(name); // typed the name of an account that exists: use it
      imp.account = existing || name;
      imp.newAccount = !existing;
      buildImport(); openImportKeepScroll();
    }
  });
  root.addEventListener('click', async ev => {
    const t = ev.target;
    if (t.closest('[data-close]')) { imp = null; return closeSheet(); }
    const o = t.closest('[data-order]');
    if (o) { imp.order = o.dataset.order; buildImport(); return openImportKeepScroll(); }
    const n = t.closest('[data-new]');
    if (n) {
      const g = imp.recurring.find(x => x.key === n.dataset.new);
      const toCatch = x => `catch:${x.amount < 0 ? 'expense' : 'income'}`;
      if (imp.newGroups.has(g.key)) {
        imp.newGroups.delete(g.key);
        imp.offGroups.add(g.key);
        g.txns.forEach(x => { if (imp.decision.get(x.id) === `new:${g.key}`) imp.decision.set(x.id, toCatch(x)); });
      } else {
        imp.newGroups.add(g.key);
        imp.offGroups.delete(g.key);
        g.txns.forEach(x => { const cur = imp.decision.get(x.id) || ''; if (!cur || cur.startsWith('catch:')) imp.decision.set(x.id, `new:${g.key}`); });
      }
      return openImportKeepScroll();
    }
    const rn = t.closest('[data-rename-payee], [data-rename-group]');
    if (rn) {
      await renamePayee(rn.dataset.renameGroup ? imp.pgroups.get(rn.dataset.renameGroup).payees : rn.dataset.renamePayee);
      buildImport();
      return openImportKeepScroll();
    }
    if (t.closest('[data-ignore-rest]')) {
      imp.txns.forEach(x => { const cur = imp.decision.get(x.id) || ''; if (!cur || cur.startsWith('catch:')) imp.decision.set(x.id, 'ignore'); });
      return openImportKeepScroll();
    }
    if (t.closest('[data-apply]')) await applyImport();
  });

  if (!sheet.open) { document.body.classList.add('modal-open'); sheet.showModal(); }
}

/** Redraw the import sheet without jumping back to the top. */
function openImportKeepScroll() {
  const y = sheet.scrollTop;
  openImport();
  sheet.scrollTop = y;
}

async function applyImport() {
  const now = new Date().toISOString();
  const rules = { ...(state.settings.payeeRules || {}) };
  const ignored = [...(state.settings.ignoredTxns || [])];
  const changed = new Map(); // entry id → updated entry
  const get = id => changed.get(id) || state.entries.find(e => e.id === id);
  let logged = 0, ignoredCount = 0, linked = 0;
  const links = importLinks();

  // New entries from recurring groups
  for (const key of imp.newGroups) {
    const g = imp.recurring.find(x => x.key === key);
    if (!g) continue;
    const id = uid();
    const start = g.txns[0].date;
    changed.set(id, {
      id, type: g.type, name: g.name, category: '', method: accountName(imp.account), frequency: g.frequency, startDate: start,
      contractEnd: null, endsAtExpiry: false, endDate: null, notes: `Added from a bank import (${g.payee})`, tags: [], fromImport: true,
      prices: [{ from: start, amount: g.variable ? null : g.amount, frequency: g.frequency }],
      variable: g.variable, manual: false, share: 100, noticeDays: null, payments: [], createdAt: now, updatedAt: now,
    });
    g.newId = id;
    rules[g.payee] = id;
  }

  // New entries for single payees ("+ New entry" on a transaction)
  const made = new Map(); // payee → new entry id
  for (const payee of new Set([...imp.decision.values()].filter(d => d.startsWith('make:')).map(d => d.slice(5)))) {
    const txns = imp.txns.filter(t => imp.decision.get(t.id) === `make:${payee}`).sort((a, b) => a.date.localeCompare(b.date));
    if (!txns.length) continue;
    const id = uid();
    const one = txns.length === 1;
    const frequency = one ? 'once' : 'irregular';
    const start = txns[0].date;
    const lead = txns.find(t => t.payee === payee) || txns[0]; // other payees may have been put in with it
    changed.set(id, {
      id, type: lead.amount < 0 ? 'expense' : 'income', name: lead.name || Bank.payeeName(payee), category: '',
      method: accountName(imp.account), frequency, startDate: start, contractEnd: null, endsAtExpiry: false, endDate: null,
      notes: `Added from a bank import (${payee})`, tags: [], fromImport: true,
      prices: [{ from: start, amount: one ? Math.abs(txns[0].amount) : null, frequency }],
      variable: !one, manual: false, share: 100, noticeDays: null, payments: [], createdAt: now, updatedAt: now,
    });
    made.set(payee, id);
    if (!one) rules[payee] = id; // later purchases from them go to it too (not to a one-off)
  }

  // The account's catch-all entries, created the first time they're needed
  const catchIds = new Map();
  let createdCatch = 0;
  for (const type of ['expense', 'income']) {
    if (![...imp.decision.values()].includes(`catch:${type}`)) continue;
    const existing = catchEntry(imp.account, type);
    if (existing) { catchIds.set(type, existing.id); continue; }
    const id = uid();
    const start = imp.txns.filter(t => imp.decision.get(t.id) === `catch:${type}`).reduce((m, t) => (t.date < m ? t.date : m), C.todayISO());
    changed.set(id, {
      id, type, name: catchName(imp.account, type), category: '', method: accountName(imp.account), frequency: 'irregular',
      startDate: start, contractEnd: null, endsAtExpiry: false, endDate: null,
      notes: 'Everything from bank imports that isn’t matched to another entry. Open it to move a payee into an entry of its own.',
      tags: [], fromImport: true, catchAll: catchKey(imp.account, type),
      prices: [{ from: start, amount: null, frequency: 'irregular' }],
      variable: true, manual: false, share: 100, noticeDays: null, payments: [], createdAt: now, updatedAt: now,
    });
    catchIds.set(type, id);
    createdCatch++;
  }

  for (const t of imp.txns) {
    let d = imp.decision.get(t.id) || '';
    const chosen = d;
    const suggested = imp.suggested.get(t.id) || '';
    if (!d) {
      // A remembered choice switched to "Skip for now": it was wrong, so forget it.
      if (t.why === 'rule' && suggested && suggested !== 'ignore') { delete rules[t.payee]; delete rules[t.oldPayee]; }
      continue;
    }
    if (d === 'ignore' || d === 'ignore-payee') {
      ignored.push(t.id); ignoredCount++;
      if (d === 'ignore-payee') rules[t.payee] = 'ignore';
      continue;
    }
    if (d.startsWith('new:')) d = imp.recurring.find(g => g.key === d.slice(4))?.newId;
    else if (d.startsWith('make:')) d = made.get(d.slice(5));
    else if (d.startsWith('catch:')) d = catchIds.get(d.slice(6));
    const e = d && get(d);
    if (!e) continue;
    // Payments are stored as the bill amount: money out on an expense (or in on income) is positive;
    // the other direction is a refund/credit (negative).
    const amount = e.type === 'expense' ? -t.amount : t.amount;
    const link = links.get(t.id);
    const note = (t.name ? `${t.name} · ${t.description}` : t.description).slice(0, 100);
    if (link) {
      // Already logged by hand: keep that payment, but take the bank's actual date and amount.
      const payments = e.payments.map(p => (p.id === link.id
        ? { ...p, date: t.date, amount, due: p.due || Bank.nearestDue(e, t.date), note: p.note || note, source: t.id, handLogged: true }
        : p));
      changed.set(e.id, { ...e, payments, updatedAt: now });
      linked++;
    } else {
      const payment = { id: uid(), date: t.date, amount, due: Bank.nearestDue(e, t.date), note, source: t.id, payee: t.payee };
      changed.set(e.id, { ...e, payments: [...(e.payments || []), payment], updatedAt: now });
    }
    // Remember the payee only for choices you made, name matches and existing rules. A match on
    // amount alone is a one-off guess and mustn't send every future purchase there.
    // Never to a one-off (later purchases don't belong to it) or a catch-all (where they go anyway).
    if ((chosen !== suggested || t.why === 'rule' || t.byName) && e.frequency !== 'once' && !isCatchAll(e)) rules[t.payee] = e.id;
    logged++;
  }

  const toSave = [...changed.values()].map(normalizeEntry).filter(Boolean);
  if (toSave.length) await db.putEntries(toSave);
  state.settings.payeeRules = rules;
  state.settings.ignoredTxns = ignored.slice(-5000);
  state.settings.bankAccounts = uniqueCI([imp.account, ...(state.settings.bankAccounts || [])]);
  await saveSettings();
  const added = imp.newGroups.size + made.size + createdCatch;
  imp = null;
  closeSheet();
  await reload();
  const fresh = logged - linked;
  toast(`Logged ${fresh} payment${fresh === 1 ? '' : 's'}${linked ? `, updated ${linked} you'd logged` : ''}${added ? `, added ${added} entr${added === 1 ? 'y' : 'ies'}` : ''}${ignoredCount ? `, ignored ${ignoredCount}` : ''}`);
}

// ---------- Manage labels sheet ----------
let manageKind = 'category';

function openManage(kind = manageKind) {
  manageKind = kind;
  const meta = LABELS[kind];
  const items = labelCounts(kind);
  const unlabelled = kind === 'tag'
    ? state.entries.filter(e => !e.tags?.length).length
    : state.entries.filter(e => !e[meta.field]).length;

  sheet.innerHTML = `
  <div id="manage">
    <div class="sheet-head">
      <span></span>
      <h2 tabindex="-1" autofocus>Manage labels</h2>
      <button type="button" class="link strong" data-close>Done</button>
    </div>
    <div class="sheet-body">
      <div class="seg">
        ${Object.entries(LABELS).map(([k, m]) =>
          `<button type="button" data-kind="${k}" class="${k === kind ? 'on' : ''}">${m.title}</button>`).join('')}
      </div>
      <p class="fine manage-help">Renaming to a name that already exists <strong>merges</strong> them.
        Deleting only removes the ${meta.noun} — the entries stay.</p>
      ${items.length ? `<section class="card list">${items.map(({ name, n }) => `
        <div class="row static label-row">
          <div class="row-main">
            <div class="row-title">${kind === 'tag' ? '#' : ''}${esc(name)}</div>
            <div class="row-sub">${n} entr${n === 1 ? 'y' : 'ies'}</div>
          </div>
          <button type="button" class="btn small" data-rename="${esc(name)}">Rename</button>
          <button type="button" class="btn small danger" data-remove="${esc(name)}">Delete</button>
        </div>`).join('')}</section>`
      : `<p class="empty-small">No ${meta.title.toLowerCase()} in use yet.</p>`}
      ${unlabelled ? `<p class="fine pad-x">${unlabelled} entr${unlabelled === 1 ? 'y has' : 'ies have'} no ${meta.noun}.</p>` : ''}
    </div>
  </div>`;

  const root = $('#manage');
  root.addEventListener('click', async ev => {
    const t = ev.target;
    if (t.closest('[data-close]')) return closeSheet();
    const k = t.closest('[data-kind]');
    if (k) return openManage(k.dataset.kind);
    const ren = t.closest('[data-rename]');
    const rem = t.closest('[data-remove]');
    if (ren) await renameLabel(kind, ren.dataset.rename);
    else if (rem) await removeLabel(kind, rem.dataset.remove);
  });

  if (!sheet.open) { document.body.classList.add('modal-open'); sheet.showModal(); }
}

/** Replace (or with to === null, remove) a label on every entry that has it. Returns the count changed. */
async function changeLabel(kind, from, to) {
  const lf = from.toLowerCase();
  const now = new Date().toISOString();
  const changed = [];
  for (const e of state.entries) {
    if (!labelsOf(kind, e).some(l => l.toLowerCase() === lf)) continue;
    const ne = kind === 'tag'
      ? { ...e, tags: normalizeTags(e.tags.map(t => (t.toLowerCase() === lf ? to : t)).filter(Boolean)) }
      : { ...e, [LABELS[kind].field]: to || '' };
    ne.updatedAt = now;
    changed.push(ne);
  }
  if (changed.length) await db.putEntries(changed);
  state.entries = await db.allEntries();
  return changed.length;
}

async function renameLabel(kind, from) {
  const meta = LABELS[kind];
  const input = prompt(`Rename the ${meta.noun} “${from}” to:`, from);
  if (input == null) return;
  let to = kind === 'tag' ? cleanTag(input) : cleanLabel(input).slice(0, 40);
  if (!to || to === from) return;
  const existing = labelCounts(kind).find(x => x.name.toLowerCase() === to.toLowerCase() && x.name.toLowerCase() !== from.toLowerCase());
  if (existing) {
    if (!confirm(`“${existing.name}” already exists. Merge “${from}” into it?`)) return;
    to = existing.name;
  }
  const n = await changeLabel(kind, from, to);
  toast(existing ? `Merged into “${to}” (${n})` : `Renamed (${n})`);
  openManage(kind);
}

async function removeLabel(kind, name) {
  const meta = LABELS[kind];
  const n = labelCounts(kind).find(x => x.name === name)?.n || 0;
  if (!confirm(`Remove the ${meta.noun} “${name}” from ${n} entr${n === 1 ? 'y' : 'ies'}? The entries themselves are kept.`)) return;
  await changeLabel(kind, name, null);
  state.tags = state.tags.filter(t => t.toLowerCase() !== name.toLowerCase());
  toast(`Removed from ${n}`);
  openManage(kind);
}

function closeSheet() {
  sheet.close();
}
sheet.addEventListener('close', () => {
  document.body.classList.remove('modal-open');
  sheet.innerHTML = ''; // don't leave a hidden copy of the last sheet in the page
  render(); // labels may have changed while the sheet was open
});

async function saveForm(form, existing) {
  const err = msg => { $('#formError').textContent = msg; $('#formError').scrollIntoView({ block: 'center', behavior: 'smooth' }); };
  const f = Object.fromEntries(new FormData(form));
  const name = (f.name || '').trim();
  if (!name) return err('Please enter a name.');
  if (!f.startDate) return err('Please choose a date.');
  const variable = !!f.variable;
  // Varying bills may leave amounts blank — the estimate then comes from logged payments
  const amountOf = raw => (variable && !String(raw ?? '').trim() ? null : C.parseAmount(raw));

  let prices;
  if (existing) {
    const froms = [...form.querySelectorAll('[name=pfrom]')].map(i => i.value);
    const amounts = [...form.querySelectorAll('[name=pamount]')].map(i => amountOf(i.value));
    const freqs = [...form.querySelectorAll('[name=pfreq]')].map(s => s.value);
    prices = froms.map((from, i) => ({ from: i === 0 ? f.startDate : from, amount: amounts[i], frequency: freqs[i] }));
    if (prices.some(p => !p.from)) return err('Each change needs a date.');
    if (prices.slice(1).some(p => p.from <= f.startDate)) return err('Changes must be after the first payment date.');
    if (new Set(prices.map(p => p.from)).size !== prices.length) return err('Two changes can’t start on the same date.');
    if (freqs[0] === 'once' && prices.length > 1) return err('A one-off payment can’t have later changes — remove them, or choose how often it repeats.');
  } else {
    prices = [{ from: f.startDate, amount: amountOf(f.amount), frequency: f.frequency }];
  }
  if (prices.some(p => !(p.amount === null || p.amount >= 0))) {
    return err(variable ? 'That estimate doesn’t look like an amount.' : 'Please enter a valid amount (or switch on “Amount varies”).');
  }
  prices.sort((a, b) => a.from.localeCompare(b.from));

  const once = prices[0].frequency === 'once';
  const frequency = once ? 'once' : prices.at(-1).frequency;
  if (!once && f.contractEnd && f.contractEnd < f.startDate) return err('Contract end can’t be before the first payment.');
  if (!once && f.endDate && f.endDate < f.startDate) return err('Cancelled date can’t be before the first payment.');

  const share = C.parseAmount(f.share || '100');
  if (!(share > 0 && share <= 100)) return err('Your share must be between 1 and 100%.');
  const noticeDays = f.noticeDays?.trim() ? Number(f.noticeDays.trim()) : null;
  if (noticeDays !== null && !(Number.isInteger(noticeDays) && noticeDays >= 0 && noticeDays <= 3650)) {
    return err('Notice needed should be a whole number of days.');
  }

  // Logged payments (edit mode only)
  const oldPays = new Map((existing?.payments || []).map(p => [p.id, p]));
  const payments = [];
  for (const row of form.querySelectorAll('.pay-row')) {
    const get = n => row.querySelector(`[name=${n}]`).value;
    const amount = C.parseAmount(get('payamount'));
    if (!get('paydate') || !(amount >= 0)) return err('Each logged payment needs a date and an amount.');
    const id = get('payid') || uid();
    payments.push({ ...oldPays.get(id), id, date: get('paydate'), amount: Number(get('paysign')) * amount, due: get('paydue') || null });
  }
  payments.sort((a, b) => a.date.localeCompare(b.date));

  const now = new Date().toISOString();
  const entry = {
    ...existing, // keep any fields this version of the form doesn't know about
    id: existing?.id || uid(),
    type: f.type === 'income' ? 'income' : 'expense',
    name,
    category: canonicalLabel(f.category, categoryOptions(f.type === 'income' ? 'income' : 'expense')),
    method: canonicalLabel(f.method, methodOptions()),
    frequency,
    startDate: f.startDate,
    contractEnd: once ? null : f.contractEnd || null,
    endsAtExpiry: !once && !!f.endsAtExpiry,
    endDate: once ? null : f.endDate || null,
    notes: (f.notes || '').trim(),
    tags: (form._commitTags(), form._getTags()),
    prices,
    variable: !!f.variable,
    manual: !!f.manual,
    share: share >= 100 ? 100 : share,
    noticeDays: once || !noticeDays ? null : noticeDays,
    payments,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  const before = state.entries;
  await db.putEntry(entry);
  closeSheet();
  // Warn if this change pushed a budget over its limit this month
  const after = await db.allEntries();
  const now2 = new Date();
  const over = R.newlyOver(before, after, state.settings.budgets || [], now2.getFullYear(), now2.getMonth());
  if (over.length) {
    setTimeout(() => toast(`Over your ${over[0].budget.kind === 'tag' ? '#' : ''}${over[0].budget.label} budget by ${money(-over[0].left)} this month`), 2600);
  }
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
/** Phones/tablets get the share sheet (→ Save to Files / iCloud Drive); computers get a normal download. */
const useShareSheet = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS reports as a Mac
async function exportBackup() {
  const payload = buildBackup(state.entries, state.settings);
  const name = `budget-backup-${C.todayISO()}.json`;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  const download = () => {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  try {
    if (useShareSheet() && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
      } catch (e) {
        if (e.name === 'AbortError') return; // user closed the share sheet
        download();                         // share refused (e.g. desktop browser) → plain download
      }
    } else {
      download();
    }
  } catch (e) {
    alert('Export failed: ' + e.message);
    return;
  }
  state.settings.lastBackup = new Date().toISOString();
  await saveSettings();
  render();
  toast('Backup created');
}

/** Three CSV files for Excel / Numbers: entries, logged payments, and monthly totals (2 years + forecast). */
async function exportCSV() {
  if (!state.entries.length) { toast('Nothing to export yet'); return; }
  const today = C.todayISO();
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 23, 1);
  const files = [
    ['budget-entries', R.entriesRows(state.entries, today)],
    ['budget-payments', R.paymentsRows(state.entries)],
    ['budget-monthly-totals', R.monthlyRows(state.entries, start.getFullYear(), start.getMonth(), 24 + FORECAST_MONTHS)],
  ].map(([name, rows]) => new File([R.toCSV(rows)], `${name}-${today}.csv`, { type: 'text/csv' }));

  const downloadAll = () => files.forEach((f, i) => setTimeout(() => {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(f), download: f.name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, i * 300));

  if (useShareSheet() && navigator.canShare?.({ files })) {
    try { await navigator.share({ files, title: 'Budget spreadsheets' }); }
    catch (e) { if (e.name !== 'AbortError') downloadAll(); }
  } else {
    downloadAll();
  }
}

async function importBackup(file) {
  try {
    let data;
    try { data = JSON.parse(await file.text()); } catch { throw new Error('The file isn’t valid JSON.'); }
    const { entries: valid, settings, skipped } = migrateBackup(data);
    const skipNote = skipped ? `\n\n${skipped} damaged entr${skipped === 1 ? 'y' : 'ies'} will be skipped.` : '';
    if (!confirm(`Import ${valid.length} entries? Entries already on this device with the same ID will be replaced.${skipNote}`)) return;
    await db.putEntries(valid);
    if (settings.currency && !state.entries.length) { state.settings.currency = settings.currency; fmtCache.clear(); }
    // Add any budgets from the backup that this device doesn't have yet
    const have = new Set((state.settings.budgets || []).map(b => `${b.kind}:${b.label.toLowerCase()}`));
    const extra = (settings.budgets || []).filter(b => !have.has(`${b.kind}:${b.label.toLowerCase()}`));
    if (extra.length) state.settings.budgets = [...(state.settings.budgets || []), ...extra];
    await saveSettings();
    await reload();
    toast(`Imported ${valid.length} entries`);
  } catch (e) {
    alert('Import failed: ' + e.message);
  }
}

// ---------- Sample data ----------
function sampleEntries() {
  const TRANSFER = METHODS.includes('Standing order') ? 'Standing order' : 'Bank transfer'; // regular transfers, in local terms
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
    mk({ type: 'expense', name: 'Rent', category: 'Housing', method: TRANSFER, frequency: 'monthly', startDate: m(-26, 1),
         prices: [{ from: m(-26, 1), amount: 950 }, { from: m(-12, 1), amount: 1010 }] }),
    mk({ type: 'expense', name: 'Electricity & gas', category: 'Utilities', method: 'Direct debit', frequency: 'monthly', startDate: m(-26, 15),
         prices: [{ from: m(-26, 15), amount: 92 }, { from: m(-16, 15), amount: 128 }, { from: m(-5, 15), amount: 115 }] }),
    mk({ type: 'expense', name: 'Phone contract', category: 'Phone & Internet', method: 'Direct debit', frequency: 'monthly', startDate: m(-23, 9),
         contractEnd: d(45), prices: [{ from: m(-23, 9), amount: 32 }] }),
    mk({ type: 'expense', name: 'Broadband', category: 'Phone & Internet', method: 'Direct debit', frequency: 'monthly', startDate: m(-20, 20),
         contractEnd: d(-18), prices: [{ from: m(-20, 20), amount: 28 }, { from: m(-8, 20), amount: 31.5 }] }),
    mk({ type: 'expense', name: 'Netflix', category: 'Subscriptions', method: 'Credit card', frequency: 'monthly', startDate: m(-26, 4),
         prices: [{ from: m(-26, 4), amount: 10.99 }, { from: m(-10, 4), amount: 12.99 }] }),
    mk({ type: 'expense', name: 'Spotify', category: 'Subscriptions', method: 'Apple Pay', frequency: 'monthly', startDate: m(-18, 7),
         prices: [{ from: m(-18, 1), amount: 11.99 }] }),
    mk({ type: 'expense', name: 'Water', category: 'Utilities', method: 'Direct debit', frequency: 'quarterly', startDate: m(-12, 10),
         variable: true, notes: 'Bill varies — real payments logged',
         prices: [{ from: m(-12, 10), amount: 95 }],
         payments: [[-12, 91.3], [-9, 96.2], [-6, 104.75], [-3, 88.4]].map(([o, amount], i) => ({ id: `w${i}`, date: m(o, 10), amount })) }),
    mk({ type: 'expense', name: 'Window cleaner', category: 'Housing', method: 'Cash', frequency: 'monthly',
         startDate: C.iso(C.addMonths(C.parse(d(-9)), -7)), manual: true,
         prices: [{ from: C.iso(C.addMonths(C.parse(d(-9)), -7)), amount: 20 }] }),
    mk({ type: 'expense', name: 'Piano lessons', category: 'Entertainment', method: 'Bank transfer', frequency: 'monthly',
         startDate: C.iso(C.addMonths(C.parse(d(5)), -4)), manual: true,
         prices: [{ from: C.iso(C.addMonths(C.parse(d(5)), -4)), amount: 60 }] }),
    mk({ type: 'expense', name: 'Apple One', category: 'Subscriptions', method: 'Apple Pay', frequency: 'monthly', startDate: m(-8, 12),
         notes: 'One category (Subscriptions); tags say what it covers',
         prices: [{ from: m(-8, 12), amount: 18.95 }] }),
    mk({ type: 'expense', name: 'Gym', category: 'Health', method: 'Debit card', frequency: 'monthly', startDate: m(-15, 5),
         endDate: m(-4, 5), prices: [{ from: m(-15, 5), amount: 35 }] }),
    mk({ type: 'expense', name: 'Car insurance', category: 'Insurance', method: 'Credit card', frequency: 'yearly', startDate: m(-21, 18),
         notes: 'Switched from paying yearly to monthly',
         prices: [{ from: m(-21, 18), amount: 540 }, { from: m(-9, 18), amount: 612 },
                  { from: m(-3, 18), amount: 56, frequency: 'monthly' }] }),
    mk({ type: 'expense', name: 'Groceries', category: 'Groceries', method: 'Debit card', frequency: 'weekly', startDate: m(-26, 2),
         prices: [{ from: m(-26, 2), amount: 70 }, { from: m(-11, 2), amount: 82 }] }),
    mk({ type: 'expense', name: 'Savings', category: 'Savings', method: TRANSFER, frequency: 'monthly', startDate: m(-6, 1),
         prices: [{ from: m(-6, 1), amount: 200 }] }),
  ].map(e => {
    e.prices[0].from = e.startDate;
    e.tags = {
      'Salary': ['work'], 'Freelance design job': ['work', 'taxable'], 'Rent': ['shared', 'essential'],
      'Electricity & gas': ['shared', 'essential'], 'Broadband': ['shared'], 'Phone contract': ['essential'],
      'Netflix': ['shared', 'streaming'], 'Spotify': ['music'], 'Car insurance': ['essential', 'car'],
      'Apple One': ['bundle', 'streaming', 'music', 'cloud-storage'],
      'Groceries': ['shared', 'essential'], 'Water': ['shared', 'essential'],
    }[e.name] || [];
    Object.assign(e, {
      'Rent': { share: 50, notes: 'Split 50/50 — only my half counts' },
      'Phone contract': { noticeDays: 30 },
    }[e.name] || {});
    // Manual sample bills: everything before the last couple of weeks is already marked paid
    if (e.manual) {
      e.payments = C.occurrences(e, e.startDate, C.addDaysISO(C.todayISO(), -12))
        .map((due, i) => ({ id: `s${i}`, date: due, amount: e.prices[0].amount, due }));
    }
    return normalizeEntry(e); // fills each period's frequency, sets current frequency
  });
}

// ---------- Global events ----------
const actions = {
  add: () => openSheet(),
  sample: async () => {
    await db.putEntries(sampleEntries());
    if (!state.settings.budgets?.length) {
      state.settings.budgets = [
        { id: uid(), kind: 'category', label: 'Subscriptions', amount: 40 },
        { id: uid(), kind: 'category', label: 'Groceries', amount: 380 },
        { id: uid(), kind: 'tag', label: 'shared', amount: 1000 },
      ];
      await saveSettings();
    }
    await reload();
    toast('Sample data added — erase it any time in Settings');
  },
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
  'manage-labels': () => openManage('category'),
  'manage-budgets': () => { editingBudget = null; openBudgets(); },
  'import-bank': () => $('#bankFile').click(),
  'rename-account': t => renameAccount(t.dataset.key),
  'forget-rules': forgetRules,
  'undo-imports': openUndoImports,
  period: async t => { state.settings.period = t.dataset.period; await saveSettings(); render(); },
  'export-csv': exportCSV,
  'mark-paid': async t => {
    const e = state.entries.find(x => x.id === t.dataset.id);
    const due = t.dataset.due;
    if (!e) return;
    const est = C.estimateOn(e, due);
    const what = e.type === 'income' ? 'Amount received' : 'Amount paid';
    const input = prompt(`${what} for ${e.name} (due ${fmtDate(due)})${e.share < 100 ? ' — the full bill, before your share' : ''}:`,
      est ? (Math.round(est * 100) / 100).toFixed(2) : '');
    if (input == null) return;
    const amount = C.parseAmount(input);
    if (!Number.isFinite(amount)) { alert('That doesn’t look like an amount.'); return; }
    const payments = [...(e.payments || []), { id: uid(), date: C.todayISO(), amount, due, note: '' }]
      .sort((a, b) => a.date.localeCompare(b.date));
    await db.putEntry({ ...e, payments, updatedAt: new Date().toISOString() });
    await reload();
    toast(e.type === 'income' ? 'Marked as received' : 'Marked as paid');
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
    Object.assign(state.settings, { lastBackup: null, budgets: [], balance: null, paydayId: null,
      payeeRules: {}, ignoredTxns: [], bankAccounts: [], accountNames: {}, payeeNames: {} });
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
  } else if (ev.target.id === 'balance') {
    const v = ev.target.value.trim();
    const amount = C.parseAmount(v);
    state.settings.balance = v && Number.isFinite(amount) ? { amount, date: C.todayISO() } : null;
    await saveSettings();
    render();
  } else if (ev.target.id === 'payday') {
    state.settings.paydayId = ev.target.value || null;
    await saveSettings();
    toast('Payday updated');
  } else if (ev.target.id === 'bankFile' && ev.target.files[0]) {
    const file = ev.target.files[0];
    ev.target.value = '';
    await startBankImport(file);
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

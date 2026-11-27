// Shared state, constants and helpers used by every screen. Imports nothing from the other UI files,
// so it always loads first.
import { db } from './db.js';
import * as C from './calc.js';
import * as Bank from './bank.js';
import { cleanLabel, normalizeEntry } from './schema.js';

// ---------- Constants ----------
export const CATEGORIES = {
  expense: ['Housing', 'Utilities', 'Subscriptions', 'Phone & Internet', 'Insurance', 'Transport',
            'Groceries', 'Eating out', 'Health', 'Entertainment', 'Debt', 'Savings', 'Other'],
  income: ['Salary', 'Freelance', 'Benefits', 'Investments', 'Rental', 'Gift', 'Other'],
};
/** The phone's region, e.g. "AU" from "en-AU". */
export const REGION = ((navigator.language || 'en-US').split('-')[1] || '').toUpperCase();
/** Payment methods people actually use in each region (suggestions only — anything can be typed). */
export const METHODS = [
  'Direct debit',
  ...({
    AU: ['BPAY', 'PayID'], NZ: ['Automatic payment'], GB: ['Standing order'], IE: ['Standing order'],
    US: ['Autopay', 'ACH transfer', 'Check', 'Zelle', 'Venmo'], CA: ['Pre-authorized debit', 'Interac e-Transfer'],
  }[REGION] || ['Standing order']),
  'Debit card', 'Credit card', 'Apple Pay', 'Bank transfer', 'PayPal', 'Cash', 'Other',
];

/** A stored timestamp (UTC) as the phone's local calendar date — e.g. 8am in Sydney is still "today". */
export const localDay = ts => C.iso(new Date(ts));
export const CURRENCIES = ['GBP', 'USD', 'EUR', 'AUD', 'CAD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'JPY', 'INR', 'SGD', 'ZAR'];
export const FORECAST_MONTHS = 3;
export const TITLES = { overview: 'Overview', entries: 'Payee groups', txns: 'Transactions', settings: 'Settings', payees: 'Payees', accounts: 'Accounts' };
export const STARTER_TAGS = ['shared', 'essential', 'work', 'tax-deductible', 'cancel-soon', 'bundle', 'streaming', 'cloud-storage'];

// ---------- Labels (category / payment method / tag) ----------
export const LABELS = {
  category: { title: 'Categories', noun: 'category', field: 'category' },
  method:   { title: 'Methods', noun: 'payment method', field: 'method' },
  tag:      { title: 'Tags', noun: 'tag' },
};
export const labelsOf = (kind, e) => (kind === 'tag' ? e.tags || [] : e[kind] ? [e[kind]] : []);

/** Labels in use, with entry counts, most-used first. Matching ignores capitals. */
export function labelCounts(kind) {
  const m = new Map();
  for (const e of state.entries) for (const l of labelsOf(kind, e)) {
    const k = l.toLowerCase();
    const cur = m.get(k) || { name: l, n: 0 };
    cur.n++; m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

/** Unique (ignoring capitals) list, first spelling wins. */
export const uniqueCI = list => {
  const seen = new Set();
  return list.filter(x => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
};

/** Snap typed text to an existing spelling: "groceries" → "Groceries" if that's already used. */
export function canonicalLabel(value, options) {
  const v = cleanLabel(value).slice(0, 40);
  if (!v) return '';
  return options.find(o => o.toLowerCase() === v.toLowerCase()) || v;
}
export const categoryOptions = type => uniqueCI([...labelCounts('category').map(x => x.name), ...CATEGORIES[type]]);
export const methodOptions = () => uniqueCI([...labelCounts('method').map(x => x.name), ...METHODS]);

export function guessCurrency() {
  const region = ((navigator.language || 'en-US').split('-')[1] || '').toUpperCase();
  const map = { GB: 'GBP', US: 'USD', AU: 'AUD', CA: 'CAD', NZ: 'NZD', CH: 'CHF', SE: 'SEK', NO: 'NOK',
    DK: 'DKK', JP: 'JPY', IN: 'INR', SG: 'SGD', ZA: 'ZAR', IE: 'EUR', DE: 'EUR', FR: 'EUR', ES: 'EUR',
    IT: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR', PT: 'EUR', FI: 'EUR' };
  return map[region] || 'USD';
}

// ---------- State ----------
export const state = {
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
export const $ = (s, el = document) => el.querySelector(s);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

export const fmtCache = new Map();
export function money(n, opts = {}) {
  const key = state.settings.currency + JSON.stringify(opts);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.NumberFormat(undefined, { style: 'currency', currency: state.settings.currency, currencyDisplay: 'narrowSymbol', ...opts }));
  return fmtCache.get(key).format(n);
}
/** Expected amount for one payment on a date — your share, using the estimate for varying bills. */
export const dueAmount = (e, dateISO) => C.shareOf(e) * C.estimateOn(e, dateISO);
/** "−£12.99" / "+£2,950.00", with "≈" when the amount varies. */
export const signed = (e, n) => (e.variable && Math.abs(n) < 0.005
  ? 'Varies' // no estimate yet — nothing logged
  : `${e.type === 'income' ? '+' : '−'}${e.variable ? '≈' : ''}${money(Math.abs(n))}`);
export const compactMoney = n => money(n, { notation: 'compact', maximumFractionDigits: 1 });

export const monthShort = new Intl.DateTimeFormat(undefined, { month: 'short' });
export const monthLong = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
export const monthYear = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
export const dayMonth = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
export const dayShort = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' });
export const dayMonthYear = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
export function fmtDate(s) {
  const d = C.parse(s);
  return (d.getFullYear() === new Date().getFullYear() ? dayMonth : dayMonthYear).format(d);
}
export function relDays(n) {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

/** After redrawing an open sheet in place: put back a toast that's still showing (it lives inside the sheet). */
export function keepToast() {
  const t = toast.el;
  if (t?.classList.contains('show') && sheet.open && t.parentElement !== sheet) sheet.append(t);
}

/**
 * Show a short message. With `undo` (a function), it has an Undo button and stays up longer;
 * Ctrl/⌘ Z runs it too, while the message shows (toast.undo).
 */
export function toast(msg, { undo } = {}) {
  // Keep our own reference: the toast may get detached when the sheet's contents are replaced.
  const t = (toast.el ||= $('#toast'));
  // an open <dialog> sits above everything else, so show the toast inside it
  const host = $('#sheet').open ? $('#sheet') : document.body;
  if (t.parentElement !== host) host.append(t);
  t.textContent = msg;
  toast.undo = null;
  if (undo) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-undo';
    b.textContent = 'Undo';
    toast.undo = async () => { toast.undo = null; t.classList.remove('show', 'has-action'); await undo(); };
    b.addEventListener('click', toast.undo);
    t.append(' ', b);
  }
  t.classList.toggle('has-action', !!undo);
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.classList.remove('show', 'has-action'); toast.undo = null; }, undo ? 7000 : 2400);
}

// ---------- Tags ----------
export const hasTag = (e, t) => (e.tags || []).some(x => x.toLowerCase() === t.toLowerCase());

/** All tags in use, most-used first. */
export function allTags() {
  const counts = new Map();
  for (const e of state.entries) for (const t of e.tags || []) {
    const k = t.toLowerCase();
    const cur = counts.get(k) || { name: t, n: 0 };
    cur.n++; counts.set(k, cur);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).map(x => x.name);
}

/** Entries passing the active tag filter. */
export const tagFiltered = () => state.entries.filter(e => state.tags.every(t => hasTag(e, t)));

export function tagBar() {
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

export async function saveSettings() { await db.saveSettings(state.settings); }

/**
 * A new group (an entry with no set schedule: its amounts come from the payments in it), not yet
 * saved. Used when you type a new group's name in the picker.
 */
export function newGroup({ name, type = 'expense', category = '', method = '', start = C.todayISO(), notes = '', ...more }) {
  const now = new Date().toISOString();
  return normalizeEntry({
    id: uid(), type, name: cleanLabel(name), category, method, frequency: 'irregular', startDate: start,
    contractEnd: null, endsAtExpiry: false, endDate: null, notes, tags: [],
    prices: [{ from: start, amount: null, frequency: 'irregular' }],
    variable: true, manual: false, share: 100, noticeDays: null, payments: [], createdAt: now, updatedAt: now, ...more,
  });
}

// ---------- Page elements: the tab view and the sheet (dialog) every screen draws into ----------
export const view = $('#view');
// Computer-sized windows get the sidebar and two-column layout (matches the 900px breakpoint in styles.css)
export const wideScreen = matchMedia('(min-width: 900px)');

/** Wrap each `.group-title` and what follows it (up to the next title) in a `.sec` box, inside one
 *  `<div class="${cls}">`. A phone shows them exactly as before; wide screens lay the boxes out in columns. */
export function sectionize(root, cls) {
  const wrap = document.createElement('div');
  wrap.className = cls;
  let sec = null;
  for (const n of [...root.childNodes]) {
    if (n.nodeType === 1 && n.classList.contains('group-title')) {
      sec = document.createElement('div');
      sec.className = 'sec';
      wrap.append(sec);
    }
    if (sec) sec.append(n);
  }
  if (sec) root.append(wrap);
}
export const sheet = $('#sheet');

export function closeSheet() {
  sheet.close();
}

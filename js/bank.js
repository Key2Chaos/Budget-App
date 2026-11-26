// Bank statement import: CSV parsing, format detection (CommBank and others), payee keys,
// matching transactions to entries, and spotting recurring payments. Pure — no DOM — so it's testable.
import * as C from './calc.js';

// ---------- CSV ----------

/** Parse CSV text into rows of strings (handles quotes, "" escapes, CRLF, BOM, blank lines). */
export function parseCSV(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows.map(r => r.map(c => c.trim()));
}

// ---------- Dates & amounts ----------

const DATE_RE = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})$/;
export const looksLikeDate = s => DATE_RE.test(String(s).trim());

/**
 * Work out the date order from all the dates in a file.
 * Returns 'YMD', 'DMY', 'MDY', or null if every date fits both DMY and MDY (e.g. only days ≤ 12).
 */
export function detectDateOrder(dates) {
  let dmy = true, mdy = true, ymd = false;
  for (const d of dates) {
    const m = DATE_RE.exec(String(d).trim());
    if (!m) continue;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (m[1].length === 4) { ymd = true; continue; }
    if (a > 12) mdy = false;
    if (b > 12) dmy = false;
  }
  if (ymd) return 'YMD';
  if (dmy && !mdy) return 'DMY';
  if (mdy && !dmy) return 'MDY';
  return null;
}

/** '21/11/2026' + order → '2026-11-21' (or null if it isn't a real date). */
export function parseDate(s, order) {
  const m = DATE_RE.exec(String(s).trim());
  if (!m) return null;
  let y, mo, d;
  if (order === 'YMD' || m[1].length === 4) [y, mo, d] = [m[1], m[2], m[3]];
  else if (order === 'MDY') [mo, d, y] = [m[1], m[2], m[3]];
  else [d, mo, y] = [m[1], m[2], m[3]];
  y = Number(y.length === 2 ? `20${y}` : y);
  const date = new Date(y, Number(mo) - 1, Number(d));
  if (date.getFullYear() !== y || date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d)) return null;
  return C.iso(date);
}

/** A 'CR' or 'DR' marker before or after an amount: '123.45 DR' is money out, '500.00 CR' money in. */
const CRDR = /^\s*(CR|DR)\.?\s*|\s*(CR|DR)\.?\s*$/i;

/** '-17.99', '+1,234.56', '$5.00', '(12.00)', '123.45 DR', '500.00 CR' → number (negative = money out). */
export function parseMoney(s) {
  let t = String(s ?? '').trim();
  if (!t || looksLikeDate(t)) return NaN; // a date is never an amount (e.g. a stray "Value Date" column)
  const m = CRDR.exec(t);
  const marker = m ? (m[1] || m[2]).toUpperCase() : null;
  if (m) t = t.replace(CRDR, '').trim();
  if (!/\d/.test(t)) return NaN;
  const neg = marker ? marker === 'DR' : /^\(.*\)$/.test(t) || /^-|-$/.test(t.replace(/[$£€\s]/g, ''));
  const n = parseFloat(t.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

const isMoney = s => /^(?:(?:CR|DR)\.?\s*)?[-+(]?\s*[$£€]?\s*[\d,]+(\.\d+)?\)?-?(?:\s*(?:CR|DR)\.?)?$/i.test(String(s).trim());

// ---------- Format detection ----------

/**
 * Work out which column is which.
 * CommBank: no header; date, signed amount, description, balance (transaction/savings) or blank (credit card).
 * Files with a header row are matched by column names (Date / Amount or Debit+Credit / Description / Balance).
 */
export function detectFormat(rows) {
  if (!rows.length) return null;
  const first = rows[0];
  const hasHeader = !looksLikeDate(first[0]) && first.some(c => /date/i.test(c));
  if (hasHeader) {
    const h = first.map(c => c.toLowerCase().replace(/\s+/g, ' ').trim());
    // The patterns are in order of preference: the first one that matches any column wins, so
    // "Transaction Date" beats an earlier "Value Date", and "Description" beats "Details".
    // Only the date can come from a column with "date" in its name ("Value Date" is not an amount).
    const find = (...re) => {
      for (const r of re) {
        const i = h.findIndex(c => r.test(c) && !/date/.test(c));
        if (i >= 0) return i;
      }
      return -1;
    };
    const findDate = (...re) => {
      for (const r of re) {
        const i = h.findIndex(c => r.test(c));
        if (i >= 0) return i;
      }
      return -1;
    };
    const fmt = {
      bank: 'Bank', hasHeader: true,
      date: findDate(/^date$/, /^(transaction|trans|txn) date/, /^(posted|posting|booking) date/, /transaction date/, /date/),
      amount: find(/^amount/, /^(transaction|trans|txn) amount/, /^value$/),
      debit: find(/debit|withdraw|money out|paid out/),
      credit: find(/credit|deposit|money in|paid in/),
      desc: find(/desc/, /narrat/, /details/, /payee/, /memo/, /particulars/),
      balance: find(/balance/),
    };
    if (fmt.date < 0 || fmt.desc < 0 || (fmt.amount < 0 && fmt.debit < 0 && fmt.credit < 0)) return null;
    fmt.kind = fmt.balance >= 0 ? 'bank' : 'card';
    return fmt;
  }
  // No header: find the columns from the data
  const sample = rows.slice(0, 50);
  const cols = Math.max(...sample.map(r => r.length));
  const share = (i, test) => sample.filter(r => r[i] != null && r[i] !== '' && test(r[i])).length / sample.length;
  const date = [...Array(cols).keys()].find(i => share(i, looksLikeDate) > 0.9);
  if (date == null) return null;
  const moneyCols = [...Array(cols).keys()].filter(i => i !== date && share(i, isMoney) > 0.9);
  const textCols = [...Array(cols).keys()].filter(i => i !== date && !moneyCols.includes(i));
  if (!moneyCols.length || !textCols.length) return null;
  const amount = moneyCols[0];
  const balance = moneyCols[1] ?? -1;
  const desc = textCols.sort((a, b) => avgLen(sample, b) - avgLen(sample, a))[0];
  const commbank = date === 0 && amount === 1 && desc === 2 && cols <= 4;
  return { bank: commbank ? 'CommBank' : 'Bank', hasHeader: false, date, amount, debit: -1, credit: -1, desc, balance, kind: balance >= 0 ? 'bank' : 'card' };
}
const avgLen = (rows, i) => rows.reduce((s, r) => s + (r[i] || '').length, 0) / rows.length;

/** Rows → transactions { date, amount, description, balance } using a detected format and date order. */
export function toTransactions(rows, fmt, order) {
  const out = [];
  for (const r of rows.slice(fmt.hasHeader ? 1 : 0)) {
    const date = parseDate(r[fmt.date], order);
    let amount = fmt.amount >= 0 ? parseMoney(r[fmt.amount]) : NaN;
    if (!Number.isFinite(amount)) {
      const out_ = fmt.debit >= 0 ? parseMoney(r[fmt.debit]) : NaN;
      const in_ = fmt.credit >= 0 ? parseMoney(r[fmt.credit]) : NaN;
      if (Number.isFinite(out_) && out_ !== 0) amount = -Math.abs(out_);
      else if (Number.isFinite(in_)) amount = Math.abs(in_);
    }
    if (fmt.flip && Number.isFinite(amount)) amount = -amount; // the file shows money out as positive
    const raw = r[fmt.desc] || '';
    const description = raw.replace(/\s+/g, ' ').trim();
    if (!date || !Number.isFinite(amount) || amount === 0 || !description) continue;
    const balance = fmt.balance >= 0 ? parseMoney(r[fmt.balance]) : NaN;
    out.push({ date, amount: Math.round(amount * 100) / 100, description, merchant: merchantPart(raw),
      balance: Number.isFinite(balance) ? balance : null });
  }
  return out;
}

// ---------- Balance column ----------

/**
 * Check the amounts against the Balance column: each row's balance should be the previous row's
 * plus its amount. Works for files in either order (newest first, like CommBank, or oldest first).
 * Only neighbouring rows that both have a balance are compared, and a file where fewer than half
 * the rows have one isn't checked at all (some banks leave it blank, e.g. on pending rows).
 * Returns null when there's nothing to check, else
 *   { pairs, normal, flipped, latest: { date, balance } }
 * where `normal` counts neighbouring rows that add up as read, and `flipped` those that add up with
 * every amount's sign reversed (a file that shows money out as positive). Pass one file's
 * transactions in file order, as read, before any flip.
 */
export function checkBalances(txns) {
  const has = t => Number.isFinite(t?.balance);
  const withBal = txns.filter(has);
  if (withBal.length < 2 || withBal.length < txns.length / 2) return null;
  const eq = (a, b) => Math.abs(a - b) < 0.005;
  let pairs = 0, down = 0, up = 0, downF = 0, upF = 0;
  for (let i = 0; i < txns.length - 1; i++) {
    const a = txns[i], b = txns[i + 1];
    if (!has(a) || !has(b)) continue;
    pairs++;
    if (eq(a.balance, b.balance + a.amount)) down++;  // newest first
    if (eq(a.balance, b.balance - a.amount)) downF++;
    if (eq(b.balance, a.balance + b.amount)) up++;    // oldest first
    if (eq(b.balance, a.balance - b.amount)) upF++;
  }
  if (!pairs) return null;
  const first = withBal[0], last = withBal.at(-1);
  // Which way the file runs: from the dates, else whichever way adds up better
  const newestFirst = first.date !== last.date ? first.date > last.date : Math.max(down, downF) >= Math.max(up, upF);
  const latest = newestFirst ? first : last;
  return { pairs, normal: newestFirst ? down : up, flipped: newestFirst ? downF : upF,
    latest: { date: latest.date, balance: latest.balance } };
}

/** Enough neighbouring rows add up (allowing for the odd skipped row) to trust the file as read. */
export const balancesAgree = (count, pairs) => pairs > 0 && count / pairs >= 0.8;

// ---------- Remembered lists ----------

/**
 * Cap a list of remembered transactions ({ id, date }, or a bare id from older data) at `max`,
 * dropping the oldest *transactions* first (bare ids before any dated one), in their original order.
 */
export function keepNewest(list, max) {
  if (list.length <= max) return list;
  const dated = list.map((x, i) => ({ i, d: typeof x === 'string' ? '' : x.date || '' }));
  dated.sort((a, b) => a.d.localeCompare(b.d) || a.i - b.i);
  const keep = new Set(dated.slice(-max).map(o => o.i));
  return list.filter((_, i) => keep.has(i));
}

// ---------- Payee keys & transaction ids ----------

/**
 * Card statements pad the merchant name into a fixed-width column, then the town and country:
 * 'SUPERLOOP LIMITED        1800961618  AUS' and 'Superloop Limited        BRISBANE    AUS' are the
 * same payee. The text before the first run of 2+ spaces is the merchant. Null when there's no such
 * gap (e.g. CommBank transaction-account lines, which use single spaces).
 */
export function merchantPart(raw) {
  const parts = String(raw).trim().split(/\s{2,}/);
  return parts.length > 1 && parts[0].length >= 3 ? parts[0] : null;
}

const NOISE = /\b(VALUE DATE:?\s*\S+|CARD\s*XX\d+|CARD\s*\d+|XX\d+|AUS?|AUSTRALIA|NSW|VIC|QLD|TAS|ACT|NT|NZL?|GBR?|USA?|DIRECT DEBIT|DIRECT CREDIT|TRANSFER (TO|FROM)|PAYMENT (TO|FROM)|EFTPOS|VISA (DEBIT )?PURCHASE|PURCHASE|PENDING|RECURRING|PTY|LTD|LIMITED|INC)\b/g;

// Card terminals and payment services put their own name first: "SQ *WOOLWORTHS SYDNEY" (Square),
// "ZLR*Cafe" (Zeller), "SMP*" / "SUMUP *" (SumUp), "TST*" (Toast), "PAYPAL *NETFLIX". The shop is
// what follows the "*".
const PROCESSOR = /^\s*(SQ|SQUARE|ZLR|ZELLER|SMP|SUMUP|TST|STRIPE|PAYPAL)\s*\*\s*/i;

/** The description without a payment processor's prefix: "SQ *WOOLWORTHS SYDNEY" → "WOOLWORTHS SYDNEY". */
export function withoutProcessor(description) {
  const s = String(description), rest = s.replace(PROCESSOR, '');
  return rest.trim() ? rest : s;
}

/**
 * A stable key for "who was paid": 'NETFLIX.COM Melbourne AU Card xx1234 Value Date: 01/11/2026' →
 * 'NETFLIX COM MELBOURNE', and 'SQ *WOOLWORTHS SYDNEY' → 'WOOLWORTHS SYDNEY'. `legacy` keeps the
 * processor's prefix, as keys were made before Nov 2026, so choices remembered then still apply.
 */
export function payeeKey(description, legacy = false) {
  if (!legacy) description = withoutProcessor(description);
  const s = String(description).toUpperCase().replace(NOISE, ' ').replace(/[^A-Z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const words = s.split(' ').filter(w => w.length > 1).slice(0, 3);
  return words.join(' ') || String(description).toUpperCase().replace(/\s+/g, ' ').slice(0, 24);
}

/** Shop platforms that put a short code before the shop: "SP BOODY" (Shopify), "LS THE SHED" (Lightspeed), "DD DOORDASH". */
const NAME_PREFIX = new Set(['SP', 'LS', 'LSP', 'KPAY', 'DD']);
/** Words a name doesn't stop on: "Best And …", "Eb St …". */
const JOINERS = new Set(['AND', 'OF', 'ON', 'BY', 'AT', 'IN', 'ST', 'THE', 'DE', 'DU', 'LA', 'LE', 'EL']);
/** Words a name doesn't stop after: "The …", "Mrs …", "Dr …". */
const TITLES = new Set(['THE', 'DR', 'MR', 'MRS', 'MS', 'ST']);

/**
 * A readable name for a new group: "DISNEY PLUS SYDNEY" → "Disney Plus", "THE LOCKER ROOM" →
 * "The Locker Room", "BEST AND LESS" → "Best And Less", "SP BOODY" → "Boody". Two words, or three
 * when two would stop mid-name.
 */
export function payeeName(key) {
  let w = [...new Set(key.split(' ').filter(x => !['COM', 'NET', 'ORG', 'WWW'].includes(x)))]; // "GOOGLE GOOGLE" → "Google"
  if (w.length > 1 && NAME_PREFIX.has(w[0])) w = w.slice(1);
  const n = w.length > 2 && (TITLES.has(w[0]) || JOINERS.has(w[1])) ? 3 : 2;
  return (w.slice(0, n).join(' ') || key).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

/** Short hash (FNV-1a) for ids. */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

/**
 * Give each transaction a stable id from account + date + amount + description, plus a counter for
 * identical rows (two £5 coffees on the same day), so re-importing an overlapping statement matches up.
 */
export function withIds(txns, account) {
  const seen = new Map();
  return txns.map(t => {
    const base = `${account.toLowerCase()}|${t.date}|${t.amount}|${t.description.toUpperCase()}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    // `oldPayee` is the key as it was made before, so choices remembered then still apply: with the
    // processor's prefix ("SQ WOOLWORTHS SYDNEY"), else from before merchantPart existed.
    const payee = payeeKey(t.merchant || t.description), legacy = payeeKey(t.merchant || t.description, true);
    return { ...t, id: `t${hash(base)}${n > 1 ? `-${n}` : ''}`, payee,
      oldPayee: legacy !== payee ? legacy : payeeKey(t.description, true) };
  });
}

// ---------- Matching ----------

const STOP = new Set(['the', 'and', 'bill', 'payment', 'monthly', 'plan', 'account', 'my', 'for', 'fee', 'fees']);
const nameTokens = name => String(name).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w));

/** The entry's due date nearest to a transaction (within half a billing period), or null. */
export function nearestDue(e, dateISO) {
  if (e.frequency === 'once') return Math.abs(C.daysBetween(e.startDate, dateISO)) <= 14 ? e.startDate : null;
  const f = C.FREQ[C.freqOn(e, dateISO)];
  if (f.irregular) return null; // no set schedule, no due dates
  const half = Math.max(2, Math.floor((f.days || f.months * 30) / 2));
  const dues = C.occurrences(e, C.addDaysISO(dateISO, -half), C.addDaysISO(dateISO, half));
  if (!dues.length) return null;
  return dues.sort((a, b) => Math.abs(C.daysBetween(a, dateISO)) - Math.abs(C.daysBetween(b, dateISO)))[0];
}

/** How many words of the entry's name appear in the transaction (the bank's text or your name for the payee). */
export function nameHits(txn, e) {
  // Whole words only ("car" must not match "Card xx1234"); longer names may match the start of a
  // word ("electric" → "electricity").
  const words = `${txn.name || ''} ${txn.description}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = nameTokens(e.name);
  return { hits: tokens.filter(t => words.some(w => w === t || (t.length >= 5 && w.startsWith(t)))).length, of: tokens.length };
}

/** Within this many days of a due date counts as "on the due date". */
export const DUE_DAYS = 3;

/**
 * How a transaction fits an entry on three separate signals, each strong, partial or missing:
 *   name   — 'full' (every word of the entry's name) | 'partial' (some words) | null
 *   amount — 'exact' (to the cent; for varying bills, within 10%) | 'close' (within 10%; 50% if it varies) | null
 *   date   — 'due' (within DUE_DAYS of a due date) | 'near' (within a week, longer for long periods) | null
 * It's a match (`ok`) only when the signals agree:
 *   - the full name, plus the amount or the date;
 *   - part of the name, plus both the amount and the date;
 *   - no name, but the exact amount on the due date (e.g. a direct debit with a cryptic name).
 * A card statement has hundreds of purchases, so one signal on its own is never enough: a
 * Woolworths grocery shop shares a word with "Woolworths Mobile", and $14.95 is close to $15.
 * `score` ranks matches against each other.
 */
export function matchDetail(txn, e) {
  const none = { ok: false, score: 0, name: null, amount: null, date: null };
  if ((e.type === 'expense') !== (txn.amount < 0)) return none;
  // Not while the entry wasn't running
  if (txn.date < C.addDaysISO(e.startDate, -14)) return none;
  const stop = C.stopDate(e);
  if (stop && txn.date > C.addDaysISO(stop, 14)) return none;

  const { hits, of } = nameHits(txn, e);
  const name = hits ? (hits === of ? 'full' : 'partial') : null;

  // No set schedule: there are no due dates, and the estimate is per month rather than per payment,
  // so only the name can say whether a transaction belongs to it.
  const irregular = C.isIrregular(e, txn.date);
  let amount = null;
  const est = irregular ? 0 : C.estimateOn(e, txn.date);
  if (est > 0) {
    const a = Math.abs(txn.amount);
    const costs = [est, est * C.shareOf(e)];
    const diff = Math.min(...costs.map(c => Math.abs(a - c) / Math.max(c, 1)));
    if (e.variable) amount = diff <= 0.1 ? 'exact' : diff <= 0.5 ? 'close' : null;
    else amount = costs.some(c => Math.abs(a - c) < 0.005) ? 'exact' : diff <= 0.1 ? 'close' : null;
  }

  let date = null;
  const due = nearestDue(e, txn.date);
  if (due) {
    const f = C.FREQ[C.freqOn(e, txn.date)];
    const near = Math.max(7, Math.round((f.days || f.months * 30) / 10)); // a week; ~9 days quarterly, ~36 yearly
    const days = Math.abs(C.daysBetween(due, txn.date));
    date = days <= DUE_DAYS ? 'due' : days <= near ? 'near' : null;
  }

  const ok = (name === 'full' && (irregular || !!(amount || date)))
    || (name === 'partial' && !!amount && !!date)
    || (!name && amount === 'exact' && date === 'due');
  const score = (name === 'full' ? 4 : name === 'partial' ? 2 : 0)
    + (amount === 'exact' ? 3 : amount === 'close' ? 1.5 : 0)
    + (date === 'due' ? 1.5 : date === 'near' ? 0.5 : 0);
  return { ok, score, name, amount, date };
}

/** A single number for how well a transaction fits an entry; 4 or more is a match. */
export function matchScore(txn, e) {
  const m = matchDetail(txn, e);
  return m.ok ? Math.max(4, m.score) : Math.min(m.score, 3.5);
}

/** Which signals agreed, for the review screen: e.g. ['name', 'amount', 'date']. */
export const matchedOn = m => [m.name && 'name', m.amount && 'amount', m.date && 'date'].filter(Boolean);

/**
 * Suggest an action for each transaction: a remembered rule, else the best-scoring entry (≥ 4).
 * rules: { [payeeKey]: entryId | 'ignore' | 'transfer' }
 * names: { [payeeKey]: the user's own name for that payee } — added to each transaction as `name`.
 */
export function suggest(txns, entries, rules = {}, names = {}) {
  const byId = new Map(entries.map(e => [e.id, e]));
  return txns.map(t0 => {
    const name = names[t0.payee] ?? names[t0.oldPayee] ?? null;
    const t = name ? { ...t0, name } : t0;
    const rule = rules[t.payee] ?? rules[t.oldPayee];
    if (rule === 'ignore' || rule === 'transfer') return { ...t, action: rule, why: 'rule' };
    if (rule && byId.has(rule)) return { ...t, action: rule, why: 'rule' };
    let best = null, bestM = null;
    for (const e of entries) {
      const m = matchDetail(t, e);
      if (m.ok && (!bestM || m.score > bestM.score)) { best = e; bestM = m; }
    }
    return best
      ? { ...t, action: best.id, why: 'match', score: bestM.score, on: matchedOn(bestM), byName: bestM.name === 'full' }
      : { ...t, action: '', why: null };
  });
}

// ---------- Similar payees ----------

/** Payment processors and banking words: the first word says nothing about who was paid ("PAYPAL *NETFLIX"). */
const GENERIC_FIRST = new Set(['paypal', 'square', 'sumup', 'stripe', 'zeller', 'google', 'apple', 'transfer',
  'payment', 'direct', 'internet', 'online', 'osko', 'bpay', 'cash', 'withdrawal', 'deposit', 'interest']);
/** A processor's name before the shop's: "Sq Woolworths" is Woolworths (names made from older keys). */
const PROCESSOR_WORDS = new Set(['sq', 'square', 'zlr', 'zeller', 'smp', 'sumup', 'tst', 'stripe', 'paypal']);
const words = name => {
  const w = String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return w.length > 1 && PROCESSOR_WORDS.has(w[0]) ? w.slice(1) : w;
};

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Well-known Australian businesses → a category, for groups no similar payee has one for yet.
 * Checked in order (so "Uber Eats" is eating out before "Uber" could be anything else).
 */
const KEYWORD_CATEGORIES = [
  ['Groceries', /\b(WOOLWORTHS|WOOLIES\w*|COLES|ALDI|IGA|HARRIS FARM|COSTCO|FOODWORKS)\b/],
  ['Eating out', /\b(MCDONALDS?|MACCAS|KFC|HUNGRY JACKS?|DOMINOS|PIZZA HUT|SUBWAY|GUZMAN Y GOMEZ|NANDOS|EL JANNAH|OPORTO|RED ROOSTER|GRILL D|DOORDASH|UBER EATS|MENULOG|SUSHI|CAFE|COFFEE|BAKERY|KEBABS?|CHATIME)\b/],
  ['Transport', /\b(ELEVEN|AMPOL|CALTEX|SHELL|BP|EG (GROUP|FUEL\w*)|UNITED PETROLEUM|METRO PETROLEUM|LINKT|E ?TOLL|TRANSPORTFORNSW|OPAL|UBER TRIP|PARKING)\b/],
  ['Health', /\b(CHEMIST|PHARMACY|PRICELINE|TERRY WHITE|DENTAL|MEDICAL|PATHOLOGY|PHYSIO\w*|OPTOMETRIST|SPECSAVERS)\b/],
  ['Insurance', /\b(INSURANCE|AAMI|NRMA|BUDGET DIRECT|BUPA|MEDIBANK|HCF|NIB|ALLIANZ|YOUI|GIO)\b/],
  ['Phone & Internet', /\b(TELSTRA|OPTUS|VODAFONE|TPG|AUSSIE BROADBAND|BELONG|AMAYSIM|BOOST MOBILE)\b/],
  ['Utilities', /\b(ORIGIN ENERGY|AGL|ENERGYAUSTRALIA|GLOBIRD\w*|RED ENERGY|ALINTA|SYDNEY WATER)\b/],
  ['Housing', /\b(\w+ (CITY )?COUNCIL|STRATA)\b/], // council rates
  ['Subscriptions', /\b(NETFLIX|SPOTIFY|DISNEY PLUS|STAN|BINGE|KAYO|YOUTUBE|PATREON|AUDIBLE|PUREVPN|ICLOUD)\b/],
  ['Entertainment', /\b(HOYTS|EVENT CINEMAS|CINEMAS?|TICKETEK|TICKETMASTER|ZOO|STEAM|PLAYSTATION|NINTENDO|EB GAMES)\b/],
];

/** A category for a payee from well-known names in it (its name, key or bank text), else ''. */
export function keywordCategory(...texts) {
  const s = texts.join(' ').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ');
  return KEYWORD_CATEGORIES.find(([, re]) => re.test(s))?.[0] || '';
}

/**
 * Whether two payee names are very likely the same business: the same name, one is the other plus
 * more words ("Kmart" / "Kmart Bondi"), the same distinctive first word ("Kmart Bondi" / "Kmart
 * Sydney" — branches in different towns), or a near-identical spelling ("Woolworth" / "Woolworths").
 * Short first words aren't enough on their own: "Uber Eats" and "Uber Trip" stay apart.
 */
export function similarPayees(nameA, nameB) {
  const a = words(nameA), b = words(nameB);
  if (!a.length || !b.length) return false;
  const sa = a.join(' '), sb = b.join(' ');
  if (sa === sb) return true;
  if (a[0] !== b[0]) {
    const n = Math.max(sa.length, sb.length);
    return n >= 6 && editDistance(sa, sb) <= Math.max(1, Math.floor(n * 0.12));
  }
  if (GENERIC_FIRST.has(a[0])) return sa.startsWith(sb) || sb.startsWith(sa) ? Math.min(a.length, b.length) > 1 : false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.every((w, i) => long[i] === w)) return true;
  return a[0].length >= 5;
}

/**
 * Stricter than similarPayees, for whole groups: the same name, one is the other plus more words
 * ("Sushi" / "Sushi Ryu"), or a near-identical spelling. A town in common isn't enough
 * ("Penrith Council" / "Penrith RSL").
 */
function sameName(a, b) { // word lists, from words()
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.every((w, i) => long[i] === w)) return !GENERIC_FIRST.has(short[0]) || short.length > 1;
  const sa = a.join(' '), sb = b.join(' '), n = Math.max(sa.length, sb.length), most = Math.max(1, Math.floor(n * 0.12));
  return n >= 6 && Math.abs(sa.length - sb.length) <= most && editDistance(sa, sb) <= most;
}

/**
 * Groups that look like the same thing twice: same type, with the same name (see sameName) or a
 * payee in common (e.g. "Bupa" and "Bupa Health", or two groups an import made for one shop). One-offs and
 * catch-alls aren't included, nor pairs you said aren't the same (notSame: [[idA, idB]]).
 * Returns [{ keep, merge: [groups] }]: `keep` is the one you set up, else the one with most payments.
 */
export function findDuplicateGroups(entries, notSame = []) {
  const apart = new Set(notSame.map(([a, b]) => [a, b].sort().join('|')));
  const keys = e => new Set((e.payments || []).map(p => p.payee).filter(Boolean));
  const rank = e => (e.scheduleSetByYou || !e.fromImport ? 1e6 : 0) + (e.payments || []).length;
  const list = entries.filter(e => e.frequency !== 'once' && !e.catchAll)
    .map(e => ({ e, keys: keys(e), words: words(e.name) }))
    .sort((a, b) => rank(b.e) - rank(a.e) || a.e.name.localeCompare(b.e.name));
  const same = (a, b) => a.e.type === b.e.type && !apart.has([a.e.id, b.e.id].sort().join('|'))
    && (sameName(a.words, b.words) || [...a.keys].some(k => b.keys.has(k)));
  const out = [];
  const taken = new Set();
  for (const lead of list) {
    if (taken.has(lead.e.id)) continue;
    const merge = list.filter(x => x !== lead && !taken.has(x.e.id) && same(lead, x)).map(x => x.e);
    if (!merge.length) continue;
    taken.add(lead.e.id);
    merge.forEach(e => taken.add(e.id));
    out.push({ keep: lead.e, merge });
  }
  return out;
}

/**
 * Put very similar payees together. payees: [{ key, name, count }] → Map key → the key of the
 * payee that leads its group (the one with the most transactions).
 */
export function clusterPayees(payees) {
  const sorted = [...payees].sort((x, y) => y.count - x.count || x.key.localeCompare(y.key));
  const leads = [];
  const out = new Map();
  for (const p of sorted) {
    const lead = leads.find(l => similarPayees(l.name, p.name));
    if (lead) out.set(p.key, lead.key);
    else { leads.push(p); out.set(p.key, p.key); }
  }
  return out;
}

/** A name for a group of payees: the words their names start with in common ("Kmart Bondi", "Kmart Sydney" → "Kmart"), else the first. */
export function commonName(names) {
  const lists = names.map(n => String(n).split(/\s+/).filter(Boolean));
  const out = [];
  for (let i = 0; i < lists[0].length; i++) {
    const w = lists[0][i].toLowerCase();
    if (lists.every(l => l[i]?.toLowerCase() === w)) out.push(lists[0][i]);
    else break;
  }
  return out.join(' ') || names[0];
}

/**
 * A payee that's very similar to one you've already put in a group goes to that group too: the same
 * company under a different payment form or reference ("TELSTRA BPAY 1234" / "Telstra Corp Ltd"), or
 * seen first in another account. Only transactions with no suggestion yet are changed.
 * known: [{ key, name, groupId, type }] — payees already in a group, and that group's type
 * ('expense' | 'income'). Money in from a payee whose group is an expense is a refund, so it goes
 * there too; money out never goes to an income group.
 */
export function suggestSimilar(txns, known) {
  if (!known.length) return txns;
  const cache = new Map();
  return txns.map(t => {
    if (t.action) return t;
    const name = t.name || payeeName(t.payee);
    if (!cache.has(name)) cache.set(name, known.filter(k => k.key !== t.payee && similarPayees(name, k.name)));
    const hit = cache.get(name).find(k => (t.amount < 0 ? k.type === 'expense' : true));
    return hit ? { ...t, action: hit.groupId, why: 'similar', like: hit.name } : t;
  });
}

// ---------- Payment method ----------

/**
 * How a transaction was paid, from the bank's text: 'BPAY', 'Direct debit', 'PayID', 'Bank transfer',
 * 'Card' or 'Cash'. When the text doesn't say, a credit card account's transactions are 'Credit card';
 * otherwise ''. accountKind is the account's kind ('credit', 'transaction', 'savings', …).
 */
export function guessMethod(description, accountKind = '') {
  const s = String(description).toUpperCase();
  if (/\bBPAY/.test(s)) return 'BPAY'; // also "BPAYN PENRITH CITY"
  if (/\bDIRECT DEBIT\b|\bDD\b(?!\s*\*)/.test(s)) return 'Direct debit'; // not "DD *DOORDASH": DoorDash's card prefix
  if (/\b(OSKO|PAYID|NPP)\b/.test(s)) return 'PayID';
  if (/\b(ATM|CASH OUT|WITHDRAWAL)\b/.test(s)) return 'Cash';
  if (accountKind === 'credit') return 'Credit card';
  if (/\b(CARD\s*X*\d+|VISA|MASTERCARD|EFTPOS|DEBIT CARD|PURCHASE)\b/.test(s) || merchantPart(description)) return 'Card';
  if (/\b(TRANSFER|TFR|XFER|DIRECT CREDIT|SALARY|PAY)\b/.test(s)) return 'Bank transfer';
  return '';
}

/** An account kind from its name: "… credit card" → 'credit', "… savings" → 'savings', else 'transaction'. */
export const guessAccountKind = name => (/card|amex|visa|mastercard/i.test(name) ? 'credit'
  : /sav(ing|er)|bonus|goal|offset/i.test(name) ? 'savings' : 'transaction');

// ---------- Payments already logged by hand ----------

/** How close a hand-logged payment must be to a bank transaction to be treated as the same one. */
export const LINK_DAYS = 4;

/**
 * Pair transactions with payments the user already logged themselves (typed in, or "Mark paid"),
 * so the bank's copy updates that payment instead of adding a second one. A payment counts when
 * it has no bank source, the amount is within 1% (or 1c), and it's within LINK_DAYS days. Each
 * payment pairs with at most one transaction, the nearest in date.
 * decisions: Map txnId → entry id (other values are ignored). Returns Map txnId → payment.
 */
export function planLinks(txns, decisions, entriesById) {
  const pairs = [];
  for (const t of txns) {
    const e = entriesById.get(decisions.get(t.id));
    if (!e) continue;
    const amt = e.type === 'expense' ? -t.amount : t.amount;
    for (const p of e.payments || []) {
      if (p.source || !Number.isFinite(p.amount)) continue;
      const days = Math.abs(C.daysBetween(p.date, t.date));
      if (days <= LINK_DAYS && Math.abs(p.amount - amt) <= Math.max(0.01, Math.abs(amt) * 0.01) + 1e-9) {
        pairs.push({ t, p, days, diff: Math.abs(p.amount - amt) });
      }
    }
  }
  pairs.sort((a, b) => a.days - b.days || a.diff - b.diff);
  const out = new Map(), used = new Set();
  for (const { t, p } of pairs) {
    if (out.has(t.id) || used.has(p.id)) continue;
    out.set(t.id, p);
    used.add(p.id);
  }
  return out;
}

// ---------- Recurring payments you haven't added ----------

const FREQ_BANDS = [
  ['weekly', 7, 1], ['fortnightly', 14, 2], ['fourweekly', 28, 1], ['monthly', 30.4, 4],
  ['quarterly', 91, 8], ['halfyearly', 182, 12], ['yearly', 365, 15],
];
/** At least this many payments before a payee counts as regular: two purchases months apart are a coincidence. */
export const MIN_REGULAR = 3;
/** Share of the gaps between payments that must fit the schedule (an extra top-up or one late bill doesn't spoil it). */
const FIT = 0.8;
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/**
 * The regular schedule a list of payments follows, or null. payments: [{ date, amount }] (either
 * sign; only the size counts). Needs MIN_REGULAR payments on different days, most of the gaps a
 * steady weekly … yearly period, and, given `asOf`, the last one recent enough that it hasn't
 * stopped (no more than about one and a half periods before `asOf`).
 * Weekly and quarterly need one more payment: three in a row a week or three months apart happen by chance.
 * Returns { frequency, amount, variable, last }: amount is the latest payment, or the average of
 * the last three when they vary.
 */
export function scheduleOf(payments, asOf = null) {
  const ts = [...payments].sort((a, b) => a.date.localeCompare(b.date));
  const gaps = ts.slice(1).map((t, i) => C.daysBetween(ts[i].date, t.date)).filter(g => g > 0);
  if (gaps.length < MIN_REGULAR - 1) return null;
  const band = FREQ_BANDS.find(([, days, tol]) => Math.abs(median(gaps) - days) <= tol);
  if (!band) return null;
  const [frequency, days, tol] = band;
  if ((frequency === 'quarterly' || frequency === 'weekly') && gaps.length < MIN_REGULAR) return null;
  const slack = tol * 1.5 + 1;
  // A payment that came late (or early) makes one long and one short gap that add up to two periods
  let fit = 0;
  for (let i = 0; i < gaps.length; i++) {
    if (Math.abs(gaps[i] - days) <= slack) fit++;
    else if (i + 1 < gaps.length && Math.abs(gaps[i] + gaps[i + 1] - 2 * days) <= slack
      && [gaps[i], gaps[i + 1]].every(g => g >= days / 2 && g <= days * 1.5)) { fit += 2; i++; }
  }
  if (fit < Math.ceil(gaps.length * FIT)) return null;
  const last = ts.at(-1).date;
  if (asOf && C.daysBetween(last, asOf) > days * 1.5 + slack) return null;
  const amounts = ts.map(t => Math.abs(t.amount));
  const variable = Math.max(...amounts) / Math.min(...amounts) > 1.05;
  const recent = amounts.slice(-3);
  return { frequency, amount: variable ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length * 100) / 100 : amounts.at(-1),
    variable, last };
}

/**
 * A schedule for a group with none set (Variable) whose payments have come regularly: "Bupa, monthly
 * on the 13th". Null when there's no clear one, it has stopped, the group isn't forecast, or you've
 * already said no to this frequency (`scheduleDismissed`).
 */
export function suggestSchedule(e, today = C.todayISO()) {
  if (e.frequency === 'once' || !C.isIrregular(e, today) || e.noForecast || e.catchAll || C.isEnded(e, today)) return null;
  const pays = (e.payments || []).filter(p => p.amount > 0 && p.date <= today);
  const s = scheduleOf(pays, C.importedUntilFor(e, today));
  return s && e.scheduleDismissed !== s.frequency ? s : null;
}

/**
 * The group on that schedule, from its first payment (so the due day is the day it's usually paid),
 * as a fixed amount or, when the amounts vary, estimated from its payments.
 */
export function withSchedule(e, s) {
  const first = [...(e.payments || [])].filter(p => p.amount > 0).sort((a, b) => a.date.localeCompare(b.date))[0]?.date || e.startDate;
  const g = { ...e, frequency: s.frequency, startDate: first, variable: s.variable, scheduleSetByYou: true, scheduleDismissed: undefined,
    prices: [{ from: first, amount: s.variable ? null : s.amount, frequency: s.frequency }] };
  return { ...g, payments: (e.payments || []).map(p => ({ ...p, due: p.amount > 0 ? nearestDue(g, p.date) : p.due })) };
}

/**
 * Groups of unmatched transactions to the same payee that repeat on a regular schedule (see
 * scheduleOf) and are still going at the end of the statement. Money in (refunds) and money out
 * are looked at separately, so a refund doesn't count as a payment.
 * Returns [{ key, name, txns, frequency, amount, variable, type }], most frequent first.
 */
export function findRecurring(txns) {
  const asOf = txns.reduce((d, t) => (t.date > d ? t.date : d), '');
  const groups = new Map();
  for (const t of txns) {
    const k = `${t.amount < 0 ? 'out' : 'in'}|${t.payee}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const out = [];
  for (const [k, list] of groups) {
    const s = scheduleOf(list, asOf);
    if (!s) continue;
    const ts = [...list].sort((a, b) => a.date.localeCompare(b.date));
    out.push({
      key: k, payee: ts[0].payee, name: ts.find(t => t.name)?.name || payeeName(ts[0].payee), txns: ts, frequency: s.frequency,
      amount: s.amount, variable: s.variable, type: k.startsWith('out') ? 'expense' : 'income',
    });
  }
  return out.sort((a, b) => b.txns.length - a.txns.length);
}

// ---------- Transfers between your own accounts ----------

/**
 * Bank text that's almost always money moving between your own accounts: paying off a credit card,
 * or a transfer to or from a savings account. Plain "Transfer to xx9876 …" isn't enough on its own:
 * that's also how rent or a payment to a friend looks.
 */
const TRANSFER_TEXT = [
  /\bPAYMENT RECEIVED\b/, /\bPAYMENT\W+THANK ?YOU\b/, /\bINTERNAL TRANSFER\b/,
  /\b(CREDIT ?CARD|CARD) (RE)?PAYMENT\b/,
  /\b(TRANSFER|TFR|XFER)\b.*\b(SAVINGS?|SAVER|CREDIT ?CARD|OFFSET|EVERYDAY)\b/,
];
export const looksLikeTransfer = description => {
  const s = String(description).toUpperCase();
  return TRANSFER_TEXT.some(r => r.test(s));
};

/** How far apart the two sides of a transfer can be (a card payment can take a few days to arrive). */
export const TRANSFER_DAYS = 3;

/**
 * Pair transactions with the other side of a transfer in another of your accounts: the same amount
 * the other way, within TRANSFER_DAYS. others: [{ id, account, date, amount (bank sign) }], e.g.
 * transactions already imported into another account's catch-all entry. Each one pairs at most once,
 * nearest date first. `account` is the transactions' account, unless each has its own `account`.
 * Returns Map txnId → other.
 */
export function findTransfers(txns, others, account) {
  const pairs = [];
  for (const t of txns) {
    const acc = String(t.account ?? account).toLowerCase(); // each transaction's own account, when several files are imported together
    for (const o of others) {
      if (String(o.account).toLowerCase() === acc) continue;
      if (Math.abs(o.amount + t.amount) >= 0.005) continue;
      const days = Math.abs(C.daysBetween(o.date, t.date));
      if (days <= TRANSFER_DAYS) pairs.push({ t, o, days });
    }
  }
  pairs.sort((a, b) => a.days - b.days);
  const out = new Map(), used = new Set();
  for (const { t, o } of pairs) {
    if (out.has(t.id) || used.has(o.id)) continue;
    out.set(t.id, o);
    used.add(o.id);
  }
  return out;
}

/**
 * Mark unmatched transactions that look like transfers between your own accounts
 * (action 'transfer'): the other side found in another account (why 'transfer-pair', with `pair`),
 * else the bank's text (why 'transfer-text'). Matches and remembered choices are left alone.
 */
export function suggestTransfers(txns, others, account) {
  const open = txns.filter(t => !t.action);
  const pairs = findTransfers(open, others, account);
  return txns.map(t => {
    if (t.action) return t;
    const pair = pairs.get(t.id);
    if (pair) return { ...t, action: 'transfer', why: 'transfer-pair', pair };
    if (looksLikeTransfer(t.description)) return { ...t, action: 'transfer', why: 'transfer-text' };
    return t;
  });
}

// ---------- Refunds ----------

/**
 * Money back from a payee you pay (a refund) goes to the same entry as their purchases, as a
 * credit, rather than counting as income: first where their purchases in this file are going, else
 * where their earlier imported payments went. history: Map payeeKey → expense entry id.
 */
export function suggestRefunds(txns, history = new Map()) {
  const spentAt = new Map(); // payee → entry id their purchases in this file matched
  for (const t of txns) {
    if (t.amount < 0 && t.action && !['ignore', 'transfer'].includes(t.action)) {
      for (const k of [t.payee, t.oldPayee]) if (k && !spentAt.has(k)) spentAt.set(k, t.action);
    }
  }
  return txns.map(t => {
    if (t.action || t.amount <= 0) return t;
    const id = spentAt.get(t.payee) ?? spentAt.get(t.oldPayee) ?? history.get(t.payee) ?? history.get(t.oldPayee);
    return id ? { ...t, action: id, why: 'refund' } : t;
  });
}

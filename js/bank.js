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

/** '-17.99', '+1,234.56', '$5.00', '(12.00)' → number (negative = money out). */
export function parseMoney(s) {
  const t = String(s ?? '').trim();
  if (!t) return NaN;
  const neg = /^\(.*\)$/.test(t) || /^-|-$/.test(t.replace(/[$£€\s]/g, ''));
  const n = parseFloat(t.replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? (neg ? -n : n) : NaN;
}

const isMoney = s => /^[-+(]?\s*[$£€]?\s*[\d,]+(\.\d+)?\)?-?$/.test(String(s).trim());

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
    const h = first.map(c => c.toLowerCase());
    const find = (...re) => h.findIndex(c => re.some(r => r.test(c)));
    const fmt = {
      bank: 'Bank', hasHeader: true,
      date: find(/^date$/, /transaction date/, /date/),
      amount: find(/^amount/, /value/),
      debit: find(/debit|withdraw|money out/),
      credit: find(/credit|deposit|money in/),
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
    const raw = r[fmt.desc] || '';
    const description = raw.replace(/\s+/g, ' ').trim();
    if (!date || !Number.isFinite(amount) || amount === 0 || !description) continue;
    const balance = fmt.balance >= 0 ? parseMoney(r[fmt.balance]) : NaN;
    out.push({ date, amount: Math.round(amount * 100) / 100, description, merchant: merchantPart(raw),
      balance: Number.isFinite(balance) ? balance : null });
  }
  return out;
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

/** A stable key for "who was paid": 'NETFLIX.COM Melbourne AU Card xx1234 Value Date: 01/11/2026' → 'NETFLIX COM MELBOURNE'. */
export function payeeKey(description) {
  const s = String(description).toUpperCase().replace(NOISE, ' ').replace(/[^A-Z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const words = s.split(' ').filter(w => w.length > 1).slice(0, 3);
  return words.join(' ') || String(description).toUpperCase().replace(/\s+/g, ' ').slice(0, 24);
}

/** "NETFLIX COM MELBOURNE" → "Netflix" (a readable name for a new entry). */
export function payeeName(key) {
  const w = key.split(' ').filter(x => !['COM', 'NET', 'ORG', 'WWW'].includes(x));
  return (w.slice(0, 2).join(' ') || key).toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
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
    // `oldPayee` is the key before merchantPart existed, so choices remembered then still apply.
    return { ...t, id: `t${hash(base)}${n > 1 ? `-${n}` : ''}`, payee: payeeKey(t.merchant || t.description),
      oldPayee: payeeKey(t.description) };
  });
}

// ---------- Matching ----------

const STOP = new Set(['the', 'and', 'bill', 'payment', 'monthly', 'plan', 'account', 'my', 'for', 'fee', 'fees']);
const nameTokens = name => String(name).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w));

/** The entry's due date nearest to a transaction (within half a billing period), or null. */
export function nearestDue(e, dateISO) {
  if (e.frequency === 'once') return Math.abs(C.daysBetween(e.startDate, dateISO)) <= 14 ? e.startDate : null;
  const f = C.FREQ[C.freqOn(e, dateISO)];
  const half = Math.max(2, Math.floor((f.days || f.months * 30) / 2));
  const dues = C.occurrences(e, C.addDaysISO(dateISO, -half), C.addDaysISO(dateISO, half));
  if (!dues.length) return null;
  return dues.sort((a, b) => Math.abs(C.daysBetween(a, dateISO)) - Math.abs(C.daysBetween(b, dateISO)))[0];
}

/**
 * How well a transaction fits an entry. Needs a name match, or an exact amount on a due date,
 * before it counts as a suggestion (score ≥ 4).
 */
export function matchScore(txn, e) {
  const out = txn.amount < 0;
  if ((e.type === 'expense') !== out) return 0;
  // Whole words only ("car" must not match "Card xx1234"); longer names may match the start of a
  // word ("electric" → "electricity").
  const words = txn.description.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = nameTokens(e.name);
  const hits = tokens.filter(t => words.some(w => w === t || (t.length >= 5 && w.startsWith(t)))).length;
  let score = hits ? (hits === tokens.length ? 4 : 3) : 0;

  const a = Math.abs(txn.amount);
  const est = C.estimateOn(e, txn.date);
  let exact = false;
  if (est > 0) {
    const diff = Math.min(...[est, est * C.shareOf(e)].map(c => Math.abs(a - c) / Math.max(c, 1)));
    exact = diff <= 0.01;
    if (e.variable) score += diff <= 0.5 ? 1.5 : 0;
    else score += exact ? 3 : diff <= 0.1 ? 1 : 0;
  }
  const due = nearestDue(e, txn.date);
  if (due) score += 1;
  if (txn.date < C.addDaysISO(e.startDate, -14)) score -= 3;
  const stop = C.stopDate(e);
  if (stop && txn.date > C.addDaysISO(stop, 14)) score -= 3;
  if (!hits && !(exact && due)) return Math.min(score, 3.5); // never a suggestion on amount alone
  return score;
}

/**
 * Suggest an action for each transaction: a remembered rule, else the best-scoring entry (≥ 4).
 * rules: { [payeeKey]: entryId | 'ignore' }
 */
export function suggest(txns, entries, rules = {}) {
  const byId = new Map(entries.map(e => [e.id, e]));
  return txns.map(t => {
    const rule = rules[t.payee] ?? rules[t.oldPayee];
    if (rule === 'ignore') return { ...t, action: 'ignore', why: 'rule' };
    if (rule && byId.has(rule)) return { ...t, action: rule, why: 'rule' };
    let best = null, bestScore = 0;
    for (const e of entries) {
      const s = matchScore(t, e);
      if (s > bestScore) { best = e; bestScore = s; }
    }
    return bestScore >= 4 ? { ...t, action: best.id, why: 'match', score: bestScore } : { ...t, action: '', why: null };
  });
}

// ---------- Recurring payments you haven't added ----------

const FREQ_BANDS = [
  ['weekly', 7, 1], ['fortnightly', 14, 2], ['fourweekly', 28, 1], ['monthly', 30.4, 4],
  ['quarterly', 91, 8], ['halfyearly', 182, 12], ['yearly', 365, 15],
];

/**
 * Groups of unmatched transactions to the same payee that repeat on a regular schedule.
 * Returns [{ key, name, txns, frequency, amount, variable, type }], most frequent first.
 */
export function findRecurring(txns) {
  const groups = new Map();
  for (const t of txns) {
    const k = `${t.amount < 0 ? 'out' : 'in'}|${t.payee}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const out = [];
  for (const [k, list] of groups) {
    if (list.length < 2) continue;
    const ts = [...list].sort((a, b) => a.date.localeCompare(b.date));
    const gaps = ts.slice(1).map((t, i) => C.daysBetween(ts[i].date, t.date)).filter(g => g > 0);
    if (!gaps.length) continue;
    const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    const band = FREQ_BANDS.find(([, days, tol]) => Math.abs(median - days) <= tol);
    if (!band) continue;
    if (!gaps.every(g => Math.abs(g - band[1]) <= band[2] * 1.5 + 1)) continue;
    const amounts = ts.map(t => Math.abs(t.amount));
    const min = Math.min(...amounts), max = Math.max(...amounts);
    out.push({
      key: k, payee: ts[0].payee, name: payeeName(ts[0].payee), txns: ts, frequency: band[0],
      amount: amounts.at(-1), variable: max / min > 1.05, type: k.startsWith('out') ? 'expense' : 'income',
    });
  }
  return out.sort((a, b) => b.txns.length - a.txns.length);
}

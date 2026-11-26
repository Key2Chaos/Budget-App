// Reports built on top of the core maths: biggest changes, yearly totals, budgets,
// "until payday" and spreadsheet (CSV) export. Pure functions — no DOM — so they're testable.
import * as C from './calc.js';
import * as M from './model.js';

/** Monthly cost on a date (your share), or 0 if the entry isn't running then. One-offs are 0. */
export function monthlyAt(e, dateISO) {
  if (e.frequency === 'once' || e.startDate > dateISO) return 0;
  const stop = C.stopDate(e);
  if (stop && stop < dateISO) return 0;
  return C.monthlyEquivalent(e, dateISO);
}

/** Entries whose monthly cost changed most between two dates (new and ended ones included). */
export function biggestChanges(entries, fromISO, toISO, limit = 5) {
  const rows = [];
  for (const e of entries) {
    if (e.frequency === 'once') continue;
    const before = monthlyAt(e, fromISO), after = monthlyAt(e, toISO);
    const diff = after - before;
    if (Math.abs(diff) < 0.005) continue;
    const kind = before === 0 ? 'new' : after === 0 ? 'ended' : diff > 0 ? 'up' : 'down';
    rows.push({ e, before, after, diff, kind });
  }
  return rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, limit);
}

/** Yearly totals at today's rates: 12 × the monthly cost of everything running on that date. */
export function annualTotals(entries, dateISO) {
  let income = 0, expense = 0;
  for (const e of entries) {
    const v = 12 * monthlyAt(e, dateISO);
    if (e.type === 'income') income += v; else expense += v;
  }
  return { income, expense, net: income - expense };
}

/** The 12 full calendar months before the one `now` is in: [{ y, m }], oldest first. */
export function lastTwelveMonths(now = new Date()) {
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 12 + i, 1);
    return { y: d.getFullYear(), m: d.getMonth() };
  });
}

/** What one group came to over the last 12 full months, month by month as the chart counts it. */
export const lastYearAmount = (e, now = new Date()) =>
  lastTwelveMonths(now).reduce((s, { y, m }) => s + C.monthAmount(e, y, m), 0);

/** Totals over the last 12 full months (what actually applied, one-offs included). */
export function lastYearTotals(entries, now = new Date()) {
  let income = 0, expense = 0;
  for (const e of entries) {
    const v = lastYearAmount(e, now);
    if (e.type === 'income') income += v; else expense += v;
  }
  return { income, expense, net: income - expense };
}

// ---------- Budgets ----------

/** Does an expense count towards a budget? (a group, a category or a tag, ignoring capitals) */
export function inBudget(e, budget) {
  if (e.type !== 'expense') return false;
  const label = budget.label.toLowerCase();
  if (budget.kind === 'group') return budget.groupId ? e.id === budget.groupId : e.name.toLowerCase() === label;
  return budget.kind === 'tag'
    ? (e.tags || []).some(t => t.toLowerCase() === label)
    : (e.category || '').toLowerCase() === label;
}

/** Spending against a monthly budget for calendar month (y, m0). */
export function budgetStatus(entries, budget, y, m0) {
  const spent = entries.filter(e => inBudget(e, budget)).reduce((s, e) => s + C.monthAmount(e, y, m0), 0);
  const pct = budget.amount > 0 ? spent / budget.amount : 0;
  return { budget, spent, left: budget.amount - spent, pct, over: spent > budget.amount + 0.005, near: pct >= 0.9 };
}

/** Budgets that an edit pushed over, or made worse while already over (to warn after saving). */
export function newlyOver(before, after, budgets, y, m0) {
  return budgets
    .map(b => ({ was: budgetStatus(before, b, y, m0), now: budgetStatus(after, b, y, m0) }))
    .filter(x => x.now.over && x.now.spent > x.was.spent + 0.005)
    .map(x => x.now);
}

// ---------- Until payday ----------

/**
 * Everything due from today until the day before next payday.
 * Payday = next payment of the chosen income entry, or of your biggest recurring income.
 * Manual payments already marked paid are skipped; overdue manual ones are included as due today.
 */
export function untilPayday(entries, today = C.todayISO(), paydayEntryId = null) {
  const incomes = entries.filter(e => e.type === 'income' && e.frequency !== 'once' && !C.isEnded(e, today) && !C.isIrregular(e, today));
  if (!incomes.length) return null;
  const main = incomes.find(e => e.id === paydayEntryId)
    || [...incomes].sort((a, b) => C.monthlyEquivalent(b, today) - C.monthlyEquivalent(a, today))[0];
  const payday = C.nextDue(main, C.addDaysISO(today, 1));
  if (!payday) return null;
  const lastDay = C.addDaysISO(payday, -1);

  const items = [];
  for (const { e, due } of C.toPay(entries, today, 0)) {
    if (due < today) items.push({ e, date: today, due, overdue: true, amount: signedAmount(e, due) });
  }
  for (const e of entries) {
    if (e.id === main.id) continue;
    for (const d of C.occurrences(e, today, lastDay)) {
      if (e.manual && C.isPaid(e, d)) continue;
      items.push({ e, date: d, due: d, overdue: false, amount: signedAmount(e, d) });
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount);
  const out = items.filter(i => i.amount < 0).reduce((s, i) => s - i.amount, 0);
  const inc = items.filter(i => i.amount > 0).reduce((s, i) => s + i.amount, 0);
  return { main, payday, days: C.daysBetween(today, payday), items, out, in: inc, net: inc - out };
}

const signedAmount = (e, d) => (e.type === 'income' ? 1 : -1) * C.shareOf(e) * C.estimateOn(e, d);

// ---------- Spreadsheet (CSV) export ----------

/** Round to pennies, halves away from zero, without float surprises (12.345 → 12.35). */
const round2 = n => Math.sign(n) * Math.round(Number((Math.abs(n) * 100).toPrecision(12))) / 100;

/**
 * One CSV cell. Numbers are written plainly; text is quoted when needed, and text that a spreadsheet
 * would treat as a formula (starting = + - @) is prefixed with ' so it can't run as one.
 */
export function csvCell(v) {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(round2(v)) : '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows → CSV text (with a BOM so Excel reads £/€ correctly). */
export const toCSV = rows => '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

export function entriesRows(entries, today = C.todayISO()) {
  const head = ['Name', 'Type', 'Category', 'Payment method', 'How often (now)', 'Amount (full bill)', 'Your share %',
    'Per month (your share)', 'Per year (your share)', 'First payment', 'Next payment', 'Contract ends',
    'Notice (days)', 'Cancelled on', 'Amount varies', 'Manual', 'Tags', 'Notes'];
  const rows = [...entries]
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
    .map(e => {
      const once = e.frequency === 'once';
      return [
        e.name, e.type === 'income' ? 'Income' : 'Expense', e.category, e.method,
        C.FREQ[once ? 'once' : C.freqOn(e, today)].label,
        once ? C.priceOn(e, e.startDate) : C.estimateOn(e, today),
        e.share ?? 100, monthlyAt(e, today), 12 * monthlyAt(e, today),
        e.startDate, C.nextDue(e, today), e.contractEnd, e.noticeDays, e.endDate,
        !!e.variable, !!e.manual, (e.tags || []).join(' '), e.notes,
      ];
    });
  return [head, ...rows];
}

export function paymentsRows(entries, settings = {}) {
  const head = ['Date', 'Name', 'Type', 'Category', 'Amount (full bill)', 'Your share', 'For payment due', 'Note',
    'Payee', 'Account', 'Payment method'];
  const rows = [];
  for (const e of entries) for (const p of e.payments || []) {
    rows.push([p.date, e.name, e.type === 'income' ? 'Income' : 'Expense', e.category, p.amount,
      p.amount * C.shareOf(e), p.due, p.note, p.payee ? M.keyTitle(settings, p.payee) : '',
      p.account ? M.accountName(settings, p.account) : '', p.method || (p.source ? '' : e.method)]);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  return [head, ...rows];
}

/** Payees: name, group (or rule), the bank's spellings, and their payments. */
export function payeesRows(entries, settings = {}) {
  const head = ['Payee', 'Payee group', 'Bank spellings', 'Payments', 'Total'];
  const byId = new Map(entries.map(e => [e.id, e]));
  const rows = M.payeesOf(settings).map(p => {
    const keys = new Set(p.keys);
    const pays = entries.flatMap(e => (e.payments || []).filter(x => keys.has(x.payee)).map(x => (e.type === 'expense' ? x.amount : -x.amount)));
    const group = p.rule === 'ignore' ? 'Always ignored' : p.rule === 'transfer' ? 'Transfer' : byId.get(p.groupId)?.name || 'Ungrouped';
    return [M.payeeTitle(p), group, p.keys.join(' | '), pays.length, pays.reduce((n, a) => n + a, 0)];
  }).sort((a, b) => a[0].localeCompare(b[0]));
  return [head, ...rows];
}

export function monthlyRows(entries, y, m0, count) {
  const head = ['Month', 'Income', 'Expenses', 'Net'];
  return [head, ...C.series(entries, y, m0, count).map(s =>
    [`${s.y}-${String(s.m + 1).padStart(2, '0')}`, s.income, s.expense, s.net])];
}

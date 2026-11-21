// Pure date + money calculations (no DOM). Dates are stored as 'YYYY-MM-DD' strings,
// which compare correctly as plain strings.

export const FREQ = {
  once:        { label: 'One-off',        perMonth: 0 },
  weekly:      { label: 'Weekly',         perMonth: 52 / 12, days: 7 },
  fortnightly: { label: 'Every 2 weeks',  perMonth: 26 / 12, days: 14 },
  fourweekly:  { label: 'Every 4 weeks',  perMonth: 13 / 12, days: 28 },
  monthly:     { label: 'Monthly',        perMonth: 1,       months: 1 },
  quarterly:   { label: 'Quarterly',      perMonth: 1 / 3,   months: 3 },
  halfyearly:  { label: 'Every 6 months', perMonth: 1 / 6,   months: 6 },
  yearly:      { label: 'Yearly',         perMonth: 1 / 12,  months: 12 },
};

const pad = n => String(n).padStart(2, '0');
export const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const todayISO = () => iso(new Date());
export const addDaysISO = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
export const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);

// Add n months, clamping the day (31 Jan + 1 month = 28/29 Feb).
export function addMonths(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth() + n, 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(date.getDate(), last));
  return d;
}

/**
 * An entry's history is a list of periods: { from, amount, frequency }.
 * Each change of price and/or frequency starts a new period. (Stored as `prices` for history reasons.)
 */
export const sortedPrices = e => [...(e.prices || [])]
  .sort((a, b) => a.from.localeCompare(b.from))
  .map(p => ({ ...p, frequency: e.frequency === 'once' ? 'once' : (p.frequency || e.frequency) }));

/** The period in force on a given date (latest change on or before it; the first one before the start). */
export function periodOn(e, dateISO) {
  const periods = sortedPrices(e);
  let cur = periods[0];
  for (const p of periods) { if (p.from <= dateISO) cur = p; else break; }
  return cur;
}

/** Amount charged per payment on a given date. */
export const priceOn = (e, dateISO) => periodOn(e, dateISO)?.amount ?? 0; // blank estimate (varying bill) → 0

/** How often it's paid on a given date. */
export const freqOn = (e, dateISO = todayISO()) => periodOn(e, dateISO)?.frequency || e.frequency;

export const currentPrice = e => priceOn(e, todayISO());

/** Date payments stop: explicit end date, or contract end if set to stop then. */
export const stopDate = e => e.endDate || (e.endsAtExpiry && e.contractEnd) || null;

export const isEnded = (e, onISO = todayISO()) =>
  e.frequency === 'once' ? false : !!(stopDate(e) && stopDate(e) < onISO);

/** Fraction of the bill that is yours (e.g. 0.5 for a bill split in half). */
export const shareOf = e => (Number.isFinite(e.share) && e.share > 0 && e.share < 100 ? e.share / 100 : 1);

const byDate = (a, b) => a.date.localeCompare(b.date);
export const paymentsOf = e => [...(e.payments || [])].sort(byDate);

/**
 * Expected amount per payment on a date (full bill, before your share).
 * Fixed bills: the planned amount. "Amount varies" bills: the average of the last 3 payments
 * logged since the current plan period began, falling back to the planned amount.
 */
export function estimateOn(e, dateISO = todayISO()) {
  const p = periodOn(e, dateISO);
  if (!p) return 0;
  if (!e.variable) return p.amount ?? 0;
  const avg = list => list.reduce((s, x) => s + x.amount, 0) / list.length;
  const before = paymentsOf(e).filter(x => x.date <= dateISO && x.amount > 0);
  // 1. last three payments on the current plan
  const inPeriod = before.filter(x => x.date >= p.from).slice(-3);
  if (inPeriod.length) return avg(inPeriod);
  // 2. an estimate typed in for this period
  if (p.amount != null) return p.amount;
  // 3. earlier payments, converted to this period's frequency via their monthly rate
  const recent = before.slice(-3);
  if (!recent.length) return 0;
  const perMonth = FREQ[p.frequency].perMonth;
  if (!perMonth) return avg(recent);
  const monthly = recent.reduce((s, x) => s + x.amount * FREQ[freqOn(e, x.date)].perMonth, 0) / recent.length;
  return monthly / perMonth;
}

/** Planned monthly amount on a date (full bill). */
function planPerMonth(e, dateISO) {
  const p = periodOn(e, dateISO);
  return estimateOn(e, dateISO) * FREQ[p.frequency].perMonth;
}

/** Normalised monthly amount, your share (e.g. yearly / 12, weekly * 52 / 12). */
export function monthlyEquivalent(e, onISO = todayISO()) {
  if (e.frequency === 'once') return 0;
  return shareOf(e) * planPerMonth(e, onISO);
}

/**
 * Logged payments as non-overlapping spans of days. Each payment covers the period leading up to
 * its date (one billing period, or back to the previous payment if that's sooner), so a quarterly
 * bill is spread over the three months it covers instead of landing in one month.
 * A span covers the days after `fromExcl` up to and including `to`.
 */
export function paymentSpans(e) {
  const out = [];
  let prev = null;
  for (const p of paymentsOf(e)) {
    const f = FREQ[e.frequency === 'once' ? 'monthly' : freqOn(e, p.date)];
    let from = f.days ? addDaysISO(p.date, -f.days) : iso(addMonths(parse(p.date), -f.months));
    if (prev && prev > from) from = prev;
    const days = daysBetween(from, p.date);
    if (days > 0) out.push({ fromExcl: from, to: p.date, amount: p.amount, days });
    else if (out.length) out.at(-1).amount += p.amount; // second payment on the same day
    else out.push({ fromExcl: addDaysISO(p.date, -1), to: p.date, amount: p.amount, days: 1 });
    prev = p.date;
  }
  return out;
}

/** Contribution of one entry to a calendar month (y, m0 = 0-based month), your share. */
export function monthAmount(e, y, m0) {
  const start = iso(new Date(y, m0, 1));
  const end = iso(new Date(y, m0 + 1, 0));
  const share = shareOf(e);
  if (e.frequency === 'once') {
    const pays = e.payments || [];
    if (pays.length) return share * pays.filter(p => p.date >= start && p.date <= end).reduce((s, p) => s + p.amount, 0);
    return e.startDate >= start && e.startDate <= end ? share * priceOn(e, e.startDate) : 0;
  }
  // What was actually paid for days in this month…
  const monthDays = daysBetween(start, end) + 1;
  let actual = 0, covered = 0;
  for (const s of paymentSpans(e)) {
    const a = addDaysISO(s.fromExcl, 1) > start ? addDaysISO(s.fromExcl, 1) : start;
    const b = s.to < end ? s.to : end;
    if (a > b) continue;
    const overlap = daysBetween(a, b) + 1;
    actual += (s.amount * overlap) / s.days;
    covered += overlap;
  }
  // …and the plan for any days no logged payment covers.
  let planned = 0;
  const stop = stopDate(e);
  if (!(e.startDate > end || (stop && stop < start))) {
    const ref = stop && stop < end ? stop : end;
    planned = planPerMonth(e, ref) * Math.max(0, 1 - covered / monthDays);
  }
  return share * (actual + planned);
}

/** Last day to give notice before the contract ends (or null). */
export const noticeBy = e => (e.contractEnd && e.noticeDays > 0 ? addDaysISO(e.contractEnd, -e.noticeDays) : null);

export function monthTotals(entries, y, m0) {
  let income = 0, expense = 0;
  for (const e of entries) {
    const v = monthAmount(e, y, m0);
    if (e.type === 'income') income += v; else expense += v;
  }
  return { y, m: m0, income, expense, net: income - expense };
}

/** Monthly totals for `count` months starting at (y, m0). */
export function series(entries, y, m0, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(y, m0 + i, 1);
    out.push(monthTotals(entries, d.getFullYear(), d.getMonth()));
  }
  return out;
}

/** First date on or after fromISO in a schedule that started on anchorISO. */
function nextOnSchedule(anchorISO, frequency, fromISO) {
  const f = FREQ[frequency];
  const start = parse(anchorISO);
  const from = parse(fromISO);
  if (from <= start) return anchorISO;
  let d;
  if (f.days) {
    const k = Math.ceil(Math.round((from - start) / 864e5) / f.days);
    d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + k * f.days);
  } else {
    let k = (from.getFullYear() - start.getFullYear()) * 12 + from.getMonth() - start.getMonth();
    k = Math.max(0, Math.floor(k / f.months) * f.months);
    d = addMonths(start, k);
    while (d < from) { k += f.months; d = addMonths(start, k); }
  }
  return iso(d);
}

/**
 * Payment schedules: consecutive periods with the same frequency share one schedule, so a
 * price-only change keeps the usual payment day. A frequency change starts a new schedule on its date.
 */
function schedules(e) {
  const out = [];
  for (const p of sortedPrices(e)) {
    if (!out.length || out.at(-1).frequency !== p.frequency) out.push({ from: p.from, frequency: p.frequency });
  }
  if (out.length) out[0].from = e.startDate;
  return out;
}

/** Next payment date on or after fromISO, or null if none. */
export function nextDue(e, fromISO = todayISO()) {
  if (e.frequency === 'once') return e.startDate >= fromISO ? e.startDate : null;
  const segs = schedules(e);
  let i = 0;
  while (i + 1 < segs.length && segs[i + 1].from <= fromISO) i++;
  let s = nextOnSchedule(segs[i].from, segs[i].frequency, fromISO);
  if (segs[i + 1] && s >= segs[i + 1].from) s = segs[i + 1].from;
  const stop = stopDate(e);
  return stop && s > stop ? null : s;
}

/** All payment dates from fromISO to toISO (inclusive). */
export function occurrences(e, fromISO, toISO) {
  const out = [];
  let d = nextDue(e, fromISO);
  while (d && d <= toISO && out.length < 400) {
    out.push(d);
    if (e.frequency === 'once') break;
    d = nextDue(e, addDaysISO(d, 1));
  }
  return out;
}

/**
 * Has the payment due on dueISO been logged? A payment marked for that due date counts; otherwise
 * any payment within half a billing period of it does.
 */
export function isPaid(e, dueISO) {
  const pays = e.payments || [];
  if (e.frequency === 'once') return pays.length > 0;
  const f = FREQ[freqOn(e, dueISO)];
  const half = f.days ? f.days / 2 : f.months * 15;
  return pays.some(p => (p.due ? p.due === dueISO : Math.abs(daysBetween(p.date, dueISO)) < half));
}

/** Manual payments that are overdue (up to 35 days back) or due within `aheadDays`. */
export function toPay(entries, today = todayISO(), aheadDays = 14) {
  const out = [];
  for (const e of entries) {
    if (!e.manual) continue;
    const from = [addDaysISO(today, -35), e.startDate].sort().at(-1);
    for (const due of occurrences(e, from, addDaysISO(today, aheadDays))) {
      if (!isPaid(e, due)) out.push({ e, due, overdue: due < today });
    }
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}

/** Parse user-typed money like "£1,234.50" or "12,50". */
export function parseAmount(str) {
  let s = String(str ?? '').replace(/[^\d.,-]/g, '');
  if (s.includes(',') && !s.includes('.') && /,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

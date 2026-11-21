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
export const priceOn = (e, dateISO) => periodOn(e, dateISO)?.amount ?? 0;

/** How often it's paid on a given date. */
export const freqOn = (e, dateISO = todayISO()) => periodOn(e, dateISO)?.frequency || e.frequency;

export const currentPrice = e => priceOn(e, todayISO());

/** Date payments stop: explicit end date, or contract end if set to stop then. */
export const stopDate = e => e.endDate || (e.endsAtExpiry && e.contractEnd) || null;

export const isEnded = (e, onISO = todayISO()) =>
  e.frequency === 'once' ? false : !!(stopDate(e) && stopDate(e) < onISO);

/** Normalised monthly amount (e.g. yearly / 12, weekly * 52 / 12). */
export function monthlyEquivalent(e, onISO = todayISO()) {
  if (e.frequency === 'once') return 0;
  const p = periodOn(e, onISO);
  return p.amount * FREQ[p.frequency].perMonth;
}

/** Contribution of one entry to a calendar month (y, m0 = 0-based month). */
export function monthAmount(e, y, m0) {
  const start = iso(new Date(y, m0, 1));
  const end = iso(new Date(y, m0 + 1, 0));
  if (e.frequency === 'once') {
    return e.startDate >= start && e.startDate <= end ? priceOn(e, e.startDate) : 0;
  }
  const stop = stopDate(e);
  if (e.startDate > end || (stop && stop < start)) return 0;
  const ref = stop && stop < end ? stop : end;
  return monthlyEquivalent(e, ref);
}

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

/** Parse user-typed money like "£1,234.50" or "12,50". */
export function parseAmount(str) {
  let s = String(str ?? '').replace(/[^\d.,-]/g, '');
  if (s.includes(',') && !s.includes('.') && /,\d{1,2}$/.test(s)) s = s.replace(',', '.');
  s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

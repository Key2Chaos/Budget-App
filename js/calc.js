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

export const sortedPrices = e => [...(e.prices || [])].sort((a, b) => a.from.localeCompare(b.from));

/** Amount charged per payment on a given date (latest price change on or before it). */
export function priceOn(e, dateISO) {
  const prices = sortedPrices(e);
  let cur = prices[0];
  for (const p of prices) { if (p.from <= dateISO) cur = p; else break; }
  return cur ? cur.amount : 0;
}

export const currentPrice = e => priceOn(e, todayISO());

/** Date payments stop: explicit end date, or contract end if set to stop then. */
export const stopDate = e => e.endDate || (e.endsAtExpiry && e.contractEnd) || null;

export const isEnded = (e, onISO = todayISO()) =>
  e.frequency === 'once' ? false : !!(stopDate(e) && stopDate(e) < onISO);

/** Normalised monthly amount (e.g. yearly / 12, weekly * 52 / 12). */
export const monthlyEquivalent = (e, onISO = todayISO()) =>
  e.frequency === 'once' ? 0 : priceOn(e, onISO) * FREQ[e.frequency].perMonth;

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
  return priceOn(e, ref) * FREQ[e.frequency].perMonth;
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

/** Next payment date on or after fromISO, or null if none. */
export function nextDue(e, fromISO = todayISO()) {
  if (e.frequency === 'once') return e.startDate >= fromISO ? e.startDate : null;
  const f = FREQ[e.frequency];
  const start = parse(e.startDate);
  const from = parse(fromISO);
  let d;
  if (from <= start) {
    d = start;
  } else if (f.days) {
    const k = Math.ceil(Math.round((from - start) / 864e5) / f.days);
    d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + k * f.days);
  } else {
    let k = (from.getFullYear() - start.getFullYear()) * 12 + from.getMonth() - start.getMonth();
    k = Math.max(0, Math.floor(k / f.months) * f.months);
    d = addMonths(start, k);
    while (d < from) { k += f.months; d = addMonths(start, k); }
  }
  const s = iso(d);
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

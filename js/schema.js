// Data format + migrations. This is what keeps old backups (and data already stored on the
// phone) working as the app changes.
//
// RULES (see README → "Keeping old backups working"):
//  1. Never edit or remove an existing migration step once it has been released.
//  2. Changing the shape of the data? Bump SCHEMA_VERSION and add a step to MIGRATIONS that
//     upgrades version N-1 → N. Then add a backup in the old format to tests/fixtures/.
//  3. Adding an optional field is NOT a format change: just give it a default in normalizeEntry().
import { FREQ } from './calc.js';
import { payeeKey, guessMethod, guessAccountKind } from './bank.js';
import { normalizeAccounts, normalizePayees } from './model.js';

export const APP_ID = 'budget-pwa';
export const SCHEMA_VERSION = 5;

/** MIGRATIONS[n] upgrades a backup object from version n to n + 1. */
const MIGRATIONS = {
  // v1 → v2 (Nov 2026): frequency moved from the entry onto each price period, so a bill can
  // change e.g. from yearly to monthly without rewriting its history.
  1: data => ({
    ...data,
    version: 2,
    entries: data.entries.map(e => (e && typeof e === 'object' && Array.isArray(e.prices)
      ? { ...e, prices: e.prices.map(p => (p && typeof p === 'object' ? { ...p, frequency: e.frequency } : p)) }
      : e)),
  }),
  // v2 → v3 (Nov 2026): a price period's amount may now be null for "amount varies" bills (the
  // estimate comes from logged payments). Nothing to convert — the bump only stops older app
  // versions, which would drop such entries, from importing v3 backups.
  2: data => ({ ...data, version: 3 }),
  // v3 → v4 (Nov 2026): new frequency 'irregular' (no set schedule). Nothing to convert — the bump
  // stops older app versions, which don't know it and would drop such entries, from importing v4.
  3: data => ({ ...data, version: 4 }),
  // v4 → v5 (Nov 2026): your accounts and payees become records of their own (docs/DESIGN.md).
  // bankAccounts + accountNames → accounts; payeeRules + payeeNames → payees (each payee key one
  // payee, with its group or ignore/transfer rule and your name). Imported payments get a payment
  // method guessed from the bank's text, and entries an import added stop using the account's name
  // as their payment method.
  4: data => {
    const s = data.settings && typeof data.settings === 'object' ? { ...data.settings } : {};
    const old = legacyImportSettings(s);
    const accounts = old.bankAccounts.map(key => ({ key, name: old.accountNames[key.toLowerCase()] || key, kind: guessAccountKind(key) }));
    const kindOf = acc => accounts.find(a => a.key.toLowerCase() === String(acc ?? '').toLowerCase())?.kind || '';
    const accountNames = new Set(accounts.flatMap(a => [a.key.toLowerCase(), a.name.toLowerCase()]));
    const entries = data.entries.map(e => {
      if (!e || typeof e !== 'object' || !Array.isArray(e.payments)) return e;
      const payments = e.payments.map(p => (p && typeof p === 'object' && p.source && typeof p.method !== 'string'
        ? { ...p, method: guessMethod(String(p.note ?? '').split(' · ').at(-1), kindOf(p.account)) } : p));
      let method = e.method;
      if ((e.fromImport || e.catchAll) && typeof method === 'string' && accountNames.has(method.trim().toLowerCase())) {
        const counts = new Map();
        for (const p of payments) if (p?.method) counts.set(p.method, (counts.get(p.method) || 0) + 1);
        method = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      }
      return { ...e, method, payments };
    });
    // One payee per payee key: remembered ones, named ones, then any seen on imported payments
    const keys = [...Object.keys(old.payeeRules), ...Object.keys(old.payeeNames)];
    for (const e of entries) for (const p of e?.payments || []) {
      if (p?.source) keys.push(p.payee || payeeKey(String(p.note ?? '').split(' · ').at(-1), true));
    }
    const payees = [...new Set(keys.filter(Boolean))].map(k => {
      const v = old.payeeRules[k];
      const rule = v === 'ignore' || v === 'transfer' ? v : null;
      return { id: `pk:${k}`, name: old.payeeNames[k] || null, keys: [k], groupId: !rule && v ? v : null, rule };
    });
    for (const k of ['payeeRules', 'payeeNames', 'bankAccounts', 'accountNames']) delete s[k];
    return { ...data, version: 5, entries, settings: { ...s, accounts, payees } };
  },
};

/** The import settings of formats before v5, tidied (as they were then), for the v4 → v5 step. */
function legacyImportSettings(raw) {
  const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const payeeRules = Object.fromEntries(Object.entries(obj(raw.payeeRules))
    .filter(([k, v]) => typeof k === 'string' && k && typeof v === 'string' && v));
  const payeeNames = Object.fromEntries(Object.entries(obj(raw.payeeNames))
    .map(([k, v]) => [k, typeof v === 'string' ? cleanLabel(v) : '']).filter(([k, v]) => k && v));
  const bankAccounts = [...new Set((Array.isArray(raw.bankAccounts) ? raw.bankAccounts : [])
    .filter(x => typeof x === 'string').map(cleanLabel).filter(Boolean))];
  const accountNames = Object.fromEntries(Object.entries(obj(raw.accountNames))
    .map(([k, v]) => [String(k).toLowerCase(), cleanLabel(v)]).filter(([k, v]) => k && v));
  // An account renamed but missing from the list (shouldn't happen) still gets a record
  for (const k of Object.keys(accountNames)) if (!bankAccounts.some(b => b.toLowerCase() === k)) bankAccounts.push(k);
  return { payeeRules, payeeNames, bankAccounts, accountNames };
}

const str = v => (typeof v === 'string' ? v : '');
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Tidy one tag: lowercase, no leading '#', spaces/underscores → hyphens ("Tax Deductible" → "tax-deductible"). */
export function cleanTag(raw) {
  return String(raw ?? '').toLowerCase().replace(/^#+/, '').trim()
    .replace(/[\s_]+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, 30);
}

/** Tidy and de-duplicate a list of tags, keeping their order. */
export function normalizeTags(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = cleanTag(raw);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Tidy a category / payment-method label: trim and collapse spaces. */
export const cleanLabel = raw => String(raw ?? '').replace(/\s+/g, ' ').trim();

/**
 * Bring one entry to the current shape, filling defaults for any missing optional fields.
 * Unknown fields are kept, so data written by a newer app version isn't silently dropped.
 * Returns null only if the entry is unusable (no name, date, frequency or price).
 */
export function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const prices = (Array.isArray(raw.prices) ? raw.prices : [])
    .map(p => ({
      from: str(p?.from),
      amount: p?.amount == null || p.amount === '' ? null
        : typeof p.amount === 'string' ? parseFloat(p.amount) : Number(p.amount),
      frequency: str(p?.frequency),
    }))
    // a blank amount is only allowed on "amount varies" bills (the estimate comes from payments)
    .filter(p => isDate(p.from) && (p.amount === null
      ? !!raw.variable || FREQ[p.frequency]?.irregular || FREQ[raw.frequency]?.irregular
      : Number.isFinite(p.amount) && p.amount >= 0))
    .sort((a, b) => a.from.localeCompare(b.from));
  if (raw.id == null || raw.id === '' || !str(raw.name).trim() || !isDate(raw.startDate) || !FREQ[raw.frequency] || !prices.length) {
    return null;
  }
  prices[0] = { ...prices[0], from: raw.startDate }; // first period always applies from the start
  const once = raw.frequency === 'once';
  // Every period gets a valid frequency: one-offs are always 'once'; a recurring period with a
  // missing/invalid one inherits the previous period's (or the entry's).
  let prev = once ? 'once' : raw.frequency;
  for (const p of prices) {
    p.frequency = once ? 'once' : (FREQ[p.frequency] && p.frequency !== 'once' ? p.frequency : prev);
    prev = p.frequency;
  }
  const now = new Date().toISOString();
  const payments = normalizePayments(raw.payments);
  return {
    ...raw,
    id: String(raw.id),
    type: raw.type === 'income' ? 'income' : 'expense',
    name: str(raw.name).trim(),
    category: cleanLabel(str(raw.category)),
    method: cleanLabel(str(raw.method)),
    frequency: once ? 'once' : prices.at(-1).frequency, // latest period's; per-date logic uses the periods
    startDate: raw.startDate,
    contractEnd: !once && isDate(raw.contractEnd) ? raw.contractEnd : null,
    endsAtExpiry: !once && !!raw.endsAtExpiry,
    endDate: !once && isDate(raw.endDate) ? raw.endDate : null,
    tags: normalizeTags(raw.tags),
    prices,
    // Optional fields added Nov 2026 (no format bump needed — older data just gets the defaults):
    variable: !!raw.variable,                      // amount varies; planned amount is an estimate
    manual: !!raw.manual,                          // paid by hand → shows in "To pay"
    share: normalizeShare(raw.share),              // your % of the bill (100 = all of it)
    noticeDays: !once && Number.isInteger(raw.noticeDays) && raw.noticeDays > 0 && raw.noticeDays <= 3650
      ? raw.noticeDays : null,
    payments,
    notes: importNote(str(raw.notes), payments),
    // Added Nov 2026, also without a format bump:
    noForecast: !!raw.noForecast,                  // no set schedule, and not expected again (a project, a trip)
    keepGoingFrom: isDate(raw.keepGoingFrom) ? raw.keepGoingFrom : null, // "still going" after it looked stopped
    scheduleDismissed: FREQ[raw.scheduleDismissed] ? raw.scheduleDismissed : null, // a suggested schedule you said no to
    createdAt: str(raw.createdAt) || now,
    updatedAt: str(raw.updatedAt) || str(raw.createdAt) || now,
  };
}

/**
 * The note an import writes on a group it adds names the payee it was made for: "Added from a bank
 * import (SUSHI RYU)". Once that payee's payments have all moved out, the note names the payee most
 * of its payments now come from instead. Notes you wrote are never touched.
 */
function importNote(notes, payments) {
  const m = /^Added from a bank import \((.+)\)$/.exec(notes);
  const keys = payments.map(p => p.payee).filter(Boolean);
  if (!m || !keys.length || keys.includes(m[1])) return notes;
  const count = new Map();
  for (const k of keys) count.set(k, (count.get(k) || 0) + 1);
  const top = [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  return `Added from a bank import (${top})`;
}

function normalizeShare(v) {
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) && n > 0 && n < 100 ? Math.round(n * 100) / 100 : 100;
}

/** Logged payments: { id, date, amount (negative = refund/credit), due (which payment it settles), note,
 *  source (bank transaction id, if imported), payee and account (imported: which payee key and account key),
 *  method (how it was paid; v5, optional — hand-logged ones use their entry's method), handLogged (logged by hand, then matched by an import) }. */
function normalizePayments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(p => p && typeof p === 'object')
    .map((p, i) => ({
      ...p,
      id: str(p.id) || `p${i}-${str(p.date)}`,
      date: str(p.date),
      amount: typeof p.amount === 'string' ? parseFloat(p.amount) : Number(p.amount),
      due: isDate(p.due) ? p.due : null,
      note: str(p.note),
    }))
    .filter(p => isDate(p.date) && Number.isFinite(p.amount))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Monthly spending limits: { id, kind: 'category' | 'tag' | 'group', label, amount, groupId (groups) }. (Added Nov 2026, optional.) */
export function normalizeBudgets(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  list.forEach((b, i) => {
    if (!b || typeof b !== 'object') return;
    const kind = b.kind === 'tag' || b.kind === 'group' ? b.kind : 'category';
    const label = kind === 'tag' ? cleanTag(b.label) : cleanLabel(b.label);
    const amount = typeof b.amount === 'string' ? parseFloat(b.amount) : Number(b.amount);
    const key = kind === 'group' && typeof b.groupId === 'string' && b.groupId ? `group:${b.groupId}` : `${kind}:${label.toLowerCase()}`;
    if (!label || !(amount > 0) || seen.has(key)) return;
    seen.add(key);
    out.push({ ...b, id: str(b.id) || `b${i}-${key}`, kind, label, amount: Math.round(amount * 100) / 100 });
  });
  return out;
}

function normalizeSettings(raw) {
  const out = {};
  if (raw && /^[A-Z]{3}$/.test(raw.currency)) out.currency = raw.currency;
  if (raw && str(raw.lastBackup)) out.lastBackup = raw.lastBackup;
  const budgets = normalizeBudgets(raw?.budgets);
  if (budgets.length) out.budgets = budgets;
  // Each one is an id (older data) or { id, date } (since Nov 2026: so the oldest can be dropped first).
  if (Array.isArray(raw?.ignoredTxns)) {
    const seen = new Set();
    const list = raw.ignoredTxns
      .map(x => (typeof x === 'string' ? x : x && typeof x.id === 'string' ? (isDate(x.date) ? { id: x.id, date: x.date } : x.id) : null))
      .filter(x => { const id = typeof x === 'string' ? x : x?.id; return id && !seen.has(id) && seen.add(id); })
      .slice(-20000);
    if (list.length) out.ignoredTxns = list;
  }
  // Transfers between your own accounts (added Nov 2026, optional): { id, account, date, amount }.
  // Not logged as payments; kept so they aren't imported again, and to pair with the other side.
  if (Array.isArray(raw?.transfers)) {
    const seen = new Set();
    const list = raw.transfers.filter(x => x && typeof x.id === 'string' && x.id && !seen.has(x.id) && seen.add(x.id)
      && typeof x.account === 'string' && isDate(x.date) && Number.isFinite(x.amount))
      .map(x => ({ id: x.id, account: x.account.toLowerCase(), date: x.date, amount: x.amount })).slice(-20000);
    if (list.length) out.transfers = list;
  }
  // Your accounts and payees (format v5, see js/model.js)
  const accounts = normalizeAccounts(raw?.accounts);
  if (accounts.length) out.accounts = accounts;
  const payees = normalizePayees(raw?.payees);
  if (payees.length) out.payees = payees;
  // Groups you said aren't the same, so they aren't offered for merging again (Nov 2026, optional)
  if (Array.isArray(raw?.notSameGroups)) {
    const list = raw.notSameGroups.filter(x => Array.isArray(x) && x.length === 2 && x.every(id => typeof id === 'string' && id));
    if (list.length) out.notSameGroups = list.slice(-2000).map(([a, b]) => [a, b]);
  }
  return out;
}

/**
 * Upgrade a backup (or the data stored on this device) from any older version to the current one.
 * Returns { entries, settings, skipped } where skipped counts unusable entries.
 * Throws a friendly Error if the data isn't a backup or comes from a newer app version.
 */
export function migrateBackup(data) {
  if (!data || typeof data !== 'object' || data.app !== APP_ID || !Array.isArray(data.entries)) {
    throw new Error('This doesn’t look like a Budget backup file.');
  }
  let version = Number.isInteger(data.version) && data.version > 0 ? data.version : 1;
  if (version > SCHEMA_VERSION) {
    throw new Error(`This data was saved by a newer version of the app (format ${version}). ` +
      'Close and reopen the app to update it, then try again.');
  }
  let d = structuredClone(data);
  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw new Error(`Missing migration from format ${version}.`);
    d = step(d);
    version++;
  }
  const entries = [];
  let skipped = 0;
  for (const raw of d.entries) {
    const e = normalizeEntry(raw);
    if (e) entries.push(e); else skipped++;
  }
  return { entries, settings: normalizeSettings(d.settings), skipped };
}

/** The object written to a backup file. */
export function buildBackup(entries, settings) {
  return {
    app: APP_ID,
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    settings: normalizeSettings(settings),
    entries,
  };
}

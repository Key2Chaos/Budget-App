// Data format + migrations. This is what keeps old backups (and data already stored on the
// phone) working as the app changes.
//
// RULES (see README → "Keeping old backups working"):
//  1. Never edit or remove an existing migration step once it has been released.
//  2. Changing the shape of the data? Bump SCHEMA_VERSION and add a step to MIGRATIONS that
//     upgrades version N-1 → N. Then add a backup in the old format to tests/fixtures/.
//  3. Adding an optional field is NOT a format change: just give it a default in normalizeEntry().
import { FREQ } from './calc.js';

export const APP_ID = 'budget-pwa';
export const SCHEMA_VERSION = 2;

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
};

const str = v => (typeof v === 'string' ? v : '');
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Trim, collapse whitespace, cap length; de-dupe case-insensitively keeping first spelling. */
export function normalizeTags(list) {
  const seen = new Set(), out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const t = String(raw ?? '').replace(/^#/, '').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push(t); }
  }
  return out;
}

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
      amount: typeof p?.amount === 'string' ? parseFloat(p.amount) : Number(p?.amount),
      frequency: str(p?.frequency),
    }))
    .filter(p => isDate(p.from) && Number.isFinite(p.amount) && p.amount >= 0)
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
  return {
    ...raw,
    id: String(raw.id),
    type: raw.type === 'income' ? 'income' : 'expense',
    name: str(raw.name).trim(),
    category: str(raw.category).trim(),
    method: str(raw.method).trim(),
    frequency: once ? 'once' : prices.at(-1).frequency, // latest period's; per-date logic uses the periods
    startDate: raw.startDate,
    contractEnd: !once && isDate(raw.contractEnd) ? raw.contractEnd : null,
    endsAtExpiry: !once && !!raw.endsAtExpiry,
    endDate: !once && isDate(raw.endDate) ? raw.endDate : null,
    notes: str(raw.notes),
    tags: normalizeTags(raw.tags),
    prices,
    createdAt: str(raw.createdAt) || now,
    updatedAt: str(raw.updatedAt) || str(raw.createdAt) || now,
  };
}

function normalizeSettings(raw) {
  const out = {};
  if (raw && /^[A-Z]{3}$/.test(raw.currency)) out.currency = raw.currency;
  if (raw && str(raw.lastBackup)) out.lastBackup = raw.lastBackup;
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

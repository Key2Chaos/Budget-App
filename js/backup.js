// Backup export / import, spreadsheet export, and sample data.
import { db } from './db.js';
import * as C from './calc.js';
import * as R from './reports.js';
import * as Bank from './bank.js';
import * as M from './model.js';
import { migrateBackup, buildBackup, normalizeEntry } from './schema.js';
import { METHODS, FORECAST_MONTHS, state, uid, fmtCache, toast, saveSettings, sheet } from './core.js';
import { reload, render } from './render.js';

// ---------- Backup ----------
/** Phones/tablets get the share sheet (→ Save to Files / iCloud Drive); computers get a normal download. */
export const useShareSheet = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS reports as a Mac
export async function exportBackup() {
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
export async function exportCSV() {
  if (!state.entries.length) { toast('Nothing to export yet'); return; }
  const today = C.todayISO();
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 23, 1);
  const files = [
    ['budget-entries', R.entriesRows(state.entries, today)],
    ['budget-payments', R.paymentsRows(state.entries, state.settings)],
    ['budget-monthly-totals', R.monthlyRows(state.entries, start.getFullYear(), start.getMonth(), 24 + FORECAST_MONTHS)],
    ...((state.settings.payees || []).length ? [['budget-payees', R.payeesRows(state.entries, state.settings)]] : []),
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

export async function importBackup(file) {
  try {
    let data;
    try { data = JSON.parse(await file.text()); } catch { throw new Error('The file isn’t valid JSON.'); }
    const { entries: valid, settings, skipped } = migrateBackup(data);
    const skipNote = skipped ? `\n\n${skipped} damaged group${skipped === 1 ? '' : 's'} will be skipped.` : '';
    if (!confirm(`Import ${valid.length} groups? Groups already on this device with the same ID will be replaced.${skipNote}`)) return;
    await db.putEntries(valid);
    if (settings.currency && !state.entries.length) { state.settings.currency = settings.currency; fmtCache.clear(); }
    // Add any budgets from the backup that this device doesn't have yet
    const have = new Set((state.settings.budgets || []).map(b => `${b.kind}:${b.label.toLowerCase()}`));
    const extra = (settings.budgets || []).filter(b => !have.has(`${b.kind}:${b.label.toLowerCase()}`));
    if (extra.length) state.settings.budgets = [...(state.settings.budgets || []), ...extra];
    // …and accounts and payees it doesn't know yet (a payee already here keeps what you set on this device)
    const accs = (settings.accounts || []).filter(a => !M.accountByKey(state.settings, a.key));
    if (accs.length) state.settings.accounts = [...M.accountsOf(state.settings), ...accs];
    const known = new Set(M.payeesOf(state.settings).flatMap(p => p.keys));
    const ids = new Set(M.payeesOf(state.settings).map(p => p.id));
    const pys = (settings.payees || []).filter(p => !p.keys.some(k => known.has(k))).map(p => (ids.has(p.id) ? { ...p, id: uid() } : p));
    if (pys.length) state.settings.payees = [...M.payeesOf(state.settings), ...pys];
    await saveSettings();
    await reload();
    toast(`Imported ${valid.length} groups`);
  } catch (e) {
    alert('Import failed: ' + e.message);
  }
}

// ---------- Sample data ----------
export function sampleEntries() {
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

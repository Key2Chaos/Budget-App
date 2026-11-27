// Entry point: global event handlers and start-up.
import { db } from './db.js';
import * as C from './calc.js';
import { APP_ID, SCHEMA_VERSION, migrateBackup } from './schema.js';
import { state, $, esc, uid, fmtCache, fmtDate, toast, saveSettings, view, wideScreen } from './core.js';
import { reload, render } from './render.js';
import { renderEntries } from './view-entries.js';
import { txActions, txInput, txChange, drillDown } from './view-transactions.js';
import { openSheet } from './sheet-entry.js';
import { manageBudgets } from './sheet-budgets.js';
import { forgetRules, openUndoImports, undoLastImport, renameAccount, startBankImport } from './importer.js';
import { openManage } from './sheet-labels.js';
import { openAccounts } from './sheet-accounts.js';
import { openPayees } from './sheet-payees.js';
import { openTidy } from './sheet-tidy.js';
import { sweepEmptyGroups, removedNote } from './groups.js';
import * as Bank from './bank.js';
import { exportBackup, exportCSV, importBackup, sampleEntries } from './backup.js';

/** Change one group, save it and say what happened. */
async function updateGroup(id, change, message) {
  const e = state.entries.find(x => x.id === id);
  if (!e) return;
  const next = { ...change(e), updatedAt: new Date().toISOString() };
  await db.putEntry(next);
  await reload();
  toast(message(next));
}

// ---------- Global events ----------
const actions = {
  ...txActions,
  add: () => openSheet(),
  sample: async () => {
    await db.putEntries(sampleEntries());
    if (!state.settings.budgets?.length) {
      state.settings.budgets = [
        { id: uid(), kind: 'category', label: 'Subscriptions', amount: 40 },
        { id: uid(), kind: 'category', label: 'Groceries', amount: 380 },
        { id: uid(), kind: 'tag', label: 'shared', amount: 1000 },
      ];
      await saveSettings();
    }
    await reload();
    toast('Sample data added — erase it any time in Settings');
  },
  edit: t => openSheet(state.entries.find(e => e.id === t.dataset.id)),
  drill: t => { const d = t.dataset; drillDown({ kind: d.kind, value: d.value, period: d.period, type: d.type, label: d.label,
    amount: d.amount === '' ? null : Number(d.amount), note: d.note }); },
  range: t => { state.range = t.dataset.range === 'all' ? 'all' : Number(t.dataset.range); state.sel = null; render(); },
  filter: t => { state.filter = t.dataset.filter; render(); },
  // Payee groups table: click a heading to sort by it, again to turn it round (names A–Z, amounts biggest first)
  'grp-sort': t => {
    const k = t.dataset.key, s = state.groupSort;
    state.groupSort = { key: k, dir: s.key === k ? -s.dir : (['name', 'category', 'schedule', 'next'].includes(k) ? 1 : -1) };
    render();
  },
  tag: t => {
    const tag = t.dataset.tag;
    const on = state.tags.some(x => x.toLowerCase() === tag.toLowerCase());
    state.tags = on ? state.tags.filter(x => x.toLowerCase() !== tag.toLowerCase()) : [...state.tags, tag];
    state.sel = null;
    render();
  },
  'manage-labels': () => openManage('category'),
  'manage-budgets': manageBudgets,
  'import-bank': () => $('#bankFile').click(),
  'rename-account': t => renameAccount(t.dataset.key),
  'open-accounts': () => openAccounts(),
  'open-payees': () => openPayees(),
  'open-tidy': () => openTidy(),
  'forget-rules': forgetRules,
  'undo-imports': openUndoImports,
  'undo-last-import': undoLastImport,
  period: async t => { state.settings.period = t.dataset.period; await saveSettings(); render(); },
  'export-csv': exportCSV,
  'mark-paid': async t => {
    const e = state.entries.find(x => x.id === t.dataset.id);
    const due = t.dataset.due;
    if (!e) return;
    const est = C.estimateOn(e, due);
    const what = e.type === 'income' ? 'Amount received' : 'Amount paid';
    const input = prompt(`${what} for ${e.name} (due ${fmtDate(due)})${e.share < 100 ? ' — the full bill, before your share' : ''}:`,
      est ? (Math.round(est * 100) / 100).toFixed(2) : '');
    if (input == null) return;
    const amount = C.parseAmount(input);
    if (!Number.isFinite(amount)) { alert('That doesn’t look like an amount.'); return; }
    const payments = [...(e.payments || []), { id: uid(), date: C.todayISO(), amount, due, note: '' }]
      .sort((a, b) => a.date.localeCompare(b.date));
    await db.putEntry({ ...e, payments, updatedAt: new Date().toISOString() });
    await reload();
    toast(e.type === 'income' ? 'Marked as received' : 'Marked as paid');
  },
  // "Check these groups" on the Overview
  'end-group': t => updateGroup(t.dataset.id, e => ({ ...e, endDate: t.dataset.end }), e => `${e.name} ended ${fmtDate(t.dataset.end)}`),
  'keep-group': t => updateGroup(t.dataset.id, e => ({ ...e, keepGoingFrom: C.todayISO() }), e => `${e.name} kept going`),
  'set-schedule': t => updateGroup(t.dataset.id, e => {
    const s = Bank.suggestSchedule(e);
    return s ? Bank.withSchedule(e, s) : e;
  }, e => `${e.name} set to ${C.FREQ[e.frequency].label.toLowerCase()}`),
  'not-regular': t => updateGroup(t.dataset.id, e => ({ ...e, scheduleDismissed: t.dataset.freq }), e => `${e.name} stays with no set schedule`),
  'tags-clear': () => { state.tags = []; state.sel = null; render(); },
  breakdown: t => { state.breakdown = t.dataset.by; render(); },
  'go-settings': () => { state.tab = 'settings'; render(); },
  // Fetch the latest sw.js; if it's a new version, wait for it to take over, then reload the page
  'reload-app': async () => {
    toast('Checking for updates…');
    const reg = await navigator.serviceWorker?.getRegistration().catch(() => null);
    if (reg) {
      await reg.update().catch(() => {});
      const w = reg.installing || reg.waiting;
      if (w) await new Promise(r => {
        w.addEventListener('statechange', () => { if (w.state === 'activated' || w.state === 'redundant') r(); });
        setTimeout(r, 15000);
      });
    }
    location.reload();
  },
  export: exportBackup,
  import: () => $('#importFile').click(),
  persist: async () => { const ok = await navigator.storage.persist(); toast(ok ? 'Storage protected' : 'Not granted — add to Home Screen first'); render(); },
  erase: async () => {
    if (!confirm('Erase ALL payee groups on this device? Export a backup first if you might need them.')) return;
    if (!confirm('Are you sure? This cannot be undone.')) return;
    await db.clearEntries();
    Object.assign(state.settings, { lastBackup: null, budgets: [], balance: null, paydayId: null,
      ignoredTxns: [], transfers: [], accounts: [], payees: [], importLog: [] });
    await saveSettings();
    await reload();
    toast('All data erased');
  },
};

view.addEventListener('click', ev => {
  const t = ev.target.closest('[data-action]');
  if (t && actions[t.dataset.action]) actions[t.dataset.action](t, ev);
});
view.addEventListener('input', ev => {
  if (txInput(ev)) return;
  if (ev.target.id === 'search') {
    state.search = ev.target.value;
    const pos = ev.target.selectionStart;
    renderEntries();
    const s = $('#search'); s.focus(); s.setSelectionRange(pos, pos);
  }
});
view.addEventListener('change', async ev => {
  if (txChange(ev)) return;
  if (ev.target.id === 'currency') {
    state.settings.currency = ev.target.value;
    fmtCache.clear();
    await saveSettings();
    toast(`Currency set to ${ev.target.value}`);
  } else if (ev.target.id === 'balance') {
    const v = ev.target.value.trim();
    const amount = C.parseAmount(v);
    state.settings.balance = v && Number.isFinite(amount) ? { amount, date: C.todayISO() } : null;
    await saveSettings();
    render();
  } else if (ev.target.id === 'payday') {
    state.settings.paydayId = ev.target.value || null;
    await saveSettings();
    toast('Payday updated');
  } else if (ev.target.id === 'bankFile' && ev.target.files[0]) {
    const files = [...ev.target.files];
    ev.target.value = '';
    await startBankImport(files);
  } else if (ev.target.id === 'importFile' && ev.target.files[0]) {
    await importBackup(ev.target.files[0]);
    ev.target.value = '';
  }
});
document.querySelector('.tabbar').addEventListener('click', ev => {
  const o = ev.target.closest('button[data-open]'); // Payees / Accounts in the sidebar on a computer
  if (o) return o.dataset.open === 'payees' ? openPayees() : openAccounts();
  const b = ev.target.closest('button[data-tab]');
  if (!b) return;
  if (state.tab === b.dataset.tab) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  state.tab = b.dataset.tab;
  window.scrollTo(0, 0);
  render();
});
$('#addBtn').addEventListener('click', () => openSheet());
// The chart is drawn at a different size on computers, and Payee groups is a table there, so redraw
// when the window crosses the breakpoint
wideScreen.addEventListener('change', () => { if (state.tab === 'overview' || state.tab === 'entries') render(); });

// ---------- Boot ----------
(async function init() {
  try {
    const saved = (await db.getSettings()) || {};
    const stored = await db.allEntries();
    // Data saved by an older version of the app goes through the same upgrade path as old backups.
    const { entries, settings: migrated, skipped } = migrateBackup({ app: APP_ID, version: saved.schemaVersion ?? 1, settings: saved, entries: stored });
    Object.assign(state.settings, saved);
    // Since format 5, your accounts and payees are records of their own (made from the older fields)
    if ((saved.schemaVersion ?? 1) < 5) {
      for (const k of ['payeeRules', 'payeeNames', 'bankAccounts', 'accountNames']) delete state.settings[k];
      Object.assign(state.settings, { accounts: migrated.accounts || [], payees: migrated.payees || [] });
    }
    state.entries = entries;
    const before = new Map(stored.map(e => [String(e.id), JSON.stringify(e)]));
    const changed = entries.filter(e => before.get(e.id) !== JSON.stringify(e));
    if (changed.length) await db.putEntries(changed);
    if (skipped) console.warn(`${skipped} stored entries could not be read and were left untouched.`);
    if (state.settings.schemaVersion !== SCHEMA_VERSION) { state.settings.schemaVersion = SCHEMA_VERSION; await saveSettings(); }
  } catch (e) {
    view.innerHTML = `<p class="empty-small">Couldn’t load your data: ${esc(e.message)}</p>`;
    return;
  }
  // Empty groups that moves before this version left behind
  const swept = await sweepEmptyGroups().catch(() => []);
  render();
  if (swept.length) toast(`Tidied up${removedNote(swept)}`);
  // Ask the browser not to evict our data (granted automatically for Home Screen apps on iOS).
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
})();

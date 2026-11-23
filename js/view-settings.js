// The Settings tab.
import * as C from './calc.js';
import * as Bank from './bank.js';
import { localDay, CURRENCIES, state, esc, fmtDate, view, sectionize } from './core.js';
import { accountKeys, accountName, entryRuleCount, hasImportData } from './importer.js';

export async function renderSettings() {
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
  if (state.tab !== 'settings') return; // user switched tabs while awaiting

  view.innerHTML = `
    ${standalone ? '' : `<div class="group-title">Install</div>
    <section class="card pad">
      <p>For the best experience on iPhone, open this page in <strong>Safari</strong>, tap the <strong>Share</strong> button, then <strong>Add to Home Screen</strong>. It will then run full-screen and work offline.</p>
      ${matchMedia('(pointer: fine)').matches ? '<p class="small-text muted" style="margin-top:8px">On a computer, use the <strong>Install</strong> button in Chrome or Edge’s address bar, or <strong>File → Add to Dock</strong> in Safari on a Mac.</p>' : ''}
    </section>`}

    <div class="group-title">General</div>
    <section class="card list">
      <label class="row static">
        <div class="row-main"><div class="row-title">Currency</div></div>
        <select id="currency">${CURRENCIES.map(c => `<option ${c === state.settings.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </label>
      <button class="row" data-action="manage-labels">
        <div class="row-main"><div class="row-title">Manage labels</div>
        <div class="row-sub">Rename, merge or delete categories, payment methods and tags</div></div>
        <span class="chev" aria-hidden="true">›</span>
      </button>
      <button class="row" data-action="manage-budgets">
        <div class="row-main"><div class="row-title">Budgets</div>
        <div class="row-sub">${(state.settings.budgets || []).length
          ? `${state.settings.budgets.length} monthly limit${state.settings.budgets.length === 1 ? '' : 's'}`
          : 'Set monthly limits for a category or tag'}</div></div>
        <span class="chev" aria-hidden="true">›</span>
      </button>
      ${(() => {
        const incomes = state.entries.filter(e => e.type === 'income' && e.frequency !== 'once' && !C.isEnded(e) && !C.isIrregular(e));
        if (!incomes.length) return '';
        return `<label class="row static">
          <div class="row-main"><div class="row-title">Payday</div>
          <div class="row-sub">Used for “Until payday” on the Overview</div></div>
          <select id="payday">
            <option value="">Biggest income</option>
            ${incomes.map(e => `<option value="${e.id}" ${state.settings.paydayId === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
          </select>
        </label>`;
      })()}
    </section>

    <div class="group-title">Backup &amp; iCloud</div>
    <section class="card list">
      <button class="row" data-action="export">
        <div class="row-main"><div class="row-title accent">Export backup</div>
        <div class="row-sub">Choose “Save to Files” → iCloud Drive</div></div>
      </button>
      <button class="row" data-action="import">
        <div class="row-main"><div class="row-title accent">Import backup</div>
        <div class="row-sub">Merges a backup file into this device</div></div>
      </button>
      <button class="row" data-action="export-csv">
        <div class="row-main"><div class="row-title accent">Export spreadsheet (CSV)</div>
        <div class="row-sub">Groups, payments (with payee, account and method), monthly totals${(state.settings.payees || []).length ? ' and payees' : ''} — opens in Excel or Numbers</div></div>
      </button>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
    </section>
    <p class="fine pad-x">${state.entries.length} groups · Last backup: ${state.settings.lastBackup ? fmtDate(localDay(state.settings.lastBackup)) : 'never'}.
      Your data is stored only on this device. Saving a backup to iCloud Drive lets you restore it on another iPhone, iPad or Mac.</p>

    <div class="group-title">Bank statements</div>
    <section class="card list">
      <button class="row" data-action="import-bank">
        <div class="row-main"><div class="row-title accent">Import bank statement (CSV)</div>
        <div class="row-sub">Match transactions to your bills and log them as payments. CommBank and most banks. Choose several files to import them together.</div></div>
      </button>
      <input type="file" id="bankFile" accept=".csv,text/csv,text/comma-separated-values" multiple hidden>
      ${accountKeys().length ? `<button class="row" data-action="open-accounts">
        <div class="row-main"><div class="row-title">Accounts (${accountKeys().length})</div>
        <div class="row-sub">${esc(accountKeys().map(accountName).join(', '))}</div></div>
        <span class="chev" aria-hidden="true">›</span>
      </button>` : ''}
      ${(state.settings.payees || []).length ? (() => {
        const all = state.settings.payees;
        const ids = new Set(state.entries.map(e => e.id));
        const loose = all.filter(p => !p.rule && !ids.has(p.groupId)).length;
        return `<button class="row" data-action="open-payees">
        <div class="row-main"><div class="row-title">Payees (${all.length})</div>
        <div class="row-sub">Who you pay and are paid by${loose ? ` · ${loose} ungrouped` : ''} — rename, group, merge</div></div>
        <span class="chev" aria-hidden="true">›</span>
      </button>`;
      })() : ''}
      ${entryRuleCount() ? `<button class="row" data-action="forget-rules">
        <div class="row-main"><div class="row-title accent">Forget remembered matches</div>
        <div class="row-sub">${entryRuleCount()} payee${entryRuleCount() === 1 ? '' : 's'} currently go straight to a group. “Always ignore” choices are kept.</div></div>
      </button>` : ''}
      ${(state.settings.importLog || []).length ? (() => {
        const b = state.settings.importLog.at(-1);
        return `<button class="row" data-action="undo-last-import">
        <div class="row-main"><div class="row-title danger">Undo last import…</div>
        <div class="row-sub">${esc(b.files > 1 ? `${b.files} files` : b.file)} into ${esc((b.accounts || [b.account]).map(accountName).join(', '))} · ${esc(fmtDate(localDay(b.at)))}</div></div>
      </button>`;
      })() : ''}
      ${hasImportData() ? `<button class="row" data-action="undo-imports">
        <div class="row-main"><div class="row-title danger">Undo bank imports…</div>
        <div class="row-sub">Remove imported payments, groups imports added, remembered matches and ignored transactions, to start again.</div></div>
      </button>` : ''}
    </section>
    <p class="fine pad-x">Download a CSV from your bank's website or app first. The file is read on this device only.
      To name a payee, tap <strong>Name</strong> next to it when importing, or open <strong>Payees</strong>.</p>

    <div class="group-title">Storage</div>
    <section class="card list">
      <div class="row static">
        <div class="row-main"><div class="row-title">Protected from clean-up</div>
        <div class="row-sub">${persisted === null ? 'Not supported by this browser' : persisted ? 'Yes — the browser won’t clear this data' : 'Not yet — install to Home Screen for best protection'}</div></div>
        ${persisted === false ? '<button class="btn small" data-action="persist">Request</button>' : ''}
      </div>
      <div class="row static">
        <div class="row-main"><div class="row-title">Version <span id="appVersion" class="muted">…</span></div>
        <div class="row-sub">Reload checks for a newer version and switches to it</div></div>
        <button class="btn small" data-action="reload-app">Reload</button>
      </div>
    </section>

    <div class="group-title">Danger zone</div>
    <section class="card list">
      <button class="row" data-action="erase"><div class="row-main"><div class="row-title danger">Erase all data</div></div></button>
    </section>
    <p class="fine pad-x">Budget · works offline · no account, no tracking.</p>
  `;
  sectionize(view, 'set-cols');
  appVersion().then(v => { const el = document.getElementById('appVersion'); if (el) el.textContent = v || 'not installed (no offline copy yet)'; });
}

/** The version the service worker is serving, e.g. "v35" (null if there isn't one). */
async function appVersion() {
  if (!('serviceWorker' in navigator)) return null;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const reg = await Promise.race([navigator.serviceWorker.ready, wait(2000)]);
  const sw = navigator.serviceWorker.controller || reg?.active;
  if (!sw) return null;
  return Promise.race([wait(2000).then(() => null), new Promise(res => {
    const ch = new MessageChannel();
    ch.port1.onmessage = e => res(e.data?.version || null);
    sw.postMessage('version', [ch.port2]);
  })]);
}

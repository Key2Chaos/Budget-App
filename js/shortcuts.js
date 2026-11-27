// Keyboard shortcuts, the "?" list of them, and dropping a file anywhere on the window to import it.
import { state, $, toast, sheet, closeSheet, keepToast, wideScreen } from './core.js';
import { render } from './render.js';
import { renderTransactions } from './view-transactions.js';
import { renderPayeesPage } from './view-payees.js';
import { openSheet } from './sheet-entry.js';
import { startBankImport } from './importer.js';
import { importBackup } from './backup.js';

// The tabs, in the sidebar's order, by number
const TABS = ['overview', 'entries', 'txns', 'settings', 'payees', 'accounts'];
const WIDE_ONLY = new Set(['payees', 'accounts']);
const SEARCH = { entries: '#search', txns: '#txSearch', payees: '#pSearch' };

export const SHORTCUTS = [
  ['N', 'New payee group'],
  ['/', 'Search (from the Overview or Settings, this searches Transactions)'],
  ['1 – 4', 'Overview, Payee groups, Transactions, Settings'],
  ['5, 6', 'Payees, Accounts (on a computer)'],
  ['Esc', 'Close what’s open, or clear the ticked rows'],
  ['Ctrl Z', 'Undo, while the message with Undo shows'],
  ['?', 'This list'],
];

const typing = el => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
const dialogOpen = () => !!document.querySelector('dialog[open]');

function goTo(tab) {
  if (state.tab === tab) return;
  state.tab = tab;
  window.scrollTo(0, 0);
  render();
}

function focusSearch() {
  if (!SEARCH[state.tab]) goTo('txns');
  const s = $(SEARCH[state.tab]);
  if (!s) return;
  s.focus();
  s.select();
}

export function openShortcuts() {
  sheet.innerHTML = `
  <div id="keys">
    <div class="sheet-head">
      <span></span>
      <h2 tabindex="-1" autofocus>Keyboard shortcuts</h2>
      <button type="button" class="link strong" data-close>Done</button>
    </div>
    <div class="sheet-body">
      <section class="card keys-list">${SHORTCUTS.map(([k, what]) => `
        <div class="keys-row"><span class="keys-k">${k.split(/(, | – )/).map(p => (/^(, | – )$/.test(p) ? p : p.split(' ').map(x => `<kbd>${x}</kbd>`).join(' '))).join('')}</span><span>${what}</span></div>`).join('')}
      </section>
      <p class="fine pad-x">Shortcuts don’t work while you’re typing in a box. On a Mac, use ⌘ in place of Ctrl.</p>
      <div class="group-title">Importing</div>
      <p class="fine pad-x">Drop a bank statement (.csv) anywhere on the window to import it, or a backup (.json) to restore it.</p>
    </div>
  </div>`;
  $('#keys').addEventListener('click', ev => { if (ev.target.closest('[data-close]')) closeSheet(); });
  if (!sheet.open) { document.body.classList.add('modal-open'); sheet.showModal(); }
  keepToast();
}

function onKey(ev) {
  if (ev.defaultPrevented || ev.isComposing) return;
  const k = ev.key;
  // Undo works from anywhere but a text box (where Ctrl Z undoes the typing)
  if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && k.toLowerCase() === 'z') {
    if (typing(ev.target) || !toast.undo) return;
    ev.preventDefault();
    toast.undo();
    return;
  }
  if (ev.ctrlKey || ev.metaKey || ev.altKey || typing(ev.target)) return;
  if (k === 'Escape') {
    if (dialogOpen()) return; // the dialog closes itself
    const sel = state.tab === 'txns' ? state.tx?.sel : state.tab === 'payees' ? state.payeeView?.sel : null;
    if (sel?.size) { sel.clear(); (state.tab === 'txns' ? renderTransactions : renderPayeesPage)(); ev.preventDefault(); }
    return;
  }
  if (dialogOpen()) return;
  if (k === '?') { ev.preventDefault(); openShortcuts(); return; }
  if (k === '/') { ev.preventDefault(); focusSearch(); return; }
  if (k === 'n' || k === 'N') { ev.preventDefault(); openSheet(); return; }
  if (/^[1-6]$/.test(k)) {
    const tab = TABS[Number(k) - 1];
    if (WIDE_ONLY.has(tab) && !wideScreen.matches) return;
    ev.preventDefault();
    goTo(tab);
  }
}

// ---------- Drop a file anywhere to import it ----------
const hasFiles = ev => [...(ev.dataTransfer?.types || [])].includes('Files');
let depth = 0;

function dropZone(show) {
  let z = $('#dropZone');
  if (!z) {
    z = document.createElement('div');
    z.id = 'dropZone';
    z.innerHTML = '<div><strong>Drop to import</strong><span>A bank statement (.csv) or a backup (.json)</span></div>';
    document.body.append(z);
  }
  z.classList.toggle('show', show);
}

/** Import what was dropped: bank statements together, or a single backup. */
export async function importDropped(fileList) {
  const files = [...fileList];
  const isJSON = f => /\.json$/i.test(f.name) || f.type === 'application/json';
  const backups = files.filter(isJSON), csvs = files.filter(f => !isJSON(f));
  if (backups.length && csvs.length) return alert('Drop bank statements, or a backup, but not both at once.');
  if (backups.length > 1) return alert('Drop one backup at a time.');
  if (backups.length) return importBackup(backups[0]);
  if (csvs.length) return startBankImport(csvs);
}

function blocked() {
  // Not while something else is open, e.g. a payee group being edited or an import half done
  return dialogOpen();
}

export function initShortcuts() {
  document.addEventListener('keydown', onKey);
  document.addEventListener('dragenter', ev => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    depth++;
    if (!blocked()) dropZone(true);
  });
  document.addEventListener('dragover', ev => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = blocked() ? 'none' : 'copy';
  });
  document.addEventListener('dragleave', ev => {
    if (!hasFiles(ev)) return;
    if (--depth <= 0) { depth = 0; dropZone(false); }
  });
  document.addEventListener('drop', async ev => {
    if (!hasFiles(ev)) return;
    ev.preventDefault(); // or the browser opens the file in place of the app
    depth = 0;
    dropZone(false);
    if (blocked()) { toast('Close what’s open first, then drop the file again'); return; }
    if (ev.dataTransfer.files.length) await importDropped(ev.dataTransfer.files);
  });
}

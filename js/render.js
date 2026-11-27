// Drawing the current tab, and reloading entries from storage.
import { db } from './db.js';
import * as C from './calc.js';
import { TITLES, state, $, sheet } from './core.js';
import { renderOverview } from './view-overview.js';
import { renderEntries } from './view-entries.js';
import { renderSettings } from './view-settings.js';
import { renderTransactions } from './view-transactions.js';

export async function reload() { state.entries = await db.allEntries(); render(); }

export function render() {
  C.setImportedUntil(state.entries); // how far the bank imports go, for "looks like it stopped"
  $('#title').textContent = TITLES[state.tab];
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
  if (state.tab === 'overview') renderOverview();
  else if (state.tab === 'entries') renderEntries();
  else if (state.tab === 'txns') renderTransactions();
  else renderSettings();
}

sheet.addEventListener('close', () => {
  document.body.classList.remove('modal-open');
  sheet.innerHTML = ''; // don't leave a hidden copy of the last sheet in the page
  render(); // labels may have changed while the sheet was open
});

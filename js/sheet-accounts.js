// The Accounts sheet (Settings → Accounts): your bank accounts and cards, their balance from the
// last statement, money in and out this month, and their transactions.
import * as C from './calc.js';
import * as M from './model.js';
import { state, $, esc, money, fmtDate, saveSettings, sheet, closeSheet, keepToast } from './core.js';
import { accountOfPayment } from './sheet-entry.js';
import { renameAccount } from './importer.js';

/** Every imported payment, with its entry and account key: [{ p, e, account }], newest first. */
export function accountPayments() {
  const out = [];
  for (const e of state.entries) for (const p of e.payments || []) {
    const account = accountOfPayment(p, e);
    if (account && account !== 'unknown') out.push({ p, e, account });
  }
  return out.sort((a, b) => b.p.date.localeCompare(a.p.date));
}

/** Money out (+) or in (−) for a payment, as the bank saw it. */
const bankAmount = ({ p, e }) => (e.type === 'expense' ? p.amount : -p.amount);

export function openAccounts(openKey = null) {
  const accounts = M.accountsOf(state.settings);
  const pays = accountPayments();
  const month = C.todayISO().slice(0, 7);
  const lc = s => String(s).toLowerCase();
  const card = a => {
    const mine = pays.filter(x => lc(x.account) === lc(a.key));
    const now = mine.filter(x => x.p.date.slice(0, 7) === month);
    const out = now.filter(x => bankAmount(x) > 0).reduce((n, x) => n + bankAmount(x), 0);
    const inn = now.filter(x => bankAmount(x) < 0).reduce((n, x) => n - bankAmount(x), 0);
    const transfers = (state.settings.transfers || []).filter(t => t.account === lc(a.key) && t.date.slice(0, 7) === month).length;
    const name = esc(a.name);
    return `<section class="card form acct-card" data-key="${esc(a.key)}">
      <div class="field"><span><strong>${name}</strong><br><span class="muted small-text">${esc(M.ACCOUNT_KINDS[a.kind] || '')}${a.name !== a.key ? ` · imported as “${esc(a.key)}”` : ''}</span></span>
        <button type="button" class="btn small" data-rename="${esc(a.key)}" aria-label="Rename ${name}">Rename</button></div>
      <label class="field"><span>Type</span>
        <select data-kind="${esc(a.key)}" aria-label="Type of ${name}">${Object.entries(M.ACCOUNT_KINDS).map(([k, label]) =>
          `<option value="${k}" ${a.kind === k ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <div class="field"><span>Balance</span><span class="acct-val">${a.balance ? `${money(a.balance.amount)} <span class="muted small-text">on ${esc(fmtDate(a.balance.date))}</span>` : '<span class="muted">—</span>'}</span></div>
      <div class="field"><span>This month</span><span class="acct-val"><span class="neg">−${money(out)}</span> · <span class="pos">+${money(inn)}</span>${transfers ? ` · ${transfers} transfer${transfers === 1 ? '' : 's'}` : ''}</span></div>
      ${mine.length ? `<details class="imp-list acct-txns" ${openKey && lc(openKey) === lc(a.key) ? 'open' : ''}>
        <summary>${mine.length} transaction${mine.length === 1 ? '' : 's'}</summary>
        ${mine.slice(0, 100).map(x => `<div class="imp-sub"><span class="imp-date">${esc(fmtDate(x.p.date))}</span>
          <span class="imp-sub-desc">${esc(x.e.name)}${x.p.note ? ` <span class="muted">· ${esc(x.p.note)}</span>` : ''}</span>
          <span class="imp-amt ${bankAmount(x) > 0 ? 'neg' : 'pos'}">${bankAmount(x) > 0 ? '−' : '+'}${money(Math.abs(bankAmount(x)))}</span></div>`).join('')}
        ${mine.length > 100 ? `<p class="fine">Showing the latest 100.</p>` : ''}
      </details>` : ''}
    </section>`;
  };
  sheet.innerHTML = `
  <div id="accounts">
    <div class="sheet-head">
      <span></span>
      <h2 tabindex="-1" autofocus>Accounts</h2>
      <button type="button" class="link strong" data-close>Done</button>
    </div>
    <div class="sheet-body">
      ${accounts.length ? accounts.map(card).join('') : `<p class="empty-small">No accounts yet. They're added when you import a bank statement.</p>`}
      <p class="fine pad-x">Accounts are added by bank imports. Renaming one is safe: transactions you've imported are still
        recognised. The balance comes from the newest statement with a Balance column.</p>
    </div>
  </div>`;
  const root = $('#accounts');
  root.addEventListener('click', async ev => {
    if (ev.target.closest('[data-close]')) return closeSheet();
    const r = ev.target.closest('[data-rename]');
    if (r) { await renameAccount(r.dataset.rename); openAccounts(); }
  });
  root.addEventListener('change', async ev => {
    const k = ev.target.closest('[data-kind]');
    if (!k) return;
    state.settings.accounts = M.updateAccount(state.settings, k.dataset.kind, { kind: k.value });
    await saveSettings();
  });
  if (!sheet.open) { document.body.classList.add('modal-open'); sheet.showModal(); }
  keepToast();
}

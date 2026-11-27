// The Accounts page, on a computer (from the sidebar): your bank accounts and cards in a table —
// type, balance from the newest statement, money in and out this month, and their payments, which
// open on the Transactions tab. A phone has the Accounts sheet in Settings (js/sheet-accounts.js).
import * as C from './calc.js';
import * as M from './model.js';
import { state, esc, money, fmtDate, monthLong, toast, saveSettings, view } from './core.js';
import { accountPayments } from './sheet-accounts.js';
import { renameAccount } from './importer.js';
import { drillDown } from './view-transactions.js';

const lc = s => String(s ?? '').toLowerCase();
/** Money out (+) or in (−) for a payment, as the bank saw it. */
const bankAmount = ({ p, e }) => (e.type === 'expense' ? p.amount : -p.amount);

/** Each account with its figures: [{ a, count, last, out, inn, transfers }]. */
export function accountRows(month = C.todayISO().slice(0, 7)) {
  const pays = accountPayments(); // newest first
  return M.accountsOf(state.settings).map(a => {
    const mine = pays.filter(x => lc(x.account) === lc(a.key));
    const now = mine.filter(x => x.p.date.slice(0, 7) === month);
    return {
      a, count: mine.length, last: mine[0]?.p.date || '',
      out: now.filter(x => bankAmount(x) > 0).reduce((n, x) => n + bankAmount(x), 0),
      inn: now.filter(x => bankAmount(x) < 0).reduce((n, x) => n - bankAmount(x), 0),
      transfers: (state.settings.transfers || []).filter(t => t.account === lc(a.key) && t.date.slice(0, 7) === month).length,
    };
  });
}

export function renderAccountsPage() {
  const rows = accountRows();
  const none = '<span class="muted">—</span>';
  const tr = r => {
    const name = esc(r.a.name);
    return `<tr>
      <td class="a-name"><button type="button" class="g-open" data-action="a-payments" data-name="${esc(r.a.name)}" title="See its payments">${name}</button>
        ${r.a.name !== r.a.key ? `<span class="tx-note">imported as “${esc(r.a.key)}”</span>` : ''}</td>
      <td class="a-kind"><select data-acct-kind="${esc(r.a.key)}" aria-label="Type of ${name}">${Object.entries(M.ACCOUNT_KINDS).map(([k, label]) =>
        `<option value="${k}" ${r.a.kind === k ? 'selected' : ''}>${label}</option>`).join('')}</select></td>
      <td class="a-bal">${r.a.balance ? `${money(r.a.balance.amount)}<small>on ${esc(fmtDate(r.a.balance.date))}</small>` : none}</td>
      <td class="a-out neg">${r.out ? `−${money(r.out)}` : none}</td>
      <td class="a-in pos">${r.inn ? `+${money(r.inn)}` : none}${r.transfers ? `<small>${r.transfers} transfer${r.transfers === 1 ? '' : 's'}</small>` : ''}</td>
      <td class="a-count">${r.count || none}</td>
      <td class="a-last">${r.last ? esc(fmtDate(r.last)) : none}</td>
      <td class="a-act"><button type="button" class="btn small" data-action="a-rename" data-key="${esc(r.a.key)}" aria-label="Rename ${name}">Rename</button>
        ${r.count ? `<button type="button" class="link small-link" data-action="a-payments" data-name="${esc(r.a.name)}">Payments ›</button>` : ''}</td>
    </tr>`;
  };
  const out = rows.reduce((n, r) => n + r.out, 0), inn = rows.reduce((n, r) => n + r.inn, 0);
  view.innerHTML = rows.length ? `
    <section class="card tx-card"><table class="tx-table a-table">
      <thead><tr>
        <th class="a-name"><span>Account</span></th><th class="a-kind"><span>Type</span></th><th class="a-bal"><span>Balance</span></th>
        <th class="a-out"><span>Out this month</span></th><th class="a-in"><span>In this month</span></th>
        <th class="a-count"><span>Payments</span></th><th class="a-last"><span>Last</span></th><th class="a-act"></th>
      </tr></thead>
      <tbody>${rows.map(tr).join('')}</tbody>
      ${rows.length > 1 ? `<tfoot><tr><td class="a-name">All accounts</td><td></td><td></td>
        <td class="a-out neg">${out ? `−${money(out)}` : none}</td><td class="a-in pos">${inn ? `+${money(inn)}` : none}</td>
        <td class="a-count">${rows.reduce((n, r) => n + r.count, 0)}</td><td></td><td></td></tr></tfoot>` : ''}
    </table></section>
    <p class="fine">${esc(monthLong.format(new Date()))}, as your statements show it: transfers between your own accounts aren’t
      counted as money in or out. The balance comes from the newest statement with a Balance column. Click an account to see
      its payments on the Transactions tab. Renaming one is safe: payments you’ve imported are still recognised.</p>`
    : `<p class="empty-small">No accounts yet. They’re added when you import a bank statement (Settings → Bank statements).</p>`;
}

// ---------- Events (wired up in app.js) ----------

export const accountActions = {
  'a-rename': async t => { await renameAccount(t.dataset.key); },
  'a-payments': t => drillDown({ kind: 'account', value: t.dataset.name, period: 'all', label: `${t.dataset.name} · all payments`, back: 'accounts' }),
};

export async function accountChange(ev) {
  const k = ev.target.closest('[data-acct-kind]');
  if (!k) return false;
  state.settings.accounts = M.updateAccount(state.settings, k.dataset.acctKind, { kind: k.value });
  await saveSettings();
  toast(`${M.accountName(state.settings, k.dataset.acctKind)}: ${M.ACCOUNT_KINDS[k.value]}`);
  return true;
}

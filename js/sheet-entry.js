// The entry sheet: add / edit an entry (Summary, Transactions and Accounts pages), save and delete.
import { db } from './db.js';
import * as C from './calc.js';
import * as R from './reports.js';
import * as Bank from './bank.js';
import * as M from './model.js';
import { normalizeEntry, normalizeTags, cleanTag } from './schema.js';
import { STARTER_TAGS, canonicalLabel, categoryOptions, methodOptions, state, $, esc, uid, money, fmtDate, toast, allTags, saveSettings, sheet, closeSheet, newGroup } from './core.js';
import { pickGroup } from './picker.js';
import { movePayments, removeEmptyGroups, removedNote } from './groups.js';
import { reload } from './render.js';
import { isCatchAll, accountKeys, accountName, getRules, setRules, groupSuggestions, suggestCategory } from './importer.js';

/** One row of an entry's history: date (or "From the start"), amount and how often. */
export function priceRow(p, first) {
  const opts = Object.entries(C.FREQ)
    .filter(([k]) => first || k !== 'once') // only the first row can be a one-off
    .map(([k, f]) => `<option value="${k}" ${p.frequency === k ? 'selected' : ''}>${f.label}</option>`).join('');
  return `<div class="field price-row">
    <div class="pr-top">
      ${first ? '<span class="pfrom-start">From the start</span><input type="hidden" name="pfrom" value="">'
              : `<span class="pr-label">From</span><input type="date" name="pfrom" value="${esc(p.from)}" aria-label="Change starts on">`}
      ${first ? '' : '<button type="button" class="icon-btn small" data-remove-price aria-label="Remove this change">−</button>'}
    </div>
    <div class="pr-bottom">
      <input name="pamount" inputmode="decimal" placeholder="0.00" value="${p.amount ?? ''}" aria-label="Amount">
      <select name="pfreq" aria-label="How often">${opts}</select>
    </div>
  </div>`;
}

/** Which payee an imported payment came from (older payments: worked out from the bank's text in the note). */
export const payeeOfPayment = p => (p.source ? p.payee || Bank.payeeKey((p.note || '').split(' · ').at(-1)) : null);
export const payeeLabel = key => M.keyTitle(state.settings, key);

/**
 * "Payees" on an entry that has imported payments from more than one payee (e.g. the catch-all
 * "Everyday spending"): each payee's total, with Move to… another entry or a new one of its own.
 */
export function payeesSection(entry) {
  const by = new Map();
  for (const p of entry.payments || []) {
    const k = payeeOfPayment(p);
    if (!k) continue;
    const g = by.get(k) || { key: k, n: 0, total: 0, last: '' };
    g.n++; g.total += p.amount; g.last = p.date > g.last ? p.date : g.last;
    by.set(k, g);
  }
  if (!by.size) return ''; // even a group's only payee can be moved on
  const groups = [...by.values()].sort((a, b) => b.total - a.total);
  return `<div class="group-title">Payees (${groups.length})</div>
    <section class="card form">${groups.map(g => `
      <div class="field payee-row"><span>${esc(payeeLabel(g.key))}<br>
        <span class="muted small-text">${g.n} payment${g.n === 1 ? "" : "s"} · ${money(g.total)} · last ${esc(fmtDate(g.last))}</span></span>
        <button type="button" class="btn small" data-move-payee="${esc(g.key)}" aria-label="Move ${esc(payeeLabel(g.key))} to another group">Move to…</button></div>`).join('')}
    </section>
    <p class="fine pad-x">Move a payee's payments to another group, or type a name for a new one. Future imports send that
      payee there too.</p>`;
}

/** Choose where one payee's payments in an entry go, with the picker. */
export async function choosePayeeGroup(from, key) {
  const name = payeeLabel(key);
  const choice = await pickGroup({ title: `Move ${name} to`, type: from.type, exclude: [from.id], name,
    suggested: groupSuggestions(name, from.type, [from.id]) });
  if (choice) await movePayee(from, key, choice.create ? { create: choice.create } : choice.id);
}

/** Choose another group for one payment (just this one: the payee's other payments stay). */
export async function choosePaymentGroup(from, paymentId) {
  const p = (from.payments || []).find(x => x.id === paymentId);
  if (!p) return;
  const choice = await pickGroup({ title: 'Move this payment to', type: from.type, exclude: [from.id],
    suggested: p.payee ? groupSuggestions(payeeLabel(p.payee), from.type, [from.id]) : [] });
  if (!choice) return;
  const dest = choice.create ? newGroup({ name: choice.create, type: from.type, start: p.date, fromImport: true,
    category: suggestCategory(choice.create, from.type) }) : state.entries.find(e => e.id === choice.id);
  if (!dest) return;
  await movePayments([{ p, e: from }], dest);
  await reload();
  const removed = await removeEmptyGroups([from.id]);
  const fresh = state.entries.find(e => e.id === from.id);
  if (fresh) openSheet(fresh, 'transactions'); else closeSheet();
  toast(`Moved to ${dest.name}${removedNote(removed)}`);
}

/**
 * Move all of one payee's imported payments from an entry to another entry: an entry id, 'new' (an
 * entry of its own, named after the payee), or { create: name } (a new group with that name).
 */
export async function movePayee(from, key, to) {
  const pays = (from.payments || []).filter(p => payeeOfPayment(p) === key);
  if (!pays.length) return;
  const now = new Date().toISOString();
  let dest;
  if (to?.create) {
    const start = pays.reduce((d, p) => (p.date < d ? p.date : d), pays[0].date);
    dest = newGroup({ name: to.create, type: from.type, start, method: from.method, fromImport: true,
      category: suggestCategory(to.create, from.type), notes: `Moved out of ${from.name}` });
  } else if (to === 'new') {
    const sorted = [...pays].sort((a, b) => a.date.localeCompare(b.date));
    const one = pays.length === 1;
    const frequency = one ? 'once' : 'irregular';
    const start = sorted[0].date;
    dest = normalizeEntry({
      id: uid(), type: from.type, name: payeeLabel(key), category: '', method: from.method, frequency, startDate: start,
      contractEnd: null, endsAtExpiry: false, endDate: null, notes: `Moved out of ${from.name}`, tags: [], fromImport: true,
      prices: [{ from: start, amount: one ? Math.abs(sorted[0].amount) : null, frequency }],
      variable: !one, manual: false, share: 100, noticeDays: null, payments: [], createdAt: now, updatedAt: now,
    });
  } else {
    dest = state.entries.find(e => e.id === to);
  }
  if (!dest) return;
  await movePayments(pays.map(p => ({ p: { ...p, payee: key }, e: from })), dest, now);
  if (dest.frequency !== 'once') {
    setRules({ ...getRules(), [key]: dest.id });
    await saveSettings();
  }
  await reload();
  const removed = await removeEmptyGroups([from.id]);
  const fresh = state.entries.find(e => e.id === from.id);
  if (fresh) openSheet(fresh, 'accounts'); // redraw in place, ready to move the next payee
  else closeSheet();
  toast(`Moved ${pays.length} payment${pays.length === 1 ? '' : 's'} to ${dest.name}${removedNote(removed)}`); // after the redraw, or it's wiped
}

/** Switch the entry sheet to one of its pages (Summary, Transactions, Accounts). */
export function showTab(form, tab) {
  for (const b of form.querySelectorAll('[role=tab][data-page]')) {
    const on = b.dataset.page === tab;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on);
  }
  for (const p of form.querySelectorAll('.tab-panel')) p.classList.toggle('on', p.dataset.panel === tab);
  sheet.scrollTop = 0;
}

/**
 * One line of a group's Summary: its payments in the last 12 months totalled by something (how
 * they were paid, or which account), e.g. "Paid by  BPAY $240 · Card $55". Hidden when there's only one.
 */
function breakdownLine(label, pays, keyOf) {
  const yearAgo = C.addDaysISO(C.todayISO(), -365);
  const by = new Map();
  for (const p of pays) if (p.date > yearAgo) by.set(keyOf(p), (by.get(keyOf(p)) || 0) + p.amount);
  if (by.size < 2) return '';
  return `<div class="sum-break"><span class="muted">${label}</span> ${[...by].sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span class="sum-part">${esc(k)} <strong>${money(v)}</strong></span>`).join(' · ')}</div>`;
}

/** The figures at the top of an entry's Summary page. */
export function summaryCard(entry) {
  const pays = entry.payments || [];
  const today = C.todayISO();
  const yearAgo = C.addDaysISO(today, -365);
  const total = pays.reduce((n, p) => n + p.amount, 0);
  const lastYear = pays.filter(p => p.date > yearAgo && p.date <= today).reduce((n, p) => n + p.amount, 0);
  const last = pays.reduce((d, p) => (p.date > d ? p.date : d), '');
  const monthly = C.isEnded(entry) ? 0 : C.monthlyEquivalent(entry);
  const next = C.isIrregular(entry) || C.isEnded(entry) ? null : C.nextDue(entry);
  const accounts = new Set(pays.map(p => accountOfPayment(p, entry)).filter(Boolean));
  const stat = (label, value) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`;
  return `<section class="card pad sum-card">
    <div class="stat-grid">
      ${stat('A month', monthly ? `${entry.variable ? '≈' : ''}${money(monthly)}` : '—')}
      ${stat('Last 12 months', pays.length ? money(lastYear) : '—')}
      ${stat('Payments', `${pays.length}${pays.length ? ` · ${money(total)}` : ''}`)}
      ${stat(next ? 'Next due' : 'Last payment', esc(next ? fmtDate(next) : last ? fmtDate(last) : '—'))}
    </div>
    ${breakdownLine('Paid by', pays, p => p.method || (p.source ? '' : entry.method) || 'Not recorded')}
    ${accounts.size ? breakdownLine('From', pays, p => { const a = accountOfPayment(p, entry); return !a ? 'By hand' : a === 'unknown' ? 'Imported' : accountName(a); }) : ''}
    ${pays.length || accounts.size ? `<div class="sum-links">
      ${pays.length ? `<button type="button" class="link" data-page="transactions">See ${pays.length} transaction${pays.length === 1 ? '' : 's'} ›</button>` : ''}
      ${accounts.size ? `<button type="button" class="link" data-page="accounts">${accounts.size} account${accounts.size === 1 ? '' : 's'} ›</button>` : ''}
    </div>` : ''}
  </section>`;
}

/**
 * Which bank account an imported payment came from: stored on newer payments; for older ones, the
 * account of the catch-all it's in, or of the import it came in with. Null when logged by hand.
 */
export function accountOfPayment(p, entry) {
  if (!p.source) return null;
  const key = acc => accountKeys().find(k => k.toLowerCase() === String(acc).toLowerCase()) || acc;
  if (p.account) return key(p.account);
  if (entry?.catchAll && !entry.catchAll.startsWith('ungrouped|')) return key(entry.catchAll.slice(0, entry.catchAll.lastIndexOf('|')));
  const b = (state.settings.importLog || []).find(x => x.id === p.batch);
  const accs = b ? b.accounts || [b.account] : [];
  return accs.length === 1 ? key(accs[0]) : 'unknown';
}

/** "Accounts" page: how much of this entry was paid from each bank account (and by hand). */
export function accountsSection(entry) {
  const by = new Map();
  for (const p of entry.payments || []) {
    const k = accountOfPayment(p, entry) || 'hand';
    const g = by.get(k) || { key: k, n: 0, total: 0, last: '' };
    g.n++; g.total += p.amount; g.last = p.date > g.last ? p.date : g.last;
    by.set(k, g);
  }
  if (!by.size) return `<section class="card pad"><p class="muted">No payments yet. Payments imported from a bank
    statement show here by account, with the payees they came from.</p></section>`;
  const label = k => (k === 'hand' ? 'Logged by hand' : k === 'unknown' ? 'Imported (account not recorded)' : accountName(k));
  const groups = [...by.values()].sort((a, b) => (a.key === 'hand') - (b.key === 'hand') || b.total - a.total);
  return `<div class="group-title">By account (${groups.length})</div>
    <section class="card list">${groups.map(g => `<div class="row static">
      <div class="row-main"><div class="row-title">${esc(label(g.key))}</div>
      <div class="row-sub">${g.n} payment${g.n === 1 ? '' : 's'} · last ${esc(fmtDate(g.last))}</div></div>
      <div class="row-amt">${money(g.total)}</div></div>`).join('')}
    </section>`;
}

/** Colour a payment row as a credit while its amount starts with a minus. */
export const syncPaySign = row => row.classList.toggle('credit', row.querySelector('[name=payamount]').value.trim().startsWith('-'));

/** Words for a logged payment's row, for money out (an expense) or in (income). */
export const PAY_WORDS = {
  expense: { date: 'Paid on', amount: 'Amount paid (minus for a credit or refund)', credit: 'Credit', flip: 'Switch between payment and credit' },
  income: { date: 'Received on', amount: 'Amount received (minus if you paid some back)', credit: 'Paid back', flip: 'Switch between received and paid back' },
};

/**
 * One logged payment: date, amount (full bill) and a ± button. A minus amount is a credit or
 * refund (on income: money paid back); type the minus or tap ±.
 */
export function payRow(p, type = 'expense') {
  const credit = p.amount < 0;
  const w = PAY_WORDS[type] || PAY_WORDS.expense;
  return `<div class="field pay-row ${credit ? 'credit' : ''}">
    <input type="date" name="paydate" value="${esc(p.date)}" aria-label="${w.date}">
    <span class="pay-kind">${w.credit}</span>
    <input name="payamount" inputmode="decimal" placeholder="0.00" value="${p.amount === '' ? '' : p.amount.toFixed(2)}" aria-label="${w.amount}">
    <button type="button" class="icon-btn small pay-flip" data-flip-sign aria-label="${w.flip}">±</button>
    <input type="hidden" name="paydue" value="${esc(p.due || '')}">
    <input type="hidden" name="payid" value="${esc(p.id || '')}">
    <button type="button" class="icon-btn small" data-remove-payment aria-label="Remove payment">−</button>
    ${p.note || p.id ? `<div class="pay-note"><span class="pay-note-text">${p.note ? esc(p.note) : ''}</span>${p.id && p.date ? `<button type="button" class="link small-link pay-move"
      data-move-payment="${esc(p.id)}" aria-label="Move this payment to another group">Move…</button>` : ''}</div>` : ''}
  </div>`;
}

export function openSheet(entry = null, tab = 'summary') {
  const isNew = !entry;
  const e = entry || { type: 'expense', frequency: 'monthly', startDate: C.todayISO(), prices: [{ from: C.todayISO(), amount: '' }] };
  const all = C.sortedPrices(e);
  const prices = e.frequency === 'once' ? all.slice(0, 1) : all; // a one-off only ever uses its first amount

  sheet.innerHTML = `
  <form id="entryForm" class="${isNew ? '' : 'tabbed'}" novalidate>
    <div class="sheet-head">
      <button type="button" class="link" data-close>Cancel</button>
      <h2 tabindex="-1" autofocus>${isNew ? 'New group' : 'Edit group'}</h2>
      <button type="submit" class="link strong">Save</button>
    </div>
    <div class="sheet-body">
      ${isNew ? '' : `<div class="seg sheet-tabs" role="tablist" aria-label="Group pages">
        ${[['summary', 'Summary'], ['transactions', 'Transactions'], ['accounts', 'Accounts']]
          .map(([k, label]) => `<button type="button" role="tab" data-page="${k}" aria-selected="${k === tab}" class="${k === tab ? 'on' : ''}">${label}</button>`).join('')}
      </div>`}
      <div class="tab-panel ${tab === 'summary' ? 'on' : ''}" data-panel="summary" role="tabpanel">
      ${isNew ? '' : summaryCard(entry)}
      <div class="seg type-seg">
        <label><input type="radio" name="type" value="expense" ${e.type !== 'income' ? 'checked' : ''}><span>Expense</span></label>
        <label><input type="radio" name="type" value="income" ${e.type === 'income' ? 'checked' : ''}><span>Income</span></label>
      </div>

      <section class="card form">
        <label class="field"><span>Name</span>
          <input name="name" placeholder="e.g. Netflix, Rent, Salary" value="${esc(e.name)}" autocomplete="off" enterkeyhint="next"></label>
        ${isNew ? `<label class="field"><span class="lbl-amount">Amount</span>
          <input name="amount" inputmode="decimal" placeholder="0.00" value="" enterkeyhint="done"></label>` : ''}
        ${isNew ? `<label class="field"><span>How often</span>
          <select name="frequency">${Object.entries(C.FREQ).map(([k, f]) =>
            `<option value="${k}" ${e.frequency === k ? 'selected' : ''}>${f.label}</option>`).join('')}</select></label>` : ''}
        <label class="field"><span class="lbl-start">First payment</span>
          <input type="date" name="startDate" value="${esc(e.startDate)}"></label>
      </section>

      ${isNew ? '' : `
      <div class="group-title"><span class="fixed-only">Amount &amp; frequency history</span><span class="variable-only">Frequency history</span></div>
      <section class="card form" id="prices">${prices.map((p, i) => priceRow(p, i === 0)).join('')}</section>
      <p class="fine pad-x recurring-only fixed-only">Add a change when the price goes up or down, or you switch how often you pay
        (e.g. yearly → monthly). For a frequency change, use the date of the first payment on the new schedule.</p>
      <p class="fine pad-x variable-only">${(() => {
        // worked out as a varying bill, so it's right even if the switch is only just being turned on
        const est = C.estimateOn({ ...e, variable: true }, C.todayISO());
        const logged = (e.payments || []).filter(p => p.amount > 0).length;
        const noSchedule = C.isIrregular(e, C.todayISO());
        const now = est <= 0 ? 'No estimate yet. Log a payment below to set one.'
          : noSchedule ? `Current estimate: <strong>≈${money(est)}</strong> a month — ${logged
            ? 'the average of your last three complete months of logged payments.'
            : 'the amount entered earlier, until you log payments.'} With no set schedule there are no due dates.`
          : `Current estimate: <strong>≈${money(est)}</strong> per payment — ${logged
            ? 'worked out from your logged payments (average of the latest three).'
            : 'the amount entered earlier, until you log payments.'}`;
        return `${now}
          Amounts come from the payments you log; add a change here only when how often you pay changes.`;
      })()}</p>
      <button type="button" class="link add-price recurring-only" data-add-price>+ Add change</button>`}

      <div class="group-title">How it's paid</div>
      <section class="card form">
        <label class="field toggle"><span>Amount varies</span>
          <input type="checkbox" name="variable" ${e.variable ? 'checked' : ''}></label>
        <label class="field toggle"><span>Manual payment</span>
          <input type="checkbox" name="manual" ${e.manual ? 'checked' : ''}></label>
        <label class="field"><span>Your share</span>
          <input name="share" inputmode="decimal" value="${e.share ?? 100}" aria-label="Your share in percent"><i class="suffix">%</i></label>
      </section>
      <p class="fine pad-x"><strong>Amount varies</strong> (e.g. utilities): no fixed amount needed — log real payments
        and the estimate is the average of your latest three. <strong>Manual</strong>: it appears under “To pay” with a Mark paid button.
        <strong>Your share</strong>: for split bills, only your part counts in the budget.</p>


      <section class="card form">
        <label class="field"><span>Category</span>
          <input name="category" list="dl-cat" placeholder="Choose or type" value="${esc(e.category)}" autocomplete="off" maxlength="40"></label>
        <label class="field"><span>Payment method</span>
          <input name="method" list="dl-method" placeholder="Choose or type" value="${esc(e.method)}" autocomplete="off" maxlength="40"></label>
      </section>

      <div class="group-title">Tags <span class="muted">— e.g. work, shared, tax-deductible</span></div>
      <section class="card form">
        <div class="tag-edit" id="tagEdit">
          <span id="tagChips"></span>
          <input id="tagInput" placeholder="Add tag…" autocomplete="off" autocapitalize="none" enterkeyhint="done" aria-label="Add tag">
        </div>
      </section>
      <div class="tag-suggest" id="tagSuggest"></div>

      <section class="card form recurring-only">
        <label class="field"><span>Contract ends</span>
          <input type="date" name="contractEnd" value="${esc(e.contractEnd || '')}"></label>
        <label class="field"><span>Notice needed</span>
          <input name="noticeDays" inputmode="numeric" placeholder="0" value="${e.noticeDays ?? ''}" aria-label="Notice needed in days"><i class="suffix">days</i></label>
        <label class="field toggle"><span>Stop when contract ends</span>
          <input type="checkbox" name="endsAtExpiry" ${e.endsAtExpiry ? 'checked' : ''}></label>
        <label class="field"><span>Cancelled on</span>
          <input type="date" name="endDate" value="${esc(e.endDate || '')}"></label>
      </section>
      <p class="fine pad-x recurring-only">Contract end is optional — you'll get a heads-up on the Overview as it approaches
        (or as the notice deadline approaches, if the contract needs notice). Set “Cancelled on” once you stop paying.</p>

      <section class="card form">
        <label class="field col"><span>Notes</span>
          <textarea name="notes" rows="3" placeholder="Account number, renewal terms…">${esc(e.notes)}</textarea></label>
      </section>

      ${isNew ? '' : `<button type="button" class="btn" data-merge-group>Merge into another group…</button>
        <button type="button" class="btn danger-btn" data-delete>Delete group</button>`}
      </div>

      ${isNew ? '' : `<div class="tab-panel ${tab === 'transactions' ? 'on' : ''}" data-panel="transactions" role="tabpanel">
        <div class="group-title">Payments made</div>
        <section class="card form" id="payments">${C.paymentsOf(e).reverse().map(p => payRow(p, e.type)).join('')}</section>
        <button type="button" class="link add-price" data-add-payment>+ Log payment</button>
        <p class="fine pad-x">Newest first. A minus amount is <span class="expense-only">a credit or refund</span><span
          class="income-only">money you paid back</span> — type “-” or tap ±. Changes here are kept when you tap Save.</p>
      </div>

      <div class="tab-panel ${tab === 'accounts' ? 'on' : ''}" data-panel="accounts" role="tabpanel">
        ${accountsSection(entry)}
        ${payeesSection(entry)}
      </div>`}
      <p class="form-error" id="formError" role="alert"></p>
    </div>
    <datalist id="dl-cat"></datalist>
    <datalist id="dl-method"></datalist>
  </form>`;

  const form = $('#entryForm');
  const syncType = () => {
    const type = form.type.value;
    $('#dl-cat').innerHTML = categoryOptions(type).map(c => `<option value="${esc(c)}">`).join('');
    form.classList.toggle('is-income', type === 'income');
    const w = PAY_WORDS[type];
    for (const row of form.querySelectorAll('.pay-row')) {
      row.querySelector('[name=paydate]').setAttribute('aria-label', w.date);
      row.querySelector('[name=payamount]').setAttribute('aria-label', w.amount);
      row.querySelector('[data-flip-sign]').setAttribute('aria-label', w.flip);
      row.querySelector('.pay-kind').textContent = w.credit;
    }
  };
  // New entries pick frequency at the top; existing ones in the first history row.
  const freqSelect = () => form.querySelector('select[name=frequency]') || form.querySelector('select[name=pfreq]');
  const syncFreq = () => {
    const once = freqSelect().value === 'once';
    const irregular = !!C.FREQ[freqSelect().value]?.irregular;
    form.classList.toggle('is-once', once);
    form.classList.toggle('is-irregular', irregular);
    $('.lbl-start', form).textContent = once ? 'Date' : irregular ? 'Started'
      : (form.type.value === 'income' ? 'First received' : 'First payment');
    // No set schedule: amounts always come from the payments logged
    if (irregular && !form.variable.checked) { form.variable.checked = true; syncVariable(); }
    else if (form.amount) syncVariable();
  };
  // "Amount varies": amounts come from logged payments, so they're optional / hidden in the history
  const syncVariable = () => {
    const v = form.variable.checked;
    form.classList.toggle('is-variable', v);
    if (form.amount) {
      const irregular = !!C.FREQ[freqSelect().value]?.irregular;
      $('.lbl-amount', form).textContent = irregular ? 'About per month' : v ? 'Estimate' : 'Amount';
      form.amount.placeholder = v ? 'Optional' : '0.00';
    }
  };
  $('#dl-method').innerHTML = methodOptions().map(c => `<option value="${esc(c)}">`).join('');
  syncType(); syncVariable(); syncFreq();

  // Tag editor
  let tags = normalizeTags(e.tags);
  const tagInput = $('#tagInput', form);
  const renderTags = () => {
    $('#tagChips', form).innerHTML = tags.map(t =>
      `<button type="button" class="chip on" data-remove-tag="${esc(t)}" aria-label="Remove tag ${esc(t)}">#${esc(t)} <span aria-hidden="true">×</span></button>`).join('');
    const q = cleanTag(tagInput.value);
    // your own tags first, then starter ideas you haven't used yet
    const suggestions = [...new Set([...allTags(), ...STARTER_TAGS])]
      .filter(t => !tags.includes(t) && (!q || t.includes(q))).slice(0, 12);
    $('#tagSuggest', form).innerHTML = suggestions.map(t =>
      `<button type="button" class="chip" data-add-tag="${esc(t)}">+ #${esc(t)}</button>`).join('');
  };
  const addTags = list => { tags = normalizeTags([...tags, ...list]); renderTags(); };
  const commitInput = () => { if (tagInput.value.trim()) { addTags(tagInput.value.split(',')); tagInput.value = ''; renderTags(); } };
  form._commitTags = commitInput;
  form._getTags = () => tags;
  tagInput.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') { ev.preventDefault(); commitInput(); }
    else if (ev.key === 'Backspace' && !tagInput.value && tags.length) { tags.pop(); renderTags(); }
  });
  tagInput.addEventListener('input', () => {
    if (tagInput.value.includes(',')) {
      const parts = tagInput.value.split(',');
      tagInput.value = parts.pop();
      addTags(parts);
    } else renderTags();
  });
  // Commit typed text when leaving the field — but not when the user is tapping a suggestion chip.
  $('#tagSuggest', form).addEventListener('mousedown', ev => ev.preventDefault());
  tagInput.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== tagInput) commitInput(); }, 200));
  renderTags();

  form.addEventListener('change', ev => {
    if (ev.target.name === 'type') { syncType(); syncFreq(); }
    if (ev.target.name === 'frequency' || ev.target.name === 'pfreq') syncFreq();
    if (ev.target.name === 'variable') syncVariable();
  });
  form.addEventListener('click', ev => {
    const rm = ev.target.closest('[data-remove-tag]');
    const add = ev.target.closest('[data-add-tag]');
    const tabBtn = ev.target.closest('[data-page]');
    if (tabBtn) showTab(form, tabBtn.dataset.page);
    else if (rm) { tags = tags.filter(t => t !== rm.dataset.removeTag); renderTags(); }
    else if (add) { tagInput.value = ''; addTags([add.dataset.addTag]); }
    else if (ev.target.closest('[data-close]')) closeSheet();
    else if (ev.target.closest('[data-add-price]')) {
      const freqs = [...form.querySelectorAll('select[name=pfreq]')].map(s => s.value).filter(v => v !== 'once');
      const lastFreq = freqs.at(-1) || 'monthly';
      $('#prices', form).insertAdjacentHTML('beforeend', priceRow({ from: C.todayISO(), amount: '', frequency: lastFreq }, false));
      $('#prices .price-row:last-child input[name=pamount]', form).focus();
    } else if (ev.target.closest('[data-remove-price]')) ev.target.closest('.price-row').remove();
    else if (ev.target.closest('[data-add-payment]')) {
      const est = entry ? C.estimateOn(entry, C.todayISO()) : C.parseAmount(form.amount?.value) || 0;
      $('#payments', form).insertAdjacentHTML('afterbegin',
        payRow({ date: C.todayISO(), amount: est ? Math.round(est * 100) / 100 : '' }, form.type.value));
      $('#payments .pay-row input[name=payamount]', form).select();
    } else if (ev.target.closest('[data-remove-payment]')) ev.target.closest('.pay-row').remove();
    else if (ev.target.closest('[data-flip-sign]')) {
      const row = ev.target.closest('.pay-row');
      const input = row.querySelector('[name=payamount]');
      const v = input.value.trim();
      input.value = v.startsWith('-') ? v.slice(1) : `-${v}`;
      syncPaySign(row);
    }
    else if (ev.target.closest('[data-delete]')) deleteEntry(entry);
    else if (ev.target.closest('[data-merge-group]')) mergeGroup(entry);
  });
  form.addEventListener('input', ev => { if (ev.target.name === 'payamount') syncPaySign(ev.target.closest('.pay-row')); });
  form.addEventListener('submit', ev => { ev.preventDefault(); saveForm(form, entry); });
  form.addEventListener('click', ev => {
    const mp = ev.target.closest('[data-move-payee]');
    if (mp) choosePayeeGroup(entry, mp.dataset.movePayee);
    const mv = ev.target.closest('[data-move-payment]');
    if (mv) choosePaymentGroup(entry, mv.dataset.movePayment);
  });

  document.body.classList.add('modal-open');
  if (!sheet.open) sheet.showModal();
  sheet.scrollTop = 0;
  if (isNew) setTimeout(() => form.name.focus(), 350);
}


export async function saveForm(form, existing) {
  const err = msg => { $('#formError').textContent = msg; $('#formError').scrollIntoView({ block: 'center', behavior: 'smooth' }); };
  const f = Object.fromEntries(new FormData(form));
  const name = (f.name || '').trim();
  if (!name) return err('Please enter a name.');
  if (!f.startDate) return err('Please choose a date.');
  const variable = !!f.variable;
  // Varying bills may leave amounts blank — the estimate then comes from logged payments
  const amountOf = raw => (variable && !String(raw ?? '').trim() ? null : C.parseAmount(raw));

  let prices;
  if (existing) {
    const froms = [...form.querySelectorAll('[name=pfrom]')].map(i => i.value);
    const amounts = [...form.querySelectorAll('[name=pamount]')].map(i => amountOf(i.value));
    const freqs = [...form.querySelectorAll('[name=pfreq]')].map(s => s.value);
    prices = froms.map((from, i) => ({ from: i === 0 ? f.startDate : from, amount: amounts[i], frequency: freqs[i] }));
    if (prices.some(p => !p.from)) return err('Each change needs a date.');
    if (prices.slice(1).some(p => p.from <= f.startDate)) return err('Changes must be after the first payment date.');
    if (new Set(prices.map(p => p.from)).size !== prices.length) return err('Two changes can’t start on the same date.');
    if (freqs[0] === 'once' && prices.length > 1) return err('A one-off payment can’t have later changes — remove them, or choose how often it repeats.');
  } else {
    prices = [{ from: f.startDate, amount: amountOf(f.amount), frequency: f.frequency }];
  }
  if (prices.some(p => !(p.amount === null || p.amount >= 0))) {
    return err(variable ? 'That estimate doesn’t look like an amount.' : 'Please enter a valid amount (or switch on “Amount varies”).');
  }
  prices.sort((a, b) => a.from.localeCompare(b.from));

  const once = prices[0].frequency === 'once';
  const frequency = once ? 'once' : prices.at(-1).frequency;
  if (!once && f.contractEnd && f.contractEnd < f.startDate) return err('Contract end can’t be before the first payment.');
  if (!once && f.endDate && f.endDate < f.startDate) return err('Cancelled date can’t be before the first payment.');

  const share = C.parseAmount(f.share || '100');
  if (!(share > 0 && share <= 100)) return err('Your share must be between 1 and 100%.');
  const noticeDays = f.noticeDays?.trim() ? Number(f.noticeDays.trim()) : null;
  if (noticeDays !== null && !(Number.isInteger(noticeDays) && noticeDays >= 0 && noticeDays <= 3650)) {
    return err('Notice needed should be a whole number of days.');
  }

  // Logged payments (edit mode only)
  const oldPays = new Map((existing?.payments || []).map(p => [p.id, p]));
  const payments = [];
  for (const row of form.querySelectorAll('.pay-row')) {
    const get = n => row.querySelector(`[name=${n}]`).value;
    const amount = C.parseAmount(get('payamount'));
    if (!get('paydate') || !Number.isFinite(amount)) return err('Each logged payment needs a date and an amount.');
    const id = get('payid') || uid();
    payments.push({ ...oldPays.get(id), id, date: get('paydate'), amount, due: get('paydue') || null });
  }
  payments.sort((a, b) => a.date.localeCompare(b.date));

  const now = new Date().toISOString();
  const entry = {
    ...existing, // keep any fields this version of the form doesn't know about
    id: existing?.id || uid(),
    type: f.type === 'income' ? 'income' : 'expense',
    name,
    category: canonicalLabel(f.category, categoryOptions(f.type === 'income' ? 'income' : 'expense')),
    method: canonicalLabel(f.method, methodOptions()),
    frequency,
    startDate: f.startDate,
    contractEnd: once ? null : f.contractEnd || null,
    endsAtExpiry: !once && !!f.endsAtExpiry,
    endDate: once ? null : f.endDate || null,
    notes: (f.notes || '').trim(),
    tags: (form._commitTags(), form._getTags()),
    prices,
    variable: !!f.variable,
    manual: !!f.manual,
    share: share >= 100 ? 100 : share,
    noticeDays: once || !noticeDays ? null : noticeDays,
    payments,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  const before = state.entries;
  await db.putEntry(entry);
  closeSheet();
  // Warn if this change pushed a budget over its limit this month
  const after = await db.allEntries();
  const now2 = new Date();
  const over = R.newlyOver(before, after, state.settings.budgets || [], now2.getFullYear(), now2.getMonth());
  if (over.length) {
    setTimeout(() => toast(`Over your ${over[0].budget.kind === 'tag' ? '#' : ''}${over[0].budget.label} budget by ${money(-over[0].left)} this month`), 2600);
  }
  await reload();
  toast(existing ? 'Saved' : 'Added');
}

/**
 * Merge a group into another: all its payments move there (into a group of the other type, their
 * sign flips: money out becomes a refund on income), its payees and budget follow, and this group
 * goes. For when the same company ended up in two groups, e.g. "Sq Woolworths" and "Woolworths".
 */
export async function mergeGroup(entry) {
  const choice = await pickGroup({ title: `Merge ${entry.name} into`, type: entry.type, exclude: [entry.id], create: false,
    suggested: groupSuggestions(entry.name, entry.type, [entry.id]) });
  const dest = choice?.id && state.entries.find(e => e.id === choice.id);
  if (!dest) return;
  const pays = entry.payments || [];
  if (!confirm(`Merge “${entry.name}” into “${dest.name}”? ${pays.length ? `Its ${pays.length === 1 ? '1 payment moves' : `${pays.length} payments move`} there, and so do its payees. ` : ''}“${entry.name}” is then removed.`)) return;
  await movePayments(pays.map(p => ({ p, e: entry })), dest);
  await db.deleteEntry(entry.id);
  state.settings.payees = M.payeesOf(state.settings).map(p => (p.groupId === entry.id ? { ...p, groupId: dest.id } : p));
  const budgets = state.settings.budgets || [];
  const hasOwn = budgets.some(b => b.kind === 'group' && b.groupId === dest.id);
  state.settings.budgets = budgets.flatMap(b => (b.kind === 'group' && b.groupId === entry.id
    ? (hasOwn ? [] : [{ ...b, groupId: dest.id, label: dest.name }]) : [b]));
  await saveSettings();
  await reload();
  const fresh = state.entries.find(e => e.id === dest.id);
  if (fresh) openSheet(fresh, 'summary'); else closeSheet();
  toast(`Merged into ${dest.name}${pays.length ? ` · ${pays.length} payment${pays.length === 1 ? '' : 's'} moved` : ''}`);
}

/**
 * Delete a group. Payments you logged by hand go with it. Imported ones move to "Ungrouped
 * spending" (or income), so they still count and aren't imported again, and its payees become
 * ungrouped: move them on from Settings → Payees, or from Ungrouped's Accounts page.
 */
export async function deleteEntry(entry) {
  const imported = (entry.payments || []).filter(p => p.source);
  const isUngrouped = entry.catchAll?.startsWith('ungrouped|');
  const note = imported.length && !isUngrouped
    ? ` Its ${imported.length} imported payment${imported.length === 1 ? '' : 's'} will move to ${ungroupedName(entry.type)}.` : '';
  if (!confirm(`Delete “${entry.name}”?${note} This can’t be undone.`)) return;
  const now = new Date().toISOString();
  if (imported.length && !isUngrouped) {
    const key = `ungrouped|${entry.type}`;
    const dest = state.entries.find(e => e.catchAll === key) || newGroup({ name: ungroupedName(entry.type), type: entry.type,
      start: imported.reduce((d, p) => (p.date < d ? p.date : d), imported[0].date), catchAll: key, fromImport: true,
      notes: 'Imported payments from groups you deleted. Open its Accounts page to move a payee into a group.' });
    const start = imported.reduce((d, p) => (p.date < d ? p.date : d), dest.startDate);
    await db.putEntry(normalizeEntry({ ...dest, startDate: start, prices: [{ ...dest.prices[0], from: start }],
      payments: [...(dest.payments || []), ...imported.map(p => ({ ...p, due: null }))], updatedAt: now }));
  }
  await db.deleteEntry(entry.id);
  state.settings.payees = M.ungroup(state.settings, entry.id);
  state.settings.budgets = (state.settings.budgets || []).filter(b => !(b.kind === 'group' && b.groupId === entry.id));
  await saveSettings();
  closeSheet();
  await reload();
  toast(note ? `Deleted · ${imported.length} payment${imported.length === 1 ? '' : 's'} moved to ${ungroupedName(entry.type)}` : 'Deleted');
}
const ungroupedName = type => (type === 'income' ? 'Ungrouped income' : 'Ungrouped spending');

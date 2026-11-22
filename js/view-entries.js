// The Entries tab: the list of entries, search and filters.
import * as C from './calc.js';
import { state, esc, money, signed, fmtDate, tagFiltered, tagBar, view } from './core.js';

export function renderEntries() {
  const today = C.todayISO();
  const yearly = state.settings.period === 'year';
  const per = yearly ? '/yr' : '/mo';
  const k = yearly ? 12 : 1;
  const q = state.search.trim().toLowerCase();
  const list = tagFiltered()
    .filter(e => state.filter === 'all' || e.type === state.filter)
    .filter(e => !q || [e.name, e.category, e.method, e.notes, ...(e.tags || []).map(t => '#' + t)]
      .some(f => (f || '').toLowerCase().includes(q)));

  const recurring = list.filter(e => e.frequency !== 'once' && !C.isEnded(e, today))
    .sort((a, b) => C.monthlyEquivalent(b) - C.monthlyEquivalent(a));
  const oneOff = list.filter(e => e.frequency === 'once').sort((a, b) => b.startDate.localeCompare(a.startDate));
  const ended = list.filter(e => C.isEnded(e, today)).sort((a, b) => C.stopDate(b).localeCompare(C.stopDate(a)));

  const totalMonthly = type => recurring.filter(e => e.type === type).reduce((s, e) => s + C.monthlyEquivalent(e), 0);

  const row = e => {
    const inc = e.type === 'income';
    const once = e.frequency === 'once';
    const full = once ? (e.payments?.length ? e.payments.reduce((s, p) => s + p.amount, 0) : C.priceOn(e, e.startDate))
                      : C.estimateOn(e, today);
    const due = C.nextDue(e, today);
    const last = C.paymentsOf(e).at(-1);
    const sub = [
      e.category,
      e.method,
      once ? fmtDate(e.startDate) : (C.FREQ[C.freqOn(e, today)].short || C.FREQ[C.freqOn(e, today)].label),
      C.isEnded(e, today) ? `Ended ${fmtDate(C.stopDate(e))}` : (!once && due ? `Next ${fmtDate(due)}` : null),
      e.manual ? 'Paid manually' : null,
      last && !once ? `Last ${money(last.amount)} on ${fmtDate(last.date)}` : null,
    ].filter(Boolean).map(esc).join(' · ');
    const notes = [];
    if (e.share < 100) notes.push(`your ${e.share}% of ${money(full)}`);
    const f = once ? 'once' : C.isIrregular(e, today) ? 'monthly' : C.freqOn(e, today); // no schedule: shown per month
    if (!once && C.isIrregular(e, today) && !yearly) notes.push('about a month');
    // show the per-month (or per-year) figure when it differs from the amount shown
    if (!once && C.monthlyEquivalent(e) > 0 && (yearly ? f !== 'yearly' : f !== 'monthly')) notes.push(`≈ ${money(C.monthlyEquivalent(e) * k)}${per}`);
    const tags = e.tags?.length
      ? `<div class="row-tags">${e.tags.map(t => `<span class="chip tiny">#${esc(t)}</span>`).join('')}</div>` : '';
    return `<button class="row" data-action="edit" data-id="${e.id}">
      <div class="row-main"><div class="row-title">${esc(e.name)}</div><div class="row-sub">${sub}</div>${tags}</div>
      <div class="row-amt ${inc ? 'pos' : 'neg'}">${signed(e, full * C.shareOf(e))}${notes.map(n => `<small>${n}</small>`).join('')}</div>
    </button>`;
  };
  const group = (title, items, extra = '') => items.length
    ? `<div class="group-title">${title}${extra}</div><section class="card list">${items.map(row).join('')}</section>` : '';

  const totals = state.filter === 'all'
    ? ` <span class="muted">${money((totalMonthly('income') - totalMonthly('expense')) * k)}${per} net</span>`
    : ` <span class="muted">${money(totalMonthly(state.filter) * k)}${per}</span>`;

  view.innerHTML = `
    <div class="toolbar">
      <div class="seg">
        ${[['all', 'All'], ['expense', 'Expenses'], ['income', 'Income']].map(([v, l]) =>
          `<button data-action="filter" data-filter="${v}" class="${state.filter === v ? 'on' : ''}">${l}</button>`).join('')}
      </div>
      <input type="search" id="search" placeholder="Search names, notes, #tags" value="${esc(state.search)}" autocomplete="off">
      ${tagBar()}
    </div>
    ${list.length ? '' : `<p class="empty-small">${state.entries.length ? 'Nothing matches.' : 'No groups yet. Tap + to add one.'}</p>`}
    ${group('Recurring', recurring, recurring.length ? totals : '')}
    ${group('One-off', oneOff)}
    ${group('Ended', ended)}
  `;
}

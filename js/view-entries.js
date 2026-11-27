// The Payee groups tab (entries in the code): search and filters, then a list on a phone or a
// table you can sort on a computer.
import * as C from './calc.js';
import * as R from './reports.js';
import { state, esc, money, signed, fmtDate, tagFiltered, tagBar, view, sectionize, wideScreen } from './core.js';

/** How the computer's table is sorted: a column key, and 1 (A–Z, earliest first) or −1. */
state.groupSort = { key: 'per', dir: -1 };

export function renderEntries() {
  const today = C.todayISO();
  const now = new Date();
  const lastYear = state.settings.period === 'last12'; // what the last 12 full months came to
  const yearly = state.settings.period === 'year' || lastYear;
  const per = lastYear ? ' over the last 12 months' : yearly ? '/yr' : '/mo';
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

  // Per month (× k); over the last 12 months, what they came to (÷ 12, so × k gives it back)
  const perMonth = e => (lastYear ? R.lastYearAmount(e, now) / 12 : C.monthlyEquivalent(e));
  const totalMonthly = type => recurring.filter(e => e.type === type).reduce((s, e) => s + perMonth(e), 0);

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
    if (lastYear && !once) { const v = R.lastYearAmount(e, now); if (v > 0) notes.push(`${money(v)} last 12 mo`); }
    else if (!once && C.monthlyEquivalent(e) > 0 && (yearly ? f !== 'yearly' : f !== 'monthly')) notes.push(`≈ ${money(C.monthlyEquivalent(e) * k)}${per}`);
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
    ? ` <span class="muted">${money((totalMonthly('income') - totalMonthly('expense')) * k)}${lastYear ? ` net${per}` : `${per} net`}</span>`
    : ` <span class="muted">${money(totalMonthly(state.filter) * k)}${per}</span>`;

  const toolbar = `
    <div class="toolbar">
      <div class="seg">
        ${[['all', 'All'], ['expense', 'Expenses'], ['income', 'Income']].map(([v, l]) =>
          `<button data-action="filter" data-filter="${v}" class="${state.filter === v ? 'on' : ''}">${l}</button>`).join('')}
      </div>
      <input type="search" id="search" placeholder="Search names, notes, #tags" value="${esc(state.search)}" autocomplete="off">
      ${tagBar()}
    </div>
    ${list.length ? '' : `<p class="empty-small">${state.entries.length ? 'Nothing matches.' : 'No payee groups yet. Tap + to add one.'}</p>`}`;
  if (wideScreen.matches) {
    view.innerHTML = toolbar + (list.length ? groupTable(list, { today, now, yearly, lastYear, perMonth, k, totals }) : '');
    return;
  }

  view.innerHTML = `${toolbar}
    ${group('Recurring', recurring, recurring.length ? totals : '')}
    ${group('One-off', oneOff)}
    ${group('Ended', ended)}
  `;
  sectionize(view, 'grp-cols');
}

// ---------- The table, on a computer ----------

/** Every payee group shown as one row; click a heading to sort by that column. */
function groupTable(list, { today, now, yearly, lastYear, perMonth, k, totals }) {
  const { key, dir } = state.groupSort;
  const rows = list.map(e => {
    const once = e.frequency === 'once';
    const ended = C.isEnded(e, today);
    const inc = e.type === 'income';
    const full = (once ? (e.payments?.length ? e.payments.reduce((s, p) => s + p.amount, 0) : C.priceOn(e, e.startDate))
                       : C.estimateOn(e, today)) * C.shareOf(e);
    const schedule = once ? 'One-off' : ended ? `Ended ${fmtDate(C.stopDate(e))}` : C.FREQ[C.freqOn(e, today)].label;
    const next = once ? (e.startDate >= today ? e.startDate : '') : ended ? '' : C.nextDue(e, today) || '';
    // a month (or a year, or the last 12 months) of it, as on the Overview; nothing for one-offs and ended ones
    const perVal = lastYear ? R.lastYearAmount(e, now) : once || ended ? 0 : perMonth(e) * k;
    const last = C.paymentsOf(e).at(-1) || null;
    // what each column sorts by: amounts by size, so the biggest come first whichever way the money goes
    const by = { name: e.name.toLowerCase(), category: (e.category || '').toLowerCase(), schedule: schedule.toLowerCase(),
      next, amount: Math.abs(full), per: perVal, last: last?.date || '' };
    return { e, once, ended, inc, full, schedule, next, perVal, last, by };
  });
  const cmp = (a, b) => {
    const x = a.by[key], y = b.by[key];
    if (x === '' || y === '') return (x === '') - (y === ''); // blanks (no date) last, whichever way
    return (typeof x === 'number' ? x - y : x.localeCompare(y)) * dir;
  };
  rows.sort((a, b) => cmp(a, b) || a.e.name.localeCompare(b.e.name));

  const perHead = lastYear ? 'Last 12 mo' : yearly ? 'A year' : 'A month';
  const th = (k2, label, cls) => {
    const on = key === k2;
    return `<th class="${cls}" aria-sort="${on ? (dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button"
      data-action="grp-sort" data-key="${k2}">${label}<span class="sort-ind" aria-hidden="true">${on ? (dir > 0 ? '▲' : '▼') : ''}</span></button></th>`;
  };
  const none = '<span class="muted">—</span>';
  const tr = r => `<tr class="${r.ended ? 'ended' : ''}" data-action="edit" data-id="${r.e.id}">
      <td class="g-name"><button type="button" class="g-open" data-action="edit" data-id="${r.e.id}">${esc(r.e.name)}</button>
        ${r.e.tags?.length ? `<span class="row-tags">${r.e.tags.map(t => `<span class="chip tiny">#${esc(t)}</span>`).join('')}</span>` : ''}</td>
      <td class="g-cat">${esc(r.e.category || '')}</td>
      <td class="g-sched">${esc(r.schedule)}${r.e.manual && !r.ended ? '<small>paid by hand</small>' : ''}</td>
      <td class="g-next">${r.next ? esc(fmtDate(r.next)) : none}</td>
      <td class="g-amt ${r.inc ? 'pos' : 'neg'}">${signed(r.e, r.full)}${r.e.share < 100 ? `<small>your ${r.e.share}%</small>` : ''}</td>
      <td class="g-per ${r.inc ? 'pos' : 'neg'}">${r.perVal > 0.004
        ? `${r.inc ? '+' : '−'}${C.isIrregular(r.e, today) && !lastYear ? '≈' : ''}${money(r.perVal)}` : none}</td>
      <td class="g-last">${r.last ? `${esc(fmtDate(r.last.date))}<small>${money(Math.abs(r.last.amount))}</small>` : none}</td>
    </tr>`;
  const n = { running: rows.filter(r => !r.once && !r.ended).length, once: rows.filter(r => r.once).length, ended: rows.filter(r => r.ended).length };
  return `<div class="tx-sum g-sum">
      <span><strong>${rows.length}</strong> payee group${rows.length === 1 ? '' : 's'}</span>
      <span>${[n.running && `${n.running} recurring`, n.once && `${n.once} one-off`, n.ended && `${n.ended} ended`].filter(Boolean).join(' · ')}</span>
      ${n.running ? `<span>Recurring${totals}</span>` : ''}
    </div>
    <section class="card tx-card"><table class="tx-table g-table">
      <thead><tr>${th('name', 'Payee group', 'g-name')}${th('category', 'Category', 'g-cat')}${th('schedule', 'Schedule', 'g-sched')}${th('next', 'Next due', 'g-next')}${th('amount', 'Amount', 'g-amt')}${th('per', perHead, 'g-per')}${th('last', 'Last paid', 'g-last')}</tr></thead>
      <tbody>${rows.map(tr).join('')}</tbody>
    </table></section>
    <p class="fine">${lastYear ? 'Last 12 mo is what each came to over the last 12 full months.'
      : `${perHead} is what each recurring one costs ${yearly ? 'a year' : 'a month'} at today’s rates, as on the Overview (switch with Month / Year / 12 mo there).`} Your share.</p>`;
}

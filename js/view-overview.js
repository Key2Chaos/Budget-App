// The Overview tab: totals, chart, upcoming payments, where it goes, budgets, until payday.
import * as C from './calc.js';
import { buildChart } from './chart.js';
import * as R from './reports.js';
import { localDay, FORECAST_MONTHS, state, $, esc, money, dueAmount, signed, compactMoney, monthShort, monthLong, monthYear, dayShort, fmtDate, relDays, tagFiltered, tagBar, view } from './core.js';
import { accountName } from './importer.js';

export let chartCtl = null;
export let chartData = [];

export function renderOverview() {
  if (!state.entries.length) {
    view.innerHTML = `
      <div class="empty">
        <div class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>
        </div>
        <h2>Track what comes in and goes out</h2>
        <p>Add your bills, subscriptions, contracts and income. You'll see your monthly budget and how it changes over time.</p>
        <button class="btn primary" data-action="add">Add your first group</button>
        <button class="btn" data-action="sample">Try it with sample data</button>
      </div>`;
    return;
  }

  const now = new Date();
  const today = C.todayISO();
  const entries = tagFiltered();
  const needsBackup = !state.settings.lastBackup || C.daysBetween(localDay(state.settings.lastBackup), today) > 30;
  const backupBanner = needsBackup ? `<button class="banner" data-action="go-settings">
      <strong>Back up your data</strong><span>Your budget lives only on this device. Save a copy to iCloud Drive.</span></button>` : '';

  if (!entries.length) {
    view.innerHTML = `${backupBanner}${tagBar()}<p class="empty-small">No groups have all of these tags.</p>`;
    return;
  }
  const cur = C.monthTotals(entries, now.getFullYear(), now.getMonth());
  const yearly = state.settings.period === 'year';
  const per = yearly ? '/yr' : '/mo';
  const k = yearly ? 12 : 1; // multiplier for per-month figures
  const yr = R.annualTotals(entries, today);
  const filtered = state.tags.length > 0;

  // Chart range
  let past = state.range;
  if (state.range === 'all') {
    const first = entries.reduce((m, e) => (e.startDate < m ? e.startDate : m), today);
    const f = C.parse(first);
    past = Math.max(2, (now.getFullYear() - f.getFullYear()) * 12 + now.getMonth() - f.getMonth() + 1);
  }
  const start = new Date(now.getFullYear(), now.getMonth() - past + 1, 1);
  chartData = C.series(entries, start.getFullYear(), start.getMonth(), past + FORECAST_MONTHS);
  const currentIdx = past - 1;
  if (state.sel == null || state.sel >= chartData.length) state.sel = currentIdx;

  chartCtl = buildChart(chartData, {
    currentIdx,
    axisFmt: compactMoney,
    monthFmt: d => (d.m === 0 ? String(d.y) : monthShort.format(new Date(d.y, d.m, 1))),
  });

  // Insight: change since start of range
  const first = chartData[0], last = chartData[currentIdx];
  const insight = [];
  const change = (label, a, b, goodUp) => {
    const diff = b - a;
    if (Math.abs(diff) < 0.005) return `<li>${label} unchanged since ${monthYear.format(new Date(first.y, first.m, 1))}</li>`;
    const p = a > 0 ? (diff / a) * 100 : null;
    const pct = p === null ? '' : Math.abs(p) < 1 ? ' (<1%)' : ` (${p > 0 ? '+' : ''}${Math.round(p)}%)`;
    const good = goodUp ? diff > 0 : diff < 0;
    return `<li><span class="${good ? 'pos' : 'neg'}">${label} ${diff > 0 ? 'up' : 'down'} ${money(Math.abs(diff))}/mo${pct}</span> since ${monthYear.format(new Date(first.y, first.m, 1))}</li>`;
  };
  if (currentIdx > 0) {
    insight.push(change('Spending', first.expense, last.expense, false));
    insight.push(change('Income', first.income, last.income, true));
  }

  // Biggest changes over the same period as the chart
  const sinceISO = C.iso(C.addMonths(now, -(past - 1)));
  const changes = currentIdx > 0 ? R.biggestChanges(entries, sinceISO, today, 6) : [];

  // Budgets (this month, all entries) and until-payday — hidden while a tag filter is on
  const budgets = filtered ? [] : (state.settings.budgets || [])
    .map(b => R.budgetStatus(state.entries, b, now.getFullYear(), now.getMonth()))
    .sort((a, b) => b.pct - a.pct);
  const pd = filtered ? null : R.untilPayday(state.entries, today, state.settings.paydayId);

  // Manual payments to make (overdue + next 14 days)
  const pay = C.toPay(entries, today);

  // Upcoming automatic payments (next 14 days) — manual ones are in "To pay" above
  const horizon = C.addDaysISO(today, 14);
  const upcoming = entries
    .filter(e => !e.manual)
    .map(e => ({ e, due: C.nextDue(e, today) }))
    .filter(x => x.due && x.due <= horizon)
    .sort((a, b) => a.due.localeCompare(b.due))
    .slice(0, 6);

  // Contracts: notice deadline (if set) or end date coming up, or recently out of contract
  const contracts = entries
    .filter(e => e.contractEnd && e.frequency !== 'once' && !(e.endDate && e.endDate < today))
    .map(e => {
      const notice = C.noticeBy(e);
      const endDays = C.daysBetween(today, e.contractEnd);
      const noticeDays = notice ? C.daysBetween(today, notice) : null;
      // count down to the notice deadline while it's still ahead, otherwise to the end date
      const days = noticeDays !== null && noticeDays >= 0 ? noticeDays : endDays;
      return { e, notice, noticeDays, endDays, days };
    })
    .filter(x => x.days <= 60 && (x.endDays >= 0 || (!x.e.endsAtExpiry && x.endDays >= -60)))
    .sort((a, b) => a.days - b.days);

  // Breakdown of this month's expenses, by category, tag or group
  const byTag = state.breakdown === 'tag';
  const byGroup = state.breakdown === 'group';
  const cats = {};
  for (const e of entries) {
    if (e.type !== 'expense') continue;
    // month: what this calendar month costs (incl. one-offs); year: 12 × today's monthly rate
    const v = yearly ? 12 * R.monthlyAt(e, today) : C.monthAmount(e, now.getFullYear(), now.getMonth());
    if (v <= 0) continue;
    const keys = byTag ? (e.tags?.length ? e.tags.map(t => '#' + t) : ['Untagged']) : byGroup ? [e.name] : [e.category || 'Other'];
    for (const k of keys) cats[k] = (cats[k] || 0) + v;
  }
  const allCats = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  // By group there can be dozens: the biggest 12, and the rest together
  const catList = byGroup && allCats.length > 13
    ? [...allCats.slice(0, 12), [`${allCats.length - 12} other groups`, allCats.slice(12).reduce((n, x) => n + x[1], 0)]]
    : allCats;
  const catMax = catList.length ? catList[0][1] : 1;
  const filterNote = state.tags.length ? `<p class="fine">Showing only groups tagged ${state.tags.map(t => '#' + esc(t)).join(' + ')}.</p>` : '';

  view.innerHTML = `
    ${backupBanner}
    ${tagBar()}
    ${filterNote}

    ${pay.length ? `<section class="card">
      <div class="card-head"><h3>To pay</h3><span class="muted">${pay.filter(x => x.overdue).length ? `${pay.filter(x => x.overdue).length} overdue` : 'manual payments'}</span></div>
      <div class="list">${pay.map(({ e, due, overdue }) => `
        <div class="row pay-item">
          <button class="row-main plain" data-action="edit" data-id="${e.id}">
            <div class="row-title">${esc(e.name)}</div>
            <div class="row-sub ${overdue ? 'neg' : ''}">${overdue ? 'Overdue · was due ' : 'Due '}${fmtDate(due)} · ${relDays(C.daysBetween(today, due))}</div>
          </button>
          <div class="row-amt ${e.type === 'income' ? 'pos' : 'neg'}">${signed(e, dueAmount(e, due))}</div>
          <button class="btn small" data-action="mark-paid" data-id="${e.id}" data-due="${due}">${e.type === 'income' ? 'Received' : 'Mark paid'}</button>
        </div>`).join('')}
      </div></section>` : ''}

    <section class="card summary">
      <div class="summary-top">
        <div class="summary-head">${yearly ? 'Per year at today’s rates' : esc(monthLong.format(now))}</div>
        <div class="seg small">
          <button data-action="period" data-period="month" class="${yearly ? '' : 'on'}">Month</button>
          <button data-action="period" data-period="year" class="${yearly ? 'on' : ''}">Year</button>
        </div>
      </div>
      ${(() => {
        const t = yearly ? yr : cur;
        return `<div class="summary-grid">
        <div><span class="k">Income</span><span class="v pos">${money(t.income)}</span></div>
        <div><span class="k">Expenses</span><span class="v neg">${money(t.expense)}</span></div>
        <div class="net"><span class="k">${filtered ? 'Net for these tags' : 'Left over'}</span><span class="v ${t.net >= 0 ? 'pos' : 'neg'}">${money(t.net)}</span></div>
      </div>`;
      })()}
      <p class="fine">${yearly
        ? 'Everything running today × 12 (one-offs not included).'
        : 'Recurring items are spread evenly per month (e.g. yearly ÷ 12).'}</p>
    </section>

    ${budgets.length ? `<section class="card">
      <div class="card-head"><h3>Budgets</h3><button class="link small-link" data-action="manage-budgets">Edit</button></div>
      <p class="fine">This month</p>
      <div class="cats">${budgets.map(s => `
        <div class="cat">
          <div class="cat-top"><span>${s.budget.kind === 'tag' ? '#' : ''}${esc(s.budget.kind === 'group' ? state.entries.find(e => e.id === s.budget.groupId)?.name || s.budget.label : s.budget.label)}</span>
            <span>${money(s.spent)} <span class="muted">of ${money(s.budget.amount)}</span></span></div>
          <div class="bar ${s.over ? 'over' : s.near ? 'near' : ''}"><span style="width:${Math.min(100, s.pct * 100).toFixed(1)}%"></span></div>
          <div class="cat-note ${s.over ? 'neg' : ''}">${s.over ? `Over by ${money(-s.left)}` : `${money(s.left)} left`}</div>
        </div>`).join('')}
      </div></section>` : ''}

    ${pd ? (() => {
      const bal = state.settings.balance;
      const balAge = bal ? C.daysBetween(bal.date, today) : 0;
      let running = bal ? bal.amount : 0;
      const rows = pd.items.map(i => {
        running += i.amount;
        return `<div class="pd-row">
          <span class="pd-date">${i.overdue ? '<span class="neg">Overdue</span>' : esc(dayShort.format(C.parse(i.date)))}</span>
          <span class="pd-name">${esc(i.e.name)}</span>
          <span class="pd-amt ${i.amount < 0 ? 'neg' : 'pos'}">${i.amount < 0 ? '−' : '+'}${i.e.variable ? '≈' : ''}${money(Math.abs(i.amount))}</span>
          ${bal ? `<span class="pd-left ${running < 0 ? 'neg' : ''}">${money(running)}</span>` : ''}
        </div>`;
      }).join('');
      const leftAtEnd = bal ? bal.amount + pd.net : null;
      return `<section class="card">
        <div class="card-head"><h3>Until payday</h3><span class="muted">${esc(pd.main.name)} · ${fmtDate(pd.payday)} · ${relDays(pd.days)}</span></div>
        <label class="row static balance-row">
          <div class="row-main"><div class="row-title">Balance now</div>
            <div class="row-sub">${bal ? `${bal.account ? `from the ${esc(accountName(bal.account))} statement,` : 'entered'} ${relDays(-balAge)}${balAge > 2 ? ' — update it for accuracy' : ''}` : 'Optional — see what’s left after each payment'}</div></div>
          <input id="balance" inputmode="decimal" placeholder="0.00" value="${bal ? bal.amount.toFixed(2) : ''}" aria-label="Current balance">
        </label>
        <div class="pd-summary">
          <div><span class="k">Going out</span><span class="v neg">${money(pd.out)}</span></div>
          ${pd.in ? `<div><span class="k">Coming in</span><span class="v pos">${money(pd.in)}</span></div>` : ''}
          ${bal ? `<div><span class="k">Left before payday</span><span class="v ${leftAtEnd < 0 ? 'neg' : 'pos'}">${money(leftAtEnd)}</span></div>` : ''}
        </div>
        ${pd.items.length ? `<details class="pd-details"${pd.items.length <= 5 ? ' open' : ''}>
          <summary>${pd.items.length} payment${pd.items.length === 1 ? '' : 's'} before payday</summary>
          <div class="pd-list">${rows}</div>
        </details>` : '<p class="fine">Nothing due before payday.</p>'}
      </section>`;
    })() : ''}

    <section class="card">
      <div class="card-head">
        <h3>Over time</h3>
        <div class="seg small">
          ${[[6, '6M'], [12, '1Y'], [24, '2Y'], ['all', 'All']].map(([v, l]) =>
            `<button data-action="range" data-range="${v}" class="${state.range === v ? 'on' : ''}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="chart">${chartCtl.svg}</div>
      <div class="legend"><span class="sw income"></span>Income <span class="sw expense"></span>Expenses</div>
      <div class="readout" id="readout"></div>
      ${insight.length ? `<ul class="insight">${insight.join('')}</ul>` : ''}
    </section>

    ${changes.length ? `<section class="card">
      <div class="card-head"><h3>Biggest changes</h3><span class="muted">since ${monthYear.format(C.parse(sinceISO))}</span></div>
      <div class="list">${changes.map(({ e, before, after, diff, kind }) => {
        const good = e.type === 'income' ? diff > 0 : diff < 0;
        const sub = kind === 'new' ? `New · ${money(after * k)}${per}`
          : kind === 'ended' ? `Ended · was ${money(before * k)}${per}`
          : `${money(before * k)} → ${money(after * k)}${per}`;
        return `<button class="row" data-action="edit" data-id="${e.id}">
          <div class="row-main"><div class="row-title">${esc(e.name)}</div><div class="row-sub">${sub}</div></div>
          <div class="row-amt ${good ? 'pos' : 'neg'}">${diff > 0 ? '+' : '−'}${money(Math.abs(diff) * k)}${per}</div>
        </button>`;
      }).join('')}</div>
      <p class="fine">Change in ${yearly ? 'yearly' : 'monthly'} cost, your share. Green is good for you, red is not.</p>
    </section>` : ''}

    ${contracts.length ? `<section class="card">
      <div class="card-head"><h3>Contracts</h3></div>
      <div class="list">${contracts.map(({ e, notice, noticeDays, endDays, days }) => `
        <button class="row" data-action="edit" data-id="${e.id}">
          <div class="row-main">
            <div class="row-title">${esc(e.name)}</div>
            <div class="row-sub">${endDays < 0
              ? `Out of contract since ${fmtDate(e.contractEnd)} — worth checking for a better deal`
              : noticeDays !== null && noticeDays >= 0
                ? `Give notice by <strong>${fmtDate(notice)}</strong> (${relDays(noticeDays)}) · ends ${fmtDate(e.contractEnd)}`
                : `Ends ${fmtDate(e.contractEnd)} · ${relDays(endDays)} · ${e.endsAtExpiry ? 'will stop' : 'then rolls over'}${notice ? ' · notice date passed' : ''}`}</div>
          </div>
          <span class="pill ${endDays < 0 ? 'warn' : days <= 14 ? 'soon' : ''}">${endDays >= 0 ? `${days}d` : 'Expired'}</span>
        </button>`).join('')}
      </div></section>` : ''}

    ${upcoming.length ? `<section class="card">
      <div class="card-head"><h3>Next 14 days</h3></div>
      <div class="list">${upcoming.map(({ e, due }) => `
        <button class="row" data-action="edit" data-id="${e.id}">
          <div class="row-main">
            <div class="row-title">${esc(e.name)}</div>
            <div class="row-sub">${fmtDate(due)} · ${relDays(C.daysBetween(today, due))}${e.method ? ' · ' + esc(e.method) : ''}</div>
          </div>
          <div class="row-amt ${e.type === 'income' ? 'pos' : 'neg'}">${signed(e, dueAmount(e, due))}</div>
        </button>`).join('')}
      </div></section>` : ''}

    ${catList.length ? `<section class="card">
      <div class="card-head"><h3>Where it goes</h3>
        <div class="seg small">
          <button data-action="breakdown" data-by="category" class="${byTag || byGroup ? '' : 'on'}">Category</button>
          <button data-action="breakdown" data-by="group" class="${byGroup ? 'on' : ''}">Group</button>
          <button data-action="breakdown" data-by="tag" class="${byTag ? 'on' : ''}">Tag</button>
        </div></div>
      <p class="fine">${yearly ? 'Per year at today’s rates' : 'This month'}${byTag ? ' · a group with several tags counts towards each' : ''}</p>
      <div class="cats">${catList.map(([name, v]) => `
        <div class="cat">
          <div class="cat-top"><span>${esc(name)}</span><span>${money(v)} <span class="muted">${Math.round((v / (yearly ? yr.expense : cur.expense)) * 100)}%</span></span></div>
          <div class="bar"><span style="width:${((v / catMax) * 100).toFixed(1)}%"></span></div>
        </div>`).join('')}
      </div></section>` : ''}
  `;

  const svg = $('.chart-svg', view);
  const select = i => { state.sel = i; chartCtl.highlight(svg, i); updateReadout(currentIdx); };
  select(state.sel);
  const onPointer = ev => select(chartCtl.indexAt(svg, ev.clientX));
  svg.addEventListener('pointerdown', onPointer);
  svg.addEventListener('pointermove', ev => { if (ev.buttons || ev.pointerType === 'touch') onPointer(ev); });
}

export function updateReadout(currentIdx) {
  const d = chartData[state.sel];
  if (!d) return;
  const label = monthLong.format(new Date(d.y, d.m, 1)) + (state.sel > currentIdx ? ' (forecast)' : '');
  $('#readout').innerHTML = `
    <div class="ro-month">${esc(label)}</div>
    <div class="ro-grid">
      <span><i class="sw income"></i>${money(d.income)}</span>
      <span><i class="sw expense"></i>${money(d.expense)}</span>
      <span class="${d.net >= 0 ? 'pos' : 'neg'}">Net ${money(d.net)}</span>
    </div>`;
}

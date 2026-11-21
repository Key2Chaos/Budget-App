// Run with:  node tests/run.mjs     (no dependencies; Node 18+)
// Guards that old backups keep importing, and that the date/money maths stays correct.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../js/calc.js';
import * as R from '../js/reports.js';
import * as B from '../js/bank.js';
import { SCHEMA_VERSION, migrateBackup, buildBackup, normalizeEntry, normalizeTags, cleanTag } from '../js/schema.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = join(root, 'tests', 'fixtures');
const fixtures = readdirSync(fixtureDir).filter(f => f.endsWith('.json')).sort();
const load = f => JSON.parse(readFileSync(join(fixtureDir, f), 'utf8'));

// ---------- Old backups keep working ----------

test('there is a fixture for every format version up to the current one', () => {
  for (let v = 1; v <= SCHEMA_VERSION; v++) {
    assert.ok(fixtures.some(f => f.startsWith(`v${v}-`)),
      `Add a backup in format ${v} to tests/fixtures/ (named v${v}-<date>-<description>.json)`);
  }
});

for (const f of fixtures) {
  test(`fixture ${f} imports fully and calculates cleanly`, () => {
    const raw = load(f);
    const { entries, skipped } = migrateBackup(raw);
    assert.equal(skipped, 0, 'no entries should be dropped');
    assert.equal(entries.length, raw.entries.length);

    for (const e of entries) {
      assert.ok(Array.isArray(e.tags), `${e.name}: tags is an array`);
      assert.ok(e.prices.length > 0, `${e.name}: has a price`);
      // nothing in the original entry is lost
      const orig = raw.entries.find(r => String(r.id) === e.id);
      for (const k of Object.keys(orig)) assert.ok(k in e, `${e.name}: kept field "${k}"`);
      assert.equal(e.name, orig.name.trim());
      assert.equal(e.startDate, orig.startDate);
      assert.equal(C.priceOn(e, '2100-01-01'), Number(orig.prices.at(-1).amount));
      assert.doesNotThrow(() => C.nextDue(e, '2026-11-21'));
    }
    // three years of monthly totals are all real numbers
    for (const m of C.series(entries, 2024, 0, 36)) {
      assert.ok(Number.isFinite(m.income) && Number.isFinite(m.expense), `${m.y}-${m.m + 1} totals are numbers`);
    }
  });

  test(`fixture ${f} survives export → import unchanged`, () => {
    const { entries, settings } = migrateBackup(load(f));
    const again = migrateBackup(JSON.parse(JSON.stringify(buildBackup(entries, settings))));
    assert.deepEqual(again.entries, entries);
    assert.deepEqual(again.settings, settings);
  });
}

test('initial-release backup: known values', () => {
  const { entries, settings } = migrateBackup(load('v1-2026-11-initial-release.json'));
  const by = n => entries.find(e => e.name === n);
  assert.equal(settings.currency, 'GBP');
  assert.equal(C.priceOn(by('Rent'), '2025-10-31'), 950);
  assert.equal(C.priceOn(by('Rent'), '2025-11-01'), 1010);
  assert.equal(C.monthAmount(by('Gym'), 2026, 7), 35);        // Aug 2026: contract ends that month
  assert.equal(C.monthAmount(by('Gym'), 2026, 8), 0);         // Sep 2026: stopped at contract end
  assert.equal(C.monthAmount(by('Netflix'), 2026, 6), 0);     // cancelled June 2026
  assert.equal(C.monthAmount(by('Car insurance'), 2026, 3), 51); // 612 / 12
  assert.equal(C.monthAmount(by('Freelance design job'), 2026, 8), 450);
  assert.deepEqual(by('Salary').tags, []);                    // pre-tags data gets an empty list
});

test('v1 → v2: every price period gets the entry’s frequency', () => {
  const raw = load('v1-2026-11-initial-release.json');
  const { entries } = migrateBackup(raw);
  for (const e of entries) {
    const orig = raw.entries.find(r => r.id === e.id);
    assert.equal(e.frequency, orig.frequency, `${e.name}: frequency unchanged`);
    for (const p of e.prices) assert.equal(p.frequency, orig.frequency, `${e.name}: period frequency`);
  }
});

test('frequency changes: amounts and payment dates follow the history', () => {
  const { entries } = migrateBackup(load('v2-2026-11-frequency-changes.json'));
  const by = n => entries.find(e => e.name === n);

  const car = by('Car insurance');                 // £600 yearly → £55 monthly from 1 Mar 2026
  assert.equal(C.freqOn(car, '2026-02-15'), 'yearly');
  assert.equal(C.freqOn(car, '2026-03-01'), 'monthly');
  assert.equal(C.monthAmount(car, 2026, 1), 50);   // Feb 2026: 600 / 12
  assert.equal(C.monthAmount(car, 2026, 3), 55);   // Apr 2026: 55 monthly
  assert.equal(C.nextDue(car, '2025-03-02'), '2026-03-01'); // next yearly date = start of monthly plan
  assert.equal(C.nextDue(car, '2026-03-02'), '2026-04-01');

  const cleaner = by('Cleaner');                   // weekly → fortnightly (1 Sep 2025) → price rise
  assert.equal(C.nextDue(cleaner, '2025-01-07'), '2025-01-13');  // weekly from Mon 6 Jan
  assert.equal(C.nextDue(cleaner, '2025-08-30'), '2025-09-01');  // switch date wins over next weekly
  assert.equal(C.nextDue(cleaner, '2025-09-02'), '2025-09-15');  // fortnightly from 1 Sep
  assert.equal(C.nextDue(cleaner, '2026-04-02'), '2026-04-13');  // price rise keeps the fortnightly rhythm (…30 Mar, 13 Apr)
  assert.ok(Math.abs(C.monthAmount(cleaner, 2025, 5) - 40 * 52 / 12) < 1e-9);
  assert.ok(Math.abs(C.monthAmount(cleaner, 2026, 5) - 45 * 26 / 12) < 1e-9);

  const stream = by('Streaming bundle');           // price-only change on the 1st; still paid on the 4th
  assert.equal(C.nextDue(stream, '2026-06-02'), '2026-06-04');
  assert.equal(C.priceOn(stream, '2026-06-04'), 17.99);

  const once = by('Concert tickets');
  assert.equal(C.monthAmount(once, 2026, 6), 120);
});

test('older data gets safe defaults for payments, share, notice, manual, variable', () => {
  const { entries } = migrateBackup(load('v1-2026-11-initial-release.json'));
  for (const e of entries) {
    assert.deepEqual(e.payments, []);
    assert.equal(e.share, 100);
    assert.equal(e.noticeDays, null);
    assert.equal(e.manual, false);
    assert.equal(e.variable, false);
  }
});

test('logged payments replace the plan for the days they cover', () => {
  const { entries } = migrateBackup(load('v2-2026-11-payments-share-notice.json'));
  const gas = entries.find(e => e.name === 'Gas');
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
  // Feb 2025 sits inside the first bill (15 Jan → 15 Apr, 90 days, £330)
  near(C.monthAmount(gas, 2025, 1), 330 * 28 / 90);
  // May 2025 sits inside the second bill (15 Apr → 15 Jul, 91 days, £210)
  near(C.monthAmount(gas, 2025, 4), 210 * 31 / 91);
  // Oct 2025: 1–15 Oct covered by the £180 bill (92 days); 16–31 Oct uses the estimate
  const estimate = (330 + 210 + 180) / 3;            // average of the last three
  near(C.estimateOn(gas, '2025-10-31'), estimate);
  near(C.monthAmount(gas, 2025, 9), 180 * 15 / 92 + (estimate / 3) * (16 / 31));
  // Future months use the estimate
  near(C.monthAmount(gas, 2026, 5), estimate / 3);
  // Every logged pound is counted somewhere across the months the bills cover
  let sum = 0;
  for (let m = 0; m < 10; m++) sum += C.monthAmount(gas, 2025, m);
  assert.ok(sum > 330 + 210 + 180 - 1, 'logged amounts are all counted');
});

test('a credit (negative payment) reduces the month', () => {
  const { entries } = migrateBackup(load('v2-2026-11-payments-share-notice.json'));
  const el = entries.find(e => e.name === 'Electricity');
  // the -40 credit covers 21 Feb → 20 Mar
  assert.ok(C.monthAmount(el, 2026, 2) < 30, 'March is mostly the credit');
});

test('your share applies to every total', () => {
  const { entries } = migrateBackup(load('v2-2026-11-payments-share-notice.json'));
  const rent = entries.find(e => e.name === 'Rent');
  assert.equal(C.monthAmount(rent, 2026, 0), 600);
  assert.equal(C.monthlyEquivalent(rent, '2026-01-01'), 600);
  assert.equal(C.priceOn(rent, '2026-01-01'), 1200); // the stored bill stays the full amount
});

test('manual payments: paid / overdue / to pay', () => {
  const { entries } = migrateBackup(load('v2-2026-11-payments-share-notice.json'));
  const wc = entries.find(e => e.name === 'Window cleaner');
  assert.equal(C.isPaid(wc, '2026-07-03'), true);   // marked for that due date
  assert.equal(C.isPaid(wc, '2026-09-03'), true);   // paid two days late, no due date recorded
  assert.equal(C.isPaid(wc, '2026-10-03'), false);
  const list = C.toPay(entries, '2026-11-10');
  assert.deepEqual(list.map(x => [x.e.name, x.due, x.overdue]), [['Window cleaner', '2026-11-03', true]]);
  assert.deepEqual(C.toPay(entries, '2026-11-25').map(x => x.due), ['2026-11-03', '2026-12-03']);
});

test('notice period moves the deadline earlier', () => {
  const { entries } = migrateBackup(load('v2-2026-11-payments-share-notice.json'));
  assert.equal(C.noticeBy(entries.find(e => e.name === 'Phone contract')), '2026-11-15');
  assert.equal(C.noticeBy(entries.find(e => e.name === 'Rent')), null);
});

test('no set schedule: spending is what was logged each month, with no due dates', () => {
  const { entries } = migrateBackup(load('v4-2026-11-no-set-schedule.json'));
  const topups = entries.find(e => e.name === 'Prepaid mobile top-ups');
  assert.equal(C.nextDue(topups, '2026-11-21'), null);
  assert.deepEqual(C.occurrences(topups, '2026-06-01', '2026-12-31'), []);
  // average of the last three complete months since logging began: Aug 50, Sep 0, Oct 40
  assert.equal(C.estimateOn(topups, '2026-11-21'), 30);
  assert.equal(C.monthAmount(topups, 2026, 7), 50);   // Aug: two top-ups, not spread over a period
  assert.equal(C.monthAmount(topups, 2026, 8), 0);    // Sep: nothing logged
  assert.equal(C.monthAmount(topups, 2026, 9), 40);
  assert.equal(C.monthAmount(topups, 2026, 6), 30);   // Jul: before logging began → the typed estimate
  assert.equal(C.monthlyEquivalent(topups, '2026-11-21'), 30);
  // A fixed monthly allowance that became "whenever": due dates stop at the change
  const fuel = entries.find(e => e.name === 'Fuel');
  assert.equal(C.monthAmount(fuel, 2026, 6), 200);
  assert.equal(C.nextDue(fuel, '2026-08-15'), null);
  assert.equal(C.occurrences(fuel, '2026-07-01', '2026-12-31').join(), '2026-07-01,2026-08-01');
  // Matching: no dates or per-payment amount to compare, so the full name is enough
  const t = { date: '2026-11-03', amount: -61.2, description: 'FUEL STOP PENRITH' };
  assert.equal(B.matchDetail(t, fuel).ok, true);
  assert.equal(B.matchDetail({ ...t, description: 'PREPAID GIFT CARD' }, topups).ok, false, 'part of the name is not enough');
  assert.equal(B.nearestDue(fuel, '2026-11-03'), null);
  // A blank amount is fine with no set schedule; payday ignores incomes with no schedule
  assert.ok(normalizeEntry({ id: 'x', type: 'income', name: 'Tips', frequency: 'irregular', startDate: '2026-01-01',
    prices: [{ from: '2026-01-01', amount: null, frequency: 'irregular' }] }));
});

test('varying bills: estimate comes from payments; amounts can be blank', () => {
  const { entries } = migrateBackup(load('v3-2026-11-varying-no-amount.json'));
  const by = n => entries.find(e => e.name === n);
  assert.equal(by('Electricity').prices[0].amount, null);           // blank amount kept as blank
  assert.equal(C.estimateOn(by('Electricity'), '2026-11-21'), 90);    // average of 80, 100, 90
  // switched quarterly → monthly with no amount: last three quarterly bills (avg 300) ≈ 100/month
  assert.equal(C.estimateOn(by('Water'), '2026-02-01'), 100);
  assert.equal(C.estimateOn(by('Water'), '2024-12-01'), 0);           // before anything was logged
  assert.equal(C.estimateOn(by('Gas (just added)'), '2026-11-21'), 0); // nothing yet → shown as "Varies"
  assert.equal(C.monthAmount(by('Gas (just added)'), 2026, 11), 0);
  assert.equal(C.estimateOn(by('Phone usage'), '2026-11-21'), 45);    // typed estimate used until payments exist
});

test('a blank amount is only allowed on varying bills', () => {
  const base = { id: 'x', name: 'X', frequency: 'monthly', startDate: '2026-01-01', prices: [{ from: '2026-01-01', amount: null }] };
  assert.equal(normalizeEntry(base), null);                                // fixed bill with no amount → unusable
  assert.equal(normalizeEntry({ ...base, variable: true }).prices[0].amount, null);
});

test('older app data is not affected by blank-amount support', () => {
  for (const f of fixtures.filter(f => /^v[12]-/.test(f))) { // formats from before blank amounts existed
    for (const e of migrateBackup(load(f)).entries) assert.ok(e.prices.every(p => typeof p.amount === 'number'));
  }
});

test('one-off entries always use "once" for every period', () => {
  const e = normalizeEntry({ id: 'o', name: 'Gift', frequency: 'once', startDate: '2026-01-01',
    prices: [{ from: '2026-01-01', amount: 5, frequency: 'monthly' }, { from: '2026-02-01', amount: 6 }] });
  assert.ok(e.prices.every(p => p.frequency === 'once'));
  assert.equal(e.frequency, 'once');
});

test('invalid period frequency inherits the previous one', () => {
  const e = normalizeEntry({ id: 'i', name: 'X', frequency: 'monthly', startDate: '2026-01-01',
    prices: [{ from: '2026-01-01', amount: 5, frequency: 'yearly' }, { from: '2026-05-01', amount: 6, frequency: 'bogus' }] });
  assert.deepEqual(e.prices.map(p => p.frequency), ['yearly', 'yearly']);
  assert.equal(e.frequency, 'yearly');
});

// ---------- Robustness ----------

test('rejects files that are not backups', () => {
  assert.throws(() => migrateBackup({ hello: 'world' }), /doesn’t look like a Budget backup/);
  assert.throws(() => migrateBackup(null));
});

test('a backup from a newer app version gives a clear message instead of corrupting data', () => {
  assert.throws(() => migrateBackup({ app: 'budget-pwa', version: SCHEMA_VERSION + 1, entries: [] }), /newer version/);
});

test('missing version is treated as format 1', () => {
  const { entries } = migrateBackup({ app: 'budget-pwa', entries: [load(fixtures[0]).entries[0]] });
  assert.equal(entries.length, 1);
});

test('damaged entries are skipped, not fatal; recoverable ones are repaired', () => {
  const good = load(fixtures[0]).entries[0];
  const { entries, skipped } = migrateBackup({
    app: 'budget-pwa', version: 1, entries: [
      good,
      { id: 'x', name: 'No price', frequency: 'monthly', startDate: '2025-01-01', prices: [] },
      { id: 'y', name: '', frequency: 'monthly', startDate: '2025-01-01', prices: [{ from: '2025-01-01', amount: 1 }] },
      'not even an object',
      { id: 7, name: ' Typed amount ', frequency: 'monthly', startDate: '2025-01-01', prices: [{ from: '2025-01-01', amount: '9.99' }] },
    ],
  });
  assert.equal(skipped, 3);
  const fixed = entries.find(e => e.id === '7');
  assert.equal(fixed.name, 'Typed amount');
  assert.equal(fixed.prices[0].amount, 9.99);
  assert.equal(fixed.type, 'expense');
  assert.equal(fixed.contractEnd, null);
});

test('tags are tidied: lowercase, hyphenated, de-duplicated', () => {
  assert.deepEqual(normalizeTags(['Tax Deductible', '#Work', 'work', '  cloud   storage ', 'a__b', '', null, '#']),
    ['tax-deductible', 'work', 'cloud-storage', 'a-b']);
  assert.equal(cleanTag('--Shared--'), 'shared');
});

test('category / method labels: whitespace tidied, nothing else lost', () => {
  const e = normalizeEntry({ id: 'l', name: 'X', frequency: 'monthly', startDate: '2026-01-01',
    category: '  Phone   &  Internet ', method: 'Credit card – Amex', prices: [{ from: '2026-01-01', amount: 1 }] });
  assert.equal(e.category, 'Phone & Internet');
  assert.equal(e.method, 'Credit card – Amex');
});

test('fields from a future version are preserved, not dropped', () => {
  const e = normalizeEntry({ ...load(fixtures[0]).entries[0], futureField: { a: 1 } });
  assert.deepEqual(e.futureField, { a: 1 });
});

test('normalising twice changes nothing', () => {
  for (const f of fixtures) for (const raw of load(f).entries) {
    const once = normalizeEntry(raw);
    assert.deepEqual(normalizeEntry(once), once);
  }
});

// ---------- Reports: biggest changes, yearly, budgets, payday, CSV ----------

const reportData = () => migrateBackup(load('v2-2026-11-budgets.json'));

test('budgets survive a backup round trip', () => {
  const { settings } = reportData();
  assert.deepEqual(settings.budgets.map(b => [b.kind, b.label, b.amount]),
    [['category', 'Subscriptions', 30], ['tag', 'streaming', 20]]);
});

test('biggest changes over a year: rises, new, ended', () => {
  const { entries } = reportData();
  const rows = R.biggestChanges(entries, '2025-11-21', '2026-11-21', 10);
  assert.deepEqual(rows.map(r => [r.e.name, r.kind]), [
    ['Salary', 'up'], ['Cleaner, "weekly"', 'new'], ['Gym', 'ended'], ['Disney+', 'new'], ['Netflix', 'up']]);
  assert.equal(Math.round(rows[0].diff), 200);
  assert.ok(!rows.some(r => r.e.name === 'Rent'), 'unchanged bills are left out');
});

test('yearly totals at today’s rates (your share, no one-offs)', () => {
  const { entries } = reportData();
  const t = R.annualTotals(entries, '2026-11-21');
  assert.equal(Math.round(t.income), 32400);
  assert.equal(Math.round(t.expense * 100) / 100, 155.88 + 89.9 + 8400 + 1300);
});

test('budgets: spent, over and newly over', () => {
  const { entries, settings } = reportData();
  const [subs, streaming] = settings.budgets;
  const s = R.budgetStatus(entries, subs, 2026, 10);
  assert.ok(Math.abs(s.spent - (12.99 + 89.9 / 12)) < 1e-9);
  assert.equal(s.over, false);
  assert.equal(R.budgetStatus(entries, streaming, 2026, 10).over, true);
  const withoutDisney = entries.filter(e => e.name !== 'Disney+');
  assert.deepEqual(R.newlyOver(withoutDisney, entries, settings.budgets, 2026, 10).map(x => x.budget.label), ['streaming']);
});

test('until payday: next pay date, overdue manual payments included', () => {
  const { entries } = reportData();
  const pd = R.untilPayday(entries, '2026-11-21');
  assert.equal(pd.main.name, 'Salary');
  assert.equal(pd.payday, '2026-11-25');
  assert.equal(pd.days, 4);
  assert.deepEqual(pd.items.map(i => [i.e.name, i.due, i.overdue]),
    ['2026-10-23', '2026-10-30', '2026-11-06', '2026-11-20'].map(d => ['Cleaner, "weekly"', d, true]));
  assert.equal(pd.out, 100);
});

test('CSV: quoting, formula guard, numbers, BOM', () => {
  assert.equal(R.csvCell('Cleaner, "weekly"'), '"Cleaner, ""weekly"""');
  assert.equal(R.csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(R.csvCell(-12.345), '-12.35');
  assert.equal(R.csvCell(null), '');
  assert.equal(R.csvCell(true), 'Yes');
  const { entries } = reportData();
  const rows = R.entriesRows(entries, '2026-11-21');
  assert.ok(rows.every(r => r.length === rows[0].length), 'every row has every column');
  const csv = R.toCSV(rows);
  assert.ok(csv.startsWith('﻿Name,Type,'));
  assert.ok(csv.includes("'=SUM(A1) should stay text"));
  assert.equal(R.paymentsRows(entries).length, 2);
  assert.equal(R.monthlyRows(entries, 2026, 0, 12).length, 13);
});

// ---------- Bank statement import ----------

const bankFile = name => readFileSync(join(fixtureDir, 'bank', name), 'utf8');

test('CSV parser: quotes, commas inside quotes, CRLF, BOM, blank lines', () => {
  assert.deepEqual(B.parseCSV('﻿a,"b, c","d ""e"""\r\n\r\n1,2,3\n'), [['a', 'b, c', 'd "e"'], ['1', '2', '3']]);
});

test('CommBank credit card file: detected, DD/MM dates, signed amounts', () => {
  const rows = B.parseCSV(bankFile('commbank-credit-card.csv'));
  const fmt = B.detectFormat(rows);
  assert.equal(fmt.bank, 'CommBank');
  assert.equal(fmt.kind, 'card');
  assert.equal(B.detectDateOrder(rows.map(r => r[fmt.date])), 'DMY');
  const txns = B.toTransactions(rows, fmt, 'DMY');
  assert.equal(txns.length, 14);
  assert.deepEqual(txns[0], { date: '2026-11-20', amount: 250, description: 'PAYMENT RECEIVED, THANK YOU', merchant: null, balance: null });
  assert.equal(txns[5].amount, -12.99);
});

test('CommBank savings file: balance column recognised', () => {
  const rows = B.parseCSV(bankFile('commbank-savings.csv'));
  const fmt = B.detectFormat(rows);
  assert.equal(fmt.kind, 'bank');
  assert.equal(B.toTransactions(rows, fmt, 'DMY')[0].balance, 3798.4);
});

test('date order: detected when possible, null when the file can’t tell', () => {
  assert.equal(B.detectDateOrder(['13/01/2026', '01/02/2026']), 'DMY');
  assert.equal(B.detectDateOrder(['01/13/2026']), 'MDY');
  assert.equal(B.detectDateOrder(['2026-01-02']), 'YMD');
  const rows = B.parseCSV(bankFile('ambiguous-dates.csv'));
  assert.equal(B.detectDateOrder(rows.map(r => r[0])), null);
  assert.equal(B.parseDate('03/11/2026', 'DMY'), '2026-11-03');
  assert.equal(B.parseDate('03/11/2026', 'MDY'), '2026-03-11');
  assert.equal(B.parseDate('31/02/2026', 'DMY'), null); // not a real date
});

test('files with a header row: Debit / Credit columns', () => {
  const rows = B.parseCSV('Date,Description,Debit,Credit,Balance\n2026-11-03,COFFEE,4.50,,100\n2026-11-04,PAY,,500,600\n');
  const fmt = B.detectFormat(rows);
  assert.deepEqual(B.toTransactions(rows, fmt, 'YMD').map(t => t.amount), [-4.5, 500]);
});

test('header row: "Value Date" is never the amount; preferred column names win', () => {
  const rows = B.parseCSV(bankFile('value-date-debit-credit.csv'));
  const fmt = B.detectFormat(rows);
  assert.equal(fmt.date, 1, 'Transaction Date, not the earlier Value Date');
  assert.equal(fmt.amount, -1, 'no Amount column: use Debit / Credit');
  assert.equal(fmt.desc, 3, 'Description, not the earlier Details');
  const txns = B.toTransactions(rows, fmt, 'DMY');
  assert.deepEqual(txns.map(t => [t.date, t.amount, t.description]), [
    ['2026-11-01', -17.99, 'NETFLIX.COM MELBOURNE'],
    ['2026-11-04', 2500, 'SALARY ACME PTY LTD'],
    ['2026-11-15', -115, 'ORIGIN ENERGY'],
  ]);
  assert.equal(txns[0].balance, 1482.01);
  // "Debit Amount" / "Credit Amount" are debit and credit columns, not the amount
  const w = B.detectFormat(B.parseCSV('Bank Account,Date,Narrative,Debit Amount,Credit Amount,Balance\n1,03/11/2026,COFFEE,4.50,,100\n'));
  assert.deepEqual([w.amount, w.debit, w.credit, w.desc], [-1, 3, 4, 2]);
});

test('CR / DR amounts: DR is money out, CR money in, with or without a space', () => {
  assert.equal(B.parseMoney('123.45 DR'), -123.45);
  assert.equal(B.parseMoney('123.45DR'), -123.45);
  assert.equal(B.parseMoney('$1,234.50 cr'), 1234.5);
  assert.equal(B.parseMoney('DR 5.00'), -5);
  assert.ok(Number.isNaN(B.parseMoney('CR')));
  assert.ok(Number.isNaN(B.parseMoney('02/11/2026')), 'a date is not an amount');
  const rows = B.parseCSV(bankFile('cr-dr-amounts.csv'));
  const fmt = B.detectFormat(rows);
  assert.ok(fmt, 'a headerless CR/DR file is recognised');
  assert.deepEqual([fmt.date, fmt.amount, fmt.desc, fmt.balance], [0, 1, 2, 3]);
  const txns = B.toTransactions(rows, fmt, 'DMY');
  assert.deepEqual(txns.map(t => t.amount), [-115, 2500, -17.99]);
  assert.equal(txns[0].balance, 3867.01);
});

test('transfers: card payments and savings transfers recognised by their text, not rent', () => {
  assert.ok(B.looksLikeTransfer('PAYMENT RECEIVED, THANK YOU'));
  assert.ok(B.looksLikeTransfer('PAYMENT - THANK YOU'));
  assert.ok(B.looksLikeTransfer('Transfer to xx5555 NetBank Savings'));
  assert.ok(B.looksLikeTransfer('TFR FROM CREDIT CARD 1234'));
  assert.ok(!B.looksLikeTransfer('Transfer to xx9876 CommBank app Rent November'), 'paying someone else');
  assert.ok(!B.looksLikeTransfer('Salary ACME PTY LTD'));
});

test('transfers: the other side is found in another account (same amount the other way, within 3 days)', () => {
  const txns = [
    { id: 'a', date: '2026-11-01', amount: -250, description: 'Transfer to xx1111', payee: 'X' },
    { id: 'b', date: '2026-11-01', amount: -250, description: 'Transfer to xx1111', payee: 'X' },
    { id: 'c', date: '2026-11-10', amount: -40, description: 'Transfer to xx2222', payee: 'Y' },
  ];
  const others = [
    { id: 'o1', account: 'card', date: '2026-11-03', amount: 250 },
    { id: 'o2', account: 'savings', date: '2026-11-01', amount: 250 }, // same account: not a transfer
    { id: 'o3', account: 'card', date: '2026-11-20', amount: 40 },     // too far apart
  ];
  const pairs = B.findTransfers(txns, others, 'Savings');
  assert.equal(pairs.size, 1, 'each side pairs once');
  assert.equal(pairs.get('a').id, 'o1');
  const s = B.suggestTransfers([...txns, { id: 'd', date: '2026-11-20', amount: 250, description: 'PAYMENT RECEIVED, THANK YOU', payee: 'P' },
    { id: 'e', date: '2026-11-20', amount: -9, description: 'PAYMENT RECEIVED', payee: 'Q', action: 'entry1' }], others, 'Savings');
  assert.deepEqual(s.map(t => [t.action || '', t.why || null]),
    [['transfer', 'transfer-pair'], ['', null], ['', null], ['transfer', 'transfer-text'], ['entry1', null]],
    'matches and remembered choices are left alone');
  // A payee remembered as a transfer
  const r = B.suggest([{ id: 'z', date: '2026-11-01', amount: -5, description: 'x', payee: 'MY SAVER' }], [], { 'MY SAVER': 'transfer' });
  assert.deepEqual([r[0].action, r[0].why], ['transfer', 'rule']);
});

test('refunds follow the payee’s purchases: in this file first, else earlier imports', () => {
  const txns = [
    { id: '1', date: '2026-11-01', amount: -60, payee: 'KMART', action: 'e-home' },
    { id: '2', date: '2026-11-05', amount: 20, payee: 'KMART', action: '' },
    { id: '3', date: '2026-11-06', amount: 15, payee: 'MYER', action: '' },
    { id: '4', date: '2026-11-07', amount: 2950, payee: 'SALARY', action: '' },
    { id: '5', date: '2026-11-08', amount: 5, payee: 'KMART', action: 'ignore' },
  ];
  const out = B.suggestRefunds(txns, new Map([['MYER', 'e-clothes'], ['KMART', 'e-other']]));
  assert.deepEqual(out.map(t => [t.action, t.why || null]),
    [['e-home', null], ['e-home', 'refund'], ['e-clothes', 'refund'], ['', null], ['ignore', null]]);
});

test('balance column: checks the amounts, either file order, and spots money out shown as "+"', () => {
  // CommBank: newest first, adds up as read
  const rows = B.parseCSV(bankFile('commbank-savings.csv'));
  const fmt = B.detectFormat(rows);
  const c = B.checkBalances(B.toTransactions(rows, fmt, 'DMY'));
  assert.deepEqual(c, { pairs: 4, normal: 4, flipped: 0, latest: { date: '2026-11-15', balance: 3798.4 } });
  assert.ok(B.balancesAgree(c.normal, c.pairs));
  // Oldest first, money out as "+": only adds up with the signs switched
  const r2 = B.parseCSV(bankFile('money-out-positive.csv'));
  const f2 = B.detectFormat(r2);
  const c2 = B.checkBalances(B.toTransactions(r2, f2, 'DMY'));
  assert.deepEqual([c2.normal, c2.flipped, c2.latest], [0, 2, { date: '2026-11-07', balance: 923.4 }]);
  assert.deepEqual(B.toTransactions(r2, { ...f2, flip: true }, 'DMY').map(t => t.amount), [-4.5, -82.1, 10]);
  // A row missing from the middle: most still add up; several missing: they don't
  const t = (date, amount, balance) => ({ date, amount, balance });
  const gap = [t('2026-11-06', -1, 90), t('2026-11-05', -1, 91), t('2026-11-04', -1, 92), t('2026-11-03', -1, 93), t('2026-11-02', -1, 94), t('2026-11-01', -5, 100)];
  const c3 = B.checkBalances(gap);
  assert.ok(B.balancesAgree(c3.normal, c3.pairs), '4 of 5 add up');
  const bad = B.checkBalances([t('2026-11-03', -1, 50), t('2026-11-02', -1, 70), t('2026-11-01', -1, 90)]);
  assert.ok(!B.balancesAgree(bad.normal, bad.pairs) && !B.balancesAgree(bad.flipped, bad.pairs));
  assert.equal(B.checkBalances(B.toTransactions(B.parseCSV(bankFile('commbank-credit-card.csv')), B.detectFormat(B.parseCSV(bankFile('commbank-credit-card.csv'))), 'DMY')), null, 'no balances');
});

test('balance column is optional: blanks are skipped, a mostly-blank column isn’t checked', () => {
  const t = (date, amount, balance = null) => ({ date, amount, balance });
  // Blank balances (e.g. pending rows) break the chain, but rows either side aren't compared across the gap
  const gappy = [t('2026-11-06', -1, 90), t('2026-11-05', -7), t('2026-11-04', -1, 98), t('2026-11-03', -1, 99), t('2026-11-02', -1, 100)];
  const c = B.checkBalances(gappy);
  assert.deepEqual([c.pairs, c.normal], [2, 2]);
  assert.ok(B.balancesAgree(c.normal, c.pairs));
  assert.deepEqual(c.latest, { date: '2026-11-06', balance: 90 });
  // Fewer than half the rows have a balance: not checked at all
  assert.equal(B.checkBalances([t('2026-11-03', -1, 50), t('2026-11-02', -1, 51), t('2026-11-01', -1), t('2026-10-31', -1), t('2026-10-30', -1)]), null);
  // No two neighbours both have one: nothing to compare
  assert.equal(B.checkBalances([t('2026-11-03', -1, 50), t('2026-11-02', -1), t('2026-11-01', -1, 52)]), null);
});

test('transfers: several files at once, each transaction paired using its own account', () => {
  const txns = [
    { id: 's1', account: 'Savings', date: '2026-11-19', amount: -250 },
    { id: 'c1', account: 'Card', date: '2026-11-20', amount: 250 },
    { id: 's2', account: 'Savings', date: '2026-11-19', amount: 40 },
  ];
  const others = txns.map(t => ({ ...t, kind: 'batch' }));
  const pairs = B.findTransfers(txns, others);
  assert.equal(pairs.get('s1').id, 'c1');
  assert.equal(pairs.get('c1').id, 's1');
  assert.ok(!pairs.has('s2'), 'nothing the other way in another account');
});

test('remembered lists drop the oldest transactions first, not the oldest decisions', () => {
  const list = [{ id: 'new', date: '2026-11-01' }, 'legacy', { id: 'old', date: '2020-01-01' }, { id: 'mid', date: '2024-05-05' }];
  assert.deepEqual(B.keepNewest(list, 2), [{ id: 'new', date: '2026-11-01' }, { id: 'mid', date: '2024-05-05' }]);
  assert.equal(B.keepNewest(list, 10), list);
});

test('payee keys ignore card numbers, dates, places', () => {
  assert.equal(B.payeeKey('NETFLIX.COM MELBOURNE AU AUS Card xx1234 Value Date: 02/11/2026'), 'NETFLIX COM MELBOURNE');
  assert.equal(B.payeeKey('Direct Debit 445566 ORIGIN ENERGY'), 'ORIGIN ENERGY');
  assert.equal(B.payeeName('DISNEY PLUS SYDNEY'), 'Disney Plus');
  assert.equal(B.payeeName('GOOGLE GOOGLE ONE'), 'Google One');
});

test('transaction ids are stable across overlapping statements, and distinguish identical rows', () => {
  const t = [{ date: '2026-11-01', amount: -5, description: 'COFFEE' }, { date: '2026-11-01', amount: -5, description: 'COFFEE' }];
  const a = B.withIds(t, 'CommBank card'), b = B.withIds(t, 'CommBank card');
  assert.deepEqual(a.map(x => x.id), b.map(x => x.id));
  assert.notEqual(a[0].id, a[1].id);
  assert.notEqual(B.withIds(t, 'Other account')[0].id, a[0].id);
});

test('matching: names, exact amounts on due dates, rules; nothing on amount alone', () => {
  const entries = migrateBackup(load('v1-2026-11-initial-release.json')).entries; // Netflix 10.99 on the 4th (cancelled Jun 2026), Rent, …
  const txns = B.withIds(B.toTransactions(B.parseCSV(bankFile('commbank-savings.csv')), B.detectFormat(B.parseCSV(bankFile('commbank-savings.csv'))), 'DMY'), 'Savings');
  const s = B.suggest(txns, entries);
  const by = d => s.find(t => t.description.includes(d));
  assert.equal(entries.find(e => e.id === by('Rent').action).name, 'Rent');
  assert.equal(entries.find(e => e.id === by('Salary').action).name, 'Salary');
  assert.equal(by('ORIGIN').action, '');                       // no entry called anything like it
  // a remembered rule wins
  const gym = entries.find(e => e.name === 'Gym');
  const ruled = B.suggest(txns, entries, { 'ORIGIN ENERGY': gym.id, 'NETBANK SAVINGS': 'ignore' });
  assert.equal(ruled.find(t => t.description.includes('ORIGIN')).action, gym.id);
  assert.equal(ruled.find(t => t.description.includes('NetBank')).action, 'ignore');
});

test('names match whole words: "Car insurance" is not matched by "Card xx1234"', () => {
  const car = normalizeEntry({ id: 'c', type: 'expense', name: 'Car insurance', frequency: 'monthly', startDate: '2026-01-18', prices: [{ from: '2026-01-18', amount: 56 }] });
  const spotify = { date: '2026-11-07', amount: -11.99, description: 'SPOTIFY P1A2B3C4 SYDNEY AU AUS Card xx1234' };
  assert.ok(B.matchScore(spotify, car) < 4);
  const aami = { date: '2026-11-18', amount: -56, description: 'AAMI INSURANCE MELBOURNE AU AUS Card xx1234' };
  assert.ok(B.matchScore(aami, car) >= 4);
});

test('recurring payments not yet added are spotted with their frequency', () => {
  const rows = B.parseCSV(bankFile('commbank-credit-card.csv'));
  const txns = B.withIds(B.toTransactions(rows, B.detectFormat(rows), 'DMY'), 'Card');
  const rec = B.findRecurring(txns);
  const disney = rec.find(r => r.payee === 'DISNEY PLUS SYDNEY');
  assert.equal(disney.frequency, 'monthly');
  assert.equal(disney.txns.length, 3);
  assert.equal(disney.amount, 13.99);
  assert.equal(disney.variable, false);
  assert.equal(rec.find(r => r.payee.startsWith('GOOGLE')).frequency, 'monthly');
  assert.ok(!rec.some(r => r.payee.startsWith('KMART')), 'one-offs are not recurring');
});

test('card lines: the padded merchant column is the payee, whatever town follows it', () => {
  assert.equal(B.merchantPart('NETLOOP LIMITED          1800000000  AUS'), 'NETLOOP LIMITED');
  assert.equal(B.merchantPart('Direct Debit 445566 ORIGIN ENERGY'), null); // single-spaced lines are left alone
  const rows = B.parseCSV(bankFile('commbank-credit-card-padded.csv'));
  const txns = B.withIds(B.toTransactions(rows, B.detectFormat(rows), 'DMY'), 'Card');
  // same description text as before the change, so transaction ids don't move
  assert.equal(txns[1].description, 'NETLOOP LIMITED 1800000000 AUS');
  assert.equal(new Set(txns.filter(t => /netloop/i.test(t.description)).map(t => t.payee)).size, 1);
  assert.equal(new Set(txns.filter(t => t.description.startsWith('GROCER')).map(t => t.payee)).size, 1);
  const rec = B.findRecurring(txns);
  const loop = rec.filter(r => r.payee.startsWith('NETLOOP'));
  assert.equal(loop.length, 1, 'one recurring group, not one per town');
  assert.equal(loop[0].txns.length, 4);
  assert.equal(loop[0].frequency, 'monthly');
  assert.equal(loop[0].name, 'Netloop');
  // a choice remembered under the old key (with the town) still applies
  const ruled = B.suggest(txns, [], { [B.payeeKey('Netloop Limited BRISBANE AUS')]: 'ignore' });
  assert.equal(ruled.filter(t => t.action === 'ignore').length, 2);
});

test('import memory (rules, ignored, accounts) survives a backup round trip', () => {
  const { settings } = migrateBackup({ app: 'budget-pwa', version: 3, entries: [],
    settings: { payeeRules: { 'ORIGIN ENERGY': 'abc', bad: 5 }, ignoredTxns: ['t1', 't1', 7, { id: 't2', date: '2026-11-01' }, { id: 't3', date: 'x' }, { id: 't2' }], bankAccounts: [' CommBank  card '],
      transfers: [{ id: 'x1', account: 'CommBank Card', date: '2026-11-01', amount: 250 }, { id: 'x1', account: 'a', date: '2026-11-01', amount: 1 }, { id: 'x2', date: 'bad' }] } });
  assert.deepEqual(settings.payeeRules, { 'ORIGIN ENERGY': 'abc' });
  assert.deepEqual(settings.ignoredTxns, ['t1', { id: 't2', date: '2026-11-01' }, 't3'], 'ids, or { id, date } (newer)');
  assert.deepEqual(settings.bankAccounts, ['CommBank card']);
  assert.deepEqual(settings.transfers, [{ id: 'x1', account: 'commbank card', date: '2026-11-01', amount: 250 }]);
});

test('card purchases near a bill\'s price are not matched to it on amount alone', () => {
  // A $15 phone plan due on the 13th of each month
  const phone = normalizeEntry({ id: 'm', type: 'expense', name: 'Woolworths Mobile - Blake', frequency: 'monthly',
    startDate: '2026-01-13', prices: [{ from: '2026-01-13', amount: 15 }] });
  const t = (date, amount, description) => ({ date, amount, description });
  const best = x => B.suggest([x], [phone])[0];
  assert.equal(best(t('2026-11-13', -14.95, 'PRICELINE ST CLAIR ST CLAIR')).action, '', 'within 1% is not the same amount');
  assert.equal(best(t('2026-11-01', -15, 'PRICELINE ST CLAIR ST CLAIR')).action, '', 'right amount, 12 days from the due date');
  const exact = best(t('2026-11-14', -15, 'BPAY 98765'));
  assert.equal(exact.action, 'm', 'exact amount, a day after the due date');
  assert.equal(exact.byName, false);
  assert.deepEqual(exact.on, ['amount', 'date']);
  // Part of the name needs both the amount and the date
  const partly = best(t('2026-11-20', -15, 'WOOLWORTHS MOBILE SYDNEY'));
  assert.equal(partly.action, 'm');
  assert.deepEqual(partly.on, ['name', 'amount', 'date']);
  assert.equal(partly.byName, false, 'part of the name is not remembered on its own');
  assert.equal(best(t('2026-11-13', -82.10, 'WOOLWORTHS 1143 MT DRUITT')).action, '', 'a grocery shop on the due date');
  assert.equal(best(t('2026-11-25', -15.60, 'WOOLWORTHS MOBILE SYDNEY')).action, '', 'partial name, close amount, 12 days out');
  // The full name needs the amount or the date
  const full = best(t('2026-12-30', -19, 'WOOLWORTHS MOBILE BLAKE'));
  assert.equal(full.action, '', 'full name but $19 vs $15 and 17 days out');
  const full2 = best(t('2026-11-13', -19, 'WOOLWORTHS MOBILE BLAKE'));
  assert.equal(full2.action, 'm', 'full name on the due date, even after a price rise');
  assert.equal(full2.byName, true);
});

test('match detail: each signal graded separately', () => {
  const water = normalizeEntry({ id: 'w', type: 'expense', name: 'Water', frequency: 'quarterly', variable: true,
    startDate: '2026-02-10', prices: [{ from: '2026-02-10', amount: 100 }] });
  const d = B.matchDetail({ date: '2026-11-16', amount: -112, description: 'SYDNEY WATER' }, water);
  assert.deepEqual([d.name, d.amount, d.date, d.ok], ['full', 'close', 'near', true]); // varying bill: 12% is close; 6 days out
  assert.equal(B.matchDetail({ date: '2026-11-16', amount: 112, description: 'SYDNEY WATER' }, water).ok, false, 'money in vs an expense');
  assert.equal(B.matchDetail({ date: '2025-11-10', amount: -100, description: 'SYDNEY WATER' }, water).ok, false, 'before the entry started');
});

test('your own payee names: shown, used for matching and for new entries, kept in backups', () => {
  const internet = normalizeEntry({ id: 'i', type: 'expense', name: 'Home internet', frequency: 'monthly',
    startDate: '2026-01-09', prices: [{ from: '2026-01-09', amount: 104 }] });
  const raw = [
    { date: '2026-10-09', amount: -105.04, description: '123456 Aus' },
    { date: '2026-11-09', amount: -105.04, description: '123456 Aus' },
  ];
  const txns = B.withIds(raw, 'Card');
  assert.equal(B.suggest(txns, [internet])[1].action, '', 'the bank text alone matches nothing');
  const names = { [txns[0].payee]: 'Home internet' };
  const named = B.suggest(txns, [internet], {}, names);
  assert.equal(named[1].name, 'Home internet');
  assert.equal(named[1].action, 'i', 'your name matches the entry');
  assert.equal(B.findRecurring(B.suggest(txns, [], {}, names))[0].name, 'Home internet');
  const { settings } = migrateBackup({ app: 'budget-pwa', version: 3, entries: [],
    settings: { payeeNames: { '123456 AUS': '  Home   internet ', bad: 5, empty: ' ' } } });
  assert.deepEqual(settings.payeeNames, { '123456 AUS': 'Home internet' });
});

test('renamed import accounts survive a backup round trip', () => {
  const { settings } = migrateBackup({ app: 'budget-pwa', version: 3, entries: [],
    settings: { bankAccounts: ['CommBank credit card'], accountNames: { 'CommBank Credit Card': ' Everyday  card ', x: '' } } });
  assert.deepEqual(settings.accountNames, { 'commbank credit card': 'Everyday card' });
});

test('a payment logged by hand is updated by the bank copy, not duplicated', () => {
  const e = normalizeEntry({ id: 'w', type: 'expense', name: 'Window cleaner', frequency: 'monthly', manual: true,
    startDate: '2026-01-05', prices: [{ from: '2026-01-05', amount: 20 }],
    payments: [
      { id: 'p1', date: '2026-11-07', amount: 20, due: '2026-11-05' },          // Mark paid, 2 days after the bank
      { id: 'p2', date: '2026-10-05', amount: 20, source: 'tOld' },             // already from an import
      { id: 'p3', date: '2026-09-05', amount: 25 },                             // different amount
    ] });
  const txns = [
    { id: 'a', date: '2026-11-05', amount: -20 },
    { id: 'b', date: '2026-11-06', amount: -20 },   // a second transfer: p1 is already taken by the nearer one
    { id: 'c', date: '2026-10-05', amount: -20 },   // only an imported payment nearby
    { id: 'd', date: '2026-09-05', amount: -20 },   // amount doesn't match
    { id: 'e', date: '2026-08-01', amount: -20 },   // nothing nearby
  ];
  const decisions = new Map(txns.map(t => [t.id, 'w']));
  const links = B.planLinks(txns, decisions, new Map([['w', e]]));
  assert.deepEqual([...links].map(([t, p]) => [t, p.id]), [['b', 'p1']]); // 1 day beats 2 days
  assert.equal(B.planLinks(txns, new Map([['a', 'w']]), new Map([['w', e]])).get('a').id, 'p1');
  assert.equal(B.planLinks(txns, new Map([['a', 'ignore']]), new Map([['w', e]])).size, 0);
  // within 1%: typed 105 for a 105.04 bill
  const f = { ...e, payments: [{ id: 'q', date: '2026-11-09', amount: 105 }] };
  assert.equal(B.planLinks([{ id: 'z', date: '2026-11-09', amount: -105.04 }], new Map([['z', 'w']]), new Map([['w', f]])).size, 1);
  assert.equal(B.planLinks([{ id: 'z', date: '2026-11-15', amount: -105.04 }], new Map([['z', 'w']]), new Map([['w', f]])).size, 0);
});

// ---------- Offline cache ----------

test('every app file is in the service worker cache list', () => {
  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  for (const f of readdirSync(join(root, 'js'))) {
    assert.ok(sw.includes(`'./js/${f}'`), `add './js/${f}' to ASSETS in sw.js or the app breaks offline`);
  }
});

// ---------- Date & money maths ----------

test('price history', () => {
  const e = { frequency: 'monthly', startDate: '2025-01-31', prices: [{ from: '2025-01-31', amount: 10 }, { from: '2025-06-01', amount: 12 }] };
  assert.equal(C.priceOn(e, '2025-05-31'), 10);
  assert.equal(C.priceOn(e, '2025-06-01'), 12);
});

test('next payment dates', () => {
  const monthly = { frequency: 'monthly', startDate: '2025-01-31', prices: [{ from: '2025-01-31', amount: 1 }] };
  assert.equal(C.nextDue(monthly, '2025-02-01'), '2025-02-28'); // clamps to month end
  assert.equal(C.nextDue(monthly, '2025-03-31'), '2025-03-31');
  const fortnightly = { frequency: 'fortnightly', startDate: '2025-01-01', prices: [{ from: '2025-01-01', amount: 1 }] };
  assert.equal(C.nextDue(fortnightly, '2025-01-02'), '2025-01-15');
  const yearly = { frequency: 'yearly', startDate: '2024-03-10', prices: [{ from: '2024-03-10', amount: 120 }] };
  assert.equal(C.nextDue(yearly, '2025-03-11'), '2026-03-10');
  assert.equal(C.nextDue({ ...yearly, endDate: '2026-01-01' }, '2025-03-11'), null);
});

test('monthly amounts', () => {
  const yearly = { frequency: 'yearly', startDate: '2024-03-10', prices: [{ from: '2024-03-10', amount: 120 }] };
  assert.equal(C.monthAmount(yearly, 2025, 4), 10);
  const ended = { frequency: 'monthly', startDate: '2025-01-01', endDate: '2025-08-15', prices: [{ from: '2025-01-01', amount: 12 }] };
  assert.equal(C.monthAmount(ended, 2025, 7), 12);
  assert.equal(C.monthAmount(ended, 2025, 8), 0);
  const once = { frequency: 'once', startDate: '2025-04-10', prices: [{ from: '2025-04-10', amount: 50 }] };
  assert.equal(C.monthAmount(once, 2025, 3), 50);
  assert.equal(C.monthAmount(once, 2025, 4), 0);
});

test('parsing typed amounts', () => {
  assert.equal(C.parseAmount('£1,234.50'), 1234.5);
  assert.equal(C.parseAmount('12,5'), 12.5);
  assert.ok(Number.isNaN(C.parseAmount('abc')));
});

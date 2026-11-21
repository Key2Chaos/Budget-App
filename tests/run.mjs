// Run with:  node tests/run.mjs     (no dependencies; Node 18+)
// Guards that old backups keep importing, and that the date/money maths stays correct.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../js/calc.js';
import * as R from '../js/reports.js';
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

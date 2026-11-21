// Run with:  node tests/run.mjs     (no dependencies; Node 18+)
// Guards that old backups keep importing, and that the date/money maths stays correct.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from '../js/calc.js';
import { SCHEMA_VERSION, migrateBackup, buildBackup, normalizeEntry } from '../js/schema.js';

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

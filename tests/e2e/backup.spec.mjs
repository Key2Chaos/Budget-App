// Backup export / import and spreadsheet export.
import { readFileSync } from 'node:fs';
import { test, expect, openWithSample, tab, row, fixturePath } from './helpers.mjs';
import { SCHEMA_VERSION } from '../../js/schema.js';

// On an iPhone these open the share sheet, which a test browser can't drive.
test.beforeEach(({ browserName }) => test.skip(browserName === 'webkit', 'iPhone uses the share sheet for exports'));

test('export backup downloads a valid, current-format file', async ({ page }) => {
  await openWithSample(page);
  await tab(page, 'settings');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action=export]').click()]);
  expect(dl.suggestedFilename()).toBe('budget-backup-2026-11-21.json');
  const data = JSON.parse(readFileSync(await dl.path(), 'utf8'));
  expect(data.app).toBe('budget-pwa');
  expect(data.version).toBe(SCHEMA_VERSION);
  expect(data.entries.length).toBeGreaterThan(10);
  expect(data.settings.budgets.length).toBe(3);
  await expect(page.locator('.fine.pad-x').first()).toContainText('Last backup: 21 Nov');
});

test('import an old (v1) backup: everything arrives and survives a reload', async ({ page }) => {
  await page.goto('/');
  await tab(page, 'settings');
  await page.locator('#importFile').setInputFiles(fixturePath('v1-2026-11-initial-release.json'));
  await expect.poll(() => page.dialogs.at(-1)).toContain('Import 9 groups?');
  await tab(page, 'entries');
  await expect(page.locator('.row[data-action=edit]')).toHaveCount(9);
  await page.reload();
  await tab(page, 'entries');
  await expect(page.locator('.row[data-action=edit]')).toHaveCount(9);
  await expect(row(page, 'Rent')).toContainText('£1,010.00');
});

test('import rejects a file that is not a backup', async ({ page }) => {
  await page.goto('/');
  await tab(page, 'settings');
  await page.locator('#importFile').setInputFiles({ name: 'nope.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
  await expect.poll(() => page.dialogs.at(-1)).toContain('doesn’t look like a Budget backup');
});

test('spreadsheet export: three CSV files with headers', async ({ page }) => {
  await openWithSample(page);
  await tab(page, 'settings');
  const downloads = [];
  page.on('download', d => downloads.push(d));
  await page.locator('[data-action=export-csv]').click();
  await expect.poll(() => downloads.length).toBe(3);
  const byName = Object.fromEntries(await Promise.all(downloads.map(async d =>
    [d.suggestedFilename(), readFileSync(await d.path(), 'utf8')])));
  expect(Object.keys(byName).sort()).toEqual([
    'budget-entries-2026-11-21.csv', 'budget-monthly-totals-2026-11-21.csv', 'budget-payments-2026-11-21.csv']);
  expect(byName['budget-entries-2026-11-21.csv']).toMatch(/^﻿Name,Type,Category/);
  expect(byName['budget-payments-2026-11-21.csv']).toMatch(/^﻿Date,Name,Type/);
  expect(byName['budget-monthly-totals-2026-11-21.csv']).toMatch(/^﻿Month,Income,Expenses,Net\r\n2024-12,/);
});

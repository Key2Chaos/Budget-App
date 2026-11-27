// Core screens, navigation, offline, start-up upgrade of old data, focus.
import { test, expect, openEmpty, openWithSample, tab, card, row, expectNoHorizontalScroll } from './helpers.mjs';
import { SCHEMA_VERSION } from '../../js/schema.js';
import { readFileSync } from 'node:fs';

test('empty state, then sample data fills every Overview card', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Track what comes in and goes out' })).toBeVisible();
  await page.getByRole('button', { name: 'Try it with sample data' }).click();
  for (const h of ['To pay', 'Budgets', 'Until payday', 'Over time', 'Biggest changes', 'Contracts', 'Next 14 days', 'Where it goes']) {
    await expect(card(page, h), h).toBeVisible();
  }
  await expect(page.locator('.summary .v').first()).toContainText('£');
});

test('every tab renders at phone width with no sideways scrolling', async ({ page }) => {
  await openWithSample(page);
  for (const t of ['overview', 'entries', 'settings']) {
    await tab(page, t);
    await expect(page.locator('#title')).toHaveText({ overview: 'Overview', entries: 'Payee groups', settings: 'Settings' }[t]);
    await expectNoHorizontalScroll(page);
  }
});

test('dark mode uses the dark theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openWithSample(page);
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(0, 0, 0)');
});

test('chart: tapping a month updates the readout', async ({ page }) => {
  await openWithSample(page);
  const before = await page.locator('#readout .ro-month').innerText();
  await page.locator('.chart-svg').scrollIntoViewIfNeeded();
  const box = await page.locator('.chart-svg').boundingBox();
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height / 2);
  await expect(page.locator('#readout .ro-month')).not.toHaveText(before);
});

test('tag filter narrows the Overview and can be cleared', async ({ page }) => {
  await openWithSample(page);
  await page.locator('.tagbar .chip[data-tag=shared]').first().click();
  await expect(page.getByText('Showing only payee groups tagged #shared')).toBeVisible();
  await expect(page.locator('.summary .net .k')).toHaveText('Net for these tags');
  await page.locator('[data-action=tags-clear]').first().click();
  await expect(page.locator('.summary .net .k')).toHaveText('Left over');
});

test('Settings shows the version the service worker is serving', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'Playwright’s WebKit doesn’t run service workers reliably');
  const version = readFileSync(new URL('../../sw.js', import.meta.url), 'utf8').match(/const VERSION = '([^']+)'/)[1];
  await openWithSample(page);
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15_000 });
  await tab(page, 'settings');
  await expect(page.locator('#appVersion')).toHaveText(version);
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.locator('.summary')).toBeVisible(); // reloaded, back on the Overview
});

test('works offline after the first visit', async ({ page, context, browserName }) => {
  test.skip(browserName === 'webkit', 'Playwright’s WebKit doesn’t run service workers offline reliably');
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 15_000 });
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Track what comes in and goes out' })).toBeVisible();
  await page.getByRole('button', { name: 'Try it with sample data' }).click();
  await expect(card(page, 'Over time')).toBeVisible();
});

test('data saved by an older app version is upgraded on start-up', async ({ page }) => {
  await openEmpty(page);
  // Write a v1-era entry straight into the database: no tags, no payments, no per-change frequency.
  await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('budget-pwa', 1);
    req.onsuccess = () => {
      const tx = req.result.transaction(['entries', 'settings'], 'readwrite');
      tx.objectStore('entries').put({
        id: 'old-1', type: 'expense', name: 'Old broadband', category: 'Phone & Internet', method: 'Direct debit',
        frequency: 'monthly', startDate: '2025-01-20', contractEnd: null, endsAtExpiry: false, endDate: null, notes: '',
        prices: [{ from: '2025-01-20', amount: 30 }], createdAt: '2025-01-20T00:00:00Z', updatedAt: '2025-01-20T00:00:00Z',
      });
      tx.objectStore('settings').put({ currency: 'GBP', lastBackup: null, schemaVersion: 1 }, 'settings');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  }));
  await page.reload();
  await tab(page, 'entries');
  await expect(row(page, 'Old broadband')).toContainText('£30.00');
  const stored = await page.evaluate(() => new Promise(resolve => {
    const req = indexedDB.open('budget-pwa', 1);
    req.onsuccess = () => {
      const tx = req.result.transaction(['entries', 'settings']);
      const out = {};
      tx.objectStore('entries').get('old-1').onsuccess = e => { out.entry = e.target.result; };
      tx.objectStore('settings').get('settings').onsuccess = e => { out.settings = e.target.result; };
      tx.oncomplete = () => resolve(out);
    };
  }));
  expect(stored.entry.prices[0].frequency).toBe('monthly');
  expect(stored.entry.tags).toEqual([]);
  expect(stored.entry.payments).toEqual([]);
  expect(stored.settings.schemaVersion).toBe(SCHEMA_VERSION);
});

test('sheets open with focus on the title, not a button (no stray focus box)', async ({ page }) => {
  await openWithSample(page);
  const focused = () => page.evaluate(() => document.activeElement.tagName + ':' + document.activeElement.textContent.trim());
  await tab(page, 'settings');
  await page.locator('[data-action=manage-labels]').click();
  await expect.poll(focused).toBe('H2:Manage labels');
  await page.locator('#manage [data-close]').click();
  await page.locator('[data-action=manage-budgets]').click();
  await expect.poll(focused).toBe('H2:Budgets');
  await page.locator('#budgets [data-close]').click();
  await tab(page, 'entries');
  await page.locator('.row[data-action=edit]').first().click();
  await expect.poll(focused).toBe('H2:Edit payee group');
});

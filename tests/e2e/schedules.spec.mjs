// What bank payments say about a group: it stopped, it's regular after all, it's a one-off
// project, or it's the same as another group. Made-up data.
import { test, expect, openEmpty, tab, row, card, editEntry, save, expectNoHorizontalScroll } from './helpers.mjs';

test.use({ locale: 'en-AU', timezoneId: 'Australia/Sydney' });

const group = (id, name, frequency, dates, extra = {}) => ({
  id, type: 'expense', name, category: '', method: 'Credit card', frequency, startDate: dates[0], contractEnd: null,
  endsAtExpiry: false, endDate: null, notes: '', tags: [], fromImport: true,
  prices: [{ from: dates[0], amount: frequency === 'irregular' ? null : 30, frequency }], variable: frequency === 'irregular',
  manual: false, share: 100, noticeDays: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  payments: dates.map((date, i) => ({ id: `${id}${i}`, date, amount: extra.amount ?? 30, due: null, note: '',
    source: `${id}-t${i}`, account: 'Card', payee: name.toUpperCase() })),
  ...extra,
});

async function seed(page) {
  await openEmpty(page);
  const groups = [
    group('gym', 'Gym', 'monthly', ['2026-03-05', '2026-04-05', '2026-05-05', '2026-06-05']),
    group('mag', 'Magazine', 'monthly', ['2026-04-09', '2026-05-09', '2026-06-09', '2026-07-09']),
    group('bupa', 'Bupa', 'irregular', ['2026-07-03', '2026-08-03', '2026-09-03', '2026-10-03', '2026-11-03'], { amount: 223.25 }),
    group('reno', 'Bathroom tiles', 'irregular', ['2026-09-02', '2026-09-20', '2026-10-11', '2026-11-15'], { amount: 400 }),
    group('sushi', 'Sushi', 'irregular', ['2026-10-01', '2026-10-20']),
    group('ryu', 'Sushi Ryu', 'irregular', ['2026-11-02']),
    group('wool', 'Woolworths', 'irregular', ['2026-11-01', '2026-11-08', '2026-11-15'], { amount: 120 }),
  ];
  await page.evaluate(gs => new Promise((resolve, reject) => {
    const req = indexedDB.open('budget-pwa', 1);
    req.onsuccess = () => {
      const tx = req.result.transaction(['entries', 'settings'], 'readwrite');
      for (const g of gs) tx.objectStore('entries').put(g);
      tx.objectStore('settings').put({ currency: 'AUD', schemaVersion: 5, lastBackup: '2026-11-20T00:00:00Z',
        accounts: [{ key: 'Card', name: 'Card', kind: 'credit' }], emptyGroupsSweep: 2 }, 'settings');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  }), groups);
  await page.reload();
  await expect(page.locator('.summary')).toBeVisible();
}

test('Overview: groups that stopped, and Variable groups paid on a schedule, are pointed out', async ({ page }) => {
  await seed(page);
  const checks = card(page, 'Check these groups');
  const item = name => checks.locator('.check-item', { has: page.locator('.row-title', { hasText: new RegExp(`^${name}$`) }) });
  await expect(item('Gym')).toContainText('Looks like it stopped · last paid 5 June, usually monthly');
  await expect(item('Magazine')).toContainText('Looks like it stopped');
  await expect(item('Bupa')).toContainText('Looks monthly · $223.25 each time');
  await expect(item('Woolworths')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await checks.screenshot({ path: 'test-results/check-card.png' });                 // weekly for only two weeks: too soon to say

  await item('Gym').getByRole('button', { name: 'End it' }).click();
  await expect(page.locator('#toast')).toContainText('Gym ended 5 June');
  await expect(item('Gym')).toHaveCount(0);
  await item('Magazine').getByRole('button', { name: 'Still going' }).click();
  await expect(item('Magazine')).toHaveCount(0);
  await item('Bupa').getByRole('button', { name: 'Set monthly' }).click();
  await expect(page.locator('#toast')).toContainText('Bupa set to monthly');
  await expect(checks).toHaveCount(0);

  await tab(page, 'entries');
  await expect(row(page, 'Bupa')).toContainText('Monthly');
  await editEntry(page, 'Gym');
  await expect(page.locator('#sheet [name=endDate]')).toHaveValue('2026-06-05');
});

test('a Variable group can be left out of the forecast, for projects and one-offs', async ({ page }) => {
  await seed(page);
  await editEntry(page, 'Bathroom tiles');
  const toggle = page.locator('#sheet [name=noForecast]');
  await expect(toggle).toBeVisible();
  await expect(page.locator('#sheet')).toContainText('Current estimate');
  await toggle.check();
  await save(page);
  await editEntry(page, 'Bathroom tiles');
  await expect(page.locator('#sheet [name=noForecast]')).toBeChecked();
  await expect(page.locator('#sheet')).toContainText('Not forecast: only the payments you log count.');
  await page.locator('#sheet [data-close]').first().click();
  // only for groups with no set schedule
  await editEntry(page, 'Gym');
  await expect(page.locator('#sheet [name=noForecast]')).toBeHidden();
});

test('Tidy up groups: merge look-alike groups in one tap, and fill in categories', async ({ page }) => {
  await seed(page);
  await tab(page, 'settings');
  await page.locator('[data-action=open-tidy]').click();
  const tidy = page.locator('#tidy');
  await expect(tidy).toContainText('Possible duplicates (1)');
  const dupe = tidy.locator('.tidy-dupe');
  await expect(dupe).toContainText('Sushi');
  await expect(dupe).toContainText('Sushi Ryu');
  await expect(dupe.locator('[data-keep] option:checked')).toHaveText('Sushi');
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: 'test-results/tidy.png' });   // the one with more payments
  await dupe.getByRole('button', { name: 'Merge both' }).click();
  await expect(page.locator('#toast')).toContainText('Merged into Sushi');
  await expect(tidy).toContainText('Possible duplicates (0)');

  const cat = name => tidy.locator('.tidy-cat', { has: page.locator('.row-title', { hasText: new RegExp(`^${name}$`) }) });
  await expect(cat('Woolworths')).toContainText('Groceries');
  await expect(cat('Sushi')).toContainText('Eating out');
  await expect(cat('Bupa')).toContainText('Insurance');
  await cat('Bupa').locator('input').uncheck();
  await tidy.getByRole('button', { name: 'Set these categories' }).click();
  await expect(page.locator('#toast')).toContainText('2 categories set');
  await expect(cat('Bupa')).toBeVisible();                                         // still to decide
  await expect(cat('Woolworths')).toHaveCount(0);

  await tidy.locator('[data-close]').click();
  await tab(page, 'entries');
  await expect(row(page, 'Sushi Ryu')).toHaveCount(0);
  await editEntry(page, 'Sushi');
  await expect(page.locator('#sheet [name=category]')).toHaveValue('Eating out');
});

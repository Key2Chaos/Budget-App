// An Australian iPhone: en-AU, Sydney time (UTC+11 in November), AUD.
import { readFileSync } from 'node:fs';
import { test, expect, openWithSample, tab, card } from './helpers.mjs';

test.use({ locale: 'en-AU', timezoneId: 'Australia/Sydney' });

// 1:30am on 22 Nov in Sydney is still 21 Nov in UTC — the classic off-by-one-day trap.
const SYDNEY_AFTER_MIDNIGHT = new Date('2026-11-21T14:30:00Z');

test('currency defaults to AUD and payment methods are Australian', async ({ page }) => {
  // Suggestions on a fresh app (before any data adds its own methods)
  await page.goto('/');
  await page.locator('#addBtn').click();
  const methods = await page.locator('#dl-method option').evaluateAll(os => os.map(o => o.value));
  expect(methods).toEqual(expect.arrayContaining(['BPAY', 'PayID', 'Direct debit']));
  expect(methods).not.toContain('Standing order');
  await page.locator('[data-close]').click();

  await page.getByRole('button', { name: 'Try it with sample data' }).click();
  await expect(page.locator('.summary .v').first()).toHaveText(/^\$[\d,]+\.\d\d$/);
  await tab(page, 'settings');
  await expect(page.locator('#currency')).toHaveValue('AUD');
  await tab(page, 'entries');
  await expect(page.locator('.row', { hasText: 'Standing order' })).toHaveCount(0); // sample data uses local methods too
});

test('just after midnight in Sydney, "today" is the Sydney date, not the UTC one', async ({ page, browserName }) => {
  await page.clock.setFixedTime(SYDNEY_AFTER_MIDNIGHT);
  await openWithSample(page);
  await expect(page.locator('.summary-head')).toHaveText('November 2026');
  // A new entry defaults its first payment to today (Sydney)
  await page.locator('#addBtn').click();
  await expect(page.locator('[name=startDate]')).toHaveValue('2026-11-22');
  await page.locator('[data-close]').click();
  // "To pay" counts days from the Sydney date: window cleaner was due 9 days before the sample's "today"
  await expect(card(page, 'To pay')).toContainText('9 days ago');

  test.skip(browserName === 'webkit', 'export uses the share sheet on iPhone');
  await tab(page, 'settings');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action=export]').click()]);
  expect(dl.suggestedFilename()).toBe('budget-backup-2026-11-22.json');
  JSON.parse(readFileSync(await dl.path(), 'utf8'));
  // The backup timestamp is UTC (21 Nov) but must show as the local date
  await expect(page.locator('.fine.pad-x').first()).toContainText('Last backup: 22 Nov');
});

// Importing a CommBank-style statement (made-up data), as an Australian user would.
import { fileURLToPath } from 'node:url';
import { test, expect, openWithSample, tab, row, editEntry } from './helpers.mjs';

test.use({ locale: 'en-AU', timezoneId: 'Australia/Sydney' });
const csv = name => fileURLToPath(new URL(`../fixtures/bank/${name}`, import.meta.url));
const imp = page => page.locator('#import');
// a transaction row, found by its description (not the entry names in its dropdown)
const txn = (page, text) => imp(page).locator('.imp-row', { has: page.locator('.imp-desc', { hasText: text }) });

async function chooseFile(page, name) {
  await tab(page, 'settings');
  await page.locator('#bankFile').setInputFiles(csv(name));
  await expect(imp(page)).toBeVisible();
}

test('credit card statement: matches, recurring, ignore payee, import, no duplicates on re-import', async ({ page }) => {
  await openWithSample(page);
  await chooseFile(page, 'commbank-credit-card.csv');

  // File details and detected settings
  await expect(imp(page)).toContainText('14 transactions');
  await expect(page.locator('#impAccount')).toHaveValue('CommBank credit card');
  await expect(imp(page).locator('[data-order=DMY]')).toHaveClass(/on/);
  await expect(imp(page)).toContainText('Date order detected from the file.');

  // Matched to existing entries
  for (const [text, entry] of [['NETFLIX.COM', 'Netflix'], ['SPOTIFY', 'Spotify'], ['APPLE.COM', 'Apple One'], ['AAMI INSURANCE', 'Car insurance']]) {
    const sel = txn(page, text).first().locator('select');
    await expect(sel.locator('option:checked'), text).toHaveText(entry);
  }
  // Recurring, not yet an entry
  const recurring = imp(page).locator('.label-row', { hasText: 'Disney Plus' });
  await expect(recurring).toContainText('3 × $13.99 · monthly');
  await recurring.locator('[data-new]').click();
  await expect(txn(page, 'DISNEY PLUS').first().locator('select option:checked')).toHaveText('New: Disney Plus');

  // Always ignore a payee
  await txn(page, 'WOOLWORTHS').locator('select').selectOption('ignore-payee');
  await page.screenshot({ path: test.info().outputPath('import-review.png'), fullPage: true });

  await imp(page).locator('.sheet-head [data-apply]').click();
  await expect(page.locator('#toast')).toContainText('added 1 entry');
  await expect(page.locator('#toast')).toContainText('ignored 1');

  await tab(page, 'entries');
  await expect(row(page, 'Disney Plus')).toContainText('Monthly');
  await expect(row(page, 'Disney Plus')).toContainText('Last $13.99 on 3 Nov');
  await expect(row(page, 'Car insurance')).toContainText('Last $56.00 on 18 Nov');

  // Same file again: everything already handled is skipped
  await chooseFile(page, 'commbank-credit-card.csv');
  await expect(imp(page)).toContainText('already imported or ignored — skipped');
  await expect(txn(page, 'NETFLIX.COM')).toHaveCount(0);
  await expect(txn(page, 'WOOLWORTHS')).toHaveCount(0);
  await expect(txn(page, 'KMART')).toHaveCount(1);            // was skipped, so it comes back to decide
});

test('savings statement: income and transfers matched; payments land on the right due dates', async ({ page }) => {
  await openWithSample(page);
  await chooseFile(page, 'commbank-savings.csv');
  await expect(page.locator('#impAccount')).toHaveValue('CommBank account');   // no accounts yet: a name box
  await expect(txn(page, 'Salary').locator('select option:checked')).toHaveText('Salary');
  await expect(txn(page, 'Rent November').locator('select option:checked')).toHaveText('Rent');
  await expect(txn(page, 'ORIGIN ENERGY').locator('select option:checked')).toHaveText('Electricity & gas');
  await imp(page).locator('.sheet-head [data-apply]').click();
  await expect(page.locator('#toast')).toContainText('Logged');
  await editEntry(page, 'Rent');
  const pay = page.locator('#payments .pay-row').first();
  await expect(pay.locator('[name=paydate]')).toHaveValue('2026-11-01');
  await expect(pay.locator('[name=payamount]')).toHaveValue('1010.00');
});

test('a payment already logged by hand is updated with the bank date, not added again', async ({ page }) => {
  await openWithSample(page);
  // The sample water bill has a hand-logged $88.40 on 10 Aug; move it to 12 Aug, as if marked paid late.
  await editEntry(page, 'Water');
  const pays = page.locator('#payments .pay-row');
  const before = await pays.count();
  const aug = pays.filter({ has: page.locator('[name=payamount][value="88.40"]') });
  await aug.locator('[name=paydate]').fill('2026-08-12');
  await page.locator('.sheet-head [type=submit]').click();
  await expect(page.locator('#sheet[open]')).toHaveCount(0);

  await chooseFile(page, 'commbank-savings.csv');
  const water = txn(page, 'SYDNEY WATER');
  await water.locator('select').selectOption({ label: 'Water' });
  await expect(water).toContainText('already logged 12 Aug');
  await imp(page).locator('.sheet-head [data-apply]').click();
  await expect(page.locator('#toast')).toContainText("updated 1 you'd logged");

  await editEntry(page, 'Water');
  await expect(pays).toHaveCount(before);                                   // no second copy
  await expect(pays.filter({ has: page.locator('[name=paydate][value="2026-08-10"]') })).toHaveCount(1); // bank's date
});

test('accounts: pick from previous ones, rename without losing duplicate detection', async ({ page }) => {
  await openWithSample(page);
  await chooseFile(page, 'commbank-credit-card.csv');
  await expect(page.locator('#impAccountPick')).toHaveCount(0);            // first import: just a name box
  await imp(page).locator('.sheet-head [data-apply]').click();
  await expect(page.locator('#toast')).toContainText('Logged');

  // Rename it in Settings
  await tab(page, 'settings');
  page.answers.push('Everyday card');
  await page.getByRole('button', { name: 'Rename CommBank credit card' }).click();
  await expect(page.locator('#toast')).toContainText('Account renamed');
  await expect(page.locator('#view')).toContainText('Everyday card');

  // Next import picks the renamed account, and still knows what was imported
  await chooseFile(page, 'commbank-credit-card.csv');
  await expect(page.locator('#impAccountPick option:checked')).toHaveText('Everyday card');
  await expect(imp(page)).toContainText('already imported or ignored — skipped');
  await expect(txn(page, 'NETFLIX.COM')).toHaveCount(0);

  // "New account…" offers a name box; typing an existing name goes back to that account
  await page.locator('#impAccountPick').selectOption({ label: 'New account…' });
  await expect(page.locator('#impAccount')).toBeVisible();
  await expect(txn(page, 'NETFLIX.COM')).not.toHaveCount(0);               // a different account: nothing known yet
  await page.locator('#impAccount').fill('everyday card');
  await page.locator('#impAccount').blur();
  await expect(page.locator('#impAccountPick option:checked')).toHaveText('Everyday card');
  await expect(txn(page, 'NETFLIX.COM')).toHaveCount(0);
});

test('name a payee: shown on this and future imports, choices kept, used in payment notes', async ({ page }) => {
  await openWithSample(page);
  await chooseFile(page, 'commbank-credit-card.csv');
  await txn(page, 'WOOLWORTHS').locator('select').selectOption('ignore-payee');   // a choice made before renaming

  page.answers.push('School uniforms');
  await txn(page, 'KMART').getByRole('button', { name: /^Rename|^Name|KMART/ }).click();
  await expect(txn(page, 'KMART').locator('.imp-name')).toHaveText('School uniforms');
  await expect(txn(page, 'KMART')).toContainText('KMART');                          // the bank's text stays visible
  await expect(txn(page, 'WOOLWORTHS').locator('select option:checked')).toHaveText('Always ignore this payee');
  await txn(page, 'KMART').screenshot({ path: test.info().outputPath('named-payee.png') });

  await txn(page, 'KMART').locator('select').selectOption({ label: 'Groceries' });
  await imp(page).locator('.sheet-head [data-apply]').click();
  await expect(page.locator('#toast')).toContainText('Logged');
  await editEntry(page, 'Groceries');
  await expect(page.locator('#payments')).toContainText('School uniforms');

  // Settings remembers it, and the next import shows the name straight away
  await page.locator('#sheet .sheet-head [data-close]').click();
  await tab(page, 'settings');
  await expect(page.locator('#view')).toContainText('1 payees with your own names');
});

test('only deliberate choices are remembered; remembered matches and imported payments can be cleared', async ({ page }) => {
  await openWithSample(page);
  await chooseFile(page, 'commbank-savings.csv');
  const salaryCount = await txn(page, 'Salary').count();
  await imp(page).locator('.sheet-head [data-apply]').click();
  await expect(page.locator('#toast')).toContainText('Logged');

  // Start again: remove what the import logged
  await tab(page, 'settings');
  const remove = page.locator('[data-action=remove-imported]');
  await expect(remove).toContainText('came from bank imports');
  await remove.click();
  await expect(page.locator('#toast')).toContainText('Removed');
  await expect(remove).toHaveCount(0);

  // Re-import: name matches were remembered; ORIGIN (matched on exact amount only) was not
  await chooseFile(page, 'commbank-savings.csv');
  await expect(imp(page)).not.toContainText('already imported or ignored');
  await expect(txn(page, 'Rent November')).toContainText('remembered');
  await expect(txn(page, 'ORIGIN ENERGY')).not.toContainText('remembered');
  await expect(txn(page, 'ORIGIN ENERGY').locator('select option:checked')).toHaveText('Electricity & gas');
  expect(salaryCount).toBeGreaterThan(0);

  // Switching a remembered row to "Skip for now" forgets it
  await txn(page, 'Rent November').locator('select').selectOption('');
  await imp(page).locator('.sheet-head [data-apply]').click();
  await chooseFile(page, 'commbank-savings.csv');
  await expect(txn(page, 'Rent November')).not.toContainText('remembered');
  await imp(page).locator('.sheet-head [data-close]').click();

  // Forget all remembered matches
  await tab(page, 'settings');
  await page.locator('[data-action=forget-rules]').click();
  await expect(page.locator('#toast')).toContainText('Remembered matches forgotten');
  await expect(page.locator('[data-action=forget-rules]')).toHaveCount(0);
});

test('ambiguous dates: the user can switch the order and sees a preview', async ({ page }) => {
  await page.goto('/');
  await chooseFile(page, 'ambiguous-dates.csv');
  await expect(imp(page)).toContainText('Check the date order');
  await expect(imp(page)).toContainText('03/11/2026 → 3 Nov 2026');
  await imp(page).locator('[data-order=MDY]').click();
  await expect(imp(page)).toContainText('03/11/2026 → 11 Mar 2026');
});

test('a file that isn’t a statement is rejected with a clear message', async ({ page }) => {
  await page.goto('/');
  await tab(page, 'settings');
  await page.locator('#bankFile').setInputFiles({ name: 'notes.csv', mimeType: 'text/csv', buffer: Buffer.from('hello,world\nfoo,bar\n') });
  await expect.poll(() => page.dialogs.at(-1)).toContain('wasn’t recognised as a bank statement');
});

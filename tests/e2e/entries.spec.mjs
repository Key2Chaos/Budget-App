// Adding, editing, deleting, searching and filtering entries.
import { test, expect, openWithSample, tab, row, editEntry, sheetPage, save } from './helpers.mjs';

test('add: validation, typed amounts, and the new row', async ({ page }) => {
  await openWithSample(page);
  await page.locator('#addBtn').click();
  await save(page);
  await expect(page.locator('#formError')).toHaveText('Please enter a name.');
  await page.fill('[name=name]', 'Test gym');
  await save(page);
  await expect(page.locator('#formError')).toContainText('valid amount');
  await page.fill('[name=amount]', '£29.99');
  await page.fill('[name=category]', 'health');          // snaps to existing "Health"
  await save(page);
  await expect(page.locator('#sheet[open]')).toHaveCount(0);
  await tab(page, 'entries');
  await expect(row(page, 'Test gym')).toContainText('−£29.99');
  await expect(row(page, 'Test gym')).toContainText('Health');
});

test('one-off entries hide the contract fields', async ({ page }) => {
  await openWithSample(page);
  await page.locator('#addBtn').click();
  await expect(page.locator('[name=contractEnd]')).toBeVisible();
  await page.selectOption('[name=frequency]', 'once');
  await expect(page.locator('[name=contractEnd]')).toBeHidden();
  await expect(page.locator('.lbl-start')).toHaveText('Date');
});

test('no set schedule: amount is optional "about per month", no due dates, spending from payments', async ({ page }) => {
  await openWithSample(page);
  await page.locator('#addBtn').click();
  await page.fill('[name=name]', 'Fuel');
  await page.selectOption('[name=frequency]', 'irregular');
  await expect(page.locator('.lbl-amount')).toHaveText('About per month');
  await expect(page.locator('.lbl-start')).toHaveText('Started');
  await expect(page.locator('[name=variable]')).toBeChecked();             // amounts come from payments
  await page.fill('[name=amount]', '180');
  await save(page);
  await expect(page.locator('#sheet[open]')).toHaveCount(0);

  await tab(page, 'entries');
  const fuel = row(page, 'Fuel');
  await expect(fuel).toContainText('Variable');
  await expect(fuel).toContainText('about a month');
  await expect(fuel).toContainText('≈£180.00');
  await expect(fuel).not.toContainText('Next');

  // Log two fill-ups this month: the estimate stays the typed one until a full month is logged
  await editEntry(page, 'Fuel');
  await expect(page.locator('#sheet')).toContainText('a month');
  await expect(page.locator('#sheet')).toContainText('no due dates');
  await save(page);
});

test('edit: add a price/frequency change and a tag', async ({ page }) => {
  await openWithSample(page);
  await editEntry(page, 'Car insurance');
  await expect(page.locator('#prices .price-row')).toHaveCount(3);
  await page.locator('[data-add-price]').click();
  const last = page.locator('#prices .price-row').last();
  await last.locator('[name=pfrom]').fill('2027-01-18');
  await last.locator('[name=pamount]').fill('60');
  await page.fill('#tagInput', 'Renew Soon');
  await page.keyboard.press('Enter');
  await expect(page.locator('#tagChips')).toContainText('#renew-soon');
  await save(page);
  await editEntry(page, 'Car insurance');
  await expect(page.locator('#prices .price-row')).toHaveCount(4);
  await expect(page.locator('#tagChips')).toContainText('#renew-soon');
});

test('edit: changes must be after the first payment', async ({ page }) => {
  await openWithSample(page);
  await editEntry(page, 'Netflix');
  await page.locator('[data-add-price]').click();
  await page.locator('#prices .price-row').last().locator('[name=pfrom]').fill('2000-01-01');
  await page.locator('#prices .price-row').last().locator('[name=pamount]').fill('1');
  await save(page);
  await expect(page.locator('#formError')).toHaveText('Changes must be after the first payment date.');
});

test('delete asks first, then removes the entry', async ({ page }) => {
  await openWithSample(page);
  await editEntry(page, 'Spotify');
  await page.locator('[data-delete]').click();
  expect(page.dialogs.at(-1)).toContain('Delete “Spotify”');
  await tab(page, 'entries');
  await expect(row(page, 'Spotify')).toHaveCount(0);
});

test('search and the Expenses / Income filter', async ({ page }) => {
  await openWithSample(page);
  await tab(page, 'entries');
  await page.fill('#search', '#streaming');
  await expect(page.locator('.row[data-action=edit]')).toHaveCount(2); // Netflix, Apple One
  await page.fill('#search', '');
  await page.locator('[data-action=filter][data-filter=income]').click();
  await expect(page.locator('.row[data-action=edit]')).toHaveCount(2); // Salary, Freelance
  await page.locator('[data-action=filter][data-filter=all]').click();
});

test('an entry has three pages: Summary, Transactions and Accounts', async ({ page }) => {
  await openWithSample(page);
  await page.locator('#addBtn').click();
  await expect(page.locator('#sheet [role=tab]')).toHaveCount(0);          // a new entry is one page
  await page.locator('#sheet .sheet-head [data-close]').click();

  await editEntry(page, 'Water');
  const tabs = page.locator('#sheet [role=tab]');
  await expect(tabs).toHaveText(['Summary', 'Transactions', 'Accounts']);
  const on = page.locator('#sheet .tab-panel.on');
  await expect(on).toContainText('A month');
  await expect(on).toContainText('Last 12 months');
  await expect(page.locator('#payments')).toBeHidden();
  await expect(page.locator('[name=notes]')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('summary.png'), fullPage: true });

  await on.getByRole('button', { name: /^See \d+ transactions? ›$/ }).click(); // shortcut from the summary
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#payments .pay-row').first()).toBeVisible();
  await expect(page.locator('[name=notes]')).toBeHidden();
  const n = await page.locator('#payments .pay-row').count();
  await page.locator('[data-add-payment]').click();
  await page.locator('#payments .pay-row').first().locator('[name=payamount]').fill('50');

  await sheetPage(page, 'accounts');
  await expect(page.locator('#sheet .tab-panel.on')).toContainText('Logged by hand');

  await save(page);                                                          // saves every page, not just the one showing
  await expect(page.locator('#sheet[open]')).toHaveCount(0);
  await editEntry(page, 'Water');
  await sheetPage(page, 'transactions');
  await expect(page.locator('#payments .pay-row')).toHaveCount(n + 1);
});

test('logged payments: a typed minus makes a credit; income rows say received / paid back', async ({ page }) => {
  await openWithSample(page);
  await editEntry(page, 'Water');
  await sheetPage(page, 'transactions');
  const first = page.locator('#payments .pay-row').first();
  await page.locator('[data-add-payment]').click();
  await first.locator('[name=payamount]').fill('-20');
  await expect(first).toHaveClass(/credit/);
  await expect(first.locator('.pay-kind')).toBeVisible();
  await first.locator('[data-flip-sign]').click();                          // and back again
  await expect(first.locator('[name=payamount]')).toHaveValue('20');
  await expect(first).not.toHaveClass(/credit/);
  await expect(first.locator('.pay-kind')).toBeHidden();
  await first.locator('[data-flip-sign]').click();
  await page.screenshot({ path: test.info().outputPath('payments.png') });
  await save(page);
  await expect(page.locator('#sheet[open]')).toHaveCount(0);
  await editEntry(page, 'Water');
  await sheetPage(page, 'transactions');
  await expect(page.locator('#payments .pay-row.credit [name=payamount]')).toHaveValue('-20.00');

  // On income, the same row reads as money received, and a minus as money paid back
  await sheetPage(page, 'summary');
  await page.locator('#sheet .type-seg label', { hasText: 'Income' }).click();
  await sheetPage(page, 'transactions');
  const row = page.locator('#payments .pay-row.credit');
  await expect(row.locator('[name=paydate]')).toHaveAttribute('aria-label', 'Received on');
  await expect(row.locator('.pay-kind')).toHaveText('Paid back');
  await expect(page.locator('#sheet .tab-panel.on')).toContainText('money you paid back');
});

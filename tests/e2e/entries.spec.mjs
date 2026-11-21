// Adding, editing, deleting, searching and filtering entries.
import { test, expect, openWithSample, tab, row, editEntry, save } from './helpers.mjs';

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

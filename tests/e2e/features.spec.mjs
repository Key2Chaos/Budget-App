// Labels, payments, varying bills, shares, budgets, payday, year view.
import { test, expect, openWithSample, tab, card, row, editEntry, sheetPage, save } from './helpers.mjs';

test.describe('labels', () => {
  test('spelling snaps to existing labels and tags are tidied', async ({ page }) => {
    await openWithSample(page);
    await page.locator('#addBtn').click();
    await page.fill('[name=name]', 'Apple TV');
    await page.fill('[name=amount]', '8.99');
    await page.fill('[name=category]', '  subscriptions ');
    await page.fill('[name=method]', 'credit CARD');
    await page.fill('#tagInput', 'Video Streaming');
    await page.keyboard.press('Enter');
    await save(page);
    await tab(page, 'entries');
    await expect(row(page, 'Apple TV')).toContainText('Subscriptions · Credit card');
    await expect(row(page, 'Apple TV')).toContainText('#video-streaming');
  });

  test('manage labels: merge a method, rename and delete a tag', async ({ page }) => {
    await openWithSample(page);
    await tab(page, 'settings');
    await page.locator('[data-action=manage-labels]').click();
    await page.locator('#manage [data-kind=method]').click();
    page.answers.push('credit card');
    await page.locator('#manage [data-rename="Apple Pay"]').click();
    await expect(page.locator('#manage .label-row')).not.toContainText(['Apple Pay']);
    await page.locator('#manage [data-kind=tag]').click();
    page.answers.push('Tunes');
    await page.locator('#manage [data-rename="music"]').click();
    await expect.poll(() => page.locator('#manage .label-row .row-title').allInnerTexts()).toContain('#tunes');
    await page.locator('#manage [data-remove="taxable"]').click();
    // the list redraws after the change is saved — wait for it rather than reading it straight away
    await expect.poll(() => page.locator('#manage .label-row .row-title').allInnerTexts()).not.toContain('#taxable');
    expect(await page.locator('#manage .label-row .row-title').allInnerTexts()).not.toContain('#music');
  });
});

test.describe('payments', () => {
  test('To pay: overdue manual payment, Mark paid clears it', async ({ page }) => {
    await openWithSample(page);
    const toPay = card(page, 'To pay');
    await expect(toPay.locator('.pay-item', { hasText: 'Window cleaner' })).toContainText('Overdue · was due 12 Nov');
    await expect(toPay.locator('.pay-item', { hasText: 'Piano lessons' })).toContainText('Due 26 Nov');
    page.answers.push('22');
    await toPay.locator('.pay-item', { hasText: 'Window cleaner' }).locator('[data-action=mark-paid]').click();
    await expect(toPay.locator('.pay-item', { hasText: 'Window cleaner' })).toHaveCount(0);
    await tab(page, 'entries');
    await expect(row(page, 'Window cleaner')).toContainText('Last £22.00 on 21 Nov');
  });

  test('varying bill: estimate follows the latest three payments; credits are left out', async ({ page }) => {
    await openWithSample(page);
    await editEntry(page, 'Water');
    await expect(page.locator('#prices input[name=pamount]').first()).toBeHidden(); // amounts come from the log
    await sheetPage(page, 'transactions');
    await page.locator('[data-add-payment]').click();
    await page.locator('#payments .pay-row').first().locator('[name=payamount]').fill('101.10');
    await page.locator('[data-add-payment]').click();
    await page.locator('#payments .pay-row').first().locator('[name=payamount]').fill('15');
    await page.locator('#payments .pay-row').first().locator('[data-sign]').click();
    await expect(page.locator('#payments .pay-row').first().locator('[data-sign]')).toHaveText('Credit');
    await save(page);
    await tab(page, 'entries');
    await expect(row(page, 'Water')).toContainText('−≈£98.08'); // (104.75 + 88.40 + 101.10) / 3
  });

  test('varying bill with no amount shows "Varies" until a payment is logged', async ({ page }) => {
    await openWithSample(page);
    await page.locator('#addBtn').click();
    await page.fill('[name=name]', 'Gas');
    await page.check('[name=variable]', { force: true });
    await expect(page.locator('.lbl-amount')).toHaveText('Estimate');
    await save(page);
    await tab(page, 'entries');
    await expect(row(page, 'Gas')).toContainText('Varies');
    await editEntry(page, 'Gas');
    await sheetPage(page, 'transactions');
    await page.locator('[data-add-payment]').click();
    await page.locator('#payments .pay-row').first().locator('[name=payamount]').fill('180');
    await save(page);
    await expect(row(page, 'Gas')).toContainText('−≈£180.00');
  });

  test('your share: shown in lists, validated in the form', async ({ page }) => {
    await openWithSample(page);
    await tab(page, 'entries');
    await expect(row(page, 'Rent')).toContainText('your 50% of £1,010.00');
    await editEntry(page, 'Rent');
    await page.fill('[name=share]', '150');
    await save(page);
    await expect(page.locator('#formError')).toHaveText('Your share must be between 1 and 100%.');
  });

  test('notice period moves the contract warning earlier', async ({ page }) => {
    await openWithSample(page);
    await expect(card(page, 'Contracts').locator('.row', { hasText: 'Phone contract' }))
      .toContainText('Give notice by 6 Dec (in 15 days)');
  });
});

test.describe('reports', () => {
  test('budgets card, adding a budget, and the duplicate check', async ({ page }) => {
    await openWithSample(page);
    await expect(card(page, 'Budgets').locator('.cat', { hasText: 'Subscriptions' })).toContainText('Over by £3.93');
    await tab(page, 'settings');
    await page.locator('[data-action=manage-budgets]').click();
    await page.check('#budgetForm [name=kind][value=tag]', { force: true });
    await page.fill('#budgetForm [name=label]', 'Streaming');
    await page.fill('#budgetForm [name=amount]', '25');
    await page.locator('[data-save-budget]').click();
    await expect(page.locator('#budgets .label-row')).toContainText(['#streaming']);
    await page.check('#budgetForm [name=kind][value=category]', { force: true });
    await page.fill('#budgetForm [name=label]', 'groceries');
    await page.fill('#budgetForm [name=amount]', '99');
    await page.locator('[data-save-budget]').click();
    await expect(page.locator('#budgetError')).toHaveText('There\'s already a budget for “Groceries”.');
  });

  test('saving an entry that pushes a budget further over shows a warning', async ({ page }) => {
    await openWithSample(page);
    await editEntry(page, 'Netflix');
    await page.locator('#prices .price-row').last().locator('[name=pamount]').fill('22.99');
    await save(page);
    await expect(page.locator('#toast')).toHaveText(/Over your Subscriptions budget by £13\.93 this month/, { timeout: 5000 });
  });

  test('until payday: balance gives a running total and what is left', async ({ page }) => {
    await openWithSample(page);
    const pd = card(page, 'Until payday');
    await expect(pd.locator('.card-head')).toContainText('Salary · 28 Nov · in 7 days');
    await page.fill('#balance', '1,250');
    await page.locator('#balance').dispatchEvent('change');
    await expect(pd.locator('.pd-summary')).toContainText('Going out£162.00');
    await expect(pd.locator('.pd-summary')).toContainText('Left before payday£1,088.00');
    await expect(pd.locator('.pd-row').first()).toContainText('£1,230.00');
  });

  test('month / year switch', async ({ page }) => {
    await openWithSample(page);
    await page.locator('[data-action=period][data-period=year]').click();
    await expect(page.locator('.summary-head')).toHaveText('Per year at today’s rates');
    await expect(card(page, 'Biggest changes').locator('.row').first()).toContainText('/yr');
    await tab(page, 'entries');
    await expect(page.locator('.group-title').first()).toContainText('/yr net');
    await tab(page, 'overview');
    await page.locator('[data-action=period][data-period=month]').click();
    await expect(page.locator('.summary-head')).toHaveText('November 2026');
  });
});

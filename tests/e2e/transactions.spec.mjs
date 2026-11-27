// The Transactions tab: every payment in one table (search, filters, sorting, moving several at
// once), and the Overview's figures opening it already filtered. Made-up data.
import { fileURLToPath } from 'node:url';
import { test, expect, openWithSample, tab, card, nameAccounts, expectNoHorizontalScroll } from './helpers.mjs';

test.use({ locale: 'en-AU', timezoneId: 'Australia/Sydney' });
const csv = name => fileURLToPath(new URL(`../fixtures/bank/${name}`, import.meta.url));
const rows = page => page.locator('.tx-table tbody tr');
const txRow = (page, text) => page.locator('.tx-table tbody tr', { hasText: text });
const picker = page => page.locator('#picker');
const shot = async (page, name) => {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `test-results/phone-${name}.png`, fullPage: true });
};

/** The sample data plus a card statement, imported as offered. */
async function withCardStatement(page) {
  await openWithSample(page);
  await tab(page, 'settings');
  await page.locator('#bankFile').setInputFiles(csv('commbank-credit-card.csv'));
  await expect(page.locator('#import')).toBeVisible();
  await nameAccounts(page);
  await page.locator('#import .sheet-head [data-apply]').click();
  await expect(page.locator('#toast')).toContainText('Logged');
  await tab(page, 'txns');
  await expect(page.locator('#title')).toHaveText('Transactions');
}

test('every payment in one table: search, sort and filter', async ({ page }) => {
  await withCardStatement(page);
  const all = await rows(page).count();
  expect(all).toBeGreaterThan(10);
  await expect(page.locator('.tx-sum')).toContainText(`${all} payments`);

  // newest first (the card repayment on 20 Nov is a transfer, not a payment), then sorted by amount
  await expect(rows(page).first().locator('.tx-date')).toHaveText('18 Nov');
  await expect(page.locator('.tx-table')).not.toContainText('PAYMENT RECEIVED');
  // on a phone the filters fold away until asked for
  await expect(page.locator('[data-tx=sortby]')).toBeHidden();
  await page.getByRole('button', { name: /^Filters & sort/ }).click();
  // (a phone has a Sort menu; a computer's column headings sort — see desktop.spec.mjs)
  await page.locator('[data-tx=sortby]').selectOption('amount:1');
  const amounts = await page.locator('.tx-table tbody .tx-amt').evaluateAll(els =>
    els.map(e => Number(e.firstChild.textContent.replace(/[^\d.−-]/g, '').replace('−', '-'))));
  expect(amounts).toEqual([...amounts].sort((a, b) => a - b)); // biggest money out first

  // search keeps the cursor in the box
  await page.locator('#txSearch').fill('netflix');
  await expect(page.locator('#txSearch')).toBeFocused();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator('.tx-sum')).toContainText('Out $25.98');

  // a filter, and clearing them all
  await page.locator('#txSearch').fill('');
  await page.locator('[data-tx=period]').selectOption('month');
  const nov = await rows(page).count();
  expect(nov).toBeLessThan(all);
  await expect(page.locator('.tx-date', { hasText: 'Oct' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(rows(page)).toHaveCount(all);

  // the group's name opens the group
  await txRow(page, 'Kmart').locator('.tx-group button').click();
  await expect(page.locator('#sheet[open]')).toBeVisible();
});

test('select several payments and move them to another payee group', async ({ page }) => {
  await withCardStatement(page);
  await page.locator('#txSearch').fill('disney');
  await expect(rows(page)).toHaveCount(3);
  await page.locator('[data-sel-all]').check();
  await expect(page.locator('.tx-bulk')).toContainText('3 selected');
  await expect(page.locator('.tx-bulk')).toContainText('−$41.97');
  await page.locator('.tx-bulk').getByRole('button', { name: 'Move to…' }).click();
  await expect(picker(page)).toBeVisible();
  await picker(page).locator('.pick-search').fill('Netflix');
  await picker(page).locator('[data-pick]', { hasText: 'Netflix' }).first().click();
  await expect(page.locator('#toast')).toContainText('Moved 3 payments to Netflix');
  await expect(page.locator('.tx-bulk')).toHaveCount(0);
  await expect(rows(page).locator('.tx-group')).toHaveText(['Netflix', 'Netflix', 'Netflix']);
  await shot(page, 'transactions');
});

test('Where it goes opens the payments behind a figure, with how the Overview counts it', async ({ page }) => {
  await withCardStatement(page);
  await tab(page, 'overview');
  const cat = card(page, 'Where it goes').locator('button.cat', { hasText: 'Subscriptions' });
  const figure = (await cat.locator('.cat-top > span').nth(1).textContent()).split(' ')[0];
  await cat.click();

  await expect(page.locator('#title')).toHaveText('Transactions');
  await expect(page.locator('.tx-origin')).toContainText(`Subscriptions · November 2026 · ${figure}`);
  await expect(page.getByRole('button', { name: /^Filters & sort/ })).toHaveText('Filters & sort · 2 on');
  await page.getByRole('button', { name: /^Filters & sort/ }).click();
  await expect(page.locator('[data-tx=category]')).toHaveValue('Subscriptions');
  await expect(page.locator('[data-tx=period] option:checked')).toHaveText('This month');
  await expect(rows(page).locator('.tx-cat')).toHaveText(Array(await rows(page).count()).fill('Subscriptions'));
  // the panel is open, and its Overview column adds up to the figure clicked
  const panel = page.locator('.tx-groups');
  await expect(panel).toHaveAttribute('open', '');
  await expect(panel.locator('.tx-g-total span').nth(2)).toHaveText(`−${figure}`);
  await expectNoHorizontalScroll(page);
  await shot(page, 'transactions-drill');

  // back to where you were
  await page.getByRole('button', { name: '‹ Overview' }).click();
  await expect(page.locator('#title')).toHaveText('Overview');
});

test('Income, Expenses, budgets and a chart month open their payments', async ({ page }) => {
  await withCardStatement(page);
  await tab(page, 'overview');
  await page.locator('.summary button.drill-fig', { hasText: 'Expenses' }).click();
  await expect(page.locator('.tx-toolbar .seg button.on')).toHaveText('Money out');
  await expect(page.locator('.tx-amt.pos')).toHaveCount(0);

  await tab(page, 'overview');
  await card(page, 'Budgets').locator('button.cat', { hasText: 'Groceries' }).click();
  await expect(page.locator('.tx-origin')).toContainText('Groceries · budget for November 2026');
  await page.getByRole('button', { name: /^Filters & sort/ }).click();
  await expect(page.locator('[data-tx=category]')).toHaveValue('Groceries');

  await tab(page, 'overview');
  // pick October on the chart (a month that's gone), feeling along from the right
  await page.locator('.chart-svg').scrollIntoViewIfNeeded();
  const svg = await page.locator('.chart-svg').boundingBox();
  for (let x = svg.width - 2; x > 0; x -= 6) {
    await page.mouse.click(svg.x + x, svg.y + svg.height / 2);
    if ((await page.locator('#readout .ro-month').textContent()) === 'October 2026') break;
  }
  await expect(page.locator('#readout .ro-month')).toHaveText('October 2026');
  await page.locator('#readout').getByRole('button', { name: 'See the payments ›' }).click();
  await page.getByRole('button', { name: /^Filters & sort/ }).click();
  await expect(page.locator('[data-tx=period] option:checked')).toHaveText('October 2026');
  await expect(page.locator('.tx-date', { hasText: 'Nov' })).toHaveCount(0);
  await expect(page.locator('.tx-date', { hasText: 'Oct' }).first()).toBeVisible();
});

// The layout on a computer: sidebar instead of the bottom tab bar, and cards in columns.
// Runs only in the desktop-chromium project (see playwright.config.mjs).
import { fileURLToPath } from 'node:url';
import { test, expect, openWithSample, tab, row, card, nameAccounts } from './helpers.mjs';

const box = loc => loc.boundingBox();
const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const shot = async (page, name) => {
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `test-results/desktop-${name}.png`, fullPage: true });
};

test('the tabs are a sidebar on the left', async ({ page }) => {
  await openWithSample(page);
  const bar = await box(page.locator('.tabbar'));
  expect(bar.x).toBe(0);
  expect(bar.width).toBeLessThan(260);
  expect(bar.height).toBeGreaterThan(600);
  const [a, b] = await Promise.all(['overview', 'entries'].map(t => box(page.locator(`.tabbar [data-tab=${t}]`))));
  expect(b.y).toBeGreaterThan(a.y); // stacked, not side by side
  expect((await box(page.locator('#view'))).x).toBeGreaterThanOrEqual(bar.width);

  for (const t of ['overview', 'entries', 'settings']) {
    await tab(page, t);
    await expect(page.locator(`.tabbar [data-tab=${t}]`)).toHaveClass(/active/);
    expect(await noSideScroll(page)).toBe(true);
  }
});

test('Overview shows two columns and a chart that fits', async ({ page }) => {
  await openWithSample(page);
  const main = await box(page.locator('.ov-main'));
  const side = await box(page.locator('.ov-side'));
  expect(side.x).toBeGreaterThan(main.x + main.width - 1);
  expect(Math.abs(side.y - main.y)).toBeLessThan(2);
  // the summary and chart are on the left, upcoming payments on the right
  await expect(page.locator('.ov-main .summary')).toBeVisible();
  await expect(page.locator('.ov-main .chart-svg')).toBeVisible();
  await expect(page.locator('.ov-side', { has: page.locator('h3', { hasText: 'Next 14 days' }) })).toHaveCount(1);
  expect((await box(page.locator('.chart-svg'))).height).toBeLessThan(320);
  // the chart still answers a click
  const svg = page.locator('.chart-svg');
  const r = await box(svg);
  await page.mouse.click(r.x + 60, r.y + r.height / 2);
  await expect(page.locator('#readout .ro-month')).not.toBeEmpty();
  await shot(page, 'overview');
});

test('the phone layout comes back when the window is narrowed', async ({ page }) => {
  await openWithSample(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const bar = await box(page.locator('.tabbar'));
  expect(bar.y + bar.height).toBeGreaterThan(830); // at the bottom again
  // cards are in one column, in the phone order: summary above the chart
  const summary = await box(page.locator('.summary'));
  const chart = await box(card(page, 'Over time'));
  expect(Math.abs(summary.x - chart.x)).toBeLessThan(2);
  expect(chart.y).toBeGreaterThan(summary.y);
  expect(await noSideScroll(page)).toBe(true);
});

test('Groups and Settings use the width', async ({ page }) => {
  await openWithSample(page);
  await tab(page, 'entries');
  const seg = await box(page.locator('.toolbar .seg'));
  const search = await box(page.locator('#search'));
  expect(Math.abs(seg.y - search.y)).toBeLessThan(8); // on one row
  await page.locator('#search').fill('netf');
  await expect(page.locator('#search')).toBeFocused();
  await page.locator('#search').fill('');
  await shot(page, 'groups');

  await tab(page, 'settings');
  // Settings draws after an async storage check, so wait for its sections before measuring
  await expect(page.locator('.set-cols > .sec').first()).toBeVisible();
  const xs = await page.locator('.set-cols > .sec').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().x)));
  expect(new Set(xs).size).toBe(2);
  await shot(page, 'settings');
});

test('the edit sheet is wider, and opens from a click', async ({ page }) => {
  await openWithSample(page);
  await tab(page, 'entries');
  await page.locator('.g-table tbody tr', { hasText: 'Netflix' }).locator('.g-cat').click(); // anywhere on the row
  const sheet = await box(page.locator('#sheet[open]'));
  expect(sheet.width).toBeGreaterThan(600);
  expect(sheet.width).toBeLessThanOrEqual(720);
  await shot(page, 'sheet');
});

test('Transactions: a table with columns that sort, opened from the Overview', async ({ page }) => {
  await openWithSample(page);
  await tab(page, 'settings');
  await page.locator('#bankFile').setInputFiles(fileURLToPath(new URL('../fixtures/bank/commbank-credit-card.csv', import.meta.url)));
  await nameAccounts(page);
  await page.locator('#import .sheet-head [data-apply]').click();
  await expect(page.locator('#toast')).toContainText('Logged');

  // Where it goes → the category's payments, with the breakdown open above the table
  await tab(page, 'overview');
  await card(page, 'Where it goes').locator('button.cat', { hasText: 'Subscriptions' }).click();
  await expect(page.locator('.tabbar [data-tab=txns]')).toHaveClass(/active/);
  await expect(page.locator('.tx-groups[open]')).toBeVisible();
  await shot(page, 'transactions-drill');

  await page.getByRole('button', { name: 'Clear filters' }).click();
  for (const h of ['Date', 'Payee', 'Payee group', 'Category', 'Account', 'Method', 'Amount']) {
    await expect(page.locator('.tx-table thead th button', { hasText: new RegExp(`^${h}[▲▼]?$`) })).toBeVisible();
  }
  await expect(page.locator('[data-tx=sortby]')).toBeHidden(); // the headings sort instead
  expect(await noSideScroll(page)).toBe(true);
  // a heading sorts; clicking again turns it round
  const head = page.locator('.tx-table th.tx-payee');
  await head.locator('button').click();
  await expect(head).toHaveAttribute('aria-sort', 'ascending');
  const names = await page.locator('.tx-table tbody .tx-name').allTextContents();
  expect(names).toEqual([...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  await head.locator('button').click();
  await expect(head).toHaveAttribute('aria-sort', 'descending');
  // the filters sit on one row
  const ys = await page.locator('.tx-filters label:visible').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().y)));
  expect(new Set(ys).size).toBe(1);
  await page.locator('.tx-table tbody tr').nth(1).locator('input[type=checkbox]').check();
  await shot(page, 'transactions');
});

test('Payee groups: a table whose headings sort, biggest a month first', async ({ page }) => {
  await openWithSample(page);
  await tab(page, 'entries');
  await expect(page.locator('#view .row')).toHaveCount(0); // no phone list
  const names = () => page.locator('.g-table tbody .g-open').allTextContents();
  const head = name => page.locator(`.g-table th.${name}`);
  // biggest a month first: Salary (+2,950), then Rent (505)
  await expect(head('g-per')).toHaveAttribute('aria-sort', 'descending');
  expect((await names()).slice(0, 2)).toEqual(['Salary', 'Rent']);
  // ended and one-off groups have nothing a month, so they're last
  expect((await names()).slice(-2).sort()).toEqual(['Freelance design job', 'Gym']);

  await head('g-name').locator('button').click();
  await expect(head('g-name')).toHaveAttribute('aria-sort', 'ascending');
  const az = await names();
  expect(az).toEqual([...az].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  await head('g-name').locator('button').click();
  await expect(head('g-name')).toHaveAttribute('aria-sort', 'descending');

  // next due: soonest first, with no date (ended, one-off gone by) at the bottom
  await head('g-next').locator('button').click();
  await expect(head('g-next')).toHaveAttribute('aria-sort', 'ascending');
  expect((await names())[0]).toBe('Groceries'); // weekly, 23 Nov
  expect(await page.locator('.g-table tbody tr').last().locator('.g-next').textContent()).toBe('—');

  // search and the type filter still apply; the per-year heading follows the Overview's switch
  await page.locator('#search').fill('netf');
  await expect(page.locator('#search')).toBeFocused();
  expect(await names()).toEqual(['Netflix']);
  await page.locator('#search').fill('');
  await tab(page, 'overview');
  await page.locator('.summary [data-period=year]').click();
  await tab(page, 'entries');
  await expect(head('g-per')).toContainText('A year');
  expect(await noSideScroll(page)).toBe(true);
  await shot(page, 'groups-table');
});

test('Payees and Accounts are in the sidebar on a computer, and not on a phone', async ({ page }) => {
  await openWithSample(page);
  await page.locator('.tabbar [data-tab=payees]').click();
  await expect(page.locator('#title')).toHaveText('Payees');
  await page.locator('.tabbar [data-open=accounts]').click();
  await expect(page.locator('#sheet[open] h2')).toHaveText('Accounts');
  await page.keyboard.press('Escape');
  await tab(page, 'overview'); // (narrowing on the Payees page opens the Payees sheet: see below)
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.tabbar [data-tab=payees]')).toBeHidden();
  await tab(page, 'entries');
  await expect(row(page, 'Netflix')).toBeVisible(); // the phone list is back
});

/** The sample data plus the card statement, imported as offered. */
async function withCardStatement(page) {
  await openWithSample(page);
  await tab(page, 'settings');
  await page.locator('#bankFile').setInputFiles(fileURLToPath(new URL('../fixtures/bank/commbank-credit-card.csv', import.meta.url)));
  await nameAccounts(page);
  await page.locator('#import .sheet-head [data-apply]').click();
  await expect(page.locator('#toast')).toContainText('Logged');
}

test('Payees page: a table to sort, and several payees put in a payee group at once', async ({ page }) => {
  await withCardStatement(page);
  await page.locator('.tabbar [data-tab=payees]').click();
  await expect(page.locator('.tabbar [data-tab=payees]')).toHaveClass(/active/);
  const prow = name => page.locator('.p-table tbody tr', { has: page.locator('.g-open', { hasText: name }) });
  const names = () => page.locator('.p-table tbody .g-open').allTextContents();
  // most payments first: Disney Plus and Google One (3 each)
  expect((await names()).slice(0, 2).sort()).toEqual(['Disney Plus', 'Google One']);
  await expect(prow('Disney Plus').locator('.p-total')).toHaveText('−$41.97'.replace('$', '£'));
  await page.locator('.p-table th.p-total button').click();
  expect((await names())[0]).toBe('Aami Insurance'); // the biggest total
  await page.locator('.p-table th.p-name button').click();
  const az = await names();
  expect(az).toEqual([...az].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  await shot(page, 'payees');

  // tick two (ticking doesn't open the payee) and put them in a new payee group
  await prow('Disney Plus').locator('input[type=checkbox]').check();
  await prow('Google One').locator('input[type=checkbox]').check();
  await expect(page.locator('#sheet[open]')).toHaveCount(0);
  await expect(page.locator('.tx-bulk')).toContainText('2 selected · 6 payments');
  await page.getByRole('button', { name: 'Put in payee group…' }).click();
  await page.locator('#picker .pick-search').fill('Streaming and storage');
  await page.locator('#picker').getByRole('button', { name: /Create “Streaming and storage”/ }).click();
  await expect(page.locator('#toast')).toContainText('2 payees → Streaming and storage · 6 payments moved');
  await expect(prow('Disney Plus').locator('.p-where')).toHaveText('Streaming and storage');
  await expect(prow('Google One').locator('.p-where')).toHaveText('Streaming and storage');
  // the groups each had to themselves were made by the import, so they've gone
  await tab(page, 'entries');
  await expect(page.locator('.g-table .g-open', { hasText: /^Disney Plus$/ })).toHaveCount(0);
  await expect(page.locator('.g-table .g-open', { hasText: 'Streaming and storage' })).toHaveCount(1);

  // always ignore, from the filter of ungrouped ones; then a payee opens its sheet, with no "‹ Payees"
  await page.locator('.tabbar [data-tab=payees]').click();
  await page.locator('#pSearch').fill('kmart');
  await expect(page.locator('#pSearch')).toBeFocused();
  await page.locator('[data-psel-all]').check();
  await page.getByRole('button', { name: 'Always ignore' }).click();
  await expect(page.locator('#toast')).toContainText('always ignored from the next import');
  await expect(prow('Kmart').locator('.p-where')).toHaveText('Always ignored');
  await page.locator('.toolbar [data-filter=rules]').click();
  expect(await names()).toEqual(['Kmart Bondi']);
  await prow('Kmart').locator('.p-last').click();
  await expect(page.locator('#sheet[open] h2')).toHaveText('Kmart Bondi');
  await expect(page.locator('#sheet [data-back]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#sheet[open]')).toHaveCount(0);

  // narrowing to phone size swaps the page for the Payees sheet in Settings
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#title')).toHaveText('Settings');
  await expect(page.locator('#sheet[open] h2')).toHaveText('Payees');
});

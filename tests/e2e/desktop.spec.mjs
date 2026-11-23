// The layout on a computer: sidebar instead of the bottom tab bar, and cards in columns.
// Runs only in the desktop-chromium project (see playwright.config.mjs).
import { test, expect, openWithSample, tab, row, card } from './helpers.mjs';

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
  await page.locator('#search').fill('net');
  await expect(page.locator('#search')).toBeFocused();
  await page.locator('#search').fill('');
  await shot(page, 'groups');

  await tab(page, 'settings');
  const xs = await page.locator('.set-cols > .sec').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().x)));
  expect(new Set(xs).size).toBe(2);
  await shot(page, 'settings');
});

test('the edit sheet is wider, and opens from a click', async ({ page }) => {
  await openWithSample(page);
  await tab(page, 'entries');
  await row(page, 'Netflix').first().click();
  const sheet = await box(page.locator('#sheet[open]'));
  expect(sheet.width).toBeGreaterThan(600);
  expect(sheet.width).toBeLessThanOrEqual(720);
  await shot(page, 'sheet');
});

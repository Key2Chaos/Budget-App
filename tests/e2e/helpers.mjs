// Shared setup for the browser tests.
import { test as base, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Every test runs on this date, so date-dependent screens are the same every day. */
export const TODAY = new Date('2026-11-21T10:00:00Z');

export const fixturePath = name => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
export const readFixture = name => JSON.parse(readFileSync(fixturePath(name), 'utf8'));

/**
 * `page` with: a frozen clock, every confirm() accepted, prompt() answered from `page.answers`
 * (or its default), dialog messages recorded in `page.dialogs`, and a check at the end that
 * nothing was written to the browser console as an error.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.clock.setFixedTime(TODAY);
    const errors = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    page.dialogs = [];
    page.answers = [];
    page.on('dialog', async d => {
      page.dialogs.push(d.message());
      if (d.type() === 'prompt') await d.accept(page.answers.length ? page.answers.shift() : d.defaultValue());
      else await d.accept();
    });
    await use(page);
    expect(errors, 'no errors in the browser console').toEqual([]);
  },
});
export { expect };

/**
 * Open the app with nothing saved, and wait until start-up has finished. Start-up reads and saves
 * settings, so a test that writes straight to the database must wait, or the two can overlap and
 * the test's data is half-overwritten (seen in WebKit about 1 run in 40).
 */
export async function openEmpty(page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Try it with sample data' })).toBeVisible();
}

/** Open the app and load the built-in sample data. */
export async function openWithSample(page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try it with sample data' }).click();
  await expect(page.locator('.summary')).toBeVisible();
}

/** A list row on the main screen whose title is exactly `name`. */
export const row = (page, name) =>
  page.locator('#view .row', { has: page.locator('.row-title', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });

/** The card on the Overview with this heading. */
export const card = (page, heading) => page.locator('section.card', { has: page.locator('h3', { hasText: heading }) });

export async function tab(page, name) {
  await page.locator(`.tabbar [data-tab=${name}]`).click();
}

/** Open an entry's edit sheet from the Entries tab. */
export async function editEntry(page, name) {
  await tab(page, 'entries');
  await row(page, name).first().click();
  await expect(page.locator('#sheet[open]')).toBeVisible();
}

/** Switch the open entry sheet to one of its pages: 'summary', 'transactions' or 'accounts'. */
export async function sheetPage(page, name) {
  await page.locator(`#sheet [role=tab][data-page=${name}]`).click();
}

export async function save(page) {
  await page.locator('.sheet-head [type=submit]').click();
}

/** No sideways scrolling at phone width. */
export async function expectNoHorizontalScroll(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

/**
 * On the import sheet, give every statement that has no account yet the one it was offered: an
 * existing account with the suggested name, else a new account named as the name box suggests.
 */
export async function nameAccounts(page) {
  for (let i = 0; ; i++) {
    const sfx = i ? `-${i}` : '';
    const card = page.locator(`#import .imp-filecard[data-file="${i}"]`);
    if (!(await card.count())) return;
    const pick = page.locator(`#impAccountPick${sfx}`);
    if (await pick.count() && await pick.inputValue() === '') {
      const guess = await pick.getAttribute('data-guess');
      const labels = await pick.locator('option').allTextContents();
      await pick.selectOption({ label: labels.includes(guess) ? guess : 'New account…' });
    }
    const name = page.locator(`#impAccount${sfx}`);
    if (await name.count() && await name.inputValue() === '') {
      await name.fill((await name.getAttribute('placeholder')).replace(/^e\.g\. /, ''));
      await name.blur();
    }
    await expect(page.locator(`#impNeedAccount${sfx}`)).toHaveCount(0);
  }
}

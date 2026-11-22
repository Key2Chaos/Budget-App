// Accounts, payees and groups (docs/DESIGN.md): the picker, Settings → Payees and Accounts, deleting
// a group, budgets and breakdowns by group, and upgrading saved data from format 4. Made-up data.
import { fileURLToPath } from 'node:url';
import { test, expect, openWithSample, tab, row, editEntry, sheetPage, readFixture } from './helpers.mjs';

test.use({ locale: 'en-AU', timezoneId: 'Australia/Sydney' });
const csv = name => fileURLToPath(new URL(`../fixtures/bank/${name}`, import.meta.url));
const imp = page => page.locator('#import');
const txn = (page, text) => imp(page).locator('.imp-row', { has: page.locator('.imp-desc', { hasText: text }) });
const picker = page => page.locator('#picker');

async function chooseFile(page, name) {
  await tab(page, 'settings');
  await page.locator('#bankFile').setInputFiles(csv(name));
  await expect(imp(page)).toBeVisible();
}

/** Import the card statement with Kmart sent to a new group typed in the picker, "School things". */
async function importWithNewGroup(page) {
  await chooseFile(page, 'commbank-credit-card.csv');
  await txn(page, 'KMART').locator('select').selectOption('pick');
  await expect(picker(page)).toBeVisible();
  await expect(picker(page)).toContainText('Create “Kmart Bondi”');          // the payee's name, before typing
  await picker(page).locator('.pick-search').fill('School things');
  await picker(page).getByRole('button', { name: /Create “School things”/ }).click();
  await expect(picker(page)).toHaveCount(0);
  await expect(txn(page, 'KMART').locator('select option:checked')).toHaveText('School things (new group)');
  await imp(page).locator('.sheet-head [data-apply]').click();
  await expect(page.locator('#toast')).toContainText('Logged');
}

test('import: type a new group in the picker; a similar payee is suggested for it next time', async ({ page }) => {
  await openWithSample(page);
  await importWithNewGroup(page);
  await tab(page, 'entries');
  await expect(row(page, 'School things')).toBeVisible();

  // Next statement: the same shop in another suburb goes to the same group, saying why
  await chooseFile(page, 'similar-payees.csv');
  await expect(txn(page, 'KMART BONDI').first().locator('select option:checked')).toHaveText('School things'); // remembered
  const sydney = txn(page, 'KMART SYDNEY');
  await expect(sydney.locator('select option:checked')).toHaveText('School things');
  await expect(sydney).toContainText('like Kmart Bondi');
  await expect(txn(page, 'UBER TRIP').locator('select option:checked')).toHaveText('+ New group: Uber Trip'); // not Uber Eats

  // Typing an existing group's name picks it rather than making a second one
  await txn(page, 'UBER EATS').locator('select').selectOption('pick');
  await picker(page).locator('.pick-search').fill('groceries');
  await expect(picker(page).locator('[data-create]')).toHaveCount(0);
  await picker(page).locator('.pick-search').press('Enter');
  await expect(txn(page, 'UBER EATS').locator('select option:checked')).toHaveText('Groceries');
});

test('Settings → Payees: change group (payments move), merge spellings, always ignore', async ({ page }) => {
  await openWithSample(page);
  await importWithNewGroup(page);
  await tab(page, 'settings');
  await page.locator('[data-action=open-payees]').click();
  const payees = page.locator('#payees');
  await expect(payees.locator('[data-payee]', { hasText: 'Kmart Bondi' })).toContainText('School things');

  // Change Kmart's group: its payment moves to Groceries
  await payees.locator('[data-payee]', { hasText: 'Kmart Bondi' }).click();
  await page.getByRole('button', { name: 'Choose a group for Kmart Bondi' }).click();
  await picker(page).locator('.pick-search').fill('Groc');
  await picker(page).locator('[data-pick]', { hasText: 'Groceries' }).click();
  await expect(page.locator('#toast')).toContainText('Kmart Bondi → Groceries · 1 payment moved');
  await expect(page.locator('#payee')).toContainText('Groceries');

  // Merge Woolworths in: one payee, two bank spellings
  await page.locator('#payee [data-merge]').click();
  await picker(page).locator('.pick-search').fill('wool');
  await picker(page).locator('[data-pick]').first().click();
  await expect(page.locator('#toast')).toContainText('Merged Woolworths Sydney into Kmart Bondi');
  await expect(page.locator('#payee')).toContainText('Bank spellings (2)');

  // Always ignore
  await page.locator('#payee [data-kind=ignore]').click();
  await expect(page.locator('#payee')).toContainText('skipped on every import');
  await page.locator('#payee [data-back]').click();
  await page.locator('#payees [data-filter=rules]').click();
  await expect(page.locator('#payees [data-payee]', { hasText: 'Kmart Bondi' })).toContainText('Always ignored');
  await page.locator('#payees [data-close]').click();

  // School things is empty now; Groceries has the Kmart payment
  await editEntry(page, 'Groceries');
  await sheetPage(page, 'transactions');
  await expect(page.locator('#payments')).toContainText('KMART');
});

test('deleting a group moves its imported payments to Ungrouped, and its payees become ungrouped', async ({ page }) => {
  await openWithSample(page);
  await importWithNewGroup(page);
  await editEntry(page, 'School things');
  await page.getByRole('button', { name: 'Delete group' }).click();
  await expect(page.locator('#toast')).toContainText('1 payment moved to Ungrouped spending');
  expect(page.dialogs.at(-1)).toContain('Its 1 imported payment will move to Ungrouped spending');
  await tab(page, 'entries');
  await expect(row(page, 'School things')).toHaveCount(0);
  await expect(row(page, 'Ungrouped spending')).toBeVisible();

  await tab(page, 'settings');
  await page.locator('[data-action=open-payees]').click();
  await page.locator('#payees [data-filter=ungrouped]').click();
  await expect(page.locator('#payees [data-payee]', { hasText: 'Kmart Bondi' })).toContainText('Ungrouped · in Ungrouped spending');
  await page.locator('#payees [data-close]').click();

  // Its payee can be moved on from Ungrouped's Accounts page
  await editEntry(page, 'Ungrouped spending');
  await sheetPage(page, 'accounts');
  await page.getByRole('button', { name: /^Move Kmart Bondi/ }).click();
  await picker(page).locator('[data-pick]', { hasText: 'Groceries' }).click();
  await expect(page.locator('#toast')).toContainText('to Groceries');
});

test('one payment can move to another group without moving its payee', async ({ page }) => {
  await openWithSample(page);
  await importWithNewGroup(page);
  await editEntry(page, 'School things');
  await sheetPage(page, 'transactions');
  const kmart = page.locator('#payments .pay-row', { hasText: 'KMART' });
  await kmart.getByRole('button', { name: 'Move this payment to another group' }).click();
  await picker(page).locator('[data-pick]', { hasText: 'Groceries' }).click();
  await expect(page.locator('#toast')).toContainText('Moved to Groceries');
  await expect(page.locator('#sheet [role=tab][data-page=transactions]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#payments .pay-row')).toHaveCount(0);
  // The payee still belongs to School things: only that payment moved
  await page.locator('#sheet .sheet-head [data-close]').click();
  await tab(page, 'settings');
  await page.locator('[data-action=open-payees]').click();
  await expect(page.locator('#payees [data-payee]', { hasText: 'Kmart Bondi' })).toContainText('School things');
});

test('budgets and "Where it goes" by group; a group shows how it was paid', async ({ page }) => {
  await openWithSample(page);
  await tab(page, 'settings');
  await page.locator('[data-action=manage-budgets]').click();
  await page.locator('#budgetForm [value=group]').check({ force: true });
  await page.locator('#budgetForm [name=label]').fill('netflix');
  await page.locator('#budgetForm [name=amount]').fill('30');
  await page.locator('[data-save-budget]').click();
  await expect(page.locator('#budgets')).toContainText('Netflix (group)');
  await page.locator('#budgets [data-close]').click();

  await tab(page, 'overview');
  await page.locator('[data-action=breakdown][data-by=group]').click();
  await expect(page.locator('[data-action=breakdown][data-by=group]')).toHaveClass(/on/);
  await expect(page.locator('section.card', { has: page.locator('h3', { hasText: 'Where it goes' }) })).toContainText('Rent');
});

test('data saved before format 5: accounts and payees are upgraded on start-up', async ({ page }) => {
  const backup = readFixture('v4-2026-11-bank-import.json');
  await page.goto('/');
  await page.evaluate(b => new Promise((resolve, reject) => {
    const req = indexedDB.open('budget-pwa', 1);
    req.onsuccess = () => {
      const tx = req.result.transaction(['entries', 'settings'], 'readwrite');
      for (const e of b.entries) tx.objectStore('entries').put(e);
      tx.objectStore('settings').put({ ...b.settings, schemaVersion: 4 }, 'settings');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  }), backup);
  await page.reload();

  await tab(page, 'settings');
  await expect(page.locator('[data-action=open-accounts]')).toContainText('CommBank account, Everyday card');
  await page.locator('[data-action=open-accounts]').click();
  await expect(page.locator('#accounts .acct-card').nth(1)).toContainText('Credit card');
  await page.locator('#accounts [data-close]').click();

  await page.locator('[data-action=open-payees]').click();
  await expect(page.locator('#payees [data-payee="pk:SUPERLOOP"]')).toContainText('Home internet');
  await expect(page.locator('#payees [data-payee="pk:SUPERLOOP LIMITED"]')).toContainText('Home internet'); // its group
  await expect(page.locator('#payees')).toContainText('Corner bakery');
  await page.locator('#payees [data-close]').click();

  // How Home internet was paid: by hand (its method, Direct debit), a direct debit, and the card
  await editEntry(page, 'Home internet');
  await expect(page.locator('#sheet .sum-break').first()).toContainText('Direct debit $178.00');
  await expect(page.locator('#sheet .sum-break').first()).toContainText('Credit card $89.00');

  const stored = await page.evaluate(() => new Promise(resolve => {
    const req = indexedDB.open('budget-pwa', 1);
    req.onsuccess = () => {
      req.result.transaction('settings').objectStore('settings').get('settings').onsuccess = e => resolve(e.target.result);
    };
  }));
  expect(stored.schemaVersion).toBe(5);
  expect(stored.payeeRules).toBeUndefined();
  expect(stored.accounts.map(a => a.name)).toEqual(['CommBank account', 'Everyday card']);
  expect(stored.payees.find(p => p.keys.includes('SUPERLOOP')).groupId).toBe('f4000000-0000-4000-8000-000000000001');
});

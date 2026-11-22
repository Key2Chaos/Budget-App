// Importing a CommBank-style statement (made-up data), as an Australian user would.
import { fileURLToPath } from 'node:url';
import { test, expect, openWithSample, tab, row, editEntry, sheetPage, fixturePath } from './helpers.mjs';

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
  // Recurring, not yet an entry: added by default
  const recurring = imp(page).locator('.label-row', { hasText: 'Disney Plus' });
  await expect(recurring).toContainText('3 × $13.99 · monthly');
  await expect(recurring.locator('[data-new]')).toHaveText('✓ Adding');
  await expect(txn(page, 'DISNEY PLUS').first().locator('select option:checked')).toHaveText('+ New entry: Disney Plus (monthly)');
  // Switching one off sends its transactions to the catch-all instead
  const google = imp(page).locator('.label-row', { hasText: 'Google' });
  await google.locator('[data-new]').click();
  await expect(google.locator('[data-new]')).toHaveText('Add as entry');
  await expect(txn(page, 'GOOGLE').first().locator('select option:checked')).toHaveText('Everyday spending – CommBank credit card');

  // Everything else imports into the catch-all unless you choose
  await expect(txn(page, 'KMART').locator('select option:checked')).toHaveText('Everyday spending – CommBank credit card');
  // Paying off the card is a transfer between your accounts, not income
  await expect(imp(page)).toContainText('Transfers between your accounts (1)');
  await expect(txn(page, 'PAYMENT RECEIVED').locator('select option:checked')).toHaveText('Transfer between my accounts');
  await expect(txn(page, 'PAYMENT RECEIVED')).toContainText('looks like a transfer');
  await txn(page, 'WOOLWORTHS').locator('select').selectOption('ignore-payee');
  await txn(page, 'KMART').locator('select').selectOption('');                     // decide later
  await page.screenshot({ path: test.info().outputPath('import-review.png'), fullPage: true });

  await imp(page).locator('.sheet-head [data-apply]').click();
  await expect(page.locator('#toast')).toContainText('added 2 entries');           // Disney Plus + Everyday spending
  await expect(page.locator('#toast')).toContainText('1 transfer');
  await expect(page.locator('#toast')).toContainText('ignored 1');

  await tab(page, 'entries');
  await expect(row(page, 'Disney Plus')).toContainText('Monthly');
  await expect(row(page, 'Disney Plus')).toContainText('Last $13.99 on 3 Nov');
  await expect(row(page, 'Car insurance')).toContainText('Last $56.00 on 18 Nov');
  await expect(row(page, 'Everyday spending – CommBank credit card')).toContainText('Variable');
  await expect(row(page, 'Other income – CommBank credit card')).toHaveCount(0);

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
  await sheetPage(page, 'transactions');
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
  await sheetPage(page, 'transactions');
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
  await expect(page.locator('#toast')).toContainText('Renamed');
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

  // Remove only the imported payments (keep remembered matches)
  await tab(page, 'settings');
  await page.locator('[data-action=undo-imports]').click();
  const undo = page.locator('#undoImports');
  await expect(undo).toContainText(/Remove \d+ imported payments/);
  await undo.locator('[name=rules]').uncheck();
  await undo.locator('[data-undo]').click();
  await expect(page.locator('#toast')).toContainText('Bank imports undone');

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
  await expect(page.locator('[data-action=undo-imports]')).toBeVisible();
  await page.locator('[data-action=forget-rules]').click();
  await expect(page.locator('#toast')).toContainText('Remembered matches forgotten');
  await expect(page.locator('[data-action=forget-rules]')).toHaveCount(0);
});

test('undo bank imports also deletes the entries imports added, so they stop matching', async ({ page }) => {
  await openWithSample(page);
  await chooseFile(page, 'commbank-credit-card.csv');
  await txn(page, 'WOOLWORTHS').locator('select').selectOption('ignore');
  await imp(page).locator('.sheet-head [data-apply]').click();
  // Disney Plus, Google One and Everyday spending (the card payment is a transfer, not income)
  await expect(page.locator('#toast')).toContainText('added 3 entries');

  await tab(page, 'settings');
  await page.locator('[data-action=undo-imports]').click();
  const undo = page.locator('#undoImports');
  await expect(undo).toContainText('Entries added by imports (3) — switch off any to keep');
  await undo.screenshot({ path: test.info().outputPath('undo-imports.png') });
  await undo.locator('label', { hasText: 'Google One' }).locator('[name=del]').uncheck();   // keep this one
  await undo.locator('[data-undo]').click();
  await expect.poll(() => page.dialogs.at(-1)).toMatch(/Delete \d+ payments and 2 entries/);
  await expect(page.locator('#toast')).toContainText('Bank imports undone');

  await tab(page, 'entries');
  await expect(row(page, 'Disney Plus')).toHaveCount(0);
  await expect(row(page, 'Everyday spending – CommBank credit card')).toHaveCount(0);
  await expect(row(page, 'Google One')).toHaveCount(1);

  // Importing again: Disney is a suggestion again, not matched to anything; ignored rows come back
  await chooseFile(page, 'commbank-credit-card.csv');
  await expect(imp(page)).not.toContainText('already imported or ignored');
  await expect(imp(page).locator('.label-row', { hasText: 'Disney Plus' })).toContainText('Adding');
  await expect(txn(page, 'DISNEY PLUS').first()).not.toContainText('remembered');
  await expect(txn(page, 'WOOLWORTHS')).toHaveCount(1);
  await expect(txn(page, 'PAYMENT RECEIVED')).toHaveCount(1);                    // transfers come back too
  await expect(txn(page, 'GOOGLE').first().locator('select option:checked')).toHaveText('Google One'); // kept entry, matched by name
});

test('with no entries yet, any transaction can start a new entry', async ({ page }) => {
  await page.goto('/');
  await chooseFile(page, 'commbank-credit-card-padded.csv');
  const grocer = txn(page, 'GROCER 0412');
  await expect(grocer.locator('option[disabled]').first()).toHaveText('No entries yet');
  // Two purchases from the same shop share a row, and become a "no set schedule" entry
  await expect(grocer).toContainText('2 ×');
  await expect(grocer).toContainText('GROCER 0398');                     // listed under it
  await grocer.locator('select').selectOption({ label: '+ New entry: Grocer' });
  await expect(grocer.locator('select option:checked')).toHaveText('+ New entry: Grocer');
  // A one-off
  await txn(page, 'CAFE EXAMPLE').locator('select').selectOption({ label: '+ New entry: Cafe Example' });
  // A recurring payee offers its schedule
  await txn(page, 'STREAMCO').first().locator('select').selectOption({ label: '+ New entry: Streamco (monthly)' });
  await expect(imp(page).locator('.label-row', { hasText: 'Streamco' })).toContainText('Adding');
  await imp(page).locator('.sheet-head [data-apply]').click();
  // Grocer, Cafe Example, Streamco and Netloop (recurring, added by default); the card payment is a transfer
  await expect(page.locator('#toast')).toContainText('added 4 entries');

  await tab(page, 'entries');
  await expect(row(page, 'Netloop')).toContainText('Monthly');
  await expect(row(page, 'Grocer')).toContainText('Variable');
  await expect(row(page, 'Grocer')).toContainText('Last $82.10');
  await expect(row(page, 'Streamco')).toContainText('Monthly');
  await expect(row(page, 'Cafe Example')).toContainText('$4.50');
});

test('unmatched: one row per payee; giving two payees the same name puts them together', async ({ page }) => {
  await openWithSample(page);
  await chooseFile(page, 'commbank-credit-card.csv');
  const google = txn(page, 'GOOGLE');
  await expect(google).toHaveCount(1);
  await expect(google).toContainText('3 ×');
  await expect(google).toContainText('−$13.47');
  await google.locator('summary').click();
  await expect(google.locator('.imp-sub')).toHaveCount(3);
  await expect(google.locator('.imp-sub').first()).toBeVisible();

  const nameIt = async text => {
    page.answers.push('Shopping');
    await txn(page, text).getByRole('button', { name: /^(Rename|Name)/ }).click();
  };
  await nameIt('KMART');
  await nameIt('WOOLWORTHS');
  const shopping = imp(page).locator('.imp-payee', { has: page.locator('.imp-name', { hasText: 'Shopping' }) });
  await expect(shopping).toHaveCount(1);
  await expect(shopping).toContainText('2 ×');
  await expect(google.locator('details')).toHaveAttribute('open', '');     // stays open across redraws
  await page.screenshot({ path: test.info().outputPath('import-payees.png'), fullPage: true });

  await shopping.locator('select').selectOption({ label: '+ New entry: Shopping' });
  // Other payees can now be put in with it
  await expect(google.locator('optgroup[label="New in this import"] option', { hasText: 'Shopping' })).toHaveCount(1);
  await imp(page).locator('.sheet-head [data-apply]').click();
  await expect(page.locator('#toast')).toContainText('Logged');
  await editEntry(page, 'Shopping');
  await expect(page.locator('#payments .pay-row')).toHaveCount(2);
});

test('everything imports by default; payees can be moved out of the catch-all later', async ({ page }) => {
  await openWithSample(page);
  await chooseFile(page, 'commbank-credit-card.csv');
  await imp(page).locator('.sheet-head [data-apply]').click();       // no choices made at all
  await expect(page.locator('#toast')).toContainText('Logged');

  const everyday = 'Everyday spending – CommBank credit card';
  await editEntry(page, everyday);
  await expect(page.locator('#sheet .payee-row').first()).toBeHidden();     // payees are on the Accounts page
  await sheetPage(page, 'accounts');
  await expect(page.locator('#sheet .tab-panel.on')).toContainText('CommBank credit card');
  const payees = page.locator('#sheet .payee-row');
  await expect(page.locator('#sheet')).toContainText('Payees (');
  const before = await payees.count();
  await page.locator('#sheet .payee-row').first().locator('xpath=ancestor::section').screenshot({ path: test.info().outputPath('payees.png') });
  // Move Kmart into an entry of its own
  const moveSel = name => page.locator('#sheet').getByRole('combobox', { name: new RegExp(`^Move ${name}`) });
  await moveSel('Kmart').selectOption({ label: '+ New entry: Kmart Bondi' });
  await expect(page.locator('#toast')).toContainText('Moved 1 payment to Kmart Bondi');
  await expect(page.locator('#sheet[open]')).toBeVisible();                // still here, ready for the next one
  await expect(page.locator('#sheet [role=tab][data-page=accounts]')).toHaveAttribute('aria-selected', 'true');
  await expect(moveSel('Kmart')).toHaveCount(0);
  await expect(payees).toHaveCount(before - 1);
  await expect(page.locator('#sheet .payee-row')).not.toHaveCount(0);       // a catch-all lists even its last payee
  // Move Woolworths to an existing entry
  await moveSel('Woolworths').selectOption({ label: 'Groceries' });
  await expect(page.locator('#toast')).toContainText('to Groceries');
  await page.locator('#sheet .sheet-head [data-close]').click();

  await tab(page, 'entries');
  await expect(row(page, 'Kmart Bondi')).toContainText('$');
  await expect(row(page, 'Groceries')).toContainText('Last $');
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

test('transfers: a card payment already in Everyday spending is taken out when the card is imported', async ({ page }) => {
  await openWithSample(page);
  // The savings statement on its own can't tell that this transfer paid off the card
  await chooseFile(page, 'savings-card-payoff.csv');
  await expect(txn(page, 'Transfer to xx1234').locator('select option:checked')).toHaveText('Everyday spending – CommBank account');
  await imp(page).locator('.sheet-head [data-apply]').click();
  await expect(page.locator('#toast')).toContainText('Logged 2 payments');

  // The card statement has the other side: +$250 a day later
  await chooseFile(page, 'commbank-credit-card.csv');
  await page.locator('#impAccountPick').selectOption('');
  await expect(page.locator('#impAccount')).toHaveValue('CommBank credit card');
  const pay = txn(page, 'PAYMENT RECEIVED');
  await expect(pay.locator('select option:checked')).toHaveText('Transfer between my accounts');
  await expect(pay).toContainText('↔ CommBank account 19 Nov');
  await expect(imp(page)).toContainText('taken out of it');
  await imp(page).locator('.sheet-head [data-apply]').click();
  await expect(page.locator('#toast')).toContainText('1 transfer (1 taken out of spending)');

  // Only the bakery is left in the savings account's spending, and the card payment isn't income
  await editEntry(page, 'Everyday spending – CommBank account');
  await expect(page.locator('#payments .pay-row')).toHaveCount(1);
  await expect(page.locator('#payments .pay-row [name=payamount]')).toHaveValue('31.20');
  await page.locator('.sheet-head button:has-text("Cancel")').first().click();
  await tab(page, 'entries');
  await expect(row(page, 'Other income – CommBank credit card')).toHaveCount(0);

  // Importing the savings file again doesn't bring the transfer back
  await chooseFile(page, 'savings-card-payoff.csv');
  await expect(imp(page)).toContainText('Nothing new in this file.');
});

test('refunds: money back from a shop goes with its purchases, not to income', async ({ page }) => {
  await openWithSample(page);
  await chooseFile(page, 'card-with-refund.csv');
  const kmart = txn(page, 'KMART');
  await expect(kmart).toHaveCount(1);                                   // purchase and refund share a row
  await expect(kmart).toContainText('2 ×');
  await expect(kmart).toContainText('−$25.50');
  await expect(kmart.locator('select option:checked')).toHaveText('Everyday spending – CommBank credit card');
  await imp(page).locator('.sheet-head [data-apply]').click();
  await expect(page.locator('#toast')).toContainText('added 1 entry');  // Everyday spending only

  await editEntry(page, 'Everyday spending – CommBank credit card');
  const amounts = await page.locator('#payments .pay-row').evaluateAll(rows => rows.map(r =>
    `${r.querySelector('[name=paysign]').value === '-1' ? '-' : ''}${r.querySelector('[name=payamount]').value}`));
  expect(amounts.sort()).toEqual(['-12.00', '37.50', '5.00']);
  await page.locator('.sheet-head button:has-text("Cancel")').first().click();
  await tab(page, 'entries');
  await expect(row(page, 'Other income – CommBank credit card')).toHaveCount(0);

  // Next time, a refund from them on its own still goes there
  await chooseFile(page, 'commbank-credit-card.csv');
  await expect(txn(page, 'KMART').locator('select option:checked')).toHaveText('Everyday spending – CommBank credit card');
});

test('undo last import: takes back only the latest import, and can be repeated', async ({ page }) => {
  await openWithSample(page);
  await chooseFile(page, 'commbank-credit-card.csv');
  await imp(page).locator('.sheet-head [data-apply]').click();
  await expect(page.locator('#toast')).toContainText('added 3 entries');   // Disney Plus, Google One, Everyday spending
  await chooseFile(page, 'card-with-refund.csv');
  await expect(page.locator('#impAccountPick')).toHaveValue('CommBank credit card');
  await imp(page).locator('.sheet-head [data-apply]').click();
  await expect(page.locator('#toast')).toContainText('Logged 3 payments');

  // Undo the second one: its payments go, the entries the first one added stay
  await tab(page, 'settings');
  const undoRow = page.locator('[data-action=undo-last-import]');
  await expect(undoRow).toContainText('card-with-refund.csv into CommBank credit card');
  await undoRow.click();
  await expect.poll(() => page.dialogs.at(-1)).toMatch(/This removes 3 payments\./);
  await expect(page.locator('#toast')).toContainText('Import undone');
  await editEntry(page, 'Everyday spending – CommBank credit card');
  await expect(page.locator('#payments .pay-row [name=payamount][value="5.00"]')).toHaveCount(0);       // the cafe, from the second
  await expect(page.locator('#payments .pay-row [name=payamount][value="23.40"]')).toHaveCount(1); // Woolworths, from the first
  await page.locator('.sheet-head button:has-text("Cancel")').first().click();

  // The file can be imported again as new
  await chooseFile(page, 'card-with-refund.csv');
  await expect(imp(page)).not.toContainText('already imported or ignored');
  await imp(page).locator('.sheet-head [data-close]').click();

  // Undo the first one too: the entries it added go, and its transactions come back as new
  await tab(page, 'settings');
  await expect(undoRow).toContainText('commbank-credit-card.csv');
  await undoRow.click();
  await expect.poll(() => page.dialogs.at(-1)).toMatch(/the 3 entries it added \(.*Disney Plus.*\)/);
  await expect(page.locator('#toast')).toContainText('Import undone');
  await expect(undoRow).toHaveCount(0);
  await tab(page, 'entries');
  await expect(row(page, 'Disney Plus')).toHaveCount(0);
  await expect(row(page, 'Everyday spending – CommBank credit card')).toHaveCount(0);
  await chooseFile(page, 'commbank-credit-card.csv');
  await expect(imp(page)).not.toContainText('already imported or ignored');
  await expect(txn(page, 'PAYMENT RECEIVED')).toHaveCount(1);                 // the transfer comes back too
  await expect(txn(page, 'NETFLIX.COM').first()).not.toContainText('remembered');
});

test('balance column: checked against the amounts, and sets "Balance now"', async ({ page }) => {
  await openWithSample(page);
  await chooseFile(page, 'commbank-savings.csv');
  await expect(imp(page).locator('#impCheck')).toContainText('The amounts add up with the Balance column');
  await expect(page.locator('#impBalance')).toBeChecked();                   // no balance yet
  await expect(imp(page)).toContainText('$3,798.40 on 15 Nov');
  await imp(page).locator('.sheet-head [data-apply]').click();
  await tab(page, 'overview');
  await expect(page.locator('#balance')).toHaveValue('3798.40');
  await expect(page.locator('.balance-row')).toContainText('from the CommBank account statement');

  // A balance you type yourself isn't replaced by default
  await page.locator('#balance').fill('500');
  await page.locator('#balance').blur();
  await chooseFile(page, 'savings-card-payoff.csv');
  await page.locator('#impAccountPick').selectOption('CommBank account');
  await expect(page.locator('#impBalance')).not.toBeChecked();
});

test('money out shown as "+": the balances spot it and the signs are switched', async ({ page }) => {
  await openWithSample(page);
  await chooseFile(page, 'money-out-positive.csv');
  await expect(imp(page).locator('#impCheck')).toContainText('This file shows money out as “+”');
  await expect(imp(page).locator('[data-flip="1"]')).toHaveClass(/on/);
  await expect(txn(page, 'COFFEE CART')).toContainText('−$4.50');
  // Switching it back shows why
  await imp(page).locator('[data-flip="0"]').click();
  await expect(imp(page).locator('#impCheck')).toContainText('doesn’t add up with the amounts on 2 of 2 rows');
  await expect(imp(page).locator('#impCheck')).toContainText('It does with money out as “+”');
  await expect(txn(page, 'COFFEE CART')).toContainText('+$4.50');
});

test('several files at once: each has its own account, and transfers between them are paired', async ({ page }) => {
  await openWithSample(page);
  await tab(page, 'settings');
  await page.locator('#bankFile').setInputFiles([csv('savings-card-payoff.csv'), csv('commbank-credit-card.csv'), fixturePath('v1-2026-11-initial-release.json')]);
  await expect(imp(page)).toBeVisible();
  await expect.poll(() => page.dialogs.at(-1)).toMatch(/“v1-2026-11-initial-release.json” wasn’t recognised as a bank statement and will be left out/);
  await expect(imp(page).locator('h2')).toHaveText('Import 2 statements');
  await expect(page.locator('#impAccount')).toHaveValue('CommBank account');
  await expect(page.locator('#impAccount-1')).toHaveValue('CommBank credit card');
  await expect(page.locator('#impCheck')).toContainText('The amounts add up');      // the savings file, on its own
  await expect(page.locator('#impCheck-1')).toHaveCount(0);                        // the card file has no balances

  // Paying off the card: both sides are in this import
  await expect(imp(page)).toContainText('Transfers between your accounts (2)');
  await expect(txn(page, 'Transfer to xx1234')).toContainText('↔ CommBank credit card 20 Nov');
  await expect(txn(page, 'PAYMENT RECEIVED')).toContainText('↔ CommBank account 19 Nov');
  // Each account's unmatched spending goes to its own catch-all
  await expect(txn(page, 'BAKERY').locator('select option:checked')).toHaveText('Everyday spending – CommBank account');
  await expect(txn(page, 'KMART').locator('select option:checked')).toHaveText('Everyday spending – CommBank credit card');
  // Matched rows need no attention
  await expect(imp(page).locator('.imp-matched > summary')).toContainText('nothing to do');
  await imp(page).locator('.sheet-head [data-apply]').click();
  await expect(page.locator('#toast')).toContainText('2 transfers');

  await editEntry(page, 'Everyday spending – CommBank account');
  await expect(page.locator('#payments .pay-row')).toHaveCount(1);                  // just the bakery
  await page.locator('.sheet-head button:has-text("Cancel")').first().click();
  await tab(page, 'settings');
  await expect(page.locator('[data-action=undo-last-import]')).toContainText('2 files into CommBank account, CommBank credit card');
});

test('several files: same kind of account over the same dates are two accounts; different months are one', async ({ page }) => {
  await openWithSample(page);
  await tab(page, 'settings');
  await page.locator('#bankFile').setInputFiles([csv('commbank-savings.csv'), csv('second-account.csv')]);
  await expect(page.locator('#impAccount')).toHaveValue('CommBank account');
  await expect(page.locator('#impAccount-1')).toHaveValue('CommBank account 2');    // 12–16 Nov overlaps 10 Aug – 15 Nov
  await imp(page).locator('.sheet-head [data-close]').click();
  await expect(page.locator('#sheet #import')).toHaveCount(0);                      // closed, and Settings redrawn

  await page.locator('#bankFile').setInputFiles([csv('commbank-savings.csv'), csv('savings-card-payoff.csv')]);
  await expect(imp(page)).toBeVisible();
  await expect(page.locator('#impAccount')).toHaveValue('CommBank account');
  await expect(page.locator('#impAccount-1')).toHaveValue('CommBank account');      // 18–19 Nov: the next statement
  // Only one statement can set "Balance now"
  await expect(page.locator('#impBalance-1')).toBeChecked();                        // the newer one
  await expect(page.locator('#impBalance')).not.toBeChecked();
  await page.locator('#impBalance').check();
  await expect(page.locator('#impBalance-1')).not.toBeChecked();
});

test('a long list of matches is folded away: nothing to do unless you want to review it', async ({ page }) => {
  await openWithSample(page);
  await chooseFile(page, 'many-matches.csv');
  const matched = imp(page).locator('.imp-matched');
  await expect(matched.locator('> summary')).toContainText('✓ 9 transactions going to 9 entries, nothing to do.');
  await expect(matched).not.toHaveAttribute('open', '');
  await expect(txn(page, 'NETFLIX').locator('select')).toBeHidden();
  await matched.locator('> summary').click();
  await expect(txn(page, 'NETFLIX').locator('select option:checked')).toHaveText('Netflix');
  await expect(matched.locator('> summary')).toContainText('Hide');
  // Stays open while you change things
  await txn(page, 'NETFLIX').locator('select').selectOption('');
  await expect(matched).toHaveAttribute('open', '');
  await imp(page).locator('.sheet-head [data-apply]').click();
  await expect(page.locator('#toast')).toContainText('Logged 10 payments');           // 8 matches (Netflix skipped), the gym and the corner shop
});

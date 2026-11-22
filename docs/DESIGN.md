# Design: Accounts, Payees, Groups, Categories and Tags

Status: **built** (23 Nov 2026, format v5). The design was agreed on 22 Nov 2026, with the
proposals in section 6 accepted as written. Section 8 lists where the build differs from this
design and what isn't built yet. All examples are made up.

## Why

The app grew around **entries**: a bill or an income line. Bank import then added more ideas, but
none of them has a proper home:

- **Payees** exist only as bank-text keys. Your names for them are kept in `settings.payeeNames`,
  and where each one goes is kept in `settings.payeeRules`.
- **Your accounts** are plain strings (`settings.bankAccounts`, `accountNames`, `payment.account`).
  They overlap with the free-text *payment method* on entries.
- **Entries already act as groups of payees.** Catch-alls, "very similar payees share one", and
  *Payees → Move to…* all put several payees into one entry. But you can only see this during
  import, or by using a dropdown.

The aim is a model you can see and control. Categories and tags stay as they are. Your accounts and
payees become things in their own right. Payees can be put into groups, and the app suggests the
group, the way import does today.

## 1. The model: one job per concept

| Concept | Answers | Belongs to | How many |
|---|---|---|---|
| **Account** (yours) | Where did the money leave from, or arrive in? | each transaction | exactly one |
| **Payee / payer** | Who was on the other side? | each transaction (optional when logged by hand) | one |
| **Group** | Which company or thing is this really? | each payee; one transaction can be overridden | exactly one per payee |
| **Payment method** | How did the money move? | each transaction; the group has a default | one |
| **Category** | What kind of spending is it? | each group | exactly one |
| **Tags** | Anything that cuts across the others | groups, and optionally single transactions | any number |

Reports go **Category → Group → Payee → Transaction**. Account, method and tags are filters that
apply across all of these.

A **group** is what an "entry" is today. It holds the schedule (or "no set schedule"), the amount
estimate, contract dates, your share %, and the payments. It can have no payees, one, or many.

### Decided

- **Name:** the app calls them **Groups**. "Bucket" and "Budget line" sounded too much like
  categories.
- **Main purpose:** to collect the payments to *one company* that show up on statements under
  different text, payment forms or accounts. For example, "TELSTRA BPAY 1234", "Telstra Direct
  Debit" and "TELSTRA CORP card" all go to the group *Telstra*. You can also put several companies
  together (*Coffee* = three cafés), but the suggestions are tuned for the one-company case.
- **One group per payee.** Totals always add up and nothing is counted twice. Use tags when things
  overlap.
- **A new payee that matches nothing gets a group of its own**, as today, unless a similar payee or
  a match suggests an existing group.
- **Payment method stays on each transaction.** The group has a *default method*, used for payments
  you log by hand. The group's Summary shows a **breakdown by method and by account**, e.g. "BPAY
  $240 · Card $55".

## 2. Data (format v5)

```text
accounts: [{ id, name, kind, importKeys: [], archived }]
            kind: 'transaction' | 'savings' | 'credit' | 'cash' | 'other'
payees:   [{ id, name, bankKeys: [], groupId | null, rule: null | 'ignore' | 'transfer', notes }]
groups:   today's entries (method becomes the default method)
payment:  { …as today, payeeId, accountId, method, groupOverride?, splits? }
```

- `importKeys` keeps each account's original lowercase name, which is part of every transaction id.
  Renaming an account never breaks duplicate detection (the same idea as `accountNames` today).
- `bankKeys` lets several bank spellings be **the same payee** ("SUPERLOOP LTD", "Superloop
  Limited"). This is **merging**. **Grouping** is different: it puts separate payees together.
- A group's payees are worked out from `payee.groupId`, not stored on the group, so the two can
  never disagree.
- `payment.method` for imports is guessed from the bank text (BPAY, direct debit, card, PayID/Osko,
  transfer). When the text gives no clue, it comes from the account's kind.

**Migration v4 → v5** (a new step in `MIGRATIONS`, see README → "Keeping old backups working"):

1. First save a v4 backup as `tests/fixtures/v4-…json`.
2. Build `accounts` from `bankAccounts` + `accountNames`. Build `payees` from `payeeNames` +
   `payeeRules`: an entry id becomes `groupId`, and `'ignore'` / `'transfer'` become `rule`.
3. Replace `payment.payee` / `payment.account` keys with ids. Copy each entry's method onto its
   payments that don't have one.
4. Keep the old fields so nothing is lost. Unknown fields are already kept.

## 3. Choosing a group: the picker

One control, used everywhere you choose a group: the import review rows, *Payees → Move to…*, the
payee screen, and a single transaction's override.

```text
Superloop  →  [ Internet ▾ ]

  🔍 sup|
  Suggested
    Internet            ← same company in another account
    Phone & data
  All groups
    Coffee
    Groceries
    …
  + Create "Superloop"
```

- Typing filters the list. **Suggested** (up to 3) comes first, then **All groups** A–Z, then
  **+ Create "…"** with what you typed.
- If what you typed matches an existing group's name (ignoring case), that group is picked instead
  of a duplicate being created.
- Creating a group asks only for its name. Its category and type are filled in from the suggestions,
  and you can change them later.
- Categories get the same control. They already match spellings, so "groceries" becomes
  "Groceries".

## 4. How the app helps

Most of this already exists in `js/bank.js`. The new parts are marked.

| Help | Built on |
|---|---|
| Suggest a group from the name, amount and date | `matchDetail`, `suggest` |
| Suggest similar payees for the same group ("Kmart Bondi" + "Kmart Sydney") | `similarPayees`, `clusterPayees` |
| **New:** same company, different payment form. Strip payment words (BPAY, DD, Direct Debit, reference numbers) before comparing, so "TELSTRA BPAY 1234" and "TELSTRA CORP LTD" suggest the same group | extends `payeeKey` and `similarPayees` |
| **New:** same company, different account. A payee seen in a second account suggests the group it already has | small |
| Name a new group after what its payees have in common | `commonName`, `payeeName` |
| A recurring payee gets a group with a schedule | `findRecurring` |
| Refunds go to the same group as the payee's purchases | `suggestRefunds` |
| Transfers between your own accounts aren't counted as spending or income | `findTransfers`, `looksLikeTransfer` |
| **New:** suggest a category for a new group from the groups of similar payees | small |
| Only deliberate choices are remembered, never a match on amount alone | existing rule |

## 5. Screens

- **Accounts** (new list): balance now (from the last import), money in and out this month,
  transfers. Tap an account to see its transactions.
- **Payees** (new list): search, total, group, and an *Ungrouped* filter. Tap a payee to rename it,
  merge another payee into it, change its group, or set it to ignore / transfer.
- **Group** (today's entry sheet): the Summary, Transactions and Accounts pages stay.
  - Summary adds the breakdown by method and by account.
  - Accounts adds a **Payees** section with *Add payee…* and *Move to…*, both using the picker.
- **Overview → Where it goes:** group by Category, Group, Payee, Account, Method or Tag.
- **Wording:** the UI says "Group" wherever it says "Entry" today. The code can keep `entries`
  internally to avoid a risky rename. *(Decide during cleanup.)*

## 6. Decisions on the details

Agreed 22 Nov 2026: each proposal below is the plan.

1. **Splits:** one transaction across groups, e.g. a supermarket shop that includes a gift card
   (backlog #12). *Proposal:* build it later, but reserve `payment.splits` now so it fits.
2. **Override one transaction:** an Amazon order that belongs to another group, without moving the
   payee. *Proposal:* `payment.groupOverride`, set from the transaction's row.
3. **Deleting a group.** *Proposal:* its payees and their payments move to *Ungrouped*. Nothing is
   lost.
4. **A payee who is also a payer** (refunds, selling something to a friend). *Proposal:* one payee.
   The sign of each amount says which way the money went.
5. **Payments logged by hand.** *Proposal:* the payee and account are optional. The method
   defaults to the group's.
6. **Budgets.** *Proposal:* add budgets per group, next to category and tag budgets.
7. **Archiving.** *Proposal:* archived groups and accounts are hidden from pickers but kept in the
   history and totals.
8. **Undo import / Undo bank imports.** *Proposal:* these also remove the payees and groups an
   import created, unless you've changed them since.
9. **Spreadsheet export.** *Proposal:* add account, payee and method columns, plus a payees CSV.
10. **Accounts in Until payday.** *Proposal:* "Balance now" comes from your chosen account(s), not
    from a single typed number.

## 7. After this doc is agreed

1. **Cleanup, with no change in behaviour.** *Done 22 Nov 2026.*
   - `js/app.js` (about 2,600 lines) is split into one file per screen, kept flat in `js/` (see the
     README's project layout). `core.js` holds shared state and helpers, and imports no other UI
     file.
   - The import screens are in `js/importer.js`. `bank.js` stays pure.
   - `npm test` (76) and `npm run test:e2e` (56) passed before and after.
   - The shared picker (`js/picker.js`) comes with the build, since nothing uses it yet.
2. **Build, in this order:**
   1. format v5, its migration and the fixture
   2. accounts
   3. payees
   4. the group picker
   5. import using payees and groups
   6. screens
   7. reports and budgets

   Then bump `VERSION` in `sw.js` and update the README and BACKLOG.
3. **Push:** a branch and a PR, as before.

**Tests to add:**
- the v4 fixture upgrades with nothing lost
- picker: pick an existing group, create a new one, and type a name that already exists
- move a payee, and merge two payees
- delete a group, and its payees become *Ungrouped*
- all of the above in the Australia/Sydney run

## 8. As built (23 Nov 2026)

The model, screens and help above are built in format v5. The code is in `js/model.js` (accounts
and payees), `js/picker.js`, `js/sheet-accounts.js` and `js/sheet-payees.js`, plus changes to the
importer and the group (entry) sheet.

**Where the build differs from the design, and why**

- **Accounts are keyed by the name first imported under**, as `{ key, name, kind, balance }`. The
  design had an id plus `importKeys`. The key is already part of every transaction id and of
  `payment.account`, so no payment had to be rewritten.
- **Payees keep their bank keys, and payments keep `payee` as a key**, not a `payeeId`. A payee is
  found from any of its keys. Migrated payees get the id `pk:<key>`; new ones get a random id.
- **The importer still works with key → group maps.** `rulesMap` / `applyRules` (and the same for
  names) translate between those maps and payee records. This kept the tested matching, undo and
  transfer logic unchanged.
- **Payment method:** imported payments get a stored `method`, guessed from the bank text or the
  account type. Payments logged by hand don't store one. They show the group's method, so changing
  the group's default updates them.
- **One payment in another group** is done by *moving* that payment (**Move…** on its row), not with
  a `groupOverride` field. The payee's group doesn't change.
- **Group budgets** store the group's id as well as its name, so renaming the group keeps the budget.

**Not built yet** (also in BACKLOG):

- **Splits** (one transaction across groups).
- **Choosing a payee or account for a payment logged by hand.**
- **Archiving** groups and accounts.
- **"Where it goes" by payee, account or method.** Only by Group is new. Breakdowns by method and
  account are on each group's Summary, and money in and out per account is on the Accounts sheet.
- **"Balance now" as the total of chosen accounts.** Each account stores its own latest balance;
  *Balance now* still works as before.


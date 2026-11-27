# Budget

An offline-first PWA for tracking recurring bills, subscriptions, contracts and income on iPhone.
No backend, no account. All data lives on the device in IndexedDB.

## Features

- **Payee groups** (called *entries*, then *groups*, before Nov 2026): each bill, subscription, income or kind of spending
  is a group. A group collects the payments to one company, even when your statements show it in
  different ways or from different accounts. For example, "TELSTRA BPAY 1234", "Telstra Direct
  Debit" and a Telstra card payment all go to *Telstra*. A group can also pool several companies,
  e.g. *Coffee* for three cafés. See [docs/DESIGN.md](docs/DESIGN.md).
  - **Choosing a group** works the same way everywhere: start typing, pick a suggestion or any
    group, or tap **+ Create “…”** to make a new one. If what you type matches an existing group's
    name, that group is picked instead of a duplicate being made.
  - Each group's **Summary** shows how it was paid, e.g. "Paid by BPAY $240 · Card $55", and from
    which accounts.
  - **Move…** on a payment moves just that payment to another group.
  - **Merge into another group…** (on a group's Summary page) moves all of a group's payments,
    payees and budget into another group and removes it. Use it when the same company ended up in
    two groups.
  - **Empty groups tidy themselves up.** When a move or merge leaves a group the app made (on an
    import, or by typing a name in the picker) with no payments and no payees, it's removed. Groups
    you set up yourself, like a monthly bill, always stay. Merging two payees puts all their
    payments in one group: the payee's group, or the one that already has most of them.
  - **Deleting a group** moves its imported payments to *Ungrouped spending* (or income). Nothing
    imported is lost, and its payees can be put in another group.
- **Payee groups on a computer** are a table: name and tags, category, schedule, next due, amount,
  what each costs a month (or a year, or the last 12 months, following the Overview's switch) and
  when it was last paid. Click a heading to sort by it, and again to reverse it; it starts with the
  biggest a month first. Click a row to open the group. A phone keeps the list (Recurring, One-off,
  Ended).
- **Payees and Accounts in the sidebar** on a computer, under *Your data* (on a phone they stay in
  Settings).
  - **Payees** is a page of its own there: a table of every payee with the bank's text, their payee
    group (or *Ungrouped · in …*, *Always ignored*, *Transfer*), number of payments, total and last
    paid. Search, filter (All, Ungrouped, Ignored & transfers) and click headings to sort.
  - Tick several payees and **Put in payee group…** (their payments move there, and future imports
    follow), **Always ignore** or **Transfer** in one go. Click a payee to rename it or merge
    spellings, as in Settings → Payees.
- **Transactions** (its own tab): every payment in every payee group in one table — date, payee,
  payee group, category, account, method and amount.
  - Search (payees, the bank's text, notes, amounts), choose a period (this month, last 12 full
    months, a custom range…), and filter by money in or out, category, payee group, account or
    method. Tag filters apply here too.
  - On a computer, click a column heading to sort by it, and again to reverse it. On a phone,
    *Filters & sort* opens the same filters and a Sort menu.
  - Tick payments (or *Select all*) and **Move to…** another payee group in one go. Groups the app
    made that are left empty are removed, as with every move.
  - **By payee group** shows each group's total for the payments shown and, for whole months, what
    the Overview counts for it: the payments logged, plus the schedule for any days they don't
    cover. That's why the two can differ (e.g. a bill due later this month).
- **Click a figure on the Overview to see the payments behind it**: Income, Expenses, a budget, a
  *Where it goes* bar (category, payee group or tag), or *See the payments ›* under a month on the
  chart. The Transactions tab opens already filtered, with *‹ Overview* to go back. Opening a tag's
  payments turns that tag's filter on.
- **Payees** (Settings → Payees): who you pay and who pays you, from bank imports. Each payee is in
  one group, so totals always add up.
  - Rename a payee, or choose its group. Its payments move there, and future imports follow.
  - Set a payee to *Always ignore* or *Transfer*.
  - **Merge** two bank spellings of the same payee.
  - Filter by *Ungrouped* to see what still needs a home.
- **Accounts** (Settings → Accounts): your bank accounts and cards, with their type, the balance
  from the latest statement, money in and out this month, and their transactions. Renaming one is
  safe.
- **Income and expenses**, each with a name, amount, frequency (one-off, weekly, fortnightly,
  4-weekly, monthly, quarterly, 6-monthly, yearly or **variable**), first payment date, category and
  payment method.
- **No set schedule** (called *Variable* before Nov 2026; not the same as *Amount varies*): for things paid whenever, like prepaid top-ups or fuel.
  - The amount is optional, and means "about per month".
  - There are no due dates, so these never show as upcoming or overdue.
  - Each month counts what you actually logged: imported or typed payments land on the day they
    were paid, rather than being spread over a period.
  - The estimate is the monthly average of the last 12 complete months, once there have been at
    least 3 payments in them (one or two big purchases aren't a habit, so they aren't forecast).
  - *Don't forecast*: for a project or one-off spend (a renovation, a holiday). Only what's been paid
    counts.
  - If one is paid on a regular schedule after all (e.g. monthly health insurance), the Overview
    offers to set it ("Looks monthly · Set monthly").
- **Check these payee groups** (Overview): a bill whose bank payments stopped coming (none for over two
  periods, while later statements have been imported) is left out of the forecast and pointed out:
  *End it* sets its cancelled date to the last payment; *Still going* keeps it.
- **Tidy up payee groups** (Settings → Bank statements): groups that look like the same thing twice
  ("Sushi" and "Sushi Ryu", or two groups with a payee in common), merged in one tap; and
  categories for groups with none, from well-known names (Woolworths → Groceries, McDonald's →
  Eating out, 7-Eleven → Transport).
  - Bank import matches them by the full name only, since there's no amount or date to compare.
- **Contract end date** (optional), with a reminder on the Overview 60 days before it ends. You can
  choose whether payments stop at the end date or roll over. Entries that have rolled over show as
  "out of contract" so you know to look for a better deal.
- **Amount & frequency history**: add a change when a bill goes up or down, or when you switch how
  often you pay (e.g. yearly → monthly). Each change stores its own amount and frequency, so the
  chart shows what really applied in each month.
  - A price-only change keeps the usual payment day.
  - A frequency change starts a new schedule from its date.
- **Bills that vary** (utilities, water): switch on *Amount varies*, then log real payments.
  - Each payment is spread over the period it covers, so a quarterly bill is spread across three
    months.
  - You don't need to enter an amount. The history then shows only dates and frequency, and the
    estimate is the average of your last three bills. You can type an optional estimate to use until
    the first payment is logged. After a frequency change, earlier payments are converted to the new
    frequency, e.g. quarterly £300 becomes about £100 a month.
  - Months without a logged payment use that estimate.
  - Refunds are logged as a minus amount (type "-" or tap **±**); they show in green as **Credit**
    (on income: **Paid back**) and are left out of the estimate.
- **Manual payments** (cash, bank transfer): switch on *Manual payment*. They appear under **To
  pay** on the Overview with a **Mark paid** button. Missed ones show as overdue.
- **Your share**: for split bills, set your % and only your part counts in totals. The full bill
  is still stored.
- **Notice period**: the Contracts warning counts down to the last day you can give notice, not the
  end date.
- **Overview**: this month's income, spending and what's left over. Also a chart over 6M, 1Y, 2Y or
  All with a 3-month forecast (tap or drag to read any month), payments due in the next 14 days, and
  spending by category.
- **Tags**: free-form tags on any entry (e.g. `work`, `shared`, `tax-deductible`). Tap tag chips to
  filter. Picking several shows entries with *all* of them. The filter applies to the Overview totals,
  chart, contracts and upcoming payments as well as the Entries list. The "Where it goes" breakdown
  can group by tag, and search matches `#tag`.
- **Month / Year / 12 mo switch**: see totals, "Where it goes", biggest changes and the Payee groups
  list per month or per year, two ways:
  - **Year**: at today's rates, everything running today × 12. What the coming year looks like.
  - **12 mo**: what the last 12 full months actually came to (e.g. Nov 2025 – Oct 2026), one-offs and
    since-ended bills included, counted the same way as the chart.
- **Biggest changes**: the bills whose cost changed most over the chart's period, including new and
  ended ones.
- **Budgets** (Settings → Budgets): a monthly limit for a category, a payee group or a tag. The Overview shows
  progress bars, amber from 90% and red when over. Saving an entry that pushes a budget over, or
  further over, shows a warning. Budgets are included in backups.
- **Until payday**: everything due before your next pay. Optionally enter your current balance to
  see what's left after each payment. Overdue manual payments are included. Choose which income is
  your payday in Settings.
- **Bank statement import** (Settings → Import bank statement): download a CSV from your bank and
  import it. Everything happens on the phone.
  - **Recognised automatically:** CommBank files (credit card and transaction/savings accounts),
    plus most files with a header row (Date / Amount or Debit & Credit / Description). When a file
    has both, *Transaction Date* is used rather than *Value Date*, and *Description* rather than
    *Details*. Amounts marked **CR / DR** (e.g. `115.00 DR`) are read as money in / out.
  - **Dates:** day/month order is detected from the file. If the file could be read either way, you
    choose, with a preview.
  - **Matching** checks three things separately: the **name** (all or some of the entry's words), the
    **amount** (exact, or within 10%; 50% for bills that vary) and the **date** (within 3 days of a
    due date, or within about a week). A match needs them to agree:
    - the full name, plus the amount or the date;
    - part of the name, plus both the amount and the date;
    - no name, but the exact amount within 3 days of a due date.

    The review screen shows which ones matched, e.g. "name · amount · date".
  - **Remembered payees:** choices you make yourself, and name matches, are remembered for next time,
    e.g. "ORIGIN ENERGY" → *Electricity & gas*, or "always ignore this payee". Amount-only matches
    aren't remembered, so one coincidence can't send every later purchase from that shop to a bill.
    Set a remembered row to *Skip for now* to forget it.
  - **Several files at once:** choose more than one CSV (e.g. your savings account and your card, or
    a few months of one account). Each file gets its own account, date order and sign, and is checked
    against its own Balance column. Transfers between them are paired up. A new file that covers the same dates as another of the same
    kind is treated as a second account ("CommBank account 2"); different months are one account.
  - **Matched rows need no attention.** Several matches from one payee to the same entry share a
    row, and a long list is folded away ("✓ 40 transactions going to 12 entries, nothing to do")
    with *Review* to open it.
  - **Balance column (optional):** when a file has one, the amounts are checked against it (each row's balance
    should be the previous one plus its amount), and the review screen says whether they add up. Blank
    balances are skipped, a file where most rows have none isn't checked, and a mismatch is only a
    warning — you can still import. A file
    that shows money out as "+" is spotted this way and switched round; you can also switch it with
    *Money out is − / +*. The newest balance can set **Balance now** for *Until payday* (on by default
    unless you typed a balance yourself; with several files, only one can set it).
  - **Undo last import** (Settings) takes back just the most recent import: its payments (wherever
    they've been moved), the entries it added (unless something else is logged on them), its ignored
    transactions and transfers, the payees it remembered, and the balance it set. Payments you'd logged
    yourself go back to how they were. Repeat it to step back through the last 5 imports.
  - **Starting again:** Settings → *Undo bank imports* removes imported payments, the entries imports
    added (switch off any you want to keep), remembered matches and the ignored list. Payments you
    logged yourself, your payee names and "always ignore" / transfer payees are kept. *Forget remembered
    matches* on its own is there too.
  - **No duplicates:** importing an overlapping statement never logs the same transaction twice.
    Ignored transactions and transfers are remembered (up to 20,000 each, dropping the oldest
    transactions first, so a recent statement never brings back something you ignored).
    The first time, you name the account a statement is from. After that, choose it (or a new one)
    each time; a file whose transactions were imported before is recognised and its account chosen.
  - **Payments you logged yourself** (typed in, or *Mark paid*) aren't doubled up. A bank transaction
    within 4 days and 1% of one updates it to the bank's actual date and amount, shown as
    "already logged" on the review screen.
  - **Your own payee names:** tap **Name** next to a transaction (e.g. "123456 Aus" → "Home
    internet"). That payee shows your name on every future import, the name is used for matching, and
    it's saved in each payment's note. Clear the name to go back to the bank's text.
  - **Renaming an account** (Settings → Bank statements → Rename) is safe: transactions are still
    recognised, and entries using the old name as their payment method are updated.
  - **One row per payee.** Unmatched transactions are grouped by payee (tap the row's count to see
    them); one choice covers them all. Very similar payees share a row: the same name, one name plus
    more words ("Kmart" / "Kmart Bondi"), the same distinctive first word ("Kmart Bondi" / "Kmart
    Sydney"), or a near-identical spelling. Short first words don't count, so "Uber Eats" and "Uber
    Trip" stay apart. A payment service's prefix is left out ("SQ *Woolworths Sydney" is Woolworths
    Sydney; also Zeller "ZLR*", SumUp, Toast, Stripe and "PayPal *"), so paying the same shop through
    a card terminal or PayPal lands with its other payments. Give two
    payees the same name, or pick a new entry another payee is getting (*New in this import*), to put
    them together.
  - **Everything imports by default, each payee to its own entry.** Matches go to their entry, payees
    that look recurring get a recurring entry, and every other payee gets an entry of its own with no
    set schedule, named after them, which their later transactions go to as well. The account's
    catch-all (*Everyday spending – <account>* / *Other income – <account>*) is still in the dropdown
    if you want one. Change any row before importing, or choose *Skip for now* / *Ignore*.
  - **Sorting it out later:** in **Settings → Payees**, choose a payee's group. Or open a group with
    payments from several payees (like a catch-all), go to its **Accounts** page and tap **Move to…**
    next to a payee. Either way, all that payee's payments move, and future imports send them there.
  - **The same company, another way:** a new payee very like one already in a group (another
    suburb, BPAY instead of card, another account) is suggested for that group, marked "like …".
  - **Choose a group or type a name…** on any row opens the group picker. A typed name becomes a
    new group when you import.
  - **Entry pages:** an existing entry opens on **Summary** (a month, last 12 months, payments,
    next due, plus its settings), with **Transactions** (the payment log) and **Accounts** (totals per
    bank account, and the payees it's made of) as separate pages. Save keeps changes from all three.
  - **New entry from any transaction:** the dropdown's *+ New entry* creates one for that payee, and
    takes their other undecided transactions with it. It becomes a recurring entry if the payee looks
    recurring, otherwise *No set schedule*, even with one transaction, so their later
    purchases have somewhere to go.
  - **Transfers between your own accounts** (paying off a card, moving money to savings) aren't
    spending or income, so they're shown under *Transfers between your accounts* and not logged.
    They're spotted from the bank's text ("PAYMENT RECEIVED, THANK YOU", "Transfer to … Savings"),
    or when another account you've imported has the same amount going the other way within 3 days.
    If that other side was already imported as spending (e.g. the savings statement went in first),
    it's taken out of that entry, and an entry the import added just for it goes too (*Undo last
    import* puts it back). Plain "Transfer to xx1234" isn't assumed to be yours, since rent
    and payments to people look the same. Choosing *Transfer between my accounts* yourself remembers
    the payee.
  - **Refunds** follow the payee's purchases: money back from a shop goes to the same entry as a credit, not to *Other income*. Purchases and refunds from one payee
    share a row.
  - **Recurring payments you haven't added**, e.g. "Disney Plus, 3 × $13.99 monthly", can be added as
    entries with one tap, past payments included. It takes at least 3 payments (4 for weekly and
    quarterly), most of them on schedule, and the last one recent: a refund, one late payment or
    a subscription that's since stopped doesn't count.
- **Spreadsheet export** (Settings → Export spreadsheet): three CSV files (entries, payments and
  monthly totals) for Excel or Numbers.
- **Backup**: export to the iOS share sheet, then "Save to Files" → iCloud Drive. Import merges a
  backup file back in.
- Works offline, supports dark mode, and respects the iPhone notch and home-indicator areas.
- **On a computer** (a window 900px or wider): the tabs move to a sidebar on the left, the Overview
  shows two columns (totals, chart and breakdowns on the left; payments due, budgets and payday on
  the right), Groups and Settings use two columns, and the edit sheet is wider. A phone looks the same
  as before.

## Labelling guide

Each label has one job:

| Label | Answers | How many | Style | Examples |
| --- | --- | --- | --- | --- |
| **Payee group** | *Which company or thing is it really?* | One per payee | Its own name | Telstra, Netflix, Coffee |
| **Category** | *What kind of spending is it?* | Exactly one per group, so the percentages add up to 100% | Title Case, broad (about 10–15 in total) | Housing, Subscriptions, Phone & Internet |
| **Payment method** | *How does the money move?* | One per payment (imports guess it; the group's is the default) | Sentence case | BPAY, Direct debit, Card |
| **Account** | *Which of my accounts?* | One per imported payment | Your name for it | Everyday card, Savings |
| **Tags** | *Anything that cuts across categories* | Any number | lowercase, hyphenated | `shared`, `essential`, `tax-deductible`, `cancel-soon` |

Quick test: if every entry needs exactly one answer, it's a category. If it's a yes or no, it's a tag.

**Bundles and overlaps.** Netflix, Spotify, Apple One and iCloud all go under one category,
*Subscriptions*. Use tags for what each one covers. For example, Apple One is tagged `bundle`,
`streaming`, `music` and `cloud-storage`. "Where it goes → Tag" then shows Apple One under each of
those tags. An entry with several tags counts towards each one.

The app keeps labels consistent for you:
- It matches what you type to the existing spelling, so "groceries" becomes "Groceries".
- It tidies tags, so "Tax Deductible" becomes `tax-deductible`.
- **Settings → Manage labels** lets you rename, merge or delete any category, method or tag across
  all entries.

## Backlog

Planned work and ideas live in [BACKLOG.md](BACKLOG.md). The design for accounts, payees and
groups is in [docs/DESIGN.md](docs/DESIGN.md).

## Run locally

No build step. Serve the folder with any static server:

```sh
python -m http.server 8000
# or: npx serve .
```

Then open http://localhost:8000.

## Put it on your iPhone

Service workers (offline mode) need **HTTPS**, so host it somewhere. Any static host works:

- **GitHub Pages**: push this repo, then Settings → Pages → deploy from `main` / root.
- **Netlify Drop** (https://app.netlify.com/drop): drag the folder in.
- **Cloudflare Pages**: connect the repo, with no build command.

On the iPhone, open the URL in **Safari** → Share → **Add to Home Screen**.

> Data is tied to the installed Home Screen app. Deleting the app or clearing Safari website data
> deletes your entries, so export a backup now and then. The app nudges you after 30 days.

## Deploying updates

Bump `VERSION` in `sw.js` each time you deploy. The installed app picks up the new version on its
next launch or the one after.

To see which version a browser or phone is running, open **Settings → Storage → Version**. It shows
the `VERSION` from `sw.js` that is serving the app. **Reload** next to it checks for a newer version,
waits for it to install, and reloads, so you can confirm a deploy has arrived without reinstalling.

## Tests

| Command | What it checks | Where it runs |
| --- | --- | --- |
| `npm test` (or `node tests/run.mjs`) | Old backups still import; date and money maths; the offline file list | Before every commit (pre-commit hook) and on GitHub |
| `npm run test:e2e` | The real app in a phone-sized browser: every screen, adding, editing and deleting, backups, CSV, labels, payments, budgets, payday, offline mode, upgrading old saved data, focus. Also an **Australian** run (en-AU, Sydney time, including just after midnight) | On GitHub after every push, in Chromium and **WebKit** (Safari's engine) |
| (same command) `tests/e2e/desktop.spec.mjs` | The computer layout in a 1280×800 window: sidebar, columns, chart size, no sideways scrolling, back to the phone layout when narrowed, the Transactions table and its sorting headings. Set `E2E_SHOTS=1` to save screenshots to `test-results/` | The `desktop-chromium` project, locally and on GitHub |

Setup for the browser tests is a one-off `npm install`. Locally they use your installed Microsoft Edge.
To also run WebKit: `npx playwright install webkit`, then `E2E_WEBKIT=1 npm run test:e2e`.

The browser tests freeze the date at 21 Nov 2026, so screens that depend on the date look the same
every day. Each test starts with an empty app. If a test fails on GitHub, the run keeps a report
with screenshots and a step-by-step trace: open the run, then **Artifacts → playwright-report**.

## Keeping old backups working

Any backup ever exported from the app must keep importing into every future version. The same goes
for data already saved on a phone when the app updates.

**How it works**
- Every backup records a format `version`. The current one is `SCHEMA_VERSION` in
  [js/schema.js](js/schema.js).
- Imports and app start-up both go through `migrateBackup()`. It upgrades older formats one step at
  a time, then fills in defaults for any missing fields. For example, backups made before tags
  existed get an empty tag list.
- Fields the app doesn't recognise are kept rather than dropped. A damaged entry is skipped and
  reported; it doesn't stop the rest of the import.
- A backup from a *newer* app version is refused with a "please update" message rather than being
  half-imported.
- `tests/fixtures/` holds a real backup in every format the app has used. `node tests/run.mjs`
  checks that each one imports with nothing lost, calculates correctly, and survives export →
  import. The tests run before every commit (pre-commit hook) and on GitHub after every push.

**When you change the data**

| Change | What to do |
| --- | --- |
| Add an optional field | Give it a default in `normalizeEntry()`. No version bump. |
| Rename, remove or change the meaning of a field | 1. Export a backup from the *current* app and save it as `tests/fixtures/v<N>-<date>-<description>.json`. 2. Bump `SCHEMA_VERSION`. 3. Add a step to `MIGRATIONS` that upgrades the old shape. |
| IndexedDB stores (`js/db.js`) | Only ever *add* stores or indexes in `onupgradeneeded`. Never delete them. |

Never edit or delete an existing fixture or migration step. They're the record of what old backups
look like. Use made-up data in fixtures, never your real budget.

## Keeping secrets out of the repo

The repo is public, so nothing private goes in it. Your budget data never does: it lives on the phone.

- **`.gitignore`** lists files git ignores: `.env` files, keys and certificates, credential files,
  budget backup exports (`budget-backup*.json`) and anything in a `local/` folder. Keep personal
  files in `local/` and they'll never be committed.
- **Pre-commit check** (`.githooks/pre-commit`) blocks a commit when a staged file looks like a key,
  a token or a budget backup. Turn it on once in each clone:
  ```sh
  git config core.hooksPath .githooks
  ```
- **GitHub secret scanning with push protection** is turned on for the repo as a second safety net.

### Removing a file from the repo

To stop tracking a file but **keep it on your computer**:

```sh
git rm --cached path/to/file      # add -r for a folder
echo "path/to/file" >> .gitignore # so it isn't re-added
git commit -m "Stop tracking path/to/file"
git push
```

The file disappears from GitHub's current view but **stays in the history**. If what you removed was
a real secret (a password or API key), treat it as leaked: revoke or change it at its source. Then
ask for the history to be rewritten if you also want it gone from old commits.

## Project layout

| Path | Purpose |
| --- | --- |
| `index.html` | App shell, tab bar, iOS meta tags |
| `styles.css` | iOS-style UI, light and dark themes |
| `js/app.js` | Entry point: button actions, global events, start-up |
| `js/core.js` | Shared state, constants and helpers (money, dates, labels, tags, toast). Imports no other UI file, so it always loads first |
| `js/render.js` | Draws the current tab; `reload()` re-reads entries |
| `js/view-overview.js`, `js/view-entries.js`, `js/view-transactions.js`, `js/view-settings.js` | The four tabs. `view-transactions.js` also has `drillDown()`, which the Overview's figures use |
| `js/view-payees.js` | The Payees page (computers only, from the sidebar) |
| `js/sheet-entry.js` | The entry sheet (Summary, Transactions, Accounts), save and delete |
| `js/sheet-budgets.js`, `js/sheet-labels.js` | The Budgets and Manage labels sheets |
| `js/importer.js` | Bank import screens: review, apply, undo (the pure logic is in `bank.js`) |
| `js/model.js` | Your accounts and payees (format v5): pure functions, tested in `npm test` |
| `js/picker.js` | The picker: choose a group (or payee), or type a name to create one |
| `js/sheet-accounts.js`, `js/sheet-payees.js` | Settings → Accounts and Settings → Payees |
| `js/backup.js` | Backup export / import, spreadsheet export, sample data |
| `js/bank.js` | Pure bank-statement logic: CSV, formats, payee keys, matching, transfers |
| `js/calc.js` | Pure date/money logic (frequencies, price history, monthly totals) |
| `js/chart.js` | Dependency-free SVG chart |
| `js/db.js` | IndexedDB wrapper |
| `js/schema.js` | Backup format version, migrations, validation |
| `js/reports.js` | Biggest changes, yearly totals, budgets, until payday, CSV export |
| `tests/` | `run.mjs` test suite + `fixtures/` (sample backups from every format) |
| `sw.js` | Offline cache |
| `tools/make_icons.py` | Regenerates the PNG icons |

## iCloud sync: options

1. **Current approach:** manual backup and restore through iCloud Drive (share sheet → Save to Files).
   Free, and needs no setup.
2. **CloudKit JS:** true automatic sync with the user's iCloud account. This needs a paid Apple
   Developer account ($99/yr), a CloudKit container and an API token, and users sign in with their
   Apple ID inside the app. The storage layer is all in `js/db.js`, so a sync layer could be added there.
3. **Native wrapper:** wrap this PWA in Capacitor and use native CloudKit/iCloud key-value storage.
   This means going through the App Store.

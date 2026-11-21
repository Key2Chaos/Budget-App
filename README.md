# Budget

An offline-first PWA for tracking recurring bills, subscriptions, contracts and income on iPhone.
No backend, no account. All data lives on the device in IndexedDB.

## Features

- **Income and expenses**, each with a name, amount, frequency (one-off, weekly, fortnightly,
  4-weekly, monthly, quarterly, 6-monthly or yearly), first payment date, category and payment method.
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
  - Refunds can be logged as **Credit**.
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
- **Month / Year switch**: see totals, "Where it goes", biggest changes and the Entries list per
  month or per year. The yearly figures are at today's rates: everything running today × 12.
- **Biggest changes**: the bills whose cost changed most over the chart's period, including new and
  ended ones.
- **Budgets** (Settings → Budgets): a monthly limit for a category or a tag. The Overview shows
  progress bars, amber from 90% and red when over. Saving an entry that pushes a budget over, or
  further over, shows a warning. Budgets are included in backups.
- **Until payday**: everything due before your next pay. Optionally enter your current balance to
  see what's left after each payment. Overdue manual payments are included. Choose which income is
  your payday in Settings.
- **Bank statement import** (Settings → Import bank statement): download a CSV from your bank and
  import it. Everything happens on the phone.
  - **Recognised automatically:** CommBank files (credit card and transaction/savings accounts),
    plus most files with a header row (Date / Amount or Debit & Credit / Description).
  - **Dates:** day/month order is detected from the file. If the file could be read either way, you
    choose, with a preview.
  - **Matching:** each transaction is matched to an entry by name (whole words), amount and due date,
    then logged as a payment. Your choices are remembered for next time, e.g. "ORIGIN ENERGY" →
    *Electricity & gas*, or "always ignore this payee".
  - **No duplicates:** importing an overlapping statement never logs the same transaction twice.
    Choose the same account each time; the app suggests the one a file was imported into before.
  - **Payments you logged yourself** (typed in, or *Mark paid*) aren't doubled up. A bank transaction
    within 4 days and 1% of one updates it to the bank's actual date and amount, shown as
    "already logged" on the review screen.
  - **Your own payee names:** tap **Name** next to a transaction (e.g. "123456 Aus" → "Home
    internet"). That payee shows your name on every future import, the name is used for matching, and
    it's saved in each payment's note. Clear the name to go back to the bank's text.
  - **Renaming an account** (Settings → Bank statements → Rename) is safe: transactions are still
    recognised, and entries using the old name as their payment method are updated.
  - **Recurring payments you haven't added**, e.g. "Disney Plus, 3 × $13.99 monthly", can be added as
    entries with one tap, past payments included.
- **Spreadsheet export** (Settings → Export spreadsheet): three CSV files (entries, payments and
  monthly totals) for Excel or Numbers.
- **Backup**: export to the iOS share sheet, then "Save to Files" → iCloud Drive. Import merges a
  backup file back in.
- Works offline, supports dark mode, and respects the iPhone notch and home-indicator areas.

## Labelling guide

Each of the three labels has one job:

| Label | Answers | How many | Style | Examples |
| --- | --- | --- | --- | --- |
| **Category** | *What is it?* | Exactly one, so the percentages add up to 100% | Title Case, broad (about 10–15 in total) | Housing, Subscriptions, Phone & Internet |
| **Payment method** | *How does the money move?* | One | Sentence case. Add the card or account if useful | Direct debit, Credit card – Amex |
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

Planned work and ideas live in [BACKLOG.md](BACKLOG.md).

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

## Tests

| Command | What it checks | Where it runs |
| --- | --- | --- |
| `npm test` (or `node tests/run.mjs`) | Old backups still import; date and money maths; the offline file list | Before every commit (pre-commit hook) and on GitHub |
| `npm run test:e2e` | The real app in a phone-sized browser: every screen, adding, editing and deleting, backups, CSV, labels, payments, budgets, payday, offline mode, upgrading old saved data, focus. Also an **Australian** run (en-AU, Sydney time, including just after midnight) | On GitHub after every push, in Chromium and **WebKit** (Safari's engine) |

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
| `js/app.js` | Views, entry form, backup and import |
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

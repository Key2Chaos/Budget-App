# Backlog

Ideas and work for the Budget app, roughly in priority order. Move items up and down as priorities
change. When something ships, move it to **Done** with the date.

Size: **S** is about an hour, **M** is an afternoon, **L** is several sessions.

## Next up

| # | Item | Size | Why |
|---|------|------|-----|
| 1 | **Groups, next steps** ([docs/DESIGN.md](docs/DESIGN.md) section 8): split one transaction across groups; choose a payee and account for payments logged by hand; archive groups and accounts; "Where it goes" by payee, account or method; Balance now as the total of chosen accounts | M | The parts of the design not built in the first round |
| 2 | **Undo after delete.** Show a toast with an *Undo* button instead of (or as well as) the confirm box. Covers entries, payments, labels and budgets | S | Mistakes are easy to recover from. Fewer pop-ups |
| 3 | **Add to Calendar.** Export contract end and notice dates (and optionally big yearly bills) as a calendar file, with an alert before each | S | Reminders that work offline, with no server |
| 4 | **Duplicate entry.** A "Duplicate" button in the edit sheet | S | Faster to add similar bills |
| 5 | **Shorter payment logs.** Show the latest 12 payments with "Show all", newest first | S | Long logs make the edit sheet very long after a year or two |

## Desktop ideas (from the 27 Nov 2026 review)

| # | Item | Size | Why |
|---|------|------|-----|
| D2 | **Open a payee group in a side panel** instead of a pop-up, with ↑/↓ to step through the list | M | Click from one group to the next without closing anything |
| D4 | **Keyboard shortcuts**: N new group, / search, Esc close, Ctrl+Z undo (with backlog #2) | S | Faster on a computer |
| D5 | **Drop a CSV anywhere** on the window to import it | S | |
| D6 | **Chart details on hover**, not only on click | S | |
| D7 | **Edit in place** in the tables: category, amount, tags | M | Fewer trips into the edit sheet |

## Soon

| # | Item | Size | Why |
|---|------|------|-----|
| 6 | **Set aside for yearly bills.** "Put aside $X/month to cover yearly and quarterly bills", plus a list of large bills due in the next 60 days | M | Stops annual bills being a surprise |
| 7 | **This year vs last year.** Compare each month with the same month a year ago on the chart, or as a list | M | Fits the main goal: seeing how the budget changes |
| 8 | **Skip a payment.** Mark one occurrence as skipped, e.g. a payment holiday or a month a bill doesn't apply | S | Keeps forecasts and "To pay" accurate |
| 9 | **Backup reminders based on changes.** Remind after N changes since the last backup, not only after 30 days | S | Less data at risk after a busy week |
| 10 | **Help and "What's new".** A short first-run guide, and a note after an update explaining new features | S | New features are easy to miss |

## Later

| # | Item | Size | Notes |
|---|------|------|-------|
| 11 | **Face ID / passcode lock** on opening | M | Possible with WebAuthn. A lighter lock than a banking app's |
| 12 | **Split one bill across categories**, e.g. part of Apple One counted as cloud storage | M | Tags cover most of this today |
| 13 | **Bank import, next steps:** a "which column is what" screen for unusual CSVs; presets for NAB, Westpac, ANZ, ING and Up; the Up Bank personal API for one-tap refresh; keep *Undo last import* history in backups | M | The basic importer is done (see Done) |
| 14 | **Savings goals**: target, date and progress | M | |
| 15 | **Push notifications** for bills due or notice deadlines | L | iPhone Home Screen apps support web push, but it needs a small server |
| 16 | **iCloud sync (CloudKit)** across devices | L | Needs an Apple Developer account ($99/yr). Today's iCloud Drive backups work without it |

## Housekeeping

- Accessibility pass: VoiceOver labels on icon buttons, colour contrast of the muted text, and the order of the segmented controls.
- Real-iPhone checklist before big releases: date pickers, the share sheet, Home Screen install, dark mode, and the notch/home-bar spacing.

## Not possible in a web app (for reference)

- Home Screen widgets, Siri shortcuts, and reading bank data directly. These would need a native app, e.g. this PWA wrapped with Capacitor and sent through the App Store.

## Done

| Date | Item |
|------|------|
| 2026-11-21 | First version: entries, price history, Overview chart, offline, backup to iCloud Drive |
| 2026-11-21 | Tags and the tag filter. Secret-protection hooks. Old backups keep working (schema versions + tests) |
| 2026-11-21 | Frequency changes in history (format v2). Fixes from the on-screen check |
| 2026-11-21 | Manage labels, consistent spellings, tidy tags |
| 2026-11-21 | Payment log, amount varies, manual payments / To pay, your share, notice periods |
| 2026-11-21 | Biggest changes, Month/Year view, budgets, until payday, CSV export |
| 2026-11-21 | Amount varies without a fixed amount (format v3). Removed stray focus boxes |
| 2026-11-21 | Browser tests in the repo (Chromium + WebKit, offline, start-up upgrade, Australia/Sydney time) running on GitHub. Fixed "Last backup" showing the UTC date. Region-specific payment methods (AU: BPAY, PayID; US; CA; NZ; UK) |
| 2026-11-21 | Bank statement import (CommBank CSV + header-row files): matching, remembered payees, no duplicates, recurring detection |
| 2026-11-21 | Bank import: card payees grouped by merchant, ignoring the town after it (e.g. Superloop "BRISBANE" vs "1800 number" was split in two) |
| 2026-11-21 | Bank import: hand-logged payments are updated (bank date and amount) instead of duplicated; pick previous accounts; rename accounts safely |
| 2026-11-21 | Bank import: your own names for payees (used for display and matching); payment notes shown in the payment log |
| 2026-11-21 | Bank import: stricter amount-only matching (exact, ±3 days), only deliberate choices remembered, Forget remembered matches, Remove imported payments |
| 2026-11-21 | Bank import: matching on name, amount and date together, with the matched signals shown on each row |
| 2026-11-21 | Undo bank imports: also deletes entries that imports added (choose which to keep) and clears the ignored list |
| 2026-11-21 | "Variable (no set schedule)" frequency (format v4) |
| 2026-11-21 | Bank import: "+ New entry" from any transaction; "No entries yet" in empty lists |
| 2026-11-22 | Bank import: everything imports by default (recurring payees get entries; the rest go to an "Everyday spending" catch-all per account); Payees → Move to… on entries |
| 2026-11-22 | Bank import: unmatched transactions shown one row per payee; same name or same new entry puts payees together |
| 2026-11-22 | Bank import fixes: a "Value Date" column is never read as the amount; preferred column names win (Transaction Date, Description); CR / DR amounts |
| 2026-11-22 | Bank import: transfers between your own accounts (card payments, savings) aren't counted as spending or income, and are taken out of a catch-all when the other side turns up; refunds go with the payee's purchases instead of income |
| 2026-11-22 | Bank import: Undo last import (steps back through the last 5); amounts checked against the Balance column, "money out is +" files spotted and switched, newest balance sets "Balance now" |
| 2026-11-22 | Bank import: several files at once (own account/check each, transfers paired between them); matched rows grouped and folded away; ignored list keeps the newest transactions (20,000) instead of silently dropping recent decisions; balance check skips blanks |
| 2026-11-22 | Entries split into three pages — Summary (key figures + settings), Transactions (payment log), Accounts (per bank account totals + payees with Move to…); imported payments now record their account |
| 2026-11-23 | Accounts, payees and groups (format v5): entries are called groups; Settings → Payees (rename, group, merge spellings, ignore / transfer) and Settings → Accounts (type, balance, this month, transactions); the group picker (pick or type a new name) on imports, Move to… and single payments; similar payees suggested for an existing group; payment method per payment and breakdowns on each group; budgets and "Where it goes" by group; deleting a group keeps its imported payments in Ungrouped; payees and accounts in backups and the spreadsheet export |
| 2026-11-23 | Layout for computers: sidebar instead of the bottom tabs, two-column Overview, Groups and Settings, a wider chart drawing and edit sheet, hover states. Fixed the clipped calendar icon on desktop date boxes |
| 2026-11-22 | Design for accounts, payees and groups agreed ([docs/DESIGN.md](docs/DESIGN.md)). `js/app.js` split into one file per screen (no change in behaviour) |
| 2026-11-22 | Bank import: every unmatched payee gets an entry of its own (no more Everyday spending by default); very similar payees share one; transfers are taken out of those entries too. Payment log: signed amounts with ±, credits in green, "Received" / "Paid back" on income |
| 2026-11-26 | Smarter schedules: stricter recurring detection (3+ payments, refunds and stopped ones left out); Variable estimates over 12 months, only after 3 payments, and *Don't forecast* for projects; Overview "Check these groups" for bills that stopped and Variable groups paid on a schedule; Settings → Tidy up groups (merge duplicates, suggested categories, new *Eating out* category). Bank import: you name or choose each statement's account unless it's recognised; DD/BPAYN methods; better shop names; import notes follow the group's payee |
| 2026-11-27 | **Payees page** on a computer: a sortable table with several payees put in a payee group, ignored or marked as transfers at once |
| 2026-11-27 | Payee groups as a sortable table on a computer (D1); Payees and Accounts in the sidebar (D3) |
| 2026-11-27 | **Transactions** tab: every payment in one table with search, period and filters, sortable columns on a computer, and *Move to…* for several payments at once; *By payee group* compares what's logged with what the Overview counts. Overview figures (Income, Expenses, budgets, Where it goes, a chart month) open their payments |
| 2026-11-27 | User guide decisions: *Groups* are now *Payee groups*; *Variable* is now *No set schedule* (so it isn't confused with *Amount varies*); a **12 mo** view of what the last 12 full months came to, beside the year at today's rates; Settings → Budgets mentions payee-group budgets |

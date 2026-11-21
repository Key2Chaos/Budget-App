# Budget

An offline-first PWA for tracking recurring bills, subscriptions, contracts and income on iPhone.
No backend, no account. All data lives on the device in IndexedDB.

## Features

- **Income and expenses**, each with a name, amount, frequency (one-off, weekly, fortnightly,
  4-weekly, monthly, quarterly, 6-monthly or yearly), first payment date, category and payment method.
- **Contract end date** (optional), with a reminder on the Overview 60 days before it ends. You can
  choose whether payments stop at the end date or roll over. Entries that have rolled over show as
  "out of contract" so you know to look for a better deal.
- **Price history**: add a price change when a bill goes up or down. The history chart uses the price
  that applied in each month, so it shows how your budget really changed.
- **Overview**: this month's income, spending and what's left over. Also a chart over 6M, 1Y, 2Y or
  All with a 3-month forecast (tap or drag to read any month), payments due in the next 14 days, and
  spending by category.
- **Tags**: free-form tags on any entry (e.g. `work`, `shared`, `tax-deductible`). Tap tag chips to
  filter. Picking several shows entries with *all* of them. The filter applies to the Overview totals,
  chart, contracts and upcoming payments as well as the Entries list. The "Where it goes" breakdown
  can group by tag, and search matches `#tag`.
- **Backup**: export to the iOS share sheet, then "Save to Files" → iCloud Drive. Import merges a
  backup file back in.
- Works offline, supports dark mode, and respects the iPhone notch and home-indicator areas.

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

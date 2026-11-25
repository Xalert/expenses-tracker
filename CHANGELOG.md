# Changelog

Notable changes, newest first. Add a line under "Unreleased" with a change worth telling self-hosters about;
`make release VERSION=x.y.z` turns that section into the release's own (when it is empty, the commit subjects since
the last tag are used instead) and starts a new one. See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md#releasing).

## Unreleased

- Upgrade note: migration `0007` adds tables for budgets, repeating entries and tags; it applies on the first
  request after the upgrade, as usual. Take a backup first (`docker compose run --rm backup`).
- "Today" and the current month follow each account's time zone (Account settings) instead of the server's clock,
  which is UTC in the container: default dates, "spent so far", the charts' future days. An account without a time
  zone keeps the server's date.
- Budgets: a monthly limit per expense category and an overall one, set on Categories, with progress there and in a
  Budgets card on the Overview. Measured in the budget's currency over all wallets, at each day's rate.
- Repeating entries: "Repeat" in the Add form (daily, weekly, monthly, yearly, every N, until a date) creates a rule;
  its entries are added the next time you open the app after they fall due. Rules are listed, paused, edited and
  deleted on the new Repeating page (from Transactions).
- Reports: a new yearly page with the year's totals against the previous year, a month-by-month chart, and
  category-by-month tables whose cells open the matching entries.
- Tags: free labels on expenses and income, picked or typed in the entry form, shown in the lists, filterable on
  Transactions and managed (rename, merge, delete) on Categories. The transactions CSV has a new optional `tags`
  column; Spendee labels still go into the note.
- Reconcile balance, in a wallet's menu: type the real balance and the difference is recorded as one entry in a
  "Balance adjustment" category.
- A wallet's balance is now the balance at the end of today everywhere (wallet page, Wallets, Overview); entries
  dated later are shown as projected instead of being counted.
- Categories can have a colour, shown next to their name.
- The JSON backup carries budgets, repeating rules, tags and category colours. Older backups import as before.
- The app can be added to a phone's home screen (web app manifest and icons). It still needs the server: there is
  no offline mode.
- Fixed in Safari: the date picker inside the Add dialog closed when changing the month. Fixed in Firefox and
  Safari: the new pill was not focused after "+ New category".
- For self-hosters building the image themselves: the Dockerfile's `NODE_IMAGE` build argument is gone (the base
  image is a literal `FROM`, so Dependabot can update it).
- Development: the browser tests also run in Firefox and WebKit; Dependabot proposes grouped updates monthly.

## 0.1.0 (2026-11-18)

The first tagged release: everything built since 2026-11-05, in short.

- Wallets in any ISO currency, expenses and income with your own categories, transfers between wallets (also
  across currencies), several users per instance.
- Import and export: a full JSON backup per account, a transactions CSV, Spendee exports (several files at once,
  transfers paired); the separate Statement Importer page turns bank statements into the CSV.
- User IDs for sign-in (email optional); password change on `/account`, which signs out the other sessions.
- Redesigned interface: Overview with month charts and a converted "All in <currency>" view (ECB rates),
  Transactions grouped by day with a month stepper, Wallets, Categories, Import & export; themed date and month
  pickers; light and dark themes.
- Wallet groups, to keep personal and business wallets apart.
- PostgreSQL instead of SQLite (no in-place upgrade: move accounts with their JSON backups).
- Docker: a prebuilt multi-arch image on ghcr.io and a download-and-run Compose file.
- Operations: an on-demand `backup` Compose service, a Postgres major-upgrade script, a warning line before
  migrations run on an existing database, a release script, a smaller image without `sharp`, signed images with
  SBOM and provenance.
- `/account` lists your signed-in devices (browser, signed in, last active) with a Sign out for each.
- New setting `TRUST_PROXY` (default off): set it to `1` behind one reverse proxy so the per-address sign-in limit
  uses the real client address; unset, `X-Forwarded-For` is no longer trusted.
- The `backup` Compose service can run on a schedule: set `BACKUP_INTERVAL_HOURS` and start it with
  `docker compose --profile backup up -d backup`.
- Each account has a time zone (taken from the browser at registration or sign-in, changeable under Account
  settings); Spendee imports are dated in it, so re-importing from another time zone finds the same duplicates.
- Archived categories and your own exchange rates survive an export: the backup carries when a category was
  archived and the rates from the Rates page, the CSV gets a `category` row for each archived category it uses, and
  the Wallets & categories file flags archived categories (the Statement Importer leaves them out). Archived wallet
  groups can be renamed and recoloured, and take no new entries, like archived wallets.
- Fixes found by the new browser tests: the time zone was lost when the first registration or sign-in attempt was
  refused; removing a used category "into a new category" after a refused first try moved its entries into another
  existing category instead; the date picker near the bottom of the screen scrolled the page instead of opening
  upwards; the wallet page scrolled sideways on phones with a long wallet name.

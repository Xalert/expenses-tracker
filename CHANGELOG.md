# Changelog

Notable changes, newest first. Add a line under "Unreleased" with a change worth telling self-hosters about;
`make release VERSION=x.y.z` turns that section into the release's own (when it is empty, the commit subjects since
the last tag are used instead) and starts a new one. See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md#releasing).

## Unreleased

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

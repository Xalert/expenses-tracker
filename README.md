# Expenses Tracker

A self-hosted, multi-user expenses tracker. Record income, expenses and transfers across wallets in different
currencies, file them under categories you manage, and see where the money went on a per-currency overview (which
can also show everything converted into one currency at the day's ECB rates). Import and export as CSV or JSON,
including Spendee exports and bank statements.

## Quick start (Docker)

```bash
mkdir expenses-tracker && cd expenses-tracker
curl -fsSLO https://raw.githubusercontent.com/xalert/expenses-tracker/main/deploy/compose.yaml
docker compose up -d
```

Open http://localhost:3000 and create your account. That starts the prebuilt image (amd64 and arm64) and its
PostgreSQL database; there is nothing to clone or build.

## Self-hosting

[`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md) covers running it for real: settings (database password, port,
closing registration), HTTPS behind a reverse proxy, backup and restore, upgrading, building from source and
running without Docker. Take a backup before upgrading. **Instances from before the move to PostgreSQL cannot be
upgraded in place**; carry each account across with its JSON backup
([how](docs/SELF-HOSTING.md#moving-from-sqlite-older-versions)).

## Development

From a clone, with Node 20.9+ and Docker. `make` lists every shortcut; details in
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

Run the app on demo data at http://localhost:3000 (sign in as `demo` / `demo-password`):

```bash
make dev
```

Typecheck, lint and run the whole test suite:

```bash
make check
```

One test file, optionally only the tests whose name matches:

```bash
make test FILE=tests/users.test.ts NAME=changePassword
```

Re-run the tests on every save:

```bash
make watch
```

Put the demo data back to its fresh state:

```bash
make demo-reset
```

Stop the development database (the data stays):

```bash
make down
```

## More

- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md): running from source with demo data, debugging, npm scripts, code
  layout.
- [`docs/SPEC.md`](docs/SPEC.md): how everything works, including the
  [import and export formats](docs/SPEC.md#import--export); [`docs/DECISIONS.md`](docs/DECISIONS.md) has the
  reasons and the known gaps.
- [`docs/STATEMENT-IMPORTER.md`](docs/STATEMENT-IMPORTER.md): the companion
  [Statement Importer](https://claude.ai/artifact/1w1vJNQk41mmcG9ActCEsH) page on claude.ai that turns bank
  statements (CSV, text, PDF or a photo) into a CSV this app imports.

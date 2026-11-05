# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Self-hosted, multi-user expenses tracker: wallets in different currencies, expenses / income with user-defined
categories, transfers between wallets, a dashboard, and import/export. One Next.js app backed by a single SQLite
file, shipped as a Docker image.

## Documents to read before changing behaviour

- `docs/SPEC.md` — the build contract: domain rules, data model, every service signature, the Server Action
  pattern, screens, import/export formats, deployment. **When you change a rule, signature, route or format,
  update the spec in the same change.**
- `docs/DECISIONS.md` — why things are the way they are, and the known gaps. **When you make a product or
  design decision, or leave something unfinished or unverified, add it there.**
- `AGENTS.md` — written by `next dev`. This is Next.js 16: APIs differ from older versions (`params` and
  `searchParams` are Promises, etc.). Check `node_modules/next/dist/docs/` before relying on memory.
- `README.md` — user-facing: running, configuration, self-hosting, backup/restore, the CSV column format.

## Commands

```bash
npm run dev                                   # dev server on :3000; the DB is created and migrated on first request
npm run db:seed                               # idempotent demo user + data; prints the demo login
npm run typecheck                             # tsc --noEmit
npm run lint                                  # eslint
npm test                                      # vitest run (whole suite, under a second)
npx vitest run tests/money.test.ts            # one file
npx vitest run tests/money.test.ts -t "JPY"   # tests whose name matches
npm run build                                 # production build → .next/standalone (forces NODE_ENV=production)
npm run db:generate                           # after editing src/db/schema.ts: new migration in drizzle/
docker compose up -d --build                  # the real deployment artefact
npx tsx --conditions=react-server script.ts   # run a one-off script that imports src/server/* (needed for `server-only`)
```

`build` and `start` set `NODE_ENV=production` inline on purpose: a globally exported `NODE_ENV=development`
breaks `next build`. A production build is best validated with `docker build .`, which runs it on Linux.

## Architecture

**Request flow.** There is no REST layer. Pages are Server Components that call the service layer directly;
mutations are Server Actions. The only route handlers are `GET /api/health` and the two `GET /api/export/*`
downloads — route handlers are not covered by the `(app)` layout, so they check the session themselves.

```
page.tsx (Server Component) ──────────────► src/server/*.ts ──► Drizzle ──► SQLite
form (client) ─► actions.ts (Server Action) ─► zod ─► src/server/*.ts
                   └─ ServiceError → FormState { message, fieldErrors, values } → useActionState
```

**Service layer (`src/server/`).** All domain rules live here, not in actions or components. Every function
takes `userId` first and scopes every query by it; another user's row behaves exactly like a missing one.
Services are synchronous (better-sqlite3) and throw `ServiceError` (`code` + user-presentable `message` +
optional `field`). Actions follow one pattern — `requireUser()`, parse with zod, call the service, map errors
with `serviceErrorState`, then `revalidatePath` / `redirect` outside the `try` — see
`src/app/(auth)/register/actions.ts` and `src/lib/form.ts`. Form inputs are named after the service's field
names so errors land on the right control.

**Money.** Integer minor units everywhere (`amountMinor`), never floats; decimals come from the currency
(`currencyDecimals`: JPY 0, EUR 2, KWD 3). Stored amounts are positive and the transaction kind gives the sign.
User input goes through `parseAmount(value, currency)` with the currency of the wallet looked up server-side.
There is no currency conversion anywhere: totals are always grouped per currency.

**Transfers** are one `transfers` row plus two `transactions` legs (`transfer_out`, `transfer_in`) written in
one DB transaction; legs are only edited or deleted through the transfer. Cross-currency transfers store both
amounts. A check constraint ties `kind`, `categoryId` and `transferId` together.

**Database (`src/db/index.ts`).** `getDb()` lazily opens the file from `DATABASE_URL` (default `data/app.db`),
enables foreign keys + WAL, and applies the migrations in `drizzle/` — so migrations must ship with the build
(`outputFileTracingIncludes` in `next.config.ts`, and an explicit copy in the Dockerfile). Never edit an
existing migration; generate a new one.

**Auth (`src/lib/auth.ts`).** Email + password (scrypt), DB-backed sessions, sha256 of the cookie token stored.
`requireUser()` is called in the `(app)` layout **and** in every Server Action. `COOKIE_SECURE` and
`ALLOW_REGISTRATION` are read through `src/lib/config.ts`.

**Import pipeline (`src/server/import.ts` + `src/server/import-formats/`).** Each format is a module with
`detect` + `parse` that produces the same parsed form; `FORMATS` in `import.ts` lists them in detection order
(the native CSV accepts anything, so it stays last). Planning, duplicate skipping, preview and the
all-or-nothing write are shared and format-agnostic. Adding a provider means one module plus one entry in that
list — do not loosen the native CSV rules to fit a provider. `previewImport` and `runImport` share one path, and
`runImport` re-validates inside the transaction it writes in.

**Deployment.** `output: "standalone"`; the Docker image runs `node server.js` as the non-root `node` user with
the DB on the `/data` volume. All runtime configuration is environment variables (`.env.example`). The image
must be built on Linux for its target platform because better-sqlite3 is a native module.

## Conventions and gotchas

- **Tests** live in `tests/` (not next to the code). Service tests call `useFreshDb()` in `beforeEach` and
  `makeUser(db, email)` from `tests/helpers.ts`, which installs an in-memory migrated DB via `setDb`.
  `server-only` is stubbed in `vitest.config.mts`.
- **Cache Components is deliberately off** (`next.config.ts`): every page is per-user and reads the session
  cookie. Don't add `'use cache'`.
- **`cn()` only joins class names; it does not merge Tailwind classes.** To override a class coming from a
  shared component, use Tailwind's important suffix (`px-0!`).
- **Forms after a failed Server Action:** React resets uncontrolled forms, and a `<select>` ignores a changed
  `defaultValue`. Echo the submitted `values` back and either `key` the select on its value or `key` the whole
  form on the action result (both approaches are in the codebase).
- **Theme tokens** (`bg-surface`, `text-muted-foreground`, `text-income`, `text-expense`, `text-transfer`, …)
  are defined in `src/app/globals.css` for light and dark; use them instead of raw colours.
- **The mobile bottom bar is full** at 375px (five entries). New top-level destinations go in the desktop
  sidebar and the mobile top bar, as `/data` does.
- **`returnTo` query parameters** must go through `safeReturnTo` (`src/lib/return-to.ts`), the open-redirect guard.
- **Revalidation:** category and import changes affect every signed-in page, so those actions call
  `revalidatePath("/", "layout")`.
- **No real user data in the repo.** Import tests use synthetic fixtures; `data/` and `.env*` are gitignored.

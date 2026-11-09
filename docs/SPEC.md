# Expenses Tracker — build spec

Multi-user web app for logging income, expenses and transfers across wallets held in different currencies.
This file is the contract between the planner and the executor agents. If you must deviate from it, update
this file in the same change and call the deviation out in your final report.

## Stack

- Next.js 16.4 (App Router, `src/` dir, TypeScript strict, Turbopack), React 19.3, React Server Components.
  **`cacheComponents` is off** (classic dynamic rendering): every page reads the session cookie, so pages and
  layouts can `await requireUser()` at the top level without `<Suspense>` boundaries. Don't use `'use cache'`.
- Tailwind CSS v4
- SQLite via Drizzle ORM + `better-sqlite3` (fall back to `@libsql/client` with a `file:` URL only if the
  native module cannot be installed on Node 24). DB file: `data/app.db` (gitignored), overridable with `DATABASE_URL`.
- Migrations generated with `drizzle-kit` into `drizzle/` and **applied automatically on first DB access**, so
  `npm install && npm run dev` works with no extra step.
- Validation with `zod`. Tests with `vitest` (services run against an in-memory / temp-file SQLite DB).
- No external auth provider, no REST API layer: pages read through services in Server Components and mutate
  through Server Actions.
- npm scripts: `dev`, `build`, `start`, `lint`, `typecheck` (`tsc --noEmit`), `test` (`vitest run`),
  `db:generate`, `db:seed` (demo user + sample data for local development; demo login
  `demo@example.com` / `demo-password`). `build`/`start` force `NODE_ENV=production` (a global
  `NODE_ENV=development` in the shell otherwise breaks prerendering).
- Tests live in `tests/*.test.ts(x)`. `tests/helpers.ts` gives `useFreshDb()` (fresh migrated `:memory:` DB installed
  via `setDb`) and `makeUser(db, email)` (user + default categories, `cat(name)` → category id).

## Development helpers

- **`npm run db:reset -- --demo`** puts the database into the demo state: every row of every table is deleted
  inside one transaction, then the demo user and sample data are seeded (same as `db:seed`), and the demo login
  is printed. **`npm run db:reset -- --clean`** deletes every row and leaves an empty, migrated database.
  Both keep the file (so a running dev server keeps working — it holds the same file open), run migrations
  first, write a copy `<file>.before-reset-<YYYYMMDD-HHMMSS>.bak` of a non-empty database before touching it
  (`--no-backup` skips it), and refuse to run against a database with data unless confirmed. **`--yes` is
  honoured only when `DATABASE_URL` is set explicitly on that command** (scratch databases); the default
  `data/app.db` always asks, and the answer must be the word `reset` — a stray `--yes` or `y` can never wipe
  it. Not a terminal and no usable `--yes` → refuse. They refuse outright when `NODE_ENV=production`. Without
  `--demo`/`--clean` they print usage and exit 1.
- **Demo mode on its own file.** `npm run dev:demo` runs `db:seed` and then `next dev`, both with
  `DATABASE_URL=data/demo.db` set inside the script; `npm run demo:reset` runs the reset with `--demo --yes
  --no-backup` on that file. Neither can reach `data/app.db`. `npm run dev` stays on the real database.
- **Demo login in the terminal.** When the dev server (`next dev`) opens the database and a user with user ID
  `demo` exists, it logs one line: `[demo] Sign in with user ID demo / password demo-password (if unchanged)`.
  Never in production builds. `db:seed` and `db:reset --demo` print the same line.
- As built: `scripts/reset.ts` and `scripts/seed.ts` share `src/server/maintenance.ts` (`wipeAllData`,
  `backupBeforeReset` via `VACUUM INTO`, `findDemoUser`, `seedDemoData`) and `src/lib/demo.ts` (`DEMO_USER`,
  `demoLoginLine`). The wipe also clears `sqlite_sequence`, so ids start at 1 again, and keeps
  `__drizzle_migrations`; `-y` is accepted for `--yes`. The startup line comes from `logDemoLogin` in
  `src/db/index.ts`, called by `getDb()` only when `NEXT_RUNTIME` is set (the scripts print it themselves); since
  the dev server opens the database lazily, the line appears on its first request, not at boot.
- The README's "Run it" section is the five-minute path: install, run, demo login, reset, where the DB is.
  Everything long-form (reverse proxies, backup/restore, bind mounts, upgrading, standalone without Docker)
  lives in `docs/SELF-HOSTING.md`; the README links to it.

## Domain rules

- **Money** is stored as integer **minor units** (`amountMinor`), never floats. The number of decimals comes
  from the currency (`Intl.NumberFormat(..., {style:'currency', currency}).resolvedOptions().maximumFractionDigits`
  — JPY 0, EUR 2, KWD 3). Stored amounts are always **positive**; the sign comes from the transaction kind.
- **Wallet** (a.k.a. account): belongs to one user, has a name, one ISO-4217 currency (immutable after
  creation), and an initial balance. `balance = initial + Σ income + Σ transfer_in − Σ expense − Σ transfer_out`.
  A wallet with transactions cannot be deleted, only archived (hidden from pickers and dashboard totals; its
  history stays visible). A wallet with no transactions can be deleted.
- **Category** ("transaction type"): per user, has a `kind` (`expense` | `income`). Seeded on registration:
  expense → Food, Groceries, Bills, Transport, Housing; income → Salary, Refund, Extra Income.
  The defaults are only a starting point: users add, rename and remove categories freely at `/categories`,
  and a seeded category is no different from one the user created.
  - Name: trimmed, inner whitespace collapsed, 1–40 characters, unique per user and kind **ignoring case**
    (compare case-folded in the service; the DB index stays as it is — no migration).
  - `kind` is fixed at creation (changing it would invalidate the category's transactions).
  - Removing an **unused** category deletes it. Removing a category **with transactions** requires a
    replacement category of the same kind: its transactions are moved there and the category is deleted, in one
    DB transaction. There is no archive / hidden state for categories. If no other category of that kind
    exists, the user is told to create one first.
  - A user may end up with no categories of a kind; the transaction form then shows an empty state linking to
    `/categories` instead of an empty picker.
- **Transaction**: wallet, kind, category (kind must match), positive amount in the wallet's currency,
  calendar date (`YYYY-MM-DD` string, no time zone), optional note.
- **Transfer**: moves money between two different wallets of the same user. Stored as one `transfers` row plus
  two transaction legs (`transfer_out` on the source wallet, `transfer_in` on the destination) written in a single
  DB transaction. Same currency → both legs carry the same amount. Different currencies → the user enters both
  the amount sent and the amount received (no exchange-rate service). Legs are only ever edited/deleted through
  the transfer, never individually.
- **No currency conversion, with one exception.** Totals are grouped per currency everywhere except the Overview
  Wallets card, which can show the total of all active wallets converted into the selected currency at the day's
  reference rates (see Overview → "Converted total"). Nothing converted is ever stored.
- Every query and mutation is scoped by `userId`; a user can never read or touch another user's rows.

## Data model (Drizzle, `src/db/schema.ts`)

Integer autoincrement primary keys; `createdAt` as integer timestamp; foreign keys enforced (`PRAGMA foreign_keys = ON`).

| table | columns |
|---|---|
| `users` | `id`, `username` (the "user ID": unique, stored lowercased, required), `email` (nullable; unique when present, stored lowercased), `firstName` (nullable), `lastName` (nullable), `passwordHash`, `createdAt` |
| `sessions` | `id`, `tokenHash` (unique, sha256 of the cookie token), `userId` → users (cascade), `expiresAt`, `createdAt` |
| `wallets` | `id`, `userId` → users (cascade), `name`, `currency` (3-letter code), `initialBalanceMinor` (int, may be negative), `archivedAt` (nullable), `createdAt` |
| `categories` | `id`, `userId` → users (cascade), `name`, `kind` (`expense`\|`income`), `createdAt`; unique (`userId`, `kind`, `name`) |
| `transfers` | `id`, `userId` → users (cascade), `date`, `note` (nullable), `createdAt` |
| `transactions` | `id`, `userId` → users (cascade), `walletId` → wallets (restrict), `kind` (`expense`\|`income`\|`transfer_out`\|`transfer_in`), `categoryId` → categories (restrict, null for transfer legs), `amountMinor` (int > 0), `date` (`YYYY-MM-DD`), `note` (nullable), `transferId` → transfers (cascade, null for non-transfers), `createdAt`; indexes on (`userId`, `date`), (`walletId`, `date`), (`transferId`) |

## Auth

- **User ID + password.** Every account has a user ID (`username`) that the user chooses at registration and signs
  in with. Email, first name and surname are all **optional**. Open registration at `/register`, sign-in at
  `/login`, sign-out action in the app shell.
  - User ID rules: 3–32 characters from `a–z`, `0–9`, `.`, `_`, `-`; must start with a letter or digit; compared
    and stored lowercased (so `Alex` and `alex` are the same account); never contains `@`, which is what keeps it
    distinguishable from an email. Unique.
  - Email, when given: valid, stored lowercased, unique among accounts that have one. An empty field means "no
    email" (stored as NULL, never as an empty string).
  - First name / surname, when given: trimmed, at most 80 characters each; empty → NULL.
  - **Sign-in takes one identifier field, "User ID or email"**: a value containing `@` is looked up as an email,
    anything else as a user ID. Both are case-insensitive. Accounts created before user IDs existed keep signing in
    with their email, and also get a user ID (below).
  - Display name everywhere (shell, greeting): first name + surname when either is set, otherwise the user ID. The
    shell's secondary line shows the user ID (and the email when there is one).
  - As built: the rules live in `src/lib/user-id.ts` (client-safe: `USER_ID_RE`, `USER_ID_HINT`, `NAME_MAX`,
    `normalizeUserId`, `userIdProblem`, `displayName`). Lookups compare `lower(username)` / `lower(email)`, so an
    email the migration carried over in mixed case is still found and still blocks a duplicate. A user ID problem
    is reported in this order: empty, contains `@`, too short, too long, bad first character, other characters.
    The account menu (top bar, after the redesign; the old sidebar until then): display name, then the user ID
    (when it differs from the display name), then the email (when there is one), one per line, then Sign out. Long
    values truncate with an ellipsis and a tooltip.
  - There is no profile screen yet: the user ID, email and names cannot be changed after registration.
- **Migration of existing accounts** (`drizzle/0001_*`): `email` becomes nullable; `name` is split at the first
  space into `first_name` / `last_name`; `username` is derived from the email's local part, lowercased, with any
  character outside the allowed set replaced by `-`, falling back to `user<id>` when that leaves nothing valid,
  and suffixed with `-<id>` when it collides with another account. No account, wallet, category, transaction,
  transfer or session may be lost or altered by it.
  - As built (hand-written SQL in `drizzle/0001_user_ids.sql`, a recursive CTE walks the local part character by
    character): the local part is everything before the first `@`; after replacing, leading `.`/`_`/`-` are
    dropped and the result is cut to 32 characters; fewer than 3 characters left → `user<id>`. "Collides" means an
    account with a lower id has the same value; the suffixed form shortens the base so it stays ≤ 32. A suffixed
    value that equals another account's plain one (`bob-5`) makes the higher id fall back to `user<id>`; anything
    still colliding fails the unique index, which rolls the whole migration back (startup then fails with the
    backup's location). The name is trimmed first, split at the first space; the surname is trimmed, empty → NULL;
    a blank name → both NULL. Email, password hash, `created_at` and `id` are copied unchanged (emails keep their
    case). The `PRAGMA foreign_keys` lines drizzle-kit writes into the file were removed (no-ops in a transaction).
- **Applying migrations safely (`src/db/index.ts`).** Changing a column's nullability in SQLite rebuilds the
  table, and dropping the old `users` table while foreign keys are enforced would cascade-delete every row that
  references a user. So: migrations run with `PRAGMA foreign_keys = OFF` set **before** the migrator starts (the
  pragma is ignored inside a transaction, which is why a `PRAGMA` line inside the migration file is not enough),
  then foreign keys are switched back on and `PRAGMA foreign_key_check` must come back empty, otherwise startup
  fails loudly. Before applying pending migrations to an existing database file that already has data, a copy of
  it is written next to it (`<file>.before-migration-<tag>.bak`), so a bad upgrade can be undone by hand.
  - As built (`migrateDatabase(db, { file, migrationsFolder? })` in `src/db/index.ts`, called by `createDatabase`):
    (1) `foreign_keys = OFF`; (2) pending = journal entries newer than the last row of `__drizzle_migrations`
    (drizzle's own rule); (3) if any are pending, `file` is not `:memory:` and the database has at least one table,
    `VACUUM INTO '<file>.before-migration-<first pending tag>.bak'` (a self-contained, non-WAL file; if that name
    exists, `.<ISO timestamp>` is added before `.bak` — a copy is never overwritten) and a `[db] …` line is
    logged; (4) drizzle's `migrate` (all pending migrations in one transaction); (5) `foreign_keys = ON` (in a
    `finally`); (6) `PRAGMA foreign_key_check` — **on every start, not only after migrating** — must be empty,
    else it throws "Database integrity check failed: N row(s) … Refusing to start." naming up to five rows and
    the copy. A failed migration is rethrown as "Database migration failed: … Nothing was changed (the migration
    was rolled back); a copy is at …". On any error the connection is closed.
  - Why (measured, `tests/migrations.test.ts`): with foreign keys ON, `DROP TABLE users` in the rebuild is an
    implicit `DELETE FROM users`. In a database with no transactions the migration "succeeds" and every wallet,
    category and session is cascade-deleted. With at least one transaction the cascade reaches `wallets` before
    `transactions`, `transactions.wallet_id` is `ON DELETE RESTRICT`, the statement fails with "FOREIGN KEY
    constraint failed" and the migration is rolled back — no loss, but the app could never start.
- Passwords hashed with `node:crypto` scrypt (random salt, timing-safe compare). Min length 8.
- DB-backed sessions: random 32-byte token in an `httpOnly`, `sameSite=lax` cookie (30-day expiry) whose `secure`
  flag follows `COOKIE_SECURE` (see Deployment; logic in `src/lib/config.ts`); only its sha256 is stored. Logout
  deletes the session row.
- `ALLOW_REGISTRATION=false` (`isRegistrationAllowed()` in `src/lib/config.ts`): `/register` renders a "Registration
  is disabled" card, `registerAction` returns an error without creating anything, `/login` hides the sign-up link.
- `src/lib/auth.ts` exposes `getCurrentUser(): Promise<CurrentUser | null>` (React `cache`, per request),
  `requireUser(): Promise<CurrentUser>` (redirects to `/login`), `createSession(userId)`, `destroySession()`,
  `redirectIfSignedIn()`; `CurrentUser = { id: number; username: string; email: string | null; firstName: string | null; lastName: string | null; displayName: string }`. Cookie name `et_session`.
  The `(app)` layout calls `requireUser()`; every Server Action calls it too (layouts don't protect actions).
  Signed-in users visiting `/login` or `/register` are redirected to `/`.
- Password hashing lives in `src/lib/password.ts` (`hashPassword`, `verifyPassword`); user creation/login in
  `src/server/users.ts`: `registerUser({ username, password, email?, firstName?, lastName? }): Promise<UserView>`
  (user + default categories in one DB transaction; CONFLICT on `username` or `email` if taken) and
  `authenticateUser(identifier, password): Promise<UserView | null>` (identifier = user ID or email).
  `UserView` has the same shape as `CurrentUser`; `toUserView(row)` builds it. Uniqueness is checked before
  hashing and again inside the insert's transaction; a unique-index error from a lost race is mapped to the right
  field. Inputs are named `username`, `password`, `email`, `firstName`, `lastName`; the action passes empty optional
  fields through and the service turns them into NULL.
  Sign-out is `signOutAction` in `src/app/(app)/actions.ts`.
- Login failures return one generic message ("Invalid user ID, email or password"), taking similar time whether
  or not the account exists. The login form field is named `identifier`; an empty or blank identifier never
  matches an account (also not one without email).

## Layout

```
src/
  app/
    (auth)/login/        (auth)/register/          # public pages + their actions.ts
    (app)/layout.tsx  (app)/actions.ts              # requireUser + shell (nav, user menu, sign out action)
    (app)/page.tsx                                  # dashboard
    (app)/wallets/…      (app)/transactions/…       # feature routes, each with its own actions.ts
    (app)/categories/…                              # page + actions.ts + form-input.ts (pure parsing)
    (app)/data/                                     # /data import & export page + actions.ts (preview / run import)
  components/ui/                                    # primitives, barrel-exported from "@/components/ui"
  components/transaction-list.tsx                   # shared read-only list of TransactionView rows
  components/shell/  components/brand.tsx           # app shell pieces (top menu, account menu, Add button, icons)
  components/charts/                                # DayBars, RunningLine (redesign)
  components/dashboard/                             # Overview pieces: MonthChart, WalletsCard / LatestCard, MonthSwitcher
  lib/chart-scale.ts  lib/overview.ts               # pure chart scale + Overview helpers (cap rule, axis, pace wording)
  app/(app)/@modal/                                 # intercepted dialog routes: (.)transactions/new, (.)wallets/new, (.)wallets/[id]/edit
  server/insights.ts                                # per-currency timelines and insight figures (redesign)
  db/schema.ts  db/index.ts                         # schema, connection, auto-migrate
  lib/auth.ts  lib/money.ts  lib/currencies.ts  lib/dates.ts  lib/errors.ts
  lib/form.ts  lib/password.ts  lib/constants.ts  lib/cn.ts  lib/config.ts (env: ALLOW_REGISTRATION, COOKIE_SECURE)
  lib/user-id.ts                                    # user ID rules + displayName (client-safe)
  lib/calendar.ts                                   # pure calendar helpers for the date / month pickers
  lib/csv.ts  lib/backup-format.ts  lib/context-format.ts  # pure import/export formats
  app/api/health/route.ts                           # GET /api/health
  app/api/export/{backup,transactions,context}/route.ts  # downloads (session required)
  components/data/import-panel.tsx                  # client: two-step import UI
  components/data/import-preview.tsx                # the preview card, problems and success banner (no state)
  components/data/copy-context-button.tsx           # client: "Copy to clipboard" for the wallets & categories export
  server/wallets.ts  server/categories.ts  server/transactions.ts  server/transfers.ts  server/dashboard.ts
  server/export.ts  server/import.ts
  server/users.ts  server/_validate.ts (internal helpers)
scripts/seed.ts  tests/  drizzle/
```

`src/db/index.ts`: `getDb()` (process-wide connection, created + migrated on first access, survives HMR),
`createDatabase(url?)`, `migrateDatabase(db, { file, migrationsFolder? })` and `pendingMigrations(db, folder?)` (see
"Applying migrations safely"), `setDb(db)` (tests), `type DB` (includes `$client`, the better-sqlite3 handle),
`type DBOrTx`. `DATABASE_URL` accepts a path,
`file:./x.db` or `:memory:` (parent dir created if missing). Migrations folder: `MIGRATIONS_DIR` or
`<cwd>/drizzle`; `next.config.ts` traces `drizzle/**` into `.next/standalone`, so `node server.js` run from
`.next/standalone` auto-migrates without extra copying.

## Service layer (`src/server/*`, server-only, every function takes `userId` first)

Services validate input, enforce ownership and domain rules, and throw `ServiceError` (`src/lib/errors.ts`,
with `code: 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT'`, a user-presentable `message`, and an optional `field` naming
the form input it belongs to). Server Actions parse form data with zod, call a service, map `ServiceError` to a
returned form state, then `revalidatePath`/`redirect`.

**Services are synchronous** (better-sqlite3): they return values, not promises (`await`-ing them is harmless).
Only `registerUser`/`authenticateUser` are async (scrypt). Ids are `number`. Accessing another user's row
behaves exactly like a missing row: getters return `null`, mutations throw `NOT_FOUND`.

`ServiceError.field` values used: `name`, `currency`, `initialBalance`, `walletId`, `kind`, `categoryId`, `amount`,
`receivedAmount`, `fromWalletId`, `toWalletId`, `date`, `note`, `from`, `to`, `month`, `username`, `email`,
`firstName`, `lastName`, `password`, `moveToCategoryId`.
Name your form inputs the same so `serviceErrorState` lands errors on the right field.

### Server Action form state (copy this pattern — see `src/app/(auth)/register/actions.ts` + `register-form.tsx`)

```ts
// src/lib/form.ts
type FormState = { ok?: boolean; message?: string; fieldErrors?: Partial<Record<string, string>>; values?: Record<string, string> };
initialFormState: FormState                          // {}
formValues(formData, omit?: string[]): Record<string, string>   // raw values to echo back (omit secrets)
zodErrorState(zodError, values?): FormState           // first issue per field + generic message
serviceErrorState(err, values?): FormState            // ServiceError → field/message; any other error is re-thrown

// actions.ts
"use server";
export async function createThingAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const values = formValues(formData);
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return zodErrorState(parsed.error, values);
  try { createThing(user.id, parsed.data); } catch (err) { return serviceErrorState(err, values); }
  revalidatePath("/things");
  redirect("/things");                                 // outside the try: redirect() throws
}

// form.tsx ("use client")
const [state, formAction] = useActionState(createThingAction, initialFormState);
<form action={formAction}> <FormError message={state.message} />
  <Field id="amount" label="Amount" error={state.fieldErrors?.amount}>
    <Input id="amount" name="amount" defaultValue={state.values?.amount} error={state.fieldErrors?.amount} />
  </Field>
  <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
</form>
```

Amount inputs are strings: parse them in the action with `parseAmount(value, wallet.currency)` (look the wallet up
with `getWallet` to know the currency) and return a `fieldErrors.amount` when it yields `null`. React resets
uncontrolled forms after an action, hence `values` + `defaultValue`. For one-click actions (archive, delete) a plain
`<form action={boundAction}>` with `<SubmitButton>` is fine; ask for confirmation first (e.g. a client
`onSubmit={(e) => { if (!confirm("Delete?")) e.preventDefault(); }}`).

```ts
// wallets.ts
type WalletView = { id; name; currency; initialBalanceMinor; balanceMinor; transactionCount; archivedAt: Date | null; createdAt: Date }
listWallets(userId, opts?: { includeArchived?: boolean }): WalletView[]        // archived excluded by default; active first, then by name (case-insensitive)
getWallet(userId, walletId): WalletView | null                                 // archived wallets included
createWallet(userId, { name, currency, initialBalanceMinor }): WalletView      // name trimmed 1–60 chars; currency upper-cased + validated; initial may be negative
updateWallet(userId, walletId, { name, initialBalanceMinor }): WalletView     // currency is immutable
archiveWallet(userId, walletId): WalletView / unarchiveWallet(userId, walletId): WalletView
deleteWallet(userId, walletId): void                                           // CONFLICT if it has transactions

// categories.ts
type CategoryView = { id; name; kind: 'expense' | 'income' }
listCategories(userId, kind?): CategoryView[]                                  // kind asc (expense first), then name (case-insensitive)
getCategory(userId, categoryId): CategoryView | null
seedDefaultCategories(userId, tx?)                                             // called inside registration's DB transaction; idempotent
DEFAULT_CATEGORIES: Record<'expense' | 'income', string[]>
type CategoryWithUsage = CategoryView & { transactionCount: number }
listCategoriesWithUsage(userId): CategoryWithUsage[]                           // same order as listCategories
createCategory(userId, { name, kind }): CategoryView                           // VALIDATION (field name | kind), CONFLICT (field name) on duplicate
renameCategory(userId, categoryId, { name }): CategoryView                     // NOT_FOUND; same rules; changing only the letter case of its own name is allowed
deleteCategory(userId, categoryId, opts?: { moveToCategoryId?: number }): { movedTransactions: number }
// deleteCategory: NOT_FOUND if not owned. Unused → deleted (moveToCategoryId ignored). In use and no
// moveToCategoryId → CONFLICT (field moveToCategoryId) naming the transaction count. moveToCategoryId must be a
// different category owned by the same user with the same kind, else VALIDATION (field moveToCategoryId).
// The re-pointing of transactions and the delete happen in one DB transaction.

// transactions.ts
type TransactionView = {
  id; kind: 'expense' | 'income' | 'transfer_out' | 'transfer_in';
  walletId; walletName; currency;
  categoryId: number | null; categoryName: string | null;
  amountMinor: number;            // always positive
  signedAmountMinor: number;      // negative for expense / transfer_out
  date: string; note: string | null;
  transferId: number | null;
  counterparty: { walletId; walletName; currency; amountMinor } | null   // the other leg, for transfers
}
type TransactionFilters = { walletId?; kind?: 'expense' | 'income' | 'transfer'; categoryId?; from?: string; to?: string; q?: string; limit?: number; offset?: number }
type TransactionInput = { walletId; kind: 'expense' | 'income'; categoryId; amountMinor; date; note?: string | null }
listTransactions(userId, filters?): { items: TransactionView[]; total: number }   // date desc, id desc; default limit 50, clamped to 1..200
//   kind 'transfer' matches both legs; from/to inclusive (malformed → VALIDATION); q = case-insensitive substring of the note
//   (transfer legs carry a copy of the transfer note, so they match too); total = count of all matches ignoring limit/offset
getTransaction(userId, id): TransactionView | null                                 // includes transfer legs (use transferId to route to the transfer editor)
createTransaction(userId, TransactionInput): TransactionView
updateTransaction(userId, id, TransactionInput): TransactionView   // rejects transfer legs (VALIDATION)
deleteTransaction(userId, id): void                                // rejects transfer legs (VALIDATION)
// Rules: wallet owned (NOT_FOUND) and not archived (VALIDATION) — except that an existing transaction may stay on the
// archived wallet it already belongs to when edited; category owned (NOT_FOUND) with kind === transaction kind
// (VALIDATION, field categoryId); amountMinor safe integer > 0; valid date; note trimmed, ≤ 500 chars, '' → null.

// transfers.ts
type TransferView = { id; date; note; from: { walletId; walletName; currency; amountMinor }; to: { walletId; walletName; currency; amountMinor } }
type TransferInput = { fromWalletId; toWalletId; amountMinor; receivedAmountMinor?: number | null; date; note?: string | null }
getTransfer(userId, transferId): TransferView | null
createTransfer(userId, TransferInput): TransferView
updateTransfer(userId, transferId, TransferInput): TransferView     // rewrites the transfer row and both legs atomically
deleteTransfer(userId, transferId): void                            // removes the transfer and both legs
// Rules: from ≠ to (VALIDATION, field toWalletId); both wallets owned (NOT_FOUND, field fromWalletId/toWalletId) and not
// archived — except a wallet the transfer already used on the same side when editing; same currency ⇒ received = sent
// (receivedAmountMinor ignored); different currency ⇒ receivedAmountMinor required and > 0 (field receivedAmount).

// dashboard.ts
getDashboard(userId, opts?: { month?: string /* YYYY-MM, default current; invalid → VALIDATION */ }): {
  month: string;
  wallets: WalletView[];                                                     // active only
  totalsByCurrency: { currency; balanceMinor; incomeMinor; expenseMinor }[]; // one row per currency of an active wallet, sorted by code;
                                                                             // income/expense for the month on active wallets, transfers excluded
  expenseByCategory: { currency; categoryId; categoryName; amountMinor }[];  // for the month on active wallets, largest first
  recent: TransactionView[];                                                 // latest 8, all wallets (archived included)
}

// insights.ts (redesign) — every figure is for ONE currency; nothing is converted. "Expense" / "income" mean
// transactions of those kinds (transfers excluded) on all wallets of that currency, archived included, unless a
// walletId narrows it. Day N = today's day for the current month (server local time), the month's last day for a
// past month, 0 for a future month (empty arrays / zeros, no error). An invalid `month` → VALIDATION (field `month`);
// a `currency` that is not a valid uppercase ISO code → VALIDATION (field `currency`); a valid currency the user
// holds no wallet in just gives zeros.
pickDefaultCurrency(userId, month): string | null
//   the currency with the most expense + income entries in the month (archived wallets included, so it can be a
//   currency held only in archived wallets — the currency switch must show the current value even then); tie or
//   none → the currency of the active wallet with the most transactions overall (then by code); no active wallets
//   → null. A `?currency=` the user has no wallet in is ignored (falls back to this).
listUserCurrencies(userId): string[]                                         // currencies of active wallets, by code
getMonthTimeline(userId, { month; currency; walletId?; categoryId? }): {    // walletId/categoryId not a positive
                                                                            // integer → VALIDATION; another user's → zeros
  days: { date; expenseMinor; incomeMinor }[];   // every calendar day of the month, zeros included
  previousCumulativeMinor: number[];             // running expense total per day of the previous month (index 0 = day 1),
                                                 // one entry per day of that month
  largestDay: { date; amountMinor; label } | null // the month's biggest expense day (earliest on a tie; the whole month,
                                                 // not only days 1..N) and its largest entry's note, else its category
}
getMonthInsights(userId, { month; currency }): {
  incomeMinor; expenseMinor; netMinor;          // the whole month (future-dated entries included)
  topCategory: { categoryId; categoryName; amountMinor; sharePercent } | null;   // largest expense category (then by
                                                // name); sharePercent rounded to a whole percent; null without expenses
  pace: { day: number; thisMonthMinor; previousMonthMinor };   // day = N; cumulative expenses through day N vs through
                                                              // min(N, previous month's length) of the previous month
  noSpendDays: { days; outOf; previousDays; previousOutOf };   // days 1..N with no expense in this currency (outOf = N);
                                                              // previous* = the same over the whole previous month
}
getWalletMonth(userId, walletId, month): {                    // null when the wallet is not the user's (archived works)
  openingMinor;                     // balance at the start of the month: initial + every entry dated before it
  inMinor; outMinor;                // the whole month, transfers included (each leg in its own wallet's amount)
  entryCount; totalEntryCount;      // entries this month / ever
  days: { date; inMinor; outMinor; closingMinor }[]   // days 1..N; closingMinor = balance after that day
} | null
// transactions.ts additions
listDayTotals(userId, filters: TransactionFilters, dates: string[]): { date; currency; netMinor }[]
//   net per (date, currency) over ALL matches of the filters on those dates (limit/offset ignored); transfer legs count
//   as money out / in of their own wallet; only pairs with entries, by date desc then currency; malformed dates ignored
// TransactionFilters gains `month?: 'YYYY-MM'`: the month's first to last day, unless `from` or `to` is given (then
// the month is ignored, but still validated: invalid → VALIDATION, field `month`). It applies to the CSV export too.
// categories.ts change
type CategoryWithMonthUsage = CategoryWithUsage & { monthCount: number; monthAmountMinor: number }
listCategoriesWithUsage(userId, opts?: { month?: string; currency?: string }): CategoryWithMonthUsage[]
//   monthCount over all currencies; monthAmountMinor in opts.currency only (0 without it); both 0 without opts.month.
//   Invalid month / currency → VALIDATION (field month / currency)
```

New Server Actions for in-place editing return form state instead of redirecting:
`updateTransactionInlineAction(id, prev, formData)`, `updateTransferInlineAction(transferId, prev, formData)` (same
zod schemas and services as the edit pages; on success `{ ok: true }` + `revalidatePath("/", "layout")`), and the
Add dialog's create actions gain a `mode: "dialog"` hidden field that makes them return `{ ok: true }` instead of
redirecting. As built (step 4): the inline actions return `{ ok: true, message }` — "Saved €4.80 · Food" / "Saved
€60.00 from Cash to Bank" — which the list announces in a visually hidden status line when the row closes; errors come
back as `{ fieldErrors, message?, values }` exactly like the edit pages' actions.

`src/lib/money.ts`: `currencyDecimals(code)`, `parseAmount(input: string, currency, opts?: { allowNegative?: boolean }): number | null`
(accepts `12`, `12.5`, `12,50`, `1 234.56`, `1,234.56`, `1.234,56`; a lone `,` is always the decimal separator; rejects
more decimals than the currency allows, negatives unless `allowNegative` (use it for a wallet's initial balance), junk;
returns `0` for zero — callers that need > 0 must check), `formatMoney(minor, currency, opts?: { signed?: boolean })`
(en-US, narrow symbol, e.g. `-€12.50`, `+$3.00`, `¥1,500`), `minorToInputValue(minor, currency)` (e.g. `"1234.50"`).
`src/lib/currencies.ts`: `CURRENCIES: { code, name }[]` from `Intl.supportedValuesOf('currency')` with English display
names, common ones (EUR, USD, GBP, RON, CHF, JPY, CAD, AUD, SEK, NOK, DKK, PLN, HUF, CZK) pinned first;
`PINNED_CURRENCIES`, `currencyName(code)`, `isValidCurrency(code)` (uppercase 3-letter code only).
`src/lib/dates.ts`: `todayISO()`, `currentMonth()` (server local time), `isValidDate`, `isValidMonth`,
`monthRange(month) → { from, to }` (inclusive), `shiftMonth(month, delta)`, `addDays(date, n)`, `addMonths(date, n)`
(day clamped to the target month: `"2026-01-31"` + 1 → `"2026-02-28"`), `formatDate(date)`
(`"5 Nov 2026"`), `formatMonth(month)` (`"November 2026"`).
`src/lib/calendar.ts` (no React; Monday-first): `WEEKDAY_LABELS` (`Mo`…`Su`), `WEEKDAY_NAMES`, `MONTH_LABELS`
(`Jan`…`Dec`), `monthOf(date)`, `weekdayIndex(date)` (0 = Monday), `calendarWeeks(month) → string[][]` (always 6 × 7
dates from the Monday on or before the 1st, so neighbouring months fill the gaps), `moveDate(date, key, shift) →
string | null` (day grid: arrows ±1 day / ±1 week, Home / End to Monday / Sunday, PageUp / PageDown ±1 month, with
Shift ±1 year; `null` for other keys or outside 1900–2999), `moveMonth(month, key)` (month grid, 3 columns: ±1, ±3,
Home / End to Jan / Dec, PageUp / PageDown ±1 year), `dateInMonth(date, month)`, `clampTo(value, min?, max?)`,
`dateLabel(date)` (`"Thursday 5 November 2026"`, for `aria-label`s).

## Shared UI (`src/components`)

All primitives are exported from `@/components/ui`. They take normal HTML props plus:

- `Button` `{ variant?: 'primary'|'secondary'|'ghost'|'danger'; size?: 'sm'|'md'; pending?: boolean }`;
  `LinkButton` (a `next/link` styled as a button, same `variant`/`size`); `buttonClasses(opts)`; `Spinner`.
- `SubmitButton` (client) — `Button` props + `pendingLabel?`; shows a spinner and disables itself while the parent
  form's action runs (`useFormStatus`).
- `Input`, `Textarea`, `Select` (native, children are `<option>`s) — `error?: string` sets `aria-invalid` and
  `aria-describedby="<id>-error"`.
- `Field` `{ id; label; hint?; error?; className? }` — label + control + hint + inline error (`<id>-error`); `FieldError`,
  `Label`.
- `DatePicker` (client) `{ id; name; defaultValue?: 'YYYY-MM-DD' | ''; required?; error?; allowEmpty?; max?;
  align?: 'start'|'end'; placeholder? }` — used for every date field instead of `<input type="date">`. Renders a
  trigger `<button type="button" id={id} role="combobox" aria-haspopup="dialog">` styled like `Input`, showing
  `formatDate(value)` or "Pick a date", with the same `aria-invalid` / `aria-describedby="<id>-error"` convention,
  plus **`<input type="hidden" name={name} value="YYYY-MM-DD">`**: forms post exactly what a native date input
  would, so actions, zod schemas and services are unchanged. With `allowEmpty` an empty picker renders **no** hidden
  input (a GET form then leaves the parameter out of the URL) and a set one shows a "Clear date" × button.
  Uncontrolled: it reads `defaultValue` once, so a form that must reset it remounts (`key`). Added in step 6:
  `value?` + `onChange?(value)` make it controlled (the Add form's Today / Yesterday pills set the same value);
  `display?: ReactNode` replaces the trigger's text, `'aria-label'?` names the trigger when no `<label for>` does, and
  `triggerClassName?` replaces its field styling (the Add form draws it as a pill). The popover
  (`role="dialog"`, "Choose a date"): ‹ › month buttons, a "November 2026" button that switches to a `MonthGrid`
  (picking a month returns to the days; Escape there steps back instead of closing), a Monday-first 6-week grid
  (`role="grid"`, day buttons `role="gridcell"` with `aria-selected`, `aria-current="date"` for today and the full
  date as `aria-label`; neighbouring months dimmed, today ringed, the selection filled with the accent), and a footer
  with "Today" and, with `allowEmpty`, "Clear". Picking closes it and returns focus to the trigger. Keyboard in the
  grid: see `moveDate`; one day is in the Tab order (roving tabindex); moving past the shown month changes month.
- `MonthGrid` (client) `{ value: 'YYYY-MM' | null; onSelect(month); minMonth?; maxMonth?; focusMonth?; autoFocus? }` —
  year stepper (‹ 2026 ›) over a 3 × 4 grid of `aria-pressed` month buttons; months outside the bounds are
  disabled; the current month has a ring when not selected. Keyboard: see `moveMonth`; roving tabindex.
- `Popover` (client) `{ open; onClose; anchor; trigger; align?: 'start'|'end'; id?; role?: 'dialog'|'listbox'; 'aria-label'?; className? }` —
  no portal: an absolutely positioned panel under `anchor` (the trigger's `relative` wrapper). Renders nothing when
  closed; closes on Escape (unless the panel already handled it with `preventDefault`), on pointer-down outside
  `anchor` and when focus moves outside it; returns focus to `trigger` unless the user clicked or tabbed elsewhere.
  It shifts itself sideways to stay 8px inside the viewport, so it never causes horizontal scroll at 375px.
- `FormError` `{ message? }` — form-level `role="alert"` banner. `Card`, `CardHeader { title; description?; actions? }`,
  `CardBody`. `Badge` `{ tone?: 'neutral'|'accent'|'income'|'expense'|'transfer'|'danger' }`.
  `EmptyState` `{ title; description?; action?; icon? }`. `PageHeader` `{ title; description?; actions? }` (page `<h1>`).
- `Amount` `{ minor; currency; kind?: TransactionKind; signed?; colorNegative?; className? }` — `tabular-nums`, coloured by kind.
- `TransactionList` (`@/components/transaction-list`) `{ items: TransactionView[]; renderActions?: (t) => ReactNode;
  showWallet?: boolean = true; emptyMessage?; className? }` — server-safe `<ul>`; also exports `transactionLabel(t)`
  ("Food", "Transfer → Savings", "Transfer ← Cash"). Wrap it in a `Card` yourself.
- The shell (`(app)/layout.tsx`) already renders the top bar, the page container (`max-w-[1240px]`, padding, room
  at the bottom for the floating Add button) and the `@modal` slot — pages just render `PageHeader` + content.
- Added by the redesign (see "UI direction" and "Screens"):
  - `Dialog` (client) `{ title; description?; onClose?; className?; children }` — the modal frame used by the
    intercepted routes; a bottom sheet below `sm`. As built: `onClose` defaults to `router.back()`; `className`
    replaces the desktop width (`sm:max-w-xl` by default; the Add dialog uses `sm:max-w-2xl`); the title is an
    `<h2>` the dialog is labelled by, `description` a line under it (`aria-describedby`). Focus goes to the panel
    on open and back to the previously focused element on close; Tab / Shift+Tab cycle inside; Escape is handled on
    `window`, after document-level handlers, so an open popover inside (the date picker) closes first and the
    dialog stays. The page's scroll is locked on `<html>` (with scrollbar-width compensation). No portal (`fixed`,
    `z-50`). **It renders nothing once `usePathname()` differs from the path it opened at**: a parallel slot keeps
    its last content on a soft navigation to a URL it does not match, so a form that redirects on success, or a
    link inside the dialog, would otherwise leave it open over the next page.
  - `Segmented` (client) `{ name; options: { value; label }[]; value?; defaultValue?; onChange?(value);
    'aria-label'?; 'aria-labelledby'?; fullWidth?; className? }` — radio group drawn as a pill track (type
    switches, currency switch). Controlled with `value` + `onChange`, else uncontrolled with `defaultValue`;
    `fullWidth` shares the width equally between the options.
  - `PillPicker` `{ name; options: { value; label }[]; defaultValue?; error?; id?; 'aria-label'?;
    'aria-labelledby'?; required?; className? }` — radio group drawn as wrapping pills (category and wallet in the
    Add form, currency in the wallet form). Uncontrolled (remount with `key` to reset). A `<label for>` cannot name
    a group: label it with `aria-labelledby` pointing at a visible heading. With `id` and `error` it renders the
    error as `<id>-error` (same convention as `Field`) and sets `aria-invalid` / `aria-describedby` on the group.
    Step 6 added `onChange?(value)` (it stays uncontrolled; the Add form mirrors the wallet choice to show its
    currency) and exports `pillClasses({ selected?, error? })`, the pill look for buttons that are not radios.
  - Both are real `<input type="radio">`s (visually hidden, `sr-only`) inside `<label>`s, in a `role="radiogroup"`:
    the form posts `name=value`, arrow keys move the choice, and the focused option shows the focus ring
    (`peer-focus-visible`). `ChoiceOption` = `{ value: string; label: ReactNode }`.
  - `DayBars` `{ days: { date; value; tone? }[]; cap?; selectedDate?; hrefFor?(date) }` — the per-day bar row; with
    `hrefFor` each bar is a link.
    As built (step 3, `@/components/charts`): `{ days: { date; value; tone?: 'accent'|'income'|'muted'|'future' }[];
    max?; cap?: { date; label }; selectedDate?; hrefFor?(date); ariaLabelFor(date, value); height?; className? }`.
    Server-renderable. A CSS grid, one column per day (`repeat(N, minmax(0,1fr))`, 2px gap, 5px from `sm`); each bar
    is absolutely positioned at the bottom of its column with `height: value / max` (default `max` = the largest
    value; values above `max` are clipped to full height); a day with value 0 shows a 2px stub (`--border`, or
    `--chart-future` for tone `future`). With `selectedDate` the selected bar is accent and the others
    `--border-strong`. With `hrefFor` each column is a `next/link` (`aria-label` from `ariaLabelFor`,
    `aria-current="date"` on the selected one); without it the whole row is `aria-hidden`. `cap` adds a 24px label
    row at the top: the pill ("Rent €1,150.00", accent fill, 11px/700, `z-10` so lines drawn over the chart do not
    cover it) sits over the capped bar (aligned to its left edge in the first half of the month, its right edge in
    the second), and the capped bar is drawn at full height with a square top and a 3px `--surface` gap near the
    top (a "broken axis" mark). Without `height` the row fills its parent: size it with a wrapper (the Overview
    puts it in an `absolute inset-0` div — do not pass `absolute` through `className`, `cn()` does not drop the
    row's own classes). The cap is decided by `pickScale` (`lib/chart-scale.ts`, below).
  - `RunningLine` — the SVG overlay: current, previous (dashed) or balance series scaled to the same box.
    As built (step 3): `{ series: { values; tone: 'foreground'|'muted'|'accent'; dashed? }[]; max; days; ariaLabel;
    className? }` — an `absolute inset-0` `<svg viewBox="0 0 <days*20> 200" preserveAspectRatio="none" role="img">`
    (put it in a `relative` box), `overflow-visible`, `pointer-events-none`; one `<polyline>` per series with
    `stroke="currentColor"` and a `text-*` class (`muted` = `--border-strong`, the previous-month colour), stroke 2.5
    (2 and `5 5` dashes when `dashed`), `vector-effect="non-scaling-stroke"`. Points (`linePoints(values, max, days)`):
    a start at 0 on the left edge, then day i at x = i·20 + 10 (the middle of its column), y = 200 − value/max·200;
    values past `days` are dropped.
  - `InsightCard` `{ title; value; sub?; tone? }`.
    As built (step 3): `tone?: 'default'|'income'|'expense'` colours the value (`text-income` / `text-expense`);
    a `<section>` card (18px radius), title an `<h2>` 13px/600 muted, value 22px (26px from `sm`)/800 tabular and
    truncated, sub 13px muted.
  - `ExpandableRow` (client) — a row button + an in-place panel with one-open-at-a-time behaviour per list.
    As built (step 4, `components/ui/expandable-row.tsx`): `ExpandableList { children; defaultOpenId? }` holds the
    open row id (one open row across everything inside it, e.g. every day group of a page) and renders a visually
    hidden `role="status"` line; it renders no element of its own. `ExpandableRow { id; summary; panel; panelLabel;
    className?; buttonClassName?; after? }` is an `<li>` (`bg-surface-open` while open) holding a full-width
    `<button type="button" aria-expanded aria-controls>` with `summary` inside (phrasing content only), then `after`
    (outside the button), then — only while open — `<div role="region" aria-label={panelLabel}>` with `panel`, so a
    closed row costs nothing. Escape closes the open row and focuses its button when the event's target is inside
    the row and nothing handled it first (listened on `window`, like `Dialog`, so an open date picker inside closes
    first). `useExpandableRow()` (inside a panel) gives `close({ restoreFocus? })` (Cancel; focus back to the row
    button by default) and `saved(message?)` (close + announce). `toggleOpen(current, id)` is the pure click rule.
  - `CurrencySwitch` `{ currencies; value; hrefFor(code) }`.
    As built (step 3): a `<nav aria-label="Currency">` (overridable with `aria-label`) holding a `Segmented`-styled
    track of `next/link`s (`scroll={false}`, `title` = the currency name, `aria-current="true"` on `value`); a `value`
    missing from `currencies` is added (codes sorted) so the selection always shows. The track scrolls sideways
    inside itself instead of widening the page. Server-renderable.
  - `MonthSwitcher` (client, `components/dashboard/month-switcher.tsx`) gained `extraParams?: Record<string,string>`
    in step 3: kept on every link it builds (`{ currency: "RON" }` → `/?month=2026-10&currency=RON`, the current
    month → `/?currency=RON`).
  - Chart and Overview helpers (pure, step 3): `lib/chart-scale.ts` — `median`, `pickScale(days) → { max;
    cappedDate? }` (cap the largest day when it is more than `CAP_FACTOR` = 3 × the median of the non-zero days
    **and** more than `CAP_HEADROOM` = 1.2 × the next largest day; then `max` = that next day × 1.2; otherwise `max`
    = the largest day; earliest on a tie), `cumulative(values)`, `axisTicks(monthShort, length, today | null)`.
    `lib/overview.ts` — `resolveOverviewCurrency(requested, heldCurrencies, pickDefault)`, `overviewHref(month,
    currency, maxMonth, basePath = "/")` (step 7 added `basePath` for `/categories`), `paceSummary(…)`, `toneOf(minor)`, `shortDateLabel(date, today)`, `monthName`,
    `monthShortName`, `monthLength`.
  - Added in step 5 (wallets): `DayBar` gains `base?: { value; tone }`, a lower segment of a stacked bar drawn
    from the bottom in its own tone (`value` stays the bar's total; dropped while a day is selected).
    `RunningLine` gains `min?` (the value at the bottom of the box, default 0) and a series' `start?` (the value on
    the left edge, default 0); `linePoints(values, max, days, min = 0, start = 0)` clamps values to the box. The
    Overview's calls are unchanged. `BigAmount` (`components/ui/big-amount.tsx`, from `entry-form.tsx`) `{ id; name;
    label; currency; currencyText; defaultValue?; error?; hint?; autoFocus?; compact?; required? = true }` and
    `amountPlaceholder(currency)` ("0.00" / "0"; safe for a half-typed code). `Popover` accepts `role="menu"`.
    `ActionButton` (`components/wallets/action-button.tsx`) gains `size`, `buttonClassName`, `role="menuitem"` and
    `onDone()` (called once per `ok` result). `DayList` gains `aside?(date)` (replaces the day's net on the right of
    the header) and `showWallet?` (default true); `totals` is optional. `lib/day-labels.ts` adds
    `balanceAfterLabel(closingMinor, currency)`. `lib/wallet-chart.ts` (pure): `balanceRange`, `isFlat`,
    `sparklinePoints`, `walletBars`, `changeLabel`, `entryCountLabel` (see the wallet screens).
  - `AccountMenu` (client, `components/shell/account-menu.tsx`) `{ displayName; username; email }` — the
    initials button (`initials(displayName)` from `lib/user-id.ts`: first letters of the first and last word, or
    the first two letters of a single word; `.`, `_`, `-` also split words) and a `Popover` with the Auth section's
    lines and Sign out.
  - `AddButton` (`components/shell/add-button.tsx`) `{ href? = "/transactions/new"; shellDefault? }` — the
    floating Add button. The layout renders `<AddButton shellDefault />`; a page that wants another target renders
    `<AddButton href="/transactions/new?wallet=<id>" />` anywhere in its markup and the shell's one hides itself
    (`body:has([data-add-button="page"]) [data-add-button="default"] { display: none }` in `globals.css`; no JS).
    `NewEntryShortcut` (client, renders nothing) pushes the `href` of whichever Add button is shown when
    `isNewEntryShortcut(event)` (`lib/shortcuts.ts`) is true: key `n`/`N`, no Ctrl/Alt/Meta, not auto-repeat or IME
    composition, not already handled, target not an input, textarea, select or contenteditable and not inside an
    open `aria-modal` dialog — and no modal dialog is open at all.
  - Main menu (`components/shell/nav.tsx`): `NAV_ITEMS` is the single list of destinations; `MainMenu` marks the
    entry for the page in the layout's `children` slot (`useSelectedLayoutSegment()`), not the URL, so while a
    dialog route is intercepted the page behind stays highlighted.

Theme tokens (`src/app/globals.css`, light + dark via `prefers-color-scheme`) — use these utilities, not raw palette
colours: `bg-background`, `bg-surface`, `bg-surface-muted`, `bg-surface-raised`, `bg-surface-open`, `bg-field`,
`border-border`, `border-border-strong`, `text-foreground`, `text-muted-foreground`,
`bg-accent`/`text-accent`/`bg-accent-soft`/`text-accent-soft-foreground`/`text-accent-foreground`/`hover:bg-accent-hover`,
`text-income`/`bg-income-soft`, `text-expense`/`bg-expense-soft`/`bg-expense-dot`, `text-transfer`/`bg-transfer-soft`,
`text-danger`/`bg-danger`/`bg-danger-soft`, `bg-chart-future`, `bg-chart-ramp-1`…`5`, `bg-scrim`, `outline-ring`. The
values (Sand light, Graphite dark) are in "UI direction".

## Screens

The look, tokens and shared patterns are in "UI direction" below; the reference mock-ups are the Design canvas
listed there. Every amount is shown in its own currency; nothing is converted (the one exception is the Overview
Wallets card total, below). Where a screen shows one currency
at a time it has a currency switch (`?currency=XXX`, see `pickDefaultCurrency`).

- **/login, /register** — a centred card on the page background (brand mark + "Expenses" above it; a faint
  decorative row of bars along the bottom of the page, `aria-hidden`), inline field errors, link between the two.
  Login: "User ID or email" + password. Register: user ID and password (required), then email, first name and
  surname in a section headed "Optional: email and name" (a `<details>` that starts open), with a hint under the
  user ID stating the allowed characters. As built before the redesign and still required: values are echoed back
  after an error (never the password); `autocomplete` is `username` / `current-password` on login and `username` /
  `new-password` / `email` / `given-name` / `family-name` on register; the user ID and identifier inputs turn off
  autocapitalise / autocorrect / spellcheck.
- **App shell** (`(app)/layout.tsx`) — **no sidebar and no bottom tab bar.** A top bar on every signed-in page:
  brand mark + "Expenses" (links to `/`), then the main menu **Overview · Transactions · Wallets · Categories ·
  Import & export** (`aria-current="page"` on the active one, shown as a filled pill), then the account button
  (initials from `user.displayName` in a circle) opening a popover with the display name, the user-ID / email line
  (see Auth) and Sign out. On narrow screens the bar is two rows: brand + account button, then the menu as a
  horizontally scrolling row of pills (no wrapping, no hidden "more" menu). Page content sits in a centred
  container (`max-w-[1240px]`, 32px side padding on desktop, 12–16px on phones).
  **Add button:** a floating pill "+ Add" fixed at the bottom-right of every signed-in page (on phones a 60px round
  button), linking to `/transactions/new` (which opens as a dialog, below). Pressing **N** anywhere outside a text
  field does the same. Pages that preselect a wallet (wallet detail) point it at `?wallet=<id>`.
- **Dialogs** — `/transactions/new`, `/wallets/new` and `/wallets/[id]/edit` open as a modal dialog over the page
  they were opened from (Next.js parallel route `@modal` + intercepting routes in `(app)`; read
  `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/intercepting-routes.md` and
  `parallel-routes.md` first). Visiting one of those URLs directly (reload, new tab, no JS) renders the same form
  as a normal page. The dialog: `role="dialog"`, `aria-modal`, labelled by its heading, focus moved into it and
  trapped, Escape and the ✕ close it (`router.back()`), the page behind is dimmed (`--scrim`). On phones it is a
  bottom sheet (rounded top, drag handle, full width). After a successful save the dialog closes and the page
  behind refreshes (`router.refresh()`); nothing redirects inside the dialog.
  - As built (step 1): `src/app/(app)/@modal/` has `default.tsx` (null), the intercepted `(.)transactions/new`,
    `(.)wallets/new`, `(.)wallets/[id]/edit`, and **a `page.tsx` returning null at every other `(app)` route**
    (`page.tsx` for `/`, `transactions/`, `transactions/[id]/edit/`, `transactions/transfers/[id]/edit/`,
    `wallets/`, `wallets/[id]/`, `categories/`, `data/`). Without them a soft navigation out of a dialog leaves
    the slot on the dialog's segment, and in `next dev` opening the same dialog again was then ignored. The docs'
    catch-all `@modal/[...catchAll]` is not usable: Next 16's strict route matching then rejects the `(auth)`
    pages. A new `(app)` page needs its null page here; `tests/shell.test.tsx` fails until it has one. Each full page and its intercepted copy render one shared body from
    the page's folder — `NewEntry` (`transactions/new/new-entry.tsx`), `NewWallet` (`wallets/new/new-wallet.tsx`),
    `walletToEdit` + `EditWallet` (`wallets/[id]/edit/edit-wallet.tsx`) — so the forms are not forked. The dialog
    calls `requireUser()` itself. Since step 6 (Add) and step 5 (wallets) every dialog closes itself after a save
    (`router.back()`, then `router.refresh()`) and its Cancel is `router.back()`; see /transactions/new and the
    wallet dialog. The Add dialog ignores `?returnTo=`.
- **App shell, as built (step 1):** the top bar is a full-width `bg-surface` strip with a bottom border (not
  sticky); inside, the same `max-w-[1240px]` container as the page (16px side padding on phones, 24px from `sm`,
  32px from `lg`). From `sm` up it is one row — brand, menu (takes the remaining width and scrolls sideways if it
  must), account button; between `sm` and `md` the "Expenses" word is visually hidden to make room. Below `sm`:
  brand + account, then the menu row. On load the menu scrolls itself (not the page) so the active pill is visible.
  The page container has `pb-32` so the last content clears the Add button. The Add button is 60px round below
  `sm` (`aria-label="Add transaction"`, the visible word "Add" from `sm` up), fixed 16px from the right and bottom
  (respecting the safe-area inset), 32px from `sm`.
- **Primitives restyled with the tokens (step 1):** `Card` radius 20px, no shadow; `Button` fully rounded,
  semibold, `md` 44px tall, `sm` 36px, secondary = transparent with a `--border` outline; `Input` / `Select` /
  `DatePicker` trigger 44px, radius 12px, `--field` background, `--border` border; `PageHeader` title 28px/800.
  Body text is 14px (`text-sm` on `<body>`). `--danger-hover` (only the solid danger button's hover) is kept
  outside the token table: `#9A3A22` / `#FFB8A3`.
- **/** Overview — empty state as before (create your first wallet / all wallets archived). Otherwise, top to bottom:
  1. **Month chart card** — heading "November 2026 · EUR" with the month switcher (existing `MonthSwitcher`, the
     month in `?month=`) and the currency switch; the big number is the month's expenses in that currency
     ("€1,401.39 spent so far" for the current month, "spent" for a past one). The chart: one bar per calendar day
     (that day's expenses, accent colour; days after today in `--chart-future`), a solid line for the running total
     of expenses through the month, and a dashed line for the previous month's running total. One very large day
     (more than ~3× the median of the month's non-zero days) is capped at the top of the chart and labelled
     ("Rent €1,150" — its largest entry's note or category). Legend: Each day · Running total · <previous month>.
     The chart is `role="img"` with an `aria-label` summary; a visually hidden table lists the days.
  2. **Four insight cards** for the same month and currency: **Net this month** (income − expenses, signed,
     coloured), **Top category** (name, share and amount), **Pace vs <previous month>** (expenses through day N
     this month minus through day N last month, "less/more spent than by 8 Oct"), **No-spend days** ("1 of 8",
     plus the previous month's figure).
  3. **Wallets** (active; name, this month's change, balance) and **Latest** (5 most recent entries, all wallets,
     with a link to Transactions), side by side from `lg` up.
  - **Converted total** (Wallets card; `src/lib/fx.ts`, `src/server/exchange-rates.ts`): the card starts with
    "Total in <currency>" for the currency selected on the page. `?view=` picks what the card shows:
    - `all` (default, left out of the URL): every active wallet; the total is converted into the selected currency
      (`convertedTotal`: each wallet converted once, rounded half away from zero to the target's decimals, then
      added) and shown with "≈"; a wallet in another currency shows "≈ <converted balance>" under its own balance.
      Under the total: "Rates of 6 Nov 2026 · European Central Bank, via Frankfurter".
    - `only`: just the wallets in the selected currency, their plain sum, nothing converted (the card as before,
      limited to that currency).
    The switch ("All in EUR · EUR only", links, `WalletsViewSwitch`) is shown when the active wallets are not all
    in the selected currency; otherwise the view is `all` and nothing is converted. The month switcher and the
    currency switch keep `view=only`. A currency with no rate (not quoted by the provider, rates switched off, or
    the provider unreachable with nothing cached) is left out of the total, with a note naming it
    (`walletsTotalNotes`). Balances are today's balances and the rates are the latest ones, also for a past month;
    the chart and the insight cards stay in one currency, unconverted.
    - Rates: `getExchangeRates()` fetches `https://api.frankfurter.dev/v1/latest?base=EUR` (ECB reference rates,
      no API key; cross rates through EUR), only when a wallet needs converting. One table in memory serves every
      user, refreshed after 6 h; a failed fetch keeps the last table and waits 10 min before trying again; 4 s
      timeout; it never throws. Nothing goes in the database. `EXCHANGE_RATES=false` turns it off (no request is
      made).
  - As built (step 3; `page.tsx`, `components/dashboard/month-chart.tsx`, `overview-lists.tsx`):
    - **Currency**: `?currency=` is used when it is a valid code (`isValidCurrency`, uppercase only) of a wallet the
      user holds, archived included; anything else falls back to `pickDefaultCurrency(userId, month)`
      (`resolveOverviewCurrency`). The month switcher keeps `currency` in its links **only when it came from the
      URL**; a defaulted currency is re-picked for each month. The currency switch's links keep the month
      (`overviewHref`). The switch lists `listUserCurrencies` (plus the current value, see `CurrencySwitch`) and is
      left out when that is a single currency equal to the current one. No wallets at all (or none active and so
      no default) → the empty state with "Welcome, <displayName>" as before.
    - The `<h1>` is the small "November 2026 · EUR" line over the big number (34px, 42px from `sm`); there is no
      "Dashboard" title or "Hello" line. The month switcher and currency switch sit at the top right (wrapping under
      the number on phones), then the legend, then the chart box (160px, 240px from `sm`), then the axis labels.
    - **Chart scales**: the bars and the lines share the box but not the scale (the legend's `title` says so).
      Bars: `pickScale` over the whole month's daily expenses, then divided by 0.6 so the tallest ordinary bar
      reaches 60% of the bar area and the lines above stay readable; a capped day reaches the top under its label
      (`largestDay.label` + amount, or the amount alone when there is no label). Bars after day N use tone
      `future` (a future-dated entry shows as a `--chart-future` bar). Lines: max = the larger of the two plotted
      running totals' last values; this month's line stops at day N; the previous month's line is cut to this
      month's length (31 October is not drawn on a November chart).
    - **Axis**: "1 Nov", 15, 22, the last day, and "<N> · today" for the current month; a fixed label closer than 4
      days to today's is dropped (if that is "1 Nov", today's label becomes "2 Nov · today"). Labels sit under their
      day's column; the first and last are aligned to the edges.
    - **Text alternative**: the line SVG is the `role="img"` with the summary ("Spending in EUR, November 2026:
      €1,401.39 by 8 Nov, against €1,434.05 by 8 Oct. Largest day: 2 Nov, €1,150.00 (Rent). Bars show each day; the
      lines show running totals on their own scale."); the bars are `aria-hidden`; a `sr-only` table (Day / Spent /
      Income) lists days 1..N plus any later day with entries.
    - **Cards**: "Net this month" ("Net in October" for a past month), value signed, `toneOf`; "Top category" or
      "—" with "No spending this month"; "Pace vs <previous month>": value = this month − previous through day N,
      signed ("-€32.66" = less spent), income tone when less, expense tone when more, "the same as by 8 Oct" when
      equal; for a past month the sub is "less/more spent over the whole month" when day N covers the whole
      previous month, else "…than by 30 Oct" (a 30-day month against a 31-day one); "No-spend days" "1 of 8" /
      "October had 8 of 31". Two columns on phones, four from `lg`.
    - **Wallets**: `getDashboard().wallets` (active, every currency), change = `getWalletMonth(…).inMinor −
      outMinor` for the shown month ("no change" when 0; `text-income` / `text-expense`), balance = today's balance
      (`text-expense` when negative), a "Manage" link to `/wallets`; rows link to `/wallets/<id>` (`?month=` added
      for a past month). **Latest**: `getDashboard().recent.slice(0, 5)`; a row is the dot (`bg-expense-dot` /
      `bg-income` / `bg-transfer`), `transactionLabel`, "Today / Yesterday / 6 Nov · note · wallet", and the signed
      amount (income `text-income`, expense `text-foreground`, transfers `text-transfer`; a cross-currency transfer
      shows only its own leg).
- **/transactions** — filter chips at the top (month, wallet, type, category; each opens a popover; a search field
  for the note text), then the **day strip**, then the list. **The default view is the current month**
  (`?month=YYYY-MM`, with "All time" in the month chip; explicit `from`/`to` still work and override `month`).
  - **Day strip** (only when one month is shown): a bar per day of that month for expenses in one currency — the
    filtered wallet's currency, else the currency switch's value. Clicking a bar narrows the list to that day
    (`from=to=<date>`); the selected day's bar is in the accent colour. `role="group"` of buttons with labels like
    "3 November: €64.20 spent".
  - **List**: entries grouped by day, newest first. Each day has a header ("Today · Sunday 8", "Tuesday 3") and
    the day's net per currency on the right (over all matches of the filters, not only the page). Rows: a dot
    coloured by kind, category (or "Transfer → Savings"), note · wallet, signed amount (income in `--income`,
    expenses in the text colour, transfers muted; a cross-currency transfer also shows the other leg's amount).
  - **In-place editing**: a row is a button (`aria-expanded`); activating it opens an edit form under the row
    (amount, category, wallet, date, note; for a transfer: from, to, sent, received when the currencies differ,
    date, note) with Delete (confirms), Cancel and Save. One row open at a time; Escape or Cancel closes it and
    returns focus to the row. Save stays on the page (the action returns form state; `revalidatePath`), errors
    show inline in the open form. The edit pages (`/transactions/<id>/edit`, `/transactions/transfers/<id>/edit`)
    remain for direct links and no-JS use.
  - Pagination and "Export CSV" (current filters) stay; the export link moves into the chip row.
  - As built (step 4; `page.tsx`, `components/transactions/{list-params,filter-chips,day-strip,day-list,inline-edit}`,
    `lib/day-labels.ts`):
    - **URL state** (`list-params.ts`): `month` (`YYYY-MM` or `all`; absent = the current month), `wallet`, `kind`,
      `category`, `from`, `to`, `q`, `page`, and `currency` (a valid uppercase code; only picks the strip's currency,
      not a filter). Invalid values are dropped. `resolveView(params, thisMonth)` → `{ type: 'month', month }`,
      `{ type: 'all' }` or `{ type: 'range', from?, to? }` (any `from`/`to` wins over `month`); `listFilters` turns
      that into `TransactionFilters`. `hasFilters` counts a month only when it differs from the current one
      (`?month=<current>` is not a filter) and ignores `currency` and `page`. `monthHref` / `dayHref` keep the other
      filters and the currency and leave the current month out of the URL; `exportCsvHref` drops page and currency.
    - **Header**: "Transactions" and "N entries this month" / "N entries in October 2026" / "N entries" (all time) /
      "N match your filters" (any wallet, type, category, search or date range). No Add button (the floating one).
    - **Chip row** (`FilterChips`, client): Month · Wallet · Type · Category pills (`pillClasses`; the selected
      style when set — the month chip only away from the current month), each opening a `Popover`. Wallet, Type and
      Category: `aria-haspopup="listbox"`, a `role="listbox"` panel of `next/link` options (`role="option"`,
      `aria-selected`, a ✓ on the chosen one; Category grouped Expense / Income in `role="group"`s; archived wallets
      marked); opening focuses the selected option, Up / Down / Home / End move, Enter follows the link, Tab leaves.
      A set chip shows the value ("Cash") with "Wallet:" visually hidden. **Month**: `aria-haspopup="dialog"` — a
      `MonthGrid` (its own ‹ year › stepper; picking pushes the URL) over a row of links "‹ Oct", "All time", "Dec ›".
      Its label is `viewLabel`: "November 2026", "All time", "5 Nov – 12 Nov", "3 Nov", "From 5 Nov", "Until 12 Nov"
      (the year is added outside the current year). "Clear" (a text link to `/transactions`) when `hasFilters`. The
      search is a GET `<form role="search" action="/transactions">` with hidden inputs for the other params (no-JS)
      and `onSubmit` pushing a clean URL (an empty search drops `q`); then the Export CSV pill (hidden when the list
      is empty). At 375px the chips wrap and the search + export share a full-width line.
    - **Day strip** (`DayStrip`, server): shown when `stripMonth(view)` is a month — the month in view, or the month
      of a single selected day (`from = to`) — and the list is not empty or a day is selected (no strip for all
      time, other ranges or a month with no entries). Currency: the filtered wallet's (no switch then), else
      `?currency=` / `pickDefaultCurrency` through `resolveOverviewCurrency` with a `CurrencySwitch` under the same
      rule as the Overview. `getMonthTimeline(userId, { month, currency, walletId, categoryId })`; the type and
      search filters do not apply (it always shows expenses). `DayBars` 48px tall (72 with a cap), scaled with
      `pickScale` (one huge day capped, labelled with its amount), days after today `future`, inside a
      `role="group"` labelled "Each day of November 2026: select a day to list only that day"; each bar links to
      `dayHref(…, date)` with the `aria-label` "3 November: €64.20 spent"; with a selected day that bar is the
      accent (`aria-current="date"`, label "… Shown; select to show the whole month") and links back to the month,
      and the heading line reads "€64.20 on 3 November" with a "Show all of November 2026" link. Axis labels as on
      the Overview (`axisTicks`). Title "Spent per day · EUR", then "€1,531.44 in November 2026".
    - **List** (`DayList`, server, inside `InlineEditProvider` + `ExpandableList`): `groupByDate` over the page's
      items; one 18px card per day: an `<h2>` with `dayHeaderLabel(date, today)` ("Today · Sunday 8", "Yesterday ·
      Saturday 7", "Tuesday 3" in today's month, "Tue 3 Nov" in today's year, "Tue 3 Nov 2025") and on the right
      `dayNetLabel` of `listDayTotals(userId, filters, datesOnThisPage)` ("-€133.85 · -lei 118.50 · -$15.99"; a day
      whose transfers cancel out shows "€0.00"), muted. Rows (`ExpandableRow`): kind dot, `transactionLabel`, "note ·
      wallet" muted, the signed amount bold (income `text-income`, expense `text-foreground`, transfers
      `text-transfer`) and, for a cross-currency transfer leg, the other leg's amount small and muted under it. Each
      row also has a `<noscript>` "Edit <label>" link to its edit page. `PAGE_SIZE` stays 50.
    - **In-place editing** (`InlineEditPanel`, client): `EntryForm variant="inline"` — no card, no `mode`, a 56px
      amount box with a 32px number, `space-y-4`, element ids prefixed `edit-<rowId>-` (names unchanged) so they
      cannot clash with the Add dialog opened over the list. A transaction keeps the edit page's Expense / Income
      switch; a transfer row (either leg) edits the whole transfer (From / To / Sent / Received, no switch). Wallets:
      active plus the archived ones the entry uses. The footer sits outside the keyed form: Delete
      (`ConfirmDeleteForm`, danger text, `confirm()`, the delete action redirects back to the list URL) and "Open as
      page" (the edit page with `returnTo`) on the left, Cancel and Save (`form=`) on the right. Wallets, categories,
      today and the list URL reach every panel once through `InlineEditProvider`. On `ok` the row closes, focus
      returns to its button, the message is announced and `router.refresh()` runs; errors show inline and focus the
      first invalid control.
    - **Empty states**: no wallets / no transactions at all (as before); a month with nothing in it and no other
      filter: "Nothing in December 2026." with "‹ November 2026" and "All time" buttons; otherwise "No matching
      transactions" + "Clear filters". The chip row shows whenever the user has any transaction.
- **/wallets** — header with "+ New wallet" (opens the dialog). Active wallets grouped by currency: a group heading
  (code, currency name, group total) over a grid of cards — name, entry count, balance, this month's change
  (coloured), and a small line of the balance through the month (flat and muted when nothing changed). Cards link
  to `/wallets/<id>`. Below, an "Archived" list (name, currency, entry count, balance, an Unarchive button).
- **/wallets/new**, **/wallets/[id]/edit** (dialog) — name; currency (new only): buttons for the pinned common
  currencies plus a "type a code" field with suggestions over the full list, and a line saying it cannot be changed
  later; starting balance (the currency's symbol/code beside a large input, may be negative; hint as now). Edit
  shows the currency as fixed text and an Archive / Unarchive section; Delete appears there only when the wallet
  has no entries.
- **/wallets/[id]** — breadcrumb "Wallets / <name>". A header card: name + currency pill, balance (large), "started
  with <initial balance>", buttons Expense / Income / Transfer (open the Add dialog with `?wallet=<id>&kind=…`) and
  a "⋯" menu (Edit → dialog, Archive/Unarchive, Delete when empty). The card also holds the **month chart** for
  this wallet (`?month=`, default current): the balance as a line, and per day a bar of money out (accent) or in
  (`--income`), transfers included. Then four cards: In this month, Out this month, Started the month at, Entries
  (this month · in total). Then the month's entries grouped by day, each day header showing **"Balance after
  <amount>"**, rows editable in place as on /transactions, and a link "Open in Transactions"
  (`/transactions?wallet=<id>&month=…`). Archived wallets show a notice instead of the add buttons.
- **Wallet screens, as built (step 5):**
  - **/wallets** (`page.tsx`, `components/wallets/wallet-cards.tsx`): `PageHeader` "Wallets" with the primary
    "+ New wallet" pill. Groups follow `listUserCurrencies` (active wallets, by code): an `<h2>` with the code
    (15px/800) and `currencyName` (muted), the group's total balance on the right (`text-expense` when negative),
    then a `<ul>` grid `repeat(auto-fill, minmax(min(100%, 320px), 1fr))`. A card is one link to `/wallets/<id>`:
    name, `entryCountLabel` ("27 entries" / "1 entry" / "No entries yet"), the balance (28px/800, `text-expense` when
    negative), `changeLabel` of `getWalletMonth(…, currentMonth).inMinor − outMinor` ("+€2,890.90 this month" in
    `text-income`, negative in `text-expense`, "No change this month" muted), and a 120×40 `aria-hidden` SVG
    polyline (`sparklinePoints`: the opening balance, then each day's closing so far, spread over the whole width and
    scaled to their own min / max; `text-income` / `text-expense` by the change, `text-foreground` when the month
    moved but netted to zero, and a flat middle line in `text-border-strong` when no day moved the balance).
    **Archived**: a muted `<h2>`, then one card of rows — the name (a link), "EUR · 18 entries · hidden from Overview
    and pickers", the balance (muted) and an Unarchive secondary pill (`unarchiveWalletAction`, no confirm). No
    wallets: the empty state as before; only archived ones: "All your wallets are archived…" above the Archived list.
    `WalletCard` / `WalletRow` were removed.
  - **/wallets/[id]** (`[id]/page.tsx`, `components/wallets/{wallet-month-chart,wallet-menu}.tsx`): a breadcrumb
    `<nav aria-label="Breadcrumb"><ol>` "Wallets / <name>" (`aria-current="page"`). The header card (20px radius):
    `<h1>` name (22px/800), the currency pill (`bg-surface-raised`, `title` = currency name), an "Archived" pill
    when archived; the balance (36px, 44px from `sm`, /800, `text-expense` when negative); "Balance today · started
    with <initial balance>". On the right: Expense / Income / Transfer secondary pills with the kind dot
    (`bg-expense-dot` / `bg-income` / `bg-transfer`) linking to `/transactions/new?wallet=<id>&kind=…&returnTo=<this
    page>` (the dialog ignores `returnTo`; the no-JS full page returns here), and the "⋯" button
    (`aria-haspopup="menu"`, "More actions for <name>") opening a `Popover role="menu"`: "Edit wallet" (link to
    `/wallets/<id>/edit`, the dialog), Archive (confirm) or Unarchive, and "Delete wallet" (confirm, danger text)
    when `transactionCount === 0`; each `role="menuitem"`, 44px tall. Opening focuses the first item; Up / Down
    wrap, Home / End jump (`nextMenuIndex`); Escape and Tab close as any `Popover`; Archive / Unarchive close the
    menu on success, Delete redirects to `/wallets`. The page renders `<AddButton href="/transactions/new?wallet=<id>"
    />` unless archived. Archived: a muted notice ("… Unarchive it from the ⋯ menu to use it again.") replaces the
    three pills, and the shell's default Add button stays.
    **Month chart** (inside the header card, under a divider): "Balance through November 2026" and the
    `MonthSwitcher` (`basePath=/wallets/<id>`; `?month=` invalid → current, later than the current month → clamped to
    it). `WalletMonthChart`: legend Balance · Out · In (its `title` says the scales differ), a 160px (220px from
    `sm`) box with **stacked** bars — one column per calendar day, money out at the bottom (accent), money in on top
    (`--income`) via `DayBar.base`, transfers included; days after day N are `future` stubs (`walletBars`). Bar scale:
    `pickScale` over each day's in + out, divided by 0.6 as on the Overview; one huge day is capped with the label
    "In €4,200.00" / "Out €1,150.00" (its larger side). Line: `RunningLine` of `days[].closingMinor` (foreground),
    starting on the left edge at `openingMinor`, scaled by `balanceRange` (min / max of the opening and closings ±
    15% of the range; a flat month gets ±10% of its size, at least ±100 minor, so it is drawn mid-box); it stops at
    day N. Axis labels as on the Overview (`axisTicks`). Text alternative: the line's `aria-label` ("Balance of ING
    Current in November 2026: €5,403.86 at the start, €7,864.71 on 9 Nov; lowest …, highest …. €1,764.14 out and
    €4,224.99 in over the month. Bars show …") and a `sr-only` table Day / Out / In / Balance after for days 1..N.
    **Cards** (two columns on phones, four from `lg`): "In this month" (`income` tone when > 0), "Out this month",
    "Started the month at" (sub "Up / Down €… since", "No change so far"; the change is the last closing − the
    opening), "Entries" (`entryCount`, sub "this month · 27 in total"). For a past month: "In during October", "Out
    during October", "Started October at" (sub "… over the month"), "in October · 27 in total".
    **Entries**: "Entries in November 2026" with "Open in Transactions" (`/transactions?wallet=<id>&month=<month>`),
    then `listTransactions(userId, { walletId, month, limit: 200 })` in `InlineEditProvider` (all wallets, archived
    flagged; `returnTo` = this page with its month) + `DayList showWallet={false} aside=…`: each day's header shows
    `balanceAfterLabel(closing)` from `getWalletMonth.days`; a future-dated day (after today) has no closing there
    and shows nothing on the right. There is **no pagination** on this page: past 200 entries in a month a line says
    "Showing the latest 200 of N entries…" with a link to Transactions. An empty month: "No entries in November
    2026." in a card.
  - **Wallet dialog** (`components/wallets/wallet-form.tsx`, `new/new-wallet.tsx`, `[id]/edit/edit-wallet.tsx`):
    `NewWallet` / `EditWallet` take `variant: 'page' | 'dialog'`; the `@modal` copies pass `dialog`. The dialog
    variant posts a hidden `mode=dialog`: `createWalletAction` / `updateWalletAction` then call
    `revalidatePath("/", "layout")` and return `{ ok: true, message }` ("Created Probe (CHF)", "Saved Pocket")
    instead of redirecting; the form calls `router.back()` and `router.refresh()` on the `popstate` that follows (as
    the Add dialog). Cancel is `router.back()` in the dialog and a link (`/wallets` or the wallet) on the full page,
    whose actions still redirect to `/wallets/<id>`. The fields remount after every result (keyed on the state) with
    the echoed values; after an error focus moves to the first `aria-invalid` control. The footer sits outside the
    `<form>` (submit with `form=`), so the edit variant's Archive section (its own forms) can sit above it.
    **Fields**: Name (`Input`, 60 max). Currency (create): a muted heading labelling a `PillPicker name="currency"`
    of the `PINNED_CURRENCIES` (codes; `title` = name), then "Another currency" — an `Input name="currency"` (3
    characters, upper-cased as typed, `list` = a `<datalist>` of every currency, option text = its name) — and "This
    can't be changed once the wallet exists." Both controls post `currency`; the action takes
    `chosenCurrency(formData.getAll("currency"))` = the last non-empty value, trimmed and upper-cased, and the text
    input comes after the pills, so a typed code wins (the no-JS rule). With JavaScript typing a code also unchecks
    the pills (they remount with nothing selected) and choosing a pill clears the code, so one value is posted. The
    echoed currency re-checks its pill when it is pinned, else refills the code; an invalid typed code carries the
    error on the input (else on the pill group). Validation stays server-side (`isValidCurrency`). Starting
    balance: `BigAmount name="initialBalance"` (not required; empty = 0) with the chosen code beside it ("—" until
    there is one) and the hint "In CHF, up to 2 decimals. May be negative (e.g. a credit card). Leave empty for 0."
    **Edit**: the currency as fixed text in a muted box ("EUR · Euro", "A wallet's currency can't be changed."), the
    starting balance, then a muted section "Archive" with the explanation ("An archived wallet is hidden from the
    Overview and the pickers; its entries stay, and you can unarchive it at any time.") and Archive (confirm) — or
    "Archived" + Unarchive — plus "Delete wallet" when the wallet has no entries. Archiving from the dialog keeps it
    open (the section turns into Unarchive); Delete redirects to `/wallets`, which closes it.
- **/transactions/new** (dialog; also the target of every Add button) — a type switch Expense / Income /
  Transfer; then
  - Expense / Income: a large amount input with the currency of the chosen wallet beside it ("EUR · from Cash");
    category as a row of pill buttons (radio group, the kind's categories, plus "Manage" linking to /categories);
    wallet as pill buttons (active wallets).
  - Transfer: From → To (selects), "Sent" and — only when the currencies differ — "Received", with the line
    "Different currencies, so enter what actually arrived. No rate is applied for you."
  - Date as pills "Today" / "Yesterday" / a calendar button opening the `DatePicker` popover; a note field.
  - Footer: "Keep open for another" checkbox (on success the form clears amount and note and stays open), Cancel,
    and the submit button ("Add expense", "Add transfer"; Enter submits). `?wallet=` / `?kind=` preselect.
  Server Actions, field names and services are unchanged; the form still posts `walletId`, `categoryId`, `amount`,
  `date`, `note` (and the transfer fields), so the pills are radio inputs with those names.
  - As built (step 6): one `EntryForm` (`components/transactions/entry-form.tsx`) with `variant: 'page' | 'dialog'`
    serves the dialog (`NewEntry variant="dialog"` from the intercepted route), the full page and both edit pages;
    it also takes `today` (the server's `todayISO()`, so the pills render the same on server and client).
    **Dialog variant:** no `Card`; posts a hidden `mode=dialog`. With it `createTransactionAction` /
    `createTransferAction` call `revalidatePath("/", "layout")` and return `{ ok: true, message }` instead of
    redirecting — `message` is "Added €12.40 to Food" or "Moved €20.00 from Cash to Revolut USD", formatted on the
    server. On `ok`: with "Keep open for another" checked, the form remounts (amount and note empty; type, wallet,
    category and date are React state and stay), focus goes to the amount and the message shows in a
    `role="status"` line in the footer; unchecked, it calls `router.back()` and, on the `popstate` that follows,
    `router.refresh()`. The footer (status line, checkbox, Cancel = `router.back()`, submit) sits outside the keyed
    `<form>` so the checkbox and the status line survive the remount; the submit joins the form with `form=<id>`
    (Enter in a field still submits) and shows the pending state from `useActionState`. **Page variant** (full page,
    edit pages): a `Card`, Cancel links to `returnTo`, the actions redirect as before; the edit pages keep Delete
    in their header. After any failed action the form remounts with the echoed values and focus moves to the first
    `aria-invalid` control (the checked or first radio of a pill group), so it never drops to `<body>` inside the
    dialog.
    **Layout:** type switch = `Segmented` `name="kind"` (the transaction edit page offers Expense / Income, the
    transfer edit page no switch). The amount is a 72px-tall box with a 44px (48px from `sm`) extrabold
    `tabular-nums` input and the currency text beside it (`<id>-currency`, in the input's `aria-describedby`):
    "EUR · from Cash" for expense / income, the bare code for Sent / Received. Category: muted heading (the group's
    `aria-labelledby`), `PillPicker name="categoryId"` keyed on the kind, then "Manage categories" as a dashed pill
    after the pills (so Tab reaches it after the group). Wallet: `PillPicker name="walletId"` of the active wallets
    plus an archived one the entry already uses ("Old card (archived)"). Transfer: From → To selects (the arrow
    from `sm` up), Sent and Received side by side from `sm`, stacked below it, the no-rate line under them. Date:
    "Today" and "Yesterday" are `aria-pressed` buttons in a `role="group"` labelled "Date", followed by the
    `DatePicker` (controlled, owns `<input type="hidden" name="date">`) drawn as a third pill: "Other date" with a
    calendar icon, or the date itself (selected style, neither pill pressed) when it is neither today nor
    yesterday. Note: one `Input` (`name="note"`, placeholder "Note (optional)", `maxLength` 500, `sr-only`
    label). Tab order: type → amount → category → Manage categories → wallet → Today → Yesterday → calendar → note
    → footer.
- **/categories** — month + currency switch at the top (default current month, `pickDefaultCurrency`). A "Spending
  split" card: the month's expense total and one segmented bar with a legend (one shade of the accent ramp per
  category, largest first). Then Expense and Income lists side by side: each row shows a swatch, the name, "N this
  month · M in all", a small share bar (expense only) and the month's amount in the chosen currency. A row expands
  in place (same pattern as transactions) to **Rename** (name input + button) and **Remove** — unused categories
  are removed after a confirmation; used ones need the "moving its N transactions to <select>" choice first, as now.
  Each list ends with a dashed "+ New expense/income category" input + Add. Errors and focus handling as before
  (inline next to the control; focus to the section heading after a removal; a `role="status"` announcement).
  - As built (step 7; `categories/page.tsx`, `components/categories/{category-section,category-row,spending-split}.tsx`,
    `lib/category-split.ts`):
    - **Month and currency**: `?month=` as on the Overview (invalid → the current month, a future month → the current
      one); `?currency=` through `resolveOverviewCurrency` (a held currency, archived wallets included, else
      `pickDefaultCurrency`); with only archived wallets (no default) their first currency by code; with no wallets at
      all there are no amounts, no share bars and no split card. The `MonthSwitcher` (`basePath="/categories"`) keeps
      `currency` only when it came from the URL; the `CurrencySwitch` links keep the month (`overviewHref(…,
      "/categories")`) and the switch is left out under the Overview's rule. Both sit in `PageHeader`'s actions and
      wrap under the title on phones.
    - **Spending split card** (`SpendingSplitCard`, server): the total is the sum of the expense categories'
      `monthAmountMinor` (every expense in that currency that month, archived wallets included — the same figure as
      `getMonthInsights().expenseMinor`), then "spent in <Month>". `spendingSplit(categories)` keeps the expense
      categories with an amount > 0, largest first (then name ignoring case, then id), ramp step `min(rank + 1, 5)`
      (`RAMP_BG`), an exact `fraction` for widths and whole `percent`s by largest remainder (they add up to exactly
      100; a non-zero share that rounds to 0 shows "<1%", `percentLabel`). The bar is a 14px `flex` row with 3px
      gaps, one `rounded-[5px]` segment per category with `flex-grow` = its amount and a 4px minimum width,
      `aria-hidden`; the legend (`<ul>`, wrapping) carries the same data as text. Empty: "Nothing spent in August 2026
      in EUR."
    - **Lists**: one `<section>` card per kind — `<h2 tabIndex=-1>` "Expense · 5 categories", a visible
      `role="status"` line under it — each its own `ExpandableList` (one open row per list). Row summary: a 10px
      swatch (expense: its ramp colour from the split via `rowShare`, so the colour follows the amount rank, not the
      row order; an expense with nothing this month: a hollow `--border-strong` ring; income: `bg-income`), **name**
      and "N this month · M in all" (inline after a "·" from `sm`, a second line below it), the share bar (expense
      only, `w-12` / `sm:w-20`, `h-1.5`, `aria-hidden`, with ", N% of the month's spending" as visually hidden text
      after the amount) and the amount (income in `text-income`, unsigned; "—" muted, read as "nothing in EUR").
    - **Open row** (`CategoryPanel`, region "Rename or remove Food"): "New name for “Food”" + the input (focused and
      selected on open, accent border) + Rename (primary) + Cancel; under a divider the remove flow: unused →
      "Remove Food" (ghost button in `--danger`, `confirm()`); used → "Remove, moving its N transactions to" + the
      select of the list's other categories + "Remove Food" (no confirm, as before); the only category of its kind
      with transactions → the explanation instead. A rename closes the row (focus back to its button) and announces
      in the section's status line; a removal closes it without restoring focus, focuses the section heading and
      announces. If an "unused" category gained transactions meanwhile, the refusal shows above the replacement
      select that now replaces the button (the action revalidates), and the select takes focus.
    - **Add row**: a visually hidden label "New expense category", a dashed input with the placeholder "+ New expense
      category" and "Add" (secondary pill); errors and focus as before. The rows' old Rename / Remove buttons are
      gone; `category-row.tsx` holds the row summary and the open-row forms.
- **Route contract between features**: `/transactions/new?wallet=<id>&kind=expense|income|transfer`,
  `/transactions/<id>/edit`, `/transactions/transfers/<transferId>/edit`,
  `/transactions?wallet=<id>&month=YYYY-MM`, `/wallets/<id>?month=YYYY-MM`, `/wallets/new`, `/wallets/<id>/edit`,
  `/?month=YYYY-MM&currency=XXX`, `/categories?month=…&currency=…`. The transaction form pages accept
  `?returnTo=<path>` for their full-page form (only same-site relative paths starting with a single `/`; default
  `/transactions`); the dialog ignores it and closes instead.

## Import / export

Purpose: data portability for a self-hosted app — back up an account, move it to another instance, and get
transactions in and out of a spreadsheet. Importing bank statements in arbitrary formats (column mapping,
per-bank presets) is **out of scope** for the app; the separate Statement Importer artifact
(`docs/STATEMENT-IMPORTER.md`) turns statements into this CSV.

### Formats

- **Backup (JSON)** — the whole account, lossless: `{ app: "expenses-tracker", version: 1, exportedAt, wallets[],
  categories[], transactions[], transfers[] }`. Wallets carry name, currency, initial balance and archived flag;
  categories name + kind; transactions date, kind (`expense`|`income`), wallet ref, category ref, amount, note;
  transfers date, note, from/to wallet refs, amount sent, amount received. References use ids local to the file.
  Amounts are written both as integer minor units and as a decimal string; minor units are authoritative on
  import. **Never** contains the user's email, password hash, sessions or database ids of other users.
- **Transactions (CSV)** — one row per expense / income / transfer, columns
  `date,type,wallet,currency,amount,category,note,to_wallet,to_currency,to_amount`.
  `type` is `expense` | `income` | `transfer`; `amount` is positive, plain decimal with a dot, no thousands
  separator, in the wallet's currency; a transfer is **one** row (`wallet` → `to_wallet`, `to_amount` = amount
  received). RFC 4180 quoting, UTF-8 with BOM (so Excel opens it correctly), CRLF line endings, ISO dates.
  Text cells that start with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'` on export (spreadsheet formula
  injection) and that prefix is removed again on import, so export → import round-trips exactly.

### Export

- `GET /api/export/backup` → `expenses-tracker-backup-YYYY-MM-DD.json`; `GET /api/export/transactions` → `…-transactions-YYYY-MM-DD.csv`.
  Both require a session (401 otherwise — route handlers are not covered by the `(app)` layout), are scoped to
  the signed-in user, and answer with `Content-Disposition: attachment` and `Cache-Control: no-store`.
- The CSV export accepts the same filter query parameters as `/transactions` (wallet, kind, category, from, to,
  q) and exports **all** matching rows (no pagination). `/transactions` gets an "Export CSV" action that carries
  its current filters. Since step 4 it also takes `month=YYYY-MM`; unlike the list, a missing `month` (or
  `month=all`) means all time, so the list's link always writes out the month it shows (`exportCsvHref`) and a bare
  `/api/export/transactions` still exports everything.
- `GET /api/export/context` → `expenses-tracker-context-YYYY-MM-DD.json`: the account's **wallets and
  categories only** — `{ app: "expenses-tracker", kind: "context", version: 1, exportedAt, wallets: [{ name,
  currency, archived }], categories: [{ name, kind }] }` — small and free of transactions, so it can be handed
  to companion tools (the Statement Importer artifact) that need to know the user's wallets and categories
  without receiving their history. Same auth and headers as the other exports. The `/data` page offers it as a
  third download, "Wallets & categories (JSON)", with one sentence saying what it is for, next to a "Copy to clipboard"
  button that puts the same JSON on the clipboard for pasting into the artifact (with a selectable fallback
  when the clipboard is refused). As built: wallets and categories are listed in creation order (as in the backup);
  Copy starts the clipboard write inside the click (a `ClipboardItem` whose text is the pending fetch, which Safari
  needs) and falls back to `writeText`; when the browser refuses, the JSON appears selected in a read-only text box
  under the buttons. A successful copy shows "Copied" for 2.5 s.

### Import

- Accepts a backup JSON or a transactions CSV (detected from content, not the file name), or several files at once
  (see "Importing several files at once"). Limits: 5 MB and 50 000 rows (for the whole selection); raise the Server Action / request body limit accordingly and reject anything larger with a clear
  message.
- CSV reading is tolerant of what spreadsheets do to files: optional BOM, `,` / `;` / tab delimiter (auto-detected
  from the header line), CRLF or LF, quoted cells with embedded newlines, header names case-insensitive and in
  any order, unknown columns ignored, blank lines skipped. Amounts go through `parseAmount` with the wallet's
  currency (so `12,50` works and too many decimals is an error). Dates: `YYYY-MM-DD` or `DD.MM.YYYY`; anything
  else (e.g. slashes, which are ambiguous) is an error that says which formats are accepted.
- **Import always adds to the current account; it never deletes or overwrites.**
  - Wallets are matched by name + currency (ignoring case); a missing wallet is created (CSV: initial balance 0;
    backup: the file's initial balance and archived flag). An existing wallet's name, initial balance and archived
    state are left untouched. The same name with a different currency is a different wallet.
  - Categories are matched by kind + name (ignoring case); missing ones are created.
  - **Duplicates are skipped by default** (checkbox "Skip transactions that already exist", on): entries are
    compared on (wallet, kind, category, date, amount, note) — transfers on (from, to, date, both amounts, note) —
    as a multiset: if the file has 3 identical entries and the account already has 1, 2 are added. Importing the
    same file twice therefore adds nothing the second time, while genuinely repeated purchases inside one file
    are kept.
- **Two steps: preview, then confirm.** The preview parses and validates the whole file and shows: transactions
  and transfers to add, duplicates skipped, wallets and categories that will be created, and every problem with
  its line number (CSV) or path (JSON) — show the first 50 and the total. If there is any problem, nothing can be
  imported: the user fixes the file and tries again. Confirm re-runs the same validation server-side (the preview
  result is never trusted) and writes everything in **one DB transaction** — all or nothing.
- The file is untrusted input: validate with zod, cap sizes and string lengths with the same rules as the
  services (names, notes, amounts > 0, safe integers, valid ISO currencies, kind/category match, from ≠ to,
  cross-currency transfers need a received amount), ignore unknown fields, reject unknown `version`s.
- Everything is created under the signed-in user; nothing in the file can reference or affect another user.

### Provider formats

Besides its own two formats, the importer recognises exports from other apps. Each provider is a small parser
that turns the file into the importer's internal parsed form; planning, preview, duplicate skipping and the
all-or-nothing write are shared and unchanged. The app's own CSV rules are **not** loosened to accommodate a
provider. Adding a provider later should mean adding one module and registering it, not touching the planner.
There is no export in provider formats.

**Spendee (CSV export)**

- Detected from the header row (not the file name): it has `Date`, `Wallet`, `Type`, `Category name`, `Amount`,
  `Currency`, `Notes` (names case-insensitive, any order) — i.e. a `Category name` column and no `category`
  column. Spendee writes `;`-separated, fully quoted, UTF-8, CRLF; the existing CSV reader already copes with
  that, including notes with embedded newlines. `First name`, `Last name` and any other column are ignored.
- `Date` is `YYYY-MM-DD HH:MM:SS`; the date part is taken as written (no time-zone conversion) and the time is
  dropped. A bare `YYYY-MM-DD` is accepted too.
- `Type` is `expense` or `income` (case-insensitive). Any other value is a problem for that line ("not
  supported") — transfers are not guessed at, because their Spendee representation is unknown.
- `Amount` is a signed decimal with a dot: negative for expenses, positive for income. The stored amount is the
  absolute value and the type decides the direction. A sign that contradicts the type, or a zero amount, is a
  problem for that line.
- Spendee can export more decimals than the currency has (converted foreign purchases, e.g. `-24.5806912` RON).
  Those amounts are **rounded half away from zero to the currency's decimals**, using decimal-string arithmetic,
  never floats. An amount that rounds to zero is a problem. The preview carries a notice with how many amounts
  were rounded.
- `Wallet` + `Currency` identify the wallet exactly as in the native CSV (matched by name + currency, created with
  an initial balance of 0 when missing; the archived-wallet rule applies). `Category name` + type identify the
  category (matched ignoring case, created when missing). An empty wallet, currency or category name is a problem.
- `Notes` becomes the note, with the usual limits.
- The preview names the format ("Spendee export") and, like the native CSV, says that new wallets start at 0.
- Rules settled while building:
  - Detection: a header with a `Category name` column and **no** `category` column is Spendee; then `Date`, `Wallet`,
    `Type`, `Category name`, `Amount`, `Currency` are required (a missing one is a line-1 problem naming it) and
    `Notes` is optional. A native CSV that happens to have an extra `Category name` column stays native.
  - Date: `YYYY-MM-DD`, optionally followed by ` HH:MM` or ` HH:MM:SS` (or `T` instead of the space); an impossible
    date or time is a problem. Other formats (e.g. `29.04.2019`) are problems — Spendee doesn't write them.
  - Amount: `[+|-]digits[.digits]` only (no decimal comma, grouping or exponent). `-0` / `0` is "must not be zero";
    an amount that only becomes zero by rounding says what it rounds to. Magnitudes beyond `Number.MAX_SAFE_INTEGER`
    minor units are rejected. A rounded amount is one where a **non-zero** digit was dropped (`-30.500` is not
    counted). One notice per currency, counting rows that are otherwise valid:
    `{ code: "amounts-rounded", count, message: "31 amounts had more decimals than RON allows and were rounded to 2 decimals." }`
    (0-decimal currencies: "…rounded to whole units.").
  - Text cells are taken literally (no `'` formula-prefix removal: Spendee doesn't write one). Problem messages are
    prefixed with Spendee's column names (`Amount: …`).

**Spendee — per-wallet export with transfers (the current Spendee export)**

Spendee now exports **one file per wallet**, with a different dialect from the older single-file export. Both
dialects are the same provider format ("Spendee export") and are detected the same way.

```
Date,Wallet,Type,Category name,Amount,Currency,Note,Labels,Author
2026-08-08T11:06:15+00:00,Joint,Expense,Groceries,-83.93000000,EUR,,,"Jane Doe"
2026-08-17T08:41:32+00:00,Savings,Outgoing Transfer,,-300.00000000,EUR,rent share,,"Jane Doe"     ← in the Savings file
2026-08-17T08:41:34+00:00,Joint,Incoming Transfer,,300.00000000,EUR,rent share,,"Jane Doe"        ← in the Joint file
```

- `,`-separated, LF, cells quoted only when needed, UTF-8. The note column is `Note` (older dialect: `Notes`);
  accept either. `Labels` and `Author` are new; `Author` is ignored.
- `Type` is `Expense`, `Income`, `Outgoing Transfer` or `Incoming Transfer` (compare case-insensitively).
- `Date` is an ISO timestamp **with a UTC offset**. A timestamp with an offset is converted to the importing
  user's time zone and that local calendar date is used (an entry made at 00:30 local time must not land on the
  previous day, or the previous month). The browser sends its IANA time zone with the upload; if it is missing or
  invalid, UTC is used. A timestamp without an offset (the older dialect) is still taken as written. The preview
  carries a notice naming the time zone used.
- `Amount` has 8 decimals; trailing zeros are not "rounding". Genuinely over-precise amounts (currency
  conversions) are rounded as before, with the notice.
- `Labels`: this app has no labels. They are kept by appending them to the note (`note · labels`, or just the
  labels when there is no note), with a notice counting the affected entries.
- **Transfers** are written as two rows in two different wallets' files: an `Outgoing Transfer` (negative) in the
  source wallet and an `Incoming Transfer` (positive) in the destination, with an empty category, the same note,
  and timestamps at most a couple of seconds apart. The importer pairs them into one transfer:
  - candidates for an outgoing row are incoming rows in a **different wallet**, with the **same note**, within
    **10 seconds**, and — when both wallets have the same currency — the **same amount**; different currencies may
    have different amounts (sent vs. received);
  - pairs are assigned closest-in-time first, each row used once; a tie that cannot be resolved by time is a
    problem naming both lines, never a guess;
  - the transfer takes the outgoing row's date and note; the two rows count as **one** transfer in the preview and
    for duplicate skipping;
  - a transfer row left **without a partner** is a blocking problem that says which file and line, and that the
    other wallet's export must be included in the same import. Because that would be a dead end when the other
    wallet no longer exists, the import has an option — off by default, offered where that problem is shown — to
    import unpaired transfer rows as plain income / expense entries in a category named `Transfer` instead.
  - a category on a transfer row is ignored.

### Importing several files at once

- The file picker accepts multiple files, and the whole selection is **one import**: one preview, one
  confirmation, one all-or-nothing DB transaction. This is what makes Spendee's per-wallet files usable, since a
  transfer's two rows live in different files.
- A selection may mix native CSVs and provider CSVs. A **backup must be imported on its own** (its wallets are
  identified by position, which cannot be merged with other files); combining it with other files is a problem.
- Limits apply to the selection as a whole: 5 MB in total, 50 000 rows in total, at most 50 files.
- Problems and notices name the file they came from (file name + line) whenever more than one file is selected.
- The same file selected twice (identical content) is used once, with a notice — otherwise its entries would
  count double inside the multiset duplicate rule.
- Duplicate skipping, wallet/category matching and creation work across the whole selection exactly as for one
  file. The preview lists the files with the format detected for each.
- Rules settled while building (Spendee per-wallet dialect and multi-file):
  - Both Spendee dialects accept all four types; `Note` is used when present, else `Notes`; problem messages use the
    column name as written (`Note: …`). A note that exceeds 500 characters only once the labels are added is a
    problem ("… (with the labels added)"). Labels are trimmed with inner whitespace collapsed and kept as written.
  - Timestamps: `YYYY-MM-DD`, then optionally `[ T]HH:MM[:SS[.fraction]]`, then optionally `Z` or `±HH[:]MM`. The
    offset is applied and the date read in the zone with `Intl.DateTimeFormat` (`dateInTimeZone`). The zone is
    validated with `Intl` (`resolveTimeZone`: canonical name, ≤ 100 chars; missing → UTC; invalid → UTC and the
    notice says the browser's zone was not recognised). Offset-less values keep the written date.
  - Pairing: the "same note" is the `Note` cell (trimmed) **without labels**; the transfer's note is the outgoing
    row's note + its labels, or + the incoming row's labels when the outgoing row has none. Offset-less times are
    read as written for pairing; a bare date counts as 00:00. The window is inclusive (10 s pairs, 11 s does not).
    Candidates are processed by distance; at one distance, rows competing for each other form a group: a group of
    one outgoing and one incoming row pairs; a group whose outgoing rows are all identical and whose incoming rows
    are all identical (wallet, amount, instant, date, note) pairs them one-to-one in file order; any other group is
    **one** blocking problem listing every row (file, line, amount, wallet) and those rows are not reported again as
    unpaired (the unpaired option does not apply to them).
  - Unpaired rows (option off): one problem per row, at its file + line, e.g. "Outgoing transfer of 40.00 EUR from
    “Savings” on 2026-08-01 has no matching Incoming Transfer row in another wallet (same note, at most 10 seconds
    apart). Select the other wallet's Spendee export too … or … turn on “Import unpaired transfers as income /
    expense”." Option on: outgoing → expense, incoming → income, category `Transfer` of that kind (matched / created
    like any category), the row's note; notice `unpaired-transfers`. `ImportPreview.unpairedTransfers` counts such
    rows either way, so the UI can offer the option.
  - Spendee notices are selection-wide (no `file`), in this order: `time-zone` (count = rows with an offset;
    "Spendee records the time of each entry; dates are taken in your time zone, Europe/Brussels. 5 entries fall on
    a different day than the UTC date in the file."), `labels` (rows with labels), `amounts-rounded` (per currency,
    as before), `unpaired-transfers`. A file selected twice adds `duplicate-file` first, with `file` set.
  - Selection checks, in order: no files → "No file was received."; more than 50 files; total UTF-8 size over 5 MB
    ("The selected files are larger than 5 MB in total."; one file keeps the old message); identical texts are
    used once; a backup with any other (distinct) file → one problem naming the backup(s), nothing parsed; each
    file is parsed by its own detected format (an empty file is a problem for that file); total rows over 50 000;
    then each format's `finalize`. Problems are ordered by file, then line; whole-file problems first.
  - One file (string or one-element list) behaves exactly as before: no `file` on problems or notices. With
    several files, wallets are merged by name + currency and categories by kind + name (first spelling wins),
    `walletMatching` is `merge`, and `format` is the common format or `null` when they differ (`formatLabel` then
    joins the distinct labels with " + ").

### Screen

- **/data** ("Import & export") — an Export card (backup JSON, transactions CSV, wallets & categories JSON with a
  Copy button, one sentence each on what it is for) and an Import card (file picker, the duplicate checkbox, preview summary, confirm). After a successful
  import: a summary of what was added and links to the dashboard and transactions. Reachable from the top menu
  ("Import & export", the fifth item). Redesign layout: "Export" and "Import" side by side from `lg` up; each export
  row has a format badge (JSON / CSV), title, one sentence and a pill download button; the import side is a dashed
  drop area ("Drop files here or choose files", accepts several), the chosen files as pills, then the preview card
  ("Ready to import · <format>", counts for transactions / transfers / duplicates skipped, new wallets and new
  categories, "Everything is saved in one step, or nothing is.", Cancel + "Import N entries").
  As built (redesign step 8): each side is a `<section>` with an 18px/800 `<h2>` over its card. Export rows: a
  44px `aria-hidden` format badge (the title carries a visually hidden "(JSON)" / "(CSV)"), title, one sentence, and
  the actions, which sit to the right of the text when the row is wide enough and wrap under it otherwise; the
  download links are 44px secondary pills (`<a download>`), "Copy to clipboard" is an accent text button beside the
  third one, its fallback text box takes a line of its own. Import: the drop area is a `<label>` around the visually
  hidden `<input type="file" multiple>` (named by "Drop files here or choose files", described by the hint line; its
  focus ring is drawn on the area); dropping files replaces the selection exactly as choosing them does. The chosen
  files are pills ("name · size", with a total line when there are several or a limit is exceeded); the longer
  format, limit and Spendee text moved into a closed "What can be imported" `<details>`. "Preview import" stays (the
  preview is still an explicit step). The preview card's footer has Cancel (clears the preview **and** the chosen
  files, focus returns to the file input) and, when there is anything to import, "Import N entries" ("Import" when
  only wallets / categories would be created); with nothing to import the card says so and offers only Cancel. A
  category created under both kinds (Spendee's unpaired "Transfer") is listed with its kind. Problems use the same
  card shape with a `bg-danger-soft` band (heading in the text colour) and the line labels in `text-danger` on the
  surface; problems have no Cancel (choosing other files or "Preview import" again is the way on). Rendering is
  covered by `tests/import-preview.test.tsx`.
- Module layout: pure, dependency-free code for the formats in `src/lib/csv.ts` (parse / serialise) and
  `src/lib/backup-format.ts` / `src/lib/context-format.ts` (schema + types); `src/server/export.ts` and
  `src/server/import.ts` for the services (`buildBackup`, `buildContext`, `buildTransactionsCsv`, `previewImport`,
  `runImport`). Each importable format is one
  module in `src/server/import-formats/` (`backup.ts`, `transactions-csv.ts`, `spendee.ts`; the parsed form and
  shared helpers in `shared.ts`), registered in the `FORMATS` list in `src/server/import.ts`.

### As built

```ts
// src/lib/csv.ts (pure)
parseCsv(text, opts?: { delimiter?; maxRecords? }): { delimiter; records: { line; cells: string[] }[]; errors: { line; message }[] }
detectDelimiter(text) / stripBom(text) / toCsv(rows, opts?: { delimiter?; bom? = true; newline? = "\r\n" })
escapeFormula(v) / unescapeFormula(v)
// src/lib/backup-format.ts (pure): BACKUP_APP, BACKUP_VERSION = 1, BACKUP_LIMITS, backupSchema (zod), types Backup…,
//   formatIssuePath(path) → "transactions[3].amountMinor"
// src/lib/context-format.ts (pure): CONTEXT_KIND = "context", CONTEXT_VERSION = 1, contextSchema (zod; strips unknown
//   fields), types ContextExport, ContextWallet, ContextCategory. Nothing in the app imports a context file yet; the
//   schema is there so it can be validated the same way when something does.
// src/lib/constants.ts: IMPORT_MAX_BYTES = 5 MiB, IMPORT_MAX_ROWS = 50 000, IMPORT_MAX_FILES = 50 — all for the whole
//   selection (shared by the browser check and the server)
// src/lib/dates.ts: resolveTimeZone(value) → { timeZone /* canonical IANA or "UTC" */; fallback }, dateInTimeZone(instantMs, zone)

// src/server/export.ts
buildBackup(userId, now?): Backup
buildContext(userId, now?): ContextExport   // every wallet (incl. archived, flagged) + category, creation order; no ids
buildTransactionsCsv(userId, filters?: Omit<TransactionFilters, 'limit' | 'offset'>): string   // uses filterConditions
// src/server/import.ts
type ImportOptions = { skipDuplicates?: boolean /* default true */; timeZone?: string /* IANA, from the browser */;
  unpairedTransfersAsEntries?: boolean /* default false */ }
type ImportFileInput = { name: string; text: string }
type ImportInput = string /* one unnamed file, as before */ | ImportFileInput[]
type ImportProblem = { file?: string /* only with several files */; line?: number; path?: string; message: string }
type ImportNotice = { code: string; message: string; count?: number; file?: string }   // non-blocking, e.g. "amounts-rounded"
type ImportFileSummary = { name; format: ImportFormatId | null; formatLabel: string | null; rows: number | null /* null = not read */;
  duplicateOf?: string /* name of the identical earlier file */ }
type ImportPreview = { format: 'backup' | 'csv' | 'spendee' | null /* null also when files differ */;
  formatLabel: string | null /* "Spendee export"; "Spendee export + Transactions (CSV)" */; files: ImportFileSummary[];
  ok; transactionsToAdd; transfersToAdd; duplicateTransactions; duplicateTransfers;
  walletsToCreate: { name; currency; archived }[]; categoriesToCreate: { name; kind }[];
  problems: ImportProblem[] /* first 50 */; problemCount; notices: ImportNotice[] /* never affect ok */;
  unpairedTransfers: number /* Spendee transfer rows without a partner */ }
previewImport(userId, input: ImportInput, opts?): ImportPreview
runImport(userId, input: ImportInput, opts?): ImportPreview & { imported: boolean }   // never throws for bad files
parseImportFiles(input, opts?): { file: ParsedFile /* the merged selection */; files: ImportFileSummary[] }

// src/server/import-formats/shared.ts — the seam between formats and the shared planner
type ImportFormat = { id: ImportFormatId; label: string; detect(source: ImportSource): boolean;
  parse(source: ImportSource, ctx: ImportContext): ParsedFile;
  finalize?(combined: ParsedFile, ctx: ImportContext): void /* once per selection containing this format, after merging */ }
type ImportContext = { timeZone /* validated */; timeZoneFallback: boolean; unpairedTransfersAsEntries: boolean }
type ImportSource = { text /* as uploaded */; body /* BOM stripped, trimStart, non-empty */; csvHeader(): string[] /* lower-cased, lazy */ }
type ParsedFile = { format; walletMatching: 'by-position' | 'merge'; wallets: WalletSpec[]; categories: CategorySpec[];
  entries: EntrySpec[]; transfers: TransferSpec[]; transferLegs: TransferLeg[] /* halves to pair in finalize */;
  problems: ImportProblem[]; notices: ImportNotice[]; unpairedTransferRows: number; rowCount: number;
  tallies: Map<string, number> /* per-format counters summed over the selection, e.g. "rounded:RON" */ }
type Loc = { line?; path?; file?; fileIndex? /* internal ordering; stripped before reaching the UI */ }
type TransferLeg = { direction: 'out' | 'in'; wallet; currency; amountMinor; date; instant /* ms */; matchKey; note; bareNote; labels; loc }
// src/server/import-formats/spendee.ts: parseSpendeeTimestamp(value, zone) → { date; instant; converted; shifted } | null,
//   TRANSFER_PAIR_WINDOW_MS = 10 000, UNPAIRED_TRANSFER_CATEGORY = "Transfer"
// helpers: readCsvTable (quoting errors, header → column map, missing columns, row limit), cellReader, specBuilder
//   (walletFor / categoryFor by key), currencyCell, check, normalizeWalletName / normalizeCategoryName
// src/server/import.ts: FORMATS = [backupFormat, spendeeFormat, transactionsCsvFormat] — first `detect` wins; the
//   native CSV accepts anything, so it is last. planImport / summarize / writePlan never look at `format`.
// src/lib/money.ts: parseDecimalRounded(input, currency) → { minor, negative, rounded } | null
//   (half away from zero on the decimal string + BigInt; used by provider formats, never for user input)
```

- One core: `parseImportFile` (size/empty checks, then the first registered format whose `detect` accepts the
  file parses it, with zod + the `_validate` helpers the services use) → `planImport`
  (one query each for the user's wallets, categories, grouped non-transfer entries and transfers-with-legs; the
  multiset is a `Map<key, count>` consumed per file entry) → `writePlan`. `runImport` re-parses and re-plans inside
  the same DB transaction it writes in; with any problem it writes nothing and returns `imported: false`.
  Inserts are chunked multi-row `INSERT`s (≤ 1000 rows); transfer ids come back from `RETURNING`, sorted (SQLite
  assigns them in VALUES order). Measured: 50 000 CSV rows (45 000 entries + 5 000 transfers, 2.5 MB) into a
  file-backed DB in ≈ 1 s; preview ≈ 0.1 s; re-import of the same file (all duplicates) ≈ 0.25 s.
- Upload: two Server Actions in `src/app/(app)/data/actions.ts` (`previewImportAction(formData)`,
  `runImportAction(formData)` → `ImportActionState = { error?; fileNames?; preview?; result? }`). The FormData has
  one `file` entry per selected file, `skipDuplicates` (`off` turns it off), `unpairedTransfers` (`on` turns it on)
  and `timeZone` (`Intl.DateTimeFormat().resolvedOptions().timeZone`); both steps send all of them and the service
  re-validates everything. The panel (`<input type="file" multiple>`) keeps the chosen `File`s in state, lists them
  with their sizes, and sends a fresh `FormData` for each step (a `<form action>` would reset the file input after
  the preview). The preview lists the files with their detected format and row count (several files), shows
  `notices` under "Good to know" (also next to problems) and after a successful import, prefixes problems with their
  file, and shows the "Import unpaired transfers as income / expense" checkbox whenever `unpairedTransfers > 0` or
  it is on; toggling it re-runs the preview, choosing other files turns it off.
  `experimental.serverActions.bodySizeLimit = "6mb"` (5 MB of files + multipart overhead; this limit applies to all
  actions). The 5 MB / 50-file caps are checked in the browser, again in the action (`file.size` sum, count) and
  in the service (UTF-8 byte length), with the same messages.
- Rules settled while building:
  - **Archived wallets**: an import never adds a *new* entry to a wallet that is archived in the account (backup or
    CSV, either side of a transfer) — that is a line-numbered problem ("unarchive it first"), mirroring the services.
    Entries on it that are duplicates are skipped silently, so re-importing an export of an account with archived
    wallets still works and adds nothing. A wallet the import *creates* from a backup with `archived: true` gets its
    history inserted and is then archived — a restore, not new activity.
  - **Same-named wallets**: in a backup, the k-th file wallet with a given name + currency matches the k-th such
    wallet in the account (by id), so two "Cash · EUR" wallets survive a round trip. In a CSV a wallet *is* its name
    + currency: rows go to the matching active wallet (else the oldest archived one), and duplicate detection treats
    all same-named wallets of that currency as one, so re-importing the CSV of such an account adds nothing.
  - Categories in a backup that differ only by case are merged into one. Unused categories travel in the backup
    (they are created), never in the CSV.
  - Decimal strings in a backup are optional; when present they must parse (`parseAmount`, wallet currency) to the
    minor units, otherwise the file is rejected at that path.
  - Transfers: same currency ⇒ the received amount may be omitted (backup `receivedAmountMinor`, CSV `to_amount`) and,
    if given, must equal the amount sent; different currencies ⇒ required. CSV `to_currency` defaults to `currency`.
    A category on a transfer row is a problem.
  - CSV header: `date,type,wallet,currency,amount` are required (`category,note,to_wallet,to_currency,to_amount`
    optional); `type` and header names are case-insensitive; rows whose cells are all blank are skipped; negative
    amounts are rejected with "amounts are positive; the type says which way the money goes".
  - Formula guard: export prefixes `'` to `wallet`, `category`, `note`, `to_wallet` cells starting with `=`, `+`, `-`,
    `@`, tab, CR **or `'`**; import strips one leading `'` only when the next character is one of those. That makes it
    an exact round trip (`'quoted` → `''quoted` → `'quoted`; a hand-written `'quoted` stays as is).
  - Backup limits: 1 000 wallets, 1 000 categories, 50 000 transactions + transfers; raw strings ≤ 2 000 chars before
    the service rules apply. Unknown fields are ignored; `version` ≠ 1 is rejected with a message (newer vs unknown).
  - The CSV export lists rows oldest first; a transfer is included when either leg matches the filters (so a wallet
    filter includes transfers into it) and appears once.

## Deployment — self-hosted with Docker

The app is meant to be self-hosted by anyone (homelab, VPS) from a single container. There is no dependency on
Vercel or any hosted platform; remove any create-next-app Vercel boilerplate (README text, "Deploy" links, logos).

- `next.config`: `output: 'standalone'` (+ `outputFileTracingIncludes` for `drizzle/**`, so the migrations are inside
  `.next/standalone/drizzle`). The standalone server still needs `.next/static` → `.next/standalone/.next/static`
  and `public/` → `.next/standalone/public` copied in (Next's standard standalone step). `public/` only holds a
  `.gitkeep` today. `better-sqlite3` is in `serverExternalPackages` and is traced into
  `.next/standalone/node_modules` with its native prebuild for the build platform — build inside the image.
  No telemetry (`NEXT_TELEMETRY_DISABLED=1` in the image).
- **Runtime configuration is environment-only** (documented in `.env.example` and the README):
  - `DATABASE_URL` — path of the SQLite file. Default `data/app.db` locally, `/data/app.db` in the image.
  - `COOKIE_SECURE` — `auto` (default: mark the session cookie `secure` only when the request arrived over
    HTTPS, judged by `x-forwarded-proto`), `true`, or `false`. Many homelabs serve plain HTTP on the LAN; a
    hard-coded `secure` cookie would silently break sign-in there.
  - `ALLOW_REGISTRATION` — `true` (default) or `false`. When `false`, `/register` shows a "registration is
    disabled" message and the register action refuses, so an instance exposed to the internet can be closed
    after its accounts exist.
  - `EXCHANGE_RATES` — `true` (default) or `false`. When `true`, the server requests the day's reference rates
    from `api.frankfurter.dev` for the Overview's converted total; `false` makes no outbound request.
  - `PORT` (default 3000), `HOSTNAME` (`0.0.0.0` in the image).
- Migrations are applied automatically at startup, so the migrations folder must be resolvable in the
  standalone build (resolve from `process.cwd()`, overridable with `MIGRATIONS_DIR`) and copied into the image.
- `GET /api/health` → `200 {"status":"ok"}` after a trivial DB query (`503` if the DB is unreachable); public, no auth.
- `Dockerfile`: multi-stage on `node:24-bookworm-slim` (glibc, so `better-sqlite3` prebuilt binaries work on
  amd64 and arm64), final stage runs the standalone server as a non-root user, `VOLUME /data`, `EXPOSE 3000`,
  `HEALTHCHECK` on `/api/health`. As built: deps stage runs `npm ci --ignore-scripts` (better-sqlite3 13 ships its
  Linux prebuilds in the package; its implicit `node-gyp rebuild` would otherwise need python3/make/g++) and then
  loads the module to fail fast; runner uses the base image's `node` user (uid/gid 1000), copies `drizzle/` to
  `/app/drizzle` explicitly (`MIGRATIONS_DIR=/app/drizzle`), drops non-Linux better-sqlite3 prebuilds, and the
  healthcheck is a `node -e` fetch (no curl/wget in the image).
- `docker-compose.yml`: one service, named volume mounted at `/data`, port mapping, the env vars above with
  their defaults, `restart: unless-stopped`. `docker compose up -d` must be all a user needs.
- `.dockerignore` keeps `node_modules`, `.next`, `data`, `.env*`, `.git` out of the build context.
- The README has the compose quick start and the env vars; `docs/SELF-HOSTING.md` documents running behind a
  reverse proxy (HTTPS, forwarded headers), where the data lives, backup/restore of the SQLite file, and upgrading.

## UI direction

Reference mock-ups: the Design canvas https://claude.ai/artifact/HYiCKKzqCayiQHUjZQc3gP, page "Chosen: Sand +
Graphite" (every screen in both themes; each artboard's script holds the exact colours). The canvas is private to
the owner; this section is the contract, the canvas is the picture. Where they disagree, this section wins.

**Character.** Calm, warm and roomy: a top menu instead of a sidebar, large confident numbers, few borders, rounded
cards on a tinted page background, one accent colour. Charts are part of the page, not decoration: per-day bars
plus a running total appear on Overview, Transactions (as a strip) and wallet pages. Lists are grouped by day and
edited in place. Light and dark follow `prefers-color-scheme`. Fully usable at 375px wide.

**Type.** Plus Jakarta Sans (weights 400–800) via `next/font/google` in `src/app/layout.tsx`, exposed as
`--font-sans`; it is downloaded at build time and served by the app, so the browser never contacts Google. Amounts
use `tabular-nums`. As built: the variable font (one file per subset covers 200–800), subsets `latin` +
`latin-ext`, `display: swap`, CSS variable `--font-jakarta` on `<html>`, which `--font-sans` in `@theme` puts first
in its fallback stack; the `.woff2` files land in `.next/static/media` and the CSS has no Google URL. Scale: page title 28px/800; big numbers 40–44px/800 (−0.03em); card numbers 26–28px/800; card
titles 13px/600 muted; body 14px; small 12–13px.

**Theme tokens** (`src/app/globals.css`; the existing token names stay, so components keep using `bg-surface`,
`text-muted-foreground` etc.; new tokens are added with matching `@theme inline` entries):

| Token | Sand (light) | Graphite (dark) | Use |
|---|---|---|---|
| `--background` | `#F4EFE7` | `#141518` | page |
| `--surface` | `#FFFCF7` | `#1D1E22` | cards, top bar, dialogs |
| `--surface-muted` | `#EFE7DB` | `#25272C` | row dividers, chips, segmented-control track |
| `--surface-raised` *(new)* | `#EFE4D6` | `#2A2C31` | active menu pill, currency pills |
| `--surface-open` *(new)* | `#FBF4EA` | `#24262B` | a row expanded for editing |
| `--field` *(new)* | `#FFFFFF` | `#141518` | input backgrounds |
| `--border` | `#E5DACB` | `#2E3036` | card and input borders |
| `--border-strong` | `#CDBFAE` | `#4E515A` | dashed "add" rows, previous-month line, bars of days without focus |
| `--foreground` | `#2B241F` | `#EDEDEF` | text, expense amounts, running-total line |
| `--muted-foreground` | `#6E6257` | `#A3A5AC` | secondary text |
| `--accent` | `#BC522C` | `#FF7A59` | primary buttons, Add, chart bars, focus ring, selected pill border |
| `--accent-hover` | `#A8461F` | `#FF9B80` | hover; also link text on Sand (`--link`) |
| `--accent-foreground` | `#FFFFFF` | `#141518` | text on accent |
| `--accent-soft` | `#F6E1D6` | `#3A2620` | selected pill fill |
| `--accent-soft-foreground` *(new)* | `#8E3A1B` | `#FFB8A3` | selected pill text |
| `--income` / `--income-soft` | `#2F7A55` / `#EDF4EE` | `#6CD49A` / `#1B2A22` | income amounts, money-in bars, success banners |
| `--expense` / `--expense-soft` | `#B5452A` / `#F7E3DA` | `#FF9B80` / `#3A2620` | negative balances, the expense dot is `--expense-dot` |
| `--expense-dot` *(new)* | `#D9824F` | `#FF9B80` | the small dot before an expense row |
| `--transfer` / `--transfer-soft` | `#6E6257` / `#EFE7DB` | `#A3A5AC` / `#25272C` | transfer amounts |
| `--danger` / `--danger-soft` | `#A83F26` / `#F7E3DA` | `#FF9B80` / `#3A2620` | delete/remove text buttons, errors |
| `--chart-future` *(new)* | `#EFE7DB` | `#25272C` | bars for days after today |
| `--chart-ramp-1…5` *(new)* | `#BC522C #D9824F #E8B48C #CDBFAE #8C7E70` | `#FF7A59 #D9694E #A85643 #7A4639 #4E515A` | category shares, largest first; the 6th and later categories reuse 5 |
| `--scrim` *(new)* | `rgba(43,36,31,.45)` | `rgba(0,0,0,.6)` | behind dialogs |
| `--ring` | = `--accent` | = `--accent` | focus outline |

**Shapes and spacing.** Cards: radius 18–20px, 1px `--border`, 20–28px padding, no shadow. Lists inside cards: rows
14px × 18px, separated by 1px `--surface-muted` lines. Buttons and chips: fully rounded pills; primary = accent fill,
secondary = transparent with a `--border` outline, destructive = `--danger` text on no fill. Inputs: radius 10–12px,
44–48px tall, `--field` background, accent border when focused or in an open edit form. Dialogs: radius 24px, large
soft shadow. Floating Add: accent pill with shadow. Touch targets ≥ 44px on phones.

**Amounts.** Always formatted with their currency (`formatMoney`), right-aligned in lists, `tabular-nums`. Income
`+€…` in `--income`; expenses `−€…` in the text colour (the dot carries the kind); transfers muted. Negative balances
in `--expense`.

**Charts** are hand-built (CSS grid bars + an inline SVG line with `preserveAspectRatio="none"` and
`vector-effect: non-scaling-stroke`); no chart library. Each chart has a text alternative (an `aria-label` summary
and, where it carries data the page does not repeat, a visually hidden table).

**Accessibility** as before: real `<label>`s, visible focus rings (`--ring`), errors tied to fields, pending state on
buttons while an action runs, `aria-expanded` on rows that open, `aria-current` in the menu, radio groups for pill
pickers. Every text/background pair in the table meets 4.5:1 (checked; the lowest are white on the Sand accent at 4.8:1 and
income on income-soft at 4.65:1); the ramp and chart colours are decorative and never carry text.

### Redesign build order

Each step leaves the app working and passes `npm run typecheck`, `npm run lint` and `npm test`; each is checked on the
demo database (`npm run dev:demo`) at 375px and desktop width, in both colour schemes.

1. **Foundation** — tokens and font; the top bar, account menu, floating Add button and the N shortcut; remove the
   sidebar and bottom tab bar; `Dialog` + the `@modal` slot with the three intercepted routes; `Segmented`,
   `PillPicker`. Update the CLAUDE.md gotcha about the full mobile bottom bar, and anything in README.md that
   describes the old shell.
2. **Data** — `server/insights.ts`, `listDayTotals`, the `month` filter, `listCategoriesWithUsage` options,
   `getWalletMonth`, with service tests (single currency, several currencies, archived wallets, transfers, month
   boundaries, a 31-day month against a 30-day one, an empty month).
3. **Overview** — chart card, insight cards, wallets + latest.
4. **Transactions** — chips, day strip, day groups with totals, in-place editing (+ the inline actions).
5. **Wallets** — list, wallet page with its month chart and "balance after" days, the wallet dialog.
6. **Add entry** — the dialog form (pills, date pills, keep-open), still working as a full page.
7. **Categories** — split bar, lists with month figures, in-place rename / remove.
8. **Import & export, sign in, register** — restyle to the new layout; no behaviour change.

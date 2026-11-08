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
- **No currency conversion anywhere.** Totals are always grouped per currency.
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
    Desktop sidebar: display name, then the user ID (when it differs from the display name), then the email (when
    there is one), one per line; mobile top bar: display name with the user ID under it when they differ (the
    block's tooltip is `<user ID> · <email>`). Long values truncate with an ellipsis and a tooltip.
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
  components/shell/  components/brand.tsx           # app shell pieces (nav, icons, sign-out button)
  db/schema.ts  db/index.ts                         # schema, connection, auto-migrate
  lib/auth.ts  lib/money.ts  lib/currencies.ts  lib/dates.ts  lib/errors.ts
  lib/form.ts  lib/password.ts  lib/constants.ts  lib/cn.ts  lib/config.ts (env: ALLOW_REGISTRATION, COOKIE_SECURE)
  lib/user-id.ts                                    # user ID rules + displayName (client-safe)
  lib/calendar.ts                                   # pure calendar helpers for the date / month pickers
  lib/csv.ts  lib/backup-format.ts  lib/context-format.ts  # pure import/export formats
  app/api/health/route.ts                           # GET /api/health
  app/api/export/{backup,transactions,context}/route.ts  # downloads (session required)
  components/data/import-panel.tsx                  # client: two-step import UI
  components/data/copy-context-button.tsx           # client: "Copy" for the wallets & categories export
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
```

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
  Uncontrolled: it reads `defaultValue` once, so a form that must reset it remounts (`key`). The popover
  (`role="dialog"`, "Choose a date"): ‹ › month buttons, a "November 2026" button that switches to a `MonthGrid`
  (picking a month returns to the days; Escape there steps back instead of closing), a Monday-first 6-week grid
  (`role="grid"`, day buttons `role="gridcell"` with `aria-selected`, `aria-current="date"` for today and the full
  date as `aria-label`; neighbouring months dimmed, today ringed, the selection filled with the accent), and a footer
  with "Today" and, with `allowEmpty`, "Clear". Picking closes it and returns focus to the trigger. Keyboard in the
  grid: see `moveDate`; one day is in the Tab order (roving tabindex); moving past the shown month changes month.
- `MonthGrid` (client) `{ value: 'YYYY-MM' | null; onSelect(month); minMonth?; maxMonth?; focusMonth?; autoFocus? }` —
  year stepper (‹ 2026 ›) over a 3 × 4 grid of `aria-pressed` month buttons; months outside the bounds are
  disabled; the current month has a ring when not selected. Keyboard: see `moveMonth`; roving tabindex.
- `Popover` (client) `{ open; onClose; anchor; trigger; align?: 'start'|'end'; id?; role?; 'aria-label'?; className? }` —
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
- The shell (`(app)/layout.tsx`) already renders the page container (`max-w-5xl`, padding, bottom padding for the
  mobile tab bar) — pages just render `PageHeader` + content.

Theme tokens (`src/app/globals.css`, light + dark via `prefers-color-scheme`) — use these utilities, not raw palette
colours: `bg-background`, `bg-surface`, `bg-surface-muted`, `border-border`, `border-border-strong`, `text-foreground`,
`text-muted-foreground`, `bg-accent`/`text-accent`/`bg-accent-soft`/`text-accent-foreground`/`hover:bg-accent-hover`,
`text-income`/`bg-income-soft`, `text-expense`/`bg-expense-soft`, `text-transfer`/`bg-transfer-soft`,
`text-danger`/`bg-danger`/`bg-danger-soft`, `outline-ring`. Accent is indigo.

## Screens

- **/login, /register** — centered card, inline field errors, link between the two. Login: "User ID or email" +
  password. Register: user ID and password (required), then email, first name and surname, each visibly marked
  optional, with a hint under the user ID stating the allowed characters. As built: first name and surname share a
  row from `sm` up; values are echoed back after an error (never the password); `autocomplete` is `username` /
  `current-password` on login and `username` / `new-password` / `email` / `given-name` / `family-name` on
  register; the user ID and identifier inputs turn off autocapitalise / autocorrect / spellcheck.
- **App shell** — sidebar on desktop, bottom tab bar on mobile: Dashboard, Transactions, Wallets, Categories (plus
  "Add" in the tab bar); display name (with the user ID / email line, see Auth) +
  sign out. "Import & export" (`/data`) is a secondary sidebar entry below a divider and, on mobile, an icon link
  in the top bar next to sign out (the bottom bar stays at five items). A prominent "Add transaction" entry point is reachable from every page.
- **/** Dashboard — greeting with the display name ("Hello, …" / "Welcome, …"); wallet cards with balances; per-currency totals with this month's income / expenses
  (month switcher); spending by category for the month (simple horizontal bars, per currency); recent
  transactions. Friendly empty state that sends a new user to create their first wallet.
  The month switcher (`components/dashboard/month-switcher.tsx`, client) is "‹ November 2026 ›": the arrows are
  plain links (they work without JS) and the month is in the URL — the current month is the bare `/`, any other
  `/?month=YYYY-MM`; nothing past the current month. The label is a button that opens a `MonthGrid` popover
  (right-aligned, future months disabled) to jump to any month (`router.push(…, { scroll: false })`). Away from the
  current month a small "This month" link next to the switcher goes back to `/`.
- **/wallets** — list (active, then archived) with balance; create wallet (name, currency picker, initial
  balance); edit (name, initial balance); archive / unarchive; delete when empty.
- **/wallets/[id]** — header with balance + actions (add expense / income / transfer preselecting this wallet,
  edit, archive, delete when empty), then that wallet's 25 most recent transactions, each row linking to its
  edit page, and a "View all" link to `/transactions?wallet=<id>`.
- **/transactions** — all transactions with filters kept in the URL (wallet, kind, category, date range,
  note search) and pagination; per-row edit / delete. The From / To filters are `DatePicker`s with `allowEmpty`
  (`To` right-aligned), so an empty one adds nothing to the URL; a set one posts `from=YYYY-MM-DD` / `to=…` as before.
- **/transactions/new**, **/transactions/[id]/edit**, **/transactions/transfers/[id]/edit** — one form with an
  Expense / Income / Transfer switch. Expense/Income: wallet, category (filtered by kind), amount (shows the
  wallet's currency), date (a `DatePicker`, defaults to today), note. Transfer: from wallet, to wallet, amount sent, and —
  only when the two currencies differ — amount received; date, note. `?wallet=<id>` and `?kind=` preselect.
  Deletes ask for confirmation. The edit pages carry the Delete button for that transaction / transfer.
- **/categories** — two sections, Expense and Income. Each lists its categories by name with their transaction
  count, and has an "add category" form (name only; the section decides the kind). Each category can be renamed
  and removed. Removing an unused category asks for confirmation; removing one with transactions shows how many
  will move and requires picking the replacement category first. Errors (duplicate name, empty name, missing
  replacement) appear next to the control that caused them. Reachable from the main navigation on desktop and
  mobile, and from a "Manage categories" link beside the category picker in the transaction form.
  As built: rename is an inline form in the row; Remove on an unused category asks `confirm()`, on a used one it
  opens an inline panel (replacement `<select>` of the other same-kind categories, "Move and remove"). Focus moves
  into each inline form and back to its button on Cancel/Escape/save; after a removal it goes to the section heading,
  and a `role="status"` line announces the result. Actions (`src/app/(app)/categories/actions.ts`:
  `createCategoryAction` (bind kind), `renameCategoryAction` / `deleteCategoryAction` (bind id)) stay on the page and
  `revalidatePath("/", "layout")`, since category names appear on every signed-in page.
- **Route contract between features** (so pages can link to each other without importing each other's code):
  `/transactions/new?wallet=<id>&kind=expense|income|transfer`, `/transactions/<id>/edit`,
  `/transactions/transfers/<transferId>/edit`, `/transactions?wallet=<id>`, `/wallets/<id>`, `/wallets/new`.
  The three transaction form pages accept `?returnTo=<path>`: after save / delete / cancel they go back there
  (only same-site relative paths starting with a single `/` are honoured; default `/transactions`).

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
  its current filters.
- `GET /api/export/context` → `expenses-tracker-context-YYYY-MM-DD.json`: the account's **wallets and
  categories only** — `{ app: "expenses-tracker", kind: "context", version: 1, exportedAt, wallets: [{ name,
  currency, archived }], categories: [{ name, kind }] }` — small and free of transactions, so it can be handed
  to companion tools (the Statement Importer artifact) that need to know the user's wallets and categories
  without receiving their history. Same auth and headers as the other exports. The `/data` page offers it as a
  third download, "Wallets & categories (JSON)", with one sentence saying what it is for, next to a "Copy"
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
  import: a summary of what was added and links to the dashboard and transactions. Reachable from the desktop
  sidebar and on mobile without adding a sixth bottom tab (the bar is full at 375px) — e.g. from the top bar.
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

Calm, legible personal-finance UI. Neutral slate surfaces, one accent colour; emerald for income, rose for
expenses, sky for transfers. Amounts right-aligned with `tabular-nums`, always formatted with their currency.
Light and dark via `prefers-color-scheme`. Fully usable at 375px wide. Accessible forms: real `<label>`s,
visible focus rings, errors tied to fields, buttons show a pending state while an action runs.

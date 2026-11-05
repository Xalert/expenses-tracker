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
| `users` | `id`, `email` (unique, stored lowercased), `name`, `passwordHash`, `createdAt` |
| `sessions` | `id`, `tokenHash` (unique, sha256 of the cookie token), `userId` → users (cascade), `expiresAt`, `createdAt` |
| `wallets` | `id`, `userId` → users (cascade), `name`, `currency` (3-letter code), `initialBalanceMinor` (int, may be negative), `archivedAt` (nullable), `createdAt` |
| `categories` | `id`, `userId` → users (cascade), `name`, `kind` (`expense`\|`income`), `createdAt`; unique (`userId`, `kind`, `name`) |
| `transfers` | `id`, `userId` → users (cascade), `date`, `note` (nullable), `createdAt` |
| `transactions` | `id`, `userId` → users (cascade), `walletId` → wallets (restrict), `kind` (`expense`\|`income`\|`transfer_out`\|`transfer_in`), `categoryId` → categories (restrict, null for transfer legs), `amountMinor` (int > 0), `date` (`YYYY-MM-DD`), `note` (nullable), `transferId` → transfers (cascade, null for non-transfers), `createdAt`; indexes on (`userId`, `date`), (`walletId`, `date`), (`transferId`) |

## Auth

- Email + password. Open registration at `/register`, sign-in at `/login`, sign-out action in the app shell.
- Passwords hashed with `node:crypto` scrypt (random salt, timing-safe compare). Min length 8.
- DB-backed sessions: random 32-byte token in an `httpOnly`, `sameSite=lax` cookie (30-day expiry) whose `secure`
  flag follows `COOKIE_SECURE` (see Deployment; logic in `src/lib/config.ts`); only its sha256 is stored. Logout
  deletes the session row.
- `ALLOW_REGISTRATION=false` (`isRegistrationAllowed()` in `src/lib/config.ts`): `/register` renders a "Registration
  is disabled" card, `registerAction` returns an error without creating anything, `/login` hides the sign-up link.
- `src/lib/auth.ts` exposes `getCurrentUser(): Promise<CurrentUser | null>` (React `cache`, per request),
  `requireUser(): Promise<CurrentUser>` (redirects to `/login`), `createSession(userId)`, `destroySession()`,
  `redirectIfSignedIn()`; `CurrentUser = { id: number; name: string; email: string }`. Cookie name `et_session`.
  The `(app)` layout calls `requireUser()`; every Server Action calls it too (layouts don't protect actions).
  Signed-in users visiting `/login` or `/register` are redirected to `/`.
- Password hashing lives in `src/lib/password.ts` (`hashPassword`, `verifyPassword`); user creation/login in
  `src/server/users.ts`: `registerUser({ name, email, password }): Promise<UserView>` (user + default categories in
  one DB transaction; CONFLICT on `email` if taken) and `authenticateUser(email, password): Promise<UserView | null>`.
  Sign-out is `signOutAction` in `src/app/(app)/actions.ts`.
- Login failures return one generic message ("Invalid email or password").

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
  lib/csv.ts  lib/backup-format.ts                  # pure import/export formats
  app/api/health/route.ts                           # GET /api/health
  app/api/export/{backup,transactions}/route.ts     # downloads (session required)
  components/data/import-panel.tsx                  # client: two-step import UI
  server/wallets.ts  server/categories.ts  server/transactions.ts  server/transfers.ts  server/dashboard.ts
  server/export.ts  server/import.ts
  server/users.ts  server/_validate.ts (internal helpers)
scripts/seed.ts  tests/  drizzle/
```

`src/db/index.ts`: `getDb()` (process-wide connection, created + migrated on first access, survives HMR),
`createDatabase(url?)`, `setDb(db)` (tests), `type DB`, `type DBOrTx`. `DATABASE_URL` accepts a path,
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
`receivedAmount`, `fromWalletId`, `toWalletId`, `date`, `note`, `from`, `to`, `month`, `email`, `password`,
`moveToCategoryId`.
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
`monthRange(month) → { from, to }` (inclusive), `shiftMonth(month, delta)`, `addDays(date, n)`, `formatDate(date)`
(`"5 Nov 2026"`), `formatMonth(month)` (`"November 2026"`).

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

- **/login, /register** — centered card, inline field errors, link between the two.
- **App shell** — sidebar on desktop, bottom tab bar on mobile: Dashboard, Transactions, Wallets, Categories (plus
  "Add" in the tab bar); user name +
  sign out. "Import & export" (`/data`) is a secondary sidebar entry below a divider and, on mobile, an icon link
  in the top bar next to sign out (the bottom bar stays at five items). A prominent "Add transaction" entry point is reachable from every page.
- **/** Dashboard — wallet cards with balances; per-currency totals with this month's income / expenses
  (month switcher); spending by category for the month (simple horizontal bars, per currency); recent
  transactions. Friendly empty state that sends a new user to create their first wallet.
- **/wallets** — list (active, then archived) with balance; create wallet (name, currency picker, initial
  balance); edit (name, initial balance); archive / unarchive; delete when empty.
- **/wallets/[id]** — header with balance + actions (add expense / income / transfer preselecting this wallet,
  edit, archive, delete when empty), then that wallet's 25 most recent transactions, each row linking to its
  edit page, and a "View all" link to `/transactions?wallet=<id>`.
- **/transactions** — all transactions with filters kept in the URL (wallet, kind, category, date range,
  note search) and pagination; per-row edit / delete.
- **/transactions/new**, **/transactions/[id]/edit**, **/transactions/transfers/[id]/edit** — one form with an
  Expense / Income / Transfer switch. Expense/Income: wallet, category (filtered by kind), amount (shows the
  wallet's currency), date (defaults to today), note. Transfer: from wallet, to wallet, amount sent, and —
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
per-bank presets) is **out of scope**.

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

### Import

- Accepts a backup JSON or a transactions CSV (detected from content, not the file name). Limits: 5 MB and
  50 000 rows; raise the Server Action / request body limit accordingly and reject anything larger with a clear
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

### Screen

- **/data** ("Import & export") — an Export card (backup JSON, transactions CSV, one sentence each on what it is
  for) and an Import card (file picker, the duplicate checkbox, preview summary, confirm). After a successful
  import: a summary of what was added and links to the dashboard and transactions. Reachable from the desktop
  sidebar and on mobile without adding a sixth bottom tab (the bar is full at 375px) — e.g. from the top bar.
- Module layout: pure, dependency-free code for the formats in `src/lib/csv.ts` (parse / serialise) and
  `src/lib/backup-format.ts` (schema + types); `src/server/export.ts` and `src/server/import.ts` for the
  services (`buildBackup`, `buildTransactionsCsv`, `previewImport`, `runImport`). Each importable format is one
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
// src/lib/constants.ts: IMPORT_MAX_BYTES = 5 MiB, IMPORT_MAX_ROWS = 50 000 (shared by the browser check and the server)

// src/server/export.ts
buildBackup(userId, now?): Backup
buildTransactionsCsv(userId, filters?: Omit<TransactionFilters, 'limit' | 'offset'>): string   // uses filterConditions
// src/server/import.ts
type ImportOptions = { skipDuplicates?: boolean /* default true */ }
type ImportProblem = { line?: number; path?: string; message: string }
type ImportNotice = { code: string; message: string; count?: number }   // non-blocking, e.g. "amounts-rounded"
type ImportPreview = { format: 'backup' | 'csv' | 'spendee' | null; formatLabel: string | null /* "Spendee export" */;
  ok; transactionsToAdd; transfersToAdd; duplicateTransactions; duplicateTransfers;
  walletsToCreate: { name; currency; archived }[]; categoriesToCreate: { name; kind }[];
  problems: ImportProblem[] /* first 50 */; problemCount; notices: ImportNotice[] /* never affect ok */ }
previewImport(userId, fileText, opts?): ImportPreview
runImport(userId, fileText, opts?): ImportPreview & { imported: boolean }   // never throws for bad files

// src/server/import-formats/shared.ts — the seam between formats and the shared planner
type ImportFormat = { id: ImportFormatId; label: string; detect(source: ImportSource): boolean; parse(source: ImportSource): ParsedFile }
type ImportSource = { text /* as uploaded */; body /* BOM stripped, trimStart, non-empty */; csvHeader(): string[] /* lower-cased, lazy */ }
type ParsedFile = { format; walletMatching: 'by-position' | 'merge'; wallets: WalletSpec[]; categories: CategorySpec[];
  entries: EntrySpec[]; transfers: TransferSpec[]; problems: ImportProblem[]; notices: ImportNotice[] }
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
  `runImportAction(formData)` → `ImportActionState = { error?; fileName?; preview?; result? }`). The panel shows
  `formatLabel` and lists `notices` under "Good to know" in the preview (also next to problems) and after a
  successful import. The client keeps the
  chosen `File` in state and sends a fresh `FormData` for each step (a `<form action>` would reset the file input
  after the preview). `experimental.serverActions.bodySizeLimit = "6mb"` (5 MB file + multipart overhead; this
  limit applies to all actions). The 5 MB cap is checked in the browser, again in the action (`file.size`) and in
  the service (UTF-8 byte length), each with the same message.
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
- README documents: quick start with compose, the env vars, running behind a reverse proxy (HTTPS, forwarded
  headers), where the data lives, backup/restore of the SQLite file, and upgrading.

## UI direction

Calm, legible personal-finance UI. Neutral slate surfaces, one accent colour; emerald for income, rose for
expenses, sky for transfers. Amounts right-aligned with `tabular-nums`, always formatted with their currency.
Light and dark via `prefers-color-scheme`. Fully usable at 375px wide. Accessible forms: real `<label>`s,
visible focus rings, errors tied to fields, buttons show a pending state while an action runs.

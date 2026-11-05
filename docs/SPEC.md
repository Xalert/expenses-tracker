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
  The schema supports user-defined categories, but there is **no category-management UI in this version**.
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
  components/ui/                                    # primitives, barrel-exported from "@/components/ui"
  components/transaction-list.tsx                   # shared read-only list of TransactionView rows
  components/shell/  components/brand.tsx           # app shell pieces (nav, icons, sign-out button)
  db/schema.ts  db/index.ts                         # schema, connection, auto-migrate
  lib/auth.ts  lib/money.ts  lib/currencies.ts  lib/dates.ts  lib/errors.ts
  lib/form.ts  lib/password.ts  lib/constants.ts  lib/cn.ts  lib/config.ts (env: ALLOW_REGISTRATION, COOKIE_SECURE)
  app/api/health/route.ts                           # GET /api/health
  server/wallets.ts  server/categories.ts  server/transactions.ts  server/transfers.ts  server/dashboard.ts
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
`receivedAmount`, `fromWalletId`, `toWalletId`, `date`, `note`, `from`, `to`, `month`, `email`, `password`.
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
listCategories(userId, kind?): CategoryView[]                                  // kind asc (expense first), then name
getCategory(userId, categoryId): CategoryView | null
seedDefaultCategories(userId, tx?)                                             // called inside registration's DB transaction; idempotent
DEFAULT_CATEGORIES: Record<'expense' | 'income', string[]>

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
- **App shell** — sidebar on desktop, bottom tab bar on mobile: Dashboard, Transactions, Wallets; user name +
  sign out. A prominent "Add transaction" entry point is reachable from every page.
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
- **Route contract between features** (so pages can link to each other without importing each other's code):
  `/transactions/new?wallet=<id>&kind=expense|income|transfer`, `/transactions/<id>/edit`,
  `/transactions/transfers/<transferId>/edit`, `/transactions?wallet=<id>`, `/wallets/<id>`, `/wallets/new`.
  The three transaction form pages accept `?returnTo=<path>`: after save / delete / cancel they go back there
  (only same-site relative paths starting with a single `/` are honoured; default `/transactions`).

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

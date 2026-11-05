# Decisions and known gaps

A running log of the choices made while building this app, why they were made, and what is knowingly missing or
unverified. `docs/SPEC.md` says *what* the app does; this file says *why*, and what it does not do.

Keep it current: when a product or design decision is made, or something is left unfinished or unchecked, add it
here in the same change. Remove a gap when it is closed (and say so in the commit).

"Decided by" is **owner** (the project owner chose it), **planner** (chosen while planning, not explicitly
confirmed by the owner — the ones most worth a second look), or **built** (settled by the implementation where the
plan left room).

All entries below date from the initial build, 2026-11-05.

---

## Decisions

### Stack and architecture

| Decision | Why | Decided by |
|---|---|---|
| One Next.js app (App Router, TypeScript, Tailwind v4) for UI and server | Simplest to run and deploy: one process, one image | owner |
| SQLite in a single file, via Drizzle + better-sqlite3 | Zero setup, plenty for a personal tracker, trivial to back up | owner |
| No REST API. Server Components read through `src/server/*`; Server Actions mutate | Less code and one place for rules; nothing else consumes an API yet | planner |
| All domain rules live in the service layer; every function takes `userId` first | One enforcement point for ownership and validation, testable without HTTP | planner |
| Migrations apply automatically on first DB access | `npm run dev` and `docker compose up` work with no extra step; upgrades are just a restart | planner |
| Next.js Cache Components switched off | Every page is per-user and reads the session cookie; the feature would force `<Suspense>` around each cookie read for no benefit | built |
| Services are synchronous | better-sqlite3 is synchronous; only password hashing is async | built |
| `build` / `start` scripts set `NODE_ENV=production` inline | A globally exported `NODE_ENV=development` broke `next build` on the development machine | built |
| `images: { unoptimized: true }` | The app serves no optimised images. It was expected to drop `sharp` from the image; it did not, and the setting was kept as harmless | planner |

### Money, wallets, transactions

| Decision | Why | Decided by |
|---|---|---|
| Amounts are integer minor units; decimals come from the currency (JPY 0, EUR 2, KWD 3) | No floating-point drift; correct for every ISO currency | planner |
| Stored amounts are always positive; the kind gives the sign | One representation, no sign bugs | planner |
| No currency conversion anywhere; totals are grouped per currency | No exchange-rate source to depend on, and no invented numbers | planner |
| A transfer is one `transfers` row plus two transaction legs, written atomically | Each wallet's history shows its own side; legs can never drift apart | planner |
| Cross-currency transfers ask for both the amount sent and the amount received | Records what actually happened without needing a rate | planner |
| A wallet's currency cannot change after creation | Its existing amounts would silently change meaning | planner |
| A wallet with transactions can only be archived, not deleted | Deleting it would remove the other side of its transfers and change other wallets' balances | planner |
| Archived wallets are hidden from pickers and dashboard totals; an existing entry may stay on one when edited, new entries are refused | History stays intact and editable without reviving the wallet | built |
| Dates are `YYYY-MM-DD` strings with no time or time zone | An expense belongs to a calendar day; avoids day-shift bugs | planner |
| Transfer legs carry a copy of the transfer's note | So the note search on the transactions list finds transfers | built |
| Another user's row behaves exactly like a missing row | No information leak about what exists | built |

### Accounts and sign-in

| Decision | Why | Decided by |
|---|---|---|
| Email + password with scrypt, database-backed sessions (30 days), only a hash of the cookie token stored | No external auth provider to configure when self-hosting | planner |
| Registration is open by default, closable with `ALLOW_REGISTRATION=false` | Easy first run; an internet-facing instance can be closed once accounts exist | planner |
| `COOKIE_SECURE=auto` (secure only when the request arrived over HTTPS) | Homelabs often serve plain HTTP on the LAN; a hard-coded `Secure` cookie silently breaks sign-in there | planner |
| Login failures give one generic message; registration does say when an email is taken | Standard trade-off for open registration | built |

### Categories

| Decision | Why | Decided by |
|---|---|---|
| Categories are per user, seeded with eight defaults that get no special treatment | The owner wanted the defaults as a starting point and full control afterwards | owner |
| Removing a category that has transactions moves them to a chosen replacement of the same kind, then deletes it | Chosen over archiving, blocking, or asking each time: the category is truly gone and there is no hidden state | owner |
| Names are unique per user and kind ignoring case, enforced in the service | Avoids "food" next to "Food" without a schema migration | planner |
| A category's kind (expense / income) is fixed at creation | Changing it would invalidate its transactions | planner |
| All categories of a kind may be removed; the transaction form then shows an empty state | "Add or remove as they wish"; no artificial minimum | planner |
| Rename and the replacement picker are inline, with no modal library | Works at phone width, keyboard-usable, no new dependency | built |

### Import and export

| Decision | Why | Decided by |
|---|---|---|
| Scope is data portability (backup, moving instances, spreadsheets), not arbitrary bank statements | "Import/export" was read this way; bank formats need column mapping, a much larger feature | planner |
| Two own formats: a lossless JSON backup and a one-row-per-entry transactions CSV | The backup moves a whole account; the CSV is for spreadsheets | planner |
| Import only ever adds; it never deletes or overwrites | An import can never destroy data, so it is safe to try | planner |
| Wallets match on name + currency, categories on kind + name, ignoring case; missing ones are created | Lets a file land in an existing account without duplicating its structure | planner |
| Duplicates are skipped as a multiset (3 in the file, 1 already there → 2 added) | Re-importing a file adds nothing, yet genuinely repeated purchases are kept | planner |
| Preview first, then confirm; any problem blocks the whole import; the write is one DB transaction | No half-imported files; the user sees exactly what will happen | planner |
| Limits of 5 MB and 50,000 rows; the Server Action body limit is raised to 6 MB app-wide | Generous for personal data while bounding untrusted input; the limit cannot be set per route | planner / built |
| An import never adds a new entry to an already-archived wallet; a backup may restore a wallet as archived with its history | Matches what the services allow; a restore is not new activity | built |
| Two wallets with the same name and currency: a backup keeps them apart; a CSV sends rows to the active one (or the oldest) | A CSV has nothing but the name to go on | built |
| Text cells starting with `=`, `+`, `-`, `@` are prefixed with `'` on export and restored on import | Prevents spreadsheet formula injection while keeping the round trip exact | planner |
| CSV import accepts `;` / `,` / tab, decimal commas, and `YYYY-MM-DD` or `DD.MM.YYYY`; slashed dates are rejected | Tolerates what spreadsheets save; slashes are ambiguous between day-first and month-first | planner |
| Other apps' exports are built-in provider formats (one module each), not a manual conversion step and not a column-mapping screen | A converter helps one person once; a built-in format helps every self-hoster. Column mapping is deferred until more providers are needed | owner |
| The app's own CSV rules are not loosened to fit a provider | Keeps the native export → import round trip exact | planner |
| Spendee: amounts with more decimals than the currency are rounded half away from zero, with a notice | Spendee exports converted foreign purchases with up to 7 decimals; rejecting them would block the file | owner |
| Spendee: the time of day is dropped; name columns are ignored; a sign that contradicts the type, a zero amount, or any type other than expense/income is a blocking problem | The app stores dates only; anything ambiguous is reported rather than guessed | planner |

### Deployment

| Decision | Why | Decided by |
|---|---|---|
| Docker is the deployment target; no dependency on Vercel or any hosted platform | The owner runs a homelab and wants anyone to be able to self-host | owner |
| Image on `node:24-bookworm-slim`, three stages, runs as the non-root `node` user (uid 1000), data on a `/data` volume | glibc base so the native SQLite module's prebuilt binaries work on amd64 and arm64; least privilege | planner |
| `npm ci --ignore-scripts` in the image | The slim image has no compiler toolchain, and the native module ships prebuilt Linux binaries | built |
| Health check uses Node's `fetch` against `/api/health` | No curl or wget needed in the image | built |
| All runtime configuration is environment variables | Standard for containers; nothing to bake into the image | planner |

### Interface

| Decision | Why | Decided by |
|---|---|---|
| Sidebar on desktop, bottom tab bar on mobile | Thumb-reachable on phones | planner |
| The mobile bottom bar stops at five entries; "Import & export" lives in the top bar | Five entries are already tight at 375px | built |
| Archive and delete are on each wallet's own page, not in the wallet list | Keeps destructive actions one step away from a casual tap | built |
| The currency picker is a native `<select>` with common currencies first | Works everywhere with no dependency; typing a code jumps to it | built |
| Deleting uses the browser's native confirmation dialog | No modal library | built |

### Process

| Decision | Why | Decided by |
|---|---|---|
| The main session plans and reviews; implementation is delegated to Opus agents working from `docs/SPEC.md` | The owner asked for this split | owner |
| Tests use synthetic data only; the owner's real Spendee export was never copied into the repo, tests, or a database on disk | It is personal financial data | planner |

---

## Known gaps

### Security and operations

- **No login rate limiting.** An internet-facing instance should sit behind something that throttles sign-in
  attempts.
- **No password change, password reset, email change or account deletion.** A forgotten password currently means
  editing the database by hand.
- **No session management.** There is no "sign out everywhere", and expired sessions are only removed when their
  cookie is next presented.
- **A reverse proxy must preserve the `Host` header** (or send `X-Forwarded-Host`); otherwise sign-in fails with a
  500. Documented in the README, not detected or explained by the app.
- **A reverse proxy's upload limit must allow 6 MB** for imports (nginx defaults to 1 MB).
- **No prebuilt image and no CI.** Self-hosters build from source; nothing runs the tests automatically.
- **`build` / `start` scripts do not work in Windows `cmd`** because of the inline `NODE_ENV`. Docker users are
  unaffected.

### Features not built

- **No exchange rates or converted totals.**
- **No bank-statement import or column-mapping screen.** Only the app's own formats and Spendee are recognised.
- **Spendee transfers are not supported**: they are reported as problem lines and block that file. Other Spendee
  export variants (other locales or date formats, several wallets) are untested.
- **A category's kind cannot be changed**, and categories cannot be archived.
- **A CSV cannot carry initial balances or archived state**; wallets it creates start at zero.

### Rough edges

- "Manage categories" in the transaction form navigates away and loses what was typed.
- Switching the form between Transfer and Expense/Income clears a typed amount.
- If a category is the only one of its kind and has transactions, another must be created before it can be removed.
- The currency picker is not searchable.
- Submitting the transaction filters leaves empty parameters in the URL (harmless).
- The name-length message says "under 40 characters" although exactly 40 is allowed (same wording for wallet and
  user names).
- An unterminated quote in a CSV stops parsing at that line, so later problems are only reported once it is fixed.
- A wallet restored as archived from a backup is marked archived as of the import, not its original date.
- If the account changes between an import's preview and its confirmation, the confirmed numbers can differ from
  the preview (the confirmation re-validates and reports what it actually did).
- A file over 6 MB that bypasses the browser's size check gets the framework's generic error instead of the app's
  message.
- The mobile tab bar is tight at 375px: "Transactions" uses 69 of its 75 pixels.
- `sharp` is still present in the Docker image although the image optimiser is off.

### Not verified

- **Bind mounts on a real Linux host.** The "folder must be owned by uid 1000" failure and its fixes were only
  simulated on Docker Desktop.
- **`COOKIE_SECURE=true` over plain HTTP** was checked with curl, not a browser.
- **The amd64 image** was built and run under emulation only.
- **No screen-reader pass.** Focus handling and labels were checked through the DOM.
- **Native dialogs were not exercised**: the confirmation dialog was stubbed, and test files were injected by
  script rather than chosen in a real file picker; downloads were fetched by script.
- **No real spreadsheet application** was used to open or re-save an exported CSV.
- **No automated end-to-end tests.** Browser checks were done by hand during the build; the automated suite covers
  services, parsers and a few rendered components.
- **A real import of the owner's Spendee file** was run only against an in-memory database (3,227 rows, balance
  matching an independent calculation); it has not been imported into a real instance.

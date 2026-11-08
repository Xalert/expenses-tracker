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
| Password sign-in with scrypt (originally by email; now by user ID or email, below), database-backed sessions (30 days), only a hash of the cookie token stored | No external auth provider to configure when self-hosting | planner |
| Registration is open by default, closable with `ALLOW_REGISTRATION=false` | Easy first run; an internet-facing instance can be closed once accounts exist | planner |
| `COOKIE_SECURE=auto` (secure only when the request arrived over HTTPS) | Homelabs often serve plain HTTP on the LAN; a hard-coded `Secure` cookie silently breaks sign-in there | planner |
| Login failures give one generic message; registration does say when a user ID or email is taken | Standard trade-off for open registration | built |
| Accounts are identified by a user ID; email, first name and surname are optional | The owner asked for it: a self-hosted tracker should not need an email address | owner |
| "User ID" is a name the user chooses (3–32 of `a–z 0–9 . _ -`, case-insensitive), not the numeric database id | Memorable, and it does not reveal how many accounts exist. **This is the planner's reading of "log in with their user id" — confirm** | planner |
| One sign-in field takes a user ID or an email; a user ID can never contain `@` | Existing email sign-ins keep working, and the two can never be confused | planner |
| Existing accounts get a user ID derived from their email's local part, and their name is split at the first space | Nobody is locked out by the upgrade, and nothing has to be entered again | planner |
| Migrations run with foreign keys switched off outside the transaction, are followed by a foreign-key check, and a copy of the database is written before pending migrations touch existing data | Making `email` nullable rebuilds the `users` table in SQLite; done naively, dropping the old table cascade-deletes every user's data | planner |
| Measured hazard: with foreign keys on, the rebuild deletes every wallet, category and session of a database with no transactions; with any transaction it fails on `transactions.wallet_id` (RESTRICT) and rolls back, so the app could not start | Found by running drizzle's migrator on populated 0000 databases (`tests/migrations.test.ts`) rather than assuming; either outcome rules out the naive path | built |
| Derived user IDs: leading `.`/`_`/`-` are dropped, the result is cut to 32, fewer than 3 characters → `user<id>`; on a collision the account with the lower id keeps the plain value; a suffixed value that hits another plain one → `user<id>`; anything beyond that fails the migration (rolled back) | The spec left "nothing valid", length and which side gets the suffix open; this always yields valid IDs and never guesses silently | built |
| Emails keep their stored case through the migration; sign-in and the duplicate check compare `lower(email)` / `lower(username)` | The spec says emails are unchanged; comparing lowercased makes a legacy mixed-case email still work and still block duplicates | built |
| `PRAGMA foreign_key_check` runs on every start, not only after migrating | Cheap at this app's size, and a dangling row is worth stopping for whenever it appears | built |
| The pre-migration copy is made with `VACUUM INTO` (synchronous, includes WAL content, writes a non-WAL file), is never overwritten (a second one gets a timestamp) and is not deleted automatically | Startup is synchronous; the copy must be self-contained and must survive a retry after a failed upgrade | built |
| Uniqueness of user ID and email is checked before hashing the password as well as inside the insert transaction | A taken user ID is reported without the scrypt delay; the second check closes the race | built |
| The dashboard greeting uses the display name (it used the first word of the name) | Spec: display name everywhere; with optional names the first word is no longer meaningful | built |
| Mobile top bar shows the display name with the user ID under it (when they differ); the sidebar shows user ID and email on separate lines; the user ID line is left out when it already is the display name | Migrated users learn their user ID from the shell; the top bar has room for two short lines | built |
| Demo seed user: user ID `demo`, email kept, first/last name "Demo" / "User"; an existing demo user is found by user ID or email and the login printed with its actual user ID | Idempotent on databases seeded before user IDs (the migration derives `demo` for it, or a suffixed one) | built |

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
| Several files can be selected and are imported as one all-or-nothing import | Spendee's current export is one file per wallet, and a transfer's two rows live in different files | owner |
| Spendee transfers are rebuilt by pairing an outgoing and an incoming row: different wallet, same note, within 10 seconds, same amount when the currency is the same | That is how the owner's real export writes them (24 of 24 paired uniquely, at most 2 seconds apart); anything ambiguous is reported, not guessed | planner |
| An unpaired Spendee transfer row blocks the import by default, with an opt-in to import such rows as income / expense in a `Transfer` category | Usually it means a wallet's file was left out; the opt-in avoids a dead end when the other wallet no longer exists | planner |
| Spendee timestamps that carry a UTC offset are converted to the importing browser's time zone to pick the date | Spendee exports UTC; taking the UTC date would put late-evening entries on the wrong day (and sometimes the wrong month) | planner |
| Spendee labels are appended to the note | The app has no labels; this keeps the information and makes it searchable instead of dropping it silently | planner |
| A backup cannot be combined with other files in one import | Its wallets are identified by position in the file, which cannot be merged with other sources | planner |
| `previewImport` / `runImport` take either one file's text (as before) or a list of `{ name, text }`; the existing tests were left unchanged | No mechanical migration of ~60 call sites; one file and a one-element list behave the same | built |
| Spendee transfers are paired on the `Note` cell without labels; the transfer gets the outgoing row's labels, or the incoming row's when the outgoing has none | Labels are per row in Spendee and may differ between the two sides; pairing should not fail over them | built |
| Two candidates at the same distance are only paired when the competing rows are identical (wallet, amount, time, note) — then the result is the same either way; otherwise every row of that group is one blocking problem, which the unpaired option does not cover | "Never guess", without failing on genuinely repeated transfers | built |
| Timestamps without an offset (older dialect) are still used for pairing, read as written; a bare date counts as midnight; `Z` and fractional seconds are accepted | One rule for both dialects; the older export never had transfer rows | built |
| Spendee notices (time zone, labels, rounding, unpaired rows) are counted over the whole selection, not per file; the time-zone notice also says how many entries changed day | Eight near-identical per-file notices would bury the information | built |
| A file selected twice is detected by identical text and listed as "same as …"; a backup in a selection with other files is refused before any file is parsed | Cheap and exact; parsing the rest would only add noise to a refusal | built |
| Toggling the unpaired-transfers option re-runs the preview at once; choosing other files resets it to off | The option changes what is imported, so the preview must always match it | built |

### Statement importer (claude.ai Artifact)

| Decision | Why | Decided by |
|---|---|---|
| Bank statements are turned into the app's CSV by a separate claude.ai Artifact page, not by the app itself | The owner asked for an artifact; it keeps the model calls on the viewer's own Claude account and off the self-hosted server | owner |
| Extraction and category suggestions use Haiku (`claude-haiku-5-5`) through the Artifact `sample` capability | The owner asked for Haiku; the task is extraction and classification, where the quick tier is enough | owner |
| Remembered choices live in the Artifact's per-user private `db` storage, keyed by statement account signature and by a normalised merchant key; nothing from a statement is stored | Memory must survive visits and stay private; statements are personal data | planner |
| A category rule is pre-selected after one confirmation and applied silently after two | "Remember once you guide it once or twice", with a glance at the first repeat as a safety net | owner / planner |
| Rules are applied before Haiku is asked; Haiku only sees rows without a rule, with existing rules as examples | Cheaper and deterministic: the model cannot override what the user already decided | planner |
| Mirror rows of the same transfer across two statements are paired automatically (same amount and currency, opposite direction, different wallets, within 3 days) and one side is excluded | The app's transfer import creates both legs itself | planner |
| Output is the app's native transactions CSV, downloaded by the viewer and imported at /data by hand | The Artifact cannot reach a self-hosted server; the app's duplicate skipping makes overlapping statements safe | planner |
| Memory lives at `data/users/<id>/config`, `…/memory/accounts/a-<hash>` and `…/memory/rules/m-<key>`; db rules lock the root (`owner`) and open `data/users/{self}` at `interact` | The planned `data/users/<id>/accounts/<sig>` is a collection path (odd segment count); nothing shared is ever needed, so nobody may write outside their own subtree | built |
| The account signature is stored only as a 53-bit hash, with a label of bank name + last four characters | Remembering a wallet per account must not put the account number in the store | built |
| Merchant key: accents folded, apostrophes dropped, other non-letters become spaces, first three words; the db id escapes non a–z characters | `McDonald's` and `UBER *TRIP` / `UBER*TRIP` should match; db path segments only allow a small character set | built |
| A rule gains at most one confirmation per page visit; a different choice resets it to 1 | Five LIDL rows accepted at once are one decision, not five; the user's change always wins | built |
| Exporting counts as accepting the rows still marked "remembered once"; suggested rows only become memory when accepted | The user kept a choice they made before; an unreviewed model guess should not turn into a silent rule | built |
| A rule applies only to rows of its direction (expense → out, income → in; transfers remember their direction) | A refund from a shop must not inherit the shop's expense category | built |
| The wallet picker on a statement lists only wallets in the statement's currency; "New wallet…" fixes the currency | The CSV carries amounts in the wallet's currency and there is no conversion | built |
| Rows can only be expense or transfer (out) and income or transfer (in) | The app has no negative expenses; a refund is income | built |
| Category and transfer wallet share one table column | Keeps the table narrower; a row needs one or the other | built |
| Categorisation waits until every statement is read, then asks once per merchant + direction | One call for the whole batch, and the same merchant is never asked twice | built |
| Splitting a pair blocks it from re-forming until the user picks the transfer wallet on one of its rows | "Not a transfer" must stick when pairing re-runs, but a deliberate transfer should still find its mirror | built |
| A manual transfer to a wallet in another currency asks for the other side's amount | The app requires both amounts for cross-currency transfers | built |
| pdf.js 3.11.174 (cdnjs) runs with its "fake worker" on the main thread; scanned pages are rendered with `intent: "print"` | Artifact frames cannot start a Worker from a CDN script; display rendering waits on `requestAnimationFrame`, which never fires in a hidden tab | built |
| A text file that is not valid UTF-8 is decoded as Windows-1250 | Romanian banks export in that code page; UTF-8 files are unaffected | built |
| `prompt_too_large` on a text piece splits it and asks again; nothing else is retried by the page | The split is a different, smaller request, which is what the error asks for | built |
| The tracker's "Wallets & categories" export is a separate small file (`GET /api/export/context`) rather than reusing the backup | The artifact only needs names, currencies and kinds; handing a claude.ai page the full history to get them is more than it needs | owner / planner |
| The context file lists wallets and categories in creation order, like the backup, with archived wallets included and flagged | One rule for both exports; the reader decides what to drop (the artifact leaves archived wallets out) | built |
| "Copy" on /data starts the clipboard write inside the click with a `ClipboardItem` whose text is the pending fetch, then falls back to `writeText`, then to a selected read-only text box | Safari drops the click's permission across an `await fetch`; the text box always works | built |
| The artifact refuses a context file whose `version` is not 1, but reads any tracker JSON with `wallets[]` and `categories[]` as a backup (as before) | A newer context format may change meaning; the backup reader only ever looked at those two lists | built |
| The artifact's config document keeps a `loaded` note `{ source, loadedAt, wallets, categories }` and the panel's status line shows the counts as loaded, not the current list lengths | "Loaded N … from …, date" should stay true after the user types or removes an entry | built |
| The artifact's preview also names the current wallets and categories the file lacks, which "Use these" removes | "Replaces the lists" is otherwise a silent deletion of entries typed by hand | built |
| Wallet and category names read from files or memory must be strings (a number is no longer turned into a name) | Defensive shape checks asked for by the plan; nothing the tracker or the page writes uses numbers there | built |
| `tools/**` is excluded from eslint | The artifact is plain browser JS outside the Next.js app; its contract is checked by the harness and by `tests/statement-importer-csv.test.ts` | built |

### Deployment

| Decision | Why | Decided by |
|---|---|---|
| Docker is the deployment target; no dependency on Vercel or any hosted platform | The owner runs a homelab and wants anyone to be able to self-host | owner |
| Image on `node:24-bookworm-slim`, three stages, runs as the non-root `node` user (uid 1000), data on a `/data` volume | glibc base so the native SQLite module's prebuilt binaries work on amd64 and arm64; least privilege | planner |
| `npm ci --ignore-scripts` in the image | The slim image has no compiler toolchain, and the native module ships prebuilt Linux binaries | built |
| Health check uses Node's `fetch` against `/api/health` | No curl or wget needed in the image | built |
| All runtime configuration is environment variables | Standard for containers; nothing to bake into the image | planner |
| In development, the machine's own LAN addresses (plus `ALLOWED_DEV_ORIGINS`) may load the dev server's scripts | Next.js allows only `localhost` by default; opened at a LAN address the app rendered but nothing client-side worked (the owner hit this: "Preview import" could not be pressed). Development only — production builds are unaffected | planner |

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
| Tests use synthetic data only; checks against the owner's real Spendee exports during the build ran against an in-memory database, and nothing from them was copied into the repo, tests or fixtures | It is personal financial data | planner |

---

## Known gaps

### Security and operations

- **No login rate limiting.** An internet-facing instance should sit behind something that throttles sign-in
  attempts.
- **No password change, password reset or account deletion.** A forgotten password currently means editing the
  database by hand.
- **No profile screen: user ID, email and names cannot be changed after registration** (nor can an email be added
  later to an account created without one).
- **Migrated accounts are not told their new user ID** other than by the shell after signing in with their email;
  the README shows how an administrator can list them.
- **Pre-migration copies are never cleaned up**; each one is a full copy of the database in the `/data` volume.
- **A migration whose derived user IDs still collide after the `user<id>` fallback** (only possible with contrived
  emails) stops startup; it is rolled back and needs a manual fix of the colliding email before upgrading.
- **Sign-in lookups compare `lower(...)`** and so do not use the unique indexes (a scan of `users`); irrelevant at
  household scale.
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
- **No bank-statement import or column-mapping screen in the app.** Only the app's own formats and Spendee are
  recognised; bank statements go through the separate Statement Importer artifact (`docs/STATEMENT-IMPORTER.md`).
- **Spendee variants beyond the two seen are untested** (other locales or date formats, transfers to a wallet
  outside Spendee, the older single-file export containing transfers). There is no zip upload: Spendee's
  per-wallet files have to be selected together.
- **A transfer row whose partner row has its own problem** is also reported as unpaired, so the problem list can
  show two entries for one mistake.
- **Importing the same Spendee files from a browser in another time zone** can shift entries near midnight to a
  different date, so they would not be recognised as duplicates.
- **A category's kind cannot be changed**, and categories cannot be archived.
- **A CSV cannot carry initial balances or archived state**; wallets it creates start at zero.

### Rough edges

- "Manage categories" in the transaction form navigates away and loses what was typed.
- Switching the form between Transfer and Expense/Income clears a typed amount.
- If a category is the only one of its kind and has transactions, another must be created before it can be removed.
- The currency picker is not searchable.
- Submitting the transaction filters leaves empty parameters in the URL (harmless).
- The name-length message says "under 40 characters" although exactly 40 is allowed (wallet and category names;
  first name / surname now say "80 characters or fewer").
- An unterminated quote in a CSV stops parsing at that line, so later problems are only reported once it is fixed.
- A wallet restored as archived from a backup is marked archived as of the import, not its original date.
- If the account changes between an import's preview and its confirmation, the confirmed numbers can differ from
  the preview (the confirmation re-validates and reports what it actually did).
- A file over 6 MB that bypasses the browser's size check gets the framework's generic error instead of the app's
  message.
- The mobile tab bar is tight at 375px: "Transactions" uses 69 of its 75 pixels.
- `sharp` is still present in the Docker image although the image optimiser is off.

### Statement importer gaps

- **Account signatures can collide** when the only identifier is a card's last four digits (two cards ending in the
  same digits at different banks share a remembered wallet).
- **Merchant keys are coarse**: a generic merchant such as "Transfer intern" shares one rule for every internal
  transfer, so its remembered wallet can be wrong for some rows.
- **Cross-currency transfers between two statements are not paired**; mark one side as a transfer (entering the
  other amount) and untick the other.
- **The CSV is only as good as the extraction.** Haiku can misread amounts or dates; the page validates the shape,
  not the truth. Totals per wallet are shown for a check against the statement.
- A PDF page with little text is treated as a scan, so a mostly-blank text page is sent as an image.
- The review table is not virtualised; a few thousand rows re-render slowly on every change.
- Memory's "last used" is only written on export, and "Forget everything" deletes documents one write at a time.
- Loading a context file **replaces** the lists; there is no merge option (typed-in entries the file lacks are
  named in the preview, then removed). The app itself cannot import a context file (the zod schema exists for
  when it does).

### Not verified

- **Bind mounts on a real Linux host.** The "folder must be owned by uid 1000" failure and its fixes were only
  simulated on Docker Desktop.
- **`COOKIE_SECURE=true` over plain HTTP** was checked with curl, not a browser.
- **The amd64 image** was built and run under emulation only.
- **No screen-reader pass.** Focus handling and labels were checked through the DOM.
- **Native dialogs were not exercised**: the confirmation dialog was stubbed, and test files were injected by
  script rather than chosen in a real file picker; downloads were fetched by script.
- **No real spreadsheet application** was used to open or re-save an exported CSV.
- **The /data "Copy" button never reached a real clipboard**: in the in-app browser pane the clipboard was refused
  and the selectable text box appeared; the "Copied" path was checked with a stubbed `navigator.clipboard`. Real
  drag-and-drop of a file onto the artifact's panel was simulated with a synthetic `drop` event in the harness.
- **The 0001 migration on the owner's real database** was not run by the implementer (it is not theirs to touch);
  it is covered by synthetic populated databases in `tests/migrations.test.ts` and a browser upgrade check on a
  scratch database.
- **The Statement Importer has not run on claude.ai.** Everything was exercised against `dev/mock-claude.js`:
  the real `sample` (Haiku's actual answers, consent, rate limits, image limits), `db` (rules, snapshots, write
  errors), `user` and `downloads` were not. Real bank statements were never used (fixtures are synthetic), and
  the clipboard path was only seen failing over to the text box.
- **No automated end-to-end tests.** Browser checks were done by hand during the build; the automated suite covers
  services, parsers and a few rendered components.
- **A real import of the owner's Spendee files** was run only against an in-memory database: the older single file
  (3,227 rows, balance matching an independent calculation) and the current per-wallet export (8 files, 382 rows,
  24 transfers paired, per-wallet net movement matching the planner's independent analysis, re-import adds
  nothing). Neither has been imported into a real instance through the UI.
- **Multi-file selection was exercised with files injected by script** (`DataTransfer`), not picked in a real
  file dialog; the 6 MB request limit with many small files (multipart overhead per file) was not measured.

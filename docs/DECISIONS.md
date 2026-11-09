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
| No currency conversion, except the Overview "All in <currency>" view; other pages group totals per currency | The owner asked for one figure over all wallets, on the Overview; the other pages stay exact | owner |
| The Overview month figures convert each day at that day's ECB rate; the Wallets total converts today's balances at the latest rate | A past expense is worth what it was worth that day; a balance is worth what it is worth now | planner |
| One `?view=` for the whole Overview, its switch next to the currency switch | The chart, the cards and the Wallets total then always agree on what they include | planner |
| The converted total uses ECB reference rates from Frankfurter (`api.frankfurter.dev`), cached in memory, with `EXCHANGE_RATES=false` to turn it off | Free, no API key, no account for self-hosters; one request per 6 h for the whole instance; a self-hoster can keep the server offline | planner |
| "All in EUR" (converted, default) and "EUR only" are a `?view=` link switch | The owner asked for both; links keep it working without JavaScript and in the URL like `?currency=` | planner |
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
| A prebuilt multi-arch image on GitHub Container Registry, published by GitHub Actions, is the default way to deploy; building from source stays supported | "It should be easy to deploy with docker": downloading one Compose file beats cloning and a several-minute build, and arm64 users (Raspberry Pi) get an image without building on the device. GHCR needs no extra account or secret (`GITHUB_TOKEN`) | owner asked for an easier Docker deploy; registry chosen by planner |
| `latest` follows `main`; releases come from `vX.Y.Z` tags | The owner deploys `main` and has no release process yet; self-hosters who want control pin `EXPENSES_TRACKER_VERSION` | planner |
| arm64 is built under QEMU on one runner, not on a native arm64 runner | Works for private and public repositories alike; slower (the `next build` under emulation), but only CI time | planner |
| `deploy/compose.yaml` is configured from `.env`, not edited, and shares the project name `expenses-tracker` | Upgrading can re-download the file without losing settings; moving between source build and prebuilt keeps the same volume | planner |
| In development, the machine's own LAN addresses (plus `ALLOWED_DEV_ORIGINS`) may load the dev server's scripts | Next.js allows only `localhost` by default; opened at a LAN address the app rendered but nothing client-side worked (the owner hit this: "Preview import" could not be pressed). Development only — production builds are unaffected | planner |

### Development tools and documentation

Added 2026-11-08.

| Decision | Why | Decided by |
|---|---|---|
| `npm run db:reset -- --demo \| --clean` deletes every row (keeping the file and the migrations table) instead of deleting the database file | A running dev server holds the file open and keeps working; migrations are not re-run | planner |
| The reset writes `<file>.before-reset-<YYYYMMDD-HHMMSS>.bak` of a non-empty database first (`--no-backup` skips it) and refuses with `NODE_ENV=production` | A reset is one typo away from losing real data; the command is a development tool | planner |
| **`--yes` is honoured only with an explicit `DATABASE_URL` on the command; the default `data/app.db` always asks, and the answer must be the word `reset`** (not `y`). No terminal and no usable `--yes` → refuse | An agent wiped the developer's real database through a broken shell chain: a failed step before the command left `DATABASE_URL` unset, so the default file became the target. A `--yes` that reaches the default file by accident must not be able to wipe it | planner |
| The dev server prints `[demo] Sign in with user ID demo / password demo-password (if unchanged)` once, when it opens the database and a `demo` user exists; never in production. The seed and reset print the same line | The demo login was only in the README; this puts it where the developer is looking. The database opens lazily, so the line appears on the first request rather than at boot | planner (line), built (timing) |
| Demo mode runs on its own file: `npm run dev:demo` seeds `data/demo.db` if needed and serves it; `npm run demo:reset` restores it without a prompt (`--yes` is allowed because `DATABASE_URL` is set inside the script) | Demo mode runs on its own file so it can never replace real data | planner |
| README cut to a five-minute path (run, debug, scripts, compose quick start, env vars, pointers); long-form operations moved to `docs/SELF-HOSTING.md` | The README had grown to 368 lines, mostly operations detail most readers never need | planner |
| In "Run it" and "Debugging", every command is its own one-line `bash` code block with the explanation in a sentence above, no trailing `# comments` | The owner reads the README in an app that puts a Run button on each single-line block; multi-line blocks with comments render badly there. This took the README to about 170 lines instead of the ~120 aimed for | owner (format), built (length) |
| The env var table lives only in the README; `docs/SELF-HOSTING.md` links to it | One table cannot drift from another | built |
| The user-facing import details (Spendee pairing, time zones, labels, rounding, limits) are no longer repeated in the README; it links to `docs/SPEC.md` → Import / export, which already held every one of them | Avoids a third copy; the nginx upload-limit note moved to the reverse-proxy section of `docs/SELF-HOSTING.md` | built |

### Interface

| Decision | Why | Decided by |
|---|---|---|
| ~~Sidebar on desktop, bottom tab bar on mobile~~ (superseded by the redesign's top menu, built in step 1) | Thumb-reachable on phones | planner |
| ~~The mobile bottom bar stops at five entries; "Import & export" lives in the top bar~~ (superseded, as above) | Five entries are already tight at 375px | built |
| Archive and delete are on each wallet's own page, not in the wallet list | Keeps destructive actions one step away from a casual tap | built |
| The currency picker is a native `<select>` with common currencies first | Works everywhere with no dependency; typing a code jumps to it | built |
| Transactions: ‹ › beside the Month chip, month links under the list, `[` / `]` keys; next is not capped; "This month" link + `T` key back to the present | The popover hid the stepper. `T` as in calendar apps ("today"); the link shows only away from the current month, as on the Overview. Keys `[` / `]` rather than arrows: arrow keys move focus in listboxes and grids and scroll the page. Next is not capped because future-dated entries exist | owner |
| Deleting uses the browser's native confirmation dialog | No modal library | built |
| Date and month pickers are hand-built (`DatePicker`, `MonthGrid`, `Popover` in `components/ui`, pure helpers in `lib/calendar.ts`) instead of a picker library | The native `<input type="date">` looks different in every browser and clashes with the theme; the project has no UI dependencies, and the pickers need little: one popover, two grids, the theme tokens | planner |
| `DatePicker` is a button plus a hidden `YYYY-MM-DD` input, not a typed text field | Forms post exactly what the native input posted, so no action, schema or service changed, and there is no date-parsing of typed text. The cost is that a date cannot be typed, so the grid is fully keyboard-operable instead (arrows, Home/End, PageUp/PageDown, Shift+PageUp/PageDown, Enter/Space, Escape) | planner |
| The trigger button carries `role="combobox"` (with `aria-haspopup="dialog"`) | A plain `button` role does not support `aria-invalid` / `aria-required` (eslint's jsx-a11y flags it); a select-only combobox does, and its text is read as its value, so `<Field>` errors attach the same way as for `<Input>` | built |
| Calendar weeks start on Monday; dates show en-GB ("5 Nov 2026", "Thursday 5 November 2026") | The app formats every date en-GB already; no locale setting exists to follow | planner |
| An empty optional `DatePicker` (`allowEmpty`, the transaction filters — that form was replaced by the chip row in redesign step 4; `allowEmpty` is kept) renders no hidden input | The filter form is a GET `next/form`; an empty field would otherwise add `from=` to the URL. `parseListParams` would ignore it anyway, so the "N active" count and the Export CSV link are unaffected either way | built |
| The dashboard month label opens a month picker; "This month" appears only away from the current month | Going back a year took twelve clicks; the ‹ › links stay plain links so they work without JS | planner |
| Popovers have no portal; they sit under their trigger and shift sideways to stay inside the viewport | Small and enough for these two uses; no horizontal scroll at 375px | built |

### Redesign (decided 2026-11-08; being built in the steps of SPEC "Redesign build order", step 1 done)

Chosen on the Design canvas https://claude.ai/artifact/HYiCKKzqCayiQHUjZQc3gP after three rounds of options. The
first two rows of "Interface" above (sidebar + bottom tab bar, the five-entry bar) are superseded once it is built.

| Decision | Why | Decided by |
|---|---|---|
| A real layout change, not a re-theme | The owner rejected a first pass that only re-coloured the existing layout ("just a new theme") | owner |
| The "Midnight" layout: top menu, per-day bars + running total on Overview / Transactions / wallet pages, insight cards, day-grouped lists, floating Add | Picked from fifteen directions (statement tables, three-pane workspace, calendar grid, bento tiles, wallet columns and mixes of them); the owner liked this one's dashboard, transaction list and top menu | owner |
| Light theme "Sand & Terracotta", dark theme "Graphite & Coral", switched by `prefers-color-scheme` | Picked from five palettes on the same layout | owner |
| Accent `#BC522C` and income-soft `#EDF4EE` instead of the canvas's `#C2562F` / `#E7F0E8` | The canvas values gave 4.50:1 and 4.47:1; the adjusted ones pass 4.5:1 and look the same | planner |
| Plus Jakarta Sans through `next/font/google` | The font of the chosen design; `next/font` downloads it at build time and serves it from the app, so a self-hosted instance never calls Google at runtime (the Docker build already needs network for npm) | planner |
| No sidebar and no bottom tab bar; on phones the menu is a horizontally scrolling row of pills under the top bar | Matches the chosen design; removes the 375px squeeze of the five-entry bar and gives Import & export a normal menu place | planner |
| Add entry, New wallet and Edit wallet open as dialogs via parallel + intercepting routes; their URLs still render full pages | Matches in-place editing; keeping the URLs keeps reloads, new tabs, `?wallet=&kind=` links and no-JS use working | planner |
| Transactions are edited in place (a row opens into a form); the edit pages stay for direct links and no-JS | The owner picked the design whose rows open in place over side panels | owner |
| /transactions shows the current month by default ("All time" in the month chip) | The day strip and day groups need a month; a long all-time list was rarely what was wanted | planner |
| Charts show one currency at a time with a currency switch; the default is the month's busiest currency | There is no conversion; mixing currencies on one axis would be meaningless | planner |
| Expense amounts in lists use the text colour, not red; a coloured dot marks the kind | A list of expenses all in red reads as alarm; income stays green | planner |
| Charts are hand-built (CSS bars + inline SVG lines), no chart library | Three small chart shapes; the project has no UI dependencies | planner |
| "No-spend days" and "pace vs last month" are new figures on Overview | Part of the chosen design; computed from existing data, no schema change | owner |
| Wallet pages show the balance after each day; the wallet list shows each wallet's month change and a balance line | Part of the chosen design; computed from existing data | owner |
| Unarchive is offered in the wallet list's Archived section | It is not destructive, so the "destructive actions one step away" rule does not apply | planner |
| The top bar is not sticky | On phones it is two rows (about 110px); pinning it would cost that much of every screen. The Add button is the one control that stays in reach | built (step 1) |
| The menu highlights the page behind a dialog, not the URL (`useSelectedLayoutSegment()` of the `children` slot) | With `/transactions/new` open over Wallets, highlighting Transactions would point at a page that is not on screen | built (step 1) |
| A page changes the Add target by rendering its own `<AddButton href>`; the shell's default hides itself through a CSS `:has()` rule, and the N shortcut follows whichever button is shown | Keeps the layout a Server Component with no per-page context or client state, works without JavaScript, and the shortcut can never disagree with the visible button | built (step 1) |
| The `@modal` slot has a null `page.tsx` at every non-dialog `(app)` route (a test enforces it), and `Dialog` also hides itself once the URL path leaves the one it opened at | A parallel slot keeps stale content on soft navigation; in `next dev` reopening the same dialog after leaving it was then ignored. The documented catch-all `@modal/[...catchAll]` makes Next 16's strict route matching reject `/login` and `/register`. The path check is a second guard that also covers a route someone forgets | built (step 1) |
| Each dialog route's body lives in one component next to its full page (`new-entry.tsx`, `new-wallet.tsx`, `edit-wallet.tsx`), used by the page and by its `@modal` copy | The full page and the dialog must never drift apart | built (step 1) |
| The variable Plus Jakarta Sans file (200–800 in one file) with the `latin-ext` subset | Fewer files than one per weight; `latin-ext` covers Romanian and other European diacritics in names and notes | built (step 1) |
| Account-button initials: first letters of the first and last word of the display name, or the first two letters of a one-word name; `.`, `_` and `-` split words too | Most accounts show their user ID (`alex.ungur` → "AU", `demo` → "DE") | built (step 1) |
| `Card`, `Button`, `Input`/`Select`/`DatePicker` and `PageHeader` took the new shapes in step 1 (pills, 20px cards, 44px fields, 28px titles) | Every later step builds on them; restyling them once avoids each screen doing it | built (step 1) |
| The auth pages' decorative bar row is 30 static `aria-hidden` divs in `--surface-muted`, every seventh in `--accent-soft` | An echo of the per-day charts that never competes with the form | built (step 1) |
| `pickDefaultCurrency` counts archived wallets when finding the month's busiest currency, so for a past month it can return a currency that `listUserCurrencies` (active only) leaves out; the currency switch must show the selected value even when it is not in that list | Every other per-currency figure includes archived wallets, and `?currency=` already accepts any currency the user holds a wallet in; a past month spent from a since-archived wallet should open on that spending, not on zeros | built |
| Day N is 0 for a future month: pace and no-spend days are zeros, `getWalletMonth.days` is empty | The spec defined N only for current and past months; a future month has no elapsed days | built |
| A month's income, expenses, net, top category and wallet in / out cover the whole month, including entries dated after today; only the pace, no-spend days and the per-day lists stop at day N | "This month" read literally. A future-dated entry in the current month therefore shows in the totals but not in the balance-after days, so `opening + in − out` can differ from the last day's closing balance until that date arrives | built |
| The `month` filter is ignored as soon as either `from` or `to` is given (it is still validated) | "Explicit from/to override month": mixing a month bound with one explicit bound would give a range the user never chose. Clicking a day bar sets both | built |
| The largest day is the earliest on a tie and is chosen over the whole month, not only days 1..N; its label falls back to the category, then to an empty string | Ties and future-dated entries were unspecified; the chart draws every day of the month | built |
| A currency argument must be a valid uppercase ISO code (`isValidCurrency`), else VALIDATION; a valid code the user holds no wallet in gives zeros rather than an error | The page already falls back when `?currency=` names no wallet of the user; the service only rejects what cannot be a currency | built |
| `listCategoriesWithUsage` returns a new `CategoryWithMonthUsage` type and leaves `CategoryWithUsage` as it was | Code that builds `CategoryWithUsage` values (fixtures, components) keeps compiling; existing callers get the extra fields as zeros | built |
| On the Overview chart the bars and the lines share the box but not the scale: bars are scaled so the tallest ordinary day reaches 60% of the box (a capped day reaches the top), the lines to the larger running total | Per-day amounts and running totals differ by an order of magnitude; on one scale the bars would be slivers. Keeping ordinary bars low leaves the upper part to the lines, as in the design. The legend's `title` and the chart's text alternative say so | built (step 3) |
| A day is capped only when it is more than 3× the median of the non-zero days **and** more than 1.2× the next largest day | With two equal big days (two rent payments) capping one would not make the others any more readable; the median rule alone would still cap it | built (step 3) |
| The month switcher keeps `?currency=` only when it came from the URL; a defaulted currency is picked again for each month | A currency the user chose should survive paging through months; one the page chose should follow each month's busiest currency, as on a first visit | built (step 3) |
| The previous month's running line is aligned by day number and cut to the shown month's length (31 Oct is not drawn on a November chart); lines start at 0 on the left edge | Matches the pace card ("by 8 Oct"); stretching October over November's width would compare different days. Starting at 0 shows the first day's step and draws something on the 1st | built (step 3) |
| For a past month the pace card says "over the whole month" only when day N covers the previous month; November against October says "…than by 30 Oct" | `getMonthInsights.pace` compares through min(N, previous length), so November is compared with 1–30 October, not all of it | built (step 3) |
| The Overview's wallet rows show each wallet's balance today, with the change for the shown month (also for a past month) | "Balance" means the wallet's balance everywhere else; a balance as of a past month's end was not asked for | built (step 3) |
| The currency switch is left out when the user holds one active currency and it is the one shown | A one-option switch is noise; the heading already names the currency | built (step 3) |
| `CurrencyTotals`, `CategorySpending` and `components/dashboard/spending.ts` were removed with their tests; `WalletCard` (`components/wallets/wallet-card.tsx`) is now unused and was left for step 5 | The insight cards replace the per-currency totals; Categories (step 7) builds its own split bar; the wallet list is step 5's to redesign | built (step 3) |
| The Add dialog's create actions switch on a hidden `mode=dialog` field and return `{ ok: true, message }`; the full page and the edit pages still redirect | One action per kind for both places; the no-JS full page keeps working because it never sends `mode` | built (step 6) |
| The "Added €12.40 to Food" / "Moved €20.00 from Cash to Revolut USD" line is built by the action, not the form | The server has the parsed amount, the wallet's currency and the category name; the client would have to re-parse what it typed | built (step 6) |
| Closing after a save is `router.back()` followed by `router.refresh()` on the next `popstate` | `back()` is asynchronous; refreshing straight away would refresh the dialog's URL. Seen working in the browser (the wallet list behind showed the new balance) | built (step 6) |
| The dialog's footer is outside the keyed `<form>`, its submit attached with `form=`, pending state from `useActionState` | The form remounts after every result (the existing fix for React's form reset); the "Keep open" checkbox and the status line must survive that, and a live region that remounts with its text is not announced | built (step 6) |
| Today / Yesterday are `aria-pressed` buttons, not radios; the calendar pill reads "Other date" unless a custom date is set | They are shortcuts that set the picker's value, not a choice that posts itself (MonthGrid uses the same pattern); a third radio could not represent "some other day" | built (step 6) |
| "Today" is the server's date, passed to the form | The form renders on the server first; a browser in another time zone would otherwise disagree with the server's default date and cause a hydration mismatch | built (step 6) |
| Sent and Received sit side by side from `sm` up and stack below it | Two 44px inputs with their currency codes do not fit side by side in a 375px sheet | built (step 6) |
| "Manage categories" is a dashed pill after the category pills, not a link in the heading row | Keeps the Tab order amount → categories → wallet that the spec asks for | built (step 6) |
| The type switch uses the neutral `Segmented` look (no expense/income/transfer colours) | The shared control; the submit label and the fields already say which kind is chosen | built (step 6) |
| After a failed save, focus moves to the first invalid control | The form remounts, so focus would fall to `<body>`, outside the dialog's focus trap | built (step 6) |
| `Popover` clears its own `translateX` before measuring | React StrictMode runs the layout effect twice in development; the second run measured the shifted panel, found a sub-pixel overflow and reset the shift to 0, so the calendar opened from the date pill stuck out of the 375px sheet | built (step 6) |
| /data's export sentences were cut to one each (the CSV one still points to the backup and to Export CSV on Transactions) and the long import text (limits, separators, Spendee pairing, "nothing is changed or deleted") moved into a closed "What can be imported" disclosure | The redesign asks for one sentence per export and a clean drop area; nothing was dropped, only folded away | built (step 8) |
| Cancel on the import preview clears the chosen files as well as the preview; "Preview import" stays as its own button | Cancel reads as "never mind"; changing the duplicates option or the files already discards a preview, so there is no need for a Cancel that keeps them. Previewing on file choice would change the two-step flow | built (step 8) |
| Files can be dropped on the drop area; a drop replaces the selection like choosing does and is not filtered by the picker's `accept` list | The panel already keeps the `File`s in state, so it was a handful of lines; the server detects formats by content anyway, so an odd file becomes a problem in the preview | built (step 8) |
| The problem card's heading is in the text colour on `--danger-soft`, with `text-danger` only for the line labels on the surface | `--danger` on `--danger-soft` measured 4.4:1 in Sand at the time; the planner then darkened the Sand `--danger` to `#A83F26` (5.0:1 on the soft tone, 6.0:1 on cards), so `FormError` and the labels now pass too | built (step 8) |
| The 44px touch targets on /data are kept at every width (download pills, Copy to clipboard, Cancel / Import, the disclosure) | One size for phones and desktop; the badges are 44px too, so the rows line up | built (step 8) |
| /transactions keeps `month` in the URL as given and treats an absent month as the current one; `?month=<current month>` is not counted as a filter, and links the page builds leave the current month out | The default view needs no parameter, so a bookmark of `/transactions` always opens on "this month"; spelling the month out must not light up "Clear" | built (step 4) |
| The CSV export route keeps "no `month` = all time"; the list's Export CSV link always writes the month it shows | A bare `/api/export/transactions` (the /data page's link) must keep exporting everything, while the list's export must match the list | built (step 4) |
| The month chip opens a dialog (a `MonthGrid` plus "‹ Oct · All time · Dec ›" links), not a listbox like the other chips | A month grid is not a list of options; the grid's own ‹ › step years, so previous / next month are links in the footer | built (step 4) |
| The in-place editor of an expense or income keeps the Expense / Income switch | It is the edit page's form; changing the kind of a mistaken entry is the same edit in both places | built (step 4) |
| Both legs of a transfer stay in the list (unless a wallet is filtered) and either leg opens the whole transfer | Each leg is a row in its wallet's history; editing one side alone would break the transfer | built (step 4) |
| The day strip shows only for a month with entries or a selected day, ignores the type and search filters and is always expenses; its tallest day is capped like on the Overview | A strip of zeros adds nothing; "expenses per day" for an income filter or a note search would be a different chart. Without the cap a rent day flattens every other bar in a 48px strip | built (step 4) |
| One card per day group; the day's net is muted, not coloured | Matches the day-grouped design; a net mixes income, expenses and transfers in several currencies, so a colour would suggest a judgement it cannot make | built (step 4) |
| The inline form's element ids carry a per-row prefix (`edit-<id>-`); the posted names are unchanged | The Add dialog (N) can open over the list while a row is open, and both forms would otherwise have `id="amount"` | built (step 4) |
| The row's `summary`, `panel` and `after` elements carry explicit keys | Without them a soft navigation between list URLs logged React's "unique key" warning for `ExpandableRow` (seen in the browser, not on a direct load); the cause was not traced further than that | built (step 4) |
| Each row has a `<noscript>` link to its edit page, besides "Open as page" inside the open row | Without JavaScript the row button does nothing, so the link inside the panel alone would never be reachable | built (step 4) |
| The floating Add button is hidden (CSS `:has([data-expandable-open])`) and the N shortcut stands down while a row is open for in-place editing | At the bottom of the viewport the button covered the open form's Save button on phones and clipped the amount's currency label on desktop; the dialog case was already handled by the scrim | planner |
| /categories reuses the Overview's currency rule (`resolveOverviewCurrency`, `?currency=` kept on month links only when it came from the URL) and clamps a future `?month=` to the current one; `overviewHref` gained a `basePath` | One rule for every month + currency page | built (step 7) |
| The split card's total is the sum of the expense categories' month amounts, not `getMonthInsights().expenseMinor` | It is the shares' denominator, so bar, legend and total agree by construction; the two figures are equal (every expense has a category, both include archived wallets) | built (step 7) |
| Legend percentages are whole numbers by largest remainder, so they add up to 100; a non-zero share under 0.5% shows "<1%" | Plain rounding gave legends of 99% or 101%; "0%" next to a category that did spend reads as a bug | built (step 7) |
| An expense category with nothing this month gets a hollow swatch and an empty share bar | It has no segment in the split bar, so there is no ramp colour to repeat; a filled neutral dot would look like another ramp shade | built (step 7) |
| Expense and Income are separate `ExpandableList`s (one open row in each) and announce in their section's visible status line, not the list's hidden one | Each section's heading and status line are where removals focus and announce, as before; the add row, outside any row, announces there too | built (step 7) |
| Income amounts in the category lists are `text-income` and unsigned; expense amounts use the text colour; a month without any is "—" | The UI direction's amount colours; the heading already says the kind, so a sign adds nothing | built (step 7) |
| The wallet chart stacks each day's money out (bottom, accent) and money in (top, income) in one bar rather than two bars side by side | Most days have only one side, so a stacked bar reads as "one bar coloured by what happened"; two bars per day would halve every bar to about 4px at 375px. `DayBars` gained an optional lower segment (`base`) instead of a second chart | built (step 5) |
| The wallet's balance line is scaled to the month's own lowest and highest balance (±15% headroom), starting on the left edge at the opening balance; the bars keep the Overview's 60% share | A balance of €7,000 that moves by €300 would be a flat line on a zero-based scale; starting at the opening shows day 1's change | built (step 5) |
| One huge day on the wallet chart is capped like on the Overview, labelled by its larger side ("In €4,200.00") | A salary or rent day otherwise flattens the rest of the month; the label keeps the amount readable | built (step 5) |
| The /wallets cards' balance line covers the month so far across the card's full width and is coloured by the month's change (muted and flat when no day moved the balance) | A line squeezed into 9/30 of a 120px box would be unreadable early in the month; the colour matches the change text under it | built (step 5) |
| "Started the month at" compares the opening with the last closing so far ("Up €2,460.85 since"; "over the month" for a past month) | The spec gave "Up/Down €… since" without a reference point; the month's last closing matches the chart and ignores future-dated entries, like the day headers | built (step 5) |
| The wallet page lists at most 200 entries of the month with no pagination, and says so with a link to Transactions when there are more | Months with more than 200 entries in one wallet are rare; Transactions already has the full, paginated list | built (step 5) |
| The new-wallet currency is posted by both the pills and the typed-code input (`name="currency"`); the last non-empty value wins (`chosenCurrency`), and with JavaScript the pills uncheck while a code is typed | One field name keeps the action and its error key unchanged; the rule makes the no-JS form behave like the scripted one | built (step 5) |
| No currency is preselected on the new-wallet form | A preselected EUR would be easy to keep by mistake, and the currency cannot be changed afterwards | built (step 5) |
| The Expense / Income / Transfer pills on the wallet page keep `returnTo=<this page>` in their link | The dialog ignores it; the full page opened without JavaScript (or in a new tab) then comes back to the wallet instead of /transactions | built (step 5) |
| The wallet page's actions moved into a "⋯" menu (`role="menu"`, arrow keys) with "Edit wallet", Archive / Unarchive and Delete; Archive / Unarchive close the menu when they succeed | The header has room for the three add pills; the rarer actions sit one step away, as the design shows | built (step 5) |
| `WalletCard` / `WalletRow` (`components/wallets/wallet-card.tsx`) were removed | Nothing used them after the Overview (step 3) and the new wallet list | built (step 5) |

### Wallet groups

Decided 2026-11-09 with the owner (the design is SPEC "Wallet groups"; steps 1, data model and services, and 2, the interface, are built).

| Decision | Why | Decided by |
|---|---|---|
| Wallet groups inside one account, not separate books or users; groups are user-defined; categories stay shared | Personal and business money should be looked at apart without a second login or duplicated categories; transfers between the two stay ordinary transfers | owner |
| `wallets.group_id` is NOT NULL with ON DELETE RESTRICT; a group is deleted only when empty and not the user's last | A wallet can never be left without a group, and deleting a group never moves or removes money | planner |
| Migration `0002` rebuilds `wallets` by hand and gives each user a `Personal` group; a wallet with a missing owner makes it fail and roll back instead of being dropped | `ALTER ... ADD NOT NULL` cannot work on a populated table; losing a row silently is worse than refusing to start (the pre-migration copy exists) | built (step 1) |
| Group names are unique per user ignoring case, compared case-folded in the service; there is no DB unique index | Same as categories; keeps the migration to the rebuild of one table | built (step 1) |
| A group of another user in a `groupId` option behaves like an empty group; in a mutation it is NOT_FOUND on `groupId` | The rule for every other foreign row | built (step 1) |
| The backup stays `version: 1` with an optional `group` per wallet | Old files still import (into the target group) and new files lose nothing; a version bump would reject them for no gain | built (step 1) |
| An import never moves an existing wallet between groups; only created wallets get the backup's group or the target group | "Import adds, never changes" | built (step 1) |
| The selected group is a cookie (`et_group`, httpOnly, one year), set by a Server Action from a plain form; the switcher is hidden below two groups | No URL parameter to carry through every link and `returnTo`; works without JavaScript; one group changes nothing in the interface | built (step 2) |
| `selectGroupAction` falls back to `/` (not `/transactions`) when `returnTo` is missing or unsafe | The switcher lives on every page, so the safe place to land is the Overview | built (step 2) |
| The expense / income wallet picker (pills) shows the group as a muted suffix instead of grouping | Pills cannot be grouped like `<optgroup>`; the transfer selects do group | built (step 2) |
| Entry forms and the inline row editor offer every wallet, not just the selected group's | A transfer can cross groups; the selected group only decides the default wallet | built (step 2) |
| The Groups card is on the Wallets page, rows open in place like Categories, and deleting is only offered when it can succeed (the panel says why not otherwise) | No new route or dialog; same interaction as categories | built (step 2) |
| The demo data has Personal and Business, a business wallet with entries and one transfer between the groups | Lets the scope be seen working on `npm run dev:demo` | built (step 1) |

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
  `docs/SELF-HOSTING.md` shows how an administrator can list them.
- **Pre-migration copies are never cleaned up**; each one is a full copy of the database in the `/data` volume.
- **A migration whose derived user IDs still collide after the `user<id>` fallback** (only possible with contrived
  emails) stops startup; it is rolled back and needs a manual fix of the colliding email before upgrading.
- **Sign-in lookups compare `lower(...)`** and so do not use the unique indexes (a scan of `users`); irrelevant at
  household scale.
- **No session management.** There is no "sign out everywhere", and expired sessions are only removed when their
  cookie is next presented.
- **A reverse proxy must preserve the `Host` header** (or send `X-Forwarded-Host`); otherwise sign-in fails with a
  500. Documented in `docs/SELF-HOSTING.md`, not detected or explained by the app.
- **A reverse proxy's upload limit must allow 6 MB** for imports (nginx defaults to 1 MB).
- **`db:reset` is development-only.** It refuses with `NODE_ENV=production` and is not shipped in the Docker image;
  Docker users start over by taking a backup and removing the volume (`docker compose down -v`).
- **CI only on GitHub.** Tests and the image run in GitHub Actions; there is no other CI, and the image is only on
  GHCR (no Docker Hub mirror). Images are not signed and no SBOM or provenance policy is documented.
- **No release process yet.** Until the first `vX.Y.Z` tag there are no version tags to pin, only `latest`/`main`
  and `sha-<commit>`.
- **`build` / `start` scripts do not work in Windows `cmd`** because of the inline `NODE_ENV`. Docker users are
  unaffected.

### Features not built

- **Conversion is only on Overview.** The Transactions strip, Categories and wallet pages stay per currency. The
  Overview Wallets card uses today's balances and the latest rates also for a past month.
- **"Top category" in the converted view breaks ties by lower-cased name in JavaScript**, not SQLite's `nocase`;
  the two can differ for non-ASCII names.
- **Frankfurter quotes about 30 currencies (the ECB list).** Wallets in other currencies (e.g. KWD) are left out of
  the converted figures with a note. There is no second provider and no way to enter a rate by hand.
- **The rate cache is per process and in memory.** After a restart the first Overview load fetches again; if the
  provider is down then, the total leaves the foreign wallets out until it is back.
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
- **Wallet groups have no archive state, no ordering and no colour**; they are listed by name.
- **The context export (Statement Importer) and the transactions CSV carry no group.** The CSV can be narrowed by
  `group=<id>` on the export URL but has no group column, so a CSV import always puts new wallets in the target
  group; only the backup round-trips groups.
- **The migration to wallet groups is tested on synthetic databases only**; it has not been run on a copy of the
  real `data/app.db`.

### Rough edges

- The import rules a user may want to read (Spendee transfers, time zones, labels, rounding) are documented only in
  `docs/SPEC.md`, which is written as a build contract rather than a user guide.
- "Manage categories" in the transaction form navigates away and loses what was typed.
- Switching the form between Transfer and Expense/Income clears a typed amount.
- If a category is the only one of its kind and has transactions, another must be created before it can be removed.
- Without JavaScript, an empty note search on /transactions leaves `q=` in the URL (harmless); with it the URL is
  clean. The filter chips themselves need JavaScript (popovers); without it only the search, the day-strip links,
  pagination and the per-row edit links work.
- The /transactions day-strip bars are about 9px wide at 375px, well under the 44px touch target; the month chip and
  the list are the comfortable path on phones.
- Opening a /transactions row does not move focus into its form (Tab from the row button reaches it next); after a
  Delete from inside a row, or a Save that moves the entry to another page or month, focus falls back to the page.
- With a day selected in the strip, a capped day's amount pill stays in the accent colour while its bar is muted.
- The name-length message says "under 40 characters" although exactly 40 is allowed (wallet and category names;
  first name / surname now say "80 characters or fewer").
- An unterminated quote in a CSV stops parsing at that line, so later problems are only reported once it is fixed.
- A wallet restored as archived from a backup is marked archived as of the import, not its original date.
- If the account changes between an import's preview and its confirmation, the confirmed numbers can differ from
  the preview (the confirmation re-validates and reports what it actually did).
- A file over 6 MB that bypasses the browser's size check gets the framework's generic error instead of the app's
  message.
- Popovers never open upwards: near the bottom of the screen the calendar's lower rows need a scroll to reach.
- On the wallet chart a capped day's label pill is in the accent colour even when it is money in (the bar itself is
  green); the label says "In" or "Out".
- A wallet's starting balance uses the decimal keyboard on phones (as before step 5), which on iOS has no minus key;
  a negative starting balance has to be pasted or entered on another keyboard.
- Future-dated entries on a wallet page show no "Balance after" in their day header (`getWalletMonth.days` stops at
  today).
- **On phones the Add dialog does not put focus in the amount when it opens**; `Dialog` focuses its panel there, so
  it takes Tab (✕, the type switch, then the amount). From `sm` up the amount (`data-autofocus`) is focused.
  Deliberate: auto-focusing on a phone would open the keyboard over half the bottom sheet.
- **A save from the Add dialog revalidates every page** (`revalidatePath("/", "layout")`) rather than the few the
  full-page form revalidates: the dialog can sit over any page.
- The bottom sheet's drag handle is decorative: there is no swipe-to-close (✕, Escape or the scrim close it).
- **Unexplained `next dev` reload loop seen while verifying step 1:** in the real checkout the dev server several
  times got into a state where every load of some page logged "Compiled in 1ms" and the browser reloaded endlessly
  (Fast Refresh). Restarting it cleared it for a while. The same tree copied to another folder, and `HEAD` copied
  the same way, never did it over the same page sequence, and `next start` never did. Suspected: other processes
  touching the checkout at the time (a parallel agent, a `next build` / `next typegen` in the same folder); not
  confirmed. If it shows up again, restart `npm run dev`.
- The date picker's month view has no button back to the day view; picking a month or pressing Escape returns.
- A date cannot be typed into the date picker (see Interface decisions); it is mouse/touch or keyboard navigation only.
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

- **Month stepper on /transactions** (arrows joined to the Month chip, the end-of-list month row, "This month", `[` / `]` / `T`) was
  covered by tests (static markup, the key predicate) and typecheck / lint only; not checked in a browser: the look
  at 375px (chip wrapping, the 44px arrows), the hover tint in dark mode, and the keys against a real open dialog
  or edit row.

- **Wallet groups interface (step 2)** was covered by tests (render to static markup, actions with mocked Next APIs)
  and typecheck / lint only; it was not exercised in a browser. Unchecked there: the switcher's submit on change and
  its look at 375px (top bar width with a long group name; the select is capped at `max-w-44`), the no-JS "Go"
  button, focus after a group rename / delete, the `<optgroup>` pickers on a real phone, and the Overview with the
  group name in the heading.

- **Bind mounts on a real Linux host.** The "folder must be owned by uid 1000" failure and its fixes were only
  simulated on Docker Desktop.
- **`COOKIE_SECURE=true` over plain HTTP** was checked with curl, not a browser.
- **The amd64 image** was built and run under emulation only.
- **The GitHub Actions workflow has never run.** The repository had no GitHub remote when it was written
  (2026-11-09); the workflow YAML was only parsed, not linted with actionlint or executed. The image name
  `ghcr.io/xalert/expenses-tracker` in `deploy/compose.yaml` and the docs assumes the repository is pushed as
  `xalert/expenses-tracker` and the package made public. Verified locally: the image built from the Dockerfile
  runs healthy through `deploy/compose.yaml` (`/api/health` 200, `/login` 200).
- **No screen-reader pass.** Focus handling and labels were checked through the DOM. This includes the date and
  month pickers: roles, `aria-selected` / `aria-pressed`, the combobox trigger and roving focus were checked in
  headless Chrome through the DevTools protocol (keyboard and mouse events, light and dark, 1280px and 375px), not
  with VoiceOver or NVDA, and not on a real touch device or in Safari / Firefox.
- **Native dialogs were not exercised**: the confirmation dialog was stubbed, and test files were injected by
  script rather than chosen in a real file picker; downloads were fetched by script.
- **No real spreadsheet application** was used to open or re-save an exported CSV.
- **The /data "Copy" button never reached a real clipboard**: in the in-app browser pane the clipboard was refused
  and the selectable text box appeared; the "Copied" path was checked with a stubbed `navigator.clipboard`. Real
  drag-and-drop of a file onto the artifact's panel was simulated with a synthetic `drop` event in the harness.
- **Dropping files on /data's import area** was only simulated (a synthetic `drop` event with a `DataTransfer` in
  headless Chrome); no real drag from Finder or Explorer, and not in Safari / Firefox.
- **The 0001 migration on the owner's real database** was not run by the implementer (it is not theirs to touch);
  it is covered by synthetic populated databases in `tests/migrations.test.ts` and a browser upgrade check on a
  scratch database.
- **The Statement Importer has not run on claude.ai.** Everything was exercised against `dev/mock-claude.js`:
  the real `sample` (Haiku's actual answers, consent, rate limits, image limits), `db` (rules, snapshots, write
  errors), `user` and `downloads` were not. Real bank statements were never used (fixtures are synthetic), and
  the clipboard path was only seen failing over to the text box.
- **The Overview with a currency held only in archived wallets** (the switch's extra option) was checked by a
  rendering test, not in the browser: the demo data has no archived wallet. The Overview was checked on the demo
  database at 375px and 1280px in both schemes (no horizontal overflow); its chart was not checked with a month of
  many similar-sized days or with dozens of currencies in the switch.
- **/categories (step 7)** was checked on the demo database at 375px and 1280px in both schemes (no horizontal
  overflow, no console errors): rename and rename back, a duplicate name on rename and on add, adding "Probe" and
  removing it (confirm accepted), the replacement select of a used expense and a used income category, Escape and
  Cancel returning focus to the row, focus on the heading after a removal, an empty past month and an empty
  currency. Not checked in the browser: the refusal when an "unused" category gains transactions while its row is
  open, more than five spending categories (the ramp reuse is unit-tested), and the archived-only and no-wallet
  states (no such demo data). The month switcher's arrows (32px) and the currency pills (36px), shared with the
  Overview, are under the 44px touch target.
- **The wallet screens (step 5)** were checked on the demo database in headless Chrome at 375px (dark) and 1280px
  (light), with both schemes screenshotted at both widths for /wallets and the wallet page (no horizontal overflow):
  archive / unarchive (the ⋯ menu and the Archived list), creating a CHF wallet by typed code in the dialog (it
  closed and the card appeared) and deleting it from the ⋯ menu, renaming through the edit dialog (it closed over
  the wallet page), the Expense pill and N preselecting the wallet, and an in-place edit updating "Balance after".
  `confirm()` was auto-accepted by the harness; the datalist suggestions were not opened (a native control); the
  no-JS forms were covered by rendering tests and the action tests, not in a browser with scripts off.
- **No automated end-to-end tests.** Browser checks were done by hand during the build; the automated suite covers
  services, parsers and a few rendered components.
- **A real import of the owner's Spendee files** was run only against an in-memory database: the older single file
  (3,227 rows, balance matching an independent calculation) and the current per-wallet export (8 files, 382 rows,
  24 transfers paired, per-wallet net movement matching the planner's independent analysis, re-import adds
  nothing). Neither has been imported into a real instance through the UI.
- **Multi-file selection was exercised with files injected by script** (`DataTransfer`), not picked in a real
  file dialog; the 6 MB request limit with many small files (multipart overhead per file) was not measured.

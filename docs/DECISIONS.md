# Decisions and known gaps

A running log of the choices made while building this app, why they were made, and what is knowingly missing or
unverified. `docs/SPEC.md` says *what* the app does; this file says *why*, and what it does not do.

Keep it current: when a product or design decision is made, or something is left unfinished or unchecked, add it
here in the same change. Remove a gap when it is closed (and say so in the commit). ["Next steps"](#next-steps) is
the ordered to-do list drawn from the gaps.

"Decided by" is **owner** (the project owner chose it), **planner** (chosen while planning, not explicitly
confirmed by the owner — the ones most worth a second look), or **built** (settled by the implementation where the
plan left room).

Entries date from the initial build, 2026-11-05, unless a section says otherwise. A row marked *superseded
2026-11-09 by Postgres* describes the SQLite era and is kept as history; the "Database: SQLite to PostgreSQL"
section holds what replaced it.

---

## Decisions

### Stack and architecture

| Decision | Why | Decided by |
|---|---|---|
| One Next.js app (App Router, TypeScript, Tailwind v4) for UI and server | Simplest to run and deploy: one process, one image | owner |
| *(superseded 2026-11-09 by Postgres)* SQLite in a single file, via Drizzle + better-sqlite3 | Zero setup, plenty for a personal tracker, trivial to back up | owner |
| No REST API. Server Components read through `src/server/*`; Server Actions mutate | Less code and one place for rules; nothing else consumes an API yet | planner |
| All domain rules live in the service layer; every function takes `userId` first | One enforcement point for ownership and validation, testable without HTTP | planner |
| Migrations apply automatically on first DB access | `npm run dev` and `docker compose up` work with no extra step; upgrades are just a restart | planner |
| Next.js Cache Components switched off | Every page is per-user and reads the session cookie; the feature would force `<Suspense>` around each cookie read for no benefit | built |
| *(superseded 2026-11-09 by Postgres)* Services are synchronous | better-sqlite3 is synchronous; only password hashing is async | built |
| `build` / `start` scripts set `NODE_ENV=production` inline | A globally exported `NODE_ENV=development` broke `next build` on the development machine | built |
| `images: { unoptimized: true }` | The app serves no optimised images. It was expected to drop `sharp` from the image; it did not (Next's own server trace includes it), so the Dockerfile deletes it, see Deployment | planner |

### Money, wallets, transactions

| Decision | Why | Decided by |
|---|---|---|
| Amounts are integer minor units; decimals come from the currency (JPY 0, EUR 2, KWD 3) | No floating-point drift; correct for every ISO currency | planner |
| Stored amounts are always positive; the kind gives the sign | One representation, no sign bugs | planner |
| *(superseded 2026-11-18 by the row below)* No currency conversion, except the Overview "All in <currency>" view; other pages group totals per currency | The owner asked for one figure over all wallets, on the Overview; the other pages stay exact | owner |
| The "All in <currency>" view (default, `?view=only` to turn it off) is on the Overview, the /transactions day strip and /categories, with the same switch, notes and mechanism (`convert` / `getConversion`); every other total stays per currency | One figure over all wallets was asked for on the Overview; the strip sits over a list that already mixes currencies and the category split is incomplete without the other wallets, so both read better converted. The same default everywhere means one rule to learn | planner (2026-11-18) |
| **Deliberate:** wallet pages never convert | A wallet is one currency, so there is nothing to convert; its page's figures are exact | planner (2026-11-18) |
| The month figures convert each day at that day's rate; the Overview Wallets total converts the balances of the day it shows — today for the current month at the latest rate, a past month's last day at that day's rate (`getWalletBalancesOn`) | A past expense is worth what it was worth that day; a balance is worth what it was worth on the day it is shown for. Before 2026-11-18 a past month showed today's balances at the latest rate, which mixed two dates | planner (2026-11-18) |
| The past-month Wallets card lists the wallets that are active now (with their balance at that month's end), not the wallets that were active then | Wallets have no history of archiving; the card's rows stay the same when stepping through months | planner (2026-11-18) |
| One `?view=` for the whole Overview, its switch next to the currency switch | The chart, the cards and the Wallets total then always agree on what they include | planner |
| The converted figures use ECB reference rates from Frankfurter (`api.frankfurter.dev`), with `EXCHANGE_RATES=false` to turn it off | Free, no API key, no account for self-hosters; a self-hoster can keep the server offline | planner |
| *(superseded 2026-11-18)* The rates were cached in memory, per process | — | planner |
| Fetched rates are stored in the database (`exchange_rates`, plus `exchange_rate_days` for every calendar day asked about) and shared by every user; the database is looked up first and only the missing days are fetched; a day is final once fetched after it ended (UTC), today is refetched after 6 h | A restart or a second container no longer refetches; past months are fetched once ever; recording the days asked about tells a weekend or holiday from a gap, so a stored range is never asked about again | planner (2026-11-18) |
| During a provider outage the most recent stored day on or before each date stands in, and the note says "rates from <date>"; the retry wait (10 min) stays in memory per process | An outage should cost precision, not the whole converted view; the date makes it visible how old the rate is. A lost wait after a restart costs one extra request | planner (2026-11-18) |
| Rates are stored as `numeric` (exact decimal, read back as a string), not `double precision` or `text` | `numeric` keeps the decimal exactly as the provider wrote it or the user typed it (a binary float cannot hold 1.0866 or 0.000087 exactly) and the database can still check `rate > 0`; `text` would lose that check. The maths converts to a JS number only to compute a figure that is then rounded to minor units, and nothing converted is stored | planner (2026-11-18) |
| Users can enter their own rate per currency ("1 KWD = 3.25 EUR from 1 Nov 2026", `/rates`); the latest one on or before a date applies; it is used **only where the provider has no rate** that day, never to override it | Frankfurter quotes about 30 currencies; an effective date keeps past months at the rate of their time. Overriding the provider was not asked for and would make two sources disagree silently | planner (2026-11-18) |
| A manual rate's base is EUR or another currency the user holds; it resolves through the provider's rate of that base (or another manual rate) on the date; without any provider table only rates against EUR resolve | Users think in the currencies they hold; EUR is the provider's base, so it always resolves, also offline | planner (2026-11-18) |
| Manual rates apply also with `EXCHANGE_RATES=false`; stored provider rates do not | "Off" means no provider; a self-hoster who keeps the server offline can still convert with rates of their own | planner (2026-11-18) |
| `/rates` is not in the main menu; it is linked from the "All in" switch ("Rates") and from a note that leaves a currency out ("Enter a rate for KWD", with `returnTo`) | It is needed rarely and only in the context of a converted view | planner (2026-11-18) |
| The rates page lists the held currencies (archived wallets included) the provider's latest stored day does not quote, plus any with own rates; with nothing quoted (off or never loaded) every held currency but EUR | What needs a rate is exactly what the provider leaves out; listing everything when nothing is known lets an offline instance convert at all | planner (2026-11-18) |
| **Deliberate: no second rate provider** | The manual rates cover the currencies Frankfurter does not quote; a second provider would need an API key or an account for most currencies and a rule for when the two disagree | planner (2026-11-18) |
| *(2026-11-18)* **Deliberate:** the provider's stored rates (`exchange_rates`, `exchange_rate_days`) are never pruned | About 30 rows per business day (some 8,000 a year), shared by every account, and needed again whenever anyone looks at a past month in a converted view; pruning would only mean fetching them again | planner |
| *(2026-11-18)* **Deliberate:** a manual rate whose base is not EUR does not resolve when there are no provider rates (switched off, or none stored), unless that base has a manual rate against EUR itself | Without the base's own rate there is nothing to convert through; inventing one is worse than leaving the currency out (the conversion note already says which currency has no rate) | planner |
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
| Password change lives on a new `/account` page (linked from the account menu, not the main menu) and needs the current password plus the new one twice | One place for account settings that profile editing can join later; the current password guards against a borrowed, already signed-in browser | planner (2026-11-17) |
| Changing the password signs out every **other** session of that user, in the same transaction; the current one stays | The usual reason to change a password is suspecting someone else has it; keeping the current session avoids an immediate re-login | planner (2026-11-17) |
| Accounts are identified by a user ID; email, first name and surname are optional | The owner asked for it: a self-hosted tracker should not need an email address | owner |
| "User ID" is a name the user chooses (3–32 of `a–z 0–9 . _ -`, case-insensitive), not the numeric database id | Memorable, and it does not reveal how many accounts exist. **This is the planner's reading of "log in with their user id" — confirm** | planner |
| One sign-in field takes a user ID or an email; a user ID can never contain `@` | Existing email sign-ins keep working, and the two can never be confused | planner |
| Existing accounts get a user ID derived from their email's local part, and their name is split at the first space | Nobody is locked out by the upgrade, and nothing has to be entered again | planner |
| *(superseded 2026-11-09 by Postgres)* Migrations run with foreign keys switched off outside the transaction, are followed by a foreign-key check, and a copy of the database is written before pending migrations touch existing data | Making `email` nullable rebuilds the `users` table in SQLite; done naively, dropping the old table cascade-deletes every user's data | planner |
| *(superseded 2026-11-09 by Postgres)* Measured hazard: with foreign keys on, the rebuild deletes every wallet, category and session of a database with no transactions; with any transaction it fails on `transactions.wallet_id` (RESTRICT) and rolls back, so the app could not start | Found by running drizzle's migrator on populated 0000 databases (`tests/migrations.test.ts`) rather than assuming; either outcome rules out the naive path | built |
| *(superseded 2026-11-09 by Postgres)* Derived user IDs: leading `.`/`_`/`-` are dropped, the result is cut to 32, fewer than 3 characters → `user<id>`; on a collision the account with the lower id keeps the plain value; a suffixed value that hits another plain one → `user<id>`; anything beyond that fails the migration (rolled back) | The spec left "nothing valid", length and which side gets the suffix open; this always yields valid IDs and never guesses silently | built |
| Emails keep their stored case through the migration; sign-in and the duplicate check compare `lower(email)` / `lower(username)` | The spec says emails are unchanged; comparing lowercased makes a legacy mixed-case email still work and still block duplicates | built |
| *(superseded 2026-11-09 by Postgres)* `PRAGMA foreign_key_check` runs on every start, not only after migrating | Cheap at this app's size, and a dangling row is worth stopping for whenever it appears | built |
| *(superseded 2026-11-09 by Postgres)* The pre-migration copy is made with `VACUUM INTO` (synchronous, includes WAL content, writes a non-WAL file), is never overwritten (a second one gets a timestamp) and is not deleted automatically | Startup is synchronous; the copy must be self-contained and must survive a retry after a failed upgrade | built |
| Uniqueness of user ID and email is checked before hashing the password as well as inside the insert transaction | A taken user ID is reported without the scrypt delay; the second check closes the race | built |
| The dashboard greeting uses the display name (it used the first word of the name) | Spec: display name everywhere; with optional names the first word is no longer meaningful | built |
| Mobile top bar shows the display name with the user ID under it (when they differ); the sidebar shows user ID and email on separate lines; the user ID line is left out when it already is the display name | Migrated users learn their user ID from the shell; the top bar has room for two short lines | built |
| Demo seed user: user ID `demo`, email kept, first/last name "Demo" / "User"; an existing demo user is found by user ID or email and the login printed with its actual user ID | Idempotent on databases seeded before user IDs (the migration derives `demo` for it, or a suffixed one) | built |
| Profile editing on `/account` (user ID, email add/change/remove, names) with the registration rules; changing the user ID or email needs the current password, the names do not | The user ID and email are what someone signs in with, so changing them from a borrowed signed-in browser must need the password; names are cosmetic | planner (2026-11-18) |
| A profile change checks formats, then conflicts, then the password; a case-only change counts as no change | Conflicts and typos are reported without spending a password attempt; stored values are lowercased anyway | built |
| The "Signed in as" card became the Profile form (its description keeps "Signed in as <name>") | One card that shows and edits the same fields; no read-only duplicate | built |
| *(superseded 2026-11-18 by the Devices list below)* "Sign out other devices" on `/account` shows the count of other active sessions and keeps the current one; no per-device list | A list would need user agents / last-seen times the sessions table does not keep; the count and one button cover "I signed in somewhere I shouldn't have" | planner (2026-11-18) |
| **Devices list on `/account`** (was a known gap): sessions record `user_agent` (trimmed, cut to 256 characters) and `last_used_at` (migration `0006_sessions-devices`); the card lists the active sessions, the current one first with a "This device" pill, each with a label, "Signed in" and "Last active", and a "Sign out" on every other one; "Sign out other devices" stays below | Lets someone see *which* other browser is signed in and end just that one. 256 characters hold every real browser's user agent while bounding what a client can make the app store | planner (2026-11-18) |
| `last_used_at` is written at most once per 5 minutes per session: `getCurrentUser` compares the row it already read, and the UPDATE repeats the condition (`last_used_at <= now - 5 min`) | Avoids a write on every request (a page load runs several); the condition in the UPDATE makes concurrent requests write once. "Last active" is therefore up to 5 minutes stale | planner (interval), built (double check) |
| `last_used_at` is NOT NULL with default `now()`; the migration sets it to `created_at` for sessions that already existed | One less null case in the list and the throttle; for old sessions their sign-in time is the honest lower bound (unknown since), where `now()` would claim activity that may not have happened | built |
| The device label is a few ordered substring checks in `src/lib/user-agent.ts` ("Firefox on macOS"; the browser alone when the system is unknown; "Unknown browser" when the browser is), no versions, no parser dependency | The planner asked for no dependency; the order (Edge, Opera, Samsung Internet before Chrome; Chrome before Safari) is all a label needs. An iPad in desktop mode says "Macintosh" and shows as macOS | planner (no dependency), built (rules) |
| Signing out one device takes the session's numeric id, deletes it only when it belongs to the user and is not the current session, and answers "That device is no longer signed in." otherwise (also for another user's id); the Devices times show in the account's time zone (UTC when unset), en-GB 24-hour | Another user's session behaves exactly like a missing one (the service rule); the current session ends through the account menu's Sign out, so a stray click cannot sign you out here. Times are formatted on the server, so the account's zone is the only one available that is not the server's | built |
| Expired sessions: the user's are deleted whenever a session is created, plus one global `delete … where expires_at <= now()` at every sign-in | No scheduler needed; the global delete is cheap at household scale | planner (2026-11-18) |
| Account deletion needs the current password and the user ID typed out, deletes everything in one transaction children first, then clears the cookie and shows a notice on `/login` | Irreversible, so two deliberate inputs; explicit order instead of relying on cascades past `restrict` foreign keys; the page links the JSON backup first | planner (2026-11-18) |
| No email-based password reset: an administrator command `scripts/reset-password.mjs` in the image (random printed password, or `--stdin`), which also deletes the user's sessions; `/login` says to ask the administrator | Email is optional and the app sends none; the person running the container is the one who can prove anything. Plain ESM so it runs with the image's Node and `pg` alone; tested against `verifyPassword` so the hash format cannot drift | planner (2026-11-18) |
| The reset script refuses the development default database outside production (no override flag) | Same rule as `db:reset --yes`: the default dev database is the owner's real data; `make reset-password` uses `expenses_demo` | planner (2026-11-18) |
| Sign-in rate limiting in memory, per process: 5 failures per identifier (lowercased, so unknown identifiers too) or 30 per client address in a 15-minute window that starts at the first failure; refused attempts get "Too many sign-in attempts. Try again in N minutes." without a password check; a success resets the identifier only | No extra infrastructure for a single-container app; the message is the same for existing and unknown accounts. A restart clears the counts and several containers would not share them (documented) | planner (2026-11-18) |
| *(superseded 2026-11-18 by `TRUST_PROXY` below)* The client address is the first `X-Forwarded-For` hop (Next.js fills the header with the socket address when absent); without one the address limit is skipped | What the planner asked for. The first hop is client-controlled when the proxy appends (nginx's `$proxy_add_x_forwarded_for`), so the address limit can be dodged by a client that sets the header; the per-identifier limit cannot. `docs/SELF-HOSTING.md` says how to make nginx overwrite it | planner (rule), built (caveat) |
| **`TRUST_PROXY`** (was a known gap) decides which `X-Forwarded-For` hop is the client: unset / `false` (default) → none, `true` → the first hop, `N` → the Nth from the right (no address when the header is shorter). Read through `src/lib/config.ts`; both Compose files pass it, off by default | The header is client-controlled up to the hops your own proxies append; only the administrator knows how many there are. The right-most-N rule is what Express and others use, and a client cannot push a forged value past it | planner (2026-11-18) |
| With `TRUST_PROXY` unset the per-address limit is **off**, not fed from a "direct" address | Next.js gives a Server Action no socket address, and it fills `X-Forwarded-For` with the socket address only when the request has none, so a value from Next.js cannot be told from one a client sent. Ignoring the header is the only safe reading; the per-account limit (5 / 15 min) still applies. The planner allowed "unless a direct remote address is available": it never is here | planner (rule), built (no direct address in Next.js 16) |
| Unrecognised `TRUST_PROXY` values (`1.5`, `-1`, `1000`, `abc`) mean unset, silently | The safe reading of a typo is "trust nothing"; the worst case is the per-address limit staying off, as by default. N is capped at 999 only to reject nonsense | built |
| **Deliberate: sign-in rate limits stay in memory, per process** (was a known gap) | The Compose files run one app container, so a shared store (Postgres table, Redis) would add writes or a service for a deployment that does not exist. A restart clears the counts, which is also how an administrator lifts a lockout | planner (2026-11-18) |
| **Deliberate: no self-service password reset** (was a known gap) | The app sends no email, and email is optional; without a second channel a "forgot password" flow would be a way around the password. The administrator's `scripts/reset-password.mjs` covers it | planner (2026-11-18) |
| **Deliberate: a reverse proxy must preserve `Host` (or send `X-Forwarded-Host`) and accept 6 MB uploads** (was a known gap) | Both are proxy configuration the app cannot do for it; `docs/SELF-HOSTING.md` → "Behind a reverse proxy" documents them, and the app already explains a `Host` mismatch instead of a bare 500 | planner (2026-11-18) |
| The current-password checks on `/account` (password change, profile, deletion) share one per-user counter with the sign-in limits' numbers (5 / 15 min), separate from the sign-in identifier counters; only a wrong password counts | A stolen session must not be able to guess the password through `/account`; keeping it apart from the sign-in key means a lockout on `/account` does not also lock the user out of signing in | planner (limit), built (separate key) |
| Unique indexes on `lower(username)` and `lower(email)` replace the plain unique constraints (migration `0002_lower-unique-users`) | The lookups compare `lower(...)`, which the plain indexes could not serve; the expression indexes do and also make case-only duplicates impossible in the database. The race mapping keys on the new index names, exported from the schema | planner (2026-11-18) |
| A reverse proxy that drops `Host` is detected by `src/proxy.ts`, which repeats Next.js's Server Action origin check: a log line naming the fix and a 403 with a readable message (`src/app/error.tsx` shows it, or a small HTML page without JavaScript) instead of Next's bare 500 | The 500 comes from Next.js's action handler (`Invalid Server Actions request.`, "`host` header … does not match `origin` header …"); it gave a self-hoster no clue. Repeating the comparison is cheap and the Next.js check still runs after it. `serverActions.allowedOrigins` is not set; if it ever is, the proxy must honour it too | planner (ask), built (approach) |
| `src/app/error.tsx` (the first app-wide error boundary) shows "Something went wrong" + Try again for every other error | Needed for the host-mismatch message to be visible after a fetch action; before it, an unexpected error showed Next's default "Application error" | built |
| (2026-11-18) An account has an optional IANA time zone, `users.time_zone` (text, nullable; migration `0004_account-time-zone`), validated with `Intl`: accepted by `Intl.DateTimeFormat` and its canonical name in `Intl.supportedValuesOf("timeZone")` or `UTC`; stored canonical | Spendee's timestamps are UTC, so dating them needs a zone that does not depend on the browser doing the import. No zone database of our own: the runtime's ICU is the list. Offsets (`+02:00`) and `Etc/GMT±N` are refused because they are not in that list (a browser reporting one gets no zone stored) | planner (design), built (canonical check) |
| The zone is set automatically: the register and login forms post a hidden `timeZone` (filled after hydration; absent without JavaScript). Registration stores it; a successful sign-in stores it only when the account has none; an invalid or absent value leaves it NULL, silently | Nobody has to find a setting for the common case, and a sign-in from a laptop abroad never overwrites a zone that was chosen or adopted earlier. A failed sign-in changes nothing | planner |
| `/account`'s Profile card has a "Time zone" native select: "Not set (use this browser's)" first, then every zone in `<optgroup>`s by region ("UTC" under "Other", last); changing it needs no password; the list comes from the server as a prop | A native select is keyboard-, screen-reader- and mobile-friendly and type-to-search works in it; ~420 options grouped by region are manageable. Computed on the server because browsers' `Intl` zone lists differ, which would break hydration. A time zone is not an identity change, so no password | planner (select), built (server-side list) |
| `updateProfile`'s `timeZone` is the one profile field where *omitted* means "unchanged" (`""` / null clear it) | Other callers and older forms that do not send it must not clear it | built |
| *(superseded 2026-11-25 by the per-account "today" rows below)* "Today" stays the server's date everywhere; the account's time zone is used only by the Spendee import | Out of scope for this change. A per-account "today" (default dates, the current month) is a possible follow-up | planner |
| **Fix (2026-11-18, found by the e2e suite): the hidden `timeZone` field on `/login` and `/register` keeps the browser's zone after a refused submit** | It was written into the DOM after hydration, and React writes an uncontrolled input's `defaultValue` again on every re-render, so a failed first attempt emptied it and the account was created (or signed in) without a zone. It is now state passed as `defaultValue` | built |
| (2026-11-25) "Today" is the date in the account's time zone everywhere a signed-in user sees it (default dates, the current month, day N, Today / Yesterday labels, the picker's today, projected days, export file names); without a zone, or with one the runtime does not know, the server's local date as before | The Docker image runs in UTC, so east of UTC an entry added after local midnight defaulted to yesterday and the month flipped late (the reverse west of UTC). The account already has a zone | planner |
| (2026-11-25) One pure function, `todayInZone(timeZone, now?)` in `src/lib/dates.ts` (`Intl`, no new dependency), with the server-local fallback; `CurrentUser` carries `timeZone` (read in the session query, no extra query) and request code calls `todayInZone(user.timeZone)` | One obvious way to get the user's today, testable without a clock or a database | planner |
| (2026-11-25) Services take today from the caller on request paths; client components get it from the server, never from a clock during render | A service defaulting to the server's date would silently undo the zone; a client clock is in the browser's zone and breaks hydration | planner |
| (2026-11-25) The service parameters are **required**, not defaulted: `getDashboard` needs `month`, `getMonthInsights` / `getWalletMonth` need `today`, `monthDayN(month, today)`, and the `list-params.ts` helpers need `thisMonth`; the tests pass a fixed date | A default only tests used would still let a new page call forget it, and the tests become independent of the day they run on | built |
| (2026-11-25) Client components take today as a **prop** from the page that renders them (`DatePicker` / `CalendarPanel` `today`, `MonthGrid` `thisMonth`, which `MonthSwitcher` fills from its `maxMonth`), not from a context in the `(app)` layout | A layout is not re-rendered on soft navigation, so a tab left open over midnight would keep yesterday in a layout context while the pages moved on; every caller already had today or the current month at hand. `getCurrentUser` turns a stored zone the runtime does not know into null, so the fallback is decided in one place (`todayInZone` also catches an unknown zone) | built |
| (2026-11-25) Left on the server's clock on purpose: the demo seed (`seedDemoData`, run from scripts, dates relative to the server's today) and the exchange-rate provider's day logic (`getDailyRates` caps the range at the server's `todayISO()`, `getProviderCurrencies`) | The seed has no user zone to use. Rate days are the provider's (business days, final once fetched after the day ended); a user ahead of the server just sees the latest stored rate for their today, as for any day not yet published | built |
| (2026-11-25) The Time zone hint on `/account` now says what the zone does ("Sets your “today” … and dates imported Spendee entries …"); the e2e seed dates entries in the seeded account's zone (`todayISO()` in `e2e/support/seed.ts` is `todayInZone("Europe/Berlin")`), and an e2e test checks the Add form's default date for a UTC+14 and a UTC−11 account | The old hint named only the import. The seed used the Playwright process's date, which in CI (UTC) is not the app's date for a Berlin account for an hour or two each night | built |

### Categories

| Decision | Why | Decided by |
|---|---|---|
| Categories are per user, seeded with eight defaults that get no special treatment | The owner wanted the defaults as a starting point and full control afterwards | owner |
| Removing a category that has transactions moves them to a chosen replacement of the same kind, then deletes it | Chosen over archiving, blocking, or asking each time: the category is truly gone and there is no hidden state (archiving was added next to it on 2026-11-18, see below) | owner |
| Names are unique per user and kind ignoring case, enforced in the service | Avoids "food" next to "Food" without a schema migration | planner |
| *(superseded 2026-11-18)* A category's kind (expense / income) is fixed at creation | Changing it would invalidate its transactions | planner |
| All categories of a kind may be removed; the transaction form then shows an empty state | "Add or remove as they wish"; no artificial minimum | planner |
| Rename and the replacement picker are inline, with no modal library | Works at phone width, keyboard-usable, no new dependency | built |
| **Fix (2026-11-18, found by the e2e suite): the "Remove, moving its entries to" form is keyed on each action result** | React resets a form after its action; the reset put the controlled replacement select's DOM back on its first category while React still held "A new … category" and showed the name field, so a corrected second submit moved the entries into that first category instead of creating the named one. Remounting the form per result (the codebase's pattern for selects after a failed action) shows the choice again | built |

Added 2026-11-18 (closing the category gaps):

| Decision | Why | Decided by |
|---|---|---|
| A category's kind can be switched expense ↔ income only while no transaction uses it; with transactions the change is refused with the reason | Switching a used category would silently flip the sign of its entries; an unused one is just a mis-filed name | planner |
| The kind change locks the category row (`FOR UPDATE`) and `createTransaction` reads it `FOR SHARE` | Without it an entry could be filed between the usage check and the switch, leaving an expense under an income category (no constraint ties the two kinds) | built |
| The kind change is a one-click "Make it an income category" button with no confirm, under the rename form | Nothing is lost and it is undone the same way; a kind select would suggest it is always possible | built |
| Categories can be archived (`archived_at`, migration `0003_categories-archive`), alongside removal | The owner's original "no hidden state" choice still holds for removal; archiving is the way to stop using a category without moving its history | planner |
| Archived categories behave like archived wallets: out of the entry form's pickers and no new entries (service-enforced), but an entry that already has one keeps it, shown as "Name (archived)" | One rule for both kinds of archive; an edit must never silently change an entry's category | planner |
| `listCategories` leaves archived categories out by default (`includeArchived` opt-in), as `listWallets`; `listCategoriesWithUsage`, `getCategory` and both exports include them | Pickers are the common caller; history, reports and exports must keep everything | built |
| Archived categories are listed after the add row of their kind's card, under "Archived · N", and still count in the spending split | The page stays one list per kind; a month's spending in an archived category is still spending | built |
| Archive / Unarchive have no confirm | One click undoes it and nothing is lost | built |
| An archived category is not offered, nor accepted, as a removal's replacement | Moving entries into it would be new activity on an archived category | built |
| Removing a used category can move its entries to a new category named in the removal form (create + move + delete in one DB transaction); the new name wins if both a name and an existing replacement are sent | Removes the dead end of the only category of its kind; the form only ever sends one of them | planner |
| The new replacement may not reuse the removed category's own name (ignoring case) | It is created before the old one is deleted; renaming is the way to keep the name | built |
| The backup carries `archived` per category (always written, optional on read, version stays 1); an import restores it on categories it creates and treats existing archived categories like archived wallets (new entries are a problem, duplicates skip) | Same contract as archived wallets; old backups keep importing (as active) | planner |
| The "Top category" (Overview insight card) is ranked in JS by one function, `pickTopCategory` (amount, then the lower-cased name by UTF-16 code units, then id), in both the per-currency and the converted view | The SQL `lower()` order depends on the database collation and `localeCompare` on the locale, so the two views could name different categories on a tie | planner |
| *(2026-11-18)* Every category list is ordered in one place, in JS: `sortCategories` / `compareCategoryNames` (`src/lib/category-order.ts`: expense first, active before archived, then the name lower-cased compared by code point, then id); the services sort after the query, and `pickTopCategory`, the spending split and the dashboard's per-category list break ties with the same name rule | Chosen over `COLLATE "C"` on `lower(name)`: Postgres' `lower()` itself depends on the database's ctype for non-ASCII letters, so only JS gives the same order on every instance (and PGlite); category lists are small. Not `localeCompare` either (runtime- and locale-dependent) | planner |
| *(2026-11-18)* After a kind change the row's new card announces it and takes the focus (its heading at once, then the row's button once the refreshed list has it), told by the old card through a window event | The two cards are separate components; focus left on the old card's heading pointed at a list the row was no longer in | planner |

### Budgets and category colours

| Decision | Why | Decided by |
|---|---|---|
| (2026-11-25) A budget is one amount for every month, with no history; a past month is compared with the current amount | Simple to set and to read; a history of amounts is a feature nobody asked for yet | planner |
| (2026-11-25) Budgets are for expense categories only, plus one optional overall budget; the currency is one the user holds a wallet in (archived wallets included); the typed amount goes through `parseAmount(value, currency)` | Income has no "limit"; a currency without a wallet would be a typo | planner |
| (2026-11-25) Progress is always in the budget's own currency over every wallet, each day's spending converted at that day's rate as in the "All in" views (a currency without a rate left out and named); it ignores the page's currency and "All in / only" switches | A budget means one figure; it must not change when the user flips a view switch | planner |
| (2026-11-25) Budgets are account-wide: with a wallet group selected their progress is not shown, one line says they cover all groups | Showing a group's spending against an account-wide limit would be wrong; a per-group budget is a known gap | planner |
| (2026-11-25) Removing a category removes its budget (FK cascade, said in the removal confirmation); transfers never count | A budget of a category that no longer exists means nothing | planner |
| (2026-11-25) Archiving a category keeps its budget, and its row still shows the meter; the budget can still be changed | Archiving is undone with one click and loses nothing elsewhere either; an archived category can still have entries that month | built |
| (2026-11-25) Switching an expense category to income removes its budget in the same DB transaction (`budgetRemoved`), and the row says so before the click and in the success message | The kind change is only possible while nothing uses the category, so nothing worth keeping is lost; refusing the change instead would add a step for no gain | built |
| (2026-11-25) The overall budget is the first row of the expense card ("Overall budget · all spending"), and a category's budget is set in the row's existing editor, under the rename / colour form | The brief asked for the existing inline editor; one place for everything about a category | built |
| (2026-11-25) The meter: "€120.00 of €300.00", "€180.00 left" / "€20.00 over" (danger colour), a neutral fill (`--muted-foreground`, `--danger` once over) and, for the current month, a tick at day N ÷ days with "40% spent · day 10 of 30" under it. The bar is `aria-hidden`; the text says the same | The tick against the fill answers "am I ahead of the month?" without a second colour; a green "on track" fill would read as income | built |
| (2026-11-25) Over means above the limit; reaching it exactly says "Limit reached"; the percentage is rounded down | "100% spent" should not show while there is still a cent left | built |
| (2026-11-25) The Overview's Budgets card sits between the four insight cards and Wallets / Latest: the overall budget and the three category budgets with the largest share spent (ties in the category order), with a link to /categories ("All budgets (N more)" when some are not shown) | Leaves the existing four cards as they were; "closest to or over the limit" = largest share | built |
| (2026-11-25) `getMonthBudgets` takes `convert` from the page: the page's own conversion when it has one (Overview, /categories in "All in"), else `getConversion` for the month when the user holds more than one currency | One conversion per request, no network call for a single-currency account; services never read the clock | built |
| (2026-11-25) Backup: optional `budgets[]` (`category` by name, absent for overall) and an optional `color` per category, version 1. Import only adds: a missing budget is created, an existing one kept (notice `budgets-kept` when it differs); a colour only on categories the import creates. The budget currency need not be held | The contract of the manual rates and groups ("import adds, never changes"); a budget does not depend on a wallet | planner |
| (2026-11-25) A category can have a colour from the wallet-group palette (`GROUP_COLORS`), picked in the row editor (the shared `ColorChoice`, now in `src/components/ui`, with 44px targets for categories; the group forms keep their 32px) and shown as a round dot before the name on /categories, in the entry form's category pills and in the Overview's Budgets card. Not on transaction rows | Another change was touching the transaction rows at the same time; the picker and the dots are where categories are chosen and managed | planner |
| (2026-11-25) The spending split keeps its rank ramp; a category's own colour is never used in the split. The row's ramp swatch is now a small square (as in the split's legend) and the category colour a round dot, so the two never read as the same thing | The palette has a red and an amber that sit next to the ramp's terracotta and orange: used in the split they would be confused with another category's ramp step, and a split of six arbitrary colours would lose the "largest = strongest" reading | built |
| (2026-11-25) The rename form became "name + colour + Save": the success message is "Renamed to …" when the name changed, else "Saved …" | One form per row keeps the editor short; the old "Rename" label no longer fit | built |

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
| (2026-11-18) The Spendee import dates timestamps in **the account's time zone** when it has one, else the browser's (as before), else UTC; the time-zone notice says which zone and where it came from ("your account's time zone, …" / "this browser's time zone, … (set one in Account settings …)" / "UTC (…)") | Closes the "re-import from another zone" gap: with an account zone the dates no longer depend on the browser, so the same files re-imported from anywhere are all duplicates. The account's zone is read by `previewImport` / `runImport` themselves, not passed by the action, so the preview and the write cannot disagree | planner |
| Spendee labels are appended to the note | The app has no labels; this keeps the information and makes it searchable instead of dropping it silently | planner |
| A backup cannot be combined with other files in one import | Its wallets are identified by position in the file, which cannot be merged with other sources | planner |
| `previewImport` / `runImport` take either one file's text (as before) or a list of `{ name, text }`; the existing tests were left unchanged | No mechanical migration of ~60 call sites; one file and a one-element list behave the same | built |
| Spendee transfers are paired on the `Note` cell without labels; the transfer gets the outgoing row's labels, or the incoming row's when the outgoing has none | Labels are per row in Spendee and may differ between the two sides; pairing should not fail over them | built |
| Two candidates at the same distance are only paired when the competing rows are identical (wallet, amount, time, note) — then the result is the same either way; otherwise every row of that group is one blocking problem, which the unpaired option does not cover | "Never guess", without failing on genuinely repeated transfers | built |
| Timestamps without an offset (older dialect) are still used for pairing, read as written; a bare date counts as midnight; `Z` and fractional seconds are accepted | One rule for both dialects; the older export never had transfer rows | built |
| Spendee notices (time zone, labels, rounding, unpaired rows) are counted over the whole selection, not per file; the time-zone notice also says how many entries changed day | Eight near-identical per-file notices would bury the information | built |
| A file selected twice is detected by identical text and listed as "same as …"; a backup in a selection with other files is refused before any file is parsed | Cheap and exact; parsing the rest would only add noise to a refusal | built |
| Toggling the unpaired-transfers option re-runs the preview at once; choosing other files resets it to off | The option changes what is imported, so the preview must always match it | built |
| (2026-11-18) Spendee dates stay in the browser's time zone; taking "the date as written in the file" was built and reverted | Investigated: Spendee writes every time as `+00:00`, so the file has no local zone and "as written" means the UTC date: an entry made just after local midnight east of UTC (the owner is in one) would land on the previous day. Determinism across browsers is not worth that; the real fix is a per-account time zone (built the same day, see the row above) | planner (finding: built) |
| The native CSV carries wallet details as **wallet rows** (`type` = `wallet`; `amount` = initial balance, `group`, `archived` date) plus two optional columns `group` and `archived`, rather than per-row initial-balance columns | A wallet's details are said once, not repeated on every entry; old files (no new columns, no wallet rows) import unchanged; the Statement Importer's CSV needs no change. An older app rejects a file with wallet rows ("not a type") — accepted | planner (design: built) |
| A CSV `group` cell names the group of the row's `wallet` (not `to_wallet`); the receiving wallet's group comes from its own rows or wallet row | One group per wallet, one column; transfers into a new wallet usually also have a wallet row in an export | built |
| Wallet rows and `group` cells only apply to wallets the import creates; an existing wallet is never changed (its wallet row is ignored, silently) | "Import adds, never changes" | built |
| A second, different group for one wallet, or a second wallet row for it, is a problem; across the files of one selection the first file's details win and a disagreeing file is a problem | Never guess which one is meant | built |
| The CSV export writes wallet rows for every wallet the rows use, and for every wallet in scope (unused ones too) when no filter other than wallet / group is set; same-named wallets of one currency share one row with their initial balances summed, archived only when all are | A filtered export should still restore its wallets correctly; the CSV merges same-named wallets, so the sum keeps the merged balance right | built |
| The CSV `archived` cell is a date (`YYYY-MM-DD`, exported from the UTC date), imported as 00:00 UTC; the backup carries the full `archivedAt` timestamp (optional; older files archive as of the import) | A date survives a spreadsheet; the backup stays lossless | built |
| The context export carries each wallet's `group` (optional in its schema, version stays 1) | Companion tools can group wallets; old readers ignore the field | planner |
| A Spendee transfer row with its own problem suppresses the "unpaired" problem of a row that could have been its partner (opposite direction, other wallet, same note, ≤ 10 s, same amount in one currency; unknown fields match); one broken row covers at most one leftover | One mistake, one problem. Hiding a genuine "unpaired" behind a broken row is harmless: the import is blocked anyway and the next preview shows it | built |
| After a quoting error the CSV reader drops that record and resyncs on the next physical line (after the broken quote's line); a broken header still stops the file | Shows every problem in one preview; a resync can misread a few lines after a quote that was meant to span lines, but those lines are reported too, never imported silently | built |
| Zip uploads are unpacked in the Server Action with `fflate` (new dependency, MIT, pure JS); zips are recognised by content; unpacked size counts towards the 5 MB, checked on the declared sizes before inflating | Spendee users can upload one archive; the declared-size check refuses zip bombs without inflating them | planner (library: built) |
| An oversized upload is answered by `src/proxy.ts` (only `/data` Server Action POSTs, by `Content-Length`) with a `text/plain` 413 carrying the app's message, which the Next.js client turns into an Error the panel shows | Next.js refuses an over-limit body before the action runs, and its refusal reaches the browser as a generic error; this is the one place the app can speak first. Requests without `Content-Length` still get Next's generic refusal | built |
| The preview/confirmation mismatch is reported by the panel comparing the confirmed counts with the preview it showed, not by sending the preview to the server | Purely informational and the panel already has both; the server still never trusts the preview | built |
| The importing guide is a user doc, `docs/IMPORTING.md`, linked from /data's "What can be imported" (to GitHub, since the app serves no docs) and from the README | The SPEC is a build contract, not something to send a user to | planner |
| **Deliberate:** no in-app bank-statement / column-mapping importer | The Statement Importer artifact (`docs/STATEMENT-IMPORTER.md`) turns statements into the native CSV; an in-app mapper is a much larger feature | planner |
| **Deliberate:** Spendee variants that have not been seen (other locales or date formats, transfers to a wallet outside Spendee, the older single-file export with transfers) are not supported specially | No sample files exist; guessing their shape would add rules nobody can test. Unknown shapes are reported as problems, never guessed | planner |
| *(2026-11-18)* The CSV gets a `category` row type (name in `category`, a new optional `kind` column, `archived` = date); the export writes one per archived category its rows use; an import applies it only to categories it creates (an unused described category is created too) | Mirrors the wallet rows: a CSV round trip keeps a category archived (and when), old files import unchanged, "import adds, never changes". A `kind` column was preferred to overloading `type` (`expense-category`) or another cell; active categories need no row, so ordinary exports barely change | planner |
| *(2026-11-18)* The backup carries `archivedAt` per archived category (optional, version stays 1) and restores it, as for wallets; two categories merged by case keep the later date | The import used to archive restored categories as of the import | planner |
| *(2026-11-18)* The backup carries the user's manual exchange rates (`manualRates: [{ currency, base, effectiveDate, rate }]`, rate as the stored decimal string; optional, version stays 1); an import adds those the account lacks by currency + date and keeps an existing one (a notice when it differs); the currencies need not be held | Restoring onto another instance no longer loses them; additive like everything else; a rate for a since-deleted wallet's currency is harmless and must not make the account's own backup unimportable | planner |
| *(2026-11-18)* The context export flags archived categories (`archived`, optional in its schema, version stays 1), and the Statement Importer leaves them out (counted in its preview, like archived wallets) | The importer could suggest an archived category, which the CSV import then refuses | planner |
| *(2026-11-18)* An import treats an existing wallet of an archived group as archived (new rows are a problem naming the group; duplicates skip); a wallet the import creates is never so treated, even in an existing archived group | Same rule as the entry services; a created wallet's rows are a restore, as for wallets created archived | planner |

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
| *(2026-11-18)* The artifact skips a category with `archived: true` in the tracker file (context or backup) and counts it in the preview ("N archived categories left out.") | The smallest change: the same rule it already had for archived wallets; older files without the flag read as before | planner |

### Database: SQLite to PostgreSQL

Decided 2026-11-09.

| Decision | Why | Decided by |
|---|---|---|
| The app supports **PostgreSQL only**; SQLite support is removed, not kept alongside | One database to build, test and document; the app is meant to be hosted for a household, where a real server is normal; keeping two dialects would double every query and migration | owner |
| **Deliberate: no migration of existing SQLite data** (no in-place upgrade; also listed as a known gap until 2026-11-18): no importer, no converter. An old instance's way across is each account's JSON backup export from the old version, imported into the new one (wallets, categories, transactions and transfers come over; the account itself and its password do not) | The owner has no instance worth converting and wanted a fresh start; the backup format already round-trips an account's data | owner |
| Tests run on **PGlite** (Postgres compiled to WASM, in process), not on a real server | `npm test` and CI keep needing no Docker and no database service, and the tests still run Postgres SQL and constraints | owner |
| Driver is **node-postgres** (`pg`, a `Pool` of 10) with `drizzle-orm/node-postgres`; the `DB` type is Drizzle's generic `PgDatabase`, so PGlite instances fit it too | The standard driver, pure JavaScript (no native module, so the image needs no per-platform steps) | planner |
| All services are **async**, and `getDb()` is a **memoized promise** on `globalThis` that connects and migrates once; a failed attempt clears it so the next call retries | Postgres drivers are asynchronous; sharing one promise stops concurrent first requests from migrating twice, and `globalThis` survives dev hot reload | planner |
| Money columns are **`bigint` in `mode: "number"`** | SQLite integers were 64-bit; `integer` in Postgres is 32-bit and would cap amounts (a 0-decimal currency reaches it quickly). Aggregates (`sum` returns numeric, `count` bigint) are mapped to `number` | planner |
| Timestamps are **`timestamptz`** (`mode: "date"`, `created_at` defaults to `now()`); calendar dates stay **`text`** `YYYY-MM-DD` | Real instants need a time zone; a calendar date is not an instant, and string compare semantics are what the code and the tests already rely on | planner |
| One fresh `0000` Postgres migration replaced the three SQLite ones | With no data to carry, a clean schema is simpler than translating table rebuilds that only existed for SQLite's limits | planner |
| The Compose files run **`postgres:17-alpine`**, pinned to a major | A major bump needs a dump and restore; a floating tag would break the volume on pull | planner |
| **Deliberate:** the default database password is `expenses` (`POSTGRES_PASSWORD` overrides it) because the database port is **not published**; anyone who publishes it must set a password (was a known gap until 2026-11-18) | `docker compose up -d` with no `.env` has to keep working; the database is reachable only from the Compose network. Documented as "set `POSTGRES_PASSWORD` in `.env`" | planner |
| Development uses Postgres in Docker (`compose.dev.yaml`, `npm run db:up`); `npm run dev` is on database `expenses` (the owner's real data), the demo on `expenses_demo` | Same safety split as the SQLite files had (`app.db` / `demo.db`); the reset's `--yes` rule now guards `DEFAULT_DEV_DATABASE_URL` | planner |

### Deployment

| Decision | Why | Decided by |
|---|---|---|
| Docker is the deployment target; no dependency on Vercel or any hosted platform | The owner runs a homelab and wants anyone to be able to self-host | owner |
| *(superseded 2026-11-09 by Postgres)* Image on `node:24-bookworm-slim`, three stages, runs as the non-root `node` user (uid 1000), data on a `/data` volume | glibc base so the native SQLite module's prebuilt binaries work on amd64 and arm64; least privilege | planner |
| *(superseded 2026-11-09 by Postgres)* `npm ci --ignore-scripts` in the image | The slim image has no compiler toolchain, and the native module ships prebuilt Linux binaries | built |
| Health check uses Node's `fetch` against `/api/health` | No curl or wget needed in the image | built |
| The nginx example in `docs/SELF-HOSTING.md` passes `Host $http_host`, not `$host` (2026-11-18) | Checked behind a real nginx: `$host` drops the port, so on any port but 80 / 443 the browser's `Origin` (`host:port`) never matches and every form gets the "Request refused" 403. `$http_host` is what the browser sent, port included, and works on the default ports too | built (ops verification) |
| All runtime configuration is environment variables | Standard for containers; nothing to bake into the image | planner |
| A prebuilt multi-arch image on GitHub Container Registry, published by GitHub Actions, is the default way to deploy; building from source stays supported | "It should be easy to deploy with docker": downloading one Compose file beats cloning and a several-minute build, and arm64 users (Raspberry Pi) get an image without building on the device. GHCR needs no extra account or secret (`GITHUB_TOKEN`) | owner asked for an easier Docker deploy; registry chosen by planner |
| `latest` follows `main`; releases come from `vX.Y.Z` tags | The owner deploys `main`; self-hosters who want control pin `EXPENSES_TRACKER_VERSION`. Tags are cut with `make release` (below) | planner |
| arm64 is built under QEMU on one runner, not on a native arm64 runner | Works for private and public repositories alike; slower (the `next build` under emulation), but only CI time | planner |
| `deploy/compose.yaml` is configured from `.env`, not edited, and shares the project name `expenses-tracker` | Upgrading can re-download the file without losing settings; moving between source build and prebuilt keeps the same volume | planner |
| **Deliberate: CI only on GitHub, images only on GHCR** (no other CI, no Docker Hub mirror) | GitHub Actions and GHCR need no extra account or secret (`GITHUB_TOKEN`); a second CI or registry would be more to keep working for no current user. A fork can add a mirror (`EXPENSES_TRACKER_IMAGE` already points Compose elsewhere) | planner (2026-11-18) |
| Published images carry BuildKit SBOM and provenance attestations (`sbom: true`, `provenance: mode=max`) and a keyless cosign signature (GitHub OIDC, `id-token: write`); pull-request builds have neither | Keyless signing needs no key to store or rotate and is one step; the SBOM and provenance come from BuildKit for free. On pull requests nothing is pushed, so there is nowhere to keep them | planner (2026-11-18) |
| `sharp` (and `@img/*`, `detect-libc`, `semver`, which only it uses) is deleted from `.next/standalone/node_modules` in the Dockerfile's build stage, not excluded in `next.config.ts` | `outputFileTracingExcludes` was tried: it applies to route traces, while sharp comes from Next's own `next-server.js.nft.json`, so it had no effect. The image's `/app` went from 45 MB to 26 MB and the server starts and migrates without it. A non-Docker standalone build still carries it (documented as safe to delete) | built (2026-11-18) |
| `npm run build` / `start` go through a small `scripts/next-production.mjs` that sets `NODE_ENV=production` and runs `next`, instead of `cross-env` | Works in Windows `cmd` with no new dependency. The dev-only scripts with an inline `DATABASE_URL` (`dev:demo`, `demo:reset`) were left as they are at first; now they use `scripts/with-demo-db.mjs` (below) | planner (2026-11-18) |
| `dev:demo` and `demo:reset` run each step through `node scripts/with-demo-db.mjs <command…>` (was a known gap), which sets `DATABASE_URL` to `expenses_demo` and replaces an inherited one; the only override, `DEMO_DATABASE_URL`, is refused unless its database is `expenses_demo` | Runs in Windows `cmd` like `next-production.mjs`, and keeps the guarantee that the demo scripts can never reach `expenses`: no environment, exported or not, can point them elsewhere. The override exists for a dev Postgres on another host or port. `tests/ops.test.ts` checks that no npm script sets a variable inline | planner (wrapper), built (override) |
| **Backups can be scheduled by the `backup` service itself** (was a known gap): `BACKUP_INTERVAL_HOURS` unset → one-shot as before; set (1–999) → dump, prune, sleep in a loop, started with `docker compose --profile backup up -d backup`. A failed dump is logged and retried next interval; SIGTERM stops it at once | No extra image or cron sidecar; the same script as the one-shot run. Supersedes the "not a scheduler" part of the on-demand backup row. Retrying instead of exiting keeps one bad night from ending the schedule | planner (2026-11-18) |
| The scheduled backup keeps `restart: "no"`, so a reboot or Docker restart ends the loop until `up -d backup` is run again; documented, with host cron as the alternative | One service serves both modes: with `unless-stopped`, a `--profile backup up` without the interval would back up, exit, restart and back up again without end. A second service or a restart-policy variable was more than the gap asked for | built |
| **Backups are an on-demand Compose service**, `backup` under its own profile (`docker compose run --rm backup`), writing `pg_dump -Fc` files to a bind-mounted `./backups` and keeping the newest `BACKUP_KEEP` (default 10); not a scheduler and not a step the app runs | A dump needs a `pg_dump` of the server's major, which the app image does not have; a sidecar with cron would be one more always-on container for what the host's cron does with one line. A bind-mounted folder is where people look for files to copy off the machine. Retention only prunes `expenses-*.dump`, so dumps written for other reasons stay | owner asked for a backup before upgrades; planner (form) (2026-11-18) |
| The backup files are written by the container's root user (mode 600) rather than a configurable uid | A dump holds every account, password hashes included, so readable only by root is the safe default; a uid setting would also need the folder pre-created with that owner. On Docker Desktop they belong to the user anyway | planner (2026-11-18) |
| Before migrating, the app logs the pending migrations, as a `console.warn` `[db] WARNING: ...` when the database already has migrations; it does not refuse to start without a backup | The app cannot tell whether a backup was taken; refusing would block every first start after `docker compose pull`. The line makes the step visible in `docker compose logs`, and the upgrade docs put the backup before the pull | planner (2026-11-18) |
| **A Postgres major upgrade is `deploy/pg-major-upgrade.sh`**: fresh verified dump, a Compose override file (`compose.override.yaml` / `docker-compose.override.yml`) putting `db` and `backup` on the new image and a **new** volume `pg-data-<major>`, restore, row counts compared; the old volume is never touched and any failure starts the old setup again | Compose loads the override by itself, so the shipped Compose files stay as they are and a re-downloaded `deploy/compose.yaml` keeps working. Making the image and the volume name variables in the Compose files was considered and rejected: a volume `name:` built from `${COMPOSE_PROJECT_NAME}` works on current Compose, but a Compose that does not provide that variable would silently open an empty `_pg-data` volume. `PGDATA=/var/lib/postgresql/data` is set in the override because the 18+ images default to another path. Bash only (self-hosters run Linux; Windows users have WSL) | planner (2026-11-18) |
| **Releases: `make release VERSION=X.Y.Z`** runs `scripts/release.mjs`: on a clean `main` equal to `origin/main`, `X.Y.Z` newer than the last tag, checks passing; bumps `package.json`, moves `CHANGELOG.md`'s "Unreleased" into the release (or the commit subjects since the last tag when it is empty), commits, tags; pushes only with `PUSH=1` (atomic push of `main` and the tag); `DRY_RUN=1` changes nothing | A script so that the tag, the version and the changelog cannot drift apart; Node, so it also runs on Windows without `make`. Equal to `origin/main` (not just "not behind") so the tag always lands on a commit that is on `main` upstream. No pre-release versions: the semver image tags would make `X.Y` follow them | owner asked for a release process; planner (rules) (2026-11-18) |
| `CHANGELOG.md` was seeded with one short "Unreleased" summary of everything built so far, not one entry per past commit | There were no releases to attach entries to; the first `make release` turns the summary into that release's section | planner (2026-11-18) |
| In development, the machine's own LAN addresses (plus `ALLOWED_DEV_ORIGINS`) may load the dev server's scripts | Next.js allows only `localhost` by default; opened at a LAN address the app rendered but nothing client-side worked (the owner hit this: "Preview import" could not be pressed). Development only — production builds are unaffected | planner |
| **Installable on a phone's home screen (2026-11-25)**: a web app manifest (`src/app/manifest.ts`, "Expenses", `display: standalone`, `start_url` `/`), 192 / 512 px icons plus a maskable 512, a 180 px `apple-touch-icon`, the Apple web-app meta tags; `themeColor` for light and dark was already there | The app is used on phones (the Add dialog is a bottom sheet) but opened from a home screen as a plain bookmark with a screenshot icon and browser chrome | planner |
| **Deliberate: no service worker and no offline mode (2026-11-25)** | Every page is per-user data rendered on the server from the session cookie; a cached page would be another user's or a stale balance, and offline entry would need a sync and conflict story. A manifest alone is enough to install (Chromium no longer requires a service worker) | planner |
| The icons are committed PNGs in `public/` (`public/icons/`, `public/apple-touch-icon.png`), rendered from the brand mark by `scripts/generate-icons.mjs` with Playwright's Chromium (already a devDependency); not `icon.tsx` / `ImageResponse` routes | Static files need nothing at runtime and cannot break in the image (no `sharp`, which the Dockerfile deletes, and no build-time rendering step). The manifest route is static (`○` in the build output). The cost: the PNGs must be regenerated by hand when the brand mark changes (`docs/DEVELOPMENT.md`) | built |
| Icon design: "any" icons are the rounded accent tile with transparent corners, as in the app; the maskable and apple-touch icons are full-bleed accent (opaque) with the same glyph proportions as `BrandMark` (16/28 of the tile). Light-theme colours (`#BC522C`, white glyph) in both schemes | Launchers cut maskable icons to their own shape and iOS rounds the apple-touch icon and fills transparency with black, so those two must be square and opaque. At 57% of the tile the glyph's corners sit at ~29% from the centre, inside the maskable 40% safe circle. Home-screen icons cannot follow the colour scheme reliably | built |
| iOS standalone: `apple-mobile-web-app-status-bar-style` is `default`, and the viewport has no `viewport-fit=cover`; the top bar was left as it is | With `default` the page starts below the status bar, and without `viewport-fit=cover` the safe-area insets are zero (iOS letterboxes landscape), so nothing sits under the notch or the home indicator; the Add button and the bottom sheet already use `max(…, env(safe-area-inset-bottom))`. `black-translucent` / `cover` would need `env(safe-area-inset-top)` padding on the sticky top bar; not worth it for a few pixels of colour | built |
| The manifest's `theme_color` is Sand's `--surface` (`#FFFCF7`, the top bar) and `background_color` Sand's `--background` (`#F4EFE7`, the launch screen) | A manifest has one colour each; the per-scheme `<meta name="theme-color">` tags (Sand / Graphite surface) take over once a page loads. A dark-mode phone sees a light launch screen for a moment | built |
| **Dependency updates: Dependabot (`.github/dependabot.yml`, 2026-11-25), monthly and grouped**: npm in two groups (`next-react`: `next`, `eslint-config-next`, `react`, `react-dom` and their types, majors included; `minor-and-patch`: everything else), other majors one PR each, a 7-day cooldown on npm; GitHub Actions in one group; the Dockerfile's base image | Quiet enough for a one-person project; `next` and `eslint-config-next` are pinned to the same exact version and must move in one PR. Each PR runs the Docker image and E2E workflows | planner |
| `@types/node` majors are ignored by Dependabot | The types follow the Node major the app runs on (`node:24` in the Dockerfile and both workflows), which is changed by hand together | built |
| The Dockerfile's `ARG NODE_IMAGE` + `FROM ${NODE_IMAGE}` became a literal `FROM node:24-bookworm-slim AS base` stage the other stages start from | Dependabot's Docker parser does not resolve build arguments, so it would never have seen the image. Nothing used the argument (no workflow or doc passed `--build-arg NODE_IMAGE`). The floating `24-bookworm-slim` tag stays: rebuilds pick up Node 24 and Debian patches, so Dependabot only proposes a new Node major; an odd (non-LTS) one is closed, which makes Dependabot skip that version. The workflows' `node-version: 24` is not bumped by Dependabot and moves with it by hand | built |

### Development tools and documentation

Added 2026-11-08.

| Decision | Why | Decided by |
|---|---|---|
| **Deliberate: `db:reset` is development-only.** It refuses with `NODE_ENV=production` and is not in the Docker image | A reset is one typo away from losing every account; on a deployed instance "start over" is a backup and `docker compose down -v`, which says plainly what goes | planner (2026-11-18, was a known gap) |
| The development Postgres listens on host port **5433** (`127.0.0.1:5433`, still 5432 inside the container); `DEFAULT_DEV_DATABASE_URL`, the npm scripts and `drizzle.config.ts` follow | The owner runs billy alongside, whose dev Postgres publishes 5432; both have to run at the same time (2026-11-17). Deployment is unaffected: there the database is reached as `db:5432` on the Compose network | owner |
| A `Makefile` of short aliases (`make dev`, `make check`, `make test FILE=… NAME=…`, …) over the npm scripts, modelled on the owner's other project (billy); `make dev` uses the demo database, the real one only via `make dev-real` | The owner asked for less typing when testing; the npm scripts stay the source of truth, so nothing works only through make (2026-11-17) | owner (ask), planner (targets) |
| *(superseded 2026-11-09 by Postgres)* `npm run db:reset -- --demo \| --clean` deletes every row (keeping the file and the migrations table) instead of deleting the database file | A running dev server holds the file open and keeps working; migrations are not re-run | planner |
| *(superseded 2026-11-09 by Postgres)* The reset writes `<file>.before-reset-<YYYYMMDD-HHMMSS>.bak` of a non-empty database first (`--no-backup` skips it) and refuses with `NODE_ENV=production` | A reset is one typo away from losing real data; the command is a development tool | planner |
| *(superseded 2026-11-09 by Postgres)* **`--yes` is honoured only with an explicit `DATABASE_URL` on the command; the default `data/app.db` always asks, and the answer must be the word `reset`** (not `y`). No terminal and no usable `--yes` → refuse | An agent wiped the developer's real database through a broken shell chain: a failed step before the command left `DATABASE_URL` unset, so the default file became the target. A `--yes` that reaches the default file by accident must not be able to wipe it | planner |
| The dev server prints `[demo] Sign in with user ID demo / password demo-password (if unchanged)` once, when it opens the database and a `demo` user exists; never in production. The seed and reset print the same line | The demo login was only in the README; this puts it where the developer is looking. The database opens lazily, so the line appears on the first request rather than at boot | planner (line), built (timing) |
| *(superseded 2026-11-09 by Postgres)* Demo mode runs on its own file: `npm run dev:demo` seeds `data/demo.db` if needed and serves it; `npm run demo:reset` restores it without a prompt (`--yes` is allowed because `DATABASE_URL` is set inside the script) | Demo mode runs on its own file so it can never replace real data | planner |
| README cut to a five-minute path (run, debug, scripts, compose quick start, env vars, pointers); long-form operations moved to `docs/SELF-HOSTING.md` | The README had grown to 368 lines, mostly operations detail most readers never need | planner |
| In "Run it" and "Debugging", every command is its own one-line `bash` code block with the explanation in a sentence above, no trailing `# comments` | The owner reads the README in an app that puts a Run button on each single-line block; multi-line blocks with comments render badly there. This took the README to about 170 lines instead of the ~120 aimed for | owner (format), built (length) |
| The README has a short "Development" section with the everyday `make` commands (dev, check, test, test-e2e, watch, demo-reset, down), one-line blocks; everything else stays in `docs/DEVELOPMENT.md` | The owner wants them runnable straight from the README (2026-11-17); this relaxes the earlier "no dev commands in the README" rule for these only | owner |
| The env var table lives only in the README; `docs/SELF-HOSTING.md` links to it | One table cannot drift from another | built |
| The user-facing import details (Spendee pairing, time zones, labels, rounding, limits) are no longer repeated in the README; it links to `docs/SPEC.md` → Import / export, which already held every one of them | Avoids a third copy; the nginx upload-limit note moved to the reverse-proxy section of `docs/SELF-HOSTING.md` | built |
| **End-to-end browser tests (2026-11-18): Playwright, Chromium only, against a production build (`.next/standalone/server.js`) on a throwaway Postgres** (`compose.e2e.yaml`, port 5434, tmpfs, torn down after every run; CI: a service container, `.github/workflows/e2e.yml`). Seeding calls the services in the test process, one user per test; `EXCHANGE_RATES=false`; desktop 1280px + phone 375px projects; any console error fails a test | The "Not verified" list had grown to mostly UI behaviour only a real browser shows (focus, popover placement, form resets, overflow). A production build is what self-hosters run (dev mode differs: StrictMode double effects, no minification). Chromium only keeps CI fast and the install small; Safari / Firefox and real touch / screen readers stay manual. The e2e database is never the dev one: the config refuses a name without `e2e` and port 5433 | planner (ask), built |
| README reduced to a landing page (2026-11-10): what the app is, the Docker quick start, a self-hosting pointer and links. "Run it", "Debugging", "Scripts" and "Layout" moved unchanged to `docs/DEVELOPMENT.md`; the import/export, statement importer and accounts paragraphs were dropped because `docs/SPEC.md`, `docs/STATEMENT-IMPORTER.md` and `docs/SELF-HOSTING.md` already hold them. Supersedes the "five-minute path" README above; the one-line `bash` block rule now applies to `docs/DEVELOPMENT.md` | The owner found the README had too many commands and wants only a quick Docker start, a short description and the self-hosting pointer there | owner |

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
| /transactions redirects a URL with any empty query value (`?q=`, `?wallet=`) to the same list's clean URL (`hasEmptyParams` → `listHref`) | The no-JS search and filter forms post every field; normalising on the server keeps one URL per view without scripts, and the forms need no special-casing | planner (2026-11-18) |
| Without JavaScript the /transactions filters are a `<noscript>` GET form of native selects (Month · Wallet · Type · Category, "Apply"); the popover chips are hidden then (`data-needs-js`), the Month chip and its ‹ › links stay | Keeps the JS chips exactly as they are; one small form instead of a second set of disclosures. The month select offers next month, the current one, the 24 before it (plus an older month in view) and All time; choosing applies to the month and drops a selected day or range | planner (2026-11-18) |
| Day-strip bars as links tile their row (no grid gap; the 2px / 5px gap is drawn inside each link) and span the full bar-row height. At 375px a hit area is about 10 × 48px (72px tall rows only add the cap label above). Below `sm` a native `<details>` "Pick a day" opens a Monday-first calendar of 44 × 44px day links (same hrefs and labels; a dot marks spending) | 31 columns cannot each be 44px wide on a phone; a calendar of the same links is the comfortable path, works without JS and adds no state | planner (2026-11-18) |
| Opening a list row moves focus to the first control of its form (the Expense / Income switch's checked option; for a transfer, From). When the row holding the focus leaves the list (Delete, or a Save that moves it off the page or month) focus goes to the same row if it reappeared (moved to another day), else the next row, else the previous, else the list heading (`[data-list-heading]`, else the page's `<h1>`), with a polite announcement ("Expense deleted. Focus is on the next entry.") | The first control rather than the amount: Tab order then matches the form, and a phone does not open its keyboard on every row tap. The announcement uses a live region outside React so it survives the list unmounting when the page empties | planner (2026-11-18) |
| A capped day's label pill follows its bar: muted (`bg-border-strong`) while another day is selected; on the wallet chart coloured by direction, In `bg-income` / Out `bg-expense` with `text-surface` | One colour story per day; `text-surface` gives the right polarity in both themes (light text on the light theme's dark tokens, dark text on the dark theme's light ones) without new tokens | planner (2026-11-18) |
| `getWalletMonth` returns `projectedDays` (day N+1 to the month's end, the balance carried through the future-dated entries) next to `days`; the wallet page labels such a day "Balance after €… · projected". The charts still stop at today | The day header then always has its balance; a separate field keeps every chart, card and summary that reads `days` unchanged | planner (2026-11-18) |
| A popover opens above its anchor only when it does not fit below **and** there is more room above; the room is measured inside every clipping ancestor (the dialog body), not just the viewport; no portal still | Below stays the default so menus do not jump around; inside the Add sheet the calendar was clipped by the scrolling body, which the viewport alone does not see. A portal would have needed its own focus and outside-click handling | planner (flip), built (clipping ancestors) |
| The date picker's way back from the month view is a "‹ Back to days" button in the footer, in the date picker only (not in the shared `MonthGrid`) | The footer is where the picker's other actions are, and it comes after the grid in Tab order; the dashboard's month switcher has no day view to return to | planner (button), built (placement) |
| A negative starting balance is entered with a "±" toggle button inside the amount box; the input keeps `inputMode="decimal"` | iOS Safari's decimal pad has no minus key and no `inputmode` value gives a numeric pad with one: `numeric` has none either, `text` brings the full keyboard for an amount that is nearly always positive, and `type="number"` rejects "1.234,56" and comma decimals and changes the value on scroll. A toggle works the same on every platform; a tap does not take focus, so the keyboard stays up | planner (toggle), built (why not an input mode) |
| The bottom sheet closes on a drag down from its handle or header (more than a third of its height, or a fast flick of at least 24px); the body is not a drag area | Dragging from the scrolling body would fight its scroll (and pull-to-refresh); handle + header is what sheet UIs use. The drag is a pointer-only shortcut, so the handle stays `aria-hidden`; ✕ and Escape remain the accessible ways to close | planner (gesture), built (thresholds) |
| Length messages say "Keep the name to N characters or fewer." (names: categories and groups 40, wallets 60; notes 500), in `normalizeName` / `normalizeNote`, the wallet form schema and the entry form schema | "under 40" read as 39 while 40 is allowed; matches the first name / surname wording | planner |
| *(2026-11-18)* Without JavaScript the /transactions Month chip's popover button is hidden like the other popover chips and a `<noscript>` link with the same label jumps to the no-JS filter form's Month select (`#no-script-month`) | The label looked like a button that did nothing; the ‹ › links keep working, and the form below is where a month is chosen without scripts. With scripts nothing changes | planner |
| **Fix (2026-11-18, found by the e2e suite): pickers focus their first item with `preventScroll`** (date picker days, month grid, the /transactions filter chips' options) | On open the focus ran before the Popover had re-placed itself above a trigger near the bottom, so the browser scrolled the page to the panel's first, below position and the panel never flipped | built |
| **Fix (2026-11-18, found by the e2e suite): the charts' screen-reader day tables are hidden by an `sr-only` wrapper, not by `sr-only` on the `<table>`** | A table does not shrink to the 1px width: on the wallet page with a long wallet name the hidden table was 470px wide and the page scrolled sideways at 375px | built |

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
| *(superseded 2026-11-25: it is now the user's today, `todayInZone(user.timeZone)`, still passed to the form)* "Today" is the server's date, passed to the form | The form renders on the server first; a browser in another time zone would otherwise disagree with the server's default date and cause a hydration mismatch | built (step 6) |
| Sent and Received sit side by side from `sm` up and stack below it | Two 44px inputs with their currency codes do not fit side by side in a 375px sheet | built (step 6) |
| "Manage categories" is a dashed pill after the category pills, not a link in the heading row | Keeps the Tab order amount → categories → wallet that the spec asks for | built (step 6) |
| The entry form creates a category in place ("+ New category", a Server Action called from a transition, not a nested form) and "Manage categories" saves a sessionStorage draft that the next form with the same key restores once | Leaving the form to add a category lost what was typed. Forms cannot nest, so the creator's field has no `name` and posts nothing with the entry. The draft covers the remaining trip to /categories (rename, remove) | planner |
| `createCategoryFromEntryAction` lives in `transactions/actions.ts`, not `categories/actions.ts`; it revalidates the whole layout like the other category actions | It is the entry form's action (its own result shape with the new category); category names show on every page | built |
| The draft key is shared by the Add dialog and the Add page (`new`); edit pages use `edit-<id>`, the inline editor its id prefix; a draft older than an hour, or with a wallet or category that is gone, is dropped (whole or per field) | "The same form" for a person is "Add", wherever it opens; an edit draft must not land in another entry. sessionStorage is per tab, so another tab never picks it up | built |
| Switching between Transfer and Expense / Income carries the typed amount and note into the new inputs; Received is not carried | The amount input is a different element per kind; the date was already state. Received has no counterpart on the other side | planner (amount), built (note) |
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
| *(superseded 2026-11-09 by Postgres)* Migration `0002` rebuilds `wallets` by hand and gives each user a `Personal` group; a wallet with a missing owner makes it fail and roll back instead of being dropped | `ALTER ... ADD NOT NULL` cannot work on a populated table; losing a row silently is worse than refusing to start (the pre-migration copy exists) | built (step 1) |
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
| *(2026-11-18)* Groups are ordered by a `position` column; new groups go last; Move up / Move down buttons swap with the neighbour of the same archived state; migration `0001` back-fills 1..n by name ignoring case | Keeps today's order on upgrade; buttons (not drag and drop) work without JavaScript and by keyboard; active and archived groups are shown apart, so each list is ordered on its own | built |
| *(2026-11-18)* Group colour: optional, one of six palette tokens (`--group-red` … `--group-violet`, light and dark in `globals.css`), checked in the service, not in the database; shown as a decorative dot next to the name | Same theme-token rule as every other colour; a fixed palette keeps the dots legible in both themes; without a DB check a palette change needs no migration (unknown values read as none) | built |
| *(2026-11-18)* No colour dot inside the wallet pickers or the switcher's options | Native `<option>` / `<optgroup>` cannot hold one, and the expense / income pills already carry the group as text; the switcher shows the selected group's dot in front of the select | built |
| *(2026-11-18)* An archived group's wallets count as archived where archived wallets are hidden (active lists, Overview balance and month totals, entry pickers, wallet page add buttons) but their history keeps counting where an archived wallet's does (Transactions, insights, category usage, exports) | The planner proposed leaving them out of every "All groups" total and list; that would make archiving a group change past totals, which contradicts "groups do not change any balance or total rule" and the archived-wallet rule (history stays). Treating them like archived wallets is the least surprising reading and needs no change to the transaction, insight or category services | built |
| *(2026-11-18)* An archived group leaves the switcher and the group pickers; a selected scope or `selectGroupAction` naming one means All; a wallet cannot be created in or moved into one (the edit form still offers the wallet's own archived group); an import cannot target one | The planner's proposal; mirrors "archived wallets are hidden from pickers" and keeps a stale cookie harmless | built |
| *(2026-11-18)* The last unarchived group can be neither archived nor deleted; an empty archived group can always be deleted; the default group is the oldest unarchived one | There is always somewhere for a new wallet to go and something for the switcher-less interface to show | built |
| *(2026-11-18)* The services do not refuse new entries on a wallet whose group is archived (only the pickers stop offering it) | SPEC: "nothing else about a transaction depends on the group"; changing the transaction / transfer rules is outside the groups area and the UI already prevents it | built |
| *(2026-11-18)* Archived groups are shown (with All) in a closed "Archived groups" `<details>` on the Wallets page with their wallets, Unarchive and Delete when empty; the Groups card lists only unarchived groups | Same pattern as the "Archived" wallets list (renaming one in place was added later the same day, see below) | built |
| *(2026-11-18)* The backup gains an optional top-level `groups: [{ name, color, archived }]` in display order; an import creates every listed group the account lacks (empty ones too), after the account's own groups, and never changes an existing group | Round-trips order, colour and archived state without a version bump; old files still import; "import adds, never changes" | built |
| *(2026-11-18)* An archived group can be renamed and recoloured without unarchiving it: an Edit toggle in its row of the "Archived groups" section opens the Groups card's form (the service always allowed it) | Unarchiving just to rename showed it in the switcher meanwhile; one form for both lists | planner |
| *(2026-11-18)* The entry services refuse new entries (and moving an entry) onto a wallet whose group is archived, exactly as onto an archived wallet; an entry already on it keeps it when edited | Before, only the pickers hid such wallets; the rule now holds for every caller | planner |

### Process

| Decision | Why | Decided by |
|---|---|---|
| The main session plans and reviews; implementation is delegated to Opus agents working from `docs/SPEC.md` | The owner asked for this split | owner |
| Tests use synthetic data only; checks against the owner's real Spendee exports during the build ran against an in-memory database, and nothing from them was copied into the repo, tests or fixtures | It is personal financial data | planner |

---

## Next steps

The to-do list, in the order worth doing (written 2026-11-18, after v0.1.0 was tagged). Tick or remove an item when
it is done; the details of each gap are under "Known gaps" below.

**Finishing the v0.1.0 release**

- [x] The `v0.1.0` workflow run is green and `ghcr.io/xalert/expenses-tracker` carries `0.1.0`, `0.1` and `0`
  (one digest, amd64 and arm64), with an SBOM, provenance and a cosign signature object in the registry (checked
  2026-11-18).
- [ ] Run `cosign verify` on the `0.1.0` image once (`docs/SELF-HOSTING.md`, "Verifying the image"): the signing
  step passed in CI and the signature is in the registry, but it has not been verified from a machine with cosign.
- [ ] Upgrade the owner's own instance: `pg_dump` of `expenses` first, then the new image, then check that the six
  migrations (`0001` to `0006`) applied.

**Before the instance is reachable from the internet**

- [ ] HTTPS behind a reverse proxy, with `COOKIE_SECURE` and `TRUST_PROXY=1`.
- [ ] `ALLOW_REGISTRATION=false` once the accounts exist.
- [ ] Backups from host cron (the `BACKUP_INTERVAL_HOURS` loop does not survive a reboot), and `backups/` copied
  off the machine.

**Checks that need a person or a real device** (see "Not verified")

- [ ] On a real iPhone: the Add sheet's drag-to-close, and the "±" toggle keeping the keyboard open.
- [ ] Safari and Firefox; the browser suite runs in headless Chromium only.
- [ ] Dark mode and the 375px layouts by eye; a screen-reader pass.
- [ ] Weekend-only and holiday-only date ranges against the live Frankfurter API.

**Optional work** (gaps left on purpose; none is queued)

- [ ] Statement Importer: pair cross-currency transfers between two statements.
- [ ] Statement Importer: virtualise the review table (slow with a few thousand rows).
- [ ] Statement Importer: a merge option when loading a context file (it replaces the lists today).
- [ ] Statement Importer: account signatures that collide on a card's last four digits.
- [ ] Manual exchange rates in the CSV export (today only in the JSON backup).
- [ ] Typing a date into the date picker.
- [ ] Importing a context file into the app itself.

New features beyond these have not been chosen yet.

## Known gaps

### Security and operations

- *(superseded 2026-11-09 by Postgres)* **Migrated accounts are not told their new user ID** other than by the shell after signing in with their email;
  `docs/SELF-HOSTING.md` shows how an administrator can list them.
- *(superseded 2026-11-09 by Postgres)* **Pre-migration copies are never cleaned up**; each one is a full copy of the database in the `/data` volume.
- *(superseded 2026-11-09 by Postgres)* **A migration whose derived user IDs still collide after the `user<id>` fallback** (only possible with contrived
  emails) stops startup; it is rolled back and needs a manual fix of the colliding email before upgrading.
- **Backups are not enforced, and stay on the same disk.** The `backup` service can now loop
  (`BACKUP_INTERVAL_HOURS`), but the loop does not survive a reboot or Docker restart (host cron does), copying
  `backups/` off the machine is up to the administrator, and the app only warns, it does not wait, before migrating
  an existing database. A failing migration rolls back, but the app does not start until it is fixed or the previous
  image is run.

### Features not built

- **An account without a time zone still dates Spendee imports in the browser's zone**, so re-importing from a
  browser in another zone can shift entries near midnight and miss them as duplicates. Accounts get a zone at
  registration or their next sign-in with JavaScript on, so this is left for accounts that never signed in again
  since 2026-11-18, browsers without JavaScript, and browsers whose zone is not an IANA name. Entries imported
  before an account had its zone keep the dates they got then.
- **Manual exchange rates are not in the CSV** (only in the JSON backup since 2026-11-18): a CSV moves entries, not
  rates. The same holds for budgets and category colours (2026-11-25).
- **Budgets (2026-11-25): no per-group budget, no history, no rollover.** A budget covers every wallet group, so in a
  group scope its progress is hidden rather than shown for that group; changing the amount rewrites past months'
  comparison too; unspent money does not carry over. No notification when a budget is exceeded (the app has no
  notifications), and no budget for income.
- **A budget whose currency's last wallet was deleted** keeps working (its progress converts as usual), but saving it
  again is refused until a wallet in that currency exists or another currency is chosen; the form still shows its
  currency so the user sees why.
- **Category colours are not on transaction rows** (`day-list`, `transaction-list`), nor in the /transactions
  category filter or the dashboard's per-category lists; the dot is on /categories, the entry form's pills and the
  Overview's Budgets card only.
- **An upload without a `Content-Length` header** that exceeds the Server Action limit still gets Next.js's generic
  refusal ("The upload failed…" in the panel); browsers always send the header for a `FormData` body.
- *(superseded 2026-11-09 by Postgres)* **The migration to wallet groups is tested on synthetic databases only**; it has not been run on a copy of the
  real `data/app.db`.

### Rough edges

- Without JavaScript the no-JS month select covers 24 months back and one ahead (plus the month in view); older
  months are reached with ‹.
- The day-strip bars themselves stay about 10px wide at 375px (the hit areas now touch and are 48px tall); the
  "Pick a day" calendar is the 44px path on phones.
- **On phones the Add dialog does not put focus in the amount when it opens**; `Dialog` focuses its panel there, so
  it takes Tab (✕, the type switch, then the amount). From `sm` up the amount (`data-autofocus`) is focused.
  Deliberate: auto-focusing on a phone would open the keyboard over half the bottom sheet.
- **A save from the Add dialog revalidates every page** (`revalidatePath("/", "layout")`) rather than the few the
  full-page form revalidates: the dialog can sit over any page.
- **Unexplained `next dev` reload loop seen while verifying step 1:** in the real checkout the dev server several
  times got into a state where every load of some page logged "Compiled in 1ms" and the browser reloaded endlessly
  (Fast Refresh). Restarting it cleared it for a while. The same tree copied to another folder, and `HEAD` copied
  the same way, never did it over the same page sequence, and `next start` never did. Suspected: other processes
  touching the checkout at the time (a parallel agent, a `next build` / `next typegen` in the same folder); not
  confirmed. If it shows up again, restart `npm run dev`.
- A date cannot be typed into the date picker (see Interface decisions); it is mouse/touch or keyboard navigation only.

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

- **End-to-end browser suite (2026-11-18): what it does and does not cover.** `e2e/` (Playwright, Chromium,
  production build, throwaway Postgres, `make test-e2e`; run twice in a row, all passing) now checks in a real
  browser what the entries below list as covered. It runs in headless Chromium only: no Safari / Firefox, no real
  touch device (the phone project emulates a 375px touch viewport), no screen reader (announcements and labels are
  checked through the accessibility tree, not heard), no real clipboard, file picker (files are set on the input) or
  password manager, and the 375px / dark-mode checks are for sideways overflow and the scheme's background, not a
  visual review.
- **Exchange rates in the database, manual rates and the converted strip / categories (2026-11-18).** A manual rate
  entered on `/rates` feeding the "All in" views of Overview (total and month spending, "EUR only"), Transactions
  and Categories with `EXCHANGE_RATES=false`, and its removal, are covered by `e2e/rates.spec.ts`; `/rates` at
  375px in both schemes by `e2e/layout.spec.ts`. Not tried against the live Frankfurter API: that a range made only
  of weekend days or holidays comes back as an empty `rates` object or as the previous business day (both are
  accepted), and the size of a long range response. Not checked in a browser: the date picker inside several forms
  on one page, the notes under the day strip and above the split card, and the Overview's past-month Wallets card.
  The `0005_exchange-rates` migration ran on PGlite, the e2e suite's empty Postgres 17 and a populated Postgres 17 (see "Operations on real Postgres 17 and Docker" below).

- **The /transactions and wallet-page fixes of 2026-11-18.** Focus moving into an opened row's form, back to the
  row on Escape, and after a Delete / a Save that moves the entry to another month to the next row, the previous
  row or the list heading; the `<noscript>` filter form with scripts off (the chips hidden, empty fields dropped);
  clean URLs for an empty `q=`; the "Pick a day" calendar at 375px (44px targets, inside the viewport); the wallet
  page's "Balance after" and projected "· projected" day headers: covered by `e2e/transactions.spec.ts` and
  `e2e/wallets.spec.ts`. Not checked: the announcement being read by a screen reader, and the cap pill colours by
  eye in both themes.
- **Entry form, dialogs and pickers gap fixes (2026-11-18).** The popover flipping above near the bottom of the
  viewport and re-placing on scroll, staying inside the Add sheet at 375px, the date picker's "Back to days" and
  Escape focus, "+ New category" end to end (typed values kept, a duplicate refused in place, Escape closing only
  the field), the "Manage categories" draft round trip in the dialog and on the full page, the amount / note
  surviving a Transfer ↔ Expense switch, and adding an expense / income / transfer through the N shortcut's dialog
  and the full page: covered by `e2e/entries.spec.ts` (which found the picker bug noted in the Interface table).
  Not checked: the sheet's drag-to-close on a real touch screen (iOS Safari's own gestures, the slide-out timing,
  reduced motion) and the "±" toggle keeping the iOS keyboard open, which need a real iPhone.
- **Accounts and security (2026-11-18).** Profile editing with the account menu showing the new name, the
  per-device Sign out, account deletion with the redirect to `/login?deleted=1` and its notice, the sign-in limit's
  message after five failures, and the four `/account` cards at 375px in both schemes: covered by
  `e2e/account.spec.ts`, `e2e/auth.spec.ts` and `e2e/layout.spec.ts`. `src/proxy.ts` on the standalone server: the
  oversized-import refusal reaching the import panel as the app's message is covered by `e2e/import.spec.ts`. Checked on 2026-11-18 (see "Operations on real Postgres 17 and Docker" below): the host check behind real
  proxies (the 403 answers seen with a script), `x-forwarded-for` behind Caddy and nginx, the reset script in a
  built image and `0002_lower-unique-users` on a populated Postgres 17. Not checked: the hydrated Next.js client
  showing the 403 text through `src/app/error.tsx`, and `src/proxy.ts` under `next dev` behind a proxy.
- **Category kind change, archive and removal into a new category (2026-11-18).** The row moving to the other card
  with focus on it after a kind change, archive / unarchive (the "Archived · N" list, the entry form leaving it out,
  the inline editor showing "Food (archived)"), and a refused removal into a new category keeping "A new …
  category" and its name: covered by `e2e/categories.spec.ts` (which found the select bug noted in the Categories
  table); the page at 375px by `e2e/layout.spec.ts`. Not checked: the `FOR UPDATE` / `FOR SHARE` pair with two real
  concurrent connections.

- **Devices list, `TRUST_PROXY`, scheduled backups and the demo wrapper (2026-11-18).** The Devices card (two
  sessions with real user-agent strings, "This device", the per-row Sign out signing the other browser out) is
  covered by `e2e/account.spec.ts`, at 375px in both schemes by `e2e/layout.spec.ts`. Checked on 2026-11-18 (see "Operations on real Postgres 17 and Docker" below): the `0006_sessions-devices`
  migration with existing sessions, `last_used_at` advancing on a running server, `TRUST_PROXY=1` behind Caddy and
  nginx, the backup loop in `postgres:17-alpine`, and `dev:demo` / `demo:reset` on macOS. Not checked: the per-row
  pending state, Traefik, and the wrapper on Windows `cmd`.
- **Leftover data and UI gaps (2026-11-18).** The kind change's focus landing on the moved row and the archived
  group's Edit toggle and form inside the closed `<details>` (focus into the name, back to the toggle) are covered
  by `e2e/categories.spec.ts` and `e2e/wallets.spec.ts`; the import of a CSV with wallet and archived-category rows
  by `e2e/import.spec.ts`. Not checked: the announcement being read, the no-JS Month link jumping to the select
  (fragment navigation scrolls to it but does not focus it in every browser), and the Statement Importer change in
  the published artifact (only through `tests/statement-importer-csv.test.ts`).
- **Account time zone (2026-11-18).** The hidden field filled after hydration on `/register` and surviving a refused
  submit (it did not: fixed, see the Accounts table), the zone reaching the new account, and the grouped select on
  `/account` saving a zone: covered by `e2e/auth.spec.ts` and `e2e/account.spec.ts`; `/account` at 375px in both
  schemes by `e2e/layout.spec.ts`. Not checked: iOS / Android pickers, type-to-search in the select, and the import
  notice text in the panel. The `0004_account-time-zone` migration ran on PGlite, the e2e suite's empty Postgres
  and a populated Postgres 17 (see "Operations on real Postgres 17 and Docker" below). The zone list and canonical spellings come from Node 24's ICU; another Node / ICU version may spell a few
  zones differently (`Europe/Kiev` vs `Europe/Kyiv`): a stored zone the runtime does not know counts as not set, and
  the select shows a stored zone that is missing from its list as an extra option.
- **Password change (2026-11-17).** The account menu's "Account settings" link closing the popover, the form
  clearing after success, another signed-in browser being sent to `/login` while this one stays, and the new
  password signing in: covered by `e2e/account.spec.ts`. Not checked: a password manager picking up the new
  password (Playwright's Chromium has none).
- **Postgres deployment, partly verified (2026-11-09).** Checked: the image built locally (arm64, Docker Desktop)
  and run through `deploy/compose.yaml` with no `.env` and an empty volume — `db` healthy, migrations applied (7
  tables), `/api/health`, `/login`, `/register` 200; register, create a KWD wallet, add an expense, see the 9.250
  balance, find it with `q=CAFÉ`, download the backup, all as no-JS form posts; then the documented `pg_dump` and
  `pg_restore --clean --if-exists` round trip restored a deleted row with the app healthy afterwards. Not checked:
  the amd64 image, the GitHub Actions run, `docker-compose.yml` (source build) end to end (both checked on
  2026-11-18), `compose.dev.yaml` with `npm run db:up` (not started, to keep agents off the dev volume), a JSON backup from an old SQLite
  instance imported into the new version, and the app in a browser with JavaScript. (The GitHub Actions run and the
  Postgres major upgrade were checked later; see the entries below.)
- **Month stepper on /transactions** (arrows joined to the Month chip, the end-of-list month row, "This month", `[` / `]` / `T`) was
  covered by tests (static markup, the key predicate) and typecheck / lint only; not checked in a browser: the look
  at 375px (chip wrapping, the 44px arrows), the hover tint in dark mode, and the keys against a real open dialog
  or edit row.

- **Wallet groups interface (step 2)** was covered by tests (render to static markup, actions with mocked Next APIs)
  and typecheck / lint only; it was not exercised in a browser. Unchecked there: the switcher's submit on change and
  its look at 375px (top bar width with a long group name; the select is capped at `max-w-44`), the no-JS "Go"
  button, focus after a group rename / delete, the `<optgroup>` pickers on a real phone, and the Overview with the
  group name in the heading.

- **Wallet group order, colour and archive.** Move up / down (also at 375px), recolouring, archiving into the
  closed "Archived groups" section, renaming there and unarchiving: covered by `e2e/wallets.spec.ts`; the group
  switcher scoping the Overview too. Not checked: the colour dots by eye in both themes, the colour radios' focus
  ring (`has-focus-visible`), the no-JS Move submit, and the `0001` migration on the real development database (it ran on a populated
  Postgres 17 on 2026-11-18: positions came out by name ignoring case, then id).

- **Bind mounts on a real Linux host.** The "folder must be owned by uid 1000" failure and its fixes were only
  simulated on Docker Desktop.
- **`COOKIE_SECURE=true` over plain HTTP** was checked with curl and scripts (the `Secure` flag per mode, behind
  Caddy and nginx, 2026-11-18), not a browser: that the browser then drops the cookie is documented, not observed.
- **The amd64 image** was built and run under emulation only (last on 2026-11-18: `docker build --platform
  linux/amd64`, `process.arch` x64, health and the no-JS flow through `deploy/compose.yaml`); never on an amd64 host.
- **The GitHub Actions workflow has run, but not its newest steps.** Runs on `main` (push, 2026-11-17) and on pull
  requests succeeded (`gh run list`), and the workflow passes actionlint (with shellcheck, 2026-11-18). The SBOM /
  provenance attestations and the cosign signing step added on 2026-11-18 have not run yet, so neither the
  `cosign verify` nor the `imagetools inspect` command in `docs/SELF-HOSTING.md` has been tried against a real
  image. Whether the GHCR package is public was not checked.
- **Operations on real Postgres 17 and Docker (2026-11-18), Docker Desktop on macOS (arm64), throwaway Compose
  projects, no-JS form posts by script (multipart, the browser's `Origin`, cookies kept).** Checked:
  - *Migrations.* All of `drizzle/` on an empty `postgres:17-alpine` ("Empty database: applying 7 migration(s)",
    10 tables). Upgrade: only `0000_init` applied through drizzle's migrator (the image with `MIGRATIONS_DIR`
    pointing at a copy of the folder whose journal stops at 0000), then filled by SQL with 3 users (mixed-case
    emails such as `Ana.Smith@Example.COM`), 4 sessions (one with a known token, one expired), 5 wallet groups,
    5 wallets (EUR / KWD / JPY, one archived), 6 categories, 366 transactions, 2 transfers (one cross-currency);
    then the current image started on it: the `[db] WARNING: applying 6 pending migration(s) …` line, 7 rows in
    `drizzle.__drizzle_migrations`, every row count and the amount sum unchanged, group positions per user by
    `lower(name)` then id (`archive` 1, `Business` 2, `personal` 3), every session's `last_used_at = created_at`,
    the `lower()` unique indexes present. The old session cookie still signed in, and its `last_used_at` advanced
    on that request; sign-in by lower-cased and upper-cased email and by user ID with the old passwords worked; the
    KWD balance was right (8.308). A database with two emails differing only in case (only possible by editing rows
    by hand: every version stored them lower-cased) makes `0002` fail: health answers 503, the log names
    `users_email_lower_uq` and the duplicated key, and the whole upgrade is rolled back (still one migration
    recorded, no new columns).
  - *Compose files with an empty volume.* `deploy/compose.yaml` (the locally built image via
    `EXPENSES_TRACKER_IMAGE` / `_VERSION`) and `docker-compose.yml` with `--build` (image tag and host port
    changed in an override): health, register, sign-out, sign in, a KWD wallet, an expense, balance 9.250,
    `q=CAFÉ`, the JSON backup download. The app runs as `node`.
  - *Password reset in the image.* `docker compose exec expenses-tracker node scripts/reset-password.mjs <email>`
    printed a password and deleted 2 sessions; `printf … | docker compose exec -T expenses-tracker … --stdin`
    (trailing newline dropped) likewise; a short password and an unknown user exit 1; sign-in with the new password
    worked, with the old one refused. The `--stdin` line in `docs/SELF-HOSTING.md` and the script's header named a
    service `app` that does not exist ("service "app" is not running"); fixed to `expenses-tracker`.
  - *Backup service.* `docker compose run --rm backup` (dumps mode 600, `BACKUP_KEEP=2` pruning); the loop with
    `BACKUP_INTERVAL_HOURS=1` through `--profile backup up -d backup` in the real busybox `sh`: one backup and
    prune, then `stop` took 0.13 s with exit code 0 (the trap works; `sleep` is a separate process). Several
    iterations were run with a `sleep` shim on `PATH` (one hour = 3 s): backups and pruning each round, the
    database stopped for two rounds ("Backup failed; trying again in 1 h.", no `.partial` left behind), then
    successful again. One dump restored with `pg_restore` into a scratch database: same row counts.
  - *Reverse proxies* (`TRUST_PROXY=1`): Caddy (`reverse_proxy app:3000`, HTTP and `tls internal` HTTPS) and nginx
    (the documented snippet). Sign-in and the whole flow work through both. Per-address limit: 30 failed sign-ins
    with distinct identifiers and a random forged `X-Forwarded-For` each, then the right password for another
    account is refused ("Too many sign-in attempts…"), while the same sign-in from another container (another
    address) succeeds; Caddy replaces the forged header, nginx appends to it (its log shows the forged value) and
    the app takes the right-most hop. Misconfigured nginx (no `proxy_set_header`, so `Host: app:3000`): the no-JS
    post gets the 403 HTML page, a `Next-Action` post the 403 `text/plain` message, and the log the
    `[origin-check] Refused a form post to /login …` line. The documented nginx line `proxy_set_header Host $host`
    does the same on a non-default port (Origin `localhost:3108`, host `localhost`); the snippet now uses
    `$http_host`. Uploads: a 7 MB `previewImportAction` POST through Caddy gets the app's 413 with
    `IMPORT_TOO_LARGE_MESSAGE`; through nginx with `client_max_body_size 6m` it gets nginx's own 413 HTML page
    (the panel refuses more than 5 MB before uploading, so a browser does not send one); 5.5 MB reaches the action.
  - *`COOKIE_SECURE`*: `auto` marks the cookie `Secure` only through Caddy's HTTPS (and directly at the app with a
    client-sent `X-Forwarded-Proto: https`); a client's forged `X-Forwarded-Proto: https` through Caddy or nginx
    over HTTP is overwritten by the proxy, so no `Secure`. `true`: always `Secure`; `false`: never.
  - *`npm run demo:reset` / `dev:demo`* with `DEMO_DATABASE_URL` pointing at a throwaway Postgres's
    `expenses_demo` (and a decoy `DATABASE_URL` that was ignored): reset migrated and seeded an empty database,
    then put a modified one back to the demo state (42 transactions, 1 user); `dev:demo` skipped the seed ("Demo
    user already exists") and the dev server signed `demo` in (its session row landed in `expenses_demo`).
    `DEMO_DATABASE_URL` naming `expenses`, `other` or a `mysql://` URL is refused with exit code 1 before
    anything runs. In an agent worktree whose `node_modules` is a symlink, Turbopack cannot find `next`
    ("Could not find the Next.js package"), so the dev server was checked with `--webpack`; a normal clone is
    not affected.
  - *amd64*: `docker build --platform linux/amd64` built; under emulation `process.arch` is `x64`, health and the
    no-JS flow pass.
  Not checked: a Linux host (bind-mount ownership, root-owned backup files), Traefik, the hydrated client in a
  browser behind the proxies, Windows `cmd`, and a real GitHub release.
- **Operations tooling (2026-11-18) was verified on Docker Desktop (arm64) with throwaway Compose projects only.**
  Checked: the image without `sharp` built with `docker build .`, came up healthy through `deploy/compose.yaml` and
  migrated an empty database (the "Empty database" line logged); `docker compose run --rm backup` three times with
  `BACKUP_KEEP=2` (oldest pruned, files mode 600); `deploy/pg-major-upgrade.sh 18` from 17 with data (row counts
  matched, app healthy on 18, old volume intact, a second run refused), and a run with an injected failure after
  the restore (override moved aside, old database and app back with all rows). `make release` in a scratch clone
  with a local bare `origin`: the refusals (not main, ahead of origin, dirty tree, version not newer, existing tag,
  `--push` with `--dry-run`), a dry run, and a real release pushed to that bare repository. Not checked: the
  scripts on a Linux host (root-owned backup files), the upgrade script with the source `docker-compose.yml` or
  with an existing override file, `npm run build` in Windows `cmd`, and a release against the real GitHub repository. In one release test run two
  tests failed once and passed on the rerun; which ones was not captured.
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
- *(superseded 2026-11-09 by Postgres)* **The 0001 migration on the owner's real database** was not run by the implementer (it is not theirs to touch);
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
- **Import / export gap closing (2026-11-18) is covered by tests only**: the CSV wallet rows and `group` /
  `archived` columns, the backup `archivedAt`, the context `group`, the broken-partner rule,
  the CSV resync, zip uploads (`fflate`), the proxy's 413 (unit-tested by calling `proxy()` with a `NextRequest`, not
  through a running server and a real browser — the claim that the Next.js client turns a `text/plain` 413 into an
  Error with the body as message comes from reading `server-action-reducer.js` of Next 16.4.5), and the
  preview-vs-confirmation sentence (render tests). Not checked: a real zip made by Spendee or macOS Finder, the
  panel in a browser, `next build` with the new `src/proxy.ts`, and that the /data link to
  `https://github.com/xalert/expenses-tracker/blob/main/docs/IMPORTING.md` resolves (it assumes that repository name).
- **Multi-file selection was exercised with files injected by script** (`DataTransfer`), not picked in a real
  file dialog; the 6 MB request limit with many small files (multipart overhead per file) was not measured.
- **Home-screen install (2026-11-25).** Checked on the standalone build (sharp removed, throwaway Postgres): the
  manifest (`application/manifest+json`), the three icons and `/apple-touch-icon.png` (`image/png`) answer 200
  without a session, and `/login`'s head links the manifest, the apple-touch icon, the favicon and the Apple meta
  tags; headless Chromium (DevTools `Page.getInstallabilityErrors`) reports no installability errors. Not checked:
  installing on a real iPhone (Safari "Add to Home Screen": icon, title, status bar, the top bar and Add button in
  standalone mode, sign-in surviving a relaunch) or a real Android phone (Chrome's install prompt, the maskable icon
  under the launcher's mask), and the icons by eye on a dark home screen.
- **Dependabot (2026-11-25) has not run.** `.github/dependabot.yml` was checked only against the documented options
  (and parsed as YAML): not whether the groups come out as intended (`next` and `eslint-config-next` in one PR), the
  cooldown, or the Docker entry finding `FROM node:24-bookworm-slim` and which tag it proposes.
- **Budgets and category colours (2026-11-25)** were checked with unit / render / action tests, the backup round
  trip, two e2e tests (setting a budget and seeing it on /categories and the Overview, a refused amount kept; picking
  a colour with the keyboard and seeing the dot in the entry form) and by eye: screenshots of /categories (closed and
  with a row open) and the Overview on the demo data at 375px and 1280px in both schemes. Not checked: the meter
  with live provider rates (the screenshots ran with `EXCHANGE_RATES=false`, so RON and USD showed as "not counted"),
  a screen reader reading the meter inside a row button (its text is long: the counts, the amount and the budget
  lines are all part of the button's name), and two people setting the same category's first budget at the same
  moment (the unique-violation retry is not exercised by a test).

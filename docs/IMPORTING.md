# Importing and exporting

Everything on the **Import & export** page (`/data`): what each file is for, what an import does with it, and the
rules it follows. The exact contract for developers is in [`SPEC.md`](SPEC.md#import--export).

## The short version

- **Importing only ever adds.** Nothing in your account is changed or deleted, and nothing is saved until you
  confirm the preview. The whole import is saved in one step, or not at all.
- **Re-importing is safe.** Entries that are already in your account are skipped (see [Duplicates](#duplicates)).
- **Any problem blocks the import.** The preview lists every problem with its file and line; fix the file and preview
  again.

## What you can export

| Download | Format | Use it to |
|---|---|---|
| Full backup | JSON | Keep a backup, or move your account to another instance. Everything: wallets (initial balance, group, archived state and date), categories (also unused ones, archived state and date, colour), transactions, transfers, your own exchange rates from the Rates page, and your budgets. |
| Transactions | CSV | Work in a spreadsheet, and import it back. One row per wallet first, then one per archived category the rows use, then one row per expense, income or transfer. |
| Wallets & categories | JSON | Give the [Statement Importer](STATEMENT-IMPORTER.md) your wallet and category names (archived ones flagged, and left out there), without any transactions. |

The **Export CSV** button on the Transactions page exports just the list you are looking at (its filters and month).

## What you can import

- **A backup** (`.json`) from this app. Import it on its own, not together with other files.
- **Transactions CSVs** from this app, from a spreadsheet, or from the Statement Importer.
- **Spendee exports**: the per-wallet CSV files, or a `.zip` of them.
- **Several files at once**: they are previewed and imported as one import. Choose them together, drop them on the
  page together, or put them in one `.zip`.

The format is recognised from the content, not the file name.

### Limits

- **5 MB in total** for one import (for a zip: also once unpacked), **50 000 rows** and **50 files**. Split larger
  data into several imports; duplicates make overlapping imports harmless.
- If the app runs behind a reverse proxy, the proxy must allow uploads of 6 MB (nginx allows 1 MB by default) — see
  [`SELF-HOSTING.md`](SELF-HOSTING.md).

## The transactions CSV

```
date,type,wallet,currency,amount,category,note,to_wallet,to_currency,to_amount,group,archived,kind
,wallet,Main,EUR,1000.00,,,,,,Personal,,
,wallet,Old card,USD,50.00,,,,,,Personal,2025-06-30,
,category,,,,Old rent,,,,,,2025-12-31,expense
2026-03-01,expense,Main,EUR,12.50,Food,Lunch,,,,Personal,,
2026-03-02,income,Main,EUR,2500.00,Salary,,,,,Personal,,
2026-03-05,transfer,Main,EUR,100.00,,ATM,Cash,EUR,100.00,Personal,,
2026-03-06,transfer,Main,EUR,200.00,,,Old card,USD,215.40,Personal,,
```

- Required columns: `date`, `type`, `wallet`, `currency`, `amount`. The others are optional, header names are not
  case-sensitive, columns can be in any order and unknown columns are ignored.
- **Separators**: comma, semicolon or tab (detected from the first line). Decimal commas (`12,50`) are fine.
- **Dates**: `2026-03-31` or `31.03.2026`. Slashed dates (`03/04/2026`) are refused, because they are ambiguous.
- **Types**: `expense`, `income`, `transfer`, `wallet` and `category`.
- **Amounts** are positive, in the wallet's currency, with no more decimals than the currency has (JPY none, EUR 2,
  KWD 3). The type says which way the money goes.
- **Transfers** are one row: from `wallet` to `to_wallet`. `to_currency` defaults to the same currency; when the
  currencies differ, `to_amount` (the amount received) is required.
- **Categories** are needed for expenses and income and are created if missing (matched ignoring case). Transfers
  have none.
- **Wallets** are identified by name and currency (ignoring case): an existing wallet is used, a missing one is
  created. Two wallets of yours with the same name and currency count as one in a CSV.

### Wallet rows, groups and archived wallets

A row with type `wallet` describes a wallet instead of moving money: `amount` is its **initial balance** (may be
negative; empty means 0), `group` the wallet group it goes in, and `archived` the date it was archived (empty for an
active wallet). Leave `date`, `category`, `note` and the `to_` columns empty.

- These details are used only when the import **creates** the wallet. A wallet you already have is never changed.
- A wallet without a wallet row starts at a balance of 0, active. The preview says when that happens.
- The `group` cell on any other row names the group of that row's `wallet` (the sending wallet for a transfer). A
  group that does not exist yet is created. Without a `group`, new wallets go into the group selected in the top bar
  (or your default group).
- A wallet has one group: giving the same wallet two different groups, or two wallet rows, is a problem.
- A wallet created archived still gets its history from the file (it is a restore), but nothing new can be imported
  into a wallet that is **already archived** in your account, or that is in an **archived group**: unarchive it (or
  the group) first.

### Category rows and archived categories

A row with type `category` describes a category: `category` is its name, `kind` is `expense` or `income`, and
`archived` the date it was archived (empty for an active one). Leave `date`, `wallet`, `currency`, `amount`, `note`,
`group` and the `to_` columns empty; only category rows use the `kind` column.

- The export writes one for each **archived** category its rows use, so importing the file into another account
  creates that category archived, with its entries.
- As for wallets, the details are used only when the import **creates** the category; a category you already have is
  never changed. A category row for a category nothing uses still creates it.
- Nothing new can be imported into a category that is **already archived** in your account: unarchive it first.

Files written before these columns existed import exactly as before.

### Spreadsheets

Text that a spreadsheet could read as a formula (starting with `=`, `+`, `-`, `@`) is written with a leading `'`,
which the import removes again, so a CSV round-trips exactly. Re-saving the file in a spreadsheet (semicolons, decimal
commas, `DD.MM.YYYY` dates) is fine.

## Spendee

Spendee exports **one CSV per wallet**. Choose all of them together (or one `.zip` with all of them); the older
single-file Spendee export works too.

- **Transfers.** Spendee writes a transfer as two rows in two files: an *Outgoing Transfer* in the sending wallet and
  an *Incoming Transfer* in the receiving one. The import pairs them into one transfer when they are in different
  wallets, have the same note, are at most 10 seconds apart and, in one currency, have the same amount. Rows that
  could be paired in more than one way are reported, never guessed.
- **A transfer row without a partner** blocks the import: usually another wallet's file is missing. If that wallet no
  longer exists, turn on **Import unpaired transfers as income / expense**: such rows become expenses (outgoing) or
  income (incoming) in a category named `Transfer`.
- If one row of a transfer has its own problem (a bad amount, say), only that problem is shown, not a second one for
  its partner.
- **Dates and time zones.** Spendee stores a time with each entry, written in UTC (`+00:00`). The import converts
  it to **your account's time zone** and keeps that local date, so an entry made at 00:30 stays on its day. Your
  account gets the time zone of the browser you register or next sign in with; you can change it, or clear it, under
  **Account settings → Profile → Time zone**. Because the account's zone is used, importing the same files again
  from a browser in another time zone dates every entry the same way, and they are all recognised as duplicates.
  If the account has no time zone, the browser's is used (and then a re-import from another zone can date a few
  entries near midnight differently). The preview says which time zone it used, where it came from, and how many
  entries landed on a different day than the UTC date in the file. The time of day is not kept. Set the time zone
  before your first Spendee import: changing it later does not change entries already imported.
- **Labels** are added to the note (`note · labels`), since this app has no labels.
- **Rounding.** Spendee can write more decimals than a currency has (converted foreign purchases). Such amounts are
  rounded half away from zero to the currency's decimals; the preview counts them.
- **Wallets** created from Spendee start at a balance of 0 (Spendee's export has no starting balance); edit them
  afterwards if needed. Categories are created as needed.

## Duplicates

With **Skip transactions that already exist** on (the default), an entry is skipped when your account already has
one with the same wallet, type, category, date, amount and note (a transfer: both wallets, date, both amounts and
note). It is counted one for one: if the file has 3 identical entries and your account has 1, 2 are added. So
importing the same file twice adds nothing the second time, while repeated purchases inside one file are kept. A file
selected twice in one import is used once.

## Preview and confirmation

The preview shows what will be added, the duplicates skipped, the wallets, groups and categories that will be
created (marked "archived" when they will be), the exchange rates and budgets a backup adds, and anything worth
knowing (rounding, labels, time zones). A backup's exchange rate for a currency and date you already have a rate for is
not imported: yours is kept, and the preview says so when they differ. Budgets work the same way: a budget for a
category (or the overall one) you already have is kept as it is. A category's colour comes from the backup only when
the import creates that category. Budgets and colours are not in the CSV. **Import** re-checks everything against your
account as it is at that moment. If something changed in between (another tab, another device), the confirmation says
so and lists the numbers that differ from the preview.

## Problems the preview reports

Problems name the file (when there are several) and the line, for example `Line 12 — amount: “1.005” is not a valid
EUR amount`. Every problem in the files is listed at once, even after a broken quote in a CSV (the rest of the file
is still checked). The first 50 are shown with the total.

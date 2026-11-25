// Wallet groups: order (position, Move up / down), colour, archive — the service rules, what an archived group hides,
// the scope fallback, the backup round trip, the migration's backfill and the rendered switcher / Wallets page parts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GroupSwitcher } from "@/components/shell/group-switcher";
import { ArchivedGroups } from "@/components/wallets/archived-groups";
import { GroupsCard } from "@/components/wallets/groups-card";
import type { DB } from "@/db";
import { resolveMigrationsDir } from "@/db";
import { ServiceError } from "@/lib/errors";
import { GROUP_COLORS } from "@/lib/group-colors";
import { resolveGroupScope } from "@/lib/group-scope";
import { getDashboard } from "@/server/dashboard";
import { buildBackup } from "@/server/export";
import { previewImport, runImport } from "@/server/import";
import { createTransaction, listTransactions, updateTransaction } from "@/server/transactions";
import { createTransfer, updateTransfer } from "@/server/transfers";
import {
  archiveWalletGroup,
  createWalletGroup,
  deleteWalletGroup,
  getDefaultGroupId,
  getWalletGroup,
  listWalletGroups,
  moveWalletGroup,
  renameWalletGroup,
  unarchiveWalletGroup,
} from "@/server/wallet-groups";
import { createWallet, listWallets, updateWallet } from "@/server/wallets";
import { EVERY_ENTRY, makeUser, useFreshDb } from "./helpers";

vi.mock("next/navigation", () => ({
  usePathname: () => "/wallets",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ back() {}, refresh() {}, push() {} }),
  redirect: () => {
    throw new Error("redirect");
  },
}));

let db: DB;
let alice: Awaited<ReturnType<typeof makeUser>>;
let bob: Awaited<ReturnType<typeof makeUser>>;

beforeEach(async () => {
  db = await useFreshDb();
  alice = await makeUser(db, "alice@example.com");
  bob = await makeUser(db, "bob@example.com");
});

async function expectServiceError(fn: () => unknown, code: ServiceError["code"], field?: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe(code);
    if (field !== undefined) expect((err as ServiceError).field).toBe(field);
    return;
  }
  throw new Error(`expected ServiceError ${code}`);
}

const names = async (userId: number) => (await listWalletGroups(userId)).map((g) => g.name);

describe("order", () => {
  it("new groups go last; listing is by position, not by name", async () => {
    await createWalletGroup(alice.id, { name: "Zeta" });
    await createWalletGroup(alice.id, { name: "Alpha" });
    expect(await names(alice.id)).toEqual(["Personal", "Zeta", "Alpha"]);
  });

  it("moves up and down, and does nothing at either end", async () => {
    const zeta = await createWalletGroup(alice.id, { name: "Zeta" });
    const alpha = await createWalletGroup(alice.id, { name: "Alpha" });
    await moveWalletGroup(alice.id, alpha.id, "up");
    expect(await names(alice.id)).toEqual(["Personal", "Alpha", "Zeta"]);
    await moveWalletGroup(alice.id, alpha.id, "up");
    expect(await names(alice.id)).toEqual(["Alpha", "Personal", "Zeta"]);
    await moveWalletGroup(alice.id, alpha.id, "up"); // already first
    expect(await names(alice.id)).toEqual(["Alpha", "Personal", "Zeta"]);
    await moveWalletGroup(alice.id, zeta.id, "down"); // already last
    expect(await names(alice.id)).toEqual(["Alpha", "Personal", "Zeta"]);
    await moveWalletGroup(alice.id, alpha.id, "down");
    expect(await names(alice.id)).toEqual(["Personal", "Alpha", "Zeta"]);
  });

  it("moves among groups of the same archived state only", async () => {
    const b = await createWalletGroup(alice.id, { name: "B" });
    const c = await createWalletGroup(alice.id, { name: "C" });
    await archiveWalletGroup(alice.id, b.id);
    // C's neighbour above among the active groups is Personal (B is archived and skipped).
    await moveWalletGroup(alice.id, c.id, "up");
    const active = (await listWalletGroups(alice.id)).filter((g) => g.archivedAt === null).map((g) => g.name);
    expect(active).toEqual(["C", "Personal"]);
  });

  it("repairs tied positions before a swap", async () => {
    const b = await createWalletGroup(alice.id, { name: "B" });
    await db.execute(`update wallet_groups set position = 0 where user_id = ${alice.id}` as never);
    await moveWalletGroup(alice.id, b.id, "up");
    expect(await names(alice.id)).toEqual(["B", "Personal"]);
  });

  it("validates the direction and treats another user's group as missing", async () => {
    const b = await createWalletGroup(alice.id, { name: "B" });
    await expectServiceError(async () => moveWalletGroup(alice.id, b.id, "sideways" as never), "VALIDATION", "direction");
    await expectServiceError(async () => moveWalletGroup(bob.id, b.id, "up"), "NOT_FOUND", "groupId");
  });

  it("the default group is the oldest unarchived one", async () => {
    const personal = await getDefaultGroupId(alice.id);
    const b = await createWalletGroup(alice.id, { name: "B" });
    await moveWalletGroup(alice.id, b.id, "up"); // order does not decide the default
    expect(await getDefaultGroupId(alice.id)).toBe(personal);
    await archiveWalletGroup(alice.id, personal);
    expect(await getDefaultGroupId(alice.id)).toBe(b.id);
  });
});

describe("colour", () => {
  it("is optional, chosen on create, changed or cleared on rename, kept when omitted", async () => {
    const g = await createWalletGroup(alice.id, { name: "Biz", color: "teal" });
    expect(g.color).toBe("teal");
    expect((await createWalletGroup(alice.id, { name: "Plain" })).color).toBeNull();
    expect((await renameWalletGroup(alice.id, g.id, { name: "Biz" })).color).toBe("teal");
    expect((await renameWalletGroup(alice.id, g.id, { name: "Biz", color: "violet" })).color).toBe("violet");
    expect((await renameWalletGroup(alice.id, g.id, { name: "Biz", color: "" })).color).toBeNull();
  });

  it("must come from the palette", async () => {
    await expectServiceError(async () => createWalletGroup(alice.id, { name: "X", color: "#ff0000" }), "VALIDATION", "color");
    const g = await createWalletGroup(alice.id, { name: "Y" });
    await expectServiceError(async () => renameWalletGroup(alice.id, g.id, { name: "Y", color: "pink" }), "VALIDATION", "color");
    expect(GROUP_COLORS.length).toBeGreaterThan(3);
  });

  it("every palette colour is a theme token in light and dark", () => {
    const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
    for (const c of GROUP_COLORS) {
      expect(css.match(new RegExp(`--group-${c}:`, "g"))?.length).toBe(2);
      expect(css).toContain(`--color-group-${c}: var(--group-${c});`);
    }
  });
});

describe("archive", () => {
  async function setup() {
    const personal = await getDefaultGroupId(alice.id);
    const biz = await createWalletGroup(alice.id, { name: "Business" });
    const home = await createWallet(alice.id, { name: "Home", currency: "EUR", initialBalanceMinor: 1000 });
    const shop = await createWallet(alice.id, { name: "Shop", currency: "EUR", initialBalanceMinor: 5000, groupId: biz.id });
    await createTransaction(alice.id, {
      walletId: shop.id,
      kind: "expense",
      categoryId: alice.cat("Food"),
      amountMinor: 700,
      date: "2026-03-05",
    });
    return { personal, biz, home, shop };
  }

  it("refuses the last unarchived group; archiving twice is a no-op; unarchive restores", async () => {
    const { personal, biz } = await setup();
    await expectServiceError(async () => archiveWalletGroup(bob.id, await getDefaultGroupId(bob.id)), "CONFLICT", "groupId");
    const archived = await archiveWalletGroup(alice.id, biz.id);
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect((await archiveWalletGroup(alice.id, biz.id)).archivedAt).toEqual(archived.archivedAt);
    await expectServiceError(async () => archiveWalletGroup(alice.id, personal), "CONFLICT", "groupId");
    expect((await unarchiveWalletGroup(alice.id, biz.id)).archivedAt).toBeNull();
    await expectServiceError(async () => archiveWalletGroup(bob.id, biz.id), "NOT_FOUND", "groupId");
  });

  it("an archived group's wallets count as archived: hidden from active lists and Overview totals, history kept", async () => {
    const { biz, shop } = await setup();
    await archiveWalletGroup(alice.id, biz.id);
    expect((await listWallets(alice.id)).map((w) => w.name)).toEqual(["Home"]);
    const all = await listWallets(alice.id, { includeArchived: true });
    expect(all.find((w) => w.id === shop.id)).toMatchObject({ groupArchived: true, archivedAt: null });
    const dash = await getDashboard(alice.id, { month: "2026-03", balanceOn: EVERY_ENTRY });
    expect(dash.wallets.map((w) => w.name)).toEqual(["Home"]);
    expect(dash.totalsByCurrency).toEqual([{ currency: "EUR", balanceMinor: 1000, incomeMinor: 0, expenseMinor: 0 }]);
    // The entries stay where history is shown, as for an archived wallet.
    expect((await listTransactions(alice.id, { month: "2026-03" })).items).toHaveLength(1);
  });

  it("no new wallet goes into an archived group; a wallet already in one may stay", async () => {
    const { biz, shop } = await setup();
    await archiveWalletGroup(alice.id, biz.id);
    await expectServiceError(
      async () => createWallet(alice.id, { name: "New", currency: "EUR", initialBalanceMinor: 0, groupId: biz.id }),
      "VALIDATION",
      "groupId",
    );
    const home = (await listWallets(alice.id))[0];
    await expectServiceError(
      async () => updateWallet(alice.id, home.id, { name: "Home", initialBalanceMinor: 1000, groupId: biz.id }),
      "VALIDATION",
      "groupId",
    );
    expect((await updateWallet(alice.id, shop.id, { name: "Shop 2", initialBalanceMinor: 5000, groupId: biz.id })).name).toBe(
      "Shop 2",
    );
  });

  it("delete: an empty archived group can go; the last unarchived one cannot, even with archived ones around", async () => {
    const personal = await getDefaultGroupId(alice.id);
    const old = await createWalletGroup(alice.id, { name: "Old" });
    await archiveWalletGroup(alice.id, old.id);
    await expectServiceError(async () => deleteWalletGroup(alice.id, personal), "CONFLICT", "groupId");
    await deleteWalletGroup(alice.id, old.id);
    expect(await getWalletGroup(alice.id, old.id)).toBeNull();
  });

  it("an import never targets an archived group", async () => {
    const { biz } = await setup();
    await archiveWalletGroup(alice.id, biz.id);
    const csv = "date,type,wallet,currency,amount,category\n2026-03-01,expense,Cash,EUR,1.00,Food\n";
    await expectServiceError(async () => previewImport(alice.id, csv, { groupId: biz.id }), "VALIDATION", "groupId");
  });

  it("an archived group can be renamed and recoloured without unarchiving it", async () => {
    const { biz } = await setup();
    await archiveWalletGroup(alice.id, biz.id);
    const renamed = await renameWalletGroup(alice.id, biz.id, { name: "Old business", color: "teal" });
    expect(renamed).toMatchObject({ name: "Old business", color: "teal" });
    expect(renamed.archivedAt).toBeInstanceOf(Date);
  });

  it("refuses new entries on a wallet of an archived group, like an archived wallet; existing entries stay editable", async () => {
    const { biz, home, shop } = await setup();
    const [entry] = (await listTransactions(alice.id, { month: "2026-03" })).items;
    const transfer = await createTransfer(alice.id, { fromWalletId: home.id, toWalletId: shop.id, amountMinor: 100, date: "2026-03-06" });
    await archiveWalletGroup(alice.id, biz.id);
    const input = { walletId: shop.id, kind: "expense", categoryId: alice.cat("Food"), amountMinor: 100, date: "2026-03-07" } as const;
    await expectServiceError(() => createTransaction(alice.id, input), "VALIDATION", "walletId");
    await expect(createTransaction(alice.id, input)).rejects.toThrow(
      "This wallet is in the archived group “Business”. Unarchive the group first.",
    );
    await expectServiceError(
      () => createTransfer(alice.id, { fromWalletId: shop.id, toWalletId: home.id, amountMinor: 100, date: "2026-03-07" }),
      "VALIDATION",
      "fromWalletId",
    );
    await expectServiceError(
      () => createTransfer(alice.id, { fromWalletId: home.id, toWalletId: shop.id, amountMinor: 100, date: "2026-03-07" }),
      "VALIDATION",
      "toWalletId",
    );
    // Moving an existing entry onto it is new activity too.
    const other = await createTransaction(alice.id, { ...input, walletId: home.id });
    await expectServiceError(() => updateTransaction(alice.id, other.id, input), "VALIDATION", "walletId");
    // An entry that already belongs to it keeps it when edited (same rule as an archived wallet).
    expect((await updateTransaction(alice.id, entry.id, { ...input, amountMinor: 800 })).amountMinor).toBe(800);
    const edited = await updateTransfer(alice.id, transfer.id, { fromWalletId: home.id, toWalletId: shop.id, amountMinor: 150, date: "2026-03-06" });
    expect(edited.from.amountMinor).toBe(150);
    // Unarchiving the group opens the wallet again.
    await unarchiveWalletGroup(alice.id, biz.id);
    await createTransaction(alice.id, input);
  });

  it("an import treats a wallet of an archived group as archived: new rows are problems, duplicates still skip", async () => {
    const { biz } = await setup();
    await archiveWalletGroup(alice.id, biz.id);
    const csv =
      "date,type,wallet,currency,amount,category\n2026-03-05,expense,Shop,EUR,7.00,Food\n2026-03-06,expense,Shop,EUR,1.00,Food\n";
    const preview = await previewImport(alice.id, csv);
    expect(preview.duplicateTransactions).toBe(1);
    expect(preview.problems).toEqual([
      {
        line: 3,
        message:
          "Wallet “Shop” (EUR) is in the archived group “Business” in your account, so nothing new can be added to it. " +
          "Unarchive the group first, or remove these rows.",
      },
    ]);
    const again = await previewImport(alice.id, "date,type,wallet,currency,amount,category\n2026-03-05,expense,Shop,EUR,7.00,Food\n");
    expect(again).toMatchObject({ ok: true, transactionsToAdd: 0, duplicateTransactions: 1 });
  });
});

describe("scope", () => {
  const view = (id: number, archived = false) => ({
    id,
    name: `G${id}`,
    position: id,
    color: null,
    archivedAt: archived ? new Date() : null,
    walletCount: 0,
    createdAt: new Date(),
  });

  it("splits off archived groups and falls back to All for a cookie naming one", () => {
    const all = [view(1), view(2, true), view(3)];
    expect(resolveGroupScope(all, 3)).toMatchObject({ groups: [{ id: 1 }, { id: 3 }], archivedGroups: [{ id: 2 }] });
    expect(resolveGroupScope(all, 3).selected?.id).toBe(3);
    expect(resolveGroupScope(all, 2).selected).toBeNull();
    expect(resolveGroupScope(all, 99).selected).toBeNull();
    expect(resolveGroupScope(all, null).selected).toBeNull();
  });
});

describe("backup", () => {
  it("round-trips position, colour and archived state; groups the account lacks are created after its own", async () => {
    const biz = await createWalletGroup(alice.id, { name: "Business", color: "blue" });
    const old = await createWalletGroup(alice.id, { name: "Old", color: "red" });
    await createWalletGroup(alice.id, { name: "Empty" });
    await moveWalletGroup(alice.id, biz.id, "up"); // Business, Personal, Old, Empty
    await createWallet(alice.id, { name: "Shop", currency: "EUR", initialBalanceMinor: 0, groupId: biz.id });
    await createWallet(alice.id, { name: "Attic", currency: "EUR", initialBalanceMinor: 0, groupId: old.id });
    await archiveWalletGroup(alice.id, old.id);

    const backup = await buildBackup(alice.id);
    expect(backup.groups).toEqual([
      { name: "Business", color: "blue", archived: false },
      { name: "Personal", color: null, archived: false },
      { name: "Old", color: "red", archived: true },
      { name: "Empty", color: null, archived: false },
    ]);

    const text = JSON.stringify(backup);
    const p = await previewImport(bob.id, text);
    expect(p).toMatchObject({ ok: true, groupsToCreate: ["Business", "Old", "Empty"] });
    expect((await runImport(bob.id, text)).imported).toBe(true);
    const groups = await listWalletGroups(bob.id);
    // Bob's own Personal keeps its place (and its state); the others follow in the file's order.
    expect(groups.map((g) => [g.name, g.color, g.archivedAt !== null])).toEqual([
      ["Personal", null, false],
      ["Business", "blue", false],
      ["Old", "red", true],
      ["Empty", null, false],
    ]);
    expect((await listWallets(bob.id, { includeArchived: true })).find((w) => w.name === "Attic")).toMatchObject({
      groupName: "Old",
      groupArchived: true,
    });
    // Importing again creates nothing.
    expect((await previewImport(bob.id, text)).groupsToCreate).toEqual([]);
  });

  it("an old backup without `groups` still imports; an unknown colour reads as none; a bad name is a problem", async () => {
    await createWalletGroup(alice.id, { name: "Business" });
    const backup = JSON.parse(JSON.stringify(await buildBackup(alice.id)));
    delete backup.groups;
    expect((await runImport(bob.id, JSON.stringify(backup))).imported).toBe(true);

    const carol = await makeUser(db, "carol@example.com");
    backup.groups = [{ name: "Neon", color: "neon-pink" }];
    expect((await runImport(carol.id, JSON.stringify(backup))).imported).toBe(true);
    expect((await listWalletGroups(carol.id)).find((g) => g.name === "Neon")).toMatchObject({ color: null, archivedAt: null });

    backup.groups = [{ name: "x".repeat(41) }];
    const r = await previewImport(carol.id, JSON.stringify(backup));
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatchObject({ path: "groups[0].name" });
  });
});

describe("migration 0001 backfill", () => {
  it("numbers each user's existing groups 1..n by name ignoring case, then id", async () => {
    const dir = resolveMigrationsDir();
    const run = async (pg: PGlite, file: string) => {
      for (const stmt of readFileSync(path.join(dir, file), "utf8").split("--> statement-breakpoint")) await pg.exec(stmt);
    };
    const pg = new PGlite();
    await run(pg, "0000_init.sql");
    await pg.exec(`insert into users (username, password_hash) values ('a', 'x'), ('b', 'x')`);
    await pg.exec(
      `insert into wallet_groups (user_id, name) values (1, 'personal'), (1, 'Business'), (2, 'Zed'), (1, 'archive'), (2, 'Alpha')`,
    );
    await run(pg, "0001_wallet-groups-order-colour-archive.sql");
    const { rows } = await pg.query<{ user_id: number; name: string; position: number }>(
      `select user_id, name, position from wallet_groups order by user_id, position`,
    );
    expect(rows.map((r) => [r.user_id, r.name, r.position])).toEqual([
      [1, "archive", 1],
      [1, "Business", 2],
      [1, "personal", 3],
      [2, "Alpha", 1],
      [2, "Zed", 2],
    ]);
  });
});

describe("rendering", () => {
  it("the switcher offers the given groups in order and shows the selected group's colour dot", () => {
    const html = renderToStaticMarkup(
      <GroupSwitcher
        groups={[
          { id: 3, name: "Zeta", color: "teal" },
          { id: 1, name: "Alpha", color: null },
        ]}
        selectedId={3}
      />,
    );
    expect(html.indexOf(">Zeta<")).toBeLessThan(html.indexOf(">Alpha<"));
    expect(html).toContain('data-group-color="teal"');
    expect(html).toContain("bg-group-teal");
    const all = renderToStaticMarkup(
      <GroupSwitcher
        groups={[
          { id: 3, name: "Zeta", color: "teal" },
          { id: 1, name: "Alpha" },
        ]}
        selectedId={null}
      />,
    );
    expect(all).not.toContain("data-group-color");
  });

  it("the Groups card: dots, Move up / down as plain forms (disabled at the ends), colour radios", () => {
    const html = renderToStaticMarkup(
      <GroupsCard
        groups={[
          { id: 1, name: "Business", walletCount: 2, color: "blue" },
          { id: 2, name: "Personal", walletCount: 1, color: null },
        ]}
      />,
    );
    expect(html).toContain('data-group-color="blue"');
    expect(html).toMatch(/<button type="submit" disabled="" aria-label="Move Business up"/);
    expect(html).toMatch(/<button type="submit" aria-label="Move Business down"/);
    expect(html).toMatch(/<button type="submit" disabled="" aria-label="Move Personal down"/);
    expect(html.match(/<form[^>]*>/g)!.length).toBeGreaterThanOrEqual(5); // 4 move forms + the new-group form
    for (const c of GROUP_COLORS) expect(html).toContain(`name="color" value="${c}"`);
    expect(html).toContain("<legend");
  });

  it("one group: no move buttons", () => {
    const html = renderToStaticMarkup(<GroupsCard groups={[{ id: 1, name: "Personal", walletCount: 0 }]} />);
    expect(html).not.toContain("Move Personal");
  });

  it("Archived groups: a closed details with each group, its wallets, Unarchive, and Delete only when empty", async () => {
    const biz = await createWalletGroup(alice.id, { name: "Business", color: "amber" });
    const empty = await createWalletGroup(alice.id, { name: "Empty" });
    await createWallet(alice.id, { name: "Shop", currency: "EUR", initialBalanceMinor: 1234, groupId: biz.id });
    await archiveWalletGroup(alice.id, biz.id);
    await archiveWalletGroup(alice.id, empty.id);
    const groups = (await listWalletGroups(alice.id)).filter((g) => g.archivedAt !== null);
    const wallets = (await listWallets(alice.id, { includeArchived: true, balanceOn: EVERY_ENTRY })).filter((w) => w.groupArchived);
    const html = renderToStaticMarkup(<ArchivedGroups groups={groups} wallets={wallets} />);
    expect(html).toMatch(/^<details/);
    expect(html).not.toMatch(/^<details[^>]* open/);
    expect(html).toContain("Archived groups · 2");
    expect(html).toContain('data-group-color="amber"');
    expect(html).toContain('href="/wallets/');
    expect(html).toContain(">Shop<");
    expect(html.match(/>Unarchive</g)).toHaveLength(2);
    expect(html.match(/>Delete</g)).toHaveLength(1);
    // Edit (rename / recolour without unarchiving): a closed toggle per group; the form mounts only when opened.
    expect(html).toContain('aria-label="Rename or recolour Business"');
    expect(html).toContain('aria-label="Rename or recolour Empty"');
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    expect(html).not.toContain('name="name"');
    expect(renderToStaticMarkup(<ArchivedGroups groups={[]} wallets={[]} />)).toBe("");
  });
});

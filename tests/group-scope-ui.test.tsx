// The wallet-group interface: the switcher, `selectGroupAction` and the cookie, `getGroupScope`, the group actions,
// the Group field of the wallet form and the CSV export link. Next's request APIs are mocked; services run for real.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportCsvHref, parseListParams } from "@/components/transactions/list-params";
import { WalletForm } from "@/components/wallets/wallet-form";
import { GroupsCard } from "@/components/wallets/groups-card";
import { GroupSwitcher } from "@/components/shell/group-switcher";
import { createWalletGroup, listWalletGroups } from "@/server/wallet-groups";
import { createWallet, listWallets } from "@/server/wallets";
import { makeUser, useFreshDb } from "./helpers";

const session = vi.hoisted(() => ({ userId: 0 }));
const jar = vi.hoisted(() => ({
  values: new Map<string, string>(),
  sets: [] as { name: string; value: string; options: Record<string, unknown> }[],
  deleted: [] as string[],
  revalidated: [] as unknown[][],
}));

vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: session.userId }) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.values.has(name) ? { name, value: jar.values.get(name)! } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      jar.values.set(name, value);
      jar.sets.push({ name, value, options });
    },
    delete: (name: string) => {
      jar.values.delete(name);
      jar.deleted.push(name);
    },
  }),
  headers: async () => ({ get: () => null }),
}));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => void jar.revalidated.push(a) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ back() {}, refresh() {}, push() {} }),
  usePathname: () => "/transactions",
  useSearchParams: () => new URLSearchParams("month=2026-10&wallet=3"),
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}

const { selectGroupAction } = await import("@/app/(app)/actions");
const { createGroupAction, renameGroupAction, deleteGroupAction, createWalletAction, updateWalletAction } = await import(
  "@/app/(app)/wallets/actions"
);
const { getGroupScope, GROUP_COOKIE } = await import("@/lib/group-scope");

function fd(entries: [string, string][]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof RedirectSignal) return err.url;
    throw err;
  }
  throw new Error("expected a redirect");
}

let db: Awaited<ReturnType<typeof useFreshDb>>;
let user: Awaited<ReturnType<typeof makeUser>>;
let personal: number;

beforeEach(async () => {
  db = await useFreshDb();
  user = await makeUser(db, "alice@example.com");
  session.userId = user.id;
  jar.values.clear();
  jar.sets = [];
  jar.deleted = [];
  jar.revalidated = [];
  personal = (await listWalletGroups(user.id))[0].id;
});

describe("GroupSwitcher", () => {
  it("renders nothing with fewer than two groups", () => {
    expect(renderToStaticMarkup(<GroupSwitcher groups={[{ id: 1, name: "Personal" }]} selectedId={null} />)).toBe("");
  });

  it("with two groups shows All groups + each group, the selection, a no-JS button and the current URL without page and wallet as returnTo", () => {
    const html = renderToStaticMarkup(
      <GroupSwitcher
        groups={[
          { id: 1, name: "Business" },
          { id: 2, name: "Personal" },
        ]}
        selectedId={2}
      />,
    );
    expect(html).toContain("All groups");
    expect(html).toContain(">Business<");
    expect(html).toMatch(/<option value="2" selected="">Personal<\/option>/);
    expect(html).toContain('name="returnTo" value="/transactions?month=2026-10"');
    expect(html).toContain('<label for="group-switcher" class="sr-only">Group</label>');
    // Before hydration the submit button is visible (works without JavaScript).
    expect(html).toMatch(/<button type="submit" class="(?!sr-only)[^"]*">Go<\/button>/);
  });
});

describe("selectGroupAction and getGroupScope", () => {
  it("sets the cookie for an own group, revalidates and returns to returnTo", async () => {
    const business = (await createWalletGroup(user.id, { name: "Business" })).id;
    const url = await redirectOf(
      selectGroupAction(fd([["groupId", String(business)], ["returnTo", "/transactions?month=2026-10"]])),
    );
    expect(url).toBe("/transactions?month=2026-10");
    expect(jar.sets).toEqual([
      {
        name: "et_group",
        value: String(business),
        options: expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 31536000, secure: false }),
      },
    ]);
    expect(jar.revalidated).toEqual([["/", "layout"]]);
    expect((await getGroupScope()).selected?.id).toBe(business);
  });

  it("an empty, foreign or garbage id clears the cookie (All); an unsafe returnTo goes to /", async () => {
    await createWalletGroup(user.id, { name: "Business" });
    jar.values.set(GROUP_COOKIE, String(personal));
    expect(await redirectOf(selectGroupAction(fd([["groupId", ""], ["returnTo", "/wallets"]])))).toBe("/wallets");
    expect(jar.values.has(GROUP_COOKIE)).toBe(false);

    const other = await makeUser(db, "bob@example.com");
    const foreign = (await createWalletGroup(other.id, { name: "Theirs" })).id;
    for (const raw of [String(foreign), "abc", "-1", "999999"]) {
      jar.values.set(GROUP_COOKIE, String(personal));
      jar.sets = [];
      expect(await redirectOf(selectGroupAction(fd([["groupId", raw], ["returnTo", "//evil.example"]])))).toBe("/");
      expect(jar.values.has(GROUP_COOKIE)).toBe(false);
      expect(jar.sets).toEqual([]);
    }
  });

  it("getGroupScope: a stale or foreign cookie means All, no cookie means All", async () => {
    await createWalletGroup(user.id, { name: "Business" });
    expect((await getGroupScope()).selected).toBeNull();
    jar.values.set(GROUP_COOKIE, "4242");
    // React `cache` is per request; outside one it does not memoise, so this reads the cookie again.
    expect((await getGroupScope()).selected).toBeNull();
    expect((await getGroupScope()).groups.map((g) => g.name)).toEqual(["Business", "Personal"]);
  });
});

describe("group actions", () => {
  it("create / rename / delete work and revalidate the layout", async () => {
    expect(await createGroupAction({}, fd([["name", "Business"]]))).toEqual({ ok: true, message: "Added the group “Business”." });
    expect(jar.revalidated).toEqual([["/", "layout"]]);
    const business = (await listWalletGroups(user.id)).find((g) => g.name === "Business")!;

    expect(await renameGroupAction(business.id, {}, fd([["name", "Work"]]))).toEqual({ ok: true, message: "Renamed to “Work”." });
    expect((await listWalletGroups(user.id)).map((g) => g.name)).toEqual(["Personal", "Work"]);

    expect(await deleteGroupAction(business.id)).toEqual({ ok: true, message: "Deleted the group “Work”." });
    expect((await listWalletGroups(user.id)).map((g) => g.name)).toEqual(["Personal"]);
  });

  it("maps service errors onto the form: duplicate name, non-empty group, last group", async () => {
    expect((await deleteGroupAction(personal)).fieldErrors?.groupId).toMatch(/at least one group/);
    const dup = await createGroupAction({}, fd([["name", "personal"]]));
    expect(dup.fieldErrors?.name).toMatch(/already have a group/);
    expect(dup.values).toEqual({ name: "personal" });

    const business = (await createWalletGroup(user.id, { name: "Business" })).id;
    await createWallet(user.id, { name: "Till", currency: "EUR", initialBalanceMinor: 0, groupId: business });
    expect((await deleteGroupAction(business)).fieldErrors?.groupId).toMatch(/still has wallets/);
    expect((await deleteGroupAction(personal)).ok).toBe(true);
    expect((await deleteGroupAction(9999)).message).toMatch(/not found/i);
    expect((await renameGroupAction(0, {}, fd([["name", "x"]]))).message).toMatch(/not found/i);
  });
});

describe("wallet actions with a group", () => {
  it("createWalletAction and updateWalletAction take an optional groupId", async () => {
    const business = (await createWalletGroup(user.id, { name: "Business" })).id;
    await createWalletAction({}, fd([["mode", "dialog"], ["name", "Till"], ["currency", "EUR"], ["groupId", String(business)]]));
    await createWalletAction({}, fd([["mode", "dialog"], ["name", "Cash"], ["currency", "EUR"]]));
    const byName = Object.fromEntries((await listWallets(user.id)).map((w) => [w.name, w]));
    expect(byName.Till.groupId).toBe(business);
    expect(byName.Cash.groupId).toBe(personal);

    await updateWalletAction(byName.Cash.id, {}, fd([["mode", "dialog"], ["name", "Cash"], ["groupId", String(business)]]));
    expect((await listWallets(user.id)).find((w) => w.name === "Cash")!.groupId).toBe(business);
    await updateWalletAction(byName.Cash.id, {}, fd([["mode", "dialog"], ["name", "Cash"]]));
    expect((await listWallets(user.id)).find((w) => w.name === "Cash")!.groupId).toBe(business);
  });

  it("rejects a bad or foreign groupId on the groupId field", async () => {
    const bad = await createWalletAction({}, fd([["mode", "dialog"], ["name", "A"], ["currency", "EUR"], ["groupId", "abc"]]));
    expect(bad.fieldErrors?.groupId).toBe("Choose a group.");
    const missing = await createWalletAction({}, fd([["mode", "dialog"], ["name", "A"], ["currency", "EUR"], ["groupId", "9999"]]));
    expect(missing.fieldErrors?.groupId).toMatch(/not found/i);
    expect(await listWallets(user.id)).toEqual([]);
  });
});

describe("WalletForm group field", () => {
  const groups = [
    { id: 1, name: "Business" },
    { id: 2, name: "Personal" },
  ];
  const base = {
    action: async () => ({}),
    submitLabel: "Save",
    pendingLabel: "Saving…",
    cancelHref: "/wallets",
    mode: "edit" as const,
    currency: "EUR",
    currencyLabel: "EUR",
  };

  it("is absent with one group, a select with two defaulting to the given group", () => {
    expect(renderToStaticMarkup(<WalletForm {...base} groups={[groups[1]]} />)).not.toContain('name="groupId"');
    expect(renderToStaticMarkup(<WalletForm {...base} />)).not.toContain('name="groupId"');
    const html = renderToStaticMarkup(<WalletForm {...base} groups={groups} defaults={{ groupId: "1" }} />);
    expect(html).toContain('name="groupId"');
    expect(html).toMatch(/<option value="1" selected="">Business<\/option>/);
    expect(html).toContain(">Group</label>");
  });
});

describe("GroupsCard", () => {
  it("lists groups with wallet counts and the new-group input", () => {
    const html = renderToStaticMarkup(
      <GroupsCard
        groups={[
          { id: 1, name: "Business", walletCount: 2 },
          { id: 2, name: "Personal", walletCount: 1 },
        ]}
      />,
    );
    expect(html).toContain("Business");
    expect(html).toContain("2 wallets");
    expect(html).toContain("1 wallet<");
    expect(html).toContain('placeholder="+ New group"');
  });
});

describe("exportCsvHref with a group", () => {
  it("adds group=<id> only when a group is selected", () => {
    const p = parseListParams({});
    expect(exportCsvHref(p, "2026-11")).toBe("/api/export/transactions?month=2026-11");
    expect(exportCsvHref(p, "2026-11", 7)).toBe("/api/export/transactions?month=2026-11&group=7");
    expect(exportCsvHref(parseListParams({ month: "all", q: "rent" }), "2026-11", 7)).toBe(
      "/api/export/transactions?q=rent&group=7",
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { categories, sessions, transactions, transfers, users, walletGroups, wallets } from "@/db/schema";
import type { DB } from "@/db";
import { ServiceError } from "@/lib/errors";
import { hashPassword, verifyPassword } from "@/lib/password";
import { displayName } from "@/lib/user-id";
import { listCategories } from "@/server/categories";
import { canonicalTimeZone, listTimeZones } from "@/lib/time-zone";
import {
  adoptTimeZoneIfUnset,
  authenticateUser,
  changePassword,
  SESSION_TOUCH_INTERVAL_MS,
  deleteAccount,
  deleteExpiredSessions,
  getUserTimeZone,
  isWrongPasswordError,
  listSessions,
  registerUser,
  sessionTouchDue,
  signOutOtherSessions,
  signOutSession,
  touchSession,
  updateProfile,
  userConflictFromError,
} from "@/server/users";
import { useFreshDb } from "./helpers";

let db: DB;
beforeEach(async () => {
  db = await useFreshDb();
});

const PW = "password1";

describe("passwords", () => {
  it("hashes with a random salt and verifies", async () => {
    const h1 = await hashPassword("correct horse");
    const h2 = await hashPassword("correct horse");
    expect(h1).not.toBe(h2);
    expect(await verifyPassword("correct horse", h1)).toBe(true);
    expect(await verifyPassword("wrong horse", h1)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("registration", () => {
  it("needs only a user ID and a password; optional fields are stored as NULL", async () => {
    const u = await registerUser({ username: " Ana_1 ", password: PW, email: "", firstName: "  ", lastName: "" });
    expect(u).toEqual({ id: u.id, username: "ana_1", email: null, firstName: null, lastName: null, timeZone: null, displayName: "ana_1" });
    expect((await db.select().from(users))[0]).toMatchObject({ username: "ana_1", email: null, firstName: null, lastName: null });
    expect(await listCategories(u.id)).toHaveLength(8);

    // Omitted entirely behaves the same as empty.
    const v = await registerUser({ username: "bob", password: PW });
    expect(v).toMatchObject({ email: null, firstName: null, lastName: null });
  });

  it("stores every optional field, trimmed, with the email lowercased", async () => {
    const u = await registerUser({
      username: "Ana.Pop",
      password: PW,
      email: " Ana@Example.COM ",
      firstName: " Ana Maria ",
      lastName: " Pop ",
    });
    expect(u).toEqual({
      id: u.id,
      username: "ana.pop",
      email: "ana@example.com",
      firstName: "Ana Maria",
      lastName: "Pop",
      timeZone: null,
      displayName: "Ana Maria Pop",
    });
  });

  it.each([
    ["ab", "at least 3"],
    ["a".repeat(33), "at most 32"],
    ["ana pop", "only letters"],
    ["ana!", "only letters"],
    ["anä", "only letters"],
    ["-ana", "Start with"],
    [".ana", "Start with"],
    ["_ana", "Start with"],
    ["ana@example.com", "@"],
    ["", "Choose a user ID"],
  ])("rejects the user ID %j", async (username, message) => {
    const err = await registerUser({ username, password: PW }).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toMatchObject({ code: "VALIDATION", field: "username" });
    expect(err.message).toContain(message);
  });

  it("accepts user IDs at the length limits and with dots, dashes, underscores and leading digits", async () => {
    for (const username of ["abc", "a".repeat(32), "1st.try_x-y", "a-b"]) {
      await expect(registerUser({ username, password: PW })).resolves.toMatchObject({ username });
    }
  });

  it("rejects a user ID that differs only in case, on the username field", async () => {
    await registerUser({ username: "alex", password: PW });
    await expect(registerUser({ username: "ALEX", password: PW })).rejects.toMatchObject({
      code: "CONFLICT",
      field: "username",
    });
  });

  it("rejects an email that differs only in case, on the email field", async () => {
    await registerUser({ username: "ana", password: PW, email: "ana@example.com" });
    await expect(
      registerUser({ username: "ana2", password: PW, email: "ANA@Example.com" }),
    ).rejects.toMatchObject({ code: "CONFLICT", field: "email" });
  });

  it("lets several accounts exist without an email", async () => {
    await registerUser({ username: "one", password: PW });
    await registerUser({ username: "two", password: PW, email: "" });
    await registerUser({ username: "three", password: PW, email: "   " });
    expect((await db.select().from(users).orderBy(users.id)).map((u) => u.email)).toEqual([null, null, null]);
  });

  it("validates email, names and password", async () => {
    await expect(registerUser({ username: "ana", password: PW, email: "not-an-email" })).rejects.toMatchObject({
      field: "email",
    });
    await expect(registerUser({ username: "ana", password: "short" })).rejects.toMatchObject({ field: "password" });
    await expect(registerUser({ username: "ana", password: PW, firstName: "x".repeat(81) })).rejects.toMatchObject({
      code: "VALIDATION",
      field: "firstName",
    });
    await expect(registerUser({ username: "ana", password: PW, lastName: "x".repeat(81) })).rejects.toMatchObject({
      code: "VALIDATION",
      field: "lastName",
    });
    await expect(
      registerUser({ username: "ana", password: PW, firstName: "x".repeat(80), lastName: "y".repeat(80) }),
    ).resolves.toMatchObject({ firstName: "x".repeat(80) });
    expect(await db.select().from(users)).toHaveLength(1);
  });
});

describe("account time zone", () => {
  it("accepts IANA zones in their canonical spelling, plus UTC; nothing else", () => {
    expect(canonicalTimeZone("Europe/Bucharest")).toBe("Europe/Bucharest");
    expect(canonicalTimeZone(" europe/bucharest ")).toBe("Europe/Bucharest");
    expect(canonicalTimeZone("US/Eastern")).toBe("America/New_York");
    expect(canonicalTimeZone("UTC")).toBe("UTC");
    expect(canonicalTimeZone("Etc/UTC")).toBe("UTC");
    for (const bad of [undefined, null, 42, "", "  ", "Mars/Olympus_Mons", "+02:00", "x".repeat(200)]) {
      expect(canonicalTimeZone(bad), String(bad)).toBeNull();
    }
    const all = listTimeZones();
    expect(all).toContain("UTC");
    expect(all).toContain("Europe/Bucharest");
    for (const z of all) expect(canonicalTimeZone(z), z).toBe(z);
  });

  it("registration stores a valid browser zone and ignores an invalid or missing one", async () => {
    expect((await registerUser({ username: "ana", password: PW, timeZone: "Europe/Bucharest" })).timeZone).toBe("Europe/Bucharest");
    expect((await registerUser({ username: "bob", password: PW, timeZone: "Not/AZone" })).timeZone).toBeNull();
    expect((await registerUser({ username: "cat", password: PW })).timeZone).toBeNull();
    expect((await db.select({ u: users.username, tz: users.timeZone }).from(users).orderBy(users.id))).toEqual([
      { u: "ana", tz: "Europe/Bucharest" },
      { u: "bob", tz: null },
      { u: "cat", tz: null },
    ]);
  });

  it("sign-in adopts the browser zone only while the account has none", async () => {
    const ana = await registerUser({ username: "ana", password: PW });
    const bob = await registerUser({ username: "bob", password: PW });
    expect(await adoptTimeZoneIfUnset(ana.id, "Not/AZone")).toBe(false);
    expect(await adoptTimeZoneIfUnset(ana.id, undefined)).toBe(false);
    expect(await getUserTimeZone(ana.id)).toBeNull();
    expect(await adoptTimeZoneIfUnset(ana.id, "Europe/Bucharest")).toBe(true);
    expect(await adoptTimeZoneIfUnset(ana.id, "America/New_York")).toBe(false);
    expect(await getUserTimeZone(ana.id)).toBe("Europe/Bucharest");
    expect(await getUserTimeZone(bob.id)).toBeNull();
    expect(await getUserTimeZone(9999)).toBeNull();
    // A stored zone the runtime does not know counts as not set.
    await db.update(users).set({ timeZone: "Gone/Zone" }).where(eq(users.id, bob.id));
    expect(await getUserTimeZone(bob.id)).toBeNull();
  });
});

describe("sign-in", () => {
  it("accepts the user ID or the email, in any letter case", async () => {
    const u = await registerUser({ username: "ana.pop", password: PW, email: "ana@example.com" });
    for (const identifier of ["ana.pop", "ANA.Pop", " ana.pop ", "ana@example.com", "Ana@EXAMPLE.com"]) {
      expect(await authenticateUser(identifier, PW)).toMatchObject({ id: u.id, username: "ana.pop" });
    }
  });

  it("returns null for a wrong password, an unknown identifier or an empty one", async () => {
    await registerUser({ username: "ana", password: PW, email: "ana@example.com" });
    await registerUser({ username: "noemail", password: PW });
    expect(await authenticateUser("ana", "nope-nope")).toBeNull();
    expect(await authenticateUser("ana@example.com", "nope-nope")).toBeNull();
    expect(await authenticateUser("nobody", PW)).toBeNull();
    expect(await authenticateUser("nobody@example.com", PW)).toBeNull();
    // An account without email cannot be reached through an empty or blank identifier.
    expect(await authenticateUser("", PW)).toBeNull();
    expect(await authenticateUser("   ", PW)).toBeNull();
    expect(await authenticateUser("@", PW)).toBeNull();
    expect(await authenticateUser("noemail", PW)).toMatchObject({ username: "noemail" });
  });

  it("does not treat a user ID as an email or the other way round", async () => {
    await registerUser({ username: "ana", password: PW, email: "bob@example.com" });
    expect(await authenticateUser("bob", PW)).toBeNull();
    expect(await authenticateUser("ana@x", PW)).toBeNull();
  });
});

describe("displayName", () => {
  it.each([
    [{ firstName: "Ana", lastName: "Pop" }, "Ana Pop"],
    [{ firstName: "Ana", lastName: null }, "Ana"],
    [{ firstName: null, lastName: "Pop" }, "Pop"],
    [{ firstName: null, lastName: null }, "ana.p"],
    [{ firstName: "", lastName: "" }, "ana.p"],
  ])("%j → %s", (names, expected) => {
    expect(displayName({ username: "ana.p", ...names })).toBe(expected);
  });
});

describe("changePassword", () => {
  const sess = (userId: number, tokenHash: string) =>
    db.insert(sessions).values({ userId, tokenHash, expiresAt: new Date(Date.now() + 86_400_000) });
  const hashesOf = async (userId: number) =>
    (await db.select({ h: sessions.tokenHash }).from(sessions).where(eq(sessions.userId, userId))).map((r) => r.h).sort();

  async function setup() {
    const a = await registerUser({ username: "alice", password: PW });
    const b = await registerUser({ username: "bob", password: PW });
    await sess(a.id, "a1");
    await sess(a.id, "a2");
    await sess(b.id, "b1");
    return { a: a.id, b: b.id };
  }

  it("rejects a wrong current password and changes nothing", async () => {
    const { a } = await setup();
    const err = await changePassword(a, { currentPassword: "nope-nope", newPassword: "brand-new-pw" }, { keepSessionTokenHash: "a1" }).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect(err).toMatchObject({ code: "VALIDATION", field: "currentPassword" });
    expect(await authenticateUser("alice", PW)).not.toBeNull();
    expect(await hashesOf(a)).toEqual(["a1", "a2"]);
  });

  it("treats an unknown user like a wrong current password", async () => {
    await expect(
      changePassword(999, { currentPassword: PW, newPassword: "brand-new-pw" }, { keepSessionTokenHash: null }),
    ).rejects.toMatchObject({ field: "currentPassword" });
  });

  it("rejects a too-short new password and changes nothing", async () => {
    const { a } = await setup();
    await expect(
      changePassword(a, { currentPassword: PW, newPassword: "short" }, { keepSessionTokenHash: "a1" }),
    ).rejects.toMatchObject({ code: "VALIDATION", field: "newPassword" });
    expect(await authenticateUser("alice", PW)).not.toBeNull();
    expect(await hashesOf(a)).toEqual(["a1", "a2"]);
  });

  it("switches to the new password, keeps one session, spares other users", async () => {
    const { a, b } = await setup();
    await changePassword(a, { currentPassword: PW, newPassword: "brand-new-pw" }, { keepSessionTokenHash: "a1" });
    expect(await authenticateUser("alice", "brand-new-pw")).not.toBeNull();
    expect(await authenticateUser("alice", PW)).toBeNull();
    expect(await hashesOf(a)).toEqual(["a1"]);
    expect(await hashesOf(b)).toEqual(["b1"]);
  });

  it("deletes all of the user's sessions when no session is kept", async () => {
    const { a, b } = await setup();
    await changePassword(a, { currentPassword: PW, newPassword: "brand-new-pw" }, { keepSessionTokenHash: null });
    expect(await hashesOf(a)).toEqual([]);
    expect(await hashesOf(b)).toEqual(["b1"]);
  });
});

describe("unique indexes and the race mapping", () => {
  it("maps a unique violation of each lower(...) index to the right field", async () => {
    await db.insert(users).values({ username: "alex", email: "alex@example.com", passwordHash: "x" });
    // Straight inserts skip the service's checks, as a lost race would.
    const conflictOf = (values: typeof users.$inferInsert) =>
      db
        .insert(users)
        .values(values)
        .then(
          () => null,
          (e: unknown) => userConflictFromError(e),
        );
    expect(await conflictOf({ username: "ALEX", passwordHash: "x" })).toMatchObject({ code: "CONFLICT", field: "username" });
    expect(await conflictOf({ username: "other", email: "Alex@Example.com", passwordHash: "x" })).toMatchObject({
      code: "CONFLICT",
      field: "email",
    });
    expect(userConflictFromError(new Error("boom"))).toBeNull();
  });

  /**
   * Make the service's "is it free?" checks (`select({ id })`) find nothing, as if the other row were not there
   * yet; whole-row lookups (`select()`) still work.
   */
  function blindChecks() {
    const nothing = { from: () => ({ where: () => ({ limit: async () => [] }) }) };
    const blind = (select: (...a: unknown[]) => unknown) => (...args: unknown[]) => (args.length ? nothing : select(...args));
    const original = { select: db.select.bind(db), transaction: db.transaction.bind(db) };
    const spies = [
      vi.spyOn(db, "select").mockImplementation(blind(original.select) as never),
      vi.spyOn(db, "transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>) =>
        original.transaction((tx) => {
          const select = blind(tx.select.bind(tx) as never);
          return fn(new Proxy(tx, { get: (t, k) => (k === "select" ? select : Reflect.get(t, k)) }));
        })) as never),
    ];
    return () => spies.forEach((s) => s.mockRestore());
  }

  it("registerUser reports a lost race on the field whose index fired", async () => {
    await db.insert(users).values({ username: "taken", email: "taken@example.com", passwordHash: "x" });
    const restore = blindChecks();
    try {
      await expect(registerUser({ username: "Taken", password: PW })).rejects.toMatchObject({
        code: "CONFLICT",
        field: "username",
      });
      await expect(registerUser({ username: "fresh", password: PW, email: "TAKEN@example.com" })).rejects.toMatchObject({
        code: "CONFLICT",
        field: "email",
      });
    } finally {
      restore();
    }
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it("updateProfile reports a lost race on the field whose index fired", async () => {
    const ana = await registerUser({ username: "ana", password: PW });
    await db.insert(users).values({ username: "taken", email: "taken@example.com", passwordHash: "x" });
    const restore = blindChecks();
    try {
      const base = { username: "ana", currentPassword: PW };
      await expect(updateProfile(ana.id, { ...base, username: "TAKEN" })).rejects.toMatchObject({
        code: "CONFLICT",
        field: "username",
      });
      await expect(updateProfile(ana.id, { ...base, email: "Taken@example.com" })).rejects.toMatchObject({
        code: "CONFLICT",
        field: "email",
      });
    } finally {
      restore();
    }
    expect((await db.select().from(users).where(eq(users.id, ana.id)))[0]).toMatchObject({ username: "ana", email: null });
  });
});

describe("updateProfile", () => {
  async function ana() {
    return registerUser({ username: "ana", password: PW, email: "ana@example.com", firstName: "Ana", lastName: "Pop" });
  }

  it("changes the names without a password; empty removes them", async () => {
    const u = await ana();
    expect(await updateProfile(u.id, { username: "ana", email: "ana@example.com", firstName: " Maria ", lastName: "" })).toEqual({
      id: u.id,
      username: "ana",
      email: "ana@example.com",
      firstName: "Maria",
      lastName: null,
      timeZone: null,
      displayName: "Maria",
    });
  });

  it("sets, keeps and clears the time zone without a password; refuses an unknown zone on the field", async () => {
    const u = await ana();
    const base = { username: "ana", email: "ana@example.com", firstName: "Ana", lastName: "Pop" };
    expect((await updateProfile(u.id, { ...base, timeZone: "europe/bucharest" })).timeZone).toBe("Europe/Bucharest");
    // Omitted: unchanged.
    expect((await updateProfile(u.id, base)).timeZone).toBe("Europe/Bucharest");
    expect(await getUserTimeZone(u.id)).toBe("Europe/Bucharest");
    for (const bad of ["Mars/Olympus_Mons", "+02:00", "x".repeat(200)]) {
      await expect(updateProfile(u.id, { ...base, timeZone: bad })).rejects.toMatchObject({ code: "VALIDATION", field: "timeZone" });
    }
    expect(await getUserTimeZone(u.id)).toBe("Europe/Bucharest");
    expect((await updateProfile(u.id, { ...base, timeZone: "" })).timeZone).toBeNull();
    expect((await updateProfile(u.id, { ...base, timeZone: "Etc/UTC" })).timeZone).toBe("UTC");
    expect((await updateProfile(u.id, { ...base, timeZone: null })).timeZone).toBeNull();
  });

  it("needs the current password to change the user ID, and then signs in with the new one", async () => {
    const u = await ana();
    await expect(updateProfile(u.id, { username: "ana2", email: "ana@example.com" })).rejects.toMatchObject({
      code: "VALIDATION",
      field: "currentPassword",
      message: expect.stringContaining("Enter your current password"),
    });
    const wrong = await updateProfile(u.id, { username: "ana2", email: "ana@example.com", currentPassword: "nope-nope" }).catch((e) => e);
    expect(wrong).toMatchObject({ field: "currentPassword" });
    expect(isWrongPasswordError(wrong)).toBe(true);
    expect((await authenticateUser("ana", PW))?.username).toBe("ana");

    await updateProfile(u.id, { username: " Ana2 ", email: "ana@example.com", currentPassword: PW });
    expect(await authenticateUser("ana2", PW)).toMatchObject({ id: u.id });
    expect(await authenticateUser("ana", PW)).toBeNull();
  });

  it("needs the current password to add, change or remove the email", async () => {
    const u = await registerUser({ username: "bob", password: PW });
    for (const email of ["bob@example.com", "robert@example.com", ""]) {
      await expect(updateProfile(u.id, { username: "bob", email })).rejects.toMatchObject({ field: "currentPassword" });
      const saved = await updateProfile(u.id, { username: "bob", email, currentPassword: PW });
      expect(saved.email).toBe(email || null);
    }
  });

  it("treats a change of letter case only as no change (no password needed)", async () => {
    const u = await ana();
    await expect(updateProfile(u.id, { username: "ANA", email: "Ana@Example.com" })).resolves.toMatchObject({
      username: "ana",
      email: "ana@example.com",
    });
  });

  it("applies the registration rules and reports conflicts with other accounts on the field", async () => {
    const u = await ana();
    await registerUser({ username: "bob", password: PW, email: "bob@example.com" });
    const base = { username: "ana", email: "ana@example.com", currentPassword: PW };
    await expect(updateProfile(u.id, { ...base, username: "a" })).rejects.toMatchObject({ code: "VALIDATION", field: "username" });
    await expect(updateProfile(u.id, { ...base, username: "a@b" })).rejects.toMatchObject({ field: "username" });
    await expect(updateProfile(u.id, { ...base, email: "nope" })).rejects.toMatchObject({ code: "VALIDATION", field: "email" });
    await expect(updateProfile(u.id, { ...base, firstName: "x".repeat(81) })).rejects.toMatchObject({ field: "firstName" });
    await expect(updateProfile(u.id, { ...base, username: "BOB" })).rejects.toMatchObject({ code: "CONFLICT", field: "username" });
    await expect(updateProfile(u.id, { ...base, email: "BOB@example.com" })).rejects.toMatchObject({ code: "CONFLICT", field: "email" });
    // Conflicts are reported before the password is checked (no attempt is spent on them).
    await expect(updateProfile(u.id, { ...base, username: "bob", currentPassword: "" })).rejects.toMatchObject({ field: "username" });
    expect(await authenticateUser("ana", PW)).toMatchObject({ email: "ana@example.com", firstName: "Ana" });
  });

  it("keeps the sessions valid and rejects an unknown user", async () => {
    const u = await ana();
    await db.insert(sessions).values({ userId: u.id, tokenHash: "s", expiresAt: new Date(Date.now() + 86_400_000) });
    await updateProfile(u.id, { username: "ana.pop", email: "ana@example.com", currentPassword: PW });
    expect(await db.select().from(sessions)).toHaveLength(1);
    await expect(updateProfile(999, { username: "zed" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("sessions", () => {
  const future = () => new Date(Date.now() + 86_400_000);
  const past = () => new Date(Date.now() - 1000);

  async function setup() {
    const a = await registerUser({ username: "alice", password: PW });
    const b = await registerUser({ username: "bob", password: PW });
    await db.insert(sessions).values([
      { userId: a.id, tokenHash: "a-current", expiresAt: future() },
      { userId: a.id, tokenHash: "a-phone", expiresAt: future() },
      { userId: a.id, tokenHash: "a-old", expiresAt: past() },
      { userId: b.id, tokenHash: "b-live", expiresAt: future() },
      { userId: b.id, tokenHash: "b-old", expiresAt: past() },
    ]);
    return { a: a.id, b: b.id };
  }
  const hashes = async () => (await db.select({ h: sessions.tokenHash }).from(sessions)).map((r) => r.h).sort();

  it("lists the user's active sessions only, the current one first, without token hashes", async () => {
    const { a, b } = await setup();
    const t = Date.now();
    await db.update(sessions).set({ lastUsedAt: new Date(t - 60_000), userAgent: "UA phone" }).where(eq(sessions.tokenHash, "a-phone"));
    await db.update(sessions).set({ lastUsedAt: new Date(t - 3_600_000) }).where(eq(sessions.tokenHash, "a-current"));

    const list = await listSessions(a, "a-current");
    expect(list.map((s) => [s.current, s.userAgent])).toEqual([
      [true, null],
      [false, "UA phone"],
    ]);
    expect(Object.keys(list[0]).sort()).toEqual(["createdAt", "current", "id", "lastUsedAt", "userAgent"]);
    // Without a current session nothing is marked, most recently used first.
    expect((await listSessions(a, null)).map((s) => s.userAgent)).toEqual(["UA phone", null]);
    expect((await listSessions(b, "a-current")).map((s) => s.current)).toEqual([false]);
  });

  it("signs out one other session of the user; never the current one or another user's", async () => {
    const { a } = await setup();
    const [phone] = await db.select().from(sessions).where(eq(sessions.tokenHash, "a-phone"));
    const [current] = await db.select().from(sessions).where(eq(sessions.tokenHash, "a-current"));
    const [bobs] = await db.select().from(sessions).where(eq(sessions.tokenHash, "b-live"));

    await expect(signOutSession(a, bobs.id, "a-current")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(signOutSession(a, current.id, "a-current")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await signOutSession(a, phone.id, "a-current");
    await expect(signOutSession(a, phone.id, "a-current")).rejects.toThrow("That device is no longer signed in.");
    expect(await hashes()).toEqual(["a-current", "a-old", "b-live", "b-old"]);
  });

  it("marks a session used at most once per interval", async () => {
    await setup();
    const [s] = await db.select().from(sessions).where(eq(sessions.tokenHash, "a-current"));
    const t0 = new Date(s.lastUsedAt.getTime() + SESSION_TOUCH_INTERVAL_MS);
    const lastUsed = async () => (await db.select().from(sessions).where(eq(sessions.id, s.id)))[0].lastUsedAt.getTime();

    expect(await touchSession(s.id, new Date(t0.getTime() - 1))).toBe(false); // not yet due
    expect(await touchSession(s.id, t0)).toBe(true);
    expect(await lastUsed()).toBe(t0.getTime());
    expect(await touchSession(s.id, new Date(t0.getTime() + 60_000))).toBe(false); // a minute later: no write
    expect(await lastUsed()).toBe(t0.getTime());
    const later = new Date(t0.getTime() + SESSION_TOUCH_INTERVAL_MS);
    expect(await touchSession(s.id, later)).toBe(true);
    expect(await lastUsed()).toBe(later.getTime());

    expect(sessionTouchDue(t0, new Date(t0.getTime() + SESSION_TOUCH_INTERVAL_MS - 1))).toBe(false);
    expect(sessionTouchDue(t0, new Date(t0.getTime() + SESSION_TOUCH_INTERVAL_MS))).toBe(true);
  });

  it("signs out the other sessions of that user and keeps the current one", async () => {
    const { a } = await setup();
    expect(await signOutOtherSessions(a, "a-current")).toBe(2); // the phone and the expired one
    expect(await hashes()).toEqual(["a-current", "b-live", "b-old"]);
  });

  it("deletes expired sessions of one user, or of everyone", async () => {
    const { a } = await setup();
    expect(await deleteExpiredSessions(a)).toBe(1);
    expect(await hashes()).toEqual(["a-current", "a-phone", "b-live", "b-old"]);
    expect(await deleteExpiredSessions()).toBe(1);
    expect(await hashes()).toEqual(["a-current", "a-phone", "b-live"]);
  });
});

describe("deleteAccount", () => {
  it("needs the current password and the user ID typed out; deletes nothing otherwise", async () => {
    const u = await registerUser({ username: "Alice", password: PW });
    await expect(deleteAccount(u.id, { currentPassword: "nope-nope", confirmUsername: "alice" })).rejects.toMatchObject({
      field: "currentPassword",
    });
    await expect(deleteAccount(u.id, { currentPassword: PW, confirmUsername: "alicia" })).rejects.toMatchObject({
      code: "VALIDATION",
      field: "confirmUsername",
    });
    await expect(deleteAccount(999, { currentPassword: PW, confirmUsername: "alice" })).rejects.toMatchObject({
      field: "currentPassword",
    });
    expect(await db.select().from(users)).toHaveLength(1);
  });

  it("deletes the user and everything they own, in any letter case of the user ID, and spares other users", async () => {
    const alice = await registerUser({ username: "alice", password: PW });
    const bob = await registerUser({ username: "bob", password: PW });
    for (const userId of [alice.id, bob.id]) {
      const [group] = await db.select().from(walletGroups).where(eq(walletGroups.userId, userId));
      const [cat] = (await listCategories(userId)).filter((c) => c.kind === "expense");
      const [w1] = await db.insert(wallets).values({ userId, groupId: group.id, name: "Cash", currency: "EUR" }).returning();
      const [w2] = await db.insert(wallets).values({ userId, groupId: group.id, name: "Bank", currency: "EUR" }).returning();
      const [t] = await db.insert(transfers).values({ userId, date: "2026-01-02" }).returning();
      await db.insert(transactions).values([
        { userId, walletId: w1.id, kind: "expense", categoryId: cat.id, amountMinor: 100, date: "2026-01-01" },
        { userId, walletId: w1.id, kind: "transfer_out", transferId: t.id, amountMinor: 50, date: "2026-01-02" },
        { userId, walletId: w2.id, kind: "transfer_in", transferId: t.id, amountMinor: 50, date: "2026-01-02" },
      ]);
      await db.insert(sessions).values({ userId, tokenHash: `s${userId}`, expiresAt: new Date(Date.now() + 86_400_000) });
    }

    await deleteAccount(alice.id, { currentPassword: PW, confirmUsername: " ALICE " });

    for (const table of [transactions, transfers, wallets, walletGroups, categories, sessions]) {
      const rows = (await db.select().from(table)) as { userId: number }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.userId === bob.id)).toBe(true);
    }
    expect((await db.select().from(users)).map((u) => u.username)).toEqual(["bob"]);
  });
});

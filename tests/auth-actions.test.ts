// The sign-in and /account Server Actions: rate limiting, expired-session cleanup, profile, devices and account
// deletion. Next's request APIs and the session helpers are mocked; the services and the limiter run for real.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DB } from "@/db";
import { sessions, users } from "@/db/schema";
import { RateLimiter, setPasswordLimiters } from "@/lib/rate-limit";
import { registerUser } from "@/server/users";
import { useFreshDb } from "./helpers";

const ctx = vi.hoisted(() => ({
  userId: 0,
  tokenHash: "current" as string | null,
  forwardedFor: "203.0.113.7" as string | null,
  created: [] as number[],
  cookieCleared: 0,
  revalidated: [] as unknown[][],
}));

vi.mock("@/lib/auth", () => ({
  requireUser: async () => ({ id: ctx.userId }),
  currentSessionTokenHash: async () => ctx.tokenHash,
  createSession: async (userId: number) => {
    ctx.created.push(userId);
  },
  clearSessionCookie: async () => {
    ctx.cookieCleared++;
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(ctx.forwardedFor ? { "x-forwarded-for": ctx.forwardedFor } : {}),
}));
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => {
    ctx.revalidated.push(args);
  },
}));
class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect ${url}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

const { loginAction } = await import("@/app/(auth)/login/actions");
const { registerAction } = await import("@/app/(auth)/register/actions");
const { changePasswordAction, deleteAccountAction, signOutOtherDevicesAction, updateProfileAction } = await import(
  "@/app/(app)/account/actions"
);

const PW = "password1";
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.append(k, v);
  return f;
};
async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof RedirectSignal) return err.url;
    throw err;
  }
  throw new Error("expected a redirect");
}

let db: DB;
const clock = { t: 1_000_000 };
beforeEach(async () => {
  db = await useFreshDb();
  clock.t = 1_000_000;
  setPasswordLimiters({
    identifier: new RateLimiter({ limit: 5, windowMs: 15 * 60_000, now: () => clock.t }),
    address: new RateLimiter({ limit: 30, windowMs: 15 * 60_000, now: () => clock.t }),
  });
  Object.assign(ctx, { userId: 0, tokenHash: "current", forwardedFor: "203.0.113.7", created: [], cookieCleared: 0, revalidated: [] });
});

const login = (identifier: string, password: string, extra: Record<string, string> = {}) =>
  loginAction({}, fd({ identifier, password, ...extra }));
const zoneOf = async (id: number) => (await db.select().from(users).where(eq(users.id, id)))[0].timeZone;

describe("loginAction rate limiting", () => {
  it("refuses an identifier after 5 failures, for an existing account and an unknown one alike, until the window ends", async () => {
    const ana = await registerUser({ username: "ana", password: PW });
    for (const identifier of ["ana", "ghost"]) {
      for (let i = 0; i < 5; i++) {
        expect((await login(identifier, "wrong-pw")).message).toBe("Invalid user ID, email or password");
      }
      // Even the right password is refused now; the message does not tell whether the account exists.
      expect((await login(identifier, PW)).message).toBe("Too many sign-in attempts. Try again in 15 minutes.");
    }
    expect(ctx.created).toEqual([]);

    clock.t += 15 * 60_000;
    expect(await redirectOf(login("ANA", PW))).toBe("/");
    expect(ctx.created).toEqual([ana.id]);
  });

  it("counts identifiers case-insensitively and resets the identifier after a successful sign-in", async () => {
    await registerUser({ username: "ana", password: PW });
    for (let i = 0; i < 4; i++) await login(i % 2 ? "ANA" : " ana ", "wrong-pw");
    expect(await redirectOf(login("ana", PW))).toBe("/");
    for (let i = 0; i < 4; i++) await login("ana", "wrong-pw");
    expect(await redirectOf(login("ana", PW))).toBe("/"); // without the reset: 8 failures, refused
  });

  it("refuses a client address after its limit of failures across identifiers; without an address only the identifier limit applies", async () => {
    // A small address limit keeps the test fast (every failed sign-in spends one scrypt); the production numbers
    // (5 and 30) are the constants in src/lib/rate-limit.ts.
    setPasswordLimiters({
      identifier: new RateLimiter({ limit: 5, windowMs: 15 * 60_000, now: () => clock.t }),
      address: new RateLimiter({ limit: 3, windowMs: 15 * 60_000, now: () => clock.t }),
    });
    await registerUser({ username: "ana", password: PW });
    for (let i = 0; i < 3; i++) await login(`ghost${i}`, "wrong-pw");
    expect((await login("ana", PW)).message).toMatch(/^Too many sign-in attempts/);
    ctx.forwardedFor = "198.51.100.1, 203.0.113.7";
    expect(await redirectOf(login("ana", PW))).toBe("/");

    ctx.forwardedFor = null;
    for (let i = 0; i < 4; i++) await login(`other${i}`, "wrong-pw");
    expect(await redirectOf(login("ana", PW))).toBe("/");
  });

  it("deletes every account's expired sessions at sign-in", async () => {
    const ana = await registerUser({ username: "ana", password: PW });
    const bob = await registerUser({ username: "bob", password: PW });
    await db.insert(sessions).values([
      { userId: ana.id, tokenHash: "old-a", expiresAt: new Date(Date.now() - 1000) },
      { userId: bob.id, tokenHash: "old-b", expiresAt: new Date(Date.now() - 1000) },
      { userId: bob.id, tokenHash: "live-b", expiresAt: new Date(Date.now() + 86_400_000) },
    ]);
    await redirectOf(login("ana", PW));
    expect((await db.select().from(sessions)).map((s) => s.tokenHash)).toEqual(["live-b"]);
  });
});

describe("time zone from the sign-in and registration forms", () => {
  it("a successful sign-in stores the browser's zone only when the account has none; a failed one never", async () => {
    const ana = await registerUser({ username: "ana", password: PW });
    await login("ana", "wrong-pw", { timeZone: "Europe/Bucharest" });
    expect(await zoneOf(ana.id)).toBeNull();
    await redirectOf(login("ana", PW, { timeZone: "Not/AZone" }));
    expect(await zoneOf(ana.id)).toBeNull();
    await redirectOf(login("ana", PW));
    expect(await zoneOf(ana.id)).toBeNull();
    await redirectOf(login("ana", PW, { timeZone: "Europe/Bucharest" }));
    expect(await zoneOf(ana.id)).toBe("Europe/Bucharest");
    await redirectOf(login("ana", PW, { timeZone: "America/New_York" }));
    expect(await zoneOf(ana.id)).toBe("Europe/Bucharest");
  });

  it("registration stores the hidden field's zone", async () => {
    expect(await redirectOf(registerAction({}, fd({ username: "cat", password: PW, timeZone: "Asia/Tokyo" })))).toBe("/");
    const [row] = await db.select().from(users).where(eq(users.username, "cat"));
    expect(row.timeZone).toBe("Asia/Tokyo");
  });
});

describe("/account actions", () => {
  async function signedIn() {
    const u = await registerUser({ username: "ana", password: PW, email: "ana@example.com" });
    ctx.userId = u.id;
    return u;
  }

  it("profile: saves the names without a password and echoes the saved values", async () => {
    await signedIn();
    const state = await updateProfileAction({}, fd({ username: "ana", email: "ana@example.com", firstName: " Ana ", lastName: "Pop" }));
    expect(state).toMatchObject({ ok: true, values: { username: "ana", firstName: "Ana", lastName: "Pop" } });
    expect(ctx.revalidated).toContainEqual(["/", "layout"]);
  });

  it("profile: sets and clears the time zone without a password, echoing it back", async () => {
    const u = await signedIn();
    const base = { username: "ana", email: "ana@example.com" };
    expect(await updateProfileAction({}, fd({ ...base, timeZone: "Europe/Bucharest" }))).toMatchObject({ ok: true, values: { timeZone: "Europe/Bucharest" } });
    expect(await zoneOf(u.id)).toBe("Europe/Bucharest");
    expect((await updateProfileAction({}, fd({ ...base, timeZone: "Nowhere/Land" }))).fieldErrors).toEqual({ timeZone: "Choose a time zone from the list." });
    expect(await updateProfileAction({}, fd({ ...base, timeZone: "" }))).toMatchObject({ ok: true, values: { timeZone: "" } });
    expect(await zoneOf(u.id)).toBeNull();
  });

  it("profile: errors land on the field and the password is never echoed", async () => {
    await signedIn();
    await registerUser({ username: "bob", password: PW });
    const taken = await updateProfileAction({}, fd({ username: "bob", email: "ana@example.com", currentPassword: PW }));
    expect(taken.fieldErrors).toEqual({ username: "This user ID is already taken." });
    expect(taken.values).not.toHaveProperty("currentPassword");
    const noPw = await updateProfileAction({}, fd({ username: "ana2", email: "ana@example.com" }));
    expect(noPw.fieldErrors?.currentPassword).toMatch(/Enter your current password/);
  });

  it("the current-password checks share one per-account limit of 5 failures", async () => {
    const u = await signedIn();
    const wrong = { currentPassword: "wrong-pw" };
    await changePasswordAction({}, fd({ ...wrong, newPassword: "brand-new-pw", confirmPassword: "brand-new-pw" }));
    await updateProfileAction({}, fd({ username: "ana2", email: "", ...wrong }));
    await deleteAccountAction({}, fd({ confirmUsername: "ana", ...wrong }));
    // A missing password is not a failed check.
    await updateProfileAction({}, fd({ username: "ana2" }));
    await changePasswordAction({}, fd({ ...wrong, newPassword: "brand-new-pw", confirmPassword: "brand-new-pw" }));
    expect((await changePasswordAction({}, fd({ ...wrong, newPassword: "brand-new-pw", confirmPassword: "brand-new-pw" }))).fieldErrors).toEqual({
      currentPassword: "That is not your current password.",
    });
    // 5 failures: now even the right password is refused, on every form.
    const locked = await deleteAccountAction({}, fd({ confirmUsername: "ana", currentPassword: PW }));
    expect(locked.message).toBe("Too many password attempts. Try again in 15 minutes.");
    expect((await updateProfileAction({}, fd({ username: "ana2", currentPassword: PW }))).message).toMatch(/^Too many/);
    // Names only need no password, so they still save.
    expect(await updateProfileAction({}, fd({ username: "ana", email: "ana@example.com", firstName: "A" }))).toMatchObject({ ok: true });
    expect(await db.select().from(users).where(eq(users.id, u.id))).toHaveLength(1);

    clock.t += 15 * 60_000;
    expect(await updateProfileAction({}, fd({ username: "ana2", email: "ana@example.com", currentPassword: PW }))).toMatchObject({ ok: true });
  });

  it("sign out other devices keeps the current session", async () => {
    const u = await signedIn();
    const later = new Date(Date.now() + 86_400_000);
    await db.insert(sessions).values([
      { userId: u.id, tokenHash: "current", expiresAt: later },
      { userId: u.id, tokenHash: "phone", expiresAt: later },
    ]);
    expect(await signOutOtherDevicesAction()).toEqual({ ok: true, message: "Signed out 1 other session." });
    expect((await db.select().from(sessions)).map((s) => s.tokenHash)).toEqual(["current"]);
    expect(await signOutOtherDevicesAction()).toEqual({ ok: true, message: "No other devices were signed in." });
  });

  it("delete account: wrong confirmation keeps everything; the right one deletes, clears the cookie and redirects with a notice", async () => {
    const u = await signedIn();
    const bad = await deleteAccountAction({}, fd({ confirmUsername: "nope", currentPassword: PW }));
    expect(bad.fieldErrors?.confirmUsername).toMatch(/Type your user ID, ana/);
    expect(bad.values).toEqual({ confirmUsername: "nope" });
    expect(await redirectOf(deleteAccountAction({}, fd({ confirmUsername: "ana", currentPassword: PW })))).toBe("/login?deleted=1");
    expect(ctx.cookieCleared).toBe(1);
    expect(await db.select().from(users).where(eq(users.id, u.id))).toHaveLength(0);
  });
});

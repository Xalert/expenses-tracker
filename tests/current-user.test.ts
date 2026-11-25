import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB } from "@/db";
import { sessions, users } from "@/db/schema";
import { makeUser, useFreshDb } from "./helpers";

// getCurrentUser reads the session cookie through next/headers; the test decides which token the request carries.
const jar = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (jar.token ? { name: "et_session", value: jar.token } : undefined) }),
  headers: async () => ({ get: () => null }),
}));

const { getCurrentUser } = await import("@/lib/auth");
const { todayInZone } = await import("@/lib/dates");

let db: DB;

beforeEach(async () => {
  db = await useFreshDb();
});

async function signIn(timeZone: string | null) {
  const alice = await makeUser(db, "alice@example.com");
  await db.update(users).set({ timeZone }).where(eq(users.id, alice.id));
  jar.token = `token-${Math.random()}`;
  await db.insert(sessions).values({
    tokenHash: createHash("sha256").update(jar.token).digest("hex"),
    userId: alice.id,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return alice;
}

describe("getCurrentUser: the account's time zone", () => {
  it("carries the stored zone, which todayInZone turns into the user's date", async () => {
    const alice = await signIn("Pacific/Auckland");
    const user = await getCurrentUser();
    expect(user).toMatchObject({ id: alice.id, timeZone: "Pacific/Auckland" });
    expect(todayInZone(user!.timeZone, new Date("2026-11-24T11:00:00Z"))).toBe("2026-11-25");
  });

  it("is null without a zone, and for a stored zone this runtime does not know", async () => {
    await signIn(null);
    expect((await getCurrentUser())?.timeZone).toBeNull();
    await useFreshDb();
    await signIn("Mars/Olympus_Mons");
    expect((await getCurrentUser())?.timeZone).toBeNull();
  });
});

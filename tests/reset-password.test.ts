// scripts/reset-password.mjs, the administrator's password reset shipped in the Docker image: its hash verifies with
// src/lib/password.ts, it deletes only that user's sessions, and its copies of shared constants stay in step.
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PGlite } from "@electric-sql/pglite";
import { DEFAULT_DEV_DATABASE_URL, type DB } from "@/db";
import { sessions, users } from "@/db/schema";
import { MIN_PASSWORD_LENGTH } from "@/lib/constants";
import { verifyPassword } from "@/lib/password";
import { authenticateUser, registerUser } from "@/server/users";
import * as script from "../scripts/reset-password.mjs";
import { useFreshDb } from "./helpers";

let db: DB;
let client: PGlite;
beforeEach(async () => {
  db = await useFreshDb();
  client = (db as unknown as { $client: PGlite }).$client;
});

const PW = "password1";
const later = () => new Date(Date.now() + 86_400_000);

describe("reset-password script", () => {
  it("writes a hash that src/lib/password.ts verifies", async () => {
    const hash = await script.hashPassword("correct horse ﬁ"); // NFKC-normalised like the app
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[^$]+\$[^$]+$/);
    expect(await verifyPassword("correct horse ﬁ", hash)).toBe(true);
    expect(await verifyPassword("correct horse fi", hash)).toBe(true);
    expect(await verifyPassword("wrong horse", hash)).toBe(false);
  });

  it("generates long random passwords from an unambiguous alphabet", () => {
    const a = script.generatePassword();
    expect(a).toHaveLength(20);
    expect(a).toMatch(/^[a-km-np-zA-HJ-NP-Z2-9]+$/);
    expect(script.generatePassword()).not.toBe(a);
  });

  it("sets the password by user ID or email (any case) and deletes only that user's sessions", async () => {
    const alice = await registerUser({ username: "alice", password: PW, email: "alice@example.com" });
    const bob = await registerUser({ username: "bob", password: PW });
    await db.insert(sessions).values([
      { userId: alice.id, tokenHash: "a1", expiresAt: later() },
      { userId: alice.id, tokenHash: "a2", expiresAt: later() },
      { userId: bob.id, tokenHash: "b1", expiresAt: later() },
    ]);

    expect(await script.resetPassword(client, " ALICE ", "brand-new-pw")).toEqual({
      id: alice.id,
      username: "alice",
      sessionsDeleted: 2,
    });
    expect(await authenticateUser("alice", "brand-new-pw")).toMatchObject({ id: alice.id });
    expect(await authenticateUser("alice", PW)).toBeNull();
    expect(await db.select().from(sessions).where(eq(sessions.userId, alice.id))).toHaveLength(0);
    expect(await db.select().from(sessions).where(eq(sessions.userId, bob.id))).toHaveLength(1);
    expect(await authenticateUser("bob", PW)).not.toBeNull();

    await script.resetPassword(client, "Alice@Example.com", "another-pw");
    expect(await authenticateUser("alice", "another-pw")).not.toBeNull();
  });

  it("returns null and changes nothing for an unknown or empty identifier", async () => {
    await registerUser({ username: "alice", password: PW });
    const [before] = await db.select({ h: users.passwordHash }).from(users);
    expect(await script.resetPassword(client, "nobody", "brand-new-pw")).toBeNull();
    expect(await script.resetPassword(client, "nobody@example.com", "brand-new-pw")).toBeNull();
    expect(await script.resetPassword(client, "  ", "brand-new-pw")).toBeNull();
    const [after] = await db.select({ h: users.passwordHash }).from(users);
    expect(after.h).toBe(before.h);
  });

  it("needs DATABASE_URL and refuses the development default outside production", () => {
    expect(script.databaseUrlProblem(undefined, "development")).toContain("DATABASE_URL is not set");
    expect(script.databaseUrlProblem(DEFAULT_DEV_DATABASE_URL, "development")).toContain("Refusing");
    expect(script.databaseUrlProblem(DEFAULT_DEV_DATABASE_URL, undefined)).toContain("Refusing");
    expect(script.databaseUrlProblem("postgres://expenses:expenses@localhost:5433/expenses_demo", undefined)).toBeNull();
    expect(script.databaseUrlProblem("postgres://expenses:pw@db:5432/expenses", "production")).toBeNull();
  });

  it("keeps its copies of the shared constants in step with the app", () => {
    expect(script.DEFAULT_DEV_DATABASE_URL).toBe(DEFAULT_DEV_DATABASE_URL);
    expect(script.MIN_PASSWORD_LENGTH).toBe(MIN_PASSWORD_LENGTH);
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { users } from "@/db/schema";
import type { DB } from "@/db";
import { ServiceError } from "@/lib/errors";
import { hashPassword, verifyPassword } from "@/lib/password";
import { displayName } from "@/lib/user-id";
import { listCategories } from "@/server/categories";
import { authenticateUser, registerUser } from "@/server/users";
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
    expect(u).toEqual({ id: u.id, username: "ana_1", email: null, firstName: null, lastName: null, displayName: "ana_1" });
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

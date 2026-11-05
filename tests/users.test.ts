import { beforeEach, describe, expect, it } from "vitest";
import { ServiceError } from "@/lib/errors";
import { hashPassword, verifyPassword } from "@/lib/password";
import { listCategories } from "@/server/categories";
import { authenticateUser, registerUser } from "@/server/users";
import { useFreshDb } from "./helpers";

beforeEach(() => {
  useFreshDb();
});

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

describe("registration and login", () => {
  it("registers with lowercased email and seeds categories", async () => {
    const u = await registerUser({ name: " Ana ", email: " Ana@Example.COM ", password: "password1" });
    expect(u).toMatchObject({ name: "Ana", email: "ana@example.com" });
    expect(listCategories(u.id)).toHaveLength(8);

    expect(await authenticateUser("ANA@example.com", "password1")).toMatchObject({ id: u.id });
    expect(await authenticateUser("ana@example.com", "nope-nope")).toBeNull();
    expect(await authenticateUser("nobody@example.com", "password1")).toBeNull();
  });

  it("rejects duplicates and weak input", async () => {
    await registerUser({ name: "Ana", email: "ana@example.com", password: "password1" });
    await expect(registerUser({ name: "Ana", email: "ANA@example.com", password: "password1" })).rejects.toMatchObject({
      code: "CONFLICT",
      field: "email",
    });
    await expect(registerUser({ name: "B", email: "b@example.com", password: "short" })).rejects.toBeInstanceOf(ServiceError);
    await expect(registerUser({ name: "B", email: "not-an-email", password: "password1" })).rejects.toMatchObject({ field: "email" });
    await expect(registerUser({ name: "", email: "c@example.com", password: "password1" })).rejects.toMatchObject({ field: "name" });
  });
});

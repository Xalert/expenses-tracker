import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { users } from "@/db/schema";
import { ServiceError } from "@/lib/errors";
import { MIN_PASSWORD_LENGTH, getDummyPasswordHash, hashPassword, verifyPassword } from "@/lib/password";
import { seedDefaultCategories } from "./categories";

export type UserView = { id: number; name: string; email: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Create a user and seed their default categories in one DB transaction.
 * Throws VALIDATION (field name/email/password) or CONFLICT (field email) when the email is taken.
 */
export async function registerUser(input: { name: string; email: string; password: string }): Promise<UserView> {
  const name = (input.name ?? "").trim();
  const email = normalizeEmail(input.email ?? "");
  if (!name) throw new ServiceError("VALIDATION", "Enter your name.", "name");
  if (name.length > 80) throw new ServiceError("VALIDATION", "Keep the name under 80 characters.", "name");
  if (!EMAIL_RE.test(email)) throw new ServiceError("VALIDATION", "Enter a valid email address.", "email");
  if ((input.password ?? "").length < MIN_PASSWORD_LENGTH) {
    throw new ServiceError("VALIDATION", `Use at least ${MIN_PASSWORD_LENGTH} characters.`, "password");
  }

  const passwordHash = await hashPassword(input.password);
  const db = getDb();
  if (db.select({ id: users.id }).from(users).where(eq(users.email, email)).get()) {
    throw new ServiceError("CONFLICT", "An account with this email already exists.", "email");
  }

  try {
    return db.transaction((tx) => {
      const user = tx
        .insert(users)
        .values({ name, email, passwordHash })
        .returning({ id: users.id, name: users.name, email: users.email })
        .get();
      seedDefaultCategories(user.id, tx);
      return user;
    });
  } catch (err) {
    // Lost a race with a concurrent registration for the same email.
    if ((err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw new ServiceError("CONFLICT", "An account with this email already exists.", "email");
    }
    throw err;
  }
}

/** The user for a correct email/password pair, else null. Takes similar time either way. */
export async function authenticateUser(email: string, password: string): Promise<UserView | null> {
  const row = getDb().select().from(users).where(eq(users.email, normalizeEmail(email ?? ""))).get();
  if (!row) {
    await verifyPassword(password ?? "", await getDummyPasswordHash());
    return null;
  }
  if (!(await verifyPassword(password ?? "", row.passwordHash))) return null;
  return { id: row.id, name: row.name, email: row.email };
}

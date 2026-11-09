import "server-only";
import { sql } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import { users, type User } from "@/db/schema";
import { ServiceError } from "@/lib/errors";
import { MIN_PASSWORD_LENGTH, getDummyPasswordHash, hashPassword, verifyPassword } from "@/lib/password";
import { NAME_MAX, displayName, normalizeUserId, userIdProblem } from "@/lib/user-id";
import { pgError } from "./_validate";
import { seedDefaultCategories } from "./categories";
import { seedDefaultGroup } from "./wallet-groups";

export type UserView = {
  id: number;
  username: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
};

export type RegisterInput = {
  username: string;
  password: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_TAKEN = "This user ID is already taken.";
const EMAIL_TAKEN = "An account with this email already exists.";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toUserView(row: Pick<User, "id" | "username" | "email" | "firstName" | "lastName">): UserView {
  const { id, username, email, firstName, lastName } = row;
  return { id, username, email, firstName, lastName, displayName: displayName(row) };
}

function optionalName(value: string | null | undefined, field: "firstName" | "lastName"): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  if (v.length > NAME_MAX) throw new ServiceError("VALIDATION", `Keep it to ${NAME_MAX} characters or fewer.`, field);
  return v;
}

// Stored values are lowercase for every account this app wrote; comparing on lower() also covers rows written by
// hand or carried over by the 0001 migration (which keeps emails exactly as they were).
const byUsername = (username: string) => sql`lower(${users.username}) = ${username}`;
const byEmail = (email: string) => sql`lower(${users.email}) = ${email}`;

/**
 * Create a user and seed their default categories and group in one DB transaction.
 * VALIDATION (field username / email / password / firstName / lastName) or CONFLICT (field username / email).
 */
export async function registerUser(input: RegisterInput): Promise<UserView> {
  const username = normalizeUserId(input.username ?? "");
  const usernameProblem = userIdProblem(username);
  if (usernameProblem) throw new ServiceError("VALIDATION", usernameProblem, "username");

  const email = normalizeEmail(input.email ?? "") || null;
  if (email !== null && !EMAIL_RE.test(email)) {
    throw new ServiceError("VALIDATION", "Enter a valid email address, or leave it empty.", "email");
  }
  const firstName = optionalName(input.firstName, "firstName");
  const lastName = optionalName(input.lastName, "lastName");
  if ((input.password ?? "").length < MIN_PASSWORD_LENGTH) {
    throw new ServiceError("VALIDATION", `Use at least ${MIN_PASSWORD_LENGTH} characters.`, "password");
  }

  const db = await getDb();
  const assertFree = async (conn: DBOrTx) => {
    const [byName] = await conn.select({ id: users.id }).from(users).where(byUsername(username)).limit(1);
    if (byName) throw new ServiceError("CONFLICT", USERNAME_TAKEN, "username");
    if (email !== null) {
      const [byMail] = await conn.select({ id: users.id }).from(users).where(byEmail(email)).limit(1);
      if (byMail) throw new ServiceError("CONFLICT", EMAIL_TAKEN, "email");
    }
  };
  await assertFree(db); // before the (slow) hash, so a taken name is reported at once
  const passwordHash = await hashPassword(input.password);

  try {
    return await db.transaction(async (tx) => {
      await assertFree(tx); // again: another registration may have finished while we were hashing
      const [user] = await tx
        .insert(users)
        .values({ username, email, firstName, lastName, passwordHash })
        .returning();
      await seedDefaultCategories(user.id, tx);
      await seedDefaultGroup(user.id, tx);
      return toUserView(user);
    });
  } catch (err) {
    // Lost a race with a concurrent registration: tell which unique index fired.
    const unique = pgError(err, "23505");
    if (unique) {
      if (unique.constraint === "users_email_unique") throw new ServiceError("CONFLICT", EMAIL_TAKEN, "email");
      throw new ServiceError("CONFLICT", USERNAME_TAKEN, "username");
    }
    throw err;
  }
}

/**
 * The user for a correct identifier/password pair, else null. The identifier is an email when it contains `@`,
 * otherwise a user ID; both case-insensitive. Takes similar time whether or not the account exists.
 */
export async function authenticateUser(identifier: string, password: string): Promise<UserView | null> {
  const id = (identifier ?? "").trim().toLowerCase();
  const [row] = id
    ? await (await getDb())
        .select()
        .from(users)
        .where(id.includes("@") ? byEmail(id) : byUsername(id))
        .limit(1)
    : [];
  if (!row) {
    await verifyPassword(password ?? "", await getDummyPasswordHash());
    return null;
  }
  if (!(await verifyPassword(password ?? "", row.passwordHash))) return null;
  return toUserView(row);
}

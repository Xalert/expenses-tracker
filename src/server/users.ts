import "server-only";
import { and, desc, eq, gt, isNull, lte, ne, sql, type SQL } from "drizzle-orm";
import { getDb, type DBOrTx } from "@/db";
import {
  budgets,
  categories,
  EMAIL_UNIQUE_INDEX,
  recurringTransactions,
  sessions,
  tags,
  transactions,
  transfers,
  type User,
  users,
  walletGroups,
  wallets,
} from "@/db/schema";
import { ServiceError } from "@/lib/errors";
import { MIN_PASSWORD_LENGTH, getDummyPasswordHash, hashPassword, verifyPassword } from "@/lib/password";
import { canonicalTimeZone } from "@/lib/time-zone";
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
  /** The account's IANA time zone, or null when not set (see `src/lib/time-zone.ts`). */
  timeZone: string | null;
  displayName: string;
};

export type RegisterInput = {
  username: string;
  password: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  /** The browser's IANA time zone (a hidden field of the form). Stored when valid; anything else leaves it unset. */
  timeZone?: string | null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_TAKEN = "This user ID is already taken.";
const EMAIL_TAKEN = "An account with this email already exists.";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function toUserView(row: Pick<User, "id" | "username" | "email" | "firstName" | "lastName" | "timeZone">): UserView {
  const { id, username, email, firstName, lastName, timeZone } = row;
  return { id, username, email, firstName, lastName, timeZone, displayName: displayName(row) };
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

function parseUsername(value: string | null | undefined): string {
  const username = normalizeUserId(value ?? "");
  const problem = userIdProblem(username);
  if (problem) throw new ServiceError("VALIDATION", problem, "username");
  return username;
}

function parseEmail(value: string | null | undefined): string | null {
  const email = normalizeEmail(value ?? "") || null;
  if (email !== null && !EMAIL_RE.test(email)) {
    throw new ServiceError("VALIDATION", "Enter a valid email address, or leave it empty.", "email");
  }
  return email;
}

/**
 * CONFLICT on the right field for a unique violation on `users` (a lost race with a concurrent registration or
 * profile change), by the name of the index that fired; null for any other error.
 */
export function userConflictFromError(err: unknown): ServiceError | null {
  const unique = pgError(err, "23505");
  if (!unique) return null;
  if (unique.constraint === EMAIL_UNIQUE_INDEX) return new ServiceError("CONFLICT", EMAIL_TAKEN, "email");
  return new ServiceError("CONFLICT", USERNAME_TAKEN, "username");
}

/** CONFLICT when another account (not `exceptUserId`) has this user ID or email. */
async function assertFree(conn: DBOrTx, username: string, email: string | null, exceptUserId?: number) {
  const others = (where: SQL) => (exceptUserId === undefined ? where : and(where, ne(users.id, exceptUserId)));
  const [byName] = await conn.select({ id: users.id }).from(users).where(others(byUsername(username))).limit(1);
  if (byName) throw new ServiceError("CONFLICT", USERNAME_TAKEN, "username");
  if (email !== null) {
    const [byMail] = await conn.select({ id: users.id }).from(users).where(others(byEmail(email))).limit(1);
    if (byMail) throw new ServiceError("CONFLICT", EMAIL_TAKEN, "email");
  }
}

/**
 * Create a user and seed their default categories and group in one DB transaction. `timeZone` is stored when it is
 * a valid IANA zone and silently left unset otherwise (it comes from the browser, not from the person).
 * VALIDATION (field username / email / password / firstName / lastName) or CONFLICT (field username / email).
 */
export async function registerUser(input: RegisterInput): Promise<UserView> {
  const username = parseUsername(input.username);
  const email = parseEmail(input.email);
  const firstName = optionalName(input.firstName, "firstName");
  const lastName = optionalName(input.lastName, "lastName");
  const timeZone = canonicalTimeZone(input.timeZone);
  if ((input.password ?? "").length < MIN_PASSWORD_LENGTH) {
    throw new ServiceError("VALIDATION", `Use at least ${MIN_PASSWORD_LENGTH} characters.`, "password");
  }

  const db = await getDb();
  await assertFree(db, username, email); // before the (slow) hash, so a taken name is reported at once
  const passwordHash = await hashPassword(input.password);

  try {
    return await db.transaction(async (tx) => {
      await assertFree(tx, username, email); // again: another registration may have finished while we were hashing
      const [user] = await tx
        .insert(users)
        .values({ username, email, firstName, lastName, passwordHash, timeZone })
        .returning();
      await seedDefaultCategories(user.id, tx);
      await seedDefaultGroup(user.id, tx);
      return toUserView(user);
    });
  } catch (err) {
    // Lost a race with a concurrent registration: tell which unique index fired.
    throw userConflictFromError(err) ?? err;
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

/**
 * After a successful sign-in: store the browser's time zone on an account that has none yet. An account's zone is
 * never replaced this way (only on /account), and an invalid or missing value changes nothing. Returns whether it
 * was stored.
 */
export async function adoptTimeZoneIfUnset(userId: number, browserTimeZone: unknown): Promise<boolean> {
  const timeZone = canonicalTimeZone(browserTimeZone);
  if (timeZone === null) return false;
  const updated = await (await getDb())
    .update(users)
    .set({ timeZone })
    .where(and(eq(users.id, userId), isNull(users.timeZone)))
    .returning({ id: users.id });
  return updated.length > 0;
}

/** The account's time zone (canonical IANA name), or null when it has none or is unknown. */
export async function getUserTimeZone(userId: number, conn?: DBOrTx): Promise<string | null> {
  const [row] = await (conn ?? (await getDb()))
    .select({ timeZone: users.timeZone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  // Re-checked: a zone the runtime no longer knows (an ICU update, a hand edit) counts as not set.
  return canonicalTimeZone(row?.timeZone);
}

/** The message of a current password that does not verify (actions count these for the rate limit). */
export const WRONG_PASSWORD_MESSAGE = "That is not your current password.";

/** True for the ServiceError a wrong current password produces (not for a missing one). */
export function isWrongPasswordError(err: unknown): boolean {
  return err instanceof ServiceError && err.field === "currentPassword" && err.message === WRONG_PASSWORD_MESSAGE;
}

/**
 * The user's row once `password` verifies against it; VALIDATION on `currentPassword` otherwise. An unknown user
 * looks the same as a wrong password and takes similar time.
 */
async function verifyCurrentPassword(userId: number, password: string | null | undefined): Promise<User> {
  const [row] = await (await getDb()).select().from(users).where(eq(users.id, userId)).limit(1);
  const wrong = new ServiceError("VALIDATION", WRONG_PASSWORD_MESSAGE, "currentPassword");
  if (!row) {
    await verifyPassword(password ?? "", await getDummyPasswordHash());
    throw wrong;
  }
  if (!(await verifyPassword(password ?? "", row.passwordHash))) throw wrong;
  return row;
}

/** Sessions of `userId` other than `keepTokenHash` (null = all of them). */
const otherSessions = (userId: number, keepTokenHash: string | null) =>
  keepTokenHash === null
    ? eq(sessions.userId, userId)
    : and(eq(sessions.userId, userId), ne(sessions.tokenHash, keepTokenHash));

/**
 * Replace the user's password. The current one must verify first (VALIDATION on `currentPassword`; an unknown user
 * looks the same). Then, in one DB transaction, the hash is replaced and every session of the user except
 * `keepSessionTokenHash` is deleted (null deletes all of them). Other users' sessions are never touched.
 */
export async function changePassword(
  userId: number,
  input: { currentPassword: string; newPassword: string },
  opts: { keepSessionTokenHash: string | null },
): Promise<void> {
  await verifyCurrentPassword(userId, input.currentPassword);
  if ((input.newPassword ?? "").length < MIN_PASSWORD_LENGTH) {
    throw new ServiceError("VALIDATION", `Use at least ${MIN_PASSWORD_LENGTH} characters.`, "newPassword");
  }

  const passwordHash = await hashPassword(input.newPassword); // slow: outside the transaction
  await (await getDb()).transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, userId));
    await tx.delete(sessions).where(otherSessions(userId, opts.keepSessionTokenHash));
  });
}

export type ProfileInput = {
  username: string;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  /**
   * The account's IANA time zone; "" or null clears it, undefined leaves it as it is. Needs no password.
   * VALIDATION on `timeZone` when it is not a valid zone.
   */
  timeZone?: string | null;
  /** Needed only when the user ID or the email changes. */
  currentPassword?: string | null;
};

/**
 * Replace the user's user ID, email, first name and surname (the whole profile: an empty email or name removes it),
 * with the same rules as registration. Changing the user ID or the email (adding, changing or removing it) also
 * needs the current password — VALIDATION on `currentPassword` when it is missing or wrong; the names and the time
 * zone (when given; VALIDATION on `timeZone` for an unknown zone) do not. Checked in this order: formats, conflicts with other accounts (CONFLICT on `username` / `email`), the
 * password. Sessions stay valid (they reference the numeric id). NOT_FOUND for an unknown user.
 */
export async function updateProfile(userId: number, input: ProfileInput): Promise<UserView> {
  const username = parseUsername(input.username);
  const email = parseEmail(input.email);
  const firstName = optionalName(input.firstName, "firstName");
  const lastName = optionalName(input.lastName, "lastName");
  const timeZone = parseProfileTimeZone(input.timeZone);

  const db = await getDb();
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!row) throw new ServiceError("NOT_FOUND", "Account not found.");

  const identityChanged = username !== row.username.toLowerCase() || email !== (row.email?.toLowerCase() ?? null);
  await assertFree(db, username, email, userId);
  if (identityChanged) {
    if (!input.currentPassword) {
      throw new ServiceError("VALIDATION", "Enter your current password to change your user ID or email.", "currentPassword");
    }
    await verifyCurrentPassword(userId, input.currentPassword);
  }

  try {
    const [updated] = await db
      .update(users)
      .set({ username, email, firstName, lastName, ...(timeZone === undefined ? {} : { timeZone }) })
      .where(eq(users.id, userId))
      .returning();
    if (!updated) throw new ServiceError("NOT_FOUND", "Account not found.");
    return toUserView(updated);
  } catch (err) {
    // Lost a race with a registration or another profile change between the check and the update.
    throw userConflictFromError(err) ?? err;
  }
}

function parseProfileTimeZone(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === "") return null;
  const zone = canonicalTimeZone(value);
  if (zone === null) throw new ServiceError("VALIDATION", "Choose a time zone from the list.", "timeZone");
  return zone;
}

/**
 * "Sign out other devices": delete every session of the user except `keepTokenHash` (null deletes all of them).
 * Returns how many were deleted. Other users' sessions are never touched.
 */
export async function signOutOtherSessions(userId: number, keepTokenHash: string | null): Promise<number> {
  const deleted = await (await getDb())
    .delete(sessions)
    .where(otherSessions(userId, keepTokenHash))
    .returning({ id: sessions.id });
  return deleted.length;
}

/** One signed-in device on /account. Never carries the token hash. */
export type SessionView = {
  id: number;
  userAgent: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  /** The session making this request. */
  current: boolean;
};

/**
 * The user's active (unexpired) sessions: the current one (`currentTokenHash`) first, then the most recently used.
 * Other users' sessions are never included.
 */
export async function listSessions(
  userId: number,
  currentTokenHash: string | null,
  now: Date = new Date(),
): Promise<SessionView[]> {
  const rows = await (await getDb())
    .select({
      id: sessions.id,
      tokenHash: sessions.tokenHash,
      userAgent: sessions.userAgent,
      createdAt: sessions.createdAt,
      lastUsedAt: sessions.lastUsedAt,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, now)))
    .orderBy(desc(sessions.lastUsedAt), desc(sessions.id));
  const views = rows.map(({ tokenHash, ...row }) => ({ ...row, current: tokenHash === currentTokenHash }));
  return [...views.filter((s) => s.current), ...views.filter((s) => !s.current)];
}

/**
 * "Sign out" on one other device: delete the user's session `sessionId`. The current session (`keepTokenHash`) is
 * not deleted this way (that is the account menu's Sign out). NOT_FOUND when there is no such session of this user,
 * which includes another user's session and one that already ended.
 */
export async function signOutSession(userId: number, sessionId: number, keepTokenHash: string | null): Promise<void> {
  const deleted = await (await getDb())
    .delete(sessions)
    .where(and(otherSessions(userId, keepTokenHash), eq(sessions.id, sessionId)))
    .returning({ id: sessions.id });
  if (deleted.length === 0) throw new ServiceError("NOT_FOUND", "That device is no longer signed in.");
}

/** `sessions.lastUsedAt` is written at most this often per session, so most requests cause no write. */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Whether a session last marked used at `lastUsedAt` is due another write at `now`. */
export function sessionTouchDue(lastUsedAt: Date, now: Date): boolean {
  return now.getTime() - lastUsedAt.getTime() >= SESSION_TOUCH_INTERVAL_MS;
}

/**
 * Mark session `sessionId` used at `now`, unless it was marked within `SESSION_TOUCH_INTERVAL_MS` (the condition is
 * in the UPDATE, so concurrent requests write once). Returns whether a row was written.
 */
export async function touchSession(sessionId: number, now: Date = new Date()): Promise<boolean> {
  const updated = await (await getDb())
    .update(sessions)
    .set({ lastUsedAt: now })
    .where(
      and(eq(sessions.id, sessionId), lte(sessions.lastUsedAt, new Date(now.getTime() - SESSION_TOUCH_INTERVAL_MS))),
    )
    .returning({ id: sessions.id });
  return updated.length > 0;
}

/**
 * Delete expired sessions: the given user's (when a session is created), or with no user every account's (one
 * `delete ... where expires_at <= now`, run at sign-in; cheap at household scale). Returns how many were deleted.
 */
export async function deleteExpiredSessions(userId?: number): Promise<number> {
  const expired = lte(sessions.expiresAt, new Date());
  const deleted = await (await getDb())
    .delete(sessions)
    .where(userId === undefined ? expired : and(eq(sessions.userId, userId), expired))
    .returning({ id: sessions.id });
  return deleted.length;
}

/**
 * Delete the account and everything it owns in one DB transaction: entries, transfers, tags, recurring rules,
 * budgets, wallets, wallet groups, categories, sessions, then the user row — explicitly and children first, so the `restrict` foreign keys
 * (entries → wallets / categories, wallets → groups) never see a half-deleted account. The current password must
 * verify (VALIDATION on `currentPassword`; an unknown user looks the same), then `confirmUsername` must be the
 * user ID in any letter case (VALIDATION on `confirmUsername`).
 */
export async function deleteAccount(
  userId: number,
  input: { currentPassword: string; confirmUsername: string },
): Promise<void> {
  const row = await verifyCurrentPassword(userId, input.currentPassword);
  if (normalizeUserId(input.confirmUsername ?? "") !== row.username.toLowerCase()) {
    throw new ServiceError("VALIDATION", `Type your user ID, ${row.username}, to confirm.`, "confirmUsername");
  }
  await (await getDb()).transaction(async (tx) => {
    // Entries take their tag links with them (cascade); rules and budgets go before the wallets and categories
    // they point at.
    await tx.delete(transactions).where(eq(transactions.userId, userId));
    await tx.delete(transfers).where(eq(transfers.userId, userId));
    await tx.delete(tags).where(eq(tags.userId, userId));
    await tx.delete(recurringTransactions).where(eq(recurringTransactions.userId, userId));
    await tx.delete(budgets).where(eq(budgets.userId, userId));
    await tx.delete(wallets).where(eq(wallets.userId, userId));
    await tx.delete(walletGroups).where(eq(walletGroups.userId, userId));
    await tx.delete(categories).where(eq(categories.userId, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.delete(users).where(eq(users.id, userId));
  });
}

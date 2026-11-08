import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { sessions, users } from "@/db/schema";
import { shouldUseSecureCookie } from "./config";
import { displayName } from "./user-id";

export const SESSION_COOKIE = "et_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type CurrentUser = {
  id: number;
  /** The user ID people sign in with. */
  username: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  /** First name + surname when either is set, otherwise the user ID (`displayName` in src/lib/user-id.ts). */
  displayName: string;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Create a DB session for `userId` and set the session cookie. Call from a Server Action only. */
export async function createSession(userId: number): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  getDb().insert(sessions).values({ tokenHash: hashToken(token), userId, expiresAt }).run();

  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // COOKIE_SECURE=auto|true|false; auto = secure only when the request came in over HTTPS (reverse proxy).
    secure: shouldUseSecureCookie((await headers()).get("x-forwarded-proto")),
    path: "/",
    expires: expiresAt,
  });
}

/** Delete the current session row and clear the cookie. Call from a Server Action only. */
export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) getDb().delete(sessions).where(eq(sessions.tokenHash, hashToken(token))).run();
  store.delete(SESSION_COOKIE);
}

/** The signed-in user, or null. Cached for the duration of a request. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const db = getDb();
  const row = db
    .select({
      sessionId: sessions.id,
      expiresAt: sessions.expiresAt,
      id: users.id,
      username: users.username,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.tokenHash, hashToken(token)))
    .get();

  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) {
    db.delete(sessions).where(eq(sessions.id, row.sessionId)).run();
    return null;
  }
  const { id, username, email, firstName, lastName } = row;
  return { id, username, email, firstName, lastName, displayName: displayName(row) };
});

/** The signed-in user; redirects to /login when signed out. Use in the (app) layout, pages and every Server Action. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** For /login and /register: send signed-in users to the dashboard. */
export async function redirectIfSignedIn(): Promise<void> {
  if (await getCurrentUser()) redirect("/");
}

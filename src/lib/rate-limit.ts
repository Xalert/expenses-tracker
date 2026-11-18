import "server-only";
import type { TrustProxy } from "./config";

/**
 * In-memory failure counters for password checks (sign-in and the current-password checks on /account).
 *
 * Per process: the counts live in this Node.js process only, so they reset on a restart and are not shared between
 * several app containers. That is deliberate for the single-container deployment this app ships (docs/DECISIONS.md);
 * see docs/SPEC.md "Auth" → "Rate limiting".
 *
 * A key's window starts at its first failure. Once `limit` failures fall inside one window the key is refused until
 * the window ends; then it starts from zero. Only failures count: a key that never fails is never refused.
 */
export type RateLimiterOptions = {
  limit: number;
  windowMs: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Prune expired entries once the map holds this many keys (bounds memory under a spray of identifiers). */
  maxKeys?: number;
};

type Entry = { failures: number; windowEndsAt: number };

export class RateLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(opts: RateLimiterOptions) {
    this.limit = opts.limit;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
    this.maxKeys = opts.maxKeys ?? 10_000;
  }

  private live(key: string, now: number): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.windowEndsAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Milliseconds until `key` may try again, or 0 when it is not refused. */
  retryAfterMs(key: string): number {
    const now = this.now();
    const entry = this.live(key, now);
    return entry && entry.failures >= this.limit ? entry.windowEndsAt - now : 0;
  }

  /** Count one failure for `key`. */
  recordFailure(key: string): void {
    const now = this.now();
    const entry = this.live(key, now);
    if (entry) {
      entry.failures += 1;
      return;
    }
    if (this.entries.size >= this.maxKeys) this.prune(now);
    this.entries.set(key, { failures: 1, windowEndsAt: now + this.windowMs });
  }

  /** Forget `key`'s failures (after a successful check). */
  reset(key: string): void {
    this.entries.delete(key);
  }

  /** Number of keys currently tracked (tests). */
  get size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) if (entry.windowEndsAt <= now) this.entries.delete(key);
    // Still full (a spray of distinct keys inside one window): drop the oldest; Map iterates in insertion order.
    for (const key of this.entries.keys()) {
      if (this.entries.size < this.maxKeys) break;
      this.entries.delete(key);
    }
  }
}

export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
/** Failed password checks per account identifier (a sign-in identifier, or a signed-in user on /account). */
export const IDENTIFIER_LIMIT = 5;
/** Failed sign-ins per client address. */
export const ADDRESS_LIMIT = 30;

/**
 * "Too many sign-in attempts. Try again in N minutes." (N rounded up, at least 1); `what: "password"` for the
 * current-password checks on /account.
 */
export function tooManyAttemptsMessage(retryAfterMs: number, what: "sign-in" | "password" = "sign-in"): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return `Too many ${what} attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
}

/**
 * The client address for the per-address limit, picked from `x-forwarded-for` as `TRUST_PROXY` says (`trust`, see
 * `trustProxy` in src/lib/config.ts), lowercased; null skips the address limit. Trusting nothing ignores the header:
 * a client can write any value into it, and Next.js only fills it with the socket's address when it is absent, so
 * without a trusted proxy it cannot be told apart from a forged one. A header shorter than the trusted hop count
 * (a request that did not come through every proxy) also gives null.
 */
export function clientAddress(forwardedFor: string | null | undefined, trust: TrustProxy): string | null {
  if (trust.mode === "none") return null;
  const hops = (forwardedFor ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const hop = trust.mode === "first" ? hops[0] : hops[hops.length - trust.hops];
  return hop ? hop.toLowerCase() : null;
}

type Limiters = { identifier: RateLimiter; address: RateLimiter };
const globalForLimits = globalThis as unknown as { __expensesRateLimits?: Limiters };

/** The process-wide limiters (on `globalThis`, so dev hot reloads keep the counts). */
export function passwordLimiters(): Limiters {
  globalForLimits.__expensesRateLimits ??= {
    identifier: new RateLimiter({ limit: IDENTIFIER_LIMIT, windowMs: RATE_LIMIT_WINDOW_MS }),
    address: new RateLimiter({ limit: ADDRESS_LIMIT, windowMs: RATE_LIMIT_WINDOW_MS }),
  };
  return globalForLimits.__expensesRateLimits;
}

/** Replace the process-wide limiters (tests). */
export function setPasswordLimiters(limiters: Limiters | undefined): void {
  globalForLimits.__expensesRateLimits = limiters;
}

/** Key of a sign-in identifier: trimmed and lowercased, like the lookup. */
export const identifierKey = (identifier: string) => `id:${identifier.trim().toLowerCase()}`;
/** Key of a signed-in user's current-password checks on /account. */
export const accountKey = (userId: number) => `user:${userId}`;

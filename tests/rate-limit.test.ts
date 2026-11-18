import { describe, expect, it } from "vitest";
import { RateLimiter, clientAddress, identifierKey, tooManyAttemptsMessage } from "@/lib/rate-limit";

const MIN = 60_000;

function limiter(limit = 5, maxKeys?: number) {
  const clock = { t: 1_000_000 };
  const l = new RateLimiter({ limit, windowMs: 15 * MIN, now: () => clock.t, maxKeys });
  return { l, clock };
}

describe("RateLimiter", () => {
  it("refuses a key after `limit` failures until the window that started at the first failure ends", () => {
    const { l, clock } = limiter();
    for (let i = 0; i < 4; i++) {
      l.recordFailure("k");
      clock.t += MIN;
    }
    expect(l.retryAfterMs("k")).toBe(0); // 4 failures: still allowed
    l.recordFailure("k"); // 5th, at minute 4
    expect(l.retryAfterMs("k")).toBe(11 * MIN);
    clock.t += 11 * MIN - 1;
    expect(l.retryAfterMs("k")).toBe(1);
    clock.t += 1;
    expect(l.retryAfterMs("k")).toBe(0);
    // A new window: one more failure does not lock it again.
    l.recordFailure("k");
    expect(l.retryAfterMs("k")).toBe(0);
  });

  it("forgets failures older than the window", () => {
    const { l, clock } = limiter();
    for (let i = 0; i < 4; i++) l.recordFailure("k");
    clock.t += 15 * MIN;
    l.recordFailure("k");
    expect(l.retryAfterMs("k")).toBe(0);
  });

  it("keeps keys apart, and reset clears one key", () => {
    const { l } = limiter(2);
    l.recordFailure("a");
    l.recordFailure("a");
    l.recordFailure("b");
    expect(l.retryAfterMs("a")).toBeGreaterThan(0);
    expect(l.retryAfterMs("b")).toBe(0);
    l.reset("a");
    expect(l.retryAfterMs("a")).toBe(0);
    expect(l.size).toBe(1);
  });

  it("bounds its memory: expired keys are pruned first, then the oldest", () => {
    const { l, clock } = limiter(5, 3);
    l.recordFailure("old");
    clock.t += 15 * MIN;
    l.recordFailure("a");
    l.recordFailure("b");
    l.recordFailure("c"); // full (3): "old" has expired and goes
    expect(l.size).toBe(3);
    l.recordFailure("d"); // still full: the oldest live key ("a") goes
    expect(l.size).toBe(3);
    for (let i = 0; i < 5; i++) l.recordFailure("d");
    expect(l.retryAfterMs("d")).toBeGreaterThan(0);
  });
});

describe("helpers", () => {
  it("words the message in whole minutes, rounded up", () => {
    expect(tooManyAttemptsMessage(15 * MIN)).toBe("Too many sign-in attempts. Try again in 15 minutes.");
    expect(tooManyAttemptsMessage(61_000)).toBe("Too many sign-in attempts. Try again in 2 minutes.");
    expect(tooManyAttemptsMessage(1)).toBe("Too many sign-in attempts. Try again in 1 minute.");
    expect(tooManyAttemptsMessage(MIN, "password")).toBe("Too many password attempts. Try again in 1 minute.");
  });

  it("picks the client address from x-forwarded-for as TRUST_PROXY says", () => {
    const none = { mode: "none" } as const;
    const first = { mode: "first" } as const;
    const hops = (n: number) => ({ mode: "hops", hops: n }) as const;
    // No trusted proxy: the header is ignored, whatever it says.
    expect(clientAddress("203.0.113.7", none)).toBeNull();
    // `true`: the left-most hop.
    expect(clientAddress("203.0.113.7, 10.0.0.1", first)).toBe("203.0.113.7");
    expect(clientAddress(" 2001:DB8::1 ", first)).toBe("2001:db8::1");
    expect(clientAddress("", first)).toBeNull();
    expect(clientAddress(null, first)).toBeNull();
    // N: the Nth hop from the right; a forged left part does not matter.
    expect(clientAddress("6.6.6.6, 203.0.113.7", hops(1))).toBe("203.0.113.7");
    expect(clientAddress("6.6.6.6, 203.0.113.7, 10.0.0.2", hops(2))).toBe("203.0.113.7");
    expect(clientAddress("203.0.113.7,,  ", hops(1))).toBe("203.0.113.7");
    // Fewer hops than trusted proxies: not through every proxy, so no address.
    expect(clientAddress("203.0.113.7", hops(2))).toBeNull();
    expect(clientAddress(null, hops(1))).toBeNull();
  });

  it("keys identifiers like the lookup: trimmed and lowercased", () => {
    expect(identifierKey(" Ana@Example.com ")).toBe(identifierKey("ana@example.com"));
  });
});

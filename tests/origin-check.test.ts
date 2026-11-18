// The early Server Action origin check (src/proxy.ts + src/lib/origin-check.ts) for reverse proxies that drop Host.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { HOST_MISMATCH_MESSAGE, hostMismatch, requestHost } from "@/lib/origin-check";
import { proxy } from "@/proxy";

const h = (o: Record<string, string>) => new Headers(o);

describe("hostMismatch (mirrors Next.js's action check)", () => {
  it("accepts a matching Host, a matching first X-Forwarded-Host hop, and requests without Origin", () => {
    expect(hostMismatch(h({ origin: "https://money.example", host: "money.example" }))).toBeNull();
    expect(hostMismatch(h({ origin: "http://192.168.1.10:3000", host: "192.168.1.10:3000" }))).toBeNull();
    expect(
      hostMismatch(h({ origin: "https://money.example", host: "localhost:3000", "x-forwarded-host": "money.example, proxy" })),
    ).toBeNull();
    expect(hostMismatch(h({ host: "localhost:3000" }))).toBeNull();
  });

  it("flags a proxy that rewrites Host without X-Forwarded-Host, or sends neither", () => {
    expect(hostMismatch(h({ origin: "https://money.example", host: "localhost:3000" }))).toEqual({
      origin: "money.example",
      host: "localhost:3000",
    });
    expect(hostMismatch(h({ origin: "https://money.example" }))).toEqual({ origin: "money.example", host: null });
    // X-Forwarded-Host wins over Host, as in Next.js.
    expect(hostMismatch(h({ origin: "https://money.example", host: "money.example", "x-forwarded-host": "other" }))).not.toBeNull();
    expect(requestHost(h({ "x-forwarded-host": " a.example , b " }))).toBe("a.example");
  });
});

describe("proxy", () => {
  afterEach(() => vi.restoreAllMocks());
  const post = (headers: Record<string, string>) =>
    new NextRequest("http://localhost:3000/login", { method: "POST", headers });

  it("lets GETs, matching posts and non-form posts through", () => {
    expect(proxy(new NextRequest("http://localhost:3000/login", { headers: { origin: "https://x", host: "y" } })).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(post({ origin: "http://localhost:3000", host: "localhost:3000", "next-action": "abc" })).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(post({ origin: "https://x", host: "y", "content-type": "application/json" })).headers.get("x-middleware-next")).toBe("1");
  });

  it("answers a refused fetch action with the message as text/plain (the client throws it) and logs the fix", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = proxy(post({ origin: "https://money.example", host: "localhost:3000", "next-action": "abc" }));
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe(HOST_MISMATCH_MESSAGE);
    expect(log.mock.calls[0][0]).toMatch(/Origin "money\.example" does not match the host "localhost:3000".*X-Forwarded-Host/);
  });

  it("answers a refused plain form post (no JavaScript) with a readable HTML page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = proxy(post({ origin: "https://money.example", host: "localhost:3000", "content-type": "multipart/form-data; boundary=x" }));
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(await res.text()).toContain("must pass the original Host header");
  });
});

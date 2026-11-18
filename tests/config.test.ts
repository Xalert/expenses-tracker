import { afterEach, describe, expect, it, vi } from "vitest";
import { isRegistrationAllowed, shouldUseSecureCookie, trustProxy } from "@/lib/config";

afterEach(() => vi.unstubAllEnvs());

describe("runtime config", () => {
  it("COOKIE_SECURE=auto follows x-forwarded-proto", () => {
    vi.stubEnv("COOKIE_SECURE", "");
    expect(shouldUseSecureCookie("https")).toBe(true);
    expect(shouldUseSecureCookie("https, http")).toBe(true);
    expect(shouldUseSecureCookie("http")).toBe(false);
    expect(shouldUseSecureCookie(null)).toBe(false);
  });
  it("COOKIE_SECURE=true|false overrides", () => {
    vi.stubEnv("COOKIE_SECURE", "true");
    expect(shouldUseSecureCookie(null)).toBe(true);
    vi.stubEnv("COOKIE_SECURE", "false");
    expect(shouldUseSecureCookie("https")).toBe(false);
  });
  it("TRUST_PROXY: unset / false → none, true → first hop, N → Nth hop from the right", () => {
    for (const v of [undefined, "", " ", "false", "FALSE", "0", "no", "off", "-1", "1.5", "abc", "1000"]) {
      expect(trustProxy(v)).toEqual({ mode: "none" });
    }
    for (const v of ["true", " True ", "yes", "on"]) expect(trustProxy(v)).toEqual({ mode: "first" });
    expect(trustProxy("1")).toEqual({ mode: "hops", hops: 1 });
    expect(trustProxy(" 2 ")).toEqual({ mode: "hops", hops: 2 });
    vi.stubEnv("TRUST_PROXY", "1");
    expect(trustProxy()).toEqual({ mode: "hops", hops: 1 });
    vi.stubEnv("TRUST_PROXY", "");
    expect(trustProxy()).toEqual({ mode: "none" });
  });
  it("ALLOW_REGISTRATION defaults to true", () => {
    vi.stubEnv("ALLOW_REGISTRATION", "");
    expect(isRegistrationAllowed()).toBe(true);
    vi.stubEnv("ALLOW_REGISTRATION", "false");
    expect(isRegistrationAllowed()).toBe(false);
    vi.stubEnv("ALLOW_REGISTRATION", "true");
    expect(isRegistrationAllowed()).toBe(true);
  });
});

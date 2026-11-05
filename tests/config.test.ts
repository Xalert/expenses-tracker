import { afterEach, describe, expect, it, vi } from "vitest";
import { isRegistrationAllowed, shouldUseSecureCookie } from "@/lib/config";

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
  it("ALLOW_REGISTRATION defaults to true", () => {
    vi.stubEnv("ALLOW_REGISTRATION", "");
    expect(isRegistrationAllowed()).toBe(true);
    vi.stubEnv("ALLOW_REGISTRATION", "false");
    expect(isRegistrationAllowed()).toBe(false);
    vi.stubEnv("ALLOW_REGISTRATION", "true");
    expect(isRegistrationAllowed()).toBe(true);
  });
});

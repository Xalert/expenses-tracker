import { describe, expect, it } from "vitest";
import { DEFAULT_RETURN_TO, safeReturnTo, withReturnTo } from "@/lib/return-to";

describe("safeReturnTo", () => {
  it("accepts same-site relative paths", () => {
    expect(safeReturnTo("/")).toBe("/");
    expect(safeReturnTo("/wallets/3")).toBe("/wallets/3");
    expect(safeReturnTo("/transactions?wallet=2&kind=expense&page=3")).toBe(
      "/transactions?wallet=2&kind=expense&page=3",
    );
    expect(safeReturnTo("/transactions?q=a%20b#top")).toBe("/transactions?q=a%20b#top");
  });

  it("takes the first value of an array (repeated query param)", () => {
    expect(safeReturnTo(["/wallets", "https://evil.example"])).toBe("/wallets");
    expect(safeReturnTo(["https://evil.example", "/wallets"])).toBe(DEFAULT_RETURN_TO);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["number", 42],
    ["empty", ""],
    ["absolute https", "https://evil.example"],
    ["absolute http with path", "http://evil.example/transactions"],
    ["protocol-relative", "//evil.example"],
    ["protocol-relative with path", "//evil.example/transactions"],
    ["backslash host", "/\\evil.example"],
    ["double backslash", "\\\\evil.example"],
    ["backslash later in path", "/foo\\..\\\\evil.example"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,hi"],
    ["relative without slash", "transactions"],
    ["dot relative", "./transactions"],
    ["tab trick", "/\t/evil.example"],
    ["newline trick", "/\n/evil.example"],
    ["carriage return", "/\r/evil.example"],
    ["leading space", " /transactions"],
    ["null byte", "/transactions\u0000"],
    ["triple slash", "///evil.example"],
    ["too long", "/" + "a".repeat(3000)],
  ])("rejects %s", (_label, value) => {
    expect(safeReturnTo(value)).toBe(DEFAULT_RETURN_TO);
  });

  it("uses a custom fallback", () => {
    expect(safeReturnTo("//evil.example", "/")).toBe("/");
  });

  it("treats encoded slashes as part of a local path", () => {
    // `/%2F/evil` is a path on this origin, not a host.
    expect(safeReturnTo("/%2F/evil.example")).toBe("/%2F/evil.example");
  });
});

describe("withReturnTo", () => {
  it("appends an encoded returnTo", () => {
    expect(withReturnTo("/transactions/5/edit", "/transactions?wallet=2&page=2")).toBe(
      "/transactions/5/edit?returnTo=%2Ftransactions%3Fwallet%3D2%26page%3D2",
    );
    expect(withReturnTo("/transactions/new?kind=income", "/wallets/2")).toBe(
      "/transactions/new?kind=income&returnTo=%2Fwallets%2F2",
    );
  });

  it("omits the default and unsafe values", () => {
    expect(withReturnTo("/transactions/5/edit", "/transactions")).toBe("/transactions/5/edit");
    expect(withReturnTo("/transactions/5/edit", "https://evil.example")).toBe("/transactions/5/edit");
  });
});

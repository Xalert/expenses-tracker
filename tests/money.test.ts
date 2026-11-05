import { describe, expect, it } from "vitest";
import { currencyDecimals, formatMoney, minorToInputValue, parseAmount } from "@/lib/money";
import { isValidCurrency, CURRENCIES } from "@/lib/currencies";

describe("currencyDecimals", () => {
  it("uses Intl minor units", () => {
    expect(currencyDecimals("EUR")).toBe(2);
    expect(currencyDecimals("JPY")).toBe(0);
    expect(currencyDecimals("KWD")).toBe(3);
    expect(currencyDecimals("usd")).toBe(2);
  });
});

describe("parseAmount", () => {
  it.each([
    ["12", "EUR", 1200],
    ["12.5", "EUR", 1250],
    ["12,50", "EUR", 1250],
    ["1 234.56", "EUR", 123456],
    ["1 234,56", "EUR", 123456],
    ["1,234.56", "USD", 123456],
    ["1.234,56", "EUR", 123456],
    ["  7 ", "EUR", 700],
    ["0.01", "EUR", 1],
    ["0", "EUR", 0],
    ["1500", "JPY", 1500],
    ["1 500", "JPY", 1500],
    ["1.234", "KWD", 1234],
    ["1,5", "KWD", 1500],
    ["12.345", "KWD", 12345],
  ])("parses %s %s → %d", (input, cur, expected) => {
    expect(parseAmount(input, cur)).toBe(expected);
  });

  it.each([
    ["", "EUR"],
    ["   ", "EUR"],
    ["abc", "EUR"],
    ["12abc", "EUR"],
    ["12.345", "EUR"], // too many decimals
    ["12,345", "EUR"], // a lone comma is a decimal separator
    ["12.5", "JPY"], // JPY has no minor unit
    ["12.", "EUR"],
    [".5", "EUR"],
    ["-5", "EUR"],
    ["1.2.3", "EUR"],
    ["12,34.56", "EUR"], // bad grouping
    ["1.2345", "KWD"],
    ["1e3", "EUR"],
    ["99999999999999999999", "EUR"],
  ])("rejects %j %s", (input, cur) => {
    expect(parseAmount(input, cur)).toBeNull();
  });

  it("accepts negatives only when allowed", () => {
    expect(parseAmount("-12.50", "EUR", { allowNegative: true })).toBe(-1250);
    expect(parseAmount("-0", "EUR", { allowNegative: true })).toBe(0);
    expect(parseAmount("-12.50", "EUR")).toBeNull();
  });
});

describe("formatMoney", () => {
  it("formats with the currency's decimals", () => {
    expect(formatMoney(123456, "EUR")).toBe("€1,234.56");
    expect(formatMoney(1500, "JPY")).toBe("¥1,500");
    expect(formatMoney(1234, "KWD")).toMatch(/1\.234$/);
    expect(formatMoney(5, "USD")).toBe("$0.05");
  });
  it("supports signed output", () => {
    expect(formatMoney(-1250, "EUR", { signed: true })).toBe("-€12.50");
    expect(formatMoney(1250, "EUR", { signed: true })).toBe("+€12.50");
    expect(formatMoney(0, "EUR", { signed: true })).toBe("€0.00");
    expect(formatMoney(-1250, "EUR")).toBe("-€12.50");
  });
});

describe("minorToInputValue", () => {
  it("round-trips with parseAmount", () => {
    expect(minorToInputValue(123450, "EUR")).toBe("1234.50");
    expect(minorToInputValue(5, "EUR")).toBe("0.05");
    expect(minorToInputValue(-5, "EUR")).toBe("-0.05");
    expect(minorToInputValue(1500, "JPY")).toBe("1500");
    expect(minorToInputValue(1, "KWD")).toBe("0.001");
    for (const [m, c] of [[123450, "EUR"], [1500, "JPY"], [12345, "KWD"]] as const) {
      expect(parseAmount(minorToInputValue(m, c), c)).toBe(m);
    }
  });
});

describe("currencies", () => {
  it("pins common currencies first and validates codes", () => {
    expect(CURRENCIES.slice(0, 4).map((c) => c.code)).toEqual(["EUR", "USD", "GBP", "RON"]);
    expect(CURRENCIES.find((c) => c.code === "RON")?.name).toMatch(/Romanian/);
    expect(isValidCurrency("EUR")).toBe(true);
    expect(isValidCurrency("eur")).toBe(false);
    expect(isValidCurrency("XXQ")).toBe(false);
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BigAmount } from "@/components/ui/big-amount";
import { isNegativeText, toggleSign } from "@/lib/amount-sign";
import { parseAmount } from "@/lib/money";

describe("toggleSign", () => {
  it("adds and removes a leading minus, ASCII or U+2212", () => {
    expect(toggleSign("12.50")).toBe("-12.50");
    expect(toggleSign("-12.50")).toBe("12.50");
    expect(toggleSign(" −3 ")).toBe("3");
    expect(toggleSign("")).toBe("-");
    expect(toggleSign("-")).toBe("");
    expect(toggleSign(toggleSign("1 500,25"))).toBe("1 500,25");
  });

  it("produces text parseAmount reads as negative", () => {
    expect(parseAmount(toggleSign("1.234,56"), "EUR", { allowNegative: true })).toBe(-123456);
  });

  it("isNegativeText", () => {
    expect(isNegativeText("-1")).toBe(true);
    expect(isNegativeText("  −1")).toBe(true);
    expect(isNegativeText("1-")).toBe(false);
    expect(isNegativeText("")).toBe(false);
  });
});

describe("BigAmount signToggle", () => {
  it("renders a labelled ± toggle button before the input, pressed for a negative value, decimal keyboard kept", () => {
    const html = renderToStaticMarkup(
      <BigAmount id="initialBalance" name="initialBalance" label="Starting balance" currency="EUR" currencyText="EUR" defaultValue="-20" required={false} signToggle />,
    );
    expect(html).toMatch(/<button type="button" aria-label="Minus sign" aria-pressed="true" aria-controls="initialBalance"/);
    expect(html.indexOf("Minus sign")).toBeLessThan(html.indexOf('id="initialBalance"', html.indexOf("</button>")));
    expect(html).toContain('inputMode="decimal"');
  });

  it("is off unless asked for, and not pressed for a positive value", () => {
    const plain = renderToStaticMarkup(<BigAmount id="amount" name="amount" label="Amount" currency="EUR" currencyText="EUR" />);
    expect(plain).not.toContain("Minus sign");
    const positive = renderToStaticMarkup(
      <BigAmount id="b" name="b" label="B" currency="EUR" currencyText="EUR" defaultValue="5" signToggle />,
    );
    expect(positive).toContain('aria-pressed="false"');
  });
});

import Link from "next/link";
import { cn } from "@/lib/cn";
import { currencyName } from "@/lib/currencies";

/**
 * "EUR · RON · USD" drawn like `Segmented`, but as links (the currency lives in the URL, `?currency=`), so it works
 * without JavaScript. The current one has `aria-current`. A `value` missing from `currencies` (a currency held only in
 * archived wallets, which `pickDefaultCurrency` can return) is added as an extra, selected option so the selection
 * is always visible. Scrolls sideways inside itself rather than widening the page.
 */
export function CurrencySwitch({
  currencies,
  value,
  hrefFor,
  className,
  "aria-label": ariaLabel = "Currency",
}: {
  currencies: string[];
  value: string;
  hrefFor(code: string): string;
  className?: string;
  "aria-label"?: string;
}) {
  const options = currencies.includes(value) ? currencies : [...currencies, value].sort();
  return (
    <nav aria-label={ariaLabel} className={cn("max-w-full overflow-x-auto", className)}>
      <ul className="inline-flex gap-1 rounded-full bg-surface-muted p-1">
        {options.map((code) => {
          const current = code === value;
          return (
            <li key={code} className="flex">
              <Link
                href={hrefFor(code)}
                scroll={false}
                aria-current={current ? "true" : undefined}
                title={currencyName(code)}
                className={cn(
                  "flex h-9 items-center justify-center rounded-full px-3.5 text-sm font-semibold whitespace-nowrap transition-colors",
                  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  current ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {code}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

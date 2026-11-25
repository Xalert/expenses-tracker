import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { exchangeRatesEnabled } from "@/lib/config";
import { currencyName } from "@/lib/currencies";
import { formatDate, todayInZone } from "@/lib/dates";
import { RATES_BASE, currenciesNeedingRates } from "@/lib/fx";
import { safeReturnTo } from "@/lib/return-to";
import { getProviderCurrencies, RATES_SOURCE } from "@/server/exchange-rates";
import { listManualRates } from "@/server/manual-rates";
import { listWallets } from "@/server/wallets";
import { DeleteRateButton, RateForm } from "./rate-forms";

export const metadata: Metadata = { title: "Exchange rates" };

type Props = { searchParams: Promise<{ returnTo?: string | string[] }> };

/**
 * The user's own exchange rates, for the currencies the provider does not quote (not in the main menu: linked from
 * the "All in <currency>" switch and from a conversion note that leaves a currency out).
 */
export default async function RatesPage({ searchParams }: Props) {
  const user = await requireUser();
  const params = await searchParams;
  const back = safeReturnTo(params.returnTo, "");
  const today = todayInZone(user.timeZone);
  const ratesOn = exchangeRatesEnabled();
  const provider = await getProviderCurrencies();
  const held = [...new Set((await listWallets(user.id, { includeArchived: true })).map((w) => w.currency))].sort();
  const manual = await listManualRates(user.id);
  const currencies = currenciesNeedingRates(
    held,
    provider?.currencies ?? new Set(),
    manual.map((r) => r.currency),
  );

  const status = !ratesOn
    ? "Exchange rates from the provider are switched off on this server (EXCHANGE_RATES=false), so only your own rates are used."
    : provider
      ? `The provider (${RATES_SOURCE}) quotes ${provider.currencies.size} currencies; its latest rates are of ${formatDate(provider.date)}. For any other currency, enter your own rate here.`
      : `The provider's rates (${RATES_SOURCE}) could not be loaded yet, so every currency you hold is listed; your own rates are used only where the provider has none.`;

  return (
    <>
      <PageHeader
        title="Exchange rates"
        description="The “All in …” views convert every wallet into one currency. Your own rate applies from its date until the next one, and only where the provider has no rate."
        actions={
          back ? (
            <Link href={back} className="text-sm font-semibold text-accent-hover hover:underline">
              ← Back
            </Link>
          ) : undefined
        }
      />
      <div className="max-w-2xl space-y-6">
        <p className="text-sm text-muted-foreground">{status}</p>
        {currencies.length === 0 ? (
          <Card>
            <CardBody>
              <p className="text-sm text-foreground">
                {held.length === 0
                  ? "You have no wallets yet."
                  : "The provider quotes every currency you hold: there is nothing to enter."}
              </p>
            </CardBody>
          </Card>
        ) : (
          currencies.map((code) => {
            const own = manual.filter((r) => r.currency === code);
            const quoted = provider?.currencies.has(code) ?? false;
            const bases = [RATES_BASE, ...held.filter((c) => c !== code && c !== RATES_BASE)];
            return (
              <Card key={code}>
                <CardHeader
                  title={`${code} · ${currencyName(code)}`}
                  description={
                    quoted
                      ? "The provider now quotes this currency, so these rates are only used on days it has none."
                      : own.length === 0
                        ? `No rate yet: wallets in ${code} are left out of the converted views.`
                        : undefined
                  }
                />
                <CardBody className="space-y-4">
                  {own.length > 0 && (
                    <ul className="divide-y divide-surface-muted rounded-xl border border-border">
                      {own.map((r) => {
                        const label = `from ${formatDate(r.effectiveDate)}, 1 ${r.currency} = ${r.rate} ${r.base}`;
                        return (
                          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                            <span className="tabular-nums text-foreground">
                              <span className="text-muted-foreground">From {formatDate(r.effectiveDate)}:</span> 1{" "}
                              {r.currency} = {r.rate} {r.base}
                            </span>
                            <DeleteRateButton id={r.id} label={label} />
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <RateForm currency={code} bases={bases} today={today} />
                </CardBody>
              </Card>
            );
          })
        )}
      </div>
    </>
  );
}

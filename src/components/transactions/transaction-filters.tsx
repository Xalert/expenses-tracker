import Form from "next/form";
import Link from "next/link";
import { Button, Card, Field, Input, Select } from "@/components/ui";
import { hasFilters, type ListParams } from "./list-params";

type Option = { id: number; name: string };

/**
 * GET filter form for /transactions. Values live in the URL; the wrapper is keyed by the current query so the
 * uncontrolled inputs re-sync after "Clear filters" or back/forward navigation.
 */
export function TransactionFilters({
  params,
  wallets,
  categories,
  queryKey,
}: {
  params: ListParams;
  wallets: (Option & { currency: string; archived: boolean })[];
  categories: (Option & { kind: "expense" | "income" })[];
  queryKey: string;
}) {
  const active = hasFilters(params);
  const count = [params.wallet, params.kind, params.category, params.from, params.to, params.q].filter(Boolean).length;
  const groups = [
    { label: "Expense", items: categories.filter((c) => c.kind === "expense") },
    { label: "Income", items: categories.filter((c) => c.kind === "income") },
  ];

  return (
    <Card className="mb-4" key={queryKey}>
      <details open={active} className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm font-medium text-foreground select-none focus-visible:outline-2 focus-visible:outline-ring sm:px-5 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2">
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.17 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z"
                clipRule="evenodd"
              />
            </svg>
            Filters
            {count > 0 && (
              <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent">{count} active</span>
            )}
          </span>
        </summary>
        <Form action="/transactions" className="grid grid-cols-2 gap-3 border-t border-border px-4 py-4 sm:px-5 lg:grid-cols-3">
          <Field id="filter-wallet" label="Wallet">
            <Select id="filter-wallet" name="wallet" defaultValue={params.wallet ? String(params.wallet) : ""}>
              <option value="">All wallets</option>
              {wallets.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} ({w.currency}){w.archived ? " — archived" : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field id="filter-kind" label="Type">
            <Select id="filter-kind" name="kind" defaultValue={params.kind ?? ""}>
              <option value="">All types</option>
              <option value="expense">Expenses</option>
              <option value="income">Income</option>
              <option value="transfer">Transfers</option>
            </Select>
          </Field>
          <Field id="filter-category" label="Category" className="col-span-2 lg:col-span-1">
            <Select id="filter-category" name="category" defaultValue={params.category ? String(params.category) : ""}>
              <option value="">All categories</option>
              {groups.map((g) =>
                g.items.length ? (
                  <optgroup key={g.label} label={g.label}>
                    {g.items.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null,
              )}
            </Select>
          </Field>
          <Field id="filter-from" label="From">
            <Input id="filter-from" name="from" type="date" defaultValue={params.from ?? ""} />
          </Field>
          <Field id="filter-to" label="To">
            <Input id="filter-to" name="to" type="date" defaultValue={params.to ?? ""} />
          </Field>
          <Field id="filter-q" label="Note contains" className="col-span-2 lg:col-span-1">
            <Input id="filter-q" name="q" type="search" maxLength={200} defaultValue={params.q ?? ""} />
          </Field>
          <div className="col-span-2 flex items-center justify-end gap-2 lg:col-span-3">
            {active && (
              <Link href="/transactions" className="px-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:underline">
                Clear filters
              </Link>
            )}
            <Button type="submit" size="sm">
              Apply filters
            </Button>
          </div>
        </Form>
      </details>
    </Card>
  );
}

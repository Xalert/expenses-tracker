import type { Metadata } from "next";
import Link from "next/link";
import { AddButton } from "@/components/shell/add-button";
import { RepeatIcon } from "@/components/shell/icons";
import { ConfirmDeleteForm } from "@/components/transactions/confirm-delete-form";
import { Badge, Card, EmptyState, LinkButton, PageHeader, SubmitButton, buttonClasses } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { describeSchedule } from "@/lib/recurrence";
import { listRecurring, type RecurringView } from "@/server/recurring";
import { deleteRecurringAction, pauseRecurringAction, resumeRecurringAction } from "./actions";

export const metadata: Metadata = { title: "Repeating entries" };

/** Where "New" goes: the Add form with Repeat preselected. */
const NEW_RECURRING_HREF = "/transactions/new?repeat=monthly";

function entriesLabel(n: number): string {
  return n === 0 ? "no entries yet" : n === 1 ? "1 entry so far" : `${n} entries so far`;
}

/** "Next 1 Dec 2026", "Paused", "Ended", plus the end date while there is one. */
function StatusLine({ rule }: { rule: RecurringView }) {
  const parts: string[] = [];
  if (rule.status === "active" && rule.nextDate) parts.push(`Next ${formatDate(rule.nextDate)}`);
  if (rule.status !== "ended" && rule.endDate) parts.push(`until ${formatDate(rule.endDate)}`);
  if (rule.status === "ended" && rule.endDate) parts.push(`ended ${formatDate(rule.endDate)}`);
  parts.push(entriesLabel(rule.entryCount));
  const badge =
    rule.status === "active" ? (
      <Badge tone="income">Active</Badge>
    ) : rule.status === "paused" ? (
      <Badge tone="accent">Paused</Badge>
    ) : (
      <Badge>Ended</Badge>
    );
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      {badge}
      <span className="tabular-nums">{parts.join(" · ")}</span>
    </p>
  );
}

function RuleRow({ rule }: { rule: RecurringView }) {
  const signed = rule.kind === "expense" ? -rule.amountMinor : rule.amountMinor;
  const amount = formatMoney(signed, rule.currency, { signed: true });
  const schedule = describeSchedule(rule);
  const meta = [schedule, rule.walletName, rule.note].filter(Boolean).join(" · ");
  const name = `${rule.categoryName} ${amount}`;
  return (
    <li id={`rule-${rule.id}`} className="scroll-mt-24 space-y-3 px-4 py-4 sm:px-5">
      <div className="flex items-start gap-3">
        <span
          className={cn("mt-2 size-2 shrink-0 rounded-full", rule.kind === "income" ? "bg-income" : "bg-expense-dot")}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-semibold text-foreground">{rule.categoryName}</h2>
          <p className="text-[13px] text-muted-foreground">{meta}</p>
        </div>
        <p
          className={cn(
            "shrink-0 font-bold tabular-nums",
            rule.kind === "income" ? "text-income" : "text-foreground",
          )}
        >
          {amount}
        </p>
      </div>
      <StatusLine rule={rule} />
      {rule.status === "paused" && rule.blockedBy && (
        <p className="rounded-xl bg-surface-muted px-3 py-2 text-sm text-foreground">
          {rule.blockedBy} Nothing is added while it is; unarchive it, then resume.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {rule.status === "active" && (
          <form action={pauseRecurringAction}>
            <input type="hidden" name="id" value={rule.id} />
            <SubmitButton variant="secondary" pendingLabel="Pausing…">
              Pause<span className="sr-only"> {name}</span>
            </SubmitButton>
          </form>
        )}
        {rule.status === "paused" && !rule.blockedBy && (
          <form action={resumeRecurringAction}>
            <input type="hidden" name="id" value={rule.id} />
            <SubmitButton variant="secondary" pendingLabel="Resuming…">
              Resume<span className="sr-only"> {name}</span>
            </SubmitButton>
          </form>
        )}
        <Link href={`/recurring/${rule.id}/edit`} className={buttonClasses({ variant: "secondary" })}>
          Edit<span className="sr-only"> {name}</span>
        </Link>
        <ConfirmDeleteForm
          action={deleteRecurringAction}
          id={rule.id}
          returnTo="/recurring"
          confirmMessage={`Delete this repeating ${rule.kind}? No more entries will be added; the ${
            rule.entryCount === 1 ? "entry it already made stays" : "entries it already made stay"
          }.`}
          variant="ghost"
          className="text-danger! hover:bg-danger-soft!"
          pendingLabel="Deleting…"
        >
          Delete<span className="sr-only"> {name}</span>
        </ConfirmDeleteForm>
      </div>
    </li>
  );
}

/**
 * Repeating expenses and income (not in the top menu: linked from the /transactions header and from the marker on
 * the entries a rule made). Each rule with its schedule, next date and status; Pause / Resume, Edit and Delete.
 */
export default async function RecurringPage() {
  const user = await requireUser();
  const rules = await listRecurring(user.id);

  return (
    <>
      <PageHeader
        title="Repeating entries"
        description="Rent, salary, subscriptions: each rule adds an ordinary entry on its dates, the next time you open the app."
        actions={
          <>
            <Link href="/transactions" className="text-sm font-semibold text-accent-hover hover:underline">
              ← Transactions
            </Link>
            {rules.length > 0 && (
              <LinkButton href={NEW_RECURRING_HREF}>
                New
              </LinkButton>
            )}
          </>
        }
      />
      <AddButton href={NEW_RECURRING_HREF} />
      <div className="max-w-3xl">
        {rules.length === 0 ? (
          <Card>
            <EmptyState
              icon={<RepeatIcon className="size-8" />}
              title="No repeating entries yet"
              description="Add an expense or income and choose how often it repeats: the entries for the coming dates are then added for you."
              action={<LinkButton href={NEW_RECURRING_HREF}>New repeating entry</LinkButton>}
            />
          </Card>
        ) : (
          <Card>
            <ul className="divide-y divide-border">
              {rules.map((r) => (
                <RuleRow key={r.id} rule={r} />
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}

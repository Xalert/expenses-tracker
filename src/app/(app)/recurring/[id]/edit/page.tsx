import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RecurringForm } from "@/components/recurring/recurring-form";
import { PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { formatDate, todayInZone } from "@/lib/dates";
import { minorToInputValue } from "@/lib/money";
import { describeSchedule } from "@/lib/recurrence";
import { getRecurring } from "@/server/recurring";
import { categoryOptions, parseId, walletOptions } from "../../../transactions/form-options";
import { updateRecurringAction } from "../../actions";

export const metadata: Metadata = { title: "Edit repeating entry" };

export default async function EditRecurringPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const ruleId = parseId((await params).id);
  const rule = ruleId ? await getRecurring(user.id, ruleId) : null;
  if (!rule) notFound();

  const categories = (await categoryOptions(user.id, [rule.categoryId])).filter((c) => c.kind === rule.kind);
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={`Edit repeating ${rule.kind}`}
        description={`${describeSchedule(rule)}, counted from ${formatDate(rule.startDate)}.`}
      />
      <RecurringForm
        action={updateRecurringAction.bind(null, rule.id)}
        kind={rule.kind}
        today={todayInZone(user.timeZone)}
        wallets={await walletOptions(user.id, [rule.walletId])}
        categories={categories}
        defaults={{
          walletId: rule.walletId,
          categoryId: rule.categoryId,
          amount: minorToInputValue(rule.amountMinor, rule.currency),
          note: rule.note ?? "",
          frequency: rule.frequency,
          interval: rule.interval,
          nextDate: rule.nextDate ?? "",
          endDate: rule.endDate ?? "",
        }}
      />
    </div>
  );
}

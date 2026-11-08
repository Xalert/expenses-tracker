import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type InsightCardTone = "default" | "income" | "expense";

const toneClass: Record<InsightCardTone, string> = {
  default: "text-foreground",
  income: "text-income",
  expense: "text-expense",
};

/** A small figure card: muted title, a large value (coloured by `tone`) and an optional muted line under it. */
export function InsightCard({
  title,
  value,
  sub,
  tone = "default",
  className,
}: {
  title: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: InsightCardTone;
  className?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col gap-1.5 rounded-[18px] border border-border bg-surface p-4 sm:p-5", className)}>
      <h2 className="text-[13px] font-semibold text-muted-foreground">{title}</h2>
      <p
        className={cn(
          "truncate text-[22px] leading-tight font-extrabold tracking-[-0.02em] tabular-nums sm:text-[26px]",
          toneClass[tone],
        )}
      >
        {value}
      </p>
      {sub && <p className="text-[13px] text-muted-foreground">{sub}</p>}
    </section>
  );
}

import { BrandMark } from "@/components/brand";

// Heights (%) of the decorative bars along the bottom of the page: a quiet echo of the per-day charts inside.
const BARS = [22, 38, 30, 54, 26, 44, 70, 34, 48, 28, 60, 40, 24, 52, 36, 66, 30, 46, 58, 26, 42, 34, 74, 38, 50, 28, 44, 62, 32, 40];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-background">
      <main className="flex flex-1 flex-col items-center justify-center px-4 pt-10 pb-36">
        <div className="mb-7 flex items-center gap-2.5 text-xl font-extrabold tracking-tight text-foreground">
          <BrandMark className="size-9" />
          Expenses
        </div>
        <div className="w-full max-w-[420px]">{children}</div>
      </main>
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 flex h-28 items-end gap-1.5 px-4 opacity-60 sm:gap-2.5">
        {BARS.map((h, i) => (
          <div
            key={i}
            className={`min-w-0 flex-1 rounded-t-md ${i % 7 === 6 ? "bg-accent-soft" : "bg-surface-muted"}`}
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
    </div>
  );
}

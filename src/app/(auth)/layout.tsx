import { BrandMark } from "@/components/brand";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="mb-8 flex items-center gap-2 text-lg font-semibold text-foreground">
        <BrandMark />
        Expenses Tracker
      </div>
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}

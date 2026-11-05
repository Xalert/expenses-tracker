import Link from "next/link";
import { BrandMark } from "@/components/brand";
import { BottomTabs, SidebarNav } from "@/components/shell/nav";
import { PlusIcon } from "@/components/shell/icons";
import { SignOutButton } from "@/components/shell/sign-out-button";
import { buttonClasses } from "@/components/ui/button";
import { requireUser } from "@/lib/auth";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <div className="min-h-dvh lg:pl-64">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-border bg-surface lg:flex">
        <Link href="/" className="flex h-16 items-center gap-2 px-5 text-base font-semibold text-foreground">
          <BrandMark />
          Expenses Tracker
        </Link>
        <div className="px-3">
          <Link href="/transactions/new" className={buttonClasses({ className: "mb-4 w-full" })}>
            <PlusIcon className="size-4" />
            Add transaction
          </Link>
          <SidebarNav />
        </div>
        <div className="mt-auto border-t border-border p-3">
          <div className="px-3 pb-2">
            <p className="truncate text-sm font-medium text-foreground">{user.name}</p>
            <p className="truncate text-xs text-muted-foreground">{user.email}</p>
          </div>
          <SignOutButton />
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur lg:hidden">
        <Link href="/" className="flex items-center gap-2 font-semibold text-foreground">
          <BrandMark className="size-6" />
          <span className="sr-only sm:not-sr-only">Expenses Tracker</span>
        </Link>
        <div className="flex min-w-0 items-center gap-1">
          <span className="truncate text-sm text-muted-foreground">{user.name}</span>
          <SignOutButton compact />
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl px-4 pt-6 pb-28 sm:px-6 lg:px-8 lg:pt-10 lg:pb-12">{children}</main>

      <BottomTabs />
    </div>
  );
}

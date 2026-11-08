import Link from "next/link";
import { BrandMark } from "@/components/brand";
import { AccountMenu } from "@/components/shell/account-menu";
import { AddButton } from "@/components/shell/add-button";
import { MainMenu } from "@/components/shell/nav";
import { NewEntryShortcut } from "@/components/shell/new-entry-shortcut";
import { requireUser } from "@/lib/auth";

/** Side padding shared by the top bar and the page container (16px on phones, 32px from `lg`). */
const GUTTER = "px-4 sm:px-6 lg:px-8";

export default async function AppLayout({ children, modal }: { children: React.ReactNode; modal: React.ReactNode }) {
  const user = await requireUser();

  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-surface">
        {/* One row from `sm` up; below it, brand + account, then the menu as its own scrolling row. */}
        <div className={`mx-auto flex max-w-[1240px] flex-wrap items-center gap-x-6 gap-y-2 py-3 ${GUTTER}`}>
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2.5 rounded-lg text-[17px] font-extrabold tracking-tight text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            <BrandMark className="size-8" />
            <span className="sm:max-md:sr-only">Expenses</span>
          </Link>
          <MainMenu className="order-last w-full sm:order-none sm:w-auto sm:flex-1" />
          <div className="ml-auto sm:ml-0">
            <AccountMenu displayName={user.displayName} username={user.username} email={user.email} />
          </div>
        </div>
      </header>

      <main className={`mx-auto w-full max-w-[1240px] pt-6 pb-32 sm:pt-8 ${GUTTER}`}>{children}</main>

      <AddButton shellDefault />
      <NewEntryShortcut />
      {modal}
    </div>
  );
}

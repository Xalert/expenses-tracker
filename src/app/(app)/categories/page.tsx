import type { Metadata } from "next";
import { CategorySection } from "@/components/categories/category-section";
import { PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { listCategoriesWithUsage } from "@/server/categories";

export const metadata: Metadata = { title: "Categories" };

export default async function CategoriesPage() {
  const user = await requireUser();
  const all = listCategoriesWithUsage(user.id);

  return (
    <>
      <PageHeader
        title="Categories"
        description="Add, rename and remove the categories you file expenses and income under."
      />
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <CategorySection kind="expense" categories={all.filter((c) => c.kind === "expense")} />
        <CategorySection kind="income" categories={all.filter((c) => c.kind === "income")} />
      </div>
    </>
  );
}

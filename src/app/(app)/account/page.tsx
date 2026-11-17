import type { Metadata } from "next";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { ChangePasswordForm } from "./change-password-form";

export const metadata: Metadata = { title: "Account settings" };

export default async function AccountPage() {
  const user = await requireUser();
  return (
    <>
      <PageHeader title="Account settings" />
      <div className="max-w-xl space-y-6">
        <Card>
          <CardHeader title="Signed in as" />
          <CardBody>
            <dl className="space-y-3 text-sm">
              <Row label="Name" value={user.displayName} />
              <Row label="User ID" value={user.username} />
              {user.email && <Row label="Email" value={user.email} />}
            </dl>
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Change password"
            description="Your other devices are signed out when you change it."
          />
          <CardBody>
            <ChangePasswordForm username={user.username} />
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 truncate font-medium text-foreground" title={value}>
        {value}
      </dd>
    </div>
  );
}

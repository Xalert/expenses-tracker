import type { Metadata } from "next";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { currentSessionTokenHash, requireUser } from "@/lib/auth";
import { countOtherSessions } from "@/server/users";
import { ChangePasswordForm } from "./change-password-form";
import { DeleteAccountForm } from "./delete-account-form";
import { ProfileForm } from "./profile-form";
import { SessionsForm } from "./sessions-form";

export const metadata: Metadata = { title: "Account settings" };

export default async function AccountPage() {
  const user = await requireUser();
  const otherSessions = await countOtherSessions(user.id, await currentSessionTokenHash());
  return (
    <>
      <PageHeader title="Account settings" />
      <div className="max-w-xl space-y-6">
        <Card>
          <CardHeader title="Profile" description={`Signed in as ${user.displayName}.`} />
          <CardBody>
            <ProfileForm
              username={user.username}
              email={user.email}
              firstName={user.firstName}
              lastName={user.lastName}
            />
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
        <Card>
          <CardHeader title="Devices" description="Sessions last 30 days unless you sign out." />
          <CardBody>
            <SessionsForm otherSessions={otherSessions} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Delete account" />
          <CardBody>
            <DeleteAccountForm username={user.username} />
          </CardBody>
        </Card>
      </div>
    </>
  );
}

import type { Metadata } from "next";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui";
import { currentSessionTokenHash, requireUser } from "@/lib/auth";
import { formatDateTime } from "@/lib/dates";
import { groupedTimeZones } from "@/lib/time-zone";
import { deviceLabel } from "@/lib/user-agent";
import { getUserTimeZone, listSessions } from "@/server/users";
import { ChangePasswordForm } from "./change-password-form";
import { DeleteAccountForm } from "./delete-account-form";
import { ProfileForm } from "./profile-form";
import { SessionsForm } from "./sessions-form";

export const metadata: Metadata = { title: "Account settings" };

export default async function AccountPage() {
  const user = await requireUser();
  const timeZone = await getUserTimeZone(user.id);
  // Times in the account's zone (UTC when it has none), so the server's HTML and hydration agree.
  const shownZone = timeZone ?? "UTC";
  const devices = (await listSessions(user.id, await currentSessionTokenHash())).map((s) => ({
    id: s.id,
    label: deviceLabel(s.userAgent),
    signedInAt: formatDateTime(s.createdAt, shownZone),
    lastActiveAt: formatDateTime(s.lastUsedAt, shownZone),
    current: s.current,
  }));
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
              timeZone={timeZone}
              timeZones={groupedTimeZones()}
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
            <SessionsForm devices={devices} />
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

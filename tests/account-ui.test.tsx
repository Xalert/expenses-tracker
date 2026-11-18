// The /account forms rendered to static markup: prefilled profile, unique ids across the forms that each have a
// current-password field, the devices count and the deletion card's backup link.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeleteAccountForm } from "@/app/(app)/account/delete-account-form";
import { ChangePasswordForm } from "@/app/(app)/account/change-password-form";
import { ProfileForm } from "@/app/(app)/account/profile-form";
import { SessionsForm } from "@/app/(app)/account/sessions-form";

describe("/account forms", () => {
  it("prefills the profile and asks for the password only as an optional field", () => {
    const html = renderToStaticMarkup(<ProfileForm username="ana" email={null} firstName="Ana" lastName={null} />);
    expect(html).toContain('name="username"');
    expect(html).toMatch(/name="username"[^>]*value="ana"|value="ana"[^>]*name="username"/);
    expect(html).toMatch(/value="Ana"/);
    expect(html).toContain("Needed only when you change your user ID or email.");
    expect(html).not.toMatch(/name="currentPassword"[^>]*required/);
  });

  it("gives each form's current-password input its own id", () => {
    const html = [
      renderToStaticMarkup(<ProfileForm username="ana" email={null} firstName={null} lastName={null} />),
      renderToStaticMarkup(<ChangePasswordForm username="ana" />),
      renderToStaticMarkup(<DeleteAccountForm username="ana" />),
    ].join("");
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(html.match(/name="currentPassword"/g)).toHaveLength(3);
  });

  it("says how many other devices are signed in", () => {
    expect(renderToStaticMarkup(<SessionsForm otherSessions={0} />)).toContain("signed in on this device only");
    expect(renderToStaticMarkup(<SessionsForm otherSessions={1} />)).toContain("1 other device or browser");
    expect(renderToStaticMarkup(<SessionsForm otherSessions={3} />)).toContain("3 other devices or browsers");
  });

  it("offers a backup before deleting and names the user ID to type", () => {
    const html = renderToStaticMarkup(<DeleteAccountForm username="ana.pop" />);
    expect(html).toContain('href="/api/export/backup"');
    expect(html).toContain("<strong>ana.pop</strong>");
    expect(html).toContain("Delete account");
  });
});

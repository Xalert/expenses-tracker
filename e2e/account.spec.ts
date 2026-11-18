import { expect, hydrated, signInContext, test } from "./support/fixtures";
import { openSession, PASSWORD } from "./support/seed";

const NEW_PASSWORD = "e2e-new-password-2";

test("changing the password signs the other browser out and keeps this one @phone", async ({ signedIn: page, user, browser, baseURL }) => {
  // A second browser, signed in as the same user.
  const other = await browser.newContext();
  await signInContext(other, await openSession(user.id, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148 Safari/604.1"), baseURL!);
  const otherPage = await other.newPage();
  await otherPage.goto("/");
  await expect(otherPage).toHaveURL("/");

  await page.goto("/");
  await hydrated(page);
  // Through the account menu: the link closes the popover.
  await page.getByRole("button", { name: /^Account: / }).click();
  await page.getByRole("link", { name: "Account settings" }).click();
  await expect(page).toHaveURL("/account");
  await expect(page.getByRole("link", { name: "Account settings" })).toBeHidden();

  const card = page.locator("form").filter({ has: page.getByRole("button", { name: "Change password" }) });
  await card.getByLabel("Current password").fill(PASSWORD);
  await card.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await card.getByLabel("Confirm new password").fill(NEW_PASSWORD);
  await card.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Password changed. Your other devices were signed out.")).toBeVisible();
  // The form cleared itself.
  await expect(card.getByLabel("Current password")).toHaveValue("");
  await expect(card.getByLabel("New password", { exact: true })).toHaveValue("");

  // This browser is still signed in; the other one is sent to /login on its next request.
  await page.goto("/transactions");
  await expect(page).toHaveURL("/transactions");
  await otherPage.goto("/transactions");
  await expect(otherPage).toHaveURL(/\/login$/);
  await other.close();

  // The new password works.
  const fresh = await browser.newContext();
  const login = await fresh.newPage();
  await login.goto(`${baseURL}/login`);
  await login.getByLabel("User ID or email").fill(user.username);
  await login.getByLabel("Password").fill(NEW_PASSWORD);
  await login.getByRole("button", { name: "Sign in" }).click();
  await expect(login).toHaveURL(`${baseURL}/`);
  await fresh.close();
});

test("a profile edit shows the new name in the account menu; the time zone select saves", async ({ signedIn: page }) => {
  await page.goto("/account");
  await hydrated(page);
  const profile = page.locator("form").filter({ has: page.getByRole("button", { name: "Save profile" }) });
  await profile.getByLabel("First name (optional)").fill("Grace");
  await profile.getByLabel("Surname (optional)").fill("Hopper");
  const zone = profile.getByLabel("Time zone");
  // The account was created with Europe/Berlin; the list holds every zone, grouped by region.
  await expect(zone).toHaveValue("Europe/Berlin");
  expect(await zone.locator("option").count()).toBeGreaterThan(300);
  await zone.selectOption("Asia/Tokyo");
  await profile.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile saved.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Account: Grace Hopper" })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Time zone")).toHaveValue("Asia/Tokyo");
  await expect(page.getByLabel("First name (optional)")).toHaveValue("Grace");
});

test("the devices list signs out one other device", async ({ signedIn: page, user, browser, baseURL }) => {
  const other = await browser.newContext();
  await signInContext(other, await openSession(user.id, "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0"), baseURL!);
  const otherPage = await other.newPage();

  await page.goto("/account");
  await hydrated(page);
  const devices = page.getByRole("list", { name: "Signed-in devices" });
  await expect(devices.getByRole("listitem")).toHaveCount(2);
  await expect(devices.getByText(/This device/)).toHaveCount(1);
  await expect(devices.getByText(/Firefox on Windows/)).toBeVisible();
  await devices.getByRole("button", { name: /^Sign out Firefox on Windows/ }).click();
  await expect(page.getByText("Signed out that device.")).toBeVisible();
  await expect(devices.getByRole("listitem")).toHaveCount(1);

  await otherPage.goto(`${baseURL}/`);
  await expect(otherPage).toHaveURL(/\/login$/);
  await other.close();
});

test("deleting the account signs out and says so on /login @phone", async ({ signedIn: page, user }) => {
  await page.goto("/account");
  await hydrated(page);
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Delete account" }) });
  await form.getByLabel(/^Type your user ID/).fill(user.username);
  await form.getByLabel("Current password").fill(PASSWORD);
  page.once("dialog", (d) => d.accept());
  await form.getByRole("button", { name: "Delete account" }).click();
  await expect(page).toHaveURL(/\/login\?deleted=1$/);
  await expect(page.getByText("Your account and all its data were deleted.")).toBeVisible();
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
});

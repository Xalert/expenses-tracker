import { expect, hydrated, test } from "./support/fixtures";
import { PASSWORD, seedUser, uniqueUsername } from "./support/seed";

test("register, sign out, sign in again and land on the Overview @phone", async ({ page }) => {
  const username = uniqueUsername("reg");
  await page.goto("/register");
  await page.getByLabel("User ID").fill(username);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("First name").fill("Ada");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "Welcome, Ada" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create your first wallet" })).toBeVisible();

  await page.getByRole("button", { name: /^Account: Ada/ }).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel("User ID or email").fill(username.toUpperCase());
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: "Welcome, Ada" })).toBeVisible();
});

test("the browser's time zone reaches the new account, also after a refused first attempt", async ({ page }) => {
  const taken = await seedUser();
  await page.goto("/register");
  await hydrated(page);
  const zone = page.locator('input[type="hidden"][name="timeZone"]');
  await expect(zone).toHaveValue("Europe/Berlin");
  // Refused: the user ID is taken.
  await page.getByLabel("User ID").fill(taken.username);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByLabel("User ID")).toHaveAttribute("aria-invalid", "true");
  await expect(zone).toHaveValue("Europe/Berlin");

  await page.getByLabel("User ID").fill(uniqueUsername("tz"));
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL("/");
  await page.goto("/account");
  await expect(page.getByLabel("Time zone")).toHaveValue("Europe/Berlin");
});

test("a signed-out visit to an app page goes to /login", async ({ page }) => {
  await page.goto("/transactions");
  await expect(page).toHaveURL(/\/login$/);
});

test("the sixth sign-in attempt after five wrong passwords is refused with a wait message", async ({ page }) => {
  const user = await seedUser();
  await page.goto("/login");
  for (let i = 0; i < 5; i++) {
    await page.getByLabel("User ID or email").fill(user.username);
    await page.getByLabel("Password").fill(`wrong-${i}-password`);
    await page.getByRole("button", { name: "Sign in" }).click();
    // The form resets the password when the result is in.
    await expect(page.getByLabel("Password")).toHaveValue("");
    await expect(page.getByText("Invalid user ID, email or password")).toBeVisible();
  }
  // Even the right password is refused now, without saying whether it was right.
  await page.getByLabel("User ID or email").fill(user.username);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText(/Too many sign-in attempts\. Try again in \d+ minutes?\./)).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
});

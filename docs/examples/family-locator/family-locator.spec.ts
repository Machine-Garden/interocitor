import { expect, test, type Page } from "@playwright/test";

type ClientId = "alex" | "sam";
type FamilyLocation = {
  id: string;
  name: string;
  place: string;
  x: number;
  y: number;
  updatedAt: number;
};

async function locations(page: Page, client: ClientId): Promise<FamilyLocation[]> {
  return page.evaluate((id) => window.__locatorDemo.getLocations(id), client);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/docs/examples/family-locator/index.html");
  await page.waitForFunction(() => window.__locatorDemo?.ready());
});

test("a protected location auto-syncs without exposing mailbox plaintext", async ({ page }) => {
  await page.evaluate(() => window.__locatorDemo.update("alex", "park"));
  expect((await locations(page, "alex")).find((location) => location.id === "alex")?.place).toBe(
    "Riverside Park",
  );
  expect((await locations(page, "sam")).find((location) => location.id === "alex")?.place).toBe(
    "Home",
  );

  await expect
    .poll(
      async () => (await locations(page, "sam")).find((location) => location.id === "alex")?.place,
      { timeout: 15_000 },
    )
    .toBe("Riverside Park");

  const mailbox = await page.evaluate(() => window.__locatorDemo.getMailbox());
  expect(Object.values(mailbox).some((value) => value.includes("Riverside Park"))).toBe(false);
  await expect(page.locator("#mailbox-status")).toHaveAttribute("data-safe", "true");
});

test("the demo states the safety and trust limits", async ({ page }) => {
  await expect(page.getByText("Auto-sync every 5 seconds")).toBeVisible();
  await expect(page.getByText("Every paired endpoint")).toBeVisible();
});

test("the endpoint journal exposes local and remote plaintext diffs", async ({ page }) => {
  await page.evaluate(() => window.__locatorDemo.update("alex", "park"));
  await page.evaluate(() => window.__locatorDemo.sync());

  const journal = page.locator("#change-journal-list");
  await expect(journal).toContainText("Alex’s device");
  await expect(journal).toContainText("Sam’s device");
  await expect(journal).toContainText("local");
  await expect(journal).toContainText("remote");
  await expect(journal).toContainText('place: "Home" → "Riverside Park"');
  await expect(page.getByText("not authenticated, complete, or globally ordered")).toBeVisible();
});

test("the locator remains usable at a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.waitForFunction(() => window.__locatorDemo?.ready());
  await expect(page.getByRole("button", { name: "Sync now" })).toBeVisible();
  await expect(page.locator('[data-client="alex"] [data-place="park"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

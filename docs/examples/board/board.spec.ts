import { expect, test, type Page } from "@playwright/test";

type ClientId = "maya" | "noah";
type BoardCard = { id: string; title: string; column: string; rank: number; updatedBy: string };

async function cards(page: Page, client: ClientId): Promise<BoardCard[]> {
  return page.evaluate((id) => window.__boardDemo.getCards(id), client);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/docs/examples/board/index.html");
  await page.waitForFunction(() => window.__boardDemo?.ready());
});

test("independent local card edits converge without mailbox plaintext", async ({ page }) => {
  const mayaSecret = "Plan the moonlight launch";
  const noahSecret = "Audit invite permissions";
  await page.evaluate(({ title }) => window.__boardDemo.addCard("maya", title), {
    title: mayaSecret,
  });
  await page.evaluate(({ title }) => window.__boardDemo.addCard("noah", title), {
    title: noahSecret,
  });

  expect((await cards(page, "maya")).some((card) => card.title === noahSecret)).toBe(false);
  expect((await cards(page, "noah")).some((card) => card.title === mayaSecret)).toBe(false);

  await page.evaluate(() => window.__boardDemo.sync());
  const titles = (await cards(page, "maya")).map((card) => card.title);
  await expect
    .poll(async () => (await cards(page, "noah")).map((card) => card.title))
    .toEqual(titles);
  expect(titles).toEqual(expect.arrayContaining([mayaSecret, noahSecret]));

  const mailbox = await page.evaluate(() => window.__boardDemo.getMailbox());
  expect(Object.keys(mailbox).some((path) => path.includes("-chg_"))).toBe(true);
  expect(
    Object.values(mailbox).some(
      (value) => value.includes(mayaSecret) || value.includes(noahSecret),
    ),
  ).toBe(false);
  await expect(page.locator("#mailbox-status")).toHaveAttribute("data-safe", "true");
});

test("a local card move reaches the peer only after sync", async ({ page }) => {
  await page.evaluate(() => window.__boardDemo.moveCard("maya", "card_research", 1));
  expect((await cards(page, "maya")).find((card) => card.id === "card_research")?.column).toBe(
    "doing",
  );
  expect((await cards(page, "noah")).find((card) => card.id === "card_research")?.column).toBe(
    "ideas",
  );
  await page.evaluate(() => window.__boardDemo.sync());
  expect((await cards(page, "noah")).find((card) => card.id === "card_research")?.column).toBe(
    "doing",
  );
});

test("each board exposes a nearby reload control", async ({ page }) => {
  await expect(page.getByRole("button", { name: "Reload board" })).toHaveCount(2);
  await page.evaluate(() => window.__boardDemo.addCard("noah", "Reload from Noah"));
  await page.locator('[data-client="noah"] [data-reload-board]').click();
  await page.locator('[data-client="maya"] [data-reload-board]').click();
  await expect
    .poll(async () => (await cards(page, "maya")).some((card) => card.title === "Reload from Noah"))
    .toBe(true);
});

test("the board remains usable at a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.waitForFunction(() => window.__boardDemo?.ready());
  await expect(page.getByLabel("Add a card as Maya")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload board" })).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

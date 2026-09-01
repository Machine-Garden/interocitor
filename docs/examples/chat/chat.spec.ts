import { expect, test, type Page } from "@playwright/test";

type ClientId = "alice" | "bob";
type ChatMessage = { id: string; sender: string; body: string; createdAt: number };

async function messages(page: Page, client: ClientId): Promise<ChatMessage[]> {
  return page.evaluate((id) => window.__chatDemo.getMessages(id), client);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/docs/examples/chat/index.html");
  await page.waitForFunction(() => window.__chatDemo?.ready());
});

test("trusted clients exchange messages while the mailbox receives no plaintext", async ({
  page,
}) => {
  const secret = "meet beside the copper tree";
  await page.getByLabel("Message from Alice").fill(secret);
  await page.getByLabel("Send as Alice").click();

  await expect
    .poll(async () => (await messages(page, "bob")).map((row) => row.body))
    .toEqual([secret]);
  await expect(page.locator('[data-client="bob"] [data-message-list]')).toContainText(secret);

  const mailbox = await page.evaluate(() => window.__chatDemo.getMailbox());
  expect(Object.keys(mailbox).some((path) => path.includes("-chg_"))).toBe(true);
  expect(Object.values(mailbox).some((contents) => contents.includes(secret))).toBe(false);
  await expect(page.locator("#mailbox-status")).toHaveAttribute("data-safe", "true");
});

test("both clients retain only the newest 15 visible messages", async ({ page }) => {
  for (let index = 1; index <= 17; index++) {
    const targetClient: ClientId = index % 2 === 0 ? "bob" : "alice";
    await page.evaluate(({ clientId, body }) => window.__chatDemo.send(clientId, body), {
      clientId: targetClient,
      body: `message ${index}`,
    });
  }

  const expected = Array.from({ length: 15 }, (_, index) => `message ${index + 3}`);
  await expect
    .poll(async () =>
      Promise.all(
        (["alice", "bob"] as const).map(async (client) =>
          (await messages(page, client)).map((message) => message.body),
        ),
      ),
    )
    .toEqual([expected, expected]);

  const mailbox = await page.evaluate(() => window.__chatDemo.getMailbox());
  expect(Object.values(mailbox).some((contents) => contents.includes("message 1"))).toBe(false);
  await expect(page.locator("#retention-status")).toContainText("newest 15");
});

test("the chat remains usable at a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.waitForFunction(() => window.__chatDemo?.ready());

  await expect(page.getByLabel("Message from Alice")).toBeVisible();
  await expect(page.getByLabel("Message from Bob")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

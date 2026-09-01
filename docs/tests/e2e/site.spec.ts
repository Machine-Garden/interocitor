import { expect, test } from "@playwright/test";

test("public pages render with the deployment security headers", async ({ page }) => {
  const landing = await page.goto("/");
  expect(landing?.status()).toBe(200);
  const headers = landing?.headers() ?? {};
  expect(headers["content-security-policy"]).toContain("default-src 'self'");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["permissions-policy"]).toContain("camera=()");
  await expect(page).toHaveTitle("Interocitor — local-first app data without trusting the cloud");
  await expect(
    page.locator(
      "#why, #use-cases, #plain-language, #surfaces, #model, #remotes, #security, #decisions, #docs",
    ),
  ).toHaveCount(9);
  await expect(page.locator('.site-hero a[href="examples/todomvc/"]')).toBeVisible();
  await expect(page.locator(".site-hero .actions a")).toHaveCount(2);
  await expect(page.locator(".fit-card, .not-fit")).toHaveCount(0);
  await expect(page.getByText("A good fit when", { exact: true })).toHaveCount(0);

  const decisionPages = new Map([
    ["/trust", "Designing a trusted Interocitor mesh"],
    ["/data-boundaries", "Plan Interocitor data scope and availability"],
    ["/mailbox", "Choose and operate an Interocitor mailbox"],
    ["/automation", "Design trusted automation with Interocitor"],
  ]);

  for (const [route, title] of decisionPages) {
    const response = await page.goto(route);
    expect(response?.status(), route).toBe(200);
    await expect(page).toHaveTitle(title);
    await expect(page.locator("main h1")).toHaveCount(1);
    await expect(page.locator(".decision-summary dt").first()).toHaveText("Decision");
    await expect(page.getByText("Choose this page when", { exact: true })).toHaveCount(0);
    await expect(page.locator(".decision-routes a")).toHaveCount(4);
  }

  const explainer = await page.goto("/how-it-works");
  expect(explainer?.status()).toBe(200);
  await expect(page).toHaveTitle("How Interocitor handles independent operators");
});

test("short documentation routes keep their public targets", async ({ request }) => {
  const routes = new Map([
    ["/github", "https://github.com/Machine-Garden/interocitor"],
    ["/core", "https://github.com/Machine-Garden/interocitor/tree/main/packages/core#readme"],
    ["/web", "https://github.com/Machine-Garden/interocitor/tree/main/packages/web#readme"],
    ["/react", "https://github.com/Machine-Garden/interocitor/tree/main/packages/react#readme"],
    ["/workers", "https://github.com/Machine-Garden/interocitor/tree/main/packages/workers#readme"],
    ["/examples", "https://github.com/Machine-Garden/interocitor/tree/main/examples"],
    [
      "/security",
      "https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/security-model.md",
    ],
    [
      "/recovery",
      "https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/recovery.md",
    ],
    [
      "/mesh-access",
      "https://github.com/Machine-Garden/interocitor/blob/main/packages/workers/docs/mesh-access.md",
    ],
    [
      "/worker-runtime",
      "https://github.com/Machine-Garden/interocitor/blob/main/packages/workers/docs/runtime-options.md",
    ],
    [
      "/worker-maintenance",
      "https://github.com/Machine-Garden/interocitor/blob/main/packages/workers/docs/maintenance.md",
    ],
    [
      "/worker-relay",
      "https://github.com/Machine-Garden/interocitor/blob/main/packages/workers/docs/relay.md",
    ],
    [
      "/shared-keys",
      "https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/shared-key-scenarios.md",
    ],
    [
      "/web-credentials",
      "https://github.com/Machine-Garden/interocitor/tree/main/packages/web#credential-storage-choices",
    ],
    [
      "/data-surfaces",
      "https://github.com/Machine-Garden/interocitor/tree/main/packages/core#keep-rows-and-files-distinct",
    ],
    [
      "/compaction",
      "https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/compaction.md",
    ],
    [
      "/adapter-contract",
      "https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/adapter-contract.md",
    ],
    [
      "/python",
      "https://github.com/Machine-Garden/interocitor/tree/main/packages/interocitor-python#readme",
    ],
    [
      "/data-migrations",
      "https://github.com/Machine-Garden/interocitor/blob/main/packages/core/docs/data-migrations.md",
    ],
  ]);

  for (const [route, target] of routes) {
    const response = await request.get(route, { maxRedirects: 0 });
    expect(response.status(), route).toBe(302);
    expect(response.headers().location, route).toBe(target);
  }
});

test("decision paths stay usable at a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const choices = page.locator(".decision-choice");
  await expect(choices).toHaveCount(4);
  await expect(choices.first()).toBeVisible();
  await expect(page.locator('.site-hero a[href="examples/todomvc/"]')).toBeVisible();
  await expect(page.locator(".site-hero .actions a")).toHaveCount(2);
  await expect(page.locator("#decisions h2")).toContainText("Turn the model into an architecture");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await choices.first().click();
  await expect(page).toHaveURL(/\/trust$/);
  await expect(page.locator("main h1")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("every public HTML page exposes the shared site map", async ({ page }) => {
  const routes = [
    "/",
    "/how-it-works",
    "/trust",
    "/data-boundaries",
    "/mailbox",
    "/automation",
    "/examples/todomvc/",
    "/examples/chat/",
  ];

  for (const route of routes) {
    await page.goto(route);
    const footer = page.locator(".site-map-footer");
    await expect(footer, route).toBeVisible();
    await expect(footer.locator(".site-map-nav h2"), route).toHaveText([
      "Explore",
      "Architecture guides",
      "Build",
    ]);
    await expect(
      footer.getByRole("link", { name: "Trust & keys", exact: true }),
      route,
    ).toBeVisible();
    await expect(
      footer.getByRole("link", { name: "Live TodoMVC", exact: true }),
      route,
    ).toHaveCount(route === "/examples/todomvc/" ? 0 : 1);
    await expect(
      footer.getByRole("link", { name: "Source on GitHub", exact: true }),
      route,
    ).toHaveAttribute("href", "https://github.com/Machine-Garden/interocitor");
  }
});

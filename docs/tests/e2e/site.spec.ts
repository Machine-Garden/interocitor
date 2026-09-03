import { expect, test } from "@playwright/test";

test("the established landing page renders with deployment security headers", async ({ page }) => {
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
  await expect(page.getByRole("heading", { name: "Your app keeps working." })).toBeVisible();
  await expect(page.locator('.site-hero a[href="/examples/todomvc/"]')).toBeVisible();
  await expect(page.locator('.task-example a[href="/examples/board/"]')).toBeVisible();
  await expect(page.locator('.task-example a[href="/examples/family-locator/"]')).toBeVisible();
  await expect(page.locator(".site-hero .actions a")).toHaveCount(2);
  await expect(page.locator(".decision-choice")).toHaveCount(5);
  await expect(page.locator('.decision-choice[href="/auth"]')).toBeVisible();
});

test("Markdown documentation owns its content, outline, and metadata", async ({ page }) => {
  const documentation = new Map([
    ["/trust", "Designing a trusted Interocitor mesh"],
    ["/data-boundaries", "Plan Interocitor data scope and availability"],
    ["/mailbox", "Choose and operate an Interocitor mailbox"],
    ["/auth", "Choose an Interocitor authorization model"],
    ["/automation", "Design trusted automation with Interocitor"],
    ["/qa", "Interocitor questions and answers"],
    ["/dictionary", "Interocitor dictionary"],
    ["/flows", "Interocitor protocol flows"],
  ]);

  for (const [route, title] of documentation) {
    const response = await page.goto(route);
    expect(response?.status(), route).toBe(200);
    await expect(page).toHaveTitle(title);
    await expect(page.locator(".docs-hero h1")).toHaveCount(1);
    await expect(page.locator(".docs-content h2").first()).toBeVisible();
    await expect(page.locator(".docs-sidebar a[aria-current='page']")).toHaveCount(1);
    await expect(page.locator(".docs-outline a").first()).toBeVisible();
  }

  const explainer = await page.goto("/how-it-works");
  expect(explainer?.status()).toBe(200);
  await expect(page).toHaveTitle("How Interocitor handles independent operators");
  await expect(page.locator("#journey")).toBeVisible();
  await expect(page.locator("#compaction")).toBeVisible();
  await expect(page.locator("#boundary")).toBeVisible();
});

test("architecture links use client-side navigation", async ({ page }) => {
  let documentRequests = 0;
  page.on("request", (request) => {
    if (request.resourceType() === "document") documentRequests += 1;
  });
  await page.goto("/");
  await page.waitForFunction(() =>
    Boolean((window as Window & { next?: { router?: unknown } }).next?.router),
  );
  documentRequests = 0;

  await page.locator('.decision-choice[href="/auth"]').click();
  await expect(page).toHaveURL(/\/auth$/);
  await expect(page.locator(".docs-hero h1")).toContainText("authority that owns them");
  expect(documentRequests).toBe(0);
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
    expect([307, 308], route).toContain(response.status());
    expect(response.headers().location, route).toBe(target);
  }
});

test("landing and documentation stay usable at a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const choices = page.locator(".decision-choice");
  await expect(choices).toHaveCount(5);
  await expect(choices.first()).toBeVisible();
  await expect(page.locator('.site-hero a[href="/examples/todomvc/"]')).toBeVisible();
  await expect(page.locator("#decisions h2")).toContainText("Turn the model into an architecture");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await choices.first().click();
  await expect(page).toHaveURL(/\/trust$/);
  await expect(page.locator(".docs-hero h1")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("live examples remain reachable from the SPA", async ({ page }) => {
  const routes = [
    "/examples/todomvc/",
    "/examples/chat/",
    "/examples/board/",
    "/examples/family-locator/",
  ];

  for (const route of routes) {
    const response = await page.goto(route);
    expect(response?.status(), route).toBe(200);
    const example = page.locator(".demo-code");
    await expect(example, route).toHaveCount(1);
    await expect(example.locator("code"), route).toContainText("const schema = {");
    await expect(example.locator("code"), route).toContainText('db.table("');
    await expect(page.locator(".site-map-footer"), route).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Source on GitHub", exact: true }),
      route,
    ).toHaveAttribute("href", "https://github.com/Machine-Garden/interocitor");
  }
});

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
  await expect(page.locator('.remotes-summary a[href="/storage"]')).toContainText(
    "See how Interocitor stores data",
  );
  await expect(page.locator('.nav-cta[href="/how-it-works"]')).toContainText("Docs");
});

test("Markdown documentation owns its content, outline, and metadata", async ({ page }) => {
  const documentation = new Map([
    ["/trust", "Who is trusted inside an Interocitor mesh?"],
    ["/storage", "How Interocitor stores data"],
    ["/data-boundaries", "What belongs in Interocitor rows, files, and meshes?"],
    ["/mailbox", "Where should the Interocitor mailbox live?"],
    ["/auth", "Authentication is not one thing"],
    ["/automation", "How should an agent join an Interocitor mesh?"],
    ["/security", "What does Interocitor protect?"],
    ["/compaction", "Why does Interocitor compact old changes?"],
    ["/tainted-files", "How can one Interocitor file have fewer readers?"],
    ["/qa", "Interocitor questions and answers"],
    ["/dictionary", "Interocitor glossary"],
    ["/flows", "Interocitor core flows"],
  ]);

  for (const [route, title] of documentation) {
    const response = await page.goto(route);
    expect(response?.status(), route).toBe(200);
    await expect(page).toHaveTitle(title);
    await expect(page.locator(".docs-hero h1")).toHaveCount(1);
    await expect(page.locator(".docs-content h2").first()).toBeVisible();
    await expect(page.locator(".docs-sidebar a[aria-current='page']")).toHaveCount(1);
    await expect(page.locator(".docs-outline a").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Docs", exact: true })).toHaveAttribute(
      "href",
      "/how-it-works",
    );
    await expect(
      page.locator('.docs-content a[href*="github.com/Machine-Garden/interocitor/blob/main"]'),
    ).toHaveCount(0);
  }

  const explainer = await page.goto("/how-it-works");
  expect(explainer?.status()).toBe(200);
  await expect(page).toHaveTitle("Why Interocitor works the way it does");
  await expect(page.locator("#begin")).toBeVisible();
  await expect(page.locator("#evolution")).toBeVisible();
  await expect(page.locator("#characters")).toBeVisible();
  await expect(page.locator("#storage")).toBeVisible();
  await expect(page.locator('#storage + p + p a[href="/storage"]')).toBeVisible();
  await expect(page.locator("#journey")).toBeVisible();
  await expect(page.locator(".docs-content h3")).toHaveCount(5);
  await expect(page.locator("#history")).toBeVisible();
  await expect(page.locator("#boundaries")).toBeVisible();
  await expect(page.locator("#protection")).toBeVisible();
  await expect(page.locator("#adapter-title")).toBeVisible();
  await expect(page.locator(".mermaid-diagram svg")).toHaveCount(3);
  await expect(page.locator(".mermaid-error")).toHaveCount(0);

  const storage = await page.goto("/storage");
  expect(storage?.status()).toBe(200);
  await expect(page).toHaveTitle("How Interocitor stores data");
  await expect(page.locator("#promise")).toBeVisible();
  await expect(page.locator("#surfaces")).toBeVisible();
  await expect(page.locator("#profiles")).toBeVisible();
  for (const profile of [
    "Local NAS",
    "Privately held WebDAV",
    "Family Google Drive",
    "Cloudflare Free for personal or light use",
    "Advanced setups use Cloudflare",
  ]) {
    await expect(page.getByRole("heading", { level: 3, name: profile, exact: true })).toBeVisible();
  }
  await expect(page.locator(".docs-content")).toContainText("Family Google Drive");
  await expect(page.locator(".docs-content")).toContainText("Cloudflare Free");
  await expect(page.locator(".docs-content")).toContainText("100,000 Worker requests");
  await expect(page.locator(".docs-content")).toContainText("2,880 requests per day");
  await expect(page.locator(".docs-content")).toContainText("512 MiB durable-file quota");
  await expect(page.locator("#cloudflare-free-numbers")).toBeVisible();
  await expect(page.locator(".docs-content")).toContainText("Durable Object relay");
  await expect(page.locator("#backends")).toBeVisible();
  await expect(page.locator(".docs-content")).toContainText("Cloudflare + S3");
  await expect(page.locator(".mermaid-diagram svg")).toHaveCount(1);
  await expect(page.locator(".mermaid-error")).toHaveCount(0);
});

test("planning links use client-side navigation", async ({ page }) => {
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
  await expect(page.locator(".docs-hero h1")).toContainText("Four locks guard one mesh");
  expect(documentRequests).toBe(0);
});

test("the auth guide keeps independent access capabilities separate", async ({ page }) => {
  await page.goto("/auth");

  await expect(page.locator("#middleware")).toContainText("meshMiddleware");
  await expect(page.locator("#recovery")).toContainText("Twelve random BIP-39 words");
  await expect(page.locator("#taints")).toContainText("A taint is not an ACL");
  await expect(page.locator("#grants")).toContainText("Authentication still stays outside");
});

test("flow charts render as diagrams instead of source code", async ({ page }) => {
  await page.goto("/flows");

  await expect(page.locator(".mermaid-diagram svg")).toHaveCount(5);
  await expect(page.locator(".mermaid-error")).toHaveCount(0);
  await expect(page.locator("pre code.language-mermaid")).toHaveCount(0);
});

test("documentation starts within the first desktop viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/automation");

  const hero = await page.locator(".docs-hero-band").boundingBox();
  const sidebar = await page.locator(".docs-sidebar").boundingBox();
  const firstSection = await page.locator(".docs-content h2").first().boundingBox();

  expect(hero?.height).toBeLessThan(420);
  expect(sidebar?.y).toBe(hero?.y);
  expect(firstSection?.y).toBeLessThan(800);
});

test("documentation guides lead with their subject and close at the intended boundary", async ({
  page,
}) => {
  const guides = new Map([
    ["/how-it-works", "Let’s begin with the problem Interocitor solves"],
    ["/storage", "Start with Interocitor’s storage promise"],
    ["/trust", "Let the key define trust"],
    ["/data-boundaries", "Classify data by behavior"],
    ["/mailbox", "Define the mailbox boundary"],
    ["/auth", "Name the four locks"],
    ["/automation", "Treat the agent as a trusted endpoint"],
    ["/security", "Trace the encryption boundary"],
    ["/compaction", "Explain why the change log grows"],
    ["/tainted-files", "Restrict one file without splitting the mesh"],
  ]);

  for (const [route, opening] of guides) {
    await page.goto(route);
    const headings = page.locator(".docs-content h2");
    await expect(headings.first(), route).toHaveText(opening);
    await expect(headings.last(), route).toHaveText(
      route === "/storage" ? "Annex: Cloudflare Free numbers" : "Decision summary",
    );
  }
});

test("short documentation routes keep their public targets", async ({ request }) => {
  const routes = new Map([
    ["/github", "https://github.com/Machine-Garden/interocitor"],
    ["/core", "https://github.com/Machine-Garden/interocitor/tree/main/packages/core#readme"],
    ["/web", "https://github.com/Machine-Garden/interocitor/tree/main/packages/web#readme"],
    ["/react", "https://github.com/Machine-Garden/interocitor/tree/main/packages/react#readme"],
    ["/workers", "https://github.com/Machine-Garden/interocitor/tree/main/packages/workers#readme"],
    ["/examples", "https://github.com/Machine-Garden/interocitor/tree/main/examples"],
  ]);

  for (const [route, target] of routes) {
    const response = await request.get(route, { maxRedirects: 0 });
    expect([307, 308], route).toContain(response.status());
    expect(response.headers().location, route).toBe(target);
  }
});

test("old deep-doc shortcuts now lead back to the public guides", async ({ request }) => {
  const routes = new Map([
    ["/recovery", "/qa#lost-key"],
    ["/mesh-access", "/auth"],
    ["/worker-runtime", "/mailbox"],
    ["/worker-maintenance", "/mailbox#operations"],
    ["/worker-relay", "/flows#access"],
    ["/shared-keys", "/trust"],
    ["/web-credentials", "/trust#custody"],
    ["/data-surfaces", "/data-boundaries"],
    ["/adapter-contract", "/mailbox"],
    ["/python", "/automation"],
    ["/data-migrations", "/automation#duplicate"],
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
  await expect(page.locator("#decisions h2")).toContainText("Plan the system boundaries");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await choices.first().click();
  await expect(page).toHaveURL(/\/trust$/);
  await expect(page.locator(".docs-hero h1")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.goto("/flows");
  await expect(page.locator(".mermaid-diagram svg")).toHaveCount(5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);

  await page.goto("/storage");
  await expect(page.locator("#backends")).toBeVisible();
  await expect(page.locator(".mermaid-diagram svg")).toHaveCount(1);
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

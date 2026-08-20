import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const routes = [
  "/",
  "/coder/",
  "/commands/",
  "/cost/",
  "/integrations/",
  "/security/",
  "/docs/",
  "/docs/getting-started/",
  "/404.html",
];

const viewports = [
  { name: "mobile-320", width: 320, height: 720 },
  { name: "mobile-375", width: 375, height: 812 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "nav-boundary-900", width: 900, height: 900 },
  { name: "desktop", width: 1440, height: 1000 },
];

function collectRuntimeErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    errors.push(`requestfailed: ${request.url()} (${request.failure()?.errorText || "unknown"})`);
  });
  return errors;
}

for (const viewport of viewports) {
  test(`all routes fit ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const runtimeErrors = collectRuntimeErrors(page);

    for (const route of routes) {
      const response = await page.goto(route, { waitUntil: "networkidle" });
      expect(response?.status(), `${route} should load`).toBeLessThan(400);
      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(
        dimensions.scrollWidth,
        `${route} overflows at ${viewport.width}px: ${JSON.stringify(dimensions)}`,
      ).toBeLessThanOrEqual(dimensions.clientWidth + 1);
    }

    expect(runtimeErrors).toEqual([]);
  });
}

for (const viewport of [viewports[1], viewports[4]]) {
  for (const route of routes) {
    test(`${route} passes automated WCAG 2.2 AA checks at ${viewport.name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(route, { waitUntil: "networkidle" });
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      const summary = results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.map((node) => node.target.join(" ")),
      }));
      expect(summary).toEqual([]);
    });
  }
}

test("keyboard focus is visible on every route", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const route of routes) {
    await page.goto(route);
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement) || element === document.body) return null;
      const style = getComputedStyle(element);
      return { tag: element.tagName, outlineStyle: style.outlineStyle, outlineWidth: Number.parseFloat(style.outlineWidth) };
    });
    expect(focus, `${route} did not move focus`).not.toBeNull();
    expect(focus.outlineStyle, `${route} focus has no visible outline`).not.toBe("none");
    expect(focus.outlineWidth, `${route} focus outline is too thin`).toBeGreaterThanOrEqual(2);
  }
});

test("key pages reflow without horizontal overflow at 200% zoom", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  for (const route of ["/", "/commands/", "/docs/getting-started/"]) {
    await page.goto(route);
    const dimensions = await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
      return {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    expect(dimensions.scrollWidth, `${route} overflows at 200% zoom`).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  }
});

test("mobile menu is keyboard-operable and resets at the desktop breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  const button = page.locator("#mobile-menu-btn");
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#mobile-nav")).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator("#mobile-nav a").first()).toBeFocused();

  await page.setViewportSize({ width: 1000, height: 812 });
  await expect(page.locator("#mobile-nav")).toBeHidden();
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(button).toHaveAttribute("aria-label", "Open menu");
  await expect(button).toHaveText("☰");
});

test("command search renders hostile input only as text", async ({ page }) => {
  await page.goto("/commands/");
  const hostile = '<img src=x onerror="window.__siteXss = true">';
  await page.locator("#cmd-search").fill(hostile);
  const grid = page.locator("#cmd-grid");
  await expect(grid).toContainText(hostile);
  await expect(grid.locator("img")).toHaveCount(0);
  expect(await page.evaluate(() => window.__siteXss)).toBeUndefined();
});

test("touch controls meet the 44px target on coarse pointers", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  const selector = [
    "a:visible",
    "button:visible",
    "input:not([type=hidden]):visible",
    "select:visible",
    "textarea:visible",
    "summary:visible",
    "[role=button]:visible",
    "[tabindex]:not([tabindex='-1']):visible",
  ].join(", ");
  for (const route of routes) {
    await page.goto(route);
    const undersized = await page.locator(selector).evaluateAll((controls) =>
      [...new Set(controls)].map((control) => {
        const rect = control.getBoundingClientRect();
        return {
          tag: control.tagName.toLowerCase(),
          label: control.getAttribute("aria-label") || control.textContent?.trim() || control.getAttribute("name"),
          width: rect.width,
          height: rect.height,
        };
      }).filter(({ width, height }) => width < 44 || height < 44));
    expect(undersized, `${route} has undersized interactive touch targets`).toEqual([]);
  }

  await page.goto("/");
  await page.locator("#mobile-menu-btn").click();
  const undersizedOpenMenuTargets = await page.locator(selector).evaluateAll((controls) =>
    [...new Set(controls)].map((control) => {
      const rect = control.getBoundingClientRect();
      return {
        tag: control.tagName.toLowerCase(),
        label: control.getAttribute("aria-label") || control.textContent?.trim(),
        width: rect.width,
        height: rect.height,
      };
    }).filter(({ width, height }) => width < 44 || height < 44));
  expect(undersizedOpenMenuTargets).toEqual([]);
  await context.close();
});

test("reduced-motion preference disables meaningful animation", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto("/");
  const moving = await page.locator("body *").evaluateAll((elements) => {
    const milliseconds = (value) => value.split(",").map((part) => {
      const duration = part.trim();
      return duration.endsWith("ms") ? Number.parseFloat(duration) : Number.parseFloat(duration) * 1000;
    });
    return elements.map((element) => {
      const style = getComputedStyle(element);
      return {
        element: element.tagName.toLowerCase(),
        animation: style.animationDuration,
        transition: style.transitionDuration,
        maxMs: Math.max(...milliseconds(style.animationDuration), ...milliseconds(style.transitionDuration)),
      };
    }).filter(({ maxMs }) => maxMs > 1);
  });
  expect(moving).toEqual([]);
  await context.close();
});

test("fonts are local and successfully loaded", async ({ page }) => {
  const remoteResources = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) remoteResources.push(request.url());
  });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('16px "IBM Plex Sans"'))).toBe(true);
  expect(await page.evaluate(() => document.fonts.check('16px "IBM Plex Mono"'))).toBe(true);
  expect(remoteResources).toEqual([]);
});

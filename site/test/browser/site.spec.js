// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

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
  "/workflows/",
  "/workflows/research/",
  "/workflows/review/",
  "/workflows/implementation/",
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
  for (const route of ["/", "/commands/", "/docs/getting-started/", "/workflows/research/", "/workflows/implementation/"]) {
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

test("quickstart step navigation stops being sticky on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/docs/getting-started/");
  const steps = page.locator(".quickstart-steps");
  await expect(steps).toHaveCSS("position", "static");

  await page.locator("#step-3").scrollIntoViewIfNeeded();
  const mobilePosition = await steps.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { bottom: rect.bottom, viewportHeight: window.innerHeight };
  });
  expect(mobilePosition.bottom).toBeLessThan(0);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/docs/getting-started/");
  await expect(steps).toHaveCSS("position", "sticky");
});

test("OMP engine control supports keyboard selection and command copy", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 375, height: 812 });
  const runtimeErrors = collectRuntimeErrors(page);
  await page.goto("/coder/", { waitUntil: "networkidle" });

  const opencode2 = page.locator('[data-engine="opencode2"]');
  await opencode2.click();
  await expect(opencode2).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#engine-body")).toContainText("0.0.0-beta-19059 or newer");
  await expect(page.locator("#engine-body")).toContainText("never one pinned build");

  const crush = page.locator('[data-engine="crush"]');
  const omp = page.locator('[data-engine="omp"]');
  await crush.focus();
  await page.keyboard.press("ArrowRight");
  await expect(omp).toBeFocused();
  await expect(omp).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#engine-body")).toContainText(/run-private config/i);
  await expect(page.locator("#engine-body")).toContainText("not an OS sandbox");
  await expect(page.locator("#engine-command")).toHaveText('triss coder run --engine omp "your task"');

  await page.locator("#copy-engine-command").click();
  await expect(page.locator("#copy-engine-command")).toHaveText("copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('triss coder run --engine omp "your task"');
  await expect(omp).toBeVisible();
  expect(runtimeErrors).toEqual([]);
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

test("homepage install copy reports success only after a real clipboard write", async ({ context, page }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:4876" });
  await page.goto("/");
  const button = page.locator("#copy-install-btn");
  await button.click();
  await expect(button).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("npm install -g triss-coworker");
  await expect(page.locator("#install-command")).toBeVisible();
});

test("homepage install copy does not report success when the clipboard write fails", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
    });
  });
  await page.goto("/");
  const button = page.locator("#copy-install-btn");
  await button.click();
  await expect(button).toHaveText("Select and copy the command");
  await expect(page.locator("#install-command")).toBeVisible();
});

test("quickstart target switching preserves the package-manager selection", async ({ page }) => {
  await page.goto("/docs/getting-started/");
  await page.locator('[data-pm="pnpm"]').click();
  await expect(page.locator('[data-install-panel="pnpm"]')).toBeVisible();
  await expect(page.locator('[data-install-panel="npm"]')).toBeHidden();

  await page.locator('[data-target="codex"]').click();
  await expect(page.locator('[data-agent-panel="codex"]')).toBeVisible();
  await expect(page.locator('[data-agent-panel="claude"]')).toBeHidden();
  await expect(page.locator('[data-install-panel="pnpm"]')).toBeVisible();

  await page.locator('[data-target="terminal"]').click();
  await expect(page.locator('[data-agent-panel="terminal"]')).toBeVisible();
});

test("quickstart exposes every setup variant without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/docs/getting-started/");
  for (const target of ["claude", "codex", "terminal"]) {
    await expect(page.locator(`[data-agent-panel="${target}"]`)).toBeVisible();
  }
  for (const pm of ["npm", "pnpm", "yarn"]) {
    await expect(page.locator(`[data-install-panel="${pm}"]`)).toBeVisible();
  }
  await context.close();
});

test("workflow pages link to the reference pages they depend on", async ({ page }) => {
  await page.goto("/workflows/research/");
  await expect(page.locator('.workflow-next a[href="/commands/"]')).toBeVisible();
  await page.goto("/workflows/review/");
  await expect(page.locator('.workflow-next a[href="/workflows/implementation/"]')).toBeVisible();
  await page.goto("/workflows/implementation/");
  await expect(page.locator('.workflow-next a[href="/coder/"]')).toBeVisible();
  await expect(page.locator('.workflow-next a[href="/security/"]')).toBeVisible();
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

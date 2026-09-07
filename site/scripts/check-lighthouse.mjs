// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "@playwright/test";
import { launch } from "chrome-launcher";
import lighthouse from "lighthouse";

const root = process.cwd();
const dist = path.join(root, "dist");
const reports = path.join(root, ".lighthouse");
const auditedRoutes = [
  "/",
  "/commands/",
  "/docs/getting-started/",
  "/workflows/",
  "/workflows/research/",
  "/workflows/review/",
  "/workflows/implementation/",
];
const categories = ["performance", "accessibility", "best-practices", "seo"];
const minimumScore = 0.9;

if (!fs.existsSync(path.join(dist, "index.html"))) {
  throw new Error('dist/ is missing; run "npm run build" before Lighthouse');
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
]);

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname);
  let relative = pathname.replace(/^\/+/, "");
  if (!relative || relative.endsWith("/")) relative += "index.html";
  const file = path.resolve(dist, relative);
  if (file !== dist && !file.startsWith(`${dist}${path.sep}`)) {
    response.writeHead(400).end("bad request");
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
    return;
  }
  response.writeHead(200, {
    "content-type": contentTypes.get(path.extname(file)) || "application/octet-stream",
    "cache-control": "public, max-age=3600",
  });
  fs.createReadStream(file).pipe(response);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to start Lighthouse server");
const origin = `http://127.0.0.1:${address.port}`;
fs.rmSync(reports, { recursive: true, force: true });
fs.mkdirSync(reports, { recursive: true });

const chrome = await launch({
  chromePath: chromium.executablePath(),
  chromeFlags: ["--headless", "--no-sandbox", "--disable-dev-shm-usage"],
});

const failures = [];
try {
  for (const route of auditedRoutes) {
    const result = await lighthouse(`${origin}${route}`, {
      logLevel: "error",
      output: "json",
      port: chrome.port,
      onlyCategories: categories,
    });
    if (!result?.lhr) throw new Error(`Lighthouse returned no report for ${route}`);
    const name = route === "/" ? "home" : route.replace(/^\/|\/$/g, "").replaceAll("/", "-");
    fs.writeFileSync(path.join(reports, `${name}.json`), JSON.stringify(result.lhr, null, 2));
    const scores = Object.fromEntries(categories.map((category) => [category, result.lhr.categories[category]?.score ?? 0]));
    process.stdout.write(`${route} ${Object.entries(scores).map(([key, value]) => `${key}=${Math.round(value * 100)}`).join(" ")}\n`);
    for (const [category, score] of Object.entries(scores)) {
      if (score < minimumScore) failures.push(`${route} ${category}=${Math.round(score * 100)} (minimum 90)`);
    }
  }
} finally {
  chrome.kill();
  await new Promise((resolve) => server.close(resolve));
}

if (failures.length) throw new Error(`Lighthouse thresholds failed:\n${failures.join("\n")}`);
process.stdout.write("Lighthouse thresholds passed\n");

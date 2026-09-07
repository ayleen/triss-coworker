// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Reproducible generation of the social preview card (og-image.png, 1200x630).
// Renders a controlled local HTML document with the site's local IBM Plex
// fonts and mascot asset through the already-installed Playwright Chromium.
// No remote embeds, fonts, or new packages. Run from site/: npm run generate:og
import { chromium } from "playwright";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(siteRoot, "public");
const outputFile = path.join(publicDir, "og-image.png");

const WIDTH = 1200;
const HEIGHT = 630;
const MAX_BYTES = 350 * 1024;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  @font-face {
    font-family: "IBM Plex Sans";
    src: url("file://${path.join(publicDir, "fonts", "IBMPlexSans-SemiBold.woff2")}") format("woff2");
    font-weight: 600;
  }
  @font-face {
    font-family: "IBM Plex Sans";
    src: url("file://${path.join(publicDir, "fonts", "IBMPlexSans-Regular.woff2")}") format("woff2");
    font-weight: 400;
  }
  @font-face {
    font-family: "IBM Plex Mono";
    src: url("file://${path.join(publicDir, "fonts", "IBMPlexMono-Medium.woff2")}") format("woff2");
    font-weight: 500;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    background: #0b0d10;
    color: #e7eaee;
    font-family: "IBM Plex Sans", sans-serif;
    position: relative;
    overflow: hidden;
  }
  .frame {
    position: absolute;
    inset: 28px;
    border: 1px solid #23262e;
  }
  .glow {
    position: absolute;
    right: -180px;
    top: -180px;
    width: 560px;
    height: 560px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(95, 180, 100, 0.14) 0%, rgba(95, 180, 100, 0) 70%);
  }
  .content {
    position: absolute;
    inset: 0;
    padding: 72px 80px;
    display: flex;
    flex-direction: column;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 18px;
  }
  .brand img {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    border: 1px solid #2d323c;
    display: block;
  }
  .brand .name {
    font-family: "IBM Plex Mono", monospace;
    font-weight: 500;
    font-size: 34px;
    color: #f2f4f6;
    letter-spacing: -0.01em;
  }
  .brand .sub {
    font-family: "IBM Plex Mono", monospace;
    font-size: 14px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #8b929e;
    margin-top: 6px;
  }
  .headline {
    margin: auto 0 0;
    font-weight: 600;
    font-size: 62px;
    line-height: 1.12;
    letter-spacing: -0.02em;
    color: #f2f4f6;
    max-width: 15em;
  }
  .headline span { color: #5fb464; }
  .tagline {
    margin: 26px 0 0;
    font-family: "IBM Plex Mono", monospace;
    font-weight: 500;
    font-size: 22px;
    letter-spacing: 0.01em;
    color: #9aa2ad;
  }
  .baseline {
    position: absolute;
    right: 80px;
    bottom: 66px;
    font-family: "IBM Plex Mono", monospace;
    font-size: 16px;
    color: #6d7480;
  }
</style>
</head>
<body>
  <div class="glow"></div>
  <div class="frame"></div>
  <div class="content">
    <div class="brand">
      <img src="file://${path.join(publicDir, "triss-avatar.png")}" alt="" />
      <div>
        <div class="name">triss</div>
        <div class="sub">coworker</div>
      </div>
    </div>
    <h1 class="headline">Managed delegation<br /><span>for AI development.</span></h1>
    <p class="tagline">Research. Review. Implement. Keep control.</p>
  </div>
  <div class="baseline">triss.work</div>
</body>
</html>
`;

const workDir = await mkdtemp(path.join(tmpdir(), "triss-og-"));
const htmlPath = path.join(workDir, "og.html");
await mkdir(workDir, { recursive: true });
await writeFile(htmlPath, html, "utf8");

let browser;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
  });
  await page.goto(`file://${htmlPath}`);
  await page.evaluate(async () => {
    await document.fonts.ready;
    const images = Array.from(document.images);
    await Promise.all(images.map((image) => image.complete
      ? Promise.resolve()
      : new Promise((resolve) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
        })));
  });
  await page.screenshot({ path: outputFile, type: "png", fullPage: false });

  const bytes = await readFile(outputFile);
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error(
      `Generated og-image.png is ${bytes.byteLength} bytes (limit ${MAX_BYTES}). ` +
        "Reduce gradient/image complexity before committing.",
    );
  }
  console.log(`og-image.png written: ${bytes.byteLength} bytes (${(bytes.byteLength / 1024).toFixed(1)} KiB)`);
} finally {
  if (browser) await browser.close();
  await rm(workDir, { recursive: true, force: true });
}

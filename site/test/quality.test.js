// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const dist = path.join(process.cwd(), "dist");
const hasDist = fs.existsSync(dist);

function filesUnder(directory) {
  return fs.readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function htmlFiles() {
  return filesUnder(dist).filter((file) => file.endsWith(".html"));
}

function attribute(html, pattern, label, file) {
  const match = html.match(pattern);
  assert.ok(match?.[1], `${file} is missing ${label}`);
  return match[1];
}

test("built pages have unique complete metadata and one main heading", { skip: !hasDist }, () => {
  const titles = new Map();
  const canonicals = new Map();
  for (const file of htmlFiles()) {
    const relative = path.relative(dist, file);
    const html = fs.readFileSync(file, "utf8");
    assert.match(html, /<html\s[^>]*lang="en"/i, `${relative} must declare its language`);
    assert.match(html, /<meta\s+name="viewport"\s+content="width=device-width, initial-scale=1"/i);

    const title = attribute(html, /<title>([^<]+)<\/title>/i, "title", relative);
    const description = attribute(html, /<meta\s+name="description"\s+content="([^"]+)"/i, "description", relative);
    const canonical = attribute(html, /<link\s+rel="canonical"\s+href="([^"]+)"/i, "canonical URL", relative);
    assert.ok(description.length >= 50 && description.length <= 180, `${relative} description length is ${description.length}`);
    assert.match(canonical, /^https:\/\/triss\.work\//);
    assert.equal(titles.has(title), false, `${relative} duplicates title from ${titles.get(title)}`);
    assert.equal(canonicals.has(canonical), false, `${relative} duplicates canonical from ${canonicals.get(canonical)}`);
    titles.set(title, relative);
    canonicals.set(canonical, relative);

    assert.match(html, /<meta\s+property="og:title"\s+content="[^"]+"/i, `${relative} is missing og:title`);
    assert.match(html, /<meta\s+property="og:description"\s+content="[^"]+"/i, `${relative} is missing og:description`);
    assert.match(html, /<meta\s+property="og:image"\s+content="https:\/\/[^"\s]+"/i, `${relative} is missing og:image`);
    assert.match(html, /<meta\s+name="twitter:card"\s+content="summary_large_image"/i, `${relative} is missing Twitter card metadata`);
    assert.equal((html.match(/<h1(?:\s|>)/gi) || []).length, 1, `${relative} must contain exactly one h1`);
  }
});

test("built HTML references only local runtime resources and dimensioned images", { skip: !hasDist }, () => {
  for (const file of htmlFiles()) {
    const relative = path.relative(dist, file);
    const html = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(html, /(?:\/Users\/|\/home\/runner\/|[A-Za-z]:\\)/, `${relative} leaks a build path`);
    assert.doesNotMatch(html, /(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})/, `${relative} resembles a secret`);

    for (const match of html.matchAll(/<(script|link|img|source)\b[^>]*>/gi)) {
      const tag = match[0];
      if (match[1].toLowerCase() === "link" && /\brel="canonical"/i.test(tag)) continue;
      const resource = tag.match(/\b(?:src|href|srcset)="(https?:\/\/[^"]+)"/i)?.[1];
      assert.equal(resource, undefined, `${relative} loads an unexpected remote resource: ${resource}`);
    }
    for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
      assert.match(match[0], /\balt="[^"]*"/i, `${relative} has an image without alt`);
      assert.match(match[0], /\bwidth="\d+"/i, `${relative} has an image without width`);
      assert.match(match[0], /\bheight="\d+"/i, `${relative} has an image without height`);
    }
  }
});

test("security headers and web manifest remain complete", { skip: !hasDist }, () => {
  const headers = fs.readFileSync(path.join(dist, "_headers"), "utf8");
  for (const header of [
    "X-Frame-Options: DENY",
    "X-Content-Type-Options: nosniff",
    "Referrer-Policy: strict-origin-when-cross-origin",
    "Permissions-Policy: camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy: same-origin",
    "Cross-Origin-Resource-Policy: same-origin",
  ]) {
    assert.ok(headers.includes(header), `missing security header: ${header}`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(dist, "site.webmanifest"), "utf8"));
  assert.ok(manifest.name && manifest.short_name, "manifest names are required");
  assert.equal(manifest.start_url, "/");
  assert.ok(["standalone", "minimal-ui", "browser"].includes(manifest.display));
  for (const icon of manifest.icons || []) {
    assert.ok(fs.existsSync(path.join(dist, icon.src.replace(/^\//, ""))), `manifest icon is missing: ${icon.src}`);
    assert.match(icon.sizes, /^(?:\d+x\d+|any)$/);
  }
});

test("site stays within explicit static asset budgets", { skip: !hasDist }, () => {
  const files = filesUnder(dist);
  const sizes = files.map((file) => ({ file: path.relative(dist, file), size: fs.statSync(file).size }));
  // Agent-facing machine-readable files (markdown mirrors, llms-full.txt,
  // the OpenAPI spec, /api responses) are never loaded by a browser, so
  // they carry their own budget and stay out of the user-facing page-weight
  // total. Per-type budgets below are unchanged.
  const isAgentFile = (file) =>
    /\.md$/.test(file) ||
    (/\.txt$/.test(file) && file !== "robots.txt") ||
    file === "openapi.json" ||
    file.startsWith("api/");
  const userTotal = sizes.filter(({ file }) => !isAgentFile(file)).reduce((sum, entry) => sum + entry.size, 0);
  const agentTotal = sizes.filter(({ file }) => isAgentFile(file)).reduce((sum, entry) => sum + entry.size, 0);
  const total = sizes.reduce((sum, entry) => sum + entry.size, 0);
  const totalJavaScript = sizes.filter(({ file }) => file.endsWith(".js")).reduce((sum, entry) => sum + entry.size, 0);
  assert.ok(userTotal <= 2 * 1024 * 1024, `user-facing dist is ${userTotal} bytes; budget is 2 MiB`);
  assert.ok(agentTotal <= 512 * 1024, `agent-readable files are ${agentTotal} bytes; budget is 512 KiB`);
  assert.ok(total <= 2.5 * 1024 * 1024, `dist is ${total} bytes; budget is 2.5 MiB`);
  assert.ok(totalJavaScript <= 150 * 1024, `client JavaScript is ${totalJavaScript} bytes; budget is 150 KiB`);

  for (const { file, size } of sizes) {
    if (file.endsWith(".html")) assert.ok(size <= 100 * 1024, `${file} exceeds the 100 KiB HTML budget`);
    if (file.endsWith(".js")) assert.ok(size <= 75 * 1024, `${file} exceeds the 75 KiB JavaScript budget`);
    if (file.endsWith(".css")) assert.ok(size <= 100 * 1024, `${file} exceeds the 100 KiB CSS budget`);
    if (/\.(?:png|jpe?g|webp|avif|ico)$/i.test(file)) assert.ok(size <= 350 * 1024, `${file} exceeds the 350 KiB image budget`);
    if (file.endsWith(".woff2")) assert.ok(size <= 80 * 1024, `${file} exceeds the 80 KiB font budget`);
    assert.equal(file.endsWith(".map"), false, `${file} publishes a source map`);
  }
});

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Worker contract: (1) the synthesized-response security policy stays in
// lockstep with public/_headers, (2) the wrangler run_worker_first patterns
// match the actual dist inventory, and (3) the documented HTTP behavior of
// router.js — negotiation states, HEAD, conditional requests, error headers.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { route, negotiateRepresentation, isDocumentPath, apiErrorBody } from "../src/worker/router.js";
import { SECURITY_HEADERS } from "../src/worker/response-headers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.join(here, "..");
const dist = path.join(siteRoot, "dist");

// --- policy sources stay in sync --------------------------------------------

test("response-headers policy matches public/_headers", () => {
  const lines = fs.readFileSync(path.join(siteRoot, "public", "_headers"), "utf8").split("\n");
  const fromFile = new Map();
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z-]+):\s*(.+)$/);
    if (match) fromFile.set(match[1].toLowerCase(), match[2].trim());
  }
  assert.ok(fromFile.size > 0, "_headers must declare headers under /*");
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(fromFile.get(name), value, `_headers and response-headers.js disagree on ${name}`);
  }
  assert.equal(fromFile.size, Object.keys(SECURITY_HEADERS).length, "one of the sources declares extra headers");
});

function patternToRegExp(pattern) {
  const negated = pattern.startsWith("!");
  const source = pattern.slice(negated ? 1 : 0);
  const body = source
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return { negated, regExp: new RegExp(`^${body}$`) };
}

function requestRouting(patterns, pathname) {
  const compiled = patterns.map(patternToRegExp);
  let invokeWorker = false;
  for (const { negated, regExp } of compiled) {
    if (!regExp.test(pathname)) continue;
    if (negated) return false;
    invokeWorker = true;
  }
  return invokeWorker;
}

test("run_worker_first bypasses real asset classes and keeps documents on the worker", () => {
  const configText = fs.readFileSync(path.join(siteRoot, "wrangler.jsonc"), "utf8");
  const jsonText = configText.replace(/^\s*\/\/.*$/gm, "");
  const config = JSON.parse(jsonText);
  const patterns = config.assets.run_worker_first;
  assert.ok(Array.isArray(patterns) && patterns.includes("/*"), "documents must stay worker-first");

  const bypassableExtensions = new Set([
    ".css", ".js", ".mjs", ".map", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
    ".ico", ".woff", ".woff2", ".ttf", ".otf", ".webmanifest", ".txt", ".md",
  ]);
  let checked = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "api") continue; // /api/* always invokes the worker
        walk(full);
        continue;
      }
      const relative = `/${path.relative(dist, full).split(path.sep).join("/")}`;
      if (entry.name.endsWith(".html")) {
        assert.equal(requestRouting(patterns, relative), true, `document ${relative} must invoke the worker`);
      } else if (bypassableExtensions.has(path.extname(entry.name))) {
        assert.equal(requestRouting(patterns, relative), false, `asset ${relative} must bypass the worker`);
        checked += 1;
      }
    }
  };
  assert.ok(fs.existsSync(dist), "dist/ is missing — run `npm run build` first");
  walk(dist);
  assert.ok(checked > 20, `unexpectedly few bypassable assets verified: ${checked}`);

  for (const pathname of ["/", "/docs/", "/cost/", "/api/v1/meta", "/sitemap.xml", "/missing-page/"]) {
    assert.equal(requestRouting(patterns, pathname), true, `${pathname} must invoke the worker`);
  }
});

// --- negotiation states ------------------------------------------------------

test("negotiation follows specificity, q-values, and the documented tie policy", () => {
  assert.equal(negotiateRepresentation(undefined), "html");
  assert.equal(negotiateRepresentation("*/*"), "html");
  assert.equal(negotiateRepresentation("text/markdown"), "markdown");
  assert.equal(negotiateRepresentation("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"), "html");
  assert.equal(negotiateRepresentation("text/*;q=0.9,text/markdown;q=0.1"), "html");
  assert.equal(negotiateRepresentation("text/html;q=0,text/*;q=0.8"), "markdown");
  assert.equal(negotiateRepresentation("text/html;q=0,*/*;q=0.8"), "markdown");
  assert.equal(negotiateRepresentation("text/html;q=0.2, text/markdown;q=0.5"), "markdown");
  assert.equal(negotiateRepresentation("application/json"), "not-acceptable");
  assert.equal(negotiateRepresentation("text/html;q=0,text/markdown;q=0"), "not-acceptable");
});

test("malformed q values reject the whole media range instead of inventing priority", () => {
  // parseFloat('1garbage') would make this range win; the documented policy
  // is to drop the malformed range entirely, so a header whose only range is
  // malformed behaves like no Accept at all (HTML default).
  assert.equal(negotiateRepresentation("text/markdown;q=1garbage"), "html");
  assert.equal(negotiateRepresentation("text/html;q=1garbage"), "html");
  assert.equal(negotiateRepresentation("text/markdown;q=0garbage,text/html;q=0.5"), "html");
  assert.equal(negotiateRepresentation("text/markdown;q=0.5,text/html;q=bad"), "markdown");
});

test("document-shaped URLs take part in negotiation, asset URLs do not", () => {
  for (const pathname of ["/", "/cost/", "/docs/getting-started/", "/missing-review-probe/"]) {
    assert.equal(isDocumentPath(pathname), true, pathname);
  }
  for (const pathname of ["/scripts/pricing-cost.js", "/fonts/IBMPlexSans-Regular.woff2", "/llms.txt", "/missing.css"]) {
    assert.equal(isDocumentPath(pathname), false, pathname);
  }
});

// --- runtime behavior over mocked assets -------------------------------------

function assetsMock() {
  return {
    ASSETS: {
      async fetch(req) {
        const { pathname } = new URL(req.url);
        const etag = req.headers.get("if-none-match");
        if (pathname === "/" || pathname === "/index.html") {
          if (etag === '"html"') return new Response(null, { status: 304, headers: { etag: '"html"' } });
          return new Response("<html><body><h1>Home</h1></body></html>", {
            headers: { "content-type": "text/html; charset=utf-8", etag: '"html"' },
          });
        }
        if (pathname === "/index.md") {
          if (etag === '"md"') return new Response(null, { status: 304, headers: { etag: '"md"' } });
          return new Response("# Home\n", {
            headers: { "content-type": "text/markdown; charset=utf-8", etag: '"md"' },
          });
        }
        if (pathname === "/api/v1/meta.json") {
          return new Response('{"ok":true}', { headers: { "content-type": "application/json; charset=utf-8" } });
        }
        return new Response("<html><body>404 page</body></html>", {
          status: 404,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    },
  };
}

const get = (accept, pathname = "/", extra = {}) =>
  route(new Request(`https://triss.work${pathname}`, { headers: { ...(accept ? { accept } : {}), ...extra } }), assetsMock());

test("HEAD returns the GET representation without a body", async () => {
  const htmlHead = await route(new Request("https://triss.work/", { method: "HEAD" }), assetsMock());
  assert.equal(htmlHead.status, 200);
  assert.match(htmlHead.headers.get("content-type"), /text\/html/);
  assert.equal((await htmlHead.arrayBuffer()).byteLength, 0, "HEAD HTML must have no body");

  const mdHead = await route(
    new Request("https://triss.work/", { method: "HEAD", headers: { accept: "text/markdown" } }),
    assetsMock(),
  );
  assert.equal(mdHead.status, 200);
  assert.match(mdHead.headers.get("content-type"), /text\/markdown/);
  assert.equal((await mdHead.arrayBuffer()).byteLength, 0, "HEAD markdown must have no body");
});

test("conditional requests revalidate against their own representation only", async () => {
  const markdown = await get("text/markdown");
  assert.match(markdown.headers.get("etag") ?? "", /"md"/, "markdown response carries the markdown validator");

  const mdRevalidate = await get("text/markdown", "/", { "if-none-match": '"md"' });
  assert.equal(mdRevalidate.status, 304, "matching markdown validator revalidates");
  assert.equal((await mdRevalidate.arrayBuffer()).byteLength, 0, "304 must not carry a body");
  assert.ok((mdRevalidate.headers.get("vary") || "").includes("Accept"), "304 must still declare Vary");

  const htmlRevalidate = await get("text/html", "/", { "if-none-match": '"md"' });
  assert.equal(htmlRevalidate.status, 200, "an HTML request must not be satisfied by a markdown ETag");

  const mdWithHtmlEtag = await get("text/markdown", "/", { "if-none-match": '"html"' });
  assert.equal(mdWithHtmlEtag.status, 200, "an HTML ETag must never stand in for markdown");
  assert.match(await mdWithHtmlEtag.text(), /# Home/);
});

test("synthesized and proxied responses carry the site security policy", async () => {
  const markdown404 = await get("text/markdown", "/missing-review-probe/");
  assert.equal(markdown404.status, 404);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(markdown404.headers.get(name), value, `markdown 404 missing ${name}`);
  }

  const notAcceptable = await get("application/json", "/");
  assert.equal(notAcceptable.status, 406);
  for (const name of Object.keys(SECURITY_HEADERS)) {
    assert.ok(notAcceptable.headers.get(name), `406 missing ${name}`);
  }

  const sitemap = await route(new Request("https://triss.work/sitemap.xml"), assetsMock());
  assert.equal(sitemap.status, 301);
  assert.equal(sitemap.headers.get("x-content-type-options"), "nosniff");

  const api405 = await route(new Request("https://triss.work/api/v1/meta", { method: "POST" }), assetsMock());
  assert.equal(api405.status, 405);
  assert.equal((api405.headers.get("allow") || "").toUpperCase(), "GET, HEAD");
  assert.equal(api405.headers.get("x-content-type-options"), "nosniff");
});

test("non-document misses keep the static 404 even for markdown agents", async () => {
  const response = await get("text/markdown", "/missing-asset.css");
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type"), /text\/html/, "static miss stays the standard 404 page");
});

test("api error bodies satisfy the published error shape", () => {
  const body = apiErrorBody("not_found", "Unknown API endpoint.", "Fetch /openapi.json");
  assert.deepEqual(body, { error: { code: "not_found", message: "Unknown API endpoint.", hint: "Fetch /openapi.json" } });
});

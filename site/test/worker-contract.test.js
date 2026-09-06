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

// Evaluates the run_worker_first patterns with a local glob matcher. This
// proves only that the CONFIG distinguishes the intended classes; live
// worker-vs-bypass behavior is proven over the network by
// scripts/check-agent-http.mjs.
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
        walk(full);
        continue;
      }
      const relative = `/${path.relative(dist, full).split(path.sep).join("/")}`;
      if (relative.startsWith("/api/")) {
        // The whole /api/** tree is behind the API contract (CORS, JSON 404s,
        // 405 + Allow) — nothing under it may bypass the worker, including
        // the published .json files.
        assert.equal(requestRouting(patterns, relative), true, `api file ${relative} must invoke the worker`);
        checked += 1;
      } else if (entry.name.endsWith(".html")) {
        assert.equal(requestRouting(patterns, relative), true, `document ${relative} must invoke the worker`);
      } else if (bypassableExtensions.has(path.extname(entry.name))) {
        assert.equal(requestRouting(patterns, relative), false, `asset ${relative} must bypass the worker`);
        checked += 1;
      } else if (/^sitemap-.*\.xml$/.test(entry.name)) {
        assert.equal(requestRouting(patterns, relative), false, `generated sitemap ${relative} must bypass the worker`);
        checked += 1;
      }
    }
  };
  assert.ok(fs.existsSync(dist), "dist/ is missing — run `npm run build` first");
  walk(dist);
  assert.ok(checked > 20, `unexpectedly few bypassable assets verified: ${checked}`);

  assert.equal(requestRouting(patterns, "/openapi.json"), false, "the standalone OpenAPI spec must bypass the worker");
  for (const pathname of ["/", "/docs/", "/cost/", "/api", "/api/v1/meta", "/api/v1/meta.json", "/sitemap.xml", "/missing-page/"]) {
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
        // Models the observed platform behavior: env.ASSETS.fetch resolves
        // the asset directly and does NOT replay the outer html_handling
        // redirect for /docs — only some (config-driven) routes redirect.
        if (pathname === "/archive") {
          return new Response(null, { status: 307, headers: { location: "/docs/" } });
        }
        if (pathname === "/foreign") {
          // A misconfigured (hypothetical) asset-layer redirect to another host.
          return new Response(null, { status: 307, headers: { location: "https://evil.com/docs/" } });
        }
        const isHtml = pathname === "/" || pathname === "/docs" || pathname === "/docs/" || pathname === "/index.html";
        const isMd = pathname === "/index.md" || pathname === "/docs/index.md";
        if (isHtml || isMd) {
          const tag = isHtml ? '"html"' : '"md"';
          if (etag === tag || etag === "*") {
            // Deliberately realistic: a 304 need not include Content-Type.
            return new Response(null, { status: 304, headers: { etag: tag } });
          }
          return new Response(
            isHtml ? "<html><body><h1>Home</h1></body></html>" : "# Home\n",
            { headers: { "content-type": isHtml ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8", etag: tag } },
          );
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

const varyTokens = (response) =>
  (response.headers.get("vary") || "").toLowerCase().split(",").map((token) => token.trim());

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
  assert.ok(varyTokens(mdRevalidate).includes("accept"), "304 must still declare Vary (Accept token)");

  const htmlRevalidate = await get("text/html", "/", { "if-none-match": '"md"' });
  assert.equal(htmlRevalidate.status, 200, "an HTML request must not be satisfied by a markdown ETag");

  const mdWithHtmlEtag = await get("text/markdown", "/", { "if-none-match": '"html"' });
  assert.equal(mdWithHtmlEtag.status, 200, "an HTML ETag must never stand in for markdown");
  assert.match(await mdWithHtmlEtag.text(), /# Home/);
});

test("F1: a matching validator cannot override the 406 profile", async () => {
  const response = await get("application/json", "/docs/", { "if-none-match": '"html"' });
  assert.equal(response.status, 406, "the preconditional 406 decision wins over a matched HTML ETag");
  assert.doesNotMatch(response.headers.get("etag") || "", /html/, "406 must not echo another representation's ETag");
  assert.equal((await response.json()).error.code, "not_acceptable");
  assert.ok(varyTokens(response).includes("accept"), "406 must declare the Accept token");
});

test("F1: If-None-Match: * with all representations excluded stays 406", async () => {
  const response = await get("text/html;q=0,text/markdown;q=0", "/docs/", { "if-none-match": "*" });
  assert.equal(response.status, 406);
});

test("F1: HEAD with an unacceptable representation stays a bodyless 406", async () => {
  const response = await route(
    new Request("https://triss.work/docs/", {
      method: "HEAD",
      headers: { accept: "application/json", "if-none-match": '"html"' },
    }),
    assetsMock(),
  );
  assert.equal(response.status, 406);
  assert.equal((await response.arrayBuffer()).byteLength, 0);
});

test("F1: accepted representations keep their own revalidation on /docs/", async () => {
  for (const [accept, tag] of [["text/html", '"html"'], ["text/markdown", '"md"']]) {
    const response = await get(accept, "/docs/", { "if-none-match": tag });
    assert.equal(response.status, 304, `${accept} revalidates its own representation`);
    assert.equal((await response.arrayBuffer()).byteLength, 0, "304 must not carry a body");
    const tokens = varyTokens(response);
    assert.ok(tokens.includes("accept") || tokens.includes("*"), `${accept} 304 must vary by Accept`);
    assert.ok(!tokens.includes("accept-encoding") || tokens.includes("accept"), "Accept-Encoding must not stand in for Accept");
  }
});

test("F3: the canonical redirect applies to markdown agents too", async () => {
  // The platform's outer redirect only fires for HTML-eligible requests, so
  // the worker canonicalizes directory-style pages for markdown itself.
  const mdRedirect = await get("text/markdown", "/docs");
  assert.equal(mdRedirect.status, 301, "directory-style page canonicalizes to its trailing-slash URL");
  assert.equal(mdRedirect.headers.get("location"), "/docs/");
  assert.equal((await mdRedirect.arrayBuffer()).byteLength, 0, "a redirect must not carry the mirror as a body");

  const canonical = await get("text/markdown", "/docs/");
  assert.equal(canonical.status, 200, "canonical URL serves the mirror");
  assert.match(canonical.headers.get("content-type"), /text\/markdown/);
  assert.match(await canonical.text(), /# Home/);
});

test("F3: a redirect returned by the asset layer is preserved as-is", async () => {
  const mdRedirect = await get("text/markdown", "/archive");
  assert.equal(mdRedirect.status, 307, "the platform's real status and location are kept");
  assert.equal(mdRedirect.headers.get("location"), "/docs/");

  const htmlRedirect = await get("text/html", "/archive");
  assert.equal(htmlRedirect.status, 307);
  assert.equal(htmlRedirect.headers.get("location"), "/docs/");
});

test("F3: a client ETag cannot turn the canonical redirect into a 304", async () => {
  const response = await get("text/markdown", "/docs", { "if-none-match": '"md"' });
  assert.equal(response.status, 301, "canonical resolution precedes conditional evaluation");
  assert.equal(response.headers.get("location"), "/docs/");

  const archived = await get("text/markdown", "/archive", { "if-none-match": '"md"' });
  assert.equal(archived.status, 307, "asset-layer redirects precede conditional evaluation too");
});

test("security: protocol-relative paths never redirect off-origin", async () => {
  // "//evil.com" is a valid request path, but in a Location header it would
  // be a protocol-relative URL. The canonicalizer collapses the double slash
  // into a same-origin path, so both probe sub-requests and any redirect
  // target stay on this origin — the attacker gets a plain 404, no Location.
  for (const pathname of ["//evil.com", "//evil.com/docs"]) {
    const response = await get("text/markdown", pathname);
    assert.equal(response.status, 404, `${pathname} is a plain same-origin miss`);
    assert.ok(!response.headers.has("location"), `${pathname} must not redirect`);
  }

  // Sanity: canonicalization itself is unaffected on honest paths.
  const canonical = await get("text/markdown", "/docs");
  assert.equal(canonical.status, 301);
  assert.equal(canonical.headers.get("location"), "/docs/");
});

test("security: foreign asset-layer locations are not re-emitted", async () => {
  // The asset layer must never hand the response an attacker-controlled
  // host: sameOriginLocation replaces a foreign Location with "/".
  const response = await get("text/markdown", "/foreign");
  assert.equal(response.status, 307, "the platform's status is kept");
  assert.equal(response.headers.get("location"), "/", "a foreign Location is replaced with the same-origin root");
  assert.doesNotMatch(response.headers.get("location") || "", /evil\.com/);
});

test("the .json forms of /api paths keep the API contract", async () => {
  // /api/v1/*.json is behind the same worker contract as the extensionless
  // endpoints: CORS on success, structured JSON 404s, 405 with Allow.
  const jsonForm = await route(new Request("https://triss.work/api/v1/meta.json"), assetsMock());
  assert.equal(jsonForm.status, 200);
  assert.equal(jsonForm.headers.get("access-control-allow-origin"), "*");
  assert.equal(jsonForm.headers.get("x-content-type-options"), "nosniff");

  const unknown = await route(new Request("https://triss.work/api/v1/unknown.json"), assetsMock());
  assert.equal(unknown.status, 404);
  assert.match(unknown.headers.get("content-type"), /application\/json/);
  assert.equal((await unknown.json()).error.code, "not_found");

  const rejected = await route(new Request("https://triss.work/api/v1/meta.json", { method: "POST" }), assetsMock());
  assert.equal(rejected.status, 405);
  assert.equal(rejected.headers.get("allow"), "GET, HEAD");
  assert.equal((await rejected.json()).error.code, "method_not_allowed");
});

test("security: asset-layer redirects with foreign locations are not amplified", async () => {
  // If the asset layer ever returned a cross-origin Location, the worker
  // must not re-emit it as an open redirect.
  const probe = await route(new Request("https://triss.work/archive"), assetsMock());
  assert.equal(probe.status, 307);
  assert.equal(probe.headers.get("location"), "/docs/");
});

test("N1: qvalue grammar accepts the empty fraction forms", () => {
  assert.equal(negotiateRepresentation("text/html;q=0.,text/markdown;q=1."), "markdown");
  assert.equal(negotiateRepresentation("text/html;q=0.,text/markdown;q=0."), "not-acceptable");
  assert.equal(negotiateRepresentation("text/markdown;q=1."), "markdown");
  assert.equal(negotiateRepresentation("text/markdown;q=0.123,text/html;q=0.5"), "html");
});

test("N1: qvalue grammar still rejects malformed values", () => {
  assert.equal(negotiateRepresentation("text/markdown;q=1.001"), "html");
  assert.equal(negotiateRepresentation("text/markdown;q=1.0000"), "html");
  assert.equal(negotiateRepresentation("text/markdown;q=-1"), "html");
  assert.equal(negotiateRepresentation("text/markdown;q="), "html");
  assert.equal(negotiateRepresentation("text/markdown;q=1garbage"), "html");
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

test("llms.txt does not promise an MCP registry on the CLI command page", () => {
  const llms = fs.readFileSync(path.join(siteRoot, "public", "llms.txt"), "utf8");
  assert.doesNotMatch(llms, /every CLI command and MCP tool/i, "the commands reference covers CLI commands, not MCP tools");
  assert.doesNotMatch(llms, /full (?:CLI command and )?MCP tool catalogue/i);
  assert.match(llms, /docs\/mcp\.md/, "MCP tooling must be pointed at its own documentation");
  assert.match(llms, /top-level CLI commands/i, "the commands link must describe its actual scope");
});

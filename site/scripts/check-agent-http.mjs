// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// HTTP acceptance matrix for the triss.work worker (review findings R2/R3/R5
// acceptance). Runs against a local `wrangler dev` started by
// scripts/run-agent-http.mjs (or any explicitly passed base URL, e.g. an
// approved preview deployment):
//
//   node scripts/check-agent-http.mjs --base http://127.0.0.1:8787
//
// Worker-invocation routing (run_worker_first) is verified separately and
// deterministically by site/test/worker-contract.test.js against the real
// dist inventory; this suite proves the served behavior of every request
// class over actual network I/O. Mostly GET/HEAD, plus deliberate POST
// probes of the documented 405 API contract — so run it locally or against
// an approved preview, never as a production smoke. No credentials.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist");

function parseArgs(argv) {
  const index = argv.indexOf("--base");
  const base = index !== -1 ? argv[index + 1] : undefined;
  if (!base) {
    console.error("usage: check-agent-http.mjs --base http://127.0.0.1:8787");
    process.exit(2);
  }
  return { base: base.replace(/\/$/, "") };
}

const { base } = parseArgs(process.argv);

const results = [];
function check(name, fn) {
  results.push(
    fn().then(
      () => ({ name, ok: true }),
      (error) => ({ name, ok: false, error }),
    ),
  );
}

const noRedirect = { redirect: "manual" };
async function request(pathname, { method = "GET", accept, headers = {}, ...rest } = {}) {
  const allHeaders = { ...headers };
  if (accept !== undefined) allHeaders.accept = accept;
  return fetch(`${base}${pathname}`, { method, headers: allHeaders, ...rest });
}

const shortType = (response) => (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
const assertEqual = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const assertOk = (condition, label) => {
  if (!condition) throw new Error(label);
};
const assertVary = (response, label) => {
  const tokens = (response.headers.get("vary") || "").toLowerCase().split(",").map((token) => token.trim());
  assertOk(
    tokens.includes("accept") || tokens.includes("*"),
    `${label}: response must declare the Accept token in Vary (got: ${response.headers.get("vary")})`,
  );
};
const assertSecurity = (response, label) => {
  assertOk((response.headers.get("x-content-type-options") || "") === "nosniff", `${label}: nosniff missing`);
  assertOk((response.headers.get("content-security-policy") || "").includes("script-src"), `${label}: CSP missing`);
};

function firstAsset(prefix, extensions) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some((ext) => entry.name.endsWith(ext))) found.push(full);
    }
  };
  const dir = path.join(dist, prefix);
  if (fs.existsSync(dir)) walk(dir);
  return found[0]?.replace(dist, "") ?? null;
}

async function etagFor(pathname, accept) {
  const response = await request(pathname, { accept });
  const etag = response.headers.get("etag");
  await response.arrayBuffer();
  return etag;
}

// --- the matrix ---------------------------------------------------------------

check("browser accept gets the real HTML homepage with Vary", async () => {
  const response = await request("/", { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" });
  assertEqual(response.status, 200, "status");
  assertEqual(shortType(response), "text/html", "content-type");
  assertVary(response, "homepage");
  const body = await response.text();
  assertOk(body.includes("Triss"), "homepage HTML content");
});

check("no Accept and */* default to HTML", async () => {
  for (const accept of [undefined, "*/*"]) {
    const response = await request("/", { accept });
    assertEqual(response.status, 200, `status for ${accept}`);
    assertEqual(shortType(response), "text/html", `content-type for ${accept}`);
    await response.arrayBuffer();
  }
});

check("markdown agents get faithful mirrors of key pages", async () => {
  for (const [pathname, expected] of [
    ["/", "# Give your coding agent a coworker."],
    ["/commands/", "# Every command, one handbook."],
    ["/docs/getting-started/", "# Your first delegated task."],
  ]) {
    const response = await request(pathname, { accept: "text/markdown" });
    assertEqual(response.status, 200, `status for ${pathname}`);
    assertEqual(shortType(response), "text/markdown", `content-type for ${pathname}`);
    assertVary(response, pathname);
    const body = await response.text();
    assertOk(body.includes(expected), `${pathname} markdown lost ${JSON.stringify(expected)}`);
  }
});

check("wildcard ranges resolve by specificity and quality", async () => {
  const htmlWins = await request("/", { accept: "text/*;q=0.9,text/markdown;q=0.1" });
  assertEqual(shortType(htmlWins), "text/html", "text/*;q=0.9 must outrank text/markdown;q=0.1");
  await htmlWins.arrayBuffer();
  for (const accept of ["text/html;q=0,text/*;q=0.8", "text/html;q=0,*/*;q=0.8"]) {
    const markdownWins = await request("/", { accept });
    assertEqual(shortType(markdownWins), "text/markdown", `${accept} must fall back to markdown`);
    await markdownWins.arrayBuffer();
  }
});

check("excluding every representation returns 406 per the documented profile", async () => {
  const response = await request("/", { accept: "text/html;q=0,text/markdown;q=0" });
  assertEqual(response.status, 406, "status");
  assertVary(response, "406");
  assertSecurity(response, "406");
  await response.arrayBuffer();
});

check("json-only accept on a document returns 406, not a soft HTML 200", async () => {
  const response = await request("/docs/", { accept: "application/json" });
  assertEqual(response.status, 406, "status");
  assertVary(response, "406");
  await response.arrayBuffer();
});

check("direct .md file serves markdown, not the HTML shell", async () => {
  const response = await request("/commands/index.md");
  assertEqual(response.status, 200, "status");
  assertEqual(shortType(response), "text/markdown", "content-type");
  const body = await response.text();
  assertOk(body.includes("# Every command, one handbook."), "direct mirror must be markdown content");
});

check("canonical trailing-slash redirect works without loops", async () => {
  const response = await request("/docs", noRedirect);
  // The redirect status is chosen by the platform's html_handling; any
  // temporary-or-permanent redirect to the canonical /docs/ URL is fine.
  assertOk([301, 302, 307, 308].includes(response.status), `expected a redirect, got ${response.status}`);
  const location = response.headers.get("location") || "";
  assertOk(location.endsWith("/docs/"), `unexpected location ${location}`);
  assertOk(!location.endsWith("/docs/docs/"), "redirect must not loop");
  const followed = await request("/docs/");
  assertEqual(followed.status, 200, "redirect target");
  assertEqual(shortType(followed), "text/html", "redirect target type");
  await followed.arrayBuffer();
});

check("canonical redirect applies to markdown agents too (F3)", async () => {
  const mdRedirect = await request("/docs", { accept: "text/markdown", ...noRedirect });
  assertOk(
    [301, 302, 307, 308].includes(mdRedirect.status),
    `markdown agent must see the canonical redirect, got ${mdRedirect.status}`,
  );
  const location = mdRedirect.headers.get("location") || "";
  assertOk(location.endsWith("/docs/"), `markdown redirect location ${location}`);
  assertEqual((await mdRedirect.arrayBuffer()).byteLength, 0, "redirect must not carry the mirror as a body");
  const canonical = await request("/docs/", { accept: "text/markdown" });
  assertEqual(canonical.status, 200, "canonical markdown target");
  assertEqual(shortType(canonical), "text/markdown", "canonical markdown type");
  await canonical.arrayBuffer();
});

check("missing document is a real HTML 404 for browsers", async () => {
  const response = await request("/review-probe-no-such-page-118/");
  assertEqual(response.status, 404, "status");
  assertEqual(shortType(response), "text/html", "content-type");
  const body = await response.text();
  assertOk(body.includes("Triss"), "404 page should help the visitor recover");
});

check("missing document is a markdown 404 with recovery links for agents", async () => {
  const response = await request("/review-probe-no-such-page-118/", { accept: "text/markdown" });
  assertEqual(response.status, 404, "status must stay 404");
  assertEqual(shortType(response), "text/markdown", "content-type");
  assertVary(response, "markdown 404");
  assertSecurity(response, "markdown 404");
  const body = await response.text();
  for (const link of ["/llms.txt", "/docs/", "/sitemap-index.xml"]) {
    assertOk(body.includes(link), `markdown 404 must link ${link}`);
  }
});

check("all documented API endpoints return schema-shaped JSON", async () => {
  const endpoints = [
    ["/api/v1/meta", ["name", "version", "cli", "resources"]],
    ["/api/v1/commands", ["count", "commands"]],
    ["/api/v1/docs", ["pages"]],
  ];
  for (const [pathname, fields] of endpoints) {
    const response = await request(pathname);
    assertEqual(response.status, 200, `status for ${pathname}`);
    assertEqual(shortType(response), "application/json", `content-type for ${pathname}`);
    const body = await response.json();
    for (const field of fields) assertOk(field in body, `${pathname} missing field ${field}`);
  }
});

check("unknown API path returns a structured JSON 404", async () => {
  const response = await request("/api/v1/unknown-review-probe");
  assertEqual(response.status, 404, "status");
  assertEqual(shortType(response), "application/json", "content-type");
  const body = await response.json();
  assertEqual(body.error.code, "not_found", "error code");
  assertOk(body.error.message && body.error.hint, "error message and hint");
});

check("POST to an API endpoint returns JSON 405 with Allow", async () => {
  const response = await request("/api/v1/meta", { method: "POST" });
  assertEqual(response.status, 405, "status");
  assertEqual(shortType(response), "application/json", "content-type");
  const allow = (response.headers.get("allow") || "").toUpperCase();
  assertOk(allow.includes("GET") && allow.includes("HEAD"), `Allow must include GET and HEAD, got ${allow}`);
  const body = await response.json();
  assertEqual(body.error.code, "method_not_allowed", "error code");
});

check("HEAD matches GET status and headers with an empty body", async () => {
  for (const { pathname, accept } of [
    { pathname: "/", accept: undefined },
    { pathname: "/", accept: "text/markdown" },
    { pathname: "/api/v1/meta", accept: undefined },
    { pathname: "/review-probe-no-such-page-118/", accept: "text/markdown" },
  ]) {
    const head = await request(pathname, { method: "HEAD", accept });
    const get = await request(pathname, { accept });
    assertEqual(head.status, get.status, `HEAD status for ${pathname} (${accept})`);
    assertEqual(shortType(head), shortType(get), `HEAD content-type for ${pathname} (${accept})`);
    assertEqual((await head.arrayBuffer()).byteLength, 0, `HEAD body for ${pathname} (${accept})`);
    await get.arrayBuffer();
  }
});

check("conditional requests revalidate per representation without false sharing", async () => {
  const htmlEtag = await etagFor("/", "text/html,application/xhtml+xml,*/*;q=0.8");
  const markdownEtag = await etagFor("/", "text/markdown");
  assertOk(htmlEtag && markdownEtag, "both representations must publish validators");

  const markdownRevalidate = await request("/", { accept: "text/markdown", headers: { "if-none-match": markdownEtag } });
  assertEqual(markdownRevalidate.status, 304, "markdown revalidation");
  assertEqual((await markdownRevalidate.arrayBuffer()).byteLength, 0, "304 body");

  const htmlRevalidate = await request("/", { accept: "text/html", headers: { "if-none-match": htmlEtag } });
  assertEqual(htmlRevalidate.status, 304, "html revalidation");
  await htmlRevalidate.arrayBuffer();

  const crossVariant = await request("/", { accept: "text/markdown", headers: { "if-none-match": htmlEtag } });
  assertEqual(crossVariant.status, 200, "an HTML ETag must never satisfy a markdown request");
  assertEqual(shortType(crossVariant), "text/markdown", "cross-variant content-type");
  await crossVariant.arrayBuffer();
});

check("a matched validator cannot override the 406 profile (F1)", async () => {
  const docsEtag = await etagFor("/docs/", "text/html,application/xhtml+xml,*/*;q=0.8");
  assertOk(docsEtag, "the docs page must publish a validator");

  const refused = await request("/docs/", { accept: "application/json", headers: { "if-none-match": docsEtag } });
  assertEqual(refused.status, 406, "the 406 decision must win over a matched HTML ETag");
  assertVary(refused, "406 with validator");
  await refused.arrayBuffer();

  const refusedHead = await request("/docs/", { method: "HEAD", accept: "application/json", headers: { "if-none-match": docsEtag } });
  assertEqual(refusedHead.status, 406, "HEAD 406");
  assertEqual((await refusedHead.arrayBuffer()).byteLength, 0, "HEAD 406 body");

  const starExclusion = await request("/docs/", { accept: "text/html;q=0,text/markdown;q=0", headers: { "if-none-match": "*" } });
  assertEqual(starExclusion.status, 406, "If-None-Match: * must not bypass the exclusion");
  await starExclusion.arrayBuffer();
});

check("protocol-relative paths never redirect off-origin", async () => {
  // "//evil.com" is a valid request path but a protocol-relative URL in a
  // Location header. Safe outcomes: a plain same-origin miss, or a redirect
  // whose Location is a same-origin relative path (the platform's
  // duplicate-slash collapse lands on /evil.com — a legitimate path that
  // merely contains that segment). Any absolute or protocol-relative
  // Location fails.
  for (const pathname of ["//evil.com", "//evil.com/docs"]) {
    const response = await request(pathname, { accept: "text/markdown", ...noRedirect });
    const location = response.headers.get("location") || "";
    const safe =
      response.status === 404 ||
      ([301, 302, 307, 308].includes(response.status) &&
        location.startsWith("/") &&
        !location.startsWith("//"));
    assertOk(safe, `${pathname}: status ${response.status}, location ${location}`);
    await response.arrayBuffer();
  }
});

check("error and redirect responses keep the security policy", async () => {
  const missing = await request("/review-probe-no-such-page-118/");
  assertSecurity(missing, "html 404");
  await missing.arrayBuffer();
  const methodNotAllowed = await request("/api/v1/meta", { method: "POST" });
  assertSecurity(methodNotAllowed, "405");
  await methodNotAllowed.arrayBuffer();
  const notAcceptable = await request("/", { accept: "application/json" });
  assertSecurity(notAcceptable, "406");
  await notAcceptable.arrayBuffer();
  const redirect = await request("/sitemap.xml", noRedirect);
  assertSecurity(redirect, "sitemap redirect");
});

check("/sitemap.xml aliases the generated sitemap without a chain", async () => {
  const redirect = await request("/sitemap.xml", noRedirect);
  assertEqual(redirect.status, 301, "alias status");
  const location = redirect.headers.get("location") || "";
  assertOk(!location.startsWith("/sitemap.xml"), "alias must not loop");
  const target = await request(location);
  assertEqual(target.status, 200, "sitemap target");
  assertOk(shortType(target).includes("xml"), `sitemap type ${shortType(target)}`);
  await target.arrayBuffer();
});

check("real assets of every class serve with preserved headers", async () => {
  const candidates = [
    ["/scripts/pricing-cost.js", "javascript"],
    ["/fonts/IBMPlexSans-Regular.woff2", "font"],
    ["/robots.txt", "text/plain"],
    ["/llms.txt", "text/plain"],
    [firstAsset("_astro", [".css", ".js"]), null],
    [firstAsset("", [".png", ".svg", ".webp", ".ico"]), null],
  ].filter(([pathname]) => pathname);
  assertOk(candidates.length >= 5, "dist must provide the asset classes to verify");
  for (const [pathname, expectedType] of candidates) {
    const response = await request(pathname);
    assertEqual(response.status, 200, `status for ${pathname}`);
    const type = shortType(response);
    assertOk(type !== "text/html", `${pathname} must not be served the HTML shell`);
    if (expectedType) assertOk(type.includes(expectedType), `${pathname} type ${type} should include ${expectedType}`);
    assertOk((response.headers.get("x-content-type-options") || "") === "nosniff", `${pathname} nosniff`);
    assertOk(response.headers.get("cache-control"), `${pathname} cache-control missing`);
    await response.arrayBuffer();
  }
});

check("llms.txt resource map resolves over HTTP with the right types", async () => {
  const llms = await request("/llms.txt");
  assertEqual(llms.status, 200, "llms.txt status");
  const body = await llms.text();
  const localLinks = [...body.matchAll(/https:\/\/triss\.work(\/[^\s)\]]*)/g)].map((match) => match[1]);
  assertOk(localLinks.length >= 10, "llms.txt must map the site's resources");
  for (const link of new Set(localLinks)) {
    const response = await request(link);
    assertEqual(response.status, 200, `llms.txt link ${link}`);
    const type = shortType(response);
    if (link.startsWith("/api/") || link.endsWith(".json")) {
      assertEqual(type, "application/json", `${link} must be JSON`);
    } else if (link.endsWith(".txt")) {
      assertOk(type.startsWith("text/"), `${link} must be text`);
    } else if (link.endsWith(".xml")) {
      assertOk(type.includes("xml"), `${link} must be XML`);
    }
    await response.arrayBuffer();
  }
});

// --- report ---------------------------------------------------------------------

const settled = await Promise.all(results);
let failures = 0;
for (const result of settled) {
  if (result.ok) {
    console.log(`ok - ${result.name}`);
  } else {
    failures += 1;
    console.log(`not ok - ${result.name}\n    ${result.error?.message || result.error}`);
  }
}
console.log(`# ${settled.length - failures}/${settled.length} HTTP acceptance checks passed against ${base}`);
process.exit(failures === 0 ? 0 : 1);

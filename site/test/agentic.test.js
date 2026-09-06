// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Agent-readiness contract: the site must stay consumable by automated
// agents (llms.txt, JSON-LD, trust pages, markdown negotiation, OpenAPI).
// Runtime behaviour lives in src/worker/router.js (pure) and is unit-tested
// here without Cloudflare; build output is validated below when dist exists.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { route, prefersMarkdown, markdownCandidates } from "../src/worker/router.js";
import workerDefault from "../src/worker/index.js";
import { COMMANDS } from "../src/data/commands.js";

const dist = path.join(process.cwd(), "dist");
const hasDist = fs.existsSync(dist);
const readDist = (...parts) => fs.readFileSync(path.join(dist, ...parts), "utf8");

// --- worker runtime (pure, no dist needed) ---------------------------------

test("agents asking for markdown are served the markdown variant with Vary", async () => {
  const html = (req) => {
    assert.equal(new URL(req.url).pathname, "/");
    return new Response("<html><main>hi</main></html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
  const md = (req) => {
    assert.equal(new URL(req.url).pathname, "/index.md");
    return new Response("# Home", { status: 200, headers: { "content-type": "text/markdown" } });
  };
  const request = new Request("https://triss.work/", { headers: { accept: "text/markdown" } });
  const response = await route(request, { ASSETS: { fetch: (req) => (new URL(req.url).pathname.endsWith(".md") ? md(req) : html(req)) } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/markdown/);
  const varyTokens = (response.headers.get("vary") || "").toLowerCase().split(",").map((t) => t.trim());
  assert.ok(varyTokens.includes("accept"), "markdown variant must declare Vary: Accept");
});

test("browser requests keep the HTML variant untouched", async () => {
  const request = new Request("https://triss.work/", {
    headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
  });
  const response = await route(request, {
    ASSETS: {
      fetch: (req) => {
        assert.equal(new URL(req.url).pathname, "/", "no markdown fetch for browser accept");
        return new Response("<html></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      },
    },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const varyTokens = (response.headers.get("vary") || "").toLowerCase().split(",").map((t) => t.trim());
  assert.ok(varyTokens.includes("accept"), "HTML variant must also declare Vary: Accept");
});

test("404 for markdown agents carries recovery links and keeps the 404 status", async () => {
  const request = new Request("https://triss.work/missing-page/", { headers: { accept: "text/markdown" } });
  const response = await route(request, {
    ASSETS: { fetch: () => new Response("404 html", { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }) },
  });
  assert.equal(response.status, 404, "must stay a real 404");
  assert.match(response.headers.get("content-type"), /text\/markdown/);
  const body = await response.text();
  for (const link of ["/llms.txt", "/docs/", "/sitemap-index.xml", "/openapi.json"]) {
    assert.ok(body.includes(`https://triss.work${link}`), `404 markdown must link ${link}`);
  }
});

test("404 stays an HTML 404 for non-markdown agents", async () => {
  const request = new Request("https://triss.work/missing-page/");
  const response = await route(request, {
    ASSETS: { fetch: () => new Response("404 html", { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }) },
  });
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type"), /text\/html/);
});

test("pages without a markdown variant fall through to HTML", async () => {
  const request = new Request("https://triss.work/llms.txt", { headers: { accept: "text/markdown" } });
  const response = await route(request, {
    ASSETS: {
      fetch: (req) => {
        if (new URL(req.url).pathname.endsWith(".md")) return new Response("nope", { status: 404 });
        return new Response("plain text", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
      },
    },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/plain/);
});

test("/sitemap.xml redirects to the generated sitemap index", async () => {
  const response = await route(new Request("https://triss.work/sitemap.xml"), {
    ASSETS: { fetch: () => assert.fail("redirect must not hit assets") },
  });
  assert.equal(response.status, 301);
  assert.equal(response.headers.get("location"), "/sitemap-index.xml");
});

test("unknown /api paths return structured JSON errors, not HTML", async () => {
  const response = await route(new Request("https://triss.work/api/v1/unknown"), {
    ASSETS: { fetch: () => new Response("404 html", { status: 404, headers: { "content-type": "text/html; charset=utf-8" } }) },
  });
  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const body = await response.json();
  assert.equal(body.error.code, "not_found");
  assert.match(body.error.hint, /\/openapi\.json/);
});

test("wrong methods on /api paths return a JSON 405", async () => {
  const response = await route(new Request("https://triss.work/api/v1/meta", { method: "POST" }), {
    ASSETS: { fetch: () => assert.fail("method check must precede assets") },
  });
  assert.equal(response.status, 405);
  const body = await response.json();
  assert.equal(body.error.code, "method_not_allowed");
});

test("known /api endpoints resolve to their static JSON files with CORS", async () => {
  const response = await route(new Request("https://triss.work/api/v1/meta"), {
    ASSETS: {
      fetch: (req) => {
        assert.equal(new URL(req.url).pathname, "/api/v1/meta.json", "endpoint must map to its static .json file");
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await response.json(), { ok: true });
});

test("worker entry wires the router", () => {
  assert.equal(typeof workerDefault.fetch, "function");
});

test("accept negotiation follows q-values", () => {
  assert.equal(prefersMarkdown("text/markdown"), true);
  assert.equal(prefersMarkdown("text/markdown;q=0.5, text/html;q=0.9"), false);
  assert.equal(prefersMarkdown("text/html;q=0.2, text/markdown;q=0.5"), true);
  assert.equal(prefersMarkdown("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"), false);
  assert.equal(prefersMarkdown("*/*"), false);
  assert.equal(prefersMarkdown(undefined), false);
});

test("markdown candidates mirror the directory build layout", () => {
  assert.deepEqual(markdownCandidates("/"), ["/index.md"]);
  assert.deepEqual(markdownCandidates("/docs/"), ["/docs/index.md", "/docs.md"]);
  assert.deepEqual(markdownCandidates("/docs"), ["/docs/index.md", "/docs.md"]);
  assert.deepEqual(markdownCandidates("/cost/"), ["/cost/index.md", "/cost.md"]);
});

// --- build output (skipped without dist) ------------------------------------

test("llms.txt exists and follows the published format", { skip: !hasDist }, () => {
  const body = readDist("llms.txt");
  assert.match(body, /^# Triss Coworker\n/);
  assert.match(body, /^> /m, "llms.txt opens with a summary blockquote");
  assert.match(body, /## When to use/, "agents need explicit when-to-use guidance");
  assert.match(body, /triss-coworker/, "the npm package name must be discoverable");
  assert.match(body, /short name .*Triss|Triss.* short name/i, "the short form Triss must map to the brand");
  for (const link of ["https://triss.work/llms-full.txt", "https://triss.work/openapi.json", "https://triss.work/docs/"]) {
    assert.ok(body.includes(link), `llms.txt must link ${link}`);
  }
  // Every advertised triss.work URL must resolve in the built output.
  for (const match of body.matchAll(/https:\/\/triss\.work(\/[^\s)\]]*)/g)) {
    const p = match[1] === "/" ? "/index.html" : match[1].replace(/\/$/, "");
    const resolves = [p, `${p}/index.html`, `${p}.json`, `${p}.txt`, `${p}.xml`, `${p}.md`].some((candidate) =>
      fs.existsSync(path.join(dist, ...candidate.split("/").filter(Boolean))),
    );
    assert.ok(resolves, `llms.txt advertises a dead URL: ${match[1]}`);
  }
});

test("llms-full.txt mirrors the machine-readable docs selection", { skip: !hasDist }, () => {
  const body = readDist("llms-full.txt");
  assert.match(body, /^# Triss Coworker/);
  const docs = JSON.parse(readDist("api", "v1", "docs.json"));
  assert.ok(docs.pages.length >= 5, "docs selection must cover the usage-critical pages");
  for (const page of docs.pages) {
    assert.ok(body.includes(page.url), `llms-full.txt is missing ${page.url}`);
  }
});

test("homepage carries valid JSON-LD identity data", { skip: !hasDist }, () => {
  const html = readDist("index.html");
  const match = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(match, "index.html must embed a JSON-LD block");
  const data = JSON.parse(match[1]);
  const graph = Array.isArray(data["@graph"]) ? data["@graph"] : [data];
  const app = graph.find((node) => node["@type"] === "SoftwareApplication");
  const org = graph.find((node) => node["@type"] === "Organization");
  assert.ok(app, "SoftwareApplication node required");
  assert.equal(app.name, "Triss Coworker");
  assert.equal(app.alternateName, "Triss", "the short form must be declared as alternateName");
  assert.match(app.url, /^https:\/\/triss\.work/);
  assert.ok(app.offers, "SoftwareApplication needs offers (free product)");
  assert.ok(org, "Organization node required");
  assert.equal(org.name, "Triss Coworker");
  assert.ok(Array.isArray(org.sameAs) && org.sameAs.length > 0, "Organization needs sameAs links");
  assert.ok(Array.isArray(org.contactPoint) && org.contactPoint[0].contactType, "Organization needs contactPoint");
});

test("trust anchor pages exist with substantial content", { skip: !hasDist }, () => {
  for (const page of ["about", "contact", "privacy"]) {
    const html = readDist(page, "index.html");
    const text = html
      .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    assert.ok(text.length >= 500, `/${page}/ carries only ${text.length} characters of content`);
  }
});

test("every built page has a markdown mirror", { skip: !hasDist }, () => {
  const pages = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "index.html") pages.push(full);
    }
  };
  walk(dist);
  assert.ok(pages.length >= 10, `unexpectedly few pages: ${pages.length}`);
  for (const page of pages) {
    const mirror = page.replace(/index\.html$/, "index.md");
    assert.ok(fs.existsSync(mirror), `missing markdown mirror for ${path.relative(dist, page)}`);
    const body = fs.readFileSync(mirror, "utf8");
    assert.match(body, /^# /m, `mirror ${mirror} must start with a heading`);
    // Placeholders like <main model> inside fenced code blocks are CLI
    // documentation, not markup; check only the prose.
    const prose = body.replace(/```[\s\S]*?```/g, "");
    assert.doesNotMatch(
      prose,
      /<(?:div|section|main|header|footer|nav|p|ul|ol|li|h[1-6]|table|pre|img|a|br)\b/i,
      `mirror ${mirror} leaked raw HTML tags`,
    );
  }
});

test("openapi.json is a valid, self-describing contract", { skip: !hasDist }, () => {
  const spec = JSON.parse(readDist("openapi.json"));
  assert.match(spec.openapi, /^3\./);
  assert.ok(spec.info.title && spec.info.version, "spec needs title and version");
  const operationIds = new Set();
  for (const [routePath, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (["parameters", "servers", "summary", "description"].includes(method)) continue;
      assert.ok(operation.operationId, `${method} ${routePath} needs an operationId`);
      assert.equal(operationIds.has(operation.operationId), false, `duplicate operationId ${operation.operationId}`);
      operationIds.add(operation.operationId);
      assert.ok(operation.description, `${method} ${routePath} needs a description`);
      assert.ok(operation.responses?.["200"], `${method} ${routePath} needs a 200 response`);
      assert.ok(operation.responses["200"].content?.["application/json"]?.schema, `200 of ${routePath} needs a JSON schema`);
    }
    if (routePath.startsWith("/api/v1/")) {
      const file = routePath.replace(/^\//, "");
      assert.ok(fs.existsSync(path.join(dist, ...file.split("/")) + ".json"), `spec promises ${routePath} but dist lacks the file`);
    }
  }
  assert.ok(spec.paths["/api/v1/meta"], "meta endpoint must be specified");
  assert.ok(spec.paths["/api/v1/commands"], "commands endpoint must be specified");
  assert.ok(spec.paths["/api/v1/docs"], "docs endpoint must be specified");
  assert.ok(spec.components?.schemas?.Error, "error schema must be published");
});

test("api endpoints serve build-derived truth", { skip: !hasDist }, () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "..", "package.json"), "utf8"));
  const meta = JSON.parse(readDist("api", "v1", "meta.json"));
  assert.equal(meta.name, "triss-coworker");
  assert.equal(meta.displayName, "Triss Coworker");
  assert.equal(meta.version, pkg.version);
  assert.equal(meta.cli.bin, "triss");
  assert.equal(meta.cli.npm, "triss-coworker");

  const commands = JSON.parse(readDist("api", "v1", "commands.json"));
  assert.equal(commands.count, COMMANDS.length);
  assert.deepEqual(
    commands.commands.map((command) => command.name),
    COMMANDS.map((command) => command.name),
  );
  for (const command of commands.commands) {
    assert.ok(command.summary, `command ${command.name} needs a summary`);
    assert.ok(command.example, `command ${command.name} needs an example`);
  }

  const docs = JSON.parse(readDist("api", "v1", "docs.json"));
  for (const page of docs.pages) {
    const mirrorPath = page.markdownUrl.replace(/^\//, "");
    assert.ok(fs.existsSync(path.join(dist, ...mirrorPath.split("/"))), `docs.json references missing mirror ${page.markdownUrl}`);
  }
});

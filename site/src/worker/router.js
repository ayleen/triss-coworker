// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Request routing for triss.work: markdown content negotiation for agents,
// markdown 404s with recovery links, JSON error responses on /api, and the
// /sitemap.xml alias. Pure module: standard Request/Response only, no
// Cloudflare-specific imports, so node --test can exercise it directly.

const MARKDOWN_TYPE = "text/markdown; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";

// A request prefers markdown only when text/markdown outranks text/html in
// its Accept q-values; everything else (browsers, */*, absent header) gets
// the HTML variant.
export function prefersMarkdown(acceptHeader) {
  if (!acceptHeader) return false;
  let markdownQ = null;
  let htmlQ = null;
  for (const part of acceptHeader.split(",")) {
    const [type, ...params] = part.trim().split(";");
    const normalized = type.trim().toLowerCase();
    if (normalized !== "text/markdown" && normalized !== "text/html") continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.split("=");
      if (key?.trim() === "q") q = Number.parseFloat(value) || 0;
    }
    if (normalized === "text/markdown") markdownQ = q;
    else htmlQ = q;
  }
  if (markdownQ === null || markdownQ <= 0) return false;
  return markdownQ > (htmlQ ?? 0);
}

// Built pages use the directory format (docs/index.html), so markdown
// mirrors live next to them (docs/index.md). Root is the one page whose
// mirror has no directory of its own.
export function markdownCandidates(pathname) {
  const clean = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (clean === "") return ["/index.md"];
  return [`${clean}/index.md`, `${clean}.md`];
}

export function notFoundMarkdownBody() {
  return [
    "# 404 — Not found",
    "",
    "The requested Triss page does not exist. Where to look next:",
    "",
    "- [Home](https://triss.work/) — project overview and install command",
    "- [Documentation](https://triss.work/docs/) — configuration and workflows",
    "- [llms.txt](https://triss.work/llms.txt) — agent guidance and resource map",
    "- [llms-full.txt](https://triss.work/llms-full.txt) — docs as one Markdown file",
    "- [Sitemap](https://triss.work/sitemap-index.xml) — every public page",
    "- [OpenAPI spec](https://triss.work/openapi.json) — the public JSON API surface",
    "",
    "Triss Coworker is a local CLI and MCP server (`npm install -g triss-coworker`) that",
    "delegates research, reviews, and implementation from coding agents to your",
    "chosen models and engines.",
    "",
  ].join("\n");
}

export function apiErrorBody(code, message, hint) {
  return { error: { code, message, hint } };
}

function varyOnAccept(response) {
  const headers = new Headers(response.headers);
  const existing = (headers.get("vary") || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const merged = new Set([...existing, "Accept", "Accept-Encoding"]);
  headers.set("vary", [...merged].join(", "));
  return headers;
}

function markdownResponse(source) {
  const headers = varyOnAccept(source);
  headers.set("content-type", MARKDOWN_TYPE);
  return new Response(source.body, { status: source.status, headers });
}

function passThrough(response) {
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) return response;
  return new Response(response.body, { status: response.status, headers: varyOnAccept(response) });
}

function jsonResponse(status, code, message, hint) {
  return new Response(JSON.stringify(apiErrorBody(code, message, hint)), {
    status,
    headers: {
      "content-type": JSON_TYPE,
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=0, must-revalidate",
    },
  });
}

async function apiRoute(request, env, url) {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return jsonResponse(405, "method_not_allowed", "Only GET and HEAD are supported on API endpoints.", "GET /openapi.json for the supported operations.");
  }
  // Endpoints are published as static files: /api/v1/meta is served from
  // dist/api/v1/meta.json. Unknown endpoints miss and become JSON errors.
  const assetPath = url.pathname.endsWith(".json") ? url.pathname : `${url.pathname}.json`;
  const assets = await env.ASSETS.fetch(new Request(new URL(assetPath, url.origin), { method: "GET" }));
  if (assets.status === 404) {
    return jsonResponse(404, "not_found", "Unknown API endpoint.", "Fetch /openapi.json for the list of supported endpoints.");
  }
  const headers = new Headers(assets.headers);
  headers.set("access-control-allow-origin", "*");
  return new Response(assets.body, { status: assets.status, headers });
}

export async function route(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;

  // The generated sitemap is published as sitemap-index.xml; keep the
  // conventional /sitemap.xml path working for crawlers.
  if (pathname === "/sitemap.xml") {
    return new Response(null, { status: 301, headers: { location: "/sitemap-index.xml" } });
  }

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return apiRoute(request, env, url);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return env.ASSETS.fetch(request);
  }

  const wantsMarkdown = prefersMarkdown(request.headers.get("accept"));
  const assets = await env.ASSETS.fetch(request);

  if (assets.status === 404) {
    if (wantsMarkdown) {
      return new Response(notFoundMarkdownBody(), {
        status: 404,
        headers: { "content-type": MARKDOWN_TYPE, vary: "Accept, Accept-Encoding" },
      });
    }
    return passThrough(assets);
  }

  if (wantsMarkdown) {
    for (const candidate of markdownCandidates(pathname)) {
      const mirror = await env.ASSETS.fetch(new Request(new URL(candidate, url.origin), { method: "GET" }));
      if (mirror.status === 200) return markdownResponse(mirror);
    }
  }

  return passThrough(assets);
}

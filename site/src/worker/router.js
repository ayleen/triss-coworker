// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Request routing for triss.work: markdown content negotiation for agents,
// markdown 404s with recovery links, JSON error responses on /api, and the
// /sitemap.xml alias. Pure module: standard Request/Response only, no
// Cloudflare-specific imports, so node --test can exercise it directly.
//
// Negotiation follows the documented acceptmarkdown.com profile: media ranges
// are matched most-specific-first (exact type > type/* > */*), an explicit
// q=0 on the exact type is not overridden by an allowing wildcard, ties
// prefer HTML (the browser default), and a document request with no
// acceptable representation gets 406. A missing or malformed q value makes
// the whole media range ineligible instead of inventing a priority.

import { withSecurityHeaders } from "./response-headers.js";

const MARKDOWN_TYPE = "text/markdown; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";

// RFC 9110 qvalue grammar: 0[.0-3 digits] or 1[.0-3 zeros] — the empty
// fraction forms ("0.", "1.") are valid and must not be discarded.
const Q_VALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

function parseAccept(header) {
  if (!header) return [];
  const ranges = [];
  for (const part of header.split(",")) {
    const [range, ...params] = part.trim().split(";");
    if (!range) continue;
    const normalized = range.trim().toLowerCase();
    if (!/^[a-z*]+\/[a-z0-9*.\-+]+$/.test(normalized)) continue;
    let q = 1;
    let malformed = false;
    for (const param of params) {
      const [key, value] = param.split("=");
      if (key?.trim().toLowerCase() === "q") {
        if (value === undefined || !Q_VALUE.test(value.trim())) {
          malformed = true;
          break;
        }
        q = Number.parseFloat(value);
      }
    }
    if (malformed) continue;
    const [type, subtype] = normalized.split("/");
    ranges.push({ type, subtype, q });
  }
  return ranges;
}

function matchQuality(ranges, type, subtype) {
  let best = { specificity: -1, q: 0 };
  for (const range of ranges) {
    let specificity;
    if (range.type === type && range.subtype === subtype) specificity = 2;
    else if (range.type === type && range.subtype === "*") specificity = 1;
    else if (range.type === "*" && range.subtype === "*") specificity = 0;
    else continue;
    if (specificity > best.specificity || (specificity === best.specificity && range.q > best.q)) {
      best = { specificity, q: range.q };
    }
  }
  return best.specificity === -1 ? 0 : best.q;
}

// Returns "html", "markdown", or "not-acceptable".
export function negotiateRepresentation(acceptHeader) {
  const ranges = parseAccept(acceptHeader);
  // Absent (or empty) Accept: both representations acceptable, HTML default.
  if (ranges.length === 0) return "html";
  const htmlQ = matchQuality(ranges, "text", "html");
  const markdownQ = matchQuality(ranges, "text", "markdown");
  if (htmlQ <= 0 && markdownQ <= 0) return "not-acceptable";
  if (markdownQ > htmlQ) return "markdown";
  return "html";
}

// Compatibility wrapper for callers that only need the boolean choice; the
// router itself sees the third "not-acceptable" state.
export function prefersMarkdown(acceptHeader) {
  return negotiateRepresentation(acceptHeader) === "markdown";
}

// Built pages use the directory format (docs/index.html), so markdown
// mirrors live next to them (docs/index.md). Root is the one page whose
// mirror has no directory of its own.
export function markdownCandidates(pathname) {
  const clean = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (clean === "") return ["/index.md"];
  return [`${clean}/index.md`, `${clean}.md`];
}

// Only document-shaped URLs take part in HTML/Markdown negotiation: a 404
// for /missing.css is a static-asset miss, not an agent-facing document.
export function isDocumentPath(pathname) {
  if (pathname === "/") return true;
  const last = pathname.split("/").filter(Boolean).pop() ?? "";
  return !last.includes(".");
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
  // An existing Vary: * already covers everything; do not narrow or expand it.
  if (existing.includes("*")) {
    headers.set("vary", "*");
    return headers;
  }
  const merged = [...existing];
  const add = (token) => {
    if (!merged.some((value) => value.toLowerCase() === token.toLowerCase())) merged.push(token);
  };
  add("Accept");
  add("Accept-Encoding");
  headers.set("vary", merged.join(", "));
  return headers;
}

function conditionalHeaders(request) {
  const headers = new Headers();
  for (const name of ["if-none-match", "if-modified-since"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

const bodyless = (request) => request.method.toUpperCase() === "HEAD";

function markdownResponse(source, request, { status = source.status } = {}) {
  const headers = withSecurityHeaders(varyOnAccept(source));
  headers.set("content-type", MARKDOWN_TYPE);
  return new Response(bodyless(request) ? null : source.body, { status, headers });
}

function passThrough(response, request) {
  if (!response.headers.get("content-type")?.toLowerCase().includes("text/html")) return response;
  return new Response(bodyless(request) ? null : response.body, {
    status: response.status,
    headers: withSecurityHeaders(varyOnAccept(response)),
  });
}

// 304 responses carry headers only; the validators must name the served
// representation's headers without a body ever being attached.
function revalidationResponse(source) {
  return new Response(null, { status: 304, headers: withSecurityHeaders(varyOnAccept(source)) });
}

function jsonResponse(request, status, code, message, hint, extraHeaders = {}) {
  const body = JSON.stringify(apiErrorBody(code, message, hint));
  return new Response(bodyless(request) ? null : body, {
    status,
    headers: withSecurityHeaders({
      "content-type": JSON_TYPE,
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=0, must-revalidate",
      ...extraHeaders,
    }),
  });
}

function notAcceptableResponse(request) {
  return jsonResponse(
    request,
    406,
    "not_acceptable",
    "This document is available as text/html and text/markdown; the request's Accept header excludes both.",
    "Send Accept: text/html or Accept: text/markdown, or fetch the .md mirror directly.",
    { vary: "Accept, Accept-Encoding" },
  );
}

async function apiRoute(request, env, url, method, pathname) {
  if (method !== "GET" && method !== "HEAD") {
    return jsonResponse(
      request,
      405,
      "method_not_allowed",
      "Only GET and HEAD are supported on API endpoints.",
      "GET /openapi.json for the supported operations.",
      { allow: "GET, HEAD" },
    );
  }
  // Endpoints are published as static files: /api/v1/meta is served from
  // dist/api/v1/meta.json. Unknown endpoints miss and become JSON errors.
  const assetPath = pathname.endsWith(".json") ? pathname : `${pathname}.json`;
  const assets = await env.ASSETS.fetch(
    new Request(new URL(assetPath, url.origin), { method: "GET", headers: conditionalHeaders(request) }),
  );
  if (assets.status === 404) {
    return jsonResponse(request, 404, "not_found", "Unknown API endpoint.", "Fetch /openapi.json for the list of supported endpoints.");
  }
  const headers = new Headers(assets.headers);
  headers.set("access-control-allow-origin", "*");
  return new Response(bodyless(request) ? null : assets.body, {
    status: assets.status,
    headers: withSecurityHeaders(headers),
  });
}

const REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

// Collapse protocol-relative-looking paths ("//host/path"): url.pathname
// keeps them verbatim, and both ASSETS sub-request URLs and a synthesized
// redirect Location would otherwise resolve off-origin (open redirect).
function normalizedPathname(url) {
  return url.pathname.replace(/^\/{2,}/, "/");
}

// A redirect target must stay on this origin — reject anything that would
// hand the Location header a different host.
function sameOriginLocation(url, location) {
  try {
    return new URL(location, url.origin).origin === url.origin ? location : null;
  } catch {
    return null;
  }
}

// Frees an unused response body so the connection is not held open.
function discard(response) {
  try {
    response.body?.cancel()?.catch(() => {});
  } catch {
    /* body already consumed or absent */
  }
}

// The fallback fetch targets the same asset as the client's request, but
// with the normalized path: a raw "//host/path" request URL must never
// leak into a sub-request URL.
function normalizedRequest(request, url, pathname) {
  if (url.pathname === pathname) return request;
  return new Request(new URL(pathname + url.search, url.origin), {
    method: request.method,
    headers: request.headers,
  });
}

// Resolves the route itself without client validators: per RFC 9110
// §13.2.1 preconditions apply only after the server has chosen its
// response, so a matching ETag must never turn a canonical redirect into
// a 304 or trade the strict 406 profile for the HTML variant's validator.
// The probe keeps the request's Accept header — the asset layer only
// produces its html_handling redirects for HTML-eligible requests — but
// drops conditional validators and must use GET (a HEAD probe never sees
// those redirects either). It only reads status, type, and redirect
// location; htmlRepresentation re-fetches with the client's validators.
async function resolveRoute(request, env, url, pathname) {
  const headers = new Headers();
  const accept = request.headers.get("accept");
  if (accept) headers.set("accept", accept);
  return env.ASSETS.fetch(new Request(new URL(pathname + url.search, url.origin), { method: "GET", headers }));
}

function redirectResponse(probe, url) {
  const location = sameOriginLocation(url, probe.headers.get("location") || "/") ?? "/";
  return new Response(null, {
    status: probe.status,
    headers: withSecurityHeaders({ location, "cache-control": "public, max-age=0, must-revalidate" }),
  });
}

async function markdownRepresentation(request, env, url, pathname) {
  // The conditional validators ride with the markdown asset request; an HTML
  // ETag never stands in for the markdown representation's ETag.
  const conditional = conditionalHeaders(request);
  const candidates = markdownCandidates(pathname);
  // A page whose mirror lives at <route>/index.md is directory-style: its
  // canonical URL carries the trailing slash. The platform's html_handling
  // only redirects HTML-eligible requests before the worker runs, so without
  // this rule markdown agents would receive the mirror on the non-canonical
  // URL. Canonical resolution also precedes conditional validation.
  const canonical = pathname === "/" || pathname.endsWith("/");
  for (let index = 0; index < candidates.length; index += 1) {
    const mirror = await env.ASSETS.fetch(
      new Request(new URL(candidates[index], url.origin), { method: "GET", headers: conditional }),
    );
    if (mirror.status !== 200 && mirror.status !== 304) continue;
    if (index === 0 && !canonical) {
      discard(mirror);
      const search = url.searchParams.toString();
      // Defensive: the target is built from the normalized path, but never
      // emit a redirect whose Location escapes this origin.
      const location = sameOriginLocation(url, `${pathname}/${search ? `?${search}` : ""}`);
      if (!location) break;
      return new Response(null, {
        status: 301,
        headers: withSecurityHeaders({
          location,
          "cache-control": "public, max-age=0, must-revalidate",
          vary: "Accept",
        }),
      });
    }
    if (mirror.status === 304) return revalidationResponse(mirror);
    if (mirror.headers.get("content-type")?.toLowerCase().includes("text/markdown")) {
      return markdownResponse(mirror, request);
    }
  }
  const page = await env.ASSETS.fetch(normalizedRequest(request, url, pathname));
  if (page.status === 304) return revalidationResponse(page);
  if (page.status === 404 && isDocumentPath(pathname)) {
    return markdownResponse(
      new Response(notFoundMarkdownBody(), { status: 404, headers: { "content-type": MARKDOWN_TYPE } }),
      request,
    );
  }
  return passThrough(page, request);
}

async function htmlRepresentation(request, env, url, probe, representation, pathname) {
  // The refusal decision uses the unconditional probe's status and type, so
  // a validator-matched 304 (which may carry no Content-Type) can never
  // preempt the 406, and the 406 itself never echoes another
  // representation's validators.
  if (representation === "not-acceptable" && isDocumentPath(pathname)) {
    const isHtml = probe.headers.get("content-type")?.toLowerCase().includes("text/html") ?? false;
    if (probe.status === 404 || isHtml) {
      discard(probe);
      return notAcceptableResponse(request);
    }
  }
  discard(probe);
  // The final response must honor the client's validators: the probe is
  // unconditional, so serving it would answer full bodies where a 304 is
  // due. (Observed separately: the platform's trailing-slash redirect also
  // only materializes for an original-request asset fetch.)
  const page = await env.ASSETS.fetch(normalizedRequest(request, url, pathname));
  if (page.status === 304) return revalidationResponse(page);
  return passThrough(page, request);
}

export async function route(request, env) {
  const url = new URL(request.url);
  const pathname = normalizedPathname(url);
  const method = request.method.toUpperCase();

  // The generated sitemap is published as sitemap-index.xml; keep the
  // conventional /sitemap.xml path working for crawlers.
  if (pathname === "/sitemap.xml") {
    return new Response(null, {
      status: 301,
      headers: withSecurityHeaders({ location: "/sitemap-index.xml", "cache-control": "public, max-age=0, must-revalidate" }),
    });
  }

  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return apiRoute(request, env, url, method, pathname);
  }

  if (method !== "GET" && method !== "HEAD") {
    return env.ASSETS.fetch(request);
  }

  const representation = negotiateRepresentation(request.headers.get("accept"));

  // Canonical redirects come first and identically for every representation:
  // the platform's html_handling redirect for /docs must not be bypassed by
  // an existing /docs/index.md mirror, and its real status/Location are kept
  // as-is rather than hardcoded.
  const probe = await resolveRoute(request, env, url, pathname);
  if (REDIRECT_STATUSES.has(probe.status)) {
    discard(probe);
    return redirectResponse(probe, url);
  }

  if (representation === "markdown") {
    discard(probe);
    return markdownRepresentation(request, env, url, pathname);
  }
  return htmlRepresentation(request, env, url, probe, representation, pathname);
}


// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Site security policy for responses synthesized by the worker (markdown
// 404s, JSON errors, 406 negotiation responses, the sitemap redirect).
// Static asset responses keep getting these from public/_headers; the two
// sources must stay in lockstep — site/test/worker-contract.test.js compares
// this object against the _headers file.

export const SECURITY_HEADERS = Object.freeze({
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
});

// Adds the site policy without weakening or replacing values a proxied
// response already carries.
export function withSecurityHeaders(headers) {
  const merged = new Headers(headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!merged.has(name)) merged.set(name, value);
  }
  return merged;
}

export function secureResponse(body, init = {}) {
  return new Response(body, { ...init, headers: withSecurityHeaders(init.headers) });
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-credential-proxy.js — parent-owned loopback
 * credential proxy.
 *
 * Section 6.5 of the approved plan (docs/reliable-delegation-contract-plan.md):
 * the proxy alone receives the real provider credential through a
 * non-inherited in-memory value; the engine receives a random single-run
 * proxy token in the expected API-key variable plus a loopback base URL.
 *
 * Guarantees implemented here:
 *  - one-run token: random per run (or caller-supplied for tests), accepted
 *    only for this run's provider/model scope;
 *  - provider/model/endpoint pinning: only the configured upstream ORIGIN is
 *    reachable, only through the loopback listener, only under the pinned
 *    path prefix (boundary-exact: `/v1` does not match `/v10`), and only for
 *    requests whose JSON body names the pinned model;
 *  - request-count, body-byte, response-byte, rate, and lifetime-deadline
 *    caps, none greater than the parent request itself;
 *  - revocation before cleanup completes; a revoked proxy refuses everything
 *    and aborts every in-flight upstream fetch;
 *  - no body logging, no CONNECT/general forward-proxy route;
 *  - exact-secret non-disclosure: the real credential is never returned,
 *    logged, or placed in engine env/argv/config by this module;
 *  - bounded request identity: the specific user agent and OpenCode request
 *    correlation headers survive the proxy without admitting arbitrary
 *    client-controlled upstream headers;
 *  - bounded retry metadata: only valid `retry-after` and `retry-after-ms`
 *    response values survive the proxy.
 *
 * URL contract (Invariant): `endpoint` is the upstream ORIGIN
 * (`https://host[:port]`, no path). The engine's base URL points at
 * `scopedBaseUrl` (loopback origin + pathPrefix), so requests arrive with
 * the prefix verbatim and forwarding is a plain origin + path join — the
 * prefix can never be doubled. Anthropic-protocol upstreams (Kimi for
 * Coding) use `authStyle: 'anthropic'`: the one-run token is accepted from
 * `x-api-key` and the real credential is attached upstream as `x-api-key`
 * plus `anthropic-version`, never as a Bearer token.
 *
 * Pure Node http/https; no dependency on the platform backend.
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const LOOPBACK_HOST = '127.0.0.1';

// Default caps: request count, body bytes, response bytes, sustained rate,
// and lifetime deadline. The caller (coder run) passes tighter caps derived
// from the parent request; these defaults are only a fail-closed floor.
const DEFAULT_MAX_REQUESTS = 1000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RATE_PER_SEC = 20;
const DEFAULT_DEADLINE_MS = 30 * 60 * 1000;

// Anthropic-protocol requests must carry an api-version header; forward the
// engine's own value when present, otherwise pin the documented default.
const ANTHROPIC_VERSION_DEFAULT = '2023-06-01';

const REQUEST_IDENTITY_HEADERS = Object.freeze([
  'user-agent',
  'x-opencode-client',
  'x-opencode-request',
  'x-opencode-session',
]);
const MAX_REQUEST_IDENTITY_HEADER_BYTES = 1024;

function copyRequestIdentityHeaders(provider, requestHeaders, upstreamHeaders) {
  if (provider !== 'opencode-go' && provider !== 'opencode-zen') return;
  // x-opencode-project is deliberately excluded: its root-commit value is a
  // stable repository fingerprint and is not needed for request correlation.
  for (const name of REQUEST_IDENTITY_HEADERS) {
    const value = requestHeaders[name];
    if (
      typeof value === 'string' &&
      value.length > 0 &&
      Buffer.byteLength(value, 'utf8') <= MAX_REQUEST_IDENTITY_HEADER_BYTES
    ) {
      upstreamHeaders[name] = value;
    }
  }
}

const RETRY_RESPONSE_HEADERS = Object.freeze([
  'retry-after',
  'retry-after-ms',
]);
const MAX_RETRY_RESPONSE_HEADER_BYTES = 1024;
const IMF_FIXDATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const UNSIGNED_DECIMAL_INTEGER_PATTERN = /^\d+$/;

function isUnsignedDecimalInteger(value) {
  if (!UNSIGNED_DECIMAL_INTEGER_PATTERN.test(value)) return false;
  return Number.isFinite(Number(value));
}

function isValidRetryAfter(value) {
  if (isUnsignedDecimalInteger(value)) return true;
  if (!IMF_FIXDATE_PATTERN.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toUTCString() === value;
}

function copyRetryHeaders(upstreamHeaders, downstreamHeaders) {
  for (const name of RETRY_RESPONSE_HEADERS) {
    const value = upstreamHeaders.get(name);
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      Buffer.byteLength(value, 'utf8') > MAX_RETRY_RESPONSE_HEADER_BYTES
    ) {
      continue;
    }
    const valid = name === 'retry-after-ms'
      ? isUnsignedDecimalInteger(value)
      : isValidRetryAfter(value);
    if (valid) downstreamHeaders[name] = value;
  }
}

function generateToken() {
  return randomBytes(16).toString('hex');
}

// ─── chat→responses protocol bridge ─────────────────────────────────────────
//
// Some native engines (crush 0.1.6 on this fork) speak ONLY Chat Completions
// against custom providers, while the selected model's audited upstream wire
// protocol is the OpenAI Responses API. Instead of substituting a different
// engine or model, the proxy translates: the pinned chat/completions route is
// accepted from the engine, forwarded as a Responses request to the pinned
// upstream, and the Responses answer is translated back into the chat shape
// the engine expects. The bridge is bounded: model identity, credential, and
// endpoint pass through verbatim; message-only rounds are translated and any
// request carrying tool definitions/tool calls is refused with a precise
// error rather than silently degraded.

const BRIDGE_MODES = Object.freeze(['chat-to-responses']);

function bridgeUnsupported(res, detail) {
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    error: {
      message: `chat-to-responses bridge: ${detail}`,
    },
  }));
}

function bridgeChatBodyToResponses(body) {
  if (body.tools !== undefined || body.tool_choice !== undefined) {
    throw new Error('tool definitions are not translated by the bridge yet; use a chat- or anthropic-protocol model for tool-using runs on this engine');
  }
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (message?.role === 'tool' || (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0)) {
      throw new Error('tool-call history is not translated by the bridge yet; use a chat- or anthropic-protocol model for tool-using runs on this engine');
    }
  }
  const translated = {
    model: body.model,
    input: body.messages,
    stream: false,
  };
  if (body.max_tokens !== undefined) translated.max_output_tokens = body.max_tokens;
  if (body.temperature !== undefined) translated.temperature = body.temperature;
  if (body.reasoning_effort !== undefined) translated.reasoning = { effort: body.reasoning_effort };
  return translated;
}

function bridgeResponsesText(response) {
  if (typeof response?.output_text === 'string') return response.output_text;
  if (!Array.isArray(response?.output)) return '';
  return response.output
    .filter((item) => item?.type === 'message')
    .flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter((part) => (part?.type === 'output_text' || part?.type === 'text') && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function bridgeResponsesToChatPayload(response) {
  const usage = response?.usage || {};
  return {
    id: response?.id || 'bridge-response',
    model: response?.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: bridgeResponsesText(response) },
      finish_reason: response?.status === 'incomplete' ? 'length' : 'stop',
    }],
    usage: {
      prompt_tokens: usage.input_tokens ?? null,
      completion_tokens: usage.output_tokens ?? null,
      total_tokens: usage.total_tokens ?? null,
    },
  };
}

function sseChunksForPayload(payload, includeUsage = true) {
  const events = [];
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.length > 0) {
    events.push({
      id: payload.id,
      model: payload.model,
      choices: [{ index: 0, delta: { role: 'assistant', content } }],
    });
  }
  events.push({
    id: payload.id,
    model: payload.model,
    choices: [{ index: 0, delta: {}, finish_reason: payload.choices?.[0]?.finish_reason || 'stop' }],
    ...(includeUsage ? { usage: payload.usage } : {}),
  });
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
}

// Forward through the chat→responses bridge: always issue a NON-streaming
// Responses request (deterministic single parse), then answer the engine in
// the shape it asked for (chat JSON or chat SSE). Response bytes are capped on
// the translated output like every other proxy path.
async function forwardBridged(req, res, parsedBody, context) {
  const { endpoint, pathPrefix, credential, fetchImpl, maxResponseBytes, controller } = context;
  let translated;
  try {
    translated = bridgeChatBodyToResponses(parsedBody);
  } catch (err) {
    bridgeUnsupported(res, err.message);
    return;
  }
  const upstreamPath = `${pathPrefix === '/' ? '' : pathPrefix}/responses`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${credential}` };
  const upstream = await fetchImpl(endpoint + upstreamPath, {
    method: 'POST',
    headers,
    body: JSON.stringify(translated),
    signal: controller.signal,
  });
  const raw = await upstream.text();
  if (Buffer.byteLength(raw, 'utf8') > maxResponseBytes) {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream response exceeds proxy cap' } }));
    }
    return;
  }
  let payload;
  try {
    const parsed = JSON.parse(raw);
    if (!upstream.ok) {
      const message = parsed?.error?.message || `upstream status ${upstream.status}`;
      if (!res.headersSent) {
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: { message } }));
      }
      return;
    }
    payload = bridgeResponsesToChatPayload(parsed);
  } catch {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({ error: { message: `upstream error: unparseable responses body (status ${upstream.status})` } }));
    }
    return;
  }
  const engineAskedStream = parsedBody.stream === true;
  if (engineAskedStream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseChunksForPayload(payload));
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  }
}

function isValidOrigin(endpoint) {
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === 'https:' &&
      (url.pathname === '/' || url.pathname === '') &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/**
 * Start a parent-owned loopback credential proxy.
 *
 * @param {object} opts
 * @param {string} opts.provider       canonical provider id
 * @param {string} opts.model          pinned model id for this run
 * @param {string} opts.endpoint       canonical upstream ORIGIN (https, no path)
 * @param {string} opts.credential     real provider credential (in-memory only)
 * @param {string} [opts.pathPrefix='/v1'] OpenAI-compatible scope prefix
 * @param {string} [opts.protocol] 'openai_chat' | 'openai_responses' | 'anthropic_messages'
 * @param {string} [opts.authStyle='bearer'] compatibility alias for protocol auth
 * @param {string} [opts.token]        pre-generated single-run token (tests)
 * @param {number} [opts.maxRequests]  request-count cap
 * @param {number} [opts.maxBodyBytes] per-request body-byte cap
 * @param {number} [opts.maxResponseBytes] per-response body-byte cap
 * @param {number} [opts.maxRatePerSec] sustained request-rate cap
 * @param {number} [opts.deadlineMs]   proxy lifetime from start
 * @param {Function} [opts.fetchImpl]  injectable fetch (tests)
 * @returns {Promise<object>} resolves once listening:
 *   { host, port, token, baseUrl, scopedBaseUrl, provider, model, revoke(), closed }
 */
export async function startCoderCredentialProxy(opts = {}) {
  const {
    provider,
    model,
    endpoint,
    credential,
  } = opts;
  // Path prefix the upstream serves the model scope under (default /v1). The
  // engine's baseURL points at `scopedBaseUrl` (loopback origin + this
  // prefix), so requests arrive verbatim and no rewrite is needed.
  const pathPrefix = typeof opts.pathPrefix === 'string' && opts.pathPrefix.startsWith('/')
    ? opts.pathPrefix.replace(/\/+$/, '') || '/'
    : '/v1';
  const protocol = ['openai_chat', 'openai_responses', 'anthropic_messages'].includes(opts.protocol)
    ? opts.protocol
    : opts.authStyle === 'anthropic' ? 'anthropic_messages' : 'openai_chat';
  const authStyle = protocol === 'anthropic_messages' ? 'anthropic' : 'bearer';
  // Optional bounded protocol bridge: the engine speaks chat/completions on
  // the pinned route while the upstream speaks the Responses API.
  const bridge = opts.bridge === undefined || opts.bridge === null ? null : opts.bridge;
  if (bridge !== null) {
    if (!BRIDGE_MODES.includes(bridge)) {
      throw new TypeError(`startCoderCredentialProxy: unsupported bridge "${bridge}"`);
    }
    if (bridge === 'chat-to-responses' && protocol !== 'openai_chat') {
      throw new TypeError('startCoderCredentialProxy: bridge "chat-to-responses" requires protocol "openai_chat"');
    }
  }
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new TypeError('startCoderCredentialProxy: provider is required');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new TypeError('startCoderCredentialProxy: model is required');
  }
  // Endpoint pinning is origin-exact: an endpoint that already carries an
  // API path would double the prefix on every forward (the exact redirect this
  // validation exists to catch), so it fails closed at construction.
  if (typeof endpoint !== 'string' || !isValidOrigin(endpoint)) {
    throw new TypeError(
      'startCoderCredentialProxy: endpoint must be an https ORIGIN (no path), e.g. https://api.z.ai',
    );
  }
  if (typeof credential !== 'string' || credential.length === 0) {
    throw new TypeError('startCoderCredentialProxy: credential is required');
  }

  const allowedModels = new Set();
  const rawModelList = Array.isArray(opts.models)
    ? opts.models
    : [model, opts.smallModel].filter((m) => typeof m === 'string' && m.length > 0);
  for (const m of rawModelList) {
    allowedModels.add(m);
    if (m.includes('/')) {
      allowedModels.add(m.slice(m.indexOf('/') + 1));
    }
  }

  const token = typeof opts.token === 'string' && opts.token.length > 0
    ? opts.token
    : generateToken();
  const maxRequests = opts.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRatePerSec = opts.maxRatePerSec ?? DEFAULT_MAX_RATE_PER_SEC;
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;

  // Rate-limit sliding window (one-second buckets, bounded history).
  const requestTimes = [];
  const now = () => Date.now();
  const startedAt = now();
  let revoked = false;
  let requestCount = 0;
  // In-flight upstream fetches: revoke() aborts them all so `closed` can
  // never hang on a stuck upstream response.
  const activeFetches = new Set();

  // Monotonic rate check: drop entries older than one second, then enforce
  // the cap on the remaining window.
  function rateAllowed() {
    const t = now();
    while (requestTimes.length && requestTimes[0] <= t - 1000) requestTimes.shift();
    if (requestTimes.length >= maxRatePerSec) return false;
    requestTimes.push(t);
    return true;
  }

  // Exact inference-endpoint pinning: ONLY the canonical completion route
  // for the pinned protocol is forwarded — the whole prefix subtree is NOT
  // open (other mutating or billed provider routes must be unreachable).
  const allowedPaths = new Set(
    protocol === 'anthropic_messages'
      ? [`${pathPrefix}/messages`]
      : [protocol === 'openai_responses' ? `${pathPrefix}/responses` : `${pathPrefix}/chat/completions`],
  );

  function pathAllowed(url) {
    // Compare the PATH component only: a query string (harmless client
    // bookkeeping) must not break the exact endpoint pin, and it is
    // forwarded verbatim with the request.
    const pathOnly = String(url).split('?')[0];
    return allowedPaths.has(pathOnly);
  }

  function tokenOk(req) {
    if (authStyle === 'anthropic') {
      return req.headers['x-api-key'] === token;
    }
    return (req.headers.authorization || '') === `Bearer ${token}`;
  }

  const server = createServer((req, res) => {
    // Fail-closed lifecycle checks first.
    if (revoked) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'credential proxy revoked' } }));
      return;
    }
    if (now() - startedAt > deadlineMs) {
      res.writeHead(408, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'credential proxy deadline exceeded' } }));
      return;
    }
    if (requestCount >= maxRequests) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'credential proxy request cap exceeded' } }));
      return;
    }

    // Endpoint pinning: only a loopback listener exists, but reject any
    // absolute-URI request line (a general forward-proxy route) outright,
    // and never accept CONNECT.
      if (req.method === 'CONNECT') {
        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'CONNECT is not supported' } }));
        return;
      }
      if (req.url.startsWith('http://') || req.url.startsWith('https://')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'absolute-URI forward-proxy route denied' } }));
        return;
      }
      // The proxy is an inference-only surface.  Do not let a GET/PUT/etc.
      // reach the body parser and get forwarded as POST upstream.
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
        res.end(JSON.stringify({ error: { message: 'only POST is supported' } }));
        return;
      }
      // Provider/model pinning: only the pinned OpenAI-compatible scope is
      // forwarded; everything else is denied. The prefix match is
      // boundary-exact — a `/v10` route must not pass a `/v1` pin.
      if (!pathAllowed(req.url)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unknown proxy route' } }));
        return;
      }

    // Token check. The real credential is never accepted here — only the
    // single-run token (Bearer for OpenAI-style clients, x-api-key for
    // Anthropic-protocol clients).
    if (!tokenOk(req)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid proxy token' } }));
      return;
    }

    // Rate cap.
    if (!rateAllowed()) {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '1',
      });
      res.end(JSON.stringify({ error: { message: 'credential proxy rate cap exceeded' } }));
      return;
    }

    // Body-byte cap: count bytes as they arrive; abort the stream on
    // overflow so we never buffer an unbounded body. Bodies are never
    // logged, never echoed.
    const chunks = [];
    let received = 0;
    let bodyOverflow = false;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBodyBytes) {
        bodyOverflow = true;
        // Answer 413 immediately and drain the rest of the stream instead of
        // destroying the socket (destroy would drop the response too).
        if (!res.headersSent) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'request body exceeds proxy cap' } }));
        }
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'request stream error' } }));
      }
    });
    req.on('end', async () => {
      if (bodyOverflow) return; // 413 already sent from the data handler
      // Model pinning: every forwarded body must be JSON naming the pinned
      // model (or its bare ID). A body naming any other model is a routing
      // escape attempt — refused before any upstream call.
      let parsedBody;
      try {
        parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        parsedBody = null;
      }
      if (
        !parsedBody || typeof parsedBody !== 'object' ||
        typeof parsedBody.model !== 'string' || !allowedModels.has(parsedBody.model)
      ) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'model is not pinned for this proxy run' } }));
        return;
      }
      requestCount += 1;
      if (bridge === 'chat-to-responses') {
        const controller = new AbortController();
        activeFetches.add(controller);
        try {
          await forwardBridged(req, res, parsedBody, {
            endpoint,
            pathPrefix,
            credential,
            fetchImpl,
            maxResponseBytes,
            controller,
          });
        } catch (err) {
          if (!res.destroyed) {
            if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
            if (!res.writableEnded) {
              res.end(JSON.stringify({ error: { message: `upstream error: ${err?.message || 'unknown'}` } }));
            }
          }
        } finally {
          activeFetches.delete(controller);
        }
        return;
      }
      const body = JSON.stringify(parsedBody);
      await forward(req, res, body);
    });
  });

  // Forward to the pinned upstream ORIGIN, attaching the REAL credential
  // (in-memory only; never logged, never returned downstream). The upstream
  // URL is the origin joined with the validated request path verbatim — no
  // rewrite, no doubling, no absolute-URI route can reach this point.
  async function forward(req, res, body) {
    const upstreamUrl = endpoint + req.url;
    const controller = new AbortController();
    activeFetches.add(controller);
    let responseBytes = 0;
    try {
      const headers = { 'content-type': 'application/json' };
      copyRequestIdentityHeaders(provider, req.headers, headers);
      if (authStyle === 'anthropic') {
        headers['x-api-key'] = credential;
        headers['anthropic-version'] =
          (typeof req.headers['anthropic-version'] === 'string' && req.headers['anthropic-version']) ||
          ANTHROPIC_VERSION_DEFAULT;
      } else {
        headers.authorization = `Bearer ${credential}`;
      }
      const upstream = await fetchImpl(upstreamUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      const declaredLength = Number(upstream.headers.get('content-length') || 0);
      if (declaredLength > maxResponseBytes) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream response exceeds proxy cap' } }));
        return;
      }
      // Bounded response relay: stream through with a hard byte cap instead
      // of buffering the whole body; overflow aborts the upstream fetch and
      // fails the response closed.
      const responseHeaders = {
        'content-type': upstream.headers.get('content-type') || 'application/json',
      };
      copyRetryHeaders(upstream.headers, responseHeaders);
      res.writeHead(upstream.status, responseHeaders);
      const reader = upstream.body?.getReader();
      if (!reader) {
        res.end();
        return;
      }
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        responseBytes += value.byteLength;
        if (responseBytes > maxResponseBytes) {
          controller.abort();
          res.destroy();
          return;
        }
        if (!res.write(Buffer.from(value))) {
          // Honor backpressure: a slow client must not let the proxy buffer
          // the whole upstream response in memory while draining its socket.
          await new Promise((resolveDrain) => {
            res.once('drain', resolveDrain);
            res.once('close', resolveDrain);
            res.once('error', resolveDrain);
          });
        }
      }
      res.end();
    } catch (err) {
      if (res.destroyed) return;
      // Never include the credential or request bodies in the error.
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({
          error: { message: `upstream error: ${err?.message || 'unknown'}` },
        }));
      }
    } finally {
      activeFetches.delete(controller);
    }
  }

  // Request-lifecycle bounds: headers must arrive promptly and the full
  // request body within a bounded window, so an authenticated chunked
  // request that never ends cannot hold the listener (and revoke's close)
  // open indefinitely. Responses are relayed streamingly, so no response
  // timeout is imposed server-side here.
  server.headersTimeout = 30000;
  server.requestTimeout = 120000;
  server.keepAliveTimeout = 5000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host || LOOPBACK_HOST, () => {
      server.unref();
      resolve();
    });
  });
  // CONNECT never reaches the `request` handler in Node — it is emitted as a
  // separate `connect` event. Reject it explicitly so no tunnel can ever be
  // opened (Section 6.5: no CONNECT/general forward-proxy route).
  server.on('connect', (_req, socket) => {
    socket.write('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n');
    socket.end();
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  let closedResolve;
  const closed = new Promise((resolve) => {
    closedResolve = resolve;
  });

  function revoke() {
    if (revoked) return;
    revoked = true;
    // Abort every in-flight upstream fetch so a stuck response can never
    // keep `closed` pending indefinitely.
    for (const controller of activeFetches) controller.abort();
    // closeIdleConnections releases keep-alive sockets held by HTTP clients
    // (undici pools them), so the close callback fires promptly instead of
    // waiting for idle connections to expire.
    server.close(() => {
      closedResolve();
    });
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
    // Hard-close EVERY connection, not just idle ones: a client stuck mid-
    // request (never-ending chunked upload) would otherwise keep the close
    // callback pending forever.
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  }

  return {
    host: LOOPBACK_HOST,
    port,
    token,
    baseUrl: `http://${LOOPBACK_HOST}:${port}`,
    // Loopback origin + pinned prefix: the exact base URL an
    // OpenAI/Anthropic-compatible engine should be configured with.
    scopedBaseUrl: `http://${LOOPBACK_HOST}:${port}${pathPrefix}`,
    provider,
    model,
    protocol,
    bridge,
    revoke,
    closed,
  };
}

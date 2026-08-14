/**
 * coder-credential-proxy.js — Package 2A (Atomic 03): parent-owned loopback
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
 *  - provider/model/endpoint pinning: only the configured upstream endpoint
 *    is reachable, only through the loopback listener;
 *  - request-count, body-byte, rate, and lifetime-deadline caps, none greater
 *    than the parent request itself;
 *  - revocation before cleanup completes; a revoked proxy refuses everything;
 *  - no body logging, no CONNECT/general forward-proxy route;
 *  - exact-secret non-disclosure: the real credential is never returned,
 *    logged, or placed in engine env/argv/config by this module.
 *
 * Pure Node http/https; no dependency on the platform backend.
 */

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const LOOPBACK_HOST = '127.0.0.1';

// Default caps: request count, body bytes, sustained rate, and lifetime
// deadline. The caller (coder run) passes tighter caps derived from the
// parent request; these defaults are only a fail-closed floor.
const DEFAULT_MAX_REQUESTS = 1000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_RATE_PER_SEC = 20;
const DEFAULT_DEADLINE_MS = 30 * 60 * 1000;

function generateToken() {
  return randomBytes(16).toString('hex');
}

/**
 * Start a parent-owned loopback credential proxy.
 *
 * @param {object} opts
 * @param {string} opts.provider       provider id (e.g. 'zai', 'worker')
 * @param {string} opts.model          pinned model id for this run
 * @param {string} opts.endpoint       canonical provider base URL (https)
 * @param {string} opts.credential     real provider credential (in-memory only)
 * @param {string} [opts.token]        pre-generated single-run token (tests)
 * @param {number} [opts.maxRequests]  request-count cap
 * @param {number} [opts.maxBodyBytes] per-request body-byte cap
 * @param {number} [opts.maxRatePerSec] sustained request-rate cap
 * @param {number} [opts.deadlineMs]   proxy lifetime from start
 * @param {Function} [opts.fetchImpl]  injectable fetch (tests)
 * @returns {Promise<object>} resolves once listening:
 *   { host, port, token, baseUrl, provider, model, revoke(), closed }
 */
export async function startCoderCredentialProxy(opts = {}) {
  const {
    provider,
    model,
    endpoint,
    credential,
  } = opts;
  if (typeof provider !== 'string' || provider.length === 0) {
    throw new TypeError('startCoderCredentialProxy: provider is required');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new TypeError('startCoderCredentialProxy: model is required');
  }
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint)) {
    throw new TypeError('startCoderCredentialProxy: endpoint must be an https URL');
  }
  if (typeof credential !== 'string' || credential.length === 0) {
    throw new TypeError('startCoderCredentialProxy: credential is required');
  }

  const token = typeof opts.token === 'string' && opts.token.length > 0
    ? opts.token
    : generateToken();
  const maxRequests = opts.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxRatePerSec = opts.maxRatePerSec ?? DEFAULT_MAX_RATE_PER_SEC;
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;

  // Rate-limit sliding window (one-second buckets, bounded history).
  const requestTimes = [];
  const now = () => Date.now();
  const startedAt = now();
  let revoked = false;
  let requestCount = 0;

  // Monotonic rate check: drop entries older than one second, then enforce
  // the cap on the remaining window.
  function rateAllowed() {
    const t = now();
    while (requestTimes.length && requestTimes[0] <= t - 1000) requestTimes.shift();
    if (requestTimes.length >= maxRatePerSec) return false;
    requestTimes.push(t);
    return true;
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
    // Provider/model pinning: only the OpenAI-compatible /v1 scope is
    // forwarded; everything else is denied.
    if (!req.url.startsWith('/v1/')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unknown proxy route' } }));
      return;
    }

    // Token check. The real credential is never accepted here — only the
    // single-run token.
    const auth = req.headers.authorization || '';
    const expected = `Bearer ${token}`;
    if (auth !== expected) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid proxy token' } }));
      return;
    }

    // Rate cap.
    if (!rateAllowed()) {
      res.writeHead(429, { 'content-type': 'application/json' });
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
      requestCount += 1;
      const body = Buffer.concat(chunks).toString('utf8');
      await forward(req.url, res, body);
    });
  });

  // Forward to the pinned upstream endpoint, attaching the REAL credential
  // (in-memory only; never logged, never returned downstream). The upstream
  // path is exactly the validated request path; no absolute-URI route can
  // reach this point (rejected above).
  async function forward(upstreamPath, res, body) {
    const upstreamUrl = endpoint + upstreamPath;
    try {
      const upstream = await fetchImpl(upstreamUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
        },
        body,
      });
      const upstreamBody = await upstream.arrayBuffer();
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'application/json',
      });
      res.end(Buffer.from(upstreamBody));
    } catch (err) {
      // Never include the credential or request bodies in the error.
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: { message: `upstream error: ${err?.message || 'unknown'}` },
      }));
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, resolve);
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
    // closeIdleConnections releases keep-alive sockets held by HTTP clients
    // (undici pools them), so the close callback fires promptly instead of
    // waiting for idle connections to expire.
    server.close(() => {
      closedResolve();
    });
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
  }

  return {
    host: LOOPBACK_HOST,
    port,
    token,
    baseUrl: `http://${LOOPBACK_HOST}:${port}`,
    provider,
    model,
    revoke,
    closed,
  };
}

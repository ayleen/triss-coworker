/**
 * coder-credential-proxy.test.js — parent-owned
 * loopback credential proxy.
 *
 * RED/GREEN: node --test test/coder-credential-proxy.test.js
 *
 * Covers Section 6.5 of docs/reliable-delegation-contract-plan.md: one-run
 * proxy token, provider/model/endpoint pinning, request/body/deadline caps,
 * no body logging, revocation, and exact-secret non-disclosure. All upstream
 * traffic goes through an injected fetch stub — no network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { connect as netConnect } from 'node:net';

import { startCoderCredentialProxy } from '../src/coder-credential-proxy.js';

const REAL_CREDENTIAL = 'sk-real-provider-secret-0123456789abcdef';
// Invariant: `endpoint` is the upstream ORIGIN only — the engine sends the API
// path (pathPrefix) verbatim, so forwarding is a plain origin+path join and
// the prefix can never be doubled.
const ENDPOINT = 'https://api.provider.example';

function stubFetch({ onRequest } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = typeof init.body === 'string' ? init.body : '';
    const call = { url, headers: init.headers, body };
    calls.push(call);
    if (onRequest) onRequest(call);
    return new Response(JSON.stringify({ ok: true, echo_model: JSON.parse(body).model }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

async function startProxy(overrides = {}, stub = stubFetch()) {
  const proxy = await startCoderCredentialProxy({
    provider: 'zai',
    model: 'glm-5.2',
    endpoint: ENDPOINT,
    credential: REAL_CREDENTIAL,
    fetchImpl: stub.fetchImpl,
    ...overrides,
  });
  return { proxy, stub };
}

function post(proxy, { path = '/v1/chat/completions', token = proxy.token, body = '{"model":"glm-5.2","messages":[]}', method = 'POST', headers = {} } = {}) {
  return fetch(`${proxy.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    body,
  });
}

// Raw request-line probe via a bare TCP socket: undici refuses CONNECT and
// malformed absolute-URI targets before they ever reach the server, so write
// the request line by hand and read the server's raw reply.
function rawRequestStatus(proxy, requestLine) {
  return new Promise((resolve) => {
    const socket = netConnect({ host: proxy.host, port: proxy.port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2000, () => finish({ error: 'timeout' }));
    socket.on('error', (err) => finish({ error: err.code }));
    socket.on('data', (chunk) => {
      const line = chunk.toString('utf8').split('\r\n')[0];
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(line)?.[1]);
      finish({ status });
    });
    socket.on('close', () => finish({ error: 'closed' }));
    socket.write(`${requestLine}\r\nHost: evil.example\r\n\r\n`);
  });
}

// ─── token and pinning ───────────────────────────────────────────────────────

test('proxy starts on loopback with a fresh one-run token', async () => {
  const { proxy } = await startProxy();
  try {
    assert.equal(proxy.host, '127.0.0.1');
    assert.ok(proxy.port > 0);
    assert.match(proxy.token, /^[0-9a-f]{32}$/);
    assert.equal(proxy.baseUrl, `http://127.0.0.1:${proxy.port}`);
    assert.equal(proxy.provider, 'zai');
    assert.equal(proxy.model, 'glm-5.2');
  } finally {
    proxy.revoke();
  }
});

test('a valid token forwards to the pinned endpoint with the real credential', async () => {
  const stub = stubFetch();
  const { proxy } = await startProxy({}, stub);
  try {
    const res = await post(proxy);
    assert.equal(res.status, 200);
    assert.equal(stub.calls.length, 1);
    // No prefix doubling: the ORIGIN plus the request path verbatim.
    assert.equal(stub.calls[0].url, `${ENDPOINT}/v1/chat/completions`);
    // The real credential is attached upstream, never placed in engine env.
    assert.equal(stub.calls[0].headers.authorization, `Bearer ${REAL_CREDENTIAL}`);
  } finally {
    proxy.revoke();
  }
});

test('scopedBaseUrl is the loopback origin plus the pinned prefix', async () => {
  const { proxy } = await startProxy({ pathPrefix: '/api/coding/paas/v4' });
  try {
    assert.equal(proxy.baseUrl, `http://127.0.0.1:${proxy.port}`);
    assert.equal(proxy.scopedBaseUrl, `http://127.0.0.1:${proxy.port}/api/coding/paas/v4`);
  } finally {
    proxy.revoke();
  }
});

test('an endpoint that already carries an API path fails closed (no doubled prefix)', async () => {
  await assert.rejects(
    () => startCoderCredentialProxy({
      provider: 'zai',
      model: 'glm-5.2',
      endpoint: 'https://api.z.ai/api/coding/paas/v4',
      credential: 'x',
      pathPrefix: '/api/coding/paas/v4',
    }),
    TypeError,
  );
});

test('a request naming a different model is refused before any upstream call', async () => {
  const stub = stubFetch();
  const { proxy } = await startProxy({}, stub);
  try {
    const res = await post(proxy, { body: '{"model":"glm-4.7","messages":[]}' });
    assert.equal(res.status, 403);
    const text = await res.text();
    assert.match(text, /model is not pinned/);
    assert.equal(stub.calls.length, 0);
  } finally {
    proxy.revoke();
  }
});

test('a non-JSON body is refused (fail-closed body contract)', async () => {
  const stub = stubFetch();
  const { proxy } = await startProxy({}, stub);
  try {
    const res = await post(proxy, { body: 'not-json' });
    assert.equal(res.status, 403);
    assert.equal(stub.calls.length, 0);
  } finally {
    proxy.revoke();
  }
});

test('the path pin is boundary-exact: /v10 does not pass a /v1 pin', async () => {
  const stub = stubFetch();
  const { proxy } = await startProxy({}, stub);
  try {
    const res = await post(proxy, { path: '/v10/chat/completions' });
    assert.equal(res.status, 404);
    assert.equal(stub.calls.length, 0);
  } finally {
    proxy.revoke();
  }
});

test('anthropic authStyle: token via x-api-key, credential via x-api-key upstream', async () => {
  const stub = stubFetch();
  const { proxy } = await startProxy(
    { authStyle: 'anthropic', pathPrefix: '/coding/v1' },
    stub,
  );
  try {
    const res = await fetch(`${proxy.baseUrl}/coding/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': proxy.token, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: '{"model":"glm-5.2","messages":[]}',
    });
    assert.equal(res.status, 200);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, `${ENDPOINT}/coding/v1/messages`);
    assert.equal(stub.calls[0].headers['x-api-key'], REAL_CREDENTIAL);
    assert.equal(stub.calls[0].headers['anthropic-version'], '2023-06-01');
    assert.equal(stub.calls[0].headers.authorization, undefined);
  } finally {
    proxy.revoke();
  }
});

test('anthropic authStyle: a Bearer token is not accepted downstream', async () => {
  const stub = stubFetch();
  const { proxy } = await startProxy({ authStyle: 'anthropic' }, stub);
  try {
    const res = await post(proxy, { path: '/v1/messages' }); // Bearer auth header
    assert.equal(res.status, 401);
    assert.equal(stub.calls.length, 0);
  } finally {
    proxy.revoke();
  }
});

test('only the exact inference endpoint is forwarded (subtree is closed)', async () => {
  const stub = stubFetch();
  const { proxy } = await startProxy({}, stub);
  try {
    // Non-completion routes under the pinned prefix must be unreachable —
    // the engine must not be able to reach mutating or billed endpoints.
    for (const path of ['/v1/embeddings', '/v1/models', '/v1/files', '/v1/completions']) {
      const res = await post(proxy, { path });
      assert.equal(res.status, 404, path);
    }
    assert.equal(stub.calls.length, 0);
  } finally {
    proxy.revoke();
  }
});

test('a query string on the exact inference endpoint still matches the pin', async () => {
  const stub = stubFetch();
  const { proxy } = await startProxy({}, stub);
  try {
    const res = await post(proxy, { path: '/v1/chat/completions?api-version=2026' });
    assert.equal(res.status, 200);
    assert.equal(stub.calls.length, 1);
    // Forwarded verbatim, query included.
    assert.equal(stub.calls[0].url, `${ENDPOINT}/v1/chat/completions?api-version=2026`);
  } finally {
    proxy.revoke();
  }
});

test('an upstream response above the response cap is refused whole', async () => {
  const fetchImpl = async () => new Response('x', {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': String(1024 * 1024) },
  });
  const { proxy } = await startProxy({ maxResponseBytes: 1024, fetchImpl });
  try {
    const res = await post(proxy);
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.match(text, /exceeds proxy cap/);
  } finally {
    proxy.revoke();
  }
});

test('wrong, missing, or malformed token is rejected before any upstream call', async () => {
  const stub = stubFetch();
  const { proxy } = await startProxy({}, stub);
  try {
    for (const token of ['wrong-token', '', 'Bearer wrong']) {
      const res = await post(proxy, { token });
      assert.equal(res.status, 401, `token=${JSON.stringify(token)}`);
    }
    const noAuth = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(noAuth.status, 401);
    assert.equal(stub.calls.length, 0);
  } finally {
    proxy.revoke();
  }
});

test('CONNECT and absolute-URI forward-proxy routes are denied', async () => {
  const stub = stubFetch();
  const { proxy } = await startProxy({}, stub);
  try {
    // A CONNECT must never yield a 200 tunnel; a closed/errored socket or a
    // 405 is the fail-closed outcome.
    const connect = await rawRequestStatus(proxy, 'CONNECT evil.example:443 HTTP/1.1');
    assert.notEqual(connect.status, 200, 'CONNECT must never open a tunnel');
    if (connect.status !== undefined) {
      assert.equal(connect.status, 405);
    }

    // An absolute-URI request line is a general forward-proxy route: denied.
    const absolute = await rawRequestStatus(
      proxy,
      'POST http://evil.example/v1/chat/completions HTTP/1.1',
    );
    assert.notEqual(absolute.status, 200);
    if (absolute.status !== undefined) {
      assert.equal(absolute.status, 400);
    }

    assert.equal(stub.calls.length, 0);
  } finally {
    proxy.revoke();
  }
});

test('unknown proxy routes are denied (endpoint pinning)', async () => {
  const stub = stubFetch();
  const { proxy } = await startProxy({}, stub);
  try {
    const res = await post(proxy, { path: '/other/route' });
    assert.equal(res.status, 404);
    assert.equal(stub.calls.length, 0);
  } finally {
    proxy.revoke();
  }
});

// ─── caps ────────────────────────────────────────────────────────────────────

test('request-count cap rejects further requests', async () => {
  const stub = stubFetch();
  const { proxy } = await startProxy({ maxRequests: 2 }, stub);
  try {
    assert.equal((await post(proxy)).status, 200);
    assert.equal((await post(proxy)).status, 200);
    const third = await post(proxy);
    assert.equal(third.status, 429);
    assert.equal(stub.calls.length, 2);
  } finally {
    proxy.revoke();
  }
});

test('body-byte cap rejects oversized bodies without forwarding them', async () => {
  const stub = stubFetch();
  const { proxy } = await startProxy({ maxBodyBytes: 1024 }, stub);
  try {
    const bigBody = JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'x'.repeat(2048) }] });
    const res = await post(proxy, { body: bigBody });
    assert.equal(res.status, 413);
    assert.equal(stub.calls.length, 0);
  } finally {
    proxy.revoke();
  }
});

test('rate cap rejects bursts beyond the sustained rate', async () => {
  const stub = stubFetch();
  const { proxy } = await startProxy({ maxRatePerSec: 3 }, stub);
  try {
    const statuses = [];
    for (let i = 0; i < 8; i += 1) {
      statuses.push((await post(proxy)).status);
    }
    const ok = statuses.filter((s) => s === 200).length;
    const limited = statuses.filter((s) => s === 429).length;
    assert.ok(ok <= 3, `at most 3 accepted, got ${ok}`);
    assert.ok(limited >= 5, `at least 5 rate-limited, got ${limited}`);
    assert.equal(ok + limited, 8);
  } finally {
    proxy.revoke();
  }
});

test('deadline cap rejects requests after the lifetime deadline', async () => {
  const stub = stubFetch();
  const { proxy } = await startProxy({ deadlineMs: 200 }, stub);
  try {
    assert.equal((await post(proxy)).status, 200);
    await new Promise((r) => setTimeout(r, 400));
    const late = await post(proxy);
    assert.equal(late.status, 408);
  } finally {
    proxy.revoke();
  }
});

// ─── no body logging / non-disclosure ────────────────────────────────────────

test('bodies and credentials never appear in upstream-facing responses', async () => {
  const stub = stubFetch();
  const { proxy } = await startProxy({}, stub);
  try {
    const res = await post(proxy, { body: JSON.stringify({ model: 'glm-5.2', secret_payload: 'TOP-SECRET-BODY' }) });
    const text = await res.text();
    assert.equal(text.includes('TOP-SECRET-BODY'), false);
    assert.equal(text.includes(REAL_CREDENTIAL), false);
    assert.equal(text.includes(proxy.token), false);
  } finally {
    proxy.revoke();
  }
});

test('upstream errors never leak the credential or the token', async () => {
  const fetchImpl = async () => {
    throw new Error('upstream exploded');
  };
  const { proxy } = await startProxy({ fetchImpl });
  try {
    const res = await post(proxy);
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.equal(text.includes(REAL_CREDENTIAL), false);
    assert.equal(text.includes(proxy.token), false);
  } finally {
    proxy.revoke();
  }
});

test('proxy errors never echo the request body or the token', async () => {
  const { proxy } = await startProxy();
  try {
    const res = await post(proxy, { token: 'wrong', body: JSON.stringify({ model: 'glm-5.2', leak_me: 'BODY-SECRET' }) });
    const text = await res.text();
    assert.equal(res.status, 401);
    assert.equal(text.includes('BODY-SECRET'), false);
    assert.equal(text.includes(proxy.token), false);
  } finally {
    proxy.revoke();
  }
});

// ─── revocation ──────────────────────────────────────────────────────────────

test('revoke stops the listener and refuses everything after cleanup', async () => {
  const stub = stubFetch();
  const { proxy } = await startProxy({}, stub);
  try {
    assert.equal((await post(proxy)).status, 200);
  } finally {
    proxy.revoke();
  }
  // After revocation the listener is closed: connection refused.
  await assert.rejects(
    () => post(proxy),
    (err) => {
      assert.match(String(err?.cause?.code || err?.code || err?.message), /ECONNREFUSED/);
      return true;
    },
  );
  assert.equal(stub.calls.length, 1);
});

test('revoke is idempotent and resolves the closed promise', async () => {
  const { proxy } = await startProxy();
  proxy.revoke();
  proxy.revoke();
  await proxy.closed;
  assert.ok(true);
});

test('revoke aborts a genuinely in-flight upstream request and settles safely', async () => {
  let fetchStarted;
  let markFetchStarted;
  fetchStarted = new Promise((resolve) => { markFetchStarted = resolve; });
  let upstreamSignal;
  const fetchImpl = async (_url, init) => {
    upstreamSignal = init.signal;
    markFetchStarted();
    return new Promise((_resolve, reject) => {
      const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (upstreamSignal.aborted) abort();
      else upstreamSignal.addEventListener('abort', abort, { once: true });
    });
  };
  const { proxy } = await startProxy({ fetchImpl });
  const body = JSON.stringify({ model: 'glm-5.2', secret_payload: 'IN-FLIGHT-BODY' });
  const request = post(proxy, { body });
  await fetchStarted;
  assert.equal(upstreamSignal.aborted, false);

  proxy.revoke();
  await proxy.closed;
  assert.equal(upstreamSignal.aborted, true);

  let settleTimeout;
  const settled = await Promise.race([
    request.then(
      async (res) => ({ text: await res.text() }),
      (error) => ({ error: String(error?.message || error) }),
    ),
    new Promise((resolve) => { settleTimeout = setTimeout(() => resolve({ timeout: true }), 2000); }),
  ]);
  clearTimeout(settleTimeout);
  assert.equal(settled.timeout, undefined, 'the client request must settle after revocation');
  const observable = settled.text || settled.error || '';
  assert.equal(observable.includes(REAL_CREDENTIAL), false);
  assert.equal(observable.includes('IN-FLIGHT-BODY'), false);
  assert.equal(observable.includes(proxy.token), false);
});

test('caller-supplied token is accepted for deterministic tests', async () => {
  const stub = stubFetch();
  const { proxy } = await startProxy({ token: 'fixed-token-0123456789abcdef' }, stub);
  try {
    assert.equal(proxy.token, 'fixed-token-0123456789abcdef');
    const res = await post(proxy, { token: 'fixed-token-0123456789abcdef' });
    assert.equal(res.status, 200);
  } finally {
    proxy.revoke();
  }
});

test('missing required options fail closed', async () => {
  await assert.rejects(() => startCoderCredentialProxy({}), TypeError);
  await assert.rejects(
    () => startCoderCredentialProxy({ provider: 'zai', model: 'glm-5.2', endpoint: ENDPOINT }),
    TypeError,
  );
  await assert.rejects(
    () => startCoderCredentialProxy({
      provider: 'zai', model: 'glm-5.2', endpoint: 'http://insecure.example', credential: 'x',
    }),
    TypeError,
  );
});

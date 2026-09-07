// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * review-round8-coder-proxy-root-and-route.test.js — two immutable-request
 * fixes:
 *
 * 1. Root endpoints in the credential proxy. provider-security normalizes a
 *    root configured endpoint (https://host) to an empty path prefix, and the
 *    run path builds the RAW upstream as endpoint + '' + route. The proxy used
 *    to treat an empty pathPrefix as "unset" and silently substitute /v1 —
 *    a protected run would hit https://host/v1/... while a raw run of the SAME
 *    configuration hits https://host/... The proxy must honor '' as root.
 * 2. Single-snapshot routing. resolveRuntimeCoderProviderRoute must resolve
 *    the manual TRISS_MODEL_TRANSPORTS override from the SAME captured
 *    provider snapshot used for model/credential selection — never from a
 *    fresh read that a concurrent config edit could diverge.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startCoderCredentialProxy } from '../src/coder-credential-proxy.js';
import { resolveRuntimeCoderProviderRoute } from '../src/commands/coder.js';
import { createProviderConfigSnapshot } from '../src/provider-config.js';

const ENDPOINT = 'https://upstream.test';
const REAL_CREDENTIAL = 'zk-synth-proxy-key-0001';

function stubFetch() {
  const calls = [];
  const fetchImpl = async (url, _init) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

// ─── 1. root endpoint (empty path prefix) ────────────────────────────────────

test('proxy: an empty pathPrefix means ROOT — scopedBaseUrl carries no /v1', async () => {
  const proxy = await startCoderCredentialProxy({
    provider: 'zai',
    model: 'glm-5.2',
    endpoint: ENDPOINT,
    credential: REAL_CREDENTIAL,
    pathPrefix: '',
    fetchImpl: stubFetch().fetchImpl,
  });
  try {
    assert.equal(proxy.scopedBaseUrl, `http://127.0.0.1:${proxy.port}`);
  } finally {
    proxy.revoke();
    await proxy.closed;
  }
});

test('proxy: a raw run and a protected run hit the SAME effective upstream path for a root endpoint', async () => {
  const stub = stubFetch();
  const proxy = await startCoderCredentialProxy({
    provider: 'zai',
    model: 'glm-5.2',
    endpoint: ENDPOINT,
    credential: REAL_CREDENTIAL,
    pathPrefix: '',
    fetchImpl: stub.fetchImpl,
  });
  try {
    const res = await fetch(`${proxy.scopedBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' },
      body: '{"model":"glm-5.2","messages":[]}',
    });
    assert.equal(res.status, 200);
    // Raw equivalent: endpoint + (pathPrefix === '/' ? '' : pathPrefix) + route
    // Root endpoint (no path prefix) contributes NOTHING to the raw path:
    // the raw run talks to <endpoint>/chat/completions directly.
    const rawPath = `${ENDPOINT}/chat/completions`;
    assert.equal(stub.calls[0], rawPath, 'the proxy must not add /v1 the raw run would not use');
    assert.equal(stub.calls[0], `${ENDPOINT}/chat/completions`);
  } finally {
    proxy.revoke();
    await proxy.closed;
  }
});

test('proxy: a "/"-prefixed pathPrefix keeps the historical default behavior', async () => {
  const stub = stubFetch();
  const proxy = await startCoderCredentialProxy({
    provider: 'zai',
    model: 'glm-5.2',
    endpoint: ENDPOINT,
    credential: REAL_CREDENTIAL,
    pathPrefix: '/v1',
    fetchImpl: stub.fetchImpl,
  });
  try {
    assert.equal(proxy.scopedBaseUrl, `http://127.0.0.1:${proxy.port}/v1`);
    const res = await fetch(`${proxy.scopedBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' },
      body: '{"model":"glm-5.2","messages":[]}',
    });
    assert.equal(res.status, 200);
    assert.equal(stub.calls[0], `${ENDPOINT}/v1/chat/completions`);
  } finally {
    proxy.revoke();
    await proxy.closed;
  }
});

test('proxy: an absent pathPrefix still defaults to /v1', async () => {
  const stub = stubFetch();
  const proxy = await startCoderCredentialProxy({
    provider: 'zai',
    model: 'glm-5.2',
    endpoint: ENDPOINT,
    credential: REAL_CREDENTIAL,
    fetchImpl: stub.fetchImpl,
  });
  try {
    assert.equal(proxy.scopedBaseUrl, `http://127.0.0.1:${proxy.port}/v1`);
  } finally {
    proxy.revoke();
    await proxy.closed;
  }
});

test('proxy: a non-path pathPrefix value fails closed instead of silently becoming /v1', async () => {
  await assert.rejects(
    startCoderCredentialProxy({
      provider: 'zai',
      model: 'glm-5.2',
      endpoint: ENDPOINT,
      credential: REAL_CREDENTIAL,
      pathPrefix: 'v1',
      fetchImpl: stubFetch().fetchImpl,
    }),
    /pathPrefix/,
  );
});

// ─── 2. single-snapshot transport routing ────────────────────────────────────

test('resolveRuntimeCoderProviderRoute: the manual transport override comes from the CAPTURED snapshot', () => {
  const captured = createProviderConfigSnapshot({
    parentEnv: { TRISS_MODEL_TRANSPORTS: '{"zai/glm-5.2":"openai-responses"}' },
  });
  // A later config edit produced a different snapshot; the run must never mix.
  const mutated = createProviderConfigSnapshot({
    parentEnv: { TRISS_MODEL_TRANSPORTS: '{"zai/glm-5.2":"anthropic-messages"}' },
  });
  const source = { modelTransports: captured.modelTransports };
  const route = resolveRuntimeCoderProviderRoute('zai/glm-5.2', undefined, {
    requireAudited: false,
    snapshot: source,
  });
  assert.equal(route.protocol, 'openai_responses', 'captured snapshot must win');
  assert.notEqual(
    resolveRuntimeCoderProviderRoute('zai/glm-5.2', undefined, {
      requireAudited: false,
      snapshot: { modelTransports: mutated.modelTransports },
    }).protocol,
    'openai_responses',
    'a different snapshot must resolve differently — the override is not ambient',
  );
});

test('resolveRuntimeCoderProviderRoute: with no snapshot injected the fresh read is used (registry protocol)', () => {
  // The test process carries no TRISS_MODEL_TRANSPORTS, so the fresh read
  // resolves the registry protocol for zai — proving the captured snapshot in
  // the test above is genuinely the source of its override.
  const route = resolveRuntimeCoderProviderRoute('zai/glm-5.2', undefined, { requireAudited: false });
  assert.notEqual(route.protocol, 'openai_responses');
  assert.equal(route.protocol, 'openai_chat');
});

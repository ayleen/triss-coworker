// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { startCoderCredentialProxy } from '../src/coder-credential-proxy.js';

const REAL_CREDENTIAL = 'sk-real-responses-secret-0123456789abcdef';
const ENDPOINT = 'https://api.provider.example';

function responsesPayload({ text = 'BRIDGE-OK', status = 'completed' } = {}) {
  return {
    id: 'resp-bridge-1',
    model: 'muse-spark-1.2-contributor',
    status,
    output: [{
      type: 'message',
      id: 'msg-1',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    }],
    usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12 },
  };
}

function stubResponsesFetch({ payload, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
    const body = status === 200
      ? JSON.stringify(payload)
      : JSON.stringify({ error: { message: 'insufficient quota sk-live-9876543210' } });
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

async function startBridgedProxy(stub, overrides = {}) {
  return startCoderCredentialProxy({
    provider: 'opencode-go',
    model: 'muse-spark-1.2-contributor',
    endpoint: ENDPOINT,
    credential: REAL_CREDENTIAL,
    pathPrefix: '/v1',
    protocol: 'openai_chat',
    bridge: 'chat-to-responses',
    fetchImpl: stub.fetchImpl,
    ...overrides,
  });
}

function post(proxy, body, { stream = false } = {}) {
  return fetch(`${proxy.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'muse-spark-1.2-contributor', messages: [{ role: 'user', content: 'q' }], ...(stream ? { stream: true } : {}) }),
  });
}

test('bridge: chat request is forwarded as a Responses request with the real credential', async () => {
  const stub = stubResponsesFetch({ payload: responsesPayload() });
  const proxy = await startBridgedProxy(stub);
  try {
    const res = await post(proxy);
    assert.equal(res.status, 200);
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, `${ENDPOINT}/v1/responses`);
    assert.equal(stub.calls[0].headers.authorization, `Bearer ${REAL_CREDENTIAL}`);
    assert.equal(stub.calls[0].body.model, 'muse-spark-1.2-contributor');
    assert.deepEqual(stub.calls[0].body.input, [{ role: 'user', content: 'q' }]);
    assert.equal(stub.calls[0].body.stream, false);

    const payload = await res.json();
    assert.equal(payload.choices[0].message.content, 'BRIDGE-OK');
    assert.equal(payload.choices[0].finish_reason, 'stop');
    assert.deepEqual(payload.usage, { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 });
    assert.ok(!JSON.stringify(payload).includes(REAL_CREDENTIAL));
  } finally {
    proxy.revoke();
  }
});

test('bridge: engine stream request receives chat SSE chunks translated from the Responses answer', async () => {
  const stub = stubResponsesFetch({ payload: responsesPayload({ text: 'STREAM-OK' }) });
  const proxy = await startBridgedProxy(stub);
  try {
    const res = await post(proxy, null, { stream: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const raw = await res.text();
    const events = raw.split('\n\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice('data: '.length)));
    assert.equal(events[0].choices[0].delta.content, 'STREAM-OK');
    assert.equal(events.at(-1).choices[0].finish_reason, 'stop');
    assert.equal(events.at(-1).usage.prompt_tokens, 7);
    assert.ok(raw.includes('data: [DONE]'));
  } finally {
    proxy.revoke();
  }
});

test('bridge: upstream provider errors pass through with the real status', async () => {
  const stub = stubResponsesFetch({ status: 429 });
  const proxy = await startBridgedProxy(stub);
  try {
    const res = await post(proxy);
    assert.equal(res.status, 429);
    const payload = await res.json();
    assert.match(payload.error.message, /insufficient quota/);
    // Upstream bodies relay verbatim in bridge mode exactly like the plain
    // forwarding path; only proxy-generated errors are secret-redacted.
    assert.ok(!JSON.stringify(payload).includes(REAL_CREDENTIAL));
  } finally {
    proxy.revoke();
  }
});

test('bridge: tool-bearing requests are refused with a precise limitation, not degraded', async () => {
  const stub = stubResponsesFetch({ payload: responsesPayload() });
  const proxy = await startBridgedProxy(stub);
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'muse-spark-1.2-contributor',
        messages: [{ role: 'user', content: 'q' }],
        tools: [{ type: 'function', function: { name: 'edit' } }],
      }),
    });
    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.match(payload.error.message, /tool definitions are not translated/);
    assert.equal(stub.calls.length, 0, 'no upstream call may leave the proxy for a refused bridge request');
  } finally {
    proxy.revoke();
  }
});

test('bridge: misconfiguration fails closed at construction', async () => {
  const stub = stubResponsesFetch({ payload: responsesPayload() });
  await assert.rejects(
    () => startBridgedProxy(stub, { bridge: 'pigeon-post' }),
    /unsupported bridge "pigeon-post"/,
  );
  await assert.rejects(
    () => startBridgedProxy(stub, { protocol: 'anthropic_messages' }),
    /requires protocol "openai_chat"/,
  );
});

test('bridge: non-bridge proxy still relays /responses verbatim for native responses clients', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push({ url });
    return new Response(JSON.stringify(responsesPayload()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const proxy = await startCoderCredentialProxy({
    provider: 'opencode-go',
    model: 'muse-spark-1.2-contributor',
    endpoint: ENDPOINT,
    credential: REAL_CREDENTIAL,
    pathPrefix: '/v1',
    protocol: 'openai_responses',
    fetchImpl,
  });
  try {
    const res = await fetch(`${proxy.baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'muse-spark-1.2-contributor', input: [] }),
    });
    assert.equal(res.status, 200);
    assert.equal(calls[0].url, `${ENDPOINT}/v1/responses`);
    const payload = await res.json();
    assert.equal(payload.id, 'resp-bridge-1');
  } finally {
    proxy.revoke();
  }
});

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createProviderConfigSnapshot } from '../src/provider-config.js';
import { resolveModelRequest } from '../src/model-selection.js';
import { executeTransport } from '../src/transport-registry.js';
import {
  parseModelTransportsOverride,
  resolveProviderModelTransport,
} from '../src/provider-model-transport.js';

function config({ shell = {}, local = '', global = '' } = {}) {
  const sources = new Map([['/local', local], ['/global', global]]);
  return createProviderConfigSnapshot({
    parentEnv: shell,
    files: [
      { scope: 'local', path: '/local', exists: true },
      { scope: 'global', path: '/global', exists: true },
    ],
    readFile: (path) => sources.get(path),
  });
}

test('audited catalogue entries resolve concrete transports per model', () => {
  const chat = resolveProviderModelTransport({ providerId: 'opencode-go', nativeModel: 'deepseek-v4-flash' });
  assert.equal(chat.transportId, 'openai-chat');
  assert.equal(chat.protocol, 'openai_chat');
  assert.equal(chat.transportAudited, true);
  assert.equal(chat.source, 'audited-catalogue');

  const responses = resolveProviderModelTransport({
    providerId: 'opencode-go',
    nativeModel: 'muse-spark-1.2-contributor',
  });
  assert.equal(responses.transportId, 'openai-responses');
  assert.equal(responses.protocol, 'openai_responses');

  const anthropic = resolveProviderModelTransport({ providerId: 'opencode-zen', nativeModel: 'claude-sonnet-5' });
  assert.equal(anthropic.transportId, 'anthropic-messages');
  assert.equal(anthropic.authStyle, 'anthropic');
});

test('unknown catalogue models stay unresolved instead of guessing a protocol', () => {
  const unknown = resolveProviderModelTransport({ providerId: 'opencode-zen', nativeModel: 'brand-new-model' });
  assert.equal(unknown.transportId, null);
  assert.equal(unknown.transportAudited, false);
  assert.equal(unknown.source, null);

  const gemini = resolveProviderModelTransport({ providerId: 'opencode-zen', nativeModel: 'gemini-3.7-flash' });
  assert.equal(gemini.transportId, null);
  assert.equal(gemini.unsupported, 'google/gemini transport is not vetted by the protected proxy');
});

test('explicit TRISS_MODEL_TRANSPORTS override is exact and does not restrict other models', () => {
  const overrides = parseModelTransportsOverride(
    '{"opencode-go/muse-spark-1.2-contributor": "openai-responses", "opencode-zen/claude-sonnet-5": "openai-chat"}',
  );
  const overridden = resolveProviderModelTransport({
    providerId: 'opencode-go',
    nativeModel: 'muse-spark-1.2-contributor',
    overrides,
  });
  assert.equal(overridden.transportId, 'openai-responses');
  assert.equal(overridden.source, 'explicit-override');

  const reinterpreted = resolveProviderModelTransport({
    providerId: 'opencode-zen',
    nativeModel: 'claude-sonnet-5',
    overrides,
  });
  assert.equal(reinterpreted.transportId, 'openai-chat');
  assert.equal(reinterpreted.source, 'explicit-override');

  // A sibling model is untouched by the override — not an allowlist.
  const sibling = resolveProviderModelTransport({
    providerId: 'opencode-go',
    nativeModel: 'grok-4.5',
    overrides,
  });
  assert.equal(sibling.transportId, 'openai-responses');
  assert.equal(sibling.source, 'audited-catalogue');
});

test('invalid TRISS_MODEL_TRANSPORTS values fail with actionable errors', () => {
  assert.throws(() => parseModelTransportsOverride('not-json{'), /TRISS_MODEL_TRANSPORTS must be a JSON object/);
  assert.throws(() => parseModelTransportsOverride('[1]'), /TRISS_MODEL_TRANSPORTS must be a JSON object/);
  assert.throws(
    () => parseModelTransportsOverride('{"opencode-go/x": "carrier-pigeon"}'),
    /unsupported transport "carrier-pigeon"/,
  );
  assert.throws(
    () => parseModelTransportsOverride('{"deepseek/model": "openai-chat"}'),
    /TRISS_MODEL_TRANSPORTS provider "deepseek"/,
  );
  assert.throws(
    () => parseModelTransportsOverride('{"opencode-go": "openai-chat"}'),
    /must be an exact "provider\/model" selector/,
  );
  assert.equal(parseModelTransportsOverride(''), null);
  assert.equal(parseModelTransportsOverride(undefined), null);
});

test('resolveModelRequest resolves per-model direct transports for Go and Zen', () => {
  const snapshot = config({
    local: 'TRISS_OPENCODE_GO_MODEL=muse-spark-1.2-contributor\nTRISS_DEFAULT_PROVIDER=opencode-go\n',
  });
  const request = resolveModelRequest({}, snapshot);
  assert.equal(request.route.transport, 'openai-responses');
  assert.equal(request.route.transportMetadata.source, 'audited-catalogue');
  assert.equal(request.route.policy, 'opencode-catalogue');

  const unknownSnapshot = config({
    local: 'TRISS_OPENCODE_GO_MODEL=totally-new-model\nTRISS_DEFAULT_PROVIDER=opencode-go\n',
  });
  const unknownRequest = resolveModelRequest({}, unknownSnapshot);
  assert.equal(unknownRequest.route.transport, 'registry');
  assert.equal(unknownRequest.route.transportMetadata.transportAudited, false);
});

test('snapshot TRISS_MODEL_TRANSPORTS reaches the route with provenance', () => {
  const snapshot = config({
    local: [
      'TRISS_OPENCODE_GO_MODEL=manual-model',
      'TRISS_DEFAULT_PROVIDER=opencode-go',
      'TRISS_MODEL_TRANSPORTS={"opencode-go/manual-model": "openai-chat"}',
    ].join('\n'),
  });
  const request = resolveModelRequest({}, snapshot);
  assert.equal(request.route.transport, 'openai-chat');
  assert.equal(request.route.transportMetadata.source, 'explicit-override');

  assert.throws(
    () => resolveModelRequest({}, config({
      local: 'TRISS_MODEL_TRANSPORTS=broken\n',
    })),
    /TRISS_MODEL_TRANSPORTS must be a JSON object/,
  );
});

test('direct Go transport speaks the resolved protocol over real HTTP', async (t) => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body: body ? JSON.parse(body) : null,
      });
      if (req.url.endsWith('/responses')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          id: 'resp-mock', model: seen.at(-1).body.model, status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'marker-ok' }] }],
          usage: { input_tokens: 3, output_tokens: 4 },
        }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'chat-mock', model: seen.at(-1).body.model,
        choices: [{ message: { content: 'chat-ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const base = `http://127.0.0.1:${server.address().port}`;
  const snapshot = config({
    local: [
      `TRISS_OPENCODE_GO_BASE_URL=${base}`,
      'OPENCODE_API_KEY=test-opencode-key',
      'TRISS_OPENCODE_GO_MODEL=muse-spark-1.2-contributor',
      'TRISS_DEFAULT_PROVIDER=opencode-go',
    ].join('\n'),
  });

  const responsesRequest = resolveModelRequest({}, snapshot);
  const responsesResult = await executeTransport({
    route: responsesRequest.route,
    messages: [{ role: 'user', content: 'q' }],
  });
  assert.equal(responsesResult.text, 'marker-ok');
  assert.equal(seen.at(-1).url, '/responses');
  assert.equal(seen.at(-1).authorization, 'Bearer test-opencode-key');
  assert.equal(seen.at(-1).body.model, 'muse-spark-1.2-contributor');

  const chatSnapshot = config({
    local: [
      `TRISS_OPENCODE_GO_BASE_URL=${base}`,
      'OPENCODE_API_KEY=test-opencode-key',
      'TRISS_OPENCODE_GO_MODEL=deepseek-v4-flash',
      'TRISS_DEFAULT_PROVIDER=opencode-go',
    ].join('\n'),
  });
  const chatRequest = resolveModelRequest({}, chatSnapshot);
  const chatResult = await executeTransport({
    route: chatRequest.route,
    messages: [{ role: 'user', content: 'q' }],
  });
  assert.equal(chatResult.text, 'chat-ok');
  assert.equal(seen.at(-1).url, '/chat/completions');
  assert.equal(seen.at(-1).body.model, 'deepseek-v4-flash');
});

test('direct provider API errors surface as classified provider errors', async (t) => {
  const server = createServer((req, res) => {
    res.statusCode = 401;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { message: 'bad key sk-live-1234567890' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const snapshot = config({
    local: [
      `TRISS_OPENCODE_GO_BASE_URL=http://127.0.0.1:${server.address().port}`,
      'OPENCODE_API_KEY=test-opencode-key',
      'TRISS_OPENCODE_GO_MODEL=deepseek-v4-flash',
      'TRISS_DEFAULT_PROVIDER=opencode-go',
    ].join('\n'),
  });
  const request = resolveModelRequest({}, snapshot);
  await assert.rejects(
    () => executeTransport({ route: request.route, messages: [{ role: 'user', content: 'q' }] }),
    (error) => error.code === 'TRISS_PROVIDER_AUTH' && !error.message.includes('sk-live-1234567890'),
  );
});

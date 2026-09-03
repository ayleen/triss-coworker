// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvText } from '../src/secrets.js';
import { START_MARKER, END_MARKER } from '../src/agent-rule-markers.js';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'migration', '0.41');

function fixture(name) {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

test('0.41 env fixtures use the production env codec and persisted field names', () => {
  const global = parseEnvText(fixture('worker-global.env')).vars;
  assert.equal(global.TRISS_WORKER_API_KEY, 'sk-legacy-global-fixture');
  assert.equal(global.TRISS_DEFAULT_MODEL, 'flash');
  assert.equal(global.TRISS_CODER_MODEL, 'triss-worker/deepseek-v4-pro');
  assert.equal(global.TRISS_CODER_SMALL_MODEL, 'triss-worker/deepseek-v4-flash');

  const project = parseEnvText(fixture('provider-project.env')).vars;
  assert.equal(project.TRISS_KIMI_BASE_URL, 'https://api.moonshot.cn/v1');
  assert.equal(project.TRISS_CODER_MODEL, 'zai-coding-plan/glm-5.2');
});

test('0.41 OpenCode worker fixture matches the generated managed provider shape', () => {
  const config = JSON.parse(fixture('opencode-worker.json'));
  assert.equal(config.model, 'triss-worker/deepseek-v4-pro');
  assert.equal(config.small_model, 'triss-worker/deepseek-v4-flash');
  assert.deepEqual(config.permission, { bash: { '*': 'deny' } });
  assert.deepEqual(config.provider['triss-worker'].options, {
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: '{env:TRISS_WORKER_API_KEY}',
  });
  assert.equal(config.provider['triss-worker'].npm, '@ai-sdk/openai-compatible');
});

test('0.41 managed-rule fixture preserves user-owned surrounding bytes', () => {
  const text = fixture('managed-agent-rule.txt');
  const start = text.indexOf(START_MARKER);
  const end = text.indexOf(END_MARKER);
  assert.ok(start > 0);
  assert.ok(end > start);
  assert.equal(text.slice(0, start), 'User text before the managed block.\n');
  assert.equal(text.slice(end + END_MARKER.length), '\nUser text after the managed block.\n');
});

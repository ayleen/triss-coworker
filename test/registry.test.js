// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadIntegrations, envReadiness } from '../src/integrations/_registry.js';

test('loadIntegrations discovers jira and linear', async () => {
  const list = await loadIntegrations();
  const names = list.map((m) => m.name).sort();
  assert.ok(names.includes('jira'), 'jira missing');
  assert.ok(names.includes('linear'), 'linear missing');
});

test('every integration has a valid manifest', async () => {
  const list = await loadIntegrations();
  for (const m of list) {
    assert.equal(typeof m.name, 'string');
    assert.equal(typeof m.register, 'function');
    if (m.envVars) {
      for (const e of m.envVars) {
        assert.equal(typeof e.name, 'string');
      }
    }
  }
});

test('envReadiness reports missing required env', async () => {
  const list = await loadIntegrations();
  const jira = list.find((m) => m.name === 'jira');
  const before = process.env.ATLASSIAN_BASE_URL;
  delete process.env.ATLASSIAN_BASE_URL;
  delete process.env.ATLASSIAN_EMAIL;
  delete process.env.ATLASSIAN_API_TOKEN;
  const r = envReadiness(jira);
  assert.equal(r.ready, false);
  assert.ok(r.missing.includes('ATLASSIAN_BASE_URL'));
  if (before) process.env.ATLASSIAN_BASE_URL = before;
});

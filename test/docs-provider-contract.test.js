// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// DOC-PROVIDER contract tests: the documented provider/model selector rules,
// persisted configuration fields, and engine capability metadata must match
// the runtime. Catches the D03/D07 drift classes and pins the A01.1 engine
// registry metadata sync (crush providerKinds was stale at ['zai']).
//
// Pure resolver tests — no network, no snapshot files.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProviderConfigSnapshot } from '../src/provider-config.js';
import { validateModelSelectionInput } from '../src/provider-contract.js';
import { resolveModelSelection } from '../src/model-selection.js';
import { resolveProvider } from '../src/usage.js';
import { CODER_ENGINE_REGISTRY, CODER_ENGINE_ORDER } from '../src/coder-engine-registry.js';
import { CANONICAL_PROVIDER_IDS } from '../src/provider-contract.js';
import { assembleTools } from '../src/mcp/tools.js';
import { readFileSync as fsReadFileSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

test('DOC-PROVIDER-01: explicit provider plus a qualified model is kept verbatim', () => {
  const selection = validateModelSelectionInput({ provider: 'zai', model: 'zai/glm-5.2' });
  assert.equal(selection.provider, 'zai');
  assert.equal(selection.model.providerId, 'zai');
  assert.equal(selection.model.nativeModel, 'glm-5.2');
});

test('DOC-PROVIDER-01: a qualified model prefix selects the provider', () => {
  const snapshot = config();
  const selection = resolveModelSelection({ model: 'moonshot/kimi-k3' }, snapshot);
  assert.equal(selection.providerId, 'moonshot');
  assert.equal(selection.nativeModel, 'kimi-k3');
});

test('DOC-PROVIDER-01: a bare model resolves against the configured default provider', () => {
  const snapshot = config({ local: 'TRISS_DEFAULT_PROVIDER=moonshot\n' });
  const selection = resolveModelSelection({ model: 'kimi-k3' }, snapshot);
  assert.equal(selection.providerId, 'moonshot');
  assert.equal(selection.nativeModel, 'kimi-k3');
});

test('DOC-PROVIDER-01: conflicting provider selections are rejected, not replaced', () => {
  assert.throws(
    () => validateModelSelectionInput({ provider: 'zai', model: 'moonshot/kimi-k3' }),
    /conflicts with model provider "moonshot"/,
  );
});

test('DOC-PROVIDER-01: usage identity derives the provider from the model prefix, never the engine', () => {
  // D09: a crush run over a moonshot model must keep the moonshot identity.
  assert.equal(resolveProvider('zai/glm-5.2'), 'zai');
  assert.equal(resolveProvider('moonshot/kimi-k3'), 'moonshot');
  assert.equal(resolveProvider('openai-compatible/deepseek-v4-pro'), 'openai-compatible');
  assert.equal(resolveProvider('crush'), null, 'the engine name is not a provider');
  assert.equal(resolveProvider('totally-unknown/model'), null, 'unknown identity stays unknown');
});

test('DOC-ENGINE-01: every engine accepts a subset of the canonical providers and crush accepts all', () => {
  assert.deepEqual([...CODER_ENGINE_ORDER], ['opencode', 'opencode2', 'crush', 'omp']);
  for (const id of CODER_ENGINE_ORDER) {
    const engine = CODER_ENGINE_REGISTRY[id];
    assert.ok(engine.providerKinds.length > 0, `${id} must declare providers`);
    for (const kind of engine.providerKinds) {
      assert.ok(
        CANONICAL_PROVIDER_IDS.includes(kind),
        `${id} declares non-canonical provider kind "${kind}"`,
      );
    }
  }
  // A01.1 regression: crush is provider-neutral since 0.44.0; its registry
  // metadata must not silently drift back to the historical Z.AI-only list.
  assert.deepEqual(
    [...CODER_ENGINE_REGISTRY.crush.providerKinds],
    [...CANONICAL_PROVIDER_IDS],
    'crush providerKinds drifted from provider-neutral reality',
  );
});

test('DOC-MCP-01: the documented core and coder tool lists match the runtime inventory', () => {
  const mcpDoc = fsReadFileSync(join(ROOT, 'docs', 'mcp.md'), 'utf8');

  const extractList = (heading) => {
    const section = mcpDoc.slice(mcpDoc.indexOf(heading));
    const rest = section.slice(section.indexOf('\n', section.indexOf('##') === 0 ? 0 : 0) + 1);
    const next = rest.indexOf('\n## ');
    const body = next === -1 ? rest : rest.slice(0, next);
    return [...body.matchAll(/^- `(triss_[a-z_]+)`/gm)].map((match) => match[1]);
  };

  const documentedCore = extractList('## Core tools');
  const documentedCoder = extractList('## Coder tools');

  const runtimeCore = assembleTools({ readyIntegrations: [], coderReady: false }).map((tool) => tool.name);
  const runtimeCoder = assembleTools({ readyIntegrations: [], coderReady: true })
    .map((tool) => tool.name)
    .filter((name) => !runtimeCore.includes(name));

  assert.deepEqual([...documentedCore].sort(), [...runtimeCore].sort());
  assert.deepEqual([...documentedCoder].sort(), [...runtimeCoder].sort());
});

test('DOC-PROVIDER-02: legacy endpoint variables stay out of current user-facing docs', () => {
  const legacyNames = ['TRISS_WORKER_BASE_URL', 'TRISS_WORKER_API_KEY', 'TRISS_WORKER_MODEL'];
  const allowlist = [
    'SECURITY.md', // names TRISS_WORKER_BASE_URL only as a migration input
    'CHANGELOG.md', // historical release notes
  ];
  const currentDocs = [
    'README.md',
    'docs/configuration.md',
    'docs/getting-started.md',
    'docs/mcp.md',
    'docs/cli-reference.md',
    'docs/security-model.md',
  ];
  for (const doc of currentDocs) {
    const text = readFileSync(join(ROOT, doc), 'utf8');
    for (const name of legacyNames) {
      assert.ok(
        !text.includes(name) || allowlist.includes(doc),
        `${doc} documents legacy variable ${name} as current configuration`,
      );
    }
  }
  // The SECURITY.md migration note must use the canonical field for setup.
  const security = readFileSync(join(ROOT, 'SECURITY.md'), 'utf8');
  assert.match(security, /TRISS_OPENAI_COMPATIBLE_BASE_URL/);
});

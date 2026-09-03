// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_CONTEXTUAL_PROVIDER_ALIASES,
  LEGACY_ENV_FIELD_MAP,
  LEGACY_INVENTORY,
  LEGACY_MODEL_PREFIX_MAP,
} from '../src/migration/legacy-inventory.js';

test('0.41 persisted provider vocabulary has one bounded migration inventory', () => {
  assert.deepEqual(LEGACY_ENV_FIELD_MAP, {
    TRISS_WORKER_API_KEY: 'TRISS_OPENAI_COMPATIBLE_API_KEY',
    TRISS_WORKER_BASE_URL: 'TRISS_OPENAI_COMPATIBLE_BASE_URL',
    TRISS_WORKER_PRO_MODEL: 'TRISS_OPENAI_COMPATIBLE_MODEL',
    TRISS_WORKER_FLASH_MODEL: 'TRISS_OPENAI_COMPATIBLE_SMALL_MODEL',
    TRISS_KIMI_BASE_URL: 'TRISS_MOONSHOT_BASE_URL',
  });
  assert.deepEqual(LEGACY_INVENTORY.envFields, [
    'TRISS_WORKER_API_KEY',
    'TRISS_WORKER_BASE_URL',
    'TRISS_WORKER_PRO_MODEL',
    'TRISS_WORKER_FLASH_MODEL',
    'TRISS_KIMI_BASE_URL',
    'TRISS_DEFAULT_MODEL',
    'TRISS_CODER_MODEL',
    'TRISS_CODER_SMALL_MODEL',
  ]);
  assert.deepEqual(LEGACY_INVENTORY.providerAliases, [
    'worker',
    'deepseek',
    'glm',
    'kimi',
    'openai',
  ]);
  assert.deepEqual(LEGACY_CONTEXTUAL_PROVIDER_ALIASES, ['openai-compatible']);
  assert.deepEqual(LEGACY_MODEL_PREFIX_MAP, {
    'triss-worker': 'openai-compatible',
    opencode: 'opencode-zen',
    moonshotai: 'moonshot',
    'moonshotai-cn': 'moonshot',
    'zai-coding-plan': 'zai',
  });
  assert.ok(Object.isFrozen(LEGACY_INVENTORY));
});

test('structured migration inventory distinguishes canonical target context', () => {
  assert.deepEqual(LEGACY_INVENTORY.structuredPaths, [
    { owner: 'opencode', path: ['provider', 'triss-worker'] },
    { owner: 'usage', path: ['provider'] },
    { owner: 'usage', path: ['model'] },
    { owner: 'managed-rule', path: ['triss'] },
  ]);
  assert.equal(
    LEGACY_INVENTORY.providerAliases.includes('openai-compatible'),
    false,
    'canonical ids must never enter the unconditional alias list',
  );
});

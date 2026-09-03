// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CANONICAL_PROVIDER_IDS,
  DEFAULT_PROVIDER_ID,
  MODEL_EFFORT_LEVELS,
  MODEL_SELECTION_FIELDS,
  PROVIDER_MODEL_ROLES,
  assertCanonicalProviderId,
  assertProviderModelRole,
  normalizeModelEffort,
  parseModelSelector,
  validateModelSelectionInput,
} from '../src/provider-contract.js';

test('provider contract exposes only canonical 0.42 provider ids', () => {
  assert.equal(DEFAULT_PROVIDER_ID, 'openai-compatible');
  assert.deepEqual(CANONICAL_PROVIDER_IDS, [
    'openai-compatible',
    'zai',
    'opencode-zen',
    'opencode-go',
    'moonshot',
    'kimi-for-coding',
  ]);
  assert.deepEqual(PROVIDER_MODEL_ROLES, ['model', 'smallModel']);
  assert.deepEqual(MODEL_SELECTION_FIELDS, ['provider', 'model', 'engine', 'effort']);
  for (const alias of ['worker', 'deepseek', 'glm', 'kimi', 'openai', 'triss-worker']) {
    assert.throws(() => assertCanonicalProviderId(alias), /Invalid provider/);
  }
  assert.ok(Object.isFrozen(CANONICAL_PROVIDER_IDS));
});

test('model selector splits only the first slash and preserves nested native ids', () => {
  assert.deepEqual(parseModelSelector('zai/glm-5.2'), {
    providerId: 'zai',
    nativeModel: 'glm-5.2',
    publicModel: 'zai/glm-5.2',
  });
  assert.deepEqual(parseModelSelector('openai-compatible/org/project/model'), {
    providerId: 'openai-compatible',
    nativeModel: 'org/project/model',
    publicModel: 'openai-compatible/org/project/model',
  });
  assert.deepEqual(parseModelSelector('glm-5.2'), {
    providerId: undefined,
    nativeModel: 'glm-5.2',
    publicModel: undefined,
  });
  assert.throws(() => parseModelSelector('worker/model'), /Invalid model provider/);
  assert.throws(() => parseModelSelector('zai/'), /Model id cannot be empty/);
  assert.throws(() => parseModelSelector(' zai/glm-5.2'), /surrounding whitespace/);
});

test('effort contract normalizes case and rejects unknown values', () => {
  assert.deepEqual(MODEL_EFFORT_LEVELS, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(normalizeModelEffort(undefined), undefined);
  assert.equal(normalizeModelEffort(' XHIGH '), 'xhigh');
  assert.equal(normalizeModelEffort('max'), 'max');
  assert.throws(() => normalizeModelEffort('auto'), /Invalid effort/);
  assert.throws(() => normalizeModelEffort(3), /Invalid effort/);
  assert.equal(assertProviderModelRole('smallModel'), 'smallModel');
  assert.throws(() => assertProviderModelRole('flash'), /Invalid model role/);
});

test('selection input rejects provider-qualified conflicts before execution', () => {
  assert.deepEqual(
    validateModelSelectionInput({
      provider: 'zai',
      model: 'zai/glm-5.2',
      engine: 'direct',
      effort: 'HIGH',
    }),
    {
      provider: 'zai',
      model: {
        providerId: 'zai',
        nativeModel: 'glm-5.2',
        publicModel: 'zai/glm-5.2',
      },
      engine: 'direct',
      effort: 'high',
    },
  );
  assert.throws(
    () => validateModelSelectionInput({ provider: 'moonshot', model: 'zai/glm-5.2' }),
    /conflicts with model provider/,
  );
  assert.throws(() => validateModelSelectionInput({ engine: '' }), /Engine must be/);
  assert.ok(Object.isFrozen(validateModelSelectionInput({})));
});

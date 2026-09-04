// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_CONFIG_ENV_KEYS,
  getProviderDefinition,
  listProviderDefinitions,
} from '../src/provider-registry.js';
import {
  createProviderConfigSnapshot,
  resolveProviderProfile,
} from '../src/provider-config.js';

function snapshot({ shell = {}, local = '', global = '' } = {}) {
  const content = new Map([
    ['/project/.triss.env', local],
    ['/home/.config/triss/.env', global],
  ]);
  return createProviderConfigSnapshot({
    parentEnv: shell,
    files: [
      { scope: 'local', path: '/project/.triss.env', exists: true },
      { scope: 'global', path: '/home/.config/triss/.env', exists: true },
    ],
    readFile: (path) => content.get(path),
  });
}

test('registry contains exactly the six canonical provider profiles', () => {
  assert.deepEqual(listProviderDefinitions().map(({ id }) => id), [
    'openai-compatible',
    'zai',
    'opencode-zen',
    'opencode-go',
    'moonshot',
    'kimi-for-coding',
  ]);
  assert.equal(getProviderDefinition('openai-compatible').credential, 'TRISS_OPENAI_COMPATIBLE_API_KEY');
  assert.equal(getProviderDefinition('kimi-for-coding').route.protocol, 'anthropic_messages');
  assert.throws(() => getProviderDefinition('worker'), /Invalid provider/);
  assert.ok(Object.isFrozen(getProviderDefinition('zai')));
  assert.ok(PROVIDER_CONFIG_ENV_KEYS.includes('TRISS_DEFAULT_PROVIDER'));
  assert.ok(PROVIDER_CONFIG_ENV_KEYS.includes('TRISS_DEFAULT_ENGINE'));
  assert.equal(new Set(PROVIDER_CONFIG_ENV_KEYS).size, PROVIDER_CONFIG_ENV_KEYS.length);
});

test('snapshot preserves shell local global and registry-default provenance', () => {
  const value = snapshot({
    shell: {
      TRISS_DEFAULT_PROVIDER: 'zai',
      TRISS_DEFAULT_ENGINE: 'opencode',
      TRISS_ZAI_MODEL: 'shell-main',
    },
    local: [
      'TRISS_ZAI_MODEL=local-main',
      'TRISS_ZAI_SMALL_MODEL=local-small',
      'TRISS_OPENAI_COMPATIBLE_MODEL=',
    ].join('\n'),
    global: [
      'TRISS_ZAI_MODEL=global-main',
      'TRISS_ZAI_SMALL_MODEL=global-small',
      'MOONSHOT_API_KEY=mk-global',
    ].join('\n'),
  });

  assert.deepEqual(value.defaultProvider, {
    value: 'zai', source: 'shell', scope: 'shell', path: null,
  });
  assert.deepEqual(value.defaultEngine, {
    value: 'opencode', source: 'shell', scope: 'shell', path: null,
  });
  assert.deepEqual(value.providers.zai.model, {
    value: 'shell-main', source: 'shell', scope: 'shell', path: null,
  });
  assert.deepEqual(value.providers.zai.smallModel, {
    value: 'local-small', source: 'config', scope: 'local', path: '/project/.triss.env',
  });
  assert.deepEqual(value.providers.moonshot.credential, {
    value: 'mk-global', source: 'config', scope: 'global', path: '/home/.config/triss/.env',
  });
  assert.deepEqual(value.providers['openai-compatible'].model, {
    value: '', source: 'config', scope: 'local', path: '/project/.triss.env',
  });
  assert.deepEqual(value.providers['opencode-go'].model, {
    value: 'deepseek-v4-flash', source: 'registry-default', scope: 'default', path: null,
  });
  assert.deepEqual(value.providers['opencode-go'].credential, {
    value: undefined, source: 'absent', scope: null, path: null,
  });
});

test('snapshot and every profile atom are immutable', () => {
  const value = snapshot();
  const profile = resolveProviderProfile(value, 'moonshot');
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.providers));
  assert.ok(Object.isFrozen(profile));
  assert.ok(Object.isFrozen(profile.model));
  assert.throws(() => { profile.model.value = 'changed'; }, TypeError);
  assert.throws(() => resolveProviderProfile(value, 'worker'), /Invalid provider/);
});

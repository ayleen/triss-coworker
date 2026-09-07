// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderConfigSnapshot } from '../src/provider-config.js';
import {
  resolveModelRequest,
  resolveModelSelection,
  resolveProviderRoute,
} from '../src/model-selection.js';

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

test('resolver uses configured default provider and main role', () => {
  const snapshot = config();
  const result = resolveModelSelection({}, snapshot);
  assert.equal(result.providerId, 'openai-compatible');
  assert.equal(result.publicModel, 'openai-compatible/deepseek-v4-pro');
  assert.equal(result.nativeModel, 'deepseek-v4-pro');
  assert.equal(result.role, 'model');
  assert.equal(result.engine, 'direct');
  assert.equal(result.effort, undefined);
  assert.equal(result.provenance.provider.source, 'registry-default');
  assert.equal(result.provenance.model.source, 'registry-default');
  assert.ok(Object.isFrozen(result));
});

test('configured default engine is persistent and lower precedence than request defaults', () => {
  const snapshot = config({
    local: 'TRISS_DEFAULT_ENGINE=opencode\n',
  });
  const configured = resolveModelSelection({}, snapshot);
  assert.equal(configured.engine, 'opencode');
  assert.equal(configured.provenance.engine.source, 'config');
  assert.equal(configured.provenance.engine.scope, 'local');

  const commandDefault = resolveModelSelection({ defaultEngine: 'omp' }, snapshot);
  assert.equal(commandDefault.engine, 'omp');
  assert.equal(commandDefault.provenance.engine.source, 'command-default');

  const explicit = resolveModelSelection({ defaultEngine: 'omp', engine: 'direct' }, snapshot);
  assert.equal(explicit.engine, 'direct');
  assert.equal(explicit.provenance.engine.source, 'explicit');
});

test('effort precedence: explicit > command default > configured > native default', () => {
  const snapshot = config({ local: 'TRISS_DEFAULT_EFFORT=high\n' });
  assert.equal(resolveModelSelection({}, snapshot).effort, 'high');
  assert.equal(resolveModelSelection({}, snapshot).provenance.effort.source, 'config');

  const commandDefault = resolveModelSelection({ defaultEffort: 'low' }, snapshot);
  assert.equal(commandDefault.effort, 'low');
  assert.equal(commandDefault.provenance.effort.source, 'command-default');

  const explicit = resolveModelSelection({ effort: 'max' }, snapshot);
  assert.equal(explicit.effort, 'max');
  assert.equal(explicit.provenance.effort.source, 'explicit');

  const absent = config();
  assert.equal(resolveModelSelection({}, absent).effort, undefined);
  assert.equal(resolveModelSelection({}, absent).provenance.effort.source, 'engine-native-default');

  assert.throws(
    () => resolveModelSelection({}, config({ local: 'TRISS_DEFAULT_EFFORT=turbo\n' })),
    /Invalid configured default effort in \/local/,
  );
});

test('resolver rejects invalid configured and command-default engines', () => {
  const invalid = config({ local: 'TRISS_DEFAULT_ENGINE=missing\n' });
  assert.throws(
    () => resolveModelSelection({}, invalid),
    /Invalid configured default engine in \/local "missing"/,
  );
  assert.throws(
    () => resolveModelSelection({ defaultEngine: 'missing' }, config()),
    /Invalid command default engine "missing"/,
  );
});

test('explicit provider with bare model preserves the native id', () => {
  const result = resolveModelSelection({
    provider: 'zai',
    model: 'glm-5.2',
    engine: 'omp',
    effort: 'XHIGH',
  }, config());
  assert.equal(result.providerId, 'zai');
  assert.equal(result.nativeModel, 'glm-5.2');
  assert.equal(result.publicModel, 'zai/glm-5.2');
  assert.equal(result.engine, 'omp');
  assert.equal(result.effort, 'xhigh');
  assert.equal(result.provenance.provider.source, 'explicit');
  assert.equal(result.provenance.model.source, 'explicit');
});

test('provider-qualified model selects provider and preserves nested ids', () => {
  const result = resolveModelSelection({
    model: 'openai-compatible/org/project/model',
    defaultEngine: 'opencode',
  }, config());
  assert.equal(result.providerId, 'openai-compatible');
  assert.equal(result.nativeModel, 'org/project/model');
  assert.equal(result.publicModel, 'openai-compatible/org/project/model');
  assert.equal(result.provenance.provider.source, 'model-prefix');
  assert.equal(result.provenance.engine.source, 'command-default');
});

test('resolver rejects provider conflicts and every legacy alias', () => {
  const snapshot = config();
  assert.throws(
    () => resolveModelSelection({ provider: 'moonshot', model: 'zai/glm-5.2' }, snapshot),
    /conflicts with model provider/,
  );
  for (const provider of ['worker', 'deepseek', 'glm', 'kimi', 'openai']) {
    assert.throws(() => resolveModelSelection({ provider }, snapshot), /Invalid provider/);
  }
});

test('main and small roles resolve independently and explicit model overrides either role', () => {
  const snapshot = config({
    local: [
      'TRISS_DEFAULT_PROVIDER=moonshot',
      'TRISS_MOONSHOT_MODEL=kimi-k3',
      'TRISS_MOONSHOT_SMALL_MODEL=kimi-k2.6',
    ].join('\n'),
  });
  assert.equal(resolveModelSelection({ role: 'model' }, snapshot).nativeModel, 'kimi-k3');
  assert.equal(resolveModelSelection({ role: 'smallModel' }, snapshot).nativeModel, 'kimi-k2.6');
  assert.equal(
    resolveModelSelection({ role: 'smallModel', model: 'kimi-k2.7-code' }, snapshot).nativeModel,
    'kimi-k2.7-code',
  );
  assert.throws(() => resolveModelSelection({ role: 'flash' }, snapshot), /Invalid model role/);
});

test('missing or cross-provider configured role fails before route execution', () => {
  const empty = config({ local: 'TRISS_ZAI_MODEL=\nTRISS_DEFAULT_PROVIDER=zai\n' });
  assert.throws(() => resolveModelSelection({}, empty), /has no configured model/);

  const conflicting = config({
    local: 'TRISS_DEFAULT_PROVIDER=zai\nTRISS_ZAI_MODEL=moonshot/kimi-k3\n',
  });
  assert.throws(() => resolveModelSelection({}, conflicting), /belongs to "moonshot"/);
});

test('route carries credential and endpoint provenance without re-reading config', () => {
  const snapshot = config({
    shell: { TRISS_DEFAULT_PROVIDER: 'moonshot' },
    local: 'TRISS_MOONSHOT_MODEL=kimi-k3\n',
    global: 'MOONSHOT_API_KEY=mk-secret\nTRISS_MOONSHOT_BASE_URL=https://api.moonshot.cn/v1\n',
  });
  const selection = resolveModelSelection({}, snapshot);
  const route = resolveProviderRoute(selection, snapshot);
  assert.equal(route.providerId, 'moonshot');
  assert.equal(route.publicModel, 'moonshot/kimi-k3');
  assert.equal(route.nativeModel, 'kimi-k3');
  assert.equal(route.credential.value, 'mk-secret');
  assert.equal(route.credential.scope, 'global');
  assert.equal(route.endpoint.value, 'https://api.moonshot.cn/v1');
  assert.equal(route.endpoint.path, '/global');
  assert.equal(route.transport, 'openai-chat');
  assert.ok(Object.isFrozen(route));

  const request = resolveModelRequest({ role: 'smallModel' }, snapshot);
  assert.equal(request.route.nativeModel, 'kimi-k2.6');
  assert.equal(request.route.provenance.model.source, 'registry-default');
});

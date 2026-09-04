// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODER_CREDENTIAL_MODES,
  CODER_OPENCODE_TRANSIENT_PROVIDER_ALIAS,
  CODER_TRANSIENT_PROVIDER_ALIAS,
  assertCoderCredentialMode,
  buildCoderTransientProviderOverlay,
  resolveCoderCredentialMode,
  resolveCoderProviderRoute,
  resolveCoderRuntimeProviderRoute,
} from '../src/coder-providers.js';

test('credential mode resolver: explicit --protect-credentials matrix over engines', () => {
  // Default (no options): OpenCode/OpenCode2 are best_effort_raw; crush is
  // ALWAYS protected regardless of the flag.
  for (const engine of ['opencode', 'opencode2']) {
    assert.equal(resolveCoderCredentialMode({ engine }), 'best_effort_raw', engine);
    assert.equal(
      resolveCoderCredentialMode({ engine, protectCredentials: true }),
      'protected_proxy',
      engine,
    );
  }
  for (const protectCredentials of [false, true, undefined]) {
    assert.equal(
      resolveCoderCredentialMode({ engine: 'crush', protectCredentials }),
      'protected_proxy',
      `crush with protectCredentials=${protectCredentials}`,
    );
  }
  // Any truthy value opts into protection: a plausible affirmative must not
  // silently resolve to raw credential exposure.
  for (const truthy of [true, 1, 'true', 'yes']) {
    assert.equal(resolveCoderCredentialMode({ engine: 'opencode', protectCredentials: truthy }), 'protected_proxy');
    assert.equal(resolveCoderCredentialMode({ engine: 'opencode2', protectCredentials: truthy }), 'protected_proxy');
  }
});

test('credential mode resolver ignores the retired legacy environment variable', () => {
  // The env contract is GONE: the resolver takes options only, so a stale
  // process.env value can never select a mode again. unset/0/1 all leave the
  // same result for every engine.
  const saved = process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
  try {
    for (const legacy of [undefined, '', '0', '1']) {
      if (legacy === undefined) delete process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
      else process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION = legacy;
      for (const engine of ['opencode', 'opencode2', 'crush']) {
        assert.equal(resolveCoderCredentialMode({ engine }), engine === 'crush' ? 'protected_proxy' : 'best_effort_raw');
        assert.equal(
          resolveCoderCredentialMode({ engine, protectCredentials: true }),
          'protected_proxy',
        );
      }
    }
  } finally {
    if (saved === undefined) delete process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
    else process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION = saved;
  }
});

test('credential modes are the closed best_effort_raw | protected_proxy set and validate fail-closed', () => {
  assert.deepEqual([...CODER_CREDENTIAL_MODES], ['best_effort_raw', 'protected_proxy']);
  for (const mode of CODER_CREDENTIAL_MODES) {
    assert.equal(assertCoderCredentialMode(mode), mode);
  }
  for (const bad of [undefined, null, '', 'raw', 'PROTECTED_PROXY', true]) {
    assert.throws(() => assertCoderCredentialMode(bad), /unsupported credential mode/u);
  }
});

test('runtime resolver requires a canonical provider-qualified model', () => {
  assert.equal(resolveCoderRuntimeProviderRoute('deepseek-v4-flash'), null);
  assert.equal(resolveCoderRuntimeProviderRoute('unknown/prefixed'), null);
  assert.equal(resolveCoderRuntimeProviderRoute('worker/model'), null);
});

test('canonical registry covers every provider and credential projection', () => {
  const cases = [
    ['openai-compatible/deepseek-v4-flash', 'openai-compatible', 'TRISS_OPENAI_COMPATIBLE_API_KEY', 'https://api.deepseek.com', '/v1', 'openai_chat'],
    ['zai/glm-5.2', 'zai', 'ZHIPU_API_KEY', 'https://api.z.ai', '/api/coding/paas/v4', 'openai_chat'],
    ['opencode-zen/deepseek-v4-flash', 'opencode-zen', 'OPENCODE_API_KEY', 'https://opencode.ai', '/zen/v1', 'openai_chat'],
    ['opencode-go/deepseek-v4-flash', 'opencode-go', 'OPENCODE_API_KEY', 'https://opencode.ai', '/zen/go/v1', 'openai_chat'],
    ['moonshot/kimi-k2.7-code', 'moonshot', 'MOONSHOT_API_KEY', 'https://api.moonshot.ai', '/v1', 'openai_chat'],
    ['kimi-for-coding/k3', 'kimi-for-coding', 'KIMI_API_KEY', 'https://api.kimi.com', '/coding/v1', 'anthropic_messages'],
  ];
  for (const [model, provider, credentialEnv, endpoint, pathPrefix, protocol] of cases) {
    const route = resolveCoderProviderRoute(model);
    assert.deepEqual(
      {
        provider: route.provider,
        credentialEnv: route.credentialEnv,
        endpoint: route.endpoint,
        pathPrefix: route.pathPrefix,
        protocol: route.protocol,
      },
      { provider, credentialEnv, endpoint, pathPrefix, protocol },
      model,
    );
  }
});

test('Zen and Go transport metadata stays model-specific and fail-closed', () => {
  const cases = [
    ['opencode-zen/deepseek-v4-flash-free', 'openai_chat', '@ai-sdk/openai-compatible'],
    ['opencode-zen/gpt-5.6-sol', 'openai_responses', '@ai-sdk/openai'],
    ['opencode-zen/claude-sonnet-4-5', 'anthropic_messages', '@ai-sdk/anthropic'],
    ['opencode-go/deepseek-v4-flash', 'openai_chat', '@ai-sdk/openai-compatible'],
    ['opencode-go/gpt-5.6-luna', 'openai_responses', '@ai-sdk/openai'],
    ['opencode-go/minimax-m3', 'anthropic_messages', '@ai-sdk/anthropic'],
  ];
  for (const [model, protocol, packageName] of cases) {
    const route = resolveCoderProviderRoute(model);
    assert.equal(route.transportAudited, true, model);
    assert.equal(route.protocol, protocol, model);
    assert.equal(route.package, packageName, model);
  }
  for (const model of [
    'opencode-zen/gemini-3.7-flash',
    'opencode-go/gemini-3.7-flash',
    'opencode-zen/new-model',
    'opencode-go/new-model',
  ]) {
    const route = resolveCoderProviderRoute(model);
    assert.equal(route.transportAudited, false, model);
    assert.equal(route.protocol, undefined, model);
  }
});

test('V1 OpenCode Go and Zen routes preserve the OpenCode request identity namespace', () => {
  for (const model of [
    'opencode-go/deepseek-v4-flash',
    'opencode-zen/deepseek-v4-flash-free',
  ]) {
    const route = resolveCoderProviderRoute(model);
    const overlay = buildCoderTransientProviderOverlay({
      route,
      model,
      baseURL: 'http://127.0.0.1:4321/zen/go/v1',
      credentialEnv: 'OPENCODE_API_KEY',
      preserveOpenCodeRequestIdentity: true,
    });
    assert.equal(
      overlay.model,
      `${CODER_OPENCODE_TRANSIENT_PROVIDER_ALIAS}/${route.modelId}`,
      model,
    );
    assert.ok(overlay.provider[CODER_OPENCODE_TRANSIENT_PROVIDER_ALIAS], model);
  }
});

test('distinct V1 main/small transports produce separate transient providers', () => {
  const mainRoute = resolveCoderProviderRoute('opencode-go/deepseek-v4-flash');
  const smallRoute = resolveCoderProviderRoute('opencode-go/muse-spark-1.2-contributor');
  const overlay = buildCoderTransientProviderOverlay({
    route: mainRoute,
    model: 'opencode-go/deepseek-v4-flash',
    smallModel: 'opencode-go/muse-spark-1.2-contributor',
    smallRoute,
    baseURL: 'http://127.0.0.1:4321/zen/go/v1',
    smallBaseURL: 'http://127.0.0.1:4322/zen/go/v1',
    credentialEnv: 'OPENCODE_API_KEY',
    preserveOpenCodeRequestIdentity: true,
  });
  const mainAlias = 'opencode-triss-coder-transient';
  const smallAlias = `${mainAlias}-small`;
  assert.equal(overlay.model, `${mainAlias}/deepseek-v4-flash`);
  assert.equal(overlay.small_model, `${smallAlias}/muse-spark-1.2-contributor`);
  assert.equal(overlay.provider[mainAlias].npm, '@ai-sdk/openai-compatible');
  assert.equal(overlay.provider[smallAlias].npm, '@ai-sdk/openai');
  assert.equal(overlay.provider[smallAlias].options.baseURL, 'http://127.0.0.1:4322/zen/go/v1');
});

test('distinct V1 models sharing one transport remain in the main transient provider', () => {
  const mainRoute = resolveCoderProviderRoute('opencode-go/deepseek-v4-flash');
  const smallRoute = resolveCoderProviderRoute('opencode-go/deepseek-v4-pro');
  const overlay = buildCoderTransientProviderOverlay({
    route: mainRoute,
    model: 'opencode-go/deepseek-v4-flash',
    smallModel: 'opencode-go/deepseek-v4-pro',
    smallRoute,
    baseURL: 'http://127.0.0.1:4321/zen/go/v1',
    credentialEnv: 'OPENCODE_API_KEY',
    preserveOpenCodeRequestIdentity: true,
  });
  const providerAlias = 'opencode-triss-coder-transient';
  assert.equal(overlay.model, `${providerAlias}/deepseek-v4-flash`);
  assert.equal(overlay.small_model, `${providerAlias}/deepseek-v4-pro`);
  assert.equal(overlay.provider[`${providerAlias}-small`], undefined);
  assert.deepEqual(overlay.provider[providerAlias].models, {
    'deepseek-v4-flash': { name: 'deepseek-v4-flash' },
    'deepseek-v4-pro': { name: 'deepseek-v4-pro' },
  });
});

test('transient protected overlay pins package, proxy URL, env reference, and main/small aliases', () => {
  const model = 'kimi-for-coding/k3';
  const small = 'kimi-for-coding/kimi-k2.6';
  const route = resolveCoderProviderRoute(model);
  const overlay = buildCoderTransientProviderOverlay({
    route,
    model,
    smallModel: small,
    baseURL: 'http://127.0.0.1:4321/coding/v1',
    credentialEnv: route.credentialEnv,
  });
  const provider = overlay.provider[CODER_TRANSIENT_PROVIDER_ALIAS];
  assert.equal(overlay.model, `${CODER_TRANSIENT_PROVIDER_ALIAS}/k3`);
  assert.equal(overlay.small_model, `${CODER_TRANSIENT_PROVIDER_ALIAS}/kimi-k2.6`);
  assert.equal(provider.npm, '@ai-sdk/anthropic');
  assert.equal(provider.options.baseURL, 'http://127.0.0.1:4321/coding/v1');
  assert.equal(provider.options.apiKey, '{env:KIMI_API_KEY}');
  assert.deepEqual(provider.models, {
    k3: { name: 'k3' },
    'kimi-k2.6': { name: 'kimi-k2.6' },
  });
  assert.doesNotMatch(JSON.stringify(overlay), /sk-|real|secret/i);
});

test('V2 transient overlay intentionally omits the unused small-model role', () => {
  const model = 'opencode-go/deepseek-v4-flash';
  const route = resolveCoderProviderRoute(model);
  const overlay = buildCoderTransientProviderOverlay({
    route,
    model,
    smallModel: 'opencode-go/deepseek-v4-pro',
    baseURL: 'http://127.0.0.1:4321/zen/go/v1',
    credentialEnv: route.credentialEnv,
    includeSmallModel: false,
  });
  assert.equal(overlay.small_model, undefined);
  assert.equal(
    overlay.provider[CODER_TRANSIENT_PROVIDER_ALIAS].npm,
    '@ai-sdk/openai-compatible',
  );
});

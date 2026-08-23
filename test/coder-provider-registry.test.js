import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODER_CREDENTIAL_MODES,
  CODER_PROVIDER_REGISTRY,
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

test('runtime resolver preserves the historical bare-model Z.AI route', () => {
  const route = resolveCoderRuntimeProviderRoute('deepseek-v4-flash');
  assert.equal(route.model, 'deepseek-v4-flash');
  assert.equal(route.provider, 'zai');
  assert.equal(route.endpoint, 'https://api.z.ai');
  assert.equal(resolveCoderRuntimeProviderRoute('unknown/prefixed'), null);
});

test('canonical registry covers every advertised provider prefix and transport', () => {
  const cases = [
    ['triss-worker/model', 'worker', 'TRISS_WORKER_API_KEY', 'openai_chat'],
    ['zai-coding-plan/model', 'zai', 'ZHIPU_API_KEY', 'openai_chat'],
    ['zai/model', 'zai', 'ZHIPU_API_KEY', 'openai_chat'],
    ['opencode/model', 'opencode-zen', 'OPENCODE_API_KEY', 'openai_chat'],
    ['opencode-go/model', 'opencode-go', 'OPENCODE_API_KEY', 'openai_chat'],
    ['moonshotai/model', 'moonshot', 'MOONSHOT_API_KEY', 'openai_chat'],
    ['moonshotai-cn/model', 'moonshot', 'MOONSHOT_API_KEY', 'openai_chat'],
    ['kimi-for-coding/model', 'kimi-for-coding', 'KIMI_API_KEY', 'anthropic_messages'],
  ];
  for (const [model, kind, env, protocol] of cases) {
    const prefix = model.split('/')[0];
    const entry = Object.values(CODER_PROVIDER_REGISTRY).find((candidate) => candidate.prefixes.includes(prefix));
    assert.equal(entry.kind, kind);
    assert.equal(entry.credentialEnv, env);
    assert.equal(entry.protocol, protocol);
  }
  assert.equal(CODER_PROVIDER_REGISTRY['opencode-go'].modelOverrides['muse-spark-1.2-contributor'].protocol, 'openai_responses');
  assert.equal(CODER_PROVIDER_REGISTRY['opencode-go'].modelOverrides['grok-4.5'].protocol, 'openai_responses');
  assert.equal(CODER_PROVIDER_REGISTRY['opencode-go'].modelOverrides['grok-4.5'].package, '@ai-sdk/openai');
});

test('canonical resolver derives endpoint, transport, and credential for every prefix', () => {
  const cases = [
    ['triss-worker/deepseek-v4-flash', 'TRISS_WORKER_API_KEY', 'https://api.deepseek.com', '/v1', 'openai_chat'],
    ['zai-coding-plan/glm-5.2', 'ZHIPU_API_KEY', 'https://api.z.ai', '/api/coding/paas/v4', 'openai_chat'],
    ['zai/glm-5.2', 'ZHIPU_API_KEY', 'https://api.z.ai', '/api/paas/v4', 'openai_chat'],
    ['opencode/deepseek-v4-flash', 'OPENCODE_API_KEY', 'https://opencode.ai', '/zen/v1', 'openai_chat'],
    ['opencode-go/deepseek-v4-flash', 'OPENCODE_API_KEY', 'https://opencode.ai', '/zen/go/v1', 'openai_chat'],
    ['moonshotai/kimi-k2.7-code', 'MOONSHOT_API_KEY', 'https://api.moonshot.ai', '/v1', 'openai_chat'],
    ['moonshotai-cn/kimi-k2.7-code', 'MOONSHOT_API_KEY', 'https://api.moonshot.cn', '/v1', 'openai_chat'],
    ['kimi-for-coding/k3', 'KIMI_API_KEY', 'https://api.kimi.com', '/coding/v1', 'anthropic_messages'],
    ['opencode-go/muse-spark-1.2-contributor', 'OPENCODE_API_KEY', 'https://opencode.ai', '/zen/go/v1', 'openai_responses'],
    ['opencode-go/grok-4.5', 'OPENCODE_API_KEY', 'https://opencode.ai', '/zen/go/v1', 'openai_responses'],
  ];
  for (const [model, credentialEnv, endpoint, pathPrefix, protocol] of cases) {
    const route = resolveCoderProviderRoute(model);
    assert.deepEqual(
      { credentialEnv: route.credentialEnv, endpoint: route.endpoint, pathPrefix: route.pathPrefix, protocol: route.protocol },
      { credentialEnv, endpoint, pathPrefix, protocol },
      model,
    );
  }
  assert.equal(resolveCoderProviderRoute('unknown/model'), null);
  assert.equal(resolveCoderProviderRoute('zai/too/many/slashes'), null);
});

test('secure Zen offline fallback candidates are all transport-audited', () => {
  for (const model of [
    'opencode/deepseek-v4-flash-free',
    'opencode/nemotron-3-ultra-free',
    'opencode/mimo-v2.5-free',
  ]) {
    assert.equal(resolveCoderProviderRoute(model).transportAudited, true, model);
  }
  assert.equal(resolveCoderProviderRoute('opencode/north-mini-code-free').transportAudited, false);
});

test('Zen and Go transport metadata is model-specific and fail-closed', () => {
  const cases = [
    ['opencode/deepseek-v4-flash-free', 'openai_chat', '@ai-sdk/openai-compatible'],
    ['opencode/gpt-5.6-sol', 'openai_responses', '@ai-sdk/openai'],
    ['opencode/claude-sonnet-4-5', 'anthropic_messages', '@ai-sdk/anthropic'],
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
  for (const model of ['opencode/gemini-3.7-flash', 'opencode-go/gemini-3.7-flash', 'opencode/new-model', 'opencode-go/new-model']) {
    const route = resolveCoderProviderRoute(model);
    assert.equal(route.transportAudited, false, model);
    assert.equal(route.protocol, undefined, model);
  }
});

test('published 2026-08-22 Zen and Go endpoint tables are fully audited', () => {
  const published = {
    openai_chat: [
      'opencode/deepseek-v4-pro', 'opencode/deepseek-v4-flash',
      'opencode/minimax-m3', 'opencode/minimax-m2.7', 'opencode/minimax-m2.5',
      'opencode/glm-5.2', 'opencode/glm-5.1', 'opencode/glm-5',
      'opencode/kimi-k2.5', 'opencode/kimi-k2.6', 'opencode/kimi-k2.7-code', 'opencode/kimi-k3',
      'opencode/big-pickle', 'opencode/x-preview-f-free', 'opencode/mimo-v2.5-free',
      'opencode/hy3-free', 'opencode/nemotron-3-ultra-free', 'opencode/nemotron-3.5-lightning-free',
      'opencode-go/glm-5.3', 'opencode-go/glm-5.2', 'opencode-go/glm-5.1',
      'opencode-go/kimi-k3', 'opencode-go/kimi-k2.7-code', 'opencode-go/kimi-k2.6',
      'opencode-go/deepseek-v4-pro', 'opencode-go/deepseek-v4-flash',
      'opencode-go/deepseek-v4-flash-vision-exp', 'opencode-go/mimo-v2.5',
      'opencode-go/mimo-v2.5-pro', 'opencode-go/hy3', 'opencode-go/ox-alpha-free',
    ],
    openai_responses: [
      'opencode/gpt-5.6-sol', 'opencode/gpt-5.6-terra', 'opencode/gpt-5.6-luna',
      'opencode/gpt-5.5', 'opencode/gpt-5.5-pro', 'opencode/gpt-5.4',
      'opencode/gpt-5.4-pro', 'opencode/gpt-5.4-mini', 'opencode/gpt-5.4-nano',
      'opencode/gpt-5.3-codex', 'opencode/gpt-5.3-codex-spark',
      'opencode/gpt-5.2', 'opencode/gpt-5.2-codex', 'opencode/gpt-5.1',
      'opencode/gpt-5.1-codex', 'opencode/gpt-5.1-codex-max', 'opencode/gpt-5.1-codex-mini',
      'opencode/gpt-5', 'opencode/gpt-5-codex', 'opencode/gpt-5-nano',
      'opencode/grok-4.6', 'opencode/grok-4.5', 'opencode/grok-build-0.1',
      'opencode/muse-spark-1.2', 'opencode/muse-spark-1.2-contributor-free',
      'opencode-go/grok-4.5', 'opencode-go/gpt-5.6-luna',
      'opencode-go/muse-spark-1.2-contributor',
    ],
    anthropic_messages: [
      'opencode/claude-fable-5', 'opencode/claude-opus-5', 'opencode/claude-opus-4-8',
      'opencode/claude-opus-4-7', 'opencode/claude-opus-4-6', 'opencode/claude-opus-4-5',
      'opencode/claude-sonnet-5', 'opencode/claude-sonnet-4-6',
      'opencode/claude-sonnet-4-5', 'opencode/claude-haiku-4-5',
      'opencode/qwen3.7-max', 'opencode/qwen3.7-plus',
      'opencode/qwen3.6-plus', 'opencode/qwen3.5-plus',
      'opencode-go/minimax-m3', 'opencode-go/minimax-m2.7', 'opencode-go/minimax-m2.5',
      'opencode-go/qwen3.8-max', 'opencode-go/qwen3.7-max',
      'opencode-go/qwen3.7-plus', 'opencode-go/qwen3.6-plus',
    ],
  };
  for (const [protocol, models] of Object.entries(published)) {
    for (const model of models) {
      const route = resolveCoderProviderRoute(model);
      assert.equal(route.transportAudited, true, model);
      assert.equal(route.protocol, protocol, model);
    }
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
  });
  assert.equal(overlay.small_model, `${CODER_TRANSIENT_PROVIDER_ALIAS}-small/muse-spark-1.2-contributor`);
  assert.equal(overlay.provider[CODER_TRANSIENT_PROVIDER_ALIAS].npm, '@ai-sdk/openai-compatible');
  assert.equal(overlay.provider[`${CODER_TRANSIENT_PROVIDER_ALIAS}-small`].npm, '@ai-sdk/openai');
  assert.equal(overlay.provider[`${CODER_TRANSIENT_PROVIDER_ALIAS}-small`].options.baseURL, 'http://127.0.0.1:4322/zen/go/v1');
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
  });
  assert.equal(overlay.small_model, `${CODER_TRANSIENT_PROVIDER_ALIAS}/deepseek-v4-pro`);
  assert.equal(overlay.provider[`${CODER_TRANSIENT_PROVIDER_ALIAS}-small`], undefined);
  assert.deepEqual(overlay.provider[CODER_TRANSIENT_PROVIDER_ALIAS].models, {
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
  assert.equal(overlay.provider[CODER_TRANSIENT_PROVIDER_ALIAS].npm, '@ai-sdk/openai-compatible');
});

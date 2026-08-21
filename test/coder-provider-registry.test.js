import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODER_PROVIDER_REGISTRY,
  CODER_TRANSIENT_PROVIDER_ALIAS,
  buildCoderTransientProviderOverlay,
  resolveCoderCredentialMode,
  resolveCoderProviderRoute,
} from '../src/coder-providers.js';

test('credential mode requires the literal one acknowledgement and is not caller-worktree isolation', () => {
  assert.equal(resolveCoderCredentialMode({}), 'protected_proxy');
  assert.equal(resolveCoderCredentialMode({ TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION: '1' }), 'best_effort_raw');
  for (const value of ['true', 'yes', 'on', '01', 1, true]) {
    assert.equal(resolveCoderCredentialMode({ TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION: value }), 'protected_proxy');
  }
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

const freeze = (value) => Object.freeze(value);

// This name is deliberately stable and owned by Triss.  It is used only in
// OPENCODE_CONFIG_CONTENT for one run; persistent config layers defining it
// are rejected before a credential-bearing child is spawned.
export const CODER_TRANSIENT_PROVIDER_ALIAS = 'triss-coder-transient';

export const CODER_PROVIDER_REGISTRY = freeze({
  worker: freeze({ kind: 'worker', prefixes: freeze(['triss-worker']), credentialEnv: 'TRISS_WORKER_API_KEY', endpoint: 'https://api.deepseek.com', pathPrefix: '/v1', protocol: 'openai_chat', package: '@ai-sdk/openai-compatible', authStyle: 'bearer' }),
  zai: freeze({ kind: 'zai', prefixes: freeze(['zai-coding-plan', 'zai']), credentialEnv: 'ZHIPU_API_KEY', endpoint: 'https://api.z.ai', pathPrefixByPrefix: freeze({ 'zai-coding-plan': '/api/coding/paas/v4', zai: '/api/paas/v4' }), protocol: 'openai_chat', package: '@ai-sdk/openai-compatible', authStyle: 'bearer' }),
  'opencode-zen': freeze({ kind: 'opencode-zen', prefixes: freeze(['opencode']), credentialEnv: 'OPENCODE_API_KEY', endpoint: 'https://opencode.ai', pathPrefix: '/zen/v1', protocol: 'openai_chat', package: '@ai-sdk/openai-compatible', authStyle: 'bearer' }),
  'opencode-go': freeze({ kind: 'opencode-go', prefixes: freeze(['opencode-go']), credentialEnv: 'OPENCODE_API_KEY', endpoint: 'https://opencode.ai', pathPrefix: '/zen/go/v1', protocol: 'openai_chat', package: '@ai-sdk/openai-compatible', authStyle: 'bearer', modelOverrides: freeze({ 'muse-spark-1.2-contributor': freeze({ protocol: 'openai_responses', package: '@ai-sdk/openai' }) }) }),
  moonshot: freeze({ kind: 'moonshot', prefixes: freeze(['moonshotai', 'moonshotai-cn']), credentialEnv: 'MOONSHOT_API_KEY', endpointByPrefix: freeze({ moonshotai: 'https://api.moonshot.ai', 'moonshotai-cn': 'https://api.moonshot.cn' }), pathPrefix: '/v1', protocol: 'openai_chat', package: '@ai-sdk/openai-compatible', authStyle: 'bearer' }),
  'kimi-for-coding': freeze({ kind: 'kimi-for-coding', prefixes: freeze(['kimi-for-coding']), credentialEnv: 'KIMI_API_KEY', endpoint: 'https://api.kimi.com', pathPrefix: '/coding/v1', protocol: 'anthropic_messages', package: '@ai-sdk/anthropic', authStyle: 'anthropic' }),
});

export const CODER_PROVIDER_ALIASES = freeze({ glm: 'zai', deepseek: 'worker', kimi: 'moonshot', go: 'opencode-go', zen: 'opencode-zen' });

// Credential mode is intentionally independent from caller-worktree
// isolation. Only the literal acknowledgement opts into raw best-effort.
export function resolveCoderCredentialMode(env = process.env) {
  return env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION === '1'
    ? 'best_effort_raw'
    : 'protected_proxy';
}

/**
 * Resolve a qualified model into the one canonical provider route.  This is
 * deliberately pure: callers still decide whether the route is protected by
 * the credential proxy or uses the explicitly acknowledged raw mode.
 */
export function resolveCoderProviderRoute(model, registry = CODER_PROVIDER_REGISTRY) {
  const qualified = String(model || '').trim();
  const slash = qualified.indexOf('/');
  if (slash <= 0 || slash === qualified.length - 1 || qualified.slice(slash + 1).includes('/')) return null;
  const prefix = qualified.slice(0, slash);
  const modelId = qualified.slice(slash + 1);
  const provider = Object.values(registry).find((candidate) => candidate.prefixes.includes(prefix));
  if (!provider) return null;
  const override = provider.modelOverrides?.[modelId] || {};
  return Object.freeze({
    model: qualified,
    modelId,
    prefix,
    provider: provider.kind,
    credentialEnv: provider.credentialEnv,
    endpoint: provider.endpointByPrefix?.[prefix] || provider.endpoint,
    pathPrefix: provider.pathPrefixByPrefix?.[prefix] || provider.pathPrefix,
    protocol: override.protocol || provider.protocol,
    package: override.package || provider.package,
    authStyle: provider.authStyle,
  });
}

/**
 * Build the provider/model projection used by both supported OpenCode
 * engines.  The credential is never embedded: OpenCode resolves the env
 * reference inside the child, where that selected env contains only the
 * run-scoped proxy token in protected mode.
 */
export function buildCoderTransientProviderOverlay({
  route,
  model,
  smallModel,
  baseURL,
  credentialEnv,
  includeSmallModel = true,
} = {}) {
  if (!route || typeof route !== 'object') throw new TypeError('buildCoderTransientProviderOverlay: route is required');
  if (typeof model !== 'string' || !model) throw new TypeError('buildCoderTransientProviderOverlay: model is required');
  if (typeof baseURL !== 'string' || !baseURL) throw new TypeError('buildCoderTransientProviderOverlay: baseURL is required');
  if (typeof credentialEnv !== 'string' || !credentialEnv) throw new TypeError('buildCoderTransientProviderOverlay: credentialEnv is required');
  const modelId = route.modelId || model.slice(model.indexOf('/') + 1);
  const main = `${CODER_TRANSIENT_PROVIDER_ALIAS}/${modelId}`;
  const smallId = typeof smallModel === 'string' && smallModel.includes('/')
    ? smallModel.slice(smallModel.indexOf('/') + 1)
    : null;
  const models = { [modelId]: { name: modelId } };
  if (includeSmallModel && smallId) models[smallId] = { name: smallId };
  return {
    model: main,
    ...(includeSmallModel && smallId ? { small_model: `${CODER_TRANSIENT_PROVIDER_ALIAS}/${smallId}` } : {}),
    provider: {
      [CODER_TRANSIENT_PROVIDER_ALIAS]: {
        npm: route.package,
        name: `Triss transient ${route.provider}`,
        options: {
          baseURL,
          apiKey: `{env:${credentialEnv}}`,
        },
        models,
      },
    },
  };
}

export const CODER_PROVIDER_CREDENTIALS = Object.freeze([
  Object.freeze({ label: 'triss-worker', env: 'TRISS_WORKER_API_KEY' }),
  Object.freeze({ label: 'zai-coding-plan', env: 'ZHIPU_API_KEY' }),
  Object.freeze({ label: 'opencode-zen/go', env: 'OPENCODE_API_KEY' }),
  Object.freeze({ label: 'moonshot', env: 'MOONSHOT_API_KEY' }),
  Object.freeze({ label: 'kimi-for-coding', env: 'KIMI_API_KEY' }),
]);

export function coderCredentialReady(env = process.env) {
  return CODER_PROVIDER_CREDENTIALS.some((provider) => !!env[provider.env]);
}

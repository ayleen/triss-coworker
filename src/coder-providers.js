const freeze = (value) => Object.freeze(value);

// This name is deliberately stable and owned by Triss.  It is used only in
// OPENCODE_CONFIG_CONTENT for one run; persistent config layers defining it
// are rejected before a credential-bearing child is spawned.
export const CODER_TRANSIENT_PROVIDER_ALIAS = 'triss-coder-transient';

const OPENAI_CHAT_ROUTE = freeze({ protocol: 'openai_chat', package: '@ai-sdk/openai-compatible' });
const OPENAI_RESPONSES_ROUTE = freeze({ protocol: 'openai_responses', package: '@ai-sdk/openai' });
const ANTHROPIC_MESSAGES_ROUTE = freeze({
  protocol: 'anthropic_messages',
  package: '@ai-sdk/anthropic',
  authStyle: 'anthropic',
});
const UNSUPPORTED_GOOGLE_ROUTE = freeze({
  unsupported: 'google/gemini transport is not vetted by the protected proxy',
});

function modelTransportMap({ chat = [], responses = [], anthropic = [], unsupportedGoogle = [] }) {
  const entries = [
    ...chat.map((id) => [id, OPENAI_CHAT_ROUTE]),
    ...responses.map((id) => [id, OPENAI_RESPONSES_ROUTE]),
    ...anthropic.map((id) => [id, ANTHROPIC_MESSAGES_ROUTE]),
    ...unsupportedGoogle.map((id) => [id, UNSUPPORTED_GOOGLE_ROUTE]),
  ];
  const seen = new Set();
  for (const [id] of entries) {
    if (seen.has(id)) throw new Error(`duplicate audited OpenCode transport metadata for model ${id}`);
    seen.add(id);
  }
  return freeze(Object.fromEntries(entries));
}

export const CODER_PROVIDER_REGISTRY = freeze({
  worker: freeze({ kind: 'worker', prefixes: freeze(['triss-worker']), credentialEnv: 'TRISS_WORKER_API_KEY', endpoint: 'https://api.deepseek.com', pathPrefix: '/v1', protocol: 'openai_chat', package: '@ai-sdk/openai-compatible', authStyle: 'bearer' }),
  zai: freeze({ kind: 'zai', prefixes: freeze(['zai-coding-plan', 'zai']), credentialEnv: 'ZHIPU_API_KEY', endpoint: 'https://api.z.ai', pathPrefixByPrefix: freeze({ 'zai-coding-plan': '/api/coding/paas/v4', zai: '/api/paas/v4' }), protocol: 'openai_chat', package: '@ai-sdk/openai-compatible', authStyle: 'bearer' }),
  // OpenCode's catalogue is model/provider specific. Keep the provider
  // defaults for catalogue/status compatibility, but the runtime resolver
  // below only admits an exact audited model entry for Zen/Go. An unknown
  // model must never silently become Chat Completions.
  'opencode-zen': freeze({
    kind: 'opencode-zen',
    prefixes: freeze(['opencode']),
    credentialEnv: 'OPENCODE_API_KEY',
    endpoint: 'https://opencode.ai',
    pathPrefix: '/zen/v1',
    protocol: 'openai_chat',
    package: '@ai-sdk/openai-compatible',
    authStyle: 'bearer',
    // Audited against https://opencode.ai/docs/zen/ on 2026-08-22. Models
    // present only in the catalogue remain unaudited until endpoint/package
    // metadata is published.
    modelOverrides: modelTransportMap({
      chat: [
        'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-free',
        'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
        'glm-5.2', 'glm-5.1', 'glm-5',
        'kimi-k2.5', 'kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3',
        'big-pickle', 'x-preview-f-free', 'mimo-v2.5-free', 'hy3-free',
        'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free',
      ],
      responses: [
        'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
        'gpt-5.5', 'gpt-5.5-pro',
        'gpt-5.4', 'gpt-5.4-pro', 'gpt-5.4-mini', 'gpt-5.4-nano',
        'gpt-5.3-codex', 'gpt-5.3-codex-spark',
        'gpt-5.2', 'gpt-5.2-codex',
        'gpt-5.1', 'gpt-5.1-codex', 'gpt-5.1-codex-max', 'gpt-5.1-codex-mini',
        'gpt-5', 'gpt-5-codex', 'gpt-5-nano',
        'grok-4.6', 'grok-4.5', 'grok-build-0.1',
        'muse-spark-1.2', 'muse-spark-1.2-contributor-free',
      ],
      anthropic: [
        'claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7',
        'claude-opus-4-6', 'claude-opus-4-5', 'claude-sonnet-5',
        'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5',
        'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus', 'qwen3.5-plus',
      ],
      // Google/Gemini requires @ai-sdk/google and /models/*, which the
      // credential proxy deliberately does not implement yet.
      unsupportedGoogle: [
        'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash',
        'gemini-3.5-flash-lite', 'gemini-3.1-pro', 'gemini-3-flash',
      ],
    }),
  }),
  'opencode-go': freeze({
    kind: 'opencode-go',
    prefixes: freeze(['opencode-go']),
    credentialEnv: 'OPENCODE_API_KEY',
    endpoint: 'https://opencode.ai',
    pathPrefix: '/zen/go/v1',
    protocol: 'openai_chat',
    package: '@ai-sdk/openai-compatible',
    authStyle: 'bearer',
    // Audited against https://opencode.ai/docs/go/ on 2026-08-22.
    modelOverrides: modelTransportMap({
      chat: [
        'glm-5.3', 'glm-5.2', 'glm-5.1',
        'kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6',
        'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp',
        'mimo-v2.5', 'mimo-v2.5-pro', 'hy3', 'ox-alpha-free',
      ],
      responses: ['grok-4.5', 'gpt-5.6-luna', 'muse-spark-1.2-contributor'],
      anthropic: [
        'minimax-m3', 'minimax-m2.7', 'minimax-m2.5',
        'qwen3.8-max', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus',
      ],
    }),
  }),
  moonshot: freeze({ kind: 'moonshot', prefixes: freeze(['moonshotai', 'moonshotai-cn']), credentialEnv: 'MOONSHOT_API_KEY', endpointByPrefix: freeze({ moonshotai: 'https://api.moonshot.ai', 'moonshotai-cn': 'https://api.moonshot.cn' }), pathPrefix: '/v1', protocol: 'openai_chat', package: '@ai-sdk/openai-compatible', authStyle: 'bearer' }),
  'kimi-for-coding': freeze({ kind: 'kimi-for-coding', prefixes: freeze(['kimi-for-coding']), credentialEnv: 'KIMI_API_KEY', endpoint: 'https://api.kimi.com', pathPrefix: '/coding/v1', protocol: 'anthropic_messages', package: '@ai-sdk/anthropic', authStyle: 'anthropic' }),
});

export const CODER_PROVIDER_ALIASES = freeze({ glm: 'zai', deepseek: 'worker', kimi: 'moonshot', go: 'opencode-go', zen: 'opencode-zen' });

// Credential mode is intentionally independent from caller-worktree
// isolation. This resolver is the SINGLE source of truth for the public
// contract: every entry point (CLI run/init/exec, config wizard, MCP) resolves
// the mode HERE from explicit user intent (--protect-credentials), and all
// internal helpers receive the already-resolved value. There is intentionally
// NO environment fallback — the retired TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION
// acknowledgement must never select a mode again (its value is a deprecated
// no-op; see readLegacyCoderBestEffortEnv in config.js).
//
//   | engine    | without the flag | with --protect-credentials        |
//   |-----------|------------------|-----------------------------------|
//   | opencode  | best_effort_raw  | protected_proxy                   |
//   | opencode2 | best_effort_raw  | protected_proxy                   |
//   | crush     | protected_proxy  | protected_proxy (flag is a no-op) |
export const CODER_CREDENTIAL_MODES = Object.freeze(['best_effort_raw', 'protected_proxy']);

export function resolveCoderCredentialMode({
  protectCredentials = false,
  engine,
} = {}) {
  if (engine === 'crush') return 'protected_proxy';

  return protectCredentials === true
    ? 'protected_proxy'
    : 'best_effort_raw';
}

// Internal helpers must never invent a mode. Validate the already-resolved
// value at the boundary so a forgotten argument fails loudly instead of
// silently re-enabling a hidden protected_proxy default.
export function assertCoderCredentialMode(credentialMode) {
  if (!CODER_CREDENTIAL_MODES.includes(credentialMode)) {
    throw new TypeError(
      `unsupported credential mode ${JSON.stringify(credentialMode)} — expected one of: ${CODER_CREDENTIAL_MODES.join(' | ')}. `,
    );
  }
  return credentialMode;
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
  const override = provider.modelOverrides?.[modelId] || null;
  const modelSpecificTransport = provider.kind === 'opencode-zen' || provider.kind === 'opencode-go';
  const transport = modelSpecificTransport ? override : (override || provider);
  return Object.freeze({
    model: qualified,
    modelId,
    prefix,
    provider: provider.kind,
    credentialEnv: provider.credentialEnv,
    endpoint: provider.endpointByPrefix?.[prefix] || provider.endpoint,
    pathPrefix: provider.pathPrefixByPrefix?.[prefix] || provider.pathPrefix,
    protocol: transport?.protocol,
    package: transport?.package,
    authStyle: transport?.authStyle || provider.authStyle,
    transportAudited: !modelSpecificTransport || Boolean(override && !override.unsupported),
    unsupportedTransport: override?.unsupported || null,
  });
}

// Historical V1 compatibility: a safe bare model id has always meant the
// Z.AI PAYG route. Keep that rule in the shared resolver so runtime and status
// cannot disagree about a model that `triss coder run` will accept.
export function resolveCoderRuntimeProviderRoute(model, registry = CODER_PROVIDER_REGISTRY) {
  const direct = resolveCoderProviderRoute(model, registry);
  if (direct) return direct;
  const bare = String(model || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(bare)) return null;
  const historical = resolveCoderProviderRoute(`zai/${bare}`, registry);
  return historical ? Object.freeze({ ...historical, model: bare }) : null;
}

export function coderRoutesShareTransport(left, right) {
  return Boolean(left && right &&
    left.provider === right.provider &&
    left.endpoint === right.endpoint &&
    left.pathPrefix === right.pathPrefix &&
    left.protocol === right.protocol &&
    left.package === right.package &&
    left.authStyle === right.authStyle);
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
  smallRoute,
  baseURL,
  smallBaseURL,
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
  const separateSmall = Boolean(
    includeSmallModel && smallId && smallRoute && !coderRoutesShareTransport(smallRoute, route),
  );
  if (includeSmallModel && smallId && !separateSmall) models[smallId] = { name: smallId };
  const smallAlias = separateSmall ? `${CODER_TRANSIENT_PROVIDER_ALIAS}-small` : CODER_TRANSIENT_PROVIDER_ALIAS;
  const smallProvider = separateSmall
    ? {
      npm: smallRoute.package,
      name: `Triss transient ${smallRoute.provider}`,
      options: {
        baseURL: smallBaseURL || baseURL,
        apiKey: `{env:${credentialEnv}}`,
      },
      models: { [smallId]: { name: smallId } },
    }
    : null;
  return {
    model: main,
    ...(includeSmallModel && smallId ? { small_model: `${smallAlias}/${smallId}` } : {}),
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
      ...(smallProvider ? { [smallAlias]: smallProvider } : {}),
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

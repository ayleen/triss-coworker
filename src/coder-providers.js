// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { getProviderDefinition } from './provider-registry.js';

const freeze = (value) => Object.freeze(value);

function providerRoute(id, overrides = {}) {
  const definition = getProviderDefinition(id);
  const url = new URL(definition.defaults.endpoint);
  const protocol = definition.route.protocol === 'anthropic_messages'
    ? 'anthropic_messages'
    : 'openai_chat';
  return freeze({
    kind: id,
    prefixes: freeze([id]),
    credentialEnv: definition.credential,
    endpoint: url.origin,
    pathPrefix: url.pathname.replace(/\/+$/, '') || '/',
    protocol,
    package: protocol === 'anthropic_messages' ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
    authStyle: definition.route.authStyle,
    ...overrides,
  });
}

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
  'openai-compatible': providerRoute('openai-compatible'),
  zai: providerRoute('zai'),
  // OpenCode's catalogue is model/provider specific. Keep the provider
  // defaults for catalogue/status compatibility, but the runtime resolver
  // below only admits an exact audited model entry for Zen/Go. An unknown
  // model must never silently become Chat Completions.
  'opencode-zen': providerRoute('opencode-zen', {
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
  'opencode-go': providerRoute('opencode-go', {
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
  moonshot: providerRoute('moonshot'),
  'kimi-for-coding': providerRoute('kimi-for-coding'),
});


// Credential mode is independent from caller-worktree isolation. Every entry
// point resolves explicit user intent here; no environment fallback exists.
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

  // Truthy on purpose, and the normalization is INTENTIONALLY centralized
  // here: callers pass the raw user-supplied value through unchanged, so any
  // plausible affirmative (true, 'true', 1) selects protection instead of
  // silently falling through to the insecure default. Only genuinely negative
  // values (false, undefined, '', 0) resolve to best_effort_raw.
  return protectCredentials
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

export function resolveCoderRuntimeProviderRoute(model, registry = CODER_PROVIDER_REGISTRY) {
  return resolveCoderProviderRoute(model, registry);
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
  Object.freeze({ label: 'openai-compatible', env: 'TRISS_OPENAI_COMPATIBLE_API_KEY' }),
  Object.freeze({ label: 'zai', env: 'ZHIPU_API_KEY' }),
  Object.freeze({ label: 'opencode-zen/go', env: 'OPENCODE_API_KEY' }),
  Object.freeze({ label: 'moonshot', env: 'MOONSHOT_API_KEY' }),
  Object.freeze({ label: 'kimi-for-coding', env: 'KIMI_API_KEY' }),
]);

export function coderCredentialReady(env = process.env) {
  return CODER_PROVIDER_CREDENTIALS.some((provider) => !!env[provider.env]);
}

import OpenAI from 'openai';
import pc from 'picocolors';
import {
  getConfig,
  requestTimeoutMs,
  requireApiKey,
  requireGlmApiKey,
  requireKimiApiKey,
} from './config.js';
import { normalizeKimiBaseUrl } from './moonshot.js';
import { logUsage } from './usage.js';
import { normalizeApiUsage, reconcileTokenSide } from './usage-schema.js';
import { currentCall } from './call-context.js';
import {
  ZAI_CODING_PLAN_BASE_URL,
  normalizeZaiBaseUrl,
  siblingZaiBaseUrl,
  zaiPrefixForBaseUrl,
} from './zai.js';

export function billingModelFor({ provider, baseUrl, model }) {
  if (provider !== 'glm') return model || '(unknown)';

  const prefix = zaiPrefixForBaseUrl(baseUrl);
  if (!prefix || !model) return model || '(unknown)';

  // Z.AI responses currently return a bare model id, but avoid duplicating a
  // prefix if a compatible endpoint starts returning one later.
  const modelId = String(model).replace(/^zai(?:-coding-plan)?\//, '');
  return `${prefix}/${modelId}`;
}

export function glmRouteHint(baseUrl) {
  const endpoint = normalizeZaiBaseUrl(baseUrl);
  return (
    `This request resolved to ${endpoint}. A bare GLM model id uses the resolved endpoint. ` +
    'Use zai/<model> for pay-as-you-go or zai-coding-plan/<model> for the subscription endpoint.'
  );
}

// Recreate the OpenAI client per call so a long-lived MCP server picks
// up `triss config set TRISS_WORKER_API_KEY` changes mid-session. Constructing
// the client is microseconds — no observable overhead next to a model RTT.
export function getClient({ provider = 'worker', baseUrl } = {}) {
  // Keep the caller's options immutable. Omitting timeout rather than passing
  // undefined preserves the OpenAI SDK's own default and retry behavior.
  const timeout = requestTimeoutMs();
  const buildClient = (options) =>
    new OpenAI(timeout === undefined ? options : { ...options, timeout });
  if (provider === 'glm') {
    return buildClient({
      apiKey: requireGlmApiKey(),
      baseURL: baseUrl || ZAI_CODING_PLAN_BASE_URL,
    });
  }
  if (provider === 'kimi') {
    return buildClient({
      apiKey: requireKimiApiKey(),
      // resolveModelRequest already normalizes, but normalize here too so a
      // direct caller with a trailing-slash/blank baseUrl gets the same URL.
      baseURL: normalizeKimiBaseUrl(baseUrl),
    });
  }
  const cfg = requireApiKey(getConfig());
  return buildClient({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl });
}

export function recordUsage(resp, label, request = {}) {
  // A successful call with no usage object is still a real call worth
  // recording — as a `missing` record, not a dropped one. Only an absent
  // response entirely is skipped.
  if (!resp) return;
  const ctx = currentCall();
  const model = billingModelFor({ ...request, model: resp.model || request.model });
  const provider = providerForUsage(request.provider);
  const { tokens, usage_status, warnings } = normalizeApiUsage(resp, { provider });
  // Normalization disagreements (e.g. a DeepSeek hit+miss mismatch) are
  // surfaced once on stderr, dimmed, so a human sees the caveat without the
  // persisted record or reportUsage()'s format changing.
  for (const warning of warnings || []) {
    process.stderr.write(pc.dim(`[triss] usage warning: ${warning}\n`));
  }
  return logUsage({
    model,
    billing_model: model,
    // A direct Kimi call is the single Moonshot PAYG endpoint, but its bare id
    // (e.g. `kimi-k3`) has no prefix for resolveBillingMode to classify — so
    // the known pay-as-you-go mode is forwarded explicitly. GLM calls leave it
    // to resolveBillingMode (billingModelFor already carries a zai prefix), and
    // the worker endpoint is user-configurable so it correctly stays 'unknown'.
    billing_mode: request.provider === 'kimi' ? 'payg' : undefined,
    usage_source: 'api',
    usage_status,
    tokens,
    // The resolved provider must be forwarded explicitly: logUsage only
    // derives it from the model prefix, so a bare id like `kimi-k3` would
    // otherwise persist with `provider: null` and lose which provider it was.
    provider,
    label,
    call_id: ctx?.callId,
    parent_call_id: ctx?.parentCallId,
  });
}

// The printed usage line and the persisted record must agree on the provider,
// so both funnel the caller's vocabulary through one mapping onto the
// normalizer's ('glm' -> 'zai' for Z.AI; kimi/deepseek name themselves;
// everything else, including the bare worker, is the generic worker shape).
function providerForUsage(provider) {
  if (provider === 'glm') return 'zai';
  if (provider === 'zai' || provider === 'kimi' || provider === 'deepseek') return provider;
  return 'worker';
}

// Statuses Z.AI returns when the key does not match the endpoint the request
// resolved to. 429 belongs here despite reading as a rate limit: a Coding Plan
// key sent to the PAYG endpoint answers "Insufficient balance or no resource
// package. Please recharge." — a billing message for what is really a routing
// mismatch, so the endpoint hint matters more there than anywhere else.
const GLM_ROUTE_STATUSES = new Set([401, 403, 429]);

export function providerRequestError(err, { provider, baseUrl, model }) {
  const status = err?.status || err?.response?.status;
  const body = err?.error?.message || err?.message || String(err);
  // Kimi has a single endpoint, so unlike GLM a 401/403 can only mean the key
  // itself; a 429 is a genuine rate limit / balance problem, not a routing one.
  if (provider === 'kimi' && (status === 401 || status === 403)) {
    return new Error(
      `Kimi request for model "${model}" was rejected (HTTP ${status}). ` +
        `Check that MOONSHOT_API_KEY is valid for ${normalizeKimiBaseUrl(baseUrl)}. ` +
        `Original error: ${body}`,
      { cause: err },
    );
  }
  if (provider === 'kimi' && status === 429) {
    return new Error(
      `Kimi request for model "${model}" was throttled (HTTP 429). ` +
        'Either the Moonshot account is rate limited or its balance/quota is exhausted — ' +
        'check the account at https://platform.kimi.ai/. ' +
        `Original error: ${body}`,
      { cause: err },
    );
  }
  if (provider === 'glm' && GLM_ROUTE_STATUSES.has(status)) {
    // A genuine 429 (quota or rate limit on the right endpoint) is also
    // possible, so name both causes instead of asserting the key is wrong.
    const advice = status === 429
      ? 'Either that endpoint has no balance/quota left, or the key belongs to the other plan.'
      : 'Check that ZHIPU_API_KEY is valid for that endpoint.';
    return new Error(
      `GLM request for model "${model}" was rejected (HTTP ${status}). ${glmRouteHint(baseUrl)} ` +
      `${advice} Original error: ${body}`,
      { cause: err },
    );
  }
  if (status === 404 || /model.*not.*found|unknown model/i.test(body)) {
    const hint = provider === 'glm'
      ? `→ Pass --provider glm --model glm-5.2. ${glmRouteHint(baseUrl)}\n`
      : provider === 'kimi'
        ? '→ Pass --provider kimi --model kimi-k3 (or kimi-k2.7-code / kimi-k2.6), or use the flash/pro presets.\n'
        : '→ Override with --model <name> or set TRISS_WORKER_FLASH_MODEL / TRISS_WORKER_PRO_MODEL in your env.\n' +
          '→ Current DeepSeek model names: deepseek-v4-flash, deepseek-v4-pro.\n';
    return new Error(
      `Model "${model}" not accepted by the provider.\n${hint}Original error: ${body}`,
      { cause: err },
    );
  }
  return err;
}

// A Z.AI key authenticates against exactly one of the two endpoints and
// carries no marker of which, so a call routed by the `zai-coding-plan`
// default is a guess. When that guess is rejected with a routing status we
// retry once on the sibling endpoint and remember the winner for the rest of
// the process — a long-lived MCP server pays for the discovery at most once
// per process. Only the endpoint is cached: the API key is never retained or
// fingerprinted. If the key changes and belongs to the other endpoint, the
// cached route is rejected and this same one-retry path corrects it.
let glmDiscoveredBaseUrl = null;

// Test seam + escape hatch for a process that swaps keys without restarting.
export function resetGlmEndpointDiscovery() {
  glmDiscoveredBaseUrl = null;
}

function statusOf(err) {
  return err?.status || err?.response?.status;
}

export async function withGlmEndpointFallback(request, run, deps = {}) {
  const warn = deps.warn || ((line) => process.stderr.write(pc.dim(line)));
  const provisional = request.provider === 'glm' && request.endpointSource === 'default';
  const baseUrl = provisional && glmDiscoveredBaseUrl
    ? glmDiscoveredBaseUrl
    : request.baseUrl;

  try {
    return { result: await run(baseUrl), baseUrl };
  } catch (err) {
    const sibling = provisional && GLM_ROUTE_STATUSES.has(statusOf(err))
      ? siblingZaiBaseUrl(baseUrl)
      : null;
    if (!sibling) throw providerRequestError(err, { ...request, baseUrl });

    let result;
    try {
      result = await run(sibling);
    } catch {
      // The key works on neither endpoint, so the sibling's rejection says
      // nothing new — surface the original one, which already carries the
      // endpoint hint for the route the user actually asked for.
      throw providerRequestError(err, { ...request, baseUrl });
    }
    glmDiscoveredBaseUrl = sibling;
    warn(
      `[triss] ZHIPU_API_KEY was rejected by ${normalizeZaiBaseUrl(baseUrl)} (HTTP ${statusOf(err)}) ` +
        `but works on ${sibling}. Using that endpoint for the rest of this process. ` +
        `Pin it with TRISS_CODER_MODEL=${zaiPrefixForBaseUrl(sibling)}/<model> ` +
        'or run `triss coder init` to skip this probe.\n',
    );
    return { result, baseUrl: sibling };
  }
}

export async function chat({
  provider,
  baseUrl,
  model,
  endpointSource,
  messages,
  maxTokens,
  temperature,
  label,
  timeoutMs,
  signal,
  thinking,
  onReasoning,
}) {
  // Two distinct shapes go to the OpenAI SDK: the JSON body (argument 1) and
  // the per-request transport options (argument 2). timeout/signal are
  // transport-only — they never appear in the API body.
  const body = buildChatCompletionsBody({
    provider,
    model,
    messages,
    maxTokens,
    temperature,
    thinking,
  });
  const requestOptions = buildRequestOptions({ timeoutMs, signal });
  const { result: resp, baseUrl: usedBaseUrl } = await withGlmEndpointFallback(
    { provider, baseUrl, model, endpointSource },
    (url) =>
      getClient({ provider, baseUrl: url }).chat.completions.create(body, requestOptions),
  );
  // Buffered GLM thinking responses carry reasoning_content on the message.
  // It stays separate from content (responseText never promotes it) but a
  // caller that wants to surface thinking can opt in via onReasoning.
  const reasoning = resp?.choices?.[0]?.message?.reasoning_content;
  if (onReasoning && typeof reasoning === 'string' && reasoning) onReasoning(reasoning);
  recordUsage(resp, label || 'chat', { provider, baseUrl: usedBaseUrl, model });
  return resp;
}

// The per-request chat-completions JSON body. API fields only: model, messages,
// token budget, temperature, the streaming shape, and the GLM thinking toggle.
// Transport concerns (timeout, AbortSignal) live in buildRequestOptions(),
// which the OpenAI SDK consumes as a separate argument — they must never be
// serialized into this body. Timeout/signal are per-call only; the global
// clients built by getClient() stay untouched, and omitting them leaves the
// OpenAI SDK's own defaults and retry behavior intact.
export function buildChatCompletionsBody({
  provider,
  model,
  messages,
  maxTokens,
  temperature,
  stream,
  streamOptions,
  thinking,
} = {}) {
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature: temperature ?? 0.2,
  };
  if (stream) {
    body.stream = true;
    body.stream_options = streamOptions || { include_usage: true };
  }
  if (provider === 'glm' && thinking) body.thinking = { type: 'enabled' };
  return body;
}

// Per-request OpenAI SDK transport options — the second argument to
// chat.completions.create(). Kept apart from the JSON body so an API request
// never serializes timeout or signal, and omitted fields leave the SDK's own
// per-request defaults untouched.
export function buildRequestOptions({ timeoutMs, signal } = {}) {
  const options = {};
  if (timeoutMs !== undefined) options.timeout = timeoutMs;
  if (signal !== undefined) options.signal = signal;
  return options;
}

export function reportUsage(resp, label = 'worker', { provider } = {}) {
  const { tokens, usage_status } = normalizeApiUsage(resp, {
    provider: providerForUsage(provider),
  });
  if (usage_status === 'missing') return '';

  const fmt = (n) => n.toLocaleString('en-US');
  const inputState = reconcileTokenSide(tokens, 'input');
  const outputState = reconcileTokenSide(tokens, 'output');

  const inputEvidence = () => {
    const parts = [];
    if (tokens.input_uncached != null) parts.push(`${fmt(tokens.input_uncached)} uncached input`);
    if (tokens.cache_read != null) parts.push(`${fmt(tokens.cache_read)} cache-read`);
    if (tokens.cache_write != null && tokens.cache_write !== 0) {
      parts.push(`${fmt(tokens.cache_write)} cache-write`);
    }
    return parts.join(' + ');
  };
  const outputEvidence = () => {
    const parts = [];
    if (tokens.output_visible != null) parts.push(`${fmt(tokens.output_visible)} visible`);
    if (tokens.reasoning != null) parts.push(`${fmt(tokens.reasoning)} reasoning`);
    return parts.join(' + ');
  };

  let input;
  const inputParts = inputEvidence();
  if (inputState.reconciled) {
    input = inputParts;
  } else if (tokens.input_total != null) {
    const detail = inputState.inconsistent
      ? `split inconsistent${inputParts ? `: ${inputParts}` : ''}`
      : `split unavailable${inputParts ? `; partial: ${inputParts}` : ''}`;
    input = `${fmt(tokens.input_total)} input (${detail})`;
  } else {
    input = inputParts;
  }

  let output;
  const outputParts = outputEvidence();
  if (outputState.reconciled) {
    output = outputParts;
  } else if (tokens.output_total != null) {
    const detail = outputState.inconsistent
      ? `split inconsistent${outputParts ? `: ${outputParts}` : ''}`
      : `split unavailable${outputParts ? `; partial: ${outputParts}` : ''}`;
    output = `${fmt(tokens.output_total)} output (${detail})`;
  } else {
    output = outputParts;
  }

  let line = `[${label}: `;
  if (input) line += input;
  if (output) line += (input ? ' / ' : '') + output;
  if (tokens.total != null) line += ` | total ${fmt(tokens.total)}`;
  if (!inputState.reconciled || !outputState.reconciled) {
    line += ' | incomplete usage detail';
  }
  line += ` | finish: ${resp?.choices?.[0]?.finish_reason ?? 'n/a'}]`;
  return line;
}

// Successful one-shot providers are not perfectly uniform. OpenAI-compatible
// chat completions use choices[0].message.content, while some GLM-compatible
// responses expose the completed assistant answer as top-level final_text.
// Normalize both without rewriting the provider payload or confusing an
// absent answer with an intentionally short one.
export function responseText(resp) {
  const content = resp?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.length > 0) return content;
  const finalText = resp?.final_text;
  if (typeof finalText === 'string' && finalText.length > 0) return finalText;
  return '';
}

// Streaming variant: yields content chunks as they arrive, captures usage
// from the final chunk (requires stream_options.include_usage). Returns
// the full assembled text and the OpenAI-style response shape so callers
// can reuse reportUsage().
export async function chatStream({
  provider,
  baseUrl,
  model,
  endpointSource,
  messages,
  maxTokens,
  temperature,
  label,
  onChunk,
  timeoutMs,
  signal,
  thinking,
  onReasoning,
}) {
  // The endpoint rejects a mismatched key while opening the stream, so the
  // fallback wraps creation only — nothing has been emitted to the caller yet
  // at that point, which is what makes retrying on the sibling safe.
  const body = buildChatCompletionsBody({
    provider,
    model,
    messages,
    maxTokens,
    temperature,
    stream: true,
    thinking,
  });
  const requestOptions = buildRequestOptions({ timeoutMs, signal });
  const { result: stream, baseUrl: usedBaseUrl } = await withGlmEndpointFallback(
    { provider, baseUrl, model, endpointSource },
    (url) =>
      getClient({ provider, baseUrl: url }).chat.completions.create(body, requestOptions),
  );

  const fakeResp = await assembleStreamResponse({ chunks: stream, model, onChunk, onReasoning });
  recordUsage(fakeResp, label || 'chat-stream', { provider, baseUrl: usedBaseUrl, model });
  return fakeResp;
}

// Folds raw stream chunks into the OpenAI-style response shape. Content
// deltas feed onChunk and the assembled message.content; reasoning_content
// deltas are collected in a separate buffer, surfaced through onReasoning
// (never onChunk), and returned as message.reasoning_content — so a thinking
// model's reasoning is observable without ever being merged into the verdict.
// Deterministic and pure so tests can drive it with plain chunk arrays.
export async function assembleStreamResponse({ chunks = [], model, onChunk, onReasoning } = {}) {
  let text = '';
  let reasoning = '';
  let usageChunk = null;
  // finish_reason travels independently of usage: an OpenAI-style stream
  // (stream_options.include_usage) ends with a finish_reason chunk followed
  // by a final choices:[] chunk that carries only usage. Pinning the reason
  // to the usage chunk would erase finish_reason — turning `length` back into
  // the 'stop' default and losing the exhausted-budget signal.
  let finishReason;
  for await (const chunk of chunks) {
    const delta = chunk?.choices?.[0]?.delta || {};
    if (delta.content) {
      text += delta.content;
      if (onChunk) onChunk(delta.content);
    }
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      if (onReasoning) onReasoning(delta.reasoning_content);
    }
    const chunkFinishReason = chunk?.choices?.[0]?.finish_reason;
    if (chunkFinishReason) finishReason = chunkFinishReason;
    if (chunk?.usage) usageChunk = chunk;
  }

  const message = { content: text };
  if (reasoning) message.reasoning_content = reasoning;
  return {
    model,
    choices: [{
      message,
      finish_reason: finishReason ?? 'stop',
    }],
    usage: usageChunk?.usage,
  };
}

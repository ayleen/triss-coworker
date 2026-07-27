import OpenAI from 'openai';
import pc from 'picocolors';
import { getConfig, requireApiKey, requireGlmApiKey, requireKimiApiKey } from './config.js';
import { normalizeKimiBaseUrl } from './moonshot.js';
import { logUsage } from './usage.js';
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
  if (provider === 'glm') {
    return new OpenAI({
      apiKey: requireGlmApiKey(),
      baseURL: baseUrl || ZAI_CODING_PLAN_BASE_URL,
    });
  }
  if (provider === 'kimi') {
    return new OpenAI({
      apiKey: requireKimiApiKey(),
      // resolveModelRequest already normalizes, but normalize here too so a
      // direct caller with a trailing-slash/blank baseUrl gets the same URL.
      baseURL: normalizeKimiBaseUrl(baseUrl),
    });
  }
  const cfg = requireApiKey(getConfig());
  return new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl });
}

function recordUsage(resp, label, request = {}) {
  if (!resp?.usage) return;
  const ctx = currentCall();
  logUsage({
    model: billingModelFor({ ...request, model: resp.model || request.model }),
    prompt_tokens: resp.usage.prompt_tokens,
    cached_tokens: resp.usage.prompt_tokens_details?.cached_tokens,
    completion_tokens: resp.usage.completion_tokens,
    label,
    call_id: ctx?.callId,
    parent_call_id: ctx?.parentCallId,
  });
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
}) {
  const { result: resp, baseUrl: usedBaseUrl } = await withGlmEndpointFallback(
    { provider, baseUrl, model, endpointSource },
    (url) =>
      getClient({ provider, baseUrl: url }).chat.completions.create({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: temperature ?? 0.2,
      }),
  );
  recordUsage(resp, label || 'chat', { provider, baseUrl: usedBaseUrl, model });
  return resp;
}

export function reportUsage(resp, label = 'worker') {
  const u = resp?.usage;
  if (!u) return '';
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return `[${label}: ${u.prompt_tokens} in (${cached} cached) / ${u.completion_tokens} out | finish: ${resp.choices?.[0]?.finish_reason ?? 'n/a'}]`;
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
}) {
  // The endpoint rejects a mismatched key while opening the stream, so the
  // fallback wraps creation only — nothing has been emitted to the caller yet
  // at that point, which is what makes retrying on the sibling safe.
  const { result: stream, baseUrl: usedBaseUrl } = await withGlmEndpointFallback(
    { provider, baseUrl, model, endpointSource },
    (url) =>
      getClient({ provider, baseUrl: url }).chat.completions.create({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: temperature ?? 0.2,
        stream: true,
        stream_options: { include_usage: true },
      }),
  );

  let text = '';
  let lastChunk = null;
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      text += delta;
      if (onChunk) onChunk(delta);
    }
    if (chunk.usage) lastChunk = chunk;
  }

  const fakeResp = {
    model,
    choices: [{ message: { content: text }, finish_reason: lastChunk?.choices?.[0]?.finish_reason ?? 'stop' }],
    usage: lastChunk?.usage,
  };
  recordUsage(fakeResp, label || 'chat-stream', { provider, baseUrl: usedBaseUrl, model });
  return fakeResp;
}

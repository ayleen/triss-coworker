import OpenAI from 'openai';
import { getConfig, requireApiKey, requireGlmApiKey } from './config.js';
import { logUsage } from './usage.js';
import { currentCall } from './call-context.js';
import {
  ZAI_CODING_PLAN_BASE_URL,
  normalizeZaiBaseUrl,
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
      : '→ Override with --model <name> or set TRISS_WORKER_FLASH_MODEL / TRISS_WORKER_PRO_MODEL in your env.\n' +
        '→ Current DeepSeek model names: deepseek-v4-flash, deepseek-v4-pro.\n';
    return new Error(
      `Model "${model}" not accepted by the provider.\n${hint}Original error: ${body}`,
      { cause: err },
    );
  }
  return err;
}

export async function chat({ provider, baseUrl, model, messages, maxTokens, temperature, label }) {
  const client = getClient({ provider, baseUrl });
  try {
    const resp = await client.chat.completions.create({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: temperature ?? 0.2,
    });
    recordUsage(resp, label || 'chat', { provider, baseUrl, model });
    return resp;
  } catch (err) {
    throw providerRequestError(err, { provider, baseUrl, model });
  }
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
  messages,
  maxTokens,
  temperature,
  label,
  onChunk,
}) {
  const client = getClient({ provider, baseUrl });
  let stream;
  try {
    stream = await client.chat.completions.create({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: temperature ?? 0.2,
      stream: true,
      stream_options: { include_usage: true },
    });
  } catch (err) {
    throw providerRequestError(err, { provider, baseUrl, model });
  }

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
  recordUsage(fakeResp, label || 'chat-stream', { provider, baseUrl, model });
  return fakeResp;
}

import OpenAI from 'openai';
import { getConfig, requireApiKey } from './config.js';
import { logUsage } from './usage.js';

// Recreate the OpenAI client per call so a long-lived MCP server picks
// up `triss config set DEEPSEEK_API_KEY` changes mid-session. Constructing
// the client is microseconds — no observable overhead next to a model RTT.
export function getClient() {
  const cfg = requireApiKey(getConfig());
  return new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl });
}

function recordUsage(resp, label) {
  if (!resp?.usage) return;
  logUsage({
    model: resp.model || '(unknown)',
    prompt_tokens: resp.usage.prompt_tokens,
    cached_tokens: resp.usage.prompt_tokens_details?.cached_tokens,
    completion_tokens: resp.usage.completion_tokens,
    label,
  });
}

export async function chat({ model, messages, maxTokens, temperature, label }) {
  const client = getClient();
  try {
    const resp = await client.chat.completions.create({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: temperature ?? 0.2,
    });
    recordUsage(resp, label || 'chat');
    return resp;
  } catch (err) {
    const status = err?.status || err?.response?.status;
    const body = err?.error?.message || err?.message || String(err);
    if (status === 404 || /model.*not.*found|unknown model/i.test(body)) {
      throw new Error(
        `Model "${model}" not accepted by the provider.\n` +
          `→ Override with --model <name> or set DEEPSEEK_FLASH_MODEL / DEEPSEEK_PRO_MODEL in your env.\n` +
          `→ Common DeepSeek model names today: deepseek-chat, deepseek-reasoner.\n` +
          `Original error: ${body}`,
      );
    }
    throw err;
  }
}

export function reportUsage(resp, label = 'deepseek') {
  const u = resp?.usage;
  if (!u) return '';
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  return `[${label}: ${u.prompt_tokens} in (${cached} cached) / ${u.completion_tokens} out | finish: ${resp.choices?.[0]?.finish_reason ?? 'n/a'}]`;
}

// Streaming variant: yields content chunks as they arrive, captures usage
// from the final chunk (requires stream_options.include_usage). Returns
// the full assembled text and the OpenAI-style response shape so callers
// can reuse reportUsage().
export async function chatStream({ model, messages, maxTokens, temperature, label, onChunk }) {
  const client = getClient();
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
    const status = err?.status || err?.response?.status;
    const body = err?.error?.message || err?.message || String(err);
    if (status === 404 || /model.*not.*found|unknown model/i.test(body)) {
      throw new Error(
        `Model "${model}" not accepted by the provider.\n` +
          `→ Override with --model <name> or set DEEPSEEK_FLASH_MODEL / DEEPSEEK_PRO_MODEL.\n` +
          `Original error: ${body}`,
      );
    }
    throw err;
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
  recordUsage(fakeResp, label || 'chat-stream');
  return fakeResp;
}

import OpenAI from 'openai';
import { getConfig, requireApiKey } from './config.js';

let cached = null;
export function getClient() {
  if (cached) return cached;
  const cfg = requireApiKey(getConfig());
  cached = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl });
  return cached;
}

export async function chat({ model, messages, maxTokens, temperature }) {
  const client = getClient();
  try {
    const resp = await client.chat.completions.create({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: temperature ?? 0.2,
    });
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

import pc from 'picocolors';
import { chat, reportUsage } from '../client.js';
import { resolveModel } from '../models.js';

export class IntegrationError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'IntegrationError';
    this.status = status;
    this.body = body;
  }
}

const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const DEFAULT_HTTP_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

function httpTimeoutMs() {
  const raw = process.env.TRISS_HTTP_TIMEOUT_MS;
  if (!raw) return DEFAULT_HTTP_TIMEOUT_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HTTP_TIMEOUT_MS;
}

function httpMaxBytes() {
  const raw = process.env.TRISS_HTTP_MAX_BYTES;
  if (!raw) return DEFAULT_HTTP_MAX_BYTES;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_HTTP_MAX_BYTES;
}

async function readBodyCapped(res, limit, ctx) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    // Test mocks (and a few legacy fetch impls) skip the streaming API.
    const text = await res.text();
    if (text.length > limit) {
      throw new IntegrationError(
        `Response body exceeds ${limit} bytes on ${ctx} (got ${text.length}). ` +
          `Set TRISS_HTTP_MAX_BYTES to override.`,
      );
    }
    return text;
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let received = 0;
  let text = '';
   
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new IntegrationError(
        `Response body exceeds ${limit} bytes on ${ctx} (aborted at ${received}). ` +
          `Set TRISS_HTTP_MAX_BYTES to override.`,
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

export async function httpJson(url, { method = 'GET', headers = {}, body, signal } = {}) {
  const init = {
    method,
    headers: { Accept: 'application/json', ...headers },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] ||= 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  // Internal timeout, composed with any caller-provided AbortSignal so
  // either source can cancel the request.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), httpTimeoutMs());
  const onCallerAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  init.signal = ctrl.signal;

  let res;
  let text;
  try {
    res = await fetch(url, init);
    text = await readBodyCapped(res, httpMaxBytes(), `${method} ${url}`);
  } catch (err) {
    if (err.name === 'AbortError') {
      if (res) {
        throw new IntegrationError(
          `Timeout reading body of ${method} ${url} after ${httpTimeoutMs()}ms ` +
            '(set TRISS_HTTP_TIMEOUT_MS to override)',
        );
      }
      throw new IntegrationError(
        `Timeout after ${httpTimeoutMs()}ms on ${method} ${url} ` +
          '(set TRISS_HTTP_TIMEOUT_MS to override)',
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener?.('abort', onCallerAbort);
  }

  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const snippet =
      typeof parsed === 'string' ? parsed.slice(0, 500) : JSON.stringify(parsed).slice(0, 500);
    throw new IntegrationError(
      `HTTP ${res.status} ${res.statusText} on ${method} ${url}\n${snippet}`,
      { status: res.status, body: parsed },
    );
  }
  return parsed;
}

export function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new IntegrationError(
      `Missing required env: ${missing.join(', ')}\n` +
        'Set them in your shell, ~/.config/triss/.env, or project .env',
    );
  }
}

const SUMMARY_SYSTEM =
  'You are summarizing data fetched from an external system (issue tracker, ' +
  'docs, etc.) for a coding agent. Be concise and faithful. Use bullets, ' +
  'preserve IDs/keys/URLs verbatim, and omit fluff.';

export async function summarize({ corpus, question, model: modelInput, maxTokens = 4096 }) {
  if (!question) return corpus;
  const model = resolveModel(modelInput);
  process.stderr.write(pc.dim(`[triss/summary] model=${model} bytes=${corpus.length}\n`));
  const resp = await chat({
    model,
    maxTokens,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: `<data>\n${corpus}\n</data>` },
      { role: 'user', content: question },
    ],
  });
  const out = resp.choices?.[0]?.message?.content;
  if (!out) {
    throw new IntegrationError(
      'DeepSeek returned empty content. Try larger --max-tokens.',
    );
  }
  process.stderr.write(pc.dim(reportUsage(resp, 'triss/summary') + '\n'));
  return out;
}

export function printResult(text, { json = false } = {}) {
  if (json && typeof text !== 'string') {
    process.stdout.write(JSON.stringify(text, null, 2) + '\n');
  } else {
    process.stdout.write(String(text) + '\n');
  }
}

export function validateManifest(manifest, source) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`Integration ${source} did not export a default object`);
  }
  if (!manifest.name || typeof manifest.name !== 'string') {
    throw new Error(`Integration ${source} is missing a "name"`);
  }
  if (typeof manifest.register !== 'function') {
    throw new Error(`Integration ${manifest.name} (${source}) is missing register(program)`);
  }
  if (manifest.envVars && !Array.isArray(manifest.envVars)) {
    throw new Error(`Integration ${manifest.name} envVars must be an array`);
  }
  return manifest;
}

/**
 * Strip HTML tags from a string, including the content of <script> and
 * <style> elements. Also decodes common HTML entities. More robust than
 * a naive /<[^>]+>/g replace which can leave script fragments behind.
 */
export function stripHtml(input) {
  if (input == null) return undefined;
  return String(input)
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

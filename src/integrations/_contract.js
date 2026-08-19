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

export async function httpJson(url, { method = 'GET', headers = {}, body, signal, maxBytes } = {}) {
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
    // Per-call maxBytes overrides the global cap (component review-specific
    // calls use bounded abort-aware response reading).
    text = await readBodyCapped(res, maxBytes ?? httpMaxBytes(), `${method} ${url}`);
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
 * <style> elements. Uses a character-by-character state machine rather
 * than regexes to avoid CodeQL js/incomplete-multi-character-sanitization.
 */
export function stripHtml(input) {
  if (input == null) return undefined;
  const s = String(input);
  let out = '';
  let i = 0;
  const len = s.length;

  while (i < len) {
    // Detect an opening tag: '<' followed by a letter or '/'
    if (s[i] === '<' && i + 1 < len && /[a-zA-Z/]/.test(s[i + 1])) {
      const { tagName, next, closing } = readHtmlTagName(s, i + 1);

      // Find the matching close '>' for this tag
      let j = findHtmlTagEnd(s, next);

      if (!closing && (tagName === 'script' || tagName === 'style')) {
        // Skip everything until we find the corresponding closing tag
        while (j < len) {
          if (isHtmlClosingTag(s, j, tagName)) {
            j = findHtmlTagEnd(s, j + tagName.length + 2);
            break;
          }
          j++;
        }
      }
      i = j;
      continue;
    }
    out += s[i];
    i++;
  }

  return out;
}

function readHtmlTagName(s, start) {
  let j = start;
  const closing = s[j] === '/';
  if (closing) j++;
  const tagStart = j;
  while (j < s.length && isHtmlTagNameChar(s[j])) j++;
  return {
    tagName: s.slice(tagStart, j).toLowerCase(),
    next: j,
    closing,
  };
}

function isHtmlTagNameChar(ch) {
  return /[a-zA-Z0-9:-]/.test(ch);
}

function findHtmlTagEnd(s, start) {
  let quote = null;
  let i = start;
  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i + 1;
    }
    i++;
  }
  return i;
}

function isHtmlClosingTag(s, start, tagName) {
  if (s[start] !== '<' || s[start + 1] !== '/') return false;
  const nameStart = start + 2;
  const nameEnd = nameStart + tagName.length;
  if (s.slice(nameStart, nameEnd).toLowerCase() !== tagName) return false;
  return isHtmlTagNameBoundary(s[nameEnd]);
}

function isHtmlTagNameBoundary(ch) {
  return ch === undefined || ch === '>' || ch === '/' || /\s/.test(ch);
}

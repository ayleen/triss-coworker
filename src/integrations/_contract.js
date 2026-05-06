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

export async function httpJson(url, { method = 'GET', headers = {}, body, signal } = {}) {
  const init = {
    method,
    headers: { Accept: 'application/json', ...headers },
    signal,
  };
  if (body !== undefined) {
    init.headers['Content-Type'] ||= 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
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

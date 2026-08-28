// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { IntegrationError } from './integrations/_contract.js';
import { fetchWithRedirects } from './net.js';
import { DEFAULT_FETCH_MAX_BYTES } from './config-defaults.js';

const DEFAULT_UA =
  'triss-coworker/0.5 (+https://github.com/ayleen/triss-coworker)';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = DEFAULT_FETCH_MAX_BYTES;
const MAX_REDIRECTS = 5;

function maxBytes() {
  const raw = process.env.TRISS_FETCH_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

// Tags that almost always carry layout/UI noise rather than article body.
const STRIP_SELECTORS = [
  'script',
  'style',
  'noscript',
  'iframe',
  'nav',
  'aside',
  'footer',
  'form',
  'svg',
  '[role=navigation]',
  '[aria-hidden=true]',
];

export async function fetchUrl(url, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  headers = {},
  requestImpl,
  lookupImpl,
} = {}) {
  if (!/^https?:\/\//i.test(url)) {
    throw new IntegrationError(`Refusing to fetch non-http(s) URL: ${url}`);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    let finalUrl;
    try {
      const result = await fetchWithRedirects(url, {
        requestImpl,
        lookupImpl,
        signal: ctrl.signal,
        headers: { 'User-Agent': DEFAULT_UA, Accept: 'text/html,application/xhtml+xml,*/*', ...headers },
        maxRedirects: MAX_REDIRECTS,
      });
      res = result.response;
      finalUrl = result.url;
    } catch (err) {
      // Surface SSRF / redirect-cap errors as IntegrationError for the
      // standard caller-side error path. assertPublicUrl already produces
      // a user-actionable message.
      if (err instanceof IntegrationError) throw err;
      throw new IntegrationError(err.message);
    }
    // Streamed read with a hard ceiling so a malicious or accidental
    // multi-gigabyte response can't OOM the process.
    const limit = maxBytes();
    const reader = res.body?.getReader?.();
    let text = '';
    if (!reader) {
      text = await res.text();
      if (text.length > limit) {
        throw new IntegrationError(
          `Response too large: ${text.length} bytes > ${limit} cap. ` +
            'Set TRISS_FETCH_MAX_BYTES to override.',
        );
      }
    } else {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      let received = 0;
       
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > limit) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          throw new IntegrationError(
            `Response exceeds ${limit} bytes (TRISS_FETCH_MAX_BYTES override available). Aborted at ${received} bytes.`,
          );
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    }

    if (!res.ok) {
      throw new IntegrationError(
        `HTTP ${res.status} ${res.statusText} on GET ${url}`,
        { status: res.status, body: text.slice(0, 500) },
      );
    }
    const contentType = res.headers.get('content-type') || '';
    return { text, url: finalUrl, contentType };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new IntegrationError(`Timeout after ${timeoutMs}ms fetching ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function htmlToMarkdown(html) {
  const { document } = parseHTML(html);
  for (const sel of STRIP_SELECTORS) {
    document.querySelectorAll(sel).forEach((el) => el.remove());
  }
  // Prefer <main> or <article> when present.
  const main =
    document.querySelector('main') ||
    document.querySelector('article') ||
    document.body ||
    document.documentElement;

  const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  });
  // Skip turndown's conversion of leading whitespace into hard breaks.
  turndown.addRule('preserveCodeBlocks', {
    filter: ['pre'],
    replacement: (_content, node) => {
      const code = node.textContent || '';
      const lang = node.querySelector?.('code')?.className?.match(/language-(\S+)/)?.[1] ?? '';
      return '\n```' + lang + '\n' + code.trim() + '\n```\n';
    },
  });
  let md = turndown.turndown(main.innerHTML || '');
  // Collapse 3+ blank lines to 2 for readability.
  md = md.replace(/\n{3,}/g, '\n\n').trim();
  return md;
}

export async function fetchAsMarkdown(url, opts) {
  const { text, url: finalUrl, contentType } = await fetchUrl(url, opts);
  if (contentType && !/html|xml/i.test(contentType)) {
    // Non-HTML — return raw text (e.g., JSON, plain text, markdown).
    return { url: finalUrl, markdown: text, contentType };
  }
  return { url: finalUrl, markdown: htmlToMarkdown(text), contentType };
}

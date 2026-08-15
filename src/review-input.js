/**
 * review-input.js — Package 18 (Atomic 39): bounded stdin and issue trust
 * boundary.
 *
 * Reference surface 10 stdin and issue bullets of the approved plan
 * (docs/reliable-delegation-contract-plan.md). Streaming stdin bounds,
 * supplied_input coverage, explicit issue validation/retrieval, deprecated
 * --skip-issue, and proof that PR prose can never trigger tracker access.
 * Does NOT duplicate HTTP/auth (reuses src/integrations/_contract.js).
 *
 * Exports:
 *   readBoundedReviewStdin({stream, maxBytes}) — streaming stdin bounds
 *   resolveExplicitReviewIssue({issue, tracker}) — explicit issue
 *     validation/retrieval via minimum-field tracker queries
 */

export const REVIEW_STDIN_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB (total_max)
export const REVIEW_ISSUE_SKIP_CODE = 'TRISS_REVIEW_SKIP_ISSUE';

/**
 * Read bounded stdin in a streaming, abort-aware way: cap-plus-one bytes are
 * collected; exceeding the cap fails closed (TRISS_REVIEW_LIMIT) instead of
 * buffering unbounded input.
 *
 * @param {object} opts
 * @param {NodeJS.ReadableStream} opts.stream stdin stream
 * @param {number} [opts.maxBytes=4194304]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok: boolean, code?: string, text?: string,
 *   bytes?: number, message?: string}>}
 */
export function readBoundedReviewStdin({ stream, maxBytes = REVIEW_STDIN_MAX_BYTES, signal }) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let failed = false;

    const finish = () => {
      if (failed) return;
      failed = true;
      cleanup();
      const buf = Buffer.concat(chunks);
      // Strict UTF-8 validation (the legacy reader's fatalUtf8 semantics):
      // toString('utf8') silently replaces malformed sequences with U+FFFD.
      // A round-trip check catches that; replacement chars are rejected.
      const text = buf.toString('utf8');
      if (Buffer.byteLength(text, 'utf8') !== buf.length || text.includes('\uFFFD')) {
        resolve({
          ok: false,
          code: 'TRISS_REVIEW_STDIN_UTF8',
          message: 'stdin input is not valid UTF-8',
        });
        return;
      }
      resolve({
        ok: true,
        text,
        bytes: total,
      });
    };
    const fail = (message, code = 'TRISS_REVIEW_LIMIT') => {
      if (failed) return;
      failed = true;
      cleanup();
      resolve({ ok: false, code, message });
    };
    const onAbort = () => fail('cancelled while reading stdin', 'TRISS_CANCELLED');
    const onData = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        // Cap-plus-one: stop immediately, no partial buffering.
        fail(`stdin exceeds ${maxBytes} bytes cap`);
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => finish();
    const onError = (err) => fail(`stdin read failed: ${err && err.message || err}`);
    const cleanup = () => {
      stream.removeListener?.('data', onData);
      stream.removeListener?.('end', onEnd);
      stream.removeListener?.('error', onError);
      stream.removeListener?.('close', onEnd);
      if (signal) signal.removeEventListener?.('abort', onAbort);
    };

    if (signal?.aborted) {
      fail('cancelled before reading stdin', 'TRISS_CANCELLED');
      return;
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.on('close', onEnd);
  });
}

/**
 * Resolve an explicit review issue reference through a tracker adapter.
 *  - `--skip-issue` (deprecated) resolves to {skip: true};
 *  - an explicit issue id/key must pass the tracker's minimum-field query;
 *  - PR prose alone can NEVER trigger tracker access: without an explicit
 *    issue option this returns {none: true} without touching any adapter.
 *
 * @param {object} opts
 * @param {string|null} opts.issue explicit --issue value
 * @param {boolean} [opts.skipIssue] deprecated --skip-issue
 * @param {object|null} opts.tracker adapter with issue(id, {signal, maxBytes})
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{kind: 'skip'|'none'|'issue', issue?: object,
 *   code?: string, message?: string}>}
 */
export async function resolveExplicitReviewIssue({ issue, skipIssue = false, tracker = null, signal }) {
  if (signal?.aborted) {
    return { kind: 'none', code: 'TRISS_CANCELLED', message: 'cancelled before issue resolution' };
  }
  if (skipIssue) {
    // Deprecated flag: explicit operator choice to skip linked-issue lookup.
    return { kind: 'skip' };
  }
  if (!issue || (typeof issue === 'string' && issue.trim().length === 0)) {
    // No explicit issue: PR prose can never trigger tracker access.
    return { kind: 'none' };
  }
  if (!tracker || typeof tracker.issue !== 'function') {
    return { kind: 'none', code: 'TRISS_REVIEW_INVALID_INPUT', message: 'explicit issue requires a configured tracker' };
  }
  try {
    const resolved = await tracker.issue(String(issue).trim(), { signal, maxBytes: 256 * 1024 });
    if (!resolved || typeof resolved.key !== 'string') {
      return { kind: 'issue', code: 'TRISS_REVIEW_INVALID_INPUT', message: `issue ${issue} not found` };
    }
    return { kind: 'issue', issue: resolved };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { kind: 'none', code: 'TRISS_CANCELLED', message: 'cancelled during issue retrieval' };
    }
    return { kind: 'none', code: 'TRISS_REVIEW_INVALID_INPUT', message: `issue retrieval failed: ${err && err.message || err}` };
  }
}

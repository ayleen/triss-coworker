/**
 * review-executor.js — Package 19 (Atomic 40): shared single-review executor
 * and CLI framing.
 *
 * Reference surface 10 single executor/CLI bullets of the approved plan
 * (docs/reliable-delegation-contract-plan.md). One buffered single executor,
 * CLI mode wiring, literal file/issue options, streaming rejection, stable
 * errors, scoped verdict framing, and the transport matrix.
 *
 * Exports:
 *   executeSingleReview(deps, opts)  — one buffered review execution
 *   renderCliReviewResult(result)    — CLI framing of the verdict
 */

import { parseUnifiedDiff, deriveReviewCoverage } from './review-payload.js';
import { reviewLimitConfig } from './config.js';

export const REVIEW_EXIT_CODES = Object.freeze({
  ok: 0,
  limit: 2,
  invalidInput: 2,
  cancelled: 130,
  provider: 1,
});

// Bounded metadata allowance for a single review request (matches the
// planner's METADATA_OVERHEAD_BYTES accounting).
const SINGLE_REVIEW_METADATA_OVERHEAD_BYTES = 4096;

/**
 * Execute one buffered single review over an already-acquired diff:
 *  - the diff is parsed and bounded by the injected Package 13 limits;
 *  - coverage is derived (repository vs requested scope);
 *  - the model call is made once with the merged payload.
 *
 * @param {object} deps injected seams
 * @param {Function} deps.callModel one-shot provider call (text in/out)
 * @param {object} deps.limits Package 13 frozen limits (or null to load)
 * @param {object} opts
 * @param {string} opts.diff acquired diff text
 * @param {string} opts.question review question
 * @param {string[]} [opts.selectors=[]] requested scope
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok: boolean, code?: string, verdict?: string,
 *   coverage?: object, bytes?: number, exit?: number, message?: string}>}
 */
export async function executeSingleReview(deps, { diff, question, selectors = [], metadataBytes = 0, signal }) {
  if (typeof deps?.callModel !== 'function') throw new TypeError('callModel is required');
  if (signal?.aborted) return { ok: false, code: 'TRISS_CANCELLED', message: 'cancelled', exit: REVIEW_EXIT_CODES.cancelled };

  const limits = deps.limits || reviewLimitConfig().limits;
  const { sections, error: parseError } = parseUnifiedDiff(diff);
  if (parseError) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: parseError, exit: REVIEW_EXIT_CODES.invalidInput };
  }

  // Requested-scope coverage with the literal selectors.
  const coverage = deriveReviewCoverage(sections, {
    requestedPaths: selectors.length > 0 ? selectors : null,
  });

  // Scoped-selection fail-closed (P0): a selector set that matched NOTHING
  // must never reach the model — an empty diff could yield an externally
  // plausible "clean" verdict for files that were never reviewed. Partial
  // matches proceed with honest partial coverage.
  if (
    selectors.length > 0 &&
    coverage?.requested &&
    coverage.requested.matched.length === 0
  ) {
    return {
      ok: false,
      code: 'TRISS_REVIEW_SCOPE_EMPTY',
      message:
        `none of the requested files (${selectors.join(', ')}) appear in the acquired diff; ` +
        'refusing to review an empty scope',
      coverage,
      exit: REVIEW_EXIT_CODES.invalidInput,
    };
  }

  // Single-request byte bound (Package 13 limits injected). P1 fix: the
  // bound is singleMaxBytes (the advertised single-request cap), NOT the
  // looser totalMaxBytes; the REAL metadata size (change corpus + linked
  // issue corpus) is accounted, not just the fixed envelope allowance —
  // a large issue body must not push the actual request past the advertised
  // cap while the accounting still says it fits.
  const payloadBytes =
    Buffer.byteLength(diff, 'utf8') +
    Buffer.byteLength(question, 'utf8') +
    SINGLE_REVIEW_METADATA_OVERHEAD_BYTES +
    Math.max(0, metadataBytes|0);
  if (payloadBytes > limits.singleMaxBytes) {
    return { ok: false, code: 'TRISS_REVIEW_LIMIT', message: `review payload exceeds ${limits.singleMaxBytes} bytes`, exit: REVIEW_EXIT_CODES.limit };
  }

  try {
    const verdict = await deps.callModel({ diff, question, coverage, signal });
    if (typeof verdict !== 'string' || verdict.trim().length === 0) {
      return { ok: false, code: 'TRISS_PROVIDER_EMPTY', message: 'provider returned an empty verdict', exit: REVIEW_EXIT_CODES.provider };
    }
    return {
      ok: true,
      verdict,
      coverage,
      bytes: payloadBytes,
      exit: REVIEW_EXIT_CODES.ok,
    };
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) {
      return { ok: false, code: 'TRISS_CANCELLED', message: 'cancelled during model call', exit: REVIEW_EXIT_CODES.cancelled, cause: err };
    }
    // Preserve a typed provider code (e.g. TRISS_PROVIDER_EMPTY) when
    // present. A provider failure without its own code is an unknown
    // provider error, not an input error — callers must not re-label a
    // connection/timeout failure as "invalid input". Preserve the original
    // error as cause so callers that expect the exact sentinel (buffered /
    // streaming rejection parity, REV-GLM-THINK-12..17) can rethrow it
    // unchanged.
    const fallbackCode = err?.code ? err.code : 'TRISS_PROVIDER_UNKNOWN';
    return { ok: false, code: fallbackCode, message: err?.message || String(err), exit: REVIEW_EXIT_CODES.provider, cause: err };
  }
}

/**
 * Render the CLI review result: scoped verdict framing with the coverage
 * summary. Never prints raw diff contents.
 */
export function renderCliReviewResult(result, { write = (s) => process.stdout.write(s) } = {}) {
  if (!result.ok) {
    write(`✗ ${result.message || result.code || 'review failed'}\n`);
    return result.exit ?? REVIEW_EXIT_CODES.invalidInput;
  }
  const cov = result.coverage;
  const scopeLine = cov?.requested
    ? `Scope: ${cov.requested.coverage} (${cov.requested.matched.length}/${(cov.requested.matched.length + cov.requested.unmatched.length)} requested files)`
    : `Repository coverage: ${cov?.repository?.coverage ?? 'unknown'}`;
  write(`${scopeLine}\n`);
  if (cov?.unsupported_files?.length) {
    write(`Unsupported (binary): ${cov.unsupported_files.length} file(s)\n`);
  }
  write(`Bytes: ${result.bytes ?? 0}\n`);
  write(`${result.verdict}\n`);
  return REVIEW_EXIT_CODES.ok;
}

// ─── sequential shard execution (Atomic 44 / Package 23) ────────────────────

/**
 * Execute a planned shard plan sequentially: each shard is one model call,
 * source-ordered; the FIRST failure or cancellation stops the sequence (no
 * third call after a second-shard failure). There is NO aggregation call and
 * NO global verdict — results are per-shard only. Attempt/usage facts are
 * returned per shard; every limit is re-checked at execution time (fresh
 * boundaries, never trusting the plan alone).
 *
 * @param {object} deps injected seams
 * @param {Function} deps.callModel one-shot provider call (text in/out)
 * @param {object} deps.limits Package 13 frozen limits
 * @param {object} opts
 * @param {Array} opts.shards planned shards [{sections, bytes}]
 * @param {string} opts.question
 * @param {string} [opts.metadata='']
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ok: boolean, code?: string, shards?: Array,
 *   attempts?: number, message?: string}>}
 */
export async function executeReviewPlan(deps, { shards, question, metadata = '', signal }) {
  if (typeof deps?.callModel !== 'function') throw new TypeError('callModel is required');
  if (!Array.isArray(shards) || shards.length === 0) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'an empty shard plan cannot execute' };
  }
  if (signal?.aborted) return { ok: false, code: 'TRISS_CANCELLED', message: 'cancelled', exit: REVIEW_EXIT_CODES.cancelled };

  const limits = deps.limits || reviewLimitConfig().limits;
  const results = [];
  let attempts = 0;

  // P1 fix: re-check the GLOBAL plan bounds at execution time too — a
  // stale or directly supplied plan may exceed maxShards or the cumulative
  // totalMaxBytes even when every individual shard passes its own bound.
  if (shards.length > limits.maxShards) {
    return { ok: false, code: 'TRISS_REVIEW_LIMIT', message: `plan exceeds ${limits.maxShards} shards`, shards: results, attempts, exit: REVIEW_EXIT_CODES.limit };
  }
  let cumulativeBytes = 0;

  for (const shard of shards) {
    if (signal?.aborted) {
      return { ok: false, code: 'TRISS_CANCELLED', message: 'cancelled between shards', shards: results, attempts, exit: REVIEW_EXIT_CODES.cancelled };
    }
    // Fresh boundary re-check: the plan may be stale.
    if (shard.bytes > limits.shardMaxBytes) {
      return { ok: false, code: 'TRISS_REVIEW_LIMIT', message: `shard exceeds ${limits.shardMaxBytes} bytes`, shards: results, attempts, exit: REVIEW_EXIT_CODES.limit };
    }
    const payloadBytes = shard.bytes;
    // Cumulative total bound BEFORE the model call, not just per shard.
    cumulativeBytes += payloadBytes;
    if (cumulativeBytes > limits.totalMaxBytes) {
      return { ok: false, code: 'TRISS_REVIEW_LIMIT', message: `cumulative shard payload exceeds ${limits.totalMaxBytes} bytes`, shards: results, attempts, exit: REVIEW_EXIT_CODES.limit };
    }

    attempts += 1;
    try {
      const verdict = await deps.callModel({ shard, question, metadata, signal });
      if (typeof verdict !== 'string' || verdict.trim().length === 0) {
        return { ok: false, code: 'TRISS_PROVIDER_EMPTY', message: `shard ${attempts} returned an empty verdict`, shards: results, attempts, exit: REVIEW_EXIT_CODES.provider };
      }
      results.push({ shard_index: attempts, verdict, bytes: payloadBytes, attempt: attempts });
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        return { ok: false, code: 'TRISS_CANCELLED', message: `cancelled during shard ${attempts}`, shards: results, attempts, exit: REVIEW_EXIT_CODES.cancelled, cause: err };
      }
      return {
        ok: false,
        code: err?.code || 'TRISS_PROVIDER_UNKNOWN',
        message: err?.message || String(err),
        shards: results,
        attempts,
        exit: REVIEW_EXIT_CODES.provider,
        cause: err,
      };
    }
  }

  // No aggregation: per-shard results only, no global verdict.
  return { ok: true, shards: results, attempts, exit: REVIEW_EXIT_CODES.ok };
}

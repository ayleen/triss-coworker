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
export async function executeSingleReview(deps, { diff, question, selectors = [], signal }) {
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

  // Single-request byte bound (Package 13 limits injected).
  const payloadBytes = Buffer.byteLength(diff, 'utf8') + Buffer.byteLength(question, 'utf8');
  if (payloadBytes > limits.totalMaxBytes) {
    return { ok: false, code: 'TRISS_REVIEW_LIMIT', message: `review payload exceeds ${limits.totalMaxBytes} bytes`, exit: REVIEW_EXIT_CODES.limit };
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
      return { ok: false, code: 'TRISS_CANCELLED', message: 'cancelled during model call', exit: REVIEW_EXIT_CODES.cancelled };
    }
    return { ok: false, code: err?.code || 'TRISS_REVIEW_INVALID_INPUT', message: err?.message || String(err), exit: REVIEW_EXIT_CODES.provider };
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

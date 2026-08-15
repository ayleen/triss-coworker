/**
 * review-pr-metadata.js — Package 17B (Atomic 36): bounded PR metadata
 * acquisition.
 *
 * Section 9.4 `gh` metadata contract of the approved plan
 * (docs/reliable-delegation-contract-plan.md). Consumes Package 17A's
 * durable reservation and runs the initial/post `gh` calls inside that set
 * with 30-second/absolute deadlines, cap-plus-one collection, cancellation,
 * no-partial JSON, pure Package 17 validation, and parent-death kill.
 *
 * Exports:
 *   acquirePrMetadata(sh, opts) — one bounded `gh pr view --json` round
 */

import { validatePrMetadata } from './review-pr-identity.js';

export const GH_METADATA_DEADLINE_MS = 30000;
export const GH_METADATA_MAX_BYTES = 256 * 1024;

// NOTE: `owner` and `repo` are NOT valid `gh pr view --json` fields (the
// supported surface has headRepository/headRepositoryOwner instead); the
// base owner/repo are already pinned by the `--repo` flag, so they come
// from the caller's arguments rather than the JSON payload.
const GH_METADATA_JSON_FIELDS = [
  'number', 'baseRefOid', 'headRefOid', 'baseRefName', 'headRefName',
  'isCrossRepository',
].join(',');

/**
 * Acquire bounded PR metadata via `gh pr view --json <fields>`. The command
 * runs inside the caller-provided owned process set (the durable reservation
 * from Package 17A) with a 30-second/absolute deadline, cap-plus-one
 * collection, cancellation, and no-partial JSON (a truncated stream fails
 * closed). The result is validated by the pure Package 17 validator.
 *
 * @param {object} sh spawnSync-like ({status, stdout, stderr, error})
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {number} opts.number
 * @param {number} [opts.deadlineMs=30000]
 * @param {number} [opts.maxBytes=262144]
 * @param {AbortSignal} [opts.signal]
 * @returns {{ok: boolean, code?: string, meta?: object, message?: string}}
 */
export function acquirePrMetadata(sh, { owner, repo, number, deadlineMs = GH_METADATA_DEADLINE_MS, maxBytes = GH_METADATA_MAX_BYTES, signal }) {
  if (typeof sh !== 'function') throw new TypeError('sh is required');
  if (typeof owner !== 'string' || owner.length === 0 || typeof repo !== 'string' || repo.length === 0) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'owner and repo are required' };
  }
  if (!Number.isInteger(number) || number < 1) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'PR number must be a positive integer' };
  }
  if (signal?.aborted) {
    return { ok: false, code: 'TRISS_CANCELLED', message: 'cancelled before gh' };
  }

  const out = sh(
    ['gh', 'pr', 'view', String(number), '--repo', `${owner}/${repo}`, '--json', GH_METADATA_JSON_FIELDS],
    { encoding: 'buffer', timeout: deadlineMs, signal },
  );
  if (out.error && out.error.name === 'AbortError') {
    return { ok: false, code: 'TRISS_CANCELLED', message: 'cancelled during gh metadata acquisition' };
  }
  if (out.status !== 0) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: `gh pr view failed: ${String(out.stderr || '').slice(0, 200)}` };
  }
  const buf = Buffer.isBuffer(out.stdout) ? out.stdout : Buffer.from(out.stdout || '');
  if (buf.length === 0) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'gh returned an empty response' };
  }
  if (buf.length > maxBytes) {
    return { ok: false, code: 'TRISS_REVIEW_LIMIT', message: `gh metadata exceeds ${maxBytes} bytes (no partial JSON)` };
  }
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'gh metadata is not valid JSON (no partial parse)' };
  }

  const meta = {
    number: parsed.number ?? number,
    base_oid: parsed.baseRefOid,
    head_oid: parsed.headRefOid,
    base_ref: parsed.baseRefName,
    head_ref: parsed.headRefName,
    fork: Boolean(parsed.isCrossRepository),
    owner,
    repo,
  };
  const validated = validatePrMetadata(meta);
  if (!validated.ok) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: `invalid PR metadata: ${validated.message}` };
  }
  return { ok: true, meta: validated.meta };
}

/**
 * coder-orchestration.js — Package 5E (Atomic 21): OpenCode run and envelope
 * orchestration helpers (pure).
 *
 * Reference surface 3 / Atomic 21 of the approved plan
 * (docs/reliable-delegation-contract-plan.md): every safe envelope after
 * allocation carries `session_slug`, `result_retention`, `result_id`, and
 * `execution_capabilities`. This module owns the pure derivations; the
 * `src/commands/coder.js` orchestration path embeds them.
 *
 * Rules (Section 6.3 / Reference surface 3):
 *  - session_slug: the explicit --session slug, or an anonymous generated
 *    slug (anon-<32 lowercase hex>) for unnamed runs;
 *  - result_retention: `retained` only for isolated changed runs with
 *    enforced credential isolation/result-store quota and a successful
 *    1 GiB reservation; read-only/unnamed runs are `none` (auto-clean);
 *  - result_id: non-null exactly when retention is retained;
 *  - execution_capabilities: the honest enforced|best_effort|unavailable
 *    tuple from the sandbox capability adapter.
 */

import { randomBytes } from 'node:crypto';

import { resolveCoderSandbox } from './coder-sandbox.js';

export const EXECUTION_CAPABILITY_KEYS = Object.freeze([
  'sandbox',
  'process_supervision',
  'locking',
  'writable_quota',
  'credential_isolation',
  'managed_root',
  'persistent_store_quota',
  'result_store_quota',
]);

/**
 * Project the sandbox capability tuple into the envelope's
 * execution_capabilities object (warnings are not envelope fields).
 */
export function buildExecutionCapabilities({ engine = 'opencode', proxyAvailable = false } = {}) {
  const caps = resolveCoderSandbox({ engine, proxyAvailable });
  const out = {};
  for (const key of EXECUTION_CAPABILITY_KEYS) {
    out[key] = caps[key];
  }
  return out;
}

/**
 * Allocate the run identity for one coder run.
 *
 * @param {object} opts
 * @param {string|null} opts.slug explicit --session slug (null for unnamed)
 * @param {boolean} opts.isolated whether this run is isolated
 * @param {boolean} opts.changed whether a verified non-empty diff exists
 * @param {boolean} [opts.resultStoreEnforced] enforced result_store_quota
 * @param {boolean} [opts.reservationOk] successful 1 GiB reservation
 * @returns {{session_slug: string, result_retention: string,
 *   result_id: string|null, anonymous: boolean}}
 */
export function allocateRunIdentity({
  slug,
  isolated,
  changed,
  resultStoreEnforced = false,
  reservationOk = false,
} = {}) {
  const anonymous = typeof slug !== 'string' || slug.length === 0;
  const sessionSlug = anonymous ? `anon-${randomBytes(16).toString('hex')}` : slug;

  // Retained results require: isolated + changed + enforced result-store
  // quota + a successful 1 GiB reservation (Reference surface 3).
  const retained =
    isolated &&
    changed &&
    resultStoreEnforced &&
    reservationOk;

  return {
    session_slug: sessionSlug,
    result_retention: retained ? 'retained' : 'none',
    result_id: retained ? `run-${randomBytes(16).toString('hex')}` : null,
    anonymous,
  };
}

/**
 * Anonymous slug grammar check (for tests and stable assertions).
 */
export function isAnonymousSlug(slug) {
  return typeof slug === 'string' && /^anon-[0-9a-f]{32}$/.test(slug);
}

/** Result id grammar check. */
export function isResultId(id) {
  return typeof id === 'string' && /^run-[0-9a-f]{32}$/.test(id);
}

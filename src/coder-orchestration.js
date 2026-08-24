/**
 * coder-orchestration.js — OpenCode run and envelope
 * orchestration helpers (pure).
 *
 * documented contract / transition of the approved plan
 * (docs/reliable-delegation-contract-plan.md): every safe envelope after
 * allocation carries `session_slug`, `result_retention`, `result_id`, and
 * `execution_capabilities`. This module owns the pure derivations; the
 * `src/commands/coder.js` orchestration path embeds them.
 *
 * Rules (Section 6.3 / documented contract):
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
import { assertCoderCredentialMode } from './coder-providers.js';

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
export function buildExecutionCapabilities({
  engine = 'opencode',
  proxyAvailable = false,
  // Already resolved by the caller via resolveCoderCredentialMode — no hidden
  // default that could silently re-enable protected_proxy semantics.
  credentialMode,
} = {}) {
  assertCoderCredentialMode(credentialMode);
  const caps = resolveCoderSandbox({
    engine,
    // Raw best-effort deliberately cannot inherit the proxy capability for
    // OpenCode, which intentionally skips the proxy in that mode. Crush is
    // different: runCrushFlow always requires and starts its proxy, so the
    // OpenCode-only mode must not falsify Crush's capability envelope.
    proxyAvailable: engine !== 'crush' && credentialMode === 'best_effort_raw'
      ? false
      : proxyAvailable,
  });
  const out = {};
  for (const key of EXECUTION_CAPABILITY_KEYS) {
    out[key] = caps[key];
  }
  return out;
}

// ─── v2 lifecycle fields (Section 6.1/6.2 derivations) ───────────────────────

export const V2_ENUMS = Object.freeze({
  process_status: ['not_started', 'completed', 'error', 'timeout', 'killed'],
  termination_cause: [
    'none', 'deadline', 'caller_abort', 'host_signal', 'provider_rate_limit',
    'output_limit', 'filesystem_quota', 'child_signal',
  ],
  engine_status: [
    'not_observed', 'completed', 'error', 'timeout', 'rate_limited',
    'max_cost', 'max_tokens', 'cancelled', 'unknown',
  ],
  cleanup_status: ['verified', 'failed', 'best_effort', 'not_applicable'],
  provider_status: [
    'usable', 'not_observed', 'connection_error', 'timeout', 'empty_response',
    'rate_limited', 'authentication_error', 'model_error', 'policy_denied',
    'unknown_error',
  ],
  session_persistence: ['ephemeral', 'persistent', 'ephemeral_downgraded'],
  effective_isolation: [
    'isolated_enforced', 'non_isolated_requested', 'best_effort_caller_worktree',
  ],
  expectation: ['changes', 'analysis', 'either'],
  artifact_status: ['changes_present', 'no_changes', 'text_only', 'no_artifact', 'not_checked'],
  requirement_status: ['satisfied', 'unsatisfied', 'not_evaluated'],
});

/**
 * Derive the v2 lifecycle fields from the observed run facts (Section 6.1
 * first-match table + Section 6.2 derivation), HONESTLY under today's
 * capabilities: process supervision is best_effort, so cleanup_status is
 * never `verified`, change evidence cannot claim `changes_present`, and
 * persistence is eligible only after the caller confirms the durable idle
 * transition. The observed files_changed/run_files_changed data is still
 * REPORTED (a real, performed git comparison) while the CLAIMING fields
 * (change_detection/artifact_status/requirement_status) stay conservative —
 * a deliberate, documented deviation from nulling out files_changed, which
 * would destroy real data without adding safety.
 */
export function deriveV2LifecycleFields({
  timedOut = false,
  terminationCause = 'none',
  signal = null,
  exitCode = 0,
  engineErrorObserved = false,
  rateLimited = false,
  exitReason = 'error',
  finalText = null,
  toolActivityCount = 0,
  isolated = false,
  callerWorktreeDowngrade = false,
  sessionRequested = false,
  // Whether the v2 persistent claim was actually ADMITTED (a non-null
  // session handle). A requested-but-downgraded claim must never be
  // reported as continuable.
  v2SessionAdmitted = false,
  // Completion is authoritative for a requested session. Admission only
  // proves that a row was reserved; it does not prove a resumable idle row.
  completionOutcome = null,
}) {
  // process_status / termination_cause (first-match precedence).
  let processStatus;
  if (timedOut) processStatus = 'timeout';
  else if (terminationCause && terminationCause !== 'none') processStatus = 'killed';
  else if (signal) processStatus = 'killed';
  else if (exitCode === 0) processStatus = 'completed';
  else processStatus = 'error';
  const terminationCauseV2 = timedOut ? 'deadline' : (terminationCause || 'none');

  // engine_status: protocol evidence wins; explicit engine errors beat a
  // fake-clean exit; missing terminal evidence after a zero exit is unknown.
  let engineStatus;
  if (rateLimited) engineStatus = 'rate_limited';
  else if (engineErrorObserved) engineStatus = 'error';
  else if (exitReason === 'end_turn') engineStatus = 'completed';
  else if (exitReason === 'timeout') engineStatus = 'timeout';
  else if (exitReason === 'killed') engineStatus = 'cancelled';
  else engineStatus = 'unknown';

  // provider_status: positive provider evidence is engine-specific text or
  // tool activity; rate-limit evidence wins over generic classification;
  // absence of evidence is never a provider failure.
  const usableText = typeof finalText === 'string' && finalText.trim().length > 0;
  let providerStatus;
  if (rateLimited) providerStatus = 'rate_limited';
  else if (usableText || toolActivityCount > 0) providerStatus = 'usable';
  else if (engineErrorObserved) providerStatus = 'unknown_error';
  else providerStatus = 'not_observed';

  // cleanup_status: a child ran under best-effort supervision (no enforced
  // descendant-tree ownership exists today), so verified is impossible.
  const cleanupStatus = 'best_effort';

  // §6.2 best-effort precedence: text_only when usable trimmed text exists,
  // otherwise not_checked — change evidence cannot be claimed.
  const artifactStatus = usableText ? 'text_only' : 'not_checked';

  return {
    process_status: processStatus,
    termination_cause: terminationCauseV2,
    engine_status: engineStatus,
    cleanup_status: cleanupStatus,
    provider_status: providerStatus,
    // Contract (Section 6): the slug is a continuation key ONLY when
    // session_persistence=persistent — i.e. admission reserved a row and
    // completion confirmed a durable resumable idle row. A requested-but-
    // downgraded run reports ephemeral_downgraded; an unnamed run is plain
    // ephemeral.
    session_persistence: !sessionRequested
      ? 'ephemeral'
      : !v2SessionAdmitted
        ? 'ephemeral_downgraded'
        : completionOutcome === 'persistent'
          ? 'persistent'
          : 'ephemeral_downgraded',
    effective_isolation: callerWorktreeDowngrade
      ? 'best_effort_caller_worktree'
      : isolated
        ? 'isolated_enforced'
        : 'non_isolated_requested',
    expectation: 'either',
    artifact_status: artifactStatus,
    requirement_status: 'not_evaluated',
    change_detection: {
      status: 'not_checked',
      basis: null,
      error: null,
    },
  };
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
  // quota + a successful 1 GiB reservation (documented contract).
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

/**
 * coder-result.js — Package 1 (Atomic 01): pure coder result and lifecycle
 * contract.
 *
 * Single source of truth for the v2 envelope's orthogonal lifecycle facts
 * (Section 6.1), the deterministic artifact/requirement matrix (Section 6.2),
 * and bounded activity normalization (Section 6.4) of the approved plan
 * (docs/reliable-delegation-contract-plan.md).
 *
 * Every function here is pure and dependency-free: no fs, no process, no
 * network, no global state. Prose is never inspected for completion phrases;
 * `final_text` is judged only by `trim().length > 0` and is preserved
 * untrimmed when returned.
 */

// ─── frozen enums (Section 6.1) ──────────────────────────────────────────────

export const PROCESS_STATUS = Object.freeze([
  'not_started',
  'completed',
  'error',
  'timeout',
  'killed',
]);

export const TERMINATION_CAUSE = Object.freeze([
  'none',
  'deadline',
  'caller_abort',
  'host_signal',
  'provider_rate_limit',
  'output_limit',
  'filesystem_quota',
  'child_signal',
]);

export const ENGINE_STATUS = Object.freeze([
  'not_observed',
  'completed',
  'error',
  'timeout',
  'rate_limited',
  'max_cost',
  'max_tokens',
  'cancelled',
  'unknown',
]);

export const CLEANUP_STATUS = Object.freeze([
  'verified',
  'failed',
  'best_effort',
  'not_applicable',
]);

export const PROVIDER_STATUS = Object.freeze([
  'usable',
  'not_observed',
  'connection_error',
  'timeout',
  'empty_response',
  'rate_limited',
  'authentication_error',
  'model_error',
  'policy_denied',
  'unknown_error',
]);

export const EXPECTATION = Object.freeze(['changes', 'analysis', 'either']);

export const CHANGE_DETECTION_STATUS = Object.freeze([
  'verified',
  'not_checked',
  'failed',
]);

export const CHANGE_DETECTION_BASIS = Object.freeze([
  'isolated_fingerprint_snapshots',
  null,
]);

export const ARTIFACT_STATUS = Object.freeze([
  'changes_present',
  'no_changes',
  'text_only',
  'no_artifact',
  'not_checked',
]);

export const REQUIREMENT_STATUS = Object.freeze([
  'satisfied',
  'unsatisfied',
  'not_evaluated',
]);

export const RESULT_RETENTION = Object.freeze(['none', 'retained']);

export const SESSION_PERSISTENCE = Object.freeze([
  'ephemeral',
  'persistent',
  'ephemeral_downgraded',
]);

export const EFFECTIVE_ISOLATION = Object.freeze([
  'isolated_enforced',
  'non_isolated_requested',
  'best_effort_caller_worktree',
]);

export const CAPABILITY_VALUE = Object.freeze([
  'enforced',
  'best_effort',
  'unavailable',
]);

// Closed non-enforced capability-warning enum (Section 6.1): one code appears
// once for each capability whose value is not `enforced`, in field order, plus
// the persistence downgrade code. Package 1 exports this closed enum; tests
// duplicate suppression and order.
export const CAPABILITY_WARNING_CODES = Object.freeze([
  'TRISS_CODER_CAP_SANDBOX_BEST_EFFORT',
  'TRISS_CODER_CAP_PROCESS_SUPERVISION_BEST_EFFORT',
  'TRISS_CODER_CAP_LOCKING_BEST_EFFORT',
  'TRISS_CODER_CAP_WRITABLE_QUOTA_BEST_EFFORT',
  'TRISS_CODER_CAP_MANAGED_ROOT_BEST_EFFORT',
  'TRISS_CODER_CAP_PERSISTENT_STORE_QUOTA_BEST_EFFORT',
  'TRISS_CODER_CAP_RESULT_STORE_QUOTA_BEST_EFFORT',
  'TRISS_CODER_PERSISTENCE_UNAVAILABLE',
]);

export const ISOLATION_DOWNGRADED_CODE = 'TRISS_CODER_ISOLATION_DOWNGRADED';
export const ISOLATION_ENFORCEMENT_REQUIRED_CODE = 'TRISS_CODER_ISOLATION_ENFORCEMENT_REQUIRED';

// Ordered execution_capabilities object keys (Section 6.1). `unavailable`
// uses the same warning code as `best_effort` because the machine-readable
// capability value distinguishes it from a weaker active mechanism.
export const EXECUTION_CAPABILITIES_KEYS = Object.freeze([
  'sandbox',
  'process_supervision',
  'locking',
  'writable_quota',
  'credential_isolation',
  'managed_root',
  'persistent_store_quota',
  'result_store_quota',
]);

// ─── expectation (Section 6.1) ───────────────────────────────────────────────

/**
 * Resolve a raw expectation input to a canonical `changes|analysis|either`.
 * Missing/undefined resolves to `either` (the compatibility default);
 * anything else outside the closed enum is rejected.
 */
export function resolveExpectation(raw) {
  if (raw === undefined || raw === null || raw === '') return 'either';
  if (EXPECTATION.includes(raw)) return raw;
  throw new TypeError(`unknown expectation: ${JSON.stringify(raw)}`);
}

// ─── activity normalization (Section 6.4) ────────────────────────────────────

/**
 * Normalize bounded activity facts into one diagnostic-only shape.
 *
 * OpenCode form: `{ engine: 'opencode', events: [...] }` — counts every
 * parseable event and every `tool_use`, counts `tool_use.part.state.status
 * === 'error'` as tool_errors, increments by_tool[tool] (missing or
 * non-string tool → `unknown`), caps distinct tool names at 32 collecting
 * the remainder under `other`, sets `saw_terminal_stop` only for
 * `step_finish.part.reason === 'stop'`, and records host-observed arrival
 * timestamps for the first and last parseable events (`arrivedAt`, if
 * present; engine-supplied clocks are never trusted or required).
 *
 * Crush form: `{ engine: 'crush', toolCalls: [{name, count}] }` — normalizes
 * the aggregate into the same shape. Absent or malformed shape reports zero
 * counts plus a warning; activity is never invented.
 *
 * Never persists `input`, `output`, `error`, command lines, or file contents.
 */
export function normalizeActivity(input) {
  const engine = input?.engine;
  if (engine === 'opencode') {
    return normalizeOpenCodeActivity(input.events ?? []);
  }
  if (engine === 'crush') {
    return normalizeCrushActivity(input.toolCalls);
  }
  throw new TypeError(`unknown activity engine: ${JSON.stringify(engine)}`);
}

const MAX_DISTINCT_TOOLS = 32;

function normalizeOpenCodeActivity(events) {
  const byTool = new Map();
  let toolUses = 0;
  let toolErrors = 0;
  let sawTerminalStop = false;
  let firstEventAt = null;
  let lastEventAt = null;
  let parseable = 0;

  for (const evt of events) {
    if (!evt || typeof evt !== 'object') continue;
    parseable += 1;
    const arrivedAt = evt.arrivedAt;
    if (arrivedAt !== undefined && arrivedAt !== null) {
      if (firstEventAt === null) firstEventAt = arrivedAt;
      lastEventAt = arrivedAt;
    }
    if (evt.type === 'tool_use') {
      toolUses += 1;
      const tool = evt.part?.tool;
      const toolName = typeof tool === 'string' && tool.length > 0 ? tool : 'unknown';
      byTool.set(toolName, (byTool.get(toolName) ?? 0) + 1);
      if (evt.part?.state?.status === 'error') toolErrors += 1;
    } else if (evt.type === 'step_finish' && evt.part?.reason === 'stop') {
      sawTerminalStop = true;
    }
  }

  return {
    events: parseable,
    tool_uses: toolUses,
    tool_errors: toolErrors,
    by_tool: foldToolMap(byTool),
    saw_terminal_stop: sawTerminalStop,
    first_event_at: firstEventAt,
    last_event_at: lastEventAt,
  };
}

function normalizeCrushActivity(toolCalls) {
  if (!Array.isArray(toolCalls)) {
    return {
      events: 0,
      tool_uses: 0,
      tool_errors: 0,
      by_tool: {},
      saw_terminal_stop: false,
      first_event_at: null,
      last_event_at: null,
      warnings: ['crush tool_calls aggregate absent or malformed'],
    };
  }

  const byTool = new Map();
  let toolUses = 0;
  for (const entry of toolCalls) {
    if (!entry || typeof entry !== 'object') continue;
    const name = entry.name;
    const count = Number(entry.count);
    if (typeof name !== 'string' || name.length === 0) continue;
    if (!Number.isInteger(count) || count < 0) continue;
    toolUses += count;
    byTool.set(name, (byTool.get(name) ?? 0) + count);
  }

  return {
    events: 0,
    tool_uses: toolUses,
    tool_errors: 0,
    by_tool: foldToolMap(byTool),
    saw_terminal_stop: false,
    first_event_at: null,
    last_event_at: null,
  };
}

// Cap distinct tool names at 32, collecting the remainder under `other` in
// first-seen order.
function foldToolMap(byTool) {
  const names = [...byTool.keys()];
  const folded = {};
  for (const name of names.slice(0, MAX_DISTINCT_TOOLS)) {
    folded[name] = byTool.get(name);
  }
  if (names.length > MAX_DISTINCT_TOOLS) {
    let other = 0;
    for (const name of names.slice(MAX_DISTINCT_TOOLS)) {
      other += byTool.get(name);
    }
    folded.other = (folded.other ?? 0) + other;
  }
  return folded;
}

// ─── artifact derivation (Section 6.2) ───────────────────────────────────────

/**
 * Derive `artifact_status` independently from expectation and failure state,
 * per Section 6.2:
 *
 * 1. a verified non-empty deliverable diff is `changes_present`;
 * 2. otherwise usable trimmed final text is `text_only`;
 * 3. otherwise a verified empty deliverable diff is `no_changes`;
 * 4. an unavailable comparison with no text is `not_checked`;
 * 5. everything else is `no_artifact`.
 *
 * `cleanup_status: best_effort` has explicit precedence: it can never produce
 * `changes_present` or `no_changes` — it returns `text_only` when usable
 * trimmed final text exists, otherwise `not_checked`.
 *
 * @param {object} input
 * @param {string} input.cleanupStatus
 * @param {boolean} input.hasUsableText  trimmed final text exists
 * @param {Array|null|undefined} input.runFilesChanged  verified list or null
 * @param {string} input.changeDetectionStatus  verified|not_checked|failed
 */
export function deriveArtifactStatus(input) {
  const { cleanupStatus, hasUsableText, runFilesChanged, changeDetectionStatus } = input;

  if (cleanupStatus === 'best_effort') {
    return hasUsableText ? 'text_only' : 'not_checked';
  }

  if (Array.isArray(runFilesChanged) && runFilesChanged.length > 0) {
    return 'changes_present';
  }
  if (hasUsableText) return 'text_only';
  if (Array.isArray(runFilesChanged) && runFilesChanged.length === 0) {
    return 'no_changes';
  }
  if (changeDetectionStatus !== 'verified' && !hasUsableText) return 'not_checked';
  return 'no_artifact';
}

// ─── result facts (Sections 6.1/6.2, Reference surface 1) ───────────────────

/**
 * Derive the complete orthogonal result-facts block for one run.
 *
 * Artifacts are derived BEFORE the requirement failure gate, so a failed run
 * with a verified deliverable diff still reports `changes_present`.
 *
 * Input (all values are the envelope's normalized lifecycle facts):
 *   expectation, processStatus, terminationCause, engineStatus,
 *   cleanupStatus, providerStatus, changeDetectionStatus, runFilesChanged,
 *   finalText, effectiveIsolation, sessionPersistence, runId.
 *
 * Output: { failClosed, artifactStatus, requirementStatus, resultRetention,
 *           resultId, usableText, noEnvelopeReason }
 *
 * `failClosed` is true when cleanup `failed` after child creation — the
 * matrix's first row: no envelope may be emitted at all.
 */
export function deriveCoderResultFacts(input = {}) {
  const expectation = resolveExpectation(input.expectation);
  const finalText = typeof input.finalText === 'string' ? input.finalText : '';
  const usableText = finalText.trim().length > 0;
  const cleanupStatus = input.cleanupStatus ?? 'not_applicable';
  const changeDetectionStatus = input.changeDetectionStatus ?? 'not_checked';
  const runFilesChanged = input.runFilesChanged ?? null;

  // Artifacts first, before any failure gate (Reference surface 1).
  const artifactStatus = deriveArtifactStatus({
    cleanupStatus,
    hasUsableText: usableText,
    runFilesChanged,
    changeDetectionStatus,
  });

  // Section 6.2 requirement matrix, first matching row.
  let requirementStatus = 'not_evaluated';
  let failClosed = false;
  let noEnvelopeReason = null;

  if (cleanupStatus === 'failed') {
    // Row 1: cleanup failed after child creation → fail closed, no envelope.
    failClosed = true;
    noEnvelopeReason = 'cleanup_failed';
  } else if (cleanupStatus === 'best_effort') {
    // Rows 2-3: advisory-only envelope, never satisfied.
    requirementStatus = 'not_evaluated';
    noEnvelopeReason = 'cleanup_best_effort';
  } else if (cleanupStatus === 'not_applicable' && input.processStatus === 'not_started') {
    // Row 4: no child ever existed.
    requirementStatus = expectation === 'either' ? 'not_evaluated' : 'unsatisfied';
  } else if (input.processStatus !== 'completed') {
    // Row 5: process not completed.
    requirementStatus = expectation === 'either' ? 'not_evaluated' : 'unsatisfied';
  } else if (input.engineStatus !== 'completed') {
    // Row 6: engine not completed — top-level OpenCode error, Crush
    // exit_reason error|timeout|max_cost|max_tokens, etc.
    requirementStatus = expectation === 'either' ? 'not_evaluated' : 'unsatisfied';
  } else if (input.providerStatus !== 'usable') {
    // Row 7: provider not usable.
    requirementStatus = expectation === 'either' ? 'not_evaluated' : 'unsatisfied';
  } else {
    // All gates normal.
    if (expectation === 'changes') {
      if (changeDetectionStatus !== 'verified') {
        // Row 8: run comparison failed/unavailable.
        requirementStatus = 'not_evaluated';
      } else if (Array.isArray(runFilesChanged) && runFilesChanged.length > 0) {
        // Row 9.
        requirementStatus = 'satisfied';
      } else {
        // Row 10: verified empty (or non-array verified? verified is a list).
        requirementStatus = 'unsatisfied';
      }
    } else if (expectation === 'analysis') {
      if (
        usableText &&
        changeDetectionStatus === 'verified' &&
        Array.isArray(runFilesChanged) &&
        runFilesChanged.length === 0
      ) {
        // Row 11: usable trimmed final text + verified empty run diff.
        requirementStatus = 'satisfied';
      } else if (usableText && runFilesChanged !== null) {
        // Row 12: usable text + non-empty/unavailable run diff.
        requirementStatus = 'not_evaluated';
      } else if (!usableText) {
        // Row 13: empty/whitespace final text.
        requirementStatus = 'unsatisfied';
      } else {
        // Row 12 fallback: usable text + non-empty/unavailable.
        requirementStatus = 'not_evaluated';
      }
    } else {
      // Row 14: expectation `either` never claims semantic satisfaction.
      requirementStatus = 'not_evaluated';
    }
  }

  // Result retention (Section 6.3/reference surfaces): a verified changed
  // ephemeral run derives `retained` with its run-bound result_id; a
  // read-only ephemeral run derives `none`/null. Retention is only ever
  // claimed on verified cleanup with verified change evidence.
  const ephemeral = input.sessionPersistence === 'ephemeral' || input.sessionPersistence === undefined;
  const isolatedEnforced = input.effectiveIsolation === 'isolated_enforced';
  const changed =
    cleanupStatus === 'verified' &&
    changeDetectionStatus === 'verified' &&
    Array.isArray(runFilesChanged) &&
    runFilesChanged.length > 0;

  let resultRetention = 'none';
  let resultId = null;
  if (ephemeral && isolatedEnforced && changed) {
    resultRetention = 'retained';
    resultId = input.runId ?? null;
  }

  return {
    failClosed,
    artifactStatus,
    requirementStatus,
    resultRetention,
    resultId,
    usableText,
    noEnvelopeReason,
  };
}

// ─── bounded blocker diagnostics (Atomic 27 / Package 10A) ──────────────────

export const BLOCKER_CATEGORIES = Object.freeze([
  'environment_permission',
  'execution_policy',
  'lock_or_process_state',
  'unknown',
]);

export const BLOCKER_MAX_ENTRIES = 16;

// Explicit evidence shapes. Prose is never scanned for completion phrases;
// only these structured signals classify a blocker.
const PERMISSION_EVIDENCE_RE = [
  /\b(EPERM|EACCES)\b/,
  /\bpermission denied\b/i,
  /\boperation not permitted\b/i,
];
const POLICY_EVIDENCE_RE = [
  /\b(?:denied|rejected|blocked|not allowed|not permitted|prohibited).*(?:policy|guideline|safety|moderation|allowlist)/i,
  /\b(?:policy|safety|moderation|allowlist).*(?:denied|rejection|blocked|violation)/i,
];
const LOCK_EVIDENCE_RE = [
  /\b(lock|unlock)\b/i,
  /\bprocess(?:es)? (?:already )?(?:running|exist|alive)\b/i,
  /\bslot .*held\b/i,
];

/**
 * Classify bounded blocker diagnostics from raw tool/engine error evidence.
 * Pure and dependency-free: never probes servers, never deletes locks, never
 * inspects prose for completion phrases. The returned objects contain NO raw
 * command, tool input/output, secret-like value, or absolute path.
 *
 * @param {Array<{text?: string}>} rawEvidence
 * @returns {Array<{category: string, hint: string|null}>} at most 16 entries
 *   with duplicate categories collapsed (first-wins hint)
 */
export function classifyCoderBlockers(rawEvidence) {
  if (!Array.isArray(rawEvidence)) return [];
  const seen = new Set();
  const blockers = [];
  for (const item of rawEvidence) {
    const text = typeof item?.text === 'string' ? item.text : '';
    // Sanitize evidence before matching: strip control bytes, secret-like
    // tokens, URLs, and absolute paths so they can never enter a hint.
    let clean = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp < 0x20 || cp === 0x7f) clean += ' ';
      else clean += ch;
    }
    clean = clean
      .replace(/(sk-|zk-|zai-)[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
      .replace(/\s+[^\s]*:\/\/[^\s]+/g, ' [URL-REDACTED]')
      .replace(/(^|\s)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){2,}/g, '$1/[PATH-REDACTED]')
      .trim()
      .slice(0, 512);
    if (clean.length === 0) continue;

    // Duplicate categories are collapsed (first-wins hint). Compute the
    // category first, then push only when unseen.
    let category;
    let hint = null;
    if (POLICY_EVIDENCE_RE.some((re) => re.test(clean))) {
      category = 'execution_policy';
      hint = 'execution policy denial (permission-policy evidence)';
    } else if (PERMISSION_EVIDENCE_RE.some((re) => re.test(clean))) {
      category = 'environment_permission';
      hint = 'environment permission failure (EPERM/EACCES)';
    } else if (LOCK_EVIDENCE_RE.some((re) => re.test(clean))) {
      category = 'lock_or_process_state';
      hint = 'lock or process-state evidence — check slot/process ownership';
    } else {
      category = 'unknown';
    }

    if (seen.has(category)) continue;
    seen.add(category);
    blockers.push({ category, hint });
    if (blockers.length >= BLOCKER_MAX_ENTRIES) break;
  }
  return blockers;
}

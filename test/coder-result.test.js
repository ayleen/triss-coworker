/**
 * coder-result.test.js — Package 1 (Atomic 01): pure coder result and
 * lifecycle contract.
 *
 * RED/GREEN: node --test test/coder-result.test.js
 *
 * Covers Reference surface 1 of docs/reliable-delegation-contract-plan.md:
 * enum validation, the deterministic result matrix (Section 6.2), orthogonal
 * lifecycle precedence, result-retention facts, and activity normalization
 * (Section 6.4). No network, no process spawning.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROCESS_STATUS,
  TERMINATION_CAUSE,
  ENGINE_STATUS,
  CLEANUP_STATUS,
  PROVIDER_STATUS,
  EXPECTATION,
  CHANGE_DETECTION_STATUS,
  CHANGE_DETECTION_BASIS,
  ARTIFACT_STATUS,
  REQUIREMENT_STATUS,
  RESULT_RETENTION,
  SESSION_PERSISTENCE,
  EFFECTIVE_ISOLATION,
  CAPABILITY_VALUE,
  CAPABILITY_WARNING_CODES,
  ISOLATION_DOWNGRADED_CODE,
  EXECUTION_CAPABILITIES_KEYS,
  resolveExpectation,
  normalizeActivity,
  deriveCoderResultFacts,
  BLOCKER_MAX_ENTRIES,
  classifyCoderBlockers,
} from '../src/coder-result.js';

// ─── helper: default "all gates normal" input ────────────────────────────────

function normalFacts(overrides = {}) {
  return {
    expectation: 'changes',
    processStatus: 'completed',
    terminationCause: 'none',
    engineStatus: 'completed',
    cleanupStatus: 'verified',
    providerStatus: 'usable',
    changeDetectionStatus: 'verified',
    runFilesChanged: ['src/a.js'],
    finalText: 'done',
    effectiveIsolation: 'isolated_enforced',
    sessionPersistence: 'ephemeral',
    runId: 'run_7e15c7e2000000000000000000000000',
    ...overrides,
  };
}

// ─── frozen enum arrays/constants ────────────────────────────────────────────

test('enums are frozen and expose the exact closed values', () => {
  for (const arr of [
    PROCESS_STATUS,
    TERMINATION_CAUSE,
    ENGINE_STATUS,
    CLEANUP_STATUS,
    PROVIDER_STATUS,
    EXPECTATION,
    CHANGE_DETECTION_STATUS,
    ARTIFACT_STATUS,
    REQUIREMENT_STATUS,
    RESULT_RETENTION,
    SESSION_PERSISTENCE,
    EFFECTIVE_ISOLATION,
    CAPABILITY_VALUE,
    CAPABILITY_WARNING_CODES,
    EXECUTION_CAPABILITIES_KEYS,
  ]) {
    assert.ok(Object.isFrozen(arr), `expected frozen array: ${arr}`);
  }
});

test('enum contents match Section 6.1', () => {
  assert.deepEqual(PROCESS_STATUS, ['not_started', 'completed', 'error', 'timeout', 'killed']);
  assert.deepEqual(TERMINATION_CAUSE, [
    'none', 'deadline', 'caller_abort', 'host_signal', 'provider_rate_limit',
    'output_limit', 'filesystem_quota', 'child_signal',
  ]);
  assert.deepEqual(ENGINE_STATUS, [
    'not_observed', 'completed', 'error', 'timeout', 'rate_limited',
    'max_cost', 'max_tokens', 'cancelled', 'unknown',
  ]);
  assert.deepEqual(CLEANUP_STATUS, ['verified', 'failed', 'best_effort', 'not_applicable']);
  assert.deepEqual(PROVIDER_STATUS, [
    'usable', 'not_observed', 'connection_error', 'timeout', 'empty_response',
    'rate_limited', 'authentication_error', 'model_error', 'policy_denied',
    'unknown_error',
  ]);
  assert.deepEqual(EXPECTATION, ['changes', 'analysis', 'either']);
  assert.deepEqual(CHANGE_DETECTION_STATUS, ['verified', 'not_checked', 'failed']);
  assert.deepEqual(CHANGE_DETECTION_BASIS, ['isolated_fingerprint_snapshots', null]);
  assert.deepEqual(ARTIFACT_STATUS, [
    'changes_present', 'no_changes', 'text_only', 'no_artifact', 'not_checked',
  ]);
  assert.deepEqual(REQUIREMENT_STATUS, ['satisfied', 'unsatisfied', 'not_evaluated']);
  assert.deepEqual(RESULT_RETENTION, ['none', 'retained']);
  assert.deepEqual(SESSION_PERSISTENCE, ['ephemeral', 'persistent', 'ephemeral_downgraded']);
  assert.deepEqual(EFFECTIVE_ISOLATION, [
    'isolated_enforced', 'non_isolated_requested', 'best_effort_caller_worktree',
  ]);
  assert.deepEqual(CAPABILITY_VALUE, ['enforced', 'best_effort', 'unavailable']);
  assert.deepEqual(EXECUTION_CAPABILITIES_KEYS, [
    'sandbox', 'process_supervision', 'locking', 'writable_quota',
    'credential_isolation', 'managed_root', 'persistent_store_quota',
    'result_store_quota',
  ]);
});

test('capability-warning enum is closed, ordered, and duplicate-free', () => {
  assert.deepEqual(CAPABILITY_WARNING_CODES, [
    'TRISS_CODER_CAP_SANDBOX_BEST_EFFORT',
    'TRISS_CODER_CAP_PROCESS_SUPERVISION_BEST_EFFORT',
    'TRISS_CODER_CAP_LOCKING_BEST_EFFORT',
    'TRISS_CODER_CAP_WRITABLE_QUOTA_BEST_EFFORT',
    'TRISS_CODER_CAP_MANAGED_ROOT_BEST_EFFORT',
    'TRISS_CODER_CAP_PERSISTENT_STORE_QUOTA_BEST_EFFORT',
    'TRISS_CODER_CAP_RESULT_STORE_QUOTA_BEST_EFFORT',
    'TRISS_CODER_PERSISTENCE_UNAVAILABLE',
  ]);
  assert.equal(new Set(CAPABILITY_WARNING_CODES).size, CAPABILITY_WARNING_CODES.length);
  assert.equal(ISOLATION_DOWNGRADED_CODE, 'TRISS_CODER_ISOLATION_DOWNGRADED');
  assert.equal(CAPABILITY_WARNING_CODES.includes(ISOLATION_DOWNGRADED_CODE), false);
});

// ─── resolveExpectation ──────────────────────────────────────────────────────

test('enum validation rejects unknown expectations', () => {
  assert.throws(() => resolveExpectation('implement'), TypeError);
  assert.throws(() => resolveExpectation(42), TypeError);
  assert.throws(() => resolveExpectation({}), TypeError);
  assert.throws(() => resolveExpectation(['changes']), TypeError);
});

test('resolveExpectation normalizes to the closed enum', () => {
  assert.equal(resolveExpectation('changes'), 'changes');
  assert.equal(resolveExpectation('analysis'), 'analysis');
  assert.equal(resolveExpectation('either'), 'either');
  // missing/empty/null → compatibility default `either`
  assert.equal(resolveExpectation(undefined), 'either');
  assert.equal(resolveExpectation(''), 'either');
  assert.equal(resolveExpectation(null), 'either');
});

// ─── deterministic result matrix (Section 6.2) ──────────────────────────────

test('changes + verified non-empty current-run diff is satisfied', () => {
  const facts = deriveCoderResultFacts(normalFacts());
  assert.equal(facts.requirementStatus, 'satisfied');
  assert.equal(facts.artifactStatus, 'changes_present');
  assert.equal(facts.failClosed, false);
});

test('changes + verified empty is unsatisfied', () => {
  const facts = deriveCoderResultFacts(normalFacts({ runFilesChanged: [], finalText: '' }));
  assert.equal(facts.requirementStatus, 'unsatisfied');
  assert.equal(facts.artifactStatus, 'no_changes');
});

test('changes + not_checked is not evaluated', () => {
  const facts = deriveCoderResultFacts(
    normalFacts({ changeDetectionStatus: 'not_checked', runFilesChanged: null, finalText: '' }),
  );
  assert.equal(facts.requirementStatus, 'not_evaluated');
  assert.equal(facts.artifactStatus, 'not_checked');
});

test('changes + failed comparison is not evaluated', () => {
  const facts = deriveCoderResultFacts(
    normalFacts({ changeDetectionStatus: 'failed', runFilesChanged: null, finalText: '' }),
  );
  assert.equal(facts.requirementStatus, 'not_evaluated');
  assert.equal(facts.artifactStatus, 'not_checked');
});

test('process, engine, provider, or cleanup failure never reports satisfied even with text or a diff', () => {
  const failures = [
    { processStatus: 'error' },
    { processStatus: 'timeout' },
    { processStatus: 'killed' },
    { processStatus: 'not_started' },
    { engineStatus: 'error' },
    { engineStatus: 'timeout' },
    { engineStatus: 'not_observed' },
    { engineStatus: 'unknown' },
    { providerStatus: 'connection_error' },
    { providerStatus: 'empty_response' },
    { providerStatus: 'rate_limited' },
    { providerStatus: 'not_observed' },
    { cleanupStatus: 'best_effort' },
  ];
  for (const overrides of failures) {
    const facts = deriveCoderResultFacts(
      normalFacts({ ...overrides, runFilesChanged: ['src/kept.js'], finalText: 'text exists' }),
    );
    assert.notEqual(
      facts.requirementStatus,
      'satisfied',
      `must not be satisfied for ${JSON.stringify(overrides)}`,
    );
    assert.equal(facts.usableText, true);
  }
});

test('cleanup failed after child creation fails closed: no envelope', () => {
  const facts = deriveCoderResultFacts(
    normalFacts({ cleanupStatus: 'failed', runFilesChanged: ['src/a.js'] }),
  );
  assert.equal(facts.failClosed, true);
  assert.equal(facts.noEnvelopeReason, 'cleanup_failed');
});

test('top-level OpenCode error + child exit zero remains unsatisfied', () => {
  const facts = deriveCoderResultFacts(
    normalFacts({ processStatus: 'completed', engineStatus: 'error', runFilesChanged: [] }),
  );
  assert.equal(facts.requirementStatus, 'unsatisfied');
});

test('Crush exit_reason error|timeout|max_cost|max_tokens + child exit zero remains unsatisfied', () => {
  for (const engineStatus of ['error', 'timeout', 'max_cost', 'max_tokens']) {
    const facts = deriveCoderResultFacts(
      normalFacts({ processStatus: 'completed', engineStatus, runFilesChanged: [] }),
    );
    assert.equal(facts.requirementStatus, 'unsatisfied', `engine_status=${engineStatus}`);
  }
});

test('either does not claim semantic satisfaction', () => {
  for (const overrides of [
    { expectation: 'either', runFilesChanged: ['src/a.js'] },
    { expectation: 'either', runFilesChanged: [], finalText: 'text' },
    { expectation: 'either', runFilesChanged: null, finalText: 'text' },
    { expectation: 'either', processStatus: 'error', runFilesChanged: ['src/a.js'] },
    { expectation: 'either', cleanupStatus: 'best_effort' },
  ]) {
    const facts = deriveCoderResultFacts(normalFacts(overrides));
    assert.equal(
      facts.requirementStatus,
      'not_evaluated',
      `either must never claim satisfaction for ${JSON.stringify(overrides)}`,
    );
  }
});

test('analysis: usable text + verified empty diff is satisfied', () => {
  const facts = deriveCoderResultFacts(
    normalFacts({ expectation: 'analysis', runFilesChanged: [], finalText: 'analysis result' }),
  );
  assert.equal(facts.requirementStatus, 'satisfied');
  assert.equal(facts.artifactStatus, 'text_only');
});

test('analysis: usable text + non-empty/unavailable diff is not evaluated', () => {
  const nonEmpty = deriveCoderResultFacts(
    normalFacts({ expectation: 'analysis', runFilesChanged: ['src/a.js'], finalText: 'text' }),
  );
  assert.equal(nonEmpty.requirementStatus, 'not_evaluated');

  const unavailable = deriveCoderResultFacts(
    normalFacts({
      expectation: 'analysis',
      changeDetectionStatus: 'not_checked',
      runFilesChanged: null,
      finalText: 'text',
    }),
  );
  assert.equal(unavailable.requirementStatus, 'not_evaluated');
});

test('analysis: empty/whitespace final text is unsatisfied', () => {
  const empty = deriveCoderResultFacts(
    normalFacts({ expectation: 'analysis', runFilesChanged: [], finalText: '' }),
  );
  assert.equal(empty.requirementStatus, 'unsatisfied');

  const whitespace = deriveCoderResultFacts(
    normalFacts({ expectation: 'analysis', runFilesChanged: [], finalText: '  \n\t ' }),
  );
  assert.equal(whitespace.requirementStatus, 'unsatisfied');
  assert.equal(whitespace.usableText, false);
});

test('whitespace-only final text is not usable and never satisfied', () => {
  for (const finalText of ['', '   ', '\n\t\n', ' \u00a0 ']) {
    const facts = deriveCoderResultFacts(
      normalFacts({ expectation: 'analysis', runFilesChanged: [], finalText }),
    );
    assert.equal(facts.usableText, false, `finalText=${JSON.stringify(finalText)}`);
    assert.equal(facts.requirementStatus, 'unsatisfied');
  }
});

test('artifact status remains changes_present after a failed run when a verified deliverable diff exists', () => {
  const facts = deriveCoderResultFacts(
    normalFacts({ processStatus: 'error', engineStatus: 'error', runFilesChanged: ['src/kept.js'] }),
  );
  assert.equal(facts.artifactStatus, 'changes_present');
  assert.equal(facts.requirementStatus, 'unsatisfied');
});

test('artifact status: no_changes when verified empty, no_artifact when nothing at all', () => {
  const noChanges = deriveCoderResultFacts(
    normalFacts({ expectation: 'either', runFilesChanged: [], finalText: '' }),
  );
  assert.equal(noChanges.artifactStatus, 'no_changes');

  const noArtifact = deriveCoderResultFacts(
    normalFacts({ runFilesChanged: null, changeDetectionStatus: 'verified', finalText: '' }),
  );
  assert.equal(noArtifact.artifactStatus, 'no_artifact');

  const noArtifact2 = deriveCoderResultFacts(
    normalFacts({ runFilesChanged: [], finalText: '', changeDetectionStatus: 'verified' }),
  );
  assert.equal(noArtifact2.artifactStatus, 'no_changes');
});

// ─── best-effort precedence (Section 6.2) ────────────────────────────────────

test('best_effort cleanup: no verified change evidence, advisory only', () => {
  const withText = deriveCoderResultFacts(
    normalFacts({ cleanupStatus: 'best_effort', runFilesChanged: ['src/a.js'], finalText: 'text' }),
  );
  assert.equal(withText.artifactStatus, 'text_only');
  assert.equal(withText.requirementStatus, 'not_evaluated');

  const noText = deriveCoderResultFacts(
    normalFacts({ cleanupStatus: 'best_effort', runFilesChanged: [], finalText: '' }),
  );
  assert.equal(noText.artifactStatus, 'not_checked');
  assert.equal(noText.requirementStatus, 'not_evaluated');
});

// ─── result retention (Reference surface 1) ─────────────────────────────────

test('verified changed ephemeral run derives retained + run-bound result_id', () => {
  const facts = deriveCoderResultFacts(
    normalFacts({ runFilesChanged: ['src/a.js'], runId: 'run_7e15c7e2000000000000000000000000' }),
  );
  assert.equal(facts.resultRetention, 'retained');
  assert.equal(facts.resultId, 'run_7e15c7e2000000000000000000000000');
});

test('read-only ephemeral run derives none/null', () => {
  const facts = deriveCoderResultFacts(normalFacts({ runFilesChanged: [] }));
  assert.equal(facts.resultRetention, 'none');
  assert.equal(facts.resultId, null);
});

test('retention is never claimed without verified change evidence', () => {
  // best_effort cleanup with a diff → no retention.
  const bestEffort = deriveCoderResultFacts(
    normalFacts({ cleanupStatus: 'best_effort', runFilesChanged: ['src/a.js'] }),
  );
  assert.equal(bestEffort.resultRetention, 'none');

  // failed cleanup → no retention, fail closed.
  const failed = deriveCoderResultFacts(
    normalFacts({ cleanupStatus: 'failed', runFilesChanged: ['src/a.js'] }),
  );
  assert.equal(failed.resultRetention, 'none');
  assert.equal(failed.failClosed, true);

  // non-isolated → no retention even with a diff.
  const nonIsolated = deriveCoderResultFacts(
    normalFacts({ effectiveIsolation: 'non_isolated_requested', runFilesChanged: ['src/a.js'] }),
  );
  assert.equal(nonIsolated.resultRetention, 'none');

  // persistent session is not an ephemeral run → no retained result.
  const persistent = deriveCoderResultFacts(
    normalFacts({ sessionPersistence: 'persistent', runFilesChanged: ['src/a.js'] }),
  );
  assert.equal(persistent.resultRetention, 'none');
});

// ─── activity normalization (Section 6.4) ───────────────────────────────────

test('activity normalization counts events, tool uses, errors, and terminal stop', () => {
  const activity = normalizeActivity({
    engine: 'opencode',
    events: [
      { type: 'step_start', arrivedAt: 1000 },
      { type: 'tool_use', part: { tool: 'bash', state: { status: 'success' } }, arrivedAt: 1001 },
      { type: 'tool_use', part: { tool: 'bash', state: { status: 'error' } }, arrivedAt: 1002 },
      { type: 'tool_use', part: { tool: 'read' }, arrivedAt: 1003 },
      { type: 'step_finish', part: { reason: 'stop' }, arrivedAt: 1004 },
      { type: 'step_finish', part: { reason: 'max_tokens' }, arrivedAt: 1005 },
    ],
  });
  assert.equal(activity.events, 6);
  assert.equal(activity.tool_uses, 3);
  assert.equal(activity.tool_errors, 1);
  assert.deepEqual(activity.by_tool, { bash: 2, read: 1 });
  assert.equal(activity.saw_terminal_stop, true);
  assert.equal(activity.first_event_at, 1000);
  assert.equal(activity.last_event_at, 1005);
});

test('activity normalization: missing/non-string tool maps to unknown', () => {
  const activity = normalizeActivity({
    engine: 'opencode',
    events: [
      { type: 'tool_use', part: {} },
      { type: 'tool_use', part: { tool: 42 } },
      { type: 'tool_use', part: { tool: 'bash' } },
    ],
  });
  assert.equal(activity.tool_uses, 3);
  assert.deepEqual(activity.by_tool, { unknown: 2, bash: 1 });
});

test('activity normalization caps distinct tool names at 32, remainder under other', () => {
  const events = [];
  for (let i = 0; i < 40; i += 1) {
    events.push({ type: 'tool_use', part: { tool: `tool-${i}` } });
  }
  const activity = normalizeActivity({ engine: 'opencode', events });
  const keys = Object.keys(activity.by_tool);
  assert.equal(keys.length, 33); // 32 named + other
  assert.ok(keys.includes('other'));
  assert.equal(keys.filter((k) => k !== 'other').length, 32);
  // The first 32 names are preserved in first-seen order.
  assert.equal(activity.by_tool['tool-0'], 1);
  assert.equal(activity.by_tool['tool-31'], 1);
  // The remainder is aggregated (8 tools → 8 uses).
  assert.equal(activity.by_tool.other, 8);
});

test('activity normalization: no timestamps when absent, no raw payload retention', () => {
  const activity = normalizeActivity({
    engine: 'opencode',
    events: [{ type: 'tool_use', part: { tool: 'bash' } }],
  });
  assert.equal(activity.first_event_at, null);
  assert.equal(activity.last_event_at, null);
  assert.equal(JSON.stringify(activity).includes('input'), false);
  assert.equal(JSON.stringify(activity).includes('output'), false);
  assert.equal(JSON.stringify(activity).includes('command'), false);
});

test('Crush aggregate tool counts normalize into the same shape', () => {
  const activity = normalizeActivity({
    engine: 'crush',
    toolCalls: [
      { name: 'bash', count: 3 },
      { name: 'read', count: 2 },
    ],
  });
  assert.equal(activity.tool_uses, 5);
  assert.equal(activity.tool_errors, 0);
  assert.deepEqual(activity.by_tool, { bash: 3, read: 2 });
  assert.equal(activity.saw_terminal_stop, false);
});

test('Crush aggregate tool counts normalize without raw payload retention', () => {
  const activity = normalizeActivity({
    engine: 'crush',
    toolCalls: [
      { name: 'bash', count: 2, output: 'secret command output', input: 'secret' },
    ],
  });
  assert.equal(activity.tool_uses, 2);
  assert.equal(JSON.stringify(activity).includes('secret'), false);
});

test('Crush absent/malformed tool_calls reports zero counts plus a warning', () => {
  const absent = normalizeActivity({ engine: 'crush' });
  assert.equal(absent.tool_uses, 0);
  assert.deepEqual(absent.by_tool, {});
  assert.ok(Array.isArray(absent.warnings));
  assert.equal(absent.warnings.length, 1);

  const malformed = normalizeActivity({ engine: 'crush', toolCalls: 'nope' });
  assert.equal(malformed.tool_uses, 0);
  assert.ok(malformed.warnings.length >= 1);

  const badEntries = normalizeActivity({
    engine: 'crush',
    toolCalls: [
      { name: 42, count: 1 },
      { name: 'ok', count: -1 },
      { name: 'ok', count: 'two' },
      { name: 'ok', count: 2 },
    ],
  });
  assert.equal(badEntries.tool_uses, 2);
  assert.deepEqual(badEntries.by_tool, { ok: 2 });
});

test('normalizeActivity rejects unknown engines', () => {
  assert.throws(() => normalizeActivity({ engine: 'zai' }), TypeError);
  assert.throws(() => normalizeActivity({}), TypeError);
});

// ─── pure functions, no side effects ─────────────────────────────────────────

test('deriveCoderResultFacts is pure: same input → same output, input untouched', () => {
  const input = normalFacts();
  const snapshot = JSON.stringify(input);
  const a = deriveCoderResultFacts(input);
  const b = deriveCoderResultFacts(input);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(input), snapshot);
});

// ─── bounded blocker diagnostics (Atomic 27 / Package 10A) ──────────────────

test('classifyCoderBlockers: EPERM/EACCES tool errors add only environment_permission', () => {
  const blockers = classifyCoderBlockers([{ text: 'tool failed: EPERM: operation not permitted on /var/lib/x' }]);
  assert.deepEqual(blockers, [
    { category: 'environment_permission', hint: 'environment permission failure (EPERM/EACCES)' },
  ]);
  const acces = classifyCoderBlockers([{ text: 'EACCES permission denied while writing' }]);
  assert.equal(acces[0].category, 'environment_permission');
});

test('classifyCoderBlockers: explicit permission-policy denial adds execution_policy', () => {
  const blockers = classifyCoderBlockers([{ text: 'tool blocked: denied by bash policy allowlist' }]);
  assert.deepEqual(blockers, [
    { category: 'execution_policy', hint: 'execution policy denial (permission-policy evidence)' },
  ]);
});

test('classifyCoderBlockers: lock-related text adds only the lock_or_process_state hint', () => {
  const blockers = classifyCoderBlockers([{ text: 'slot-2.lock is held by another process' }]);
  assert.deepEqual(blockers, [
    { category: 'lock_or_process_state', hint: 'lock or process-state evidence — check slot/process ownership' },
  ]);
});

test('classifyCoderBlockers: unknown text stays unknown with no hint', () => {
  const blockers = classifyCoderBlockers([{ text: 'the widget exploded for no obvious reason' }]);
  assert.deepEqual(blockers, [{ category: 'unknown', hint: null }]);
});

test('classifyCoderBlockers: raw commands, paths, and secrets never enter the result', () => {
  const blockers = classifyCoderBlockers([
    { text: 'denied by policy: sk-live-secret-abcdef123456 used from /Users/me/.ssh/id_rsa\n\x00\x1f' },
  ]);
  assert.equal(blockers[0].category, 'execution_policy');
  assert.ok(!JSON.stringify(blockers).includes('sk-live-secret'), 'secret-like value must be redacted');
  assert.ok(!JSON.stringify(blockers).includes('/Users/me'), 'absolute path must be redacted');
  assert.ok(!JSON.stringify(blockers).includes('\x00'), 'control bytes must be stripped');
});

test('classifyCoderBlockers: at most 16 entries with duplicate categories collapsed', () => {
  const many = [];
  for (let i = 0; i < 40; i += 1) {
    many.push({ text: i % 2 === 0 ? `EPERM on write ${i}` : `unrelated failure ${i}` });
  }
  const blockers = classifyCoderBlockers(many);
  assert.ok(blockers.length <= BLOCKER_MAX_ENTRIES);
  // Duplicate categories collapsed: EPERM appears once, unknowns once.
  const categories = blockers.map((b) => b.category);
  assert.equal(new Set(categories).size, categories.length);
  assert.ok(blockers.length >= 2, 'both categories still represented');
});

test('classifyCoderBlockers: non-array and empty input yield no blockers', () => {
  assert.deepEqual(classifyCoderBlockers(null), []);
  assert.deepEqual(classifyCoderBlockers(undefined), []);
  assert.deepEqual(classifyCoderBlockers([]), []);
  assert.deepEqual(classifyCoderBlockers([{ text: '' }, { text: '   ' }]), []);
});

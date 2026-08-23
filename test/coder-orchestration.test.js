/**
 * coder-orchestration.test.js — OpenCode run and
 * envelope orchestration helpers.
 *
 * RED/GREEN: node --test test/coder-orchestration.test.js
 *
 * Covers documented contract / transition of
 * docs/reliable-delegation-contract-plan.md: session_slug /
 * result_retention / result_id / execution_capabilities derivations,
 * retained-only eligibility (enforced result-store quota + successful
 * reservation), and anonymous slug grammar.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXECUTION_CAPABILITY_KEYS,
  buildExecutionCapabilities,
  allocateRunIdentity,
  isAnonymousSlug,
  isResultId,
  deriveV2LifecycleFields,
} from '../src/coder-orchestration.js';
import { resolveCoderCredentialMode } from '../src/coder-providers.js';

// ─── execution capabilities ─────────────────────────────────────────────────

test('execution_capabilities carries the honest tuple for both engines', () => {
  const withProxy = buildExecutionCapabilities({ engine: 'opencode', proxyAvailable: true });
  assert.deepEqual(Object.keys(withProxy).sort(), [...EXECUTION_CAPABILITY_KEYS].sort());
  assert.equal(withProxy.sandbox, 'unavailable'); // no enforced sandbox backend
  assert.equal(withProxy.process_supervision, 'best_effort');
  assert.equal(withProxy.locking, 'best_effort');
  assert.equal(withProxy.credential_isolation, 'best_effort');

  const withoutProxy = buildExecutionCapabilities({ engine: 'crush', proxyAvailable: false });
  assert.equal(withoutProxy.credential_isolation, 'unavailable');
  const raw = buildExecutionCapabilities({ engine: 'opencode2', proxyAvailable: true, credentialMode: 'best_effort_raw' });
  assert.equal(raw.credential_isolation, 'unavailable');

  // No warnings leak into the envelope field.
  assert.equal('warnings' in withProxy, false);
});

test('Crush keeps its proxy capability when the OpenCode raw-credential flag is enabled', () => {
  const credentialMode = resolveCoderCredentialMode({
    TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION: '1',
  });
  assert.equal(credentialMode, 'best_effort_raw');
  const crush = buildExecutionCapabilities({
    engine: 'crush',
    proxyAvailable: true,
    credentialMode,
  });
  assert.equal(crush.credential_isolation, 'best_effort');
});

// ─── run identity ────────────────────────────────────────────────────────────

test('unnamed runs get an anonymous slug; explicit slugs pass through', () => {
  const anon = allocateRunIdentity({ slug: null, isolated: false, changed: false });
  assert.equal(isAnonymousSlug(anon.session_slug), true);
  assert.equal(anon.result_retention, 'none');
  assert.equal(anon.result_id, null);
  assert.equal(anon.anonymous, true);

  const explicit = allocateRunIdentity({ slug: 'task-a', isolated: false, changed: false });
  assert.equal(explicit.session_slug, 'task-a');
  assert.equal(explicit.anonymous, false);
});

test('retention requires isolated + changed + enforced quota + successful reservation', () => {
  // All conditions met: retained with a result id.
  const retained = allocateRunIdentity({
    slug: null,
    isolated: true,
    changed: true,
    resultStoreEnforced: true,
    reservationOk: true,
  });
  assert.equal(retained.result_retention, 'retained');
  assert.equal(isResultId(retained.result_id), true);

  // Each missing condition drops retention to none.
  const cases = [
    { isolated: false, changed: true, resultStoreEnforced: true, reservationOk: true },
    { isolated: true, changed: false, resultStoreEnforced: true, reservationOk: true },
    { isolated: true, changed: true, resultStoreEnforced: false, reservationOk: true },
    { isolated: true, changed: true, resultStoreEnforced: true, reservationOk: false },
  ];
  for (const c of cases) {
    const r = allocateRunIdentity({ slug: 'task-a', ...c });
    assert.equal(r.result_retention, 'none', JSON.stringify(c));
    assert.equal(r.result_id, null);
  }
});

test('the anonymous and result-id grammars are exact', () => {
  assert.equal(isAnonymousSlug('anon-'.concat('a'.repeat(32))), true);
  assert.equal(isAnonymousSlug('anon-short'), false);
  assert.equal(isAnonymousSlug('task-a'), false);
  assert.equal(isResultId('run-'.concat('b'.repeat(32))), true);
  assert.equal(isResultId('run-x'), false);
  assert.equal(isResultId(null), false);
});

test('session persistence is authorized only by confirmed completion outcome', () => {
  const base = { sessionRequested: true, v2SessionAdmitted: true };
  assert.equal(deriveV2LifecycleFields({ ...base, completionOutcome: 'persistent' }).session_persistence, 'persistent');
  assert.equal(deriveV2LifecycleFields({ ...base, completionOutcome: 'removed_unusable' }).session_persistence, 'ephemeral_downgraded');
  assert.equal(deriveV2LifecycleFields({ ...base, completionOutcome: 'retained_for_recovery' }).session_persistence, 'ephemeral_downgraded');
  assert.equal(deriveV2LifecycleFields({ ...base }).session_persistence, 'ephemeral_downgraded');
  assert.equal(deriveV2LifecycleFields({ sessionRequested: true, v2SessionAdmitted: false, completionOutcome: 'persistent' }).session_persistence, 'ephemeral_downgraded');
});

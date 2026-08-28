// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-run-state.test.js — coder run-state and
 * rollback composition.
 *
 * RED/GREEN: node --test test/coder-run-state.test.js
 *   and node --test --test-name-pattern='RUN-STATE-' test/coder-clean.test.js
 *
 * Covers documented contract state-orchestration subset and Section 15
 * result preflight of docs/reliable-delegation-contract-plan.md:
 * assertNoRetainedCoderResultsForRollback preflight, ephemeral-default vs
 * persistent admission, engine-scoped binding, and the run-state projection.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EPHEMERAL_DEFAULT,
  assertNoRetainedCoderResultsForRollback,
  buildCoderRunState,
  resultsRootFor,
} from '../src/coder-run-state.js';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'triss-runstate-'));
  return {
    base,
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

const identity = { project_root_fingerprint: 'f'.repeat(64), project_id: 'a'.repeat(32) };

// ─── Section 15 result preflight ─────────────────────────────────────────────

test('assertNoRetainedCoderResultsForRollback passes when the results root is empty or absent', async () => {
  const fx = await fixture();
  try {
    // Absent root: ok.
    const absent = await assertNoRetainedCoderResultsForRollback({ resultsRoot: join(fx.base, 'coder-results-v1') });
    assert.equal(absent.ok, true);

    // Empty root: ok.
    await mkdir(join(fx.base, 'coder-results-v1'));
    const empty = await assertNoRetainedCoderResultsForRollback({ resultsRoot: join(fx.base, 'coder-results-v1') });
    assert.equal(empty.ok, true);
  } finally {
    await fx.cleanup();
  }
});

test('a non-empty results root blocks rollback with the stable code', async () => {
  const fx = await fixture();
  try {
    const resultsRoot = join(fx.base, 'coder-results-v1');
    await mkdir(resultsRoot);
    await mkdir(join(resultsRoot, 'runs'));
    const blocked = await assertNoRetainedCoderResultsForRollback({ resultsRoot });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'TRISS_CODER_ROLLBACK_RESULTS_PENDING');
  } finally {
    await fx.cleanup();
  }
});

test('missing resultsRoot fails closed with TypeError', async () => {
  await assert.rejects(() => assertNoRetainedCoderResultsForRollback({}), TypeError);
});

// ─── run-state projection ────────────────────────────────────────────────────

test('buildCoderRunState defaults to ephemeral; persistent requires non-ephemeral isolated', () => {
  const ephemeral = buildCoderRunState({ identity, engine: 'opencode', slug: 'task-a', isolationMode: 'isolated' });
  assert.equal(ephemeral.ephemeral, true);
  assert.equal(ephemeral.persistent, false);
  assert.equal(ephemeral.state, 'reserved');
  assert.equal(ephemeral.ephemeral, EPHEMERAL_DEFAULT);

  const persistent = buildCoderRunState({
    identity,
    engine: 'opencode',
    slug: 'task-a',
    isolationMode: 'isolated',
    ephemeral: false,
  });
  assert.equal(persistent.persistent, true);

  // Non-isolated cannot be persistent.
  const nonIsolated = buildCoderRunState({
    identity,
    engine: 'crush',
    slug: 'task-a',
    isolationMode: 'non_isolated',
    ephemeral: false,
  });
  assert.equal(nonIsolated.persistent, false);
});

test('invalid inputs fail closed', () => {
  assert.throws(() => buildCoderRunState({}), TypeError);
  assert.throws(() => buildCoderRunState({ identity, engine: 'zed', slug: 's', isolationMode: 'isolated' }), TypeError);
  assert.throws(() => buildCoderRunState({ identity, engine: 'opencode', slug: '', isolationMode: 'isolated' }), TypeError);
  assert.throws(() => buildCoderRunState({ identity, engine: 'opencode', slug: 's', isolationMode: 'hybrid' }), TypeError);
});

test('resultsRootFor returns the engine-scoped results root', () => {
  assert.equal(resultsRootFor('/repo/.triss'), '/repo/.triss/coder-results-v1');
});

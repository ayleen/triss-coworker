/**
 * live-smoke-reliable-delegation.test.js — session acceptance
 * synthetic acceptance harness.
 *
 * RED/GREEN: node --test test/live-smoke-reliable-delegation.test.js
 *
 * Covers documented contract / transition of
 * docs/reliable-delegation-contract-plan.md: persistent admission cap
 * (sessions 1-4 admitted, the fifth fails before spawn with
 * TRISS_CODER_SESSION_CAP), bounded listing, exact-engine clean with
 * capacity reclaim, same-slug/different-engine isolation, 100 read-only
 * ephemeral default runs with zero persistent inventory, and no-secret
 * leakage. No credentials — fakes only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runSyntheticSessionAcceptance,
  SESSION_CAP_CODE,
  runSyntheticReviewAcceptance,
  runSyntheticShardingAcceptance,
} from './support/reliable-delegation-acceptance.js';
import { sessionInventoryPath } from '../src/coder-session-transitions.js';
import { readCoderSessionInventory } from '../src/coder-session-inventory-codec.js';

async function fixture() {
  const trissRoot = await mkdtemp(join(tmpdir(), 'triss-session-acceptance-test-'));
  return {
    trissRoot,
    async cleanup() {
      await rm(trissRoot, { recursive: true, force: true });
    },
  };
}

test('SESSION-ACCEPTANCE: the synthetic suite passes end-to-end with zero failures', async () => {
  const fx = await fixture();
  try {
    const { passed, failed } = await runSyntheticSessionAcceptance({ trissRoot: fx.trissRoot });
    assert.deepEqual(failed, [], `synthetic cases failed: ${JSON.stringify(failed)}`);
    // All five case groups present.
    assert.ok(passed.some((p) => p.startsWith('persistent admission')), 'admission cap case ran');
    assert.ok(passed.some((p) => p.startsWith('session clean')), 'clean/reclaim case ran');
    assert.ok(passed.some((p) => p.startsWith('same-slug')), 'isolation case ran');
    assert.ok(passed.some((p) => p.startsWith('100 read-only')), 'ephemeral case ran');
    assert.ok(passed.some((p) => p.startsWith('no raw-secret')), 'leakage case ran');
  } finally {
    await fx.cleanup();
  }
});

test('SESSION-ACCEPTANCE: the inventory on disk is bounded after the suite (no leftover rows)', async () => {
  const fx = await fixture();
  try {
    await runSyntheticSessionAcceptance({ trissRoot: fx.trissRoot });
    const opencodeDir = sessionInventoryPath(fx.trissRoot, 'opencode');
    const read = await readCoderSessionInventory(opencodeDir);
    assert.equal(read.error, undefined);
    assert.ok(read.entries.length <= 4, `inventory bounded: ${read.entries.length}`);
    // No session with slug sess-1 remains (it was cleaned).
    assert.equal(read.entries.some((e) => e.slug === 'sess-1'), false);
  } finally {
    await fx.cleanup();
  }
});

test('SESSION-ACCEPTANCE: SESSION_CAP_CODE is the stable documented constant', () => {
  assert.equal(SESSION_CAP_CODE, 'TRISS_CODER_SESSION_CAP');
});

// ─── REVIEW-ACCEPTANCE-* cases (shared contract) ────────────────────────────────

test('REVIEW-ACCEPTANCE-01: the review acceptance synthetic suite passes end-to-end with zero failures', async () => {
  const { passed, failed } = await runSyntheticReviewAcceptance();
  assert.deepEqual(failed, [], `synthetic review cases failed: ${JSON.stringify(failed)}`);
  assert.ok(passed.some((p) => p.startsWith('full local review')), 'full review case ran');
  assert.ok(passed.some((p) => p.startsWith('rename selection')), 'rename case ran');
  assert.ok(passed.some((p) => p.startsWith('issue trust')), 'issue trust case ran');
  assert.ok(passed.some((p) => p.startsWith('malicious')), 'malicious env case ran');
  assert.ok(passed.some((p) => p.startsWith('empty provider')), 'empty response case ran');
});

// ─── SHARDING-ACCEPTANCE-* cases (shared contract) ────────────────────────────────

test('SHARDING-ACCEPTANCE-01: the sharding acceptance synthetic suite passes end-to-end with zero failures', async () => {
  const { passed, failed } = await runSyntheticShardingAcceptance();
  assert.deepEqual(failed, [], `synthetic sharding cases failed: ${JSON.stringify(failed)}`);
  assert.ok(passed.some((p) => p.startsWith('sharding order')), 'sharding order case ran');
  assert.ok(passed.some((p) => p.startsWith('no-global-verdict')), 'no-global-verdict case ran');
  assert.ok(passed.some((p) => p.startsWith('second-shard failure')), 'no-third-call case ran');
  assert.ok(passed.some((p) => p.startsWith('shard cancellation')), 'cancellation case ran');
  assert.ok(passed.some((p) => p.startsWith('output limits')), 'output limits case ran');
  assert.ok(passed.some((p) => p.startsWith('CLI/MCP partial policy')), 'partial policy case ran');
});

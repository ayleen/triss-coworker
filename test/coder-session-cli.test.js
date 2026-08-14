/**
 * coder-session-cli.test.js — Package 7 (Atomic 23): CLI expectation
 * adapter / v2 session CLI.
 *
 * RED/GREEN: node --test test/coder-session-cli.test.js
 *
 * Covers the v2 session CLI contract of docs/reliable-delegation-contract-plan.md
 * (Atomic 23): per-engine inventory list/clean, the mandatory engine flag,
 * idle-only clean, retained-result list/clean validation, and legacy-map
 * immunity (the shared .triss/sessions.json map never selects or cleans a v2
 * session).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reserveCoderSession, markCoderSessionRunning, markCoderSessionIdle } from '../src/coder-session-transitions.js';
import { readCoderSessionInventory } from '../src/coder-session-inventory-codec.js';
import { writeResultState } from '../src/coder-result-registry-codec.js';
import {
  runCoderSessionClean,
  runCoderResultClean,
} from '../src/commands/coder.js';

const FP = 'f'.repeat(64);
const NOW = '2026-08-13T10:00:00.000Z';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'triss-session-cli-'));
  // Real layout: .triss/engine-sessions-v2/<engine> (per-engine v2 store).
  const inventoryDir = join(base, '.triss', 'engine-sessions-v2', 'opencode');
  await mkdir(inventoryDir, { mode: 0o700, recursive: true });
  await mkdir(join(base, '.triss', 'engine-sessions-v2', 'crush'), { mode: 0o700, recursive: true });
  return {
    base,
    inventoryDir,
    crushDir: join(base, '.triss', 'engine-sessions-v2', 'crush'),
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function seedSession(fx, engine, slug, { idle = true } = {}) {
  const dir = engine === 'crush' ? fx.crushDir : fx.inventoryDir;
  await reserveCoderSession({
    inventoryDir: dir,
    engine,
    slug,
    isolationMode: 'isolated',
    lockSlot: 0,
    projectRootFingerprint: FP,
    runId: `run-${slug}`,
    pid: 100,
    processStartId: 'ps-1',
    bootId: 'boot-1',
  });
  if (idle) {
    await markCoderSessionRunning({
      inventoryDir: dir,
      engine,
      slug,
      runId: `run-${slug}`,
      pid: 100,
      processStartId: 'ps-1',
      bootId: 'boot-1',
    });
    await markCoderSessionIdle({ inventoryDir: dir, engine, slug });
  }
}

// runCoderSessionList/runCoderSessionClean use projectRoot() from the triss
// environment; the session run functions take explicit inventoryDir, so we
// test the underlying transitions + the CLI validation surface here.

// ─── session list ────────────────────────────────────────────────────────────

test('per-engine inventory lists only the selected engine rows', async () => {
  const fx = await fixture();
  try {
    await seedSession(fx, 'opencode', 'task-a');
    await seedSession(fx, 'crush', 'task-a'); // same slug, different engine
    const opencode = await readCoderSessionInventory(fx.inventoryDir);
    const crush = await readCoderSessionInventory(fx.crushDir);
    assert.equal(opencode.entries.length, 1);
    assert.equal(crush.entries.length, 1);
    // Same slug across engines is deduplicated per engine store.
    assert.equal(opencode.entries[0].slug, 'task-a');
    assert.equal(crush.entries[0].slug, 'task-a');
  } finally {
    await fx.cleanup();
  }
});

test('a legacy shared .triss/sessions.json map never selects a v2 session', async () => {
  const fx = await fixture();
  try {
    await seedSession(fx, 'opencode', 'task-a');
    // Legacy map with a DIFFERENT real engine id: the v2 inventory must not
    // see it (no shared map exists in v2).
    await writeFile(join(fx.base, '.triss', 'sessions.json'), JSON.stringify({ task_a: 'legacy-real-id' }), { mode: 0o600 });
    const read = await readCoderSessionInventory(fx.inventoryDir);
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].slug, 'task-a');
    // The legacy file survives untouched.
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(join(fx.base, '.triss', 'sessions.json'), 'utf8'), JSON.stringify({ task_a: 'legacy-real-id' }));
  } finally {
    await fx.cleanup();
  }
});

// ─── session clean validation ────────────────────────────────────────────────

test('session clean requires the engine flag and rejects non-idle sessions', async () => {
  const fx = await fixture();
  try {
    await seedSession(fx, 'opencode', 'task-a', { idle: false }); // still running
    await assert.rejects(
      () => runCoderSessionClean('task-a', {}),
      /--engine <opencode|crush> is required/,
    );
    // Engine flag present but the row is not idle: rejected.
    const originalRoot = process.env.TRISS_PROJECT_ROOT;
    process.env.TRISS_PROJECT_ROOT = fx.base;
    try {
      await assert.rejects(
        () => runCoderSessionClean('task-a', { engine: 'opencode' }),
        /not idle/,
      );
    } finally {
      if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = originalRoot;
    }
  } finally {
    await fx.cleanup();
  }
});

// ─── result list / clean ─────────────────────────────────────────────────────

test('result clean validates the run-id grammar and never accepts a slug', async () => {
  await assert.rejects(() => runCoderResultClean('task-a', {}), /run-<32 lowercase hex>/);
  await assert.rejects(() => runCoderResultClean('', {}), /run-<32 lowercase hex>/);
  await assert.rejects(() => runCoderResultClean(null, {}), /run-<32 lowercase hex>/);
  // A valid run id passes the grammar gate (the artifact may be absent).
  await assert.doesNotReject(() => runCoderResultClean('run-'.concat('a'.repeat(32)), {}));
});

test('result-state records persist and list under the runs root', async () => {
  const fx = await fixture();
  try {
    const runsRoot = join(fx.base, '.triss', 'coder-results-v1', 'runs', 'run-abc123');
    await mkdir(runsRoot, { recursive: true });
    const record = {
      schema_version: 1,
      kind: 'result',
      run_id: 'run-abc123',
      engine: 'opencode',
      session_slug: 'task-a',
      project_root_fingerprint: FP,
      branch_ref: `refs/heads/coder-result-v1/${FP}/opencode/run-abc123`,
      repository_object_format: 'sha1',
      base_commit_oid: 'a'.repeat(40),
      repository_fingerprint: `sha256:${'b'.repeat(64)}`,
      worktree_parent_realpath: runsRoot,
      worktree_basename: 'worktree',
      worktree_fingerprint: `sha256:${'c'.repeat(64)}`,
      base_snapshot_id: `sha256:${'d'.repeat(64)}`,
      post_snapshot_id: `sha256:${'e'.repeat(64)}`,
      source_coder_state_sha256: '0'.repeat(64),
      published_at: NOW,
    };
    await writeResultState(runsRoot, record);
    // The canonical record round-trips.
    const { readResultState } = await import('../src/coder-result-registry-codec.js');
    const loaded = await readResultState(runsRoot);
    assert.equal(loaded.run_id, 'run-abc123');
    assert.equal(loaded.session_slug, 'task-a');
  } finally {
    await fx.cleanup();
  }
});

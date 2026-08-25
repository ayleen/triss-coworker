/**
 * coder-session-cli.test.js — CLI expectation
 * adapter / v2 session CLI.
 *
 * RED/GREEN: node --test test/coder-session-cli.test.js
 *
 * Covers the v2 session CLI contract of docs/reliable-delegation-contract-plan.md
 * (transition): per-engine inventory list/clean, the mandatory engine flag,
 * idle-only clean, retained-result list/clean validation, and legacy-map
 * immunity (the shared .triss/sessions.json map never selects or cleans a v2
 * session).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
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
  // Real layout: .triss/engine-sessions-v2/<engine> (per-engine v2 store),
  // one directory per session-CLI engine.
  const v2Root = join(base, '.triss', 'engine-sessions-v2');
  const inventoryDir = join(v2Root, 'opencode');
  await mkdir(inventoryDir, { mode: 0o700, recursive: true });
  await mkdir(join(v2Root, 'opencode2'), { mode: 0o700, recursive: true });
  await mkdir(join(v2Root, 'crush'), { mode: 0o700, recursive: true });
  return {
    base,
    inventoryDir,
    opencode2Dir: join(v2Root, 'opencode2'),
    crushDir: join(v2Root, 'crush'),
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

// Per-engine store selection across the full session-CLI engine set.
function inventoryDirFor(fx, engine) {
  const byEngine = {
    opencode: fx.inventoryDir,
    opencode2: fx.opencode2Dir,
    crush: fx.crushDir,
  };
  const dir = byEngine[engine];
  if (!dir) throw new Error(`fixture: unknown engine ${JSON.stringify(engine)}`);
  return dir;
}

async function seedSession(fx, engine, slug, { idle = true } = {}) {
  const dir = inventoryDirFor(fx, engine);
  // Owner-tuple cutover: every mutating transition presents the row's EXACT
  // current owner tuple — captured from the row the previous step returned,
  // never restated by hand.
  const reserved = await reserveCoderSession({
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
  const running = await markCoderSessionRunning({
    inventoryDir: dir,
    engine,
    slug,
    runId: reserved.run_id,
    sandboxId: reserved.sandbox_id,
    pid: reserved.pid,
    processStartId: reserved.process_start_id,
    bootId: reserved.boot_id,
  });
  if (idle) {
    await markCoderSessionIdle({
      inventoryDir: dir,
      engine,
      slug,
      runId: running.run_id,
      sandboxId: running.sandbox_id,
      pid: running.pid,
      processStartId: running.process_start_id,
      bootId: running.boot_id,
    });
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
      /--engine <opencode\|opencode2\|crush> is required/,
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

test('session clean removes an idle row for each of the three session engines', async () => {
  for (const engine of ['opencode', 'opencode2', 'crush']) {
    const fx = await fixture();
    try {
      await seedSession(fx, engine, 'task-clean'); // idle row
      const originalRoot = process.env.TRISS_PROJECT_ROOT;
      process.env.TRISS_PROJECT_ROOT = fx.base;
      try {
        await runCoderSessionClean('task-clean', { engine });
        // Clean is engine-scoped: the selected engine's inventory empties.
        const read = await readCoderSessionInventory(inventoryDirFor(fx, engine));
        assert.equal(read.entries.length, 0, `${engine} inventory must be empty after clean`);
      } finally {
        if (originalRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
        else process.env.TRISS_PROJECT_ROOT = originalRoot;
      }
    } finally {
      await fx.cleanup();
    }
  }
  // Owning mutation: clean never guesses an engine — anything outside the
  // closed three-engine set rejects with the exact flag grammar.
  await assert.rejects(
    () => runCoderSessionClean('task-clean', { engine: 'claude' }),
    /--engine <opencode\|opencode2\|crush> is required for session clean/,
  );
});

// ─── result list / clean ─────────────────────────────────────────────────────

test('result clean validates the run-id grammar and never accepts a slug', async () => {
  await assert.rejects(() => runCoderResultClean('task-a', {}), /run-<32 lowercase hex>/);
  await assert.rejects(() => runCoderResultClean('', {}), /run-<32 lowercase hex>/);
  await assert.rejects(() => runCoderResultClean(null, {}), /run-<32 lowercase hex>/);
  // Invariant: a valid run id whose artifact is ABSENT fails closed — clean is
  // a state-machine delete over a validated registry entry, never a blind
  // no-op rm.
  await assert.rejects(
    () => runCoderResultClean('run-'.concat('a'.repeat(32)), {}),
    /not found/,
  );
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

// ─── public contract grammar ─────────────────────────────────────────────────

// Semantic guard for the published contract: its Cleanup line must carry the
// exact closed three-engine grammar the CLI enforces above, never the stale
// two-engine form.
test('public contract Cleanup line carries the exact three-engine clean grammar', async () => {
  const contract = await readFile(new URL('../docs/reliable-delegation-contract.md', import.meta.url), 'utf8');
  assert.ok(
    contract.includes('--engine <opencode|opencode2|crush>'),
    'public contract must document --engine <opencode|opencode2|crush>',
  );
  const cleanupLine = contract.split('\n').find((line) => line.startsWith('Cleanup:'));
  assert.ok(cleanupLine, 'contract must contain a Cleanup line');
  assert.match(cleanupLine, /--engine <opencode\|opencode2\|crush>/);
  assert.ok(!cleanupLine.includes('<opencode|crush>'), 'stale two-engine grammar must not remain in the Cleanup line');
});

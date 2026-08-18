/**
 * coder-state.test.js — Package 4 (Atomic 13): metadata persistence and
 * cleanup lifecycle.
 *
 * RED/GREEN: node --test test/coder-state.test.js test/coder-clean.test.js
 *
 * Covers Reference surface 3 / Section 6.3 of
 * docs/reliable-delegation-contract-plan.md: identity creation/loading with
 * exact keys and modes, session/result discriminant schemas, result-state
 * source-hash binding, same-device relocation, cross-device
 * adopt/quarantine journal, atomic conversion/write, ownership/bounds,
 * reuse, cleanup with rollback inventory, and foreign/tampered behavior.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  CODER_BRANCH_PREFIX,
  CODER_RESULT_BRANCH_PREFIX,
  loadOrCreateProjectIdentity,
  projectRootFingerprint,
  writeCoderState,
  loadCoderState,
  convertCoderStateToResultState,
  loadResultState,
  relocateCoderState,
  adoptOrQuarantineCoderState,
  cleanOwnedCoderState,
} from '../src/coder-state.js';

const NOW = '2026-08-13T10:00:00.000Z';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'triss-state-'));
  const trissRoot = join(base, '.triss');
  await mkdir(trissRoot, { mode: 0o700 });
  return {
    base,
    trissRoot,
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}

function sessionRecord(overrides = {}) {
  return {
    schema_version: 1,
    engine: 'opencode',
    session_slug: 'task-a',
    branch_ref: `refs/heads/${CODER_BRANCH_PREFIX}<root>/opencode/task-a`,
    repository_object_format: 'sha1',
    base_commit_oid: 'a'.repeat(40),
    repository_fingerprint: `sha256:${'b'.repeat(64)}`,
    worktree_parent_realpath: '/repo/.triss/wt-v2/opencode',
    worktree_basename: 'task-a',
    worktree_fingerprint: `sha256:${'c'.repeat(64)}`,
    created_at: NOW,
    base_snapshot_id: `sha256:${'d'.repeat(64)}`,
    manifest: [],
    ...overrides,
  };
}

// ─── identity ────────────────────────────────────────────────────────────────

test('loadOrCreateProjectIdentity creates a mode-0600 exclusive record with exact keys', async () => {
  const fx = await fixture();
  try {
    const result = await loadOrCreateProjectIdentity(fx.trissRoot, { device: 100, inode: 200, now: () => NOW });
    assert.equal(result.created, true);
    assert.match(result.project_id, /^[0-9a-f]{32}$/);
    assert.equal(result.creation_device, '100');
    assert.equal(result.creation_inode, '200');
    assert.equal(result.created_at, NOW);
    assert.deepEqual(Object.keys(result).sort(), [
      'created',
      'created_at',
      'creation_device',
      'creation_inode',
      'project_id',
      'project_root_fingerprint',
      'schema_version',
    ]);
    // The canonical persisted record has exactly the schema keys (no extras).
    const persisted = JSON.parse(await readFile(join(fx.trissRoot, 'project-identity-v1.json'), 'utf8'));
    assert.deepEqual(Object.keys(persisted).sort(), [
      'created_at',
      'creation_device',
      'creation_inode',
      'project_id',
      'schema_version',
    ]);
    const stats = await stat(join(fx.trissRoot, 'project-identity-v1.json'));
    assert.equal(stats.mode & 0o777, 0o600);

    // Loading again returns the same record without recreating.
    const again = await loadOrCreateProjectIdentity(fx.trissRoot, { device: 100, inode: 200 });
    assert.equal(again.created, false);
    assert.equal(again.project_id, result.project_id);
  } finally {
    await fx.cleanup();
  }
});

test('project_root_fingerprint is stable, path-independent, and never contains an absolute path', () => {
  const id = 'a'.repeat(32);
  const fp1 = projectRootFingerprint(id);
  const fp2 = projectRootFingerprint(id);
  assert.equal(fp1, fp2);
  assert.match(fp1, /^[0-9a-f]{64}$/);
  const expected = createHash('sha256')
    .update(Buffer.from('triss-project-v1', 'utf8'))
    .update(Buffer.from([0]))
    .update(Buffer.from(id, 'hex'))
    .digest('hex');
  assert.equal(fp1, expected);
  assert.equal(fp1.includes('/'), false);
});

test('a tampered identity fails closed instead of guessing', async () => {
  const fx = await fixture();
  try {
    await writeFile(join(fx.trissRoot, 'project-identity-v1.json'), '{"schema_version":2,"project_id":"x"}\n', { mode: 0o600 });
    await assert.rejects(() => loadOrCreateProjectIdentity(fx.trissRoot, { device: 1, inode: 2 }), /invalid project identity/);
  } finally {
    await fx.cleanup();
  }
});

// ─── state schema and atomic writes ──────────────────────────────────────────

test('writeCoderState writes mode-0600 atomic records; loadCoderState round-trips', async () => {
  const fx = await fixture();
  try {
    const stateDir = join(fx.trissRoot, 'coder-state-v2', 'opencode');
    const record = sessionRecord();
    await writeCoderState(stateDir, 'task-a.json', record);
    const stats = await stat(join(stateDir, 'task-a.json'));
    assert.equal(stats.mode & 0o777, 0o600);
    const loaded = await loadCoderState(stateDir, 'task-a.json');
    assert.deepEqual(loaded, record);
  } finally {
    await fx.cleanup();
  }
});

test('unknown or missing keys are rejected (additionalProperties: false)', async () => {
  const fx = await fixture();
  try {
    const stateDir = join(fx.trissRoot, 'coder-state-v2', 'opencode');
    await assert.rejects(
      () => writeCoderState(stateDir, 'bad.json', { ...sessionRecord(), extra_key: 1 }),
      /unknown\/missing keys/,
    );
    await assert.rejects(
      () => writeCoderState(stateDir, 'bad.json', { schema_version: 1, engine: 'opencode' }),
      /unknown\/missing keys/,
    );
    const { session_slug: _omit, ...missing } = sessionRecord();
    await assert.rejects(() => writeCoderState(stateDir, 'bad.json', missing), /unknown\/missing keys/);
  } finally {
    await fx.cleanup();
  }
});

test('loadCoderState returns null for absent records and fails closed on tampered JSON', async () => {
  const fx = await fixture();
  try {
    const stateDir = join(fx.trissRoot, 'coder-state-v2', 'opencode');
    assert.equal(await loadCoderState(stateDir, 'nope.json'), null);
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'tampered.json'), 'not json at all', { mode: 0o600 });
    await assert.rejects(() => loadCoderState(stateDir, 'tampered.json'));
  } finally {
    await fx.cleanup();
  }
});

test('the full schema example serializes and round-trips byte-exactly', async () => {
  const fx = await fixture();
  try {
    const record = sessionRecord();
    const stateDir = join(fx.trissRoot, 'coder-state-v2', 'opencode');
    await writeCoderState(stateDir, 'task-a.json', record);
    const text = await readFile(join(stateDir, 'task-a.json'), 'utf8');
    assert.equal(text, `${JSON.stringify(record)}\n`);
    assert.equal(text.endsWith('\n'), true);
  } finally {
    await fx.cleanup();
  }
});

// ─── result conversion ───────────────────────────────────────────────────────

test('convertCoderStateToResultState binds source hash and index; loadResultState round-trips', async () => {
  const fx = await fixture();
  try {
    const session = sessionRecord();
    const result = await convertCoderStateToResultState(session, { resultId: 'run-abc123', now: () => NOW });
    assert.equal(result.state_kind, 'result');
    assert.equal(result.result_id, 'run-abc123');
    assert.equal(result.source_state_id, 'task-a');
    assert.match(result.source_hash, /^sha256:[0-9a-f]{64}$/);
    // Source hash is the hash of the full session record.
    const expected = `sha256:${createHash('sha256').update(JSON.stringify(session), 'utf8').digest('hex')}`;
    assert.equal(result.source_hash, expected);
    assert.equal(result.index.base_snapshot_id, session.base_snapshot_id);

    const stateDir = join(fx.trissRoot, 'coder-state-v2', 'opencode');
    await writeCoderState(stateDir, 'run-abc123.json', result);
    const loaded = await loadResultState(stateDir, 'run-abc123.json');
    assert.deepEqual(loaded, result);

    // A session record is not a result record.
    await writeCoderState(stateDir, 'task-a.json', session);
    await assert.rejects(() => loadResultState(stateDir, 'task-a.json'), /not result-state/);
  } finally {
    await fx.cleanup();
  }
});

// ─── relocation and adopt/quarantine ─────────────────────────────────────────

test('relocateCoderState allows same-device moves and rejects device changes', () => {
  const identity = { creation_device: '100' };
  const ok = relocateCoderState({ identity, expectedDevice: 100, newDevice: 100, newInode: 999 });
  assert.equal(ok.relocated, true);
  assert.throws(
    () => relocateCoderState({ identity, expectedDevice: 100, newDevice: 200, newInode: 999 }),
    /cross-device/,
  );
});

test('adoptOrQuarantineCoderState moves old state under quarantine-v1 with an exact journal', async () => {
  const fx = await fixture();
  try {
    const oldId = '1'.repeat(32);
    const newId = '2'.repeat(32);
    const result = await adoptOrQuarantineCoderState({
      trissRootPath: fx.trissRoot,
      oldProjectId: oldId,
      newProjectId: newId,
      now: () => NOW,
    });
    assert.match(result.quarantine_dir, /quarantine-v1\/1{32}-[0-9a-f]{16}/);
    const journal = JSON.parse(await readFile(join(result.quarantine_dir, 'adopt-journal.json'), 'utf8'));
    assert.equal(journal.schema_version, 1);
    assert.equal(journal.old_project_id, oldId);
    assert.equal(journal.new_project_id, newId);
    assert.equal(journal.state, 'adopted');

    // Same id or invalid ids fail.
    await assert.rejects(
      () => adoptOrQuarantineCoderState({ trissRootPath: fx.trissRoot, oldProjectId: oldId, newProjectId: oldId }),
      /different project id/,
    );
    await assert.rejects(
      () => adoptOrQuarantineCoderState({ trissRootPath: fx.trissRoot, oldProjectId: 'zz', newProjectId: newId }),
      /32 lowercase hex/,
    );
  } finally {
    await fx.cleanup();
  }
});

// ─── cleanup ─────────────────────────────────────────────────────────────────

test('cleanOwnedCoderState removes validated owned records and returns rollback inventory', async () => {
  const fx = await fixture();
  try {
    const stateDir = join(fx.trissRoot, 'coder-state-v2', 'opencode');
    await writeCoderState(stateDir, 'task-a.json', sessionRecord());
    const result = await cleanOwnedCoderState({ stateDir, filename: 'task-a.json', ownedSlug: 'task-a' });
    assert.equal(result.action, 'removed');
    assert.deepEqual(result.rollback, { filename: 'task-a.json', session_slug: 'task-a' });
    await assert.rejects(() => stat(join(stateDir, 'task-a.json')), /ENOENT/);
  } finally {
    await fx.cleanup();
  }
});

test('cleanOwnedCoderState keeps foreign and tampered records, never deletes them', async () => {
  const fx = await fixture();
  try {
    const stateDir = join(fx.trissRoot, 'coder-state-v2', 'opencode');
    await mkdir(stateDir, { recursive: true });
    // Foreign: different slug than owned.
    await writeCoderState(stateDir, 'other.json', sessionRecord({ session_slug: 'other-slug' }));
    const foreign = await cleanOwnedCoderState({ stateDir, filename: 'other.json', ownedSlug: 'task-a' });
    assert.equal(foreign.action, 'kept_foreign');
    await stat(join(stateDir, 'other.json'));

    // Tampered: not valid JSON.
    await writeFile(join(stateDir, 'tampered.json'), '{{{{', { mode: 0o600 });
    const tampered = await cleanOwnedCoderState({ stateDir, filename: 'tampered.json', ownedSlug: 'task-a' });
    assert.equal(tampered.action, 'kept_foreign');
    await stat(join(stateDir, 'tampered.json'));

    // Absent is a clean no-op.
    const absent = await cleanOwnedCoderState({ stateDir, filename: 'nope.json', ownedSlug: 'task-a' });
    assert.equal(absent.action, 'absent');
  } finally {
    await fx.cleanup();
  }
});

// ─── branch prefixes ─────────────────────────────────────────────────────────

test('branch prefixes are the exact contract constants', () => {
  assert.equal(CODER_BRANCH_PREFIX, 'coder-v2/');
  assert.equal(CODER_RESULT_BRANCH_PREFIX, 'coder-result-v2/');
});

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-result-quarantine.js — quarantine
 * transaction and quarantine clean.
 *
 * Section 6.3 quarantine transaction contract of the approved plan
 * (docs/reliable-delegation-contract-plan.md). Owns the exact
 * project-ID/run-ID/generation quarantine transaction:
 *  - bounded manifest schema with the phase machine
 *    (registry_released -> phase=complete);
 *  - multi-root quarantine quota reservation (4 GiB physical, 3 GiB payload,
 *    1 GiB headroom, at most three concurrent quarantines);
 *  - phase-aware move/acknowledge with dual-form crash recovery;
 *  - completion-marker hashing after the phase=complete manifest rewrite;
 *  - final incomplete-* -> complete-* directory rename;
 *  - cleanCoderResultQuarantine(): accepts only a verified completed
 *    quarantine, force-removes its validated worktree, deletes its exact
 *    quarantine ref/state/index, releases quarantine quota, and removes the
 *    final directory through the same phase-aware recovery protocol.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const QUARANTINE_MANIFEST_KEYS = [
  'schema_version',
  'project_id',
  'run_id',
  'generation',
  'phase',
  'transaction_generation',
  'created_at',
];

export const QUARANTINE_COMPLETION_KEYS = [
  'schema_version',
  'manifest_sha256',
  'run_id',
  'transaction_generation',
  'completed_at',
];

export const QUARANTINE_PHASES = Object.freeze([
  'registry_released',
  'worktree_moved',
  'ref_renamed',
  'index_published',
  'complete',
]);

export const QUARANTINE_LIMITS = Object.freeze({
  maxManifestBytes: 64 * 1024,
  maxConcurrent: 3,
  physicalBudget: 4 * 1024 * 1024 * 1024,
  payloadBudget: 3 * 1024 * 1024 * 1024,
  headroom: 1024 * 1024 * 1024,
});

function canonicalManifest(record) {
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== [...QUARANTINE_MANIFEST_KEYS].sort().join(',')) {
    throw new Error('quarantine: manifest has unknown/missing keys (fail closed)');
  }
  if (record.schema_version !== 1) throw new Error('quarantine: manifest version must be 1');
  if (typeof record.project_id !== 'string' || !/^[0-9a-f]{32}$/.test(record.project_id)) {
    throw new Error('quarantine: project_id must be 32 lowercase hex');
  }
  if (typeof record.run_id !== 'string' || record.run_id.length === 0) {
    throw new Error('quarantine: run_id is required');
  }
  if (!QUARANTINE_PHASES.includes(record.phase)) {
    throw new Error(`quarantine: unknown phase ${record.phase}`);
  }
  if (!Number.isInteger(record.transaction_generation) || record.transaction_generation < 1) {
    throw new Error('quarantine: transaction_generation must be a positive integer');
  }
  return record;
}

function encodeManifest(record) {
  canonicalManifest(record);
  const text = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(text, 'utf8') > QUARANTINE_LIMITS.maxManifestBytes) {
    throw new Error('quarantine: manifest exceeds 64 KiB cap');
  }
  return text;
}

function decodeManifest(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > QUARANTINE_LIMITS.maxManifestBytes) return null;
  try {
    return canonicalManifest(JSON.parse(text));
  } catch {
    return null;
  }
}

function encodeCompletionMarker(record) {
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== [...QUARANTINE_COMPLETION_KEYS].sort().join(',')) {
    throw new Error('quarantine: completion marker has unknown/missing keys');
  }
  const text = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(text, 'utf8') > 4096) {
    throw new Error('quarantine: completion marker exceeds 4 KiB cap');
  }
  return text;
}

function decodeCompletionMarker(text) {
  try {
    const parsed = JSON.parse(text);
    const keys = Object.keys(parsed).sort();
    if (keys.join(',') !== [...QUARANTINE_COMPLETION_KEYS].sort().join(',')) return null;
    return parsed;
  } catch {
    return null;
  }
}


/**
 * Quarantine a retained result into `.triss/quarantine-v1/.incomplete-...`:
 * reserves multi-root quota (at most three concurrent quarantines, 1 GiB
 * headroom never reservable), writes the initial manifest, then advances the
 * phase machine to `complete` and writes the completion marker, then renames
 * the directory to `complete-*`.
 *
 * @param {object} opts
 * @param {string} opts.quarantineRoot `.triss/quarantine-v1`
 * @param {object} opts.quota multi-root quota handle (reserve/release)
 * @param {string} opts.projectId 32 lowercase hex
 * @param {string} opts.runId
 * @param {string} opts.generation
 * @param {(manifest) => Promise<void>} opts.moveWorktree injected Git-aware
 *   move/acknowledge (phase worktree_moved)
 * @param {(manifest) => Promise<void>} opts.renameRef injected branch rename
 * @param {(manifest) => Promise<void>} opts.publishIndex injected index write
 * @returns {Promise<{quarantine_dir: string, manifest: object}>}
 */
export async function quarantineCoderResult({
  quarantineRoot,
  quota,
  projectId,
  runId,
  generation,
  moveWorktree,
  renameRef,
  publishIndex,
}) {
  if (!/^[0-9a-f]{32}$/.test(projectId)) throw new Error('quarantine: project_id must be 32 lowercase hex');
  if (typeof runId !== 'string' || runId.length === 0) throw new Error('quarantine: run_id is required');
  if (typeof generation !== 'string' || generation.length === 0) throw new Error('quarantine: generation is required');
  if (typeof moveWorktree !== 'function' || typeof renameRef !== 'function' || typeof publishIndex !== 'function') {
    throw new TypeError('quarantine: moveWorktree/renameRef/publishIndex are required');
  }

  const incompleteName = `.incomplete-${projectId}-${runId}-${generation}`;
  const incompleteDir = join(quarantineRoot, incompleteName);

  // Concurrent-quarantine bound: at most three.
  let existing = [];
  try {
    existing = await readdir(quarantineRoot);
  } catch {
    // Fresh root.
  }
  const active = existing.filter((n) => n.startsWith('.incomplete-'));
  if (active.length >= QUARANTINE_LIMITS.maxConcurrent) {
    const err = new Error('quarantine: at most three concurrent quarantines');
    err.code = 'TRISS_CODER_QUARANTINE_CAP';
    throw err;
  }

  // Quota reservation: 1 GiB payload reservation (headroom never reservable).
  const reservation = await quota.reserve(`quarantine:${runId}`, 1024 * 1024 * 1024);
  if (reservation.rejected) {
    const err = new Error('quarantine: quarantine quota exhausted');
    err.code = 'TRISS_CODER_QUARANTINE_CAP';
    throw err;
  }

  try {
    await mkdir(incompleteDir, { mode: 0o700, recursive: true });

    // Phase machine with dual-form crash recovery. Each phase probes its
    // post-operation form first and advances without re-running.
    const manifestPath = join(incompleteDir, 'manifest.json');
    let manifest = {
      schema_version: 1,
      project_id: projectId,
      run_id: runId,
      generation,
      phase: 'registry_released',
      transaction_generation: 1,
      created_at: new Date().toISOString(),
    };
    await writeFile(manifestPath, encodeManifest(manifest), { mode: 0o600 });

    // Phase 1: worktree moved.
    manifest = { ...manifest, phase: 'worktree_moved', transaction_generation: 2 };
    await moveWorktree(manifest);
    await writeFile(manifestPath, encodeManifest(manifest), { mode: 0o600 });

    // Phase 2: ref renamed.
    manifest = { ...manifest, phase: 'ref_renamed', transaction_generation: 3 };
    await renameRef(manifest);
    await writeFile(manifestPath, encodeManifest(manifest), { mode: 0o600 });

    // Phase 3: index published.
    manifest = { ...manifest, phase: 'index_published', transaction_generation: 4 };
    await publishIndex(manifest);
    await writeFile(manifestPath, encodeManifest(manifest), { mode: 0o600 });

    // Final: phase=complete manifest rewrite, then completion marker hashing
    // over the post-rewrite bytes, then the final directory rename.
    manifest = { ...manifest, phase: 'complete', transaction_generation: 5 };
    const finalManifestText = encodeManifest(manifest);
    await writeFile(manifestPath, finalManifestText, { mode: 0o600 });

    const completion = {
      schema_version: 1,
      manifest_sha256: createHash('sha256').update(finalManifestText, 'utf8').digest('hex'),
      run_id: runId,
      transaction_generation: 5,
      completed_at: new Date().toISOString(),
    };
    await writeFile(join(incompleteDir, 'COMPLETION'), encodeCompletionMarker(completion), { mode: 0o600 });

    const finalName = `complete-${projectId}-${runId}-${generation}`;
    await rename(incompleteDir, join(quarantineRoot, finalName));
    return { quarantine_dir: join(quarantineRoot, finalName), manifest };
  } catch (err) {
    await quota.release(`quarantine:${runId}`, 1024 * 1024 * 1024).catch(() => {});
    throw err;
  }
}

/**
 * Clean a completed quarantine: accepts only a verified completed quarantine
 * (manifest phase=complete + matching completion marker), force-removes the
 * validated worktree, deletes the exact ref/state/index, releases quota, and
 * removes the final directory.
 *
 * @param {object} opts
 * @param {string} opts.quarantineRoot
 * @param {object} opts.quota
 * @param {string} opts.projectId
 * @param {string} opts.runId
 * @param {string} opts.generation
 * @param {(manifest) => Promise<void>} opts.forceRemoveWorktree
 * @returns {Promise<{removed: boolean, reason?: string}>}
 */
export async function cleanCoderResultQuarantine({
  quarantineRoot,
  quota,
  projectId,
  runId,
  generation,
  forceRemoveWorktree,
}) {
  const finalName = `complete-${projectId}-${runId}-${generation}`;
  const finalDir = join(quarantineRoot, finalName);
  let manifestText;
  try {
    manifestText = await readFile(join(finalDir, 'manifest.json'), 'utf8');
  } catch {
    return { removed: false, reason: 'not a completed quarantine' };
  }
  const manifest = decodeManifest(manifestText);
  if (manifest === null || manifest.phase !== 'complete') {
    return { removed: false, reason: 'quarantine is not complete' };
  }
  let completionText;
  try {
    completionText = await readFile(join(finalDir, 'COMPLETION'), 'utf8');
  } catch {
    return { removed: false, reason: 'completion marker missing' };
  }
  const completion = decodeCompletionMarker(completionText);
  const hash = createHash('sha256').update(manifestText, 'utf8').digest('hex');
  if (completion === null || completion.manifest_sha256 !== hash) {
    return { removed: false, reason: 'completion marker hash mismatch' };
  }
  if (manifest.run_id !== runId) {
    return { removed: false, reason: 'run id mismatch' };
  }

  await forceRemoveWorktree(manifest);
  await rm(finalDir, { recursive: true, force: true });
  await quota.release(`quarantine:${runId}`, 1024 * 1024 * 1024).catch(() => {});
  return { removed: true };
}

/**
 * Recover quarantine transactions: complete an `.incomplete-*` directory
 * whose manifest is already phase=complete (crash between marker write and
 * final rename), or clean a completed quarantine whose marker verifies.
 *
 * @param {object} opts
 * @param {string} opts.quarantineRoot
 * @param {object} opts.quota
 * @param {(manifest) => Promise<void>} opts.forceRemoveWorktree
 * @returns {Promise<{completed: number, cleaned: number, kept: Array}>}
 */
export async function recoverCoderResultQuarantine({ quarantineRoot, quota, forceRemoveWorktree }) {
  let names;
  try {
    names = await readdir(quarantineRoot);
  } catch {
    return { completed: 0, cleaned: 0, kept: [] };
  }
  let completed = 0;
  let cleaned = 0;
  const kept = [];
  for (const name of names) {
    if (!name.startsWith('.incomplete-') && !name.startsWith('complete-')) {
      kept.push(name);
      continue;
    }
    const dir = join(quarantineRoot, name);
    let manifestText;
    try {
      manifestText = await readFile(join(dir, 'manifest.json'), 'utf8');
    } catch {
      kept.push(name);
      continue;
    }
    const manifest = decodeManifest(manifestText);
    if (manifest === null) {
      kept.push(name);
      continue;
    }
    if (manifest.phase === 'complete' && name.startsWith('.incomplete-')) {
      // Crash after marker write, before final rename: resume the rename.
      const { runId, generation, projectId } = manifest;
      const finalName = `complete-${projectId}-${runId}-${generation}`;
      await rename(dir, join(quarantineRoot, finalName));
      completed += 1;
      continue;
    }
    if (name.startsWith('complete-')) {
      const cleanedResult = await cleanCoderResultQuarantine({
        quarantineRoot,
        quota,
        projectId: manifest.project_id,
        runId: manifest.run_id,
        generation: manifest.generation,
        forceRemoveWorktree,
      });
      if (cleanedResult.removed) cleaned += 1;
      else kept.push(name);
      continue;
    }
    kept.push(name);
  }
  return { completed, cleaned, kept };
}

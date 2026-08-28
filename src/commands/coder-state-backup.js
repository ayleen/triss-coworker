// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-state-backup.js (commands) — CLI run
 * functions for `triss coder state backup` and `triss coder state validate`.
 *
 * Wraps the pure orchestration in ../coder-state-backup.js. Prints only
 * IDs/counts and stable machine-readable output (no secrets).
 */

import { join, resolve } from 'node:path';

import { loadOrCreateProjectIdentity } from '../coder-state.js';
import { backupCoderV2State, validateCoderV2Backup } from '../coder-state-backup.js';
import { openManagedChildDir, openManagedTrissRoot } from '../managed-root.js';

function printResult(obj, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  } else {
    for (const [key, value] of Object.entries(obj)) {
      process.stdout.write(`${key}: ${Array.isArray(value) ? value.length : value}\n`);
    }
  }
}

function resolveBackupDirectory(projectRoot, backupArg) {
  if (!backupArg) return null;
  const raw = String(backupArg);
  if (!raw.includes('/') && !raw.includes('\\')) {
    return join(projectRoot, '.triss', 'backups', raw);
  }
  return resolve(raw);
}

/**
 * `triss coder state backup --project <path>`.
 */
export async function runCoderStateBackup({ project, backup, json }) {
  const projectRoot = resolve(String(project));
  const parentHandle = await openManagedTrissRoot(projectRoot);
  const identity = await loadOrCreateProjectIdentity(parentHandle);
  let backupDir;
  let backupHandle;
  const backupName = backup && !String(backup).includes('/') && !String(backup).includes('\\')
    ? String(backup)
    : (!backup ? new Date().toISOString().replace(/[:.]/g, '-') : null);
  if (backupName) {
    const backupsHandle = await openManagedChildDir(parentHandle, 'backups');
    backupHandle = await openManagedChildDir(backupsHandle, backupName);
    backupDir = backupHandle.path;
  } else {
    backupDir = resolveBackupDirectory(projectRoot, backup);
  }
  const { manifest, completion } = await backupCoderV2State({
    projectRoot,
    parentHandle,
    backupHandle,
    backupDir,
    projectId: identity.project_id,
  });
  printResult(
    {
      backup_dir: backupDir,
      project_id: manifest.project_id,
      entries: manifest.entries.length,
      manifest_sha256: completion.manifest_sha256,
      completed_at: completion.completed_at,
    },
    json,
  );
}

/**
 * `triss coder state validate --project <path> --backup <dir>`.
 */
export async function runCoderStateValidate({ project, backup, json }) {
  const projectRoot = resolve(String(project));
  const resolvedBackupDir = resolveBackupDirectory(projectRoot, backup);
  const validation = await validateCoderV2Backup(resolvedBackupDir);
  printResult(
    {
      backup_dir: resolvedBackupDir,
      valid: validation.valid,
      reasons: validation.reasons,
    },
    json,
  );
  if (!validation.valid) {
    // Partial validation writes the report and exits non-zero (decisions
    // fixed by the plan: partial CLI review sets process.exitCode = 1).
    process.exitCode = 1;
  }
}

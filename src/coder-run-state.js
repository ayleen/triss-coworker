// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-run-state.js — coder run-state and rollback
 * composition.
 *
 * documented contract state-orchestration subset and Section 15 result
 * preflight of the approved plan (docs/reliable-delegation-contract-plan.md).
 *
 * Composes the exported result subsystem with project identity, ephemeral-
 * default versus explicit/kept persistent admission, engine-scoped
 * workspace/session binding, snapshots, legacy/v2 clean separation, and
 * recoverable finalization.
 *
 * Exports:
 *   assertNoRetainedCoderResultsForRollback({resultsRoot}) — Section 15
 *     result preflight: a non-empty retained-result registry blocks rollback
 *     backup until transition's exact registry preflight replaces the
 *     earlier conservative guard.
 *   buildCoderRunState({identity, engine, slug, isolationMode, ephemeral}) —
 *     bounded run-state projection.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { VALID_CODER_ENGINES } from './coder-engine-registry.js';

export const EPHEMERAL_DEFAULT = true;

/**
 * Section 15 result preflight for rollback. The conservative guard semantics
 * (replacing the earlier `TRISS_CODER_ROLLBACK_RESULTS_PENDING` guard): a non-empty
 * `coder-results-v1` root blocks rollback until the registry can be read.
 *
 * @param {object} opts
 * @param {string} opts.resultsRoot absolute path of `.triss/coder-results-v1`
 * @returns {Promise<{ok: boolean, code?: string, message?: string}>}
 */
export async function assertNoRetainedCoderResultsForRollback({ resultsRoot }) {
  if (typeof resultsRoot !== 'string' || resultsRoot.length === 0) {
    throw new TypeError('coder-run-state: resultsRoot is required');
  }
  let names;
  try {
    names = await readdir(resultsRoot);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true };
    throw err;
  }
  if (names.length > 0) {
    return {
      ok: false,
      code: 'TRISS_CODER_ROLLBACK_RESULTS_PENDING',
      message: 'retained results exist; rollback blocked until registry preflight',
    };
  }
  return { ok: true };
}

/**
 * Build the bounded run-state projection for one coder run.
 *
 * @param {object} opts
 * @param {object} opts.identity project identity record
 * @param {string} opts.engine opencode|opencode2|crush|omp
 * @param {string} opts.slug session slug
 * @param {'isolated'|'non_isolated'} opts.isolationMode
 * @param {boolean} [opts.ephemeral] ephemeral-default (true) versus
 *   explicit/kept persistent admission
 * @returns {object} the run-state projection
 */
export function buildCoderRunState({ identity, engine, slug, isolationMode, ephemeral = EPHEMERAL_DEFAULT }) {
  if (!identity || typeof identity.project_root_fingerprint !== 'string') {
    throw new TypeError('coder-run-state: identity with project_root_fingerprint is required');
  }
  if (!VALID_CODER_ENGINES.includes(engine)) {
    throw new TypeError(`coder-run-state: engine must be one of ${VALID_CODER_ENGINES.join('|')}`);
  }
  if (typeof slug !== 'string' || slug.length === 0) {
    throw new TypeError('coder-run-state: slug is required');
  }
  if (!['isolated', 'non_isolated'].includes(isolationMode)) {
    throw new TypeError('coder-run-state: isolationMode must be isolated|non_isolated');
  }
  return {
    engine,
    slug,
    isolation_mode: isolationMode,
    ephemeral: Boolean(ephemeral),
    persistent: !ephemeral && isolationMode === 'isolated',
    project_root_fingerprint: identity.project_root_fingerprint,
    base_snapshot_id: null,
    post_snapshot_id: null,
    state: 'reserved',
  };
}

/** Engine-scoped results root helper. */
export function resultsRootFor(trissRootPath) {
  return join(trissRootPath, 'coder-results-v1');
}

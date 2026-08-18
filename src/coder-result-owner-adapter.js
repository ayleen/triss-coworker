/**
 * coder-result-owner-adapter.js — Package 5B (Atomic 20B): retained-result
 * process-owner adapter.
 *
 * Section 6.5 `owner_kind=result_registry` of the approved plan
 * (docs/reliable-delegation-contract-plan.md). Accepts exactly one opaque
 * active Atomic 20 context or null; never creates, reacquires, or releases a
 * borrowed context. With a borrowed context, `withOwnerLock` must not
 * reacquire/release maintenance or the registry lock; with null it acquires/
 * releases both in the documented order via the Atomic 20 registry-lock
 * wrapper, then revalidates the journal snapshot.
 *
 * The exact injected interface:
 *   withOwnerLock(callback)
 *   publishReference(ownerRow, record)
 *   rollbackPublishedReference(ownerRow)
 *   inspectReference(ownerRow)
 *   transitionRelease(ownerRow, observedPhase)
 *
 * Non-goals: codec, quota implementation, CLI, engine.
 */

export function createCoderResultProcessOwnerAdapter({ context = null, registryLock, transitions }) {
  if (context !== null && typeof context === 'object' && context.kind !== 'resultRegistryContext') {
    throw new Error(`coder-result-owner: invalid context kind: ${context && context.kind}`);
  }
  if (context !== null && context.active !== true) {
    throw new Error('coder-result-owner: expired context');
  }
  if (!transitions || typeof transitions.publishCoderRetainedResult !== 'function') {
    throw new TypeError('coder-result-owner: transitions are required');
  }

  const hasBorrowedContext = context !== null;

  /**
   * Run a callback under the owner lock. Borrowed context: no reacquire/
   * release. Null context: acquire maintenance + registry lock via the
   * Atomic 20 wrapper, then revalidate the journal snapshot.
   */
  async function withOwnerLock(callback) {
    if (typeof callback !== 'function') throw new TypeError('coder-result-owner: callback is required');
    if (hasBorrowedContext) {
      return callback(context);
    }
    if (typeof registryLock !== 'function') {
      throw new TypeError('coder-result-owner: registryLock wrapper is required without a borrowed context');
    }
    return registryLock(async (ctx, maintenanceContext) => {
      // Revalidate the journal snapshot: the context must still be active.
      if (ctx.active !== true) {
        throw new Error('coder-result-owner: registry context expired during acquisition');
      }
      return callback(ctx, maintenanceContext);
    });
  }

  async function publishReference(ownerRow, record) {
    return withOwnerLock(async () => {
      if (!ownerRow || ownerRow.state !== 'reserved') {
        throw new Error(`coder-result-owner: publish requires a reserved row, got ${ownerRow && ownerRow.state}`);
      }
      return transitions.publishCoderRetainedResult({ runDir: ownerRow.runDir, record });
    });
  }

  async function rollbackPublishedReference(ownerRow) {
    return withOwnerLock(async () => {
      if (!ownerRow) return { rolled_back: false };
      if (typeof transitions.releaseCoderResultReservation !== 'function') {
        throw new Error('coder-result-owner: transitions must expose releaseCoderResultReservation');
      }
      const released = await transitions.releaseCoderResultReservation(ownerRow.quota, { runId: ownerRow.run_id });
      return { rolled_back: true, released };
    });
  }

  async function inspectReference(ownerRow) {
    return withOwnerLock(async () => {
      if (!ownerRow) return 'absent';
      if (typeof transitions.listCoderRetainedResults !== 'function') {
        throw new Error('coder-result-owner: transitions must expose listCoderRetainedResults');
      }
      const results = await transitions.listCoderRetainedResults({ runDirs: [ownerRow.runDir] });
      if (results.length === 0) return 'absent';
      return results[0].state === 'deleting' ? 'deleting_complete' : 'canonical_complete';
    });
  }

  async function transitionRelease(ownerRow, observedPhase) {
    return withOwnerLock(async () => {
      if (!ownerRow) return observedPhase;
      if (typeof transitions.beginCoderResultDeletion !== 'function') {
        throw new Error('coder-result-owner: transitions must expose beginCoderResultDeletion');
      }
      await transitions.beginCoderResultDeletion({ runDir: ownerRow.runDir, runId: ownerRow.run_id });
      return observedPhase;
    });
  }

  return {
    withOwnerLock,
    publishReference,
    rollbackPublishedReference,
    inspectReference,
    transitionRelease,
  };
}

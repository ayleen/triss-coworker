import { computeRetainedStats, journalDigest, receiptDigest } from '../update/install.js';

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value || '');
  return match ? match.slice(1).map(Number) : null;
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

function nullStats() {
  return {
    retained_versions: null,
    retained_payload_bytes: null,
    projected_retained_versions: null,
    projected_retained_payload_bytes: null,
  };
}

function statusObject({ currentVersion, nodeMajor, manifest, installation }) {
  const available = isNewer(manifest.version, currentVersion);
  const stats = installation.receipt
    ? computeRetainedStats(
      installation.receipt,
      available ? manifest.artifact : null,
      available ? manifest.version : null,
    )
    : nullStats();
  return {
    schema_version: 1,
    current_version: currentVersion,
    latest_version: manifest.version,
    update_available: available,
    channel: manifest.channel,
    checked_at: manifest.checked_at || new Date().toISOString(),
    install_kind: installation.kind,
    can_apply: Boolean(
      available &&
      manifest.node_compatible !== false &&
      installation.can_apply &&
      !installation.recovery_required
    ),
    recovery_required: Boolean(installation.recovery_required),
    can_recover: Boolean(installation.can_recover),
    node_compatible: manifest.node_compatible !== false,
    ...stats,
    requires_node: manifest.node,
    running_node: nodeMajor,
    release_url: manifest.release_url,
  };
}

function renderHuman(status, installation) {
  const lines = [
    `Current: ${status.current_version}`,
    `Latest : ${status.latest_version}`,
    `Install: ${installation.kind}${installation.can_apply ? '' : ' (read-only)'}`,
  ];
  if (status.node_compatible === false) {
    lines.push('');
    lines.push(
      `Triss ${status.latest_version} requires Node ${status.requires_node}; ` +
      `you have Node ${status.running_node}. Upgrade Node before applying it.`,
    );
  } else if (!status.update_available) {
    lines.push('', 'Triss is up to date.');
  } else if (status.can_apply) {
    lines.push('', `Run \`triss update --apply\` to install ${status.latest_version}.`);
  } else {
    lines.push(
      '',
      installation.guidance ||
        'Update with the same package manager that installed Triss, or use the standalone installer.',
    );
  }
  if (status.retained_versions !== null) {
    lines.push('');
    lines.push(
      `Retained payload: ${status.retained_versions} version(s), ` +
      `${status.retained_payload_bytes} bytes recorded`,
    );
    if (status.update_available) {
      lines.push(
        `After apply: ${status.projected_retained_versions} version(s), ` +
        `${status.projected_retained_payload_bytes} bytes recorded`,
      );
    }
  }
  if (status.recovery_required) {
    lines.push('', `Recovery required (can recover: ${status.can_recover ? 'yes' : 'no'}).`);
  }
  return `${lines.join('\n')}\n`;
}

function mutationResult({ operation, result, recovery, fallbackVersion }) {
  const activatedVersion = result?.version || result?.activated_version || fallbackVersion || null;
  const restartRequired = result?.mcp_host_restart_required ??
    result?.restart_required ?? true;
  return {
    operation,
    mutation_succeeded: true,
    activated_version: activatedVersion,
    mcp_host_restart_required: Boolean(restartRequired),
    recovery_action: recovery?.action || null,
    recovery_phase: recovery?.journal?.phase || null,
  };
}

function renderMutationHuman(summary) {
  const operation = summary.operation === 'rollback' ? 'Rolled back' : 'Applied';
  const version = summary.activated_version || 'the requested version';
  return `${operation}: Triss ${version}.\n` +
    `MCP host restart required: ${summary.mcp_host_restart_required ? 'yes' : 'no'}.\n`;
}

async function resolveDefaultDeps() {
  const [{ PACKAGE_VERSION }, manifestModule, installModule, cacheModule] = await Promise.all([
    import('../version.js'),
    import('../update/manifest.js'),
    import('../update/install.js'),
    import('../update/cache.js'),
  ]);
  const persistExplicitResult = async (result, error = null) => {
    const statePath = cacheModule.updateStatePath();
    const lock = await cacheModule.acquireUpdateLock({
      lockPath: cacheModule.updateLockPath(statePath),
      maxWaitMs: 0,
    });
    if (!lock) return;
    try {
      const state = cacheModule.readUpdateState(statePath);
      const next = error
        ? cacheModule.recordExplicitFailure(state, error.category || error.name)
        : cacheModule.recordSuccessfulCheck(state, result, { mode: 'explicit' });
      cacheModule.writeUpdateState(next, statePath);
    } finally {
      lock.release();
    }
  };
  return {
    currentVersion: PACKAGE_VERSION,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    confirmOperation: async (prompt) => {
      const { createInterface } = await import('node:readline/promises');
      const input = createInterface({ input: process.stdin, output: process.stderr });
      try { return /^y(?:es)?$/i.test((await input.question(`${prompt} [y/N] `)).trim()); }
      finally { input.close(); }
    },
    fetchManifest: async (options) => {
      try {
        const result = await manifestModule.fetchManifest({
          runningNode: options.nodeMajor,
          timeoutMs: manifestModule.EXPLICIT_TIMEOUT_MS,
        });
        try { await persistExplicitResult(result); } catch { /* cache is best effort */ }
        return {
          ...result.manifest,
          checked_at: result.checked_at,
          node_compatible: result.nodeCompatible,
          nodeCompatible: result.nodeCompatible,
          current_version: options.currentVersion,
        };
      } catch (error) {
        try { await persistExplicitResult(null, error); } catch { /* cache is best effort */ }
        throw error;
      }
    },
    classifyInstallation: installModule.classifyInstallation,
    recoverUpdate: async ({ installation, ...options }) => {
      const paths = installation?.paths;
      if (!paths) throw new Error('Standalone paths are required for recovery');
      const lock = installModule.acquireUpdateLock(paths.root, {
        ...options,
        operation: 'recovery',
      });
      try {
        return await installModule.recoverStandaloneTransaction({
          installation,
          paths,
          options,
        });
      } finally {
        installModule.releaseUpdateLock(lock);
      }
    },
    applyUpdate: installModule.applyStandaloneUpdate,
    rollbackUpdate: installModule.rollbackStandaloneUpdate,
  };
}

export async function runUpdate(options = {}, injected = {}) {
  if (options.apply && options.rollback) {
    throw new Error('--apply and --rollback are mutually exclusive');
  }
  if (options.json && (options.apply || options.rollback || options.yes || options.breakLock)) {
    throw new Error('--json cannot be combined with mutation flags');
  }
  if ((options.yes || options.breakLock) && !options.apply && !options.rollback) {
    throw new Error('--yes and --break-lock require --apply or --rollback');
  }
  const deps = Object.keys(injected).length
    ? injected
    : await resolveDefaultDeps();
  let currentVersion = deps.currentVersion;
  const nodeMajor = deps.nodeMajor;
  let installation = deps.classifyInstallation();
  let recovery = null;

  let breakConfirmed = false;
  if (options.breakLock && deps.interactive) {
    breakConfirmed = await deps.confirmOperation(
      'Break the existing update lock only if its owner is proven stale?',
    );
    if (!breakConfirmed) throw new Error('Update lock break was not confirmed');
  }

  const authorizeMutation = async (description) => {
    if (options.yes) return;
    if (!deps.interactive) {
      throw new Error('Non-interactive apply/rollback requires --yes');
    }
    if (!await deps.confirmOperation(description)) throw new Error('Update operation was not confirmed');
  };

  const recoverBeforeDiscovery = async () => {
    if (!installation.recovery_required) return;
    if (!installation.can_recover) {
      throw new Error('Recovery is required but the local transaction is not safe to recover');
    }
    if (typeof deps.recoverUpdate !== 'function') {
      throw new Error('Recovery is required but no local recovery API is available');
    }
    const phase = installation.journal?.phase || 'unknown';
    const action = installation.completion_candidate ? 'complete' : 'restore';
    const expectedJournal = installation.journal ? {
      transaction_id: installation.journal.transaction_id,
      phase: installation.journal.phase,
      sha256: journalDigest(installation.journal),
    } : null;
    await authorizeMutation(`Recover transaction at phase ${phase} (${action})?`);
    if (!options.json) deps.stdout('Recovery: journal found; restoring the last verified state...\n');
    recovery = await deps.recoverUpdate({
      installation,
      yes: Boolean(options.yes),
      breakLock: Boolean(options.breakLock),
      interactive: Boolean(deps.interactive),
      breakConfirmed,
      expectedJournal,
    });
    installation = deps.classifyInstallation();
    // The running process may have started from the candidate tree before a
    // crash. Recovery restores the receipt-backed active tree; use that
    // verified state for the subsequent manifest/status decision instead of
    // retaining the stale package version from process startup.
    currentVersion = installation.receipt?.current_version || currentVersion;
    if (!options.json) {
      deps.stdout(`Recovery: ${recovery?.action || 'completed'}.\n`);
    }
  };

  if (options.rollback) {
    await recoverBeforeDiscovery();
    if (installation.kind !== 'standalone') {
      throw new Error('Rollback is available only for a validated standalone installation');
    }
    // Recovery may have completed the rollback transaction before this
    // process reached the command branch. Treat that durable result as the
    // requested operation's success; starting another rollback would simply
    // toggle back to the version the user was trying to leave.
    if (recovery?.action === 'completed' && recovery.journal?.operation === 'rollback') {
      const version = installation.receipt?.current_version ||
        recovery.journal.new_receipt?.current_version || null;
      const summary = mutationResult({
        operation: 'rollback',
        result: { version, restart_required: true },
        recovery,
        fallbackVersion: version,
      });
      deps.stdout(renderMutationHuman(summary));
      return summary;
    }
    // Recovery/reclassification can leave an active initial install without
    // a rollback target. Fail before rendering output, confirmation, or any
    // mutation attempt; the command must not report a misleading transition
    // from a null previous version.
    if (!installation.receipt?.previous_version) {
      throw new Error('No previous standalone version is available for rollback.');
    }
    const stats = computeRetainedStats(installation.receipt);
    if (!options.json) {
      deps.stdout(
        `Retained payload: ${stats.retained_versions} version(s), ` +
        `${stats.retained_payload_bytes} bytes recorded\n`,
      );
      deps.stdout(
        `Rollback: ${installation.receipt.current_version} -> ` +
        `${installation.receipt.previous_version}.\n`,
      );
    }
    const expectedReceipt = {
      current_version: installation.receipt.current_version,
      previous_version: installation.receipt.previous_version,
      sha256: receiptDigest(installation.receipt),
    };
    await authorizeMutation(
      `Rollback ${installation.receipt.current_version} to ` +
      `${installation.receipt.previous_version} at ${installation.receipt.root}?`,
    );
    const result = await deps.rollbackUpdate({
      installation,
      yes: Boolean(options.yes),
      breakLock: Boolean(options.breakLock),
      interactive: Boolean(deps.interactive),
      breakConfirmed,
      expectedReceipt,
    });
    const summary = mutationResult({
      operation: 'rollback',
      result,
      recovery,
      fallbackVersion: installation.receipt.previous_version,
    });
    deps.stdout(renderMutationHuman(summary));
    return summary;
  }

  if (options.apply) await recoverBeforeDiscovery();
  const manifest = await deps.fetchManifest({ currentVersion, nodeMajor, explicit: true });
  const status = statusObject({ currentVersion, nodeMajor, manifest, installation });

  if (options.json) {
    deps.stdout(`${JSON.stringify(status)}\n`);
    return status;
  }

  // A recovery completion may already have activated the requested release
  // before this process fetched the manifest. Treat --apply as an idempotent
  // success in that case; do not print "up to date" and then fail the generic
  // can-apply gate for a transaction that was just repaired successfully.
  if (options.apply && recovery?.action === 'completed' &&
      status.current_version === status.latest_version) {
    const summary = mutationResult({
      operation: 'apply',
      result: { version: status.current_version, restart_required: true },
      recovery,
      fallbackVersion: status.current_version,
    });
    deps.stdout(renderMutationHuman(summary));
    return { ...status, ...summary };
  }

  deps.stdout(renderHuman(status, installation));
  if (!options.apply) return status;
  // The requested release is already the current version. `--apply` is an
  // idempotent success in that case: there is nothing to install, so no
  // confirmation, mutation, or restart is required — and the generic
  // can-apply gate must not turn "Triss is up to date." into a hard failure.
  if (!status.update_available) {
    const summary = mutationResult({
      operation: 'apply',
      result: { version: status.current_version, restart_required: false },
      recovery,
      fallbackVersion: status.current_version,
    });
    return { ...status, ...summary };
  }
  if (manifest.node_compatible === false) {
    throw new Error(
      `Update requires Node ${manifest.node}; you have Node ${nodeMajor}. ` +
      'Upgrade Node before applying this release.',
    );
  }
  if (!status.can_apply && !installation.recovery_required) {
    throw new Error('This installation cannot apply the requested standalone update');
  }
  const expectedReceipt = installation.receipt ? {
    current_version: installation.receipt.current_version,
    previous_version: installation.receipt.previous_version,
    sha256: receiptDigest(installation.receipt),
  } : null;
  await authorizeMutation(
    `Install Triss ${manifest.version} at ${installation.receipt.root} ` +
    `(${manifest.artifact.size} compressed bytes)?`,
  );
  const result = await deps.applyUpdate({
    installation,
    manifest,
    yes: Boolean(options.yes),
    breakLock: Boolean(options.breakLock),
    interactive: Boolean(deps.interactive),
    breakConfirmed,
    expectedReceipt,
  });
  const summary = mutationResult({
    operation: 'apply',
    result,
    recovery,
    fallbackVersion: manifest.version,
  });
  const output = { ...status, ...summary };
  deps.stdout(renderMutationHuman(summary));
  return output;
}

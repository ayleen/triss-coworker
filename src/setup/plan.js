// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// setup/plan.js — SetupPlan assembly and transactional apply (plan §4.3 /
// §P07). buildSetupPlan() validates the draft with the SAME semantics as
// setup/configuration applyDraftToSnapshot (it calls it), captures a raw
// content hash of the target env file, and produces a fully REDACTED,
// JSON-serializable plan (secrets never appear in enumerable fields).
// applySetupPlan() applies the plan:
//   1. all env-file edits in ONE applyEnvPatch call, guarded by the captured
//      hash so a concurrent writer is never clobbered;
//   2. rules / MCP writes through the EXISTING writers (dynamic imports of
//      src/commands/init.js runInit and src/mcp/install.js installEntry via
//      deps seams) — those writers own their own atomicity, this module only
//      records their per-action outcome;
//   3. .gitignore for the local scope via addToGitignore in the SAME apply
//      (idempotent, never deferred behind a later successful step);
//   4. external package installs are NOT part of the file transaction: the
//      caller applies enginePlan separately via setup/engines.js
//      applyEngineSetup; this module only records their planned presence;
//   5. the effective state is re-read with the real resolver afterwards and
//      returned as a SetupResult.
//
// Partial failures never throw: failed actions are recorded and later safe
// actions (rules after env) still run; the result status becomes
// 'incomplete' with reasons. 'cancelled' is ONLY produced by the caller's
// own choice — applySetupPlan never fakes it.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  addToGitignore,
  applyEnvPatch,
  getEnvFilePath,
  maskValue,
} from '../secrets.js';
import {
  applyDraftToSnapshot,
  listSetupFields,
  readSetupState,
} from './configuration.js';
import { resolveCoderEngine } from '../coder-engine-registry.js';
import { TARGETS } from '../agent-rules.js';
import { configPath } from '../mcp/install.js';
import { projectRoot } from '../safety.js';

const FILE_KINDS = Object.freeze(['env', 'rules', 'mcp-json', 'mcp-toml', 'gitignore']);
const HOST_ACTION_KINDS = Object.freeze(['mcp', 'rules']);

function freeze(value) {
  return Object.freeze(value);
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function defaultReadRaw(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

// Bare native model id from a `provider/model` atom value, matching how
// runCoderInit derives crush model atoms from profile values.
function bareModel(value) {
  if (typeof value !== 'string') return value ?? null;
  return value.includes('/') ? value.slice(value.indexOf('/') + 1) : value;
}

// ─── buildSetupPlan (pure assembly) ────────────────────────────────────────

// Mask a draft-edit endpoint value when its key is secret. Empty/undefined
// values stay as-is: there is nothing to fingerprint.
function redactEditValue(value, isSecret) {
  if (!isSecret || value === undefined || value === null || value === '') return value;
  return maskValue(String(value));
}

// Redacted projection of the preview snapshot: provider credential atoms are
// masked first4…last4 (maskValue); every other atom is copied verbatim. The
// original frozen preview is never mutated.
function redactSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const providers = {};
  for (const [id, profile] of Object.entries(snapshot.providers ?? {})) {
    const copy = { ...profile };
    const credential = profile?.credential;
    if (credential && typeof credential === 'object' && credential.value) {
      copy.credential = { ...credential, value: maskValue(String(credential.value)) };
    }
    providers[id] = copy;
  }
  return { ...snapshot, providers };
}

function normalizeHostActions(hostActions, scope, limitations) {
  const actions = [];
  const seen = new Set();
  const dedupe = (action) => {
    const key = `${action.host}\0${action.target}\0${action.hostScope}\0${action.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    actions.push(freeze(action));
  };

  for (const raw of hostActions ?? []) {
    if (!raw || typeof raw !== 'object') {
      throw new TypeError('each hostAction must be an object like { kind: "mcp"|"rules", target, scope? }');
    }
    if (!HOST_ACTION_KINDS.includes(raw.kind)) {
      throw new Error(`unknown hostAction kind "${raw.kind}" — use ${HOST_ACTION_KINDS.join(' or ')}`);
    }
    const hostScope = raw.scope ?? scope;
    if (raw.kind === 'mcp') {
      if (raw.target !== 'claude' && raw.target !== 'codex') {
        throw new Error(`unknown mcp hostAction target "${raw.target}" — use claude or codex`);
      }
      // Mirror the wizard's existing behavior: codex has no project-local MCP
      // config, so it plans the global config and says so.
      const effectiveScope = raw.target === 'codex' && hostScope === 'local'
        ? 'global'
        : hostScope;
      if (effectiveScope !== hostScope) {
        limitations.push(
          'codex supports global MCP config only — planned ~/.codex/config.toml instead of a project-local file',
        );
      }
      const kind = raw.target === 'codex' ? 'mcp-toml' : 'mcp-json';
      dedupe({
        kind: 'host',
        host: 'mcp',
        target: raw.target,
        hostScope: effectiveScope,
        fileKind: kind,
        path: configPath(effectiveScope, raw.target),
      });
      continue;
    }
    // rules: runInit's own scope semantics — global lives in the target's
    // global dir, otherwise the project cwd.
    const targets = raw.target === 'both' ? ['claude', 'codex'] : [raw.target];
    for (const target of targets) {
      const meta = TARGETS[target];
      if (!meta) {
        throw new Error(`unknown rules hostAction target "${raw.target}" — use claude, codex or both`);
      }
      dedupe({
        kind: 'host',
        host: 'rules',
        target,
        hostScope,
        fileKind: 'rules',
        path: hostScope === 'global'
          ? join(homedir(), meta.globalDir, meta.filename)
          : join(process.cwd(), meta.filename),
      });
    }
  }
  return actions;
}

/**
 * PURE assembly of a SetupPlan. `draft` is validated with
 * applyDraftToSnapshot semantics (invalid keys/values, managed fields and
 * duplicate edits throw) BEFORE any filesystem access, so an invalid
 * argument can never leave a half-created environment behind. The returned
 * plan is { scope, summary, preview, env, hostActions, enginePlan,
 * requestedValidation } where:
 *   - summary = { provider, engine, models, filesToChange, externalActions,
 *     limitations, blockers } with filesToChange: [{ path, kind }] over
 *     env / rules / mcp-json / mcp-toml / gitignore;
 *   - preview = { snapshot, edits, conflicts } — the post-draft snapshot and
 *     edit list with EVERY secret value masked (first4…last4), safe to
 *     JSON.stringify;
 *   - env = { path, rawHash, editCount } — rawHash guards applySetupPlan
 *     against concurrent modifications of the env file;
 *   - enginePlan is stored verbatim for the caller; its external installs
 *     are NEVER applied by applySetupPlan.
 * The raw env edit values (needed to actually apply) ride along as a
 * NON-ENUMERABLE `rawEnvEdits` property so accidental serialization of the
 * plan cannot leak secrets.
 */
export function buildSetupPlan(
  {
    scope,
    draft = {},
    state,
    enginePlan,
    hostActions = [],
    requestedValidation = false,
    integrations = [],
  } = {},
  deps = {},
) {
  if (scope !== 'local' && scope !== 'global') {
    throw new Error(`unknown setup scope "${scope}" — use "local" or "global"`);
  }
  if (!state || typeof state !== 'object' || !state.snapshot) {
    throw new TypeError('state must come from readSetupState() (setup/configuration.js)');
  }

  // Pure validation first: an invalid draft throws before any fs read.
  const applied = applyDraftToSnapshot(state.snapshot, draft, { integrations });

  // Env edits derived from the draft's changed list: `to === undefined`
  // means unset (planEnvPatch's null); absent-to-absent entries are no-ops.
  const rawEnvEdits = applied.changed
    .filter((edit) => !(edit.to === undefined && edit.from === undefined))
    .map((edit) => freeze({ key: edit.key, value: edit.to === undefined ? null : edit.to }));
  // TRISS_CONFIG_SCHEMA is managed (not user-editable through the draft);
  // any real config write stamps it so downstream readers see schema 2.
  if (rawEnvEdits.length > 0 && state.snapshot.schema?.value !== '2') {
    rawEnvEdits.push(freeze({ key: 'TRISS_CONFIG_SCHEMA', value: '2' }));
  }

  // Redacted edit projection for the preview.
  const secretKeys = new Set(
    listSetupFields({ integrations })
      .filter((descriptor) => descriptor.secret && !descriptor.pattern)
      .map((descriptor) => descriptor.key),
  );
  const edits = applied.changed.map((edit) => freeze({
    key: edit.key,
    from: redactEditValue(edit.from, secretKeys.has(edit.key)),
    to: redactEditValue(edit.to, secretKeys.has(edit.key)),
  }));

  // Raw content hash of the target env file, captured now (right after the
  // caller's readSetupState) so apply can detect concurrent modification.
  const readFile = deps.readFile ?? defaultReadRaw;
  const envPath = getEnvFilePath(scope);
  const rawHash = sha256(readFile(envPath));

  const limitations = [...(enginePlan?.limitations ?? [])];
  for (const key of applied.conflicts) {
    limitations.push(
      `${key}: the shell value outranks every persisted layer — unset it in your shell to change the effective value`,
    );
  }

  const filesToChange = [];
  if (rawEnvEdits.length > 0) {
    filesToChange.push(freeze({ path: envPath, kind: 'env' }));
    if (scope === 'local') {
      // The local secret file must never be left unignored by a later
      // failure — .gitignore is planned as part of the same apply.
      filesToChange.push(freeze({ path: join(projectRoot(), '.gitignore'), kind: 'gitignore' }));
    }
  }
  const normalizedHostActions = normalizeHostActions(hostActions, scope, limitations);
  for (const action of normalizedHostActions) {
    filesToChange.push(freeze({ path: action.path, kind: action.fileKind }));
  }

  const previewSnapshot = applied.preview;
  const providerId = previewSnapshot.defaultProvider?.value
    ?? state.snapshot.defaultProvider?.value;
  const coderProviderId = previewSnapshot.coderProvider?.value || providerId;
  const profile = previewSnapshot.providers?.[coderProviderId];
  const models = enginePlan?.providerActions?.[0]?.models ?? {
    model: bareModel(profile?.model?.value),
    smallModel: bareModel(profile?.smallModel?.value),
  };
  const engine = enginePlan?.engine ?? resolveCoderEngine({});

  const summary = freeze({
    provider: providerId,
    coderProvider: coderProviderId,
    engine,
    models: freeze({ ...models }),
    filesToChange: freeze(filesToChange),
    externalActions: freeze([...(enginePlan?.actions ?? [])]),
    limitations: freeze(limitations),
    blockers: freeze([]),
  });

  const plan = {
    scope,
    summary,
    preview: freeze({
      snapshot: freeze(redactSnapshot(previewSnapshot)),
      edits: freeze(edits),
      conflicts: freeze([...applied.conflicts]),
    }),
    env: freeze({ path: envPath, rawHash, editCount: rawEnvEdits.length }),
    hostActions: freeze(normalizedHostActions),
    enginePlan: enginePlan ?? null,
    requestedValidation: Boolean(requestedValidation),
  };
  // Secret-bearing payload, hidden from JSON.stringify / console dumps.
  Object.defineProperty(plan, 'rawEnvEdits', {
    value: freeze([...rawEnvEdits]),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return freeze(plan);
}

// ─── applySetupPlan (transactional apply) ──────────────────────────────────

function recordAction(list, entry) {
  list.push(freeze(entry));
}

function appliedKinds(result) {
  return new Set([...result.applied, ...result.unchanged].map((a) => a.kind));
}

function failedKinds(result) {
  return new Set(result.failed.map((a) => a.kind));
}

function perComponent(name, { configured, available, executionMode = 'normal', reasons = [] }) {
  return freeze({
    name,
    configured: Boolean(configured),
    available: Boolean(available),
    verification: 'not-run',
    executionMode,
    reasons: freeze([...reasons]),
  });
}

/**
 * Apply a SetupPlan built by buildSetupPlan. Seams (all optional):
 *   deps.applyEnvPatch(path, edits) — default: the real applyEnvPatch
 *     (src/secrets.js; exactly ONE call per apply);
 *   deps.installMcp(scope, { target }) — default: dynamic import of
 *     src/mcp/install.js installEntry;
 *   deps.writeRules({ global, target }) — default: dynamic import of
 *     src/commands/init.js runInit;
 *   deps.addToGitignore(pattern) — default: the real addToGitignore;
 *   deps.rereadState(options) — default: readSetupState (the shared
 *     effective-state resolver).
 *
 * Throws ONLY for a concurrent modification of the env file detected via the
 * plan's captured raw hash (the file is named and never clobbered) and for a
 * structurally invalid plan. Every other failure is recorded per action and
 * the apply continues where safe. Returns a SetupResult
 * { status, perComponent, applied, unchanged, failed, warnings, state }:
 * status is 'ready' when nothing failed, 'incomplete' otherwise; 'cancelled'
 * is the CALLER's decision before calling this function, never produced
 * here. External installs recorded in the plan are documented as planned
 * presence only — the caller applies enginePlan via applyEngineSetup.
 */
export async function applySetupPlan(plan, deps = {}) {
  if (!plan || typeof plan !== 'object' || !plan.summary || !plan.env) {
    throw new TypeError('applySetupPlan requires a plan from buildSetupPlan');
  }
  const scope = plan.scope;
  if (scope !== 'local' && scope !== 'global') {
    throw new Error(`plan has an unknown scope "${scope}" — rebuild it with buildSetupPlan`);
  }
  if (plan.env.editCount > 0) {
    const rawEdits = plan.rawEnvEdits;
    if (!Array.isArray(rawEdits) || rawEdits.length !== plan.env.editCount) {
      throw new TypeError('plan is missing its non-enumerable rawEnvEdits payload — rebuild it with buildSetupPlan');
    }
  }

  const applied = [];
  const unchanged = [];
  const failed = [];
  const warnings = [];

  // .gitignore FIRST and fail-closed: a local secret file must never be
  // written while its ignore entry is missing, and an ignore update failure
  // must stop the env write rather than leave the secret committable.
  const gitignorePlanned = (plan.summary.filesToChange ?? []).some((f) => f.kind === 'gitignore');
  let gitignoreFailed = null;
  if (gitignorePlanned) {
    try {
      const add = deps.addToGitignore ?? addToGitignore;
      const added = add('.triss.env');
      if (added) {
        recordAction(applied, { kind: 'gitignore', path: join(projectRoot(), '.gitignore'), detail: 'added .triss.env' });
      } else {
        recordAction(unchanged, { kind: 'gitignore', path: join(projectRoot(), '.gitignore'), detail: '.triss.env already ignored' });
      }
    } catch (err) {
      gitignoreFailed = err.message;
      recordAction(failed, { kind: 'gitignore', path: join(projectRoot(), '.gitignore'), reason: err.message });
    }
  }
  if (gitignoreFailed && plan.env.editCount > 0) {
    recordAction(failed, {
      kind: 'env',
      path: plan.env.path,
      reason: `skipped — .gitignore could not be updated (${gitignoreFailed}); refusing to write an unignored secret file`,
    });
    const reread = deps.rereadState ?? ((options) => readSetupState(options));
    const state = await reread({ scope: plan.scope });
    return freeze({
      status: 'incomplete',
      perComponent: freeze([
        perComponent('gitignore', { configured: false, available: false, reasons: [gitignoreFailed] }),
        perComponent('env-file', { configured: false, available: false, reasons: ['skipped until .gitignore is writable'] }),
      ]),
      applied: freeze(applied),
      unchanged: freeze(unchanged),
      failed: freeze(failed),
      warnings: freeze(warnings),
      state,
    });
  }

  // Env file edits — one applyEnvPatch call, guarded by the raw hash.
  if (plan.env.editCount > 0) {
    const readRaw = deps.readRaw ?? defaultReadRaw;
    const current = readRaw(plan.env.path);
    if (sha256(current) !== plan.env.rawHash) {
      throw new Error(
        `concurrent modification: ${plan.env.path} changed after the setup state was read — ` +
          're-read the state and rebuild the plan instead of overwriting the newer content',
      );
    }
    try {
      const patch = deps.applyEnvPatch ?? applyEnvPatch;
      const result = await patch(plan.env.path, plan.rawEnvEdits);
      const entry = { kind: 'env', path: plan.env.path, keys: freeze([...result.touched]) };
      if (result.changed) {
        recordAction(applied, entry);
      } else {
        recordAction(unchanged, entry);
      }
    } catch (err) {
      recordAction(failed, { kind: 'env', path: plan.env.path, reason: err.message });
    }
  }

  // 2. Rules / MCP writes through the existing writers.
  for (const action of plan.hostActions ?? []) {
    if (action.host === 'mcp') {
      try {
        const installer = deps.installMcp
          ?? (async (mcpScope, opts) => (await import('../mcp/install.js')).installEntry(mcpScope, opts));
        const result = await installer(action.hostScope, { target: action.target });
        recordAction(applied, {
          kind: action.fileKind,
          path: result?.path ?? action.path,
          detail: `mcp server "triss" ${result?.status ?? 'written'}`,
        });
      } catch (err) {
        recordAction(failed, { kind: action.fileKind, path: action.path, reason: err.message });
      }
      continue;
    }
    if (action.host === 'rules') {
      try {
        const writer = deps.writeRules
          ?? (async (opts) => (await import('../commands/init.js')).runInit(opts));
        await writer({ global: action.hostScope !== 'local', target: action.target });
        recordAction(applied, { kind: 'rules', path: action.path, detail: 'managed rules block written' });
      } catch (err) {
        recordAction(failed, { kind: 'rules', path: action.path, reason: err.message });
      }
    }
  }

  // 4. External installs are NOT part of this file transaction — the caller
  // applies plan.enginePlan separately via applyEngineSetup; the planned
  // presence is surfaced through summary.externalActions and perComponent.

  for (const limitation of plan.summary.limitations ?? []) {
    warnings.push(limitation);
  }
  for (const key of plan.preview?.conflicts ?? []) {
    warnings.push(`${key}: shell value overrides the persisted layers; the unset was not applied`);
  }

  // 5. Re-read the effective state with the shared resolver.
  let state = null;
  try {
    const reread = deps.rereadState ?? ((options) => readSetupState(options));
    state = await reread({ scope });
  } catch (err) {
    recordAction(failed, { kind: 'state-reread', path: null, reason: err.message });
    warnings.push(`effective state could not be re-read: ${err.message}`);
  }

  const okKinds = appliedKinds({ applied, unchanged });
  const badKinds = failedKinds({ applied, unchanged, failed });

  const components = [];
  const providerId = plan.summary.provider;
  const providerProfile = state?.snapshot?.providers?.[providerId];
  const providerConfigured = Boolean(providerProfile?.credential?.value);
  components.push(perComponent(`provider:${providerId}`, {
    configured: providerConfigured,
    available: providerConfigured,
    reasons: providerConfigured ? [] : [`credential for ${providerId} is not set`],
  }));

  const enginePlan = plan.enginePlan;
  const installAction = enginePlan?.actions?.find((a) => a.kind === 'engine-install');
  const engineInstallPending = Boolean(installAction?.needed);
  const engineDeclined = engineInstallPending && (enginePlan?.installChoice ?? 'install') === 'skip';
  const credentialMode = enginePlan?.providerActions?.[0]?.credentialMode;
  components.push(perComponent(`engine:${plan.summary.engine}`, {
    configured: true,
    available: !engineDeclined,
    executionMode: credentialMode === 'best_effort_raw' ? 'best-effort' : 'normal',
    reasons: [
      ...(engineInstallPending
        ? ['external engine install is applied separately by the caller (see applyEngineSetup) — not part of this file transaction']
        : []),
      ...(engineDeclined ? ['engine installation was declined (installChoice="skip")'] : []),
    ],
  }));

  components.push(perComponent('env-file', {
    configured: plan.env.editCount === 0 || okKinds.has('env'),
    available: !badKinds.has('env'),
    reasons: badKinds.has('env')
      ? [failed.find((f) => f.kind === 'env')?.reason].filter(Boolean)
      : [],
  }));
  for (const action of plan.hostActions ?? []) {
    components.push(perComponent(`${action.host}:${action.target}`, {
      configured: okKinds.has(action.fileKind),
      available: !badKinds.has(action.fileKind),
      reasons: badKinds.has(action.fileKind)
        ? [failed.find((f) => f.kind === action.fileKind)?.reason].filter(Boolean)
        : [],
    }));
  }
  if (gitignorePlanned) {
    components.push(perComponent('gitignore', {
      configured: okKinds.has('gitignore'),
      available: !badKinds.has('gitignore'),
    }));
  }

  return freeze({
    status: failed.length === 0 ? 'ready' : 'incomplete',
    perComponent: freeze(components),
    applied: freeze(applied),
    unchanged: freeze(unchanged),
    failed: freeze(failed),
    warnings: freeze(warnings),
    state,
  });
}

// Re-exported for consumers that validate file kinds without importing the
// constant list inline.
export { FILE_KINDS as SETUP_PLAN_FILE_KINDS };

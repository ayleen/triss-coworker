// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// setup/engines.js — shared full engine setup for `coder init` and the
// wizard (plan §4.3 / P06). The module is split by purity:
//
//   - listEngineSetupFields() / planEngineSetup() are data + pure planning:
//     no prompts, no filesystem writes, no spawnSync inside the planner.
//     Whether an engine needs installing comes from a version-policy PROBE
//     SEAM (deps.probeEngine) so tests and the wizard inject their own.
//   - probeEngineVersionPolicy() is the ready-made CLI-side probe built on
//     the engine adapters' own version policies (it spawns read-only
//     `--version` probes — that is exactly why it is NOT called from the
//     planner).
//   - applyEngineSetup() executes a plan through injected seams
//     (deps.runInstall, deps.runCoderSetup) and records a per-action
//     outcome for every step; it never throws mid-way without recording.
//
// Install commands are derived from the engine adapters' installHint()
// wherever one exists (crush, omp, opencode2) so this file cannot drift
// from the adapters. OpenCode 1 has no adapter module — its install command
// is assembled from the exported opencode version policy exactly like
// ensureEngine() does inside src/commands/coder.js (which is not exported
// and owned by another workstream; do not duplicate more of it here).

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { VALID_CODER_ENGINES } from '../coder-engine-registry.js';
import { crush as crushEngine } from '../coder-engines/crush.js';
import { omp as ompEngine } from '../coder-engines/omp.js';
import { opencode2 as opencode2Engine } from '../coder-engines/opencode2.js';
import { resolveOpencodeVersionPolicy, runCoderSetup } from '../commands/coder.js';

// ─── engine inventory ──────────────────────────────────────────────────────

// omp's installHint() is `curl https://omp.sh/install | sh  # minimum …` —
// an executable command plus a human annotation. Keep the single source
// (the adapter) but strip the annotation so `command` stays exactly what a
// shell must run; the version annotation lives in minimumVersion().
function commandFromHint(hint) {
  return String(hint).split('#')[0].trim();
}

// OpenCode 1 minimum without spawning: resolveOpencodeVersionPolicy(null)
// is pure and classifies the configured minimum (TRISS_CODER_OPENCODE_VERSION)
// against the exported supported floor, degrading to the floor text when the
// config is invalid — the same value ensureEngine() installs.
function opencodeMinimum() {
  const policy = resolveOpencodeVersionPolicy(null);
  return { value: policy.effectiveMinimum, policy };
}

function minimumFromPin(pin, configuredEnv, origin) {
  const configured = process.env[configuredEnv];
  return {
    value: pin,
    source: configured ? `${configuredEnv} (raise-only; clamped to the adapter floor)` : origin,
  };
}

// Descriptors are rebuilt on every call (no module-level cache): the
// effective minimums read raise-only TRISS_CODER_*_VERSION overrides at
// call time, and tests change process.env per case — a cached command
// would go stale.
function buildEngineDescriptor(id) {
  switch (id) {
    case 'opencode':
      return {
        id,
        install: () => ({
          command: `npm install -g opencode-ai@${opencodeMinimum().value}`,
          kind: 'npm',
        }),
        minimumVersion: () => {
          const { value, policy } = opencodeMinimum();
          const configured = process.env.TRISS_CODER_OPENCODE_VERSION;
          return {
            value,
            source: configured
              ? (policy.configValid
                ? 'TRISS_CODER_OPENCODE_VERSION (raise-only, floor-clamped)'
                : `invalid TRISS_CODER_OPENCODE_VERSION degraded to the floor ${policy.effectiveMinimum}`)
              : 'src/commands/coder.js OPENCODE_SUPPORTED_FLOOR (default pin)',
          };
        },
        detectionHint: 'opencode --version on PATH (shared policy: src/commands/coder.js resolveOpencodeVersionPolicy)',
      };
    case 'opencode2':
      return {
        id,
        install: () => ({
          command: opencode2Engine.installHint(),
          kind: 'npm',
        }),
        minimumVersion: () => minimumFromPin(
          opencode2Engine.versionPin(),
          'TRISS_CODER_OPENCODE2_VERSION',
          'src/coder-engines/opencode2.js OPENCODE2_MIN_VERSION_DEFAULT (minimum-or-newer beta channel, never an exact pin)',
        ),
        detectionHint: 'opencode2 --version on PATH plus capability probe (src/coder-engines/opencode2.js detect)',
      };
    case 'crush':
      return {
        id,
        install: () => ({
          command: crushEngine.installHint(),
          kind: 'npm',
        }),
        minimumVersion: () => minimumFromPin(
          crushEngine.CRUSH_PIN,
          'TRISS_CODER_CRUSH_VERSION',
          'src/coder-engines/crush.js CRUSH_SUPPORTED_FLOOR (hard floor, raise-only config)',
        ),
        detectionHint: 'crush --version on PATH (src/coder-engines/crush.js resolveCrushVersionPolicy)',
      };
    case 'omp':
      return {
        id,
        install: () => ({
          command: commandFromHint(ompEngine.installHint()),
          kind: 'script',
        }),
        minimumVersion: () => minimumFromPin(
          ompEngine.OMP_PIN,
          'TRISS_CODER_OMP_VERSION',
          'src/coder-engines/omp.js OMP_SUPPORTED_FLOOR (hard floor, raise-only config)',
        ),
        detectionHint: 'omp --version on PATH (src/coder-engines/omp.js resolveOmpVersionPolicy)',
      };
    default:
      throw new Error(`unknown engine "${id}" — valid values: ${VALID_CODER_ENGINES.join(', ')}`);
  }
}

function descriptorFor(engine) {
  return buildEngineDescriptor(engine);
}

/**
 * Frozen inventory of the four native engines with everything the wizard
 * needs to describe an install: { id, install: { command, kind }, 
 * minimumVersion() -> { value, source }, detectionHint }. Commands come from
 * the adapters' installHint() (opencode 1 assembles its command from the
 * shared version policy, mirroring ensureEngine()).
 */
export function listEngineSetupFields() {
  return Object.freeze(
    VALID_CODER_ENGINES.map((id) => {
      const descriptor = descriptorFor(id);
      return Object.freeze({
        id: descriptor.id,
        install: Object.freeze({ ...descriptor.install() }),
        minimumVersion: descriptor.minimumVersion,
        detectionHint: descriptor.detectionHint,
      });
    }),
  );
}

// ─── version-policy probe (CLI side; spawns read-only --version probes) ────

// Minimal sanitized probe env (PATH + locale/TZ only) — same posture as the
// adapters' own buildProbeEnv(): a version probe never inherits credentials.
function opencodeProbeEnv() {
  const env = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ']) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  return env;
}

// Normalize the heterogeneous policy objects into the fields the planner
// reads: found / installedVersion / compatible / reason / effectiveMinimum /
// configValid. crush+omp policies already use `compatible`; the opencode 1
// policy uses `installedCompatible`; the opencode2 detect() projection uses
// `satisfiesPin`.
function normalizePolicy(engine, policy) {
  if (!policy || typeof policy !== 'object') {
    throw new TypeError(`probeEngine("${engine}") must return the engine's version-policy object`);
  }
  const found = policy.found ?? policy.installedVersion != null;
  const compatible = Boolean(
    policy.compatible ?? policy.installedCompatible ?? policy.satisfiesPin,
  ) && found;
  return {
    found: Boolean(found),
    installedVersion: policy.installedVersion ?? policy.version ?? null,
    compatible,
    reason: policy.reason ?? (compatible ? 'compatible' : found ? 'version_unknown' : 'missing'),
    effectiveMinimum: policy.effectiveMinimum ?? policy.minimumVersion ?? null,
    configValid: policy.configValid !== false,
    configuredMinimum: policy.configuredMinimum ?? null,
  };
}

/**
 * Ready-made deps.probeEngine for CLI adapters: returns each engine's own
 * policy object (never a reimplementation). crush/omp come from their
 * adapters' resolveVersionPolicy(sh); opencode2 from detect(sh); opencode 1
 * from a read-only `opencode --version` probe classified through the shared
 * resolveOpencodeVersionPolicy. `sh` is injectable for tests.
 */
export function probeEngineVersionPolicy(engine, sh = nodeSpawnSync) {
  if (engine === 'crush') return crushEngine.resolveVersionPolicy(sh);
  if (engine === 'omp') return ompEngine.resolveVersionPolicy(sh);
  if (engine === 'opencode2') {
    const detected = opencode2Engine.detect(sh);
    return {
      found: detected.found,
      installedVersion: detected.version ?? null,
      compatible: Boolean(detected.satisfiesPin),
      reason: detected.found
        ? (detected.satisfiesPin ? 'compatible' : (detected.capabilities?.reason ?? 'below_minimum'))
        : 'missing',
      effectiveMinimum: detected.minimumVersion ?? opencode2Engine.versionPin(),
      capabilities: detected.capabilities ?? null,
    };
  }
  if (engine === 'opencode') {
    let result;
    try {
      result = sh('opencode', ['--version'], { env: opencodeProbeEnv() });
    } catch {
      result = null;
    }
    if (!result || result.error || result.status !== 0) {
      // Not installed (mirrors detectOpencodeVersion's null case).
      return { ...normalizePolicy('opencode', { found: false }), reason: 'missing' };
    }
    const version = String(result.stdout || '').trim();
    const policy = resolveOpencodeVersionPolicy(version === '' ? null : version);
    return {
      ...policy,
      found: true,
      installedVersion: version === '' ? null : version,
      compatible: policy.installedCompatible,
      reason: policy.reason,
    };
  }
  throw new Error(`unknown engine "${engine}" — valid values: ${VALID_CODER_ENGINES.join(', ')}`);
}

// ─── pure planning ─────────────────────────────────────────────────────────

function installReason(engine, policy) {
  if (policy.compatible) {
    return `${engine} ${policy.installedVersion} already meets the minimum ${policy.effectiveMinimum}`;
  }
  if (!policy.found) return `${engine} not found on PATH — installation required`;
  if (policy.installedVersion == null) {
    return `${engine} found but its version could not be determined (minimum ${policy.effectiveMinimum})`;
  }
  return `${engine} ${policy.installedVersion} does not meet the minimum ${policy.effectiveMinimum} (${policy.reason})`;
}

function engineLimitations(engine, policy) {
  const limitations = [];
  if (policy.configValid === false) {
    const knob = {
      opencode: 'TRISS_CODER_OPENCODE_VERSION',
      opencode2: 'TRISS_CODER_OPENCODE2_VERSION',
      crush: 'TRISS_CODER_CRUSH_VERSION',
      omp: 'TRISS_CODER_OMP_VERSION',
    }[engine];
    limitations.push(
      `${engine}: configured minimum ${JSON.stringify(policy.configuredMinimum)} is invalid — installing a binary cannot fix this; set ${knob} to a canonical supported version`,
    );
  }
  if (engine === 'crush') {
    limitations.push(
      'crush: the shared setup boundary (runCoderSetup) does not complete crush model/permission seeding yet — applyEngineSetup records the exact `triss coder init --engine crush <scope>` recovery command from the underlying error instead of faking success',
    );
  }
  if (engine === 'omp') {
    limitations.push(
      'omp: no persistent engine config — runtime config/auth/state live in a run-private PI_CODING_AGENT_DIR created per invocation',
    );
  }
  if (engine === 'opencode2') {
    limitations.push(
      'opencode2: beta channel install (@opencode-ai/cli@beta); compatibility is minimum-or-newer plus the CLI capability contract, never an exact build pin',
    );
  }
  return limitations;
}

/**
 * PURE engine setup planning (no prompts, no writes, no spawn): builds a
 * SetupPlan fragment for one engine. `needed` comes from the injected
 * version-policy probe `deps.probeEngine(engine)` (use
 * probeEngineVersionPolicy as the default CLI implementation) — the planner
 * itself never spawns. Returns
 *   { engine, installChoice, probe, actions, providerActions, limitations }
 * where actions[0] is { kind: 'engine-install', engine, command, installKind,
 * needed, reason } and providerActions[0] carries the runCoderSetup intent
 * ({ engine, provider, scope, credentialMode, models }). installChoice
 * ('install' | 'skip', default 'install') is honored by applyEngineSetup.
 */
export function planEngineSetup(
  {
    engine,
    provider,
    scope,
    models,
    credentialMode,
    installChoice = 'install',
  } = {},
  deps = {},
) {
  if (!VALID_CODER_ENGINES.includes(engine)) {
    throw new Error(`unknown engine "${engine}" — valid values: ${VALID_CODER_ENGINES.join(', ')}`);
  }
  if (scope !== undefined && scope !== 'local' && scope !== 'global') {
    throw new Error(`unknown setup scope "${scope}" — use "local" or "global"`);
  }
  if (installChoice !== 'install' && installChoice !== 'skip') {
    throw new Error(`unknown installChoice "${installChoice}" — use "install" or "skip"`);
  }
  if (typeof deps.probeEngine !== 'function') {
    throw new TypeError(
      'planEngineSetup requires deps.probeEngine(engine) — inject a version-policy probe ' +
        '(see probeEngineVersionPolicy); the planner never spawns',
    );
  }
  if (models !== undefined && models !== null && typeof models !== 'object') {
    throw new TypeError('models must be null/undefined or an object like { model, smallModel }');
  }

  const descriptor = descriptorFor(engine);
  const policy = normalizePolicy(engine, deps.probeEngine(engine));

  const action = Object.freeze({
    kind: 'engine-install',
    engine,
    command: descriptor.install().command,
    installKind: descriptor.install().kind,
    needed: !policy.compatible,
    reason: installReason(engine, policy),
  });
  const providerAction = Object.freeze({
    kind: 'provider-setup',
    engine,
    provider: provider ?? null,
    scope: scope ?? 'global',
    credentialMode: credentialMode ?? null,
    models: models
      ? Object.freeze({
        model: models.model ?? null,
        smallModel: models.smallModel ?? null,
      })
      : null,
  });

  return Object.freeze({
    engine,
    installChoice,
    probe: Object.freeze(policy),
    actions: Object.freeze([action]),
    providerActions: Object.freeze([providerAction]),
    limitations: Object.freeze(engineLimitations(engine, policy)),
  });
}

// ─── apply ─────────────────────────────────────────────────────────────────

// Default deps.runInstall. The npm commands this module plans contain no
// quoted/whitespace arguments, so whitespace splitting is exact; script-kind
// commands (omp's curl|sh) run through `sh -c` verbatim.
function defaultRunInstall(command, engine) {
  const parts = String(command).trim().split(/\s+/);
  const result = parts[0] === 'npm'
    ? nodeSpawnSync('npm', parts.slice(1), { stdio: 'inherit' })
    : nodeSpawnSync('sh', ['-c', command], { stdio: 'inherit' });
  if (!result || result.error || result.status !== 0) {
    const detail = result?.error ? ` (${result.error.message})` : '';
    return { ok: false, error: `install command failed for ${engine}: ${command}${detail}` };
  }
  return { ok: true };
}

function outcome(kind, engine, status, reason) {
  return { kind, engine, status, reason };
}

/**
 * Execute an engine setup plan through seams:
 *   deps.runInstall(command, engine) — performs the external install
 *     (default: real npm / sh -c spawn, stdio inherited);
 *   deps.runCoderSetup(input) — performs provider/model persistence
 *     (default: the real runCoderSetup from src/commands/coder.js).
 *
 * The engine install runs only when the plan says it is needed AND
 * installChoice !== 'skip'. Provider setup then runs for ALL four engines
 * through runCoderSetup (its omp branch verifies the version policy and the
 * credential; its crush branch currently refuses to complete and reports
 * the exact `triss coder init --engine crush` recovery command — recorded
 * as a failed outcome with that actionable reason, never swallowed).
 *
 * Returns { engine, status, outcomes, providerResult, limitations }:
 * `status` is 'applied' when every outcome succeeded and no needed install
 * was declined, otherwise 'incomplete'; each outcome carries
 * { kind, engine, status: 'applied'|'skipped'|'failed', reason }. A throwing
 * seam is recorded as a failed outcome, never re-thrown mid-way.
 */
export async function applyEngineSetup(plan, deps = {}) {
  if (!plan || typeof plan !== 'object' || !VALID_CODER_ENGINES.includes(plan.engine)) {
    throw new TypeError('applyEngineSetup requires a plan from planEngineSetup');
  }
  const outcomes = [];
  const installAction = Array.isArray(plan.actions)
    ? plan.actions.find((action) => action.kind === 'engine-install')
    : undefined;
  const installChoice = plan.installChoice ?? 'install';

  if (installAction && installAction.needed && installChoice !== 'skip') {
    const runInstall = deps.runInstall ?? defaultRunInstall;
    try {
      const result = await runInstall(installAction.command, plan.engine);
      if (result && result.ok === false) {
        outcomes.push(outcome('engine-install', plan.engine, 'failed',
          result.error || `install reported failure: ${installAction.command}`));
      } else {
        outcomes.push(outcome('engine-install', plan.engine, 'applied',
          `installed via: ${installAction.command}`));
      }
    } catch (err) {
      outcomes.push(outcome('engine-install', plan.engine, 'failed',
        `${installAction.command}: ${err.message}`));
    }
  } else if (installAction && installAction.needed) {
    outcomes.push(outcome('engine-install', plan.engine, 'skipped',
      `install declined (installChoice="${installChoice}") — ${installAction.reason}`));
  } else if (installAction) {
    outcomes.push(outcome('engine-install', plan.engine, 'skipped', installAction.reason));
  }

  const providerAction = Array.isArray(plan.providerActions)
    ? plan.providerActions.find((action) => action.kind === 'provider-setup')
    : undefined;
  const runSetup = deps.runCoderSetup
    ?? ((input) => runCoderSetup(input, deps));
  let providerResult = null;
  try {
    providerResult = await runSetup({
      engine: plan.engine,
      scope: providerAction?.scope ?? 'global',
      provider: providerAction?.provider ?? undefined,
      credentialMode: providerAction?.credentialMode ?? undefined,
    });
    const summaryBits = [];
    if (providerResult && typeof providerResult === 'object') {
      if (providerResult.model) summaryBits.push(`model=${providerResult.model}`);
      if (providerResult.smallModel) summaryBits.push(`smallModel=${providerResult.smallModel}`);
    }
    outcomes.push(outcome('provider-setup', plan.engine, 'applied',
      `runCoderSetup completed for ${providerAction?.provider ?? '(inferred provider)'}`
      + (summaryBits.length ? ` (${summaryBits.join(', ')})` : '')));
  } catch (err) {
    outcomes.push(outcome('provider-setup', plan.engine, 'failed', err.message));
  }

  const declinedNeededInstall = Boolean(installAction?.needed && installChoice === 'skip');
  const status = outcomes.some((o) => o.status === 'failed') || declinedNeededInstall
    ? 'incomplete'
    : 'applied';

  return Object.freeze({
    engine: plan.engine,
    status,
    outcomes: Object.freeze(outcomes.map((o) => Object.freeze(o))),
    providerResult,
    limitations: plan.limitations ?? [],
  });
}

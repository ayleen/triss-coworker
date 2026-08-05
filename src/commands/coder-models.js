// src/commands/coder-models.js — CLI handlers for `triss coder models` (live
// read-only model listing) and `triss coder model set` (persistent model
// switch). These are the Phase 4 command surfaces wired in bin/triss.js.
//
// They reuse the shared in-process service in src/coder-models.js (provider
// intent, catalogue status, compatibility validation, transactional
// read-modify-write of opencode.json + the two Triss env pins) and the
// existing env/config loader (loadEnvFiles). The service owns the "no silent
// fallback", "no credential value ever leaves", and "pure plan /
// transactional apply" invariants; this module owns CLI affordances: argument
// parsing, explicit engine/scope/yes gates, human + JSON rendering, and the
// non-interactive mutation contract.
//
// Naming: the SHARED SERVICE lives at src/coder-models.js (project root);
// THIS file at src/commands/coder-models.js holds only the thin CLI action
// handlers. Same basename, different directory — the service is imported via
// '../coder-models.js'.
//
// ─── Current scope (this module) ─────────────────────────────────────────────
//   - functional OpenCode read-only listing (`coder models`, `--json`)
//   - non-interactive model-set validation + rendering (`coder model set`)
//   - explicit engine + scope + --yes gates; no secret output
//   - on `--yes`, a real apply via the service's transactional
//     read-modify-write — config + env pins staged in 0600 sibling temps and
//     committed via per-file atomic rename, with a collision-resistant record,
//     rollback on failure, exit 2 (write/validation failure) vs exit 3
//     (rollback failure with protected record + absolute restore paths).
//
// ─── Intentionally NOT faked here (later phases) ─────────────────────────────
//   - the cross-scope shadow audit runs in runCoderModelSet (project env /
//     project opencode.json overriding a global request) — see
//     auditCrossScopeShadow below; the shell-export shadow is still warned
//     post-apply by warnIfShellShadow
//   - Crush model mutations (crush.json is opaque to triss; `crush models use`
//     is the engine's own surface) — refused here with a gap message, never
//     faked as an opencode.json write
//   - interactive TTY flow (engine/scope/provider/model prompts) — non-interactive
//     only; a TTY still requires the explicit flags + --yes

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';
import { loadEnvFiles } from '../config.js';
import { resolveCoderEngine } from './coder.js';
import { projectRoot } from '../safety.js';
import { getEnvFilePath, readEnvFile } from '../secrets.js';
import {
  resolveProviderIntent,
  inspectCoderModelState,
  planModelChange,
  applyModelChange,
  planCrushModelChange,
  applyCrushModelChange,
  rollbackModelChange,
  formatModelRecovery,
  formatShellCommand,
  captureShellSnapshot,
} from '../coder-models.js';

// ─── shared helpers ──────────────────────────────────────────────────────────

// Mirrors opencodeConfigPath in src/coder-models.js / src/commands/coder.js.
// Kept local so this command module doesn't reach into either file's private
// scope. The path resolution is part of the documented config contract.
function opencodeConfigPath(scope) {
  return scope === 'local'
    ? join(projectRoot(), 'opencode.json')
    : join(homedir(), '.config', 'opencode', 'opencode.json');
}

// Reads model / small_model + the deny-first bash gate out of an opencode.json
// without throwing. Returns { exists, model, small_model, denyFirstBash }.
// `denyFirstBash` is false when the file is missing/unreadable so the gate
// only ever BLOCKS on a present file that lacks the policy (parity with
// `coder init`'s auditExistingConfig).
function readOpencodeConfig(scope) {
  try {
    const obj = JSON.parse(readFileSync(opencodeConfigPath(scope), 'utf8'));
    return {
      exists: true,
      model: typeof obj.model === 'string' ? obj.model : undefined,
      small_model: typeof obj.small_model === 'string' ? obj.small_model : undefined,
      denyFirstBash: obj?.permission?.bash?.['*'] === 'deny',
    };
  } catch {
    return { exists: false, denyFirstBash: false };
  }
}

// Maps the service's internal availability token to the user-facing term from
// docs/glm-clients.md (available / unavailable / not verified). The service
// returns 'unknown' for a not-verified catalogue; users see "not verified".
function availabilityLabel(a) {
  if (a === 'available') return pc.green('available');
  if (a === 'unavailable') return pc.red('unavailable');
  if (a === 'unknown' || a === 'not-verified') return pc.yellow('not verified');
  return pc.dim('unset');
}

function compatibilityLabel(c) {
  if (c === 'compatible') return pc.green('compatible');
  if (c === 'incompatible') return pc.red('incompatible');
  return pc.dim('unset');
}

function severityColor(sev) {
  if (sev === 'error') return pc.red;
  if (sev === 'warn') return pc.yellow;
  return pc.dim;
}

// ─── `triss coder models` — read-only listing ────────────────────────────────

export async function runCoderModels(opts = {}) {
  // Capture the true parent shell exports BEFORE loadEnvFiles merges the .env
  // files. This allows inspectCoderModelState to distinguish between a real
  // shell export and a dotenv-loaded value, reporting the correct provenance
  // (source_path and scope) in the output.
  const shellSnapshot = captureShellSnapshot();

  loadEnvFiles();
  const engine = resolveCoderEngine(opts);

  // Crush model store (crush.json) is opaque to triss — use the same
  // inspectCoderModelState path that OpenCode uses, but with provider fixed to 'zai'
  // and no catalogue fetch. The service reads actual crush.json files and reports
  // real role values with distinct source/scope, never synthetic null.
  if (engine === 'crush') {
    const scope = opts.local ? 'local' : undefined;
    const state = await inspectCoderModelState({ engine: 'crush', provider: 'zai', scope, shellSnapshot }, {});
    if (opts.json) {
      process.stdout.write(JSON.stringify(state, null, 2) + '\n');
      return 0;
    }
    renderModelsHuman(state);
    return 0;
  }

  const intent = await resolveProviderIntent({ engine, provider: opts.provider });
  if (!intent.ok) {
    renderIntentDiagnostics(intent);
    process.exit(1);
  }

  // Live catalogue verification is the POINT of `coder models` — pass no
  // deps.fetch so the service uses globalThis.fetch (the real network). This
  // is the documented behaviour and the counterpart to `triss status`, which
  // never makes a network call.
  const state = await inspectCoderModelState(
    { engine, provider: intent.provider, shellSnapshot },
    {},
  );

  if (opts.json) {
    // Stable, additive-only JSON contract (docs/glm-clients.md §4). The
    // service already guarantees no credential value is serialized.
    process.stdout.write(JSON.stringify(state) + '\n');
    return;
  }
  renderModelsHuman(state);
}

// Builds the stable `coder models` state for the Crush engine. crush.json is
// opaque to triss (the live list lives behind `crush models use` and the
// engine's own credentials), so this NEVER fetches: the catalogue is
// "not-supported", the current roles are null with availability
// "not-verified" (never the ambiguous "unknown" token), and the recommended
// pair is the single canonical Z.AI coding-plan public pair Crush serves.
function renderIntentDiagnostics(intent) {
  process.stderr.write(pc.yellow('⚠ Could not resolve a single model provider.\n'));
  for (const d of intent.diagnostics || []) {
    const extra = d.providers ? ` (credentials set: ${d.providers.join(', ')})` : '';
    process.stderr.write(
      pc.dim(`  · ${d.code}${extra}${d.hint ? ` — ${d.hint}` : ''}\n`),
    );
  }
  process.stderr.write(
    pc.dim(
      '  Pass --provider <name> explicitly: zai, opencode-zen, moonshot, kimi-for-coding.\n',
    ),
  );
}

function renderModelsHuman(state) {
  const out = process.stdout;
  out.write(
    pc.bold(
      `── coder models (engine: ${state.engine}, provider: ${state.provider || '?'}) ──`,
    ) + '\n',
  );
  out.write(pc.dim(`scope: ${state.scope}\n\n`));

  const cur = state.current || {};
  const renderRole = (label, role) => {
    const r = cur[role] || {};
    const val = r.value ? pc.cyan(r.value) : pc.dim('(unset)');
    out.write(
      `${label}  ${val}  ${availabilityLabel(r.availability)} ${compatibilityLabel(r.compatibility)}\n`,
    );
    if (r.source_path) out.write(pc.dim(`    source: ${r.source_path}\n`));
  };

  // Engine-specific labels for unambiguous rendering.
  if (state.engine === 'crush') {
    renderRole('Crush large:    ', 'main');
    renderRole('Crush fast:     ', 'small');
  } else if (state.engine === 'opencode') {
    renderRole('Triss runtime main: ', 'main');
    renderRole('OpenCode config small: ', 'small');
  } else {
    // Fallback for unknown engines (should not occur in practice).
    renderRole('current main:  ', 'main');
    renderRole('current small: ', 'small');
  }

  // For OpenCode split state, show config_main separately.
  if (state.config_main) {
    const r = state.config_main;
    const val = r.value ? pc.cyan(r.value) : pc.dim('(unset)');
    out.write(
      `OpenCode config main:   ${val}  ${availabilityLabel(r.availability)} ${compatibilityLabel(r.compatibility)}\n`,
    );
    if (r.source_path) out.write(pc.dim(`    source: ${r.source_path}\n`));
  }

  out.write('\n');
  const cred = state.credential || {};
  out.write(
    `credential:     ${cred.env} ${cred.ready ? pc.green('ready') : pc.yellow('missing')}\n`,
  );
  out.write(`catalogue:      ${state.catalogue_status}\n`);

  const rec = state.recommended;
  if (rec) {
    out.write(`recommended:    main ${pc.cyan(rec.main)}  small ${pc.cyan(rec.small)}\n`);
  }

  const models = state.available_models || [];
  if (models.length) {
    out.write('\n' + pc.dim(`available models (${models.length}):`) + '\n');
    for (const m of models) out.write(`  ${m}\n`);
  }

  const warns = state.warnings || [];
  if (warns.length) {
    out.write('\n');
    for (const w of warns) {
      const where = w.role ? `${w.scope}:${w.role}` : w.scope;
      out.write(severityColor(w.severity)(`⚠ ${w.code} (${where})\n`));
    }
  }

  // One copy-paste recovery command per blocking warning (uses the service's
  // formatter so the CLI and the recovery path render identically).
  const recovery = formatModelRecovery(state, {});
  for (const cmd of recovery.commands) {
    out.write('\n' + pc.dim('recovery: ') + cmd + '\n');
  }
}

// ─── `triss coder model set` — persistent switch ─────────────────────────────

export async function runCoderModelSet(mainArg, opts = {}) {
  // Capture shell-exported model pins BEFORE loadEnvFiles merges the .env
  // files, so a higher-precedence shell export that would shadow what we are
  // about to write is detectable after the apply (mirrors runCoderInit's
  // inheritedModels capture). The on-disk cross-scope shadow (project env /
  // project opencode.json overriding a global request) is audited BEFORE
  // plan/apply below; this capture is for the shell-export path only.
  const inheritedModel = process.env.TRISS_CODER_MODEL;
  const inheritedSmall = process.env.TRISS_CODER_SMALL_MODEL;
  loadEnvFiles();

  // Engine + scope are NEVER guessed for a non-interactive persistent mutation
  // (docs/coder-model-management-plan.md §3). Scope is mandatory. Engine must
  // be EXPLICIT for `model set`: unlike the shared resolver (which would fall
  // back to the opencode default), this command refuses unless --engine or
  // TRISS_CODER_ENGINE is present, before any read/config mutation.
  if (opts.global && opts.local) {
    throw new Error('Pick one of --global or --local, not both.');
  }
  if (!opts.global && !opts.local) {
    renderScopeRequired(opts, mainArg);
    process.exit(1);
  }
  const scope = opts.local ? 'local' : 'global';

  // Engine-required gate: scope is now validated, but refuse BEFORE resolving
  // the engine / reading opencode.json / mutating anything. resolveCoderEngine
  // would otherwise default to opencode silently; a persistent mutation must
  // never pick its own target engine. Without an explicit engine on the CLI or
  // in the env, the on-disk config is left byte-identical.
  if (!opts.engine && !process.env.TRISS_CODER_ENGINE) {
    renderEngineRequired(opts, mainArg, scope);
    process.exit(1);
  }
  const engine = resolveCoderEngine(opts);

  // Crush persistent mutation: plan the spawn argv via the PURE service seam
  // (validates the exact canonical Z.AI coding-plan pair + scope), then apply
  // by spawning `crush models use` directly. This branch owns the WHOLE crush
  // flow and RETURNS here — it must NOT fall through into the OpenCode paths
  // below (resolveProviderIntent / readOpencodeConfig / planModelChange /
  // applyModelChange all assume opencode.json, which crush never touches).
  if (engine === 'crush') {
    // Crush engine only supports 'zai' provider (Z.AI GLM). Reject any other
    // provider BEFORE spawn/write to avoid spurious failures.
    if (opts.provider && opts.provider !== 'zai') {
      process.stderr.write(
        pc.red(
          `✗ Crush engine only supports the 'zai' provider (Z.AI GLM).\n` +
            `  Specified --provider ${opts.provider} is not compatible with --engine crush.\n` +
            `  Either use --engine opencode with --provider ${opts.provider}, or omit --provider to use zai.\n`,
        ),
      );
      process.exit(1);
    }

    if (!mainArg || !opts.small) {
      throw new Error(
        'For --engine crush, pass a main model positionally and --small <model>.\n' +
          '  Example: triss coder model set zai-coding-plan/glm-5.2 ' +
          '--small zai-coding-plan/glm-5-turbo --engine crush --global --yes',
      );
    }
    const plan = await planCrushModelChange({ main: mainArg, small: opts.small, scope });
    if (!plan.ok) {
      renderPlanDiagnostics(plan);
      process.exit(1);
    }
    if (!opts.yes) {
      process.stderr.write(pc.bold('── proposed crush model switch ──') + '\n');
      process.stderr.write(pc.dim(`  scope:   ${scope}\n`));
      process.stderr.write(`  main:    ${pc.cyan(mainArg)}\n`);
      process.stderr.write(`  small:   ${pc.cyan(opts.small)}\n`);
      process.stderr.write(
        pc.yellow('\n⚠ Proposed but not applied — re-run with --yes to spawn `crush models use`.\n'),
      );
      process.exit(1);
    }
    let result;
    try {
      result = await applyCrushModelChange(plan, {
        sh: (cmd, argv, opts) => spawnSync(cmd, argv, { encoding: 'utf8', shell: false, cwd: opts && opts.cwd }),
      });
    } catch (err) {
      process.stderr.write(pc.red(`${err.message}\n`));
      process.exit(1);
    }
    // Treat result.ok!==true as failure: render structured reason/error/lockPath/rollback
    // guidance and exit with result.exitCode or 1; never print green success/exit 0.
    if (!result || result.ok !== true) {
      const exitCode = (result && typeof result.exitCode === 'number') ? result.exitCode : 1;
      const reason = result && result.reason ? result.reason : 'unknown';
      const error = result && result.error ? result.error : null;
      const lockPath = result && result.lockPath ? result.lockPath : null;
      const rollbackCmd = result && result.rollbackCommand ? result.rollbackCommand : null;

      process.stderr.write(pc.red(`✗ Crush model change failed (${reason})\n`));
      if (error) {
        process.stderr.write(pc.dim(`  error: ${error}\n`));
      }
      if (lockPath) {
        process.stderr.write(pc.dim(`  lock path: ${lockPath}\n`));
        process.stderr.write(pc.dim(`  manual removal: rm ${lockPath}\n`));
      }
      if (rollbackCmd) {
        process.stderr.write(pc.dim(`  rollback: ${rollbackCmd}\n`));
      }
      process.exit(exitCode);
    }

    // Private intentional renderer for Crush success output, matching OpenCode style.
    function renderCrushApplySuccess(result, scope) {
      process.stderr.write(pc.green('✓ Switched persistent crush models.\n'));
      process.stderr.write(pc.dim(`  engine: crush\n`));
      process.stderr.write(pc.dim(`  provider: zai\n`));
      process.stderr.write(pc.dim(`  scope: ${scope}\n`));
      process.stderr.write(`  main: ${pc.cyan(mainArg)}\n`);
      process.stderr.write(`  small: ${pc.cyan(opts.small)}\n`);
      if (result?.transaction?.dir) {
        process.stderr.write(pc.dim(`  record: ${result.transaction.dir}\n`));
      }
      const rollbackCmd = result?.rollbackCommand || result?.rollback_command;
      if (rollbackCmd) {
        process.stderr.write(pc.dim(`  rollback: ${rollbackCmd}\n`));
      }
    }
    renderCrushApplySuccess(result, scope);
    return;
  }

  const main = mainArg;
  const small = opts.small;
  if (!main && !small) {
    throw new Error(
      'Specify a main model (positional) and/or --small <model>.\n' +
        '  Example: triss coder model set opencode/deepseek-v4-flash-free ' +
        '--small opencode/deepseek-v4-flash-free --engine opencode --global --yes',
    );
  }

  const intent = await resolveProviderIntent({
    engine,
    provider: opts.provider,
    main: mainArg,
    small: opts.small,
  });
  if (!intent.ok) {
    renderIntentDiagnostics(intent);
    process.exit(1);
  }

  // When only --small is given, keep the currently-configured main so a
  // small-only edit doesn't accidentally drop the main role. planModelChange
  // needs a concrete main to enforce the same-prefix rule.
  const existing = readOpencodeConfig(scope);
  const effectiveMain = main || existing.model;
  if (!effectiveMain) {
    throw new Error(
      'No main model given and none currently configured in opencode.json — ' +
        'pass a main model positionally (e.g. `triss coder model set opencode/<id> ...`).',
    );
  }
  const effectiveSmall = small || existing.small_model;
  if (!effectiveSmall) {
    throw new Error(
      'No --small model given and none currently configured in opencode.json — ' +
        'pass --small <model> (opencode reads small_model from this file at run time).',
    );
  }

  // Cross-scope shadow audit (global scope only). A project .triss.env
  // (TRISS_CODER_MODEL) and/or a project opencode.json (model / small_model)
  // have HIGHER precedence than the global config opencode resolves at run
  // time, so a --global set that either file shadows would be cosmetic at the
  // project root. Audit both BEFORE plan/apply so nothing is mutated while a
  // shadow is active (the plan is pure but makes a network round-trip; failing
  // fast here avoids it). The shell-export shadow is still caught post-apply by
  // warnIfShellShadow; this catches the on-disk project shadows. --local sets
  // and equal project values do NOT block.
  if (scope === 'global') {
    const shadows = auditCrossScopeShadow(effectiveMain, effectiveSmall);
    if (shadows) {
      renderCrossScopeShadow(shadows, effectiveMain, effectiveSmall, opts);
      process.exit(1);
    }
  }

  // PURE validation first: never reach the apply with an invalid plan. The
  // service rejects cross-provider pairs, Z.AI coding-plan/PAYG prefix
  // mismatches, a missing credential, an unauthenticated catalogue, and an
  // authoritative catalogue absence. allowUnverified narrows which
  // not-verified catalogue states may be bypassed (never auth, never absence).
  const plan = await planModelChange(
    {
      engine,
      scope,
      provider: intent.provider,
      main: effectiveMain,
      small: effectiveSmall,
      allowUnverified: opts.allowUnverified,
      // Forward the explicit opt-in so planModelChange's deny-first bash gate
      // (checkDenyFirstBash) can pass, making THIS module's own gate at the
      // warning step below reachable. The plan still PRESERVES the existing
      // policy verbatim — this flag only decides whether to PROCEED over a
      // non-canonical policy, never to install or rewrite one.
      allowUnsafeBash: opts.allowUnsafeBash,
      // Pass the shell-exported model pins captured BEFORE loadEnvFiles so the
      // service can distinguish true shell overrides from file values loaded
      // after capture (file values should never be treated as shell overrides).
      shellModelOverride: inheritedModel,
      shellSmallIntent: inheritedSmall,
    },
    {}, // globalThis.fetch — live catalogue verification
  );

  if (!plan.ok) {
    renderPlanDiagnostics(plan);
    process.exit(1);
  }

  // Deny-first bash policy gate (parity with `coder init`'s auditExistingConfig).
  // A present opencode.json without permission.bash["*"]="deny" is BLOCKING by
  // default; --allow-unsafe-bash is the explicit opt-in. applyModelChange
  // RETAINS the existing policy verbatim, so this gate only decides whether to
  // PROCEED, never whether to install a policy.
  if (existing.exists && !existing.denyFirstBash && !opts.allowUnsafeBash) {
    renderBashPolicyGap(scope, plan, opts);
    process.exit(1);
  }
  if (existing.exists && !existing.denyFirstBash && opts.allowUnsafeBash) {
    process.stderr.write(
      pc.yellow(
        '⚠ opencode.json has no deny-first bash policy (permission.bash["*"]="deny") — proceeding\n' +
          '  because --allow-unsafe-bash was passed. The coder agent runs with --auto and can run\n' +
          '  arbitrary shell commands. Add the deny-first policy when you can.\n',
      ),
    );
  }

  // Non-interactive gate: a persistent mutation requires --yes. Without it,
  // print the proposed change and exit non-zero WITHOUT writing (the plan is
  // pure, so nothing has been touched yet).
  if (!opts.yes) {
    renderPlanPreview(plan);
    process.stderr.write(
      pc.yellow('\n⚠ Proposed but not applied — re-run with --yes to write.\n'),
    );
    process.exit(1);
  }

  // Apply the transactional read-modify-write. applyModelChange now performs
  // the FULL transaction (plan §8–§12): collision-resistant record under
  // ~/.config/triss/backups/coder-model/<id>/, config bytes+mode backup,
  // pins-only env snapshot (never the API key / whole env), exclusive 0600
  // sibling temps for both opencode.json and the env file, atomic per-file
  // rename, rollback on any post-config/env failure, and a rollback command
  // the operator can use later. It exits 2 on write/validation failure (after
  // successful rollback) and 3 on rollback failure (retaining the protected
  // record + absolute manual restore paths).
  const result = await applyModelChange({ ...plan, confirmed: true }, {});
  if (!result.ok) {
    renderApplyFailure(result);
    process.exit(result.exitCode && typeof result.exitCode === 'number' ? result.exitCode : 1);
  }

  // The two Triss intent pins are persisted INSIDE applyModelChange's
  // transaction now (sibling-temp + 0600 + atomic rename), so there is no
  // second setVar pass here — that would both duplicate the write and bypass
  // the transactional guarantee. A fresh `triss coder run` reads
  // TRISS_CODER_MODEL (now staged atomically) for the main role; OpenCode
  // itself reads small_model from opencode.json (also staged atomically).
  // TRISS_CODER_SMALL_MODEL is management intent — kept in sync so the next
  // `triss coder init` is idempotent.

  // Shell-export shadow warning: a shell export beats every .env file, so if
  // TRISS_CODER_MODEL was exported to a different value the pin just written
  // is cosmetic and the next run still uses the shell value. Warn loudly
  // (parity with runCoderInit's warnIfPinShadowed). The on-disk cross-scope
  // (project-env / project-opencode.json) shadow audit already ran BEFORE
  // plan/apply above; this catches the shell-export path only.
  warnIfShellShadow(inheritedModel, inheritedSmall, result.model, result.small_model);

  renderApplySuccess(result, scope);
}

// ─── model set render helpers ────────────────────────────────────────────────

// Exported for TDD testing. Uses formatShellCommand so dynamic model ids and
// --small values are POSIX-quoted. Returns array of command strings (one per
// scope option) without changing stderr output.
export function renderScopeRequired(opts, mainArg) {
  process.stderr.write(
    pc.yellow(
      '⚠ A persistent model switch requires an explicit scope (--global or --local).\n',
    ) +
      pc.dim('  Engine and scope are never guessed for a non-interactive mutation.\n\n') +
      pc.bold('  Re-run with one of:\n'),
  );
  const head = ['triss', 'coder', 'model', 'set'];
  if (mainArg) head.push(mainArg);
  if (opts.small) head.push('--small', opts.small);
  const engine = opts.engine || process.env.TRISS_CODER_ENGINE || 'opencode';
  head.push('--engine', engine);
  if (opts.provider) head.push('--provider', opts.provider);
  const commands = [];
  for (const scopeFlag of ['--global', '--local']) {
    const argv = [...head, scopeFlag, '--yes'];
    const cmd = formatShellCommand(argv);
    process.stderr.write(pc.cyan('    ' + cmd + '\n'));
    commands.push(cmd);
  }
  process.stderr.write('\n');
  return commands;
}

// Engine-required gate renderer. Scope is already validated when this runs, so
// only the engine is left to choose. Offer BOTH supported engines verbatim so
// the operator can copy-paste either path; preserve mainArg / --small / the
// resolved scope / --yes (and --provider if given) so the rerun line is a
// complete, executable command. Mirrors renderScopeRequired's shape.
// Uses formatShellCommand so dynamic model ids and --small values are POSIX-quoted.
// Returns array of command strings (one per engine) without changing stderr output.
export function renderEngineRequired(opts, mainArg, scope) {
  process.stderr.write(
    pc.yellow(
      '⚠ Engine required: a persistent model switch needs --engine ' +
        '(or TRISS_CODER_ENGINE) — engine is never guessed for a non-interactive mutation.\n\n',
    ) + pc.bold('  Re-run with one of:\n'),
  );
  const scopeFlag = scope === 'local' ? '--local' : '--global';
  const commands = [];
  for (const engineName of ['opencode', 'crush']) {
    const argv = ['triss', 'coder', 'model', 'set'];
    if (mainArg) argv.push(mainArg);
    if (opts.small) argv.push('--small', opts.small);
    argv.push('--engine', engineName, scopeFlag);
    if (opts.provider) argv.push('--provider', opts.provider);
    argv.push('--yes');
    const cmd = formatShellCommand(argv);
    process.stderr.write(pc.cyan('    ' + cmd + '\n'));
    commands.push(cmd);
  }
  process.stderr.write('\n');
  return commands;
}

function renderPlanDiagnostics(plan) {
  process.stderr.write(
    pc.yellow('⚠ Refusing to switch — the proposed pair did not validate.\n'),
  );
  for (const d of plan.diagnostics || []) {
    const where = d.role ? `${d.scope}:${d.role}` : d.scope;
    const detail =
      d.value ? ` value="${d.value}"` : d.main ? ` main="${d.main}" small="${d.small}"` : '';
    process.stderr.write(
      pc.red(`  ✗ ${d.code} (${where})${detail}\n`),
    );
  }
  process.stderr.write(
    pc.dim(
      '  Catalogue status for this attempt: ' +
        (plan.catalogue?.status || 'unknown') +
        '.\n  Fix the flagged issue(s) and re-run; --allow-unverified only bypasses a\n' +
        '  not-verified catalogue (timeout/http-error/parse-error), never auth or an\n' +
        '  authoritative unavailable result.\n',
    ),
  );
}

// Deny-first bash policy gap renderer. The opencode.json exists but lacks
// permission.bash["*"]="deny". Prints the exact --allow-unsafe-bash command
// using formatShellCommand so dynamic model ids are POSIX-quoted.
// Returns the command string without changing stderr output.
export function renderBashPolicyGap(scope, plan, _opts) {
  process.stderr.write(
    pc.yellow(
      '⚠ Refusing to switch — opencode.json lacks the deny-first bash policy\n' +
        '  (permission.bash["*"]="deny"). The coder agent runs with --auto, so without it\n' +
        '  the agent can run arbitrary shell commands. applyModelChange retains the existing\n' +
        '  policy verbatim, so this gate only proceeds with the explicit opt-in.\n\n',
    ) +
      pc.bold('  Either:\n') +
      pc.dim('    • review/add a deny-first policy first (recommended), or\n') +
      pc.dim('    • re-run with --allow-unsafe-bash to proceed without it.\n\n'),
  );
  const argv = [
    'triss', 'coder', 'model', 'set',
    plan.main,
    '--small', plan.small,
    '--engine', plan.engine,
    '--provider', plan.provider,
    scope === 'local' ? '--local' : '--global',
    '--allow-unsafe-bash',
    '--yes',
  ];
  const cmd = formatShellCommand(argv);
  process.stderr.write(pc.cyan('    ' + cmd + '\n\n'));
  return cmd;
}

function renderPlanPreview(plan) {
  process.stderr.write(pc.bold('── proposed model switch ──') + '\n');
  process.stderr.write(pc.dim(`  engine:  ${plan.engine}\n`));
  process.stderr.write(pc.dim(`  provider: ${plan.provider}\n`));
  process.stderr.write(pc.dim(`  scope:   ${plan.scope}\n`));
  process.stderr.write(`  main:    ${pc.cyan(plan.main)}\n`);
  process.stderr.write(`  small:   ${pc.cyan(plan.small)}\n`);
  process.stderr.write(pc.dim(`  catalogue: ${plan.catalogue?.status || 'unknown'}\n`));
}

function renderApplyFailure(result) {
  const reason = result.reason || 'unknown';
  const exitCode = result.exitCode;
  if (exitCode === 3) {
    // Rollback FAILED — the protected transaction record is retained and the
    // operator must restore manually from the absolute backup paths. Lead
    // with the loudest possible banner: original files may currently be in
    // the post-write state (the rename committed before the rollback threw).
    process.stderr.write(
      pc.bgRed(pc.white(' ROLLBACK FAILED ')) +
        pc.red(' — original files may NOT be restored.\n'),
    );
    process.stderr.write(
      pc.red(`  cause: ${result.cause || result.error || 'unknown'}\n`),
    );
    if (result.error) {
      process.stderr.write(pc.dim(`  rollback error: ${result.error}\n`));
    }
    if (result.transaction && result.transaction.dir) {
      process.stderr.write(
        pc.dim(`  protected record: ${result.transaction.dir}\n`),
      );
    }
    const restorePaths = Array.isArray(result.restorePaths) ? result.restorePaths : [];
    if (restorePaths.length) {
      process.stderr.write(pc.yellow('  Manual restore paths (each still on disk):\n'));
      for (const p of restorePaths) process.stderr.write(pc.dim(`    · ${p}\n`));
    }
    if (result.rollbackCommand) {
      process.stderr.write(pc.yellow('  Manual restore command:\n'));
      process.stderr.write(pc.cyan(`    ${result.rollbackCommand}\n`));
    }
    return;
  }
  process.stderr.write(
    pc.red(`✗ Apply failed (${reason}) — rolled back; opencode.json is unchanged.\n`),
  );
  if (result.path) {
    process.stderr.write(pc.dim(`  target: ${result.path}\n`));
  }
  if (result.error) {
    process.stderr.write(pc.dim(`  error: ${result.error}\n`));
  }
  if (result.transaction && result.transaction.dir) {
    process.stderr.write(
      pc.dim(`  forensics: ${result.transaction.dir} (retained)\n`),
    );
  }
  if (result.rollbackCommand) {
    process.stderr.write(pc.dim(`  rollback: ${result.rollbackCommand}\n`));
  }
  if (reason === 'malformed-config') {
    process.stderr.write(
      pc.dim('  opencode.json is not valid JSON — left byte-identical; fix it and re-run.\n'),
    );
  } else if (reason === 'config-missing') {
    process.stderr.write(
      pc.dim(
        '  opencode.json does not exist — run `triss coder init` first, or create it.\n',
      ),
    );
  }
}

function renderApplySuccess(result, scope) {
  process.stderr.write(pc.green('✓ Switched persistent coder models.\n'));
  process.stderr.write(pc.dim(`  scope:        ${scope}\n`));
  process.stderr.write(`  main:         ${pc.cyan(result.model)}\n`);
  process.stderr.write(`  small:        ${pc.cyan(result.small_model)}\n`);
  process.stderr.write(pc.dim(`  opencode.json: ${result.path}\n`));
  if (result.envPath) {
    process.stderr.write(pc.dim(`  env pins:     ${result.envPath}\n`));
  }
  if (result.transaction && result.transaction.dir) {
    process.stderr.write(pc.dim(`  record:       ${result.transaction.dir}\n`));
  }
  if (result.rollbackCommand) {
    process.stderr.write(pc.dim(`  rollback:     ${result.rollbackCommand}\n`));
  }
  process.stderr.write(
    pc.dim(
      '  A fresh `triss coder run` resolves this pair (TRISS_CODER_MODEL + opencode.json.small_model).\n',
    ),
  );
}

// Writes TRISS_CODER_MODEL / TRISS_CODER_SMALL_MODEL into the .env of `scope`
// — handled INSIDE applyModelChange's transaction now (sibling-temp + 0600 +
// exclusive-open + atomic rename), so this command module no longer performs
// a second setVar pass. The previous Phase 4a helper is removed: it would
// both duplicate the write and bypass the transactional guarantee. The
// service owns the env-pin mutation; this module owns CLI affordances only.

// Shell-export shadow check (subset of runCoderInit's warnIfPinShadowed). A
// shell export beats every .env file, so a differing inherited value means the
// pin just written is cosmetic — warn loudly. The on-disk cross-scope audit
// (project .triss.env / project opencode.json overriding a global request) runs
// BEFORE plan/apply via auditCrossScopeShadow; this catches the shell-export
// trap, which cannot be detected from disk.
function warnIfShellShadow(inheritedModel, inheritedSmall, model, smallModel) {
  if (inheritedModel && inheritedModel !== model) {
    process.stderr.write(
      pc.yellow(
        `  ⚠ TRISS_CODER_MODEL=${inheritedModel} is exported in your shell — it overrides the\n` +
          `    ${model} just pinned in EVERY .env file, so the next run still uses the shell value.\n` +
          '    Run `unset TRISS_CODER_MODEL`, or export the pinned value.\n',
      ),
    );
  }
  // TRISS_CODER_SMALL_MODEL is management intent, not a runtime override (the
  // small role is read from opencode.json at run time). A differing shell
  // export does not shadow THIS run, but is a management-intent conflict that
  // the next `triss coder init` could restore — warn distinctly.
  if (inheritedSmall && inheritedSmall !== smallModel) {
    process.stderr.write(
      pc.yellow(
        `  ⚠ TRISS_CODER_SMALL_MODEL=${inheritedSmall} is exported in your shell — it does not\n` +
          '    shadow this run (small_model is read from opencode.json) but the next\n' +
          '    `triss coder init` could restore it. Run `unset TRISS_CODER_SMALL_MODEL`.\n',
      ),
    );
  }
}

// ─── cross-scope shadow audit (read-only, --global model set) ────────────────
//
// A project .triss.env (TRISS_CODER_MODEL) and/or a project opencode.json
// (model / small_model) have HIGHER precedence than the global config opencode
// resolves at run time. A `coder model set --global` that either file shadows
// would be cosmetic at the project root — exactly the silent footgun this gate
// prevents. It runs AFTER effective main/small are known but BEFORE plan/apply,
// so nothing is mutated while a shadow is active. The shell-export shadow is a
// separate concern, caught post-apply by warnIfShellShadow; this gate reads the
// project FILES directly (never confusing them with a shell export).
//
// Reuses projectRoot() (via getEnvFilePath('local') / opencodeConfigPath('local'))
// and readEnvFile. For project opencode.json, the file is read directly:
//   - Missing file is clean (no finding)
//   - Present but unreadable (permission denied) or JSON parse error or non-JSON
//     object produces a finding kind 'malformed-config' with path and safe detail
//     (the global switch is refused before any write)
//   - Valid JSON object keeps the existing differing model/small behavior
//
// Equal project values do NOT block (no shadow). --local sets skip the gate
// entirely (the operator is already writing where the shadow lives).

// Detects any project-scope file that would shadow a --global model set.
// Returns null when clean (files absent, or project values already equal the
// request), or a non-empty array of {kind:'env'|'config'|'malformed-config', path, detail}
// findings. No credential value is ever read into `detail` — only the model ids
// the operator already requested persistently.
function auditCrossScopeShadow(effectiveMain, effectiveSmall) {
  const findings = [];

  // 1. Project .triss.env — read TRISS_CODER_MODEL directly from the file (NOT
  //    a shell export). A differing value would win over the global pin at the
  //    project root, so the --global switch would be cosmetic HERE.
  const projectEnvPath = getEnvFilePath('local');
  const envMain = readEnvFile(projectEnvPath).vars.TRISS_CODER_MODEL;
  if (envMain && envMain !== effectiveMain) {
    findings.push({
      kind: 'env',
      path: projectEnvPath,
      detail: `TRISS_CODER_MODEL=${envMain}`,
    });
  }

  // 2. Project opencode.json — read the file directly. A missing file is clean
  //    (no finding). A present but unreadable file (permission denied), or a file
  //    with JSON parse errors, or a non-JSON object produces a finding kind
  //    'malformed-config' with path and safe detail (the global switch is refused
  //    before any write). For valid JSON objects, a differing model OR small_model
  //    means the project config shadows the requested pair.
  const projectConfigPath = opencodeConfigPath('local');
  try {
    const content = readFileSync(projectConfigPath, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Valid JSON object — check for differing model/small_model
      const modelDiffers =
        typeof parsed.model === 'string' && parsed.model !== effectiveMain;
      const smallDiffers =
        typeof parsed.small_model === 'string' && parsed.small_model !== effectiveSmall;
      if (modelDiffers || smallDiffers) {
        const parts = [];
        if (modelDiffers) parts.push(`model=${parsed.model}`);
        if (smallDiffers) parts.push(`small_model=${parsed.small_model}`);
        findings.push({
          kind: 'config',
          path: projectConfigPath,
          detail: parts.join(' '),
        });
      }
    } else {
      // File exists but is not a valid JSON object (e.g., array, primitive, null)
      findings.push({
        kind: 'malformed-config',
        path: projectConfigPath,
        detail: 'not a valid JSON object',
      });
    }
  } catch (err) {
    // Check if the file exists at all
    if (err.code === 'ENOENT') {
      // Missing file is clean (no finding)
    } else if (err.code === 'EACCES' || err.code === 'EISDIR') {
      // Unreadable file or directory — report as malformed
      findings.push({
        kind: 'malformed-config',
        path: projectConfigPath,
        detail: `unreadable (${err.code})`,
      });
    } else if (err instanceof SyntaxError) {
      // JSON parse error — report as malformed
      const firstLine = err.message.split('\n')[0];
      findings.push({
        kind: 'malformed-config',
        path: projectConfigPath,
        detail: `invalid JSON: ${firstLine}`,
      });
    } else {
      // Any other error — report as malformed with error type
      findings.push({
        kind: 'malformed-config',
        path: projectConfigPath,
        detail: `error: ${err.name}`,
      });
    }
  }

  return findings.length > 0 ? findings : null;
}

// Renders the cross-scope shadow findings plus the exact, copy-paste
// remediation, then the caller exits nonzero. Each finding names the PROJECT
// context, the higher-precedence file (.triss.env or opencode.json), and why it
// wins. The remediation offers the exact --local model-set command (scoped to
// the project so the write lands where it takes effect) and, for an env shadow,
// the exact unset command to clear the shadowing pin. For malformed-config,
// provides guidance to fix or move the file aside without suggesting any
// command that would rewrite malformed JSON. No credential values are ever emitted.
function renderCrossScopeShadow(shadows, effectiveMain, effectiveSmall, opts) {
  const localCmd = buildLocalModelSetCommand(effectiveMain, effectiveSmall, opts);
  for (const s of shadows) {
    if (s.kind === 'env') {
      process.stderr.write(
        pc.yellow(
          '⚠ Refusing to switch — a project .triss.env has higher precedence than the global config.\n',
        ) +
          pc.dim(
            `    ${s.path} pins ${s.detail}, which shadows the requested main ` +
              `"${effectiveMain}" at the project root (project scope has higher precedence ` +
              `than global), so the --global switch would be cosmetic HERE.\n\n`,
          ) +
          pc.bold('  Either re-run scoped to the project, or clear the shadowing pin:\n'),
      );
      process.stderr.write(pc.cyan(`    ${localCmd}\n`));
      process.stderr.write(pc.dim('  or clear the shadowing project pin:\n'));
      process.stderr.write(pc.cyan('    triss config unset TRISS_CODER_MODEL --local\n\n'));
    } else if (s.kind === 'config') {
      process.stderr.write(
        pc.yellow(
          '⚠ Refusing to switch — a project opencode.json has higher precedence than the global config.\n',
        ) +
          pc.dim(
            `    ${s.path} pins ${s.detail}, which shadows the requested pair ` +
              `(main "${effectiveMain}", small "${effectiveSmall}") at the project root ` +
              `(project scope has higher precedence than global), so the --global switch ` +
              `would be cosmetic HERE.\n\n`,
          ) +
          pc.bold('  Re-run scoped to the project:\n'),
      );
      process.stderr.write(pc.cyan(`    ${localCmd}\n\n`));
    } else if (s.kind === 'malformed-config') {
      const mvCmd = buildMalformedConfigMoveCommand(s.path);
      process.stderr.write(
        pc.yellow(
          '⚠ Refusing to switch — a project opencode.json is invalid or malformed.\n',
        ) +
          pc.dim(
            `    ${s.path} is ${s.detail}. Project scope has higher precedence than global,\n` +
              `    so the global switch is refused before any write. The malformed file must be\n` +
              `    fixed or removed. A safe alternative is to move it aside.\n\n`,
          ) +
          pc.bold('  Either fix the file, or use the safe alternative (move it aside):\n'),
      );
      process.stderr.write(pc.cyan(`    ${mvCmd}\n`));
      process.stderr.write(pc.dim('  Then re-run the --global set command.\n\n'));
    }
  }
}

// Builds the exact `triss coder model set ... --engine <engine> --local --yes`
// command scoped to the project, mirroring the original request's main/small/
// engine/provider/--allow-unverified so the operator can copy-paste a runnable
// fix. The scope flips to --local (the whole point of the remediation); --yes
// Exported for TDD testing. Uses formatShellCommand so dynamic model ids and
// --small values are POSIX-quoted and parse back as exactly one argv item under
// /bin/sh, even when values contain spaces, apostrophes, semicolons, $(), or newlines.
export function buildLocalModelSetCommand(effectiveMain, effectiveSmall, opts) {
  const argv = ['triss', 'coder', 'model', 'set'];
  if (effectiveMain) argv.push(effectiveMain);
  if (effectiveSmall) argv.push('--small', effectiveSmall);
  const engine = opts.engine || process.env.TRISS_CODER_ENGINE || 'opencode';
  argv.push('--engine', engine);
  if (opts.provider) argv.push('--provider', opts.provider);
  argv.push('--local');
  if (opts.allowUnverified) argv.push('--allow-unverified');
  argv.push('--yes');
  return formatShellCommand(argv);
}

// Builds a safe `mv path path.backup` command using formatShellCommand so the
// path is POSIX-quoted. Used in renderCrossScopeShadow for the malformed-config
// branch. The path may contain shell-hostile characters (space, apostrophe,
// semicolon, $(), backtick, tab, newline) — formatShellCommand ensures it parses
// as exactly one argv element under /bin/sh without command execution.
export function buildMalformedConfigMoveCommand(path) {
  const argv = ['mv', path, `${path}.backup`];
  return formatShellCommand(argv);
}

// ─── `triss coder model rollback` — restore retained transaction record ─────

export async function runCoderModelRollback(from, opts = {}) {
  // Scope is mandatory and mutually exclusive — exactly one of --global or
  // --local must be provided. This guard mirrors runCoderModelSet's scope
  // enforcement and ensures the operator explicitly chooses the target scope.
  if (opts.global && opts.local) {
    throw new Error('Pick one of --global or --local, not both.');
  }
  if (!opts.global && !opts.local) {
    throw new Error(
      'A rollback requires an explicit scope (--global or --local).\n' +
        '  Re-run with either --global or --local.'
    );
  }
  const scope = opts.local ? 'local' : 'global';

  // Delegates to the pure rollbackModelChange service. It validates the
  // record directory, manifest, and backup integrity, then restores the
  // pre-change bytes+mode via sibling temps + atomic renames. All validation
  // errors propagate; the CLI only adds the scope gate and success rendering.
  const result = await rollbackModelChange({ from, scope });

  // Success: print green success message to stderr with engine, scope, the
  // retained recordPath, and every absolute restored path. The record is
  // retained for evidence and may be re-run.
  process.stderr.write(pc.green('✓ Rolled back coder model change.\n'));
  process.stderr.write(pc.dim(`  engine:        ${result.engine}\n`));
  process.stderr.write(pc.dim(`  scope:         ${scope}\n`));
  process.stderr.write(pc.dim(`  record:        ${result.recordPath}\n`));
  for (const p of result.restoredPaths) {
    process.stderr.write(pc.dim(`  restored path: ${p}\n`));
  }
}

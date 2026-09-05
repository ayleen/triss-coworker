// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import pc from 'picocolors';
import { readProviderConfigSnapshot } from '../provider-config.js';
import { listProviderDefinitions } from '../provider-registry.js';
import { loadIntegrations, envReadiness } from '../integrations/_registry.js';
import { activeEnvFiles, readEnvFile, maskValue } from '../secrets.js';
import { projectRoot, pathsRestricted } from '../safety.js';
import { CODER_MANIFEST, describeCoderStatus } from './coder.js';
import { CODER_PROVIDER_CREDENTIALS, resolveCoderRuntimeProviderRoute } from '../coder-providers.js';
import { inspectMigration } from '../migration/migrate.js';

export async function runStatus(deps = {}) {
  const snapshot = readProviderConfigSnapshot();
  const providers = listProviderDefinitions();
  const integrations = await loadIntegrations();
  const allManifests = [CODER_MANIFEST, ...integrations];
  const providerCredentials = Object.fromEntries(
    providers.map((definition) => [
      definition.credential,
      snapshot.providers[definition.id].credential?.value || '',
    ]),
  );
  const coderReady = CODER_PROVIDER_CREDENTIALS.some(
    (provider) => Boolean(providerCredentials[provider.env]),
  );
  const root = projectRoot();
  const rootSource = process.env.TRISS_PROJECT_ROOT
    ? pc.dim('[TRISS_PROJECT_ROOT]')
    : pc.dim('[cwd]');

  // Map var name → scope where it was found (project wins).
  const varSource = new Map();
  for (const f of activeEnvFiles()) {
    if (!f.exists) continue;
    const vars = readEnvFile(f.path).vars;
    for (const k of Object.keys(vars)) {
      if (!varSource.has(k)) varSource.set(k, f.scope);
    }
  }

  const lines = [
    pc.bold('Triss Coworker — status'),
    '',
    `  Default provider: ${pc.cyan(snapshot.defaultProvider.value)}`,
    `  Default engine  : ${pc.cyan(snapshot.defaultEngine.value)}`,
    `  Project root    : ${root} ${rootSource}`,
    `  Path sandbox    : ${pathsRestricted() ? pc.green('on') : pc.dim('off (CLI mode)')}`,
    '',
    pc.bold('Provider profiles'),
  ];
  for (const definition of providers) {
    const profile = snapshot.providers[definition.id];
    const credential = profile.credential?.value ? pc.green('ready') : pc.red('missing');
    const selected = definition.id === snapshot.defaultProvider.value ? pc.green(' (default)') : '';
    lines.push(`  ${definition.id}${selected}`);
    lines.push(`     credential : ${credential}`);
    lines.push(`     endpoint   : ${profile.endpoint?.value || pc.dim('(engine-managed)')}`);
    lines.push(`     model      : ${profile.model?.value || pc.dim('(unset)')}`);
    lines.push(`     smallModel : ${profile.smallModel?.value || pc.dim('(unset)')}`);
    lines.push(`     transport  : ${profile.transport?.value || definition.transport}`);
  }

  lines.push('');
  lines.push(pc.bold('Env files'));
  for (const f of activeEnvFiles()) {
    const tag = f.exists ? pc.green('exists') : pc.dim('(missing)');
    lines.push(`  ${f.scope.padEnd(8)} ${tag}  ${f.path}`);
  }
  const migration = inspectMigration();
  const migrationTag = migration.state === 'required'
    ? pc.yellow('required — run `triss migrate`')
    : migration.state === 'blocked'
      ? pc.red(`blocked — ${migration.message}`)
      : pc.green('schema 2 ready');
  lines.push(`  migration ${migrationTag}`);

  lines.push('');
  lines.push(pc.bold('Credentials & integrations'));
  for (const m of allManifests) {
    const r = envReadiness(m);
    let tag;
    if (m.name === 'coder') {
      // The coder manifest's own envVars grammar can only mark one set of
      // keys required, so it under-reports readiness: any ONE of the five
      // coder providers is enough to run `triss coder`. Resolve the tag from
      // shared provider metadata instead, and when nothing is set, name all five
      // (provider-aware) rather than only ZHIPU_API_KEY.
      const anyProviderSet = coderReady;
      tag = anyProviderSet
        ? pc.green('✓ ready')
        : pc.yellow(`⚠ missing ${CODER_PROVIDER_CREDENTIALS.map((p) => p.env).join(', ')}`);
    } else {
      tag = r.ready
        ? pc.green('✓ ready')
        : pc.yellow(`⚠ missing ${r.missing.join(', ')}`);
    }
    // The `coder` manifest remains the config-wizard target; its Z.AI and
    // Moonshot credentials also enable one-shot GLM/Kimi ask/review calls
    // (spelled out in the routing blocks above), so the row is just "coder".
    lines.push(`  ${m.name.padEnd(10)} ${tag}`);
    for (const e of m.envVars || []) {
      const present = providerCredentials[e.name] || process.env[e.name];
      const source = varSource.get(e.name);
      const sourceTag = source ? pc.dim(`[${source}]`) : present ? pc.dim('[env]') : pc.dim('[—]');
      const marker = present ? pc.green('●') : e.required ? pc.red('○') : pc.dim('○');
      const value = present ? maskValue(present) : pc.dim('(unset)');
      lines.push(`     ${marker} ${e.name.padEnd(28)} ${value} ${sourceTag}`);
    }
  }

  // Explicit per-provider coder readiness — one line each, no key values.
  // Complements the manifest row (which folds all providers into one tag)
  // and the per-envVar rows (which only exist for keys the manifest lists).
  // Lets a user see at a glance which of the five upstreams are wired.
  lines.push('');
  lines.push(pc.bold('Coder providers') + pc.dim('  (any one enables `triss coder`)'));
  for (const p of CODER_PROVIDER_CREDENTIALS) {
    const present = providerCredentials[p.env] || process.env[p.env];
    const tag = present ? pc.green('ready') : pc.red('missing');
    lines.push(`  ${p.label.padEnd(16)} ${p.env.padEnd(20)} ${tag}`);
  }

  // Richer engine-level view for coder — the manifest row above already
  // covers ZHIPU_API_KEY / OPENCODE_API_KEY (value + source), so this block
  // sticks to what that generic grammar can't express: engine
  // binaries/versions, which config files exist, and how many isolation
  // worktrees are live. Gated on coderCredentialReady() (ZHIPU_API_KEY OR
  // OPENCODE_API_KEY) so a zen-only user still sees engine state — but a user
  // who hasn't configured coder at all shouldn't have every `triss status`
  // call silently fork `opencode`/`crush`/`git` on their behalf.
  if (coderReady) {
    lines.push('');
    // Header dropped the "(opencode engine)" qualifier now that crush is a
    // second engine — the per-engine lines below identify each, and a
    // "default engine" line says what a bare `triss coder run` resolves to.
    lines.push(pc.bold('Coder'));
    const coder = describeCoderStatus(deps);
    lines.push(`  default engine                ${pc.cyan(coder.defaultEngine)}`);
    if (coder.coderEngine) {
      lines.push(`  coding engine                 ${pc.cyan(coder.coderEngine)}${coder.coderProvider ? ` (provider ${pc.cyan(coder.coderProvider)})` : ''}`);
    } else if (coder.coderProvider) {
      lines.push(`  coding provider               ${pc.cyan(coder.coderProvider)} (engine inherits ${coder.defaultEngine})`);
    }
    // Credential mode comes from describeCoderStatus, which resolves it via
    // the same single resolver as runCoderRun — this file never re-implements
    // the engine x flag matrix.
    const credMode = coder.defaultCredentialMode;
    lines.push(`  default credential mode       ${pc.cyan(credMode)}`);
    lines.push(
      credMode === 'best_effort_raw'
        ? '  protected credential mode     pass --protect-credentials'
        : '  protected credential mode     default on (crush); --no-protect-credentials for raw',
    );
    // Shared provider roles used by an unqualified coder run.
    lines.push(`  default model (opencode)      ${pc.cyan(coder.defaultModel)}`);
    const defaultRoute = resolveCoderRuntimeProviderRoute(coder.defaultModel);
    lines.push(
      `  canonical provider route      ${defaultRoute
        ? pc.cyan(`${defaultRoute.provider} → ${defaultRoute.endpoint}${defaultRoute.pathPrefix}`)
        : pc.yellow('unrecognized model prefix')}`,
    );
    // opencode (engine #1) — version-checked through the ONE shared policy
    // resolver (describeCoderStatus). A below-floor or malformed
    // TRISS_CODER_OPENCODE_VERSION is INVALID CONFIGURATION: shown explicitly,
    // with the effective floor, never rendered as meeting the minimum.
    const ocMarker = coder.engineVersion !== null ? pc.green('●') : pc.dim('○');
    const ocInvalid = coder.configValid === false
      ? pc.yellow(
        `(invalid configured minimum: ${coder.configuredMinimum}; effective floor: ${coder.effectiveMinimum})`,
      )
      : null;
    const ocLabel =
      ocInvalid ??
      (coder.engineVersion !== null
        ? coder.engineVersion === ''
          ? `(version unknown) (minimum: ${coder.minimumVersion})`
          : coder.meetsMinimum
            ? `${coder.engineVersion} (meets minimum)`
            : pc.yellow(`${coder.engineVersion} (minimum: ${coder.minimumVersion})`)
        : pc.dim(`not installed (minimum: ${coder.minimumVersion})`));
    lines.push(`  ${ocMarker} opencode                      ${ocLabel}`);
    for (const c of coder.configs) {
      const marker = c.exists ? pc.green('●') : pc.dim('○');
      const value = c.exists ? c.path : pc.dim('(not written)');
      lines.push(`  ${marker} opencode.json [${c.scope}]        ${value}`);
    }
    // crush (engine #2) — policy state comes from the shared resolver (same
    // source runCoderRun asserts against). A compatible build is green; an
    // incompatible one is yellow against the EFFECTIVE minimum; a malformed
    // TRISS_CODER_CRUSH_VERSION is shown as invalid configuration. crush.json
    // presence is a best-effort file check. Never hard-fails — opencode-only
    // users see a clean ○ "not installed" line.
    const crushMarker = coder.crush.found ? pc.green('●') : pc.dim('○');
    const crushInvalid = coder.crush.configValid === false
      ? pc.yellow(
        `(invalid configured minimum: ${coder.crush.configuredMinimum}; effective floor: ${coder.crush.effectiveMinimum})`,
      )
      : null;
    const crushLabel = crushInvalid ??
      (coder.crush.found
        ? (coder.crush.meetsMinimum ?? coder.crush.satisfiesPin)
          ? `${coder.crush.version} ${pc.dim('(meets minimum)')}`
          : pc.yellow(`${coder.crush.version || '(version unknown)'} (minimum: ${coder.crush.minimumVersion})`)
        : pc.dim(`not installed (minimum: ${coder.crush.minimumVersion})`));
    lines.push(`  ${crushMarker} crush                        ${crushLabel}`);
    for (const c of coder.crush.configs) {
      const marker = c.exists ? pc.green('●') : pc.dim('○');
      const value = c.exists ? c.path : pc.dim('(not written)');
      lines.push(`  ${marker} crush.json [${c.scope}]           ${value}`);
    }
    // opencode2 (engine #3) — minimum-version plus --version/run --help
    // capability check. The probes are read-only and never start the V2
    // service. Config rows are shared
    // with opencode (the V1-compatible opencode.json) — labelled above.
    const oc2 = coder.opencode2;
    if (oc2) {
      const oc2Marker = oc2.satisfiesPin
        ? pc.green('●')
        : oc2.found
          ? pc.yellow('●')
          : pc.dim('○');
      const oc2Label = oc2.found
        ? oc2.satisfiesPin
          ? `${oc2.version} ${pc.dim(oc2.serviceProcessCheck === 'unavailable'
            ? '(compatible; service snapshot unavailable — best effort)'
            : '(compatible)')}`
          : pc.yellow(
            oc2.missingCapabilities?.length
              ? `${oc2.version || '(version unknown)'} (incompatible CLI; missing ${oc2.missingCapabilities.join(', ')})`
              : `${oc2.version || '(version unknown)'} (minimum: ${oc2.pin})`,
          )
        : pc.dim(`not installed (minimum: ${oc2.pin})`);
      lines.push(`  ${oc2Marker} opencode2                    ${oc2Label}`);
    }
    // omp (engine #4) — binary + capability probe under isolated PI_CODING_AGENT_DIR
    const omp = coder.omp;
    if (omp) {
      const ompMarker = omp.compatible
        ? pc.green('●')
        : omp.found
          ? pc.yellow('●')
          : pc.dim('○');
      let ompLabel;
      if (omp.configValid === false) {
        ompLabel = pc.yellow(
          `(invalid configured minimum: ${omp.configuredMinimum}; effective floor: ${omp.effectiveMinimum})`,
        );
      } else if (omp.compatible) {
        ompLabel = `${omp.version} ${pc.dim('(meets minimum)')}`;
      } else if (omp.reason === 'missing') {
        ompLabel = pc.dim(`not installed (minimum: ${omp.minimumVersion})`);
      } else if (omp.reason === 'version_unknown') {
        ompLabel = pc.yellow(
          `${omp.version || '(version unknown)'} (minimum: ${omp.minimumVersion}) — version unknown`,
        );
      } else if (omp.reason === 'unsupported-cli-contract') {
        ompLabel = pc.yellow(
          `${omp.version || '(version unknown)'} (minimum: ${omp.minimumVersion}) — unsupported CLI contract`,
        );
      } else {
        ompLabel = pc.yellow(
          `${omp.version || '(version unknown)'} (minimum: ${omp.minimumVersion}) — ${omp.reason}`,
        );
      }
      lines.push(`  ${ompMarker} omp                            ${ompLabel}`);
      if (omp.capabilities?.missing?.length) {
        lines.push(pc.dim(`    capabilities missing: ${omp.capabilities.missing.join(', ')}`));
      }
    }
    const wtMarker = coder.worktreeCount > 0 ? pc.green('●') : pc.dim('○');
    lines.push(`  ${wtMarker} worktrees (.triss/wt)       ${coder.worktreeCount} live`);
  }

  const defaultProfile = snapshot.providers[snapshot.defaultProvider.value];
  if (!defaultProfile.credential.value || allManifests.some((m) => !envReadiness(m).ready)) {
    lines.push('');
    lines.push(pc.dim('Tip: run ') + pc.cyan('triss config wizard') + pc.dim(' for an interactive setup.'));
  }

  process.stdout.write(lines.join('\n') + '\n');
}

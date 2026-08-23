import pc from 'picocolors';
import { getConfig } from '../config.js';
import { listPresets, describeGlmRouting, describeKimiRouting } from '../models.js';
import { loadIntegrations, envReadiness, getCoreManifest } from '../integrations/_registry.js';
import { activeEnvFiles, readEnvFile, maskValue } from '../secrets.js';
import { projectRoot, pathsRestricted } from '../safety.js';
import { CODER_MANIFEST, describeCoderStatus } from './coder.js';
import { CODER_PROVIDER_CREDENTIALS, coderCredentialReady, resolveCoderRuntimeProviderRoute } from '../coder-providers.js';

export async function runStatus(deps = {}) {
  const cfg = getConfig();
  const presets = listPresets();
  const integrations = await loadIntegrations();
  const allManifests = [getCoreManifest(), CODER_MANIFEST, ...integrations];
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
    `  API base    : ${cfg.baseUrl}`,
    `  API key     : ${cfg.apiKey ? maskValue(cfg.apiKey) : pc.red('(missing)')}`,
    `  Default     : ${cfg.defaultPreset}`,
    `  Project root: ${root} ${rootSource}`,
    `  Path sandbox: ${pathsRestricted() ? pc.green('on') : pc.dim('off (CLI mode)')}`,
    '',
    pc.bold('Model presets') + pc.dim('  (worker — the default provider)'),
  ];
  for (const p of presets) {
    const tag = p.isDefault ? pc.green(' (default)') : '';
    lines.push(`  ${p.preset.padEnd(6)} → ${p.model}${tag}`);
  }

  // Presets resolve differently per provider, and a GLM-only user has no
  // worker key at all — so where `--provider glm` actually lands gets its own
  // block rather than being implied by the worker rows above.
  const glm = describeGlmRouting();
  lines.push('');
  lines.push(pc.bold('GLM routing') + pc.dim('  (--provider glm)'));
  lines.push(
    `  key         : ${glm.keyConfigured ? pc.green('ZHIPU_API_KEY set') : pc.red('ZHIPU_API_KEY missing')}`,
  );
  lines.push(`  endpoint    : ${glm.baseUrl} ${pc.dim(`[${glm.endpoint}]`)}`);
  lines.push(
    glm.endpointSource === 'config'
      ? `  selected by : ${pc.dim(`TRISS_CODER_MODEL=${glm.coderModel}`)}`
      : `  selected by : ${pc.dim('default — a rejected call retries the other endpoint once')}`,
  );
  for (const p of glm.presets) {
    lines.push(`  ${p.preset.padEnd(12)}→ ${p.model}`);
  }

  // Kimi mirrors the GLM block: one endpoint, so the only routing fact worth
  // showing besides the key is whether TRISS_KIMI_BASE_URL overrides it — and
  // from WHERE. A project .triss.env can redirect the endpoint (and thus where
  // MOONSHOT_API_KEY is sent), so name the file scope like the credential rows
  // do rather than hiding the override behind a bare env-var name.
  const kimi = describeKimiRouting();
  const kimiUrlScope = varSource.get('TRISS_KIMI_BASE_URL') || 'env';
  lines.push('');
  lines.push(pc.bold('Kimi routing') + pc.dim('  (--provider kimi)'));
  lines.push(
    `  key         : ${kimi.keyConfigured ? pc.green('MOONSHOT_API_KEY set') : pc.red('MOONSHOT_API_KEY missing')}`,
  );
  lines.push(
    `  endpoint    : ${kimi.baseUrl} ${pc.dim(
      kimi.baseUrlSource === 'config' ? `[TRISS_KIMI_BASE_URL · ${kimiUrlScope}]` : '[default]',
    )}`,
  );
  for (const p of kimi.presets) {
    lines.push(`  ${p.preset.padEnd(12)}→ ${p.model}`);
  }

  lines.push('');
  lines.push(pc.bold('Env files'));
  for (const f of activeEnvFiles()) {
    const tag = f.exists ? pc.green('exists') : pc.dim('(missing)');
    lines.push(`  ${f.scope.padEnd(8)} ${tag}  ${f.path}`);
  }

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
      const anyProviderSet = coderCredentialReady();
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
      const present = process.env[e.name];
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
    const present = process.env[p.env];
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
  if (coderCredentialReady()) {
    lines.push('');
    // Header dropped the "(opencode engine)" qualifier now that crush is a
    // second engine — the per-engine lines below identify each, and a
    // "default engine" line says what a bare `triss coder run` resolves to.
    lines.push(pc.bold('Coder'));
    const coder = describeCoderStatus(deps);
    lines.push(`  default engine                ${pc.cyan(coder.defaultEngine)}`);
    // Credential mode contract (docs/plans/2025-protect-credentials-default.md):
    // best_effort_raw is the OpenCode/OpenCode2 default; protected_proxy needs
    // the explicit flag. crush is always protected.
    lines.push('  default credential mode       best_effort_raw');
    lines.push('  protected credential mode     pass --protect-credentials (crush: always on)');
    // The model a bare opencode-engine run uses (from TRISS_CODER_MODEL). crush
    // ignores it and runs its own GLM atoms, so label it as opencode-scoped.
    lines.push(`  default model (opencode)      ${pc.cyan(coder.defaultModel)}`);
    const defaultRoute = resolveCoderRuntimeProviderRoute(coder.defaultModel);
    lines.push(
      `  canonical provider route      ${defaultRoute
        ? pc.cyan(`${defaultRoute.provider} → ${defaultRoute.endpoint}${defaultRoute.pathPrefix}`)
        : pc.yellow('unrecognized model prefix')}`,
    );
    // opencode (engine #1) — version-checked against the pin.
    const ocMarker = coder.engineVersion !== null ? pc.green('●') : pc.dim('○');
    const ocLabel =
      coder.engineVersion !== null
        ? coder.engineVersion === ''
          ? `(version unknown) (pin: ${coder.pin})`
          : coder.engineVersion === coder.pin
            ? `${coder.engineVersion} (matches pin)`
            : pc.yellow(`${coder.engineVersion} (pin: ${coder.pin})`)
        : pc.dim(`not installed (pin: ${coder.pin})`);
    lines.push(`  ${ocMarker} opencode                      ${ocLabel}`);
    for (const c of coder.configs) {
      const marker = c.exists ? pc.green('●') : pc.dim('○');
      const value = c.exists ? c.path : pc.dim('(not written)');
      lines.push(`  ${marker} opencode.json [${c.scope}]        ${value}`);
    }
    // crush (engine #2) — version-checked against the pin (crush ≥0.1.3
    // reports a clean semver, parsed by detect()). A below-pin build is shown
    // yellow like opencode; a missing/garbage version falls back to a dim
    // "(version unknown)" note. crush.json presence is a best-effort file
    // check. Never hard-fails — opencode-only users see a clean ○ "not
    // installed" line.
    const crushMarker = coder.crush.found ? pc.green('●') : pc.dim('○');
    const crushLabel = coder.crush.found
      ? coder.crush.satisfiesPin
        ? `${coder.crush.version} ${pc.dim('(matches pin)')}`
        : pc.yellow(`${coder.crush.version || '(version unknown)'} (pin: ${coder.crush.pin})`)
      : pc.dim(`not installed (pin: ${coder.crush.pin})`);
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
      const oc2Marker = oc2.found ? pc.green('●') : pc.dim('○');
      const oc2Label = oc2.found
        ? (oc2.satisfiesMinimum ?? oc2.satisfiesPin)
          ? `${oc2.version} ${pc.dim(oc2.serviceProcessCheck === 'unavailable'
            ? '(compatible; service snapshot unavailable — best effort)'
            : '(compatible)')}`
          : pc.yellow(`${oc2.version || '(version unknown)'} (minimum: ${oc2.pin})`)
        : pc.dim(`not installed (minimum: ${oc2.pin})`);
      lines.push(`  ${oc2Marker} opencode2                    ${oc2Label}`);
    }
    const wtMarker = coder.worktreeCount > 0 ? pc.green('●') : pc.dim('○');
    lines.push(`  ${wtMarker} worktrees (.triss/wt)       ${coder.worktreeCount} live`);
  }

  if (!cfg.apiKey || allManifests.some((m) => !envReadiness(m).ready)) {
    lines.push('');
    lines.push(pc.dim('Tip: run ') + pc.cyan('triss config wizard') + pc.dim(' for an interactive setup.'));
  }

  process.stdout.write(lines.join('\n') + '\n');
}

import pc from 'picocolors';
import { getConfig } from '../config.js';
import { listPresets } from '../models.js';
import { loadIntegrations, envReadiness, getCoreManifest } from '../integrations/_registry.js';
import { activeEnvFiles, readEnvFile, maskValue } from '../secrets.js';
import { projectRoot, pathsRestricted } from '../safety.js';
import { CODER_MANIFEST, describeCoderStatus, coderCredentialReady } from './coder.js';

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
    pc.bold('Model presets'),
  ];
  for (const p of presets) {
    const tag = p.isDefault ? pc.green(' (default)') : '';
    lines.push(`  ${p.preset.padEnd(6)} → ${p.model}${tag}`);
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
    const tag = r.ready
      ? pc.green('✓ ready')
      : pc.yellow(`⚠ missing ${r.missing.join(', ')}`);
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
    // The model a bare opencode-engine run uses (from TRISS_CODER_MODEL). crush
    // ignores it and runs its own GLM atoms, so label it as opencode-scoped.
    lines.push(`  default model (opencode)      ${pc.cyan(coder.defaultModel)}`);
    // opencode (engine #1) — version-checked against the pin.
    const ocMarker = coder.engineVersion ? pc.green('●') : pc.dim('○');
    const ocLabel = coder.engineVersion
      ? coder.engineVersion === coder.pin
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
    const wtMarker = coder.worktreeCount > 0 ? pc.green('●') : pc.dim('○');
    lines.push(`  ${wtMarker} worktrees (.triss/wt)       ${coder.worktreeCount} live`);
  }

  if (!cfg.apiKey || allManifests.some((m) => !envReadiness(m).ready)) {
    lines.push('');
    lines.push(pc.dim('Tip: run ') + pc.cyan('triss config wizard') + pc.dim(' for an interactive setup.'));
  }

  process.stdout.write(lines.join('\n') + '\n');
}

import pc from 'picocolors';
import { getConfig } from '../config.js';
import { listPresets } from '../models.js';
import { loadIntegrations, envReadiness, getCoreManifest } from '../integrations/_registry.js';
import { activeEnvFiles, readEnvFile, maskValue } from '../secrets.js';
import { projectRoot, pathsRestricted } from '../safety.js';

export async function runStatus() {
  const cfg = getConfig();
  const presets = listPresets();
  const integrations = await loadIntegrations();
  const allManifests = [getCoreManifest(), ...integrations];
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

  if (!cfg.apiKey || allManifests.some((m) => !envReadiness(m).ready)) {
    lines.push('');
    lines.push(pc.dim('Tip: run ') + pc.cyan('triss config wizard') + pc.dim(' for an interactive setup.'));
  }

  process.stdout.write(lines.join('\n') + '\n');
}

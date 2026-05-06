import pc from 'picocolors';
import { getConfig } from '../config.js';
import { listPresets } from '../models.js';
import { loadIntegrations, envReadiness } from '../integrations/_registry.js';

export async function runStatus() {
  const cfg = getConfig();
  const presets = listPresets();
  const integrations = await loadIntegrations();

  const mask = (k) => (k ? `${k.slice(0, 4)}…${k.slice(-4)}` : pc.red('(missing)'));

  const lines = [
    pc.bold('Triss Coworker — status'),
    '',
    `  API base    : ${cfg.baseUrl}`,
    `  API key     : ${mask(cfg.apiKey)}`,
    `  Default     : ${cfg.defaultPreset}`,
    '',
    pc.bold('Model presets'),
  ];
  for (const p of presets) {
    const tag = p.isDefault ? pc.green(' (default)') : '';
    lines.push(`  ${p.preset.padEnd(6)} → ${p.model}${tag}`);
  }

  lines.push('');
  lines.push(pc.bold('Loaded .env files'));
  lines.push(`  user    : ${cfg.envSources.userEnv ?? pc.dim('(none)')}`);
  lines.push(`  project : ${cfg.envSources.projectEnv ?? pc.dim('(none)')}`);

  lines.push('');
  lines.push(pc.bold('Integrations'));
  if (!integrations.length) {
    lines.push(pc.dim('  (none)'));
  } else {
    for (const m of integrations) {
      const r = envReadiness(m);
      const tag = r.ready ? pc.green('✓ ready') : pc.yellow(`⚠ missing ${r.missing.join(', ')}`);
      lines.push(`  ${m.name.padEnd(10)} ${tag}`);
      if (m.envVars?.length) {
        for (const e of m.envVars) {
          const present = process.env[e.name];
          const marker = present ? pc.green('●') : e.required ? pc.red('○') : pc.dim('○');
          const value = present ? mask(present) : pc.dim('(unset)');
          lines.push(`     ${marker} ${e.name.padEnd(28)} ${value}`);
        }
      }
    }
  }

  process.stdout.write(lines.join('\n') + '\n');
}

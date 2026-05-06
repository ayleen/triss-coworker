import pc from 'picocolors';
import { getConfig } from '../config.js';
import { listPresets } from '../models.js';

export function runStatus() {
  const cfg = getConfig();
  const presets = listPresets();

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
  process.stdout.write(lines.join('\n') + '\n');
}

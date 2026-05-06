import { readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateManifest } from './_contract.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export async function loadIntegrations({ dir = HERE } = {}) {
  const entries = readdirSync(dir);
  const integrations = [];
  for (const entry of entries) {
    if (entry.startsWith('_') || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const indexPath = resolve(full, 'index.js');
    if (!existsSync(indexPath)) continue;
    const mod = await import(pathToFileURL(indexPath).href);
    const manifest = validateManifest(mod.default, `${entry}/index.js`);
    integrations.push(manifest);
  }
  integrations.sort((a, b) => a.name.localeCompare(b.name));
  return integrations;
}

export function envReadiness(manifest) {
  const required = (manifest.envVars || []).filter((e) => e.required);
  const missing = required.filter((e) => !process.env[e.name]).map((e) => e.name);
  return { ready: missing.length === 0, missing };
}

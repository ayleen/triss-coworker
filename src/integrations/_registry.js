import { readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateManifest } from './_contract.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// "Core" credentials live outside any single integration but should appear
// in `triss config wizard`/`status` alongside integrations.
export const CORE_MANIFEST = {
  name: 'worker',
  description: 'Worker model (any OpenAI-compatible chat-completions endpoint; DeepSeek by default)',
  isCore: true,
  envVars: [
    {
      name: 'TRISS_WORKER_API_KEY',
      required: true,
      secret: true,
      doc: 'Get one at https://platform.deepseek.com/',
    },
    {
      name: 'TRISS_WORKER_BASE_URL',
      required: false,
      doc: 'Override endpoint (default https://api.deepseek.com/v1)',
    },
    {
      name: 'TRISS_WORKER_FLASH_MODEL',
      required: false,
      doc: 'Override the "flash" preset model id',
    },
    {
      name: 'TRISS_WORKER_PRO_MODEL',
      required: false,
      doc: 'Override the "pro" preset model id',
    },
    {
      name: 'TRISS_DEFAULT_MODEL',
      required: false,
      doc: 'Default preset when no --model is passed: "flash" (cheap, default) or "pro"',
    },
  ],
};

export function getCoreManifest() {
  return CORE_MANIFEST;
}

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
    // Optional bootstrap hook — lets an integration prime process.env from
    // an out-of-band source (e.g. github reads `gh auth token` when the
    // user hasn't exported GITHUB_TOKEN). Best-effort; failures are swallowed.
    if (typeof manifest.bootstrap === 'function') {
      try {
        await manifest.bootstrap();
      } catch {
        /* keep going — readiness will report missing creds normally */
      }
    }
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

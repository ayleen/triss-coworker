// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateManifest } from './_contract.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// The generic configuration wizard exposes the default direct provider as a
// core manifest. Other canonical providers are configured by the provider
// wizard/coder surfaces.
export const CORE_MANIFEST = {
  name: 'openai-compatible',
  description: 'Default OpenAI-compatible provider profile',
  isCore: true,
  envVars: [
    {
      name: 'TRISS_OPENAI_COMPATIBLE_API_KEY',
      required: true,
      secret: true,
      doc: 'API key for the configured OpenAI-compatible endpoint',
    },
    {
      name: 'TRISS_OPENAI_COMPATIBLE_BASE_URL',
      required: false,
      doc: 'OpenAI-compatible API base URL',
    },
    {
      name: 'TRISS_OPENAI_COMPATIBLE_MODEL',
      required: false,
      doc: 'Main model id for review, write, and coder tasks',
    },
    {
      name: 'TRISS_OPENAI_COMPATIBLE_SMALL_MODEL',
      required: false,
      doc: 'Small model id for ask, chat, fetch, commit, and integration summaries',
    },
    {
      name: 'TRISS_DEFAULT_PROVIDER',
      required: false,
      doc: 'Canonical provider selected when --provider is omitted',
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

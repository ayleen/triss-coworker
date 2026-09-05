// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import pc from 'picocolors';
import { join } from 'node:path';
import {
  getEnvFilePath,
  ensureEnvFile,
  activeEnvFiles,
  readEnvFile,
  setVar,
  unsetVar,
  prompt,
  promptChoice,
  maskValue,
  addToGitignore,
  readStdin,
} from '../secrets.js';
import { assertModelExecutionEngine } from '../provider-contract.js';
import { loadIntegrations, getCoreManifest } from '../integrations/_registry.js';
import { CODER_MANIFEST } from './coder.js';

// Exported for reuse by coder.js (`--global`/`--local` mean the same
// thing everywhere in triss) — see the identical logic that used to live
// there as `resolveCoderScope`.
export function resolveScope(opts) {
  if (opts.global && opts.local) {
    throw new Error('Pick one of --global or --local, not both');
  }
  if (opts.local) return 'local';
  if (opts.global) return 'global';
  return null;
}

export async function chooseScope(message = 'Where to save?') {
  // Non-interactive shell (CI, pipes): silently default to global.
  if (!process.stdin.isTTY) return 'global';
  return promptChoice(
    message,
    [
      { label: `Global  — ${getEnvFilePath('global')} (works in every project)`, value: 'global' },
      { label: `Project — ${getEnvFilePath('local')} (overrides global here only)`, value: 'local' },
    ],
    { defaultIndex: 0 },
  );
}

function isSecretKey(name) {
  return /TOKEN|KEY|SECRET|PASS/i.test(name);
}

async function listManifests() {
  const integrations = await loadIntegrations();
  return [getCoreManifest(), CODER_MANIFEST, ...integrations];
}

function maybeAddGitignore() {
  const root = process.env.TRISS_PROJECT_ROOT || process.cwd();
  if (!existsSync(join(root, '.gitignore')) && !existsSync(join(root, '.git'))) return;
  addToGitignore('.triss.env');
}

// ─── wizard ──────────────────────────────────────────────────────────────────

// Exported for tests — pure function over the parsed flags.
export function resolveMode(opts) {
  if (opts.standard && opts.advanced) {
    throw new Error('Pick one of --standard or --advanced, not both');
  }
  if (opts.standard) return 'standard';
  if (opts.advanced) return 'advanced';
  return null;
}

// The wizard machinery (Easy/Advanced/targeted/headless) lives in
// src/setup/wizard.js; this entry point keeps the historical import path and
// the historical flags.
export async function runWizard(target, opts = {}, deps = {}) {
  // The wizard machinery (Easy/Advanced/targeted/headless) lives in
  // src/setup/wizard.js; this entry point keeps the historical import path.
  const { runSetupWizard } = await import('../setup/wizard.js');
  return runSetupWizard(target, opts, deps);
}

export async function runSet(key, value, opts) {
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
    throw new Error(`Invalid env var name: "${key}"`);
  }
  let scope = resolveScope(opts);
  if (!scope) scope = await chooseScope();

  let resolved = value;
  if (resolved === '-') {
    resolved = await readStdin();
  }
  if (resolved == null) {
    resolved = await prompt(key, { hidden: isSecretKey(key) });
  }
  if (!resolved) throw new Error('Empty value — aborted');
  if (key === 'TRISS_DEFAULT_ENGINE') {
    assertModelExecutionEngine(resolved, key);
  }

  const path = ensureEnvFile(scope);
  setVar(path, key, resolved);
  process.stdout.write(pc.green(`✓ ${key} saved to ${path}\n`));
  if (scope === 'local') maybeAddGitignore();
}

export function runGet(key, opts) {
  const scope = resolveScope(opts);
  const files = scope ? activeEnvFiles().filter((f) => f.scope === scope) : activeEnvFiles();
  for (const f of files) {
    if (!f.exists) continue;
    const v = readEnvFile(f.path).vars[key];
    if (v != null) {
      process.stdout.write(`${f.scope}\t${isSecretKey(key) ? maskValue(v) : v}\t(${f.path})\n`);
      return;
    }
  }
  process.stdout.write(pc.dim(`(${key} not set in ${scope || 'any scope'})\n`));
  process.exit(1);
}

export async function runList(opts) {
  const scope = resolveScope(opts);
  const files = scope ? activeEnvFiles().filter((f) => f.scope === scope) : activeEnvFiles();
  const manifests = await listManifests();
  const known = new Set();
  for (const m of manifests) for (const v of m.envVars || []) known.add(v.name);

  for (const f of files) {
    process.stdout.write(
      pc.bold(`── ${f.scope} ── `) + f.path + (f.exists ? '' : pc.dim(' (missing)')) + '\n',
    );
    if (!f.exists) continue;
    const vars = readEnvFile(f.path).vars;
    const keys = Object.keys(vars).sort();
    if (!keys.length) {
      process.stdout.write(pc.dim('  (empty)\n'));
      continue;
    }
    for (const k of keys) {
      const v = vars[k];
      const tag = known.has(k) ? '' : pc.dim(' (unknown)');
      process.stdout.write(`  ${k.padEnd(28)} ${isSecretKey(k) ? maskValue(v) : v}${tag}\n`);
    }
  }
}

export function runPath(opts) {
  const scope = resolveScope(opts);
  const files = scope ? activeEnvFiles().filter((f) => f.scope === scope) : activeEnvFiles();
  for (const f of files) {
    process.stdout.write(`${f.scope}\t${f.path}\t${f.exists ? 'exists' : 'missing'}\n`);
  }
}

export async function runEdit(opts) {
  let scope = resolveScope(opts);
  if (!scope) scope = await chooseScope('Edit which file?');
  const path = ensureEnvFile(scope);
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  // spawnSync without shell: editor + path passed as separate argv entries.
  const result = spawnSync(editor, [path], { stdio: 'inherit' });
  if (result.error) {
    throw new Error(`Failed to launch editor "${editor}": ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Editor "${editor}" exited with status ${result.status} — ` +
        `${path} was not saved (or your editor reports an error).`,
    );
  }
}

export async function runUnset(key, opts) {
  let scope = resolveScope(opts);
  if (!scope) scope = await chooseScope('Remove from which file?');
  const path = getEnvFilePath(scope);
  const removed = unsetVar(path, key);
  if (removed) process.stdout.write(pc.green(`✓ ${key} removed from ${path}\n`));
  else process.stdout.write(pc.dim(`(${key} was not set in ${path})\n`));
}

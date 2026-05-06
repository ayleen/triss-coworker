import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import pc from 'picocolors';
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
import { loadIntegrations, getCoreManifest } from '../integrations/_registry.js';

function resolveScope(opts) {
  if (opts.global && opts.local) {
    throw new Error('Pick one of --global or --local, not both');
  }
  if (opts.local) return 'local';
  if (opts.global) return 'global';
  return null;
}

async function chooseScope(message = 'Where to save?') {
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

async function listManifests() {
  const integrations = await loadIntegrations();
  return [getCoreManifest(), ...integrations];
}

function findManifest(name, manifests) {
  const m = manifests.find((x) => x.name === name);
  if (!m) {
    throw new Error(
      `Unknown target "${name}". Try one of: ${manifests.map((x) => x.name).join(', ')}`,
    );
  }
  return m;
}

function isSecretKey(name) {
  return /TOKEN|KEY|SECRET|PASS/i.test(name);
}

// ─── wizard ──────────────────────────────────────────────────────────────────

export async function runWizard(target, opts) {
  const manifests = await listManifests();
  const explicit = !!target;
  const targets = explicit ? [findManifest(target, manifests)] : manifests;

  let scope = resolveScope(opts);
  if (!scope) scope = await chooseScope();
  const path = ensureEnvFile(scope);
  const current = readEnvFile(path).vars;

  process.stdout.write(pc.dim(`\nSaving to ${path}\n`));

  for (const m of targets) {
    if (!m.envVars?.length) continue;

    // For the full wizard (no explicit target), ask before stepping into
    // each non-core integration — most users only need a subset.
    if (!explicit && !m.isCore) {
      const readyAlready = m.envVars
        .filter((v) => v.required)
        .every((v) => current[v.name]);
      const verb = readyAlready ? 'Re-enter' : 'Configure';
      const defaultYes = false;
      const want = await yesNo(
        `\n${verb} ${pc.bold(m.name)}? ${pc.dim(m.description || '')}`,
        defaultYes,
      );
      if (!want) {
        process.stdout.write(pc.dim(`  · skipped\n`));
        continue;
      }
    }

    process.stdout.write('\n' + pc.bold(`── ${m.name} ──`) + '\n');
    if (m.description) process.stdout.write(pc.dim(m.description + '\n'));

    for (const v of m.envVars) {
      const secret = v.secret || isSecretKey(v.name);
      const existing = current[v.name];
      if (existing && !opts.force) {
        const overwrite = await yesNo(
          `${v.name} is already set (${maskValue(existing)}). Overwrite?`,
          false,
        );
        if (!overwrite) continue;
      }

      const labelParts = [v.name];
      labelParts.push(v.required ? pc.yellow('(required)') : pc.dim('(optional, Enter to skip)'));
      process.stdout.write('  ' + labelParts.join(' ') + '\n');
      if (v.doc) process.stdout.write(pc.dim('  ' + v.doc + '\n'));

      const answer = await prompt('  value', { hidden: secret, defaultValue: existing });
      if (!answer) {
        if (v.required && !existing) {
          process.stdout.write(
            pc.yellow(
              `  ⚠ Skipped — ${v.name} is required, set it later via 'triss config set ${v.name}'\n`,
            ),
          );
        }
        continue;
      }
      setVar(path, v.name, answer);
      process.stdout.write(pc.green(`  ✓ saved\n`));
    }
  }

  if (scope === 'local') maybeAddGitignore();
  process.stdout.write(
    '\n' + pc.green('Done.') + ' Run ' + pc.cyan('triss status') + ' to verify.\n',
  );
}

async function yesNo(question, defaultYes) {
  const def = defaultYes ? 'Y/n' : 'y/N';
  const ans = (await prompt(`${question} [${def}]`)).trim().toLowerCase();
  if (!ans) return defaultYes;
  return ans.startsWith('y');
}

function maybeAddGitignore() {
  if (!existsSync('.gitignore') && !existsSync('.git')) return;
  if (addToGitignore('.triss.env')) {
    process.stdout.write(pc.dim('  · added .triss.env to .gitignore\n'));
  }
}

// ─── set / get / list / path / edit / unset ──────────────────────────────────

export async function runSet(key, value, opts) {
  if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
    throw new Error(`Invalid env var name: "${key}"`);
  }
  let scope = resolveScope(opts);
  if (!scope) scope = await chooseScope();
  const path = ensureEnvFile(scope);

  let resolved = value;
  if (resolved === '-') {
    resolved = await readStdin();
  }
  if (resolved == null) {
    resolved = await prompt(key, { hidden: isSecretKey(key) });
  }
  if (!resolved) throw new Error('Empty value — aborted');

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
  if (result.status !== 0 && result.error) throw result.error;
}

export async function runUnset(key, opts) {
  let scope = resolveScope(opts);
  if (!scope) scope = await chooseScope('Remove from which file?');
  const path = getEnvFilePath(scope);
  const removed = unsetVar(path, key);
  if (removed) process.stdout.write(pc.green(`✓ ${key} removed from ${path}\n`));
  else process.stdout.write(pc.dim(`(${key} was not set in ${path})\n`));
}

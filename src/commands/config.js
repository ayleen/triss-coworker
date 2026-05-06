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

// Exported for tests — pure function over the parsed flags.
export function resolveMode(opts) {
  if (opts.standard && opts.advanced) {
    throw new Error('Pick one of --standard or --advanced, not both');
  }
  if (opts.standard) return 'standard';
  if (opts.advanced) return 'advanced';
  return null;
}

// Exported for tests — falls back to "standard" in non-TTY environments
// so wizard works in CI / piped contexts without hanging.
export async function chooseMode() {
  if (!process.stdin.isTTY) return 'standard';
  return promptChoice(
    'Setup mode?',
    [
      {
        label: 'Standard  — API key + one model. For most users.',
        value: 'standard',
      },
      {
        label: 'Advanced  — full control: presets, base URL, integrations (Jira, Linear, …).',
        value: 'advanced',
      },
    ],
    { defaultIndex: 0 },
  );
}

export async function runWizard(target, opts) {
  const manifests = await listManifests();
  const explicit = !!target;

  let scope = resolveScope(opts);
  if (!scope) scope = await chooseScope();
  const path = ensureEnvFile(scope);
  const current = readEnvFile(path).vars;

  // Targeted invocation skips the standard/advanced choice entirely —
  // the user has already said "configure exactly this".
  if (explicit) {
    if (resolveMode(opts)) {
      throw new Error('--standard / --advanced cannot be combined with a target argument');
    }
    process.stdout.write(pc.dim(`\nSaving to ${path}\n`));
    await runFullWizard([findManifest(target, manifests)], path, current, {
      explicit: true,
      force: !!opts.force,
    });
    process.stdout.write('\n' + pc.green('Done.') + ' Run ' + pc.cyan('triss status') + ' to verify.\n');
    if (scope === 'local') maybeAddGitignore();
    return;
  }

  const mode = resolveMode(opts) || (await chooseMode());
  process.stdout.write(pc.dim(`\nSaving to ${path}\n`));

  if (mode === 'standard') {
    await runStandardWizard(path, current);
    await silentlyInstallBoth();
  } else {
    await runFullWizard(manifests, path, current, { explicit: false, force: !!opts.force });
    process.stdout.write('\n' + pc.green('Done.') + ' Run ' + pc.cyan('triss status') + ' to verify.\n');
    await offerClaudeCodeIntegration();
  }
  if (scope === 'local') maybeAddGitignore();
}

// Standard mode treats Claude Code integration as part of the default
// setup — install both paths without asking. Aligns with the rest of
// Standard mode's "do the obvious thing" philosophy.
async function silentlyInstallBoth() {
  process.stdout.write(
    '\n' +
      pc.bold('Wiring Triss into Claude Code') +
      pc.dim(' (Standard installs both — re-run with --advanced to choose otherwise)') +
      '\n',
  );
  const { installEntry } = await import('../mcp/install.js');
  const r = installEntry('global');
  process.stdout.write(pc.green(`  ✓ MCP server "triss" ${r.status} in ${r.path}\n`));

  const { runInit } = await import('./init.js');
  await runInit({ global: true });

  process.stdout.write(
    '\n  ' +
      pc.dim('Restart your Claude Code session to pick up the new server / rules.') +
      '\n',
  );
}

async function offerClaudeCodeIntegration() {
  if (!process.stdin.isTTY) return; // CI / piped runs: stay silent

  process.stdout.write('\n' + pc.bold('Wire Triss into Claude Code?') + '\n');
  process.stdout.write(
    pc.dim(
      '  · MCP server      — Claude Code calls Triss tools natively\n' +
        '                      (faster, per-tool permissions)\n' +
        '  · CLAUDE.md rules — agent calls Triss via shell\n' +
        '                      (universal, simple, also acts as MCP fallback)\n\n' +
        '  Most users want both — they cooperate (MCP primary, rules fallback).\n',
    ),
  );

  const choice = await promptChoice(
    'How should Triss integrate with Claude Code?',
    [
      { label: 'Both (recommended) — MCP server + global CLAUDE.md', value: 'both' },
      { label: 'MCP server only', value: 'mcp' },
      { label: 'CLAUDE.md rules only', value: 'rules' },
      { label: 'Skip — I will run `triss init` / `triss mcp install` later', value: 'skip' },
    ],
    { defaultIndex: 0 },
  );

  if (choice === 'skip') {
    process.stdout.write(
      pc.dim(
        '\n  Hint: ' +
          pc.cyan('triss mcp install') +
          pc.dim(' to register as MCP, ') +
          pc.cyan('triss init --global') +
          pc.dim(' for CLAUDE.md rules.\n'),
      ),
    );
    return;
  }

  process.stdout.write('\n');
  if (choice === 'both' || choice === 'mcp') {
    const { installEntry } = await import('../mcp/install.js');
    const r = installEntry('global');
    process.stdout.write(pc.green(`✓ MCP server "triss" ${r.status} in ${r.path}\n`));
  }
  if (choice === 'both' || choice === 'rules') {
    const { runInit } = await import('./init.js');
    await runInit({ global: true });
  }
  process.stdout.write(
    '\n  ' + pc.dim('Restart your Claude Code session to pick up the new server / rules.') + '\n',
  );
}

async function runStandardWizard(path, current) {
  process.stdout.write('\n' + pc.bold('── Standard setup ──') + '\n');
  process.stdout.write(pc.dim('Just the essentials: API key + worker model.\n'));
  process.stdout.write(
    pc.dim('For Jira / Linear / per-preset models, run `triss config wizard --advanced` later.\n'),
  );

  // 1. API key — required.
  const existingKey = current['DEEPSEEK_API_KEY'];
  let proceedKey = true;
  if (existingKey) {
    proceedKey = await yesNo(
      `\nAPI key is already set (${maskValue(existingKey)}). Replace?`,
      false,
    );
  }
  if (proceedKey) {
    process.stdout.write('\n  ' + pc.yellow('DEEPSEEK_API_KEY') + ' (required)\n');
    process.stdout.write(pc.dim('  Get one at https://platform.deepseek.com/\n'));
    const key = await prompt('  value', { hidden: true, defaultValue: existingKey });
    if (key) {
      setVar(path, 'DEEPSEEK_API_KEY', key);
      process.stdout.write(pc.green('  ✓ saved\n'));
    } else if (!existingKey) {
      process.stdout.write(
        pc.yellow("  ⚠ skipped — set later via 'triss config set DEEPSEEK_API_KEY'\n"),
      );
    }
  }

  // 2. Worker model — optional, single value writes to both presets.
  const existingFlash = current['DEEPSEEK_FLASH_MODEL'];
  const existingPro = current['DEEPSEEK_PRO_MODEL'];
  const presetsMatch = existingFlash && existingFlash === existingPro;
  const existingModel = presetsMatch ? existingFlash : '';
  process.stdout.write(
    '\n  ' + pc.dim('Worker model') + pc.dim(' (optional, Enter for default)\n'),
  );
  process.stdout.write(
    pc.dim('  e.g. deepseek-v4-flash, kimi-k2.5, qwen2.5-coder:14b. Default: deepseek-v4-flash\n'),
  );
  const model = await prompt('  value', { defaultValue: existingModel });
  if (model) {
    if (existingFlash && existingPro && !presetsMatch) {
      process.stdout.write(
        pc.yellow(
          `  ⚠ flash (${existingFlash}) and pro (${existingPro}) presets are currently different.\n` +
            `    Standard mode will overwrite BOTH with "${model}".\n`,
        ),
      );
      const ok = await yesNo('  Overwrite both?', false);
      if (!ok) {
        process.stdout.write(
          pc.dim('  · skipped — keep separate presets via `triss config wizard --advanced`\n'),
        );
        return;
      }
    }
    setVar(path, 'DEEPSEEK_FLASH_MODEL', model);
    setVar(path, 'DEEPSEEK_PRO_MODEL', model);
    process.stdout.write(pc.green('  ✓ saved as both flash and pro presets\n'));
  }

  process.stdout.write(
    '\n' +
      pc.green('Done.') +
      ' Run ' +
      pc.cyan('triss status') +
      pc.dim(' to verify. Need Jira/Linear or different presets? ') +
      pc.cyan('triss config wizard --advanced') +
      '\n',
  );
}

async function runFullWizard(targets, path, current, { explicit, force }) {
  for (const m of targets) {
    if (!m.envVars?.length) continue;

    // For the full wizard (no explicit target), ask before stepping into
    // each non-core integration — most users only need a subset.
    if (!explicit && !m.isCore) {
      const readyAlready = m.envVars
        .filter((v) => v.required)
        .every((v) => current[v.name]);
      const verb = readyAlready ? 'Re-enter' : 'Configure';
      const want = await yesNo(
        `\n${verb} ${pc.bold(m.name)}? ${pc.dim(m.description || '')}`,
        false,
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
      if (existing && !force) {
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

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import pc from 'picocolors';
import { runServer } from '../mcp/server.js';
import {
  installEntry,
  uninstallEntry,
  showStatus,
  migrateCodexToolTimeout,
} from '../mcp/install.js';
import { promptChoice } from '../secrets.js';

const SUPPORTED_TARGETS = ['claude', 'codex', 'both'];

function resolveScopeFlags(opts) {
  if (opts.global && opts.local) {
    throw new Error('Pick one of --global or --local, not both');
  }
  if (opts.local) return 'local';
  if (opts.global) return 'global';
  return null;
}

// Read-only commands (status, uninstall) keep the old behaviour: default to
// global when no flag is given. Only `install` prompts.
function resolveScope(opts) {
  return resolveScopeFlags(opts) || 'global';
}

// Install-time scope resolver. When neither --global nor --local is passed
// and stdin is a TTY, prompt the user — we used to silently default to
// global, which was the silent culprit behind cross-project sandbox bugs
// (a global ~/.claude.json baked the install-time cwd into every session).
// Codex / 'both' have no project-local config, so we don't prompt there.
async function resolveInstallScope(opts, target) {
  const flag = resolveScopeFlags(opts);
  if (flag) return flag;
  if (target !== 'claude') return 'global';
  if (!process.stdin.isTTY) return 'global';
  return promptChoice(
    'Where should triss be registered?',
    [
      {
        label: 'Project — ./.mcp.json (only this project; sandbox pinned here)',
        value: 'local',
      },
      {
        label:
          'Global  — ~/.claude.json (every Claude Code session; sandbox follows per-session cwd)',
        value: 'global',
      },
    ],
    { defaultIndex: 0 },
  );
}

async function resolveTarget(opts) {
  const raw = opts.target ? String(opts.target).toLowerCase() : '';
  if (raw) {
    if (!SUPPORTED_TARGETS.includes(raw)) {
      throw new Error(
        `Unknown --target "${raw}". Supported: ${SUPPORTED_TARGETS.join(', ')}`,
      );
    }
    return raw;
  }
  if (!process.stdin.isTTY) return 'claude';
  return promptChoice(
    'Where should triss register as an MCP server?',
    [
      { label: 'Claude — ~/.claude.json or ./.mcp.json', value: 'claude' },
      { label: 'Codex  — ~/.codex/config.toml', value: 'codex' },
      { label: 'Both   — Claude and Codex', value: 'both' },
    ],
    { defaultIndex: 0 },
  );
}

function expandTargets(target) {
  return target === 'both' ? ['claude', 'codex'] : [target];
}

export async function runMcpServe(deps = {}) {
  const warn =
    deps.warn ||
    ((msg) => (deps.stderr || process.stderr).write(`${msg}\n`));
  const migrate = deps.migrateCodexToolTimeout || migrateCodexToolTimeout;
  const serve = deps.runServer || runServer;

  // Existing-user migration, best effort: after any distribution-path update,
  // upgrade a stale Triss-owned Codex tool_timeout_sec (120) to the current
  // default (5460) on the first startup. This must never block the MCP server
  // from starting, must never touch values other than the exact historical 120
  // (an exact 120 is indistinguishable from a deliberately custom one and is
  // always treated as legacy), and must never create the Codex config —
  // failure, a concurrent-edit conflict, or "nothing to do" just falls
  // through. Only an actual "updated" result tells the user to restart; a
  // conflict means we deliberately did not write, so a restart claim would be
  // wrong. The migration distinguishes two races: a change detected by its
  // optimistic pre-write re-read returns the early `status: 'conflict'` result
  // (never a warning), while a change that lands later — during the atomic
  // temp write — surfaces as a thrown CAS precondition error, which is caught
  // here and warned as best-effort. Both leave the user's edit untouched.
  try {
    const migrationPath = deps.codexConfigPath;
    const result = await migrate(migrationPath ? { path: migrationPath } : {});
    if (result?.status === 'updated') {
      // Derive the message from the result so it always reflects what was
      // actually migrated (from/to come from the migration's own constants or
      // injected test seams, never hardcoded here).
      warn(
        `triss mcp: upgraded Codex tool_timeout_sec ${result.from} → ${result.to} in ` +
          `${result.path}. The running host already loaded the old ${result.from}s cap — ` +
          'restart any currently running Codex sessions once to pick up the new timeout.',
      );
    }
  } catch (err) {
    warn(
      `triss mcp: could not upgrade the Codex tool timeout (best effort): ` +
        `${err?.message || err}`,
    );
  }

  await serve();
}

export async function runMcpInstall(opts) {
  // Resolve target first so we can skip the scope prompt for Codex / 'both'
  // (those have no project-local mode — would just be a dead choice).
  const target = await resolveTarget(opts);
  const scope = await resolveInstallScope(opts, target);
  const targets = expandTargets(target);

  // Codex doesn't support project-local config — fail fast before any write.
  if (scope === 'local' && targets.includes('codex')) {
    throw new Error(
      "Codex doesn't support project-local MCP config — use --global with --target codex/both",
    );
  }

  const customArgs = opts.args ? opts.args.split(/\s+/).filter(Boolean) : undefined;
  for (const t of targets) {
    const result = installEntry(scope, {
      target: t,
      command: opts.command,
      args: customArgs,
    });
    process.stdout.write(
      pc.green(`✓ MCP server "triss" ${result.status} in ${result.path}`) +
        pc.dim(` (${t}, scope=${t === 'codex' ? 'global' : scope})`) +
        '\n',
    );
    if (result.migratedFrom) {
      process.stdout.write(
        pc.yellow(
          `  ⚠ dropped stale TRISS_PROJECT_ROOT=${result.migratedFrom} ` +
            `from this entry — global installs no longer pin a sandbox path; ` +
            `the sandbox now follows the per-session cwd.\n`,
        ),
      );
    }
  }
  const session = target === 'codex' ? 'Codex' : target === 'both' ? 'agent' : 'Claude Code';
  process.stdout.write(
    pc.dim(`  Restart your ${session} session to pick up the new server.\n`),
  );
}

export async function runMcpUninstall(opts) {
  const scope = resolveScope(opts);
  const target = await resolveTarget(opts);
  const targets = expandTargets(target);

  for (const t of targets) {
    if (scope === 'local' && t === 'codex') {
      // Nothing to do — Codex never installed locally.
      continue;
    }
    const result = uninstallEntry(scope, { target: t });
    if (result.status === 'absent') {
      process.stdout.write(pc.dim(`(no triss entry found in ${result.path})\n`));
      continue;
    }
    process.stdout.write(
      pc.cyan(`✓ MCP server "triss" removed from ${result.path}`) + pc.dim(` (${t})`) + '\n',
    );
  }
}

export async function runMcpStatus(opts) {
  const scope = resolveScope(opts);
  const raw = opts.target ? String(opts.target).toLowerCase() : '';
  // Status is read-only — when target is unspecified, show both agents
  // instead of prompting (prompt would be annoying for a status command).
  const targets = raw
    ? expandTargets(
        SUPPORTED_TARGETS.includes(raw)
          ? raw
          : (() => {
              throw new Error(
                `Unknown --target "${raw}". Supported: ${SUPPORTED_TARGETS.join(', ')}`,
              );
            })(),
      )
    : ['claude', 'codex'];

  for (const t of targets) {
    if (scope === 'local' && t === 'codex') continue;
    let status;
    try {
      status = showStatus(scope, { target: t });
    } catch (err) {
      const msg = err?.message || String(err);
      process.stdout.write(pc.bold(`── ${t} ──`) + '\n');
      process.stdout.write(`Path: (unknown)\n`);
      process.stderr.write(pc.dim(`[triss/mcp] could not read ${t} config: ${msg}\n`));
      continue;
    }
    process.stdout.write(pc.bold(`── ${t} ──`) + '\n');
    process.stdout.write(`Path: ${status.path}\n`);
    if (!status.present) {
      process.stdout.write(pc.dim(`  triss is not registered as an MCP server here\n`));
      continue;
    }
    process.stdout.write(pc.green('  triss is registered:\n'));
    const entry =
      typeof status.entry === 'string'
        ? status.entry
        : JSON.stringify(status.entry, null, 2);
    process.stdout.write(
      entry
        .split('\n')
        .map((l) => '  ' + l)
        .join('\n') + '\n',
    );
  }
}

import pc from 'picocolors';
import { runServer } from '../mcp/server.js';
import { installEntry, uninstallEntry, showStatus } from '../mcp/install.js';
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

export async function runMcpServe() {
  await runServer();
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
    const status = showStatus(scope, { target: t });
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

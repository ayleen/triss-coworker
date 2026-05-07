import pc from 'picocolors';
import { runServer } from '../mcp/server.js';
import { installEntry, uninstallEntry, showStatus } from '../mcp/install.js';
import { promptChoice } from '../secrets.js';

const SUPPORTED_TARGETS = ['claude', 'codex', 'both'];

function resolveScope(opts) {
  if (opts.global && opts.local) {
    throw new Error('Pick one of --global or --local, not both');
  }
  return opts.local ? 'local' : 'global';
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
  const scope = resolveScope(opts);
  const target = await resolveTarget(opts);
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
        pc.dim(` (${t})`) +
        '\n',
    );
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

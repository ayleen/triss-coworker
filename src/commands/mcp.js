import pc from 'picocolors';
import { runServer } from '../mcp/server.js';
import { installEntry, uninstallEntry, showStatus } from '../mcp/install.js';

function resolveScope(opts) {
  if (opts.global && opts.local) {
    throw new Error('Pick one of --global or --local, not both');
  }
  return opts.local ? 'local' : 'global';
}

export async function runMcpServe() {
  await runServer();
}

export async function runMcpInstall(opts) {
  const scope = resolveScope(opts);
  const result = installEntry(scope, {
    command: opts.command,
    args: opts.args ? opts.args.split(/\s+/).filter(Boolean) : undefined,
  });
  process.stdout.write(
    pc.green(`✓ MCP server "triss" ${result.status} in ${result.path}\n`),
  );
  process.stdout.write(
    pc.dim('  Restart your Claude Code session to pick up the new server.\n'),
  );
}

export async function runMcpUninstall(opts) {
  const scope = resolveScope(opts);
  const result = uninstallEntry(scope);
  if (result.status === 'absent') {
    process.stdout.write(pc.dim(`(no triss entry found in ${result.path})\n`));
    return;
  }
  process.stdout.write(pc.cyan(`✓ MCP server "triss" removed from ${result.path}\n`));
}

export async function runMcpStatus(opts) {
  const scope = resolveScope(opts);
  const status = showStatus(scope);
  process.stdout.write(`Path: ${status.path}\n`);
  if (!status.present) {
    process.stdout.write(pc.dim('triss is not registered as an MCP server in this scope\n'));
    return;
  }
  process.stdout.write(pc.green('triss is registered:\n'));
  process.stdout.write(JSON.stringify(status.entry, null, 2) + '\n');
}

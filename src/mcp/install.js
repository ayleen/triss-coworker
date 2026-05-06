// Manage the Triss MCP-server registration in Claude Code config.
// Two scopes:
//   global → ~/.claude.json (the main Claude Code config)
//   local  → <cwd>/.mcp.json (project-level MCP config)

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SERVER_NAME = 'triss';

function configPath(scope) {
  if (scope === 'local') return join(process.cwd(), '.mcp.json');
  return join(homedir(), '.claude.json');
}

function readJson(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }
}

function writeJson(path, obj) {
  // Preserve a trailing newline; Claude Code sometimes writes without one,
  // but most editors add it back.
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

function entrySpec(opts = {}) {
  return {
    command: opts.command || SERVER_NAME,
    args: opts.args || ['mcp', 'serve'],
  };
}

export function installEntry(scope, opts = {}) {
  const path = configPath(scope);
  const config = readJson(path);
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  const existing = config.mcpServers[SERVER_NAME];
  config.mcpServers[SERVER_NAME] = entrySpec(opts);
  writeJson(path, config);
  return { path, status: existing ? 'updated' : 'added' };
}

export function uninstallEntry(scope) {
  const path = configPath(scope);
  if (!existsSync(path)) return { path, status: 'absent' };
  const config = readJson(path);
  if (!config.mcpServers?.[SERVER_NAME]) return { path, status: 'absent' };
  delete config.mcpServers[SERVER_NAME];
  // Keep the mcpServers key even if empty — other tools may add to it later.
  writeJson(path, config);
  return { path, status: 'removed' };
}

export function showStatus(scope) {
  const path = configPath(scope);
  if (!existsSync(path)) return { path, present: false };
  const config = readJson(path);
  return {
    path,
    present: !!config.mcpServers?.[SERVER_NAME],
    entry: config.mcpServers?.[SERVER_NAME] || null,
  };
}

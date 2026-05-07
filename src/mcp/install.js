// Manage the Triss MCP-server registration in agent configs.
//
// Two agents are supported via opts.target:
//   claude (default) — JSON in ~/.claude.json (global) or <cwd>/.mcp.json (local)
//   codex            — TOML in ~/.codex/config.toml (global only)
//
// For Claude we own the `mcpServers.triss` JSON key. For Codex we own the
// `[mcp_servers.triss]` and `[mcp_servers.triss.env]` TOML sections; everything
// else in the TOML file is preserved byte-for-byte (we don't fully parse TOML
// — we just locate and surgically replace our block).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { projectRoot } from '../safety.js';

const SERVER_NAME = 'triss';

// Codex defaults — give pro-model calls enough headroom out of the box.
const CODEX_STARTUP_TIMEOUT_SEC = 30;
const CODEX_TOOL_TIMEOUT_SEC = 120;

function normTarget(t) {
  const v = (t || 'claude').toLowerCase();
  if (v !== 'claude' && v !== 'codex') {
    throw new Error(`Unknown MCP target "${t}". Supported: claude, codex`);
  }
  return v;
}

export function configPath(scope, target = 'claude') {
  const t = normTarget(target);
  if (t === 'codex') {
    if (scope === 'local') {
      throw new Error(
        "Codex doesn't support project-local MCP config — use --global (~/.codex/config.toml)",
      );
    }
    return join(homedir(), '.codex', 'config.toml');
  }
  if (scope === 'local') return join(process.cwd(), '.mcp.json');
  return join(homedir(), '.claude.json');
}

// ─── Claude (JSON) ───────────────────────────────────────────────────────────

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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

function claudeEntry(opts) {
  const entry = {
    command: opts.command || SERVER_NAME,
    args: opts.args || ['mcp', 'serve'],
  };
  const root = opts.projectRoot || projectRoot();
  entry.env = { ...(opts.env || {}), TRISS_PROJECT_ROOT: root };
  return entry;
}

function installClaude(scope, opts) {
  const path = configPath(scope, 'claude');
  const config = readJson(path);
  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }
  const existing = config.mcpServers[SERVER_NAME];
  config.mcpServers[SERVER_NAME] = claudeEntry(opts);
  writeJson(path, config);
  return { path, status: existing ? 'updated' : 'added', target: 'claude' };
}

function uninstallClaude(scope) {
  const path = configPath(scope, 'claude');
  if (!existsSync(path)) return { path, status: 'absent', target: 'claude' };
  const config = readJson(path);
  if (!config.mcpServers?.[SERVER_NAME]) {
    return { path, status: 'absent', target: 'claude' };
  }
  delete config.mcpServers[SERVER_NAME];
  writeJson(path, config);
  return { path, status: 'removed', target: 'claude' };
}

function statusClaude(scope) {
  const path = configPath(scope, 'claude');
  if (!existsSync(path)) return { path, present: false, target: 'claude' };
  const config = readJson(path);
  return {
    path,
    target: 'claude',
    present: !!config.mcpServers?.[SERVER_NAME],
    entry: config.mcpServers?.[SERVER_NAME] || null,
  };
}

// ─── Codex (TOML) ────────────────────────────────────────────────────────────

const SECTION_RE = /^\s*\[\[?([^\]]+)\]\]?\s*$/;

function isTrissSection(name) {
  return name === 'mcp_servers.triss' || name.startsWith('mcp_servers.triss.');
}

// Locate the [mcp_servers.triss] block (header line index inclusive, end
// exclusive). End is the first line that opens a non-Triss section, or EOF.
function findTrissBlock(lines) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(SECTION_RE);
    if (m && m[1].trim() === 'mcp_servers.triss') {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(SECTION_RE);
    if (m && !isTrissSection(m[1].trim())) {
      end = i;
      break;
    }
  }
  // Trim trailing blank lines from inside the block.
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
  return { start, end };
}

function tomlString(s) {
  return (
    '"' +
    String(s)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t') +
    '"'
  );
}

function tomlKey(k) {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlString(k);
}

function renderTrissToml(opts) {
  const command = opts.command || SERVER_NAME;
  const args = opts.args || ['mcp', 'serve'];
  const startup =
    opts.startupTimeoutSec ?? CODEX_STARTUP_TIMEOUT_SEC;
  const toolTimeout = opts.toolTimeoutSec ?? CODEX_TOOL_TIMEOUT_SEC;
  const root = opts.projectRoot || projectRoot();
  const env = { ...(opts.env || {}), TRISS_PROJECT_ROOT: root };

  const lines = [];
  lines.push('[mcp_servers.triss]');
  lines.push(`command = ${tomlString(command)}`);
  lines.push(`args = [${args.map((a) => tomlString(a)).join(', ')}]`);
  if (Number.isFinite(startup)) lines.push(`startup_timeout_sec = ${startup}`);
  if (Number.isFinite(toolTimeout)) lines.push(`tool_timeout_sec = ${toolTimeout}`);

  if (Object.keys(env).length) {
    lines.push('');
    lines.push('[mcp_servers.triss.env]');
    for (const [k, v] of Object.entries(env)) {
      lines.push(`${tomlKey(k)} = ${tomlString(v)}`);
    }
  }
  return lines.join('\n') + '\n';
}

// Drop the existing Triss block (and the blank line that separated it from
// surrounding content), returning the cleaned TOML.
function stripTrissBlock(content) {
  if (!content) return '';
  const lines = content.split('\n');
  const block = findTrissBlock(lines);
  if (!block) return content;
  let from = block.start;
  // Pull in the blank line that precedes our block as part of the deletion.
  if (from > 0 && lines[from - 1].trim() === '') from -= 1;
  const before = lines.slice(0, from).join('\n');
  const after = lines.slice(block.end).join('\n');
  if (!before) return after.replace(/^\n+/, '');
  if (!after.trim()) return before.endsWith('\n') ? before : before + '\n';
  const sep = before.endsWith('\n') ? '' : '\n';
  return before + sep + after.replace(/^\n+/, '\n');
}

function installCodex(opts) {
  const path = configPath('global', 'codex');
  mkdirSync(dirname(path), { recursive: true });
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const had = !!findTrissBlock(before.split('\n'));
  const stripped = stripTrissBlock(before);
  const block = renderTrissToml(opts);

  let next;
  if (!stripped.trim()) {
    next = block;
  } else {
    let prefix = stripped;
    if (!prefix.endsWith('\n')) prefix += '\n';
    if (!prefix.endsWith('\n\n')) prefix += '\n';
    next = prefix + block;
  }
  writeFileSync(path, next);
  return { path, status: had ? 'updated' : 'added', target: 'codex' };
}

function uninstallCodex() {
  const path = configPath('global', 'codex');
  if (!existsSync(path)) return { path, status: 'absent', target: 'codex' };
  const before = readFileSync(path, 'utf8');
  if (!findTrissBlock(before.split('\n'))) {
    return { path, status: 'absent', target: 'codex' };
  }
  const stripped = stripTrissBlock(before);
  writeFileSync(path, stripped);
  return { path, status: 'removed', target: 'codex' };
}

function statusCodex() {
  const path = configPath('global', 'codex');
  if (!existsSync(path)) return { path, present: false, target: 'codex' };
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n');
  const block = findTrissBlock(lines);
  if (!block) return { path, present: false, target: 'codex' };
  const entry = lines.slice(block.start, block.end).join('\n').trim();
  return { path, present: true, entry, target: 'codex' };
}

// ─── Public API: dispatch on opts.target ─────────────────────────────────────

function rejectLocalCodex(scope, target) {
  if (target === 'codex' && scope === 'local') {
    throw new Error(
      "Codex doesn't support project-local MCP config — use --global with --target codex",
    );
  }
}

export function installEntry(scope, opts = {}) {
  const target = normTarget(opts.target);
  rejectLocalCodex(scope, target);
  if (target === 'codex') return installCodex(opts);
  return installClaude(scope, opts);
}

export function uninstallEntry(scope, opts = {}) {
  const target = normTarget(opts.target);
  rejectLocalCodex(scope, target);
  if (target === 'codex') return uninstallCodex();
  return uninstallClaude(scope);
}

export function showStatus(scope, opts = {}) {
  const target = normTarget(opts.target);
  rejectLocalCodex(scope, target);
  if (target === 'codex') return statusCodex();
  return statusClaude(scope);
}

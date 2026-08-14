/**
 * opencode-config.js — canonical OpenCode configuration source enumeration.
 *
 * docs/opencode2-engine-plan.md "Shared configuration backend" + "File-level
 * implementation map": one engine-family enumerator is the ONLY source of
 * paths and precedence for preflight, init, status, model inspection, and
 * their tests. Triss never rewrites the layered V1 graph to V2-native
 * fields — it only reads and audits it.
 *
 * Config precedence (effective order, root -> cwd within each group):
 *
 *   1. ~/.config/opencode/opencode.json(c)            (global)
 *   2. <boundary>..<cwd>/opencode.json(c)             (direct layers)
 *   3. <boundary>..<cwd>/.opencode/opencode.json(c)   (.opencode layers)
 *
 * The result also includes every configured plugin reference, the global
 * ~/.config/opencode/plugin{,s}/ directories, every discovered
 * <level>/.opencode/plugin{,s}/, and JSON- or file-defined agent sources
 * under the supported agent{,s} and mode{,s} directories. Each entry
 * retains its source path, kind, precedence, and existence state.
 * Ambiguous project-boundary detection or an unreadable candidate fails
 * closed, and errors name the source but never contain file contents.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// ─── JSONC parsing ──────────────────────────────────────────────────────────
//
// Minimal, dependency-free JSONC support: strip // and /* */ comments with
// a string-preserving state machine, remove trailing commas, then
// JSON.parse. Whatever JSON.parse rejects is a malformed source; callers
// fail closed on it.

export function parseOpenCodeDocument(text, { path: sourcePath = null } = {}) {
  const src = String(text);
  let out = '';
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        if (next !== undefined) {
          out += next;
          i += 2;
          continue;
        }
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  // Trailing commas: safe as a targeted regex because strings are the only
  // remaining quoted regions and a comma directly before } or ] inside a
  // string is not valid content in these documents.
  out = out.replace(/,(\s*[}\]])/gu, '$1');
  try {
    return JSON.parse(out);
  } catch (err) {
    const where = sourcePath ? ` ${sourcePath}` : '';
    throw new Error(`Failed to parse OpenCode document${where}: ${err.message}`, { cause: err });
  }
}

// ─── boundary resolution ─────────────────────────────────────────────────────

// Walk up from cwd to the first .git marker; the filesystem root when none
// exists (OpenCode treats the root as the boundary in non-git trees, so
// parent configs remain loadable — parity with opencodeProjectBoundary in
// src/commands/coder.js).
export function resolveOpenCodeProjectBoundary(cwd) {
  let current = resolve(cwd);
  while (true) {
    try {
      statSync(join(current, '.git'));
      return current;
    } catch {
      // keep walking
    }
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

// ─── constants ───────────────────────────────────────────────────────────────

const CONFIG_BASENAMES = ['opencode.json', 'opencode.jsonc'];
const PLUGIN_DIRNAMES = ['plugin', 'plugins'];
const AGENT_DIRNAMES = ['agent', 'agents', 'mode', 'modes'];

// ─── safe fs helpers (fail closed, name the path, never the contents) ───────

function listDirSafe(dir) {
  try {
    return readdirSync(dir);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    throw new Error(`Cannot read OpenCode directory ${dir}: ${err.message}`, { cause: err });
  }
}

function isFileSafe(p) {
  try {
    return statSync(p).isFile();
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw new Error(`Cannot stat OpenCode source ${p}: ${err.message}`, { cause: err });
  }
}

function readTextFailClosed(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read OpenCode source ${p}: ${err.message}`, { cause: err });
  }
}

function entryName(entry) {
  return typeof entry === 'string' ? entry : entry.name;
}

// Top-level `model` of an existing config layer, parsed fail-closed. Never
// includes other contents in errors — parse errors name only the path.
function parsedModelOf(path) {
  const doc = parseOpenCodeDocument(readTextFailClosed(path), { path });
  return typeof doc?.model === 'string' ? doc.model : undefined;
}

// ─── layer walk ──────────────────────────────────────────────────────────────

// Levels from boundary (root) down to cwd, inclusive. Fails closed when cwd
// is not inside boundary — that is an ambiguous project boundary. Built by
// walking cwd UP to the boundary and reversing (dirname from the boundary
// walks AWAY from a deeper cwd and never terminates).
function layerLevels(cwd, boundary) {
  const target = resolve(cwd);
  const root = resolve(boundary);
  // Root boundary ('/') needs a special prefix: root + '/' would be '//'.
  const inside = target === root
    || (root === '/' ? target.startsWith('/') : target.startsWith(root + '/'));
  if (!inside) {
    throw new Error(
      `Ambiguous OpenCode project boundary: cwd ${target} is not inside boundary ${root}`,
    );
  }
  const levels = [];
  let current = target;
  while (true) {
    levels.push(current);
    if (current === root) break;
    current = dirname(current);
  }
  return levels.reverse();
}

// ─── plugin/agent collection ─────────────────────────────────────────────────

// Configured plugin references (doc.plugin / doc.plugins): string paths or
// arrays of string paths resolved against the DEFINING config's directory.
// A non-string reference is unsupported and fails closed. A missing target
// is reported with exists:false — preflight rejects it later.
function collectConfiguredPlugins(doc, configPath, layer, out) {
  const refsRaw = doc?.plugin ?? doc?.plugins;
  if (refsRaw == null) return;
  const refs = Array.isArray(refsRaw) ? refsRaw : [refsRaw];
  const baseDir = dirname(configPath);
  for (const ref of refs) {
    if (typeof ref !== 'string') {
      throw new Error(
        `Unsupported OpenCode plugin reference in ${configPath}: expected a string path, got ${typeof ref}`,
      );
    }
    const abs = isAbsolute(ref) ? resolve(ref) : resolve(baseDir, ref);
    out.push({
      origin: 'configured',
      layer,
      dir: baseDir,
      path: abs,
      kind: 'reference',
      exists: isFileSafe(abs),
    });
  }
}

// Discovered plugin directories: <level>/plugin{,s}/ and
// <level>/.opencode/plugin{,s}/ — every regular file inside is listed.
function collectDiscoveredPlugins(levelDir, layer, out) {
  for (const name of PLUGIN_DIRNAMES) {
    const dir = join(levelDir, name);
    const entries = listDirSafe(dir);
    if (!entries) continue;
    for (const entry of entries) {
      const p = join(dir, entryName(entry));
      if (!isFileSafe(p)) continue;
      out.push({
        origin: 'discovered',
        layer,
        dir,
        path: p,
        kind: 'file',
        exists: true,
      });
    }
  }
}

// JSON-defined agent blocks inside a config document (doc.agent/agents/
// mode/modes) — reported as an inline agent source pinned to that config.
function collectConfiguredAgentBlocks(doc, configPath, layer, out) {
  const has = doc?.agent != null || doc?.agents != null || doc?.mode != null || doc?.modes != null;
  if (!has) return;
  out.push({
    origin: 'configured',
    layer,
    dir: dirname(configPath),
    path: configPath,
    kind: 'inline-agent-block',
    exists: true,
  });
}

// File-defined agent sources: <level>/agent{,s}/mode{,s}/*.json and the
// same under <level>/.opencode/.
function collectAgentDirFiles(dir, layer, out) {
  const entries = listDirSafe(dir);
  if (!entries) return;
  for (const entry of entries) {
    const p = join(dir, entryName(entry));
    if (!isFileSafe(p)) continue;
    out.push({
      origin: 'discovered',
      layer,
      dir,
      path: p,
      kind: 'agent-file',
      exists: true,
    });
  }
}

function collectLevelAgentFiles(levelDir, layer, out) {
  for (const name of AGENT_DIRNAMES) {
    collectAgentDirFiles(join(levelDir, name), layer, out);
  }
}

// ─── canonical enumerator ────────────────────────────────────────────────────

/**
 * The canonical OpenCode source enumerator.
 *
 * @param {object} input
 * @param {string} input.cwd — exact child working directory (required)
 * @param {string} [input.projectBoundary] — explicit boundary; derived from
 *   cwd via a .git walk when omitted
 * @param {string} [input.home] — home directory override (tests/isolation)
 * @returns {{ configs: Array<object>, plugins: Array<object>, agentSources: Array<object> }}
 *   configs: every candidate config layer in effective order, each with
 *   { path, kind: 'json'|'jsonc', precedence, exists, layer, dir }.
 *   plugins: configured references + discovered plugin files, each with
 *   { origin: 'configured'|'discovered', layer, dir, path, kind, exists }.
 *   agentSources: inline agent blocks + agent/mode dir files, same shape.
 */
export function enumerateOpenCodeSources({ cwd, projectBoundary, home } = {}) {
  if (!cwd) throw new Error('enumerateOpenCodeSources: cwd is required');
  const homeDir = resolve(home || homedir());
  const boundary = projectBoundary
    ? resolve(projectBoundary)
    : resolveOpenCodeProjectBoundary(cwd);
  const levels = layerLevels(cwd, boundary);

  const configs = [];
  const plugins = [];
  const agentSources = [];
  const globalDir = join(homeDir, '.config', 'opencode');

  let precedence = 0;
  const pushConfig = (path, layer, levelDir) => {
    const kind = path.endsWith('.jsonc') ? 'jsonc' : 'json';
    const exists = isFileSafe(path);
    configs.push({
      path,
      kind,
      precedence: precedence++,
      exists,
      layer,
      dir: levelDir,
      // Top-level model declared in THIS layer (undefined when the layer is
      // absent or declares none). Model inspection reads exactly this.
      model: exists
        ? parsedModelOf(path)
        : undefined,
    });
  };

  // 1. global layer
  for (const base of CONFIG_BASENAMES) {
    pushConfig(join(globalDir, base), 'global', globalDir);
  }

  // 2. direct layers, root -> cwd
  for (const levelDir of levels) {
    for (const base of CONFIG_BASENAMES) {
      pushConfig(join(levelDir, base), 'direct', levelDir);
    }
  }

  // 3. .opencode layers, root -> cwd
  for (const levelDir of levels) {
    const dotDir = join(levelDir, '.opencode');
    for (const base of CONFIG_BASENAMES) {
      pushConfig(join(dotDir, base), 'opencode-dir', dotDir);
    }
  }

  // Parse every existing config (fail closed on unreadable/malformed) and
  // collect configured plugin references + inline agent blocks.
  for (const c of configs) {
    if (!c.exists) continue;
    const doc = parseOpenCodeDocument(readTextFailClosed(c.path), { path: c.path });
    collectConfiguredPlugins(doc, c.path, c.layer, plugins);
    collectConfiguredAgentBlocks(doc, c.path, c.layer, agentSources);
  }

  // Discovered plugin dirs at every level: global, boundary..cwd direct,
  // and each level's .opencode/.
  collectDiscoveredPlugins(globalDir, 'global', plugins);
  for (const levelDir of levels) {
    collectDiscoveredPlugins(levelDir, 'direct', plugins);
    collectDiscoveredPlugins(join(levelDir, '.opencode'), 'opencode-dir', plugins);
  }

  // Agent/mode dir files at every level: global + boundary..cwd direct and
  // their .opencode/ counterparts.
  collectLevelAgentFiles(globalDir, 'global', agentSources);
  for (const levelDir of levels) {
    collectLevelAgentFiles(levelDir, 'direct', agentSources);
    collectLevelAgentFiles(join(levelDir, '.opencode'), 'opencode-dir', agentSources);
  }

  return { configs, plugins, agentSources };
}

// existsSync kept for callers that only need a cheap presence probe.
export { existsSync };

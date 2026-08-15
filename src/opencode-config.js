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
      let closed = false;
      while (i < src.length) {
        if (src[i] === '*' && src[i + 1] === '/') {
          closed = true;
          break;
        }
        i += 1;
      }
      // Round-3 parse parity: an unterminated block comment is a parse error
      // in the engine's jsonc-parser. Silently consuming it to EOF made a
      // truncated document parse as its complete prefix — OpenCode would
      // reject the layer and run a DIFFERENT baseline than the preflight
      // verified. Fail closed instead.
      if (!closed) {
        const where = sourcePath ? ` ${sourcePath}` : '';
        throw new Error(`Failed to parse OpenCode document${where}: unterminated block comment`);
      }
      i += 2;
      continue;
    }
    // Trailing commas (review P3-13 + round-2 #6): removed INSIDE the
    // string-aware state machine — a regex over the whole document would
    // also rewrite string contents (`{"pattern":"value,}"}` used to become
    // `{"pattern":"value}"}`). When a comma is followed only by whitespace
    // and/or COMMENTS up to a closing } or ], drop it; inside strings we
    // never land in this branch, so string commas are untouchable. The
    // comment case is real: `{"model":"x", /* why */ }` used to keep the
    // comma (lookahead saw `/`), the comment was then stripped, and the
    // leftover trailing comma broke JSON.parse.
    if (ch === ',') {
      let j = i + 1;
      while (j < src.length) {
        if (/\s/.test(src[j])) {
          j += 1;
          continue;
        }
        if (src[j] === '/' && src[j + 1] === '/') {
          while (j < src.length && src[j] !== '\n') j += 1;
          continue;
        }
        if (src[j] === '/' && src[j + 1] === '*') {
          j += 2;
          while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j += 1;
          j += 2;
          continue;
        }
        break;
      }
      if (src[j] === '}' || src[j] === ']') {
        i = j; // skip the comma AND the skipped whitespace/comments
        continue;
      }
    }
    out += ch;
    i += 1;
  }
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
const TOOL_DIRNAMES = ['tool', 'tools'];

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

// Tolerant variant for model INSPECTION (coder models / status): a malformed
// layer must not crash the whole inspection — the layer is marked with its
// parse error instead, and role resolution reports it (P2-10 contract).
function tolerantParsedModelOf(path) {
  try {
    return parsedModelOf(path);
  } catch (err) {
    return { __parseError: { path, message: err.message } };
  }
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

// File-defined agent sources: <level>/agent{,s}/mode{,s}/** and the same
// under <level>/.opencode/. RECURSIVE (review round-3 P1-4): OpenCode
// discovers agents through the whole subtree, so a nested
// .opencode/agents/nested/evil.md used to be invisible to the preflight while
// still loadable by the engine. statSync (symlink-following) mirrors the
// engine's glob: a symlinked file or dir is discovered just like its target.
function collectAgentDirFiles(dir, layer, out, depth = 0, kind = 'agent-file') {
  const entries = listDirSafe(dir);
  if (!entries) return;
  // Depth cap is a pathological-tree guard (symlink loops resolve through
  // realpath'd dirs only up to here), not a discovery limit — real agent
  // trees are 2–3 levels deep.
  if (depth > 16) {
    throw new Error(`Cannot enumerate OpenCode agent directory ${dir}: nested too deep (symlink loop?)`);
  }
  for (const entry of entries) {
    const p = join(dir, entryName(entry));
    let st;
    try {
      st = statSync(p);
    } catch (err) {
      if (err?.code === 'ENOENT') continue; // broken symlink — unloadable
      throw new Error(`Cannot stat OpenCode source ${p}: ${err.message}`, { cause: err });
    }
    if (st.isDirectory()) {
      collectAgentDirFiles(p, layer, out, depth + 1, kind);
      continue;
    }
    if (!st.isFile()) continue;
    out.push({
      origin: 'discovered',
      layer,
      dir,
      path: p,
      kind,
      exists: true,
    });
  }
}

function collectLevelAgentFiles(levelDir, layer, out) {
  for (const name of AGENT_DIRNAMES) {
    collectAgentDirFiles(join(levelDir, name), layer, out);
  }
}

// Custom tool sources (review round-3 P0-1): .opencode/{tool,tools}/** and
// the global config root's tool{,s}/. Every regular file is a top-level
// executable surface imported INSIDE the OpenCode process with the provider
// credential in `process.env` — the beta preflight rejects them all.
function collectToolDirFiles(levelDir, layer, out) {
  for (const name of TOOL_DIRNAMES) {
    collectAgentDirFiles(join(levelDir, name), layer, out, 0, 'tool-file');
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
 * @returns {{ configs: Array<object>, plugins: Array<object>, agentSources: Array<object>, toolSources: Array<object> }}
 *   configs: every candidate config layer in effective order, each with
 *   { path, kind: 'json'|'jsonc', precedence, exists, layer, dir }.
 *   plugins: configured references + discovered plugin files, each with
 *   { origin: 'configured'|'discovered', layer, dir, path, kind, exists }.
 *   agentSources: inline agent blocks + agent/mode dir files (recursive),
 *   same shape. toolSources: custom tool dir files (recursive), same shape.
 */
export function enumerateOpenCodeSources({ cwd, projectBoundary, home, tolerantParsing = false } = {}) {
  if (!cwd) throw new Error('enumerateOpenCodeSources: cwd is required');
  const homeDir = resolve(home || homedir());
  const boundary = projectBoundary
    ? resolve(projectBoundary)
    : resolveOpenCodeProjectBoundary(cwd);
  const levels = layerLevels(cwd, boundary);

  const configs = [];
  const plugins = [];
  const agentSources = [];
  const toolSources = [];
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
        ? (tolerantParsing ? tolerantParsedModelOf(path) : parsedModelOf(path))
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

  // Parse every existing config and collect configured plugin references +
  // inline agent blocks. Strict by default (fail closed on malformed — the
  // V2 preflight contract); tolerantParsing skips plugin/agent collection
  // for a malformed layer and lets the configs[] marker carry the error.
  for (const c of configs) {
    if (!c.exists) continue;
    let doc;
    try {
      doc = parseOpenCodeDocument(readTextFailClosed(c.path), { path: c.path });
    } catch (err) {
      if (tolerantParsing) continue; // error already surfaced via c.model.__parseError
      throw err;
    }
    collectConfiguredPlugins(doc, c.path, c.layer, plugins);
    collectConfiguredAgentBlocks(doc, c.path, c.layer, agentSources);
  }

  // Discovered plugin dirs: global config root + each level's .opencode/
  // ONLY (review P2-11). Bare `plugins/` inside a random project level is
  // NOT an OpenCode source in the pinned build — the official migration
  // docs enumerate `.opencode/plugin(s)` (and direct dirs only under the
  // GLOBAL config root), so scanning bare project `plugins/` produced
  // false-positive V2 blocks on ordinary app trees.
  collectDiscoveredPlugins(globalDir, 'global', plugins);
  for (const levelDir of levels) {
    collectDiscoveredPlugins(join(levelDir, '.opencode'), 'opencode-dir', plugins);
  }

  // Agent/mode dir files: global config root + each level's .opencode/ only
  // (review P2-11 — same reasoning as plugins above).
  collectLevelAgentFiles(globalDir, 'global', agentSources);
  for (const levelDir of levels) {
    collectLevelAgentFiles(join(levelDir, '.opencode'), 'opencode-dir', agentSources);
  }

  // Custom tool dirs (review round-3 P0-1): same discovery scopes as plugins —
  // global config root + each level's .opencode/.
  collectToolDirFiles(globalDir, 'global', toolSources);
  for (const levelDir of levels) {
    collectToolDirFiles(join(levelDir, '.opencode'), 'opencode-dir', toolSources);
  }

  return { configs, plugins, agentSources, toolSources };
}

// existsSync kept for callers that only need a cheap presence probe.
export { existsSync };

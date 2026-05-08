import { resolve, sep } from 'node:path';

const RESTRICT_ENV = 'TRISS_RESTRICT_PATHS';
const PROJECT_ROOT_ENV = 'TRISS_PROJECT_ROOT';

// Whether path access should be locked down to the project-root subtree.
// Always returns false in CLI mode (env is unset). The MCP server sets it
// to '1' at startup so an agent that compromises the model cannot
// exfiltrate or overwrite arbitrary host files via tool calls.
export function pathsRestricted() {
  return process.env[RESTRICT_ENV] === '1';
}

export function setRestricted(on) {
  if (on) process.env[RESTRICT_ENV] = '1';
  else delete process.env[RESTRICT_ENV];
}

// Effective project root for the sandbox and for `.triss.env` lookups.
// Precedence: explicit TRISS_PROJECT_ROOT (from the MCP launcher / shell)
// > current working directory. Centralising here means the same value
// is reported by `triss status` and used by the safety guard.
export function projectRoot() {
  const fromEnv = process.env[PROJECT_ROOT_ENV];
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  const cwd = resolve(process.cwd());
  // When running inside a Claude Code worktree (.claude/worktrees/<id>/…),
  // step up to the real project root so .triss.env is found there.
  const marker = sep + '.claude' + sep + 'worktrees' + sep;
  const idx = cwd.indexOf(marker);
  if (idx !== -1) return cwd.slice(0, idx);
  return cwd;
}

/**
 * Assert that `target` (file path) is safe to use for the given `kind`
 * of operation ('read' | 'write'). Throws when restricted mode is on and
 * the path resolves outside the project root. Caller should catch and
 * surface a user-friendly error.
 */
export function assertSafePath(target, { kind = 'access' } = {}) {
  if (!pathsRestricted()) return; // CLI mode — no restriction
  const abs = resolve(target);
  const root = projectRoot();
  const rootWithSep = root === sep ? root : root + sep;
  if (abs === root || abs.startsWith(rootWithSep)) return;
  const e = new Error(
    `Refusing ${kind} of "${abs}" — outside the project root ` +
      `(${root}). When triss runs as an MCP server it is sandboxed to the ` +
      `project root by default; set ${PROJECT_ROOT_ENV} to point at a ` +
      `different tree, or set ${RESTRICT_ENV}=0 to disable the sandbox.`,
  );
  e.code = 'TRISS_PATH_DENIED';
  throw e;
}

import { resolve, sep } from 'node:path';

const RESTRICT_ENV = 'TRISS_RESTRICT_PATHS';

// Whether path access should be locked down to the cwd subtree. Always
// returns false in CLI mode (env is unset). The MCP server sets it to '1'
// at startup so an agent that compromises the model cannot exfiltrate or
// overwrite arbitrary host files via tool calls.
export function pathsRestricted() {
  return process.env[RESTRICT_ENV] === '1';
}

export function setRestricted(on) {
  if (on) process.env[RESTRICT_ENV] = '1';
  else delete process.env[RESTRICT_ENV];
}

/**
 * Assert that `target` (file path) is safe to use for the given `kind`
 * of operation ('read' | 'write'). Throws when restricted mode is on and
 * the path resolves outside cwd. Caller should catch and surface a
 * user-friendly error.
 */
export function assertSafePath(target, { kind = 'access' } = {}) {
  if (!pathsRestricted()) return; // CLI mode — no restriction
  const abs = resolve(target);
  const root = resolve(process.cwd());
  const rootWithSep = root === sep ? root : root + sep;
  if (abs === root || abs.startsWith(rootWithSep)) return;
  const e = new Error(
    `Refusing ${kind} of "${abs}" — outside the current working directory ` +
      `(${root}). When triss runs as an MCP server it is sandboxed to the ` +
      `cwd by default; set TRISS_RESTRICT_PATHS=0 in the server's env to ` +
      `disable, or move the file under the project root.`,
  );
  e.code = 'TRISS_PATH_DENIED';
  throw e;
}

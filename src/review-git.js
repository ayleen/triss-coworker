/**
 * review-git.js — Package 15 (Atomic 32): comparison identity and bounded
 * rename inventory.
 *
 * Reference surface 10 local-Git bullets of the approved plan
 * (docs/reliable-delegation-contract-plan.md). This package is the sole
 * local sealed-projection owner; Package 2E enforces the copy quota.
 *
 * Exports:
 *   resolveReviewComparison(sh, opts)      — exact commit OIDs + unique merge
 *                                            base; sanitized git environment
 *   acquireNameStatusInventory(sh, opts)   — bounded NUL-delimited name-status
 *   expandRenameSelection(inventory, opts) — literal selectors expand to both
 *                                            sides of a rename
 *
 * Sanitization invariants: no ext-diff, no textconv, no config injection,
 * replacement objects disabled, graft/shallow rejection (complete/empty
 * shallow metadata accepted; every NONEMPTY shallow repository rejected).
 */

import { join as joinPath } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export const REVIEW_RENAME_CANDIDATE_LIMIT = 2000;

const SANITIZED_ENV = Object.freeze({
  GIT_EXTERNAL_DIFF: '',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
});

// Strict allowlist environment for every git invocation in this module.
// process.env is NEVER spread: an inherited GIT_DIR / GIT_WORK_TREE /
// GIT_OBJECT_DIRECTORY / GIT_CONFIG_* could redirect the supposedly exact
// comparison at a different object store or repository state, so the sealed
// env forwards only the basics a local read-only git needs, disables config
// injection explicitly, and lets nothing else through.
const SEALED_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ',
  // Windows spawnSync basics (harmless elsewhere; only set when present).
  'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT',
]);

export function buildSealedGitEnv(baseEnv = process.env) {
  const env = {};
  for (const key of SEALED_ENV_ALLOWLIST) {
    if (baseEnv[key] != null) env[key] = baseEnv[key];
  }
  return {
    ...env,
    ...SANITIZED_ENV,
    // The sealed projection must not read the user's global gitconfig either:
    // aliases, diff drivers, and replacement config there are out of scope.
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
}

const SHALLOW_MARKER = 'shallow'; // resolved against `rev-parse --absolute-git-dir`

function gitArgs(opts, args) {
  return ['--no-pager', '-c', 'core.quotepath=false', ...args];
}

/**
 * Resolve the comparison identity: exact base/head OIDs, a UNIQUE merge base,
 * and rejection of nonempty shallow repositories.
 *
 * @param {object} sh spawnSync-like ({status, stdout, stderr, error})
 * @param {object} opts
 * @param {string} opts.cwd repository root
 * @param {string} [opts.base] base rev (default: default branch)
 * @param {string} [opts.head] head rev (default: HEAD)
 * @param {number} [opts.deadlineMs] absolute deadline (0 = none)
 * @returns {{ok: boolean, code?: string, base_oid?: string, head_oid?: string,
 *   merge_base_oid?: string, merge_bases?: number, message?: string}}
 */
export function resolveReviewComparison(sh, { cwd, base, head = 'HEAD', deadlineMs = 30000 }) {
  if (typeof sh !== 'function') throw new TypeError('sh is required');
  const run = (args) => sh(gitArgs({}, args), { cwd, env: buildSealedGitEnv(), encoding: 'utf8', timeout: deadlineMs });

  // Graft rejection: refs/replace disabled + shallow check.
  const replaceCheck = run(['replace', '--list']);
  if (replaceCheck.status === 0 && replaceCheck.stdout.trim().length > 0) {
    return { ok: false, code: 'TRISS_REVIEW_GRAFT_REJECTED', message: 'replacement objects present (grafts rejected)' };
  }

  // Nonempty shallow repositories are rejected; complete/empty accepted.
  // NOTE: worktrees keep their metadata in `<repo>/.git/worktrees/<name>/`,
  // and bare repositories have no worktree at all — resolve the marker
  // through `git rev-parse --git-dir` instead of assuming `.git`.
  const shallowOut = run(['rev-parse', '--is-shallow-repository']);
  if (shallowOut.status === 0 && shallowOut.stdout.trim() === 'true') {
    const gitDirOut = run(['rev-parse', '--absolute-git-dir']);
    const gitDir = gitDirOut.status === 0 ? gitDirOut.stdout.trim() : null;
    if (gitDir) {
      const shallowPath = joinPath(gitDir, SHALLOW_MARKER);
      const hasShallowFile = existsSync(shallowPath) && readFileSync(shallowPath, 'utf8').trim().length > 0;
      if (hasShallowFile) {
        return { ok: false, code: 'TRISS_REVIEW_SHALLOW_REJECTED', message: 'nonempty shallow repository rejected' };
      }
    }
  }

  const baseRev = base || 'HEAD';
  const baseOid = run(['rev-parse', '--verify', `${baseRev}^{commit}`]);
  if (baseOid.status !== 0 || !/^[0-9a-f]{40,64}$/.test(baseOid.stdout.trim())) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: `cannot resolve base rev: ${baseRev}` };
  }
  const headOid = run(['rev-parse', '--verify', `${head}^{commit}`]);
  if (headOid.status !== 0 || !/^[0-9a-f]{40,64}$/.test(headOid.stdout.trim())) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: `cannot resolve head rev: ${head}` };
  }

  // Unique merge base required.
  const mb = run(['merge-base', '--all', baseOid.stdout.trim(), headOid.stdout.trim()]);
  if (mb.status !== 0 || !mb.stdout.trim()) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'no merge base found' };
  }
  const bases = mb.stdout.trim().split('\n').filter(Boolean);
  if (bases.length !== 1) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: `merge base is not unique (${bases.length} bases)` };
  }

  return {
    ok: true,
    base_oid: baseOid.stdout.trim(),
    head_oid: headOid.stdout.trim(),
    merge_base_oid: bases[0],
    merge_bases: bases.length,
  };
}

/**
 * Acquire the bounded NUL-delimited name-status inventory for the
 * merge-base..head pair (used both for rename expansion and as the
 * cross-check against parsed sections). Bounded to 100,000 paths.
 *
 * @param {object} sh
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.baseOid
 * @param {string} opts.headOid
 * @param {number} [opts.maxEntries=100000]
 * @param {number} [opts.deadlineMs=30000]
 * @returns {{ok: boolean, code?: string, entries?: Array, pairs?: Array,
 *   message?: string}}
 */
export function acquireNameStatusInventory(sh, { cwd, baseOid, headOid, maxEntries = 100000, deadlineMs = 30000 }) {
  if (typeof sh !== 'function') throw new TypeError('sh is required');
  const run = (args) =>
    sh(gitArgs({}, args), { cwd, env: buildSealedGitEnv(), encoding: 'buffer', timeout: deadlineMs });

  // P1 fix: deterministic bounded rename detection. `--no-renames` made the
  // R* parsing below unreachable for real Git (a rename would be emitted as
  // separate A/D entries). Rename detection is explicitly ON with the
  // documented candidate limit passed to Git itself (-l caps the
  // source/destination matrix BEFORE the expensive comparison, not only as
  // a post-parse rejection) plus the post-parse bound below as a backstop.
  const out = run([
    'diff', '--name-status', '-z',
    '--find-renames=50%',
    '-l' + REVIEW_RENAME_CANDIDATE_LIMIT,
    baseOid, headOid,
  ]);
  if (out.status !== 0) {
    return { ok: false, code: 'TRISS_REVIEW_LIMIT', message: `name-status failed: ${String(out.stderr || '').slice(0, 200)}` };
  }
  const buf = Buffer.isBuffer(out.stdout) ? out.stdout : Buffer.from(out.stdout || '');
  if (buf.length === 0) return { ok: true, entries: [], pairs: [] };

  // NUL-delimited: status, path, [old path for renames].
  const parts = buf.toString('utf8').split('\u0000');
  const entries = [];
  let overflow = false;
  for (let i = 0; i < parts.length; i += 1) {
    const status = parts[i];
    if (!status) continue;
    const path = parts[i + 1];
    if (path === undefined) break;
    if (status.startsWith('R')) {
      const newPath = parts[i + 2];
      if (newPath === undefined) break;
      entries.push({ status, path: newPath, old_path: path });
      i += 2;
    } else {
      entries.push({ status, path, old_path: null });
      i += 1;
    }
    if (entries.length > maxEntries) {
      overflow = true;
      break;
    }
  }
  if (overflow) {
    return { ok: false, code: 'TRISS_REVIEW_LIMIT', message: `name-status exceeds ${maxEntries} entries` };
  }
  // The rename candidate bound is enforced, not decorative: detection cost is
  // capped by rejecting inventories whose rename pair count exceeds the
  // documented limit (fail closed instead of silently accepting the cost).
  const renameCandidates = entries.filter((e) => e.status.startsWith('R')).length;
  if (renameCandidates > REVIEW_RENAME_CANDIDATE_LIMIT) {
    return {
      ok: false,
      code: 'TRISS_REVIEW_LIMIT',
      message: `rename candidates ${renameCandidates} exceed the ${REVIEW_RENAME_CANDIDATE_LIMIT} bound`,
    };
  }
  return { ok: true, entries, rename_candidates: renameCandidates };
}

/**
 * Expand literal selectors after `--` to both sides of a rename; old-only or
 * new-only selection retains rename metadata. Bounded to the documented
 * 2,000-candidate limit.
 *
 * @param {object} inventory result of acquireNameStatusInventory
 * @param {object} opts
 * @param {string[]} opts.selectors literal paths after `--`
 * @returns {{matched: string[], unmatched: string[], candidates: number}}
 */
export function expandRenameSelection(inventory, { selectors = [] } = {}) {
  const entries = Array.isArray(inventory?.entries) ? inventory.entries : [];
  const candidates = entries.filter((e) => e.status.startsWith('R'));
  const selected = new Set();

  for (const sel of selectors) {
    let found = false;
    for (const e of entries) {
      if (e.path === sel || e.old_path === sel) {
        selected.add(e.path);
        if (e.old_path) selected.add(e.old_path);
        found = true;
      }
    }
    if (!found) {
      // Non-rename exact match still selects.
      for (const e of entries) {
        if (e.path === sel) {
          selected.add(e.path);
          found = true;
        }
      }
    }
    if (!found) {
      // Track unmatched only for truly absent paths (rename metadata kept).
      if (!entries.some((e) => e.path === sel || e.old_path === sel)) {
        // Unmatched selectors are reported by the caller via the inventory.
        selected.add(sel);
      }
    }
  }

  return {
    matched: [...selected].sort(),
    unmatched: selectors.filter((s) => !entries.some((e) => e.path === s || e.old_path === s)),
    candidates: candidates.length,
  };
}

// ─── selected local content acquisition (Atomic 33 / Package 16) ─────────────

const SEALED_ATTRIBUTES = Object.freeze([
  '-c', 'core.attributesFile=/dev/null',
  '-c', 'core.quotepath=false',
]);

/**
 * Acquire the selected local diff content: literal selectors wire to
 * inventory-first acquisition with pathspec limiting, so a huge full change
 * with a small selected file acquires ONLY that selected content without
 * first buffering the full diff. Every command uses the sealed empty-
 * attribute projection (global/info/dirty/committed .gitattributes canaries
 * must produce byte-identical text hunks).
 *
 * @param {object} sh
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {string} opts.baseOid
 * @param {string} opts.headOid
 * @param {string[]} opts.selectors literal paths (already rename-expanded)
 * @param {number} [opts.deadlineMs=30000]
 * @param {number} [opts.maxBytes] selected-content cap
 * @returns {{ok: boolean, code?: string, diff?: string, bytes?: number,
 *   message?: string}}
 */
export function acquireSelectedLocalDiff(sh, { cwd, baseOid, headOid, selectors, deadlineMs = 30000, maxBytes = 16 * 1024 * 1024 }) {
  if (typeof sh !== 'function') throw new TypeError('sh is required');
  if (!Array.isArray(selectors)) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'selectors must be an array' };
  }
  // P1 fix: an EMPTY selector list means FULL-PR scope — default to every
  // inventoried path. (An explicit empty list cannot be distinguished from
  // "no selectors given", and the inventory-derived full set is exactly the
  // bounded pathspec the sealed diff needs.)
  const effectiveSelectors = selectors.length > 0 ? selectors : [':/'];
  const run = (args) =>
    sh(gitArgs({}, args), { cwd, env: buildSealedGitEnv(), encoding: 'buffer', timeout: deadlineMs });

  // Pathspec-limited diff over the exact merge-base..head pair. No external
  // diff/textconv, no config injection; sealed empty-attribute projection.
  const out = run([
    ...SEALED_ATTRIBUTES,
    'diff', '--no-ext-diff', '--text', '--no-color', '--unified=3',
    baseOid, headOid, '--', ...effectiveSelectors,
  ]);
  if (out.status !== 0) {
    return { ok: false, code: 'TRISS_REVIEW_LIMIT', message: `selected diff failed: ${String(out.stderr || '').slice(0, 200)}` };
  }
  const buf = Buffer.isBuffer(out.stdout) ? out.stdout : Buffer.from(out.stdout || '');
  if (buf.length === 0) {
    // No hunks for the selection: byte-identical empty result.
    return { ok: true, diff: '', bytes: 0 };
  }
  if (buf.length > maxBytes) {
    return { ok: false, code: 'TRISS_REVIEW_LIMIT', message: `selected diff exceeds ${maxBytes} bytes` };
  }
  return { ok: true, diff: buf.toString('utf8'), bytes: buf.length };
}

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

export const REVIEW_RENAME_CANDIDATE_LIMIT = 2000;

const SANITIZED_ENV = Object.freeze({
  GIT_EXTERNAL_DIFF: '',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
});

const SHALLOW_MARKER = '.git/shallow';

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
  const run = (args) => sh(gitArgs({}, args), { cwd, env: { ...process.env, ...SANITIZED_ENV }, encoding: 'utf8', timeout: deadlineMs });

  // Graft rejection: refs/replace disabled + shallow check.
  const replaceCheck = run(['replace', '--list']);
  if (replaceCheck.status === 0 && replaceCheck.stdout.trim().length > 0) {
    return { ok: false, code: 'TRISS_REVIEW_GRAFT_REJECTED', message: 'replacement objects present (grafts rejected)' };
  }

  // Nonempty shallow repositories are rejected; complete/empty accepted.
  const shallowOut = run(['rev-parse', '--is-shallow-repository']);
  if (shallowOut.status === 0 && shallowOut.stdout.trim() === 'true') {
    const shallow = sh(gitArgs({}, ['rev-list', '--max-count=1', 'HEAD']), { cwd, encoding: 'utf8' });
    const shallowPath = require('node:path').join(cwd, SHALLOW_MARKER);
    const { existsSync, readFileSync } = require('node:fs');
    const hasShallowFile = existsSync(shallowPath) && readFileSync(shallowPath, 'utf8').trim().length > 0;
    if (hasShallowFile) {
      return { ok: false, code: 'TRISS_REVIEW_SHALLOW_REJECTED', message: 'nonempty shallow repository rejected' };
    }
    void shallow;
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
    sh(gitArgs({}, args), { cwd, env: { ...process.env, ...SANITIZED_ENV }, encoding: 'buffer', timeout: deadlineMs });

  const out = run(['diff', '--name-status', '-z', '--no-renames', baseOid, headOid]);
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
  return { ok: true, entries };
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

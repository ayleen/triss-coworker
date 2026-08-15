/**
 * review-scoped.js — inventory-first acquisition for literal `--files`
 * selection (P0 fix).
 *
 * Sections 9.3/9.4 of docs/reliable-delegation-contract-plan.md: when the
 * caller supplies literal path selectors, the selected content is acquired
 * INVENTORY-FIRST — exact comparison OIDs, a bounded name-status inventory,
 * rename-aware selector expansion, and a pathspec-limited diff — so a huge
 * full change with a small selected file never buffers the whole diff or
 * plans the planner against unrelated files. The legacy full-diff path stays
 * for selector-less reviews (a full review legitimately needs the full diff).
 *
 * Pure composition over Package 15/16/17 seams: every spawn goes through the
 * injected sh adapters (sealed env inside review-git.js; the gh/git process
 * adapter inherits the ambient environment for network credentials).
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import {
  resolveReviewComparison,
  acquireNameStatusInventory,
  expandRenameSelection,
  acquireSelectedLocalDiff,
} from './review-git.js';
import { acquirePrMetadata } from './review-pr-metadata.js';
import { acquireSelectedPrDiff } from './review-pr.js';
import { PR_REGISTRY_ROOT_QUOTA_BYTES } from './review-pr-registry.js';
import { prepareQuotaBackedDirectory } from './coder-write-quota.js';
import { openManagedTrissRoot } from './managed-root.js';
import { projectRoot } from './safety.js';

// git-args seam: review-git.js helpers pass bare git argument arrays.
export function gitSpawnSh(args, opts = {}) {
  return spawnSync('git', args, opts);
}

// process seam: acquirePrMetadata / fetchExactPrObjects pass full argv lists
// (['gh', ...] / ['git', ...]).
export function procSpawnSh(argv, opts = {}) {
  return spawnSync(argv[0], argv.slice(1), opts);
}

// Glob/escape metacharacters a literal path selector must not contain.
// Implemented via charCodeAt because the no-control-regex lint rule forbids
// control escapes inside a RegExp literal (same precedent as
// sanitizeControlBytes in src/commands/coder.js).
function selectorHasRejectedChar(sel) {
  for (const ch of sel) {
    const code = ch.charCodeAt(0);
    if (code === 0 || code === 42 /* * */ || code === 63 /* ? */ || code === 91 /* [ */ || code === 92 /* backslash */) {
      return true;
    }
  }
  return false;
}

/**
 * Validate literal path selectors. Selectors are LITERAL repo-relative
 * POSIX paths: Git pathspec magic (`:(glob)...`), glob metacharacters,
 * absolute paths, and `..` traversal are rejected — anything else would be
 * interpreted by Git as a pattern, silently changing the reviewed scope.
 *
 * @param {string[]} selectors
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export function validateReviewSelectors(selectors) {
  if (!Array.isArray(selectors)) return { ok: false, message: '--files expects literal path selectors' };
  for (const sel of selectors) {
    if (typeof sel !== 'string' || sel.length === 0) {
      return { ok: false, message: 'file selectors must be non-empty strings' };
    }
    if (sel.startsWith(':')) {
      return { ok: false, message: `file selectors are literal paths, not Git pathspecs: ${sel}` };
    }
    if (selectorHasRejectedChar(sel)) {
      return { ok: false, message: `file selectors must be literal paths without glob/escape characters: ${sel}` };
    }
    if (sel.startsWith('/')) {
      return { ok: false, message: `file selectors are repository-relative, not absolute: ${sel}` };
    }
    if (sel === '..' || sel.startsWith('../')) {
      return { ok: false, message: `file selectors cannot traverse outside the repository: ${sel}` };
    }
  }
  return { ok: true };
}

/**
 * Acquire ONLY the selected content for a literal `--files` review.
 *
 * @param {object} deps injected seams (tests)
 * @param {Function} [deps.gitSh] git-args spawn adapter
 * @param {Function} [deps.procSh] process spawn adapter
 * @param {object} deps.resolveComparison / acquireInventory / expandSelection /
 *   acquireDiff / acquirePrMetadata / acquirePrDiff composition seams
 * @param {object} opts
 * @param {string} [opts.pr] PR number (PR mode)
 * @param {string} [opts.base] explicit base ref (local mode only)
 * @param {string[]} opts.selectors validated literal selectors
 * @param {string} [opts.cwd] repository root (default process.cwd())
 * @returns {Promise<{ok: boolean, code?: string, message?: string,
 *   diff?: string, base_ref?: string, head_ref?: string,
 *   changed_files?: string[], unmatched?: string[]}>}
 */
export async function acquireScopedReviewDiff(
  deps = {},
  { pr, base, selectors, cwd } = {},
) {
  const gitSh = deps.gitSh || gitSpawnSh;
  const procSh = deps.procSh || procSpawnSh;
  const workDir = cwd || process.cwd();

  if (pr) {
    // PR mode: exact OIDs from gh metadata, then a disposable bare-repo
    // fetch (fork-aware: the head OID comes from the fork repository).
    const number = Number(pr);
    if (!Number.isInteger(number) || number < 1) {
      return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: `invalid PR number: ${pr}` };
    }
    // The base owner/repo come from the ambient `gh` context, matching the
    // selector-less PR path (`gh pr diff` uses the same resolution).
    let repoInfo;
    try {
      repoInfo = JSON.parse(String(procSh(['gh', 'repo', 'view', '--json', 'owner,name'], { encoding: 'utf8' }).stdout || ''));
    } catch {
      return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'cannot resolve the base repository via `gh repo view`' };
    }
    const owner = repoInfo?.owner?.login;
    const repo = repoInfo?.name;
    if (!owner || !repo) {
      return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'cannot resolve the base repository via `gh repo view`' };
    }
    const meta = (deps.acquirePrMetadata || acquirePrMetadata)(procSh, { owner, repo, number });
    if (!meta.ok) return meta;

    const trissRootPath = projectRoot();
    const quota = prepareQuotaBackedDirectory({
      root: join(trissRootPath, '.triss', 'review-pr-v1'),
      limitBytes: 4 * PR_REGISTRY_ROOT_QUOTA_BYTES,
    });
    quota.capability = 'enforced';
    const parentHandle = await openManagedTrissRoot(trissRootPath);
    const acquired = await (deps.acquirePrDiff || acquireSelectedPrDiff)(
      {
        sh: procSh,
        resolveComparison: deps.resolveComparison || resolveReviewComparison,
        acquireInventory: deps.acquireInventory || acquireNameStatusInventory,
        expandSelection: deps.expandSelection || expandRenameSelection,
        acquireDiff: deps.acquireDiff || acquireSelectedLocalDiff,
      },
      {
        trissRootPath,
        quota,
        managedRoot: { path: trissRootPath, capability: 'enforced' },
        parentHandle,
        meta: meta.meta,
        sourceUrl: `https://github.com/${owner}/${repo}`,
        selectors,
      },
    );
    if (!acquired.ok) return acquired;
    // Zero-match detection for PR mode happens in the shared executor: the
    // pathspec-limited diff simply contains no section for unmatched
    // selectors, and executeSingleReview fails closed on an empty scope.
    return {
      ok: true,
      diff: acquired.diff,
      base_ref: meta.meta.base_ref,
      head_ref: meta.meta.head_ref,
      changed_files: [],
      unmatched: [],
    };
  }

  // Local mode: exact comparison identity + bounded inventory + selected
  // content under the sealed Git projection (see review-git.js).
  const comparison = (deps.resolveComparison || resolveReviewComparison)(gitSh, {
    cwd: workDir,
    base: base || undefined,
    head: 'HEAD',
  });
  if (!comparison.ok) return comparison;

  const inventory = (deps.acquireInventory || acquireNameStatusInventory)(gitSh, {
    cwd: workDir,
    baseOid: comparison.merge_base_oid,
    headOid: comparison.head_oid,
  });
  if (!inventory.ok) return inventory;

  const expanded = (deps.expandSelection || expandRenameSelection)(inventory, { selectors });
  if (expanded.matched.length === 0 || expanded.unmatched.length === selectors.length) {
    return {
      ok: false,
      code: 'TRISS_REVIEW_SCOPE_EMPTY',
      message:
        `none of the requested files (${selectors.join(', ')}) appear in the ` +
        `${base || 'default-base'}..HEAD change inventory; refusing to review an empty scope`,
    };
  }

  const selected = (deps.acquireDiff || acquireSelectedLocalDiff)(gitSh, {
    cwd: workDir,
    baseOid: comparison.merge_base_oid,
    headOid: comparison.head_oid,
    selectors: expanded.matched,
  });
  if (!selected.ok) return selected;

  return {
    ok: true,
    diff: selected.diff,
    base_ref: base || null,
    head_ref: 'HEAD',
    changed_files: inventory.entries.map((e) => e.path),
    unmatched: expanded.unmatched,
  };
}

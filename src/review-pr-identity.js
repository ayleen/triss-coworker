/**
 * review-pr-identity.js — pure PR identity parser.
 *
 * documented contract PR acquisition identity bullets of the approved plan
 * (docs/reliable-delegation-contract-plan.md). Pure: no subprocesses, no gh,
 * no directories, no Git fetch/diff, no CLI/MCP formatting.
 *
 * Exports:
 *   parsePrInput(value, opts)      — canonical input: number, URL, or
 *                                    "owner/repo#number"
 *   validatePrMetadata(meta, opts) — configured-origin matching, --base
 *                                    rejection, bounded metadata schema,
 *                                    fork/base/head equality
 */

const OWNER_REPO_NUMBER_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d{1,9})$/;
const GITHUB_URL_RE = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,9})(?:[/?#].*)?$/i;

/**
 * Parse canonical PR input: a bare number, an https://github.com URL, or
 * owner/repo#number. Rejects arbitrary strings.
 *
 * @param {string} value
 * @param {object} [opts]
 * @param {string} [opts.owner] configured origin owner (for owner/repo#n)
 * @returns {{ok: boolean, code?: string, number?: number,
 *   owner?: string, repo?: string, message?: string}}
 */
export function parsePrInput(value, opts = {}) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'PR input is required' };
  }
  const raw = value.trim();

  // Bare number.
  if (/^\d{1,9}$/.test(raw)) {
    const number = Number(raw);
    if (!opts.owner || !opts.repo) {
      return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'bare PR number requires a configured origin' };
    }
    return { ok: true, number, owner: opts.owner, repo: opts.repo };
  }

  // owner/repo#number.
  const slash = OWNER_REPO_NUMBER_RE.exec(raw);
  if (slash) {
    if (opts.owner && slash[1] !== opts.owner) {
      return {
        ok: false,
        code: 'TRISS_REVIEW_INVALID_INPUT',
        message: `PR owner ${slash[1]} does not match the configured origin ${opts.owner}`,
      };
    }
    return { ok: true, number: Number(slash[3]), owner: slash[1], repo: slash[2] };
  }

  // github.com URL.
  const url = GITHUB_URL_RE.exec(raw);
  if (url) {
    if (opts.owner && url[1] !== opts.owner) {
      return {
        ok: false,
        code: 'TRISS_REVIEW_INVALID_INPUT',
        message: `PR URL owner ${url[1]} does not match the configured origin ${opts.owner}`,
      };
    }
    return { ok: true, number: Number(url[3]), owner: url[1], repo: url[2] };
  }

  return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'expected a PR number, owner/repo#number, or github.com URL' };
}

const METADATA_KEYS = Object.freeze([
  'number',
  'base_oid',
  'head_oid',
  'base_ref',
  'head_ref',
  'fork',
  'owner',
  'repo',
  // Fork identity (Invariant): for cross-repository PRs the head commit lives
  // in the FORK, so acquisition needs the head repository's own coordinates.
  'head_owner',
  'head_repo',
]);

const OID_RE = /^[0-9a-f]{40}$/;

/**
 * Validate bounded PR metadata. Rejects `--base` (PR mode never mixes with
 * an explicit base); fork/base/head equality rules:
 *  - base_oid and head_oid are exact 40-hex OIDs;
 *  - base_ref !== head_ref (a PR cannot compare a ref with itself);
 *  - fork is a boolean.
 *
 * @param {object} meta
 * @param {object} [opts]
 * @param {boolean} [opts.baseGiven] whether the caller passed --base
 * @returns {{ok: boolean, code?: string, message?: string, meta?: object}}
 */
export function validatePrMetadata(meta, opts = {}) {
  if (opts.baseGiven) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: '--base is not allowed with PR input' };
  }
  if (typeof meta !== 'object' || meta === null) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'PR metadata is required' };
  }
  const keys = Object.keys(meta).sort();
  if (keys.join(',') !== [...METADATA_KEYS].sort().join(',')) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: `PR metadata must have exactly the keys: ${METADATA_KEYS.join(', ')}` };
  }
  if (!Number.isInteger(meta.number) || meta.number < 1) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'PR number must be a positive integer' };
  }
  if (typeof meta.base_oid !== 'string' || !OID_RE.test(meta.base_oid)) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'base_oid must be a 40-hex OID' };
  }
  if (typeof meta.head_oid !== 'string' || !OID_RE.test(meta.head_oid)) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'head_oid must be a 40-hex OID' };
  }
  if (meta.base_oid === meta.head_oid) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'base_oid and head_oid must differ' };
  }
  if (typeof meta.base_ref !== 'string' || meta.base_ref.length === 0) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'base_ref is required' };
  }
  if (typeof meta.head_ref !== 'string' || meta.head_ref.length === 0) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'head_ref is required' };
  }
  if (meta.base_ref === meta.head_ref) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'base_ref and head_ref must differ' };
  }
  if (typeof meta.fork !== 'boolean') {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'fork must be a boolean' };
  }
  if (typeof meta.owner !== 'string' || meta.owner.length === 0) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'owner is required' };
  }
  if (typeof meta.repo !== 'string' || meta.repo.length === 0) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'repo is required' };
  }
  if (meta.fork) {
    if (typeof meta.head_owner !== 'string' || meta.head_owner.length === 0) {
      return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'fork PRs require head_owner' };
    }
    if (typeof meta.head_repo !== 'string' || meta.head_repo.length === 0) {
      return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'fork PRs require head_repo' };
    }
  } else if (meta.head_owner !== null || meta.head_repo !== null) {
    return { ok: false, code: 'TRISS_REVIEW_INVALID_INPUT', message: 'head_owner/head_repo must be null for same-repository PRs' };
  }
  return { ok: true, meta };
}

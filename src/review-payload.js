/**
 * review-payload.js — Package 14 (Atomic 31): pure diff parser and coverage
 * model.
 *
 * Reference surface 9 parser/coverage subset of the approved plan
 * (docs/reliable-delegation-contract-plan.md). Pure core: input strings and
 * options in, plan/result out. No Git, GitHub, provider, stdout, or
 * environment reads inside. Package 13's frozen configuration result is
 * injected.
 *
 * Exports:
 *   parseUnifiedDiff(text, opts)        — split `diff --git` sections
 *   deriveReviewCoverage(sections, opts) — repository/requested coverage
 *   planSingleReviewPayload(opts)       — single-request planning with exact
 *                                         byte accounting
 *
 * Shard packing/shard-count enforcement belong to Reference surface 12 /
 * Package 23 — NOT here.
 */

const METADATA_OVERHEAD_BYTES = 4096; // bounded envelope/metadata allowance

/**
 * Decode a Git-quoted path (C-style quoting used by `git -c core.quotepath=`
 * and the diff header) back to its literal string. Pure: no subprocess.
 * Returns null when the quoting is malformed.
 */
export function decodeGitQuotedPath(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (!raw.startsWith('"')) return raw;
  if (!raw.endsWith('"') || raw.length < 2) return null;
  const inner = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = inner[i + 1];
    if (next === undefined) return null;
    i += 1;
    switch (next) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      default: {
        if (next === 'u' && /^[0-9a-fA-F]{4}/.test(inner.slice(i + 1))) {
          out += String.fromCharCode(parseInt(inner.slice(i + 1, i + 5), 16));
          i += 4;
        } else {
          return null; // malformed escape
        }
      }
    }
  }
  return out;
}

function splitSections(text) {
  if (typeof text !== 'string') return [];
  // Preserve CRLF input: sections keep their original bytes; splitting only
  // looks at the `diff --git ` header line start.
  const lines = text.split(/(?:\r\n|\n)/);
  const sections = [];
  let current = null;
  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) sections.push(current);
      current = { header: line, body: [], lineEnding, rawBytes: 0 };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push(current);
  for (const s of sections) {
    s.raw = s.header + s.lineEnding + s.body.join(s.lineEnding) + s.lineEnding;
    s.rawBytes = Buffer.byteLength(s.raw, 'utf8');
  }
  return sections;
}

/**
 * Parse the two path tokens out of a `diff --git a/old b/new` header line.
 * Handles BOTH unquoted (`a/foo b/foo`) and Git C-quoted
 * (`"a/foo bar.txt" "b/foo bar.txt"`) forms with an escape-aware scanner —
 * a naive `(.*) (.*)` split breaks on spaces inside quoted tokens.
 * Returns [oldToken, newToken] or null.
 */
function parseDiffGitHeaderPaths(header) {
  const rest = String(header).slice('diff --git '.length);
  const tokens = [];
  let i = 0;
  while (tokens.length < 2 && i < rest.length) {
    // Skip separating whitespace before a token.
    while (i < rest.length && /\s/.test(rest[i])) i += 1;
    if (i >= rest.length) break;
    if (rest[i] === '"') {
      // Quoted token: consume escapes until the closing quote.
      let token = '"';
      i += 1;
      let closed = false;
      while (i < rest.length) {
        const ch = rest[i];
        if (ch === '\\') {
          if (i + 1 >= rest.length) return null;
          token += ch + rest[i + 1];
          i += 2;
          continue;
        }
        if (ch === '"') {
          closed = true;
          i += 1;
          break;
        }
        token += ch;
        i += 1;
      }
      if (!closed) return null;
      tokens.push(token);
    } else {
      // Unquoted token: runs until the next whitespace.
      let j = i;
      while (j < rest.length && !/\s/.test(rest[j])) j += 1;
      tokens.push(rest.slice(i, j));
      i = j;
    }
  }
  if (tokens.length !== 2) return null;
  return tokens;
}

/**
 * Parse a unified diff into sections. Returns {sections, error}.
 *  - section: {header, raw, old_path, new_path, kind, binary, bytes}
 *  - kind: 'modified' | 'created' | 'deleted' | 'renamed' | 'binary'
 *  - binary detection: /dev/null or GIT binary patch markers.
 */
export function parseUnifiedDiff(text) {
  if (typeof text !== 'string') return { sections: [], error: 'diff input must be a string' };
  if (text.length === 0) return { sections: [], error: null };
  const sections = splitSections(text).map((sec) => {
    const { header } = sec;
    // `diff --git a/old b/new` — quoted and unquoted path forms both
    // supported (see parseDiffGitHeaderPaths).
    const tokens = parseDiffGitHeaderPaths(header);
    let oldPath = null;
    let newPath = null;
    if (tokens) {
      oldPath = decodeGitQuotedPath(tokens[0].replace(/^a\//, ''));
      newPath = decodeGitQuotedPath(tokens[1].replace(/^b\//, ''));
    }
    const body = sec.body;
    const isBinary =
      body.some((l) => /^GIT binary patch$/.test(l) || /^Binary files .* differ$/.test(l)) ||
      body.some((l) => l.startsWith('index ') && /\.\./.test(l) && !l.includes('100'));
    const oldIsNull = body.some((l) => l.startsWith('--- /dev/null'));
    const newIsNull = body.some((l) => l.startsWith('+++ /dev/null'));
    const rename = body.some((l) => l.startsWith('rename from ') || l.startsWith('rename to '));
    let kind = 'modified';
    if (isBinary) kind = 'binary';
    else if (oldIsNull) kind = 'created';
    else if (newIsNull) kind = 'deleted';
    else if (rename) kind = 'renamed';
    return {
      header,
      raw: sec.raw,
      old_path: oldPath,
      new_path: newPath,
      kind,
      binary: isBinary,
      bytes: sec.rawBytes,
    };
  });
  return { sections, error: null };
}

/**
 * Derive coverage: repository coverage vs requested-scope coverage.
 * Binary sections leave repository acquisition coverage unchanged but make
 * requested-scope coverage partial and appear in `unsupported_files`.
 */
export function deriveReviewCoverage(sections, { requestedPaths = null } = {}) {
  if (!Array.isArray(sections)) return { error: 'sections must be an array' };
  const repositoryFiles = new Set();
  const requestedMatched = new Set();
  const unsupportedFiles = [];
  const unmatched = [];

  for (const sec of sections) {
    const path = sec.new_path || sec.old_path;
    if (!path) continue;
    repositoryFiles.add(path);
    if (sec.binary) {
      unsupportedFiles.push(path);
      // Binary sections are still part of the repository, but requested-scope
      // coverage becomes partial: unsupported files are never "matched".
      continue;
    }
    if (requestedPaths) {
      if (requestedPaths.includes(path)) requestedMatched.add(path);
    }
  }

  if (requestedPaths) {
    for (const p of requestedPaths) {
      if (!repositoryFiles.has(p) && !unsupportedFiles.includes(p)) unmatched.push(p);
    }
  }

  const result = {
    repository: {
      files: [...repositoryFiles].sort(),
      coverage: repositoryFiles.size > 0 ? 'complete' : 'empty',
    },
    requested: requestedPaths
      ? {
          matched: [...requestedMatched].sort(),
          coverage: requestedMatched.size === requestedPaths.length ? 'complete' : 'partial',
          unmatched: unmatched.sort(),
        }
      : null,
    unsupported_files: unsupportedFiles.sort(),
  };
  return result;
}

/**
 * Plan a single review request with exact byte accounting: metadata + the
 * question + every selected section must fit the single-max bound.
 * Returns {plan, error} where plan is {sections, total_bytes} or
 * {error: 'single_max_exceeded', path} for a single oversized file.
 */
export function planSingleReviewPayload({
  sections,
  question = '',
  metadata = '',
  limits,
}) {
  if (!Array.isArray(sections)) return { error: 'sections must be an array' };
  if (!limits || typeof limits.singleMaxBytes !== 'number') {
    return { error: 'limits are required (inject Package 13 frozen config)' };
  }
  // Malformed oversized stdin: refuse to split arbitrarily.
  if (typeof question !== 'string') return { error: 'question must be a string' };
  if (typeof metadata !== 'string') return { error: 'metadata must be a string' };

  const fixed = METADATA_OVERHEAD_BYTES + Buffer.byteLength(metadata, 'utf8') + Buffer.byteLength(question, 'utf8');
  const selected = [];
  let total = fixed;

  for (const sec of sections) {
    // A single oversized file fails with its path.
    if (sec.bytes > limits.singleMaxBytes) {
      return { error: 'single_max_exceeded', path: sec.new_path || sec.old_path || '(unknown)' };
    }
    selected.push(sec);
    total += sec.bytes;
  }

  // P0 fix: single mode NEVER silently truncates whole files. When every
  // file is individually under the cap but their aggregate (plus fixed
  // metadata) exceeds it, the plan fails closed — the caller must shard
  // instead of issuing a clean verdict over a partial corpus.
  if (total > limits.singleMaxBytes) {
    return { error: 'single_max_exceeded', path: '(aggregate)' };
  }

  if (selected.length === 0 && sections.length > 0) {
    return { error: 'no_section_fits', path: null };
  }
  return { plan: { sections: selected, total_bytes: total }, error: null };
}

// ─── sequential shard planning (Atomic 44 / Package 23) ─────────────────────

/**
 * Plan source-ordered whole-file shards for sequential execution.
 * Whole-file shards keep each file's hunks together (no cross-file mixing);
 * shards are source-ordered by the first section's path. The total bound is
 * precomputed against the injected Package 13 limits (shardMaxBytes,
 * maxShards, totalMaxBytes). Fresh boundaries are returned as a pure plan —
 * the executor re-checks every limit at execution time.
 *
 * @param {object} opts
 * @param {Array} opts.sections parsed sections (Package 14)
 * @param {string} opts.question
 * @param {string} [opts.metadata='']
 * @param {object} opts.limits Package 13 frozen limits
 * @returns {{plan?: {shards: Array, total_bytes: number},
 *   error?: string, path?: string|null}}
 */
export function planSequentialShards({ sections, question, metadata = '', limits }) {
  if (!Array.isArray(sections)) return { error: 'sections must be an array' };
  if (!limits || typeof limits.shardMaxBytes !== 'number' || typeof limits.maxShards !== 'number') {
    return { error: 'limits are required (inject Package 13 frozen config)' };
  }
  if (typeof question !== 'string') return { error: 'question must be a string' };
  if (typeof metadata !== 'string') return { error: 'metadata must be a string' };

  const fixed = METADATA_OVERHEAD_BYTES + Buffer.byteLength(metadata, 'utf8') + Buffer.byteLength(question, 'utf8');

  // Source-ordered whole-file shards: group sections by path, never split a
  // file across shards (a single oversized file fails with its path).
  const byPath = new Map();
  for (const sec of sections) {
    if (sec.bytes > limits.shardMaxBytes) {
      return { error: 'shard_max_exceeded', path: sec.new_path || sec.old_path || '(unknown)' };
    }
    const path = sec.new_path || sec.old_path || '(unknown)';
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path).push(sec);
  }

  const shards = [];
  let current = [];
  let currentBytes = fixed;
  // P2 fix: iterate files in FIRST-SEEN order (Map preserves insertion
  // order) — the advertised source-ordered planner. Sorting alphabetically
  // would move dependent changes into a different review sequence than the
  // input diff.
  for (const path of byPath.keys()) {
    const fileBytes = byPath.get(path).reduce((acc, s) => acc + s.bytes, 0);
    if (current.length > 0 && currentBytes + fileBytes > limits.shardMaxBytes) {
      shards.push({ sections: current, bytes: currentBytes });
      current = [];
      currentBytes = fixed;
    }
    current.push(...byPath.get(path));
    currentBytes += fileBytes;
  }
  if (current.length > 0) shards.push({ sections: current, bytes: currentBytes });

  if (shards.length > limits.maxShards) {
    return { error: 'shard_count_exceeded', path: null };
  }
  const totalBytes = shards.reduce((acc, s) => acc + s.bytes, 0);
  if (totalBytes > limits.totalMaxBytes) {
    return { error: 'total_max_exceeded', path: null };
  }
  return { plan: { shards, total_bytes: totalBytes }, error: null };
}

/**
 * coder-git-mediator.js — Package 2C (Atomic 05): bounded Git mediator.
 *
 * Section 6.5 of the approved plan (docs/reliable-delegation-contract-plan.md):
 * Git inspection receives no direct source .git/common-dir/refs/objects —
 * a parent-owned run-scoped mediator exposes exactly three bounded
 * operations against the authorized target and its captured start state:
 *   - `status --short`
 *   - content `diff` for validated literal current paths
 *   - `rev-parse --show-object-format`
 *
 * Structural argv parsing rejects aliases, config/env overrides, `log`, and
 * every other subcommand/flag. Bounds: one request at most 8 KiB encoded argv
 * plus 256 literal path operands; one response at most 1 MiB UTF-8; all
 * responses in one run share an 8 MiB aggregate cap. Crossing any boundary
 * cancels the child, returns NO partial content, and records the stable
 * `TRISS_CODER_GIT_MEDIATOR_LIMIT` execution-policy blocker. Timeout is 30
 * seconds per request. The mediator never returns bytes from a path absent
 * from both the authorized start tree and the current target, and never
 * returns object IDs usable for later lookup.
 */

export const GIT_MEDIATOR_LIMIT_CODE = 'TRISS_CODER_GIT_MEDIATOR_LIMIT';

export const GIT_MEDIATOR_OPS = Object.freeze([
  'status',
  'diff',
  'object-format',
]);

export const GIT_MEDIATOR_LIMITS = Object.freeze({
  maxRequestArgvBytes: 8 * 1024,
  maxPathOperands: 256,
  maxResponseBytes: 1024 * 1024,
  maxAggregateBytes: 8 * 1024 * 1024,
  timeoutMs: 30 * 1000,
});

// Dangerous argv fragments that must never reach git even inside an operand
// (canary messages, notes, author email, refs, historical paths).
const REJECTED_FRAGMENTS = [
  '%B',
  '%N',
  '%ae',
  '%an',
  '%h',
  '%H',
  '%s',
  '%d',
  '%D',
  '--all',
  '--decorate',
  '--format=',
  '--pretty=',
  'HEAD',
  ':',
  '@',
  'refs/heads/',
  'refs/tags/',
  'HEAD~',
  'HEAD^',
  '..',
  '...',
];

const STATUS_ARGV = ['status', '--short'];
const OBJECT_FORMAT_ARGV = ['rev-parse', '--show-object-format'];

function encodedArgvBytes(argv) {
  return argv.reduce((sum, arg) => sum + Buffer.byteLength(String(arg), 'utf8') + 1, 0);
}

/**
 * Structurally validate one mediator request argv.
 *
 * @param {string[]|string} argv raw request (array of operands, or a single
 *   space-joined string for CLI-style input)
 * @param {object} [opts]
 * @param {string[]} [opts.allowedPaths] authorized literal paths for `diff`
 * @returns {{ok:true, op:string, argv:string[], paths:string[]}
 *   | {ok:false, code:string, reason:string}}
 */
export function validateCoderGitRequest(argv, { allowedPaths = [] } = {}) {
  const args = Array.isArray(argv) ? argv.map(String) : String(argv).split(/\s+/).filter(Boolean);
  if (args.length === 0) {
    return { ok: false, code: GIT_MEDIATOR_LIMIT_CODE, reason: 'empty request' };
  }

  // Encoded-argv bound (8 KiB).
  if (encodedArgvBytes(args) > GIT_MEDIATOR_LIMITS.maxRequestArgvBytes) {
    return { ok: false, code: GIT_MEDIATOR_LIMIT_CODE, reason: 'request argv exceeds 8 KiB bound' };
  }

  const [subcommand, ...rest] = args;

  // Alias / config / env overrides and any other subcommand are rejected.
  if (subcommand === 'status') {
    if (!(rest.length === 1 && rest[0] === '--short')) {
      return { ok: false, code: GIT_MEDIATOR_LIMIT_CODE, reason: 'only status --short is allowed' };
    }
    return { ok: true, op: 'status', argv: STATUS_ARGV, paths: [] };
  }

  if (subcommand === 'rev-parse') {
    if (!(rest.length === 1 && rest[0] === '--show-object-format')) {
      return { ok: false, code: GIT_MEDIATOR_LIMIT_CODE, reason: 'only rev-parse --show-object-format is allowed' };
    }
    return { ok: true, op: 'object-format', argv: OBJECT_FORMAT_ARGV, paths: [] };
  }

  if (subcommand === 'diff') {
    // Only literal path operands; no options at all.
    if (rest.some((arg) => arg.startsWith('-'))) {
      return { ok: false, code: GIT_MEDIATOR_LIMIT_CODE, reason: 'diff options are rejected' };
    }
    if (rest.length > GIT_MEDIATOR_LIMITS.maxPathOperands) {
      return { ok: false, code: GIT_MEDIATOR_LIMIT_CODE, reason: `diff exceeds ${GIT_MEDIATOR_LIMITS.maxPathOperands} path operands` };
    }
    for (const arg of rest) {
      for (const fragment of REJECTED_FRAGMENTS) {
        if (arg.includes(fragment)) {
          return { ok: false, code: GIT_MEDIATOR_LIMIT_CODE, reason: `rejected fragment in operand: ${fragment}` };
        }
      }
      // Paths must be literal relative paths under the target, never
      // absolute, never escaping, and present in the authorized set.
      if (arg.startsWith('/') || arg.includes('..') || arg === '.') {
        return { ok: false, code: GIT_MEDIATOR_LIMIT_CODE, reason: `non-literal path operand: ${arg}` };
      }
      if (allowedPaths.length > 0 && !allowedPaths.includes(arg)) {
        return { ok: false, code: GIT_MEDIATOR_LIMIT_CODE, reason: `path not authorized: ${arg}` };
      }
    }
    return { ok: true, op: 'diff', argv: ['diff', '--no-color', ...rest], paths: rest };
  }

  return {
    ok: false,
    code: GIT_MEDIATOR_LIMIT_CODE,
    reason: `unsupported subcommand: ${subcommand}`,
  };
}

function buildMediatorEnv(objectFormat) {
  // Synthetic config from independently verified facts; no other source
  // config key is copied.
  const env = {
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  if (objectFormat === 'sha256') {
    env.GIT_CONFIG_COUNT = '2';
    env.GIT_CONFIG_KEY_0 = 'core.repositoryFormatVersion';
    env.GIT_CONFIG_VALUE_0 = '1';
    env.GIT_CONFIG_KEY_1 = 'extensions.objectFormat';
    env.GIT_CONFIG_VALUE_1 = 'sha256';
  }
  return env;
}

/**
 * Start a run-scoped Git mediator.
 *
 * @param {object} opts
 * @param {Function} opts.runGit injectable `(argv, {env, timeoutMs}) =>
 *   {status, stdout, stderr}` (defaults to spawnSync-based git runner)
 * @param {string} [opts.objectFormat] detected object format (sha1|sha256)
 * @param {string[]} [opts.allowedPaths] authorized literal paths
 * @returns {{run: Function, aggregateBytes: () => number}}
 */
export function startCoderGitMediator({
  runGit,
  objectFormat = 'sha1',
  allowedPaths = [],
} = {}) {
  if (typeof runGit !== 'function') {
    throw new TypeError('startCoderGitMediator: runGit is required');
  }
  let aggregateBytes = 0;

  /**
   * Execute one validated request with bounded collection and no partial
   * output.
   * @returns {{ok:true, op:string, stdout:string}
   *   | {ok:false, code:string, reason:string}}
   */
  async function run(rawRequest) {
    const validated = validateCoderGitRequest(rawRequest, { allowedPaths });
    if (!validated.ok) return validated;

    let outcome;
    try {
      outcome = await runGit(validated.argv, {
        env: buildMediatorEnv(objectFormat),
        timeoutMs: GIT_MEDIATOR_LIMITS.timeoutMs,
      });
    } catch (err) {
      return { ok: false, code: GIT_MEDIATOR_LIMIT_CODE, reason: `git execution failed: ${err?.message || 'unknown'}` };
    }

    // A non-zero status is an execution error, never partial content.
    if (outcome.status !== 0) {
      return { ok: false, code: GIT_MEDIATOR_LIMIT_CODE, reason: `git exited ${outcome.status}` };
    }

    const stdout = typeof outcome.stdout === 'string' ? outcome.stdout : '';
    // Bounded response: the complete safe response either fits or the whole
    // request fails — never truncated into apparently valid Git output.
    if (Buffer.byteLength(stdout, 'utf8') > GIT_MEDIATOR_LIMITS.maxResponseBytes) {
      return { ok: false, code: GIT_MEDIATOR_LIMIT_CODE, reason: 'response exceeds 1 MiB bound' };
    }
    if (aggregateBytes + Buffer.byteLength(stdout, 'utf8') > GIT_MEDIATOR_LIMITS.maxAggregateBytes) {
      return { ok: false, code: GIT_MEDIATOR_LIMIT_CODE, reason: 'aggregate response exceeds 8 MiB bound' };
    }
    aggregateBytes += Buffer.byteLength(stdout, 'utf8');

    return { ok: true, op: validated.op, stdout };
  }

  return {
    run,
    aggregateBytes: () => aggregateBytes,
  };
}

/**
 * coder-sandbox.js — Package 2B (Atomic 04): filesystem and network
 * capability adapter.
 *
 * Section 6.5 of the approved plan (docs/reliable-delegation-contract-plan.md).
 *
 * Package 0 has not selected a platform backend (the feasibility spike is
 * intentionally stopped), so this adapter implements only the documented
 * best-effort path: every capability is reported honestly as
 * `enforced|best_effort|unavailable` per platform, an unavailable sandbox
 * never stops coder, and `credential_isolation` remains the sole mandatory
 * boundary — a missing credential proxy is a stable fail-closed preflight
 * rejection, never a silent env-cleanup plan.
 *
 * Everything here is pure and dependency-free (no fs, no process, no
 * network): platform capability tuples and mounts are resolved from explicit
 * inputs so tests can exercise darwin|linux|win32 and malicious canaries
 * deterministically.
 */

export const PLATFORMS = Object.freeze(['darwin', 'linux', 'win32']);

export const CAPABILITY_VALUE = Object.freeze(['enforced', 'best_effort', 'unavailable']);

// Stable preflight rejection code (Section 6.1 closed warning enum is for
// non-enforced capabilities; credential isolation failure is a preflight
// error, not a warning).
export const CREDENTIAL_ISOLATION_REQUIRED_CODE = 'TRISS_CODER_CREDENTIAL_ISOLATION_REQUIRED';


// Forbidden broad roots that must never appear in a mounts allowlist even as
// readonly entries (Section 6.5 runtime_roots contract). A path is denied
// when it IS one of these roots exactly — a concrete subpath (e.g.
// /usr/local/lib/node_modules/...) is a specific validated runtime root and
// is allowed. HOME/SSH/cloud/parent-process paths are denied by prefix
// regardless of depth.
const FORBIDDEN_BROAD_ROOTS = Object.freeze([
  '/',
  '/usr',
  '/usr/local',
  '/opt',
  '/etc',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/System',
  '/Library',
  '/Applications',
]);

const FORBIDDEN_SENSITIVE_PREFIXES = Object.freeze([
  '/Users/',
  '/home/',
  '/root',
  '/proc',
  '/dev',
  '/private/var/root',
]);

function isAbsolutePath(value) {
  return typeof value === 'string' && value.startsWith('/');
}

/**
 * Resolve the exact capability tuple for one engine/platform tuple.
 *
 * Honest best-effort reporting (Package 0 has selected no enforced backend):
 *  - `sandbox`/`managed_root`/quotas: `unavailable` everywhere until a
 *    reviewed backend exists;
 *  - `process_supervision`: `best_effort` (Triss group kill + residual
 *    cleanup exist, but complete descendant-tree ownership is not proven);
 *  - `locking`: `best_effort` (PID-file locks are in-process, not kernel
 *    advisory locks);
 *  - `credential_isolation`: `best_effort` when a proxy launch plan was
 *    supplied and the platform can run it, `unavailable` otherwise (and the
 *    preflight rejects — see resolveCoderCredentialIsolation). Never
 *    `enforced` until an OS-enforced backend denies raw provider stores to
 *    the same-UID child.
 *
 * @param {object} input
 * @param {string} [input.platform] darwin|linux|win32 (default process.platform)
 * @param {string} [input.engine] opencode|crush (default opencode)
 * @param {boolean} [input.proxyAvailable] whether a credential proxy launch
 *   plan exists for this run
 * @returns {{sandbox:string,process_supervision:string,locking:string,
 *   writable_quota:string,credential_isolation:string,managed_root:string,
 *   persistent_store_quota:string,result_store_quota:string,warnings:string[]}}
 */
export function resolveCoderSandbox({
  platform = typeof process !== 'undefined' ? process.platform : 'darwin',
  engine = 'opencode',
  proxyAvailable = false,
} = {}) {
  const warnings = [];
  if (!PLATFORMS.includes(platform)) {
    throw new TypeError(`unsupported platform: ${JSON.stringify(platform)}`);
  }
  if (!['opencode', 'crush'].includes(engine)) {
    throw new TypeError(`unsupported engine: ${JSON.stringify(engine)}`);
  }

  const capabilities = {
    // No Package 0-reviewed backend exists on any platform yet.
    sandbox: 'unavailable',
    process_supervision: 'best_effort',
    locking: 'best_effort',
    writable_quota: 'unavailable',
    // P0 honesty fix: the loopback token proxy removes the raw credential
    // from the engine's env/argv/config — a real boundary — but the child
    // still runs as the same unrestricted user who can read the raw
    // credential stores (project/global .triss.env, HOME). Until an
    // OS-enforced filesystem/network backend exists, this is best_effort,
    // never 'enforced'; the proxy itself remains the mandatory boundary
    // (missing proxy = stable preflight rejection, never a silent env plan).
    credential_isolation: proxyAvailable ? 'best_effort' : 'unavailable',
    managed_root: 'unavailable',
    persistent_store_quota: 'unavailable',
    result_store_quota: 'unavailable',
  };

  for (const [name, value] of Object.entries(capabilities)) {
    if (value === 'unavailable' && name !== 'credential_isolation') {
      warnings.push(`TRISS_CODER_CAP_${name.toUpperCase()}_UNAVAILABLE`);
    } else if (value === 'best_effort') {
      warnings.push(`TRISS_CODER_CAP_${name.toUpperCase()}_BEST_EFFORT`);
    }
  }
  if (!proxyAvailable) {
    warnings.push(CREDENTIAL_ISOLATION_REQUIRED_CODE);
  }

  return { ...capabilities, warnings };
}

/**
 * Build the sanctioned mount allowlist for an enforced-sandbox run.
 *
 * Returns readonly/sanitized roots only: the authorized target worktree,
 * task temp/config, resolved engine executable + its read-only runtime
 * roots, and explicitly selected readonly project dependency roots. Broad
 * system roots, HOME, SSH/cloud/keychain dirs, and parent-process paths are
 * never allowed, even when passed as `readonlyRoots`.
 *
 * @param {object} input
 * @param {string} input.targetRoot authorized worktree (isolated or caller project)
 * @param {string} [input.taskTemp] task-scoped temp/config dir
 * @param {string[]} [input.engineRoots] resolved engine runtime roots
 * @param {string[]} [input.readonlyProjectRoots] explicitly selected dependency roots
 * @returns {{mounts:Array<{src:string,readonly:boolean}>, denied:string[]}}
 */
export function buildCoderSandboxMounts({
  targetRoot,
  taskTemp,
  engineRoots = [],
  readonlyProjectRoots = [],
} = {}) {
  if (!isAbsolutePath(targetRoot)) {
    throw new TypeError('buildCoderSandboxMounts: targetRoot must be an absolute path');
  }
  const mounts = [];
  const denied = [];

  const pushMount = (src, readonly = true) => {
    if (!isAbsolutePath(src)) {
      denied.push(String(src));
      return;
    }
    // Exact broad roots are never mounted, even readonly.
    if (FORBIDDEN_BROAD_ROOTS.includes(src)) {
      denied.push(src);
      return;
    }
    // HOME, SSH, cloud, and parent-process paths are denied by prefix at any
    // depth (a subpath under /Users/ is still the user's private tree).
    for (const prefix of FORBIDDEN_SENSITIVE_PREFIXES) {
      if (src === prefix || src.startsWith(prefix)) {
        denied.push(src);
        return;
      }
    }
    mounts.push({ src, readonly });
  };

  // The authorized target is always writable; everything else readonly.
  pushMount(targetRoot, false);
  if (taskTemp) pushMount(taskTemp, false);
  for (const root of engineRoots) pushMount(root, true);
  for (const root of readonlyProjectRoots) pushMount(root, true);

  return { mounts, denied };
}

/**
 * Resolve credential isolation to either an opaque launch plan or the stable
 * fail-closed preflight rejection.
 *
 * The ONLY acceptable plan is a parent-owned credential proxy: the engine
 * receives a single-run token and loopback base URL, the real credential
 * stays in the parent's memory. A plan that merely sanitizes environment
 * variables is never returned (Section 6.5). Missing proxy, missing platform
 * capability proof, or a non-loopback target is a rejection.
 *
 * @param {object} input
 * @param {object} input.proxy resolved credential proxy plan
 *   ({baseUrl, token, envKey, provider, model, endpoint})
 * @param {string[]} [input.credentialStorePaths] absolute paths of raw
 *   credential stores that must stay out of the child (canaries)
 * @param {number|string} [input.parentPid] parent process identity
 * @param {string} [input.engineCommand] resolved engine executable
 * @param {object} [input.platformCapabilities] tuple from resolveCoderSandbox
 * @returns {{ok:true, plan:object} | {ok:false, code:string, message:string}}
 */
export function resolveCoderCredentialIsolation({
  proxy,
  credentialStorePaths = [],
  parentPid,
  engineCommand,
  platformCapabilities,
} = {}) {
  const validProxy =
    proxy &&
    typeof proxy.baseUrl === 'string' &&
    /^http:\/\/127\.0\.0\.1:\d+/.test(proxy.baseUrl) &&
    typeof proxy.token === 'string' &&
    proxy.token.length > 0 &&
    typeof proxy.envKey === 'string' &&
    proxy.envKey.length > 0;

  if (!validProxy) {
    return {
      ok: false,
      code: CREDENTIAL_ISOLATION_REQUIRED_CODE,
      message:
        'credential isolation requires a parent-owned loopback credential proxy; ' +
        'refusing to spawn with raw credential inheritance',
    };
  }

  const caps = platformCapabilities || resolveCoderSandbox({ proxyAvailable: true });
  // The proxy IS the mandatory boundary, so a valid plan is accepted when the
  // capability is honestly reported as best_effort (loopback token proxy,
  // no OS-enforced store denial yet) or enforced (future backend).
  if (caps.credential_isolation !== 'enforced' && caps.credential_isolation !== 'best_effort') {
    return {
      ok: false,
      code: CREDENTIAL_ISOLATION_REQUIRED_CODE,
      message: 'credential isolation capability is not available on this platform',
    };
  }

  // The denied set is the raw credential stores plus the parent process
  // control identity; the plan itself only ever references the proxy.
  const deniedPaths = credentialStorePaths.filter(isAbsolutePath);
  return {
    ok: true,
    plan: {
      kind: 'credential_proxy',
      proxy: {
        baseUrl: proxy.baseUrl,
        envKey: proxy.envKey,
      },
      // The token is passed to the launcher separately (it may appear in the
      // child env), never in this plan object.
      engineCommand: typeof engineCommand === 'string' ? engineCommand : null,
      parentPid: typeof parentPid === 'number' ? parentPid : null,
      deniedPaths,
    },
  };
}

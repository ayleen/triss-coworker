// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Crush adapter behind `triss coder run --engine
// crush`. See docs/engines/crush.md for the supported configuration, safety
// boundaries, and upstream limitations this adapter must preserve.
//
// Scope of THIS file: PURE adapter functions — detect, argv/env builders,
// single-envelope parser, exit-reason mapper. NO process orchestration, NO
// isolation/worktree logic, NO logUsage. That lives in src/commands/coder.js
// (engine-agnostic), which calls into this adapter. Keeping the adapter pure
// means another engine can be added as a sibling with the same member shape.

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { ZAI_CODING_PLAN_BASE_URL } from '../zai.js';

// Hard supported floor for the npm package. The semver-parse fix landed in
// 0.1.3 (crush ≥0.1.3 reports a clean `crush version vX.Y.Z`), so the shared
// version-policy resolver (resolveCrushVersionPolicy) parses the semver and
// compares it against the effective minimum (installed >= effective minimum,
// with the floor clamped underneath — see resolveCrushMinimumConfig). 0.1.6 is
// the oldest release verified live against the triss adapter (envelope shape,
// ZHIPU→ZAI env bridge, --restrict-run CLI-flag enforcement, worktree
// isolation — all re-verified on 0.1.6, 2026-07-15).
// TRISS_CODER_CRUSH_VERSION may RAISE the minimum but can never lower it below
// this value; the floor also drives installHint().
const CRUSH_SUPPORTED_FLOOR = '0.1.6';

// crush selects models by "atoms". For GLM the large atom is glm5_2 (GLM-5.2)
// and the small atom is glm5_turbo (GLM-5-turbo). `crush models use <large>
// <small> [--global|--local]` writes crush.json so `--role smart` -> large and
// `--role fast` -> small deterministically. Without this, crush may resolve to
// a non-GLM default atom (e.g. an Anthropic-via-local-claude-CLI atom) — so
// pinning these atoms is the ONE thing crush init must do beyond the shared
// ZHIPU_API_KEY setup. Kept as constants so a future model bump is one edit.
const CRUSH_LARGE_ATOM = 'glm5_2';
const CRUSH_SMALL_ATOM = 'glm5_turbo';

// Configured-minimum policy, read from TRISS_CODER_CRUSH_VERSION ONLY (no
// probing). THE single source both crushVersionPin() (display/install advice)
// and resolveCrushVersionPolicy() (admission) consult, so display and
// enforcement cannot drift:
//   - unset ('' or undefined counts as unset) -> the hard floor;
//   - a value BELOW the floor clamps UP to the floor — an installation
//     preference must never resurrect unsupported releases
//     (TRISS_CODER_CRUSH_VERSION=0.1.4 must not make 0.1.4 supported);
//   - a MALFORMED value fails closed: configValid=false and NOTHING is
//     admitted (admission), while the DISPLAY degrades to the floor so install
//     advice stays actionable. Never reinterpreting garbage as "latest" or
//     silently as the floor.
function resolveCrushMinimumConfig() {
  const floor = parseMinimumVersion(CRUSH_SUPPORTED_FLOOR);
  const configuredRaw = process.env.TRISS_CODER_CRUSH_VERSION;
  const configuredUnset = configuredRaw == null || configuredRaw === '';
  const configuredParsed = parseMinimumVersion(configuredRaw);
  const configValid = configuredUnset || Boolean(configuredParsed);
  const effectiveParsed =
    !configuredUnset && configValid && semverGte(configuredParsed, floor)
      ? configuredParsed
      : floor;
  return { configuredRaw, configuredUnset, configuredParsed, configValid, floor, effectiveParsed };
}

// The effective minimum version TEXT: the configured override when it is a
// legal (canonical, >= floor) value, otherwise the hard floor itself. Used for
// display and install hints.
export function crushVersionPin() {
  const { effectiveParsed } = resolveCrushMinimumConfig();
  return `${effectiveParsed.major}.${effectiveParsed.minor}.${effectiveParsed.patch}`;
}

const CANONICAL_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function versionFromMatch(match) {
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) return null;
  return { major: parts[0], minor: parts[1], patch: parts[2] };
}

// Configured minimums are policy, not command output. They must be one
// canonical stable x.y.z value: prefixes, partial versions, extra components,
// prereleases, build metadata, and arbitrary suffixes all fail closed.
function parseMinimumVersion(text) {
  if (text == null) return null;
  const m = CANONICAL_VERSION.exec(String(text));
  return versionFromMatch(m);
}

// Installed Crush output has a small, documented wrapper (`crush version
// vX.Y.Z`). Accept that wrapper and a bare stable version for test/tool
// compatibility, but never strip a prerelease/build suffix and call it stable.
function parseInstalledVersion(text) {
  if (text == null) return null;
  const value = String(text).trim();
  const wrapped = /^crush\s+version\s+v?(.+)$/.exec(value);
  const candidate = wrapped ? wrapped[1] : value.replace(/^v/, '');
  const m = CANONICAL_VERSION.exec(candidate);
  return versionFromMatch(m);
}

// a >= b (lexicographic on major/minor/patch). Both inputs must be parsed.
function semverGte(a, b) {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}

// The shared read-only PROBE environment. Every read-only crush binary probe
// (`crush --version`) receives an explicit minimal sanitized environment:
// PATH plus only deterministic locale/TZ variables actually needed to format
// output. Provider/API/cloud/GitHub/AWS credentials and arbitrary parent env
// are NEVER inherited by a probe (same posture as detectOpencodeVersion's
// allowlist and detectOpenCode2's probeEnv). This is NOT the protected
// execution path — buildSpawnEnv owns the credential-bearing run env.
export function buildCrushProbeEnv(baseEnv = process.env) {
  const env = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ']) {
    if (baseEnv[key] != null) env[key] = baseEnv[key];
  }
  return env;
}

// resolveCrushVersionPolicy: THE one shared Crush version-policy resolver.
// Non-throwing; probes `crush --version` ONCE through the sanitized probe env
// and classifies the result into an explicit reason instead of leaving callers
// to interpret satisfyPin booleans:
//   - 'compatible'                  installed >= effective minimum
//   - 'missing'                     binary absent / probe failed
//   - 'version_unknown'             found but no stable x.y.z parses
//   - 'below_floor'                 installed < immutable floor 0.1.6
//   - 'below_configured_minimum'    installed < a VALID stricter override
//   - 'invalid_configured_minimum'  TRISS_CODER_CRUSH_VERSION malformed
//
// PRECEDENCE: an invalid configured minimum is the PRIMARY reason regardless
// of binary state — missing, version_unknown, below_floor, and
// below_configured_minimum never overwrite it (found/installedVersion stay
// collected as diagnostics).
// Raise-only semantics are preserved exactly: unset -> effective 0.1.6;
// configured 0.1.4 clamps UP to 0.1.6; configured 0.2.0 -> effective 0.2.0;
// malformed -> fail closed (compatible=false; `effectiveMinimum` degrades to
// the floor TEXT so advice stays actionable while nothing is admitted).
// Runtime (runCoderRun) treats this as AUTHORITATIVE — see
// assertCrushVersionPolicy. `sh` is injectable for tests.
export function resolveCrushVersionPolicy(sh = nodeSpawnSync) {
  const { configuredRaw, configuredUnset, configuredParsed, configValid, floor, effectiveParsed } =
    resolveCrushMinimumConfig();
  // Effective minimum TEXT: a valid raised override, otherwise the hard floor
  // itself. When the configured value is MALFORMED nothing is admissible; the
  // display still degrades to the floor so install advice stays actionable.
  const effectiveMinimum = `${effectiveParsed.major}.${effectiveParsed.minor}.${effectiveParsed.patch}`;

  const base = {
    found: false,
    installedVersion: null,
    configuredMinimum: configuredUnset ? null : String(configuredRaw),
    configValid,
    supportedFloor: CRUSH_SUPPORTED_FLOOR,
    effectiveMinimum,
    compatible: false,
    // PRIMARY verdict first: a MALFORMED configured minimum is THE reason no
    // matter what the probe reports below. missing / version_unknown /
    // below_floor / below_configured_minimum may only classify a VALID
    // configuration, so they can never overwrite an invalid one.
    reason: configValid ? 'missing' : 'invalid_configured_minimum',
  };
  let r;
  try {
    r = sh('crush', ['--version'], { env: buildCrushProbeEnv() });
  } catch {
    r = null; // a throwing spawnSync seam is equivalent to a failed probe
  }
  if (!r || r.error || r.status !== 0) {
    return base; // 'missing', or the primary invalid-config reason already set
  }
  const out = String(r.stdout || '').trim();
  const parsed = parseInstalledVersion(out);
  base.found = true;
  // Bare `x.y.z` when a stable version parses; the RAW output otherwise (for
  // diagnostics — never strip a prerelease suffix and call it stable).
  base.installedVersion = parsed
    ? `${parsed.major}.${parsed.minor}.${parsed.patch}`
    : (out || null);
  // Probe-derived classification refines a VALID configuration only; an
  // invalid one keeps its primary reason above while found/installedVersion
  // stay diagnostic.
  if (configValid) {
    if (!parsed) base.reason = 'version_unknown';
    else if (!semverGte(parsed, floor)) base.reason = 'below_floor';
    else if (
      !configuredUnset && !semverGte(parsed, configuredParsed)
    ) base.reason = 'below_configured_minimum';
    else base.reason = 'compatible';
  }
  base.compatible = base.reason === 'compatible';
  return base;
}

// Narrow typed code for a MALFORMED TRISS_CODER_CRUSH_VERSION — mirrors
// OPENCODE_INVALID_MINIMUM_CODE. Below-minimum installs stay plain Errors
// (matching the OpenCode one-shot path); only broken CONFIGURATION is typed.
export const CRUSH_INVALID_MINIMUM_CODE = 'TRISS_CODER_CRUSH_MINIMUM_INVALID';

// assertCrushVersionPolicy: throwing adapter over resolveCrushVersionPolicy.
// Takes the RESOLVED policy (never re-probes) and throws a fail-closed error
// for every incompatible state, so runCoderRun can gate BEFORE isolation,
// credential proxy setup, or session reservation and make spawnCrush
// unreachable for an incompatible binary. Returns the policy when compatible.
export function assertCrushVersionPolicy(policy) {
  if (policy.compatible) return policy;
  const eff = policy.effectiveMinimum;
  const installCmd = `npm install -g @phpcraftdream/crush@${eff}`;
  if (policy.reason === 'invalid_configured_minimum') {
    const error = new Error(
      `Invalid Crush minimum version "${String(policy.configuredMinimum)}" ` +
        '(is not a canonical stable x.y.z version); ' +
        `set TRISS_CODER_CRUSH_VERSION to a canonical stable x.y.z version >= ${policy.supportedFloor}. ` +
        'No engine was started.',
    );
    error.code = CRUSH_INVALID_MINIMUM_CODE;
    throw error;
  }
  if (policy.reason === 'missing') {
    throw new Error(`crush not found — run manually: ${installCmd}`);
  }
  if (policy.reason === 'version_unknown') {
    throw new Error(
      `crush version could not be determined (${JSON.stringify(policy.installedVersion)}) — ` +
        `minimum supported version is ${eff}. Reinstall: ${installCmd}`,
    );
  }
  throw new Error(
    `crush ${policy.installedVersion} found, minimum supported version is ${eff} — upgrade: ${installCmd}`,
  );
}

// detect(): spawnSync('crush', ['--version'], sanitized-env) — NEVER shell:true,
// NEVER inheriting credentials (see buildCrushProbeEnv). crush ≥0.1.3 reports
// a clean `crush version v0.1.3`; earlier builds reported a dirty dev string.
// This is now a thin READ-ONLY projection over resolveCrushVersionPolicy (one
// shared policy source): {found, version, minimumVersion, meetsMinimum,
// satisfiesPin} where meetsMinimum/satisfiesPin == policy.compatible. NEVER
// throws — detection stays total for status/init surfaces; RUNTIME enforcement
// happens via assertCrushVersionPolicy in runCoderRun. `sh` remains injectable
// for tests.
export function detectCrush(sh = nodeSpawnSync) {
  const p = resolveCrushVersionPolicy(sh);
  return {
    found: p.found,
    version: p.installedVersion,
    minimumVersion: p.effectiveMinimum,
    meetsMinimum: p.compatible,
    satisfiesPin: p.compatible,
  };
}

export function installHintCrush() {
  return `npm install -g @phpcraftdream/crush@${crushVersionPin()}`;
}

// buildCrushRunArgv: returns the argv for `crush run`.
//  - `--role smart` is REQUIRED by crush (smart = large model); default.
//  - `--json` always on (single JSON envelope on stdout at end of run).
//  - `--timeout <sec>`: crush has its own timeout that preserves the partial
//    answer in the envelope (unlike opencode, which retries forever).
//  - `--model <model>` ONLY when an explicit override is given; otherwise rely
//    on the configured default (crush.json's `glm5_2` atom — see hint).
//  - `--effort low|medium|high` receives the exact supported logical value.
//    Crush cannot represent xhigh/max; those requests fail before spawn rather
//    than silently downgrading to high.
//  - `--session <slug>` flows STRAIGHT THROUGH: crush sessions are native
//    get-or-create with caller-supplied arbitrary ids (no slug->real-id map
//    needed, unlike opencode's ses_ workaround). needsSessionMap: false.
//  - `--continue` maps 1:1.
//  - `--cwd <path>` for the working dir.
//  - `--agents single` disables sub-agent fan-out/recursion (safety).
//  - `prompt` is the positional arg (last).
//
// Safety note: the CALLER (runCrushFlow) is responsible for adding
// CRUSH_FORBID_WRITES=<paths> to the spawn env for any harness-owned output
// paths; buildSpawnEnv below does not set it (it's per-run, not a default).
//
// restrict: when ON, append `--restrict-run` AND the allowlist as CLI flags
// (`--allow-bash <p>` per pattern, `--allow-tool <t>` per tool). This is the
// ONLY enforcement path that actually works today: live testing (see
// docs/engines/crush.md) proved crush 0.1.3 IGNORES the
// `permissions.run` config block — only the CLI flags take effect. So when
// restrict is ON we emit the full allowlist on the command line. When OFF,
// append nothing — crush then auto-approves every tool (its default). The
// caller resolves the tristate (CLI/env/config/default — see
// resolveCrushRestrict in src/commands/coder.js) and passes a concrete boolean
// here. argv stays a plain array (never shell:true).
export function buildCrushRunArgv({
  prompt,
  model,
  session,
  continue: cont,
  cwd,
  timeoutSec = 900,
  maxTokens,
  effort,
  restrict = true,
} = {}) {
  const argv = [
    'run',
    '--role',
    'smart',
    '--json',
    '--timeout',
    String(timeoutSec),
    '--agents',
    'single',
  ];
  if (maxTokens !== undefined) argv.push('--max-tokens', String(maxTokens));
  if (effort) {
    if (!['low', 'medium', 'high'].includes(effort)) {
      throw new Error(
        `Crush cannot apply effort "${effort}" — this engine supports low, medium, and high only.`,
      );
    }
    argv.push('--effort', effort);
  }
  if (restrict) {
    argv.push('--restrict-run');
    // CLI allow flags are the load-bearing enforcement (config is inert — see
    // the comment block above). One --allow-bash per pattern, one --allow-tool
    // per tool, so the working coder can read/edit/write files + run the
    // read-only bash allowlist. A denied *bash* command deadlocks to timeout
    // (docs/engines/crush.md), so the bash set is deliberately
    // narrow; pair restrict with worktree isolation (the crush isolate default)
    // for defense-in-depth.
    for (const p of CRUSH_ALLOW_BASH_PATTERNS) argv.push('--allow-bash', p);
    for (const t of CRUSH_ALLOW_TOOLS) argv.push('--allow-tool', t);
  }
  if (model) argv.push('--model', model);
  if (session) argv.push('--session', session);
  if (cont) argv.push('--continue');
  if (cwd) argv.push('--cwd', cwd);
  argv.push(prompt); // positional message
  return argv;
}

// buildCrushSpawnEnv: minimal allowlist env for the crush subprocess. NEVER
// spread process.env — only what crush needs.
//
// Canonical Triss configuration uses `ZHIPU_API_KEY`. Protected projection
// creates a run-private Crush `zai` provider pointed at the credential proxy,
// then places only the single-run token in Crush's engine-native ZAI_API_KEY.
// The child never receives the real credential. NEVER log the value.
export function buildCrushSpawnEnv(baseEnv = process.env, proxy = null) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (baseEnv[key] != null) env[key] = baseEnv[key];
  }
  // Credential proxy: when a proxy plan exists, the engine
  // receives the single-run proxy token in the API-key variables plus the
  // loopback base URL — never the real provider credential.
  if (proxy && proxy.token && proxy.baseUrl) {
    env.ZAI_API_KEY = proxy.token;
    env.CRUSH_GLOBAL_CONFIG = proxy.configDir;
    env.CRUSH_GLOBAL_DATA = proxy.dataDir;
    return env;
  }
  if (baseEnv.ZHIPU_API_KEY) {
    env.ZHIPU_API_KEY = baseEnv.ZHIPU_API_KEY;
  }
  return env;
}

export function buildCrushProtectedProviderConfig(baseUrl, model) {
  if (typeof baseUrl !== 'string' || !baseUrl.startsWith('http://127.0.0.1:')) {
    throw new Error('Crush protected provider config requires a loopback proxy URL');
  }
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error('Crush protected provider config requires a native model');
  }
  return {
    options: {
      disable_provider_auto_update: true,
      disable_metrics: true,
    },
    models: {
      large: { model, provider: 'zai' },
      small: { model, provider: 'zai' },
    },
    providers: {
      zai: {
        base_url: baseUrl,
        api_key: '$ZAI_API_KEY',
        discover_models: false,
        models: [{
          id: model,
          name: model,
          context_window: 200_000,
          default_max_tokens: 65_536,
          can_reason: true,
          reasoning_levels: ['low', 'medium', 'high'],
          default_reasoning_effort: 'high',
        }],
      },
    },
  };
}

// parseCrushEnvelope: crush prints ONE JSON object on stdout at end of run
// (confirmed live; see docs/engines/crush.md). Shape:
//   {session_id, exit_reason, final_text, assistant_notes?, tool_calls,
//    usage:{delta_tokens, delta_cost_usd}, duration_ms, error}
//
// Take the LAST non-empty line and parse it as JSON. Returns the parsed
// object, or null if nothing parseable (the caller throws per the
// envelope-vs-throw split). crush's WARN noise + `▶ <tool>` heartbeats go to
// STDERR, not stdout, so stdout is pure JSON in --json mode.
export function parseCrushEnvelope(stdout) {
  if (!stdout) return null;
  const lines = String(stdout).split('\n');
  let lastLine = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t) {
      lastLine = t;
      break;
    }
  }
  if (!lastLine) return null;
  try {
    const obj = JSON.parse(lastLine);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

// mapCrushExitReason: crush vocabulary -> triss envelope vocabulary.
// triss envelope uses: end_turn | error | timeout | killed (see the envelope
// contract in docs/coder-agent-plan.md). The raw crush reason is preserved for
// diagnostics.
//   end_turn   -> end_turn   (normal completion)
//   done       -> end_turn   (crush synonym for completion)
//   timeout    -> timeout
//   canceled   -> killed     (external `crush sessions cancel <id>` / signal)
//   max_cost   -> error      (budget cap hit — surfaced as a run error)
//   max_tokens -> error      (token cap hit — surfaced as a run error)
//   error      -> error
export function mapCrushExitReason(crushReason) {
  // `.raw` preserves the original crush reason VERBATIM (null/undefined -> null)
  // so diagnostics show exactly what crush reported, never a fabricated value.
  const raw = crushReason ?? null;
  const TRISS_MAP = {
    end_turn: 'end_turn',
    done: 'end_turn',
    timeout: 'timeout',
    canceled: 'killed',
    max_cost: 'error',
    max_tokens: 'error',
    error: 'error',
  };
  // Unknown / null / undefined reasons all collapse to 'error'.
  const triss = (raw != null && TRISS_MAP[raw]) || 'error';
  return { triss, raw };
}

// crushDefaultModelsHint: the two crush model ATOMS to configure via
// `crush models use <large> <small>`. Reuses the CRUSH_*_ATOM constants so a
// model bump is one edit; configureCrushModels() actually runs the command.
export function crushDefaultModelsHint() {
  return {
    large: CRUSH_LARGE_ATOM,
    small: CRUSH_SMALL_ATOM,
    note:
      `Configure with \`crush models use ${CRUSH_LARGE_ATOM} ${CRUSH_SMALL_ATOM}\` (writes crush.json). ` +
      `Provider: built-in zai (coding-plan endpoint, ${ZAI_CODING_PLAN_BASE_URL}).`,
  };
}

// The shared read-only bash allowlist, mirroring opencode's `permission.bash`
// allowlist in src/commands/coder.js (opencodeConfigTemplate). Kept in ONE
// named constant here so the two engines' safe-command sets stay in sync —
// edit this and opencode's template together. crush 0.1.3 pattern forms: a
// bare string is a command-prefix match (e.g. 'git diff' matches `git diff`,
// `git diff --stat`, ...); `glob:<pattern>` is a glob match. This is crush's
// closest analog to opencode's deny-first bash policy (crush has no per-key
// allow/deny object — just a flat allow_bash list under permissions.run).
export const CRUSH_ALLOW_BASH_PATTERNS = [
  'git status',
  'git diff',
  'git log',
  'glob:ls *',
  'glob:node --test *',
  'glob:npm test *',
  'glob:npm run test *',
];

// The non-bash tool allowlist emitted as `--allow-tool <t>` flags when restrict
// is ON. The verified file-tool taxonomy is `view`, `edit`, `write`, `ls`
// (each accepts a bare name or `tool:action`). This is the WORKING set a coder
// needs to read and edit files under `--restrict-run` — broader than the
// `allow_tools: ['view']` we seed into crush.json (which is the conservative
// forward-compat config block, currently inert). Kept in ONE named constant so
// the CLI flag set is one edit.
export const CRUSH_ALLOW_TOOLS = ['view', 'edit', 'write', 'ls'];

// Build the `permissions.run` block triss seeds into crush.json at init.
// restrict:true + the curated read-only allow_bash above + `view` as the only
// always-allowed non-bash tool — the opencode-parity persistent policy shape.
//
// Forward-compatibility caveat (see docs/engines/crush.md):
// crush 0.1.3 IGNORES this config block — `permissions.run` in crush.json is
// not honored by `crush run --restrict-run`. We keep seeding it because it is
// harmless AND correct once the maintainer honors config (then this becomes the
// real persistent policy, editable in one file like opencode.json). But TODAY
// the working allowlist is enforced via CLI flags at run time (see
// buildCrushRunArgv's `--allow-bash`/`--allow-tool` emission), NOT via this
// block. Returned fresh each call so callers can merge it into a config object
// without mutating the constant.
export function crushPermissionsRunBlock() {
  return {
    restrict: true,
    allow_bash: [...CRUSH_ALLOW_BASH_PATTERNS],
    allow_tools: ['view'],
  };
}

// Pure merge of the permissions.run block into a crush.json config object.
// Returns {merged, hadRunPolicy}: `merged` is a shallow-cloned config with the
// run block seeded ONLY when no run policy was already present (no-clobber);
// `hadRunPolicy` tells the caller whether the user already had one (so it can
// warn instead of overwriting). NEVER touches the `models` block —
// `crush models use` owns that, and crush.json is read-modify-written (there
// is no `crush config` CLI).
export function mergeCrushPermissionsRun(config = {}) {
  const merged = { ...config };
  if (!merged.permissions || typeof merged.permissions !== 'object') {
    merged.permissions = {};
  }
  const hadRunPolicy = !!(merged.permissions.run && typeof merged.permissions.run === 'object');
  if (!hadRunPolicy) {
    merged.permissions = { ...merged.permissions, run: crushPermissionsRunBlock() };
  }
  return { merged, hadRunPolicy };
}

// configureCrushModels: runs `crush models use glm5_2 glm5_turbo <scopeFlag>` so
// crush's --role smart/fast resolve to GLM deterministically. This is the ONE
// thing crush init does beyond the shared ZHIPU_API_KEY setup. It does NOT write
// any api_key into crush.json; buildCrushSpawnEnv forwards the canonical key.
//
// Idempotent + non-fatal: a missing binary, a non-zero exit, or a thrown
// spawnSync all return {ok:false} with a short reason (stderr tail) so init
// degrades gracefully instead of aborting. `sh` is the injected spawnSync the
// rest of coder.js uses (tests fake it); NEVER shell:true — argv is an array.
export function configureCrushModels({ scope, sh = nodeSpawnSync }) {
  const scopeFlag = scope === 'local' ? '--local' : '--global';
  const argv = ['models', 'use', CRUSH_LARGE_ATOM, CRUSH_SMALL_ATOM, scopeFlag];
  let r;
  try {
    r = sh('crush', argv);
  } catch (err) {
    return { ok: false, note: `crush models use failed: ${err.message}` };
  }
  if (!r || r.error) {
    const reason = (r && r.error && r.error.message) || 'spawn failed (crush missing?)';
    return { ok: false, note: `crush models use failed: ${reason}` };
  }
  if (r.status !== 0) {
    const stderr = String((r && (r.stderr || r.stdout)) || '').trim();
    const tail = stderr
      ? stderr
          .split('\n')
          .filter(Boolean)
          .slice(-3)
          .join(' ')
      : '';
    return {
      ok: false,
      note: `crush models use exited ${r.status}${tail ? ` — ${tail}` : ' (no stderr)'}`,
    };
  }
  return {
    ok: true,
    note: `set default models: ${CRUSH_LARGE_ATOM} (large) / ${CRUSH_SMALL_ATOM} (small)`,
  };
}

// The adapter object defines the shape another engine implementation mirrors.
export const crush = {
  id: 'crush',
  binaryName: 'crush',
  // Hard supported floor drives installHint() AND the shared version-policy
  // resolver (resolveCrushVersionPolicy). TRISS_CODER_CRUSH_VERSION may raise
  // the effective minimum, never lower it; runtime admission is enforced by
  // assertCrushVersionPolicy in runCoderRun — detection alone is advisory.
  get CRUSH_PIN() {
    return crushVersionPin();
  },
  detect: detectCrush,
  installHint: installHintCrush,
  // THE shared version policy: non-throwing resolver + throwing assertion.
  // Runtime callers (runCoderRun/runCoderInit in src/commands/coder.js) must
  // resolve + assert through these instead of interpreting detect()'s
  // satisfiesPin boolean themselves.
  resolveVersionPolicy: resolveCrushVersionPolicy,
  assertVersionPolicy: assertCrushVersionPolicy,
  buildProbeEnv: buildCrushProbeEnv,
  CRUSH_INVALID_MINIMUM_CODE,
  buildRunArgv: buildCrushRunArgv,
  buildSpawnEnv: buildCrushSpawnEnv,
  buildProtectedProviderConfig: buildCrushProtectedProviderConfig,
  parseEnvelope: parseCrushEnvelope,
  mapExitReason: mapCrushExitReason,
  crushDefaultModelsHint,
  configureCrushModels,
  // permissions.run policy (crush 0.1.3+): the curated read-only bash
  // allowlist, the CLI tool allowlist, the block builder, and the no-clobber
  // merge helper. Used by src/commands/coder.js seedCrushPermissions() at init
  // (config block, currently inert) and buildCrushRunArgv() at run (CLI flags,
  // the load-bearing enforcement).
  CRUSH_ALLOW_BASH_PATTERNS,
  CRUSH_ALLOW_TOOLS,
  crushPermissionsRunBlock,
  mergeCrushPermissionsRun,
  // crush `--session <id>` is genuine get-or-create with caller-supplied ids —
  // NO slug->real-id map needed (unlike opencode's ses_ workaround).
  needsSessionMap: false,
};

export default crush;

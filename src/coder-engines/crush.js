// crush adapter — the SECOND coding engine behind `triss coder run --engine
// crush`. See docs/coder-agent-plan.md "Phase 6 recon (crush fork — 2026-07-05)"
// for the verified facts this adapter follows, and docs/crush-issues.md for the
// maintainer bug report (esp. the ZAI_API_KEY mismatch and the dirty version
// string).
//
// Scope of THIS file: PURE adapter functions — detect, argv/env builders,
// single-envelope parser, exit-reason mapper. NO process orchestration, NO
// isolation/worktree logic, NO logUsage. That lives in src/commands/coder.js
// (engine-agnostic), which calls into this adapter. Keeping the adapter pure
// means a future engine #3 slots in by adding a sibling file with the same
// member shape.

import { spawnSync as nodeSpawnSync } from 'node:child_process';

// Pin the npm package version. crush ≥0.1.3 reports a clean `crush version
// v0.1.3` (docs/crush-issues.md "[High] Version string does not match the
// release" — resolved in 0.1.3), so detect() now parses the semver and
// compares against this pin. The pin still also drives installHint().
const CRUSH_PIN_DEFAULT = '0.1.3';

// crush selects models by "atoms". For GLM the large atom is glm5_2 (GLM-5.2)
// and the small atom is glm5_turbo (GLM-5-turbo). `crush models use <large>
// <small> [--global|--local]` writes crush.json so `--role smart` -> large and
// `--role fast` -> small deterministically. Without this, crush may resolve to
// a non-GLM default atom (e.g. an Anthropic-via-local-claude-CLI atom) — so
// pinning these atoms is the ONE thing crush init must do beyond the shared
// ZHIPU_API_KEY setup. Kept as constants so a future model bump is one edit.
const CRUSH_LARGE_ATOM = 'glm5_2';
const CRUSH_SMALL_ATOM = 'glm5_turbo';

export function crushVersionPin() {
  return process.env.TRISS_CODER_CRUSH_VERSION || CRUSH_PIN_DEFAULT;
}

// Parse a `vX.Y.Z` semver out of arbitrary text (the crush --version stdout).
// Returns {major, minor, patch} or null when no semver is parseable. Tolerates
// a leading `v`, surrounding noise (`crush version v0.1.3`), and a `+dirty` /
// `-pre` suffix (the suffix is ignored — only the numeric core is captured).
// NEVER throws: garbage in -> null out.
function parseSemver(text) {
  if (text == null) return null;
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

// a >= b (lexicographic on major/minor/patch). Both inputs must be parsed.
function semverGte(a, b) {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}

// detect(): spawnSync('crush', ['--version']) — NEVER shell:true. crush 0.1.3+
// reports a clean `crush version v0.1.3`; earlier builds reported a dirty dev
// string like `v0.0.0-20260704...+dirty` (docs/crush-issues.md). We parse the
// `vX.Y.Z` semver out of whatever it prints and return {found, version,
// satisfiesPin}: `version` is the bare `0.1.3` (or the raw string when no
// semver is parseable, for diagnostics); `satisfiesPin` is parsed >= pin.
// NEVER throws — a `+dirty` suffix, garbage, or a NEWER version all yield a
// usable result (newer is still found:true, satisfiesPin:true). Version
// mismatch is NON-FATAL: callers warn at most, never abort (the installHint
// command still carries the pin for `npm install`). `sh` defaults to real
// spawnSync and is injectable for tests.
export function detectCrush(sh = nodeSpawnSync) {
  const r = sh('crush', ['--version']);
  if (!r || r.error || r.status !== 0) {
    return { found: false, version: null, satisfiesPin: false };
  }
  const out = String(r.stdout || '').trim();
  const parsed = parseSemver(out);
  const version = parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : out || null;
  const pin = parseSemver(crushVersionPin());
  const satisfiesPin = !!(parsed && pin && semverGte(parsed, pin));
  return { found: true, version, satisfiesPin };
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
// restrict: when ON (the default), append `--restrict-run` so crush honors the
// permissions.run policy seeded into crush.json at init (allow_bash +
// allow_tools). When OFF, append nothing — crush then auto-approves every tool
// (the pre-0.1.3 all-or-nothing behavior; only reachable via an explicit
// --no-restrict). The caller resolves the tristate (CLI/env/config/default)
// and passes a concrete boolean here.
export function buildCrushRunArgv({
  prompt,
  model,
  session,
  continue: cont,
  cwd,
  timeoutSec = 900,
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
  if (restrict) argv.push('--restrict-run');
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
// KEY BRIDGE: crush ≥0.1.1 reads `ZHIPU_API_KEY` natively (the ecosystem-
// standard name used by Z.AI's own docs, opencode, and triss). We forward
// `ZHIPU_API_KEY` straight through into the spawn env AND still forward
// `ZAI_API_KEY` as a compat alias for older crush binaries that read only
// that name (docs/crush-issues.md "[High] Provider env var mismatch" —
// fixed upstream in 0.1.1; the alias keeps <0.1.1 binaries working with a
// single user-facing ZHIPU_API_KEY). NEVER log either value (use
// maskValue() at the call site if anything is echoed).
export function buildCrushSpawnEnv(baseEnv = process.env) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (baseEnv[key] != null) env[key] = baseEnv[key];
  }
  if (baseEnv.ZHIPU_API_KEY) {
    env.ZHIPU_API_KEY = baseEnv.ZHIPU_API_KEY;
    env.ZAI_API_KEY = baseEnv.ZHIPU_API_KEY;
  }
  return env;
}

// parseCrushEnvelope: crush prints ONE JSON object on stdout at end of run
// (confirmed live, docs/crush-issues.md "What works well": "emits exactly one
// pure-JSON object on stdout"). Shape:
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
      'Provider: built-in zai (coding-plan endpoint, https://api.z.ai/api/coding/paas/v4).',
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

// Build the `permissions.run` block triss seeds into crush.json at init.
// restrict:true + the curated read-only allow_bash above + `view` as the only
// always-allowed non-bash tool — the crush analog of opencode's deny-first
// opencode.json bash policy. Returned fresh each call so callers can merge it
// into a config object without mutating the constant.
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
// any api_key into crush.json — the adapter bridges ZHIPU_API_KEY -> ZAI_API_KEY
// in the spawn env at run time (see buildCrushSpawnEnv).
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

// The adapter object — the shape a future engine #3 mirrors.
export const crush = {
  id: 'crush',
  binaryName: 'crush',
  // Pin drives installHint() AND the satisfiesPin comparison in detect()
  // (crush ≥0.1.3 reports a clean semver — see detectCrush).
  get CRUSH_PIN() {
    return crushVersionPin();
  },
  detect: detectCrush,
  installHint: installHintCrush,
  buildRunArgv: buildCrushRunArgv,
  buildSpawnEnv: buildCrushSpawnEnv,
  parseEnvelope: parseCrushEnvelope,
  mapExitReason: mapCrushExitReason,
  crushDefaultModelsHint,
  configureCrushModels,
  // permissions.run policy (crush 0.1.3+): the curated read-only bash
  // allowlist, the block builder, and the no-clobber merge helper. Used by
  // src/commands/coder.js seedCrushPermissions() at init.
  CRUSH_ALLOW_BASH_PATTERNS,
  crushPermissionsRunBlock,
  mergeCrushPermissionsRun,
  // crush `--session <id>` is genuine get-or-create with caller-supplied ids —
  // NO slug->real-id map needed (unlike opencode's ses_ workaround).
  needsSessionMap: false,
};

export default crush;

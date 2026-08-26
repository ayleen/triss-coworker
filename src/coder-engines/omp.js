// OMP adapter — the FOURTH coding engine (Oh My Pi) behind
// `triss coder run --engine omp`. See docs/engines/omp.md and
// docs/omp-engine-plan.md for the verified facts this adapter follows.
// Scope mirrors crush.js / opencode2.js: PURE adapter functions —
// detect, version gate, capability probe, argv/env builders,
// runtime-dir validation, policy overlay, models config, NDJSON fold.
// NO process orchestration, NO isolation/worktree logic, NO logUsage.
// That lives in src/commands/coder.js (engine-agnostic).

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync as nodeRealpathSync, rmSync, statSync as nodeStatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

// Hard supported floor — verified against omp/18.0.6 (arm64, 2026-08-26).
export const OMP_SUPPORTED_FLOOR = '18.0.6';
export const OMP_INVALID_MINIMUM_CODE = 'TRISS_CODER_OMP_MINIMUM_INVALID';

// Canonical stable semver x.y.z
const CANONICAL_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function versionFromMatch(match) {
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) return null;
  return { major: parts[0], minor: parts[1], patch: parts[2] };
}

function parseMinimumVersion(text) {
  if (text == null) return null;
  const m = CANONICAL_VERSION.exec(String(text).trim());
  return versionFromMatch(m);
}

// Installed output is "omp/<semver>" — also accept bare x.y.z for tool compat,
// but never strip prerelease/build suffixes.
function parseInstalledVersion(text) {
  if (text == null) return null;
  const value = String(text).trim();
  // Prefer omp/<semver> wrapper
  const ompWrapped = /^omp\/(.+)$/.exec(value);
  const candidate = ompWrapped ? ompWrapped[1] : value.replace(/^v/, '');
  const m = CANONICAL_VERSION.exec(candidate);
  return versionFromMatch(m);
}

function semverGte(a, b) {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}

function resolveOmpMinimumConfig() {
  const floor = parseMinimumVersion(OMP_SUPPORTED_FLOOR);
  const configuredRaw = process.env.TRISS_CODER_OMP_VERSION;
  const configuredUnset = configuredRaw == null || configuredRaw === '';
  const configuredParsed = parseMinimumVersion(configuredRaw);
  const configValid = configuredUnset || Boolean(configuredParsed);
  const effectiveParsed =
    !configuredUnset && configValid && semverGte(configuredParsed, floor)
      ? configuredParsed
      : floor;
  return { configuredRaw, configuredUnset, configuredParsed, configValid, floor, effectiveParsed };
}

export function ompVersionMinimum() {
  return process.env.TRISS_CODER_OMP_VERSION || OMP_SUPPORTED_FLOOR;
}

export function ompVersionPin() {
  const { effectiveParsed } = resolveOmpMinimumConfig();
  return `${effectiveParsed.major}.${effectiveParsed.minor}.${effectiveParsed.patch}`;
}

export function buildOmpProbeEnv(baseEnv = process.env) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) {
    if (baseEnv[key] != null) env[key] = baseEnv[key];
  }
  return env;
}

const REQUIRED_LAUNCH_CAPS = Object.freeze([
  '--mode', '--model', '--smol', '--session-dir',
  '--no-session', '--resume', '--continue',
  '--config', '--tools', '--approval-mode',
  '--no-extensions', '--no-skills', '--no-title', '--no-pty',
]);

const REQUIRED_MODELS_CAPS = Object.freeze(['--json', '--no-extensions']);

export function probeOmpCapabilities({ launchHelp = '', modelsHelp = '', version } = {}) {
  const launchMissing = REQUIRED_LAUNCH_CAPS.filter((flag) => !launchHelp.includes(flag));
  const modelsMissing = REQUIRED_MODELS_CAPS.filter((flag) => !modelsHelp.includes(flag));
  const missing = [...launchMissing, ...modelsMissing.map((f) => `models:${f}`)];
  if (!parseInstalledVersion(version ? `omp/${version}` : '')) {
    return { ok: false, version, reason: 'unsupported-version', missing: [], launchMissing, modelsMissing, help: launchHelp };
  }
  if (missing.length) {
    return { ok: false, version, reason: 'unsupported-cli-contract', missing, launchMissing, modelsMissing, help: launchHelp };
  }
  return { ok: true, version, missing: [], launchMissing: [], modelsMissing: [], help: launchHelp };
}

export function resolveOmpVersionPolicy(sh = nodeSpawnSync) {
  const { configuredRaw, configuredUnset, configuredParsed, configValid, floor, effectiveParsed } = resolveOmpMinimumConfig();
  const effectiveMinimum = `${effectiveParsed.major}.${effectiveParsed.minor}.${effectiveParsed.patch}`;
  const base = {
    found: false,
    installedVersion: null,
    configuredMinimum: configuredUnset ? null : String(configuredRaw),
    configValid,
    supportedFloor: OMP_SUPPORTED_FLOOR,
    effectiveMinimum,
    compatible: false,
    reason: configValid ? 'missing' : 'invalid_configured_minimum',
    capabilities: null,
  };
  let r;
  try {
    r = sh('omp', ['--version'], { env: buildOmpProbeEnv() });
  } catch {
    r = null;
  }
  if (!r || r.error || r.status !== 0) return base;
  const out = String(r.stdout || '').trim();
  const parsed = parseInstalledVersion(out);
  base.found = true;
  base.installedVersion = parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : (out || null);
  if (configValid) {
    if (!parsed) base.reason = 'version_unknown';
    else if (!semverGte(parsed, floor)) base.reason = 'below_floor';
    else if (!configuredUnset && !semverGte(parsed, configuredParsed)) base.reason = 'below_configured_minimum';
    else {
      // Capability probe — version alone is not admission
      // eslint-disable-next-line no-useless-assignment -- probe overwrites these when spawn succeeds
      let launchHelp = '';
      // eslint-disable-next-line no-useless-assignment
      let modelsHelp = '';
      // eslint-disable-next-line no-useless-assignment
      let capOk = false;
      try {
        const lh = sh('omp', ['--help'], { env: buildOmpProbeEnv() });
        launchHelp = `${lh?.stdout || ''}\n${lh?.stderr || ''}`;
        const mh = sh('omp', ['models', '--help'], { env: buildOmpProbeEnv() });
        modelsHelp = `${mh?.stdout || ''}\n${mh?.stderr || ''}`;
        const cap = probeOmpCapabilities({ launchHelp, modelsHelp, version: base.installedVersion });
        base.capabilities = cap;
        capOk = cap.ok;
        if (!capOk) base.reason = 'unsupported-cli-contract';
        else base.reason = 'compatible';
      } catch {
        base.reason = 'unsupported-cli-contract';
        base.capabilities = { ok: false, reason: 'unsupported-cli-contract', missing: [], help: '' };
      }
      if (base.reason === 'compatible') {
        // leave as compatible
      } else if (parsed && semverGte(parsed, floor) && (configuredUnset || semverGte(parsed, configuredParsed))) {
        // keep unsupported-cli-contract reason
      }
    }
  }
  base.compatible = base.reason === 'compatible';
  return base;
}

export function assertOmpVersionPolicy(policy) {
  if (policy.compatible) return policy;
  const eff = policy.effectiveMinimum;
  const installCmd = 'curl https://omp.sh/install | sh';
  if (policy.reason === 'invalid_configured_minimum') {
    const error = new Error(
      `Invalid OMP minimum version "${String(policy.configuredMinimum)}" (is not a canonical stable x.y.z version); set TRISS_CODER_OMP_VERSION to a canonical stable x.y.z version >= ${policy.supportedFloor}. No engine was started.`,
    );
    error.code = OMP_INVALID_MINIMUM_CODE;
    throw error;
  }
  if (policy.reason === 'missing') throw new Error(`omp not found — install: ${installCmd} (minimum ${eff})`);
  if (policy.reason === 'version_unknown') throw new Error(`omp version could not be determined (${JSON.stringify(policy.installedVersion)}) — minimum supported version is ${eff}. Reinstall: ${installCmd}`);
  if (policy.reason === 'unsupported-cli-contract') {
    const miss = policy.capabilities?.missing?.join(', ') || '';
    throw new Error(`omp ${policy.installedVersion} found but lacks required CLI capabilities${miss ? ` (missing: ${miss})` : ''} — minimum ${eff} with capabilities ${REQUIRED_LAUNCH_CAPS.join(', ')}.`);
  }
  throw new Error(`omp ${policy.installedVersion} found, minimum supported version is ${eff} — upgrade: ${installCmd}`);
}

// detectOmp — resolve absolute path, realpath, executable check, version + capability gate.
// Returns {found, path, version, minimumVersion, satisfiesMinimum, meetsMinimum, satisfiesPin, capabilities}
export function detectOmp(sh = nodeSpawnSync, fs = {}) {
  const realpathSync = fs.realpathSync || nodeRealpathSync;
  const statSync = fs.statSync || nodeStatSync;
  const probeEnv = buildOmpProbeEnv();
  let resolvedPath = null;
  try {
    const w = sh('which', ['omp'], { env: probeEnv });
    if (w && !w.error && w.status === 0) {
      const p = String(w.stdout || '').trim().split('\n').filter(Boolean).pop();
      if (p) resolvedPath = p;
    }
  } catch {}
  if (!resolvedPath) return { found: false, path: null, version: null, satisfiesPin: false, meetsMinimum: false, satisfiesMinimum: false, capabilities: null };
  if (!isAbsolute(resolvedPath)) return { found: false, path: null, version: null, satisfiesPin: false, meetsMinimum: false, satisfiesMinimum: false, capabilities: null };
  let realPath;
  try { realPath = realpathSync(resolvedPath); } catch { return { found: false, path: null, version: null, satisfiesPin: false, meetsMinimum: false, satisfiesMinimum: false, capabilities: null }; }
  if (!isAbsolute(realPath)) return { found: false, path: null, version: null, satisfiesPin: false, meetsMinimum: false, satisfiesMinimum: false, capabilities: null };
  try {
    const st = statSync(realPath);
    if (!st.isFile() || (st.mode & 0o111) === 0) return { found: false, path: null, version: null, satisfiesPin: false, meetsMinimum: false, satisfiesMinimum: false, capabilities: null };
  } catch { return { found: false, path: null, version: null, satisfiesPin: false, meetsMinimum: false, satisfiesMinimum: false, capabilities: null }; }

  // Probe version + capabilities under isolated PI_CODING_AGENT_DIR
  let isolated = null;
  try {
    const makeTemp = fs.mkdtempSync || mkdtempSync;
    const makeDir = fs.mkdirSync || mkdirSync;
    const remove = fs.rmSync || rmSync;
    const root = makeTemp(join(tmpdir(), 'triss-omp-probe-'));
    isolated = { root, remove };
    const isoEnv = { ...probeEnv, PI_CODING_AGENT_DIR: join(root, 'agent') };
    // Ensure agent dir exists for probe
    makeDir(isoEnv.PI_CODING_AGENT_DIR, { recursive: true, mode: 0o700 });
    const vr = sh(realPath, ['--version'], { env: isoEnv });
    const out = String(vr?.stdout || '').trim();
    const parsed = parseInstalledVersion(out);
    const version = parsed ? `${parsed.major}.${parsed.minor}.${parsed.patch}` : null;
    if (!vr || vr.error || vr.status !== 0 || !parsed) {
      return { found: false, path: realPath, version, satisfiesPin: false, meetsMinimum: false, satisfiesMinimum: false, capabilities: null };
    }
    // Capabilities
    let launchHelp = '';
    let modelsHelp = '';
    try {
      const lh = sh(realPath, ['--help'], { env: isoEnv });
      launchHelp = `${lh?.stdout || ''}\n${lh?.stderr || ''}`;
      const mh = sh(realPath, ['models', '--help'], { env: isoEnv });
      modelsHelp = `${mh?.stdout || ''}\n${mh?.stderr || ''}`;
    } catch {}
    const cap = probeOmpCapabilities({ launchHelp, modelsHelp, version });
    const minimum = parseMinimumVersion(ompVersionPin());
    const installed = parseMinimumVersion(version);
    const satisfiesMinimum = !!(cap.ok && minimum && installed && semverGte(installed, minimum));
    return {
      found: cap.ok && satisfiesMinimum,
      path: realPath,
      version,
      minimumVersion: ompVersionPin(),
      satisfiesMinimum,
      meetsMinimum: satisfiesMinimum,
      satisfiesPin: satisfiesMinimum,
      capabilities: cap,
    };
  } catch {
    return { found: false, path: realPath, version: null, satisfiesPin: false, meetsMinimum: false, satisfiesMinimum: false, capabilities: { ok: false, reason: 'capability-probe-unavailable', missing: [], help: '' } };
  } finally {
    if (isolated) try { isolated.remove(isolated.root, { recursive: true, force: true }); } catch {}
  }
}

export function installHintOmp() {
  return `curl https://omp.sh/install | sh  # minimum ${ompVersionPin()} (hard floor ${OMP_SUPPORTED_FLOOR})`;
}

// ─── argv / env builders ────────────────────────────────────────────────────

export function buildOmpRunArgv({
  prompt,
  model,
  smallModel,
  sessionDir,
  sessionRealId,
  cont = false,
  noSession = false,
  configPath,
  tools: toolList = 'read,write,edit,glob,grep,bash,todo',
} = {}) {
  if (!prompt || typeof prompt !== 'string') throw new TypeError('buildOmpRunArgv: prompt is required');
  if (!model || typeof model !== 'string') throw new TypeError('buildOmpRunArgv: model is required');
  if (!sessionDir || typeof sessionDir !== 'string') throw new TypeError('buildOmpRunArgv: sessionDir is required');
  if (!configPath || typeof configPath !== 'string') throw new TypeError('buildOmpRunArgv: configPath is required');
  if (sessionRealId && cont) throw new Error('--resume and --continue are mutually exclusive');
  if (noSession && (sessionRealId || cont)) throw new Error('--no-session is exclusive with --resume/--continue');

  const argv = [
    '-p',
    '--mode', 'json',
    '--model', model,
    '--session-dir', sessionDir,
    '--no-title', '--no-extensions', '--no-skills', '--no-pty',
    '--approval-mode', 'write',
    '--tools', toolList,
    '--config', configPath,
  ];
  if (smallModel) argv.push('--smol', smallModel);
  if (noSession) argv.push('--no-session');
  else if (sessionRealId) argv.push('--resume', sessionRealId);
  else if (cont) argv.push('--continue');
  argv.push('--', prompt);
  return argv;
}

export function buildOmpSpawnEnv({
  projectRoot: _projectRoot,
  baseEnv = process.env,
  credentialEnv,
  credentialValue,
  proxy = null,
  agentDir,
  extraEnv = {},
} = {}) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) {
    if (baseEnv[key] != null) env[key] = baseEnv[key];
  }
  if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
  // Provider credential handling is done by the caller via credentialEnv/value or proxy.
  // Never spread baseEnv credentials blindly — only the ONE selected provider credential
  // is forwarded (see plan §4.4/5). The raw-credential path sets credentialEnv/value;
  // the protected path sets proxy.token -> ZAI_API_KEY alias + upstream bridge handled below.
  if (proxy && proxy.token && proxy.baseUrl) {
    // Protected proxy: only proxy token (bridged to provider-specific var by caller)
    // For now expose as the selected credential env pointing at proxy URL indirectly;
    // the transient provider config points at proxy.baseUrl.
    // Preserve proxy token under the provider's expected var is handled by caller
    // mapping (e.g. ZHIPU→ZAI). Here just set a generic marker is NOT needed —
    // caller sets credentialEnv to proxy token explicitly.
    // This function is intentionally minimal; caller composes final credential vars.
    env._TRISS_OMP_PROXY = '1';
    if (proxy.token) {
      // Expose proxy token under OPENCODE_API_KEY fallback for audit parity;
      // real provider var is set by caller via credentialEnv.
    }
  }
  const value = credentialValue === undefined ? (credentialEnv ? baseEnv[credentialEnv] : undefined) : credentialValue;
  if (credentialEnv && value) env[credentialEnv] = value;
  // Bridge ZHIPU_API_KEY -> ZAI_API_KEY for zai provider (OMP expects ZAI_API_KEY)
  if (env.ZHIPU_API_KEY && !env.ZAI_API_KEY) env.ZAI_API_KEY = env.ZHIPU_API_KEY;
  // Moonshot CN base URL is injected via env when needed
  if (extraEnv.MOONSHOT_BASE_URL) env.MOONSHOT_BASE_URL = extraEnv.MOONSHOT_BASE_URL;
  // Extra validated env passthrough (only explicit allowlisted keys)
  for (const [k, v] of Object.entries(extraEnv)) {
    if (['MOONSHOT_BASE_URL'].includes(k) && v) env[k] = v;
  }
  return env;
}

// ─── runtime dirs ───────────────────────────────────────────────────────────

export function ompDataRoot(projectRoot) {
  return join(projectRoot, '.triss', 'omp');
}
export function ompSessionsRoot(projectRoot) {
  return join(projectRoot, '.triss', 'omp', 'sessions');
}
export function ompRunsRoot(projectRoot) {
  return join(projectRoot, '.triss', 'omp', 'runs');
}

function assertNoSymlinkAncestors(root, dir, created) {
  const rel = relative(root, dir);
  if (!rel || rel.startsWith('..')) throw new Error(`OMP runtime root ${dir} is not inside ${root}.`);
  const parts = rel.split(sep).filter(Boolean);
  let cur = root;
  for (const part of parts) {
    cur = join(cur, part);
    let st;
    try { st = lstatSync(cur); } catch (err) {
      if (err?.code !== 'ENOENT') throw new Error(`Cannot inspect OMP runtime path component ${cur}: ${err.message}`, { cause: err });
      mkdirSync(cur, { mode: 0o700 });
      if (created) created.push(cur);
      st = lstatSync(cur);
    }
    if (st.isSymbolicLink()) throw new Error(`OMP runtime path component ${cur} is a symlink — refusing to place credential state behind a symlink. Remove it.`);
    if (!st.isDirectory()) throw new Error(`OMP runtime path component ${cur} is not a directory.`);
    if ((st.mode & 0o777) !== 0o700) {
      chmodSync(cur, 0o700);
      const after = lstatSync(cur);
      if ((after.mode & 0o777) !== 0o700) throw new Error(`OMP runtime path component ${cur} mode could not be corrected to 0700 (still ${(after.mode & 0o777).toString(8)}).`);
    }
  }
}

export function ensureOmpRuntimeDirs(projectRoot, runId = null) {
  const created = [];
  const sessions = ompSessionsRoot(projectRoot);
  assertNoSymlinkAncestors(projectRoot, sessions, created);
  let st = lstatSync(sessions);
  if (st.isSymbolicLink()) throw new Error(`OMP sessions root ${sessions} is a symlink`);
  if (!st.isDirectory()) throw new Error(`OMP sessions root ${sessions} is not a directory`);
  if (runId) {
    const agentDir = join(ompRunsRoot(projectRoot), runId, 'agent');
    assertNoSymlinkAncestors(projectRoot, agentDir, created);
    st = lstatSync(agentDir);
    if (st.isSymbolicLink()) throw new Error(`OMP agent dir ${agentDir} is a symlink`);
    if (!st.isDirectory()) throw new Error(`OMP agent dir ${agentDir} is not a directory`);
    return { created, sessions, agentDir };
  }
  return { created, sessions, agentDir: null };
}

// ─── policy overlay ─────────────────────────────────────────────────────────

// OMP policy overlay (docs/settings.md).
//
// bash.patterns lives at the TOP level (not tools.bash.patterns) and uses
// { match, approval } with values 'allow' | 'prompt' | 'deny'. OMP deep-merges
// settings but REPLACES arrays wholesale, so the overlay MUST include a
// catch-all rule to lock down the unlisted commands. For protected mode, the
// same catch-all deny runs first; the policy layer is also re-pinned via
// tools.approval.bash: deny so the bash tool itself stays inert.
export function buildOmpPolicyOverlay({ protectCredentials = false } = {}) {
  const bashPatterns = protectCredentials
    ? [{ match: '*', approval: 'deny' }]
    : [
        { match: 'git status*', approval: 'allow' },
        { match: 'git diff*', approval: 'allow' },
        { match: 'git log*', approval: 'allow' },
        { match: 'ls *', approval: 'allow' },
        { match: 'node --test*', approval: 'allow' },
        { match: 'npm test*', approval: 'allow' },
        { match: 'npm run test*', approval: 'allow' },
        // Catch-all MUST be last — OMP picks the first matching rule.
        { match: '*', approval: 'deny' },
      ];

  return {
    memory: { backend: 'off' },
    async: { enabled: false },
    tools: {
      approvalMode: 'write',
      approval: {
        bash: protectCredentials ? 'deny' : 'allow',
        eval: 'deny',
        task: 'deny',
        hub: 'deny',
        web_search: 'deny',
      },
    },
    bash: { patterns: bashPatterns },
  };
}

export function renderOmpPolicyYaml(overlay) {
  if (!overlay || !overlay.bash || !Array.isArray(overlay.bash.patterns)) {
    throw new TypeError('renderOmpPolicyYaml: overlay.bash.patterns is required');
  }
  const lines = [];
  // Top-level keys (order is irrelevant; the YAML parser accepts any order)
  if (overlay.memory) {
    lines.push('memory:');
    for (const [k, v] of Object.entries(overlay.memory)) lines.push(`  ${k}: ${formatScalar(v)}`);
  }
  if (overlay.async) {
    lines.push('async:');
    for (const [k, v] of Object.entries(overlay.async)) lines.push(`  ${k}: ${formatScalar(v)}`);
  }
  lines.push('tools:');
  if (overlay.tools.approvalMode) lines.push(`  approvalMode: ${formatScalar(overlay.tools.approvalMode)}`);
  if (overlay.tools.approval) {
    lines.push('  approval:');
    for (const [k, v] of Object.entries(overlay.tools.approval)) lines.push(`    ${k}: ${formatScalar(v)}`);
  }
  lines.push('bash:');
  lines.push('  patterns:');
  for (const rule of overlay.bash.patterns) {
    lines.push(`    - match: ${JSON.stringify(rule.match)}`);
    lines.push(`      approval: ${formatScalar(rule.approval)}`);
  }
  return lines.join('\n') + '\n';
}

// Emit a YAML scalar. Strings that contain only safe characters (alphanumerics,
// hyphens, underscores, dots, slashes, asterisks, and spaces) are emitted
// unquoted; anything more exotic gets JSON-quoted. This matches the OMP docs
// style (unquoted enums like "deny", "allow", "write") while staying safe for
// URLs and apiKey names.
function formatScalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    if (/^[A-Za-z0-9_./\- ]*$/.test(v)) return v;
    return JSON.stringify(v);
  }
  return JSON.stringify(v);
}

// ─── models config ──────────────────────────────────────────────────────────

const TRISS_TO_OMP_PROTOCOL = Object.freeze({
  openai_chat: 'openai-completions',
  openai_responses: 'openai-responses',
  anthropic_messages: 'anthropic-messages',
});

// OMP model registry accepts ONLY these api values (docs/models.md). An unknown
// value would let the engine silently fall through to a default transport, so
// reject it BEFORE spawn.
export const OMP_SUPPORTED_PROTOCOLS = Object.freeze(['openai-completions', 'openai-responses', 'anthropic-messages']);

function toOmpProtocol(protocol) {
  if (!protocol) return 'openai-completions';
  const mapped = TRISS_TO_OMP_PROTOCOL[protocol];
  if (mapped) return mapped;
  if (OMP_SUPPORTED_PROTOCOLS.includes(protocol)) return protocol;
  return null;
}

export function buildOmpModelsConfig({ providerRoute, proxy = null, credentialEnv }) {
  if (!providerRoute || !providerRoute.modelId) throw new TypeError('buildOmpModelsConfig: providerRoute with modelId is required');
  const ompProtocol = toOmpProtocol(providerRoute.protocol);
  if (!ompProtocol) {
    throw new Error(`Unsupported OMP protocol ${providerRoute.protocol} — supported: ${OMP_SUPPORTED_PROTOCOLS.join(', ')}`);
  }
  const baseURL = proxy?.baseUrl || providerRoute.endpoint + (providerRoute.pathPrefix || '');
  // OMP real schema (docs/models.md): provider has baseUrl, apiKey, api at the
  // top level; models is an ARRAY of { id, name, api, contextWindow, maxTokens }.
  // Anything else (baseURL/apiKeyEnv/models-as-object) is silently ignored.
  return {
    providers: {
      'triss-coder-transient': {
        baseUrl: baseURL,
        apiKey: credentialEnv,
        api: ompProtocol,
        models: [
          {
            id: providerRoute.modelId,
            name: `triss-coder-transient/${providerRoute.modelId}`,
            api: ompProtocol,
            contextWindow: providerRoute.contextWindow || 128000,
            maxTokens: providerRoute.maxTokens || 16384,
          },
        ],
      },
    },
  };
}

// Render the OMP models config as a YAML string. The runtime file is
// <PI_CODING_AGENT_DIR>/models.yml, the canonical OMP provider registry
// (docs/models.md). YAML emission is a minimal mapping serializer — OMP reads
// the file with the standard YAML parser, and the structure is small enough
// that a hand-rolled renderer avoids adding js-yaml as a direct dep.
export function renderOmpModelsYaml(config) {
  if (!config || !config.providers) throw new TypeError('renderOmpModelsYaml: config.providers is required');
  const lines = ['providers:'];
  for (const [providerId, provider] of Object.entries(config.providers)) {
    lines.push(`  ${formatScalar(providerId)}:`);
    if (provider.baseUrl != null) lines.push(`    baseUrl: ${formatScalar(provider.baseUrl)}`);
    if (provider.apiKey != null) lines.push(`    apiKey: ${formatScalar(provider.apiKey)}`);
    if (provider.api != null) lines.push(`    api: ${formatScalar(provider.api)}`);
    if (Array.isArray(provider.models) && provider.models.length > 0) {
      lines.push('    models:');
      for (const m of provider.models) {
        lines.push(`      - id: ${formatScalar(m.id)}`);
        if (m.name) lines.push(`        name: ${formatScalar(m.name)}`);
        if (m.api) lines.push(`        api: ${formatScalar(m.api)}`);
        if (m.contextWindow) lines.push(`        contextWindow: ${m.contextWindow}`);
        if (m.maxTokens) lines.push(`        maxTokens: ${m.maxTokens}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

// ─── NDJSON fold ────────────────────────────────────────────────────────────

export function createOmpEventFolder() {
  return {
    sawParseableEvent: false,
    sessionId: null,
    terminalAgentEnd: false,
    sawTerminalAgentEnd: false,
    finalText: null,
    assistantMessages: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, _rawCosts: [] },
    provider: null,
    model: null,
    stopReason: null,
    terminalError: null,
    toolActivity: new Map(),
    warnings: [],
    invalidLines: 0,
    retryCount: 0,
    isTerminalError: false,
  };
}

export function foldOmpEventLine(state, rawLine) {
  const line = String(rawLine).trim();
  if (!line) return;
  let evt;
  try { evt = JSON.parse(line); } catch {
    state.warnings.push(`unparseable line: ${line.slice(0, 200)}`);
    state.invalidLines += 1;
    return;
  }
  state.sawParseableEvent = true;

  const type = evt.type;
  if (!type) {
    state.warnings.push(`unknown event without type: ${line.slice(0, 200)}`);
    return;
  }

  switch (type) {
    case 'session': {
      const id = evt.id;
      if (!id) { state.warnings.push('session event missing id'); break; }
      if (state.sessionId && state.sessionId !== id) {
        throw new Error(`conflicting session ids: ${state.sessionId} vs ${id}`);
      }
      if (!state.sessionId) state.sessionId = id;
      break;
    }
    case 'agent_start':
    case 'turn_start':
    case 'turn_end':
    case 'message_start':
      break;
    case 'message_update':
      // progress only
      break;
    case 'message_end': {
      if (evt.role === 'assistant' || !evt.role) {
        const text = Array.isArray(evt.content) ? evt.content.filter(c=>c.type==='text').map(c=>c.text).join('') : (evt.content || '');
        // Keep last assistant text as current final; de-duplicate later in finalize if agent_end repeats it
        if (text) state.finalText = text;
        if (evt.provider) state.provider = evt.provider;
        if (evt.model) state.model = evt.model;
        if (evt.stopReason) state.stopReason = evt.stopReason;
        if (evt.errorMessage) { state.terminalError = evt.errorMessage; state.isTerminalError = true; }
        else if (evt.stopReason === 'error' && !state.terminalError) { state.isTerminalError = true; }
        if (evt.usage) {
          const u = evt.usage;
          // Aggregate once per message_end — idempotence is caller's job to avoid double count of agent_end copy
          const key = `${evt.provider || ''}/${evt.model || ''}/${evt.stopReason || ''}/${text.slice(0,50)}`;
          if (!state.assistantMessages.includes(key)) {
            state.assistantMessages.push(key);
            state.usage.input += Number(u.input) || 0;
            state.usage.output += Number(u.output) || 0;
            state.usage.cacheRead += Number(u.cacheRead) || 0;
            state.usage.cacheWrite += Number(u.cacheWrite) || 0;
            state.usage.totalTokens += Number(u.totalTokens) || 0;
            if (u.cost && typeof u.cost.total === 'number' && Number.isFinite(u.cost.total)) state.usage._rawCosts.push(u.cost.total);
          }
        }
      }
      break;
    }
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_execution_end': {
      const id = evt.toolCallId || evt.id || 'unknown';
      const name = evt.toolName || evt.tool || 'unknown';
      const entry = state.toolActivity.get(id) || { toolName: name, status: 'running', args: evt.args || null, result: null, error: null, timestamps: [] };
      entry.toolName = name;
      if (evt.args) entry.args = evt.args;
      if (type === 'tool_execution_end') {
        entry.status = evt.status || (evt.error ? 'error' : 'success');
        entry.result = evt.result || null;
        entry.error = evt.error || null;
      }
      entry.timestamps.push(Date.now());
      state.toolActivity.set(id, entry);
      break;
    }
    case 'agent_end': {
      const isTerminal = evt.isTerminal !== false;
      if (isTerminal) {
        state.sawTerminalAgentEnd = true;
        state.terminalAgentEnd = true;
        if (evt.errorMessage && !state.terminalError) { state.terminalError = evt.errorMessage; state.isTerminalError = true; }
      } else {
        state.warnings.push('non-terminal agent_end ignored');
      }
      break;
    }
    default: {
      // Unknown valid JSON — warning, not failure
      state.warnings.push(`unknown OMP event type: ${type}`);
      break;
    }
  }
}

export function finalizeOmpEnvelopeState(state, { exitCode = 0, timedOut = false, killed = false } = {}) {
  if (timedOut) return { exitReason: 'timeout', finalText: state.finalText, usage: state.usage, provider: state.provider, model: state.model, sessionId: state.sessionId, warnings: state.warnings, toolActivity: [...state.toolActivity.values()], isError: false };
  if (killed) return { exitReason: 'killed', finalText: state.finalText, usage: state.usage, provider: state.provider, model: state.model, sessionId: state.sessionId, warnings: state.warnings, toolActivity: [...state.toolActivity.values()], isError: false };
  if (state.isTerminalError || state.terminalError) return { exitReason: 'error', finalText: state.finalText, usage: state.usage, provider: state.provider, model: state.model, sessionId: state.sessionId, warnings: state.warnings, toolActivity: [...state.toolActivity.values()], isError: true, errorMessage: state.terminalError };
  if (exitCode !== 0) return { exitReason: 'error', finalText: state.finalText, usage: state.usage, provider: state.provider, model: state.model, sessionId: state.sessionId, warnings: state.warnings, toolActivity: [...state.toolActivity.values()], isError: true };
  if (state.sawTerminalAgentEnd || state.stopReason === 'stop') return { exitReason: 'end_turn', finalText: state.finalText, usage: state.usage, provider: state.provider, model: state.model, sessionId: state.sessionId, warnings: state.warnings, toolActivity: [...state.toolActivity.values()], isError: false };
  if (state.sawParseableEvent) {
    state.warnings.push('parseable but incomplete stream — no terminal agent_end');
    return { exitReason: 'error', finalText: state.finalText, usage: state.usage, provider: state.provider, model: state.model, sessionId: state.sessionId, warnings: state.warnings, toolActivity: [...state.toolActivity.values()], isError: true };
  }
  throw new Error('unparseable OMP output — no parseable events');
}

export const omp = {
  id: 'omp',
  binaryName: 'omp',
  get OMP_PIN() { return ompVersionPin(); },
  detect: detectOmp,
  installHint: installHintOmp,
  resolveVersionPolicy: resolveOmpVersionPolicy,
  assertVersionPolicy: assertOmpVersionPolicy,
  buildProbeEnv: buildOmpProbeEnv,
  OMP_INVALID_MINIMUM_CODE,
  OMP_SUPPORTED_PROTOCOLS,
  buildRunArgv: buildOmpRunArgv,
  buildSpawnEnv: buildOmpSpawnEnv,
  ensureRuntimeDirs: ensureOmpRuntimeDirs,
  buildPolicyOverlay: buildOmpPolicyOverlay,
  renderPolicyYaml: renderOmpPolicyYaml,
  buildModelsConfig: buildOmpModelsConfig,
  renderModelsYaml: renderOmpModelsYaml,
  createEventFolder: createOmpEventFolder,
  foldEventLine: foldOmpEventLine,
  finalizeEnvelopeState: finalizeOmpEnvelopeState,
  needsSessionMap: true,
  supportsSmallModel: true,
  supportsAgent: false,
  supportsRestrict: false,
};

export default omp;
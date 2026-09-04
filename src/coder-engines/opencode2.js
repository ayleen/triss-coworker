// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// opencode2 adapter — the THIRD coding engine (OpenCode 2 beta) behind
// `triss coder run --engine opencode2`. See docs/opencode2-engine-plan.md for
// the verified facts this adapter follows. Scope mirrors crush.js: PURE
// adapter functions — detect, argv/env builders, event fold, capabilities.
// NO process orchestration (that stays in src/commands/coder.js spawnEngine),
// NO isolation logic, NO logUsage.
//
// Verified-against-the-supported-beta facts encoded here (live recon against
// the current beta line; see the routing recovery plan):
//   - CLI surface: `run --standalone --format json --auto
//     --model <provider/model#variant> [--agent <a>]
//     [--session <id> | --continue] <prompt>`; NO separate --variant, NO
//     --pure and NO --dir (child cwd selects the project).
//   - Events on stdout are ndjson with the SAME event vocabulary as V1
//     (step_start/tool_use/step_finish/text/error) but TWO differences the
//     fold must handle: (1) `error.message` is populated (V1 parsers read
//     only error.data.message/error.name); (2) `step_finish` may arrive BEFORE
//     the final `text` event on tool runs — order-independent folding only.
//   - `--standalone` is REQUIRED for managed runs: every other startup mode
//     leaves a resident `opencode2 serve --service` process behind (verified
//     live — even `opencode2 debug config` spawns one). Standalone leaves no
//     descendant.
//   - Version compatibility follows the supported beta floor and the CLI
//     capability probe; unsupported next/dev/tui channels fail closed.
//   - Auto-update must be disabled per invocation (OPENCODE_DISABLE_AUTOUPDATE
//     =1) so the verified pin cannot drift under us.
//   - Runtime state is isolated into a Triss-owned XDG root
//     (<project>/.triss/opencode2/{data,state}) so V2's SQLite/log files can
//     never collide with V1's ~/.local/share/opencode.

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync as nodeRealpathSync, rmSync, statSync as nodeStatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';

import { emptyOpencodeUsage, foldOpencodeStep, finalizeOpencodeUsage } from '../usage-schema.js';
import { parseRateLimitReset } from '../commands/coder.js';

// Minimum supported OpenCode 2 release. Compatibility is never an exact pin:
// every parseable version at or above this floor remains eligible when its
// required CLI capabilities are present.
export const OPENCODE2_MIN_VERSION_DEFAULT = '0.0.0-beta-19059';
export const OPENCODE2_SMALL_MODEL_UNUSED_WARNING =
  'OPENCODE2_SMALL_MODEL_UNUSED: --small-model was validated but is not used by OpenCode 2.';
export const OPENCODE2_SERVICE_SNAPSHOT_WARNING =
  'OPENCODE2_SERVICE_SNAPSHOT_UNAVAILABLE: the host cannot inspect resident OpenCode 2 service processes; continuing with the verified --standalone CLI contract as best effort.';
// Deprecated export/name retained for callers during the migration.  It now
// denotes the minimum accepted version rather than an exact build pin.
const OPENCODE2_PIN_DEFAULT = OPENCODE2_MIN_VERSION_DEFAULT;
const BETA_VERSION_RE = /^(0\.0\.0)-beta-(\d+)$/;
const STABLE_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const REQUIRED_CAPABILITIES = Object.freeze(['--standalone', '--format', '--auto', '--model']);
const OPTION_ALIAS_LIST_RE =
  /^(?:--[a-z0-9][a-z0-9-]*|-[a-z0-9])(?:\s*,\s*(?:--[a-z0-9][a-z0-9-]*|-[a-z0-9]))*(?=\s|$)/iu;
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu');
const HELP_SECTION_HEADING_RE = /^[A-Z][A-Z ]*:?\s*$/iu;

// `opencode2 --version` prefixes the version with the executable name. Keep
// the token extraction deliberately broader than the set of supported
// channels so an unsupported channel (for example `-dev`, `-next`, or
// `-tui`) is passed to the canonical parser as a whole. A narrow regex that
// only knows about beta/next can truncate `0.0.0-dev-17819` to `0.0.0` and
// accidentally classify it as a supported stable release.
const VERSION_TOKEN_RE = /(?:^|\s)(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)(?=\s|$)/;

function parseOpenCode2VersionOutput(value) {
  const match = VERSION_TOKEN_RE.exec(String(value || '').trim());
  if (!match) return null;
  const token = match[1];
  return parseOpenCode2Version(token) ? token.replace(/^v/u, '') : null;
}

export function parseOpenCode2Version(value) {
  const raw = String(value || '').trim().replace(/^v/, '');
  const beta = BETA_VERSION_RE.exec(raw);
  if (beta) return { raw, channel: 'beta', major: 0, minor: 0, patch: 0, ordinal: Number(beta[2]) };
  const stable = STABLE_VERSION_RE.exec(raw);
  if (stable) return { raw, channel: 'stable', major: Number(stable[1]), minor: Number(stable[2]), patch: Number(stable[3]), ordinal: null };
  return null;
}

export function compareOpenCode2Versions(a, b) {
  const left = typeof a === 'string' ? parseOpenCode2Version(a) : a;
  const right = typeof b === 'string' ? parseOpenCode2Version(b) : b;
  if (!left || !right) return null;
  if (left.channel === 'beta' && right.channel === 'beta') return Math.sign(left.ordinal - right.ordinal);
  if (left.channel === 'stable' && right.channel === 'stable') {
    return Math.sign((left.major - right.major) || (left.minor - right.minor) || (left.patch - right.patch));
  }
  return left.channel === 'stable' ? 1 : -1;
}

export function opencode2MinimumVersion() {
  const configured = process.env.TRISS_CODER_OPENCODE2_VERSION;
  if (!configured) return OPENCODE2_MIN_VERSION_DEFAULT;
  const configuredVersion = parseOpenCode2Version(configured);
  if (!configuredVersion) return OPENCODE2_MIN_VERSION_DEFAULT;
  return compareOpenCode2Versions(configuredVersion, OPENCODE2_MIN_VERSION_DEFAULT) >= 0
    ? configuredVersion.raw
    : OPENCODE2_MIN_VERSION_DEFAULT;
}

export function installChannelOpenCode2() {
  return '@opencode-ai/cli@beta';
}

export function opencode2VersionPin() {
  return opencode2MinimumVersion();
}

export { OPENCODE2_PIN_DEFAULT };

// Parse actual option declarations inside FLAGS/GLOBAL FLAGS instead of
// searching arbitrary help substrings. Heading case, an optional colon, ANSI
// styling, and per-record indentation are presentation details and must not
// reject a newer compatible build. Every option-shaped line in these sections
// is authoritative and all long aliases qualify. Because indentation is
// intentionally ignored, nested option-shaped prose is indistinguishable from
// a declaration; accepting it is the forward-compatible choice for help emitted
// by the locally installed binary.
function openCode2OptionNames(help) {
  const options = new Set();
  let inOptionSection = false;
  const plainHelp = String(help || '').replace(ANSI_ESCAPE_RE, '');
  for (const line of plainHelp.split(/\r?\n/u)) {
    const trimmed = line.trim();
    const indent = /^\s*/u.exec(line)?.[0].length || 0;
    if (indent === 0 && HELP_SECTION_HEADING_RE.test(trimmed)) {
      const heading = trimmed.replace(/:\s*$/u, '').toUpperCase();
      inOptionSection = heading === 'FLAGS' || heading === 'GLOBAL FLAGS';
      continue;
    }
    if (!inOptionSection || !trimmed) continue;
    const aliasList = OPTION_ALIAS_LIST_RE.exec(trimmed)?.[0];
    if (!aliasList) continue;
    for (const match of aliasList.matchAll(/--[a-z0-9][a-z0-9-]*/giu)) {
      options.add(match[0]);
    }
  }
  return options;
}

export function probeOpenCode2Capabilities(path, version, sh = nodeSpawnSync, env = {}) {
  let helpResult;
  try {
    helpResult = sh(path, ['run', '--help'], { env });
  } catch (err) {
    helpResult = { status: 1, error: err, stdout: '', stderr: '' };
  }
  const help = `${helpResult?.stdout || ''}\n${helpResult?.stderr || ''}`;
  const options = openCode2OptionNames(help);
  const missing = REQUIRED_CAPABILITIES.filter((flag) => !options.has(flag));
  return !parseOpenCode2Version(version)
    ? { ok: false, version, reason: 'unsupported-version', missing: [], help: '' }
    : !helpResult || helpResult.error || helpResult.status !== 0 || missing.length
      ? { ok: false, version, reason: 'unsupported-cli-contract', missing, help }
      : { ok: true, version, missing: [], help };
}

function isolatedCapabilityEnv(baseEnv, fs = {}) {
  const makeTemp = fs.mkdtempSync || mkdtempSync;
  const makeDir = fs.mkdirSync || mkdirSync;
  const remove = fs.rmSync || rmSync;
  let root = null;
  try {
    root = makeTemp(join(tmpdir(), 'triss-opencode2-probe-'));
    const env = {
      ...baseEnv,
      HOME: root,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'),
      NO_COLOR: '1',
    };
    for (const path of [env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME]) {
      makeDir(path, { recursive: true, mode: 0o700 });
    }
    return { root, env, remove };
  } catch (err) {
    if (root) {
      try {
        remove(root, { recursive: true, force: true });
      } catch {
        // Preserve the original probe setup error.
      }
    }
    throw err;
  }
}

function servicePids(spawnSync = nodeSpawnSync) {
  try {
    const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    if (!result || result.status !== 0 || result.error) return { ok: false, pids: new Set() };
    return { ok: true, pids: new Set(String(result.stdout || '').split(/\r?\n/u).flatMap((line) => {
      if (!/opencode2(?:\s|$).*serve(?:\s|$).*--service/u.test(line)) return [];
      const match = /^\s*(\d+)\s/u.exec(line);
      return match ? [match[1]] : [];
    })) };
  } catch {
    return { ok: false, pids: new Set() };
  }
}

function normalizeServiceSnapshot(value) {
  if (value instanceof Set) return { ok: true, pids: value };
  if (!value || value.ok === false) return { ok: false, pids: new Set() };
  const pids = value.pids instanceof Set ? value.pids : new Set(value.pids || []);
  return { ok: true, pids };
}

function boundedProbeSleep(ms) {
  if (!ms) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

// detectOpenCode2: resolve `opencode2` ONCE to an absolute path and pin the
// spawn to THAT path. A bare name means the parent's PATH
// lookup and the child's PATH lookup can disagree (relative PATH entries are
// resolved against each process's own cwd): the pre-check could verify
// /trusted/bin/opencode2 while the credential-bearing spawn — running with a
// different child cwd — picks up /repo/opencode2. Returning { path } and
// spawning exactly that path closes the gap.
//
// Resolution: `which opencode2` via the allowlisted env (PATH/HOME only, plus
// OPENCODE_DISABLE_AUTOUPDATE=1 — a version probe must never trigger the
// updater, and no credential may leak into a probe). The
// `which` output must be ABSOLUTE (a relative PATH entry resolves against
// each process's own cwd — the parent could verify bin/opencode2 while the
// child executes a different file), is canonicalized with Node's
// realpathSync (an external `realpath` failure used to silently keep the
// un-canonicalized path), and the canonical result must be a REGULAR
// EXECUTABLE file. Any canonicalization/stat failure fails closed. Returns
// { found, path, version, satisfiesPin } — NEVER throws. `sh` and the
// `fs.realpathSync` / `fs.statSync` seams are injectable for tests.
export function detectOpenCode2(
  sh = nodeSpawnSync,
  fs = {},
  processTools = {},
) {
  const realpathSync = fs.realpathSync || nodeRealpathSync;
  const statSync = fs.statSync || nodeStatSync;
  const probeEnv = {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
  };
  let resolvedPath = null;
  try {
    const w = sh('which', ['opencode2'], { env: probeEnv });
    if (w && !w.error && w.status === 0) {
      const p = String(w.stdout || '').trim().split('\n').filter(Boolean).pop();
      if (p) resolvedPath = p;
    }
  } catch {
    // fall through: no `which` on PATH (unusual) or spawn failure
  }
  if (!resolvedPath) {
    return { found: false, path: null, version: null, satisfiesPin: false };
  }
  if (!isAbsolute(resolvedPath)) {
    // Relative `which` output means a relative PATH entry — the pre-check and
    // the credential-bearing child (different cwd) could resolve it to
    // different files. Fail closed rather than guess.
    return { found: false, path: null, version: null, satisfiesPin: false };
  }
  let realPath;
  try {
    realPath = realpathSync(resolvedPath);
  } catch {
    // Un-canonicalizable (missing, permission, symlink loop): fail closed —
    // never fall back to the pre-realpath path: the credential-bearing spawn
    // must use the exact canonical executable that passed preflight.
    return { found: false, path: null, version: null, satisfiesPin: false };
  }
  if (!isAbsolute(realPath)) {
    return { found: false, path: null, version: null, satisfiesPin: false };
  }
  try {
    const st = statSync(realPath);
    if (!st.isFile() || (st.mode & 0o111) === 0) {
      return { found: false, path: null, version: null, satisfiesPin: false };
    }
  } catch {
    return { found: false, path: null, version: null, satisfiesPin: false };
  }
  let isolated = null;
  try {
    isolated = isolatedCapabilityEnv(probeEnv, fs);
    const snapshotServices = processTools.snapshot || (() => servicePids(processTools.spawnSync || nodeSpawnSync));
    const beforeService = normalizeServiceSnapshot(snapshotServices());
    // The two commands are intentionally explicit.  In particular, do not
    // replace this with `debug config`: some beta builds start a resident
    // service for that command.
    const versionResult = sh(realPath, ['--version'], { env: isolated.env });
    const versionOutput = String(versionResult?.stdout || '').trim();
    const version = parseOpenCode2VersionOutput(versionOutput);
    if (!versionResult || versionResult.error || versionResult.status !== 0 || !version) {
      return { found: false, path: realPath, version, satisfiesPin: false, satisfiesMinimum: false, meetsMinimum: false, capabilities: null };
    }
    const baseProbe = probeOpenCode2Capabilities(realPath, version, sh, isolated.env);
    const probe = { ...baseProbe, missing: [...(baseProbe.missing || [])] };
    let afterService = normalizeServiceSnapshot(snapshotServices());
    if (afterService.ok && beforeService.ok && ![...afterService.pids].some((pid) => !beforeService.pids.has(pid))) {
      boundedProbeSleep(processTools.graceMs ?? 20);
      afterService = normalizeServiceSnapshot(snapshotServices());
    }
    const newServicePids = [...afterService.pids].filter((pid) => !beforeService.pids.has(pid));
    if (!beforeService.ok || !afterService.ok) {
      // `ps -axo` is not portable to every supported minimal/container host.
      // The verified --standalone CLI contract remains usable; surface the
      // missing behavioral proof as a best-effort warning instead of turning
      // a compatible binary into a false version/capability mismatch.
      probe.serviceProcessCheck = 'unavailable';
      probe.warning = 'service-process-snapshot-unavailable';
    } else if (newServicePids.length) {
      probe.ok = false;
      probe.reason = 'capability-probe-started-service';
      probe.serviceProcessCheck = 'failed';
    } else {
      probe.serviceProcessCheck = 'passed';
    }
    const minimumVersion = opencode2MinimumVersion();
    const minimum = parseOpenCode2Version(minimumVersion);
    const installed = parseOpenCode2Version(version);
    const satisfiesMinimum = !!(
      probe.ok && minimum && installed && compareOpenCode2Versions(installed, minimum) >= 0
    );
    return {
      found: true,
      path: realPath,
      version,
      minimumVersion,
      satisfiesMinimum,
      meetsMinimum: satisfiesMinimum,
      // Compatibility alias for older status/tests.  It deliberately follows
      // minimum semantics and is not an exact equality check anymore.
      satisfiesPin: satisfiesMinimum,
      capabilities: probe,
    };
  } catch (err) {
    return {
      found: true,
      path: realPath,
      version: null,
      minimumVersion: opencode2MinimumVersion(),
      satisfiesMinimum: false,
      meetsMinimum: false,
      satisfiesPin: false,
      capabilities: {
        ok: false,
        reason: 'capability-probe-unavailable',
        detail: err?.code || err?.message || String(err),
        missing: [],
        help: '',
      },
    };
  } finally {
    if (isolated) {
      try {
        isolated.remove(isolated.root, { recursive: true, force: true });
      } catch {
        // Detection remains total even when cleanup itself is unavailable.
      }
    }
  }
}

export function installHintOpenCode2() {
  return `npm install -g ${installChannelOpenCode2()}`;
}

// buildOpenCode2RunArgv: argv for `opencode2 run`. Flag order mirrors the
// verified CLI surface; the prompt is the positional LAST.
//  - `--standalone` ALWAYS: non-standalone modes leave a resident service.
//  - `--format json --auto`: ndjson events on stdout; headless auto-approve.
//  - `--model <m>` ALWAYS explicit — same determinism argument as V1 (the
//    wrong config-file default loops forever with nothing on stdout).
//  - `--model <model#effort>` carries explicit logical effort on the supported
//    beta contract; there is no separate --variant flag.
//  - `--session <real-id>` XOR `--continue` — the CLI accepts both together
//    but the semantics are ambiguous (which session does --continue resume
//    when --session also names one?), so the adapter refuses the combo
//    BEFORE any spawn. `--session` takes a REAL engine session id; the
//    slug->real-id map is the caller's job (needsSessionMap: true).
//  - NO --pure, NO --dir, NO --cwd flag: this build supports neither, the
//    child process cwd selects the project.
export function buildOpenCode2RunArgv({ prompt, model, effort, agent, sessionRealId, cont } = {}) {
  if (sessionRealId && cont) {
    throw new Error(
      '--session and --continue are mutually exclusive on the opencode2 engine — ' +
        'passing both states an ambiguous resume intent.',
    );
  }
  const modelSelector = effort ? `${model}#${effort}` : model;
  const argv = ['run', '--standalone', '--format', 'json', '--auto', '--model', modelSelector];
  if (agent) argv.push('--agent', agent);
  if (sessionRealId) argv.push('--session', sessionRealId);
  if (cont) argv.push('--continue');
  argv.push(prompt); // positional message, LAST
  return argv;
}

// The Triss-owned XDG roots for V2 runtime state, derived from the project
// root (NOT the user's home): V2's SQLite/log/cache must never collide with
// V1's ~/.local/share/opencode. Exported because the log scanner needs the
// same derivation (V2 writes $XDG_DATA_HOME/opencode/log/opencode.log).
export function opencode2DataRoot(projectRoot) {
  return join(projectRoot, '.triss', 'opencode2', 'data');
}

export function opencode2StateRoot(projectRoot) {
  return join(projectRoot, '.triss', 'opencode2', 'state');
}

// ensureOpenCode2RuntimeDirs(root): create the two Triss-owned XDG roots
// under the project (not $HOME) — <root>/.triss/opencode2/{data,state} — with
// mode 0700 before forwarding credentials. An existing 0755 directory is
// CHMOD-corrected,
// not tolerated; a symlink or non-directory at either root is a hard failure.
// Re-checks the final mode after chmod so a umask/failure cannot silently
// leave it loose.
//
// mkdirSync({recursive}) passes through intermediate components
// (<root>/.triss, <root>/.triss/opencode2) without validating them, so a
// symlinked .triss would redirect the credential-bearing state outside the
// project while the final data/state dirs still pass lstat. The whole
// ancestor chain is now walked: every component of the path BELOW `root`
// must be a real directory (no symlinks), creating missing ones 0700.
// NOTE: this module is a PURE adapter — process.stderr writes live in the
// caller; here we stay silent and just return what changed.
function assertNoSymlinkAncestors(root, dir, created) {
  const rel = relative(root, dir);
  if (!rel || rel.startsWith('..')) {
    throw new Error(`OpenCode 2 runtime root ${dir} is not inside ${root}.`);
  }
  const parts = rel.split(sep).filter(Boolean);
  let cur = root;
  for (const part of parts) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        throw new Error(`Cannot inspect OpenCode 2 runtime path component ${cur}: ${err.message}`, { cause: err });
      }
      mkdirSync(cur, { mode: 0o700 });
      if (created) created.push(cur); // Cleanup owns only paths created here.
      st = lstatSync(cur);
    }
    if (st.isSymbolicLink()) {
      throw new Error(
        `OpenCode 2 runtime path component ${cur} is a symlink — refusing to place credential state ` +
          'behind a symlink. Remove the symlink and let Triss recreate the directory.',
      );
    }
    if (!st.isDirectory()) {
      throw new Error(`OpenCode 2 runtime path component ${cur} is not a directory.`);
    }
    if ((st.mode & 0o777) !== 0o700) {
      chmodSync(cur, 0o700);
      const after = lstatSync(cur);
      if ((after.mode & 0o777) !== 0o700) {
        throw new Error(
          `OpenCode 2 runtime path component ${cur} mode could not be corrected to 0700 ` +
            `(still ${((after.mode & 0o777) >>> 0).toString(8)}).`,
        );
      }
    }
  }
}

export function ensureOpenCode2RuntimeDirs(root) {
  // Return only directories created by this call so cleanup cannot remove
  // pre-existing user paths.
  const created = [];
  for (const dir of [opencode2DataRoot(root), opencode2StateRoot(root)]) {
    assertNoSymlinkAncestors(root, dir, created);
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) {
      throw new Error(
        `OpenCode 2 runtime root ${dir} is a symlink — refusing to run with credential state behind a symlink. ` +
          'Remove the symlink and let Triss recreate the directory.',
      );
    }
    if (!st.isDirectory()) {
      throw new Error(`OpenCode 2 runtime root ${dir} is not a directory.`);
    }
  }
  return created;
}

// buildOpenCode2SpawnEnv: allowlist env for the opencode2 subprocess.
// NEVER spread process.env. Beyond the V1 allowlist (PATH/HOME/TMPDIR/LANG/
// LC_ALL + the ONE selected credential):
//  - OPENCODE_DISABLE_AUTOUPDATE=1 always (pin drift guard).
//  - XDG_DATA_HOME / XDG_STATE_HOME pinned to the Triss-owned project-local
//    roots above, OVERRIDING whatever the parent shell had — this is what
//    keeps V2 state off V1's turf (and vice versa).
//  - XDG_CONFIG_HOME is deliberately NOT forwarded: the parent shell's
//    override must not redirect which opencode.json V2 loads. V2 resolves
//    config from the documented default (~/.config/opencode) plus the child
//    cwd chain — preflight audits exactly that chain (Phase 4).
export function buildOpenCode2SpawnEnv({
  projectRoot,
  baseEnv = process.env,
  credentialEnv,
  credentialValue,
  configContent,
} = {}) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (baseEnv[key] != null) env[key] = baseEnv[key];
  }
  const value = credentialValue === undefined ? baseEnv[credentialEnv] : credentialValue;
  if (credentialEnv && value) env[credentialEnv] = value;
  env.OPENCODE_DISABLE_AUTOUPDATE = '1';
  env.XDG_DATA_HOME = opencode2DataRoot(projectRoot);
  env.XDG_STATE_HOME = opencode2StateRoot(projectRoot);
  if (typeof configContent === 'string' && configContent.length > 0) {
    env.OPENCODE_CONFIG_CONTENT = configContent;
  }
  return env;
}

// ─── event fold ─────────────────────────────────────────────────────────────
//
// Same accumulator shape as V1's createEventFolder (the usage fold is shared:
// foldOpencodeStep/finalizeOpencodeUsage in usage-schema.js — V2 step_finish
// `part` is byte-compatible with V1's), plus TWO V2-only fields:
//   - terminalError / terminalErrorType: a V2 `error` event is terminal even
//     when the process later exits 0 (verified live: the auth-error capture
//     exits 1, but a mid-stream provider error after partial text can exit 0).
//     The envelope classifies terminalError as exit_reason "error" BEATS the
//     exit code.

export function createOpenCode2EventFolder() {
  return {
    parsedAnyEvent: false,
    sessionRealId: null,
    finalText: null,
    usage: emptyOpencodeUsage(),
    sawStepFinish: false,
    warnings: [],
    rateLimit: null,
    terminalError: null,
    terminalErrorType: null,
  };
}

// V2 error payloads carry a human-readable `message` V1 never populated.
// Precedence: message > data.message (V1 compat) > name > null.
export function extractOpenCode2ErrorMessage(evt) {
  const err = evt && evt.error;
  if (!err || typeof err !== 'object') return null;
  if (typeof err.message === 'string' && err.message) return err.message;
  if (err.data && typeof err.data.message === 'string' && err.data.message) return err.data.message;
  if (typeof err.name === 'string' && err.name) return err.name;
  return null;
}

// foldOpenCode2EventLine: folds one raw ndjson line into `state` (mutated in
// place). Mirrors V1's foldEventLine contract — unknown event types and
// unparseable lines add a warning instead of throwing — with the V2
// differences: error.message precedence + terminal error capture, and a
// V2-specific unknown-event warning so a V2 stream is never misread as V1.
// NOTE: `text` handling keeps overwrite semantics and is deliberately
// order-independent w.r.t. step_finish (V2 emits step_finish BEFORE the final
// text on tool runs — verified live).
export function foldOpenCode2EventLine(state, rawLine, { onToolUse } = {}) {
  const line = String(rawLine).trim();
  if (!line) return;

  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    state.warnings.push(`unparseable line: ${line.slice(0, 200)}`);
    return;
  }
  state.parsedAnyEvent = true;
  if (!state.sessionRealId && evt.sessionID) state.sessionRealId = evt.sessionID;

  switch (evt.type) {
    case 'step_start':
      break;
    case 'tool_use':
      if (onToolUse) onToolUse(evt);
      break;
    case 'step_finish': {
      // Per-step tokens, same as V1: the envelope usage is the SUM across
      // all step_finish events (foldOpencodeStep maintains it).
      state.sawStepFinish = true;
      foldOpencodeStep(state.usage, evt.part);
      const { tokens: folded } = finalizeOpencodeUsage(state.usage);
      state.usage.input_total = folded.input_total;
      state.usage.output_total = folded.output_total;
      break;
    }
    case 'text':
      if (evt.part?.text != null) state.finalText = evt.part.text;
      break;
    case 'error': {
      const msg = extractOpenCode2ErrorMessage(evt) || 'unknown engine error';
      state.warnings.push(`engine error: ${msg}`);
      state.terminalError = msg;
      state.terminalErrorType = (evt.error && evt.error.type) || null;
      const rl = parseRateLimitReset(msg) || parseRateLimitReset(line);
      if (rl && !state.rateLimit) state.rateLimit = rl;
      break;
    }
    default:
      state.warnings.push(`unknown OpenCode 2 event type: ${evt.type}`);
  }
}

// The V2 run-log location under the Triss-owned data root (the engine still
// writes $XDG_DATA_HOME/opencode/log/opencode.log — inside OUR root). Used by
// both the live rate-limit watchdog and the fallback post-run scan.
export function opencode2LogPath(projectRoot) {
  return join(opencode2DataRoot(projectRoot), 'opencode', 'log', 'opencode.log');
}

// The adapter object — same member shape as crush.js so coder.js dispatches
// uniformly. `logPathFor` is V2's analog of V1's opencodeLogPath().
export const opencode2 = {
  id: 'opencode2',
  binaryName: 'opencode2',
  versionPin: opencode2VersionPin,
  detect: detectOpenCode2,
  installHint: installHintOpenCode2,
  buildRunArgv: buildOpenCode2RunArgv,
  buildSpawnEnv: buildOpenCode2SpawnEnv,
  createState: createOpenCode2EventFolder,
  foldLine: foldOpenCode2EventLine,
  logPathFor: ({ projectRoot }) => opencode2LogPath(projectRoot),
  // OpenCode 2 sessions use the same ses_* real ids as V1 — slug->real-id
  // mapping is required, namespaced per engine in the versioned store.
  needsSessionMap: true,
  // This pin has no small-model role surface: no --small-model, ever.
  supportsSmallModel: false,
  // Every managed invocation MUST run --standalone (resident-service guard).
  requiresStandalone: true,
  // --pure is unsupported; OPENCODE_CONFIG_CONTENT is the supported
  // transient overlay surface (never written by Triss).
  supportsPureConfig: false,
  supportsConfigContent: true,
};

export default opencode2;

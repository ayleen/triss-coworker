// `triss coder` — delegate coding tasks to a GLM agent (opencode engine).
// See docs/coder-agent-plan.md for the original roadmap (init/run/clean,
// the opencode adapter, MCP wiring — all shipped). Naming: "agent" is
// taken (the AI assistant using triss), so this feature is "coder"
// everywhere (command, file, env prefix).

import { spawnSync as nodeSpawnSync, spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, cpSync, renameSync } from 'node:fs';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import readline from 'node:readline';
import pc from 'picocolors';
import { loadEnvFiles } from '../config.js';
// Circular import: config.js imports CODER_MANIFEST from this file. Safe
// because both sides only touch the imported bindings inside function
// bodies (never at module-eval time), so it doesn't matter which module
// finishes evaluating first.
import { chooseScope, resolveScope } from './config.js';
import {
  ensureEnvFile,
  setVar,
  maskValue,
  prompt,
  promptChoice,
  yesNo,
  addToGitignore,
  readStdin,
} from '../secrets.js';
import { projectRoot } from '../safety.js';
import { logUsage } from '../usage.js';
import { currentCall } from '../call-context.js';
import { defaultBranchVia } from '../git.js';

// Pinned opencode-ai version, overridable for testing/upgrades.
export const OPENCODE_PIN = '1.17.13';
// Provider corrected during Phase 0 recon: the configured ZHIPU_API_KEY is
// a `zai-coding-plan` (subscription) key, not a pay-as-you-go `zai` key —
// `zai/glm-*` fails with "Insufficient balance or no resource package" on
// that key. See docs/coder-agent-plan.md's "Recon results" section.
const DEFAULT_CODER_MODEL = 'zai-coding-plan/glm-5.2';
const DEFAULT_CODER_SMALL_MODEL = 'zai-coding-plan/glm-5-turbo';

// ─── Z.AI provider auto-detection ───────────────────────────────────────────
//
// The zai-coding-plan default above was derived from ONE account's
// subscription key during Phase 0 recon — a pay-as-you-go `zai` key hits
// the wrong base URL and opencode retries the failing call forever (see
// the DEFAULT_CODER_MODEL comment). `triss coder init` now probes which
// base a given key actually authenticates against, so the written
// opencode.json always gets the right provider prefix.
//
// Request shape: docs.z.ai's chat-completions reference (fetched
// 2026-07-03) documents only `POST <base>/chat/completions` with
// `Authorization: Bearer <key>` + `{model, messages}` — there is no
// lighter-weight GET (e.g. a models list) to validate a key more cheaply,
// and the coding-plan base is documented only as "follow the [separate]
// tutorial to configure your dedicated endpoint" with no independent
// spec. So the cheapest *verifiable* probe is a real chat completion with
// `max_tokens: 1`, tried against coding-plan first (the more common key
// type observed in recon), falling back to pay-as-you-go.
const ZAI_CODING_PLAN_BASE = 'https://api.z.ai/api/coding/paas/v4';
const ZAI_PAYG_BASE = 'https://api.z.ai/api/paas/v4';
const ZAI_PROBE_MODEL = 'glm-5-turbo';
const ZAI_PROBE_TIMEOUT_MS = 10_000;

async function probeZaiBase(fetchImpl, base, key) {
  try {
    const res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ZAI_PROBE_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(ZAI_PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    // Network error, timeout, or non-throwing rejection shape — treat as
    // "this base didn't work" and let the caller try the next one / warn.
    return false;
  }
}

// Returns 'zai-coding-plan', 'zai', or null (key unset, or neither base
// accepted it — e.g. offline, or a key that's invalid everywhere).
// `fetchImpl` defaults to globalThis.fetch (repo convention — tests mock
// globalThis.fetch or pass a fake directly here).
export async function detectZaiProvider(fetchImpl = globalThis.fetch) {
  const key = process.env.ZHIPU_API_KEY;
  if (!key) return null;
  if (await probeZaiBase(fetchImpl, ZAI_CODING_PLAN_BASE, key)) return 'zai-coding-plan';
  if (await probeZaiBase(fetchImpl, ZAI_PAYG_BASE, key)) return 'zai';
  return null;
}

async function detectAndReportZaiProvider(fetchImpl) {
  if (!process.env.ZHIPU_API_KEY) return null;
  process.stderr.write(pc.dim('  · probing which Z.AI endpoint this key works with...\n'));
  const provider = await detectZaiProvider(fetchImpl);
  if (provider) {
    process.stderr.write(pc.green(`  ✓ detected provider: ${provider}\n`));
  } else {
    process.stderr.write(
      pc.yellow(
        '  ⚠ could not verify ZHIPU_API_KEY against either Z.AI endpoint (coding-plan or ' +
          'pay-as-you-go) — keeping the current default provider prefix. If opencode seems to ' +
          'retry a model call forever, set TRISS_CODER_MODEL / TRISS_CODER_SMALL_MODEL explicitly.\n',
      ),
    );
  }
  return provider;
}

// GLM models verified in the plan's "Fixed technical facts" (models.dev
// catalog for the Z.AI provider). Same set offered for both the main and
// small model picks — small model just defaults to a different index.
const GLM_MODEL_CHOICES = [
  { label: 'glm-5.2 (recommended)', value: 'glm-5.2' },
  { label: 'glm-5-turbo', value: 'glm-5-turbo' },
  { label: 'glm-4.7', value: 'glm-4.7' },
];

// Precedence: TRISS_CODER_MODEL/SMALL_MODEL env override > interactive
// pick (TTY only) > silent default. The provider prefix comes from
// detection (falling back to the historical zai-coding-plan default when
// detection couldn't confirm one) — env overrides are taken verbatim
// since a caller setting them already includes whatever prefix they want.
async function resolveInitModels(detectedProvider, deps = {}) {
  const providerPrefix = detectedProvider || DEFAULT_CODER_MODEL.split('/')[0];
  const choose = deps.promptChoice || promptChoice;
  const interactive = !!process.stdin.isTTY;

  let model = process.env.TRISS_CODER_MODEL;
  if (!model) {
    model = interactive
      ? `${providerPrefix}/${await choose('  Main GLM model for opencode.json?', GLM_MODEL_CHOICES, { defaultIndex: 0 })}`
      : `${providerPrefix}/glm-5.2`;
  }

  let smallModel = process.env.TRISS_CODER_SMALL_MODEL;
  if (!smallModel) {
    smallModel = interactive
      ? `${providerPrefix}/${await choose('  Small/fast GLM model for opencode.json?', GLM_MODEL_CHOICES, { defaultIndex: 1 })}`
      : `${providerPrefix}/glm-5-turbo`;
  }

  return { model, smallModel };
}

// Fixed layout from the plan: `.triss/wt/<slug>` working trees, each on
// its own `coder/<slug>` branch. Centralised here so every construction
// site and every `startsWith(...)` gate uses the same literal.
const TRISS_STATE_DIR = '.triss';
const CODER_BRANCH_PREFIX = 'coder/';

// A user-supplied --session slug flows verbatim into a worktree path
// segment (join(worktreesRoot(repoRoot), slug)) and a git branch name
// (coder/<slug>). Without this check, a slug like '../../../tmp/evil'
// would make wtPath resolve outside the repo, and existsSync would stat
// it before git's own ref-name grammar ever runs — a filesystem
// existence oracle outside the sandbox, and a bare path-segment guard
// that git-specific validation alone doesn't cover. randomSlug() is
// compliant with this pattern by construction.
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function opencodeVersionPin() {
  return process.env.TRISS_CODER_OPENCODE_VERSION || OPENCODE_PIN;
}

function coderModel() {
  return process.env.TRISS_CODER_MODEL || DEFAULT_CODER_MODEL;
}

function coderSmallModel() {
  return process.env.TRISS_CODER_SMALL_MODEL || DEFAULT_CODER_SMALL_MODEL;
}

// ─── wizard manifest ─────────────────────────────────────────────────────────

// Pseudo-manifest so `triss config wizard` / `triss status` can surface
// coder setup alongside real integrations. Field is `name`, NOT `key` —
// every consumer (envReadiness, wizard prompts, status markers) reads
// `.name`. Has no `register()` — do NOT add to loadIntegrations(), it
// requires that (see src/integrations/_contract.js validateManifest).
export const CODER_MANIFEST = {
  name: 'coder',
  description: 'GLM coding agent (opencode engine)',
  envVars: [
    {
      name: 'ZHIPU_API_KEY',
      required: true,
      secret: true,
      doc: 'Z.AI API key for GLM models — https://z.ai/manage-apikey/apikey-list',
    },
  ],
  postSetup: (ctx) => runCoderSetup(ctx),
};

// ─── agent templates ─────────────────────────────────────────────────────────

const CODER_AGENT_TEMPLATE = `---
description: Implementation agent — writes and edits code under the opencode.json permission policy.
mode: primary
---

You are the coder agent, invoked headlessly by \`triss coder run\`. Make the
requested change, run tests when the task calls for it (only the
bash commands allowlisted in opencode.json are permitted), and report
exactly what you changed. Stay inside the working directory you were
given — do not push, deploy, or touch anything outside this checkout.
`;

const RESEARCHER_AGENT_TEMPLATE = `---
description: Read-only research agent — investigates and reports, never edits.
mode: subagent
permission:
  edit: deny
  bash: deny
---

You are the researcher agent. Investigate and answer the question you were
given by reading the codebase. Do not edit files and do not run shell
commands — report findings as text only.
`;

// ─── init ────────────────────────────────────────────────────────────────────

// Entry point 1: `triss coder init`. Entry point 2: `triss config wizard`
// (via CODER_MANIFEST — the generic env-var loop handles the key, then
// runFullWizard calls CODER_MANIFEST.postSetup -> runCoderSetup). Both
// converge on runCoderSetup() for engine/config/template steps.
export async function runCoderInit(opts = {}, deps = {}) {
  loadEnvFiles();
  let scope = resolveScope(opts);
  if (!scope) scope = await chooseScope('Where to save the Z.AI key and coder config?');
  const path = ensureEnvFile(scope);
  await setupKey(path);
  if (scope === 'local' && addToGitignore('.triss.env')) {
    process.stderr.write(pc.dim('  · added .triss.env to .gitignore\n'));
  }
  await runCoderSetup({ scope }, deps);
  process.stderr.write(
    '\n' + pc.green('Done.') + ' Run ' + pc.cyan('triss coder init') + pc.dim(' again anytime — it is idempotent.\n'),
  );
}

async function setupKey(path) {
  const existing = process.env.ZHIPU_API_KEY;
  if (existing) {
    process.stderr.write(pc.dim(`  ✓ ZHIPU_API_KEY already set (${maskValue(existing)}) — skipping\n`));
    return;
  }
  process.stderr.write('\n  ' + pc.yellow('ZHIPU_API_KEY') + ' (required)\n');
  process.stderr.write(pc.dim('  Z.AI API key for GLM models — https://z.ai/manage-apikey/apikey-list\n'));
  const key = await prompt('  value', { hidden: true });
  if (!key) {
    process.stderr.write(
      pc.yellow("  ⚠ skipped — set later via 'triss config set ZHIPU_API_KEY'\n"),
    );
    return;
  }
  setVar(path, 'ZHIPU_API_KEY', key);
  process.env.ZHIPU_API_KEY = key;
  process.stderr.write(pc.green('  ✓ saved\n'));
}

// Steps 1 (engine), 2 (Z.AI provider detection), 3 (opencode.json), 4
// (agent templates), 6 (summary). `deps.spawnSync` lets tests inject a
// fake spawnSync instead of touching the real engine / npm.
// `deps.confirmInstall` lets tests stub the install-confirmation prompt
// instead of driving real stdin. `deps.fetch` / `deps.promptChoice` let
// tests stub the provider probe and the interactive model pick.
export async function runCoderSetup({ scope } = {}, deps = {}) {
  // `triss coder init` calls loadEnvFiles() itself before setupKey() runs,
  // so ZHIPU_API_KEY is already in process.env by the time this function
  // is reached from that path. But CODER_MANIFEST.postSetup (the
  // `triss config wizard` path) calls runCoderSetup directly: the
  // generic env-var loop writes the key to the .env FILE via setVar(),
  // never to process.env. Without reloading here, detectAndReportZaiProvider
  // below reads an unset ZHIPU_API_KEY on a first-time wizard setup,
  // silently skips detection, and falls back to the default provider
  // prefix. override:false + uncached (see config.js) makes this a safe,
  // idempotent no-op when the key is already loaded.
  loadEnvFiles();
  const resolvedScope = scope || 'global';
  const sh = deps.spawnSync || nodeSpawnSync;
  process.stderr.write('\n' + pc.bold('── coder (opencode engine) ──') + '\n');
  await ensureEngine(sh, deps.confirmInstall);
  const detectedProvider = await detectAndReportZaiProvider(deps.fetch || globalThis.fetch);
  await writeOpencodeConfig(resolvedScope, detectedProvider, deps);
  scaffoldAgentTemplates(resolvedScope);
}

function detectOpencodeVersion(sh) {
  const r = sh('opencode', ['--version']);
  if (!r || r.error || r.status !== 0) return null;
  const out = String(r.stdout || '').trim();
  return out || null;
}

async function ensureEngine(sh, confirmInstall) {
  const pin = opencodeVersionPin();
  const version = detectOpencodeVersion(sh);
  if (version) {
    if (version === pin) {
      process.stderr.write(pc.green(`  ✓ opencode ${version} (matches pin)\n`));
    } else {
      process.stderr.write(
        pc.yellow(`  ⚠ opencode ${version} found, pinned version is ${pin} (not auto-upgrading)\n`),
      );
    }
    return;
  }

  const installCmd = `npm install -g opencode-ai@${pin}`;
  process.stderr.write(pc.dim(`  · opencode not found (pinned version: ${pin})\n`));

  // Non-interactive shell (CI, pipe): never install unattended — throw so
  // the caller sees a clear, actionable error (same shape as the
  // npm-missing case below).
  if (!process.stdin.isTTY) {
    throw new Error(`opencode not found — run manually: ${installCmd}`);
  }

  const npmCheck = sh('npm', ['--version']);
  if (!npmCheck || npmCheck.error || npmCheck.status !== 0) {
    throw new Error(`npm not found — install Node.js/npm, then run: ${installCmd}`);
  }

  const confirm = confirmInstall || (() => yesNo(`  Install opencode-ai@${pin} globally via npm?`, true));
  const proceed = await confirm();
  if (!proceed) {
    process.stderr.write(pc.dim(`  · skipped — install manually later: ${installCmd}\n`));
    return;
  }

  const install = sh('npm', ['install', '-g', `opencode-ai@${pin}`], { stdio: 'inherit' });
  if (!install || install.error || install.status !== 0) {
    throw new Error(`Failed to install opencode-ai@${pin} — run manually: ${installCmd}`);
  }
  const after = detectOpencodeVersion(sh);
  if (after) {
    process.stderr.write(pc.green(`  ✓ opencode ${after} installed\n`));
  } else {
    process.stderr.write(
      pc.yellow('  ⚠ install finished but `opencode --version` still not found on PATH\n'),
    );
  }
}

function opencodeConfigPath(scope) {
  return scope === 'local'
    ? join(projectRoot(), 'opencode.json')
    : join(homedir(), '.config', 'opencode', 'opencode.json');
}

function opencodeConfigTemplate(model, smallModel) {
  return {
    $schema: 'https://opencode.ai/config.json',
    model,
    small_model: smallModel,
    permission: {
      bash: {
        '*': 'deny',
        'git status': 'allow',
        'git diff*': 'allow',
        'git log*': 'allow',
        'ls*': 'allow',
        'node --test*': 'allow',
        'npm test*': 'allow',
        'npm run test*': 'allow',
      },
      webfetch: 'deny',
      websearch: 'deny',
    },
  };
}

// If the caller already has an opencode.json (the no-clobber path never
// touches it), still tell them when its `model` provider prefix
// contradicts what the key just verified against — a mismatched prefix
// is exactly the infinite-retry trap this whole feature exists to catch.
function warnIfProviderMismatch(path, detectedProvider) {
  if (!detectedProvider) return; // nothing to compare against
  let existing;
  try {
    existing = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return; // unreadable/malformed — not this function's job to fix that
  }
  const existingModel = typeof existing.model === 'string' ? existing.model : '';
  const existingPrefix = existingModel.split('/')[0];
  if (existingPrefix && existingPrefix !== detectedProvider) {
    process.stderr.write(
      pc.yellow(
        `  ⚠ ${path} sets model="${existingModel}" (provider "${existingPrefix}"), but ZHIPU_API_KEY ` +
          `just verified against the "${detectedProvider}" endpoint instead — this is the exact ` +
          "mismatch that makes opencode retry a model call it can never complete. Update the " +
          'model/small_model fields, or unset ZHIPU_API_KEY and use a key for the right plan.\n',
      ),
    );
  }
}

async function writeOpencodeConfig(scope, detectedProvider, deps = {}) {
  const path = opencodeConfigPath(scope);
  if (existsSync(path)) {
    process.stderr.write(pc.dim(`  · ${path} already exists — not overwriting\n`));
    process.stderr.write(
      pc.dim(
        `    (would set model=${coderModel()}, small_model=${coderSmallModel()}, ` +
          'permission.bash.*=deny)\n',
      ),
    );
    warnIfProviderMismatch(path, detectedProvider);
    return;
  }
  const { model, smallModel } = await resolveInitModels(detectedProvider, deps);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(opencodeConfigTemplate(model, smallModel), null, 2) + '\n');
  process.stderr.write(pc.green(`  ✓ wrote ${path} (model=${model}, small_model=${smallModel})\n`));
}

function agentsDir(scope) {
  return scope === 'local'
    ? join(projectRoot(), '.opencode', 'agents')
    : join(homedir(), '.config', 'opencode', 'agents');
}

function writeTemplateIfMissing(path, content) {
  if (existsSync(path)) {
    process.stderr.write(pc.dim(`  · ${path} already exists — not overwriting\n`));
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  process.stderr.write(pc.green(`  ✓ wrote ${path}\n`));
}

function scaffoldAgentTemplates(scope) {
  const dir = agentsDir(scope);
  writeTemplateIfMissing(join(dir, 'coder.md'), CODER_AGENT_TEMPLATE);
  writeTemplateIfMissing(join(dir, 'researcher.md'), RESEARCHER_AGENT_TEMPLATE);
}

// ─── worktree helpers (engine-agnostic — Phase 2 reuses these) ────────────────
//
// Fixed layout from the plan: `.triss/wt/<slug>` working trees, each on its
// own `coder/<slug>` branch. These are plain wrappers around `git`/`spawnSync`
// so both `coder clean` (Phase 3) and `coder run --isolate` (Phase 2) can
// share them without depending on the opencode engine at all.

function worktreesRoot(repoRoot) {
  return join(repoRoot, TRISS_STATE_DIR, 'wt');
}

// Resolves the git repo root for `dir`, or null if `dir` isn't inside a
// git repo (or `git` itself can't be found) — never throws. Exported so
// the MCP handler (src/mcp/handlers.js) can pre-check `--isolate`'s
// eventual worktree location against the sandbox before calling
// runCoderRun — the CLI path stays unrestricted, same as everywhere else.
export function gitRepoRoot(sh, dir) {
  const r = sh('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
  if (!r || r.error || r.status !== 0) return null;
  const out = String(r.stdout || '').trim();
  return out || null;
}

function listWorktreeDirs(repoRoot) {
  const dir = worktreesRoot(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ slug: e.name, path: join(dir, e.name) }));
}

function gitWorktreeBranch(sh, wtPath) {
  const r = sh('git', ['-C', wtPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (!r || r.error || r.status !== 0) return null;
  return String(r.stdout || '').trim() || null;
}

// True if `branch` introduces any change relative to `base` (three-dot
// diff — changes on `branch` since it forked from `base`). When `base`
// is unknown, treats the branch as dirty (safe default: keep, don't
// silently delete work we can't verify).
function worktreeHasDiff(sh, repoRoot, branch, base) {
  if (!branch || !base) return true;
  const r = sh('git', ['-C', repoRoot, 'diff', '--quiet', `${base}...${branch}`]);
  if (!r || r.error) return true;
  return r.status !== 0; // `diff --quiet`: 0 = no diff, 1 = diff, >1 = error
}

// True if the worktree has uncommitted changes (staged, unstaged, or
// untracked) — `coder run` stages but never commits, so a run-produced
// worktree has NO diff vs base (worktreeHasDiff above returns false) yet
// is very much in-progress work. Checked so the default (non---all) clean
// path classifies it as KEPT, not as a failed removal attempt. Unreadable
// status (error) is treated as dirty — same safe-default spirit as
// worktreeHasDiff.
function worktreeHasUncommittedChanges(sh, wtPath) {
  const r = sh('git', ['-C', wtPath, 'status', '--porcelain']);
  if (!r || r.error || r.status !== 0) return true;
  return String(r.stdout || '').trim().length > 0;
}

function gitWorktreeRemove(sh, repoRoot, wtPath, { force = false } = {}) {
  const args = ['-C', repoRoot, 'worktree', 'remove', wtPath];
  if (force) args.push('--force');
  const r = sh('git', args);
  if (!r || r.error || r.status !== 0) {
    const msg = String((r && (r.stderr || r.stdout)) || 'unknown error').trim();
    throw new Error(`git worktree remove ${wtPath} failed: ${msg}`);
  }
}

// SAFE branch delete (`-d`, never `-D`) — refuses to delete a branch with
// unmerged commits. Returns true if the branch was deleted, false if git
// refused (unmerged) or the branch is otherwise gone already. Never throws.
function gitBranchDeleteSafe(sh, repoRoot, branch) {
  const r = sh('git', ['-C', repoRoot, 'branch', '-d', branch]);
  return !!r && !r.error && r.status === 0;
}

// ─── status helper (Phase 3 status block) ──────────────────────────────────────

// Read-only snapshot used by `triss status`. Never throws — every check
// degrades to a "not found / unknown" value instead, so a missing engine
// or a non-git cwd never crashes `triss status`.
export function describeCoderStatus(deps = {}) {
  const sh = deps.spawnSync || nodeSpawnSync;
  const pin = opencodeVersionPin();
  const engineVersion = detectOpencodeVersion(sh);
  const configs = ['global', 'local'].map((scope) => {
    const path = opencodeConfigPath(scope);
    return { scope, path, exists: existsSync(path) };
  });
  let worktreeCount = 0;
  try {
    const repoRoot = gitRepoRoot(sh, projectRoot());
    if (repoRoot) worktreeCount = listWorktreeDirs(repoRoot).length;
  } catch {
    worktreeCount = 0;
  }
  return { pin, engineVersion, configs, worktreeCount };
}

// ─── coder run (Phase 2) ────────────────────────────────────────────────────────
//
// The core adapter: spawn opencode headlessly, fold its ndjson event
// stream into one envelope, print exactly that envelope to stdout. Every
// other message in this module (and in this section) goes to stderr —
// stdout is reserved for the single JSON line the caller parses.
//
// Session handling deviates from the plan's original "get-or-create"
// description per Phase 0 recon: opencode's own `--session <id>` requires
// a real, opencode-issued `ses_...` id — it will NOT create a session
// keyed by a caller-chosen slug. So `--session <slug>` on the triss side
// is a lookup key into `.triss/sessions.json` (slug -> real id), not a
// value passed straight through to opencode on a session's first run.

// ─── event folding (exported: replayable against the Phase 0 fixture) ──────────

export function createEventFolder() {
  return {
    parsedAnyEvent: false,
    sessionRealId: null,
    finalText: null,
    usage: { input: 0, output: 0 },
    sawStepFinish: false,
    warnings: [],
  };
}

// Folds one raw ndjson line into `state` (mutated in place). Unknown
// event types and unparseable/truncated lines are tolerated — they add a
// warning instead of throwing, per the plan's "never crash on unknown
// events" rule. `onToolUse(evt)` is an optional side-effect hook (used by
// the live spawn path to print a progress line; the fixture-replay tests
// don't need it).
export function foldEventLine(state, rawLine, { onToolUse } = {}) {
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
      // Per-step tokens, NOT cumulative — recon confirmed every
      // step_finish event carries its own step-level counts, so the
      // envelope's usage is the SUM across all step_finish events, not
      // just the last one.
      state.sawStepFinish = true;
      const tokens = evt.part?.tokens || {};
      state.usage.input += tokens.input || 0;
      state.usage.output += tokens.output || 0;
      break;
    }
    case 'text':
      // Keep overwriting — the last `text` event before the final
      // `step_finish (reason: stop)` is the assistant's actual reply.
      if (evt.part?.text != null) state.finalText = evt.part.text;
      break;
    case 'error': {
      const msg = evt.error?.data?.message || evt.error?.name || 'unknown engine error';
      state.warnings.push(`engine error: ${msg}`);
      break;
    }
    default:
      state.warnings.push(`unknown event type: ${evt.type}`);
  }
}

// ─── engine env / argv ──────────────────────────────────────────────────────────

// Minimal allowlist env for the engine subprocess — never spread
// process.env, so the engine only ever sees what it needs.
function buildEngineEnv() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  if (process.env.ZHIPU_API_KEY) env.ZHIPU_API_KEY = process.env.ZHIPU_API_KEY;
  return env;
}

function buildOpencodeArgv({ prompt, agent, model, sessionRealId, cont, dir }) {
  // --auto: headless runs must auto-approve every "ask" permission (deny
  // still blocks) — there is no human to answer the prompt.
  // --model is ALWAYS passed explicitly (the resolved model — override or
  // coderModel()), never left for opencode to infer from whichever config
  // file it happens to find. Recon showed the wrong provider default
  // causes an infinite retry loop with nothing on stdout; an explicit
  // model makes this deterministic regardless of worktree config state.
  const argv = ['run', prompt, '--format', 'json', '--auto', '--model', model];
  if (agent) argv.push('--agent', agent);
  if (sessionRealId) argv.push('--session', sessionRealId);
  if (cont) argv.push('--continue');
  if (dir) argv.push('--dir', dir);
  return argv;
}

// ─── session slug <-> real opencode session id ─────────────────────────────────

function randomSlug() {
  return 'run-' + randomBytes(3).toString('hex');
}

function sessionsFilePath() {
  return join(projectRoot(), TRISS_STATE_DIR, 'sessions.json');
}

function readSessionsMap() {
  const path = sessionsFilePath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Write-then-rename so a reader never observes a partially-written file.
// renameSync is atomic on the same filesystem, which the tmp file always
// is (same directory as the target).
function atomicWriteJson(path, obj) {
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmpPath, path);
}

// Only gitignores `.triss/` when we're inside a git repo (mirrors
// config.js's maybeAddGitignore guard) — a non-git cwd still gets the
// mapping file written, just not a .gitignore entry for it.
//
// Read-modify-write race: two concurrent `coder run` calls with different
// slugs can each read the map before the other writes, then each write
// back a version missing the other's fresh mapping — the loser's slug
// silently vanishes from sessions.json, breaking its future --continue.
// The atomic write above only prevents torn reads; it doesn't close this
// window. Narrow it further by re-reading immediately after our write and,
// if our own slug's value was clobbered by a concurrent writer, redo the
// merge once. This is a best-effort mitigation, not a lock: two processes
// racing on the SAME slug is still inherently last-write-wins (there is
// no source of truth for "which write is correct" in that case, and it's
// not the scenario this guards against).
function persistSessionMapping(sh, slug, realId) {
  const path = sessionsFilePath();
  mkdirSync(dirname(path), { recursive: true });

  const map = readSessionsMap();
  map[slug] = realId;
  atomicWriteJson(path, map);

  const verify = readSessionsMap();
  if (verify[slug] !== realId) {
    const retryMap = readSessionsMap();
    retryMap[slug] = realId;
    atomicWriteJson(path, retryMap);
  }

  if (gitRepoRoot(sh, projectRoot())) addToGitignore(`${TRISS_STATE_DIR}/`);
}

// ─── isolation (worktree) setup — Phase 3 helpers reused ───────────────────────

function setupIsolation(sh, slug) {
  const repoRoot = gitRepoRoot(sh, projectRoot());
  if (!repoRoot) {
    throw new Error(
      '--isolate requires a git repository — no repo found at or above the current directory.',
    );
  }
  // FIRST gitignore .triss/, THEN create the worktree — otherwise the
  // very first run's own .triss/ directory shows up as an untracked file
  // inside the worktree's own diff.
  addToGitignore(`${TRISS_STATE_DIR}/`);

  const branch = `${CODER_BRANCH_PREFIX}${slug}`;
  const wtPath = join(worktreesRoot(repoRoot), slug);
  let freshlyCreated = false;

  if (existsSync(wtPath)) {
    const existingBranch = gitWorktreeBranch(sh, wtPath);
    if (existingBranch !== branch) {
      throw new Error(
        `${TRISS_STATE_DIR}/wt/${slug} already exists on branch "${existingBranch}", expected "${branch}" — ` +
          'use a different --session slug, or remove the worktree manually (triss coder clean --all).',
      );
    }
  } else {
    // Detect "branch exists but its worktree dir doesn't" BEFORE calling
    // `git worktree add -b`, which would otherwise fail with a generic
    // git error — this is the orphan-branch case: a previous run's
    // worktree was removed (empty diff) but its branch survived a SAFE
    // (-d) delete because it had unmerged commits (e.g. a commit
    // immediately followed by a revert — net diff zero, but two real
    // unreachable commits). `triss coder clean --all` or a manual
    // `git branch -D` is the way out.
    const branchExists = sh('git', ['-C', repoRoot, 'rev-parse', '--verify', `refs/heads/${branch}`]);
    if (branchExists && !branchExists.error && branchExists.status === 0) {
      throw new Error(
        `Branch "${branch}" already exists but ${TRISS_STATE_DIR}/wt/${slug} does not — likely left ` +
          "behind by a previous run whose worktree was removed while the branch survived (unmerged " +
          `commits). Remove it with \`git branch -D ${branch}\` (review its commits first) or ` +
          '`triss coder clean --all`, or pick a different --session slug.',
      );
    }
    const r = sh('git', ['-C', repoRoot, 'worktree', 'add', wtPath, '-b', branch]);
    if (!r || r.error || r.status !== 0) {
      // A concurrent `coder run` on the same fresh slug can win the race
      // between our existsSync/rev-parse checks above and this `add` —
      // the loser hits git's raw error. Re-check now and, if either the
      // worktree dir or the branch exists, it's that race: give the same
      // polished message setupIsolation uses elsewhere instead of git's
      // stderr.
      const branchExistsNow = sh('git', ['-C', repoRoot, 'rev-parse', '--verify', `refs/heads/${branch}`]);
      const branchNowExists =
        branchExistsNow && !branchExistsNow.error && branchExistsNow.status === 0;
      if (existsSync(wtPath) || branchNowExists) {
        throw new Error(
          `${TRISS_STATE_DIR}/wt/${slug} (branch "${branch}") already exists — another run may have ` +
            'created it concurrently; use a different --session slug or `triss coder clean`.',
        );
      }
      const msg = String((r && (r.stderr || r.stdout)) || 'unknown error').trim();
      throw new Error(`git worktree add ${wtPath} -b ${branch} failed: ${msg}`);
    }
    freshlyCreated = true;
  }

  // `git worktree add` only checks out COMMITTED state — an uncommitted
  // (often gitignored) opencode.json / .opencode/ at the repo root does
  // NOT exist inside the worktree. Left alone, opencode falls back to its
  // own defaults there: no configured model, no "coder" agent template,
  // and — the dangerous part — NO PERMISSION POLICY in effect. Seed both
  // from the repo root (only when the worktree doesn't already have its
  // own — a committed copy on the coder/<slug> branch always wins and is
  // never overwritten). Runs on both the fresh-create and the reuse path,
  // in case an earlier run seeded before this existed.
  seedIsolationConfig(repoRoot, wtPath);

  return { repoRoot, wtPath, branch, freshlyCreated };
}

// If the engine spawn/fold fails after setupIsolation already created a
// worktree, the worktree+branch would otherwise leak: the "already
// exists" guard in setupIsolation then hard-fails a retry with the same
// slug until the user runs `triss coder clean`. Only clean up worktrees
// THIS run freshly created (never touch a reused one — it may hold prior
// turns' state) and only when the engine wrote nothing to it (a git
// status --porcelain default listing skips gitignored seed files, so a
// freshly-seeded-but-untouched worktree still reads as clean here).
function cleanupAbandonedIsolation(sh, isolation) {
  const status = sh('git', ['-C', isolation.wtPath, 'status', '--porcelain']);
  const clean = status && !status.error && status.status === 0 && String(status.stdout || '').trim() === '';
  if (!clean) {
    process.stderr.write(pc.dim(`worktree kept for inspection: ${isolation.wtPath}\n`));
    return;
  }
  try {
    gitWorktreeRemove(sh, isolation.repoRoot, isolation.wtPath, { force: true });
    if (isolation.branch.startsWith(CODER_BRANCH_PREFIX)) {
      gitBranchDeleteSafe(sh, isolation.repoRoot, isolation.branch);
    }
  } catch {
    // Best-effort cleanup while already unwinding a failure — the
    // original error is what the caller needs to see, not this one.
  }
}

// See setupIsolation's comment for why this exists. Copies opencode.json
// and .opencode/ from the repo root into the worktree only when the
// worktree doesn't already have its own (a committed copy on the
// coder/<slug> branch always wins and is never overwritten). Does NOT
// track what it seeded — computeWorktreeChanges below decides what to
// exclude from the diff by comparing CONTENT, not by remembering this
// call's actions (see that function's comment for why).
function seedIsolationConfig(repoRoot, wtPath) {
  const srcConfig = join(repoRoot, 'opencode.json');
  const dstConfig = join(wtPath, 'opencode.json');
  if (existsSync(srcConfig) && !existsSync(dstConfig)) {
    cpSync(srcConfig, dstConfig);
  }

  const srcAgents = join(repoRoot, '.opencode');
  const dstAgents = join(wtPath, '.opencode');
  if (existsSync(srcAgents) && !existsSync(dstAgents)) {
    cpSync(srcAgents, dstAgents, { recursive: true });
  }
}

// The SOURCE-side integrity candidate set: opencode.json plus every file
// currently under .opencode/ at the REPO ROOT (not the worktree) — paths
// relative to `repoRoot`. This is deliberately source-anchored, not
// worktree-anchored: opencode itself materializes a full runtime tree
// under the worktree's `.opencode/` (node_modules, package.json, …) that
// has no source counterpart at all and must never be treated as "seeded
// scaffolding that diverged" (see computeWorktreeChanges).
function collectSourceCandidatePaths(repoRoot) {
  const candidates = [];
  if (existsSync(join(repoRoot, 'opencode.json'))) candidates.push('opencode.json');
  const agentsRoot = join(repoRoot, '.opencode');
  if (existsSync(agentsRoot)) collectFilesRecursive(agentsRoot, repoRoot, candidates);
  return candidates;
}

function collectFilesRecursive(dir, baseDir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFilesRecursive(full, baseDir, out);
    else out.push(relative(baseDir, full));
  }
}

function filesIdentical(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  try {
    return Buffer.compare(readFileSync(a), readFileSync(b)) === 0;
  } catch {
    return false;
  }
}

// Stages everything in the worktree (index-only — never commits/pushes)
// so newly-created files show up in the diff too, since the coder agent
// isn't expected to `git commit` its own work; the orchestrator reviews
// and commits afterward.
//
// Two independent, STATELESS exclusion rules run against the staged file
// list (not "whatever setupIsolation seeded this call" — see below):
//
//  1. Seeded-file integrity (source-anchored, CONTENT-based): for each
//     candidate under collectSourceCandidatePaths(repoRoot) that is
//     actually staged, compare the worktree copy against the repo-root
//     source. Identical -> reset out of staging silently (still the same
//     seeded config, nothing to review). Differs -> LEAVE in the diff
//     plus a warning — this is what catches the coder agent editing
//     <worktree>/opencode.json (`edit` isn't denied by the policy);
//     excluding it by path alone would have silently hidden a policy
//     weakening. Missing from the worktree entirely -> not staged, so
//     this rule never touches it (case doesn't arise).
//  2. Engine runtime noise (worktree-anchored, no source comparison): any
//     staged path under `.opencode/` that has NO counterpart under
//     repoRoot/.opencode/ — opencode's own node_modules/, package.json,
//     package-lock.json, etc., that it writes into the worktree at
//     runtime — is reset out of staging silently, NEVER a warning, NEVER
//     in files_changed. `.opencode/` is the engine's config/runtime dir,
//     not agent deliverable space, and rule 1's "differs -> warn" logic
//     must not apply to files that were never seeded in the first place
//     (a live smoke run surfaced ~2000 phantom warnings/files_changed
//     entries when this was worktree-anchored instead of source-anchored).
//
// This is deliberately NOT `git -C <wt> rev-parse --git-path
// info/exclude` (a per-worktree exclude file) — verified empirically
// that `info/exclude` resolves to the MAIN repo's shared
// `.git/info/exclude`, not a per-worktree one (unlike HEAD/index, it
// isn't in git's per-worktree file set). Writing to it would leak the
// exclusion into the main checkout and every other worktree, which is
// the opposite of what we want here.
function computeWorktreeChanges(sh, repoRoot, wtPath) {
  sh('git', ['-C', wtPath, 'add', '-A']);

  const stagedRaw = sh('git', ['-C', wtPath, 'diff', '--cached', '--name-only']);
  const staged =
    stagedRaw && !stagedRaw.error && stagedRaw.status === 0
      ? String(stagedRaw.stdout || '').trim().split('\n').filter(Boolean)
      : [];
  const stagedSet = new Set(staged);

  const toExclude = [];
  const warnings = [];

  // Rule 1 — seeded-file integrity, source-anchored.
  for (const rel of collectSourceCandidatePaths(repoRoot)) {
    if (!stagedSet.has(rel)) continue;
    const wtFile = join(wtPath, rel);
    const srcFile = join(repoRoot, rel);
    if (filesIdentical(wtFile, srcFile)) {
      toExclude.push(rel);
    } else {
      warnings.push(`${rel} differs from the seeded policy — left in the diff for review`);
    }
  }

  // Rule 2 — engine runtime noise under .opencode/ with no source
  // counterpart. Skip anything rule 1 already decided on.
  const excludedSet = new Set(toExclude);
  for (const rel of staged) {
    if (!rel.startsWith('.opencode/') || excludedSet.has(rel)) continue;
    if (!existsSync(join(repoRoot, rel))) toExclude.push(rel);
  }

  if (toExclude.length) {
    sh('git', ['-C', wtPath, 'reset', '--', ...toExclude]);
  }

  const nameOnly = sh('git', ['-C', wtPath, 'diff', '--cached', '--name-only']);
  const filesChanged =
    nameOnly && !nameOnly.error && nameOnly.status === 0
      ? String(nameOnly.stdout || '').trim().split('\n').filter(Boolean)
      : [];
  const stat = sh('git', ['-C', wtPath, 'diff', '--cached', '--stat']);
  const diffStat =
    stat && !stat.error && stat.status === 0 ? String(stat.stdout || '').trim() || null : null;
  return { filesChanged, diffStat, warnings };
}

// ─── spawn + fold ────────────────────────────────────────────────────────────────

const KILL_GRACE_MS = 5000;

function spawnEngine({ argv, env, timeoutSec, spawnFn }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn('opencode', argv, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (err) {
      reject(new Error(`Failed to spawn opencode: ${err.message}`));
      return;
    }

    let settled = false;
    let timedOut = false;
    let graceTimer = null;
    const state = createEventFolder();
    const stderrChunks = [];

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      graceTimer = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }, KILL_GRACE_MS);
    }, timeoutSec * 1000);

    // The child is spawned `detached: true` so the timeout-kill above can
    // signal its whole process GROUP (negative PID), not just opencode's
    // immediate PID. But the timeout timer is not the only way this
    // process can end: a user hitting Ctrl-C (SIGINT) or a supervisor
    // sending SIGTERM ends the PARENT without touching the detached
    // child's group at all — per Phase 0 recon, opencode retries failed
    // API calls indefinitely, so an orphaned engine can burn quota
    // headless forever. Forward both signals to the child's group.
    //
    // Forward-only, no exit()/process.kill(process.pid, sig) re-raise:
    // this same code path runs inside the long-lived MCP server process
    // (coderRunHandler), which has its own shutdown story and possibly
    // its own SIGINT/SIGTERM handlers — we must not terminate or
    // interfere with the host, only make sure the child doesn't outlive
    // this one engine call. The listeners are removed in settle() so a
    // server handling many `coder run` calls over its lifetime doesn't
    // accumulate one pair of listeners per call.
    const onHostSignal = () => {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    };
    process.on('SIGINT', onHostSignal);
    process.on('SIGTERM', onHostSignal);

    function settle(fn) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      process.off('SIGINT', onHostSignal);
      process.off('SIGTERM', onHostSignal);
      fn();
    }

    child.on('error', (err) => {
      settle(() => reject(new Error(`Failed to spawn opencode: ${err.message}`)));
    });

    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => {
        foldEventLine(state, line, {
          onToolUse: (evt) => {
            const tool = evt.part?.tool || 'tool';
            const denied = evt.part?.state?.status === 'error';
            process.stderr.write(pc.dim(`  → ${tool}${denied ? ' (denied/error)' : ''}\n`));
          },
        });
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString('utf8')));
    }

    child.on('close', (code, signal) => {
      settle(() =>
        resolve({
          code,
          signal,
          timedOut,
          stderrTail: stderrChunks.join(''),
          ...state,
        }),
      );
    });
  });
}

// ─── prompt resolution (mirrors `triss chat --stdin`) ───────────────────────────

async function resolveCoderPrompt(promptArg, opts) {
  if (opts.stdin) {
    if (process.stdin.isTTY) {
      throw new Error(
        '--stdin requires piped input. Try: echo "task..." | triss coder run --stdin',
      );
    }
    const fromStdin = await readStdin();
    if (!fromStdin) throw new Error('--stdin was passed but stdin was empty');
    return fromStdin;
  }
  if (!promptArg) {
    throw new Error('Pass a prompt as argument or via --stdin');
  }
  return promptArg;
}

function resolveSlug(opts) {
  if (opts.session) {
    if (!SLUG_PATTERN.test(opts.session)) {
      throw new Error(
        `--session "${opts.session}" is invalid — slugs must match ${SLUG_PATTERN} ` +
          '(letters, digits, underscore, hyphen; max 64 chars; no path separators).',
      );
    }
    return opts.session;
  }
  if (opts.isolate) return randomSlug();
  return null;
}

// ─── runCoderRun ─────────────────────────────────────────────────────────────────

export async function runCoderRun(promptArg, opts = {}, deps = {}) {
  // The engine env allowlist (buildEngineEnv) and the timeout kill
  // (negative-PID process-group SIGTERM/SIGKILL in spawnEngine) are both
  // POSIX-only. Rather than ship a silently half-working Windows path
  // (no group kill => a hung/retrying engine can never be terminated by
  // --timeout), refuse explicitly.
  if (process.platform === 'win32') {
    throw new Error('triss coder run is POSIX-only for now (Windows is not supported).');
  }

  loadEnvFiles();
  const sh = deps.spawnSync || nodeSpawnSync;
  const spawnFn = deps.spawn || nodeSpawn;

  const prompt = await resolveCoderPrompt(promptArg, opts);

  // Pure usage-error checks first, independent of environment/credentials
  // — a caller should get "you combined two contradictory flags" rather
  // than "no API key" when both are true.
  //
  // --continue resumes whatever opencode session was last active; --isolate
  // (without --session) creates a brand-new worktree/branch on a random
  // slug. Combined with no --session, those two are self-contradictory —
  // there is no session tied to the fresh worktree to continue.
  if (opts.continue && opts.isolate && !opts.session) {
    throw new Error(
      '--continue with --isolate requires --session <id> — without it, --isolate creates a new ' +
        'worktree/branch while --continue tries to resume an unrelated previous session. Pass the ' +
        'same --session slug you used to start that session.',
    );
  }

  if (!process.env.ZHIPU_API_KEY) {
    throw new Error('ZHIPU_API_KEY is not set — run `triss coder init` first.');
  }

  const timeoutSec = opts.timeout == null ? 900 : Number(opts.timeout);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new Error(`Invalid --timeout "${opts.timeout}" — must be a positive number of seconds`);
  }

  const agent = opts.agent || 'coder';
  const modelOverride = opts.model || null;
  const modelUsed = modelOverride || coderModel();

  const slug = resolveSlug(opts);

  let isolation = null;
  if (opts.isolate) {
    isolation = setupIsolation(sh, slug);
  }

  const sessionRealIdArg = opts.session ? readSessionsMap()[opts.session] || null : null;
  const dir = isolation ? isolation.wtPath : opts.cwd ? resolvePath(opts.cwd) : null;

  const argv = buildOpencodeArgv({
    prompt,
    agent,
    model: modelUsed,
    sessionRealId: sessionRealIdArg,
    cont: !!opts.continue,
    dir,
  });
  const env = buildEngineEnv();
  const engineVersion = detectOpencodeVersion(sh) || opencodeVersionPin();

  process.stderr.write(
    pc.dim(
      `[coder run] agent=${agent} model=${modelUsed}` +
        (isolation ? ` isolate=${isolation.wtPath}` : '') +
        '\n',
    ),
  );

  let result;
  try {
    result = await spawnEngine({ argv, env, timeoutSec, spawnFn });

    // Engine started and produced nothing parseable (e.g. bad --session id,
    // missing message, immediate crash) -> throw, per the envelope-vs-throw
    // split. Note this also covers "unknown real-id" errors from a stale
    // sessions.json entry — opencode's "Session not found" prints nothing
    // to stdout, so it naturally lands here.
    if (!result.parsedAnyEvent) {
      const tailLines = result.stderrTail.trim().split('\n').filter(Boolean).slice(-20);
      const detail = tailLines.length ? `\nLast stderr:\n${tailLines.join('\n')}` : '';
      throw new Error(
        `opencode produced no parseable output (exit ${result.code ?? 'null'}` +
          `${result.signal ? `, signal ${result.signal}` : ''}).${detail}`,
      );
    }
  } catch (err) {
    // setupIsolation ran BEFORE spawnEngine — a throw here would otherwise
    // leak a freshly-created worktree/branch (see cleanupAbandonedIsolation).
    if (isolation && isolation.freshlyCreated) {
      cleanupAbandonedIsolation(sh, isolation);
    }
    throw err;
  }

  let exit_reason;
  if (result.timedOut) exit_reason = 'timeout';
  else if (result.signal) exit_reason = 'killed';
  else if (result.code === 0) exit_reason = 'end_turn';
  else exit_reason = 'error';

  if (opts.session && result.sessionRealId) {
    persistSessionMapping(sh, opts.session, result.sessionRealId);
  }

  let filesChanged = [];
  let diffStat = null;
  let worktreeOut = null;
  if (isolation) {
    const changes = computeWorktreeChanges(sh, isolation.repoRoot, isolation.wtPath);
    if (changes.warnings.length) result.warnings.push(...changes.warnings);
    if (changes.filesChanged.length === 0) {
      try {
        // force: true — even with zero real changes, the seeded
        // opencode.json/.opencode (if any) are still untracked on disk
        // after computeWorktreeChanges' `git reset`, which makes `git
        // worktree remove` refuse without --force. Safe here specifically
        // because we've already confirmed via our OWN diff (which
        // excludes exactly those seeded paths) that nothing else changed.
        gitWorktreeRemove(sh, isolation.repoRoot, isolation.wtPath, { force: true });
        if (isolation.branch.startsWith(CODER_BRANCH_PREFIX)) {
          const branchDeleted = gitBranchDeleteSafe(sh, isolation.repoRoot, isolation.branch);
          if (!branchDeleted) {
            result.warnings.push(
              `branch ${isolation.branch} kept — not fully merged; a future --isolate --session ` +
                `<slug> reusing this slug will fail until it's removed (see \`triss coder clean --all\`)`,
            );
          }
        }
      } catch (err) {
        result.warnings.push(`isolate cleanup failed: ${err.message}`);
      }
    } else {
      filesChanged = changes.filesChanged;
      diffStat = changes.diffStat;
      worktreeOut = isolation.wtPath;
    }
  }

  if (!result.sawStepFinish) {
    result.warnings.push('no usage data (no step_finish events) in the event stream');
  }

  const promptTokens = result.usage.input;
  const completionTokens = result.usage.output;
  const ctx = currentCall();
  logUsage({
    model: modelUsed,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    label: 'coder',
    call_id: ctx?.callId,
    parent_call_id: ctx?.parentCallId,
  });

  const envelope = {
    engine: 'opencode',
    engine_version: engineVersion,
    session_id: result.sessionRealId || null,
    exit_reason,
    final_text: result.finalText,
    files_changed: filesChanged,
    diff_stat: diffStat,
    worktree: worktreeOut,
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    warnings: result.warnings,
  };

  // Injectable so tests don't have to monkey-patch the real
  // process.stdout.write — doing that across an `await` that yields the
  // event loop (as spawning a child process does) races with `node
  // --test`'s own internal reporter, which also writes to stdout between
  // turns and would otherwise corrupt the captured buffer.
  const writeStdout = deps.stdoutWrite || ((s) => process.stdout.write(s));
  writeStdout(JSON.stringify(envelope) + '\n');
}

// ─── coder clean (Phase 3) ──────────────────────────────────────────────────────

// Removes `.triss/wt/<slug>` worktrees whose branch has no diff vs the
// repo's default branch, then SAFE-deletes (`git branch -d`, never `-D`)
// the matching `coder/<slug>` branch so a re-run of `coder run --isolate`
// with the same slug can re-create it via `-b` (Phase 2's contract — `-b`
// fails if the branch already exists). Only branches under the `coder/`
// prefix are ever touched; a branch a user manually checked out into a
// `.triss/wt/*` dir some other way is left alone. `--all` forces removal
// of every worktree found, regardless of diff state. Never throws for
// "nothing to clean" — only for an actual `git worktree remove` failure
// on a targeted worktree (surfaced as a warning, not aborting the run).
export async function runCoderClean(opts = {}, deps = {}) {
  const sh = deps.spawnSync || nodeSpawnSync;
  const forceAll = !!opts.all;

  const repoRoot = gitRepoRoot(sh, projectRoot());
  if (!repoRoot) {
    process.stderr.write(pc.dim('  · not a git repository — nothing to clean\n'));
    return;
  }

  const worktrees = listWorktreeDirs(repoRoot);
  if (!worktrees.length) {
    process.stderr.write(pc.dim('  · no worktrees under .triss/wt — nothing to clean\n'));
    return;
  }

  const defaultBranch = defaultBranchVia(sh, repoRoot);
  const removed = [];
  const kept = [];
  const failed = [];

  for (const wt of worktrees) {
    const branch = gitWorktreeBranch(sh, wt.path);
    // Two independent "has work" signals, checked BEFORE attempting
    // removal: a committed diff vs base (worktreeHasDiff), and
    // uncommitted changes sitting in the worktree itself
    // (worktreeHasUncommittedChanges — this is what a `coder run`
    // worktree looks like: it stages but never commits). Either one
    // means "keep", not "attempt removal and report a failure".
    const dirty =
      !forceAll &&
      (worktreeHasDiff(sh, repoRoot, branch, defaultBranch) || worktreeHasUncommittedChanges(sh, wt.path));
    if (dirty) {
      kept.push({ ...wt, branch });
      continue;
    }
    try {
      gitWorktreeRemove(sh, repoRoot, wt.path, { force: forceAll });
      let branchKept = false;
      if (branch && branch.startsWith(CODER_BRANCH_PREFIX)) {
        branchKept = !gitBranchDeleteSafe(sh, repoRoot, branch);
      }
      removed.push({ ...wt, branch, branchKept });
    } catch (err) {
      failed.push({ ...wt, branch, error: err.message });
    }
  }

  for (const wt of removed) {
    process.stderr.write(pc.green(`  ✓ removed ${wt.slug} (${wt.branch || 'unknown branch'})\n`));
    if (wt.branchKept) {
      process.stderr.write(pc.dim(`    · kept branch ${wt.branch} — not fully merged\n`));
    }
  }
  for (const wt of kept) {
    const baseLabel = defaultBranch || 'base (unknown — kept to be safe)';
    process.stderr.write(
      pc.dim(`  · kept ${wt.slug} (${wt.branch || 'unknown branch'}) — has changes vs ${baseLabel}\n`),
    );
  }
  for (const wt of failed) {
    process.stderr.write(pc.yellow(`  ⚠ failed to remove ${wt.slug}: ${wt.error}\n`));
  }
  if (!removed.length && !kept.length && !failed.length) {
    process.stderr.write(pc.dim('  · nothing to clean\n'));
  }
}

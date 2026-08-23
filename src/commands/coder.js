// `triss coder` — delegate coding tasks to a GLM agent. opencode is the
// default engine (deny-first bash policy); crush is an optional second
// engine behind --engine crush / TRISS_CODER_ENGINE=crush (single JSON
// envelope, native session ids; crush 0.1.3's permissions.run config is
// currently inert, so crush defaults to worktree isolation and an opt-in
// CLI-flag allowlist — see src/coder-engines/crush.js and
// docs/engines/crush.md). Naming: "agent" is
// taken (the AI assistant using triss), so this feature is "coder"
// everywhere (command, file, env prefix).

import { spawnSync as nodeSpawnSync, spawn as nodeSpawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  cpSync,
  renameSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  rmSync,
  statSync,
  lstatSync,
  chmodSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, relative, resolve as resolvePath } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import pc from 'picocolors';
import {
  captureWorkerShellSnapshot,
  loadEnvFiles,
  readCoderCredentialMode,
  readWorkerConfigSnapshot,
} from '../config.js';
import { acquireCoderMutationLock } from '../coder-lock.js';
import { ISOLATION_CONFLICT_CODE, ISOLATION_DOWNGRADED_CODE, ISOLATION_ENFORCEMENT_REQUIRED_CODE, ISOLATION_UNAVAILABLE_CODE } from '../coder-result.js';
import { buildExecutionCapabilities, allocateRunIdentity, deriveV2LifecycleFields } from '../coder-orchestration.js';
import { startCoderCredentialProxy } from '../coder-credential-proxy.js';
import { positiveIntegerOption, positiveNumberOption } from '../option-validation.js';
import {
  resolveCoderProviderRoute,
  resolveCoderRuntimeProviderRoute,
  coderRoutesShareTransport,
  buildCoderTransientProviderOverlay,
  CODER_TRANSIENT_PROVIDER_ALIAS,
} from '../coder-providers.js';
export { coderCredentialReady } from '../coder-providers.js';

export const CREDENTIAL_ISOLATION_DOWNGRADED_CODE = 'TRISS_CODER_CREDENTIAL_ISOLATION_DOWNGRADED';
const CREDENTIAL_ISOLATION_DOWNGRADED_WARNING =
  `${CREDENTIAL_ISOLATION_DOWNGRADED_CODE}: best_effort_raw passes the selected raw provider credential to a same-UID engine child; repository code, plugins, tools, and shell commands may read or print it.`;
// Known configuration values that may legitimately live beside provider keys
// in a Triss env store but carry no credential material themselves. Keep this
// allowlist explicit: unknown assignments still fail closed, while a normal
// shell-credential `coder init` may persist its model pins without making the
// following protected run misclassify the store as credential-bearing.
const NON_SECRET_CODER_STORE_KEYS = new Set([
  'TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION',
  'TRISS_CODER_MODEL',
  'TRISS_CODER_SMALL_MODEL',
  'TRISS_CODER_ENGINE',
  'TRISS_CODER_OPENCODE_VERSION',
  'TRISS_CODER_OPENCODE2_VERSION',
  'TRISS_CODER_CRUSH_VERSION',
  'TRISS_CODER_CRUSH_RESTRICT',
  'TRISS_CODER_SESSION_CAP',
  'TRISS_WORKER_BASE_URL',
  'TRISS_WORKER_FLASH_MODEL',
  'TRISS_WORKER_PRO_MODEL',
  'TRISS_DEFAULT_MODEL',
  'TRISS_KIMI_BASE_URL',
  'TRISS_REQUEST_TIMEOUT_MS',
]);
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
  activeEnvFiles,
  readEnvFile,
} from '../secrets.js';
import { projectRoot } from '../safety.js';
import { logUsage, estimateCanonicalCost, resolveBillingMode } from '../usage.js';
import {
  emptyOpencodeUsage,
  foldOpencodeStep,
  finalizeOpencodeUsage,
  normalizeCrushUsage,
} from '../usage-schema.js';
import { currentCall } from '../call-context.js';
import { defaultBranchVia } from '../git.js';
import { openManagedTrissRoot } from '../managed-root.js';
import {
  acquireCoderMaintenanceLock,
  acquireCoderSessionRunLease,
  acquireCoderSlotLease,
  acquireCoderTargetLease,
  withCoderInventoryLock,
} from '../coder-lease.js';
// Plain string/number constants: static import keeps the typed admission
// error codes available to module-level helpers without module-eval coupling.
import {
  CODER_SESSION_BUSY_CODE,
  CODER_SESSION_INCOMPATIBLE_CODE,
  CODER_SESSION_STORE_INVALID_CODE,
} from '../coder-session-transitions.js';
// Canonical engine enums (dependency-neutral single source of truth).
import {
  CODER_SESSION_ENGINES,
  CODER_SESSION_STORE_ENGINES as SESSION_STORE_ENGINES,
} from '../coder-session-engines.js';
import { processStartIdentity } from '../update/cache.js';
import { ZAI_CODING_PLAN_BASE_URL, ZAI_PAYG_BASE_URL } from '../zai.js';
import {
  OPENCODE_CATALOGUE_TRANSIENT_HTTP_STATUSES,
  isTransientOpenCodeReadError,
} from '../opencode-catalogue.js';
// Crush is an optional coding engine behind `--engine crush`. The adapter is
// pure (detect/argv/env/parse/map); this module owns the engine-agnostic
// orchestration (isolation, spawn, envelope assembly). See
// docs/engines/crush.md for the supported engine boundary.
import { crush as crushEngine } from '../coder-engines/crush.js';
import {
  opencode2 as opencode2Engine,
  opencode2VersionPin,
  detectOpenCode2,
  installHintOpenCode2,
  ensureOpenCode2RuntimeDirs,
  createOpenCode2EventFolder,
  foldOpenCode2EventLine,
  opencode2LogPath,
  OPENCODE2_SMALL_MODEL_UNUSED_WARNING,
  OPENCODE2_SERVICE_SNAPSHOT_WARNING,
} from '../coder-engines/opencode2.js';
import { auditOpenCode2Run, auditOpenCode2Documents, verifyOpenCode2ContentHashes, computeEffectivePermissionPolicy } from '../opencode2-preflight.js';
// One canonical walker enumerates every opencode.json layer plus plugin and
// agent discovery; V2 static preflight and model inspection must see the same
// source set.
import { enumerateOpenCodeSources, parseOpenCodeDocument } from '../opencode-config.js';

// Pinned opencode-ai version, overridable for testing/upgrades.
// 1.18.7 (2026-07-27): 1.18.x is bugfix/Desktop work with no `run` CLI
// changes; 1.18.4 specifically improved Kimi model handling.
export const OPENCODE_PIN = '1.18.7';
// The default assumes a `zai-coding-plan` subscription key, not a pay-as-you-go
// `zai` key:
// `zai/glm-*` fails with "Insufficient balance or no resource package" on
// that key. Runtime provider detection below verifies the actual key type.
const DEFAULT_CODER_MODEL = 'zai-coding-plan/glm-5.2';
const DEFAULT_CODER_SMALL_MODEL = 'zai-coding-plan/glm-5-turbo';

// OpenCode remains the default because its deny-first opencode.json policy is
// enforced. Crush has a simpler single-envelope model but a weaker safety
// story: verified Crush releases ignore the persistent permissions.run config
// and a denied bash command can wait until timeout, so this module
// compensates by defaulting --isolate ON for Crush and making restrict opt-in.
// Override per-call via --engine or globally via TRISS_CODER_ENGINE.
export const DEFAULT_CODER_ENGINE = 'opencode';
const VALID_CODER_ENGINES = ['opencode', 'opencode2', 'crush'];

// Resolve + validate the engine selection. --engine beats TRISS_CODER_ENGINE
// beats the default. An invalid name throws a clear Error listing valid values
// (caught + formatted by wrap() in bin/triss.js; never a silent fallback).
export function resolveCoderEngine(opts = {}) {
  const engine = opts.engine || process.env.TRISS_CODER_ENGINE || DEFAULT_CODER_ENGINE;
  if (!VALID_CODER_ENGINES.includes(engine)) {
    throw new Error(
      `Unknown coder engine "${engine}" — valid values: ${VALID_CODER_ENGINES.join(', ')}. ` +
        'Pass --engine <name> or set TRISS_CODER_ENGINE=<name>.',
    );
  }
  return engine;
}

// ─── Z.AI provider auto-detection ───────────────────────────────────────────
//
// A coding-plan subscription key sent to the pay-as-you-go `zai` endpoint hits
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
// likely subscription route first, falling back to pay-as-you-go.
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
  if (await probeZaiBase(fetchImpl, ZAI_CODING_PLAN_BASE_URL, key)) return 'zai-coding-plan';
  if (await probeZaiBase(fetchImpl, ZAI_PAYG_BASE_URL, key)) return 'zai';
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

// Moonshot pay-as-you-go models (models.dev `moonshotai` provider, cross-checked
// against the official platform.kimi.ai pricing pages 2026-08-09).
// kimi-k2.7-code is the recommended
// main: it is the purpose-built coding model at $0.95/$4.00 per 1M tokens —
// the flagship kimi-k3 ($3.00/$15.00) is offered for when raw smarts beat cost.
// kimi-k2.6 is the cheap general model, the natural small/fast pick.
const MOONSHOT_MODEL_CHOICES = [
  { label: 'kimi-k2.7-code (recommended)', value: 'kimi-k2.7-code' },
  { label: 'kimi-k3 — flagship, 1M context', value: 'kimi-k3' },
  { label: 'kimi-k2.7-code-highspeed', value: 'kimi-k2.7-code-highspeed' },
  { label: 'kimi-k2.6', value: 'kimi-k2.6' },
];

// Kimi for Coding subscription models (models.dev `kimi-for-coding` provider —
// flat plan quota, Anthropic-protocol endpoint that only the coder engines can
// speak, not ask/review). k3 is the plan's headline model; the highspeed
// variant is the natural small/fast pick on a flat-rate plan.
const KIMI_CODING_MODEL_CHOICES = [
  { label: 'k3 — Kimi K3, 1M context (recommended)', value: 'k3' },
  { label: 'k3-256k — Kimi K3, 256k context', value: 'k3-256k' },
  { label: 'kimi-for-coding — plan default model', value: 'kimi-for-coding' },
  { label: 'kimi-for-coding-highspeed', value: 'kimi-for-coding-highspeed' },
];

// A convenience snapshot of the FREE OpenCode Zen models (served under the
// built-in `opencode` provider, base https://opencode.ai/zen/v1) offered by
// the `--provider opencode-zen` init picker. Free-tier only — the whole Zen
// catalogue (paid GPT/Claude/Gemini/… mirrors) is large and moves, so any other
// id is reachable verbatim via TRISS_CODER_MODEL=opencode/<id>. These free
// models are TEMPORARY (promotional), so init resolves the actual default and
// picker order against the LIVE catalogue (fetchZenModelIds) rather than
// trusting this static list — it's the offline fallback.
const ZEN_MODEL_CHOICES = [
  { label: 'deepseek-v4-flash-free — DeepSeek V4 Flash (free)', value: 'deepseek-v4-flash-free' },
  { label: 'north-mini-code-free — repo-level agentic coding (free)', value: 'north-mini-code-free' },
  { label: 'nemotron-3-ultra-free (free)', value: 'nemotron-3-ultra-free' },
  { label: 'mimo-v2.5-free (free)', value: 'mimo-v2.5-free' },
];
// Preference order for the silent (non-TTY) default. First one that the live
// catalogue actually offers wins. Both roles default to the current DeepSeek
// replacement for the retired hy3-free pin, then fall back independently.
const ZEN_MAIN_PRIORITY = [
  'deepseek-v4-flash-free',
  'north-mini-code-free',
  'nemotron-3-ultra-free',
  'mimo-v2.5-free',
];
const ZEN_SMALL_PRIORITY = ['deepseek-v4-flash-free', 'north-mini-code-free', 'mimo-v2.5-free'];
const isAuditedZenModel = (modelId) =>
  resolveCoderProviderRoute(`opencode/${modelId}`)?.transportAudited === true;
const ZEN_MODELS_URL = 'https://opencode.ai/zen/v1/models';
const ZEN_MODELS_TIMEOUT_MS = 10_000;

const GO_MODEL_CHOICES = [
  { label: 'deepseek-v4-flash — DeepSeek V4 Flash, 1M context', value: 'deepseek-v4-flash' },
];
const GO_MAIN_PRIORITY = ['deepseek-v4-flash'];
const GO_SMALL_PRIORITY = ['deepseek-v4-flash'];
const GO_MODELS_URL = 'https://opencode.ai/zen/go/v1/models';

// Zen keeps its historical Set-or-null contract. Go consumes the structured
// outcome directly so authenticated denials and an authoritative empty
// catalogue can never be mistaken for a temporary offline condition.
async function fetchZenModelIds(fetchImpl = globalThis.fetch) {
  const outcome = await fetchOpenCodeCatalogue(ZEN_MODELS_URL, fetchImpl, { strictEntries: false });
  return outcome.kind === 'available' ? outcome.ids : null;
}

async function fetchGoCatalogue(fetchImpl = globalThis.fetch) {
  return fetchOpenCodeCatalogue(GO_MODELS_URL, fetchImpl);
}

async function fetchOpenCodeCatalogue(url, fetchImpl = globalThis.fetch, { strictEntries = true } = {}) {
  const key = process.env.OPENCODE_API_KEY;
  if (!key) return { kind: 'missing-key' };
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(ZEN_MODELS_TIMEOUT_MS),
    });
  } catch {
    return { kind: 'transient', reason: 'transport' };
  }

  const status = Number(res?.status);
  if (!res?.ok) {
    if (status === 401) return { kind: 'unauthenticated' };
    if (status === 403) return { kind: 'forbidden' };
    if (OPENCODE_CATALOGUE_TRANSIENT_HTTP_STATUSES.has(status)) {
      return { kind: 'transient', reason: 'http', status };
    }
    return { kind: 'invalid', reason: 'http', status: Number.isFinite(status) ? status : null };
  }

  let body;
  try {
    body = await res.json();
  } catch (error) {
    return isTransientOpenCodeReadError(error)
      ? { kind: 'transient', reason: 'transport' }
      : { kind: 'invalid', reason: 'parse' };
  }
  if (!body || !Array.isArray(body.data)) return { kind: 'invalid', reason: 'shape' };
  if (body.data.length === 0) return { kind: 'empty' };

  if (!strictEntries) {
    // Preserve Zen init's historical leniency: valid ids remain useful even
    // when an unrelated entry is malformed. Go stays strict because an
    // authoritative subscription catalogue controls fail-closed setup.
    const ids = new Set();
    for (const entry of body.data) {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') continue;
      const id = entry.id.trim();
      if (!id || id !== entry.id || /\s/.test(id)) continue;
      ids.add(id);
    }
    return ids.size ? { kind: 'available', ids } : { kind: 'empty' };
  }

  const ids = new Set();
  for (const entry of body.data) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') {
      return { kind: 'invalid', reason: 'shape' };
    }
    const id = entry.id.trim();
    if (!id || id !== entry.id || /\s/.test(id)) {
      return { kind: 'invalid', reason: 'shape' };
    }
    ids.add(id);
  }
  return { kind: 'available', ids };
}

function resolveGoCatalogue(outcome, { allowUnverified = false, scope = 'global' } = {}) {
  if (outcome.kind === 'missing-key') {
    throw new Error(
      'Coder setup incomplete: OPENCODE_API_KEY is not set, so the OpenCode Go catalogue cannot be verified.',
    );
  }
  if (outcome.kind === 'unauthenticated') {
    throw new Error(
      'Coder setup incomplete: OpenCode Go catalogue returned HTTP 401; verify OPENCODE_API_KEY is a valid workspace key, then re-run.',
    );
  }
  if (outcome.kind === 'forbidden') {
    throw new Error(
      'Coder setup incomplete: OpenCode Go catalogue returned HTTP 403; verify the workspace has an active Go entitlement and catalogue access, then re-run.',
    );
  }
  if (outcome.kind === 'empty') {
    throw new Error(
      'Coder setup incomplete: OpenCode Go catalogue returned no models; verify the active Go subscription and workspace availability, then re-run.',
    );
  }
  if (outcome.kind === 'invalid') {
    const detail = outcome.reason === 'http' && outcome.status
      ? ` (HTTP ${outcome.status})`
      : '';
    throw new Error(
      `Coder setup incomplete: OpenCode Go catalogue response is invalid${detail}; retry after checking the provider status.`,
    );
  }
  if (outcome.kind === 'transient') {
    const detail = outcome.reason === 'http' ? `HTTP ${outcome.status}` : 'network or timeout failure';
    if (!allowUnverified) {
      const scopeFlag = scope === 'local' ? '--local' : '--global';
      throw new Error(
        `Coder setup incomplete: OpenCode Go catalogue is temporarily unavailable (${detail}); retry, or intentionally accept an unverified built-in model fallback with: triss coder init --provider opencode-go --allow-unverified ${scopeFlag}`,
      );
    }
    process.stderr.write(
      pc.yellow(
        `  ⚠ OpenCode Go catalogue is temporarily unavailable (${detail}) — ` +
          'using the built-in DeepSeek V4 Flash default because --allow-unverified was set; ' +
          'availability is NOT verified. Check the subscription and workspace settings at ' +
          'https://opencode.ai/docs/go/.\n',
      ),
    );
    return {
      available: null,
      choices: GO_MODEL_CHOICES,
      mainDefault: GO_MAIN_PRIORITY[0],
      smallDefault: GO_SMALL_PRIORITY[0],
    };
  }
  if (outcome.kind !== 'available' || !(outcome.ids instanceof Set)) {
    throw new Error(
      'Coder setup incomplete: OpenCode Go catalogue returned an unknown internal outcome; update Triss or retry with a supported version.',
    );
  }
  const available = outcome.ids;
  const firstAvailable = (priority) => priority.find((id) => available.has(id));
  const known = new Map(GO_MODEL_CHOICES.map((choice) => [choice.value, choice]));
  const orderedIds = [
    ...GO_MAIN_PRIORITY.filter((id) => available.has(id)),
    ...[...available].filter((id) => !GO_MAIN_PRIORITY.includes(id)),
  ];
  const choices = orderedIds.map(
    (id) => known.get(id) || { label: id, value: id },
  );
  const mainDefault = firstAvailable(GO_MAIN_PRIORITY) || orderedIds[0];
  const smallDefault = firstAvailable(GO_SMALL_PRIORITY) || mainDefault;
  return { available, choices, mainDefault, smallDefault };
}

// Resolves a Zen catalogue { available, mainDefault, smallDefault, choices }
// from the live model set (or the static fallback). Carries `available` (the
// verified Set, or null when unverified) so the caller can reject a stale
// preset/existing model the catalogue no longer lists. Secure mode also keeps
// unaudited transport ids out of choices/defaults even when the live catalogue
// lists them; best-effort raw mode deliberately retains those explicit ids.
// When the catalogue IS verified but lists none of the audited free models,
// defaults come back undefined and secure init blocks rather than persisting a
// model that protected routing cannot serve.
function resolveZenCatalogue(available, { allowUnaudited = false } = {}) {
  if (!available) {
    process.stderr.write(
      pc.yellow(
        '  ⚠ could not fetch the OpenCode Zen catalogue — using built-in model defaults; their ' +
          'availability is NOT verified (free Zen models are temporary). If a run fails immediately, ' +
          'set TRISS_CODER_MODEL to a model listed at https://opencode.ai/docs/zen/.\n',
      ),
    );
    const allowed = (modelId) => allowUnaudited || isAuditedZenModel(modelId);
    const fallbackChoices = ZEN_MODEL_CHOICES.filter(({ value }) => allowed(value));
    const fallbackMainPriority = ZEN_MAIN_PRIORITY.filter(allowed);
    const fallbackSmallPriority = ZEN_SMALL_PRIORITY.filter(allowed);
    return {
      available: null,
      choices: fallbackChoices,
      mainDefault: fallbackMainPriority[0],
      smallDefault: fallbackSmallPriority[0] || fallbackMainPriority[0],
    };
  }
  const firstAvailable = (priority) => priority.find((id) => available.has(id));
  const allowed = (modelId) => allowUnaudited || isAuditedZenModel(modelId);
  const choices = ZEN_MODEL_CHOICES.filter((c) => available.has(c.value) && allowed(c.value));
  const mainDefault = firstAvailable(ZEN_MAIN_PRIORITY.filter(allowed));
  // Any available model can serve as the small/fast one, so if none of the
  // small-priority ids remain but a main model does, reuse it rather than
  // leaving small unresolved (which would falsely trip the "none known" block).
  const smallDefault = firstAvailable(ZEN_SMALL_PRIORITY.filter(allowed)) || mainDefault;
  return { available, choices, mainDefault, smallDefault };
}

// Init-time picker choices for the provider itself (opencode engine only).
const CODER_PROVIDER_CHOICES = [
  { label: 'Z.AI GLM (glm-5.2, …) — needs a Z.AI key', value: 'zai' },
  { label: 'Triss worker (OpenAI-compatible) — reuses the worker key and endpoint', value: 'worker' },
  { label: 'OpenCode Zen (free models incl. DeepSeek V4 Flash) — needs an OpenCode key', value: 'opencode-zen' },
  { label: 'OpenCode Go subscription (DeepSeek V4 Flash) — uses an OpenCode key', value: 'opencode-go' },
  { label: 'Moonshot Kimi pay-as-you-go (kimi-k2.7-code, kimi-k3) — needs a Moonshot key', value: 'moonshot' },
  { label: 'Kimi for Coding subscription (K3) — needs a Kimi for Coding key', value: 'kimi-for-coding' },
];

function workerCoderProfile(settings = readWorkerConfigSnapshot()) {
  const baseUrl = String(settings.baseUrl || 'https://api.deepseek.com/v1')
    .trim()
    .replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid TRISS_WORKER_BASE_URL "${baseUrl}" — expected an absolute HTTP(S) URL.`);
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      'Invalid TRISS_WORKER_BASE_URL — embedded credentials, query parameters, and fragments are not allowed.',
    );
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error(
      `Unsafe TRISS_WORKER_BASE_URL "${baseUrl}" — remote OpenAI-compatible endpoints must use HTTPS.`,
    );
  }
  const flashModel = String(settings.flashModel || 'deepseek-v4-flash').trim();
  const proModel = String(settings.proModel || 'deepseek-v4-pro').trim();
  for (const [env, value] of [
    ['TRISS_WORKER_FLASH_MODEL', flashModel],
    ['TRISS_WORKER_PRO_MODEL', proModel],
  ]) {
    if (!value || /\s/.test(value)) {
      throw new Error(`Invalid ${env} — model ids must be non-empty and contain no whitespace.`);
    }
  }
  return { baseUrl, flashModel, proModel, models: [...new Set([flashModel, proModel])] };
}

// Resolves the per-provider init catalogue: the model prefix written into
// opencode.json, the picker choices, and the silent (non-TTY) defaults.
// `providerInfo.kind` is 'zai' | 'opencode-zen' | 'moonshot' |
// 'kimi-for-coding'; for zai, `detectedZai` is the plan probe result
// (zai-coding-plan / zai / null) so the prefix matches the endpoint the key
// actually authenticates against. The Kimi kinds need no probe at all: the two
// plans use DIFFERENT credential envs (MOONSHOT_API_KEY vs KIMI_API_KEY), so
// the chosen kind already names the endpoint.
// `openCodeCatalogue` supplies the live-verified defaults/choices for either
// OpenCode provider; it is omitted for providers without that catalogue flow.
function coderInitCatalogue(providerInfo, openCodeCatalogue) {
  if (providerInfo.kind === 'worker') {
    const profile = providerInfo.workerProfile || workerCoderProfile();
    const choices = profile.models.map((value) => ({ label: value, value }));
    return {
      prefix: 'triss-worker',
      choices,
      mainDefault: profile.flashModel,
      smallDefault: profile.flashModel,
      mainIdx: 0,
      smallIdx: 0,
      noun: 'Triss worker',
    };
  }
  if (providerInfo.kind === 'moonshot') {
    return {
      prefix: 'moonshotai',
      choices: MOONSHOT_MODEL_CHOICES,
      mainDefault: 'kimi-k2.7-code',
      smallDefault: 'kimi-k2.6',
      mainIdx: 0,
      smallIdx: 3,
      noun: 'Moonshot Kimi',
    };
  }
  if (providerInfo.kind === 'kimi-for-coding') {
    return {
      prefix: 'kimi-for-coding',
      choices: KIMI_CODING_MODEL_CHOICES,
      mainDefault: 'k3',
      smallDefault: 'kimi-for-coding-highspeed',
      mainIdx: 0,
      smallIdx: 3,
      noun: 'Kimi for Coding',
    };
  }
  if (providerInfo.kind === 'opencode-zen') {
    const z = openCodeCatalogue || {
      available: null,
      choices: ZEN_MODEL_CHOICES,
      mainDefault: ZEN_MAIN_PRIORITY[0],
      smallDefault: ZEN_SMALL_PRIORITY[0],
    };
    const idxOf = (v) => Math.max(0, z.choices.findIndex((c) => c.value === v));
    return {
      prefix: 'opencode',
      choices: z.choices,
      mainDefault: z.mainDefault,
      smallDefault: z.smallDefault,
      mainIdx: idxOf(z.mainDefault),
      smallIdx: idxOf(z.smallDefault),
      noun: 'OpenCode Zen',
      available: z.available,
    };
  }
  if (providerInfo.kind === 'opencode-go') {
    const go = openCodeCatalogue || {
      available: null,
      choices: GO_MODEL_CHOICES,
      mainDefault: GO_MAIN_PRIORITY[0],
      smallDefault: GO_SMALL_PRIORITY[0],
    };
    const idxOf = (value) => Math.max(0, go.choices.findIndex((choice) => choice.value === value));
    return {
      prefix: 'opencode-go',
      choices: go.choices,
      mainDefault: go.mainDefault,
      smallDefault: go.smallDefault,
      mainIdx: idxOf(go.mainDefault),
      smallIdx: idxOf(go.smallDefault),
      noun: 'OpenCode Go',
      available: go.available,
    };
  }
  return {
    prefix: providerInfo.detectedZai || DEFAULT_CODER_MODEL.split('/')[0],
    choices: GLM_MODEL_CHOICES,
    mainDefault: 'glm-5.2',
    smallDefault: 'glm-5-turbo',
    mainIdx: 0,
    smallIdx: 1,
    noun: 'GLM',
  };
}

// The credential env a provider KIND uses (not the plan sub-prefix) — so a
// preset is judged by provider, not by exact string.
const KIND_KEY_ENVS = {
  worker: 'TRISS_WORKER_API_KEY',
  'opencode-zen': 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  'kimi-for-coding': 'KIMI_API_KEY',
};
function kindKeyEnv(kind) {
  return KIND_KEY_ENVS[kind] || 'ZHIPU_API_KEY';
}
function modelMatchesKind(model, kind) {
  return !!model && coderModelCredential(model).provider === kind;
}

// Whether a preset/existing model may be REUSED verbatim for the chosen
// provider. Stricter than modelMatchesKind: for zai it also requires the
// model's plan prefix to match the DETECTED plan (when detection succeeded), so
// a `zai-coding-plan/*` model is not re-pinned against a probe that resolved to
// the pay-as-you-go `zai` base (which would retry forever). Unknown/undetected
// plan (detectedZai null) can't be verified, so it's allowed through.
function modelFitsProvider(model, providerInfo) {
  if (!model) return false;
  const prefix = String(model).split('/')[0];
  if (providerInfo.kind === 'worker') {
    const profile = providerInfo.workerProfile || workerCoderProfile();
    return prefix === 'triss-worker' && profile.models.includes(providerModelId(model));
  }
  if (providerInfo.kind === 'opencode-zen') return prefix === 'opencode';
  if (providerInfo.kind === 'opencode-go') return prefix === 'opencode-go';
  // Both Moonshot PAYG hosts share MOONSHOT_API_KEY, so either regional prefix
  // fits; kimi-for-coding is its own credential and endpoint.
  if (providerInfo.kind === 'moonshot') return prefix === 'moonshotai' || prefix === 'moonshotai-cn';
  if (providerInfo.kind === 'kimi-for-coding') return prefix === 'kimi-for-coding';
  if (prefix !== 'zai' && prefix !== 'zai-coding-plan') return false;
  return providerInfo.detectedZai ? prefix === providerInfo.detectedZai : true;
}

// The main/small_model of an existing opencode.json (or {} if absent/unreadable).
function readOpencodeModels(path) {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return {
      model: typeof j.model === 'string' ? j.model : undefined,
      smallModel: typeof j.small_model === 'string' ? j.small_model : undefined,
    };
  } catch {
    return {};
  }
}

// Resolve the main + small model for the CHOSEN provider. Per field, priority:
//   1. a TRISS_CODER_MODEL/SMALL_MODEL preset — but ONLY if it belongs to the
//      chosen provider (an explicit --provider must beat a stale cross-provider
//      preset; a mismatch is warned and ignored, not written);
//   2. the model already in opencode.json when it matches the provider (so a
//      re-run is idempotent and pins what's configured, without re-prompting);
//   3. the interactive picker (TTY);
//   4. the provider's silent default.
// `existing` is readOpencodeModels(opencode.json) from the caller.
async function resolveInitModels(
  providerInfo,
  deps = {},
  existing = {},
  { allowUnverified = false, allowUnaudited = false, scope = 'global' } = {},
) {
  // For Zen, resolve defaults + picker order against the LIVE catalogue (free
  // models are temporary) so we never pin a model that's already gone.
  const openCodeCatalogue =
    providerInfo.kind === 'opencode-zen'
      ? resolveZenCatalogue(await fetchZenModelIds(deps.fetch || globalThis.fetch), { allowUnaudited })
      : providerInfo.kind === 'opencode-go'
        ? resolveGoCatalogue(await fetchGoCatalogue(deps.fetch || globalThis.fetch), {
            allowUnverified,
            scope,
          })
        : undefined;
  const cat = coderInitCatalogue(providerInfo, openCodeCatalogue);
  const choose = deps.promptChoice || promptChoice;
  const interactive = !!process.stdin.isTTY;

  // With a VERIFIED live Zen catalogue (available is a Set), a preset/existing
  // model — or a static default — is only usable if the catalogue still lists
  // its bare id. Free Zen models are temporary, so a stale pin (e.g. a
  // previous init's opencode/hy3-free after the promo ends) must NOT be honored
  // verbatim just because its provider prefix matches. When the catalogue is
  // unverified (available null) we can't reject anything.
  const providerAvailable =
    providerInfo.kind === 'opencode-zen' || providerInfo.kind === 'opencode-go'
      ? cat.available
      : null;
  const providerVerifiedAbsent = (m) => {
    if (!m) return false;
    if (providerInfo.kind === 'opencode-zen' && !allowUnaudited && !isAuditedZenModel(providerModelId(m))) {
      return true;
    }
    if (providerInfo.kind === 'worker') {
      const profile = providerInfo.workerProfile || workerCoderProfile();
      return !profile.models.includes(providerModelId(m));
    }
    return !!providerAvailable && !providerAvailable.has(providerModelId(m));
  };

  // `prefix` is the provider prefix used for picker/default resolutions of
  // THIS field; it defaults to the catalogue's canonical prefix but the small
  // model passes the resolved main model's prefix instead (see below).
  const pickOne = async (envVar, existingVal, label, idx, def, fallbackFull, prefix = cat.prefix) => {
    // 1. An explicit env preset is honored verbatim when it's the right PROVIDER
    //    KIND (the user set it deliberately). Warn — but still use it — if its
    //    plan prefix doesn't match the detected Z.AI plan.
    const preset = process.env[envVar];
    if (preset) {
      if (modelMatchesKind(preset, providerInfo.kind)) {
        if (providerVerifiedAbsent(preset)) {
          // A stale or unaudited secure Zen pin is never persisted; fall
          // through to an available audited model instead.
          process.stderr.write(
            pc.yellow(
              `  ⚠ ignoring ${envVar}=${preset} — it is not in the current ${cat.noun} catalogue or lacks ` +
                `secure/audited transport metadata; ` +
                'selecting an available model instead.\n',
            ),
          );
        } else {
          // A zai preset on the wrong PLAN (detected) is honored but flagged; a
          // totally unknown prefix is left to the end-of-function warning.
          const pfx = preset.split('/')[0];
          if (
            providerInfo.kind === 'zai' &&
            providerInfo.detectedZai &&
            (pfx === 'zai' || pfx === 'zai-coding-plan') &&
            pfx !== providerInfo.detectedZai
          ) {
            process.stderr.write(
              pc.yellow(
                `  ⚠ ${envVar}=${preset} uses the "${pfx}/" prefix but the key verified against the ` +
                  `"${providerInfo.detectedZai}" plan — using it as set, but runs may retry forever if the ` +
                  'key cannot serve that plan.\n',
              ),
            );
          }
          return preset;
        }
      } else {
        process.stderr.write(
          pc.yellow(
            `  ⚠ ignoring ${envVar}=${preset} — it does not match the ${cat.noun} provider you ` +
              `selected (expected the "${cat.prefix}/" prefix); unset it or set a matching model.\n`,
          ),
        );
      }
    }
    // 2. Reuse an existing opencode.json model only when it FITS the provider,
    //    plan included — so a zai-coding-plan model isn't re-pinned against a
    //    key that verified as pay-as-you-go zai (the infinite-retry trap) — AND
    //    (for Zen) the live catalogue still offers it.
    if (modelFitsProvider(existingVal, providerInfo) && !providerVerifiedAbsent(existingVal)) {
      return existingVal;
    }
    // 3./4. picker (TTY, when the catalogue offers choices) or the provider's
    //       silent default. When a VERIFIED Zen catalogue lists none of triss's
    //       known free models there is no `def`: fall back to `fallbackFull`
    //       (the already-resolved main model — any available model serves as the
    //       small/fast one, so a single in-catalogue main pick like a paid
    //       opencode/gpt-5.5 doesn't dead-end on the small model). Only when
    //       there is no fallback either do we block with an actionable message
    //       rather than fabricating a model the catalogue said is gone.
    if (interactive && cat.choices.length) {
      return `${prefix}/${await choose(`  ${label} ${cat.noun} model for opencode.json?`, cat.choices, { defaultIndex: idx })}`;
    }
    if (def) return `${prefix}/${def}`;
    if (fallbackFull) return fallbackFull;
    if (cat.noun === 'OpenCode Zen') {
      throw new Error(
        `Coder setup incomplete: none of triss's known free OpenCode Zen models are in the current ` +
          `catalogue (for the ${label.toLowerCase()} model). Pick one from https://opencode.ai/docs/zen/ and ` +
          `set ${envVar}=opencode/<id>, then re-run.`,
      );
    }
    throw new Error(
      `Coder setup incomplete: none of triss's known ${cat.noun} models are in the current ` +
        `catalogue (for the ${label.toLowerCase()} model). Pick one from the provider catalogue and ` +
        `set ${envVar}=${cat.prefix}/<id>, then re-run.`,
    );
  };

  const model = await pickOne('TRISS_CODER_MODEL', existing.model, 'Main', cat.mainIdx, cat.mainDefault, null);
  // The small model must share the MAIN model's provider/plan prefix when the
  // main fits the chosen provider: an honored moonshotai-cn/* main would
  // otherwise pair with the catalogue's default `moonshotai/` small — a
  // cross-host mix one key cannot serve, which auditExistingConfig rightly
  // blocks on the NEXT init run (breaking idempotency). A main that does NOT
  // fit (a cross-plan zai preset honored with its loud warning) keeps the
  // catalogue prefix — the endpoint the key actually verified against.
  const mainPrefix = String(model).split('/')[0];
  const smallPrefix = modelFitsProvider(model, providerInfo) ? mainPrefix : cat.prefix;
  // The resolved main model is the small model's last-resort fallback (see the
  // block above) so a paid/custom in-catalogue main pick never dead-ends here.
  const smallModel = await pickOne(
    'TRISS_CODER_SMALL_MODEL',
    existing.smallModel,
    'Small/fast',
    cat.smallIdx,
    cat.smallDefault,
    model,
    smallPrefix,
  );
  if (!allowUnaudited && providerInfo.kind === 'opencode-zen') {
    for (const [label, selected] of [['main', model], ['small', smallModel]]) {
      if (!isAuditedZenModel(providerModelId(selected))) {
        throw new Error(
          `Coder setup incomplete: secure OpenCode Zen ${label} model "${selected}" lacks audited transport metadata; ` +
          'use a transport-audited model or explicitly acknowledge best-effort raw mode with ' +
          'TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=1.',
        );
      }
    }
  }
  // A preset/existing model with a prefix triss doesn't recognize is routed to
  // ZHIPU_API_KEY by default (coderModelCredential) and can never be served —
  // opencode retries it forever. Warn rather than silently pin it.
  for (const [field, m] of [['TRISS_CODER_MODEL', model], ['TRISS_CODER_SMALL_MODEL', smallModel]]) {
    if (!isKnownProviderPrefix(m)) {
      process.stderr.write(
        pc.yellow(
          `  ⚠ ${field} resolved to "${m}", whose provider prefix triss doesn't recognize ` +
            '(known: triss-worker/*, zai-coding-plan/*, zai/*, opencode/*, opencode-go/*, moonshotai/*, moonshotai-cn/*, ' +
            'kimi-for-coding/*). Runs will send it the ZHIPU_API_KEY by ' +
            'default and likely retry forever — set a model with a known prefix.\n',
        ),
      );
    }
  }
  // Return both the legacy Zen-specific view (for the focused stale-Zen
  // recovery reporter) and the selected provider's catalogue (for generic
  // cross-scope small-model validation, including Go).
  return {
    model,
    smallModel,
    zenAvailable: providerInfo.kind === 'opencode-zen' ? providerAvailable : null,
    providerAvailable,
  };
}

// Normalizes a --provider flag value (with aliases) to 'zai' | 'opencode-zen'
// | 'opencode-go' | 'moonshot' | 'kimi-for-coding', throwing on anything else. Shared by
// resolveInitProvider and the crush guard so both accept the SAME alias set
// (glm/z.ai/zhipu -> zai; opencode/zen -> opencode-zen; kimi/moonshotai ->
// moonshot; kimi-coding/kimi-code -> kimi-for-coding).
export function normalizeProviderFlag(raw) {
  const v = String(raw).trim().toLowerCase();
  if (['zai', 'glm', 'z.ai', 'zhipu'].includes(v)) return 'zai';
  if (['worker', 'openai', 'openai-compatible'].includes(v)) return 'worker';
  if (['opencode-zen', 'opencode', 'zen'].includes(v)) return 'opencode-zen';
  if (['opencode-go', 'go'].includes(v)) return 'opencode-go';
  if (['moonshot', 'kimi', 'moonshotai'].includes(v)) return 'moonshot';
  if (['kimi-for-coding', 'kimi-coding', 'kimi-code'].includes(v)) return 'kimi-for-coding';
  throw new Error(
    `Unknown --provider "${raw}" — valid values: zai, worker, opencode-zen, opencode-go, moonshot, kimi-for-coding.`,
  );
}

// Provider implied by the environment alone (no flag, no prompt): a
// TRISS_CODER_MODEL preset decides by its prefix, else a single configured
// credential is taken as the intent (only one of ZHIPU / OPENCODE / MOONSHOT /
// KIMI set -> that provider). Returns null when genuinely ambiguous (none or
// several set).
function providerFromEnv() {
  const preset = process.env.TRISS_CODER_MODEL;
  if (preset) return coderModelCredential(preset).provider;
  const configured = [
    ['zai', 'ZHIPU_API_KEY'],
    ['opencode-zen', 'OPENCODE_API_KEY'],
    ['moonshot', 'MOONSHOT_API_KEY'],
    ['kimi-for-coding', 'KIMI_API_KEY'],
  ].filter(([, env]) => !!process.env[env]);
  return configured.length === 1 ? configured[0][0] : null;
}

// Non-prompting resolution (wizard postSetup path): environment intent ONLY.
// Throws when ambiguous or missing — this hardening is for direct/non-wizard
// runCoderSetup and does NOT change resolveInitProvider behavior.
function inferCoderProvider() {
  const fromEnv = providerFromEnv();
  if (fromEnv) return fromEnv;

  // Provider intent is ambiguous or missing. Detect which keys are set to
  // give a helpful error message.
  const configuredKeys = [
    ['zai', 'ZHIPU_API_KEY'],
    ['opencode-zen', 'OPENCODE_API_KEY'],
    ['moonshot', 'MOONSHOT_API_KEY'],
    ['kimi-for-coding', 'KIMI_API_KEY'],
  ].filter(([, env]) => !!process.env[env]);

  const keyNames = configuredKeys.map(([, env]) => env).join(', ');
  throw new Error(
    `Coder provider intent is ambiguous or missing. ${keyNames ? `Multiple credentials are set: ${keyNames}.` : 'No provider credential is set.'} ` +
      'Disambiguate by re-running with one of:\n' +
      '  triss config wizard coder --coder-provider zai\n' +
      '  triss config wizard coder --coder-provider worker\n' +
      '  triss config wizard coder --coder-provider opencode-zen\n' +
      '  triss config wizard coder --coder-provider opencode-go\n' +
      '  triss config wizard coder --coder-provider moonshot\n' +
      '  triss config wizard coder --coder-provider kimi-for-coding'
  );
}

// The interactive provider resolution for `triss coder init`: explicit
// --provider flag > environment intent (preset / single credential) > a TTY
// prompt when genuinely ambiguous. Non-interactive + genuinely ambiguous (zero
// or several credentials, no flag, no preset) REFUSES to silently default to
// zai — the historical `return 'zai'` fallback that caused the incident — and
// instead throws listing the exact per-provider alternatives, BEFORE any
// spawn/fetch/write. Parity with resolveWizardCoderProvider's WIZ-09 branch.
async function resolveInitProvider(opts, deps = {}) {
  if (opts.provider) return normalizeProviderFlag(opts.provider);
  const fromEnv = providerFromEnv();
  if (fromEnv) return fromEnv;
  if (process.stdin.isTTY) {
    const choose = deps.promptChoice || promptChoice;
    return await choose('  Model provider for the opencode engine?', CODER_PROVIDER_CHOICES, { defaultIndex: 0 });
  }
  // Non-interactive + genuinely ambiguous (no flag, no preset, zero or several
  // provider credentials). Fail BEFORE any spawn/fetch/write and list the exact
  // alternatives; never silently pick zai.
  throw new Error(
    'Coder provider is required but ambiguous: no --provider flag, no TRISS_CODER_MODEL ' +
      'preset, and not exactly one provider credential (zero or several are set). `triss coder init` ' +
      'will not silently default to Z.AI. Re-run with one of:\n' +
      '  triss coder init --provider zai\n' +
      '  triss coder init --provider worker\n' +
      '  triss coder init --provider opencode-zen\n' +
      '  triss coder init --provider opencode-go\n' +
      '  triss coder init --provider moonshot\n' +
      '  triss coder init --provider kimi-for-coding',
  );
}

// ─── `triss config wizard coder` provider/engine resolution ──────────────────
//
// The wizard has its OWN flag surface (--coder-engine / --coder-provider) so a
// generic `config wizard coder` does NOT collide with `coder init`'s
// --engine/--provider. Engine is resolved FIRST, provider SECOND — because the
// crush engine fixes the provider to Z.AI and rejects a conflicting
// --coder-provider before any credential is iterated. The opencode engine then
// resolves the provider via a strict intent order (see resolveWizardCoderProvider).

// Resolve + validate the wizard coder engine. --coder-engine beats
// TRISS_CODER_ENGINE beats the default. An invalid name throws (never a silent
// fallback) — same contract as resolveCoderEngine, just on the wizard flag.
function resolveWizardCoderEngine(opts = {}) {
  const engine = opts.coderEngine || process.env.TRISS_CODER_ENGINE || DEFAULT_CODER_ENGINE;
  if (!VALID_CODER_ENGINES.includes(engine)) {
    throw new Error(
      `Unknown coder engine "${engine}" — valid values: ${VALID_CODER_ENGINES.join(', ')}. ` +
        'Pass --coder-engine <name> or set TRISS_CODER_ENGINE=<name>.',
    );
  }
  return engine;
}

// Provider intent implied by the EFFECTIVE opencode.json model prefix (intent
// #3 in the wizard order). opencode resolves config from cwd upward, so the
// project (local) file is checked first — that is the file that actually
// governs runs and the one a stale Zen pin (the incident) lives in. Returns
// null when there is no opencode.json model to read. Used ONLY by the wizard
// resolver (coder init keeps its own, credential-first inference).
function providerFromEngineConfig(engine) {
  if (engine !== 'opencode') return null;
  for (const s of ['local', 'global']) {
    const p = opencodeConfigPath(s);
    if (existsSync(p)) {
      const { model } = readOpencodeModels(p);
      if (model) return coderModelCredential(model).provider;
    }
  }
  return null;
}

// The wizard provider resolver. Intent order (engine already resolved):
//   1. explicit --coder-provider flag (or --coder-model prefix)
//   2. effective TRISS_CODER_MODEL prefix
//   3. effective engine config (opencode.json) model prefix — the incident hook
//   4. exactly one configured provider credential
//   5. a TTY prompt when genuinely ambiguous
//   6. otherwise (non-interactive + genuinely ambiguous): THROW naming provider
//      ambiguity and the exact per-provider recovery commands — rather than
//      silently defaulting to zai. The zai fallback would write a global
//      opencode.json, pin a Z.AI model into the env file, and demand
//      ZHIPU_API_KEY against the user's actual intent. Throwing here (inside
//      resolveWizardCtx, before the env-var loop or postSetup) guarantees the
//      wizard writes nothing before the failure.
// Crush short-circuits ALL of this: provider is fixed to zai and a non-zai
// --coder-provider is rejected before credentials are iterated.
async function resolveWizardCoderProvider(opts = {}, engine, deps = {}) {
  if (engine === 'crush') {
    const want = opts.coderProvider ? normalizeProviderFlag(opts.coderProvider) : 'zai';
    if (want !== 'zai') {
      throw new Error(
        `The crush engine supports Z.AI GLM only — \`--coder-provider ${opts.coderProvider}\` requires the ` +
          'opencode engine. Drop --coder-engine crush (or use --coder-provider zai).',
      );
    }
    return 'zai';
  }
  if (opts.coderProvider) return normalizeProviderFlag(opts.coderProvider);
  if (opts.coderModel) return coderModelCredential(opts.coderModel).provider;
  const preset = process.env.TRISS_CODER_MODEL;
  if (preset) return coderModelCredential(preset).provider;
  const fromCfg = providerFromEngineConfig(engine);
  if (fromCfg) return fromCfg;
  const fromCreds = providerFromEnv();
  if (fromCreds) return fromCreds;
  const interactive = deps && deps.isTTY !== undefined ? !!deps.isTTY : !!process.stdin.isTTY;
  if (interactive) {
    const choose = (deps && deps.promptChoice) || promptChoice;
    return await choose('  Model provider for the opencode engine?', CODER_PROVIDER_CHOICES, { defaultIndex: 0 });
  }
  // Non-interactive + genuinely ambiguous (no flag, no preset, no engine config,
  // and zero or several provider credentials). Refuse to silently default to zai
  // — that would write a global opencode.json, pin a Z.AI model, and demand
  // ZHIPU_API_KEY against the user's actual intent. Throw here (before the env-var
  // loop or postSetup run) so the wizard writes nothing before this failure. The
  // message lists the exact per-provider recovery commands and no credential
  // values. WIZ-09.
  throw new Error(
    'Coder provider is required but ambiguous: no --coder-provider flag, no TRISS_CODER_MODEL ' +
      'preset, no opencode.json model, and not exactly one provider credential (zero or several ' +
      'are set). The wizard will not silently default to Z.AI. Disambiguate by re-running with ' +
      'one of:\n' +
      '  triss config wizard coder --coder-engine opencode --coder-provider zai\n' +
      '  triss config wizard coder --coder-engine opencode --coder-provider worker\n' +
      '  triss config wizard coder --coder-engine opencode --coder-provider opencode-zen\n' +
      '  triss config wizard coder --coder-engine opencode --coder-provider opencode-go\n' +
      '  triss config wizard coder --coder-engine opencode --coder-provider moonshot\n' +
      '  triss config wizard coder --coder-engine opencode --coder-provider kimi-for-coding',
  );
}

// Per-provider key descriptor for setupKey / the init prompt.
function coderProviderKeyInfo(provider) {
  if (provider === 'worker') {
    return {
      env: 'TRISS_WORKER_API_KEY',
      doc: 'Existing OpenAI-compatible worker API key (TRISS_WORKER_BASE_URL selects the endpoint)',
    };
  }
  if (provider === 'opencode-zen') {
    return {
      env: 'OPENCODE_API_KEY',
      doc: 'OpenCode Zen API key — free models (catalogue-driven) — https://opencode.ai/docs/zen/',
    };
  }
  if (provider === 'opencode-go') {
    return {
      env: 'OPENCODE_API_KEY',
      doc: 'OpenCode Go subscription key — https://opencode.ai/docs/go/',
    };
  }
  if (provider === 'moonshot') {
    return {
      env: 'MOONSHOT_API_KEY',
      doc: 'Moonshot AI (Kimi) API key — https://platform.kimi.ai/console/api-keys',
    };
  }
  if (provider === 'kimi-for-coding') {
    return {
      env: 'KIMI_API_KEY',
      doc: 'Kimi for Coding subscription key — https://www.kimi.com/code/docs/en/',
    };
  }
  return {
    env: 'ZHIPU_API_KEY',
    doc: 'Z.AI API key for GLM models — https://z.ai/manage-apikey/apikey-list',
  };
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

// Which API key a resolved coder model needs. OpenCode Zen models (provider
// prefix `opencode/`, e.g. the free `opencode/deepseek-v4-flash-free`) authenticate with
// OPENCODE_API_KEY; Moonshot PAYG models (`moonshotai/*`, `moonshotai-cn/*`)
// with MOONSHOT_API_KEY; Kimi for Coding subscription models
// (`kimi-for-coding/*`) with KIMI_API_KEY; every other prefix — the Z.AI GLM
// families `zai-coding-plan/*` and `zai/*`, plus any unrecognised prefix (the
// historical default) — uses ZHIPU_API_KEY. triss forwards whichever key is
// set straight through to the engine subprocess (see buildEngineEnv). The
// crush engine only speaks Z.AI (it bridges ZHIPU_API_KEY -> ZAI_API_KEY), so
// its credential is always ZHIPU regardless of the model string.
export function coderModelCredential(model) {
  const route = resolveCoderProviderRoute(model);
  if (route) return { env: route.credentialEnv, provider: route.provider };
  return { env: 'ZHIPU_API_KEY', provider: 'zai' };
}

// Provider prefixes triss actually knows how to authenticate. Anything else is
// routed to ZHIPU_API_KEY by coderModelCredential's default, which then can't
// serve it — a silent infinite-retry trap. Used to warn at init time.
const KNOWN_PROVIDER_PREFIXES = new Set([
  'triss-worker',
  'zai-coding-plan',
  'zai',
  'opencode',
  'opencode-go',
  'moonshotai',
  'moonshotai-cn',
  'kimi-for-coding',
]);
function isKnownProviderPrefix(model) {
  return KNOWN_PROVIDER_PREFIXES.has(String(model || '').split('/')[0]);
}

function isQualifiedProviderModel(model) {
  const value = String(model || '');
  const slash = value.indexOf('/');
  return (
    slash > 0 &&
    slash < value.length - 1 &&
    value === value.trim() &&
    !/\s/.test(value) &&
    !value.endsWith('/') &&
    providerModelId(value).length > 0 &&
    !providerModelId(value).startsWith('/')
  );
}

// The bare model id of a provider-prefixed model string (everything after the
// first `/`): `opencode/hy3-free` -> `hy3-free`. Used to check a model against
// the live OpenCode Zen catalogue, whose ids are bare.
function providerModelId(model) {
  return String(model || '').split('/').slice(1).join('/');
}

// POSIX single-quote a dynamic value for a printed, copy-paste command (model
// ids in a recovery command). Wraps in '...' and escapes embedded quotes as
// '\'' so the value parses as one shell argument even with spaces/apostrophes/
// $();. Mirrors src/coder-models.js#posixSingleQuote without introducing a
// circular coder.js <-> coder-models.js import.
function posixSingleQuote(value) {
  const v = String(value);
  return `'${v.replace(/'/g, "'\\''")}'`;
}

// The coder tools/status surface as soon as ANY provider credential is
// present: ZHIPU_API_KEY (Z.AI GLM — the default) or OPENCODE_API_KEY
// (OpenCode Zen). envReadiness(CODER_MANIFEST) only tracks the required ZHIPU
// key, so callers that must also light up for a zen-only setup OR this in.
// ─── wizard manifest ─────────────────────────────────────────────────────────

// Pseudo-manifest so `triss config wizard` / `triss status` can surface
// coder setup alongside real integrations. Field is `name`, NOT `key` —
// every consumer (envReadiness, wizard prompts, status markers) reads
// `.name`. Has no `register()` — do NOT add to loadIntegrations(), it
// requires that (see src/integrations/_contract.js validateManifest).
export const CODER_MANIFEST = {
  name: 'coder',
  description: 'Coding agent — GLM, the OpenAI-compatible Triss worker, Kimi, OpenCode Zen, or OpenCode Go models (opencode or crush engine)',
  envVars: [
    {
      name: 'TRISS_WORKER_API_KEY',
      required: false,
      secret: true,
      doc: 'Existing OpenAI-compatible worker key for triss-worker/* coder models',
    },
    {
      name: 'ZHIPU_API_KEY',
      required: true,
      secret: true,
      doc: 'Z.AI API key for GLM models — https://z.ai/manage-apikey/apikey-list',
    },
    {
      // Optional: only the opencode engine needs it, and only for
      // `opencode/*` (OpenCode Zen) models — e.g. the free opencode/deepseek-v4-flash-free.
      // Set TRISS_CODER_MODEL=opencode/<id> (or pass --model) to route a run
      // through it. Readiness stays governed by ZHIPU_API_KEY (the default
      // provider); this key just unlocks the zen provider when present.
      name: 'OPENCODE_API_KEY',
      required: false,
      secret: true,
      doc: 'OpenCode key for Zen opencode/* and Go opencode-go/* models — https://opencode.ai/docs/go/',
    },
    {
      // Optional: unlocks Moonshot PAYG models (moonshotai/*) for the
      // opencode engine and `--provider kimi` ask/review calls.
      name: 'MOONSHOT_API_KEY',
      required: false,
      secret: true,
      doc: 'Moonshot AI key for moonshotai/* Kimi models (e.g. moonshotai/kimi-k2.7-code) — https://platform.kimi.ai/console/api-keys',
    },
    {
      // Optional: unlocks the Kimi for Coding subscription (kimi-for-coding/*)
      // for the opencode engine — flat plan quota, not per-token billing.
      name: 'KIMI_API_KEY',
      required: false,
      secret: true,
      doc: 'Kimi for Coding subscription key for kimi-for-coding/* models (e.g. kimi-for-coding/k3) — https://www.kimi.com/code/docs/en/',
    },
  ],
  // Resolves the engine/provider for the wizard BEFORE the generic env-var
  // loop runs, and narrows that loop to ONLY the resolved provider's
  // credential — so an explicit `--coder-provider opencode-zen` walks just
  // OPENCODE_API_KEY and never asks for (or requires) ZHIPU_API_KEY. Engine is
  // resolved first; provider second. A crush engine + non-zai provider is
  // rejected HERE (before any credential iteration). The returned `ctx`
  // (engine/provider) flows into postSetup so runCoderSetup doesn't re-infer.
  // `deps` (injected fetch/spawnSync/isTTY/outputs) threads through so the
  // wizard is testable without real network/PATH.
  resolveWizardCtx: async (wizardOpts, current, deps, { scope, path }) => {
    const engine = resolveWizardCoderEngine(wizardOpts);
    const provider = await resolveWizardCoderProvider(wizardOpts, engine, deps);
    const keyEnv = kindKeyEnv(provider);
    const envVars = CODER_MANIFEST.envVars.filter((v) => v.name === keyEnv);
    return { envVars, ctx: { engine, provider, scope, path } };
  },
  postSetup: (ctx, deps) => runCoderSetup(ctx, deps),
};

// ─── agent templates ─────────────────────────────────────────────────────────

const CODER_AGENT_TEMPLATE = `---
description: Implementation agent — writes and edits code under the opencode.json permission policy.
mode: primary
---

You are the coder agent, invoked headlessly by \`triss coder run\` with a
complete task packet. You own the implementation stream for your assigned
checkout: repository investigation, implementation, tests, debugging, and
self-verification.

1. Read the applicable repository instructions (README, CONTRIBUTING,
   AGENTS.md, CLAUDE.md) and locate the relevant files and existing
   patterns.
2. Execute the complete scoped plan from the task packet.
3. Add or update focused tests whenever you change behavior.
4. Run the relevant repository-native checks the task packet allows (only
   the bash commands allowlisted in opencode.json are permitted); if a
   check is unavailable, say so instead of skipping it silently.
5. Debug failures caused by your change until the checks pass.
6. Inspect the final diff for accidental or unrelated edits.
7. Report the outcome, files changed, checks run with their exact pass/fail
   state, and any unresolved blockers or risks truthfully.

Hard boundaries: stay inside the working directory you were given; do not
commit; do not push, deploy, or touch anything outside this checkout; do
not modify unrelated files; and never claim a check passed unless it
actually ran successfully. Leave the finished change on disk — the
orchestrator collects and stages the diff after you finish.
`;

const RESEARCHER_AGENT_TEMPLATE = `---
description: Read-only research agent — investigates and reports, never edits.
mode: subagent
permission:
  edit: deny
  bash: deny
---

You are the researcher agent: a research-only specialist. Investigate and
answer the question you were given by reading the codebase. Do not edit
files and do not run shell commands — report findings as text only. You are
not a mandatory precursor to coder work: use your results as one input when
research is genuinely needed, then let a single coder run own the
implementation.
`;

// ─── init ────────────────────────────────────────────────────────────────────

// Entry point 1: `triss coder init`. Entry point 2: `triss config wizard`
// (via CODER_MANIFEST — the generic env-var loop handles the key, then
// runFullWizard calls CODER_MANIFEST.postSetup -> runCoderSetup). Both
// converge on runCoderSetup() for engine/config/template steps.
export async function runCoderInit(opts = {}, deps = {}) {
  // Capture model overrides that are in the environment BEFORE loadEnvFiles()
  // merges the .env files — i.e. genuine shell exports, which have higher
  // precedence than any .env file and so would shadow whatever init pins.
  // Invariant: the pre-dotenv snapshots are taken FIRST and the env
  // files are loaded BEFORE the engine dispatch — the dispatch used to read
  // TRISS_CODER_ENGINE from the shell env only, so `TRISS_CODER_ENGINE=
  // opencode2` in a .env file silently ran the whole V1 init path (V1 binary
  // probe/install, V1 agent templates, the allowlist bash policy the V2
  // preflight then rejects). The pre-dotenv snapshots are passed through to
  // runOpenCode2Init so its own capture (which now runs AFTER this
  // loadEnvFiles) is not polluted by dotenv values.
  const inheritedModels = {
    model: process.env.TRISS_CODER_MODEL,
    smallModel: process.env.TRISS_CODER_SMALL_MODEL,
  };
  const workerShellEnv = captureWorkerShellSnapshot();
  loadEnvFiles();
  const engine = resolveCoderEngine(opts);
  // OpenCode 2 shares the V1-compatible configuration surface.
  // V2 shares the V1-compatible opencode.json surface: the SAME
  // setupKey/runCoderSetup flow configures the shared config, then the V2
  // specifics (XDG state roots + static plugin/agent preflight + minimum and
  // capability report) run BEFORE any V2 process is spawned. Nothing here
  // starts a V2 service: detectOpenCode2 probes `--version` and `run --help`
  // under isolated roots and snapshots service processes.
  if (engine === 'opencode2') {
    return runOpenCode2Init(opts, deps, { inheritedModels, workerShellEnv });
  }
  const explicitProvider = opts.provider ? normalizeProviderFlag(opts.provider) : null;
  // The provider choice applies to the opencode engine only — crush speaks
  // Z.AI GLM exclusively (it bridges ZHIPU_API_KEY -> ZAI_API_KEY). A
  // non-zai --provider with --engine crush is a contradiction, so reject
  // it rather than silently ignoring the flag.
  if (engine === 'crush' && explicitProvider && explicitProvider !== 'zai') {
    throw new Error(
      `The crush engine supports Z.AI GLM only — \`--provider ${opts.provider}\` requires the ` +
        'opencode engine. Drop --engine crush (or use --provider zai).',
    );
  }
  if (
    opts.allowUnverified
    && explicitProvider !== 'opencode-go'
  ) {
    throw new Error(
      '`--allow-unverified` on `triss coder init` requires explicit `--provider opencode-go` ' +
        '(alias: `--provider go`).',
    );
  }
  const provider = engine === 'crush'
    ? 'zai'
    : explicitProvider || await resolveInitProvider(opts, deps);
  let scope = resolveScope(opts);
  if (!scope) scope = await chooseScope('Where to save the coder key and config?');
  if (provider === 'worker') {
    assertWorkerTransportProvenance(workerShellEnv);
  }
  const path = ensureEnvFile(scope);
  const scopedWorker = provider === 'worker'
    ? readWorkerConfigSnapshot({ scope, parentEnv: workerShellEnv })
    : null;
  await setupKey(path, provider, provider === 'worker' ? { existing: scopedWorker?.apiKey } : {});
  if (scope === 'local' && addToGitignore('.triss.env')) {
    process.stderr.write(pc.dim('  · added .triss.env to .gitignore\n'));
  }
  if (engine === 'crush') {
    // crush init's jobs beyond the shared ZHIPU_API_KEY setup: (1) pin the
    // default model atoms (glm5_2 / glm5_turbo) via `crush models use` so
    // --role smart/fast resolve to GLM deterministically; (2) seed the
    // permissions.run policy (restrict + read-only allow_bash) into crush.json
    // as a FORWARD-COMPAT gesture — crush 0.1.3 currently IGNORES this block
    // (docs/engines/crush.md), so it does NOT make crush restricted by
    // itself; the working allowlist is enforced via CLI flags at run time when
    // --restrict is on (see buildCrushRunArgv). The adapter bridges
    // ZHIPU_API_KEY -> ZAI_API_KEY at run time, so NO key is written into
    // crush.json here.
    process.stderr.write('\n' + pc.bold('── coder (crush engine) ──') + '\n');
    const sh = deps.spawnSync || nodeSpawnSync;
    const det = crushEngine.detect(sh);
    if (det.found && det.version) {
      // Version mismatch is NON-FATAL: warn yellow, keep going. The install
      // hint below already carries the pin for an `npm install -g` upgrade.
      if (det.satisfiesPin) {
        process.stderr.write(pc.green(`  ✓ crush ${det.version} (matches pin ${crushEngine.CRUSH_PIN})\n`));
      } else {
        process.stderr.write(
          pc.yellow(
            `  ⚠ crush ${det.version} found, pinned version is ${crushEngine.CRUSH_PIN} ` +
              '(not auto-upgrading — permissions.run still seeds into crush.json)\n',
          ),
        );
      }
    } else {
      process.stderr.write(
        pc.yellow(`  ⚠ crush not found — install: ${crushEngine.installHint()}\n`),
      );
    }
    const hint = crushEngine.crushDefaultModelsHint();
    process.stderr.write(
      pc.dim(`  · default models: ${hint.large} (large) / ${hint.small} (small)\n`),
    );
    // Only attempt the models write when crush is actually present; otherwise
    // the install hint above is the actionable line and `models use` would just
    // fail with ENOENT. Non-fatal: a non-zero exit returns {ok:false} and is
    // surfaced yellow, never thrown (init still exits 0).
    if (det.found) {
      const res = crushEngine.configureCrushModels({ scope, sh });
      process.stderr.write(res.ok ? pc.green(`  ✓ ${res.note}\n`) : pc.yellow(`  ⚠ ${res.note}\n`));
      // Seed permissions.run AFTER `crush models use` has written the models
      // block — read-modify-write so we MERGE, never clobber it. Skipped
      // (warned) when crush.json already has a user-set permissions.run.
      seedCrushPermissions(scope);
    } else {
      // crush binary absent: still seed permissions.run into crush.json if we
      // can, so the policy is in place the moment the user installs crush.
      // (crush.json may not exist yet — seedCrushPermissions creates it.)
      seedCrushPermissions(scope);
    }
  }
  if (engine !== 'crush') {
    // runCoderSetup does the cross-scope opencode.json audit AND the pin-shadow
    // check (shell export needs inheritedModels; .env-file shadow is read from
    // disk), throwing "Coder setup incomplete" on any blocking problem so both
    // this path and the wizard's postSetup path fail the same way.
    const credentialMode = opts.credentialMode ?? readCoderCredentialMode({
      scope,
      parentEnv: deps.credentialModeParentEnv,
    });
    await runCoderSetup(
      {
        scope,
        provider,
        credentialMode,
        inheritedModels,
        allowUnsafeBash: opts.allowUnsafeBash,
        allowUnverified: opts.allowUnverified,
        workerShellEnv,
      },
      deps,
    );
  }
  // The setup isn't runnable if the provider's key never got set (a skipped or
  // empty prompt, or a non-TTY run with nothing in the env) — fail rather than
  // print a green "Done." the very next run contradicts with "<KEY> is not set".
  // Config + templates are already on disk, so re-running after setting the key
  // is a clean, idempotent completion.
  const keyEnv = coderProviderKeyInfo(provider).env;
  const selectedKey = provider === 'worker'
    ? readWorkerConfigSnapshot({ scope, parentEnv: workerShellEnv }).apiKey
    : process.env[keyEnv];
  if (!selectedKey) {
    process.stderr.write(
      pc.yellow(
        `  ⚠ ${keyEnv} is not set — the config was written but runs will fail until you set it.\n`,
      ),
    );
    throw new Error(
      `Coder setup incomplete: ${keyEnv} is not set. Set it (triss config set ${keyEnv}) and re-run \`triss coder init\`.`,
    );
  }
  process.stderr.write(
    '\n' + pc.green('Done.') + ' Run ' + pc.cyan('triss coder init') + pc.dim(' again anytime — it is idempotent.\n'),
  );
}

// Credential/transport provenance invariant: the worker credential and its
// transport must form one consistently trusted profile. Precedence is shell
// > project .triss.env > global .env PER FIELD,
// so a repository can steer the effective transport while the key comes from
// a higher-trust source — and a DECOY key in the project file does not make
// the profile consistent (dotenv override:false can never displace a shell
// export, so shell key + project URL is exactly what the engine would run
// with). The check therefore resolves the EFFECTIVE source of each field —
// using the pre-dotenv shell snapshot — and rejects when the endpoint is
// project-local while the key is not.
function assertWorkerTransportProvenance(workerShellEnv = captureWorkerShellSnapshot()) {
  const files = activeEnvFiles();
  const localFile = files.find((f) => f.scope === 'local');
  const localVars = localFile && localFile.exists ? readEnvFile(localFile.path).vars : {};
  const globalFile = files.find((f) => f.scope === 'global');
  const globalVars = globalFile && globalFile.exists ? readEnvFile(globalFile.path).vars : {};
  const effectiveSource = (key) => {
    if (workerShellEnv[key] != null) return 'shell';
    if (localVars[key] != null) return 'local';
    if (globalVars[key] != null) return 'global';
    return null;
  };
  const urlSource = effectiveSource('TRISS_WORKER_BASE_URL');
  if (urlSource !== 'local') return;
  const keySource = effectiveSource('TRISS_WORKER_API_KEY');
  if (keySource === 'local' || keySource == null) return;
  throw new Error(
    `Worker credential provenance check failed: the effective TRISS_WORKER_BASE_URL comes from the project .triss.env while ` +
      `the effective TRISS_WORKER_API_KEY comes from a higher-trust source (${keySource} — a key in the project ` +
      'file cannot displace it). The worker endpoint the provider audit compares against would be ' +
      'repository-controlled, so the key could be forwarded to an attacker URL. Move the key and the endpoint ' +
      'into the same scope.',
  );
}

// ── OpenCode 2 init ──────────────────────────────────────────────────────────//
// Reuses the shared V1 surface (same env file, same key setup, same
// runCoderSetup flow onto the shared opencode.json) and adds the V2 specifics:
//   1. Static source/plugin/agent preflight via the canonical enumerator —
//      protected mode rejects before any credential write and any V2 spawn
//      (fail closed); best_effort_raw accepts sources after shape checks.
//   2. Triss-owned V2 XDG data/state roots under <project>/.triss/opencode2
//      (0o700) so V2 state never lands on V1 turf.
//   3. Minimum/capability report via detectOpenCode2 (`--version` plus
//      `run --help`, with service-process verification — never a service spawn).
// Static source/plugin/agent preflight shared by `coder init` and `coder run`
// for the opencode2 engine (docs/opencode2-engine-plan.md §"Configuration
// and permission audit"). enumerateOpenCodeSources walks every config layer
// and every plugin/agent source with the DOCUMENTED precedence (no
// XDG_CONFIG_HOME override: the walker is anchored to ~ and cwd). Protected
// mode rejects configured/discovered executable sources before any credential
// write or child process; explicit best_effort_raw mode accepts them after the
// structural/config-shape audit. Errors name the source, never secrets.
function staticOpenCode2Preflight(cwd, credentialMode = 'protected_proxy') {
  if (credentialMode !== 'protected_proxy' && credentialMode !== 'best_effort_raw') {
    throw new TypeError(`OpenCode 2 preflight: unsupported credential mode ${JSON.stringify(credentialMode)}`);
  }
  let sources;
  try {
    sources = enumerateOpenCodeSources({ cwd });
  } catch (err) {
    throw new Error(
      `OpenCode 2 preflight aborted: cannot enumerate configuration sources — ${err.message}`,
      { cause: err },
    );
  }
  const offender = credentialMode === 'best_effort_raw'
    ? null
    : sources.plugins.find((p) => p.origin === 'configured' || p.origin === 'discovered');
  if (offender) {
    throw new Error(
      `OpenCode 2 preflight aborted: unsupported plugin source "${offender.path}" ` +
        `(${offender.origin}${offender.exists === false ? ', target missing' : ''}). ` +
        'No OpenCode 2 plugin is verified compatible yet — remove or disable the plugin reference, ' +
        'then re-run. See docs/engines/opencode2.md "Credential modes and executable surfaces".',
    );
  }
  const agentOffender = credentialMode === 'best_effort_raw'
    ? null
    : sources.agentSources.find(
      (a) => a.origin === 'configured' || a.origin === 'discovered',
    );
  if (agentOffender) {
    throw new Error(
      `OpenCode 2 preflight aborted: unsupported agent source "${agentOffender.path}" ` +
        `(${agentOffender.origin}). No OpenCode 2 subagent is verified to retain ` +
        'the deny-first shell policy — remove or disable the agent source, then re-run. ' +
        'See docs/engines/opencode2.md "Credential modes and executable surfaces".',
    );
  }
  // Executable configuration surfaces: custom tool dirs
  // (.opencode/{tool,tools}/** and the global
  // config root) are top-level executable surfaces imported INSIDE the
  // OpenCode process — with the provider credential in process.env — so the
  // protected mode rejects them like plugins; best_effort_raw admits them
  // after the structural/config-shape audit. MCP blocks are rejected by the
  // document shape check in auditOpenCode2Run.
  const toolOffender = credentialMode === 'best_effort_raw'
    ? null
    : (sources.toolSources || []).find(
      (t) => t.origin === 'configured' || t.origin === 'discovered',
    );
  if (toolOffender) {
    throw new Error(
      `OpenCode 2 preflight aborted: unsupported custom tool source "${toolOffender.path}" ` +
        `(${toolOffender.origin}). Custom tools execute inside the OpenCode process with the ` +
        'provider credential in the environment — none are verified for the beta. Remove the ' +
        'tool directory and re-run. See docs/engines/opencode2.md "Credential modes and executable surfaces".',
    );
  }
  return sources;
}

async function runOpenCode2Init(opts = {}, deps = {}, precaptured = {}) {
  // Scope is part of the acknowledgement boundary. Resolve it before the
  // mode-dependent preflight: a global setup must ignore a project-local raw
  // acknowledgement, while local/effective setup keeps local-over-global
  // precedence. The resolver rereads files and uses the immutable parent
  // snapshot captured by config.js, so long-lived MCP state cannot leak in.
  let scope = precaptured.scope || resolveScope(opts);
  if (!scope) scope = await chooseScope('Where to save the coder key and config?');
  const credentialMode = opts.credentialMode ?? readCoderCredentialMode({
    scope,
    parentEnv: deps.credentialModeParentEnv,
  });
  // The V2 init path owns its complete flow:
  //   1. STATIC PREFLIGHT before any credential write or child process
  //      (plugin + agent gates, shared with the run path).
  //   2. Minimum-version/capability gate TERMINALLY — a missing or
  //      incompatible binary must not
  //      mutate any configuration (beta contract).
  //   3. Credential + scope handling mirroring the V1 runCoderInit head:
  //      --local/--global resolution, .env file creation, setupKey prompt,
  //      .gitignore for local .triss.env. Previously the V2
  //      path jumped straight into runCoderSetup and skipped all of this,
  //      so a missing key only failed at the late gate AFTER config/pins
  //      were written, and --local was silently ignored.)
  //   4. Shared config/model setup WITHOUT the V1-only steps: no V1 binary
  //      check/install (ensureEngine), no agent templates the V2 preflight
  //      itself rejects.
  //   5. Post-setup FULL audit (auditOpenCode2Run + static gate) over the
  //      final filesystem state — not just the plugin/agent scan.
  staticOpenCode2Preflight(deps.cwd || process.cwd(), credentialMode);
  // Invariant: document-CONTENT gates (mcp, command-bearing and
  // unknown top-level keys, dual legacy/native forms, malformed JSONC) used
  // to run only in the POST-setup audit — after setupKey had written the
  // credential to the env file. Run the document audit up front too, so a
  // hostile tree rejects BEFORE any credential write.
  const headDocs = auditOpenCode2Documents({ cwd: deps.cwd || process.cwd(), credentialMode }, { enumerate: deps.enumerateOpenCodeSources });
  // Invariant: the protected-mode permission gate over EXISTING layers must
  // fire HERE — before the credential write. Every existing V1 user's config
  // carries the V1 template allowlist (git status, npm test, …), and the
  // post-setup audit used to discover `live-allow-rule (git status)` only
  // AFTER setupKey had written the key, .gitignore, and the model pins.
  // Best-effort mode explicitly accepts that policy, so its existing config
  // remains byte-identical and the structural/provider gates remain the
  // authority. A protected tree with NO existing layers skips the gate — the
  // shared setup then writes the deny-everything template and the post-setup
  // audit proves it.
  if (headDocs.layerDocs.length > 0) {
    const policy = computeEffectivePermissionPolicy({ layerDocs: headDocs.layerDocs, credentialMode });
    if (policy.unsafe) {
      const detail = policy.detail ? ` (${policy.detail})` : '';
      // Remediation differs by reason: a config with
      // NO wildcard deny needs one ADDED, a live allow rule needs one
      // REMOVED. Saying "remove the allow rules" to the first case sends the
      // operator in the wrong direction.
      const remediation = policy.reason === 'no-wildcard-deny'
        ? 'Add "permission": { "bash": { "*": "deny" } } to opencode.json — without a wildcard ' +
          'deny every command falls back to the built-in allow/ask baseline.'
        : 'Remove the allow rules from opencode.json (V1 runs will lose them too) — the opencode2 ' +
          'beta cannot run while any live allow rule exists, because the credential sits in the ' +
          'child environment.';
      throw new Error(
        'OpenCode 2 init aborted BEFORE any credential or config write: the existing opencode.json ' +
          `effective shell policy is not deny-everything (${policy.reason}${detail}). ${remediation} ` +
          'Alternatively keep using `--engine opencode` until the V2 beta grows real credential ' +
          'isolation. See docs/engines/opencode2.md "Troubleshooting".',
      );
    }
  }
  process.stderr.write('\n' + pc.bold('── coder (opencode2 engine) ──') + '\n');
  const sh = deps.spawnSync || nodeSpawnSync;
  // Minimum-version and capability verification is terminal on mismatch; otherwise the audited
  // configuration semantics may differ from the spawned engine.
  const det = detectOpenCode2(sh);
  if (!det.found || !det.satisfiesPin) {
    throw openCode2CompatibilityError(det, 'setup; no configuration was changed');
  }
  process.stderr.write(pc.green(`  ✓ opencode2 ${det.version} (meets minimum ${opencode2VersionPin()} + capability contract)\n`));
  if (det.capabilities?.warning === 'service-process-snapshot-unavailable') {
    process.stderr.write(pc.yellow(`  ⚠ ${OPENCODE2_SERVICE_SNAPSHOT_WARNING}\n`));
  }
  // (3) Credential + scope — the V1 head flow. The worker-shell snapshot is
  // taken BEFORE loadEnvFiles() (invariant): snapshotting after the dotenv
  // merge made a local .triss.env value indistinguishable from a genuine
  // shell export, so `coder init --engine opencode2 --global --provider worker`
  // run inside a project could silently satisfy the key check from the LOCAL
  // env file and leave the global scope unset.
  // Invariant: when dispatched from runCoderInit the env files are
  // ALREADY loaded (the engine dispatch must see TRISS_CODER_ENGINE from
  // .env), so the pre-dotenv snapshots come in via `precaptured` — the local
  // captures below are the fallback for direct callers only.
  const workerShellEnv = precaptured.workerShellEnv || captureWorkerShellSnapshot();
  // Capture shell-export model pins before loadEnvFiles() so
  // warnIfPinShadowed can see a shadowing export. V2 used to pass nothing,
  // silently disabling the shell-export half of the pin-shadow check.
  const inheritedModels = precaptured.inheritedModels || {
    model: process.env.TRISS_CODER_MODEL,
    smallModel: process.env.TRISS_CODER_SMALL_MODEL,
  };
  // Credential provenance is resolved from the
  // PRE-DOTENV snapshot (a decoy key in the project .triss.env cannot
  // displace a shell export), and only when the worker credential is
  // actually in play — a non-worker init must not fail on an unrelated
  // project-local TRISS_WORKER_BASE_URL.
  loadEnvFiles();
  const provider = opts.provider ? normalizeProviderFlag(opts.provider) : await resolveInitProvider(opts, deps);
  if (provider === 'worker') {
    assertWorkerTransportProvenance(workerShellEnv);
  }
  const envPath = ensureEnvFile(scope);
  const scopedWorker = provider === 'worker'
    ? readWorkerConfigSnapshot({ scope, parentEnv: workerShellEnv })
    : null;
  await setupKey(envPath, provider, provider === 'worker' ? { existing: scopedWorker?.apiKey } : {});
  if (scope === 'local' && addToGitignore('.triss.env')) {
    process.stderr.write(pc.dim('  · added .triss.env to .gitignore\n'));
  }
  // Triss-owned XDG roots under the PROJECT (not $HOME): run time pins
  // XDG_DATA_HOME/XDG_STATE_HOME here so V2 state stays off V1 turf.
  ensureOpenCode2RuntimeDirs(projectRoot());
  // Shared surface — without the V1-only steps. The V1
  // runCoderInit path checks/installs the V1 `opencode` binary and then
  // scaffoldAgentTemplates() writes .opencode/agent files the V2 preflight
  // itself REJECTS, making a fresh V2 init deterministically poison the
  // next V2 run. V2 init therefore reuses only the shared key/config
  // setup (runCoderSetup with engine-aware template skipping) — the same
  // opencode.json / model-pin flow.
  const setup = await runCoderSetup(
    {
      ...opts,
      engine: 'opencode2',
      scope,
      provider,
      credentialMode,
      skipAgentTemplates: true,
      inheritedModels,
      workerShellEnv,
    },
    deps,
  );
  // (5) Post-setup preflight over the resulting tree: the shared setup must
  // not have created any source the V2 gate rejects — and the FULL audit
  // (provider + permission) must pass over the written config. The audit
  // walks the CANONICAL (realpath) directory (invariant), same as the run path.
  const postDir = realpathSync.native(deps.cwd || process.cwd());
  staticOpenCode2Preflight(postDir, credentialMode);
  const pinnedModel = process.env.TRISS_CODER_MODEL || readOpencodeModels(opencodeConfigPath(scope)).model;
  const postWorkerProfile = pinnedModel && pinnedModel.startsWith('triss-worker/')
    ? workerCoderProfile()
    : null;
  auditOpenCode2Run(
    {
      cwd: postDir,
      modelUsed: pinnedModel,
      expectedWorkerBaseURL: postWorkerProfile ? postWorkerProfile.baseUrl : null,
      credentialMode,
    },
    { enumerate: deps.enumerateOpenCodeSources },
  );
  return setup;
}

function warnIfPinShadowed(scope, pinned, inherited) {
  let shadowed = false;
  const warn = (m) => {
    shadowed = true;
    process.stderr.write(pc.yellow(m));
  };
  // 1. Shell export — highest precedence of all, not fixable by writing files.
  if (inherited.model && inherited.model !== pinned.model) {
    warn(
      `  ⚠ TRISS_CODER_MODEL=${inherited.model} is exported in your shell — it overrides the pinned ` +
        `${pinned.model} in EVERY .env file, so the next run will use it (and likely the wrong ` +
        'provider/key). Run `unset TRISS_CODER_MODEL TRISS_CODER_SMALL_MODEL`, or export the pinned value.\n',
    );
  }
  // 2. A higher-precedence .env FILE. activeEnvFiles() is highest-first; stop at
  //    the scope we wrote — anything after it is lower precedence and can't win.
  for (const f of activeEnvFiles()) {
    if (f.scope === scope) break;
    if (!f.exists) continue;
    const v = readEnvFile(f.path).vars.TRISS_CODER_MODEL;
    if (v && v !== pinned.model) {
      warn(
        `  ⚠ ${f.path} (${f.scope} scope) sets TRISS_CODER_MODEL=${v}, which has higher precedence than ` +
          `the ${scope} config just written (pin ${pinned.model}) and will win in the next run. Fix or ` +
          `remove it, or re-run init with --${f.scope}.\n`,
      );
    }
  }
  return shadowed;
}

async function setupKey(path, provider = 'zai', opts = {}) {
  const info = coderProviderKeyInfo(provider);
  const existing = Object.prototype.hasOwnProperty.call(opts, 'existing')
    ? opts.existing
    : process.env[info.env];
  if (existing) {
    process.stderr.write(pc.dim(`  ✓ ${info.env} already set (${maskValue(existing)}) — skipping\n`));
    return;
  }
  process.stderr.write('\n  ' + pc.yellow(info.env) + ' (required)\n');
  process.stderr.write(pc.dim(`  ${info.doc}\n`));
  const key = await prompt('  value', { hidden: true });
  if (!key) {
    process.stderr.write(
      pc.yellow(`  ⚠ skipped — set later via 'triss config set ${info.env}'\n`),
    );
    return;
  }
  setVar(path, info.env, key);
  process.env[info.env] = key;
  process.stderr.write(pc.green('  ✓ saved\n'));
}

// Steps 1 (engine), 2 (Z.AI provider detection), 3 (opencode.json), 4
// (agent templates), 6 (summary). `deps.spawnSync` lets tests inject a
// fake spawnSync instead of touching the real engine / npm.
// `deps.confirmInstall` lets tests stub the install-confirmation prompt
// instead of driving real stdin. `deps.fetch` / `deps.promptChoice` let
// tests stub the provider probe and the interactive model pick.
export async function runCoderSetup(input = {}, deps = {}) {
  loadEnvFiles();
  const resolvedScope = input.scope || 'global';
  const resolvedProvider = input.provider || (input.engine === 'crush' ? 'zai' : inferCoderProvider());
  // `config wizard coder` enters through this public boundary after writing
  // the selected credential to an env file. Resolve the OpenCode credential
  // mode from a fresh scope-aware snapshot so edits in a long-lived process
  // and the selected init scope are both honored.
  // Explicit caller intent (notably runOpenCode2Init) remains authoritative.
  const resolvedCredentialMode = input.credentialMode ?? (
    input.engine === 'crush'
      ? 'protected_proxy'
      : readCoderCredentialMode({
          scope: resolvedScope,
          parentEnv: deps.credentialModeParentEnv,
        })
  );
  if (input.engine === 'crush') {
    return runCoderSetupUnlocked({
      ...input,
      scope: resolvedScope,
      provider: resolvedProvider,
      credentialMode: resolvedCredentialMode,
    }, deps);
  }
  // Both OpenCode engines share the opencode-v1 configuration backend: the
  // lock key below (config backend 'opencode') and the config surface are
  // identical for engine 'opencode' and 'opencode2', so the wizard's
  // postSetup path with engine 'opencode2' flows into this same locked setup.

  const lockHandle = typeof deps.lock === 'function'
    ? deps.lock('opencode', resolvedScope)
    : acquireCoderMutationLock('opencode', resolvedScope, { isPidAlive: deps.isLockPidAlive });
  try {
    return await runCoderSetupUnlocked(
      {
        ...input,
        scope: resolvedScope,
        provider: resolvedProvider,
        credentialMode: resolvedCredentialMode,
      },
      deps,
    );
  } finally {
    if (lockHandle && typeof lockHandle.release === 'function') lockHandle.release();
  }
}

async function runCoderSetupUnlocked(
  {
    scope,
    provider,
    engine,
    credentialMode = 'protected_proxy',
    inheritedModels,
    allowUnsafeBash,
    allowUnverified,
    workerShellEnv,
    skipAgentTemplates,
  } = {},
  deps = {},
) {
  // `triss coder init` calls loadEnvFiles() itself before setupKey() runs,
  // so the provider key is already in process.env by the time this function
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
  // The wizard resolves engine FIRST, provider SECOND (resolveWizardCtx) and
  // passes both in. crush fixes provider to Z.AI and rejects conflicts before
  // this point; reaching here with engine=crush means Z.AI was agreed, so the
  // crush path only needs the Z.AI credential gate (the full crush model +
  // permissions setup lives in `triss coder init --engine crush`, which owns
  // crush.json). opencode.json / agent templates do not apply to crush.
  if (engine === 'crush') {
    process.stderr.write('\n' + pc.bold('── coder (crush engine · Z.AI GLM) ──') + '\n');
    process.stderr.write(
      pc.dim('  · crush speaks Z.AI GLM only (it bridges ZHIPU_API_KEY -> ZAI_API_KEY at run time)\n'),
    );
    const keyEnv = 'ZHIPU_API_KEY';
    if (!process.env[keyEnv]) {
      process.stderr.write(
        pc.yellow(
          `  ⚠ ${keyEnv} is not set — the config was written but runs will fail until you set it.\n`,
        ),
      );
      throw new Error(
        `Coder setup incomplete: ${keyEnv} is not set. Set it (triss config set ${keyEnv}) and re-run.`,
      );
    }
    // The wizard configures the Z.AI credential but does NOT seed crush models
    // (crush models use) or the permissions.run policy — those steps live in
    // `triss coder init --engine crush`. Report a structured incomplete result
    // and the EXACT next command instead of returning {} (which let the wizard
    // print a generic green "Done." over an unconfigured engine).
    // The recovery command MUST include the selected scope flag (--local or --global)
    // for exact reproducibility.
    const scopeFlag = scope === 'local' ? '--local' : '--global';
    throw new Error(
      'Coder (crush engine) setup incomplete: the wizard saved the Z.AI credential but did not ' +
        'seed crush models or the permissions.run policy. Complete setup with the exact command:\n' +
        `  triss coder init --engine crush ${scopeFlag}`,
    );
  }
  // The wizard postSetup path passes no provider — infer it from the
  // configured model/credential (no prompt) so a preset zen model is honored.
  const resolvedProvider = provider || inferCoderProvider();
  const sh = deps.spawnSync || nodeSpawnSync;
  const noun =
    {
      worker: 'Triss worker',
      'opencode-zen': 'OpenCode Zen',
      'opencode-go': 'OpenCode Go',
      moonshot: 'Moonshot Kimi',
      'kimi-for-coding': 'Kimi for Coding',
    }[resolvedProvider] || 'Z.AI GLM';
  process.stderr.write('\n' + pc.bold(`── coder (opencode engine · ${noun}) ──`) + '\n');
  // Privacy: the coder agent reads your repository and sends it to the model.
  // OpenCode Zen's FREE models come with data-usage terms (some log or train on
  // submitted content), so warn BEFORE anything is picked or written.
  if (resolvedProvider === 'opencode-zen') {
    process.stderr.write(
      pc.yellow(
        '  ⚠ OpenCode Zen free models may LOG or TRAIN ON submitted content — the coder agent sends\n' +
          '    your repository to the model, so avoid them for confidential/proprietary code. Review\n' +
          '    the current terms first: https://opencode.ai/docs/zen/\n',
      ),
    );
  }
  // Engine separation: the V1 binary check/install applies to the V1 engine only.
  // runOpenCode2Init already verified the opencode2 minimum/capability contract
  // terminally, so
  // requiring `opencode` here would force a V1 install on machines that only
  // run the V2 beta (engine is undefined on the legacy V1 init/wizard paths —
  // those keep the check).
  if (engine !== 'opencode2') {
    await ensureEngine(sh, deps.confirmInstall);
  }
  // Z.AI plan detection only applies to the zai kind: Zen models resolve via
  // opencode's built-in `opencode` provider, and the two Kimi kinds already
  // name their endpoint through the credential env — nothing to probe.
  const detectedZai =
    resolvedProvider === 'zai'
      ? await detectAndReportZaiProvider(deps.fetch || globalThis.fetch)
      : null;
  const providerInfo = {
    kind: resolvedProvider,
    detectedZai,
    ...(resolvedProvider === 'worker'
      ? {
          workerProfile: workerCoderProfile(
            readWorkerConfigSnapshot({ scope: resolvedScope, parentEnv: workerShellEnv }),
          ),
        }
      : {}),
  };
  // Resolve the model ONCE, up front, honoring only presets/config that belong
  // to the chosen provider — then write opencode.json (if absent) and pin
  // TRISS_CODER_MODEL from the SAME resolved value. This has to happen even when
  // opencode.json already exists: the run path reads the model from
  // TRISS_CODER_MODEL, never from opencode.json, so skipping the pin would leave
  // a bare run falling back to the GLM default (and demanding ZHIPU_API_KEY)
  // right after a successful Zen setup.
  const existing = readOpencodeModels(opencodeConfigPath(resolvedScope));
  const { model, smallModel, zenAvailable, providerAvailable } = await resolveInitModels(
    providerInfo,
    deps,
    existing,
    {
      allowUnverified,
      allowUnaudited: credentialMode === 'best_effort_raw',
      scope: resolvedScope,
    },
  );
  const projectCfg = opencodeConfigPath('local');
  let projectWorkerAudit = null;
  if (
    resolvedProvider === 'worker' &&
    resolvedScope === 'global' &&
    existsSync(projectCfg) &&
    projectCfg !== opencodeConfigPath('global')
  ) {
    projectWorkerAudit = auditExistingConfig(projectCfg, providerInfo, {
      note: '(project scope — higher precedence than the global config, so it governs runs)',
      credentialMode,
      allowUnsafeBash,
      expectedWorkerProvider: workerProviderDefinition(providerInfo, model, smallModel),
      workerModels: new Set(providerInfo.workerProfile.models.map((id) => `triss-worker/${id}`)),
    });
    if (projectWorkerAudit.blocking) {
      throw new Error(
        'Coder setup incomplete: fix the existing opencode.json issues reported above, then re-run `triss coder init`.',
      );
    }
  }
  const writeResult = writeOpencodeConfig(resolvedScope, providerInfo, model, smallModel, {
    credentialMode,
    allowUnsafeBash,
    providerAvailable,
    engine,
  });
  let blocking = writeResult.blocking;
  // Invariant: a FRESH V2-init write puts deny-everything bash into
  // the SHARED opencode.json — the default engine is still opencode (V1), so
  // plain `triss coder run` silently loses git status / git diff / npm test.
  // Warn loudly instead; re-running plain `triss coder init` restores the
  // V1 allowlist (and makes the tree V2-incompatible again — that tension is
  // documented in docs/engines/opencode2.md).
  if (engine === 'opencode2' && credentialMode === 'protected_proxy' && writeResult.created) {
    const v1Degradation = pc.yellow(
      '  ⚠ opencode2 init wrote a deny-everything bash policy into the SHARED opencode.json — plain ' +
        '`triss coder run` (engine opencode, the default) has LOST git status / git diff / npm test. ' +
        'Export TRISS_CODER_ENGINE=opencode2 for V2 runs, or re-run `triss coder init` (V1) to restore ' +
        'the allowlist — which makes this tree opencode2-incompatible again.\n',
    );
    process.stderr.write(v1Degradation);
    if (Array.isArray(deps.outputs)) deps.outputs.push(v1Degradation);
  }
  // Stale-Zen incident report (own scope). When the opencode.json being audited
  // is pinned to a Zen model the AUTHENTICATED live catalogue no longer offers,
  // name the stale id(s) + the current replacement(s) triss just resolved, and
  // print the EXACT recovery command — instead of silently selecting a fallback
  // or printing only "fix the issues above". No-clobber is preserved: nothing is
  // mutated here, the user runs the printed command to recover. `outputs` (an
  // injected dep array, when present) gets a copy so a headless wizard caller
  // can read the recovery lines without scraping stderr.
  emitZenStaleIncident(opencodeConfigPath(resolvedScope), existing, { model, smallModel }, zenAvailable, resolvedScope, deps);
  // Cross-scope audit: opencode resolves config from the run's cwd upward, so a
  // project ./opencode.json overrides the global one. Writing --global while a
  // project file exists means THAT file (its small_model / bash policy) governs
  // runs — audit it too, or init reports clean while runs misbehave. Its
  // small_model belongs to a DIFFERENT scope, so we check catalogue presence +
  // provider/plan compat (zenAvailable), NOT exact equality with the global
  // resolvedSmall — a valid in-catalogue project small_model that merely differs
  // from the global default is fine.
  if (resolvedScope === 'global') {
    if (existsSync(projectCfg) && projectCfg !== opencodeConfigPath('global')) {
      // The stale-Zen incident most often lives in this higher-precedence
      // project file (a previous init pinned opencode/hy3-free here before the
      // promo model was retired). Report it with the same recovery commands.
      emitZenStaleIncident(projectCfg, readOpencodeModels(projectCfg), { model, smallModel }, zenAvailable, 'local', deps);
      const otherAudit = projectWorkerAudit || auditExistingConfig(projectCfg, providerInfo, {
          note: '(project scope — higher precedence than the global config, so it governs runs)',
          credentialMode,
          allowUnsafeBash,
          zenAvailable,
          providerAvailable,
        });
      blocking = blocking || otherAudit.blocking;
    }
  }
  if (blocking) {
    // The stale-Zen incident report above (emitZenStaleIncident) already
    // printed the stale id(s), the current replacement(s), and the EXACT
    // recovery commands when applicable — so a blocking audit on a stale Zen
    // pin surfaces a focused, actionable recovery rather than only this line.
    // The generic message is retained verbatim because existing contracts
    // (coder-init compatibility contract) match on "existing opencode.json issues".
    throw new Error(
      'Coder setup incomplete: fix the existing opencode.json issues reported above, then re-run `triss coder init`.',
    );
  }
  persistCoderModels(resolvedScope, model, smallModel);
  // V2 init does not scaffold V1 agent templates: the protected-mode static
  // preflight rejects those sources, and keeping init mode-neutral avoids
  // creating an executable surface just for one mode. skipAgentTemplates is
  // set by runOpenCode2Init; V1 init keeps its templates.
  if (engine !== 'opencode2' && !skipAgentTemplates) {
    scaffoldAgentTemplates(resolvedScope);
  }
  // Missing-key gate runs HERE (not only in runCoderInit) so the wizard's
  // postSetup path — `config wizard coder` calls runCoderSetup directly, never
  // runCoderInit — is gated too: without the provider's key the setup isn't
  // runnable, so fail rather than print a green "Done." the next run
  // contradicts with "<KEY> is not set". Config + templates are already on
  // disk, so re-running after setting the key is a clean idempotent completion.
  const keyEnv = coderProviderKeyInfo(resolvedProvider).env;
  const selectedKey = resolvedProvider === 'worker'
    ? readWorkerConfigSnapshot({ scope: resolvedScope, parentEnv: workerShellEnv }).apiKey
    : process.env[keyEnv];
  if (!selectedKey) {
    process.stderr.write(
      pc.yellow(
        `  ⚠ ${keyEnv} is not set — the config was written but runs will fail until you set it.\n`,
      ),
    );
    throw new Error(
      `Coder setup incomplete: ${keyEnv} is not set. Set it (triss config set ${keyEnv}) and re-run.`,
    );
  }
  // Pin-shadow check runs HERE (not only in runCoderInit) so the wizard's
  // postSetup path is covered too. A shell export needs inheritedModels (only
  // runCoderInit captures it pre-loadEnvFiles); the .env-file shadow is detected
  // from disk regardless, so the wizard at least sees that.
  if (warnIfPinShadowed(resolvedScope, { model, smallModel }, inheritedModels || {})) {
    process.stderr.write(
      '\n' +
        pc.yellow('⚠ Setup incomplete: ') +
        'the override flagged above wins over what was just written, so runs will NOT use this ' +
        'config until you remove or fix it. Then re-run ' +
        pc.cyan('triss coder init') +
        '.\n',
    );
    throw new Error(
      'Coder setup incomplete: remove or fix the higher-precedence model override reported above, then re-run `triss coder init`.',
    );
  }
  return { model, smallModel };
}

// Pin TRISS_CODER_MODEL / TRISS_CODER_SMALL_MODEL into the .env of `scope` (and
// process.env, so an in-process run like the MCP server sees it immediately) so
// the model chosen at init drives every later run — the run path resolves the
// model from TRISS_CODER_MODEL, not from opencode.json. The values passed in are
// already provider-correct (resolveInitModels rejected any cross-provider
// preset), so we write them authoritatively rather than preserving a stale env
// value that would send a Zen run to the GLM default.
function persistCoderModels(scope, model, smallModel) {
  const path = ensureEnvFile(scope);
  setVar(path, 'TRISS_CODER_MODEL', model);
  process.env.TRISS_CODER_MODEL = model;
  setVar(path, 'TRISS_CODER_SMALL_MODEL', smallModel);
  process.env.TRISS_CODER_SMALL_MODEL = smallModel;
  process.stderr.write(
    pc.dim(`  · pinned TRISS_CODER_MODEL=${model} (small_model=${smallModel}) so runs use it\n`),
  );
}

function detectOpencodeVersion(sh) {
  // Even a version probe is a child process. Never let it inherit provider
  // credentials or arbitrary caller env before one-shot config auditing.
  const r = sh('opencode', ['--version'], { env: buildEngineEnv(null, null, null) });
  if (!r || r.error || r.status !== 0) return null; // binary missing or errored
  // Status 0 means opencode actually ran, so it is INSTALLED — return the
  // trimmed version string (possibly '' when the build prints nothing or a
  // minimal spawnSync fake returns empty stdout). Callers that only care about
  // presence check `!== null`; callers that need a real version see '' (falsy)
  // for the unknown case. Conflating empty-stdout with "not installed" made the
  // wizard's stale-Zen incident unreachable when the engine probe was a
  // minimal fake, pre-empting the catalogue fetch + recovery report.
  return String(r.stdout || '').trim();
}

async function ensureEngine(sh, confirmInstall) {
  const pin = opencodeVersionPin();
  const version = detectOpencodeVersion(sh);
  if (version !== null) {
    if (version && version === pin) {
      process.stderr.write(pc.green(`  ✓ opencode ${version} (matches pin)\n`));
    } else if (version) {
      process.stderr.write(
        pc.yellow(`  ⚠ opencode ${version} found, pinned version is ${pin} (not auto-upgrading)\n`),
      );
    } else {
      process.stderr.write(
        pc.yellow(`  ⚠ opencode found (version unknown), pinned version is ${pin} (not auto-upgrading)\n`),
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

// Verified Crush paths: `crush models use ...
// --global` writes ~/.local/share/crush/crush.json; `--local` writes
// ./.crush/crush.json. Used only for presence checks in `triss status` — we
// never parse or write it from here (crush owns the shape).
function crushConfigPath(scope) {
  return scope === 'local'
    ? join(projectRoot(), '.crush', 'crush.json')
    : join(homedir(), '.local', 'share', 'crush', 'crush.json');
}

// seedCrushPermissions: read-modify-write crush.json to MERGE in the
// permissions.run policy (restrict:true + the read-only allow_bash that
// mirrors opencode's bash allowlist). There is NO `crush config` CLI, so we
// touch the JSON that `crush models use` already wrote — and we MERGE, never
// clobbering the `models` block or a user-set `permissions.run`.
//
// Forward-compatibility caveat (see docs/engines/crush.md):
// crush 0.1.3 IGNORES this `permissions.run` config block — `crush run
// --restrict-run` does not honor it. We keep seeding it because it is harmless
// and correct once the maintainer honors config (then it becomes the editable
// persistent policy, like opencode.json). But TODAY the working allowlist is
// enforced via CLI flags at run time (see buildCrushRunArgv in
// src/coder-engines/crush.js), NOT via this block. The user-facing "seeded"
// message below says so explicitly.
//
// No-clobber rules (parity with opencode's "don't overwrite an existing
// opencode.json"):
//  - crush.json missing or has no permissions.run -> seed it (green).
//  - crush.json already has a permissions.run -> leave it untouched. Warn dim
//    when it lacks restrict:true so the user knows their runs will be
//    unrestricted under --restrict; stay quiet + dim-confirm when they DO have
//    restrict:true.
//  - crush.json unparseable -> warn yellow and skip (don't risk clobbering a
//    hand-maintained file we can't read).
//  - crush.json valid JSON but NOT a plain object (e.g. `[]`, `"x"`, `null`)
//    -> warn yellow and skip too. Silently re-seeding over a non-object would
//    destroy whatever the user kept there.
//
// Uses atomicWriteJson (write-then-rename) so a reader never sees a torn file.
function seedCrushPermissions(scope) {
  const path = crushConfigPath(scope);
  let config = {};
  if (existsSync(path)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      process.stderr.write(
        pc.yellow(`  ⚠ ${path} is not valid JSON — not seeding permissions.run (edit it manually)\n`),
      );
      return;
    }
    // Valid JSON but not a plain object (array / string / number / null):
    // route into the SAME warn-and-skip branch as a parse error. Do NOT
    // silently overwrite a non-object crush.json.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      process.stderr.write(
        pc.yellow(
          `  ⚠ ${path} is valid JSON but not a JSON object — not seeding permissions.run (edit it manually)\n`,
        ),
      );
      return;
    }
    config = parsed;
  }
  const existingRun =
    config.permissions && typeof config.permissions === 'object' ? config.permissions.run : undefined;
  if (existingRun && typeof existingRun === 'object') {
    // No-clobber: respect the user's existing permissions.run verbatim.
    if (existingRun.restrict === true) {
      process.stderr.write(
        pc.dim(`  · ${path} already has a permissions.run (restrict:true) — not overwriting\n`),
      );
    } else {
      process.stderr.write(
        pc.dim(
          `  · ${path} has a permissions.run without restrict:true — crush runs will be ` +
            'unrestricted under --restrict; set permissions.run.restrict true to enable the allow_bash policy\n',
        ),
      );
    }
    return;
  }
  const { merged } = crushEngine.mergeCrushPermissionsRun(config);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteJson(path, merged);
  process.stderr.write(
    pc.green(
      `  ✓ seeded permissions.run into ${path} ` +
        '(forward-compat: currently inert — crush 0.1.3 ignores this block; the working allowlist is enforced via CLI --allow-bash/--allow-tool flags at run time when --restrict is on)\n',
    ),
  );
}

// crush's restrict policy default. INTERIM (live-verified 2026-07-06,
// docs/engines/crush.md): crush 0.1.3 IGNORES the permissions.run
// config block, and a denied bash command deadlocks to the timeout instead of
// denying cleanly. A coding agent routinely runs bash outside a read-only
// allowlist (`npm run build`, `tsc`, ...), so restrict-ON-by-default would make
// crush runs routinely dead-end at the timeout. restrict therefore defaults
// OFF; the disposable worktree (crush isolate-ON) is the dependable safety
// layer. restrict is still OPT-IN and, when turned on, buildCrushRunArgv emits
// the allowlist as CLI flags (the only enforcement path that works today).
// Once the maintainer fixes the deadlock + honors config, revisit flipping this
// back ON for true opencode parity.
const CRUSH_RESTRICT_DEFAULT = false;

// Read permissions.run.restrict out of crush.json (local first, then global —
// matching crush's own local-over-global precedence). Returns true/false when
// the user hand-set it, or undefined when neither file sets it (caller falls
// back to the built-in default). Never throws: missing/malformed files are
// skipped. Used by resolveCrushRestrict at run time.
function readCrushConfigRestrict() {
  for (const scope of ['local', 'global']) {
    const path = crushConfigPath(scope);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      const restrict = parsed?.permissions?.run?.restrict;
      if (restrict === true || restrict === false) return restrict;
    } catch {
      // malformed crush.json — skip to the next scope, don't abort the run.
    }
  }
  return undefined;
}

// Resolve the Crush restrict tristate to a concrete boolean. Order is part of
// the public configuration contract:
//   1. CLI flag --restrict (true) / --no-restrict (false) — opts.restrict.
//      Both options are declared WITHOUT a Commander default in bin/triss.js,
//      so opts.restrict is undefined when neither is passed (the tristate is
//      load-bearing — do NOT add a default there).
//   2. TRISS_CODER_CRUSH_RESTRICT env (1/true/yes/on => true; 0/false/no/off
//      => false; any other value ignored so garbage can't silently flip safety).
//   3. crush.json permissions.run.restrict (if the user hand-set it).
//   4. Built-in default: OFF (interim — see CRUSH_RESTRICT_DEFAULT above).
// Exported so the resolution order is unit-testable without driving a run.
export function resolveCrushRestrict(opts = {}) {
  if (opts.restrict === true || opts.restrict === false) return opts.restrict;
  const env = process.env.TRISS_CODER_CRUSH_RESTRICT;
  if (env !== undefined) {
    const v = String(env).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
  }
  const fromConfig = readCrushConfigRestrict();
  if (fromConfig !== undefined) return fromConfig;
  return CRUSH_RESTRICT_DEFAULT;
}

// ─── credential proxy endpoint resolution ──────────────────────────────────
//
// The production run path must start the parent-owned loopback credential
// proxy BEFORE spawning either engine and hand the child only the one-run
// token + loopback base URL (never the raw credential). These helpers map
// the resolved credential env key to the canonical upstream ORIGIN (no API
// path — the engine sends the prefix verbatim, so a path here would double
// it), the OpenAI-compatible path prefix the proxy pins, and the upstream
// auth style. `engineRedirect` names whether the spawned engine can be
// verifiably pinned to the proxy; 'none' means the engine would present the
// one-run token to the REAL upstream (guaranteed auth failure), so the run
// fails closed before spawn instead.
export function coderCredentialEndpoint(credEnv, modelUsed) {
  switch (credEnv) {
    case 'ZHIPU_API_KEY': {
      // Coding-plan models go to the coding endpoint; everything else to PAYG.
      // Both are OpenAI-compatible under their /api/.../v4 scope; the origin
      // carries NO path (the prefix travels with the request).
      const coding = /^(zai-coding-plan|glm-coding)\//.test(String(modelUsed || ''));
      return coding
        ? { endpoint: 'https://api.z.ai', pathPrefix: '/api/coding/paas/v4' }
        : { endpoint: 'https://api.z.ai', pathPrefix: '/api/paas/v4' };
    }
    case 'OPENCODE_API_KEY':
      // Zen/Go models are served by opencode's own OpenAI-compatible router.
      return {
        endpoint: 'https://opencode.ai',
        pathPrefix: '/zen/v1',
        engineRedirectEnv: 'OPENCODE_BASE_URL',
      };
    case 'MOONSHOT_API_KEY':
      // PAYG Moonshot is OpenAI-compatible Bearer auth. The opencode built-in
      // moonshot provider exposes no documented base-URL env override, so the
      // engine cannot be pinned to the proxy — the run must fail closed.
      return { endpoint: 'https://api.moonshot.ai', pathPrefix: '/v1', engineRedirect: 'none' };
    case 'KIMI_API_KEY':
      // Kimi for Coding is a SEPARATE service from PAYG Moonshot: it lives on
      // api.kimi.com under /coding/v1 and speaks the ANTHROPIC protocol
      // (x-api-key + anthropic-version; see src/moonshot.js). Routing it to
      // the PAYG OpenAI endpoint with Bearer auth can never authenticate.
      return {
        endpoint: 'https://api.kimi.com',
        pathPrefix: '/coding/v1',
        authStyle: 'anthropic',
        engineRedirect: 'none',
      };
    case 'TRISS_WORKER_API_KEY': {
      // The worker profile pins its own base URL (default DeepSeek). A test
      // or partial environment without TRISS_WORKER_BASE_URL falls back to
      // the same default the worker client itself uses. The URL is split
      // into origin + prefix so forwarding can never double the path.
      const settings = readWorkerConfigSnapshot({ scope: 'effective' });
      const baseUrl = settings.baseUrl || 'https://api.deepseek.com/v1';
      if (!/^https:\/\//.test(String(baseUrl))) return null;
      const parsed = new URL(baseUrl);
      const prefix = parsed.pathname.replace(/\/+$/, '') || '/';
      return {
        endpoint: parsed.origin,
        pathPrefix: prefix,
      };
    }
    default:
      return null;
  }
}

// Resolve the canonical route once for a run.  The worker is the only route
// whose endpoint is operator-configurable; its snapshot has already been
// validated by workerCoderProfile, so split that URL into the exact upstream
// origin and path sent to the parent-owned proxy.
function resolveRuntimeCoderProviderRoute(model, workerSettings, { requireAudited = true } = {}) {
  const route = resolveCoderRuntimeProviderRoute(model);
  if (!route) {
    throw new Error(
      `No protected OpenCode transport route is registered for model "${model}"; ` +
        'no provider route fixture is available.',
    );
  }
  if (requireAudited && ['opencode-zen', 'opencode-go'].includes(route.provider) && !route.transportAudited) {
    const detail = route.unsupportedTransport || 'the model has no audited protocol/package metadata';
    throw new Error(
      `No audited protected OpenCode transport metadata is registered for model "${model}"; ${detail}. ` +
        'Protected mode refuses to guess Chat Completions. Retry in explicit best_effort_raw mode to use the built-in OpenCode provider, after auditing persistent provider overrides.',
    );
  }
  if (route.provider !== 'worker') return route;
  const profile = workerCoderProfile(workerSettings);
  const parsed = new URL(profile.baseUrl);
  return Object.freeze({
    ...route,
    endpoint: parsed.origin,
    pathPrefix: parsed.pathname.replace(/\/+$/, '') || '/',
  });
}

function transientModelName(route) {
  return `${CODER_TRANSIENT_PROVIDER_ALIAS}/${route.modelId}`;
}

// Public, non-secret routing identity for OpenCode envelopes.  Keep the
// requested model/provider separate from what the child actually receives:
// protected and acknowledged best-effort runs use the generated transient
// provider alias, while any direct path reports the real model/provider.
function buildOpenCodeEnvelopeRouting({ modelUsed, credential, route, canonical }) {
  const requestedProvider = route?.provider || credential?.provider || 'zai';
  const usesTransient = Boolean(canonical && route);
  return {
    requested_model: modelUsed,
    requested_provider: requestedProvider,
    engine_model: usesTransient ? transientModelName(route) : modelUsed,
    engine_provider: usesTransient ? CODER_TRANSIENT_PROVIDER_ALIAS : requestedProvider,
  };
}

// A persistent config must not be able to define the generated provider id.
// Read every JSON layer OpenCode can load and reject collisions before the
// proxy starts. JSONC is handled by the V2 canonical preflight; V1 cannot
// safely prove its shape here and therefore fails closed as well.
function auditTransientProviderAlias(cwd, configRoot, aliases = CODER_TRANSIENT_PROVIDER_ALIAS) {
  const reservedAliases = new Set(Array.isArray(aliases) ? aliases : [aliases]);
  for (const configPath of opencodeConfigAuditPaths(cwd, { projectRoot: configRoot })) {
    if (!existsSync(configPath)) continue;
    let config;
    try {
      config = parseOpenCodeDocument(readFileSync(configPath, 'utf8'), { path: configPath });
    } catch (err) {
      throw new Error(
        `Cannot parse ${configPath} before forwarding a provider credential: ${err.message}`,
        { cause: err },
      );
    }
    for (const key of ['provider', 'providers']) {
      const providers = config?.[key];
      if (providers && typeof providers === 'object' && !Array.isArray(providers) &&
          [...reservedAliases].some((alias) => Object.prototype.hasOwnProperty.call(providers, alias))) {
        const alias = [...reservedAliases].find((candidate) => Object.prototype.hasOwnProperty.call(providers, candidate));
        throw new Error(
          `${configPath} defines reserved transient provider "${alias}". ` +
            'Remove the persistent collision and retry; Triss will supply this provider only for the current run.',
        );
      }
    }
  }
}

function auditProtectedRouteConfiguration({ model, route, smallModel, smallRoute, cwd, configRoot, workerSettings }) {
  auditTransientProviderAlias(cwd, configRoot, [
    CODER_TRANSIENT_PROVIDER_ALIAS,
    ...(smallRoute && !coderRoutesShareTransport(smallRoute, route)
      ? [`${CODER_TRANSIENT_PROVIDER_ALIAS}-small`]
      : []),
  ]);
  const allowedProvider = route.provider === 'worker'
    ? workerProviderDefinition(
      { kind: 'worker', workerProfile: workerCoderProfile(workerSettings) },
      model,
      smallModel,
    )
    : undefined;
  auditOneShotProviderConfiguration(model, {
    cwd,
    projectRoot: configRoot,
    allowedProvider,
    requireAllowedProvider: false,
    allowManagedWorkerProvider: route.provider === 'worker',
  });
}

function auditBuiltInOpenCodeRouteConfiguration({ model, smallModel, cwd, configRoot }) {
  // Raw mode may use OpenCode's own provider metadata, but persistent config
  // must not redefine either actually-used provider and redirect the selected
  // raw key. V1 can use both roles; audit both even for persisted (non-one-shot)
  // configuration.
  for (const selectedModel of [...new Set([model, smallModel].filter(Boolean))]) {
    auditOneShotProviderConfiguration(selectedModel, {
      cwd,
      projectRoot: configRoot,
      requireAllowedProvider: false,
    });
  }
}

// Credential exposure boundary: the V1 template's bash allowlist
// (git status / ls / npm test …) is UNSAFE for the opencode2 beta when the
// credential must stay protected — an allowed command can disclose it
// (env expansion in an error message, `npm test` running untrusted JS with
// the key in process.env). Protected V2 init writes deny-everything and the
// protected run preflight rejects any live allow/ask rule. Explicit raw
// best-effort mode intentionally keeps the normal V1 template and accepts
// that exposure; V1 keeps its template unchanged.
function opencodeConfigTemplate(
  model,
  smallModel,
  providerInfo,
  { engine, credentialMode = 'protected_proxy' } = {},
) {
  const bashPolicy = engine === 'opencode2' && credentialMode !== 'best_effort_raw'
    ? { '*': 'deny' }
    : {
      '*': 'deny',
      'git status': 'allow',
      'git diff*': 'allow',
      'git log*': 'allow',
      'ls*': 'allow',
      'node --test*': 'allow',
      'npm test*': 'allow',
      'npm run test*': 'allow',
    };
  const config = {
    $schema: 'https://opencode.ai/config.json',
    model,
    small_model: smallModel,
    permission: {
      bash: bashPolicy,
      webfetch: 'deny',
      websearch: 'deny',
    },
  };
  if (providerInfo?.kind === 'worker') {
    config.provider = {
      'triss-worker': workerProviderDefinition(providerInfo, model, smallModel),
    };
  }
  return config;
}

function workerProviderDefinition(providerInfo, model, smallModel) {
  const profile = providerInfo.workerProfile || workerCoderProfile();
  const modelIds = [...new Set([
    ...profile.models,
    providerModelId(model),
    providerModelId(smallModel),
  ].filter(Boolean))];
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'Triss worker (OpenAI-compatible)',
    options: {
      baseURL: profile.baseUrl,
      apiKey: '{env:TRISS_WORKER_API_KEY}',
    },
    models: Object.fromEntries(modelIds.map((id) => [id, { name: id }])),
  };
}

function isManagedWorkerProvider(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (!isDeepStrictEqual(Object.keys(value).sort(), ['models', 'name', 'npm', 'options'])) return false;
  if (value.npm !== '@ai-sdk/openai-compatible') return false;
  if (value.name !== 'Triss worker (OpenAI-compatible)') return false;
  if (!value.options || typeof value.options !== 'object' || Array.isArray(value.options)) return false;
  if (!isDeepStrictEqual(Object.keys(value.options).sort(), ['apiKey', 'baseURL'])) return false;
  if (value.options.apiKey !== '{env:TRISS_WORKER_API_KEY}') return false;
  if (typeof value.options.baseURL !== 'string') return false;
  if (!value.models || typeof value.models !== 'object' || Array.isArray(value.models)) return false;
  return Object.entries(value.models).every(([id, model]) => (
    model &&
    typeof model === 'object' &&
    !Array.isArray(model) &&
    isDeepStrictEqual(Object.keys(model), ['name']) &&
    model.name === id
  ));
}

function opencodeConfigAuditPaths(cwd, { projectRoot: configRoot } = {}) {
  const globalDir = dirname(opencodeConfigPath('global'));
  const paths = [
    join(globalDir, 'config.json'),
    join(globalDir, 'opencode.json'),
    join(globalDir, 'opencode.jsonc'),
    join(homedir(), '.opencode', 'opencode.json'),
    join(homedir(), '.opencode', 'opencode.jsonc'),
  ];
  let current = resolvePath(cwd || projectRoot());
  const boundary = resolvePath(configRoot || current);
  while (true) {
    paths.push(
      join(current, 'opencode.json'),
      join(current, 'opencode.jsonc'),
      join(current, '.opencode', 'opencode.json'),
      join(current, '.opencode', 'opencode.jsonc'),
    );
    if (current === boundary) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...new Set(paths)];
}

function opencodeProjectBoundary(cwd) {
  const runtimeDir = resolvePath(cwd);
  let current = runtimeDir;
  while (true) {
    try {
      lstatSync(join(current, '.git'));
      return current;
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') {
        throw new Error(
          `Cannot determine the OpenCode project boundary from ${runtimeDir}: ${err.message}`,
          { cause: err },
        );
      }
    }
    const parent = dirname(current);
    // OpenCode treats the filesystem root as the project boundary when no
    // VCS marker exists, so parent configs remain loadable in non-git trees.
    if (parent === current) return current;
    current = parent;
  }
}

function auditOneShotProviderConfiguration(model, {
  cwd,
  projectRoot: configRoot,
  allowedProvider,
  requireAllowedProvider = true,
  allowManagedWorkerProvider = false,
} = {}) {
  const providerId = String(model).split('/')[0];
  let sawAllowedProvider = false;
  for (const path of opencodeConfigAuditPaths(cwd, { projectRoot: configRoot })) {
    if (!existsSync(path)) continue;
    let raw;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      throw new Error(
        `Cannot read ${path} before forwarding a provider credential: ${err.message}`,
        { cause: err },
      );
    }
    let config;
    try {
      config = parseOpenCodeDocument(raw, { path });
    } catch (err) {
      throw new Error(
        `Cannot parse ${path} before forwarding a provider credential: ${err.message}`,
        { cause: err },
      );
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error(
        `Cannot safely audit ${path}: the OpenCode config must be a JSON object.`,
      );
    }
    for (const [providerKey, providerBlock] of [['provider', config.provider], ['providers', config.providers]]) {
      if (providerBlock !== undefined && (
        !providerBlock || typeof providerBlock !== 'object' || Array.isArray(providerBlock)
      )) {
        throw new Error(
          `Cannot safely audit provider overrides in ${path}: "${providerKey}" must be an object.`,
        );
      }
      if (!Object.prototype.hasOwnProperty.call(providerBlock || {}, providerId)) continue;
      const definition = providerBlock[providerId];
      const compatibleManagedWorker = allowManagedWorkerProvider &&
        allowedProvider &&
        isManagedWorkerProvider(definition) &&
        definition.options.baseURL === allowedProvider.options.baseURL;
      if (allowedProvider && (isDeepStrictEqual(definition, allowedProvider) || compatibleManagedWorker)) {
        sawAllowedProvider = true;
        continue;
      }
      throw new Error(
        `${path} overrides provider["${providerId}"]. OpenCode deep-merges that block, so Triss ` +
          'refuses to forward the selected credential to a potentially overridden endpoint or headers. ' +
          'Remove the provider override and retry.',
      );
    }
  }
  if (allowedProvider && requireAllowedProvider && !sawAllowedProvider) {
    throw new Error(
      `The managed provider["${providerId}"] definition was not found in an auditable OpenCode config.`,
    );
  }
}

function auditEffectiveOpenCodeConfiguration(
  sh,
  requestedModels,
  configContent,
  { cwd, credentialEnv, pure = false } = {},
) {
  // OpenCode loads account/org, managed-directory, and macOS MDM layers after
  // OPENCODE_CONFIG_CONTENT. Ask the pinned binary for the final merged config
  // under the exact child cwd/env, but deliberately omit the selected provider
  // credential. Any failure to obtain or parse that final view is fail-closed.
  const probeCredential = `triss-config-audit-${randomBytes(16).toString('hex')}`;
  const env = buildEngineEnv(credentialEnv, probeCredential, configContent);
  const result = sh('opencode', ['debug', 'config', ...(pure ? ['--pure'] : [])], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result?.error || result?.status !== 0) {
    throw new Error(
      'Cannot safely resolve the final effective OpenCode configuration before forwarding the selected credential.',
      result?.error ? { cause: result.error } : undefined,
    );
  }

  let config;
  try {
    config = JSON.parse(String(result.stdout || ''));
  } catch {
    throw new Error(
      'Cannot parse the final effective OpenCode configuration before forwarding the selected credential.',
    );
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('The final effective OpenCode configuration is not a JSON object.');
  }
  let expected;
  try {
    expected = JSON.parse(configContent);
  } catch {
    throw new Error('Cannot parse the Triss run-scoped OpenCode configuration before auditing it.');
  }
  if (config.model !== expected.model) {
    throw new Error(
      `The final effective OpenCode model is ${JSON.stringify(config.model)}, not ${JSON.stringify(expected.model)}; ` +
        'Triss refuses to forward the selected credential.',
    );
  }
  if (config.small_model !== expected.small_model) {
    throw new Error(
      `The final effective OpenCode small_model is ${JSON.stringify(config.small_model)}, not ` +
        `${JSON.stringify(expected.small_model)}; Triss refuses to forward the selected credential.`,
    );
  }

  const providers = config.provider;
  if (providers !== undefined && (
    !providers || typeof providers !== 'object' || Array.isArray(providers)
  )) {
    throw new Error(
      'Cannot safely audit provider overrides in the final effective OpenCode configuration.',
    );
  }
  const expectedProviders = expected.provider || {};
  for (const [expectedProviderId, expectedProviderDefinition] of Object.entries(expectedProviders)) {
    const expectedProvider = structuredClone(expectedProviderDefinition);
    if (expectedProvider?.options?.apiKey === `{env:${credentialEnv}}`) {
      expectedProvider.options.apiKey = probeCredential;
    }
    if (
      !Object.prototype.hasOwnProperty.call(providers || {}, expectedProviderId) ||
      !isDeepStrictEqual(providers[expectedProviderId], expectedProvider)
    ) {
      throw new Error(
        `The final effective OpenCode provider["${expectedProviderId}"] differs from the Triss-managed definition; ` +
          'Triss refuses to forward the selected credential.',
      );
    }
  }
  if (Object.keys(expectedProviders).length === 0) {
    // Protected routing pins the selected models to transient aliases whose
    // complete definitions were compared above. Only raw built-in routing has
    // no expected provider block, so reject persistent/managed overrides for
    // the provider ids the real run will select.
    for (const model of requestedModels) {
      const providerId = String(model).split('/')[0];
      if (Object.prototype.hasOwnProperty.call(providers || {}, providerId)) {
        throw new Error(
          `The final effective OpenCode configuration overrides provider["${providerId}"]; ` +
            'Triss refuses to forward the selected credential.',
        );
      }
    }
  }
}

function mergeWorkerProviderIntoExisting(path, providerInfo, model, smallModel, opts) {
  const audit = auditExistingConfig(path, providerInfo, {
      credentialMode: opts.credentialMode,
      allowUnsafeBash: opts.allowUnsafeBash,
      resolvedSmall: smallModel,
      providerAvailable: opts.providerAvailable,
      allowModelReplacement: true,
  });
  if (audit.blocking) return audit;

  let raw;
  let config;
  try {
    raw = readFileSync(path, 'utf8');
    config = JSON.parse(raw);
  } catch {
    return { blocking: true };
  }
  const expected = workerProviderDefinition(providerInfo, model, smallModel);
  const providers = config.provider;
  const current = providers && typeof providers === 'object' && !Array.isArray(providers)
    ? providers['triss-worker']
    : undefined;
  if (current !== undefined) {
    if (!isManagedWorkerProvider(current)) {
      process.stderr.write(
        pc.yellow(
          `  ⚠ ${path} contains a conflicting provider["triss-worker"] definition — refusing to overwrite it.\n`,
        ),
      );
      return { blocking: true };
    }
    if (
      isDeepStrictEqual(current, expected) &&
      config.model === model &&
      config.small_model === smallModel
    ) return { blocking: false };
  }
  if (providers !== undefined && (typeof providers !== 'object' || providers === null || Array.isArray(providers))) {
    process.stderr.write(pc.yellow(`  ⚠ ${path} has a non-object provider field — refusing to replace it.\n`));
    return { blocking: true };
  }
  config.model = model;
  config.small_model = smallModel;
  config.provider = { ...(providers || {}), 'triss-worker': expected };
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const indent = raw.match(/\r?\n([ \t]+)"/)?.[1] || '  ';
  const trailing = raw.endsWith('\r\n') || raw.endsWith('\n');
  const rendered = JSON.stringify(config, null, indent).replace(/\n/g, newline) + (trailing ? newline : '');
  const temp = `${path}.triss-worker-${randomBytes(6).toString('hex')}.tmp`;
  const mode = statSync(path).mode & 0o777;
  try {
    writeFileSync(temp, rendered, { mode, flag: 'wx' });
    chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (error) {
    try { if (existsSync(temp)) rmSync(temp); } catch {}
    throw error;
  }
  process.stderr.write(pc.green(`  ✓ configured provider["triss-worker"] in ${path}\n`));
  return { blocking: false };
}

// If the caller already has an opencode.json (the no-clobber path never
// touches it), still tell them when its `model` provider prefix contradicts
// the provider being configured — a mismatched prefix is exactly the
// infinite-retry trap this whole feature exists to catch. `providerInfo` is
// { kind: 'zai' | 'opencode-zen' | 'opencode-go', detectedZai }: for zai the
// expected prefix is the detected plan (skip if detection couldn't confirm
// one); the two OpenCode providers use fixed, distinct prefixes.
function warnIfProviderMismatch(path, providerInfo) {
  // Prefixes that belong to the provider being configured. Empty means there
  // is nothing to compare against (a zai kind whose plan probe failed).
  const expected =
    providerInfo.kind === 'worker'
      ? ['triss-worker']
      : providerInfo.kind === 'opencode-zen'
      ? ['opencode']
      : providerInfo.kind === 'opencode-go'
        ? ['opencode-go']
        : providerInfo.kind === 'moonshot'
          ? ['moonshotai', 'moonshotai-cn']
          : providerInfo.kind === 'kimi-for-coding'
            ? ['kimi-for-coding']
            : providerInfo.detectedZai
              ? [providerInfo.detectedZai]
              : [];
  if (!expected.length) return; // nothing to compare against
  let existing;
  try {
    existing = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return; // unreadable/malformed — not this function's job to fix that
  }
  const existingModel = typeof existing.model === 'string' ? existing.model : '';
  const existingPrefix = existingModel.split('/')[0];
  if (!existingPrefix || expected.includes(existingPrefix)) return;
  if (providerInfo.kind !== 'zai') {
    const cat = coderInitCatalogue(providerInfo);
    process.stderr.write(
      pc.yellow(
        `  ⚠ ${path} sets model="${existingModel}" (provider "${existingPrefix}"), which does not match ` +
          `the ${cat.noun} provider you are configuring — the existing file is kept untouched. Set a ` +
          `${cat.prefix}/<id> model (e.g. via TRISS_CODER_MODEL), or delete opencode.json and re-run init.\n`,
      ),
    );
    return;
  }
  process.stderr.write(
    pc.yellow(
      `  ⚠ ${path} sets model="${existingModel}" (provider "${existingPrefix}"), but ZHIPU_API_KEY ` +
        `just verified against the "${expected[0]}" endpoint instead — this is the exact ` +
        "mismatch that makes opencode retry a model call it can never complete. Update the " +
        'model/small_model fields, or unset ZHIPU_API_KEY and use a key for the right plan.\n',
    ),
  );
}

// Stale-Zen incident reporter. When an existing opencode.json (own OR the
// higher-precedence project file) is pinned to an OpenCode Zen model the
// AUTHENTICATED live catalogue (`zenAvailable`, a verified Set) no longer
// lists, this prints a focused recovery block:
//   - the stale field(s) (model / small_model) with their bare ids,
//   - the CURRENT replacement id(s) triss just resolved from the catalogue,
//   - the EXACT recovery commands (`triss coder model set --engine opencode
//     --provider opencode-zen --<scope>` and the equivalent wizard form).
// It deliberately does NOT mention selecting a fallback provider — provider
// intent stays whatever the config/catalogue indicated (the post-incident
// contract). Returns true when it emitted anything. No-clobber is preserved:
// this only PRINTS; the user runs the printed command to recover (the blocking
// throw that follows still uses the generic "existing opencode.json issues"
// line so existing CLI diagnostic contracts keep matching, while
// THIS block supplies the actionable recovery detail). `deps.outputs` (when an
// array) receives the same lines so a headless wizard caller (e.g. an injected
// deps bag) can read them without scraping stderr.
function emitZenStaleIncident(path, existingModels, resolved, zenAvailable, fileScope, deps = {}) {
  if (!zenAvailable || !existingModels) return false;
  const out = (s) => {
    process.stderr.write(s);
    if (Array.isArray(deps && deps.outputs)) deps.outputs.push(typeof s === 'string' ? s : String(s));
  };
  const scopeFlag = fileScope === 'local' ? '--local' : '--global';
  const fields = [];
  const seen = new Set();
  const consider = (field, val) => {
    if (!val) return;
    const id = providerModelId(val);
    const prefix = String(val).split('/')[0];
    // Only Zen models (opencode/* prefix) are in scope for this report, and
    // only when the catalogue verifiably no longer offers their bare id.
    if (prefix !== 'opencode' || !id) return;
    if (zenAvailable.has(id)) return;
    if (seen.has(field)) return;
    seen.add(field);
    fields.push([field, val, id]);
  };
  consider('model', existingModels.model);
  consider('small_model', existingModels.smallModel);
  if (!fields.length) return false;
  out(
    pc.yellow(
      `\n  ⚠ ${path} is pinned to a stale OpenCode Zen model the authenticated live catalogue no longer offers\n` +
        '    (free Zen models are temporary). Provider intent stays OpenCode Zen.\n',
    ),
  );
  const replacementFor = (field) => (field === 'model' ? resolved.model : resolved.smallModel);
  for (const [field, val] of fields) {
    const rep = replacementFor(field);
    out(
      pc.dim(
        `    · ${field}: ${val} (stale — "${providerModelId(val)}" retired)` +
          (rep ? ` -> current replacement ${rep}` : ' (no replacement resolved)') +
          '\n',
      ),
    );
  }
  // Print exactly one executable persistent repair
  // command — `triss coder model set <canonical-main> --small <canonical-small>
  // --engine opencode --provider opencode-zen <scope> --yes` — built from the
  // replacements triss just resolved, POSIX-quoted. The command must apply
  // through the real CLI (it carries the resolved ids + --yes), must NOT loop
  // back into the no-clobber wizard, and must not omit the required main. Do
  // NOT print the repeat `triss config wizard coder` alternative.
  if (resolved && resolved.model && resolved.smallModel) {
    out(pc.yellow('  Recover with:\n'));
    out(
      pc.cyan(
        `    triss coder model set ${posixSingleQuote(resolved.model)} --small ${posixSingleQuote(resolved.smallModel)} --engine opencode --provider opencode-zen ${scopeFlag} --yes\n`,
      ),
    );
  } else {
    out(
      pc.yellow(
        '  Recover with `triss coder model set <main> --small <small> --engine opencode --provider opencode-zen ' +
          `${scopeFlag} --yes` +
          '` using a current id from `triss coder models --provider opencode-zen`.\n',
      ),
    );
  }
  return true;
}

// Audits an existing opencode.json (the no-clobber path never rewrites it) for
// what a fresh config would guarantee but a user's file might not:
//   1. the deny-first bash policy — without permission.bash["*"]="deny" the
//      agent (run with --auto, which auto-approves every "ask") can execute
//      arbitrary shell commands;
//   2. the small_model *provider* — opencode has no run-time small-model flag,
//      so triss can't override a stale small_model; a cross-provider one is read
//      straight from the file and won't authenticate with the run's key
//      (blocking); and
//   3. a small_model *plan-level* mismatch — same credential kind but a
//      different prefix than the main model (e.g. `zai-coding-plan/*` main with
//      a `zai/*` small): both use ZHIPU but hit different Z.AI bases, the
//      original infinite-retry trap (warn).
// `opts.note` is a short precedence description prepended to warnings when the
// file audited isn't the one just written (see the cross-scope audit in
// runCoderSetup). Emits a specific warning per problem; never edits the file.
function auditExistingConfig(path, providerInfo, opts = {}) {
  const where = opts.note ? `${path} ${opts.note}` : path;
  let existing;
  try {
    existing = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    process.stderr.write(
      pc.yellow(`  ⚠ ${where} exists but is not valid JSON — leaving it; runs may misbehave.\n`),
    );
    return { blocking: true };
  }
  let blocking = false;
  if (existing?.permission?.bash?.['*'] !== 'deny' && opts.credentialMode !== 'best_effort_raw') {
    // The coder agent runs with --auto (every "ask" permission auto-approved),
    // so WITHOUT a deny-first allowlist it can run arbitrary shell commands.
    // That's the whole safety layer, so a missing policy is BLOCKING by default;
    // `--allow-unsafe-bash` is the explicit opt-in that downgrades it to a warning.
    if (opts.allowUnsafeBash) {
      process.stderr.write(
        pc.yellow(
          `  ⚠ ${where} has no deny-first bash policy (permission.bash["*"]="deny") — proceeding because ` +
            '--allow-unsafe-bash was passed. The coder agent runs with --auto and can run arbitrary shell ' +
            'commands. Add the policy when you can.\n',
        ),
      );
    } else {
      blocking = true;
      process.stderr.write(
        pc.yellow(
          `  ⚠ ${where} has no deny-first bash policy (permission.bash["*"]="deny"). The coder agent runs ` +
            'with --auto — every "ask" permission is auto-approved, so without an explicit deny-first ' +
            'allowlist it can run arbitrary shell commands. Add the policy, delete opencode.json and re-run ' +
            'init to regenerate it, or pass --allow-unsafe-bash to proceed without it.\n',
        ),
      );
    }
  }
  const model = typeof existing.model === 'string' ? existing.model : '';
  const small = typeof existing.small_model === 'string' ? existing.small_model : '';
  if (providerInfo.kind === 'worker' && opts.expectedWorkerProvider) {
    const providers = existing.provider;
    const current = providers && typeof providers === 'object' && !Array.isArray(providers)
      ? providers['triss-worker']
      : undefined;
    if (current !== undefined && !isDeepStrictEqual(current, opts.expectedWorkerProvider)) {
      blocking = true;
      process.stderr.write(
        pc.yellow(
          `  ⚠ ${where} overrides provider["triss-worker"] with an endpoint, credential binding, package, ` +
            'or model map that differs from the selected worker profile. Refresh that project config before ' +
            'using the global worker key.\n',
        ),
      );
    }
    for (const [role, value] of [['model', model], ['small_model', small]]) {
      if (value && !opts.workerModels?.has(value)) {
        blocking = true;
        process.stderr.write(
          pc.yellow(
            `  ⚠ ${where} sets ${role}="${value}", which is outside the selected Triss worker ` +
              'flash/pro allowlist. Re-run worker init for project scope or remove the override.\n',
          ),
        );
      }
    }
  }
  if (opts.allowModelReplacement) {
    return { blocking };
  }
  if (small && coderModelCredential(small).provider !== providerInfo.kind) {
    blocking = true;
    process.stderr.write(
      pc.yellow(
        `  ⚠ ${where} sets small_model="${small}", which is not a ${coderInitCatalogue(providerInfo).noun} ` +
          "model. opencode reads small_model from this file (triss cannot override it at run time), so the " +
          "run's key won't authenticate it. Update small_model, or delete opencode.json and re-run init.\n",
      ),
    );
  } else if (model && small && model.split('/')[0] !== small.split('/')[0]) {
    // Same credential kind but different plan/prefix (e.g. zai-coding-plan main
    // + zai small). triss cannot override small_model at run time and the two
    // Z.AI plans hit different bases, so a key serving one won't serve the other
    // — a guaranteed-broken run. Blocking, like the cross-kind case.
    blocking = true;
    process.stderr.write(
      pc.yellow(
        `  ⚠ ${where} sets model="${model}" but small_model="${small}" — different provider prefixes. ` +
          'opencode reads small_model from this file (triss cannot override it at run time), so the ' +
          "run's key likely can't serve both. Align small_model's prefix with the main model, or delete " +
          'opencode.json and re-run init.\n',
      ),
    );
  } else if (small && opts.resolvedSmall && small !== opts.resolvedSmall) {
    // OWN-SCOPE ONLY (opts.resolvedSmall is the value init resolved for THIS
    // scope). Same provider/plan, but the file's small_model isn't the resolved
    // one — e.g. a previous init's opencode/hy3-free that the live Zen catalogue
    // no longer lists, so resolveInitModels dropped it in favour of an available
    // model. opencode reads small_model from THIS file (triss has no run-time
    // small-model flag), so the stale/gone model keeps being used and the new
    // pin is cosmetic. Blocking — no-clobber won't fix it silently.
    blocking = true;
    const cat = coderInitCatalogue(providerInfo);
    process.stderr.write(
      pc.yellow(
        `  ⚠ ${where} sets small_model="${small}", but init resolved small_model="${opts.resolvedSmall}" ` +
          `(the old one is no longer selected — likely dropped from the ${cat.noun} catalogue). opencode ` +
          'reads small_model from this file and triss cannot override it at run time, so runs keep using ' +
          `the stale model. Set small_model="${opts.resolvedSmall}", or delete opencode.json and re-run init.\n`,
      ),
    );
  } else if (
    small &&
    opts.providerAvailable &&
    coderModelCredential(small).provider === providerInfo.kind &&
    !opts.providerAvailable.has(providerModelId(small))
  ) {
    // CROSS-SCOPE (opts.providerAvailable is the live provider catalogue). A DIFFERENT
    // scope's file is being audited, so exact equality with the scope-under-
    // config's resolvedSmall is meaningless — a valid in-catalogue small_model
    // that merely differs from this init's default is fine. What DOES break a
    // run is a Zen small_model the catalogue no longer lists (opencode reads it
    // from this higher-precedence file and triss can't override it). Block that.
    blocking = true;
    const cat = coderInitCatalogue(providerInfo);
    const temporary = providerInfo.kind === 'opencode-zen' ? ' (free models are temporary)' : '';
    process.stderr.write(
      pc.yellow(
        `  ⚠ ${where} sets small_model="${small}", which the live ${cat.noun} catalogue no longer lists${temporary}. ` +
          'opencode reads small_model from this file and triss cannot override ' +
          'it at run time, so runs will fail. Update small_model to a listed model, or delete opencode.json ' +
          'and re-run init.\n',
      ),
    );
  }
  return { blocking };
}

// Writes opencode.json with the already-resolved `model`/`smallModel` (from
// runCoderSetup's single resolveInitModels call) plus the deny-first bash
// policy. Never clobbers an existing file — instead it audits that file (main
// model provider, small_model provider, deny-first policy) and warns on any
// problem. `providerInfo` carries the normalized provider kind and optional
// detected Z.AI plan prefix.
function writeOpencodeConfig(scope, providerInfo, model, smallModel, opts = {}) {
  const path = opencodeConfigPath(scope);
  if (existsSync(path)) {
    process.stderr.write(pc.dim(`  · ${path} already exists — not overwriting\n`));
    process.stderr.write(
      pc.dim(`    (runs use TRISS_CODER_MODEL=${model}; auditing the existing file below)\n`),
    );
    if (providerInfo.kind === 'worker') {
      return mergeWorkerProviderIntoExisting(path, providerInfo, model, smallModel, opts);
    }
    warnIfProviderMismatch(path, providerInfo);
    return auditExistingConfig(path, providerInfo, {
      credentialMode: opts.credentialMode,
      allowUnsafeBash: opts.allowUnsafeBash,
      resolvedSmall: smallModel,
      providerAvailable: opts.providerAvailable,
    });
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      opencodeConfigTemplate(model, smallModel, providerInfo, {
        engine: opts.engine,
        credentialMode: opts.credentialMode,
      }),
      null,
      2,
    ) + '\n',
  );
  process.stderr.write(pc.green(`  ✓ wrote ${path} (model=${model}, small_model=${smallModel})\n`));
  return { blocking: false, created: true };
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

// ─── engine-agnostic worktree helpers ────────────────────────────────────────
//
// Fixed layout from the plan: `.triss/wt/<slug>` working trees, each on its
// own `coder/<slug>` branch. These are plain wrappers around `git`/`spawnSync`
// so both `coder clean` and `coder run --isolate` can
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

function openCode2CompatibilityError(detected, operation) {
  const identity = detected.found
    ? detected.version
      ? `v${detected.version}`
      : `found at ${detected.path || '(unknown path)'}, version unavailable`
    : 'not found';
  const reason = detected.capabilities?.reason;
  const recovery = reason === 'capability-probe-unavailable'
    ? `Fix the temporary-directory/probe environment and retry (${detected.capabilities.detail || 'probe unavailable'}); ` +
      'reinstalling the CLI does not repair this host error.'
    : `Install a compatible beta (${installHintOpenCode2()}) and retry.`;
  return new Error(
    `opencode2 ${identity} does not satisfy the minimum v${opencode2VersionPin()} and capability contract ` +
      `required for managed V2 ${operation}. ${recovery}`,
  );
}

// ─── status helper ───────────────────────────────────────────────────────────

// Read-only snapshot used by `triss status`. Never throws — every check
// degrades to a "not found / unknown" value instead, so a missing engine
// or a non-git cwd never crashes `triss status`. Additively reports BOTH
// engines and which engine a bare `triss coder run`
// resolves to, so the user knows what's installed and what's the default.
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
  // Crush detection is presence-only (crush
  // --version reports a dirty dev string; see docs/engines/crush.md); crush.json
  // presence is a best-effort file check, never parsed deeply. Never throws.
  const crushDetect = crushEngine.detect(sh);
  const crushConfigs = ['global', 'local'].map((scope) => {
    const path = crushConfigPath(scope);
    return { scope, path, exists: existsSync(path) };
  });
  // OpenCode 2 uses the same detect shape as Crush, but accepts versions at
  // or above the supported minimum when the required CLI capability probe
  // succeeds. `--version` plus `run --help` are read-only probes, and the
  // detector verifies that they leave no resident service behind (unlike
  // debug config / serve). V2 shares V1's opencode.json (Triss never writes
  // V2-native config), so there are no separate config rows — the shared
  // files above already describe them.
  const oc2Detect = detectOpenCode2(sh);
  // What a bare `triss coder run` (no --engine) resolves to right now.
  const defaultEngine = resolveCoderEngine({});
  // The model a bare `triss coder run` on the opencode engine would use — i.e.
  // TRISS_CODER_MODEL or the built-in default (NOT opencode.json, which the run
  // path ignores). Surfacing it makes provider/model misconfiguration visible.
  const defaultModel = coderModel();
  const defaultSmallModel = coderSmallModel();
  return {
    pin,
    engineVersion,
    configs,
    worktreeCount,
    crush: {
      found: crushDetect.found,
      version: crushDetect.version,
      satisfiesPin: crushDetect.satisfiesPin,
      pin: crushEngine.CRUSH_PIN,
      configs: crushConfigs,
    },
    opencode2: {
      found: oc2Detect.found,
      version: oc2Detect.version,
      satisfiesMinimum: oc2Detect.satisfiesMinimum,
      satisfiesPin: oc2Detect.satisfiesPin,
      pin: opencode2VersionPin(),
      serviceProcessCheck: oc2Detect.capabilities?.serviceProcessCheck || null,
    },
    defaultEngine,
    defaultModel,
    defaultSmallModel,
  };
}

// ─── coder run ───────────────────────────────────────────────────────────────
//
// The core adapter: spawn opencode headlessly, fold its ndjson event
// stream into one envelope, print exactly that envelope to stdout. Every
// other message in this module (and in this section) goes to stderr —
// stdout is reserved for the single JSON line the caller parses.
//
// OpenCode's own `--session <id>` requires
// a real, opencode-issued `ses_...` id — it will NOT create a session
// keyed by a caller-chosen slug. So `--session <slug>` on the triss side
// is a lookup key into `.triss/sessions.json` (slug -> real id), not a
// value passed straight through to opencode on a session's first run.

// ─── GLM rate-limit detection ────────────────────────────────────────────────
//
// On a Z.AI usage-limit hit, opencode's provider call fails with an
// AI_APICallError that the AI SDK RETRIES indefinitely — unlike a terminal
// error it never emits an `error` event on stdout, so a `coder run` just
// hangs until --timeout kills it with nothing to show (parsedAnyEvent stays
// false). The only durable trace is opencode's own log file, where every
// failed attempt logs a line like:
//   ...error.error="AI_APICallError: Usage limit reached for 5 hour. Your limit will reset at 2026-07-04 19:39:04"
// The reset timestamp is Z.AI server time (Beijing, UTC+8); we surface it
// converted to the caller's local time. spawnEngine polls this log so the
// run is killed within seconds of the limit instead of hanging to --timeout.

// Z.AI reports the reset time on its own clock (Beijing, no offset in the
// string) — parse it as +08:00 so the local-time conversion is correct.
const ZAI_RESET_TZ_OFFSET = '+08:00';
const RATE_LIMIT_RE =
  /Usage limit reached[^\n"]*?reset at (\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/i;

// Parse a Z.AI usage-limit message out of arbitrary text (an engine error
// string or a raw log line). Returns null when there's no match. `beijing`
// is the timestamp verbatim as Z.AI reported it; `resetLocal` is the same
// instant formatted in the host's local timezone (null only if the parsed
// date is somehow invalid).
export function parseRateLimitReset(text) {
  if (!text) return null;
  const m = RATE_LIMIT_RE.exec(String(text));
  if (!m) return null;
  const beijing = `${m[1]} ${m[2]}`;
  const at = new Date(`${m[1]}T${m[2]}${ZAI_RESET_TZ_OFFSET}`);
  const valid = !Number.isNaN(at.getTime());
  return {
    beijing,
    resetAt: valid ? at.toISOString() : null,
    resetLocal: valid ? at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' }) : null,
  };
}

// Human-facing one-liner for the CLI/MCP error and envelope warnings.
export function rateLimitMessage(info) {
  const when = info.resetLocal
    ? `${info.resetLocal} (local time)`
    : `${info.beijing} Beijing time`;
  return `GLM usage limit reached — quota resets at ${when} (reported ${info.beijing} Beijing time).`;
}

// Default opencode log location — XDG data dir, overridable in tests via the
// `logPath` dep on findRecentRateLimit (no env var, to keep the doc surface
// small).
function opencodeLogPath() {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(dataHome, 'opencode', 'log', 'opencode.log');
}

// Read up to `maxBytes` from the END of a file without loading the whole
// thing (the engine log grows to many MB). Returns '' on any error. When the
// file is larger than `maxBytes` the window starts mid-line, so the leading
// partial fragment is DROPPED: callers scan for complete lines and a
// fragment has no reliable `timestamp=` prefix, which would otherwise defeat
// findRecentRateLimit's recency guard (a stale prior-run limit line split by
// the window boundary would read as fresh). Only whole trailing lines are
// returned.
function readFileTail(path, maxBytes) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    const truncated = size > maxBytes;
    const start = truncated ? size - maxBytes : 0;
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.allocUnsafe(len);
    let pos = 0;
    while (pos < len) {
      const n = readSync(fd, buf, pos, len - pos, start + pos);
      if (n <= 0) break;
      pos += n;
    }
    let text = buf.subarray(0, pos).toString('utf8');
    if (truncated) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1);
    }
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

const RATE_LIMIT_LOG_SCAN_BYTES = 256 * 1024;

// Scan the tail of opencode's log for a usage-limit line logged at or after
// `sinceMs` (epoch ms). The recency filter is essential: the tail is full of
// PRIOR runs' rate-limit lines, and only lines from THIS run should count —
// otherwise every healthy run inherits a stale limit. Lines are chronological
// so the last match wins. Never throws.
export function findRecentRateLimit(sinceMs, deps = {}) {
  const readTail = deps.readFileTail || readFileTail;
  const path = deps.logPath || opencodeLogPath();
  const text = readTail(path, deps.scanBytes || RATE_LIMIT_LOG_SCAN_BYTES);
  if (!text) return null;
  let latest = null;
  for (const line of text.split('\n')) {
    if (!line.includes('Usage limit reached')) continue;
    // Fail CLOSED on a missing/unparseable timestamp: readFileTail already
    // drops the leading partial fragment, so every remaining line should
    // carry a real `timestamp=` prefix. A line without one means the log
    // format changed — skipping it degrades to the old hang-to-timeout,
    // whereas trusting it would fast-fail healthy runs against a stale limit
    // for hours. Only a line proven at-or-after this run's start counts.
    const tsMatch = /^timestamp=(\S+)/.exec(line);
    if (!tsMatch) continue;
    const lineMs = Date.parse(tsMatch[1]);
    if (!Number.isFinite(lineMs) || lineMs < sinceMs) continue;
    const info = parseRateLimitReset(line);
    if (info) latest = info;
  }
  return latest;
}

// ─── event folding ───────────────────────────────────────────────────────────

export function createEventFolder() {
  return {
    parsedAnyEvent: false,
    sessionRealId: null,
    finalText: null,
    usage: emptyOpencodeUsage(),
    sawStepFinish: false,
    warnings: [],
    rateLimit: null,
    // Bounded activity facts (Section 6.4 of the approved plan): counts and
    // tool-name aggregates only — never input/output/error/command bytes.
    activity: {
      events: 0,
      tool_uses: 0,
      tool_errors: 0,
      by_tool: {},
      saw_terminal_stop: false,
      first_event_at: null,
      last_event_at: null,
    },
    // Malformed/omitted events increment this counter; the raw line is never
    // copied into a warning (bounded categories only).
    omittedCount: 0,
    // A top-level `error` event is an internal engine-error observation even
    // if a fake child later exits zero (documented contract).
    engineErrorObserved: false,
  };
}

// At most 16 distinct public warnings, each at most 256 UTF-8 bytes
// (Section 6.4). Control bytes are stripped so raw diagnostics can never
// smuggle terminal escapes or secrets into the envelope.
const MAX_PUBLIC_WARNINGS = 16;
const MAX_WARNING_BYTES = 256;

// Replace control bytes (C0 controls + DEL) with '?' so raw diagnostics can
// never smuggle terminal escapes or secrets into the envelope. Implemented
// via charCodeAt because the no-control-regex lint rule forbids control
// escapes inside a RegExp literal.
function sanitizeControlBytes(text) {
  let out = '';
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0);
    const isControl =
      (code >= 0x00 && code <= 0x08) ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f;
    out += isControl ? '?' : ch;
  }
  return out;
}

function pushWarning(state, text) {
  if (state.warnings.length >= MAX_PUBLIC_WARNINGS) return;
  const sanitized = sanitizeControlBytes(text).slice(0, MAX_WARNING_BYTES);
  if (state.warnings.includes(sanitized)) return;
  state.warnings.push(sanitized);
}

// Cap distinct tool names at 32, collecting the remainder under `other`
// (Section 6.4). Missing or non-string tool names normalize to `unknown`.
const MAX_DISTINCT_TOOLS = 32;

function bumpToolActivity(activity, rawTool) {
  const tool = typeof rawTool === 'string' && rawTool.length > 0 ? rawTool : 'unknown';
  if (Object.prototype.hasOwnProperty.call(activity.by_tool, tool)) {
    activity.by_tool[tool] += 1;
    return;
  }
  const named = Object.keys(activity.by_tool).filter((k) => k !== 'other').length;
  if (named >= MAX_DISTINCT_TOOLS) {
    activity.by_tool.other = (activity.by_tool.other ?? 0) + 1;
    return;
  }
  activity.by_tool[tool] = 1;
}

// Folds one raw ndjson line into `state` (mutated in place). Unknown
// event types and unparseable/truncated lines are tolerated — they add a
// warning instead of throwing, per the plan's "never crash on unknown
// events" rule. `onToolUse(evt)` is an optional side-effect hook (used by
// the live spawn path to print a progress line; the fixture-replay tests
// don't need it).
export function foldEventLine(state, rawLine, { onToolUse, arrivedAt } = {}) {
  const line = String(rawLine).trim();
  if (!line) return;

  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    // Malformed NDJSON: bounded category warning + exact counter; the raw
    // line is never copied into a warning (documented contract).
    state.omittedCount += 1;
    pushWarning(state, 'unparseable line (omitted)');
    return;
  }
  state.parsedAnyEvent = true;
  state.activity.events += 1;
  // Host-observed arrival timestamps for the first and last parseable events
  // (Section 6.4); engine-supplied clocks are never trusted or required.
  if (arrivedAt !== undefined) {
    if (state.activity.first_event_at === null) state.activity.first_event_at = arrivedAt;
    state.activity.last_event_at = arrivedAt;
  }
  if (!state.sessionRealId && evt.sessionID) state.sessionRealId = evt.sessionID;

  switch (evt.type) {
    case 'step_start':
      break;
    case 'tool_use':
      state.activity.tool_uses += 1;
      bumpToolActivity(state.activity, evt.part?.tool);
      if (evt.part?.state?.status === 'error') state.activity.tool_errors += 1;
      if (onToolUse) onToolUse(evt);
      break;
    case 'step_finish': {
      // Per-step tokens, NOT cumulative — recon confirmed every step_finish event
      // carries its own step-level counts, so the envelope's usage is the SUM
      // across all step_finish events, not just the last one.
      state.sawStepFinish = true;
      foldOpencodeStep(state.usage, evt.part);
      // The accumulator keeps the raw per-step sums; the two derived totals are
      // refreshed here so the canonical fold surface already carries them
      // (finalizeOpencodeUsage stays the single source of the derivation).
      const { tokens: folded } = finalizeOpencodeUsage(state.usage);
      state.usage.input_total = folded.input_total;
      state.usage.output_total = folded.output_total;
      // Only a terminal `stop` marks terminal stop; intermediate
      // `reason=tool-calls` does not (Section 6.4).
      if (evt.part?.reason === 'stop') state.activity.saw_terminal_stop = true;
      break;
    }
    case 'text':
      // Keep overwriting — the last `text` event before the final
      // `step_finish (reason: stop)` is the assistant's actual reply.
      if (evt.part?.text != null) state.finalText = evt.part.text;
      break;
    case 'error': {
      // A top-level engine error is an internal engine-error observation even
      // if a fake child later exits zero (documented contract).
      state.engineErrorObserved = true;
      const msg = evt.error?.data?.message || evt.error?.name || 'unknown engine error';
      pushWarning(state, `engine error: ${msg}`);
      // A terminal rate-limit error (rare on stdout — usually retried
      // silently and only logged) still gets recognised here so the live
      // path can kill early and report the reset time.
      const rl = parseRateLimitReset(msg) || parseRateLimitReset(line);
      if (rl && !state.rateLimit) state.rateLimit = rl;
      break;
    }
    default:
      pushWarning(state, `unknown event type: ${evt.type}`);
  }
}

// ─── engine env / argv ──────────────────────────────────────────────────────────

// Minimal allowlist env for the engine subprocess — never spread
// process.env, so the engine only ever sees what it needs. `credEnv` is the
// single provider key the resolved model requires (from coderModelCredential):
// only that key is forwarded, so a Zen run never carries the Z.AI key and vice
// versa, even when both are configured. Included only when actually set — an
// unconfigured credential never appears.
function buildEngineEnv(credEnv, credentialValue, opencodeConfigContent) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  const value = credentialValue === undefined ? process.env[credEnv] : credentialValue;
  if (credEnv && value) env[credEnv] = value;
  if (opencodeConfigContent) env.OPENCODE_CONFIG_CONTENT = opencodeConfigContent;
  return env;
}

function buildOpencodeArgv({ prompt, agent, model, sessionRealId, cont, dir, pure = false }) {
  // --auto: headless runs must auto-approve every "ask" permission (deny
  // still blocks) — there is no human to answer the prompt.
  // --model is ALWAYS passed explicitly (the resolved model — override or
  // coderModel()), never left for opencode to infer from whichever config
  // file it happens to find. Recon showed the wrong provider default
  // causes an infinite retry loop with nothing on stdout; an explicit
  // model makes this deterministic regardless of worktree config state.
  const argv = ['run', prompt, '--format', 'json', '--auto', '--model', model];
  if (pure) argv.push('--pure');
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
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    // Malformed JSON must not degrade to an empty
    // store — the next successful persist would overwrite and destroy it.
    // Surface the corruption instead of silently rewriting the file.
    throw new Error(
      `Session store at ${path} is not valid JSON (${err.message}) — refusing to read or rewrite it ` +
        '(fail-closed). Fix or remove the file manually.',
      { cause: err },
    );
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(
      `Session store at ${path} does not contain a JSON object — refusing to read or rewrite it ` +
        '(fail-closed). Fix or remove the file manually.',
    );
  }
  if (Array.isArray(parsed)) {
    throw new Error(
      `Session store at ${path} is a JSON array — not a recognized shape. ` +
        'Refusing to read or rewrite it (fail-closed).',
    );
  }
  return parsed;
}

// ─── versioned, engine-namespaced session store ─────────────────────────────
//
// Shape v2 (docs/opencode2-engine-plan.md "Session contract"):
//   { "version": 2, "engines": { "opencode": {slug: realId}, "opencode2": {...} } }
// A legacy flat file {slug: realId} is all-V1 (the only engine that existed)
// and migrates atomically on first write. Migration is read-time lazy: the
// accessors below normalize BOTH shapes in memory so readers never see the
// flat form, while the on-disk file is only rewritten when a mapping is
// actually persisted (an existing safe V1 file is not rewritten merely by a
// V2 read).

const SESSION_STORE_VERSION = 2;

// Normalize any on-disk shape (legacy flat map OR versioned) into the
// versioned in-memory shape. Pure: never mutates the argument.
//
// An unknown `version` (e.g. 3, written by a
// future Triss) or a version-2 object with a malformed `engines` field is
// NOT treated as a legacy flat map — treating {version:3, engines:{...}} as
// legacy silently discards both fields and the next persist DESTROYS the
// unknown data (data loss). Such a store throws; persistSessionMapping
// propagates and the file is never rewritten. Only a genuinely legacy flat
// object (no `version` key at all) migrates.
// Prototype-pollution boundary: namespaces are null-prototype dictionaries. A plain `{}`+
// `namespace[slug]` lookup resolves `constructor`/`toString` from
// Object.prototype, an assignment under the `__proto__` slug mutates the
// prototype instead of recording a mapping, and legacy flat slugs literally
// named "version"/"engines" were misread as store metadata. Lookup is
// own-property only, and version detection is STRUCTURAL (a versioned store
// has a NUMBER 2 + an engines object; a string "version" value is a legacy
// flat slug). Every legacy entry must be string -> string — malformed values
// fail closed instead of being silently dropped (a later persist would
// destroy them).
const emptyNamespace = () => Object.create(null);

function normalizeSessionStore(raw) {
  const store = { version: SESSION_STORE_VERSION, engines: { opencode: emptyNamespace(), opencode2: emptyNamespace() } };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return store;
  if ('version' in raw && typeof raw.version === 'number') {
    if (raw.version === 2) {
      if (!raw.engines || typeof raw.engines !== 'object' || Array.isArray(raw.engines)) {
        throw new Error(
          `Session store at ${sessionsFilePath()} has version 2 but a malformed "engines" field — ` +
            'refusing to migrate or rewrite it (fail-closed). Fix or remove the file manually.',
        );
      }
      // Invariant: an UNRECOGNIZED engines.* key is future/corrupted
      // data — copying only the known namespaces made the next persist
      // silently erase it. Same fail-closed contract as every other
      // unrecognized store shape.
      for (const key of Object.keys(raw.engines)) {
        if (!SESSION_STORE_ENGINES.includes(key)) {
          throw new Error(
            `Session store at ${sessionsFilePath()} has an unknown engine namespace "engines.${key}" — this ` +
              'Triss understands opencode and opencode2 only. Refusing to read or rewrite it (fail-closed); ' +
              'upgrade Triss or fix the file manually.',
          );
        }
      }
      for (const engine of SESSION_STORE_ENGINES) {
        const namespace = raw.engines[engine];
        if (namespace == null) continue; // absent is fine
        if (typeof namespace !== 'object' || Array.isArray(namespace)) {
          // A string/array namespace (corrupted or future
          // shape) used to be silently skipped; the next persist then
          // REWROTE the store without that data. Fail closed instead —
          // the file is never rewritten when its shape is not understood.
          throw new Error(
            `Session store at ${sessionsFilePath()} has a malformed "${engine}" namespace ` +
              `(expected an object of slug -> session id, got ${Array.isArray(namespace) ? 'an array' : `a ${typeof namespace}`}) — ` +
              'refusing to read or rewrite it (fail-closed). Fix or remove the file manually.',
          );
        }
        for (const [slug, realId] of Object.entries(namespace)) {
          if (typeof slug === 'string' && typeof realId === 'string') {
            store.engines[engine][slug] = realId;
          } else {
            // Non-string slug/value entries are corruption too — same
            // fail-closed contract: silent drops lose data
            // on the next rewrite).
            throw new Error(
              `Session store at ${sessionsFilePath()} has a malformed entry in "engines.${engine}" ` +
                `(${JSON.stringify(String(slug))} -> ${typeof realId}) — refusing to read or rewrite it ` +
                '(fail-closed). Fix or remove the file manually.',
            );
          }
        }
      }
      return store;
    }
    throw new Error(
      `Session store at ${sessionsFilePath()} has unknown version ${JSON.stringify(raw.version)} — ` +
        'this Triss understands version 2 and legacy flat maps only. Refusing to read or rewrite it ' +
        '(fail-closed); upgrade Triss or fix the file manually.',
    );
  }
  if ('engines' in raw) {
    // Structural disambiguation (invariant): a legacy flat map whose slugs
    // literally include "version"/"engines" carries STRING session-id values
    // — every value a string means legacy. Anything else with an `engines`
    // key but no numeric version is an unrecognized shape: fail closed.
    const allStringValues = Object.values(raw).every((v) => typeof v === 'string');
    if (!allStringValues) {
      throw new Error(
        `Session store at ${sessionsFilePath()} has an "engines" field but no numeric "version" — this is ` +
          'not a recognized shape (legacy flat maps carry only string session ids). Refusing to read or ' +
          'rewrite it (fail-closed).',
      );
    }
  }
  // Legacy flat map: every entry belongs to the V1 engine (the only writer
  // that ever produced this shape). Malformed entries fail closed because
  // silently dropping them would lose data on the next rewrite.
  for (const [slug, realId] of Object.entries(raw)) {
    if (typeof realId !== 'string') {
      throw new Error(
        `Session store at ${sessionsFilePath()} has a malformed legacy entry ` +
          `(${JSON.stringify(slug)} -> ${typeof realId}) — refusing to read or rewrite it (fail-closed). ` +
          'Fix or remove the file manually.',
      );
    }
    store.engines.opencode[slug] = realId;
  }
  return store;
}

function readSessionStore() {
  return normalizeSessionStore(readSessionsMap());
}

// Look up a slug's real session id for ONE engine. Cross-engine lookups are
// impossible by construction — an opencode2 run never sees opencode's ids
// (equal slugs across engines never cross-resume).
export function lookupSessionRealId(engine, slug) {
  const store = readSessionStore();
  const namespace = store.engines[engine] || emptyNamespace();
  // Own-property only (invariant): `constructor`/`toString` must never
  // resolve from Object.prototype as a session id.
  return Object.prototype.hasOwnProperty.call(namespace, slug) ? namespace[slug] : null;
}

// The session store's own mutation lock path. Keyed per project (TRISS_STATE_DIR
// lives under projectRoot) so two projects never contend on one lock, while
// every engine's writer within THIS project serializes on the same file.
export function sessionsLockPath() {
  return join(projectRoot(), TRISS_STATE_DIR, 'sessions.lock');
}

// Persist slug -> realId under the engine's namespace. Read-modify-write of
// the VERSIONED shape (legacy content migrates here), atomic write-then-
// rename, serialized under the engine-neutral session-store mutation lock.
//
// Invariant: this runs AFTER the engine finished and BEFORE the
// envelope is written — the model output is ready and the tokens are already
// paid for. acquireCoderMutationLock throws LOCK_HELD IMMEDIATELY (no wait,
// no retry), so two parallel `coder run --session a` / `--session b` in one
// project made one of them DISCARD a finished run over a session-bookkeeping
// file. The lock is therefore acquired with a bounded retry/backoff, and if
// it is still held the mapping persists via the pre-lock lock-free protocol
// (atomic write + post-commit verify + repair) with a stderr warning — a
// possible lost UPDATE of a slug mapping must never cost a finished RUN.
const SESSIONS_LOCK_RETRY_MS = [50, 100, 200, 400, 800, 1500, 2500];
function acquireSessionsLock({ acquireLock, retryMs } = {}) {
  const schedule = retryMs || SESSIONS_LOCK_RETRY_MS;
  const acquire = acquireLock || (() => acquireCoderMutationLock('sessions', 'store', {
    lockPath: sessionsLockPath(),
  }));
  for (let attempt = 0; attempt < schedule.length; attempt += 1) {
    try {
      return acquire();
    } catch (err) {
      if (err?.code !== 'LOCK_HELD') throw err;
      // DELIBERATE blocking sleep (invariant follow-up: this is Atomics.wait,
      // not an await) — persistSessionMapping is a synchronous CLI-final
      // path (the engine is done, only the envelope write remains), so
      // nothing else needs the event loop and a busy-wait-free sleep is the
      // simplest correct pause. Worst case is the full schedule (~5.5s on
      // the default).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, schedule[attempt]);
    }
  }
  try {
    return acquire();
  } catch (err) {
    if (err?.code !== 'LOCK_HELD') throw err;
    return null; // still held — degrade to the lock-free path
  }
}
export function persistSessionMapping(sh, engine, slug, realId, deps = {}) {
  // Invariant: without this guard a future/typo'd engine argument
  // would CREATE an unrecognized engines.* namespace that the very next read
  // (and rewrite) silently erased.
  if (!SESSION_STORE_ENGINES.includes(engine)) {
    throw new Error(
      `persistSessionMapping: unknown engine ${JSON.stringify(engine)} — supported: ${SESSION_STORE_ENGINES.join(', ')}`,
    );
  }
  const path = sessionsFilePath();
  mkdirSync(dirname(path), { recursive: true });

  const lockSchedule = deps.lockRetryMs || SESSIONS_LOCK_RETRY_MS;
  const lockHandle = acquireSessionsLock({ acquireLock: deps.acquireLock, retryMs: deps.lockRetryMs });
  if (!lockHandle) {
    process.stderr.write(
      pc.yellow(
        `⚠ session-store lock still held after ${
          lockSchedule.reduce((a, b) => a + b, 0)
        }ms — persisting "${slug}" without the lock (rare concurrent mapping loss possible)\n`,
      ),
    );
  }
  const writeMapping = () => {
    const store = readSessionStore();
    if (!store.engines[engine]) store.engines[engine] = emptyNamespace();
    store.engines[engine][slug] = realId;
    atomicWriteJson(path, store);
  };
  try {
    writeMapping();
  } finally {
    if (lockHandle && typeof lockHandle.release === 'function') lockHandle.release();
  }

  // Post-commit verify: under the lock this can only fire after a crash
  // between rename and release; on the lock-free fallback path another
  // writer may have committed in between — re-persisting repairs our slug
  // (the other writer's slug is repaired by its own verify pass).
  const verify = readSessionStore();
  if (verify.engines[engine]?.[slug] !== realId) {
    const retryHandle = acquireSessionsLock({ acquireLock: deps.acquireLock });
    try {
      const retryStore = readSessionStore();
      if (!retryStore.engines[engine]) retryStore.engines[engine] = emptyNamespace();
      retryStore.engines[engine][slug] = realId;
      atomicWriteJson(path, retryStore);
    } finally {
      if (retryHandle && typeof retryHandle.release === 'function') retryHandle.release();
    }
  }

  if (gitRepoRoot(sh, projectRoot())) addToGitignore(`${TRISS_STATE_DIR}/`);
}

/**
 * Remove one slug's mapping from the versioned session store (the
 * engine-owned session artifact `session clean` must clear before the
 * inventory row disappears). No-op for engines without a store namespace and
 * for an absent store file; read-modify-write under the same sessions lock as
 * persistSessionMapping so a concurrent run can never resurrect or lose a
 * mapping. Idempotent: removing an already-absent slug succeeds.
 */
export function removeSessionStoreMapping(engine, slug) {
  // crush has no namespace in the versioned store — nothing to remove.
  if (!SESSION_STORE_ENGINES.includes(engine)) return false;
  const path = sessionsFilePath();
  if (!existsSync(path)) return false;
  const lockHandle = acquireCoderMutationLock('sessions', 'store', { lockPath: sessionsLockPath() });
  try {
    const store = readSessionStore();
    const namespace = store.engines[engine];
    if (!namespace || !Object.prototype.hasOwnProperty.call(namespace, slug)) return false;
    delete namespace[slug];
    atomicWriteJson(path, store);
    return true;
  } finally {
    if (lockHandle && typeof lockHandle.release === 'function') lockHandle.release();
  }
}

/**
 * Classify the DURABLE engine-owned session-store mapping for one slug —
 * the lifecycle authority for whether a row may claim to be continuable.
 * Returns { state, realId }:
 *   not_applicable  engine keeps no store namespace (crush)
 *   absent          no mapping for the slug (nothing published)
 *   matching        slug -> string realId present (== expectedRealId when given)
 *   mismatch        mapping exists but differs from expectedRealId, or the
 *                   store is malformed/unreadable (fail closed, retain)
 */
function classifySessionStoreMapping(engine, slug, expectedRealId) {
  if (!SESSION_STORE_ENGINES.includes(engine)) return { state: 'not_applicable', realId: null };
  try {
    const namespace = readSessionStore().engines[engine];
    if (!namespace || !Object.prototype.hasOwnProperty.call(namespace, slug)) {
      return { state: 'absent', realId: null };
    }
    const value = namespace[slug];
    if (typeof value !== 'string' || value.length === 0) return { state: 'mismatch', realId: null };
    if (expectedRealId !== undefined && value !== expectedRealId) {
      return { state: 'mismatch', realId: value };
    }
    return { state: 'matching', realId: value };
  } catch (err) {
    // A malformed/unreadable store is mismatch by definition: fail closed.
    // The ORIGINAL store error is preserved so callers can surface the real
    // corruption diagnostic instead of a generic orphan/mismatch message.
    return { state: 'mismatch', realId: null, unreadable: true, cause: err };
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
// Invariant: the historical lock-free rationale ("two concurrent
// runs can each drop the other's mapping; the atomic write only prevents
// torn reads") is now the DEGRADED fallback of persistSessionMapping — used
// only when the session lock stays held past the bounded retry, because
// discarding a finished run (tokens already paid) over a mapping file was
// strictly worse than a rare lost slug update.

// ─── isolation worktree setup ────────────────────────────────────────────────

function setupIsolation(sh, slug) {
  const repoRoot = gitRepoRoot(sh, projectRoot());
  if (!repoRoot) {
    const err = new Error(
      '--isolate requires a git repository — no repo found at or above the current directory.',
    );
    err.code = ISOLATION_UNAVAILABLE_CODE;
    throw err;
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
      const err = new Error(
        `${TRISS_STATE_DIR}/wt/${slug} already exists on branch "${existingBranch}", expected "${branch}" — ` +
          'use a different --session slug, or remove the worktree manually (triss coder clean --all).',
      );
      err.code = ISOLATION_CONFLICT_CODE;
      throw err;
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
      const err = new Error(
        `Branch "${branch}" already exists but ${TRISS_STATE_DIR}/wt/${slug} does not — likely left ` +
          "behind by a previous run whose worktree was removed while the branch survived (unmerged " +
          `commits). Remove it with \`git branch -D ${branch}\` (review its commits first) or ` +
          '`triss coder clean --all`, or pick a different --session slug.',
      );
      err.code = ISOLATION_CONFLICT_CODE;
      throw err;
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
        const err = new Error(
          `${TRISS_STATE_DIR}/wt/${slug} (branch "${branch}") already exists — another run may have ` +
            'created it concurrently; use a different --session slug or `triss coder clean`.',
        );
        err.code = ISOLATION_CONFLICT_CODE;
        throw err;
      }
      const msg = String((r && (r.stderr || r.stdout)) || 'unknown error').trim();
      const err2 = new Error(`git worktree add ${wtPath} -b ${branch} failed: ${msg}`);
      err2.code = ISOLATION_UNAVAILABLE_CODE;
      throw err2;
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
const RESIDUAL_GROUP_TERM_GRACE_MS = 250;
const RESIDUAL_GROUP_KILL_WAIT_MS = 1000;
const PROCESS_GROUP_POLL_MS = 25;
// How often to poll the engine log for a usage-limit line while a run is in
// flight. On a rate-limited run opencode emits nothing on stdout and retries
// forever, so without this the run hangs to --timeout; polling turns that
// into a ~poll-interval-latency clear error instead.
const RATE_LIMIT_POLL_MS = 3000;

// Signal a detached child's whole process GROUP (negative pid), never anything
// else. `kill(-1, ...)` means every process this uid may signal and `kill(0,
// ...)` means the caller's own process group, so a degenerate child pid must
// never reach process.kill. Return false when there is no safe/observable group.
function killProcessGroup(
  pid,
  sig,
  killProcess = process.kill.bind(process),
  { strict = false, label = 'OpenCode' } = {},
) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    killProcess(-pid, sig);
    return true;
  } catch (err) {
    if (err?.code === 'ESRCH') return false;
    // macOS sandbox profiles can deny the existence probe for a process group
    // even when signalling that same group is permitted. EPERM for signal 0
    // therefore means "still observable", not "already gone".
    if (sig === 0 && err?.code === 'EPERM') return true;
    if (!strict) return false;
    throw new Error(
      `Failed to signal ${label} process group ${pid} with ${sig}: ${err?.message || String(err)}`,
      { cause: err },
    );
  }
}

function noInjectedProcessGroup() {
  const error = new Error('custom spawn has no injected process-group owner');
  error.code = 'ESRCH';
  throw error;
}

function spawnEngine({
  argv,
  env,
  timeoutSec,
  spawnFn,
  sinceMs,
  scanRateLimit,
  logPath,
  pollMs,
  abortSignal,
  killProcess = process.kill.bind(process),
  residualTermGraceMs = RESIDUAL_GROUP_TERM_GRACE_MS,
  residualKillWaitMs = RESIDUAL_GROUP_KILL_WAIT_MS,
  processGroupPollMs = PROCESS_GROUP_POLL_MS,
  // OpenCode 2 overrides this engine seam; omitted values preserve V1.
  // The V1 path is unchanged when these are omitted: binary 'opencode',
  // V1 event fold, V1 diagnostics labels (tests pin the exact messages).
  // V2 passes its adapter's members.
  binary = 'opencode',
  label = 'opencode',
  createState = createEventFolder,
  foldLine = foldEventLine,
  cwd,
}) {
  // pollMs === 0 disables the watchdog entirely; null/undefined uses the
  // default cadence. Tests set a small value to exercise the poll path.
  const resolvedPollMs = pollMs == null ? RATE_LIMIT_POLL_MS : pollMs;
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error(`${label} run was cancelled before the engine started.`));
      return;
    }
    let child;
    try {
      child = spawnFn(binary, argv, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
        ...(cwd !== undefined ? { cwd } : {}),
      });
    } catch (err) {
      reject(new Error(`Failed to spawn ${label}: ${err.message}`));
      return;
    }

    let settled = false;
    let timedOut = false;
    let graceTimer = null;
    let pollTimer = null;
    let residualCleanupPromise = null;
    const state = createState();
    // First termination cause wins and is recorded BEFORE sending any signal
    // (Section 6.1), so a child that exits zero still reports `killed` with
    // the right cause. `none` means no termination was requested/observed.
    let terminationCause = 'none';
    // Private stderr retention is a bounded 64 KiB tail, never an unbounded
    // array; its raw bytes never enter public results (Section 6.4).
    const MAX_STDERR_TAIL_BYTES = 64 * 1024;
    let stderrTail = '';
    // Bounded engine-output accounting (Section 6.4): one NDJSON record and
    // the public final_text are capped at 1 MiB UTF-8 each, cumulative
    // processed stdout at 32 MiB; overflow terminates the tree and completes
    // normal cleanup.
    const MAX_RECORD_BYTES = 1024 * 1024;
    const MAX_FINAL_TEXT_BYTES = 1024 * 1024;
    const MAX_TOTAL_STDOUT_BYTES = 32 * 1024 * 1024;
    let totalStdoutBytes = 0;
    let outputLimitObserved = false;

    const killGroup = (sig) => killProcessGroup(child.pid, sig, killProcess, { strict: true });

    const waitForGroupExit = async (maxMs) => {
      const deadline = Date.now() + Math.max(0, maxMs);
      while (killGroup(0)) {
        if (Date.now() >= deadline) return false;
        await new Promise((done) => setTimeout(done, Math.max(1, processGroupPollMs)));
      }
      return true;
    };

    // The immediate OpenCode CLI can close after a tool subprocess redirected
    // its stdio and kept running in the detached process group. Do not return
    // an envelope while such descendants can still hold DB locks or write
    // files after Triss reported completion. Send the first real signal
    // directly: an existence probe followed by a signal would add a PID/PGID
    // reuse window after the group leader was reaped, while ESRCH from the
    // signal itself proves that no target existed at that instant.
    const terminateResidualGroup = async () => {
      if (!killGroup('SIGTERM')) return;
      if (await waitForGroupExit(residualTermGraceMs)) return;
      if (!killGroup('SIGKILL')) return;
      if (!(await waitForGroupExit(residualKillWaitMs))) {
        throw new Error(
          `${label} process group ${child.pid} remained alive after SIGKILL; refusing to report completion.`,
        );
      }
    };

    const startResidualCleanup = () => {
      if (!residualCleanupPromise) {
        residualCleanupPromise = terminateResidualGroup();
        // The close handler awaits this same promise. Attach a handler now so
        // an early rejection between exit and close is never reported as an
        // unhandled rejection.
        void residualCleanupPromise.catch(() => {});
      }
      return residualCleanupPromise;
    };
    // Schedule the SIGKILL escalation AT MOST ONCE — the timeout, the
    // rate-limit poll, host/caller cancellation, and the stdout-error path can
    // all send SIGTERM, but a second graceTimer would leak past settle()
    // (which only clears the
    // latest reference) and fire a stray SIGKILL at an already-reaped group.
    // The `settled` guard also stops a buffered stdout line delivered after
    // 'close' from arming a fresh timer that outlives settle().
    const scheduleSigkill = () => {
      if (settled || graceTimer) return;
      graceTimer = setTimeout(() => requestGroupSignal('SIGKILL'), KILL_GRACE_MS);
      if (typeof graceTimer.unref === 'function') graceTimer.unref();
    };

    const requestGroupSignal = (sig) => {
      try {
        return killGroup(sig);
      } catch (err) {
        // Timer, AbortSignal, and process-signal callbacks must not throw an
        // uncaught exception. Reject with this exact signalling failure. A
        // second strict group probe would only throw again and could replace
        // the original error that explains why cleanup cannot be guaranteed.
        settle(() => reject(err), { cleanup: false });
        return false;
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (terminationCause === 'none') terminationCause = 'deadline';
      requestGroupSignal('SIGTERM');
      scheduleSigkill();
    }, timeoutSec * 1000);

    // Rate-limit watchdog: opencode retries a usage-limit failure silently
    // (nothing on stdout), so poll its log for a limit line newer than this
    // run's start and, on the first hit, record the reset time and kill the
    // engine group early rather than waiting out --timeout. Disabled when
    // sinceMs is absent (e.g. a caller that opted out).
    // Default scan honours the caller's logPath so tests never poll the
    // developer's real engine log (and never SIGTERM a fake pid on a match).
    const scan = scanRateLimit || ((since) => findRecentRateLimit(since, { logPath }));
    if (sinceMs != null && resolvedPollMs > 0) {
      pollTimer = setInterval(() => {
        if (settled || state.rateLimit) return;
        let info;
        try {
          info = scan(sinceMs);
        } catch {
          info = null;
        }
        if (info) {
          state.rateLimit = info;
          if (terminationCause === 'none') terminationCause = 'provider_rate_limit';
          requestGroupSignal('SIGTERM');
          scheduleSigkill();
        }
      }, resolvedPollMs);
      if (typeof pollTimer.unref === 'function') pollTimer.unref();
    }

    // The child is spawned `detached: true` so the timeout-kill above can
    // signal its whole process GROUP (negative PID), not just opencode's
    // immediate PID. But the timeout timer is not the only way this
    // process can end: a user hitting Ctrl-C (SIGINT) or a supervisor
    // sending SIGTERM ends the PARENT without touching the detached
    // child's group at all. OpenCode retries failed
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
      requestGroupSignal('SIGTERM');
      scheduleSigkill();
    };
    process.on('SIGINT', onHostSignal);
    process.on('SIGTERM', onHostSignal);

    const onAbort = () => {
      if (terminationCause === 'none') terminationCause = 'caller_abort';
      requestGroupSignal('SIGTERM');
      scheduleSigkill();
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    let executionSourcesArmed = true;
    const disarmExecutionSources = () => {
      if (!executionSourcesArmed) return;
      executionSourcesArmed = false;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      if (pollTimer) clearInterval(pollTimer);
      process.off('SIGINT', onHostSignal);
      process.off('SIGTERM', onHostSignal);
      abortSignal?.removeEventListener('abort', onAbort);
    };

    function settle(fn, { cleanup = true } = {}) {
      if (settled) return;
      settled = true;
      disarmExecutionSources();
      if (!cleanup) {
        fn();
        return;
      }
      void startResidualCleanup().then(fn, reject);
    }

    // A real ChildProcess emits exit before close. Start group cleanup in that
    // earlier callback, immediately after reap, instead of waiting for stdio
    // close and widening the chance that the numeric PID/PGID is recycled.
    // Test doubles that emit only close still use settle()'s safe fallback.
    child.on('exit', () => {
      if (settled) return;
      // The execution is over even if inherited stdio delays `close`. Disarm
      // deadline/cancellation callbacks before cleaning residual descendants,
      // so a successful exit cannot be relabelled as a timeout or signal a
      // re-used numeric PGID during that gap.
      disarmExecutionSources();
      void startResidualCleanup().catch((err) =>
        settle(() => reject(err), { cleanup: false }));
    });

    child.on('error', (err) => {
      // A ChildProcess error means the engine did not spawn successfully; do
      // not replace that exact diagnostic with a speculative group-cleanup
      // failure for a pid that may never have become a process leader.
      settle(() => reject(new Error(`Failed to spawn ${label}: ${err.message}`)), { cleanup: false });
    });

    if (child.stdout) {
      // Bounded line scanner (Invariant): readline buffers an entire line in
      // memory BEFORE emitting it, so one huge unterminated record could
      // exhaust memory before MAX_RECORD_BYTES ever fired. Here the pending
      // bytes are capped as they arrive; an unterminated oversized record
      // trips the same typed output-limit failure without being buffered.
      const feedLine = (line) => {
        // Bounded output accounting (Section 6.4): an oversized record or
        // cumulative stdout overflow is a typed engine failure that
        // terminates the sandbox-owned tree and completes normal cleanup.
        const lineBytes = Buffer.byteLength(line, 'utf8');
        totalStdoutBytes += lineBytes + 1;
        if (!outputLimitObserved && (lineBytes > MAX_RECORD_BYTES || totalStdoutBytes > MAX_TOTAL_STDOUT_BYTES)) {
          outputLimitObserved = true;
          requestGroupSignal('SIGTERM');
          scheduleSigkill();
        }
        const hadRateLimit = state.rateLimit;
        foldLine(state, line, {
          arrivedAt: Date.now(),
          onToolUse: (evt) => {
            const tool = evt.part?.tool || 'tool';
            const denied = evt.part?.state?.status === 'error';
            process.stderr.write(pc.dim(`  → ${tool}${denied ? ' (denied/error)' : ''}\n`));
          },
        });
        // Oversized public final_text is also a typed engine failure.
        if (
          !outputLimitObserved &&
          state.finalText != null &&
          Buffer.byteLength(state.finalText, 'utf8') > MAX_FINAL_TEXT_BYTES
        ) {
          outputLimitObserved = true;
          requestGroupSignal('SIGTERM');
          scheduleSigkill();
        }
        // A rate-limit error that DID reach stdout: kill early, same as the
        // log-poll path, so we don't wait out --timeout. Guard on `settled`
        // so a line buffered past 'close' can't signal a reaped/recycled pid.
        if (state.rateLimit && !hadRateLimit && !settled) {
          if (terminationCause === 'none') terminationCause = 'provider_rate_limit';
          requestGroupSignal('SIGTERM');
          scheduleSigkill();
        }
      };
      let pending = Buffer.alloc(0);
      child.stdout.on('data', (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        // Split on newlines WITHIN the chunk; a partial trailing line is the
        // only part carried over (concatenated at most once per emitted
        // line), so the scan is linear in total bytes — never a full
        // re-concat of the pending buffer on every chunk.
        let start = 0;
        let newlineAt;
        while ((newlineAt = buf.indexOf(0x0a, start)) !== -1) {
          const lineBuf = pending.length
            ? Buffer.concat([pending, buf.subarray(start, newlineAt)])
            : buf.subarray(start, newlineAt);
          pending = Buffer.alloc(0);
          start = newlineAt + 1;
          feedLine(lineBuf.toString('utf8'));
        }
        const tail = buf.subarray(start);
        if (tail.length) {
          pending = pending.length ? Buffer.concat([pending, tail]) : Buffer.from(tail);
        }
        // An unterminated record already above the cap is dropped without
        // being buffered: the typed failure fires and the drain continues.
        if (pending.length > MAX_RECORD_BYTES) {
          if (!outputLimitObserved) {
            outputLimitObserved = true;
            requestGroupSignal('SIGTERM');
            scheduleSigkill();
          }
          pending = Buffer.alloc(0);
        }
      });
      child.stdout.on('end', () => {
        if (pending.length && pending.length <= MAX_RECORD_BYTES) {
          const line = pending.toString('utf8');
          pending = Buffer.alloc(0);
          feedLine(line);
        }
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderrTail += chunk.toString('utf8');
        if (Buffer.byteLength(stderrTail, 'utf8') > MAX_STDERR_TAIL_BYTES) {
          stderrTail = stderrTail.slice(-MAX_STDERR_TAIL_BYTES);
        }
      });
    }

    child.on('close', (code, signal) => {
      settle(() =>
        resolve({
          code,
          signal,
          timedOut,
          terminationCause,
          outputLimitObserved,
          stderrTail,
          ...state,
        }),
      );
    });
  });
}

// ─── Crush spawn and flow ────────────────────────────────────────────────────
//
// spawnCrush mirrors spawnEngine's process-management (detached process group,
// timeout, SIGTERM->SIGKILL escalation, host SIGINT/SIGTERM forwarding) but for
// crush's single-envelope output model: NO ndjson fold, NO rate-limit log
// polling (crush has its own --timeout that preserves the partial answer and
// does not retry a failing call forever). Crush writes the whole JSON envelope
// at end-of-run, so stdout is
// buffered fully and parsed once on close.

function spawnCrush({
  argv,
  env,
  timeoutSec,
  spawnFn,
  abortSignal,
  killProcess = process.kill.bind(process),
  residualTermGraceMs = RESIDUAL_GROUP_TERM_GRACE_MS,
  residualKillWaitMs = RESIDUAL_GROUP_KILL_WAIT_MS,
  processGroupPollMs = PROCESS_GROUP_POLL_MS,
}) {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error('Crush run was cancelled before the engine started.'));
      return;
    }
    let child;
    try {
      child = spawnFn('crush', argv, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
    } catch (err) {
      reject(new Error(`Failed to spawn crush: ${err.message}`));
      return;
    }

    let settled = false;
    let timedOut = false;
    let graceTimer = null;
    let residualCleanupPromise = null;
    const stdoutChunks = [];
    // crush emits ONE JSON envelope at end of run, so stdout is buffered —
    // but boundedly: past the cap the run is a typed engine failure (the
    // envelope contract caps the output well below this), never unbounded
    // memory growth.
    const CRUSH_STDOUT_MAX_BYTES = 16 * 1024 * 1024;
    let crushStdoutBytes = 0;
    let crushStdoutOverflow = false;
    // First termination cause wins and is recorded BEFORE sending any signal
    // (Section 6.1), so a child that exits zero still reports `killed` with
    // the right cause.
    let terminationCause = 'none';
    // Private stderr retention is a bounded 64 KiB tail (Section 6.4).
    const MAX_STDERR_TAIL_BYTES = 64 * 1024;
    let stderrTail = '';

    const killGroup = (sig) =>
      killProcessGroup(child.pid, sig, killProcess, { strict: true, label: 'Crush' });

    const waitForGroupExit = async (maxMs) => {
      const deadline = Date.now() + Math.max(0, maxMs);
      while (killGroup(0)) {
        if (Date.now() >= deadline) return false;
        await new Promise((done) => setTimeout(done, Math.max(1, processGroupPollMs)));
      }
      return true;
    };

    const terminateResidualGroup = async () => {
      if (!killGroup('SIGTERM')) return;
      if (await waitForGroupExit(residualTermGraceMs)) return;
      if (!killGroup('SIGKILL')) return;
      if (!(await waitForGroupExit(residualKillWaitMs))) {
        throw new Error(
          `Crush process group ${child.pid} remained alive after SIGKILL; refusing to report completion.`,
        );
      }
    };

    const startResidualCleanup = () => {
      if (!residualCleanupPromise) {
        residualCleanupPromise = terminateResidualGroup();
        void residualCleanupPromise.catch(() => {});
      }
      return residualCleanupPromise;
    };

    // Same SIGKILL-once guard as spawnEngine: timeout, host/caller
    // cancellation, and error paths can all send SIGTERM.
    const scheduleSigkill = () => {
      if (settled || graceTimer) return;
      graceTimer = setTimeout(() => requestGroupSignal('SIGKILL'), KILL_GRACE_MS);
      if (typeof graceTimer.unref === 'function') graceTimer.unref();
    };

    const requestGroupSignal = (sig) => {
      try {
        return killGroup(sig);
      } catch (err) {
        settle(() => reject(err), { cleanup: false });
        return false;
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      if (terminationCause === 'none') terminationCause = 'deadline';
      requestGroupSignal('SIGTERM');
      scheduleSigkill();
    }, timeoutSec * 1000);

    // Forward host SIGINT/SIGTERM to the child's process group ONLY — never
    // touch the host (same rationale as spawnEngine; this also runs inside the
    // long-lived MCP server). Removed on settle so a host handling many crush
    // runs doesn't accumulate one listener pair per call.
    const onHostSignal = () => {
      if (terminationCause === 'none') terminationCause = 'host_signal';
      requestGroupSignal('SIGTERM');
      scheduleSigkill();
    };
    process.on('SIGINT', onHostSignal);
    process.on('SIGTERM', onHostSignal);

    const onAbort = () => {
      if (terminationCause === 'none') terminationCause = 'caller_abort';
      requestGroupSignal('SIGTERM');
      scheduleSigkill();
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    let executionSourcesArmed = true;
    const disarmExecutionSources = () => {
      if (!executionSourcesArmed) return;
      executionSourcesArmed = false;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      process.off('SIGINT', onHostSignal);
      process.off('SIGTERM', onHostSignal);
      abortSignal?.removeEventListener('abort', onAbort);
    };

    function settle(fn, { cleanup = true } = {}) {
      if (settled) return;
      settled = true;
      disarmExecutionSources();
      if (!cleanup) {
        fn();
        return;
      }
      void startResidualCleanup().then(fn, reject);
    }

    child.on('exit', () => {
      if (settled) return;
      disarmExecutionSources();
      void startResidualCleanup().catch((err) =>
        settle(() => reject(err), { cleanup: false }));
    });

    child.on('error', (err) =>
      settle(() => reject(new Error(`Failed to spawn crush: ${err.message}`)), { cleanup: false }));

    // crush emits the whole envelope at end-of-run, so buffer stdout fully
    // (parseEnvelope takes the last non-empty line on close).
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        crushStdoutBytes += bytes;
        if (crushStdoutBytes > CRUSH_STDOUT_MAX_BYTES) {
          if (!crushStdoutOverflow) {
            crushStdoutOverflow = true;
            if (terminationCause === 'none') terminationCause = 'output_limit';
            killGroup('SIGTERM');
            scheduleSigkill();
          }
          return; // stop buffering past the cap
        }
        stdoutChunks.push(chunk);
      });
    }
    // stderr is captured for the error-tail on the throw path; NOT forwarded
    // live — crush's WARN noise + `▶ <tool>` heartbeats would interleave with
    // this module's own dim stderr logs (a later step can forward it dimmed).
    // Retention is a bounded 64 KiB tail (Section 6.4), never an unbounded
    // array.
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderrTail += chunk.toString('utf8');
        if (Buffer.byteLength(stderrTail, 'utf8') > MAX_STDERR_TAIL_BYTES) {
          stderrTail = stderrTail.slice(-MAX_STDERR_TAIL_BYTES);
        }
      });
    }

    child.on('close', (code, signal) => {
      settle(() =>
        resolve({
          code,
          signal,
          timedOut,
          terminationCause,
          stdout: stdoutChunks.join(''),
          stderrTail,
        }),
      );
    });
  });
}

// runCrushFlow: the crush run path, branched out of runCoderRun. Builds the
// triss envelope from crush's single-JSON output, reusing the EXISTING
// engine-agnostic isolation helpers (setupIsolation ran in runCoderRun before
// this; computeWorktreeChanges / cleanupAbandonedIsolation / gitWorktreeRemove
// / gitBranchDeleteSafe are called here for the teardown). Emits the SAME
// envelope shape as the opencode path so callers are engine-agnostic.
async function runCrushFlow({
  opts,
  deps,
  sh,
  spawnFn,
  killProcess,
  prompt,
  isolate: _isolate,
  isolation,
  slug,
  timeoutSec,
  credentialProxy = null,
  sessionV2 = null,
  credentialMode = 'protected_proxy',
}) {
  let crushSpawnStartMs;
  const modelOverride = opts.model || null;
  const allowBestEffortCallerWorktree = opts.allowBestEffortCallerWorktree === true;
  const isolate = _isolate;
  // crush sessions are native get-or-create with caller-supplied ids — pass the
  // slug straight through (NO .triss/sessions.json map, unlike opencode).
  const session = slug || opts.session || null;
  const dir = isolation ? isolation.wtPath : opts.cwd ? resolvePath(opts.cwd) : null;

  // restrict tristate resolution is crush-only (opencode's safety layer is its
  // opencode.json bash policy, not a restrict flag). CLI --restrict/--no-restrict
  // > TRISS_CODER_CRUSH_RESTRICT env > crush.json permissions.run.restrict >
  // built-in default (OFF, interim). When ON, buildCrushRunArgv emits the
  // allowlist as CLI flags (the only enforcement path that works today).
  const restrict = resolveCrushRestrict(opts);

  const argv = crushEngine.buildRunArgv({
    prompt,
    model: modelOverride, // only when an explicit override is given
    session,
    continue: !!opts.continue,
    cwd: dir,
    timeoutSec,
    maxTokens: opts.maxTokens,
    restrict,
  });
  const env = crushEngine.buildSpawnEnv(
    undefined,
    credentialProxy
      ? { token: credentialProxy.token, baseUrl: credentialProxy.scopedBaseUrl }
      : deps.proxy || null,
  );

  // Version detect: crush 0.1.3+ reports a clean semver, so detect() now
  // parses it and returns satisfiesPin. NON-FATAL: a mismatch warns yellow
  // and the run continues (the restrict-run policy still applies via crush.json).
  const det = crushEngine.detect(sh);
  const engineVersion = det.version || crushEngine.CRUSH_PIN;
  if (det.found && det.version) {
    if (det.satisfiesPin) {
      process.stderr.write(pc.dim(`  · crush ${det.version} (matches pin ${crushEngine.CRUSH_PIN})\n`));
    } else {
      process.stderr.write(
        pc.yellow(
          `  ⚠ crush ${det.version} found, pinned version is ${crushEngine.CRUSH_PIN} ` +
            '(not auto-upgrading)\n',
        ),
      );
    }
  }

  process.stderr.write(
    pc.dim(
      '[coder run] engine=crush' +
        (modelOverride ? ` model=${modelOverride}` : '') +
        (isolation ? ` isolate=${isolation.wtPath}` : '') +
        '\n',
    ),
  );

  // Outer SIGTERM backstop. crush's own --timeout (passed above) fires FIRST
  // and preserves the partial answer in the envelope; this outer kill only
  // triggers if crush hung past its own timeout. +5s grace so crush's graceful
  // exit wins the race and we don't truncate the JSON line mid-write (which
  // would land in the "nothing parseable -> throw" path needlessly).
  const outerTimeoutSec = timeoutSec + 5;

  let result;
  try {
    crushSpawnStartMs = Date.now();
    result = await spawnCrush({
      argv,
      env,
      timeoutSec: outerTimeoutSec,
      spawnFn,
      abortSignal: deps.abortSignal,
      killProcess,
      residualTermGraceMs: deps.residualTermGraceMs,
      residualKillWaitMs: deps.residualKillWaitMs,
      processGroupPollMs: deps.processGroupPollMs,
    });
  } catch (err) {
    if (isolation && isolation.freshlyCreated) cleanupAbandonedIsolation(sh, isolation);
    throw err;
  }

  const parsed = crushEngine.parseEnvelope(result.stdout);
  if (!parsed) {
    // Nothing parseable on stdout -> throw a plain Error (envelope-vs-throw
    // split, identical to the opencode path). Clean up a freshly-created empty
    // worktree first so it doesn't leak.
    if (isolation && isolation.freshlyCreated) cleanupAbandonedIsolation(sh, isolation);
    const tailLines = result.stderrTail.trim().split('\n').filter(Boolean).slice(-20);
    const detail = tailLines.length ? `\nLast stderr:\n${tailLines.join('\n')}` : '';
    throw new Error(
      `crush produced no parseable output (exit ${result.code ?? 'null'}` +
        `${result.signal ? `, signal ${result.signal}` : ''}).${detail}`,
    );
  }

  const warnings = [];
  if (allowBestEffortCallerWorktree && !isolation && isolate) warnings.push(`${ISOLATION_DOWNGRADED_CODE}: isolation unavailable — downgraded to caller worktree (best-effort; edits may reach current Git worktree)`);
  if (parsed.error) warnings.push(`crush error: ${parsed.error}`);

  // crush reports a COMBINED delta_tokens, never split prompt/completion (unlike
  // opencode's per-step input/output). The canonical tokens shape keeps every
  // split null and puts delta_tokens in combined/total; flag the split as
  // unavailable so the run is still accounted without pretending to a split.
  const normalizedUsage = normalizeCrushUsage(parsed.usage);
  const {
    tokens,
    reported_total_usd,
    reported_total_source,
    usage_status,
    warnings: normalizeWarnings,
  } = normalizedUsage;
  if (normalizeWarnings.length) warnings.push(...normalizeWarnings);
  const deltaTokens = tokens.combined ?? 0;
  warnings.push(
    'crush reports combined token count only (delta_tokens); prompt/completion split unavailable',
  );

  // exit_reason: our outer timeout/signal wins over the envelope's reported
  // reason (we know definitively we killed it); otherwise map crush's
  // vocabulary onto the triss envelope vocabulary.
  let exit_reason;
  if (result.timedOut) exit_reason = 'timeout';
  else if (result.signal) exit_reason = 'killed';
  else exit_reason = crushEngine.mapExitReason(parsed.exit_reason).triss;

  // Isolation teardown — engine-agnostic, same helpers/logic as the opencode
  // path: stage everything, integrity-check seeded config, auto-remove a
  // zero-diff worktree + its branch.
  // v2 contract: files_changed is [] ONLY for a successfully performed
  // comparison that found nothing; a run with no comparison (non-isolated)
  // reports null — never a fabricated empty list.
  let filesChanged = null;
  let diffStat = null;
  let worktreeOut = null;
  if (isolation) {
    const changes = computeWorktreeChanges(sh, isolation.repoRoot, isolation.wtPath);
    if (changes.warnings.length) warnings.push(...changes.warnings);
    // The comparison was PERFORMED: [] is the honest result for a verified
    // empty change (null stays reserved for no-comparison runs).
    filesChanged = changes.filesChanged;
    if (changes.filesChanged.length === 0) {
      try {
        gitWorktreeRemove(sh, isolation.repoRoot, isolation.wtPath, { force: true });
        if (isolation.branch.startsWith(CODER_BRANCH_PREFIX)) {
          const branchDeleted = gitBranchDeleteSafe(sh, isolation.repoRoot, isolation.branch);
          if (!branchDeleted) {
            warnings.push(
              `branch ${isolation.branch} kept — not fully merged; a future --isolate --session ` +
                '<slug> reusing this slug will fail until it\'s removed (see `triss coder clean --all`)',
            );
          }
        }
      } catch (err) {
        warnings.push(`isolate cleanup failed: ${err.message}`);
      }
    } else {
      diffStat = changes.diffStat;
      worktreeOut = isolation.wtPath;
    }
  }

  // Usage accounting — canonical v2 form. crush reports a REAL, complete
  // per-call cost straight from the engine (unlike opencode's catalogue-derived
  // cost, whose zero proves nothing), so the canonical estimate trusts it in
  // full, including an explicit 0.
  const crushCost = estimateCanonicalCost({
    billing_model: 'crush',
    billing_mode: 'unknown',
    tokens,
    reported_total_usd,
    reported_total_source,
    usage_source: 'crush',
  });
  const ctx = currentCall();
  // An explicit model replaces the stable 'crush' sentinel for pricing. The
  // sentinel is kept only when no model identity is known, and it is never
  // eligible for a component price estimate (see estimateCanonicalCost).
  const crushBillingModel = modelOverride || 'crush';
  const logUsageFn = deps.logUsage || logUsage;
  logUsageFn({
    model: modelOverride || 'crush',
    billing_model: crushBillingModel,
    billing_mode: 'unknown',
    // The schema documents Crush runs as Z.AI (provider `zai`, engine
    // `crush`). The `crush` sentinel model has no provider prefix for
    // resolveProvider to read, so the provider must be forwarded explicitly.
    provider: 'zai',
    usage_source: 'crush',
    engine: 'crush',
    usage_status,
    tokens,
    cost: crushCost,
    label: 'coder',
    call_id: ctx?.callId,
    parent_call_id: ctx?.parentCallId,
  });

  // Run-identity invariant: allocate the v2 identity from the actual run
  // facts — anonymous runs get anon-<32hex>; retention requires the full
  // eligibility matrix (isolated + changed + enforced quota + reservation).
  const runIdentity = allocateRunIdentity({
    slug: session || null,
    isolated: !!isolation,
    changed: (filesChanged || []).length > 0,
  });

  // Finalization MUST precede lifecycle derivation and envelope assembly.
  // Admission is not persistence evidence; only a confirmed typed outcome may
  // authorize session_persistence=persistent.
  const completionOutcome = await completeV2SessionRow(sessionV2, parsed.session_id);
  if (completionOutcome === 'retained_for_recovery') {
    throw new Error('coder-session: completion retained row for recovery — refusing to emit a clean envelope');
  }
  if (completionOutcome === 'removed_unusable' && sessionV2) {
    warnings.push('TRISS_CODER_SESSION_NOT_RESUMABLE: native session id was not confirmed; persistent row removed');
  }

  // v2 lifecycle fields (Section 6.1/6.2): honest derivations from the
  // observed crush facts; crush exposes no per-event activity stream, so
  // tool activity is derived from its tool_calls array.
  const v2Lifecycle = deriveV2LifecycleFields({
    timedOut: result.timedOut,
    terminationCause: result.terminationCause,
    signal: result.signal,
    exitCode: result.code,
    engineErrorObserved: Boolean(parsed.error),
    rateLimited: exit_reason === 'error' && /rate/i.test(String(parsed.error || '')),
    exitReason: exit_reason,
    finalText: parsed.final_text,
    toolActivityCount: Array.isArray(parsed.tool_calls)
      ? parsed.tool_calls.filter((c) => c && (c.count ?? 1) > 0).length
      : 0,
    isolated: !!isolation,
    callerWorktreeDowngrade: allowBestEffortCallerWorktree && !isolation && isolate,
    sessionRequested: Boolean(session),
    v2SessionAdmitted: sessionV2 != null,
    completionOutcome,
  });
  const finishedAtMs = Date.now();

  const envelope = {
    engine: 'crush',
    envelope_version: 2,
    engine_version: engineVersion,
    session_id: parsed.session_id || null,
    // component: every safe envelope carries the run identity + honest
    // execution capabilities (Section 6.3 / documented contract).
    ...runIdentity,
    execution_capabilities: buildExecutionCapabilities({
      engine: 'crush',
      proxyAvailable: !!credentialProxy,
      credentialMode,
    }),
    ...v2Lifecycle,
    run_id: `run_${randomBytes(16).toString('hex')}`,
    started_at: new Date(crushSpawnStartMs).toISOString(),
    finished_at: new Date(finishedAtMs).toISOString(),
    duration_ms: finishedAtMs - crushSpawnStartMs,
    activity: {
      events: 0,
      tool_calls: Array.isArray(parsed.tool_calls) ? parsed.tool_calls.length : 0,
      tool_errors: 0,
      by_tool: {},
      saw_terminal_stop: exit_reason === 'end_turn',
      first_event_at: null,
      last_event_at: null,
    },
    exit_reason,
    final_text: parsed.final_text ?? null,
    files_changed: filesChanged,
    run_files_changed: filesChanged,
    diff_stat: diffStat,
    worktree: worktreeOut,
    usage: {
      schema_version: 2,
      usage_status,
      tokens,
      cost: crushCost,
      // Deprecated aliases keep crush's existing meaning: prompt 0, and the
      // combined delta_tokens carried as completion_tokens.
      prompt_tokens: 0,
      completion_tokens: deltaTokens,
      // crush reports REAL per-call cost (unlike opencode's coding-plan
      // cost:0). Preserved verbatim for current consumers.
      cost_usd: crushCost.total_usd ?? null,
    },
    warnings,
  };

  // Injectable so tests don't have to monkey-patch process.stdout.write
  // (same reason as the opencode path — see comment there).
  const writeStdout = deps.stdoutWrite || ((s) => process.stdout.write(s));
  writeStdout(JSON.stringify(envelope) + '\n');
  return { completionOutcome };
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

function resolveSlug(opts, isolate) {
  if (opts.session) {
    if (!SLUG_PATTERN.test(opts.session)) {
      throw new Error(
        `--session "${opts.session}" is invalid — slugs must match ${SLUG_PATTERN} ` +
          '(letters, digits, underscore, hyphen; max 64 chars; no path separators).',
      );
    }
    return opts.session;
  }
  if (isolate) return randomSlug();
  return null;
}

// ─── runCoderRun ─────────────────────────────────────────────────────────────────

export function validateCoderRunOptions(opts = {}, { prompt } = {}) {
  const engine = resolveCoderEngine(opts);
  const maxTokens = opts.maxTokens === undefined
    ? undefined
    : positiveIntegerOption(opts.maxTokens, '--max-tokens');
  if (maxTokens !== undefined && engine !== 'crush') {
    throw new Error(
      '--max-tokens for coder runs requires --engine crush; OpenCode exposes no per-run token-budget flag.',
    );
  }
  if (!opts.stdin && !prompt) {
    throw new Error('Pass a prompt as argument or via --stdin');
  }
  if (opts.session && !SLUG_PATTERN.test(opts.session)) {
    throw new Error(
      `--session "${opts.session}" is invalid — slugs must match ${SLUG_PATTERN} ` +
      '(letters, digits, underscore, hyphen; max 64 chars; no path separators).',
    );
  }
  const isolate = opts.isolate === undefined ? engine === 'crush' : !!opts.isolate;
  // shared contract: an isolation downgrade to a best-effort CALLER
  // worktree is opt-in only. Without the explicit flag the run fails before
  // spawn when the enforced sandbox is unavailable (fail closed).
  const allowBestEffortCallerWorktree = opts.allowBestEffortCallerWorktree === true;
  if (allowBestEffortCallerWorktree && !isolate) {
    throw new Error(
      'allowBestEffortCallerWorktree is only meaningful with isolation enabled (it downgrades an isolated run to a caller worktree).',
    );
  }
  if (opts.continue && isolate && !opts.session) {
    throw new Error(
      '--continue with --isolate requires --session <id> — without it, --isolate creates a new ' +
        'worktree/branch while --continue tries to resume an unrelated previous session. Pass the ' +
        'same --session slug you used to start that session.',
    );
  }
  const modelOverride = opts.model || null;
  if (opts.smallModel && !opts.provider) {
    throw new Error(
      '--small-model requires --provider <name> (MCP: small_model requires provider) — without an explicit provider, --model keeps its legacy main-only semantics.',
    );
  }
  let oneShotProvider = null;
  let oneShotSmallModel = null;
  if (opts.provider) {
    if (engine === 'crush') {
      throw new Error('--provider and --small-model are OpenCode-only; Crush remains fixed to Z.AI GLM.');
    }
    if (!modelOverride) {
      throw new Error(
        '--provider requires --model <provider/model> (MCP: provider requires model) so the one-shot model and Z.AI plan are explicit.',
      );
    }
    oneShotProvider = normalizeProviderFlag(opts.provider);
    oneShotSmallModel = opts.smallModel || modelOverride;
    for (const [flag, value] of [
      ['--model (MCP: model)', modelOverride],
      ['--small-model (MCP: small_model)', oneShotSmallModel],
    ]) {
      if (!isQualifiedProviderModel(value)) {
        throw new Error(
          `${flag} must be a non-empty provider-qualified model (<provider>/<id>) without whitespace.`,
        );
      }
      if (!isKnownProviderPrefix(value)) {
        throw new Error(
          `${flag} "${value}" must use a known provider prefix for a one-shot provider run.`,
        );
      }
      const actualProvider = coderModelCredential(value).provider;
      if (actualProvider !== oneShotProvider) {
        throw new Error(`${flag} "${value}" does not belong to provider "${oneShotProvider}".`);
      }
    }
    if (String(modelOverride).split('/')[0] !== String(oneShotSmallModel).split('/')[0]) {
      throw new Error(
        `--model and --small-model must use the same provider prefix for a one-shot run ` +
          `(got "${String(modelOverride).split('/')[0]}" and "${String(oneShotSmallModel).split('/')[0]}").`,
      );
    }
  }
  if (engine === 'crush' && modelOverride && coderModelCredential(modelOverride).env !== 'ZHIPU_API_KEY') {
    throw new Error(
      `The crush engine speaks Z.AI GLM only — it cannot run the non-GLM model "${modelOverride}". ` +
        'Use the opencode engine (drop --engine crush) for triss-worker/*, opencode/*, opencode-go/*, moonshotai/*, or ' +
        'kimi-for-coding/* models, or choose a GLM model.',
    );
  }
  const timeoutSec = positiveNumberOption(opts.timeout, '--timeout', 900);
  return {
    engine,
    maxTokens,
    isolate,
    modelOverride,
    oneShotProvider,
    oneShotSmallModel,
    smallModelUnused: engine === 'opencode2' && Boolean(opts.smallModel),
    timeoutSec,
  };
}

// ─── v2 session lifecycle wiring ──────────────────────────────────────────────
// The production run reserves a v2 session row BEFORE spawn, marks it
// running, and completes it to idle (or deletes it on failure), so the
// `coder session list|clean` commands finally observe REAL runs instead of
// only rows created by direct store tests. Store failures degrade to a dim
// warning — the legacy .triss/sessions.json map stays authoritative for
// continuation until persistent sessions become eligibility-enforced.

export function currentBootIdentity({
  platform = process.platform,
  readFile = readFileSync,
  spawnSync = nodeSpawnSync,
} = {}) {
  if (platform === 'linux') {
    try {
      const value = readFile('/proc/sys/kernel/random/boot_id', 'utf8').trim().toLowerCase();
      return /^[0-9a-f-]{36}$/.test(value) ? `linux:${value}` : null;
    } catch {
      return null;
    }
  }
  if (platform === 'darwin') {
    try {
      // Fixed absolute binary + minimal fixed environment: a boot-identity
      // probe must never forward the parent process.env (which can carry
      // credentials loaded from project env files) to a PATH-resolved
      // subprocess. A missing binary degrades to null -> explicit ephemeral
      // downgrade by the caller.
      const result = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1_000,
        env: { TZ: 'UTC', LC_ALL: 'C' },
      });
      if (result.status !== 0) return null;
      const match = /sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/.exec(result.stdout || '');
      return match ? `darwin:${match[1]}:${match[2]}` : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function currentSessionOwnerTuple(overrides = {}) {
  const pid = overrides.pid ?? process.pid;
  const processStartId = overrides.processStartId ?? processStartIdentity(pid);
  const bootId = overrides.bootId ?? currentBootIdentity();
  if (!Number.isInteger(pid) || pid <= 0 || !processStartId || !bootId) {
    throw new Error('coder-session: current process owner identity is unavailable');
  }
  return { pid, processStartId, bootId };
}

function storeInvalidError(detail) {
  const error = new Error(`coder-session: canonical store unusable — ${detail} (retain, fail closed)`);
  error.code = CODER_SESSION_STORE_INVALID_CODE;
  return error;
}

// Two FIRST-EVER runs in one project may race the identity file creation
// (exclusive create); the loser re-opens what the winner wrote — same id.
async function loadProjectIdentityWithRaceRetry(trissRoot, attempts = 3) {
  const { loadOrCreateProjectIdentity } = await import('../coder-state.js');
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await loadOrCreateProjectIdentity(trissRoot);
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      lastError = err;
    }
  }
  throw lastError;
}

// Lowest lock slot not held by a live (reserved/running) or cleanup
// (deleting) row. Idle rows hold no live run, so their stored slot is free.
function pickFreeLockSlot(entries) {
  const liveSlots = new Set(
    entries
      .filter((e) => ['reserved', 'running', 'deleting'].includes(e.state))
      .map((e) => e.lock_slot),
  );
  for (const slot of [0, 1, 2, 3]) {
    if (!liveSlots.has(slot)) return slot;
  }
  throw new Error('coder-session: no free lock slot among live session rows');
}

// True iff the row's complete owner tuple is EXACTLY this run cycle's —
// including the IMMUTABLE session_instance_id minted at THIS admission. A
// same-slug replacement row (new incarnation, even with a coinciding
// millisecond created_at) never matches.
function rowOwnedByRun(row, sessionV2) {
  return Boolean(row)
    && row.run_id === sessionV2.runId
    && row.sandbox_id === sessionV2.sandboxId
    && row.pid === sessionV2.pid
    && row.process_start_id === sessionV2.processStartId
    && row.boot_id === sessionV2.bootId
    && row.session_instance_id === sessionV2.instanceId;
}

export async function reserveV2SessionRow({ engine, slug, isolated, ownerTuple }) {
  // Only REAL slugs are wired in v1 of this integration: the anonymous slug
  // is allocated later in the flow, and reserving an unnamed row adds
  // pre-spawn awaits (dynamic import + mkdir) that shift abort-test timing
  // without producing a continuable session anyway.
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) {
    return null;
  }
  let owner;
  try {
    owner = currentSessionOwnerTuple(ownerTuple);
  } catch (err) {
    // The ONLY sanctioned degradation: without both host identities no
    // canonical row may be published (contract) — degrade explicitly and let
    // the engine run stay ephemeral. Every other admission failure below is
    // a typed fail-closed error, never a silent downgrade.
    process.stderr.write(pc.dim(`  ⚠ v2 session store unavailable: ${err.message}\n`));
    return null;
  }

  const transitions = await import('../coder-session-transitions.js');
  const {
    reserveCoderSession,
    markCoderSessionRunning,
    sessionInventoryPath,
  } = transitions;
  const { readCoderSessionInventory } = await import('../coder-session-inventory-codec.js');
  const { projectRootFingerprint } = await import('../coder-state.js');
  const { mkdir } = await import('node:fs/promises');
  const trissRoot = join(projectRoot(), '.triss');
  const inventoryDir = sessionInventoryPath(trissRoot, engine);
  await mkdir(inventoryDir, { recursive: true, mode: 0o700 });
  const identity = await loadProjectIdentityWithRaceRetry(trissRoot);
  const fingerprint = projectRootFingerprint(identity.project_id);
  const runId = `run_${randomBytes(16).toString('hex')}`;
  const sandboxId = `sbx_${randomBytes(16).toString('hex')}`;
  const requestedIsolationMode = isolated ? 'isolated' : 'non_isolated';
  const parentHandle = await openManagedTrissRoot(projectRoot());

  // Production admission runs under the RUN LEASE: ONE shared maintenance
  // scope covering the whole cycle, conditional-target lease for
  // non-isolated runs, assigned slot lease, and brief exclusive inventory
  // scopes (normative hierarchy; release is strictly reverse). Concurrent
  // same-slug admissions serialize so the loser observes a live row instead
  // of clobbering it; non-isolated runs serialize on the target lease.
  let resumedRealId = null;
  const runLease = await acquireCoderSessionRunLease({
    parentHandle,
    isolationMode: isolated ? 'isolated' : 'non-isolated',
    selectLockSlot: async () => {
      // Plain snapshot read (atomic-rename file): selection only — the
      // authoritative re-check happens under the exclusive inventory lock.
      const pre = await readCoderSessionInventory(inventoryDir);
      if (pre.error) throw storeInvalidError(pre.error);
      return pickFreeLockSlot(pre.entries);
    },
    classifyAndWrite: async (lockSlot) => {
      // Exclusive inventory: classify against FRESH state. Only an idle
      // row may continue; reserved/running is busy and deleting is cleanup
      // in progress — none of those states may degrade to "store
      // unavailable, continue anyway".
      const read = await readCoderSessionInventory(inventoryDir);
      if (read.error) throw storeInvalidError(read.error);
      const liveSlots = new Set(
        read.entries
          .filter((e) => ['reserved', 'running', 'deleting'].includes(e.state))
          .map((e) => e.lock_slot),
      );
      if (liveSlots.has(lockSlot)) return { retake: true };
      const existing = read.entries.find((e) => e.engine === engine && e.slug === slug);
      if (!existing) {
        // A NEW reservation must never silently adopt an ORPHAN durable
        // mapping (slug -> realId with no inventory row): binding a fresh row
        // to a foreign/old native conversation would make the next
        // "continuation" resume somebody else's session. Only an ABSENT
        // mapping admits brand-new state; anything present/malformed retains
        // and fails closed.
        if (SESSION_STORE_ENGINES.includes(engine)) {
          const orphan = classifySessionStoreMapping(engine, slug);
          // An UNREADABLE store must surface its real corruption diagnostic
          // (unknown version, invalid JSON, …) rather than the orphan label.
          if (orphan.unreadable) {
            throw storeInvalidError(orphan.cause?.message ?? 'session store unreadable');
          }
          if (orphan.state !== 'absent') {
            const error = new Error(
              `coder-session: ${engine}/${slug} has a durable session mapping but NO inventory row — ` +
                'orphaned state; restore from backup or repair manually. Retain, fail closed.',
            );
            error.code = CODER_SESSION_STORE_INVALID_CODE;
            throw error;
          }
        }
        const row = await reserveCoderSession({
          inventoryDir,
          engine,
          slug,
          isolationMode: requestedIsolationMode,
          lockSlot,
          runId,
          sandboxId,
          ...owner,
          projectRootFingerprint: fingerprint,
        });
        return { result: { origin: 'new_reservation', row } };
      }
      if (existing.state !== 'idle') {
        const error = new Error(
          `coder-session: ${engine}/${slug} is ${existing.state} — another run owns it or` +
          ' cleanup is in progress; wait for it to finish, clean it, or choose another slug.',
        );
        error.code = CODER_SESSION_BUSY_CODE;
        throw error;
      }
      // Continuation compatibility BEFORE idle -> running: isolation mode
      // and project ownership are part of session ownership — silently
      // running an idle row under a different mode would make the
      // inventory lie about how this spawn actually executes.
      if (existing.isolation_mode !== requestedIsolationMode) {
        const error = new Error(
          `coder-session: ${engine}/${slug} was created isolation_mode=${existing.isolation_mode};` +
          ` this run requests ${requestedIsolationMode}. Isolation mode is part of session ownership —` +
          ' clean the session (triss coder session clean ...) or use a different slug.',
        );
        error.code = CODER_SESSION_INCOMPATIBLE_CODE;
        throw error;
      }
      if (existing.project_root_fingerprint !== fingerprint) {
        const error = new Error(
          `coder-session: ${engine}/${slug} belongs to a different project identity — refusing to continue it`,
        );
        error.code = CODER_SESSION_INCOMPATIBLE_CODE;
        throw error;
      }
      // A continuation MUST have a durable published mapping: without it the
      // native conversation does not exist and this run would silently start
      // a NEW conversation while claiming to resume.
      const mapping = classifySessionStoreMapping(engine, slug);
      if (mapping.state === 'absent') {
        const error = new Error(
          `coder-session: ${engine}/${slug} has NO published session mapping — nothing to continue.` +
          ' Clean the stale row (triss coder session clean ...) or start a fresh slug.',
        );
        error.code = CODER_SESSION_INCOMPATIBLE_CODE;
        throw error;
      }
      if (mapping.state === 'mismatch') {
        const error = new Error(
          `coder-session: ${engine}/${slug} has a malformed/unreadable session mapping — retain, fail closed.`,
        );
        error.code = CODER_SESSION_STORE_INVALID_CODE;
        throw error;
      }
      resumedRealId = mapping.realId;
      const row = await markCoderSessionRunning({
        inventoryDir,
        engine,
        slug,
        runId,
        sandboxId,
        lockSlot,
        ...owner,
      });
      return { result: { origin: 'idle_continuation', row } };
    },
  });

  const admission = runLease.admission || {};
  const sessionV2 = {
    inventoryDir,
    engine,
    slug,
    runId,
    sandboxId: admission.row ? admission.row.sandbox_id : sandboxId,
    origin: admission.origin,
    lockSlot: runLease.lockSlot,
    // Immutable incarnation identity pinned from the admitted row: every
    // later owner revalidation compares THIS value, never timestamps.
    instanceId: admission.row ? admission.row.session_instance_id : null,
    resumedRealId,
    ...owner,
    runLease,
    // Convenience for tests/tools: releasing the run cycle lease releases
    // slot -> target -> maintenance strictly in reverse acquisition order.
    releaseRunLease: () => runLease.release(),
  };
  return sessionV2;
}

/**
 * Pre-spawn revalidation under the HELD run lease (brief exclusive inventory
 * only — maintenance/target/slot stay held; nothing higher is reacquired):
 * the exact claimed row must still exist and be ours. A fresh reserved row
 * (this run between admission and spawn) transitions reserved -> running
 * HERE; an already running row must carry EXACTLY this run cycle owner
 * tuple — anything else means another writer touched the row and fails
 * closed without mutation.
 */
export async function revalidateV2SessionRowBeforeSpawn(sessionV2) {
  if (!sessionV2) return;
  const { markCoderSessionRunning } = await import('../coder-session-transitions.js');
  const { readCoderSessionInventory } = await import('../coder-session-inventory-codec.js');
  await sessionV2.runLease.withInventory(async () => {
    const read = await readCoderSessionInventory(sessionV2.inventoryDir);
    if (read.error) throw storeInvalidError(read.error);
    const row = read.entries.find((e) => e.engine === sessionV2.engine && e.slug === sessionV2.slug);
    if (row && row.state === 'reserved' && rowOwnedByRun(row, sessionV2)) {
      await markCoderSessionRunning(sessionV2);
      return;
    }
    if (!rowOwnedByRun(row, sessionV2) || row.state !== 'running') {
      throw new Error(
        `coder-session: claimed row ${sessionV2.engine}/${sessionV2.slug} changed before spawn` +
        ` (state=${row ? row.state : 'absent'}) — retain, fail closed`,
      );
    }
  });
}

/**
 * Store-state-driven finalizer. The DURABLE session-store mapping — not the
 * admission-time origin alone — decides whether a row is published:
 *   complete (success): running -> idle ONLY with a valid engine session id
 *   AND its durable matching mapping; otherwise the row cannot claim a
 *   continuable session and is removed through the canonical deleting
 *   transition (a mapping mismatch retains/fails closed).
 *   abandon (failure): a reservation WITHOUT a published mapping is removed;
 *   one WITH a matching published mapping survives as idle (the persisted
 *   session outlives the failed envelope write); a MISMATCHED mapping
 *   retains and fails closed. Continuations additionally require their
 *   captured resumed real id to remain durably present.
 * Every mutation is owner-checked inside the held run lease; on any
 * ambiguity the row is retained for recovery, never blindly deleted.
 *
 * Completion returns a TYPED outcome the envelope consumes:
 *   'persistent'             — confirmed resumable idle row (mapping matched)
 *   'removed_unusable'       — success produced nothing continuable; row removed
 *   'retained_for_recovery'  — ambiguity/finalization failure; fail closed
 * A persistent envelope claim is therefore only ever emitted AFTER the
 * inventory transition is durably confirmed — never before finalization.
 */
async function finalizeV2SessionRow(sessionV2, mode, publishedRealId) {
  if (!sessionV2) return mode === 'complete' ? 'removed_unusable' : undefined;
  // The finalizer owns the run lease for the whole completion/rollback
  // attempt. Outer engine catches must not invoke abandon a second time after
  // a fail-closed completion has already released that lease.
  sessionV2.finalizationAttempted = true;
  let outcome;
  try {
    const transitions = await import('../coder-session-transitions.js');
    const { readCoderSessionInventory } = await import('../coder-session-inventory-codec.js');
    const isStoreEngine = SESSION_STORE_ENGINES.includes(sessionV2.engine);
    // Expected durable mapping per path: completion verifies EXACTLY the id
    // this run published (sessionV2.publishedRealId, set right after the
    // durable persist); a failed continuation verifies the id captured at
    // claim time; a failed NEW reservation verifies ITS OWN published id too
    // (undefined when publication never happened) — an existing mapping can
    // NEVER be attributed to a run that did not publish it.
    const expectedRealId =
      mode === 'complete' ? publishedRealId
      : sessionV2.origin === 'idle_continuation' ? sessionV2.resumedRealId
      : sessionV2.publishedRealId;
    outcome = await sessionV2.runLease.withInventory(async () => {
      const read = await readCoderSessionInventory(sessionV2.inventoryDir);
      if (read.error) throw storeInvalidError(read.error);
      const row = read.entries.find((e) => e.engine === sessionV2.engine && e.slug === sessionV2.slug);
      const mapping = isStoreEngine
        ? classifySessionStoreMapping(sessionV2.engine, sessionV2.slug, expectedRealId)
        : { state: 'not_applicable', realId: null };
      const removeUnpublished = async () => {
        if (!['reserved', 'running'].includes(row.state)) {
          throw new Error(`unexpected row state ${row.state} during rollback`);
        }
        if (!rowOwnedByRun(row, sessionV2)) {
          throw new Error('row owner tuple mismatch during rollback');
        }
        await transitions.beginCoderSessionDelete(sessionV2);
        await transitions.removeCoderSessionRow(sessionV2);
        return 'removed_unusable';
      };
      if (mode === 'complete') {
        if (!rowOwnedByRun(row, sessionV2) || row.state !== 'running') {
          throw new Error(`row is ${row ? row.state : 'absent'} / not owned by this run`);
        }
        if (!isStoreEngine) {
          if (typeof publishedRealId !== 'string' || publishedRealId.length === 0) {
            // Non-store engines (currently Crush) still need a native id to
            // make the inventory row resumable. An admitted row alone is not
            // persistence evidence.
            process.stderr.write(pc.dim('  ⚠ v2 session had no resumable session id — removing the unusable persistent row\n'));
            return removeUnpublished();
          }
          // Crush has no Triss-side slug -> real-id map: the caller slug is
          // the native get-or-create key passed to the engine. A different
          // id therefore proves that this run cannot be resumed by the
          // admitted slug; retain the row for recovery rather than publishing
          // a false persistent envelope.
          if (publishedRealId !== sessionV2.slug) {
            throw new Error(
              `native Crush session id ${JSON.stringify(publishedRealId)} does not match ` +
                `the admitted session slug ${JSON.stringify(sessionV2.slug)} (retain, fail closed)`,
            );
          }
          await transitions.markCoderSessionIdle(sessionV2);
          return 'persistent';
        }
        if (typeof publishedRealId !== 'string' || publishedRealId.length === 0) {
          // A named run that produced no usable native session id can never
          // be continued: do NOT publish an idle row that would make the
          // next run silently start a fresh conversation.
          process.stderr.write(pc.dim('  ⚠ v2 session had no resumable session id — removing the unusable persistent row\n'));
          return removeUnpublished();
        }
        if (mapping.state === 'matching') {
          await transitions.markCoderSessionIdle(sessionV2);
          return 'persistent';
        }
        if (mapping.state === 'mismatch') {
          throw new Error('session mapping changed during the run (retain, fail closed)');
        }
        // mapping absent: durable publication did not happen despite success.
        process.stderr.write(pc.dim('  ⚠ v2 session mapping was not durably published — removing the unusable persistent row\n'));
        return removeUnpublished();
      }
      // ── abandon (failure path) ──
      const promoteThenIdle = async () => {
        const { markCoderSessionRunning } = await import('../coder-session-transitions.js');
        // A failure before pre-spawn revalidation leaves the row RESERVED;
        // the canonical table has no reserved -> idle edge, so promote it to
        // running under OUR tuple exactly like revalidate does, then idle.
        await markCoderSessionRunning(sessionV2);
        await transitions.markCoderSessionIdle(sessionV2);
      };
      if (sessionV2.origin === 'new_reservation') {
        const ours = row && ['running', 'reserved'].includes(row.state) && rowOwnedByRun(row, sessionV2);
        if (isStoreEngine && typeof sessionV2.publishedRealId !== 'string') {
          // Publication never happened during this run: an existing durable
          // mapping is FOREIGN (pre-existing orphan/other-run state) and must
          // never be adopted as this run's session. Retain everything.
          if (!ours) throw new Error('row not owned by this run during rollback');
          if (mapping.state !== 'absent') {
            throw new Error('pre-existing session mapping cannot be attributed to this failed run (retain, fail closed)');
          }
          await removeUnpublished();
          return;
        }
        // Published BEFORE the failure? Then the persisted session survives —
        // but ONLY when the durable mapping still matches OUR exact id:
        // running -> idle keeps mapping and inventory consistent. Otherwise
        // THIS run created the row and nothing durable references it —
        // remove via the canonical deleting transition.
        if (mapping.state === 'matching' && ours) {
          if (row.state === 'running') await transitions.markCoderSessionIdle(sessionV2);
          else await promoteThenIdle();
          return;
        }
        if (mapping.state === 'mismatch') {
          throw new Error('session mapping changed during the run (retain, fail closed)');
        }
        if (!ours) throw new Error('row not owned by this run during rollback');
        await removeUnpublished();
        return;
      }
      // Failed continuation: the previously published session SURVIVES the
      // failure — but its mapping must still be durably present and equal
      // the id captured at claim time, otherwise retain and fail closed.
      if (!rowOwnedByRun(row, sessionV2) || row.state !== 'running') {
        throw new Error(`row is ${row ? row.state : 'absent'} / not owned by this run`);
      }
      if (isStoreEngine && mapping.state !== 'matching') {
        throw new Error(`session mapping ${mapping.state} during rollback (retain, fail closed)`);
      }
      await transitions.markCoderSessionIdle(sessionV2);
      return undefined;
    });
  } catch (err) {
    // Retain / fail closed: a finalization failure never deletes the row
    // blindly — the diagnostic names the retained state for recovery.
    process.stderr.write(pc.dim(`  ⚠ v2 session ${mode === 'complete' ? 'completion' : 'rollback'} retained row for recovery: ${err.message}\n`));
    outcome = 'retained_for_recovery';
  } finally {
    try {
      // Idempotent by contract: the confirmed-persistent success path has
      // already released the prefix; every other path releases it here.
      await sessionV2.runLease?.release();
    } catch {
      /* idempotent best-effort lease release */
    }
  }
  return outcome;
}

// Exported for tests + production envelope assembly: success finalizer
// (running -> idle + lease release). Returns the typed completion outcome:
// 'persistent' ONLY after the idle transition was durably confirmed with a
// matching durable mapping; 'removed_unusable' when success produced nothing
// continuable; 'retained_for_recovery' on any ambiguity (fail closed).
// publishedRealId is the engine session id whose mapping was durably
// persisted before the envelope is assembled (undefined for engines without
// a versioned store namespace).
export async function completeV2SessionRow(sessionV2, publishedRealId) {
  return finalizeV2SessionRow(sessionV2, 'complete', publishedRealId);
}

// Exported for tests: provenance/store-aware rollback of a claimed row.
export async function releaseV2SessionRow(sessionV2) {
  await finalizeV2SessionRow(sessionV2, 'abandon', undefined);
}

export async function runCoderRun(promptArg, opts = {}, deps = {}) {
  // The engine env allowlist (buildEngineEnv) and the timeout kill
  // (negative-PID process-group SIGTERM/SIGKILL in spawnEngine) are both
  // POSIX-only. Rather than ship a silently half-working Windows path
  // (no group kill => a hung/retrying engine can never be terminated by
  // --timeout), refuse explicitly.
  if (process.platform === 'win32') {
    throw new Error('triss coder run is POSIX-only for now (Windows is not supported).');
  }

  const {
    engine,
    maxTokens,
    isolate,
    modelOverride,
    oneShotProvider,
    oneShotSmallModel,
    smallModelUnused,
    timeoutSec,
  } = validateCoderRunOptions(opts, { prompt: promptArg });
  if (maxTokens !== undefined) {
    opts = { ...opts, maxTokens };
  }
  const workerShellEnv = captureWorkerShellSnapshot();
  loadEnvFiles();
  const sh = deps.spawnSync || nodeSpawnSync;
  const spawnFn = deps.spawn || nodeSpawn;
  // A custom spawn seam usually returns an EventEmitter test double with an
  // arbitrary pid. Never let that pid authorize real OS signalling. Callers
  // that deliberately create a real detached group through a custom spawn
  // must also inject the matching killProcess seam explicitly.
  const killProcess = deps.killProcess || (spawnFn === nodeSpawn ? undefined : noInjectedProcessGroup);

  const prompt = await resolveCoderPrompt(promptArg, opts);
  const allowBestEffortCallerWorktree = opts.allowBestEffortCallerWorktree === true;
  const credentialMode = readCoderCredentialMode({
    scope: 'effective',
    parentEnv: deps.credentialModeParentEnv,
  });

  // Effective --isolate. The two engines DEFAULT differently:
  //   - opencode: isolate-OFF (its deny-first opencode.json bash policy is the
  //     reliable safety layer — it actually enforces).
  //   - crush: isolate-ON. crush 0.1.3's `permissions.run` config block is
  //     INERT (see docs/engines/crush.md) and a denied bash
  //     command deadlocks to the timeout instead of denying cleanly. So the
  //     config allowlist is NOT a dependable safety layer today; the disposable
  //     git worktree is. crush therefore ships isolate-ON by default — the same
  //     posture it had before the (reverted) Variant-A flip — with opt-in
  //     `--restrict` adding a CLI allowlist on top for defense-in-depth.
  // An explicit --isolate / --no-isolate always wins for either engine.
  // bin/triss.js declares BOTH options on `coder run` (neither carries a
  // default), so Commander yields the tristate this line relies on:
  // opts.isolate is `undefined` when neither flag is passed, `true` under
  // --isolate, `false` under --no-isolate. (Do NOT add a default to either
  // option — the undefined tristate is load-bearing here.)
  // V1 resolves the agent default here; V2 must NOT inject a default agent:
  // the V2 binary does not auto-load the V1 `.opencode/agents` templates, so
  // `--agent coder` failed live with "Agent not found" unless agent files
  // were hand-installed — and the static agent-source preflight rejects
  // those. A beta V2 run without an explicit --agent uses the engine's
  // built-in primary agent instead.
  const agent = opts.agent || (engine === 'opencode2' ? null : 'coder');

  const modelUsed = modelOverride || coderModel();

  // Provider-aware credential gate. crush only speaks Z.AI (it bridges
  // ZHIPU_API_KEY -> ZAI_API_KEY), so it always needs ZHIPU_API_KEY. For
  // opencode the required key follows the resolved model's provider:
  // `opencode/*` (OpenCode Zen) and `opencode-go/*` (OpenCode Go) need the
  // shared OPENCODE_API_KEY; other provider prefixes use their own keys. Keeping the
  // Z.AI message wording identical preserves the historical error text.
  // crush speaks Z.AI GLM only. An explicit `--model opencode/*` would be
  // forwarded to crush verbatim (buildCrushRunArgv) and fail at the engine
  // with an opaque parse/timeout — reject it upfront with a clear message.
  // (A bare TRISS_CODER_MODEL=opencode/* env default is fine: crush ignores it
  // and runs its GLM atoms, so only the explicit override is a real mistake.)

  const cred = engine === 'crush' ? { env: 'ZHIPU_API_KEY' } : coderModelCredential(modelUsed);
  const protectedRouting = engine !== 'crush' && credentialMode === 'protected_proxy';
  // Raw Zen/Go models without an audited Triss transport intentionally use
  // OpenCode's built-in provider metadata. Known audited models still use the
  // transient overlay so their protocol/package can be pinned in protected
  // and raw modes alike; other providers retain their existing overlay path.
  let smallModelUsed = oneShotSmallModel || coderSmallModel();
  // Classify both persisted roles before resolving runtime metadata. A stale
  // cross-provider or cross-prefix small pin is not a real role for a
  // non-one-shot run; map it to the main model before a worker profile or a
  // second credential scope can be loaded for it. Distinct transports within
  // one prefix (for example two opencode-go models) remain supported.
  const mainProviderRoute = engine !== 'crush'
    ? resolveCoderProviderRoute(modelUsed)
    : null;
  const smallProviderRoute = engine !== 'crush' && engine !== 'opencode2'
    ? resolveCoderProviderRoute(smallModelUsed)
    : mainProviderRoute;
  const sameProviderScope =
    (!mainProviderRoute && !smallProviderRoute) ||
    (
      mainProviderRoute?.provider === smallProviderRoute?.provider &&
      mainProviderRoute?.prefix === smallProviderRoute?.prefix
    );
  if (engine === 'opencode' && !oneShotProvider && !sameProviderScope) {
    smallModelUsed = modelUsed;
  }
  // The worker key and endpoint are resolved independently per field. Reject
  // a repository-local endpoint paired with a higher-trust effective key for
  // every OpenCode engine before route construction can hand that pair to the
  // parent credential proxy (or to a raw best-effort child).
  if (cred.provider === 'worker') {
    assertWorkerTransportProvenance(workerShellEnv);
  }
  const workerSettings = cred.provider === 'worker'
    ? readWorkerConfigSnapshot({ scope: 'effective', parentEnv: workerShellEnv })
    : null;
  const credentialValue = workerSettings ? workerSettings.apiKey : process.env[cred.env];
  const routeCandidate = engine !== 'crush'
    ? resolveRuntimeCoderProviderRoute(modelUsed, workerSettings, { requireAudited: false })
    : null;
  let smallRouteCandidate = engine !== 'crush' && engine !== 'opencode2'
    ? resolveRuntimeCoderProviderRoute(smallModelUsed, workerSettings, { requireAudited: false })
    : routeCandidate;
  // A stale persisted same-provider small pin must not brick an otherwise
  // audited protected run. Explicit one-shot --small-model remains strict;
  // only the implicit persisted role falls back to the main audited route.
  if (
    protectedRouting && engine === 'opencode' && !oneShotSmallModel &&
    ['opencode-zen', 'opencode-go'].includes(smallRouteCandidate?.provider) &&
    !smallRouteCandidate.transportAudited && routeCandidate?.transportAudited
  ) {
    smallModelUsed = modelUsed;
    smallRouteCandidate = routeCandidate;
  }
  const rawBuiltInRoute = credentialMode === 'best_effort_raw' &&
    ['opencode-zen', 'opencode-go'].includes(routeCandidate?.provider) &&
    (!routeCandidate.transportAudited || (
      engine === 'opencode' &&
      ['opencode-zen', 'opencode-go'].includes(smallRouteCandidate?.provider) &&
      !smallRouteCandidate.transportAudited
    ));
  const canonicalOpenCodeRouting = engine !== 'crush' && (
    protectedRouting || (credentialMode === 'best_effort_raw' && !rawBuiltInRoute)
  );
  const runtimeRoute = canonicalOpenCodeRouting
    ? resolveRuntimeCoderProviderRoute(modelUsed, workerSettings, { requireAudited: protectedRouting })
    : routeCandidate;
  let runtimeSmallRoute = canonicalOpenCodeRouting && engine !== 'opencode2'
    ? resolveRuntimeCoderProviderRoute(smallModelUsed, workerSettings, { requireAudited: protectedRouting })
    : (engine === 'opencode2' ? runtimeRoute : smallRouteCandidate);
  if (canonicalOpenCodeRouting && engine !== 'opencode2' &&
      runtimeSmallRoute.provider !== runtimeRoute.provider) {
    if (oneShotProvider) {
      throw new Error(
        `Protected OpenCode routing requires the main and small models to use one provider; ` +
        `"${modelUsed}" and "${smallModelUsed}" resolve to different providers.`,
      );
    }
    // A stale persisted small-model pin must not make the main run demand a
    // different provider key or proxy route.  Keep the historical main-only
    // semantics for non-one-shot runs and map the small role to that route.
    smallModelUsed = modelUsed;
    runtimeSmallRoute = runtimeRoute;
  }
  const separateSmallTransport = Boolean(
    canonicalOpenCodeRouting && engine === 'opencode' &&
    !coderRoutesShareTransport(runtimeSmallRoute, runtimeRoute),
  );
  if (!credentialValue) {
    const suffix =
      cred.provider === 'worker'
        ? ' (set TRISS_WORKER_API_KEY and run `triss coder init --provider worker` to use the existing OpenAI-compatible worker profile)'
        : cred.provider === 'opencode-go'
        ? ' (set OPENCODE_API_KEY to use OpenCode Go models — run `triss coder models --provider opencode-go` to see current offerings)'
        : {
            OPENCODE_API_KEY: ' (set OPENCODE_API_KEY to use OpenCode Zen models — run `triss coder models` to see current offerings)',
            MOONSHOT_API_KEY:
              ' (set MOONSHOT_API_KEY to use Moonshot Kimi models like moonshotai/kimi-k2.7-code)',
            KIMI_API_KEY:
              ' (set KIMI_API_KEY to use Kimi for Coding subscription models like kimi-for-coding/k3)',
          }[cred.env] || '';
    // A bare opencode-engine run resolves the GLM default model, so it demands
    // ZHIPU_API_KEY even when another provider's key IS configured — and that
    // key would serve a run today via an explicit model. Name that path
    // instead of dead-ending a Kimi/Zen-only setup on a Z.AI message.
    const ALT_MODEL_HINTS = {
      OPENCODE_API_KEY: 'opencode/deepseek-v4-flash-free',
      MOONSHOT_API_KEY: 'moonshotai/kimi-k2.7-code',
      KIMI_API_KEY: 'kimi-for-coding/k3',
    };
    const altKey =
      engine !== 'crush' && cred.env === 'ZHIPU_API_KEY'
        ? Object.keys(ALT_MODEL_HINTS).find((k) => process.env[k])
        : null;
    const alt = altKey
      ? ` ${altKey} is set, so a run works now with --model ${ALT_MODEL_HINTS[altKey]}; \`triss coder init\` makes it the default.`
      : '';
    throw new Error(`${cred.env} is not set — run \`triss coder init\` first.${suffix}${alt}`);
  }
  const rawCredentialWarning = engine !== 'crush' && credentialMode === 'best_effort_raw'
    ? CREDENTIAL_ISOLATION_DOWNGRADED_WARNING
    : null;
  if (rawCredentialWarning) {
    process.stderr.write(pc.yellow(`  ⚠ ${rawCredentialWarning}\n`));
  }
  const detectedOpencodeVersion = engine === 'opencode' ? detectOpencodeVersion(sh) : null;
  if (engine === 'opencode' && oneShotProvider && detectedOpencodeVersion !== OPENCODE_PIN) {
    const found = detectedOpencodeVersion === null
      ? 'not installed'
      : detectedOpencodeVersion || 'version unknown';
    throw new Error(
      `One-shot provider credential auditing is verified only for opencode ${OPENCODE_PIN}; ` +
        `found ${found}. Run \`npm install -g opencode-ai@${OPENCODE_PIN}\` and retry.`,
    );
  }

  const slug = resolveSlug(opts, isolate);

  let isolation = null;
  let isolationDowngraded = false;
  if (isolate) {
    try {
      isolation = setupIsolation(sh, slug);
    } catch (err) {
      const msg = String(err.message || err);
      // Only mechanism-unavailability is downgradeable; slug/branch conflicts
      // carry ISOLATION_CONFLICT_CODE and must fail closed even with the
      // opt-in so the user can pick a new slug/clean. Only UNAVAILABLE
      // (no git repo / worktree creation failure) downgrades.
      const isConflict = err.code === ISOLATION_CONFLICT_CODE;
      const isMechanismUnavailable = !isConflict;
      if (!allowBestEffortCallerWorktree || isConflict) {
        if (!msg.includes(ISOLATION_ENFORCEMENT_REQUIRED_CODE)) {
          if (isMechanismUnavailable) {
            err.message = `${msg} (${ISOLATION_ENFORCEMENT_REQUIRED_CODE} — retry with --allow-best-effort-caller-worktree to downgrade to caller worktree when isolation cannot be enforced)`;
          } else {
            err.message = `${msg} (${ISOLATION_ENFORCEMENT_REQUIRED_CODE})`;
          }
        }
        if (err.code === ISOLATION_CONFLICT_CODE || err.code === ISOLATION_UNAVAILABLE_CODE) {
          const prev = err.code;
          err.code = ISOLATION_ENFORCEMENT_REQUIRED_CODE;
          err.cause = err.cause ?? { code: prev };
        } else if (!err.code) err.code = ISOLATION_ENFORCEMENT_REQUIRED_CODE;
        throw err;
      }
      isolation = null;
      isolationDowngraded = true;
      process.stderr.write(pc.yellow(`  ⚠ ${ISOLATION_DOWNGRADED_CODE}: isolation unavailable — running in caller worktree (best-effort; edits may reach current Git worktree)\n`));
    }
  }

  // Model identifiers are the only transient config values. Credentials stay
  // in their dedicated env var and must never be embedded in this JSON overlay.
  const rawBuiltInV1Config = engine === 'opencode' && rawBuiltInRoute;
  const oneShotConfigContent = !protectedRouting && (oneShotProvider || rawBuiltInV1Config)
    ? JSON.stringify({
      model: modelUsed,
      ...(engine === 'opencode2'
        ? {}
        : { small_model: rawBuiltInV1Config ? smallModelUsed : oneShotSmallModel }),
    })
    : null;

  // Audit the exact directory tree OpenCode will load, not merely the Triss
  // state root. A reused isolated session can carry its own opencode.json,
  // while a non-isolated call without --cwd inherits process.cwd() even when
  // TRISS_PROJECT_ROOT points elsewhere. No selected credential reaches the
  // engine until every applicable layer from this runtime directory is safe.
  // Security coupling: agent-level model defaults are deliberately outside
  // this selected-provider audit because buildOpencodeArgv always passes the
  // resolved model explicitly via --model, which OpenCode gives precedence.
  // If that CLI pin is ever removed, this audit must expand to agent.*.model
  // before any provider credential can still be forwarded safely.
  if (canonicalOpenCodeRouting) {
    const runtimeDir = isolation
      ? isolation.wtPath
      : opts.cwd
        ? resolvePath(opts.cwd)
        : process.cwd();
    try {
      auditProtectedRouteConfiguration({
        model: modelUsed,
        route: runtimeRoute,
        smallModel: smallModelUsed,
        smallRoute: runtimeSmallRoute,
        cwd: runtimeDir,
        configRoot: opencodeProjectBoundary(runtimeDir),
        workerSettings,
      });
    } catch (err) {
      if (isolation?.freshlyCreated) cleanupAbandonedIsolation(sh, isolation);
      throw err;
    }
  } else if (rawBuiltInRoute) {
    const runtimeDir = isolation
      ? isolation.wtPath
      : opts.cwd
        ? resolvePath(opts.cwd)
        : process.cwd();
    try {
      auditBuiltInOpenCodeRouteConfiguration({
        model: modelUsed,
        // OpenCode 2 validates --small-model for identity only; it never
        // routes or audits that unused role as part of the built-in fallback.
        smallModel: engine === 'opencode' ? smallModelUsed : undefined,
        cwd: runtimeDir,
        configRoot: opencodeProjectBoundary(runtimeDir),
      });
    } catch (err) {
      if (isolation?.freshlyCreated) cleanupAbandonedIsolation(sh, isolation);
      throw err;
    }
  }

  // ─── Credential proxy: the production run path never hands
  // the raw provider credential to the engine. Start the parent-owned
  // loopback proxy FIRST; the child receives only the one-run token and the
  // loopback base URL. If the proxy cannot start (or no canonical endpoint
  // is known for this credential), the run fails closed BEFORE spawn.
  // ─── Credential-store isolation preflight: the loopback token proxy
  // removes the raw key from the child's env/argv/config, but a same-UID
  // child can still READ the raw credential stores (project .triss.env and
  // global ~/.config/triss/.env) directly. Per the plan (Section 6.5), a
  // best-effort run is only allowed when the boundary is actually absent: if
  // any raw store is readable, the run fails closed BEFORE spawn unless the
  // operator has explicitly acknowledged the best-effort scope via
  // TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=1.
  if (!deps.allowBestEffortIsolation && credentialMode !== 'best_effort_raw') {
    const readableStores = [];
    const storePaths = new Set([
      ...activeEnvFiles().map(({ path }) => path),
      // Legacy locations remain leak channels even though current writes use
      // activeEnvFiles()' canonical local/global stores.
      join(homedir(), '.triss.env'),
      join(projectRoot(), '.triss.env.local'),
    ]);
    for (const storePath of storePaths) {
      try {
        const { vars } = readEnvFile(storePath);
        // Fail-closed policy: any unknown non-empty assignment, or any known
        // credential, is potential credential material that makes the raw
        // store a leak channel for same-UID child processes. Explicitly known
        // non-secret coder/provider settings (including the model pins written
        // by init) do not turn an otherwise clean store into a leak channel.
        // Empty stores (0-byte files, comments-only, blank values) contain no
        // keys and are safely ignored.
        const hasEntries = Object.entries(vars).some(([key, value]) =>
          !NON_SECRET_CODER_STORE_KEYS.has(key) &&
          typeof value === 'string' &&
          value.trim().length > 0,
        );
        if (hasEntries) {
          readableStores.push(storePath);
        }
      } catch {
        /* absent or unreadable: not a leak channel */
      }
    }
    if (readableStores.length > 0) {
      if (isolation?.freshlyCreated) cleanupAbandonedIsolation(sh, isolation);
      throw new Error(
        `credential isolation unavailable: the raw credential store(s) ${readableStores.join(', ')} ` +
          `are readable by the same-UID engine child, so the loopback token proxy alone cannot ` +
          `contain the real key. Move the credentials into your shell environment, or ` +
          `acknowledge the best-effort scope with TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=1`,
      );
    }
  }

  const proxyTarget = engine === 'crush'
    ? coderCredentialEndpoint(cred.env, modelUsed)
    : protectedRouting
      ? runtimeRoute
      : null;
  let credentialProxy = null;
  let smallCredentialProxy = null;
  let credentialProxyReleased = false;
  const releaseCredentialProxy = async () => {
    if (credentialProxyReleased) return;
    credentialProxyReleased = true;
    const proxies = [credentialProxy, smallCredentialProxy].filter(Boolean);
    for (const proxy of proxies) proxy.revoke();
    await Promise.all(proxies.map((proxy) => proxy.closed));
  };
  if (
    !protectedRouting &&
    engine === 'opencode' &&
    proxyTarget?.engineRedirect === 'none' &&
    !deps.disableCredentialProxy
  ) {
    // Honest fail-closed: the opencode built-in provider for this credential
    // exposes no documented base-URL override, so the engine would present
    // the one-run PROXY token to the REAL upstream (a guaranteed auth
    // failure, possibly with the token logged upstream). Refuse before spawn
    // instead of handing over a credential that cannot work.
    if (isolation?.freshlyCreated) cleanupAbandonedIsolation(sh, isolation);
    throw new Error(
      `credential isolation unavailable: ${cred.env} runs through opencode cannot be ` +
        `pinned to the parent-owned credential proxy (no documented engine base-URL ` +
        `override for this provider); refusing to spawn the engine with a one-run ` +
        `proxy token the upstream would reject`,
    );
  }
  const proxyRequired = engine === 'crush' || protectedRouting;
  if (proxyRequired && !deps.disableCredentialProxy && proxyTarget) {
    try {
      credentialProxy = await startCoderCredentialProxy({
        provider: cred.provider || cred.env,
        model: protectedRouting ? transientModelName(runtimeRoute) : modelUsed,
        smallModel: protectedRouting && engine !== 'opencode2' && !separateSmallTransport
          ? transientModelName(runtimeSmallRoute)
          : undefined,
        models: protectedRouting
          ? [runtimeRoute.modelId, ...(engine === 'opencode2' || separateSmallTransport
            ? []
            : [runtimeSmallRoute.modelId])]
          : undefined,
        endpoint: proxyTarget.endpoint,
        pathPrefix: proxyTarget.pathPrefix,
        protocol: proxyTarget.protocol,
        authStyle: proxyTarget.authStyle,
        credential: credentialValue,
        deadlineMs: (timeoutSec + 60) * 1000,
        ...(deps.credentialProxyOptions || {}),
      });
      // OpenCode 1 can retain a distinct small_model role. If its audited
      // transport differs from main, give it a separate scoped loopback
      // route; both proxies intentionally share the one-run token because
      // the child has one credential environment variable.
      if (separateSmallTransport) {
        smallCredentialProxy = await startCoderCredentialProxy({
          provider: cred.provider || cred.env,
          model: transientModelName(runtimeSmallRoute),
          models: [runtimeSmallRoute.modelId],
          endpoint: runtimeSmallRoute.endpoint,
          pathPrefix: runtimeSmallRoute.pathPrefix,
          protocol: runtimeSmallRoute.protocol,
          authStyle: runtimeSmallRoute.authStyle,
          credential: credentialValue,
          token: credentialProxy.token,
          deadlineMs: (timeoutSec + 60) * 1000,
          ...(deps.credentialProxyOptions || {}),
        });
      }
    } catch (err) {
      await releaseCredentialProxy();
      if (isolation?.freshlyCreated) cleanupAbandonedIsolation(sh, isolation);
      throw new Error(
        `credential isolation unavailable: the coder run requires the parent-owned ` +
          `credential proxy and it failed to start (${err?.message || 'unknown error'}); ` +
          `refusing to spawn the engine with raw credential inheritance`,
        { cause: err },
      );
    }
  }
  if (proxyRequired && !credentialProxy && !deps.disableCredentialProxy) {
    if (isolation?.freshlyCreated) cleanupAbandonedIsolation(sh, isolation);
    throw new Error(
      `credential isolation unavailable: no canonical provider endpoint is known for ` +
        `${cred.env}; refusing to spawn the engine with raw credential inheritance`,
    );
  }

  // Protected runs use the same transient provider projection for both
  // engines. In acknowledged raw V1 mode the proxy is intentionally absent,
  // so the fallback is the audited real upstream; test seams can also disable
  // the proxy while exercising the same deterministic projection.
  const transientBaseURL = credentialProxy?.scopedBaseUrl ||
    (runtimeRoute ? `${runtimeRoute.endpoint}${runtimeRoute.pathPrefix === '/' ? '' : runtimeRoute.pathPrefix}` : `http://127.0.0.1:0/v1`);
  const transientSmallBaseURL = smallCredentialProxy?.scopedBaseUrl ||
    (runtimeSmallRoute ? `${runtimeSmallRoute.endpoint}${runtimeSmallRoute.pathPrefix === '/' ? '' : runtimeSmallRoute.pathPrefix}` : transientBaseURL);
  const routingConfigContent = canonicalOpenCodeRouting
    ? JSON.stringify(buildCoderTransientProviderOverlay({
      route: runtimeRoute,
      model: modelUsed,
      smallModel: smallModelUsed,
      smallRoute: runtimeSmallRoute,
      baseURL: transientBaseURL,
      smallBaseURL: transientSmallBaseURL,
      credentialEnv: runtimeRoute.credentialEnv,
      includeSmallModel: engine !== 'opencode2',
    }))
    : oneShotConfigContent;
  const openCodePureMode = engine === 'opencode' && Boolean(oneShotProvider);

  // OpenCode V1 loads account/org, managed-directory, and macOS MDM layers
  // after OPENCODE_CONFIG_CONTENT. Disk-only auditing cannot see those final
  // overlays, so ask the pinned binary for its exact merged config with a
  // disposable probe credential before the real credential-bearing spawn.
  if (engine === 'opencode') {
    const runtimeDir = isolation
      ? isolation.wtPath
      : opts.cwd
        ? resolvePath(opts.cwd)
        : process.cwd();
    try {
      auditEffectiveOpenCodeConfiguration(
        deps.effectiveConfigSpawnSync || sh,
        [modelUsed, smallModelUsed],
        routingConfigContent,
        {
          cwd: runtimeDir,
          credentialEnv: cred.env,
          // Mirror the actual V1 argv exactly. One-shot runs disable external
          // plugins in both processes; ordinary runs keep their deny-first
          // disk policy and late managed/MDM layers visible to both.
          pure: openCodePureMode,
        },
      );
    } catch (err) {
      await releaseCredentialProxy();
      if (isolation?.freshlyCreated) cleanupAbandonedIsolation(sh, isolation);
      throw err;
    }
  }

  // Option validation that needs NO ownership claim runs BEFORE the v2
  // reservation: a rejected request must never flip an existing idle row to
  // running (the deterministic published-row deletion scenario).
  if (engine === 'opencode2' && opts.session && opts.continue) {
    if (isolation && isolation.freshlyCreated) cleanupAbandonedIsolation(sh, isolation);
    throw new Error(
      '--session and --continue state an ambiguous resume intent on the opencode2 engine — ' +
        'pass one or the other, never both.',
    );
  }

  // v2 session lifecycle: lease-integrated admission BEFORE the engine
  // branch. The claimed row is finalized before the envelope is assembled;
  // only its typed completion outcome can authorize persistence.
  // Rollback is provenance-aware: a reservation THIS run created is removed
  // on any failure path; a continuation of a previously published idle
  // session returns to idle so the persisted session survives the failure.
  let sessionV2;
  try {
    sessionV2 = await reserveV2SessionRow({
      engine,
      slug: opts.session || null,
      isolated: !!isolation,
      // Test seam (deps.ownerTuple): CLI regression tests force the sanctioned
      // "owner identity unavailable" downgrade without patching probes.
      ownerTuple: deps.ownerTuple,
    });
  } catch (err) {
    // Admission runs AFTER setupIsolation: a rejected claim (BUSY,
    // INCOMPATIBLE, corrupt store/orphan mapping) must never strand a
    // freshly-created isolation worktree/branch.
    if (isolation && isolation.freshlyCreated) cleanupAbandonedIsolation(sh, isolation);
    throw err;
  }

  // crush diverges here — its own (simpler) spawn + single-envelope parse flow.
  // Isolation is set up above (engine-agnostic git worktrees), so runCrushFlow
  // reuses the same teardown helpers as the opencode path below.
  if (engine === 'crush') {
    try {
      // Pre-spawn revalidation: reserved -> running under the leases, and a
      // hijack/foreign-tuple claim fails closed before any engine spawn.
      await revalidateV2SessionRowBeforeSpawn(sessionV2);
      return await runCrushFlow({
        opts,
        deps,
        sh,
        spawnFn,
        killProcess,
        prompt,
        isolate,
        isolation,
        slug,
        timeoutSec,
        credentialProxy,
        sessionV2,
        credentialMode,
      });
    } catch (err) {
      if (!sessionV2?.finalizationAttempted) await releaseV2SessionRow(sessionV2);
      throw err;
    } finally {
      await releaseCredentialProxy();
    }
  }

  // Engine-namespaced slug -> real-id lookup (versioned store): an opencode2
  // run never sees opencode's ids even for the same slug. Deferred into the
  // engine branches: the store read fails closed on malformed/
  // unknown shapes, and the V2 branch must clean up a freshly-created
  // isolation worktree when it throws — previously this line ran BEFORE the
  // V2 try/catch existed, leaking .triss/wt/<slug> + the coder/<slug> branch.
  // Invariant: the V1 lookup leaks the SAME way — it runs after
  // setupIsolation but was never wrapped in the cleanup guard, so
  // `coder run --isolate --session foo` with a corrupted sessions.json
  // stranded a worktree+branch that blocked re-runs until `coder clean`.
  const sessionRealIdArgFor = (engineName) => (opts.session ? lookupSessionRealId(engineName, opts.session) : null);
  let sessionRealIdV1 = null;
  if (engine !== 'opencode2' && opts.session) {
    try {
      sessionRealIdV1 = lookupSessionRealId(engine, opts.session);
    } catch (err) {
      if (isolation && isolation.freshlyCreated) cleanupAbandonedIsolation(sh, isolation);
      // The claimed v2 row must not outlive a failed lookup — otherwise a
      // corrupted sessions.json would strand a reserved/running row forever.
      await releaseV2SessionRow(sessionV2);
      await releaseCredentialProxy();
      throw err;
    }
  }

  // ─── OpenCode 2 ───────────────────────────────────────────────────────────
  //
  // Shares spawnEngine's process management through the engine seam (binary/
  // label/createState/foldLine/cwd) but diverges from V1 on: XDG-isolated
  // runtime state, ALWAYS --standalone (resident-service guard), no --pure/
  // --dir/--small-model surface, error.message precedence, terminal error
  // classification, and the never-zero missing-usage rule. The six provider
  // routes are fixture-gated: any route without a deterministic supported-beta
  // translation fixture fails closed BEFORE a credential is forwarded.
  if (engine === 'opencode2') {
    try {
    // ─── OpenCode 2 fail-closed preflight ───
    const root = projectRoot();
    // The audit runs against the EXACT child runtime directory — the
    // isolation worktree when --isolate, else the resolved --cwd, else
    // process.cwd(). deps.cwd is a TEST seam only and must never select the
    // audited tree in production; otherwise a test seam could bypass the
    // effective runtime configuration.
    const runtimeDir = isolation
      ? isolation.wtPath
      : opts.cwd
        ? resolvePath(opts.cwd)
        : process.cwd();
    // NOTE: the --session/--continue mutual exclusion already ran BEFORE the
    // v2 reservation (option validation must never claim ownership first).
    // Session lookup inside the guarded zone: the store read
    // fails closed on malformed/unknown shapes and must not leak a
    // freshly-created isolation worktree.
    let sessionRealIdArg2;
    try {
      sessionRealIdArg2 = sessionRealIdArgFor('opencode2');
    } catch (err) {
      if (isolation && isolation.freshlyCreated) cleanupAbandonedIsolation(sh, isolation);
      throw err;
    }
    // Full effective-configuration audit BEFORE the credential is read:
    // route fixture gate for the final model prefix, provider projection vs.
    // the exact worker profile baseURL, deny-first permission proof including
    // agents via the real last-match-wins evaluator, plus the existing
    // plugin/agent source rejection. Any failure leaves NO worktree/branch
    // behind.
    //
    // The audit must walk the canonical runtime
    // directory. A symlinked --cwd makes the child chdir to the PHYSICAL
    // target, so the engine's own config walk starts from a different parent
    // chain than the lexical path the preflight enumerated — hostile sources
    // in the physical tree's ancestors were invisible to the audit. Both the
    // audit and the spawn use the same realpathSync.native value.
    let runtimeDirCanonical;
    try {
      runtimeDirCanonical = realpathSync.native(runtimeDir);
    } catch (err) {
      if (isolation && isolation.freshlyCreated) cleanupAbandonedIsolation(sh, isolation);
      throw new Error(
        `OpenCode 2 preflight aborted: cannot canonicalize the runtime directory ${runtimeDir} — ${err.message}`,
        { cause: err },
      );
    }
    const workerProfile = modelUsed.startsWith('triss-worker/')
      ? workerCoderProfile()
      : null;
    let auditResult2;
    try {
      auditResult2 = auditOpenCode2Run(
        {
          cwd: runtimeDirCanonical,
          modelUsed,
          agentName: agent,
          expectedWorkerBaseURL: workerProfile ? workerProfile.baseUrl : null,
          credentialMode,
          allowManagedProviderAbsent: canonicalOpenCodeRouting,
        },
        { enumerate: deps.enumerateOpenCodeSources },
      );
      staticOpenCode2Preflight(runtimeDirCanonical, credentialMode);
    } catch (err) {
      if (isolation && isolation.freshlyCreated) cleanupAbandonedIsolation(sh, isolation);
      throw err;
    }
    // Runtime roots must be mode 0700 before credential forwarding so another
    // local user cannot read engine state or logs.
    try {
      ensureOpenCode2RuntimeDirs(root);
    } catch (err) {
      if (isolation && isolation.freshlyCreated) cleanupAbandonedIsolation(sh, isolation);
      throw err;
    }
    // Minimum-version verification before the credential-bearing spawn:
    // resolve the binary to an absolute path, verify the compatible build and
    // capability contract, and spawn THAT path — never a bare name whose PATH lookup
    // can differ between the parent (pre-check) and the child cwd (spawn).
    // A missing/mismatched/garbage binary is a terminal error here — the
    // envelope reports the DETECTED version, not the configured pin.
    const pinDetected = detectOpenCode2(sh);
    if (!pinDetected.found || !pinDetected.satisfiesPin) {
      if (isolation && isolation.freshlyCreated) cleanupAbandonedIsolation(sh, isolation);
      throw openCode2CompatibilityError(pinDetected, 'runs');
    }
    const engine2Version = pinDetected.version;
    const engine2Path = pinDetected.path;
    const serviceSnapshotWarning = pinDetected.capabilities?.warning === 'service-process-snapshot-unavailable'
      ? OPENCODE2_SERVICE_SNAPSHOT_WARNING
      : null;
    if (serviceSnapshotWarning) process.stderr.write(pc.yellow(`  ⚠ ${serviceSnapshotWarning}\n`));

    const argv2 = opencode2Engine.buildRunArgv({
      prompt,
      model: canonicalOpenCodeRouting ? transientModelName(runtimeRoute) : modelUsed,
      agent,
      sessionRealId: sessionRealIdArg2,
      cont: !!opts.continue,
    });
    const env2 = opencode2Engine.buildSpawnEnv({
      projectRoot: root,
      credentialEnv: cred.env,
      credentialValue: credentialProxy ? credentialProxy.token : (canonicalOpenCodeRouting ? credentialValue : undefined),
      configContent: routingConfigContent,
    });
    const logPath2 = opencode2LogPath(root);

    process.stderr.write(
      pc.dim(
        `[coder run] engine=opencode2${agent ? ` agent=${agent}` : ' (built-in agent)'} model=${modelUsed}` +
          (isolation ? ` isolate=${isolation.wtPath}` : '') +
          '\n',
      ),
    );

    // Re-run the full audit immediately before spawn. Between the audit and
    // this point sat the runtime-dir setup and the binary probes (several
    // subprocesses) — a window in which the audited tree can change. Hash
    // re-verification catches modified/removed layers but NOT sources CREATED
    // in the window (a fresh .opencode/opencode.json, plugin, or agent file),
    // so the FULL audit + static gate re-runs immediately before the
    // credential-bearing spawn: new layers, new provider overrides, new
    // executable sources — everything is re-enumerated from disk.
    try {
      auditOpenCode2Run(
        {
          cwd: runtimeDirCanonical,
          modelUsed,
          agentName: agent,
          expectedWorkerBaseURL: workerProfile ? workerProfile.baseUrl : null,
          credentialMode,
          allowManagedProviderAbsent: canonicalOpenCodeRouting,
        },
        { enumerate: deps.enumerateOpenCodeSources },
      );
      staticOpenCode2Preflight(runtimeDirCanonical, credentialMode);
      verifyOpenCode2ContentHashes(auditResult2?.contentHashes);
    } catch (err) {
      if (isolation && isolation.freshlyCreated) cleanupAbandonedIsolation(sh, isolation);
      throw err;
    }

    const spawnStartMs2 = Date.now();
    let result2;
    let rateLimit2;
    try {
      // Pre-spawn revalidation under the leases: a fresh reserved row
      // transitions to running HERE; a row rewritten by another writer fails
      // closed before any engine spawn.
      await revalidateV2SessionRowBeforeSpawn(sessionV2);
      result2 = await spawnEngine({
        argv: argv2,
        env: env2,
        timeoutSec,
        spawnFn,
        sinceMs: spawnStartMs2,
        scanRateLimit: deps.scanRateLimit,
        logPath: deps.logPath || logPath2,
        pollMs: deps.pollMs,
        abortSignal: deps.abortSignal,
        killProcess,
        residualTermGraceMs: deps.residualTermGraceMs,
        residualKillWaitMs: deps.residualKillWaitMs,
        processGroupPollMs: deps.processGroupPollMs,
        binary: engine2Path,
        label: 'opencode2',
        createState: createOpenCode2EventFolder,
        foldLine: foldOpenCode2EventLine,
        cwd: runtimeDirCanonical,
      });

      rateLimit2 = result2.rateLimit || findRecentRateLimit(spawnStartMs2, { logPath: logPath2 });
      // Post-run compatibility re-verification: the
      // SAME absolute path must still resolve to the verified compatible build — a
      // mid-run self-update, binary swap, or symlink retarget is a terminal
      // compatibility failure.
      const postPin = detectOpenCode2(sh);
      if (
        !postPin.found
        || !postPin.satisfiesPin
        || postPin.version !== engine2Version
        || postPin.path !== engine2Path
      ) {
        throw new Error(
          `opencode2 binary changed or lost compatibility during the run (before: v${engine2Version} @ ${engine2Path}, after: ` +
            `${postPin.found ? `v${postPin.version} @ ${postPin.path}` : 'not found'}) — treat this run's compatibility as unverified.`,
        );
      }
      if (rateLimit2 && !result2.finalText) {
        const err = new Error(rateLimitMessage(rateLimit2));
        err.rateLimit = rateLimit2;
        throw err;
      }
      if (!result2.parsedAnyEvent) {
        const tailLines = result2.stderrTail.trim().split('\n').filter(Boolean).slice(-20);
        const detail = tailLines.length ? `\nLast stderr:\n${tailLines.join('\n')}` : '';
        throw new Error(
          `opencode2 produced no parseable output (exit ${result2.code ?? 'null'}` +
            `${result2.signal ? `, signal ${result2.signal}` : ''}).${detail}`,
        );
      }
    } catch (err) {
      if (isolation && isolation.freshlyCreated) {
        cleanupAbandonedIsolation(sh, isolation);
      }
      throw err;
    }

    if (rawCredentialWarning) result2.warnings.unshift(rawCredentialWarning);
    if (serviceSnapshotWarning) result2.warnings.push(serviceSnapshotWarning);
    if (rateLimit2) result2.warnings.push(rateLimitMessage(rateLimit2));
    if (smallModelUnused) result2.warnings.push(OPENCODE2_SMALL_MODEL_UNUSED_WARNING);
    if (isolationDowngraded) result2.warnings.push(`${ISOLATION_DOWNGRADED_CODE}: isolation unavailable — downgraded to caller worktree (best-effort; edits may reach current Git worktree)`);

    // Terminal-error precedence: a V2 error event is terminal even when the
    // process exits 0 (verified live — see the adapter header). This BEATS
    // every exit-code/signal-based classification.
    let exit_reason2;
    if (result2.terminalError) exit_reason2 = 'error';
    else if (result2.timedOut) exit_reason2 = 'timeout';
    else if (result2.signal) exit_reason2 = 'killed';
    else if (result2.code === 0) exit_reason2 = 'end_turn';
    else exit_reason2 = 'error';

    if (opts.session && result2.sessionRealId && sessionV2) {
      persistSessionMapping(sh, 'opencode2', opts.session, result2.sessionRealId);
      // Attribution anchor for the finalizer: only THIS exact id may be
      // recognized as this run's publication during rollback.
      sessionV2.publishedRealId = result2.sessionRealId;
    } else if (opts.session && result2.sessionRealId && !sessionV2) {
      // Sanctioned ephemeral downgrade (owner identity unavailable): the run
      // itself succeeded, but publishing a durable slug mapping here would
      // create exactly the ORPHAN state (mapping without inventory row) the
      // admission gate rejects. The native session ends with this run; the
      // envelope reports session_persistence=ephemeral_downgraded.
      result2.warnings.push(
        'TRISS_CODER_PERSISTENCE_UNAVAILABLE: v2 session store unavailable — this native session is ephemeral and was NOT published for continuation',
      );
    }

    let filesChanged2 = null;
    let diffStat2 = null;
    let worktreeOut2 = null;
    if (isolation) {
      const changes = computeWorktreeChanges(sh, isolation.repoRoot, isolation.wtPath);
      if (changes.warnings.length) result2.warnings.push(...changes.warnings);
      filesChanged2 = changes.filesChanged;
      if (changes.filesChanged.length === 0) {
        try {
          gitWorktreeRemove(sh, isolation.repoRoot, isolation.wtPath, { force: true });
          if (isolation.branch.startsWith(CODER_BRANCH_PREFIX)) {
            const branchDeleted = gitBranchDeleteSafe(sh, isolation.repoRoot, isolation.branch);
            if (!branchDeleted) {
              result2.warnings.push(
                `branch ${isolation.branch} kept — not fully merged; a future --isolate --session ` +
                  `<slug> reusing this slug will fail until it's removed (see \`triss coder clean --all\`)`,
              );
            }
          }
        } catch (err) {
          result2.warnings.push(`isolate cleanup failed: ${err.message}`);
        }
      } else {
        filesChanged2 = changes.filesChanged;
        diffStat2 = changes.diffStat;
        worktreeOut2 = isolation.wtPath;
      }
    }

    // Never-zero missing usage: exit 0 without step_finish is NOT zero usage —
    // usage_status "missing", null canonical counters, null cost, explicit
    // warning. (estimateCanonicalCost would return plan-$0 for a subscription
    // model even with no counters; V2 must not claim that.)
    if (!result2.sawStepFinish) {
      result2.warnings.push(
        'OpenCode 2 emitted no step_finish event — usage counters unknown (usage_status "missing"); ' +
          'never reported as zero.',
      );
    }

    const { tokens: tokens2, usage_status: usageStatus2, warnings: normalizeWarnings2,
      reported_total_usd: reportedTotalUsd2, reported_total_source: reportedTotalSource2 } =
      finalizeOpencodeUsage(result2.usage);
    if (normalizeWarnings2.length) result2.warnings.push(...normalizeWarnings2);
    const usageTimestamp2 = new Date().toISOString();

    // Missing usage -> null cost object with explicit unknowns (the plan's
    // "never reported as zero" rule); reported usage -> normal canonical cost.
    let cost2;
    if (usageStatus2 === 'missing' || !result2.sawStepFinish) {
      cost2 = {
        input_uncached_usd: null,
        cache_read_usd: null,
        cache_write_usd: null,
        output_visible_usd: null,
        reasoning_usd: null,
        output_total_usd: null,
        reported_total_usd: null,
        reported_total_source: null,
        total_usd: null,
        source: 'unknown',
        complete: false,
        unknown_components: ['no_step_finish'],
      };
    } else {
      cost2 = estimateCanonicalCost({
        billing_model: modelUsed,
        billing_mode: resolveBillingMode({ billing_model: modelUsed, engine: 'opencode2' }),
        timestamp: usageTimestamp2,
        tokens: tokens2,
        // Provider-specific normalized cost: finalizeOpencodeUsage
        // returns reported_total_usd=null when per-step cost coverage is
        // INCOMPLETE — a partial sum must not leak into the envelope as an
        // authoritative number, and reported_total_source must stay 'null'
        // (not undefined → dropped in serialization) when unknown.
        reported_total_usd: reportedTotalUsd2,
        reported_total_source: reportedTotalSource2,
      });
    }

    const promptTokens2 = tokens2.input_uncached ?? 0;
    const completionTokens2 = tokens2.output_visible ?? 0;
    const ctx2 = currentCall();
    const logUsageFn2 = deps.logUsage || logUsage;
    logUsageFn2({
      model: modelUsed,
      billing_model: modelUsed,
      billing_mode: resolveBillingMode({ billing_model: modelUsed, engine: 'opencode2' }),
      usage_source: 'opencode2',
      engine: 'opencode2',
      usage_status: usageStatus2,
      timestamp: usageTimestamp2,
      tokens: tokens2,
      cost: cost2,
      label: 'coder',
      call_id: ctx2?.callId,
      parent_call_id: ctx2?.parentCallId,
    });

    const runIdentity2 = allocateRunIdentity({
      slug: opts.session || null,
      isolated: !!isolation,
      changed: (filesChanged2 || []).length > 0,
    });
    // Finalization MUST precede lifecycle derivation and envelope assembly.
    // The row is only persistent after the durable mapping and idle transition
    // have both been confirmed.
    const completionOutcome = await completeV2SessionRow(sessionV2, result2.sessionRealId);
    if (completionOutcome === 'retained_for_recovery') {
      throw new Error('coder-session: completion retained row for recovery — refusing to emit a clean envelope');
    }
    if (completionOutcome === 'removed_unusable' && sessionV2) {
      result2.warnings.push('TRISS_CODER_SESSION_NOT_RESUMABLE: native session id was not confirmed; persistent row removed');
    }

    const lifecycle2 = deriveV2LifecycleFields({
      timedOut: result2.timedOut,
      terminationCause: result2.terminationCause,
      signal: result2.signal,
      exitCode: result2.code,
      engineErrorObserved: Boolean(result2.terminalError),
      rateLimited: Boolean(rateLimit2),
      exitReason: exit_reason2,
      finalText: result2.finalText,
      toolActivityCount: result2.activity?.tool_uses || 0,
      isolated: !!isolation,
      callerWorktreeDowngrade: allowBestEffortCallerWorktree && !isolation && isolate,
      sessionRequested: Boolean(opts.session),
      v2SessionAdmitted: sessionV2 != null,
      completionOutcome,
    });
  const envelope2 = {
    engine: 'opencode2',
    envelope_version: 2,
    credential_mode: credentialMode,
    engine_version: engine2Version,
      ...buildOpenCodeEnvelopeRouting({
        modelUsed,
        credential: cred,
        route: runtimeRoute,
        canonical: canonicalOpenCodeRouting,
      }),
      session_id: result2.sessionRealId || null,
      ...runIdentity2,
      execution_capabilities: buildExecutionCapabilities({
        engine: 'opencode2',
        proxyAvailable: !!credentialProxy,
        credentialMode,
      }),
      ...lifecycle2,
      run_id: `run_${randomBytes(16).toString('hex')}`,
      started_at: new Date(spawnStartMs2).toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - spawnStartMs2,
      activity: result2.activity || { events: 0, tool_uses: 0, tool_errors: 0, by_tool: {}, saw_terminal_stop: false, first_event_at: null, last_event_at: null },
      small_model: smallModelUnused
        ? { requested: oneShotSmallModel, used: false }
        : { requested: null, used: false },
      exit_reason: exit_reason2,
      final_text: result2.finalText,
      files_changed: filesChanged2,
      diff_stat: diffStat2,
      worktree: worktreeOut2,
      usage: {
        schema_version: 2,
        usage_status: usageStatus2,
        tokens: tokens2,
        cost: cost2,
        prompt_tokens: promptTokens2,
        completion_tokens: completionTokens2,
      },
      warnings: result2.warnings,
    };

    const writeStdout2 = deps.stdoutWrite || ((s) => process.stdout.write(s));
    writeStdout2(JSON.stringify(envelope2) + '\n');
    return { completionOutcome };
    } catch (err) {
      if (!sessionV2?.finalizationAttempted) await releaseV2SessionRow(sessionV2);
      throw err;
    } finally {
      // The proxy is parent-owned and must not survive a V2 success, spawn
      // failure, preflight rejection, post-run compatibility failure, or
      // envelope assembly error. revoke() is idempotent; await closed makes
      // ownership complete before this run returns or throws.
      if (credentialProxy) {
        await releaseCredentialProxy();
      }
    }
  }

  const dir = isolation ? isolation.wtPath : opts.cwd ? resolvePath(opts.cwd) : null;

  const argv = buildOpencodeArgv({
    prompt,
    agent,
    model: canonicalOpenCodeRouting ? transientModelName(runtimeRoute) : modelUsed,
    sessionRealId: sessionRealIdV1,
    cont: !!opts.continue,
    dir,
    pure: openCodePureMode,
  });
  // Credential-proxy integration: the child env carries the one-run token in
  // the credential variable plus the loopback base URL — never the raw key.
  // The OPENCODE_CONFIG_CONTENT overlay (one-shot mode) pins the model; for
  // the triss-worker provider it additionally pins baseURL to the proxy.
  let proxiedConfigContent = routingConfigContent;
  if (!protectedRouting && oneShotProvider && cred.provider === 'worker' && credentialProxy) {
    const overlay = routingConfigContent ? JSON.parse(routingConfigContent) : {};
    proxiedConfigContent = JSON.stringify({
      ...overlay,
      provider: {
        ...(overlay.provider || {}),
        'triss-worker': {
          ...(overlay.provider?.['triss-worker'] || {}),
          options: {
            ...(overlay.provider?.['triss-worker']?.options || {}),
            baseURL: credentialProxy.scopedBaseUrl,
            apiKey: credentialProxy.token,
          },
        },
      },
    });
  }
  const env = buildEngineEnv(
    cred.env,
    credentialProxy ? credentialProxy.token : (canonicalOpenCodeRouting ? credentialValue : undefined),
    proxiedConfigContent,
  );
  const engineVersion = detectedOpencodeVersion || opencodeVersionPin();

  process.stderr.write(
    pc.dim(
      `[coder run] agent=${agent} model=${modelUsed}` +
        (oneShotProvider ? ` provider=${oneShotProvider} small_model=${oneShotSmallModel} one-shot` : '') +
        (isolation ? ` isolate=${isolation.wtPath}` : '') +
        '\n',
    ),
  );

  const spawnStartMs = Date.now();
  let result;
  let rateLimit;
  try {
    // Pre-spawn revalidation under the leases (same contract as the V2
    // branch): reserved -> running here; a foreign-tuple row fails closed.
    await revalidateV2SessionRowBeforeSpawn(sessionV2);
    result = await spawnEngine({
      argv,
      env,
      timeoutSec,
      spawnFn,
      sinceMs: spawnStartMs,
      scanRateLimit: deps.scanRateLimit,
      logPath: deps.logPath,
      pollMs: deps.pollMs,
      abortSignal: deps.abortSignal,
      killProcess,
      residualTermGraceMs: deps.residualTermGraceMs,
      residualKillWaitMs: deps.residualKillWaitMs,
      processGroupPollMs: deps.processGroupPollMs,
    });

    // GLM usage limit: opencode retries the failing provider call forever and
    // emits nothing parseable on stdout, so without this the run hangs to
    // --timeout and throws the generic "no parseable output". spawnEngine's
    // watchdog already killed the engine early on detection; here we turn it
    // into a clear error with the reset time converted from Z.AI's Beijing
    // clock to local. The fallback log scan covers a run that was killed some
    // other way (e.g. timeout) but whose log still shows the limit.
    rateLimit = result.rateLimit || findRecentRateLimit(spawnStartMs, { logPath: deps.logPath });
    if (rateLimit && !result.finalText) {
      const err = new Error(rateLimitMessage(rateLimit));
      err.rateLimit = rateLimit;
      throw err;
    }

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
    await releaseV2SessionRow(sessionV2);
    // setupIsolation ran BEFORE spawnEngine — a throw here would otherwise
    // leak a freshly-created worktree/branch (see cleanupAbandonedIsolation).
    if (isolation && isolation.freshlyCreated) {
      cleanupAbandonedIsolation(sh, isolation);
    }
    throw err;
  } finally {
    // component: the credential proxy is parent-owned and single-run —
    // revoke it as soon as the engine exits (success, failure, or throw).
    await releaseCredentialProxy();
  }

  // Rate limit that only hit AFTER the engine produced some text: keep the
  // partial envelope but flag it so the caller knows the run was cut short.
  if (rawCredentialWarning) result.warnings.unshift(rawCredentialWarning);
  if (rateLimit) result.warnings.push(rateLimitMessage(rateLimit));
  if (isolationDowngraded) result.warnings.push(`${ISOLATION_DOWNGRADED_CODE}: isolation unavailable — downgraded to caller worktree (best-effort; edits may reach current Git worktree)`);

  let exit_reason;
  if (result.timedOut) exit_reason = 'timeout';
  // A child that handles SIGTERM and exits with code=0/signal=null is still
  // `killed` when Triss recorded a termination cause before signalling
  // (Section 6.1); the cause is set BEFORE the signal is sent.
  else if (result.outputLimitObserved) exit_reason = 'error';
  else if (['caller_abort', 'host_signal', 'provider_rate_limit', 'output_limit', 'filesystem_quota', 'child_signal'].includes(result.terminationCause)) {
    exit_reason = 'killed';
  } else if (result.signal) exit_reason = 'killed';
  // A parseable top-level engine error event is a typed engine failure even
  // when the child exits zero (a fake-clean `end_turn` must never win).
  else if (result.engineErrorObserved) exit_reason = 'error';
  else if (result.code === 0) exit_reason = 'end_turn';
  else exit_reason = 'error';

  if (opts.session && result.sessionRealId && sessionV2) {
    persistSessionMapping(sh, engine, opts.session, result.sessionRealId);
    // Attribution anchor for the finalizer (exact-id rollback recognition).
    sessionV2.publishedRealId = result.sessionRealId;
  } else if (opts.session && result.sessionRealId && !sessionV2) {
    // Sanctioned ephemeral downgrade: never publish a resumable mapping
    // without a persistent claim behind it (orphan-mapping prevention).
    result.warnings.push(
      'TRISS_CODER_PERSISTENCE_UNAVAILABLE: v2 session store unavailable — this native session is ephemeral and was NOT published for continuation',
    );
  }

  // v2 contract: files_changed is [] ONLY for a successfully performed
  // comparison that found nothing; a run with no comparison (non-isolated)
  // reports null — never a fabricated empty list.
  let filesChanged = null;
  let diffStat = null;
  let worktreeOut = null;
  if (isolation) {
    const changes = computeWorktreeChanges(sh, isolation.repoRoot, isolation.wtPath);
    if (changes.warnings.length) result.warnings.push(...changes.warnings);
    // The comparison was PERFORMED: [] is the honest result for a verified
    // empty change (null stays reserved for no-comparison runs).
    filesChanged = changes.filesChanged;
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
      diffStat = changes.diffStat;
      worktreeOut = isolation.wtPath;
    }
  }

  if (!result.sawStepFinish) {
    result.warnings.push('no usage data (no step_finish events) in the event stream');
  }

  // Run-identity invariant: allocate the v2 identity from the actual run
  // facts — anonymous runs get anon-<32hex>; retention requires the full
  // eligibility matrix (isolated + changed + enforced quota + reservation).
  const runIdentity = allocateRunIdentity({
    slug: opts.session || slug || null,
    isolated: !!isolation,
    changed: (filesChanged || []).length > 0,
  });

  const { tokens, reported_total_usd, reported_total_source, usage_status, warnings: normalizeWarnings } =
    finalizeOpencodeUsage(result.usage);
  if (normalizeWarnings.length) result.warnings.push(...normalizeWarnings);
  const billing_model = modelUsed;
  const billing_mode = resolveBillingMode({ billing_model, engine: 'opencode' });
  const usageTimestamp = new Date().toISOString();
  // Estimate the canonical cost. An unknown provider zero stays unknown ("unknown
  // is not zero") — exactly how an engine zero on an unpriced pay-per-token route
  // reports source:'unknown', complete:false instead of a claimed $0.
  const cost = estimateCanonicalCost({
    billing_model,
    billing_mode,
    timestamp: usageTimestamp,
    tokens,
    reported_total_usd,
    reported_total_source,
  });
  // Deprecated aliases keep their pre-existing meaning and values: the summed
  // uncached input and the visible output. They are the pre-v2 shape and must
  // stay numeric for null-averse consumers — before the canonical split existed
  // the zero-initialized accumulator made a no-step run report 0/0, so when the
  // canonical value is unknown the alias falls back to 0. The canonical fields
  // remain the ones that distinguish unknown from zero.
  const promptTokens = tokens.input_uncached ?? 0;
  const completionTokens = tokens.output_visible ?? 0;
  const ctx = currentCall();
  const logUsageFn = deps.logUsage || logUsage;
  logUsageFn({
    model: modelUsed,
    billing_model,
    billing_mode,
    usage_source: 'opencode',
    engine: 'opencode',
    usage_status,
    timestamp: usageTimestamp,
    tokens,
    cost,
    label: 'coder',
    call_id: ctx?.callId,
    parent_call_id: ctx?.parentCallId,
  });

  // Finalization MUST precede lifecycle derivation and envelope assembly.
  const completionOutcome = await completeV2SessionRow(sessionV2, result.sessionRealId);
  if (completionOutcome === 'retained_for_recovery') {
    throw new Error('coder-session: completion retained row for recovery — refusing to emit a clean envelope');
  }
  if (completionOutcome === 'removed_unusable' && sessionV2) {
    result.warnings.push('TRISS_CODER_SESSION_NOT_RESUMABLE: native session id was not confirmed; persistent row removed');
  }

  // v2 lifecycle fields (Section 6.1/6.2): honest derivations from the
  // folded opencode event stream.
  const v2Lifecycle = deriveV2LifecycleFields({
    timedOut: result.timedOut,
    terminationCause: result.terminationCause,
    signal: result.signal,
    exitCode: result.code,
    engineErrorObserved: Boolean(result.engineErrorObserved),
    rateLimited: Boolean(result.rateLimit),
    exitReason: exit_reason,
    finalText: result.finalText,
    toolActivityCount: result.activity ? result.activity.tool_uses : 0,
    isolated: !!isolation,
    callerWorktreeDowngrade: allowBestEffortCallerWorktree && !isolation && isolate,
    sessionRequested: Boolean(opts.session || sessionRealIdV1),
    v2SessionAdmitted: sessionV2 != null,
    completionOutcome,
  });
  const finishedAtMs = Date.now();

  const envelope = {
    engine: 'opencode',
    envelope_version: 2,
    credential_mode: credentialMode,
    engine_version: engineVersion,
    ...buildOpenCodeEnvelopeRouting({
      modelUsed,
      credential: cred,
      route: runtimeRoute,
      canonical: canonicalOpenCodeRouting,
    }),
    session_id: result.sessionRealId || null,
    // component: every safe envelope carries the run identity + honest
    // execution capabilities (Section 6.3 / documented contract). The
    // identity is allocated from the ACTUAL run facts — anonymous runs get
    // anon-<32hex>, retention requires the full eligibility matrix.
    ...(runIdentity || {}),
    execution_capabilities: buildExecutionCapabilities({
      engine: 'opencode',
      proxyAvailable: !!credentialProxy,
      credentialMode,
    }),
    ...v2Lifecycle,
    run_id: `run_${randomBytes(16).toString('hex')}`,
    started_at: new Date(spawnStartMs).toISOString(),
    finished_at: new Date(finishedAtMs).toISOString(),
    duration_ms: finishedAtMs - spawnStartMs,
    activity: result.activity || {
      events: 0,
      tool_uses: 0,
      tool_errors: 0,
      by_tool: {},
      saw_terminal_stop: false,
      first_event_at: null,
      last_event_at: null,
    },
    exit_reason,
    final_text: result.finalText,
    files_changed: filesChanged,
    run_files_changed: filesChanged,
    diff_stat: diffStat,
    worktree: worktreeOut,
    usage: {
      schema_version: 2,
      usage_status,
      tokens,
      cost,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    },
    warnings: result.warnings,
  };

  // Injectable so tests don't have to monkey-patch the real
  // process.stdout.write — doing that across an `await` that yields the
  // event loop (as spawning a child process does) races with `node
  // --test`'s own internal reporter, which also writes to stdout between
  // turns and would otherwise corrupt the captured buffer.
  const writeStdout = deps.stdoutWrite || ((s) => process.stdout.write(s));
  writeStdout(JSON.stringify(envelope) + '\n');
  return { completionOutcome };
}

// ─── coder clean ─────────────────────────────────────────────────────────────

// Removes `.triss/wt/<slug>` worktrees whose branch has no diff vs the
// repo's default branch, then SAFE-deletes (`git branch -d`, never `-D`)
// the matching `coder/<slug>` branch so a re-run of `coder run --isolate`
// with the same slug can re-create it via `-b` (`-b`
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

// ─── v2 session CLI (shared contract) ──────────────────────────────────

/**
 * `triss coder session list [--engine <name>]`: serialize the bounded
 * component inventory projection. Exits 0 only for a complete canonical
 * projection; on error writes typed diagnostics to stderr and emits no
 * partial JSON.
 */
export async function runCoderSessionList(opts = {}, deps = {}) {
  if (opts.engine && !CODER_SESSION_ENGINES.includes(opts.engine)) {
    throw new Error(`--engine must be one of: ${CODER_SESSION_ENGINES.join(', ')}`);
  }
  const { listCoderSessions } = await import('../coder-session-transitions.js');
  const inventoryDir = join(projectRoot(), '.triss', 'engine-sessions-v2', opts.engine || 'opencode');
  const sessions = await listCoderSessions({ inventoryDir });
  const writeStdout = deps.stdoutWrite || ((s) => process.stdout.write(s));
  writeStdout(`${JSON.stringify({ schema_version: 1, sessions })}\n`);
}

/**
 * `triss coder session clean <slug> --engine <opencode|opencode2|crush>`:
 * requires the engine flag (one canonical enum shared by CLI validation,
 * help, docs, and this implementation — opencode2 rows are first-class
 * persistent sessions and MUST be cleanable). Forms its own COMPLETE clean
 * owner tuple (run id, sandbox id, live PID + process-start + boot identity)
 * and holds the normative clean lease — shared maintenance (whole cycle),
 * conditional-target for non-isolated rows, the row's STORED assigned slot,
 * brief exclusive inventory scopes.
 *
 * Ordering is crash-safe: the durable idle -> deleting transition publishes
 * FIRST (the deleting row is the recovery breadcrumb), then the engine-owned
 * store mapping is removed while the prefix stays held, and only after that
 * a final brief inventory scope removes the row. A crash at any point leaves
 * either an intact idle row or a deleting breadcrumb; a later clean takes
 * the idempotent deleting-recovery path and always converges.
 */
export async function runCoderSessionClean(slug, opts = {}) {
  if (!opts.engine || !CODER_SESSION_ENGINES.includes(opts.engine)) {
    throw new Error(`--engine <${CODER_SESSION_ENGINES.join('|')}> is required for session clean`);
  }
  const { beginCoderSessionDelete, removeCoderSessionRow } =
    await import('../coder-session-transitions.js');
  const { readCoderSessionInventory } = await import('../coder-session-inventory-codec.js');
  const inventoryDir = join(projectRoot(), '.triss', 'engine-sessions-v2', opts.engine);
  // The clean action owns its complete owner tuple: the canonical deleting
  // row requires run id + sandbox id + positive PID + process-start identity
  // + boot identity, so a bare {inventoryDir, engine, slug} transition is
  // invalid and would fail closed.
  const ownerTuple = currentSessionOwnerTuple();
  const cleanRunId = `run_${randomBytes(16).toString('hex')}`;
  const cleanSandboxId = `sbx_${randomBytes(16).toString('hex')}`;
  const parentHandle = await openManagedTrissRoot(projectRoot());

  // ONE shared maintenance scope covers DISCOVERY through COMPLETION. Taking
  // it BEFORE the first snapshot means no exclusive-maintenance writer
  // (backup transaction) can interleave, and every later observation below
  // happens under the same umbrella. ABA defense: the discovery row's EXACT
  // identity is pinned here and byte-revalidated after every lock
  // re-acquisition — the immutable session_instance_id (128 random bits)
  // is the primary anchor, so a same-slug REPLACEMENT (even one that
  // coincides on slot/mode/fingerprint AND millisecond created_at) is never
  // deletable by an older clean attempt.
  const maintenance = await acquireCoderMaintenanceLock({ parentHandle, mode: 'shared' });
  let target;
  let slotLease;
  let removedMapping;
  let recovering = false;
  try {
    // Discovery snapshot (plain read; exclusive writers are excluded by our
    // maintenance scope).
    const snapshot = await readCoderSessionInventory(inventoryDir);
    if (snapshot.error) throw new Error(snapshot.error);
    const snapRow = snapshot.entries.find((s) => s.slug === slug);
    if (!snapRow) {
      process.stderr.write(pc.dim(`  · no v2 session ${slug} for engine ${opts.engine}\n`));
      return;
    }
    recovering = snapRow.state === 'deleting';
    if (!recovering && snapRow.state !== 'idle') {
      throw new Error(`session ${slug} is not idle (state=${snapRow.state}); only inactive sessions can be cleaned`);
    }
    if (recovering && typeof snapRow.deleting_basename === 'string'
        && !snapRow.deleting_basename.startsWith(`.deleting-${opts.engine}-${slug}-`)) {
      throw new Error(`session ${slug} carries a foreign deleting breadcrumb (${snapRow.deleting_basename}) — retain, fail closed`);
    }
    const identity = {
      // PRIMARY anchor: the immutable 128-bit incarnation identity minted at
      // this row's reservation. created_at (millisecond precision) is kept
      // only as a secondary metadata anchor — it can coincide across two
      // incarnations and must never be the identity.
      session_instance_id: snapRow.session_instance_id,
      isolation_mode: snapRow.isolation_mode,
      lock_slot: snapRow.lock_slot,
      project_root_fingerprint: snapRow.project_root_fingerprint,
      created_at: snapRow.created_at,
    };
    const recoveryBasename = recovering ? snapRow.deleting_basename : null;
    // ABA anchors are ONLY the immutable identity fields. State and the
    // deleting breadcrumb are deliberately EXCLUDED: this clean's own
    // breadcrumb transition legitimately changes them between phases.
    const sameRow = (candidate) => Boolean(candidate)
      && ['session_instance_id', 'isolation_mode', 'lock_slot', 'project_root_fingerprint', 'created_at']
        .every((key) => candidate[key] === identity[key]);

    // Normative order under the held maintenance: conditional-target
    // (non-isolated rows), then the STORED assigned slot.
    target = isolationModeFor(snapRow.isolation_mode) === 'non-isolated'
      ? await acquireCoderTargetLease({ parentHandle })
      : null;
    slotLease = await acquireCoderSlotLease({ parentHandle, lockSlot: `session-${identity.lock_slot}` });

    // Brief inventory #1: EXACT row revalidation, then publish the DELETING
    // breadcrumb with this attempt's complete clean owner tuple.
    await withCoderInventoryLock({ parentHandle }, async () => {
      const fresh = await readCoderSessionInventory(inventoryDir);
      if (fresh.error) throw new Error(fresh.error);
      const freshRow = fresh.entries.find((e) => e.engine === opts.engine && e.slug === slug);
      if (!sameRow(freshRow)) {
        throw new Error(
          `session ${slug} changed while clean was starting (replaced or removed — ABA guard) — ` +
            'retain, fail closed',
        );
      }
      if (freshRow.state !== 'deleting') {
        await beginCoderSessionDelete({
          inventoryDir,
          engine: opts.engine,
          slug,
          runId: cleanRunId,
          sandboxId: cleanSandboxId,
          ...ownerTuple,
        });
      }
    });
    // Inventory released; owner prefix STILL held: remove the engine-owned
    // store artifact only after the deleting state is durably published.
    removedMapping = removeSessionStoreMapping(opts.engine, slug);

    // Brief inventory #2: verify the EXACT deleting breadcrumb we published
    // (or the recovered one), then the row goes away last.
    await withCoderInventoryLock({ parentHandle }, async () => {
      const fresh = await readCoderSessionInventory(inventoryDir);
      if (fresh.error) throw new Error(fresh.error);
      const freshRow = fresh.entries.find((e) => e.engine === opts.engine && e.slug === slug);
      if (!sameRow(freshRow)) {
        throw new Error(
          `session ${slug} changed while its artifacts were being removed (ABA guard) — retain, fail closed`,
        );
      }
      if (freshRow.state !== 'deleting') {
        throw new Error(`session ${slug} must be deleting before removal, got ${freshRow.state}`);
      }
      const expectedBasename = recovering
        ? recoveryBasename
        : `.deleting-${opts.engine}-${slug}-${cleanRunId}`;
      if (freshRow.deleting_basename !== expectedBasename) {
        throw new Error(
          `unexpected deleting breadcrumb for ${slug}: ${freshRow.deleting_basename} — retain, fail closed`,
        );
      }
      await removeCoderSessionRow({ inventoryDir, engine: opts.engine, slug });
    });
  } finally {
    // Strict reverse order: slot -> target -> maintenance.
    if (slotLease) await slotLease.release();
    if (target) await target.release();
    await maintenance.release();
  }
  process.stderr.write(
    pc.dim(
      `  · removed v2 session ${slug} (engine ${opts.engine}` +
        `${removedMapping ? ', store mapping cleared' : ''}${recovering ? ', recovered from deleting' : ''})\n`),
  );
}

// isolation_mode (row form) -> lease wrapper form ('isolated'|'non-isolated').
function isolationModeFor(rowMode) {
  return rowMode === 'isolated' ? 'isolated' : 'non-isolated';
}

/**
 * `triss coder state adopt --from-project-id <32hex>`: explicit operator
 * action; moves old owned state to quarantine with a NEW project id.
 */
export async function runCoderStateAdopt(opts = {}) {
  const { loadOrCreateProjectIdentity } = await import('../coder-state.js');
  const { adoptOrQuarantineCoderState } = await import('../coder-state.js');
  if (!opts.fromProjectId || !/^[0-9a-f]{32}$/.test(opts.fromProjectId)) {
    throw new Error('--from-project-id <32hex> is required for state adopt');
  }
  const trissRoot = join(projectRoot(), '.triss');
  const identity = await loadOrCreateProjectIdentity(trissRoot);
  if (identity.project_id === opts.fromProjectId) {
    throw new Error('adopt requires a DIFFERENT newly generated project id');
  }
  const result = await adoptOrQuarantineCoderState({
    trissRootPath: trissRoot,
    oldProjectId: opts.fromProjectId,
    newProjectId: identity.project_id,
  });
  process.stderr.write(
    pc.dim(`  · quarantined ${opts.fromProjectId} -> ${identity.project_id} at ${result.quarantine_dir}\n`),
  );
}

/**
 * `triss coder state reset --project`: quarantine all validated local v2
 * state and create an empty identity (never deletes it).
 */
export async function runCoderStateReset(opts = {}) {
  if (!opts.project) {
    throw new Error('--project is required for state reset');
  }
  const { resolve: resolvePath } = await import('node:path');
  const { loadOrCreateProjectIdentity } = await import('../coder-state.js');
  const { randomBytes } = await import('node:crypto');
  const { mkdir, readdir, rename, rm } = await import('node:fs/promises');
  // --project names the target tree: resetting repo-B from repo-A's cwd must
  // never quarantine repo-A's state. Resolve the EXPLICIT path, not cwd.
  const trissRoot = join(resolvePath(opts.project), '.triss');
  // A fresh identity is created only after the old one is quarantined;
  // the identity itself is never deleted.
  const identity = await loadOrCreateProjectIdentity(trissRoot);

  // Invariant: actually quarantine ALL validated v2 state — every session and
  // result state directory is MOVED (recoverable) under the quarantine
  // root, not merely reported. The identity file itself is never deleted.
  const quarantineRoot = join(trissRoot, 'quarantine-v1');
  const stamp = `${Date.now()}-${randomBytes(8).toString('hex')}`;
  let quarantined = 0;
  const stateRoots = ['coder-state-v2', 'engine-sessions-v2', 'coder-results-v1'];
  for (const root of stateRoots) {
    const src = join(trissRoot, root);
    let entries;
    try {
      entries = await readdir(src, { withFileTypes: true });
    } catch {
      continue; // root absent: nothing to quarantine
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const dst = join(quarantineRoot, `${root}-${stamp}`, ent.name);
      await mkdir(join(quarantineRoot, `${root}-${stamp}`), { mode: 0o700, recursive: true });
      try {
        await rename(join(src, ent.name), dst);
        quarantined += 1;
      } catch (err) {
        if (err && err.code !== 'ENOENT') throw err;
      }
    }
    // Remove the now-empty root so a fresh project state starts clean.
    try {
      await rm(src, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
  }

  // Quarantine the old project-identity-v1.json and create a fresh identity
  const identityFile = join(trissRoot, 'project-identity-v1.json');
  try {
    await mkdir(join(quarantineRoot, `identity-${stamp}`), { mode: 0o700, recursive: true });
    await rename(identityFile, join(quarantineRoot, `identity-${stamp}`, 'project-identity-v1.json'));
    await loadOrCreateProjectIdentity(trissRoot);
  } catch (err) {
    if (err && err.code !== 'ENOENT') throw err;
  }

  process.stderr.write(pc.dim(
    `  · reset project ${identity.project_id}: quarantined ${quarantined} state record(s)\n`,
  ));
}

/**
 * `triss coder result list`: bounded retained-result projection.
 */
export async function runCoderResultList(deps = {}) {
  const { listCoderRetainedResults } = await import('../coder-result-transitions.js');
  const { readdir } = await import('node:fs/promises');
  const resultsRoot = join(projectRoot(), '.triss', 'coder-results-v1', 'runs');
  let runDirs = [];
  try {
    runDirs = (await readdir(resultsRoot)).map((name) => join(resultsRoot, name));
  } catch {
    // No results root: empty list.
  }
  const results = await listCoderRetainedResults({ runDirs });
  const writeStdout = deps.stdoutWrite || ((s) => process.stdout.write(s));
  writeStdout(`${JSON.stringify({ schema_version: 1, results })}\n`);
}

/**
 * `triss coder result clean <run-id>`: removes only a validated retained
 * result artifact, never a persistent session selected by a slug.
 */
export async function runCoderResultClean(runId, _opts = {}, deps = {}) {
  if (!runId || !/^run-[0-9a-f]{32}$/.test(runId)) {
    throw new Error('result clean requires a valid <run-id> (run-<32 lowercase hex>)');
  }
  const { beginCoderResultDeletion } = await import('../coder-result-transitions.js');
  const { rm, stat } = await import('node:fs/promises');
  const runDir = join(projectRoot(), '.triss', 'coder-results-v1', 'runs', runId);

  // Invariant: go through the deletion state machine (tombstone first), not a
  // bare recursive rm — a crash mid-delete must leave a recoverable
  // `.deleting.json` marker, and the run dir must be a validated registry
  // entry (state.json present) before anything is removed.
  try {
    await stat(runDir);
  } catch {
    throw new Error(`retained result ${runId} not found`);
  }
  const tombstone = await beginCoderResultDeletion({ runDir, runId });
  if (tombstone === null) {
    throw new Error(`retained result ${runId} has no valid state record (refusing blind delete)`);
  }
  // Durable phase breadcrumbs: every artifact class is confirmed gone before
  // the terminal phase, so a crash mid-delete leaves a recoverable marker
  // naming exactly what remains.
  const { advanceCoderResultDeletionPhase, RESULT_DELETE_PHASE } = await import('../coder-result-transitions.js');
  const runSub = (name) => join(runDir, name);
  for (const [phase, artifact] of [
    [RESULT_DELETE_PHASE[1], 'worktree'],
    [RESULT_DELETE_PHASE[2], 'branch'],
    [RESULT_DELETE_PHASE[3], 'state'],
  ]) {
    await rm(runSub(artifact), { recursive: true, force: true }).catch(() => {});
    await advanceCoderResultDeletionPhase({ runDir, runId, phase });
  }
  await rm(runDir, { recursive: true, force: true });
  const writeStderr = deps?.stderrWrite || ((s) => process.stderr.write(s));
  writeStderr(pc.dim(`  · removed retained result ${runId}\n`));
}

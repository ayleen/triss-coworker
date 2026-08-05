// `triss coder` — delegate coding tasks to a GLM agent. opencode is the
// default engine (deny-first bash policy); crush is an optional second
// engine behind --engine crush / TRISS_CODER_ENGINE=crush (single JSON
// envelope, native session ids; crush 0.1.3's permissions.run config is
// currently inert, so crush defaults to worktree isolation and an opt-in
// CLI-flag allowlist — see src/coder-engines/crush.js and
// docs/crush-restrict-issues.md).
// See docs/coder-agent-plan.md for the original roadmap (init/run/clean,
// the opencode adapter, MCP wiring — all shipped). Naming: "agent" is
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
} from 'node:fs';
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
  activeEnvFiles,
  readEnvFile,
} from '../secrets.js';
import { projectRoot } from '../safety.js';
import { logUsage } from '../usage.js';
import { currentCall } from '../call-context.js';
import { defaultBranchVia } from '../git.js';
import {
  ZAI_CODING_PLAN_BASE_URL,
  ZAI_PAYG_BASE_URL,
} from '../zai.js';
import {
  OPENCODE_CATALOGUE_TRANSIENT_HTTP_STATUSES,
  isTransientOpenCodeReadError,
} from '../opencode-catalogue.js';
// crush is the SECOND coding engine behind `--engine crush`. The adapter is
// pure (detect/argv/env/parse/map); this module owns the engine-agnostic
// orchestration (isolation, spawn, envelope assembly). See Phase 6 step 1 in
// docs/coder-agent-plan.md and docs/crush-issues.md.
import { crush as crushEngine } from '../coder-engines/crush.js';

// Pinned opencode-ai version, overridable for testing/upgrades.
// 1.18.7 (2026-07-27): 1.18.x is bugfix/Desktop work with no `run` CLI
// changes; 1.18.4 specifically improved Kimi model handling.
export const OPENCODE_PIN = '1.18.7';
// Provider corrected during Phase 0 recon: the configured ZHIPU_API_KEY is
// a `zai-coding-plan` (subscription) key, not a pay-as-you-go `zai` key —
// `zai/glm-*` fails with "Insufficient balance or no resource package" on
// that key. See docs/coder-agent-plan.md's "Recon results" section.
const DEFAULT_CODER_MODEL = 'zai-coding-plan/glm-5.2';
const DEFAULT_CODER_SMALL_MODEL = 'zai-coding-plan/glm-5-turbo';

// Default coding engine. opencode is engine #1 (shipped — deny-first
// opencode.json policy is its safety layer). crush is engine #2 (Phase 6 —
// simpler single-envelope model, but a weaker safety story: crush 0.1.3's
// permissions.run config is inert and denied bash deadlocks, so this module
// compensates by defaulting --isolate ON for crush and making restrict opt-in).
// Override per-call via --engine or globally via TRISS_CODER_ENGINE.
export const DEFAULT_CODER_ENGINE = 'opencode';
const VALID_CODER_ENGINES = ['opencode', 'crush'];

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
// against platform.kimi.ai docs 2026-07-27). kimi-k2.7-code is the recommended
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
// preset/existing model the catalogue no longer lists. Warns clearly when
// availability could not be verified. When the catalogue IS verified but lists
// none of triss's known free models, mainDefault/smallDefault come back
// undefined — the caller then blocks (or honors an in-catalogue preset) rather
// than pinning a model the catalogue just said is gone.
function resolveZenCatalogue(available) {
  if (!available) {
    process.stderr.write(
      pc.yellow(
        '  ⚠ could not fetch the OpenCode Zen catalogue — using built-in model defaults; their ' +
          'availability is NOT verified (free Zen models are temporary). If a run fails immediately, ' +
          'set TRISS_CODER_MODEL to a model listed at https://opencode.ai/docs/zen/.\n',
      ),
    );
    return {
      available: null,
      choices: ZEN_MODEL_CHOICES,
      mainDefault: ZEN_MAIN_PRIORITY[0],
      smallDefault: ZEN_SMALL_PRIORITY[0],
    };
  }
  const firstAvailable = (priority) => priority.find((id) => available.has(id));
  const choices = ZEN_MODEL_CHOICES.filter((c) => available.has(c.value));
  const mainDefault = firstAvailable(ZEN_MAIN_PRIORITY);
  // Any available model can serve as the small/fast one, so if none of the
  // small-priority ids remain but a main model does, reuse it rather than
  // leaving small unresolved (which would falsely trip the "none known" block).
  const smallDefault = firstAvailable(ZEN_SMALL_PRIORITY) || mainDefault;
  return { available, choices, mainDefault, smallDefault };
}

// Init-time picker choices for the provider itself (opencode engine only).
const CODER_PROVIDER_CHOICES = [
  { label: 'Z.AI GLM (glm-5.2, …) — needs a Z.AI key', value: 'zai' },
  { label: 'OpenCode Zen (free models incl. DeepSeek V4 Flash) — needs an OpenCode key', value: 'opencode-zen' },
  { label: 'OpenCode Go subscription (DeepSeek V4 Flash) — uses an OpenCode key', value: 'opencode-go' },
  { label: 'Moonshot Kimi pay-as-you-go (kimi-k2.7-code, kimi-k3) — needs a Moonshot key', value: 'moonshot' },
  { label: 'Kimi for Coding subscription (K3) — needs a Kimi for Coding key', value: 'kimi-for-coding' },
];

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
  { allowUnverified = false, scope = 'global' } = {},
) {
  // For Zen, resolve defaults + picker order against the LIVE catalogue (free
  // models are temporary) so we never pin a model that's already gone.
  const openCodeCatalogue =
    providerInfo.kind === 'opencode-zen'
      ? resolveZenCatalogue(await fetchZenModelIds(deps.fetch || globalThis.fetch))
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
  const providerVerifiedAbsent = (m) =>
    !!providerAvailable && !!m && !providerAvailable.has(providerModelId(m));

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
          // A stale Zen pin the catalogue no longer lists: don't honor it —
          // fall through to an available model instead of pinning a dead id.
          process.stderr.write(
            pc.yellow(
              `  ⚠ ignoring ${envVar}=${preset} — it is not in the current ${cat.noun} catalogue; ` +
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
  // A preset/existing model with a prefix triss doesn't recognize is routed to
  // ZHIPU_API_KEY by default (coderModelCredential) and can never be served —
  // opencode retries it forever. Warn rather than silently pin it.
  for (const [field, m] of [['TRISS_CODER_MODEL', model], ['TRISS_CODER_SMALL_MODEL', smallModel]]) {
    if (!isKnownProviderPrefix(m)) {
      process.stderr.write(
        pc.yellow(
          `  ⚠ ${field} resolved to "${m}", whose provider prefix triss doesn't recognize ` +
            '(known: zai-coding-plan/*, zai/*, opencode/*, opencode-go/*, moonshotai/*, moonshotai-cn/*, ' +
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
  if (['opencode-zen', 'opencode', 'zen'].includes(v)) return 'opencode-zen';
  if (['opencode-go', 'go'].includes(v)) return 'opencode-go';
  if (['moonshot', 'kimi', 'moonshotai'].includes(v)) return 'moonshot';
  if (['kimi-for-coding', 'kimi-coding', 'kimi-code'].includes(v)) return 'kimi-for-coding';
  throw new Error(
    `Unknown --provider "${raw}" — valid values: zai, opencode-zen, opencode-go, moonshot, kimi-for-coding.`,
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
      '  triss config wizard coder --coder-engine opencode --coder-provider opencode-zen\n' +
      '  triss config wizard coder --coder-engine opencode --coder-provider opencode-go\n' +
      '  triss config wizard coder --coder-engine opencode --coder-provider moonshot\n' +
      '  triss config wizard coder --coder-engine opencode --coder-provider kimi-for-coding',
  );
}

// Per-provider key descriptor for setupKey / the init prompt.
function coderProviderKeyInfo(provider) {
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
  const provider = String(model || '').split('/')[0];
  if (provider === 'opencode') return { env: 'OPENCODE_API_KEY', provider: 'opencode-zen' };
  if (provider === 'opencode-go') return { env: 'OPENCODE_API_KEY', provider: 'opencode-go' };
  if (provider === 'moonshotai' || provider === 'moonshotai-cn') {
    return { env: 'MOONSHOT_API_KEY', provider: 'moonshot' };
  }
  if (provider === 'kimi-for-coding') return { env: 'KIMI_API_KEY', provider: 'kimi-for-coding' };
  return { env: 'ZHIPU_API_KEY', provider: 'zai' };
}

// Provider prefixes triss actually knows how to authenticate. Anything else is
// routed to ZHIPU_API_KEY by coderModelCredential's default, which then can't
// serve it — a silent infinite-retry trap. Used to warn at init time.
const KNOWN_PROVIDER_PREFIXES = new Set([
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
export function coderCredentialReady() {
  return !!(
    process.env.ZHIPU_API_KEY ||
    process.env.OPENCODE_API_KEY ||
    process.env.MOONSHOT_API_KEY ||
    process.env.KIMI_API_KEY
  );
}

// ─── wizard manifest ─────────────────────────────────────────────────────────

// Pseudo-manifest so `triss config wizard` / `triss status` can surface
// coder setup alongside real integrations. Field is `name`, NOT `key` —
// every consumer (envReadiness, wizard prompts, status markers) reads
// `.name`. Has no `register()` — do NOT add to loadIntegrations(), it
// requires that (see src/integrations/_contract.js validateManifest).
export const CODER_MANIFEST = {
  name: 'coder',
  description: 'Coding agent — GLM, Kimi, OpenCode Zen, or OpenCode Go models (opencode or crush engine)',
  envVars: [
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
  // Capture model overrides that are in the environment BEFORE loadEnvFiles()
  // merges the .env files — i.e. genuine shell exports, which have higher
  // precedence than any .env file and so would shadow whatever init pins.
  const inheritedModels = {
    model: process.env.TRISS_CODER_MODEL,
    smallModel: process.env.TRISS_CODER_SMALL_MODEL,
  };
  loadEnvFiles();
  const engine = resolveCoderEngine(opts);
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
  const path = ensureEnvFile(scope);
  await setupKey(path, provider);
  if (scope === 'local' && addToGitignore('.triss.env')) {
    process.stderr.write(pc.dim('  · added .triss.env to .gitignore\n'));
  }
  if (engine === 'crush') {
    // crush init's jobs beyond the shared ZHIPU_API_KEY setup: (1) pin the
    // default model atoms (glm5_2 / glm5_turbo) via `crush models use` so
    // --role smart/fast resolve to GLM deterministically; (2) seed the
    // permissions.run policy (restrict + read-only allow_bash) into crush.json
    // as a FORWARD-COMPAT gesture — crush 0.1.3 currently IGNORES this block
    // (docs/crush-restrict-issues.md), so it does NOT make crush restricted by
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
    await runCoderSetup(
      {
        scope,
        provider,
        inheritedModels,
        allowUnsafeBash: opts.allowUnsafeBash,
        allowUnverified: opts.allowUnverified,
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
  if (!process.env[keyEnv]) {
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

// Warn when the model just pinned by init will be overridden in a fresh process
// by a higher-precedence source: a shell export (beats every .env file) or a
// higher-precedence .env file (local `.triss.env` beats global). Silent here
// means a green "Done." followed by `ZHIPU_API_KEY is not set` on the next run.
// Returns true if it emitted any shadow warning (so the caller can withhold the
// green "Done.").
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

async function setupKey(path, provider = 'zai') {
  const info = coderProviderKeyInfo(provider);
  const existing = process.env[info.env];
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
export async function runCoderSetup(
  { scope, provider, engine, inheritedModels, allowUnsafeBash, allowUnverified } = {},
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
  await ensureEngine(sh, deps.confirmInstall);
  // Z.AI plan detection only applies to the zai kind: Zen models resolve via
  // opencode's built-in `opencode` provider, and the two Kimi kinds already
  // name their endpoint through the credential env — nothing to probe.
  const detectedZai =
    resolvedProvider === 'zai'
      ? await detectAndReportZaiProvider(deps.fetch || globalThis.fetch)
      : null;
  const providerInfo = { kind: resolvedProvider, detectedZai };
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
    { allowUnverified, scope: resolvedScope },
  );
  let blocking = writeOpencodeConfig(resolvedScope, providerInfo, model, smallModel, {
    allowUnsafeBash,
    providerAvailable,
  }).blocking;
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
    const projectCfg = opencodeConfigPath('local');
    if (existsSync(projectCfg) && projectCfg !== opencodeConfigPath('global')) {
      // The stale-Zen incident most often lives in this higher-precedence
      // project file (a previous init pinned opencode/hy3-free here before the
      // promo model was retired). Report it with the same recovery commands.
      emitZenStaleIncident(projectCfg, readOpencodeModels(projectCfg), { model, smallModel }, zenAvailable, 'local', deps);
      const otherAudit = auditExistingConfig(projectCfg, providerInfo, {
        note: '(project scope — higher precedence than the global config, so it governs runs)',
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
    // (coder-init P2-round8) match on "existing opencode.json issues".
    throw new Error(
      'Coder setup incomplete: fix the existing opencode.json issues reported above, then re-run `triss coder init`.',
    );
  }
  persistCoderModels(resolvedScope, model, smallModel);
  scaffoldAgentTemplates(resolvedScope);
  // Missing-key gate runs HERE (not only in runCoderInit) so the wizard's
  // postSetup path — `config wizard coder` calls runCoderSetup directly, never
  // runCoderInit — is gated too: without the provider's key the setup isn't
  // runnable, so fail rather than print a green "Done." the next run
  // contradicts with "<KEY> is not set". Config + templates are already on
  // disk, so re-running after setting the key is a clean idempotent completion.
  const keyEnv = coderProviderKeyInfo(resolvedProvider).env;
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
  const r = sh('opencode', ['--version']);
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

// crush.json locations (verified live, Phase 6 recon): `crush models use ...
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
// FORWARD-COMPAT CAVEAT (live-verified 2026-07-06, docs/crush-restrict-issues.md):
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
// docs/crush-restrict-issues.md): crush 0.1.3 IGNORES the permissions.run
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

// Resolve the crush restrict tristate to a concrete boolean. Order (per the
// Phase 6 fix spec):
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
    providerInfo.kind === 'opencode-zen'
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
// line so existing contracts like coder-init P2-round8 keep matching, while
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
  // Corrective Blocker B: print exactly ONE executable persistent repair
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
  if (existing?.permission?.bash?.['*'] !== 'deny') {
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
    warnIfProviderMismatch(path, providerInfo);
    return auditExistingConfig(path, providerInfo, {
      allowUnsafeBash: opts.allowUnsafeBash,
      resolvedSmall: smallModel,
      providerAvailable: opts.providerAvailable,
    });
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(opencodeConfigTemplate(model, smallModel), null, 2) + '\n');
  process.stderr.write(pc.green(`  ✓ wrote ${path} (model=${model}, small_model=${smallModel})\n`));
  return { blocking: false };
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
// or a non-git cwd never crashes `triss status`. Additively reports BOTH
// engines (opencode #1, crush #2) and which engine a bare `triss coder run`
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
  // crush engine #2 — additive awareness. detect() is presence-only (crush
  // --version reports a dirty dev string, docs/crush-issues.md); crush.json
  // presence is a best-effort file check, never parsed deeply. Never throws.
  const crushDetect = crushEngine.detect(sh);
  const crushConfigs = ['global', 'local'].map((scope) => {
    const path = crushConfigPath(scope);
    return { scope, path, exists: existsSync(path) };
  });
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
    defaultEngine,
    defaultModel,
    defaultSmallModel,
  };
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

// ─── event folding (exported: replayable against the Phase 0 fixture) ──────────

export function createEventFolder() {
  return {
    parsedAnyEvent: false,
    sessionRealId: null,
    finalText: null,
    usage: { input: 0, output: 0 },
    sawStepFinish: false,
    warnings: [],
    rateLimit: null,
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
      // A terminal rate-limit error (rare on stdout — usually retried
      // silently and only logged) still gets recognised here so the live
      // path can kill early and report the reset time.
      const rl = parseRateLimitReset(msg) || parseRateLimitReset(line);
      if (rl && !state.rateLimit) state.rateLimit = rl;
      break;
    }
    default:
      state.warnings.push(`unknown event type: ${evt.type}`);
  }
}

// ─── engine env / argv ──────────────────────────────────────────────────────────

// Minimal allowlist env for the engine subprocess — never spread
// process.env, so the engine only ever sees what it needs. `credEnv` is the
// single provider key the resolved model requires (from coderModelCredential):
// only that key is forwarded, so a Zen run never carries the Z.AI key and vice
// versa, even when both are configured. Included only when actually set — an
// unconfigured credential never appears.
function buildEngineEnv(credEnv) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[key] != null) env[key] = process.env[key];
  }
  if (credEnv && process.env[credEnv]) env[credEnv] = process.env[credEnv];
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
// How often to poll the engine log for a usage-limit line while a run is in
// flight. On a rate-limited run opencode emits nothing on stdout and retries
// forever, so without this the run hangs to --timeout; polling turns that
// into a ~poll-interval-latency clear error instead.
const RATE_LIMIT_POLL_MS = 3000;

function spawnEngine({ argv, env, timeoutSec, spawnFn, sinceMs, scanRateLimit, logPath, pollMs }) {
  // pollMs === 0 disables the watchdog entirely; null/undefined uses the
  // default cadence. Tests set a small value to exercise the poll path.
  const resolvedPollMs = pollMs == null ? RATE_LIMIT_POLL_MS : pollMs;
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
    let pollTimer = null;
    const state = createEventFolder();
    const stderrChunks = [];

    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* already gone */
      }
    };
    // Schedule the SIGKILL escalation AT MOST ONCE — the timeout, the
    // rate-limit poll, and the stdout-error path can all send SIGTERM, but a
    // second graceTimer would leak past settle() (which only clears the
    // latest reference) and fire a stray SIGKILL at an already-reaped group.
    // The `settled` guard also stops a buffered stdout line delivered after
    // 'close' from arming a fresh timer that outlives settle().
    const scheduleSigkill = () => {
      if (settled || graceTimer) return;
      graceTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
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
          killGroup('SIGTERM');
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
      if (pollTimer) clearInterval(pollTimer);
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
        const hadRateLimit = state.rateLimit;
        foldEventLine(state, line, {
          onToolUse: (evt) => {
            const tool = evt.part?.tool || 'tool';
            const denied = evt.part?.state?.status === 'error';
            process.stderr.write(pc.dim(`  → ${tool}${denied ? ' (denied/error)' : ''}\n`));
          },
        });
        // A rate-limit error that DID reach stdout: kill early, same as the
        // log-poll path, so we don't wait out --timeout. Guard on `settled`
        // so a line buffered past 'close' can't signal a reaped/recycled pid.
        if (state.rateLimit && !hadRateLimit && !settled) {
          killGroup('SIGTERM');
          scheduleSigkill();
        }
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

// ─── crush spawn + flow (engine #2) ─────────────────────────────────────────────
//
// spawnCrush mirrors spawnEngine's process-management (detached process group,
// timeout, SIGTERM->SIGKILL escalation, host SIGINT/SIGTERM forwarding) but for
// crush's single-envelope output model: NO ndjson fold, NO rate-limit log
// polling (crush has its own --timeout that preserves the partial answer and
// does not retry a failing call forever — see docs/coder-agent-plan.md Phase 6
// recon). crush writes the whole JSON envelope at end-of-run, so stdout is
// buffered fully and parsed once on close.

function spawnCrush({ argv, env, timeoutSec, spawnFn }) {
  return new Promise((resolve, reject) => {
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
    const stdoutChunks = [];
    const stderrChunks = [];

    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* already gone */
      }
    };
    // Same SIGKILL-once guard as spawnEngine: the timeout, the stdout-error
    // path, and host-signal forwarding can all send SIGTERM, but a second
    // graceTimer would fire a stray SIGKILL at an already-reaped group.
    const scheduleSigkill = () => {
      if (settled || graceTimer) return;
      graceTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      scheduleSigkill();
    }, timeoutSec * 1000);

    // Forward host SIGINT/SIGTERM to the child's process group ONLY — never
    // touch the host (same rationale as spawnEngine; this also runs inside the
    // long-lived MCP server). Removed on settle so a host handling many crush
    // runs doesn't accumulate one listener pair per call.
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

    child.on('error', (err) => settle(() => reject(new Error(`Failed to spawn crush: ${err.message}`))));

    // crush emits the whole envelope at end-of-run, so buffer stdout fully
    // (parseEnvelope takes the last non-empty line on close).
    if (child.stdout) child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    // stderr is captured for the error-tail on the throw path; NOT forwarded
    // live — crush's WARN noise + `▶ <tool>` heartbeats would interleave with
    // this module's own dim stderr logs (a later step can forward it dimmed).
    if (child.stderr) child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    child.on('close', (code, signal) => {
      settle(() =>
        resolve({
          code,
          signal,
          timedOut,
          stdout: stdoutChunks.join(''),
          stderrTail: stderrChunks.join(''),
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
async function runCrushFlow({ opts, deps, sh, spawnFn, prompt, isolate: _isolate, isolation, slug, timeoutSec }) {
  const modelOverride = opts.model || null;
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
    restrict,
  });
  const env = crushEngine.buildSpawnEnv();

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
    result = await spawnCrush({ argv, env, timeoutSec: outerTimeoutSec, spawnFn });
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
  if (parsed.error) warnings.push(`crush error: ${parsed.error}`);

  // crush reports a COMBINED delta_tokens, never split prompt/completion (unlike
  // opencode's per-step input/output). Stuff it into completion_tokens so the
  // run is still accounted (prompt_tokens:0 is fine — logUsage only
  // short-circuits on null), and flag the split as unavailable.
  const deltaTokens = parsed.usage?.delta_tokens ?? 0;
  const deltaCostUsd = parsed.usage?.delta_cost_usd;
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
  let filesChanged = [];
  let diffStat = null;
  let worktreeOut = null;
  if (isolation) {
    const changes = computeWorktreeChanges(sh, isolation.repoRoot, isolation.wtPath);
    if (changes.warnings.length) warnings.push(...changes.warnings);
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
      filesChanged = changes.filesChanged;
      diffStat = changes.diffStat;
      worktreeOut = isolation.wtPath;
    }
  }

  // Usage accounting. prompt_tokens:0 (crush has no split) + the real combined
  // count as completion_tokens, so runs never vanish from the usage log.
  const ctx = currentCall();
  logUsage({
    model: modelOverride || 'crush',
    prompt_tokens: 0,
    completion_tokens: deltaTokens,
    label: 'coder',
    call_id: ctx?.callId,
    parent_call_id: ctx?.parentCallId,
  });

  const envelope = {
    engine: 'crush',
    engine_version: engineVersion,
    session_id: parsed.session_id || null,
    exit_reason,
    final_text: parsed.final_text ?? null,
    files_changed: filesChanged,
    diff_stat: diffStat,
    worktree: worktreeOut,
    usage: {
      prompt_tokens: 0,
      completion_tokens: deltaTokens,
      // crush reports REAL per-call cost (unlike opencode's coding-plan
      // cost:0). Preserved verbatim as an extra usage field.
      cost_usd: deltaCostUsd ?? null,
    },
    warnings,
  };

  // Injectable so tests don't have to monkey-patch process.stdout.write
  // (same reason as the opencode path — see comment there).
  const writeStdout = deps.stdoutWrite || ((s) => process.stdout.write(s));
  writeStdout(JSON.stringify(envelope) + '\n');
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

export async function runCoderRun(promptArg, opts = {}, deps = {}) {
  // The engine env allowlist (buildEngineEnv) and the timeout kill
  // (negative-PID process-group SIGTERM/SIGKILL in spawnEngine) are both
  // POSIX-only. Rather than ship a silently half-working Windows path
  // (no group kill => a hung/retrying engine can never be terminated by
  // --timeout), refuse explicitly.
  if (process.platform === 'win32') {
    throw new Error('triss coder run is POSIX-only for now (Windows is not supported).');
  }

  const engine = resolveCoderEngine(opts);
  loadEnvFiles();
  const sh = deps.spawnSync || nodeSpawnSync;
  const spawnFn = deps.spawn || nodeSpawn;

  const prompt = await resolveCoderPrompt(promptArg, opts);

  // Effective --isolate. The two engines DEFAULT differently:
  //   - opencode: isolate-OFF (its deny-first opencode.json bash policy is the
  //     reliable safety layer — it actually enforces).
  //   - crush: isolate-ON. crush 0.1.3's `permissions.run` config block is
  //     INERT (live-verified, docs/crush-restrict-issues.md) and a denied bash
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
  const isolate = opts.isolate === undefined ? engine === 'crush' : !!opts.isolate;

  // Pure usage-error checks first, independent of environment/credentials
  // — a caller should get "you combined two contradictory flags" rather
  // than "no API key" when both are true.
  //
  // --continue resumes whatever opencode session was last active; --isolate
  // (without --session) creates a brand-new worktree/branch on a random
  // slug. Combined with no --session, those two are self-contradictory —
  // there is no session tied to the fresh worktree to continue.
  if (opts.continue && isolate && !opts.session) {
    throw new Error(
      '--continue with --isolate requires --session <id> — without it, --isolate creates a new ' +
        'worktree/branch while --continue tries to resume an unrelated previous session. Pass the ' +
        'same --session slug you used to start that session.',
    );
  }

  const agent = opts.agent || 'coder';
  const modelOverride = opts.model || null;
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
  if (engine === 'crush' && modelOverride && coderModelCredential(modelOverride).env !== 'ZHIPU_API_KEY') {
    throw new Error(
      `The crush engine speaks Z.AI GLM only — it cannot run the non-GLM model "${modelOverride}". ` +
        'Use the opencode engine (drop --engine crush) for opencode/*, opencode-go/*, moonshotai/*, or ' +
        'kimi-for-coding/* models, or choose a GLM model.',
    );
  }

  const cred = engine === 'crush' ? { env: 'ZHIPU_API_KEY' } : coderModelCredential(modelUsed);
  if (!process.env[cred.env]) {
    const suffix =
      cred.provider === 'opencode-go'
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

  const timeoutSec = opts.timeout == null ? 900 : Number(opts.timeout);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    throw new Error(`Invalid --timeout "${opts.timeout}" — must be a positive number of seconds`);
  }

  const slug = resolveSlug(opts, isolate);

  let isolation = null;
  if (isolate) {
    isolation = setupIsolation(sh, slug);
  }

  // crush diverges here — its own (simpler) spawn + single-envelope parse flow.
  // Isolation is set up above (engine-agnostic git worktrees), so runCrushFlow
  // reuses the same teardown helpers as the opencode path below.
  if (engine === 'crush') {
    return runCrushFlow({ opts, deps, sh, spawnFn, prompt, isolate, isolation, slug, timeoutSec });
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
  const env = buildEngineEnv(cred.env);
  const engineVersion = detectOpencodeVersion(sh) || opencodeVersionPin();

  process.stderr.write(
    pc.dim(
      `[coder run] agent=${agent} model=${modelUsed}` +
        (isolation ? ` isolate=${isolation.wtPath}` : '') +
        '\n',
    ),
  );

  const spawnStartMs = Date.now();
  let result;
  let rateLimit;
  try {
    result = await spawnEngine({
      argv,
      env,
      timeoutSec,
      spawnFn,
      sinceMs: spawnStartMs,
      scanRateLimit: deps.scanRateLimit,
      logPath: deps.logPath,
      pollMs: deps.pollMs,
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
    // setupIsolation ran BEFORE spawnEngine — a throw here would otherwise
    // leak a freshly-created worktree/branch (see cleanupAbandonedIsolation).
    if (isolation && isolation.freshlyCreated) {
      cleanupAbandonedIsolation(sh, isolation);
    }
    throw err;
  }

  // Rate limit that only hit AFTER the engine produced some text: keep the
  // partial envelope but flag it so the caller knows the run was cut short.
  if (rateLimit) result.warnings.push(rateLimitMessage(rateLimit));

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

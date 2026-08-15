/**
 * opencode2-preflight.js — fail-closed effective-configuration preflight for
 * the OpenCode 2 coder engine (PR review blockers P0-1, P0-2, P1-6).
 *
 * staticOpenCode2Preflight() only hunted plugin/agent files. This module
 * computes the FULL effective projection OpenCode 2 would run with — every
 * config layer, translated provider blocks, the final ordered permission
 * policy, and the selected model — and gates the run on all of it BEFORE any
 * credential is forwarded:
 *
 *   1. ROUTE GATE: the modelUsed provider prefix must be one of the six
 *      advertised routes AND have a deterministic current-pin translation
 *      fixture; an unproven route fails closed (P1-6 — previously only the
 *      one-shot --provider flag was gated).
 *   2. PROVIDER GATE: the effective provider projection for the selected
 *      model must match the fixture exactly — provider id, endpoint/package/
 *      settings, the credential placeholder — and contain no unrelated
 *      providers a project layer smuggled in (P0-1 — a project repo could
 *      previously redirect the forwarded API key to an arbitrary endpoint).
 *   3. PERMISSION GATE: the final ordered permission policy for the primary
 *      agent and every reachable subagent must be deny-first for shell: any
 *      last-matching shell allow/ask rule fails closed (P0-2 — a project
 *      `permissions: [{action:"shell",resource:"*",effect:"allow"}]`
 *      previously passed while runs execute with --auto).
 *
 * Translation semantics verified live against the pinned build
 * v0.0.0-next-17430 (2026-08-15, `opencode2 debug config`):
 *   V1 `permission.bash` entries  -> V2 `permissions` ordered rules
 *                                    {action:"shell", resource, effect}
 *   V1 `provider.<id>.npm`        -> V2 `providers.<id>.package`
 *                                    ("@scope/pkg" => "aisdk:@scope/pkg")
 *   V1 `provider.<id>.options`    -> V2 `providers.<id>.settings`
 *   `apiKey: "{env:VAR}"` stays a placeholder in `settings`.
 *
 * Pure module: no process spawning, no filesystem writes, no env reads.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { enumerateOpenCodeSources } from './opencode-config.js';

// ─── route fixtures ─────────────────────────────────────────────────────────
//
// A route is supported only when its exact V1->V2 translation is pinned here.
// Fields: the credential env Triss forwards for the prefix, the provider ids
// the route may define, and whether the provider definition is TRISS-MANAGED
// (written by `triss coder init` — endpoint/settings must match the managed
// shape) or BUILT-IN to the engine (no local definition is required at all).
// `expectedProviders: null` means the route's providers are engine built-ins:
// a config layer DEFINING that provider id is an override and fails closed.

export const OPENCODE2_ROUTE_FIXTURES = Object.freeze({
  'triss-worker': {
    credentialEnv: 'TRISS_WORKER_API_KEY',
    managedProvider: true,
    fixtureComment: 'Managed V1 shape: npm @ai-sdk/openai-compatible + options.{baseURL,apiKey:{env:TRISS_WORKER_API_KEY}}',
  },
  'zai-coding-plan': {
    credentialEnv: 'ZHIPU_API_KEY',
    managedProvider: false,
    expectedProviders: null,
    fixtureComment: 'Engine built-in zai-coding-plan route; a defining layer is an override',
  },
  zai: {
    credentialEnv: 'ZHIPU_API_KEY',
    managedProvider: false,
    expectedProviders: null,
    fixtureComment: 'Engine built-in zai route; a defining layer is an override',
  },
  opencode: {
    credentialEnv: 'OPENCODE_API_KEY',
    managedProvider: false,
    expectedProviders: null,
    fixtureComment: 'Engine built-in opencode zen route; a defining layer is an override',
  },
  'opencode-go': {
    credentialEnv: 'OPENCODE_API_KEY',
    managedProvider: false,
    expectedProviders: null,
    fixtureComment: 'Engine built-in opencode-go route; a defining layer is an override',
  },
  moonshotai: {
    credentialEnv: 'MOONSHOT_API_KEY',
    managedProvider: false,
    expectedProviders: null,
    fixtureComment: 'Engine built-in moonshotai route; a defining layer is an override',
  },
  'moonshotai-cn': {
    credentialEnv: 'MOONSHOT_API_KEY',
    managedProvider: false,
    expectedProviders: null,
    fixtureComment: 'Engine built-in moonshotai-cn route; a defining layer is an override',
  },
  'kimi-for-coding': {
    credentialEnv: 'KIMI_API_KEY',
    managedProvider: false,
    expectedProviders: null,
    fixtureComment: 'Engine built-in kimi-for-coding route; a defining layer is an override',
  },
});

export function opencode2RouteFixture(modelUsed) {
  const prefix = String(modelUsed || '').split('/')[0];
  return { prefix, fixture: OPENCODE2_ROUTE_FIXTURES[prefix] || null };
}

// ─── V1 -> V2 permission translation (verified against the pin) ─────────────

/**
 * Translate one V1 `permission.bash` map into the ordered V2 rule list the
 * pinned build produces. Object key order = rule order (last match wins).
 */
export function translateV1BashPermissions(bashMap) {
  if (!bashMap || typeof bashMap !== 'object' || Array.isArray(bashMap)) return [];
  const rules = [];
  for (const [resource, effect] of Object.entries(bashMap)) {
    if (typeof effect !== 'string') continue;
    rules.push({ action: 'shell', resource, effect });
  }
  return rules;
}

// V2 native permission rule shape guard.
function isV2PermissionRule(rule) {
  return !!rule
    && typeof rule === 'object'
    && !Array.isArray(rule)
    && typeof rule.action === 'string'
    && typeof rule.resource === 'string'
    && (rule.effect === 'allow' || rule.effect === 'deny' || rule.effect === 'ask');
}

/**
 * Compute the final effective permission policy: ordered defaults + config
 * rules (V1 bash translation and/or native V2 permissions, in layer
 * precedence order) + the selected agent's own rules, evaluated with
 * last-match-wins semantics exactly as the pinned build merges them.
 * Returns { rules, unsafe } — unsafe is true when ANY shell command could be
 * allowed/asked under --auto.
 */
export function computeEffectivePermissionPolicy({ layerDocs, agentDoc } = {}) {
  const orderedRules = [];
  for (const doc of layerDocs) {
    if (!doc) continue;
    const v1 = translateV1BashPermissions(doc?.permission?.bash);
    orderedRules.push(...v1);
    if (Array.isArray(doc.permissions)) {
      orderedRules.push(...doc.permissions.filter(isV2PermissionRule));
    }
  }
  if (agentDoc) {
    if (Array.isArray(agentDoc.permissions)) {
      orderedRules.push(...agentDoc.permissions.filter(isV2PermissionRule));
    }
    if (agentDoc?.permission?.bash) {
      orderedRules.push(...translateV1BashPermissions(agentDoc.permission.bash));
    }
  }
  const shellRules = orderedRules.filter((r) => r.action === 'shell');
  const unsafe = shellRules.length === 0
    || shellRules.some((r) => r.effect === 'allow' || r.effect === 'ask');
  return { rules: orderedRules, unsafe, shellRuleCount: shellRules.length };
}

// ─── provider projection ────────────────────────────────────────────────────

/**
 * Merge `provider`/`providers` blocks from every layer (later layers win
 * per-key, OpenCode deep-merges provider blocks) and translate each to the
 * V2 shape the pin produces: npm -> package (`aisdk:` prefixed when scoped),
 * options -> settings. Returns { providers, sourceLayers }.
 */
export function projectEffectiveProviders({ layerDocs } = {}) {
  const providers = {};
  const sourceLayers = {};
  for (const doc of layerDocs) {
    if (!doc) continue;
    const raw = doc.provider ?? doc.providers;
    if (raw == null) continue;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('OpenCode 2 preflight: a config layer has a non-object provider/providers block');
    }
    for (const [id, def] of Object.entries(raw)) {
      if (def == null) continue;
      if (typeof def !== 'object' || Array.isArray(def)) {
        throw new Error(`OpenCode 2 preflight: provider "${id}" definition is not an object`);
      }
      const translated = {};
      if (typeof def.npm === 'string') {
        translated.package = def.npm.startsWith('@') || def.npm.includes('/')
          ? `aisdk:${def.npm}`
          : def.npm;
      }
      if (typeof def.package === 'string') translated.package = def.package;
      if (def.options != null) translated.settings = def.options;
      if (def.settings != null) translated.settings = def.settings;
      if (def.models != null) translated.models = def.models;
      providers[id] = translated;
      sourceLayers[id] = doc.__layerPath || 'unknown-layer';
    }
  }
  return { providers, sourceLayers };
}

// The managed triss-worker provider shape written by `triss coder init`
// (workerProviderDefinition): scoped npm package + options.{baseURL, apiKey
// placeholder}. The endpoint (baseURL) is profile-specific and NOT pinned
// here — what IS pinned: package id, the credential placeholder field, and
// that settings carries no extra keys (an injected headers/other-endpoint
// key fails).
export function isManagedTrissWorkerTranslation(translated) {
  if (!translated || typeof translated !== 'object') return false;
  if (translated.package !== 'aisdk:@ai-sdk/openai-compatible') return false;
  const settings = translated.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
  const keys = Object.keys(settings).sort();
  if (keys.length !== 2 || keys[0] !== 'apiKey' || keys[1] !== 'baseURL') return false;
  return settings.apiKey === '{env:TRISS_WORKER_API_KEY}' && typeof settings.baseURL === 'string';
}

// ─── full preflight ─────────────────────────────────────────────────────────

/**
 * The complete fail-closed preflight for one opencode2 run.
 *
 * @param {object} input
 * @param {string} input.cwd — the EXACT child runtime directory (isolation
 *   worktree or resolved --cwd), never a test seam (P1-5).
 * @param {string} input.modelUsed — the finally selected model (--model,
 *   TRISS_CODER_MODEL, or the configured default; the gate applies to the
 *   final value regardless of how it was chosen — P1-6).
 * @param {object} [input.deps] — { enumerate } seams for tests.
 * @returns {{ sources, projection, policy }} for envelope/logging use.
 * @throws on ANY gate failure, before a credential is forwarded.
 */
export function auditOpenCode2Run({ cwd, modelUsed, agentName }, deps = {}) {
  if (!cwd) throw new Error('auditOpenCode2Run: cwd is required');
  if (!modelUsed) throw new Error('auditOpenCode2Run: modelUsed is required');

  const sources = (deps.enumerate || enumerateOpenCodeSources)({ cwd });

  // 1. ROUTE GATE — final modelUsed prefix, however it was selected.
  const { prefix, fixture } = opencode2RouteFixture(modelUsed);
  if (!fixture) {
    throw new Error(
      `OpenCode 2 preflight aborted: model "${modelUsed}" uses provider route "${prefix}", which has no ` +
        'verified current-pin translation fixture. Supported routes: '
        + `${Object.keys(OPENCODE2_ROUTE_FIXTURES).join(', ')}. `,
    );
  }

  // Parse every EXISTING config layer once (the enumerator already parsed
  // them for plugins; re-parse here for projection/policy fields).
  const layerDocs = [];
  for (const c of sources.configs) {
    if (!c.exists) continue;
    let doc;
    try {
      doc = JSON.parse(readFileSync(c.path, 'utf8'));
    } catch {
      // The enumerator's own JSONC parser is the canonical one for jsonc;
      // re-parse failures here mean the file changed under us — fail closed.
      throw new Error(`OpenCode 2 preflight aborted: cannot re-read ${c.path}`);
    }
    doc.__layerPath = c.path;
    layerDocs.push(doc);
  }

  // 2. PROVIDER GATE — effective projection vs the fixture.
  const { providers, sourceLayers } = projectEffectiveProviders({ layerDocs });
  if (fixture.managedProvider) {
    const translated = providers[prefix];
    if (!translated) {
      throw new Error(
        `OpenCode 2 preflight aborted: the managed provider "${prefix}" is not defined in any auditable ` +
          'config layer — run `triss coder init --engine opencode --provider worker` first.',
      );
    }
    if (!isManagedTrissWorkerTranslation(translated)) {
      throw new Error(
        `OpenCode 2 preflight aborted: provider["${prefix}"] in ${sourceLayers[prefix]} does not match the ` +
          'managed translation fixture (package / settings / credential placeholder). Remove the override or ' +
          're-run `triss coder init`.',
      );
    }
  } else {
    // Built-in route: a config layer DEFINING the provider id is an override
    // of the engine's built-in transport — reject before credential forward.
    if (Object.prototype.hasOwnProperty.call(providers, prefix)) {
      throw new Error(
        `OpenCode 2 preflight aborted: config layer ${sourceLayers[prefix]} overrides the built-in provider ` +
          `"${prefix}" (endpoint/package/settings). Triss refuses to forward ${fixture.credentialEnv} to a ` +
          'project-configured endpoint. Remove the provider definition and retry.',
      );
    }
  }

  // 3. PERMISSION GATE — final ordered policy, deny-first proof.
  const agentDoc = agentName
    ? layerDocs.find((doc) => {
      const block = doc?.agent?.[agentName] ?? doc?.agents?.[agentName];
      return block != null ? block : null;
    }) ?? null
    : null;
  const policy = computeEffectivePermissionPolicy({ layerDocs, agentDoc });
  if (policy.unsafe) {
    if (policy.shellRuleCount === 0) {
      throw new Error(
        'OpenCode 2 preflight aborted: no shell permission rules in the effective configuration — runs execute ' +
          'with --auto, so a missing policy is not deny-first. Add permission.bash {"*": "deny"} to the global ' +
          'opencode.json.',
      );
    }
    throw new Error(
      'OpenCode 2 preflight aborted: the effective shell policy is not deny-first — a later rule allows or ' +
        'asks for shell commands, and --auto would approve it. The final ordered policy must end deny for "*" ' +
        'and allow only vetted commands. Remove the allow/ask rule or add a later deny.',
    );
  }

  return {
    sources,
    projection: { providers, sourceLayers },
    policy: { rules: policy.rules, shellRuleCount: policy.shellRuleCount },
    route: { prefix, credentialEnv: fixture.credentialEnv },
  };
}

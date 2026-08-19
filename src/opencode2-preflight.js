/**
 * opencode2-preflight.js — fail-closed effective-configuration preflight for
 * the OpenCode 2 coder engine. It prevents unverified provider routes,
 * credential redirection, and executable shell-policy bypasses.
 *
 * staticOpenCode2Preflight() only hunted plugin/agent files. This module
 * computes the FULL effective projection OpenCode 2 would run with — every
 * config layer, translated provider blocks, the final ordered permission
 * policy, and the selected model — and gates the run on all of it BEFORE any
 * credential is forwarded:
 *
 *   1. ROUTE GATE: the modelUsed provider prefix must be one of the six
 *      advertised routes AND have a deterministic current-pin translation
 *      fixture; an unproven route fails closed even when selected through
 *      persistent configuration rather than a one-shot flag.
 *   2. PROVIDER GATE: the effective provider projection for the selected
 *      model must match the fixture exactly — provider id, endpoint/package/
 *      settings, the credential placeholder — and contain no unrelated
 *      providers a project layer smuggled in. Otherwise untrusted repository
 *      configuration could redirect the forwarded API key to an attacker.
 *      The managed baseURL must equal the Triss worker profile
 *      endpoint EXACTLY (a same-package/same-placeholder override with an
 *      attacker URL failed before), `provider.<id>.api` (higher V1 migration
 *      precedence than options.baseURL) is tracked, and model-level
 *      transport overrides (models.<id>.provider.{api,npm}) are rejected.
 *   3. PERMISSION GATE: the final ordered permission policy for the primary
 *      agent and every reachable subagent must be deny-everything for shell.
 *      This is a real last-match-wins evaluator over the merged
 *      rule list with wildcard action/resource semantics (findLast over
 *      action/resource glob matches) — not a `some(allow)` scan. The former
 *      vetted allowlist is unsafe: while the credential is in the
 *      child env ANY live allow/ask rule can disclose it, so a rule that is
 *      not shadowed by a later wildcard deny fails the gate regardless of
 *      how narrow it is. Only dead (shadowed) allows are tolerated.
 *
 * Translation semantics verified live against the pinned build
 * v0.0.0-next-17430 (2026-08-15, `opencode2 debug config`):
 *   V1 `permission.bash` entries  -> V2 `permissions` ordered rules
 *                                    {action:"shell", resource, effect}
 *   V1 `provider.<id>.npm`        -> V2 `providers.<id>.package`
 *                                    ("@scope/pkg" => "aisdk:@scope/pkg")
 *   V1 `provider.<id>.options`    -> V2 `providers.<id>.settings`
 *   `apiKey: *** stays a placeholder in `settings`.
 *
 * Pure module: no process spawning, no filesystem writes, no env reads.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { enumerateOpenCodeSources, parseOpenCodeDocument } from './opencode-config.js';

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
    fixtureComment: 'Managed V1 shape: npm @ai-sdk/openai-compatible + options.{baseURL,apiKey:{env:T...}}; baseURL pinned to the Triss worker profile endpoint',
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
 * Translate one V1 `permission.bash` value into ordered V2 shell rules.
 * Accepts both shapes allowed by the official schema. Treating only the
 * object-map form as valid would reject legitimate wildcard policies:
 *   - a plain string ("allow" | "deny" | "ask") => one wildcard rule
 *     resource "*" (applies to EVERY command);
 *   - an object map { pattern: effect }        => one rule per key, key
 *     order = rule order (last match wins).
 * Non-string effects / non-object non-string inputs yield [] (the caller's
 * empty-policy fail-closed path catches them).
 */
export function translateV1BashPermissions(bashValue) {
  if (typeof bashValue === 'string') {
    return ['allow', 'deny', 'ask'].includes(bashValue) ? [{ action: 'shell', resource: '*', effect: bashValue }] : [];
  }
  if (!bashValue || typeof bashValue !== 'object' || Array.isArray(bashValue)) return [];
  const rules = [];
  for (const [resource, effect] of Object.entries(bashValue)) {
    if (typeof effect !== 'string') continue;
    if (!['allow', 'deny', 'ask'].includes(effect)) continue;
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

// The built-in agents ship a default policy where the primary agent allows
// most tools (the pinned build's build agent defaults "*" -> allow for bash).
// The audit must evaluate THAT baseline too, or a config with a single narrow
// deny ("git status": "deny") passes while every other command stays allowed.
const BUILTIN_AGENT_BASELINE_RULES = Object.freeze([
  { action: 'shell', resource: '*', effect: 'allow' },
]);

/**
 * Wildcard matcher mirroring the pinned build's evaluator: "*" matches
 * anything; otherwise a case-sensitive glob where "*" is a any-run wildcard
 * (e.g. "git diff*" matches "git diff HEAD"). Escaped/regex metacharacters
 * are treated literally.
 */
export function wildcardMatches(pattern, value) {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === value;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function ruleMatchesCommand(rule, command) {
  const actionOk = rule.action === '*' || rule.action === 'shell';
  if (!actionOk) return false;
  return wildcardMatches(rule.resource, command);
}

/**
 * Evaluate the ordered rule list for ONE concrete command with the engine's
 * real semantics: the LAST matching rule wins (findLast); NO matching rule
 * means "ask" — and under `run --auto`, ask is auto-approved.
 */
function evaluateCommand(orderedRules, command) {
  let matched = null;
  for (const rule of orderedRules) {
    if (ruleMatchesCommand(rule, command)) matched = rule;
  }
  return matched ? matched.effect : 'ask';
}

// A battery of probe commands covering the vetted allowlist surface plus
// arbitrary dangerous commands. The effective policy must deny (or at least
// not allow) every unvetted probe.
const PROBE_COMMANDS = [
  'curl http://attacker.example',
  'rm -rf /',
  'echo pwned > /etc/hosts',
  'sh -c anything',
  'git push --force origin main',
  'find / -name secrets',
  'cat ~/.ssh/id_rsa',
  'npm publish',
  'node -e "process.exit(1)"',
  'bash',
];

// The vetted allowlist concept is retired: while the
// provider credential sits in the child env, ANY allowed shell command can
// disclose it — `ls -- "/x-$OPENCODE_API_KEY"` echoes the expanded secret in
// an error, and `npm test` / `node --test` execute untrusted repo JavaScript
// with the key in `process.env`. Until real credential isolation exists for
// OpenCode 2, the beta contract is deny-everything: a live allow/ask rule of
// ANY resource fails the gate. (A rule shadowed by a later wildcard deny is
// dead and harmless.)
export const VETTED_BASH_ALLOWLIST = Object.freeze([]);

/**
 * Compute the effective permission policy and the deny-first proof.
 *
 * Algorithm (replacing the unsafe `some(allow)` scan):
 *   1. Merge ordered rules: built-in agent baseline FIRST, then every config
 *      layer in precedence order (V1 bash translation + native V2
 *      permissions), then the selected agent's own rules LAST (agents
 *      override config).
 *   2. Require an explicit wildcard-deny rule for shell ("*" -> deny) —
 *      without it the final word on arbitrary commands is the baseline allow
 *      or "ask" (auto-approved under --auto).
 *   3. Every non-wildcard ALLOW rule must be a vetted allowlist pattern and
 *      must actually be narrowed by the wildcard deny in LAST-match-wins
 *      order: an allow rule that is a LATER match for a command it covers
 *      than every deny rule would let that command through.
 *   4. Prove by evaluation: every PROBE_COMMAND must resolve to deny under
 *      the real evaluator, and every vetted command must resolve to allow
 *      ONLY if it is actually allowlisted in the policy (a policy that
 *      denies everything is safe, just unusable — not a preflight failure).
 *
 * @returns {{ rules, unsafe, reason, shellRuleCount }}
 */
export function computeEffectivePermissionPolicy({ layerDocs, agentDoc } = {}) {
  const orderedRules = [...BUILTIN_AGENT_BASELINE_RULES];
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
    const agentBash = agentDoc?.permission?.bash;
    if (agentBash) {
      orderedRules.push(...translateV1BashPermissions(agentBash));
    }
  }

  // 2. A wildcard shell deny must exist somewhere in the policy. Without it
  //    the final word on arbitrary commands is the built-in baseline allow
  //    (or "ask", which --auto approves) — bypass C shape.
  const wildcardDenyIdx = orderedRules.findIndex(
    (r) => (r.action === 'shell' || r.action === '*') && r.resource === '*' && r.effect === 'deny',
  );
  if (wildcardDenyIdx < 0) {
    return {
      rules: orderedRules,
      unsafe: true,
      reason: 'no-wildcard-deny',
      shellRuleCount: orderedRules.filter((r) => r.action === 'shell' || r.action === '*').length,
    };
  }

  // 3. Live permissive rules. Last-match-wins semantics: a rule GRANTS
  //    something only for commands it matches that NO LATER rule matches.
  //    So an allow/ask is harmless when a LATER wildcard deny fully shadows
  //    it ({"rm -rf":"allow","*":"deny"} denies rm -rf — dead rule, safe);
  //    and the Triss template's vetted allows AFTER the wildcard deny are
  //    the intended shape (last-match winners for vetted commands only).
  //    A rule is LIVE (dangerous) when no later wildcard deny shadows it;
  //    a live wildcard allow/ask grants/approves everything (bypasses A/B),
  //    a live narrow allow/ask must be a vetted allowlist pattern.
  //    `ask` counts as permissive because `run --auto` approves it.
  for (let k = 0; k < orderedRules.length; k += 1) {
    const rule = orderedRules[k];
    const isShellish = rule.action === 'shell' || rule.action === '*';
    if (!isShellish) continue;
    if (rule.effect !== 'allow' && rule.effect !== 'ask') continue;
    const shadowedByLaterDeny = orderedRules
      .slice(k + 1)
      .some((r) => (r.action === 'shell' || r.action === '*') && r.resource === '*' && r.effect === 'deny');
    if (shadowedByLaterDeny) continue; // dead rule — grants nothing
    // No shell allow is safe while the provider credential is in the child
    // env — ANY live allow/ask rule (wildcard or narrow) fails the gate.
    return {
      rules: orderedRules,
      unsafe: true,
      reason: `live-${rule.resource === '*' ? 'wildcard-' : ''}${rule.effect}${rule.resource === '*' ? '' : `-rule`}`,
      detail: rule.resource === '*' ? undefined : rule.resource,
      shellRuleCount: orderedRules.filter((r) => r.action === 'shell' || r.action === '*').length,
    };
  }

  // 4. Full-evaluation proof over probe commands: with a wildcard deny
  //    present every probe matches it, so the LAST match must resolve to
  //    deny — anything else (allow, ask) means a live permissive rule
  //    slipped past step 3.
  for (const probe of PROBE_COMMANDS) {
    const effect = evaluateCommand(orderedRules, probe);
    if (effect !== 'deny') {
      return {
        rules: orderedRules,
        unsafe: true,
        reason: 'probe-not-denied',
        detail: `${probe} -> ${effect}`,
        shellRuleCount: orderedRules.filter((r) => r.action === 'shell' || r.action === '*').length,
      };
    }
  }

  return {
    rules: orderedRules,
    unsafe: false,
    reason: 'deny-first',
    shellRuleCount: orderedRules.filter((r) => r.action === 'shell' || r.action === '*').length,
  };
}

// ─── provider projection ────────────────────────────────────────────────────

/**
 * Merge `provider`/`providers` blocks from every layer (later layers win
 * per-key, OpenCode deep-merges provider blocks) and translate each to the
 * V2 shape the pin produces: npm -> package (`aisdk:` prefixed when scoped),
 * options -> settings. Returns { providers, sourceLayers }.
 *
 * `provider.<id>.api` is captured because the official migrator maps
 * `url = provider.api ?? lowered options.url` — api has HIGHER precedence
 * than options.baseURL, so an attacker URL there redirects the key without
 * touching options), and model-level transport overrides
 * (models.<id>.provider.{api,npm}) are surfaced for the gate to reject.
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
      const translated = { ...(providers[id] || {}) };
      if (typeof def.npm === 'string') {
        translated.package = def.npm.startsWith('@') || def.npm.includes('/')
          ? `aisdk:${def.npm}`
          : def.npm;
      }
      if (typeof def.package === 'string') translated.package = def.package;
      if (def.api != null) translated.api = def.api;
      if (def.options != null) translated.settings = def.options;
      if (def.settings != null) translated.settings = def.settings;
      if (def.models != null) translated.models = def.models;
      providers[id] = translated;
      sourceLayers[id] = doc.__layerPath || 'unknown-layer';
    }
  }
  return { providers, sourceLayers };
}

/**
 * The managed triss-worker provider shape written by `triss coder init`
 * (workerProviderDefinition). The audit passes in the expected
 * worker profile (exact baseURL from the live Triss worker config) and the
 * definition must match it exactly — package id, settings keys, the
 * credential placeholder, the baseURL value, AND no provider.api /
 * model-level transport override that could redirect the key.
 */
export function isManagedTrissWorkerTranslation(translated, expectedBaseURL) {
  if (!translated || typeof translated !== 'object') return { ok: false, reason: 'not-an-object' };
  if (translated.api != null) return { ok: false, reason: 'provider-api-override' };
  if (translated.package !== 'aisdk:@ai-sdk/openai-compatible') return { ok: false, reason: 'package' };
  const settings = translated.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { ok: false, reason: 'settings-shape' };
  const keys = Object.keys(settings).sort();
  if (keys.length !== 2 || keys[0] !== 'apiKey' || keys[1] !== 'baseURL') return { ok: false, reason: 'settings-keys' };
  if (settings.apiKey !== '{env:TRISS_WORKER_API_KEY}') return { ok: false, reason: 'credential-placeholder' };
  if (typeof settings.baseURL !== 'string') return { ok: false, reason: 'baseurl-type' };
  if (expectedBaseURL != null && settings.baseURL !== expectedBaseURL) {
    return { ok: false, reason: 'baseurl-value', actual: settings.baseURL, expected: expectedBaseURL };
  }
  // Model-level transport overrides require the same scrutiny as provider-
  // level overrides. In native V2, `models.<id>.api` redirects traffic
  // exactly like
  // provider.<id>.api (a late layer can leave the top-level provider intact
  // and reroute ONE model). The managed definition writes plain { name }
  // entries — ANY other key in ANY model entry is an override and rejects.
  if (translated.models != null) {
    if (typeof translated.models !== 'object' || Array.isArray(translated.models)) {
      return { ok: false, reason: 'models-shape' };
    }
    for (const [id, model] of Object.entries(translated.models)) {
      if (!model || typeof model !== 'object' || Array.isArray(model)) return { ok: false, reason: 'models-entry' };
      const keys = Object.keys(model);
      if (keys.length !== 1 || keys[0] !== 'name' || typeof model.name !== 'string') {
        return { ok: false, reason: 'model-level-transport', detail: id };
      }
    }
  }
  return { ok: true };
}

// ─── document shape validation ──────────────────────────────────────────────

// Top-level keys with their allowed value types, captured from the official
// published schema (https://opencode.ai/config.json, fetched 2026-08-15; the
// root sets additionalProperties:false — unknown keys are schema-invalid,
// which is exactly why they fail closed here). An earlier hand-picked subset
// false-rejected legitimate configs carrying keys such as
// autoupdate/instructions/share; this table instead mirrors the published
// schema while preserving fail-closed handling for genuinely unknown keys.
// Pin-verification caveat: the published schema may drift from the exact
// pinned beta build — re-capture against the pin when a working
// `debug config` oracle is available (sandboxed XDG currently cannot start
// the background service). Anything outside this table still rejects.
const V2_TOP_LEVEL_TYPES = Object.freeze({
  $schema: ['string'],
  shell: ['string'],
  logLevel: ['string'],
  server: ['object'],
  skills: ['object'],
  references: ['object'],
  reference: ['object'],
  watcher: ['object'],
  snapshot: ['boolean'],
  plugin: ['string', 'array'],
  plugins: ['string', 'array'],
  share: ['string'],
  autoshare: ['boolean'],
  autoupdate: ['boolean', 'string'],
  disabled_providers: ['array'],
  enabled_providers: ['array'],
  model: ['string'],
  small_model: ['string'],
  default_agent: ['string'],
  subagent_depth: ['number'],
  username: ['string'],
  mode: ['object'],
  modes: ['object'],
  agent: ['object'],
  agents: ['object'],
  provider: ['object'],
  providers: ['object'],
  // lsp/formatter: the schema allows objects too, but an OBJECT form names a
  // local process to run (language server / formatter binary) — an executable
  // surface. The beta accepts only the boolean toggles.
  lsp: ['boolean'],
  formatter: ['boolean'],
  instructions: ['array'],
  layout: ['string'],
  permission: ['object'],
  permissions: ['array'],
  attachment: ['object'],
  enterprise: ['object'],
  tool_output: ['object'],
  compaction: ['object'],
});

// Command-bearing surfaces a config layer can smuggle in. Distinct errors so
// the operator knows which gate fired (the static plugin/agent gates cover
// the file-based forms of the same surfaces).
const V2_EXECUTABLE_KEYS = Object.freeze({
  mcp: 'local MCP servers are launched with the inherited process env (including the provider credential) and remote MCP headers can exfiltrate it',
  tool: 'custom tool definitions execute inside the OpenCode process',
  tools: 'custom tool definitions execute inside the OpenCode process',
  command: 'command definitions execute arbitrary shell inside the OpenCode process',
  commands: 'command definitions execute arbitrary shell inside the OpenCode process',
  experimental: 'the "experimental" block can alter engine behavior in ways Triss has no fixture for',
});

// Legacy/native dual forms (invariant): when a document carries BOTH the
// V1 and the V2 name of a security-critical field, the pinned build prefers
// the NATIVE value — while Triss's projection reads `provider ?? providers`
// (legacy first) and concatenates permission rules from both. Until there is
// an exact canonical merger, any dual form fails closed: three independent
// bypasses hide behind it (empty legacy `provider` masking a native endpoint
// override, empty legacy `plugin` masking executable native `plugins`, a
// legacy shell deny masking a permissive native `permissions` policy).
const V2_DUAL_FORM_PAIRS = Object.freeze([
  ['provider', 'providers'],
  ['plugin', 'plugins'],
  ['permission', 'permissions'],
]);

export function assertV2DocumentShape(doc, layerPath) {
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) return;
  for (const [legacy, native] of V2_DUAL_FORM_PAIRS) {
    if (legacy in doc && native in doc) {
      throw new Error(
        `OpenCode 2 preflight aborted: ${layerPath} defines BOTH "${legacy}" (V1) and "${native}" (V2). ` +
          `The pinned build prefers the native "${native}" value while Triss's audit models the legacy ` +
          'one — the audited baseline would not be the running one. Keep exactly one form per document.',
      );
    }
  }
  for (const key of Object.keys(doc)) {
    const executable = V2_EXECUTABLE_KEYS[key];
    if (executable) {
      throw new Error(
        `OpenCode 2 preflight aborted: ${layerPath} defines "${key}" — ${executable}. ` +
          'No local MCP/tool/command surface is verified for the beta; remove the block and re-run.',
      );
    }
    const allowed = V2_TOP_LEVEL_TYPES[key];
    if (!allowed) {
      throw new Error(
        `OpenCode 2 preflight aborted: ${layerPath} has an unknown top-level key "${key}". The official config ` +
          'schema sets additionalProperties:false, so the engine drops the whole document — the audited ' +
          'baseline would not be the running one. Remove the key or verify it against the pin first.',
      );
    }
    const value = doc[key];
    const valueType = Array.isArray(value) ? 'array' : typeof value;
    if (!allowed.includes(valueType)) {
      throw new Error(
        `OpenCode 2 preflight aborted: ${layerPath} key "${key}" must be ${allowed.join(' or ')} ` +
          `(got ${valueType}). A schema-invalid document is dropped whole by the engine — the audited ` +
          'baseline would not be the running one.',
      );
    }
  }
}

// ─── full preflight ─────────────────────────────────────────────────────────

/**
 * The complete fail-closed preflight for one opencode2 run.
 *
 * @param {object} input
 * @param {string} input.cwd — the EXACT child runtime directory (isolation
 *   worktree or resolved --cwd), never a test seam.
 * @param {string} input.modelUsed — the finally selected model (--model,
 *   TRISS_CODER_MODEL, or the configured default; the gate applies to the
 *   final value regardless of how it was chosen).
 * @param {string} [input.expectedWorkerBaseURL] — the Triss worker profile
 *   endpoint for this run; managed-provider baseURL must equal it exactly
 *   endpoint for this run. A same-shape override with an attacker URL must
 *   fail before credential forwarding.
 * @param {object} [input.deps] — { enumerate } seams for tests.
 * @returns {{ sources, projection, policy }} for envelope/logging use.
 * @throws on ANY gate failure, before a credential is forwarded.
 */
/**
 * Document-level audit shared by the run path and the V2 init head (cross-
 * review fix 6): enumerate sources, parse every EXISTING config layer through
 * the canonical JSONC parser, and run the shape gates (mcp / command-bearing
 * and unknown top-level keys / dual legacy-native forms) — BEFORE any
 * credential write or spawn. Also returns a SHA-256 per audited file so the
 * caller can re-verify the tree right before the credential-bearing spawn
 * and close the audit→spawn TOCTOU window (invariant).
 *
 * @returns {{ sources, layerDocs, contentHashes: Array<{path, sha256}> }}
 */
export function auditOpenCode2Documents({ cwd }, deps = {}) {
  if (!cwd) throw new Error('auditOpenCode2Documents: cwd is required');
  const sources = (deps.enumerate || enumerateOpenCodeSources)({ cwd });
  const layerDocs = [];
  const contentHashes = [];
  for (const c of sources.configs) {
    if (!c.exists) continue;
    let text;
    let doc;
    try {
      text = readFileSync(c.path, 'utf8');
      doc = parseOpenCodeDocument(text, { path: c.path });
    } catch (err) {
      throw new Error(`OpenCode 2 preflight aborted: cannot parse ${c.path} — ${err.message}`, { cause: err });
    }
    // Reject malformed or schema-suspicious documents and
    // command-bearing surfaces (mcp, tool, command, unknown keys) BEFORE the
    // provider/permission gates — a document the engine would drop whole
    // invalidates everything computed from it.
    assertV2DocumentShape(doc, c.path);
    doc.__layerPath = c.path;
    layerDocs.push(doc);
    contentHashes.push({ path: c.path, sha256: createHash('sha256').update(text).digest('hex') });
  }
  return { sources, layerDocs, contentHashes };
}

/**
 * Re-verify the audited config files still hash to the audit-time values.
 * Called immediately before the credential-bearing spawn (invariant)
 * — between the audit and the spawn sit directory setup and binary probes
 * (several subprocesses), a window in which the audited tree can change.
 */
export function verifyOpenCode2ContentHashes(contentHashes) {
  for (const { path, sha256 } of contentHashes || []) {
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      throw new Error(
        `OpenCode 2 preflight aborted: audited config ${path} disappeared before the spawn — aborting ` +
          '(TOCTOU guard). Re-run the command.',
        { cause: err },
      );
    }
    const now = createHash('sha256').update(text).digest('hex');
    if (now !== sha256) {
      throw new Error(
        `OpenCode 2 preflight aborted: audited config ${path} changed between the audit and the spawn — ` +
          'aborting (TOCTOU guard). Re-run the command.',
      );
    }
  }
}

export function auditOpenCode2Run({ cwd, modelUsed, agentName, expectedWorkerBaseURL }, deps = {}) {
  if (!cwd) throw new Error('auditOpenCode2Run: cwd is required');
  if (!modelUsed) throw new Error('auditOpenCode2Run: modelUsed is required');

  const { sources, layerDocs, contentHashes } = auditOpenCode2Documents({ cwd }, deps);

  // 1. ROUTE GATE — final modelUsed prefix, however it was selected.
  const { prefix, fixture } = opencode2RouteFixture(modelUsed);
  if (!fixture) {
    throw new Error(
      `OpenCode 2 preflight aborted: model "${modelUsed}" uses provider route "${prefix}", which has no ` +
        'verified current-pin translation fixture. Supported routes: '
        + `${Object.keys(OPENCODE2_ROUTE_FIXTURES).join(', ')}. `,
    );
  }

  // 2. PROVIDER GATE — effective projection vs the fixture.
  const { providers, sourceLayers } = projectEffectiveProviders({ layerDocs });
  // Invariant: a provider definition's npm/package field tells the
  // engine to LOAD CODE inside the credential-bearing process — an unrelated
  // provider id is as much an executable surface as a plugin. The beta gate
  // allows exactly ONE provider definition: the managed triss-worker fixture
  // (worker route) or none at all (built-in routes).
  for (const id of Object.keys(providers)) {
    if (id !== prefix) {
      throw new Error(
        `OpenCode 2 preflight aborted: config layer ${sourceLayers[id]} defines provider "${id}", which the ` +
          'selected model does not use. A provider definition is an executable surface (its npm/package is ' +
          'loaded inside the OpenCode process with the credential in the environment) — unrelated provider ' +
          'definitions are rejected for the beta. Remove the definition and retry.',
      );
    }
  }
  if (fixture.managedProvider) {
    const translated = providers[prefix];
    if (!translated) {
      throw new Error(
        `OpenCode 2 preflight aborted: the managed provider "${prefix}" is not defined in any auditable ` +
          'config layer — run `triss coder init --engine opencode --provider worker` first.',
      );
    }
    const check = isManagedTrissWorkerTranslation(translated, expectedWorkerBaseURL);
    if (!check.ok) {
      const detail = check.actual != null ? ` (baseURL "${check.actual}" != expected "${check.expected}")` : '';
      throw new Error(
        `OpenCode 2 preflight aborted: provider["${prefix}"] in ${sourceLayers[prefix]} does not match the ` +
          `managed translation fixture (${check.reason}${detail ? ': ' + detail : ''}). Remove the override or ` +
          're-run `triss coder init`. Triss refuses to forward TRISS_WORKER_API_KEY to a redirected endpoint.',
      );
    }
  } else if (Object.prototype.hasOwnProperty.call(providers, prefix)) {
    // Built-in route: a config layer DEFINING the provider id is an override
    // of the engine's built-in transport — reject before credential forward.
    throw new Error(
      `OpenCode 2 preflight aborted: config layer ${sourceLayers[prefix]} overrides the built-in provider ` +
        `"${prefix}" (endpoint/package/settings). Triss refuses to forward ${fixture.credentialEnv} to a ` +
        'project-configured endpoint. Remove the provider definition and retry.',
    );
  }

  // 3. PERMISSION GATE — final ordered policy, deny-first proof via the real
  //    last-match-wins evaluator.
  // Invariant: the selected agent's BLOCK (agents override config —
  // its rules merge LAST), not the defining document. find() used to return
  // the whole doc, re-merging doc-level rules and never seeing the agent's
  // own permissions. Later layers win for the block, mirroring the merge.
  let agentBlock = null;
  if (agentName) {
    for (const doc of layerDocs) {
      const block = doc?.agent?.[agentName] ?? doc?.agents?.[agentName];
      if (block != null) agentBlock = block;
    }
  }
  const policy = computeEffectivePermissionPolicy({ layerDocs, agentDoc: agentBlock });
  if (policy.unsafe) {
    const detail = policy.detail ? ` (${policy.detail})` : '';
    if (policy.reason === 'no-wildcard-deny') {
      throw new Error(
        'OpenCode 2 preflight aborted: the effective shell policy has no wildcard deny — every command not ' +
          'matched by a narrower rule falls back to the built-in allow/ask baseline, and --auto would approve ' +
          'it. Add permission.bash {"*": "deny"} to the config. The final ordered policy must end deny for "*" ' +
          'and allow only vetted commands.',
      );
    }
    throw new Error(
      'OpenCode 2 preflight aborted: the effective shell policy is not deny-everything — ' +
        `${policy.reason}${detail}. While the provider credential is in the child environment, ANY ` +
        'allowed shell command can disclose it (env expansion, `npm test` running untrusted JS), so the ' +
        'opencode2 beta allows NO live allow/ask rule — only a wildcard deny (rules shadowed by a later ' +
        'wildcard deny are dead and fine). Remove the allow/ask rule or shadow it with a later wildcard deny.',
    );
  }

  return {
    sources,
    projection: { providers, sourceLayers },
    policy: { rules: policy.rules, shellRuleCount: policy.shellRuleCount },
    route: { prefix, credentialEnv: fixture.credentialEnv },
    contentHashes,
  };
}

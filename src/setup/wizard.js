// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// The user-facing setup wizard (plan §3): Easy by default, Advanced by
// choice, targeted sections through the same machinery, and a headless
// --yes apply for non-interactive use. All value resolution goes through
// setup/configuration.js, all application through setup/plan.js and
// setup/engines.js — this module only collects intent and presents results.
// It never mutates process.env or writes files outside those modules.

import {
  maskValue,
  prompt,
  promptChoice,
  yesNo,
} from '../secrets.js';
import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
import { CANONICAL_PROVIDER_IDS } from '../provider-contract.js';
import { getProviderDefinition } from '../provider-registry.js';
import { loadIntegrations } from '../integrations/_registry.js';
import { readSetupState, previewSetupState } from './configuration.js';
import { planEngineSetup, applyEngineSetup, probeEngineVersionPolicy } from './engines.js';
import { buildSetupPlan, applySetupPlan } from './plan.js';

const CODER_ENGINES = Object.freeze(['opencode', 'opencode2', 'crush', 'omp']);

function isInteractive(deps = {}) {
  if (typeof deps.isInteractive === 'function') return Boolean(deps.isInteractive());
  return Boolean(process.stdin.isTTY);
}

function out(deps, text) {
  (deps.stderrWrite || ((s) => process.stderr.write(s)))(text);
}

function resolveMode(opts) {
  if (opts.standard && opts.advanced) {
    throw new Error('--standard / --advanced cannot be combined.');
  }
  if (opts.standard) return 'easy';
  if (opts.advanced) return 'advanced';
  return null;
}

export function resolveWizardTargets(targetArg, { integrations = [], coderManifest = null } = {}) {
  if (!targetArg) return { kind: 'none', names: [] };
  const name = String(targetArg).trim().toLowerCase();
  const valid = new Set([
    ...integrations.map((integration) => integration.name),
    ...(coderManifest ? [coderManifest.name] : []),
    ...CANONICAL_PROVIDER_IDS,
  ]);
  if (!valid.has(name)) {
    throw new Error(
      `Unknown target "${targetArg}". Try one of: ${[...valid].sort().join(', ')}.`,
    );
  }
  if (name === 'coder') return { kind: 'coder', names: ['coder'] };
  if (CANONICAL_PROVIDER_IDS.includes(name)) return { kind: 'provider', names: [name] };
  return { kind: 'integration', names: [name] };
}

async function chooseScope(opts, deps) {
  if (opts.local) return 'local';
  if (opts.global) return 'global';
  if (!isInteractive()) return 'global';
  const choice = await (deps.promptChoice || promptChoice)(
    'Save configuration to?',
    [
      { value: 'global', label: 'Global (~/.config/triss/.env) — recommended' },
      { value: 'local', label: 'Project (./.triss.env)' },
    ],
    { defaultIndex: 0 },
  );
  return choice;
}

function providerRecommendation(state) {
  const snapshot = state.snapshot;
  const configured = snapshot.defaultProvider;
  if (configured.source !== 'registry-default') return { providerId: configured.value, why: 'your current configuration' };
  const withCredential = CANONICAL_PROVIDER_IDS
    .filter((id) => snapshot.providers[id]?.credential?.value);
  if (withCredential.length === 1) return { providerId: withCredential[0], why: 'a key is already configured' };
  if (withCredential.length > 1) return { providerId: configured.value, why: 'multiple keys found — pick below' };
  return { providerId: configured.value, why: 'the recommended default' };
}

function fieldFor(state, key) {
  return state.fields.find((field) => field.key === key) || null;
}

function credentialPromptLabel(definition) {
  return definition.credential === 'ZHIPU_API_KEY'
    ? 'Z.AI API key'
    : definition.id === 'opencode-zen' || definition.id === 'opencode-go'
      ? 'OpenCode API key'
      : `${definition.id} API key`;
}

async function collectProviderCredential(draft, state, providerId, deps) {
  const definition = getProviderDefinition(providerId);
  const field = fieldFor(state, definition.credential);
  const existing = field?.current;
  if (existing?.value) {
    if (!deps.force && !deps.rerun) return; // preserve the existing choice
    const replace = await (deps.yesNo || yesNo)(
      `  ${credentialPromptLabel(definition)} is already set (${maskValue(String(existing.value))}). Replace?`,
      false,
    );
    if (!replace) return;
  }
  const value = await (deps.prompt || prompt)('  API key', { hidden: true });
  if (!value) {
    return { skipped: true };
  }
  setDraftValue(draft, definition.credential, value);
  return { skipped: false };
}

async function detectAgentHosts(deps) {
  const status = deps.mcpStatus
    ? await deps.mcpStatus()
    : (await import('../mcp/install.js')).showStatus;
  const hosts = [];
  try {
    const claude = await status('global', { target: 'claude' });
    if (claude?.present) hosts.push('claude');
  } catch { /* unreadable config — treat as absent */ }
  try {
    const codex = await status('global', { target: 'codex' });
    if (codex?.present) hosts.push('codex');
  } catch { /* unreadable config — treat as absent */ }
  return hosts;
}

// The printed first command must satisfy the real ask contract: --question
// is required and the prompt needs a source (--stdin). The model comes from
// the post-apply effective state when available (review round 3).
function firstCommand(state, providerId) {
  const modelAtom = state.snapshot.providers[providerId]?.model;
  const model = (modelAtom?.value && modelAtom.source !== 'absent' ? modelAtom.value : null)
    || getProviderDefinition(providerId).defaults.model;
  const modelArg = /^[A-Za-z0-9._/-]+$/.test(model) ? ` --model ${providerId}/${model}` : '';
  return `printf 'ping' | triss ask${modelArg} --stdin --question 'Reply with pong.'`;
}

// ─── Easy ────────────────────────────────────────────────────────────────────

async function runEasyFlow({ draft, state, opts, deps }) {
  out(deps, '\n── Easy setup ──\n');

  // 1. Provider and access.
  const recommendation = providerRecommendation(state);
  const providerChoices = CANONICAL_PROVIDER_IDS.map((id) => ({
    value: id,
    label: id === recommendation.providerId ? `${id} (recommended — ${recommendation.why})` : id,
  }));
  const providerId = await (deps.promptChoice || promptChoice)(
    'Which model provider?',
    providerChoices,
    { defaultIndex: CANONICAL_PROVIDER_IDS.indexOf(recommendation.providerId) },
  );
  setDraftValue(draft, 'TRISS_DEFAULT_PROVIDER', providerId);
  // A skipped key is NOT recorded as a permanent failure: readiness is
  // re-derived from the final post-draft state at finalize time, so adding
  // the key later (Advanced/Providers) makes the run complete (review
  // round 5, R5-B).
  await collectProviderCredential(draft, state, providerId, deps);

  // 2. Working tool (agent hosts) — not an execution-engine question.
  const detected = await detectAgentHosts(deps);
  const agentChoices = [
    { value: 'both', label: `Both Claude and Codex${detected.length ? ` (found: ${detected.join(', ')})` : ''}` },
    { value: 'claude', label: 'Claude' },
    { value: 'codex', label: 'Codex' },
    { value: 'none', label: 'Skip — wire later with triss mcp install / triss init' },
  ];
  const agent = opts.agent
    ? String(opts.agent).toLowerCase()
    : await (deps.promptChoice || promptChoice)('Connect Triss to a coding assistant?', agentChoices, { defaultIndex: 0 });
  if (!['claude', 'codex', 'both', 'none'].includes(agent)) {
    throw new Error(`--agent must be one of: claude, codex, both, none (got "${agent}").`);
  }
  draft.agent = agent;

  // 3. Engine + models come from the effective configuration or registry
  // defaults; they stay changeable in Advanced, not on the Easy path.
  const engineField = fieldFor(state, 'TRISS_CODER_ENGINE');
  draft.engineId = engineField?.current?.value || 'opencode';
  // Role models come from the provider profile; nothing to ask on Easy.
  return { providerId };
}

// ─── Advanced ────────────────────────────────────────────────────────────────

async function runAdvancedFlow({ draft, state, scope, opts, deps, integrations }) {
  const sections = [
    { value: 'providers', label: 'Providers — keys, endpoints, main/small models' },
    { value: 'execution', label: 'Execution — default engine, coder provider/engine, effort, protection' },
    { value: 'connections', label: 'Connections — Claude/Codex, MCP and rules' },
    { value: 'integrations', label: 'Integrations — GitHub/GitLab/Jira/Confluence/Linear' },
    { value: 'runtime', label: 'Runtime — limits, timeouts, network, usage, pricing, update' },
    { value: 'maintenance', label: 'Maintenance — validation and repair' },
    { value: 'done', label: 'Done — review and apply' },
  ];
  while (true) {
    const section = await (deps.promptChoice || promptChoice)('Advanced setup — which section?', sections, {
      defaultIndex: sections.length - 1,
    });
    if (section === 'done') break;
    // Every section revisit renders "current" values from a FRESH
    // post-draft preview, so earlier edits of this run are visible and a
    // re-selection compares against the true post-draft value, not the
    // startup snapshot (review round 4, R3).
    const previewState = previewSetupState(state, draft, { scope, integrations });
    if (section === 'providers') await sectionProviders({ draft, previewState, deps });
    if (section === 'execution') await sectionExecution({ draft, previewState, deps });
    if (section === 'connections') await sectionConnections({ draft, deps, scope, opts });
    if (section === 'integrations') await sectionIntegrations({ draft, previewState, deps, integrations });
    if (section === 'runtime') await sectionRuntime({ draft, previewState, deps });
    if (section === 'maintenance') await sectionMaintenance({ draft, deps });
  }
}

async function sectionProviders({ draft, previewState, deps }) {
  const provider = await (deps.promptChoice || promptChoice)(
    'Provider profile to configure?',
    [
      ...CANONICAL_PROVIDER_IDS.map((id) => ({ value: id, label: id })),
      { value: 'shared-default', label: 'Set the shared default provider (TRISS_DEFAULT_PROVIDER)' },
      { value: 'back', label: 'Back' },
    ],
    { defaultIndex: 0 },
  );
  if (provider === 'back') return;
  if (provider === 'shared-default') {
    const current = fieldFor(previewState, 'TRISS_DEFAULT_PROVIDER')?.current;
    const action = await (deps.promptChoice || promptChoice)(
      `  Shared default provider (current: ${current?.value ?? 'openai-compatible'} [${current?.source || 'registry-default'}])`,
      [
        { value: 'keep', label: 'Keep' },
        ...CANONICAL_PROVIDER_IDS.map((id) => ({ value: id, label: id })),
      ],
      { defaultIndex: 0 },
    );
    if (action !== 'keep') setDraftValue(draft, 'TRISS_DEFAULT_PROVIDER', action);
    return;
  }
  const definition = getProviderDefinition(provider);
  await collectProviderCredential(draft, previewState, provider, { ...deps, force: true });
  const keys = [definition.fields.endpoint, definition.fields.model, definition.fields.smallModel];
  for (const key of keys) {
    const field = fieldFor(previewState, key);
    const current = field?.current;
    const action = await (deps.promptChoice || promptChoice)(
      `  ${field?.description || key} (current: ${current?.value ? String(current.value) : 'not set'} [${current?.source || 'absent'}])`,
      [
        { value: 'keep', label: 'Keep' },
        { value: 'replace', label: 'Replace' },
        { value: 'unset', label: 'Remove override' },
      ],
      { defaultIndex: 0 },
    );
    if (action === 'unset') {
      if (current?.source === 'shell') {
        out(deps, '  · shell value cannot be unset from here — remove it from your shell profile\n');
      } else {
        unsetDraftValue(draft, key);
      }
    } else if (action === 'replace') {
      const value = await (deps.prompt || prompt)('  value', {
        defaultValue: current?.value ? String(current.value) : '',
      });
      if (value) setDraftValue(draft, key, value);
    }
  }
}

async function sectionExecution({ draft, previewState, deps }) {
  // Enter preserves the EFFECTIVE value and its inheritance: a field whose
  // current source is registry-default stays unset instead of gaining a
  // local override that merely restates the default (review finding).
  const editEnumField = async (key, label, valid) => {
    const current = previewState.fields.find((f) => f.key === key)?.current;
    const value = await (deps.prompt || prompt)(
      `${label} (current: ${current?.value ?? 'native default'} [${current?.source || 'registry-default'}]; Enter = keep, '-' = remove override)`,
      { defaultValue: '' },
    );
    if (value === '' || value === undefined) return;
    if (value === '-') {
      if (current?.source === 'shell') out(deps, '  · shell value cannot be unset from here\n');
      else unsetDraftValue(draft, key);
      return;
    }
    if (valid && !valid.includes(value)) {
      throw new Error(`${label} must be one of ${valid.join(', ')} (got "${value}").`);
    }
    if (value === current?.value && (current?.source === 'registry-default' || current?.source === 'absent')) return;
    setDraftValue(draft, key, value);
  };

  await editEnumField('TRISS_DEFAULT_ENGINE', 'Default engine for model tasks', ['direct', 'opencode', 'opencode2', 'omp', 'crush']);
  await editEnumField('TRISS_CODER_ENGINE', 'Coding engine', CODER_ENGINES);
  draft.engineId = draftValueOf(draft, 'TRISS_CODER_ENGINE')
    || fieldFor(previewState, 'TRISS_CODER_ENGINE')?.current?.value || 'opencode';
  await editEnumField('TRISS_CODER_PROVIDER', 'Coding provider', CANONICAL_PROVIDER_IDS);
  await editEnumField('TRISS_DEFAULT_EFFORT', 'Default effort for model tasks', ['low', 'medium', 'high', 'xhigh', 'max']);
  await editEnumField('TRISS_CODER_EFFORT', 'Coding effort override', ['low', 'medium', 'high', 'xhigh', 'max']);

  const protection = await (deps.promptChoice || promptChoice)(
    'Credential protection',
    [
      { value: 'keep', label: `Keep current (${previewState.fields.find((f) => f.key === 'TRISS_PROTECT_CREDENTIALS')?.current?.value || 'engine default'})` },
      { value: 'true', label: 'Protected — parent-owned proxy where available' },
      { value: 'false', label: 'Raw — forward the selected credential directly' },
    ],
    { defaultIndex: 0 },
  );
  if (protection !== 'keep') setDraftValue(draft, 'TRISS_PROTECT_CREDENTIALS', protection);
}

async function sectionConnections({ draft, deps, scope, opts }) {
  const agent = opts.agent || await (deps.promptChoice || promptChoice)(
    'Wire which assistant?',
    [
      { value: 'both', label: 'Both (MCP + rules)' },
      { value: 'claude', label: 'Claude only' },
      { value: 'codex', label: 'Codex only' },
      { value: 'none', label: 'Skip' },
    ],
    { defaultIndex: 0 },
  );
  draft.agent = agent;
  if (agent !== 'none') {
    out(deps, `  · MCP will be ${agent === 'codex' ? 'global (~/.codex/config.toml — Codex has no project-local MCP)' : scope === 'local' ? 'project (.mcp.json)' : 'global (~/.claude.json)'}; rules in ${scope === 'local' ? './CLAUDE.md' : '~/.claude/CLAUDE.md'}\n`);
  }
}

async function sectionIntegrations({ draft, previewState, deps, integrations, preselected = [] }) {
  const choices = integrations
    .filter((integration) => integration.envVars?.length)
    .map((integration) => {
      const ready = integration.envVars.filter((v) => v.required).every((v) => process.env[v.name]);
      return { value: integration.name, label: `${integration.name}${ready ? ' (configured)' : ''}` };
    });
  if (!choices.length) {
    out(deps, '  · no integrations found\n');
    return;
  }
  // A targeted integration run names its target: asking "which integrations"
  // again would be a redundant re-entry of information already on the CLI.
  const pickedNames = preselected.length > 0
    ? preselected
    : String(await (deps.prompt || prompt)(
      `Configure which integrations (comma-separated names, empty to skip)? ${choices.map((c) => c.value).join(', ')}`,
      { defaultValue: '' },
    )).split(/[,\s]+/).filter(Boolean);
  // Shared credential groups: Atlassian asks once for Jira+Confluence.
  const asked = new Set();
  for (const integration of integrations) {
    if (!pickedNames.includes(integration.name)) continue;
    for (const envVar of integration.envVars || []) {
      if (asked.has(envVar.name)) continue;
      asked.add(envVar.name);
      void previewState;
      const value = await (deps.prompt || prompt)(`  ${envVar.name}${envVar.required ? ' (required)' : ' (optional)'}`, {
        hidden: /TOKEN|KEY|SECRET|PASS/i.test(envVar.name),
        defaultValue: '',
      });
      if (value) setDraftValue(draft, envVar.name, value);
      // A skipped required integration field is re-derived from the final
      // post-draft state at finalize time (R5-B): filling it on a later
      // visit must clear the gap.
    }
  }
}

async function sectionRuntime({ draft, previewState, deps }) {
  const groups = new Map();
  for (const field of previewState.fields) {
    if (!['requests', 'review', 'corpus', 'paths', 'usage', 'update', 'engine-tuning', 'model-transport'].includes(field.group)) continue;
    if (!groups.has(field.group)) groups.set(field.group, []);
    groups.get(field.group).push(field);
  }
  for (const [group, fields] of groups) {
    out(deps, `\n  ${group}:`);
    for (const field of fields) {
      const value = await (deps.prompt || prompt)(
        `  ${field.key} (${field.description}; current: ${field.current?.value ?? 'not set'} [${field.current?.source || 'absent'}], empty = keep)`,
        { defaultValue: '' },
      );
      if (value === '') continue;
      if (value === '-') unsetDraftValue(draft, field.key);
      else setDraftValue(draft, field.key, value);
    }
  }
}

async function sectionMaintenance({ draft, deps }) {
  const validate = await (deps.yesNo || yesNo)('Validate the configuration now (static checks only — no network)?', false);
  if (validate) draft.validate = 'static';
}

// ─── Targeted flows ──────────────────────────────────────────────────────────

async function runTargetedFlow({ kind, names, draft, state, opts, deps, integrations }) {
  if (kind === 'coder') {
    const providerId = opts.coderProvider
      ? String(opts.coderProvider).toLowerCase()
      : state.snapshot.coderProvider?.value
        || providerRecommendation(state).providerId;
    setDraftValue(draft, 'TRISS_CODER_PROVIDER', providerId);
    if (opts.coderEngine) setDraftValue(draft, 'TRISS_CODER_ENGINE', opts.coderEngine);
    if (opts.coderProtectCredentials) setDraftValue(draft, 'TRISS_CODER_PROTECT_CREDENTIALS', 'true');
    if (opts.coderNoProtectCredentials) setDraftValue(draft, 'TRISS_CODER_PROTECT_CREDENTIALS', 'false');
    draft.engineId = opts.coderEngine || fieldFor(state, 'TRISS_CODER_ENGINE')?.current?.value || 'opencode';
    await collectProviderCredential(draft, state, providerId, { ...deps, force: deps.force });
    return;
  }
  if (kind === 'provider') {
    const providerId = names[0];
    setDraftValue(draft, 'TRISS_DEFAULT_PROVIDER', providerId);
    await collectProviderCredential(draft, state, providerId, { ...deps, force: false });
    // Provider endpoints/models stay editable without being asked here.
    return;
  }
  // integration target: the section is preselected by the target argument
  await sectionIntegrations({ draft, previewState: state, deps, preselected: names, integrations: integrations.filter((i) => names.includes(i.name)) });
}

// ─── Headless ────────────────────────────────────────────────────────────────

function headlessAssemble({ draft, opts, targets }) {
  // An explicit target narrows the headless apply to that section.
  if (targets?.kind === 'provider') {
    setDraftValue(draft, 'TRISS_DEFAULT_PROVIDER', targets.names[0]);
  }
  if (opts.coderProvider) setDraftValue(draft, 'TRISS_CODER_PROVIDER', String(opts.coderProvider).toLowerCase());
  if (opts.coderEngine) {
    if (!CODER_ENGINES.includes(opts.coderEngine)) {
      throw new Error(`--coder-engine must be one of ${CODER_ENGINES.join(', ')}.`);
    }
    setDraftValue(draft, 'TRISS_CODER_ENGINE', opts.coderEngine);
    draft.engineId = opts.coderEngine;
  }
  // Protection flags apply on the headless path too — they were previously
  // handled only by the interactive targeted flow, so a headless coder setup
  // silently dropped the declared protection choice.
  if (opts.coderProtectCredentials) setDraftValue(draft, 'TRISS_CODER_PROTECT_CREDENTIALS', 'true');
  if (opts.coderNoProtectCredentials) setDraftValue(draft, 'TRISS_CODER_PROTECT_CREDENTIALS', 'false');
  if (opts.coderProtectCredentials && opts.coderNoProtectCredentials) {
    throw new Error('--coder-protect-credentials and --coder-no-protect-credentials cannot be combined.');
  }
  draft.agent = opts.agent ? String(opts.agent).toLowerCase() : 'none';
  if (draft.agent !== 'none' && !['claude', 'codex', 'both'].includes(draft.agent)) {
    throw new Error(`--agent must be claude, codex, both, or none (got "${draft.agent}").`);
  }
}

// Headless completeness, checked against the POST-draft state (review round
// 4, R2): a coder target validates the EFFECTIVE coding provider's key —
// never the shared provider's; a provider target validates that profile; an
// integration target validates its manifest's required fields; a general
// setup validates the resolved shared provider. Empty string counts as an
// absent credential. Runs before any write.
function missingRequirements({ preview, targets, opts: _opts, state: _state }) {
  const fieldValue = (key) => preview.fields.find((f) => f.key === key)?.current?.value;
  const missing = [];

  if (targets?.kind === 'integration') {
    for (const field of preview.fields
      .filter((f) => f.group === `integration:${targets.names[0]}` && f.required && !f.pattern)) {
      if (field.current?.value === undefined || field.current?.value === '') {
        missing.push({
          component: `integration:${targets.names[0]}`,
          key: field.key,
          reason: `${field.key} is not set`,
          remedy: `triss config set ${field.key}`,
        });
      }
    }
    return missing;
  }

  const providerId = targets?.kind === 'provider'
    ? targets.names[0]
    : targets?.kind === 'coder'
      ? (fieldValue('TRISS_CODER_PROVIDER') || fieldValue('TRISS_DEFAULT_PROVIDER') || 'openai-compatible')
      : preview.snapshot.defaultProvider?.value || 'openai-compatible';
  const credential = preview.snapshot.providers[providerId]?.credential?.value;
  if (!credential) {
    missing.push({
      component: `provider:${providerId}`,
      key: getProviderDefinition(providerId).credential,
      reason: `${getProviderDefinition(providerId).credential} is not set for provider "${providerId}"`,
      remedy: `triss config set ${getProviderDefinition(providerId).credential}`,
    });
  }
  return missing;
}

function validateHeadlessCompleteness({ preview, targets, opts, state }) {
  const missing = missingRequirements({ preview, targets, opts, state });
  if (missing.length > 0) {
    throw new Error(
      `Headless setup incomplete: ${missing.map((m) => m.key).join(', ')} not set. ` +
        'Set it first (triss config set / stdin / env) and rerun.',
    );
  }
}

// ─── Orchestration ───────────────────────────────────────────────────────────

function createDraft() {
  return { set: [], unset: [], incomplete: [], agent: null, engineId: null, validate: null, scope: null };
}

// Ordered draft mutations: the LAST confirmed action for a key wins. A set
// replaces a previous unset and vice versa — the coalescing in
// applyDraftToSnapshot cannot recover user intent from two unordered lists
// (review round 3, set→unset ordering).
function setDraftValue(draft, key, value) {
  draft.unset = draft.unset.filter((k) => k !== key);
  const existing = draft.set.find((e) => e.key === key);
  if (existing) existing.value = value;
  else draft.set.push({ key, value });
}

function unsetDraftValue(draft, key) {
  draft.set = draft.set.filter((e) => e.key !== key);
  if (!draft.unset.includes(key)) draft.unset.push(key);
}

function draftValueOf(draft, key) {
  if (draft.unset.includes(key)) return undefined;
  return draft.set.find((e) => e.key === key)?.value;
}

export async function runSetupWizard(targetArg, opts = {}, deps = {}) {
  // Argument validation BEFORE any side effect (no env file creation yet).
  const mode = resolveMode(opts);
  if (mode && targetArg) {
    throw new Error('--standard / --advanced cannot be combined with a target argument.');
  }
  const integrations = deps.integrations || await loadIntegrations();
  const coderManifest = deps.coderManifest || (await import('../commands/coder.js')).CODER_MANIFEST;
  const targets = resolveWizardTargets(targetArg, { integrations, coderManifest });
  const interactive = isInteractive(deps);
  if (!interactive && !opts.yes) {
    throw new Error(
      'triss config wizard is interactive; in non-interactive shells pass --yes to apply a complete configuration ' +
        'assembled from existing files, the environment, and explicit flags (--agent, --install).',
    );
  }

  // Migration gate BEFORE any draft is assembled: schema-2 writes must never
  // land on top of unmigrated legacy data (plan §P10.6).
  const inspectMigration = deps.inspectMigration
    || (async (options) => (await import('../migration/migrate.js')).inspectMigration(options));
  const migration = await inspectMigration({
    cwd: process.env.TRISS_PROJECT_ROOT || process.cwd(),
    home: homedir(),
  });
  // 'required' also fires when the planner would merely append default
  // canonical lines (e.g. TRISS_DEFAULT_ENGINE) to an already-clean file.
  // The gate exists for LEGACY data (plan §P10.6), so require an actual
  // legacy key in one of the target files before demanding a migration.
  let legacyRequired = migration.state === 'required';
  if (legacyRequired) {
    const { discoverMigrationTargets, envTextHasLegacyKeys } = await import('../migration/migrate.js');
    const { readFileSync } = await import('node:fs');
    legacyRequired = discoverMigrationTargets({
      cwd: process.env.TRISS_PROJECT_ROOT || process.cwd(),
      home: homedir(),
    }).some((target) => target.kind === 'env' && envTextHasLegacyKeys(readFileSync(target.path, 'utf8')));
  }
  if (legacyRequired) {
    if (!interactive) {
      throw new Error(
        'Legacy configuration detected — run `triss migrate` first; the wizard refuses to write schema 2 over unmigrated data.',
      );
    }
    const migrateNow = await (deps.yesNo || yesNo)(
      'Legacy configuration found. Run the canonical migration now (recommended)?',
      true,
    );
    if (!migrateNow) {
      throw new Error('Setup cancelled — run `triss migrate` before configuring.');
    }
    const runMigration = deps.runMigration
      || (async (options) => (await import('../migration/migrate.js')).runMigration(options));
    await runMigration({
      cwd: process.env.TRISS_PROJECT_ROOT || process.cwd(),
      home: homedir(),
    });
  }

  const scope = await chooseScope(opts, deps);
  const state = readSetupState({ scope, integrations, populateRawTexts: true });
  // Baseline for the whole interactive window: prompts run against THIS
  // content; buildSetupPlan refuses to plan if the file moved underneath.
  const { getEnvFilePath } = await import('../secrets.js');
  let stateRawHash;
  try {
    stateRawHash = sha256(readFileSync(getEnvFilePath(scope), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    stateRawHash = sha256('');
  }
  const draft = createDraft();
  draft.scope = scope;

  let easyProvider = null;
  if (opts.yes) {
    headlessAssemble({ draft, opts, targets });
  } else if (targets.kind !== 'none') {
    await runTargetedFlow({ ...targets, draft, state, opts, deps, integrations });
  } else if (mode === 'advanced') {
    await runAdvancedFlow({ draft, state, scope, opts, deps, integrations });
  } else {
    const easy = await runEasyFlow({ draft, state, opts, deps });
    easyProvider = easy.providerId;
    if (interactive) {
      const goAdvanced = await (deps.yesNo || yesNo)('Fine-tune anything else in Advanced?', false);
      if (goAdvanced) await runAdvancedFlow({ draft, state, scope, opts, deps, integrations });
    }
  }

  // Engine plan: only flows that configure coding execution plan an engine
  // install/setup — provider and integration targets must not drag a coder
  // engine along (plan §3.3).
  const plansCodingEngine = targets.kind === 'none' || targets.kind === 'coder';
  // ONE true post-draft state: the collected set/unset edits applied to a
  // copy of the selected layer, re-read through the normal resolution order
  // (shell > local > global > defaults). Every intent value — shared
  // provider, coding provider, coding engine — derives from THIS state, so
  // an unset reveals its real fallback and an explicit choice (including
  // "back to the original value") is honored. No startup-state fallback
  // chains here (review round 4, R1/R2).
  const preview = previewSetupState(state, draft, { scope, integrations });
  const fieldValue = (src, key) => src.fields.find((f) => f.key === key)?.current?.value;
  const sharedProviderId = fieldValue(preview, 'TRISS_DEFAULT_PROVIDER')
    || state.snapshot.defaultProvider?.value || 'openai-compatible';
  const coderProviderId = fieldValue(preview, 'TRISS_CODER_PROVIDER') || sharedProviderId;
  const coderEngineId = fieldValue(preview, 'TRISS_CODER_ENGINE') || 'opencode';
  draft.coderProviderId = coderProviderId;
  // Keep draft.engineId aligned with the preview resolution for callers
  // that read it after this point (summary, apply).
  draft.engineId = CODER_ENGINES.includes(coderEngineId) ? coderEngineId : 'opencode';
  if (opts.yes) {
    validateHeadlessCompleteness({ preview, targets, opts, state });
  }
  // Headless runs install only with --install; interactive runs fold the
  // install into the summary confirmation.
  const engineInstallChoice = opts.install || interactive ? 'install' : 'skip';
  const enginePlan = plansCodingEngine
    ? await planEngineSetup({
      engine: draft.engineId,
      provider: coderProviderId,
      scope,
      installChoice: engineInstallChoice,
    }, {
      probeEngine: deps.probeEngine || ((engine) => probeEngineVersionPolicy(engine)),
    })
    : null;

  const plan = buildSetupPlan({
    scope,
    draft,
    state,
    enginePlan,
    hostActions: agentHostActions(draft.agent, scope),
    requestedValidation: draft.validate === 'static',
    integrations,
    stateRawHash,
  });

  if (!opts.yes) {
    const confirmed = await confirmPlan(plan, { deps, install: enginePlan });
    if (!confirmed) {
      out(deps, '\nCancelled — nothing was written.\n');
      return { status: 'cancelled', applied: [], warnings: [] };
    }
  }

  // File transaction FIRST: the env patch, host configs, and .gitignore land
  // as one guarded apply. Engine installs and the engine provider setup run
  // AFTER the file transaction (their own writers own their durability), so
  // a post-apply failure never strands a half-written env file.
  const result = await applySetupPlan(plan, {
    installMcp: deps.installMcp,
    writeRules: deps.writeRules,
    rereadState: () => readSetupState({ scope, integrations }),
  });

  const engineResult = enginePlan
    ? await applyEngineSetup(enginePlan, {
      installChoice: engineInstallChoice,
      runInstall: deps.runInstall,
      runCoderSetup: deps.runCoderSetup,
    })
    : null;

  // Honest final status: ready only when the file transaction AND the engine
  // setup AND every required credential succeeded (plan §1.1/§P06 acceptance).
  const staticValidation = draft.validate === 'static'
    ? await runStaticValidation({ deps })
    : null;
  // R5: judge readiness on the CURRENT post-apply state — engine setup may
  // have persisted values after the file transaction, and skipped keys may
  // have been provided later in the flow.
  const finalState = result.state
    ? readSetupState({ scope, integrations, populateRawTexts: true })
    : null;
  const missing = missingRequirements({
    preview: finalState || state,
    targets,
    opts,
    state: finalState || state,
    integrations,
    selectedIntegrations: draft.integrations || [],
  });
  const finalResult = finalizeResult({ result, engineResult, draft, staticValidation, missing });
  printResult({
    result: finalResult,
    engineResult,
    state,
    providerId: easyProvider
      || draftValueOf(draft, 'TRISS_DEFAULT_PROVIDER')
      || draftValueOf(draft, 'TRISS_CODER_PROVIDER')
      || result.state?.snapshot?.defaultProvider?.value
      || state.snapshot.defaultProvider?.value,
    deps,
  });
  if (finalResult.status !== 'ready') process.exitCode = 1;
  return finalResult;
}

// Static validation: the effective configuration must resolve real model
// requests for both roles of the default provider — no network involved.
async function runStaticValidation({ deps }) {
  const problems = [];
  const readSnapshot = deps.readProviderConfigSnapshot
    || (await import('../provider-config.js')).readProviderConfigSnapshot;
  const { resolveModelRequest } = await import('../model-selection.js');
  let snapshot;
  try {
    snapshot = readSnapshot();
  } catch (error) {
    return { problems: [`configuration cannot be read: ${error.message}`] };
  }
  for (const role of ['model', 'smallModel']) {
    try {
      resolveModelRequest({ role }, snapshot);
    } catch (error) {
      problems.push(`${role}: ${error.message}`);
    }
  }
  return { problems };
}

// The wizard's own result: never a green "complete" over a failed engine
// setup, a skipped required credential, or failed static validation.
// True when the named credential is absent/empty in the snapshot the final
// result is judged against (the post-apply re-read).
function finalCredentialMissing(key, snapshot) {
  if (!snapshot) return true;
  for (const providerId of CANONICAL_PROVIDER_IDS) {
    if (getProviderDefinition(providerId).credential === key) {
      const value = snapshot.providers[providerId]?.credential?.value;
      return value === undefined || value === '';
    }
  }
  return true;
}

function finalizeResult({ result, engineResult, draft, staticValidation, missing }) {
  const warnings = [...result.warnings];
  // Failure entries are renderer objects {kind, path, reason}; the added
  // findings keep that shape so printing never shows "undefined: undefined".
  const failures = [...result.failed];
  const asFailure = (kind, reason, remedy) => Object.freeze({ kind, path: null, reason, ...(remedy ? { remedy } : {}) });
  if (engineResult && engineResult.status === 'incomplete') {
    for (const outcome of engineResult.outcomes || []) {
      if (outcome.status === 'failed') {
        failures.push(asFailure(`${outcome.kind} (${outcome.engine})`, outcome.reason));
      }
      if (outcome.status === 'skipped' && outcome.kind === 'engine-install') {
        failures.push(asFailure(`engine-install (${outcome.engine})`, `skipped: ${outcome.reason}`));
      }
    }
  }
  // R5: readiness follows the FINAL post-draft state, not the answer
  // history. draft.incomplete entries are re-evaluated by key against the
  // post-apply snapshot: a key skipped earlier but provided later clears.
  for (const incomplete of draft.incomplete || []) {
    const stillMissing = incomplete.key
      ? finalCredentialMissing(incomplete.key, result.state?.snapshot)
      : true;
    if (stillMissing) {
      failures.push(asFailure('credential', incomplete.reason, incomplete.remedy));
    }
  }
  if (staticValidation) {
    for (const problem of staticValidation.problems) failures.push(asFailure('validation', problem));
  }
  // The resolved missing-requirements list (post-apply state) is the source
  // of truth; history entries whose key is now present are dropped.
  for (const req of missing || []) {
    if (!failures.some((f) => typeof f === 'object' && f.key === req.key)) {
      failures.push(asFailure(req.component, req.reason, req.remedy));
    }
  }
  const status = result.status === 'ready' && failures.length === 0 ? 'ready' : 'incomplete';
  return Object.freeze({
    ...result,
    status,
    failed: Object.freeze(failures),
    warnings: Object.freeze(warnings),
  });
}

function agentHostActions(agent, scope) {
  if (!agent || agent === 'none') return [];
  const hosts = agent === 'both' ? ['claude', 'codex'] : [agent];
  // The promised integration is BOTH surfaces: the MCP server entry and the
  // managed rules block, each through its existing writer.
  return hosts.flatMap((target) => [
    {
      kind: 'mcp',
      target,
      scope: target === 'codex' ? 'global' : (scope || 'global'),
    },
    {
      kind: 'rules',
      target,
      scope: scope || 'global',
    },
  ]);
}


async function confirmPlan(plan, { deps }) {
  out(deps, '\n── Summary ──\n');
  const summary = plan.summary;
  out(deps, `  provider : ${summary.provider}\n`);
  out(deps, `  engine   : ${summary.engine}\n`);
  if (summary.models?.model) {
    out(deps, `  models   : ${summary.models.model} (main)${summary.models.smallModel ? ` / ${summary.models.smallModel} (small)` : ''}\n`);
  }
  for (const file of summary.filesToChange) {
    out(deps, `  file     : ${file.path} (${file.kind})\n`);
  }
  for (const action of summary.externalActions) {
    if (action.needed) out(deps, `  install  : ${action.reason || action.engine}\n`);
  }
  for (const limitation of summary.limitations) {
    out(deps, `  note     : ${limitation}\n`);
  }
  out(deps, '\n');
  return (deps.yesNo || yesNo)('Apply?', true);
}

function describeAction(action) {
  if (typeof action === 'string') return action;
  const detail = action.keys?.length ? ` (${action.keys.join(', ')})` : action.detail ? ` (${action.detail})` : '';
  return `${action.kind}: ${action.path ?? ''}${detail}`;
}

function printResult({ result, engineResult, state, providerId, deps }) {
  out(deps, `\n${result.status === 'ready' ? '✓ Setup complete.' : '⚠ Setup incomplete.'}\n`);
  for (const action of result.applied) out(deps, `  ✓ ${describeAction(action)}\n`);
  for (const action of result.failed) {
    out(deps, `  ✗ ${describeAction(action)}${typeof action === 'object' && action.reason ? ` — ${action.reason}` : ''}\n`);
  }
  for (const warning of result.warnings) out(deps, `  · ${warning}\n`);
  for (const component of result.perComponent || []) {
    if (component.configured === false) {
      out(deps, `  · ${component.name}: ${component.reasons.join('; ')}\n`);
    }
  }
  for (const outcome of engineResult?.outcomes || []) {
    if (outcome.status === 'applied') out(deps, `  ✓ ${outcome.kind}: ${outcome.reason || outcome.engine}\n`);
    if (outcome.status === 'failed') out(deps, `  ✗ ${outcome.kind} (${outcome.engine}): ${outcome.reason}\n`);
    if (outcome.status === 'skipped') out(deps, `  · ${outcome.kind} skipped — ${outcome.reason || 'not needed'}\n`);
  }
  if (providerId && result.status === 'ready') {
    // The applied state (applySetupPlan re-reads the real files) reflects
    // what the user configured; fall back to the pre-apply snapshot.
    out(deps, `\nFirst command:\n  ${firstCommand(result.state || state, providerId)}\n`);
  }
}

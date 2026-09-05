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
import { CANONICAL_PROVIDER_IDS } from '../provider-contract.js';
import { getProviderDefinition } from '../provider-registry.js';
import { loadIntegrations } from '../integrations/_registry.js';
import { readSetupState } from './configuration.js';
import { planEngineSetup, applyEngineSetup, probeEngineVersionPolicy } from './engines.js';
import { buildSetupPlan, applySetupPlan } from './plan.js';

const CODER_ENGINES = Object.freeze(['opencode', 'opencode2', 'crush', 'omp']);

function isInteractive() {
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
  draft.set.push({ key: definition.credential, value });
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

function firstCommand(state, providerId) {
  const model = state.snapshot.providers[providerId]?.model?.value
    || getProviderDefinition(providerId).defaults.model;
  return `triss ask --model ${providerId}/${model} "ping"`;
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
  draft.set.push({ key: 'TRISS_DEFAULT_PROVIDER', value: providerId });
  const credentialOutcome = await collectProviderCredential(draft, state, providerId, deps);
  if (credentialOutcome?.skipped) {
    draft.incomplete.push({
      reason: `${credentialPromptLabel(getProviderDefinition(providerId))} not set`,
      remedy: `triss config set ${getProviderDefinition(providerId).credential}`,
    });
  }

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
  const seen = new Set();
  while (true) {
    const section = await (deps.promptChoice || promptChoice)('Advanced setup — which section?', sections, {
      defaultIndex: sections.length - 1,
    });
    if (section === 'done') break;
    if (seen.has(section)) continue;
    seen.add(section);
    if (section === 'providers') await sectionProviders({ draft, state, deps });
    if (section === 'execution') await sectionExecution({ draft, state, deps, opts });
    if (section === 'connections') await sectionConnections({ draft, state, deps, scope, opts });
    if (section === 'integrations') await sectionIntegrations({ draft, state, deps, integrations });
    if (section === 'runtime') await sectionRuntime({ draft, state, deps });
    if (section === 'maintenance') await sectionMaintenance({ draft, state, deps });
  }
}

async function sectionProviders({ draft, state, deps }) {
  const provider = await (deps.promptChoice || promptChoice)(
    'Provider profile to configure?',
    [...CANONICAL_PROVIDER_IDS.map((id) => ({ value: id, label: id })), { value: 'back', label: 'Back' }],
    { defaultIndex: 0 },
  );
  if (provider === 'back') return;
  const definition = getProviderDefinition(provider);
  await collectProviderCredential(draft, state, provider, { ...deps, force: true });
  const keys = [definition.fields.endpoint, definition.fields.model, definition.fields.smallModel];
  for (const key of keys) {
    const field = fieldFor(state, key);
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
        draft.unset.push(key);
      }
    } else if (action === 'replace') {
      const value = await (deps.prompt || prompt)('  value', {
        defaultValue: current?.value ? String(current.value) : '',
      });
      if (value) draft.set.push({ key, value });
    }
  }
}

async function sectionExecution({ draft, state, deps }) {
  const sharedEngine = fieldFor(state, 'TRISS_DEFAULT_ENGINE');
  const sharedEngineValue = await (deps.prompt || prompt)('Default engine for model tasks (direct/opencode/opencode2/omp/crush)', {
    defaultValue: sharedEngine?.current?.value || 'direct',
  });
  if (sharedEngineValue) draft.set.push({ key: 'TRISS_DEFAULT_ENGINE', value: sharedEngineValue });

  const coderEngine = await (deps.prompt || prompt)('Coding engine (opencode/opencode2/crush/omp)', {
    defaultValue: fieldFor(state, 'TRISS_CODER_ENGINE')?.current?.value || 'opencode',
  });
  if (coderEngine && !CODER_ENGINES.includes(coderEngine)) {
    throw new Error(`Coding engine must be one of ${CODER_ENGINES.join(', ')} (got "${coderEngine}").`);
  }
  draft.set.push({ key: 'TRISS_CODER_ENGINE', value: coderEngine });
  draft.engineId = coderEngine;

  const coderProvider = await (deps.prompt || prompt)('Coding provider (empty = inherit the shared default)', {
    defaultValue: fieldFor(state, 'TRISS_CODER_PROVIDER')?.current?.value || '',
  });
  if (coderProvider) draft.set.push({ key: 'TRISS_CODER_PROVIDER', value: coderProvider });
  else if (fieldFor(state, 'TRISS_CODER_PROVIDER')?.current?.source === 'config') draft.unset.push('TRISS_CODER_PROVIDER');

  for (const [key, label] of [
    ['TRISS_DEFAULT_EFFORT', 'Default effort for model tasks (low/medium/high/xhigh/max, empty = native default)'],
    ['TRISS_CODER_EFFORT', 'Coding effort override (empty = inherit)'],
  ]) {
    const value = await (deps.prompt || prompt)(label, {
      defaultValue: fieldFor(state, key)?.current?.value || '',
    });
    if (value) draft.set.push({ key, value });
  }

  const protection = await (deps.promptChoice || promptChoice)(
    'Credential protection',
    [
      { value: 'keep', label: `Keep current (${fieldFor(state, 'TRISS_PROTECT_CREDENTIALS')?.current?.value || 'engine default'})` },
      { value: 'true', label: 'Protected — parent-owned proxy where available' },
      { value: 'false', label: 'Raw — forward the selected credential directly' },
    ],
    { defaultIndex: 0 },
  );
  if (protection !== 'keep') draft.set.push({ key: 'TRISS_PROTECT_CREDENTIALS', value: protection });
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

async function sectionIntegrations({ draft, state, deps, integrations }) {
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
  const picked = await (deps.prompt || prompt)(
    `Configure which integrations (comma-separated names, empty to skip)? ${choices.map((c) => c.value).join(', ')}`,
    { defaultValue: '' },
  );
  const pickedNames = String(picked || '').split(/[,\s]+/).filter(Boolean);
  // Shared credential groups: Atlassian asks once for Jira+Confluence.
  const asked = new Set();
  for (const integration of integrations) {
    if (!pickedNames.includes(integration.name)) continue;
    for (const envVar of integration.envVars || []) {
      if (asked.has(envVar.name)) continue;
      asked.add(envVar.name);
      const existing = process.env[envVar.name] || fieldFor(state, envVar.name)?.current?.value;
      const value = await (deps.prompt || prompt)(`  ${envVar.name}${envVar.required ? ' (required)' : ' (optional)'}`, {
        hidden: /TOKEN|KEY|SECRET|PASS/i.test(envVar.name),
        defaultValue: '',
      });
      if (value) draft.set.push({ key: envVar.name, value });
      else if (!existing && envVar.required) {
        draft.incomplete.push({ reason: `${envVar.name} not set`, remedy: `triss config set ${envVar.name}` });
      }
    }
  }
}

async function sectionRuntime({ draft, state, deps }) {
  const groups = new Map();
  for (const field of state.fields) {
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
      if (value === '-') draft.unset.push(field.key);
      else draft.set.push({ key: field.key, value });
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
    draft.set.push({ key: 'TRISS_CODER_PROVIDER', value: providerId });
    if (opts.coderEngine) draft.set.push({ key: 'TRISS_CODER_ENGINE', value: opts.coderEngine });
    draft.engineId = opts.coderEngine || fieldFor(state, 'TRISS_CODER_ENGINE')?.current?.value || 'opencode';
    await collectProviderCredential(draft, state, providerId, { ...deps, force: deps.force });
    return;
  }
  if (kind === 'provider') {
    const providerId = names[0];
    draft.set.push({ key: 'TRISS_DEFAULT_PROVIDER', value: providerId });
    await collectProviderCredential(draft, state, providerId, { ...deps, force: false });
    // Provider endpoints/models stay editable without being asked here.
    return;
  }
  // integration target
  await sectionIntegrations({ draft, state, deps, integrations: integrations.filter((i) => names.includes(i.name)) });
}

// ─── Headless ────────────────────────────────────────────────────────────────

function headlessAssemble({ draft, state, opts }) {
  if (opts.coderProvider) draft.set.push({ key: 'TRISS_CODER_PROVIDER', value: String(opts.coderProvider).toLowerCase() });
  if (opts.coderEngine) {
    if (!CODER_ENGINES.includes(opts.coderEngine)) {
      throw new Error(`--coder-engine must be one of ${CODER_ENGINES.join(', ')}.`);
    }
    draft.set.push({ key: 'TRISS_CODER_ENGINE', value: opts.coderEngine });
    draft.engineId = opts.coderEngine;
  }
  draft.agent = opts.agent ? String(opts.agent).toLowerCase() : 'none';
  if (draft.agent !== 'none' && !['claude', 'codex', 'both'].includes(draft.agent)) {
    throw new Error(`--agent must be claude, codex, both, or none (got "${draft.agent}").`);
  }
  // Completeness: the selected (or default) provider must have its credential
  // from an existing file or shell; --yes never turns a missing key into ok.
  const providerId = opts.coderProvider || state.snapshot.defaultProvider.value;
  const credential = state.snapshot.providers[providerId]?.credential?.value;
  if (!credential) {
    throw new Error(
      `Headless setup incomplete: ${getProviderDefinition(providerId).credential} is not set for provider "${providerId}". ` +
        'Set it first (triss config set / stdin / env) and rerun.',
    );
  }
}

// ─── Orchestration ───────────────────────────────────────────────────────────

function createDraft() {
  return { set: [], unset: [], incomplete: [], agent: null, engineId: null, validate: null, scope: null };
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
  const interactive = isInteractive();
  if (!interactive && !opts.yes) {
    throw new Error(
      'triss config wizard is interactive; in non-interactive shells pass --yes to apply a complete configuration ' +
        'assembled from existing files, the environment, and explicit flags (--agent, --install).',
    );
  }

  const scope = await chooseScope(opts, deps);
  const state = readSetupState({ scope, ...(deps.readSetupState ? { } : {}) });
  const draft = createDraft();
  draft.scope = scope;

  let easyProvider = null;
  if (opts.yes) {
    headlessAssemble({ draft, state, scope, opts });
  } else if (targets.kind !== 'none') {
    await runTargetedFlow({ ...targets, draft, state, scope, opts, deps, integrations });
  } else if (mode === 'advanced') {
    await runAdvancedFlow({ draft, state, scope, opts, deps, integrations });
  } else {
    const easy = await runEasyFlow({ draft, state, scope, opts, deps, integrations });
    easyProvider = easy.providerId;
    if (interactive) {
      const goAdvanced = await (deps.yesNo || yesNo)('Fine-tune anything else in Advanced?', false);
      if (goAdvanced) await runAdvancedFlow({ draft, state, scope, opts, deps, integrations });
    }
  }

  // Engine plan: probe only the engine this setup will use. Installs run
  // BEFORE the file transaction, only with consent (--install headless, the
  // summary confirmation interactive).
  const engineId = draft.engineId || fieldFor(state, 'TRISS_CODER_ENGINE')?.current?.value || 'opencode';
  // Headless runs install only with --install; interactive runs fold the
  // install into the summary confirmation.
  const engineInstallChoice = opts.install || interactive ? 'install' : 'skip';
  const enginePlan = await planEngineSetup({
    engine: CODER_ENGINES.includes(engineId) ? engineId : 'opencode',
    scope,
    installChoice: engineInstallChoice,
  }, {
    probeEngine: deps.probeEngine || ((engine) => probeEngineVersionPolicy(engine)),
  });

  const plan = buildSetupPlan({
    scope,
    draft,
    state,
    enginePlan,
    hostActions: agentHostActions(draft.agent, scope),
    requestedValidation: draft.validate === 'static',
  });

  if (!opts.yes) {
    const confirmed = await confirmPlan(plan, { deps, install: enginePlan, opts });
    if (!confirmed) {
      out(deps, '\nCancelled — nothing was written.\n');
      return { status: 'cancelled', applied: [], warnings: [] };
    }
  }

  const engineResult = await applyEngineSetup(enginePlan, {
    installChoice: engineInstallChoice,
    runInstall: deps.runInstall,
    runCoderSetup: deps.runCoderSetup,
  });

  const result = await applySetupPlan(plan, {
    installMcp: deps.installMcp,
    writeRules: deps.writeRules,
    rereadState: () => readSetupState({ scope }),
  });

  printResult({ result, engineResult, state, providerId: easyProvider || draft.set.find((e) => e.key === 'TRISS_DEFAULT_PROVIDER')?.value, deps, scope });
  if (result.status !== 'ready') process.exitCode = 1;
  return result;
}

function agentHostActions(agent, scope) {
  if (!agent || agent === 'none') return [];
  const targets = agent === 'both' ? ['claude', 'codex'] : [agent];
  return targets.map((target) => ({
    kind: 'mcp-install',
    target,
    scope: target === 'codex' ? 'global' : (scope || 'global'),
  }));
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
  const detail = action.keys?.length ? ` (${action.keys.join(', ')})` : action.detail ? ` (${action.detail})` : '';
  return `${action.kind}: ${action.path}${detail}`;
}

function printResult({ result, engineResult, state, providerId, deps }) {
  out(deps, `\n${result.status === 'ready' ? '✓ Setup complete.' : '⚠ Setup incomplete.'}\n`);
  for (const action of result.applied) out(deps, `  ✓ ${describeAction(action)}\n`);
  for (const action of result.failed) out(deps, `  ✗ ${action.kind}: ${action.path}${action.reason ? ` — ${action.reason}` : ''}\n`);
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
    out(deps, `\nFirst command:\n  ${firstCommand(state, providerId)}\n`);
  }
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { MODEL_EXECUTION_ENGINES } from './provider-contract.js';

export const READ_ONLY_PROJECTION_AGENT = 'triss-readonly-projection';

// A projection receives its complete corpus in the prompt. It must not gain
// ambient filesystem access: a broad read allow would override OpenCode's
// built-in secret-file prompts and explicit user denies after config merge.
const READ_ONLY_AGENT_PERMISSION = Object.freeze({
  '*': 'deny',
  task: 'deny',
  skill: 'deny',
  edit: 'deny',
  bash: 'deny',
  external_directory: 'deny',
});

const READ_ONLY_PROJECTION_AGENT_DEFINITION = Object.freeze({
  name: READ_ONLY_PROJECTION_AGENT,
  description: 'Triss run-scoped read-only model projection agent.',
  mode: 'primary',
  disable: false,
  permission: READ_ONLY_AGENT_PERMISSION,
  prompt:
    'You are a read-only Triss model projection. Answer the supplied request using only the explicitly ' +
    'provided context. Never read files, edit files, run shell commands, load skills, or delegate to subagents.',
});

// Every engine can execute a non-coder model projection. What differs is the
// AVAILABLE protection, not permission to run: opencode gets a verified
// deny-everything agent; opencode2 runs with its built-in agent under the
// merged deny-first permission policy; omp runs under its run-private policy
// overlay; crush runs single-agent with the restrict allowlist when enabled.
// Engines without a VERIFIED read-only projection report their concrete
// limitation; callers surface it as a warning, never as a refusal.
const POLICIES = Object.freeze({
  direct: Object.freeze({
    engine: 'direct',
    supported: true,
    agent: null,
    isolate: null,
    credentialMode: 'transport',
    readOnlyGuarantee: 'verified',
    limitations: [],
  }),
  opencode: Object.freeze({
    engine: 'opencode',
    supported: true,
    agent: READ_ONLY_PROJECTION_AGENT,
    isolate: false,
    credentialMode: 'caller-selectable',
    readOnlyGuarantee: 'verified',
    limitations: [],
  }),
  opencode2: Object.freeze({
    engine: 'opencode2',
    supported: true,
    agent: READ_ONLY_PROJECTION_AGENT,
    isolate: false,
    credentialMode: 'caller-selectable',
    readOnlyGuarantee: 'config-injected',
    limitations: [
      'opencode2 receives the deny-everything projection agent through its run-scoped config ' +
        'surface; the beta engine itself is not independently verified to enforce it',
    ],
  }),
  omp: Object.freeze({
    engine: 'omp',
    supported: true,
    agent: null,
    isolate: false,
    credentialMode: 'caller-selectable',
    readOnlyGuarantee: 'best-effort',
    limitations: [
      'omp runs the projection under its run-private deny-first policy overlay; ' +
        'tool restriction is configured per run, not verified',
    ],
  }),
  crush: Object.freeze({
    engine: 'crush',
    supported: true,
    agent: null,
    isolate: false,
    credentialMode: 'caller-selectable',
    restrict: true,
    readOnlyGuarantee: 'best-effort',
    limitations: [
      'crush runs the projection single-agent with the restrict allowlist; ' +
        'crush permissions.run config is inert, so restriction relies on CLI flags',
    ],
  }),
});

export const MODEL_PROJECTION_POLICIES = Object.freeze(
  MODEL_EXECUTION_ENGINES.map((engine) => POLICIES[engine]),
);

export function resolveModelProjectionPolicy(task, engine) {
  if (typeof task !== 'string' || task.length === 0 || task === 'coder') {
    throw new Error(`Task "${String(task)}" is not eligible for a read-only model projection`);
  }
  const policy = POLICIES[engine];
  if (!policy) throw new Error(`Unsupported execution engine "${String(engine)}"`);
  return policy;
}

export function withReadOnlyProjectionAgent(configContent) {
  let config;
  try {
    config = configContent ? JSON.parse(configContent) : {};
  } catch (error) {
    throw new Error('Cannot parse the Triss run-scoped OpenCode configuration for read-only projection.', {
      cause: error,
    });
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('The Triss run-scoped OpenCode configuration must be an object.');
  }
  return JSON.stringify({
    ...config,
    default_agent: READ_ONLY_PROJECTION_AGENT,
    agent: {
      ...(config.agent && typeof config.agent === 'object' && !Array.isArray(config.agent)
        ? config.agent
        : {}),
      [READ_ONLY_PROJECTION_AGENT]: READ_ONLY_PROJECTION_AGENT_DEFINITION,
    },
  });
}

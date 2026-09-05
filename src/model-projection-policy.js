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

const POLICIES = Object.freeze({
  direct: Object.freeze({
    engine: 'direct',
    supported: true,
    agent: null,
    isolate: null,
    credentialMode: 'transport',
  }),
  opencode: Object.freeze({
    engine: 'opencode',
    supported: true,
    agent: READ_ONLY_PROJECTION_AGENT,
    isolate: false,
    credentialMode: 'caller-selectable',
  }),
  opencode2: Object.freeze({
    engine: 'opencode2',
    supported: false,
    agent: null,
    isolate: null,
    credentialMode: 'unsupported',
  }),
  omp: Object.freeze({
    engine: 'omp',
    supported: false,
    agent: null,
    isolate: null,
    credentialMode: 'unsupported',
  }),
  crush: Object.freeze({
    engine: 'crush',
    supported: false,
    agent: null,
    isolate: null,
    credentialMode: 'unsupported',
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
  if (!policy.supported) {
    throw new Error(
      `Execution engine "${engine}" does not provide a verified read-only projection for task "${task}"; ` +
      'use engine "direct" or "opencode".',
    );
  }
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

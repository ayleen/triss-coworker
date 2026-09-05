// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { readProviderConfigSnapshot } from './provider-config.js';
import { resolveModelRequest } from './model-selection.js';
import { executeTransport } from './transport-registry.js';
import { MODEL_ENGINE_ADAPTERS } from './model-engine-adapters.js';
import { recordNormalizedUsage } from './model-usage.js';

const TASK_ROLES = Object.freeze({
  ask: 'smallModel',
  chat: 'smallModel',
  fetch: 'smallModel',
  'web-search': 'smallModel',
  'web-answer': 'smallModel',
  'commit-msg': 'smallModel',
  'integration-summary': 'smallModel',
  review: 'model',
  'review-shard': 'model',
  write: 'model',
  coder: 'model',
});

export function resolveTaskRole(task) {
  const role = TASK_ROLES[task];
  if (!role) throw new Error(`Unknown model task "${String(task)}"`);
  return role;
}

export function listModelTaskRoles() {
  return Object.freeze(Object.entries(TASK_ROLES).map(([task, role]) => Object.freeze({ task, role })));
}

export async function executeModelTask({
  task,
  input = {},
  provider,
  model,
  engine,
  effort,
  protectCredentials,
  signal,
  timeout,
} = {}, deps = {}) {
  const role = resolveTaskRole(task);
  const snapshot = deps.snapshot || (deps.readSnapshot || readProviderConfigSnapshot)();
  const resolved = (deps.resolveRequest || resolveModelRequest)({
    role,
    provider,
    model,
    engine,
    effort,
    defaultEngine: input.defaultEngine,
  }, snapshot);
  const request = Object.freeze({
    ...input,
    task,
    route: resolved.route,
    effort: resolved.effort,
    signal,
    protectCredentials: protectCredentials === true,
    timeout,
  });

  if (resolved.engine === 'direct') {
    const result = await (deps.executeTransport || executeTransport)(request, deps.transportDeps || {});
    const recordUsage = deps.recordUsage === false
      ? null
      : deps.recordUsage || recordNormalizedUsage;
    recordUsage?.(result, resolved, input.label || `triss/${task}`);
    return Object.freeze({ resolved, result });
  }

  const adapter = deps.engines?.[resolved.engine] || MODEL_ENGINE_ADAPTERS[resolved.engine];
  if (!adapter) throw new Error(`Unsupported execution engine "${resolved.engine}"`);
  const result = await adapter({ resolved, request, snapshot });

  return Object.freeze({ resolved, result });
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { executeProjectedEngineTask } from '../src/model-engine-adapters.js';
import {
  MODEL_PROJECTION_POLICIES,
  READ_ONLY_PROJECTION_AGENT,
  resolveModelProjectionPolicy,
  withReadOnlyProjectionAgent,
} from '../src/model-projection-policy.js';
import { createProviderConfigSnapshot } from '../src/provider-config.js';
import {
  executeModelTask,
  listModelTaskRoles,
  resolveTaskRole,
} from '../src/model-runtime.js';

const snapshot = createProviderConfigSnapshot({ parentEnv: {}, files: [] });
const museSnapshot = createProviderConfigSnapshot({
  parentEnv: {},
  files: [{ scope: 'local', path: '/project/.triss.env', exists: true }],
  readFile: () => [
    'TRISS_DEFAULT_PROVIDER=opencode-go',
    'TRISS_DEFAULT_ENGINE=opencode',
    'TRISS_OPENCODE_GO_MODEL=muse-spark-1.3-contributor',
    'TRISS_OPENCODE_GO_SMALL_MODEL=muse-spark-1.3-contributor',
  ].join('\n'),
});

test('model runtime owns the complete main and small task-role matrix', () => {
  assert.equal(resolveTaskRole('ask'), 'smallModel');
  assert.equal(resolveTaskRole('integration-summary'), 'smallModel');
  assert.equal(resolveTaskRole('review'), 'model');
  assert.equal(resolveTaskRole('coder'), 'model');
  assert.throws(() => resolveTaskRole('unknown'), /Unknown model task/);
  assert.equal(listModelTaskRoles().length, 11);
});

test('every execution engine has an explicit read-only projection policy', () => {
  assert.deepEqual(
    MODEL_PROJECTION_POLICIES.map(({ engine, supported, agent, isolate, credentialMode }) => ({
      engine,
      supported,
      agent,
      isolate,
      credentialMode,
    })),
    [
      { engine: 'direct', supported: true, agent: null, isolate: null, credentialMode: 'transport' },
      {
        engine: 'opencode',
        supported: true,
        agent: READ_ONLY_PROJECTION_AGENT,
        isolate: false,
        credentialMode: 'caller-selectable',
      },
      { engine: 'opencode2', supported: false, agent: null, isolate: null, credentialMode: 'unsupported' },
      { engine: 'omp', supported: false, agent: null, isolate: null, credentialMode: 'unsupported' },
      { engine: 'crush', supported: false, agent: null, isolate: null, credentialMode: 'unsupported' },
    ],
  );
  assert.equal(resolveModelProjectionPolicy('review', 'opencode').agent, READ_ONLY_PROJECTION_AGENT);
  for (const engine of ['opencode2', 'omp', 'crush']) {
    assert.throws(
      () => resolveModelProjectionPolicy('review', engine),
      new RegExp(`engine "${engine}" does not provide a verified read-only projection`),
    );
  }
});

test('run-scoped projection agent is active, context-only, and cannot read ambient files', () => {
  const config = JSON.parse(withReadOnlyProjectionAgent(JSON.stringify({
    model: 'provider/model',
    default_agent: 'coder',
    agent: {
      [READ_ONLY_PROJECTION_AGENT]: { disable: true },
    },
  })));
  assert.equal(config.default_agent, READ_ONLY_PROJECTION_AGENT);
  assert.deepEqual(config.agent[READ_ONLY_PROJECTION_AGENT], {
    description: 'Triss run-scoped read-only model projection agent.',
    mode: 'primary',
    disable: false,
    permission: {
      '*': 'deny',
      task: 'deny',
      skill: 'deny',
      edit: 'deny',
      bash: 'deny',
      external_directory: 'deny',
    },
    prompt:
      'You are a read-only Triss model projection. Answer the supplied request using only the explicitly ' +
      'provided context. Never read files, edit files, run shell commands, load skills, or delegate to subagents.',
  });
});

test('persistent OpenCode Go defaults route ask and review through Muse without request flags', async () => {
  const calls = [];
  for (const task of ['ask', 'review']) {
    const output = await executeModelTask({
      task,
      input: { messages: [{ role: 'user', content: task }] },
    }, {
      snapshot: museSnapshot,
      executeTransport: async () => {
        throw new Error('direct transport must not run');
      },
      engines: {
        opencode: async (projection) => {
          calls.push(projection.resolved);
          return { text: `${task}-ok` };
        },
      },
    });
    assert.equal(output.result.text, `${task}-ok`);
  }
  assert.deepEqual(calls.map(({ providerId, nativeModel, engine }) => ({
    providerId,
    nativeModel,
    engine,
  })), [
    {
      providerId: 'opencode-go',
      nativeModel: 'muse-spark-1.3-contributor',
      engine: 'opencode',
    },
    {
      providerId: 'opencode-go',
      nativeModel: 'muse-spark-1.3-contributor',
      engine: 'opencode',
    },
  ]);
});

test('direct runtime resolves selection before invoking one transport adapter', async () => {
  let transportRequest;
  let usageRecords = 0;
  const output = await executeModelTask({
    task: 'ask',
    provider: 'zai',
    model: 'glm-5.2',
    effort: 'high',
    input: { task: 'coder', messages: [{ role: 'user', content: 'q' }], maxOutputTokens: 100 },
  }, {
    snapshot,
    executeTransport: async (request) => {
      transportRequest = request;
      return { text: 'answer' };
    },
    recordUsage: () => { usageRecords += 1; },
  });
  assert.equal(output.resolved.role, 'smallModel');
  assert.equal(output.resolved.providerId, 'zai');
  assert.equal(output.resolved.publicModel, 'zai/glm-5.2');
  assert.equal(output.resolved.engine, 'direct');
  assert.equal(transportRequest.route.nativeModel, 'glm-5.2');
  assert.equal(transportRequest.effort, 'high');
  assert.equal(transportRequest.task, 'ask');
  assert.deepEqual(transportRequest.messages, [{ role: 'user', content: 'q' }]);
  assert.equal(output.result.text, 'answer');
  assert.equal(usageRecords, 1);
  assert.ok(Object.isFrozen(output));
});

test('non-direct runtime receives one resolved route and never re-resolves provider config', async () => {
  let projection;
  let usageRecords = 0;
  const output = await executeModelTask({
    task: 'coder',
    provider: 'moonshot',
    engine: 'omp',
    input: { prompt: 'change code', defaultEngine: 'opencode' },
  }, {
    snapshot,
    engines: {
      omp: async (value) => {
        projection = value;
        return { text: 'done' };
      },
    },
    recordUsage: () => { usageRecords += 1; },
  });
  assert.equal(output.resolved.role, 'model');
  assert.equal(output.resolved.engine, 'omp');
  assert.equal(projection.resolved.route.providerId, 'moonshot');
  assert.equal(projection.request.prompt, 'change code');
  assert.equal(usageRecords, 0);
});

test('runtime rejects invalid options before transport or engine execution', async () => {
  let executed = false;
  await assert.rejects(
    () => executeModelTask({ task: 'review', effort: 'auto' }, {
      snapshot,
      executeTransport: async () => { executed = true; },
    }),
    /Invalid effort/,
  );
  assert.equal(executed, false);
  await assert.rejects(
    () => executeModelTask({ task: 'review', engine: 'missing' }, { snapshot }),
    /Invalid engine "missing"/,
  );
});

test('production engine adapter projects the resolved route through coder and normalizes its envelope', async () => {
  let call;
  const result = await executeProjectedEngineTask({
    resolved: {
      engine: 'opencode',
      providerId: 'moonshot',
      nativeModel: 'kimi-k2.7-code',
      effort: 'xhigh',
    },
    request: {
      task: 'review',
      protectCredentials: true,
      timeout: 5000,
      messages: [
        { role: 'system', content: 'Return plain text.' },
        { role: 'user', content: 'Answer now.' },
      ],
      stream: true,
      onText: (text) => { call.streamed = text; },
    },
    snapshot,
  }, {
    runCoderRun: async (prompt, opts, deps) => {
      call = { prompt, opts, deps };
      deps.stdoutWrite(JSON.stringify({
        final_text: 'done',
        exit_reason: 'completed',
        engine_version: '1.2.3',
        run_id: 'run_test',
        warnings: ['engine warning'],
        usage: {
          tokens: {
            input_total: 11,
            output_total: 4,
            cache_read: 2,
            cache_write: 1,
          },
        },
      }) + '\n');
    },
  });
  assert.match(call.prompt, /SYSTEM:\nReturn plain text\./);
  assert.match(call.prompt, /USER:\nAnswer now\./);
  assert.deepEqual(call.opts, {
    engine: 'opencode',
    provider: 'moonshot',
    model: 'kimi-k2.7-code',
    effort: 'xhigh',
    modelProjectionTask: 'review',
    isolate: false,
    protectCredentials: true,
    timeout: 5,
  });
  assert.equal(call.deps.providerConfigSnapshot, snapshot);
  assert.equal(call.streamed, 'done');
  assert.equal(result.text, 'done');
  assert.equal(result.finishReason, 'completed');
  assert.deepEqual(result.usage, {
    inputTokens: 11,
    outputTokens: 4,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    reasoningTokens: null,
    totalTokens: 15,
  });
  assert.deepEqual(result.warnings, ['engine warning']);
  assert.deepEqual(result.rawMetadata, {
    engine: 'opencode',
    engineVersion: '1.2.3',
    runId: 'run_test',
  });
});

test('unsupported projected engines fail before coder execution', async () => {
  for (const engine of ['opencode2', 'omp', 'crush']) {
    let ran = false;
    await assert.rejects(
      () => executeProjectedEngineTask({
        resolved: { engine, providerId: 'zai', nativeModel: 'glm-5.2' },
        request: { task: 'review', prompt: 'review' },
        snapshot,
      }, {
        runCoderRun: async () => { ran = true; },
      }),
      /does not provide a verified read-only projection/,
    );
    assert.equal(ran, false);
  }
});

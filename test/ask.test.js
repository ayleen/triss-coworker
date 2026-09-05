// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAsk, runAskWithDeps } from '../src/commands/ask.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'triss.js');

function runtimeResponse(request, text = 'ok') {
  const providerId = request.provider || 'openai-compatible';
  const modelId = request.model?.includes('/') ? request.model.split('/').slice(1).join('/') : (request.model || 'test');
  return {
    resolved: {
      providerId,
      modelId,
      publicModel: `${providerId}/${modelId}`,
    },
    result: {
      text,
      reasoning: null,
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      finishReason: 'stop',
      rawMetadata: null,
    },
  };
}

test('ASK-01: runAsk rejects legacy providers before model execution', async () => {
  await assert.rejects(
    () => runAsk({
      paths: ['package.json'],
      question: 'What is this?',
      provider: 'glm',
      model: 'glm-5.2',
    }),
    /Invalid provider "glm"/,
  );
});

test('ASK-02: runAskWithDeps forwards canonical model selection to the shared runtime', async () => {
  let runtimeInput;
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    await runAskWithDeps(
      {
        paths: ['package.json'],
        question: 'What is this?',
        provider: 'zai',
        model: 'glm-5.2',
        engine: 'direct',
        effort: 'high',
        stream: false,
      },
      {
        async executeModelTask(input) {
          runtimeInput = input;
          return runtimeResponse(input);
        },
      },
    );
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }

  assert.equal(runtimeInput.task, 'ask');
  assert.equal(runtimeInput.provider, 'zai');
  assert.equal(runtimeInput.model, 'glm-5.2');
  assert.equal(runtimeInput.engine, 'direct');
  assert.equal(runtimeInput.effort, 'high');
  assert.equal(runtimeInput.input.label, 'triss/ask');
});

test('ASK-09: a quoted source glob sends file contents to the model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'triss-ask-context-'));
  const sourceDir = join(dir, 'src');
  const sourcePath = join(sourceDir, 'demo.js');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(sourcePath, 'const ASK_UNIQUE_SOURCE_MARKER = 7419;\n');
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  let request;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    await runAskWithDeps({
      paths: [join(dir, 'src/**/*.js')],
      question: 'Find correctness defects',
      stream: false,
    }, {
      executeModelTask: async (input) => {
        request = input;
        return runtimeResponse(input);
      },
    });
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.match(request.input.messages[1].content, /ASK_UNIQUE_SOURCE_MARKER = 7419/);
  assert.match(request.input.messages[1].content, /<file path='/);
});

test('ASK-10: file context guard rejects error-only paths but preserves empty and mixed sources', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'triss-ask-boundaries-'));
  const emptyPath = join(dir, 'empty.js');
  const validPath = join(dir, 'valid.js');
  writeFileSync(emptyPath, '');
  writeFileSync(validPath, 'const MIXED_SOURCE_MARKER = 8520;\n');
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    for (const path of [dir, join(dir, 'missing.js')]) {
      let executed = false;
      await assert.rejects(
        () => runAskWithDeps({ paths: [path], question: 'q', stream: false }, {
          executeModelTask: async () => {
            executed = true;
            return runtimeResponse({});
          },
        }),
        /No readable file content.*directories are not read recursively/,
        path,
      );
      assert.equal(executed, false, path);
    }

    let emptyRequest;
    await runAskWithDeps({ paths: [emptyPath], question: 'q', stream: false }, {
      executeModelTask: async (input) => {
        emptyRequest = input;
        return runtimeResponse(input);
      },
    });
    assert.match(emptyRequest.input.messages[1].content, new RegExp(`<file path='${emptyPath}'`));
    assert.doesNotMatch(emptyRequest.input.messages[1].content, /error=/);

    let mixedRequest;
    await runAskWithDeps({ paths: [validPath, join(dir, 'missing.js')], question: 'q', stream: false }, {
      executeModelTask: async (input) => {
        mixedRequest = input;
        return runtimeResponse(input);
      },
    });
    assert.match(mixedRequest.input.messages[1].content, /MIXED_SOURCE_MARKER = 8520/);
    assert.match(mixedRequest.input.messages[1].content, /missing\.js.*not found/);
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ASK-03: runAsk ignores Commander-like second arguments with dependency-shaped fields', async () => {
  const commanderArg = {
    executeModelTask() {
      throw new Error('Commander arg was used as runtime deps');
    },
  };
  await assert.rejects(
    () => runAsk({
      paths: ['package.json'],
      question: 'What is this?',
      provider: 'glm',
      model: 'glm-5.2',
    }, commanderArg),
    /Invalid provider "glm"/,
  );
});

test('ASK-04: CLI ask prints the normalized runtime text', async () => {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  const captured = [];
  process.stdout.write = (chunk) => {
    captured.push(String(chunk));
    return true;
  };
  process.stderr.write = () => true;

  try {
    await runAskWithDeps(
      {
        paths: ['package.json'],
        question: 'What is this?',
        provider: 'zai',
        model: 'glm-5.2',
        stream: false,
      },
      {
        executeModelTask: async (input) => runtimeResponse(input, 'The final answer.'),
      },
    );
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }

  assert.match(captured.join(''), /The final answer\./);
});

test('ASK-05: the real ask stdin caller keeps the helper default trim behavior', () => {
  const script = `
    import { runAskWithDeps } from './src/commands/ask.js';
    let captured;
    const originalWrite = process.stdout.write;
    process.stdout.write = () => true;
    await runAskWithDeps(
      { stdin: true, question: 'q', stream: false },
      {
        executeModelTask: async (input) => {
          captured = input;
          return {
            resolved: { providerId: 'openai-compatible', publicModel: 'openai-compatible/test' },
            result: { text: 'ok', reasoning: null, usage: {}, finishReason: 'stop', rawMetadata: null },
          };
        },
      },
    );
    process.stdout.write = originalWrite;
    console.log(JSON.stringify(captured.input.messages[1].content));
  `;
  const raw = '  leading\r\nbody\r\ntrailing  \n';
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    input: raw,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    JSON.parse(result.stdout),
    '<corpus>\n<source kind="stdin">\nleading\r\nbody\r\ntrailing\n</source>\n</corpus>',
  );
});

test('ASK-06: ask applies the direct CLI 8192 max-tokens default and honors an explicit value', async () => {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    let defaultRequest;
    await runAskWithDeps(
      { paths: ['package.json'], question: 'What is this?', stream: false },
      {
        executeModelTask: async (request) => {
          defaultRequest = request;
          return runtimeResponse(request);
        },
      },
    );
    assert.equal(defaultRequest.input.maxOutputTokens, 8192);

    let explicitRequest;
    await runAskWithDeps(
      { paths: ['package.json'], question: 'What is this?', maxTokens: 12_345, stream: false },
      {
        executeModelTask: async (request) => {
          explicitRequest = request;
          return runtimeResponse(request);
        },
      },
    );
    assert.equal(explicitRequest.input.maxOutputTokens, 12_345);
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
});

test('ASK-07: invalid max-tokens fails before corpus or model I/O', async () => {
  for (const maxTokens of [0, -1, 'abc', 1.5]) {
    let executed = false;
    await assert.rejects(
      () => runAskWithDeps({
        paths: ['missing-and-must-not-be-read'],
        question: 'q',
        maxTokens,
        stream: false,
      }, {
        executeModelTask: async () => {
          executed = true;
          throw new Error('unreachable');
        },
      }),
      /max-tokens must be a positive integer/,
    );
    assert.equal(executed, false);
  }
});

test('ASK-08: real CLI rejects partial and malformed token budgets without model I/O', () => {
  for (const value of ['1.5', '12junk', '0', '-1']) {
    const result = spawnSync(process.execPath, [
      BIN,
      'ask',
      '--paths',
      'package.json',
      '--question',
      'q',
      '--max-tokens',
      value,
    ], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' } });
    assert.notEqual(result.status, 0, value);
    assert.match(result.stderr, /max-tokens must be a positive integer/, value);
    assert.doesNotMatch(result.stderr, /provider=.*sources=/, value);
    assert.doesNotMatch(result.stderr, /at positiveIntegerOption|node:internal/, value);
  }
});

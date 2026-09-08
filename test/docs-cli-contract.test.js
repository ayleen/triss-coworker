// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// DOC-CLI contract tests (docs-first TDD): documentation examples must match
// the executable CLI tree, and the documented `ask --paths` input contract
// must hold in the runtime. Catches the D01/D02 drift classes:
//   - docs recommending a removed flag (e.g. coder run --small-model)
//   - docs recommending a non-existent command (e.g. coder status)
//   - docs implying directories are recursive inputs to `ask --paths`
//
// No network, no engine spawns: the doc checks are parse-only, and the ask
// check uses the runAskWithDeps dependency seam with a mock model boundary.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAskWithDeps } from '../src/commands/ask.js';
import {
  checkRepositoryDocs,
  collectCliFacts,
  checkInvocation,
} from '../scripts/check-doc-examples.js';
import { COMMANDS } from '../site/src/data/commands.js';

test('DOC-CLI-01/02: every documented triss example matches the registered CLI tree', () => {
  const { failures, fileCount } = checkRepositoryDocs();
  assert.equal(
    failures.length,
    0,
    `documented examples drift from the CLI tree:\n${failures.join('\n')}`,
  );
  assert.ok(fileCount > 20, 'expected the check to cover the user-facing doc set');
});

test('DOC-CLI-01: the removed `coder status` path is rejected by the checker', () => {
  const facts = collectCliFacts();
  const failures = checkInvocation(facts, {
    pathTokens: ['coder', 'status'],
    args: ['coder', 'status'],
  });
  assert.equal(failures.length, 1, 'coder status must be flagged as a non-existent command path');
});

test('DOC-CLI-02: the removed `--small-model` flag is rejected by the checker', () => {
  const facts = collectCliFacts();
  const failures = checkInvocation(facts, {
    pathTokens: ['coder', 'run'],
    args: ['coder', 'run', '--small-model', 'a/b'],
  });
  assert.deepEqual(
    failures.map((line) => line.includes('--small-model')),
    [true],
  );
});

test('DOC-CLI: site command cards reference registered flags and command paths', () => {
  const facts = collectCliFacts();
  for (const card of COMMANDS) {
    const example = card.example.replace(/^\$\s*/, '');
    // Card examples may be compound shell lines (`git add … && triss …`);
    // validate the triss invocation segment.
    const segment = example
      .split(/&&|\|/).map((part) => part.trim())
      .find((part) => part.startsWith('triss '));
    assert.ok(segment, `card ${card.name} example must invoke triss`);
    const tokens = segment.split(/\s+/);
    const pathTokens = [];
    let i = 1;
    while (i < tokens.length && !tokens[i].startsWith('-')) {
      // Integration commands (jira, linear, ...) are registered dynamically
      // and validated by the integration docs, not the static CLI tree.
      if (['jira', 'linear', 'github', 'gitlab', 'confluence'].includes(tokens[i])) return;
      pathTokens.push(tokens[i]);
      i += 1;
    }
    const failures = checkInvocation(facts, { pathTokens, args: tokens.slice(1) });
    assert.deepEqual(failures, [], `card ${card.name} example drifts from the CLI tree`);
  }
});

test('DOC-INPUT-01: a directory input fails before the model boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'triss-docinput-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'example.js'), 'export const marker = 1;\n');
  let modelCalled = false;
  await assert.rejects(
    runAskWithDeps(
      {
        paths: [join(dir, 'src')],
        question: 'What is the marker?',
        provider: 'zai',
        model: 'glm-5.2',
        engine: 'direct',
        stream: false,
      },
      {
        async executeModelTask() {
          modelCalled = true;
          throw new Error('model boundary must not be reached');
        },
      },
    ),
    (error) => /no readable file content/i.test(error.message),
  );
  assert.equal(modelCalled, false, 'empty corpus must fail before any model call');
});

test('DOC-INPUT-01: a quoted glob sends the matched file to the mock boundary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'triss-docglob-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'example.js'), 'export const marker = 1;\n');
  let receivedCorpus = null;
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    await runAskWithDeps(
      {
        paths: [join(dir, 'src', '**', '*.js')],
        question: 'What is the marker?',
        provider: 'zai',
        model: 'glm-5.2',
        engine: 'direct',
        stream: false,
      },
      {
        async executeModelTask(input) {
          receivedCorpus = input;
          return {
            resolved: { providerId: 'zai', modelId: 'glm-5.2', publicModel: 'zai/glm-5.2' },
            result: {
              text: 'ok',
              reasoning: null,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              finishReason: 'stop',
              rawMetadata: null,
            },
          };
        },
      },
    );
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  const corpusText = JSON.stringify(receivedCorpus);
  assert.match(corpusText, /marker = 1/);
});

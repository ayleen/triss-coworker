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
  validateRunnableExamples,
} from '../scripts/check-doc-examples.js';
import { COMMANDS } from '../site/src/data/commands.js';

test('DOC-CLI-01/02: every documented triss example matches the registered CLI tree', async () => {
  const { failures, fileCount } = await checkRepositoryDocs();
  assert.equal(
    failures.length,
    0,
    `documented examples drift from the CLI tree:\n${failures.join('\n')}`,
  );
  assert.ok(fileCount > 20, 'expected the check to cover the user-facing doc set');
});

test('DOC-CLI-01: the removed `coder status` path is rejected by the checker', async () => {
  const facts = await collectCliFacts();
  const failures = checkInvocation(facts, ['coder', 'status']);
  assert.equal(failures.length, 1, 'coder status must be flagged as a non-existent command path');
  assert.match(failures[0], /not a registered command path/);
});

test('DOC-CLI-02: the removed `--small-model` flag is rejected by the checker', async () => {
  const facts = await collectCliFacts();
  const failures = checkInvocation(facts, ['coder', 'run', '--small-model', 'a/b']);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /--small-model/);
});

// R03 regression fixtures: negative cases must be red, positive cases green,
// exercised through the full Markdown extraction path (fences, prompts,
// continuations, quotes), not just pre-split token arrays.

test('DOC-CLI-03a: a bad flag on a continuation line is rejected', async () => {
  const facts = await collectCliFacts();
  const markdown = '```bash\ntriss coder run "task" \\\n  --small-model zai/glm-5\n```';
  const findings = validateRunnableExamples(facts, markdown);
  assert.ok(findings.some((finding) => /--small-model/.test(finding.message)), JSON.stringify(findings));
  assert.match(findings[0].message, /--small-model/);
});

test('DOC-CLI-03b: console `$` prompts are validated, not skipped', async () => {
  const facts = await collectCliFacts();
  const markdown = '```console\n$ triss coder run "task" --small-model zai/glm-5\n```';
  const findings = validateRunnableExamples(facts, markdown);
  assert.ok(findings.some((finding) => /--small-model/.test(finding.message)), JSON.stringify(findings));
  assert.match(findings[0].message, /--small-model/);
});

test('DOC-CLI-03c: a missing mandatory option is rejected', async () => {
  const facts = await collectCliFacts();
  const markdown = '```bash\ntriss ask --paths README.md\n```';
  const findings = validateRunnableExamples(facts, markdown);
  assert.ok(findings.length >= 1, JSON.stringify(findings));
  assert.match(findings[0].message, /--question/);
});

test('DOC-CLI-03d: quoted shell separators stay inside the prompt', async () => {
  const facts = await collectCliFacts();
  const markdown = '```bash\ntriss chat "Explain this text; triss coder status"\n```';
  assert.deepEqual(validateRunnableExamples(facts, markdown), []);
});

test('DOC-CLI-03e: a `#` inside quotes is a value, not a comment', async () => {
  const facts = await collectCliFacts();
  const markdown = '```bash\ntriss chat "what does # mean here?"\n```';
  assert.deepEqual(validateRunnableExamples(facts, markdown), []);
});

test('DOC-CLI-03f: unregistered integration subcommands and options are rejected', async () => {
  const facts = await collectCliFacts();
  const findings = validateRunnableExamples(
    facts,
    '```bash\ntriss jira not-a-command --made-up\n```',
  );
  assert.ok(findings.length >= 1, JSON.stringify(findings));
});

test('DOC-CLI-03g: the explicit skip directive exempts a fence', async () => {
  const facts = await collectCliFacts();
  const markdown = [
    '<!-- doc-examples-skip -->',
    '```bash',
    'triss coder run "task" --small-model zai/glm-5',
    '```',
  ].join('\n');
  assert.deepEqual(validateRunnableExamples(facts, markdown), []);
});

test('DOC-CLI-03h: the legend directive validates documented option lists', async () => {
  const facts = await collectCliFacts();
  const bad = [
    '<!-- doc-examples-legend path="coder run" -->',
    '```bash',
    '--engine <name>     # real option',
    '--small-model <p/m> # removed option',
    '```',
  ].join('\n');
  const findings = validateRunnableExamples(facts, bad);
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.match(findings[0].message, /--small-model/);

  const good = [
    '<!-- doc-examples-legend path="coder run" -->',
    '```bash',
    '--engine <name>  # real option',
    '--isolate       # real option',
    '```',
  ].join('\n');
  assert.deepEqual(validateRunnableExamples(facts, good), []);
});

test('DOC-CLI-03i: output and diagram fences without a shell language are not runnable', async () => {
  const facts = await collectCliFacts();
  const markdown = '```\ntriss coder run / triss_coder_run (MCP)\n```';
  assert.deepEqual(validateRunnableExamples(facts, markdown), []);
});

test('DOC-CLI: every site command card example and flag list matches the CLI tree', async () => {
  const facts = await collectCliFacts();
  const integrationNames = new Set(['jira', 'linear', 'github', 'gitlab', 'confluence']);
  for (const card of COMMANDS) {
    const example = card.example.replace(/^\$\s*/, '');
    // Compound examples (`git add … && triss …`) must have every triss
    // segment validated, and an error in a card AFTER an integration card
    // must still fail this test — so no early returns per card.
    const segments = example.split(/&&|\|/).map((part) => part.trim()).filter(Boolean);
    const trissSegments = segments.filter((segment) => segment.startsWith('triss '));
    assert.ok(trissSegments.length > 0, `card ${card.name} example must invoke triss`);
    for (const segment of trissSegments) {
      const markdown = '```bash\n' + segment + '\n```';
      const findings = validateRunnableExamples(facts, markdown);
      assert.deepEqual(findings, [], `card ${card.name} example drifts from the CLI tree`);
    }
    // card.flags mixes executable flags with human-readable subcommand
    // synopses; validate the flag-shaped entries against the resolved card
    // command. Integration cards are exercised through their own docs.
    if (integrationNames.has(card.name)) continue;
    const command = facts.get(card.name);
    assert.ok(command, `card ${card.name} must name a registered command`);
    // Group cards (coder, config, mcp) summarize their most-used leaves, so
    // a flag counts as registered when any descendant command declares it.
    const descendants = [...facts.entries()].filter(([path]) => path === card.name || path.startsWith(`${card.name} `));
    const unionOptions = new Set(descendants.flatMap(([, entry]) => [...entry.options.keys()]));
    for (const flag of card.flags) {
      if (!flag.startsWith('--')) continue; // subcommand synopsis entries
      const name = flag.split(' ')[0].split('=')[0];
      assert.ok(
        unionOptions.has(name) || name === '--help',
        `card ${card.name} lists unregistered flag ${name}`,
      );
    }
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

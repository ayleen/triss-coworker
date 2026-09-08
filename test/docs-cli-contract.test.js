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

// C01 regression fixtures: the checker must agree with the real Commander
// parse of the registered declarations for the supported grammar.

test('C01: `triss config set` without the mandatory KEY argument is rejected', async () => {
  const facts = await collectCliFacts();
  const findings = validateRunnableExamples(facts, '```bash\ntriss config set\n```');
  assert.ok(findings.some((finding) => /mandatory argument `<KEY>`/.test(finding.message)), JSON.stringify(findings));
});

test('C01: `ask --paths --question x` is rejected the way Commander parses it', async () => {
  const facts = await collectCliFacts();
  const findings = validateRunnableExamples(facts, '```bash\ntriss ask --paths --question x\n```');
  assert.ok(findings.some((finding) => /--question/.test(finding.message)), JSON.stringify(findings));
});

test('C01: a short variadic alias accepts multiple values', async () => {
  const facts = await collectCliFacts();
  const findings = validateRunnableExamples(
    facts,
    '```bash\ntriss ask -p README.md SECURITY.md -q x\n```',
  );
  assert.deepEqual(findings, [], JSON.stringify(findings));
});

test('C01: `--help` short-circuits mandatory-option validation without duplicates', async () => {
  const facts = await collectCliFacts();
  const findings = validateRunnableExamples(facts, '```bash\ntriss ask --help\n```');
  assert.deepEqual(findings, [], JSON.stringify(findings));
});

test('C01: a removed flag hidden behind a double-quoted continuation is detected', async () => {
  const facts = await collectCliFacts();
  const BS = String.fromCharCode(92);
  const markdown = [
    '```bash',
    'triss coder run "first line ' + BS,
    'last line" ' + BS,
    '  --small-model x',
    '```',
  ].join('\n');
  const findings = validateRunnableExamples(facts, markdown);
  assert.ok(findings.some((finding) => /--small-model/.test(finding.message)), JSON.stringify(findings));
});

test('C01: the node bin form validates Triss flags and rejects unknown root flags', async () => {
  const facts = await collectCliFacts();
  const help = validateRunnableExamples(facts, '```bash\nnode bin/triss.js --help\n```');
  assert.deepEqual(help, [], JSON.stringify(help));
  const unknown = validateRunnableExamples(facts, '```bash\nnode bin/triss.js --not-a-flag\n```');
  assert.ok(unknown.some((finding) => /--not-a-flag/.test(finding.message)), JSON.stringify(unknown));
});

test('C01: orphan option segments from shell alternatives are flagged', async () => {
  const facts = await collectCliFacts();
  const findings = validateRunnableExamples(
    facts,
    '```bash\ntriss config wizard --local|--global\n```',
  );
  assert.ok(findings.some((finding) => /orphan option segment/.test(finding.message)), JSON.stringify(findings));
});

// V01 fixtures (review round 3): command boundaries and option grammar must
// follow the real Commander parse of the registered declarations. A newline
// inside an open quote continues ONE command; `--help` only short-circuits
// as an option, never as another option's value; `--` ends option parsing;
// boolean flags reject `--flag=value`; attached short values are accepted.

test('V01: a real newline inside double quotes keeps one command', async () => {
  const facts = await collectCliFacts();
  const markdown = '```bash\ntriss coder run "first line\nlast line" --small-model x\n```';
  const findings = validateRunnableExamples(facts, markdown);
  assert.ok(findings.some((finding) => /--small-model/.test(finding.message)), JSON.stringify(findings));
});

test('V01: a real newline inside single quotes keeps one command', async () => {
  const facts = await collectCliFacts();
  const markdown = "```bash\ntriss coder run 'first line\nlast line' --small-model x\n```";
  const findings = validateRunnableExamples(facts, markdown);
  assert.ok(findings.some((finding) => /--small-model/.test(finding.message)), JSON.stringify(findings));
});

test('V01: a command-shaped multi-line prompt is not split into runnable commands', async () => {
  const facts = await collectCliFacts();
  const markdown = '```bash\ntriss chat "first line\ntriss coder status"\n```';
  assert.deepEqual(validateRunnableExamples(facts, markdown), [], 'prompt text must stay inside the prompt argument');
});

test('V01: `--help` as an option value does not short-circuit validation', async () => {
  const facts = await collectCliFacts();
  const findings = validateRunnableExamples(
    facts,
    '```bash\ntriss ask --paths README.md --question "--help" --small-model x\n```',
  );
  assert.ok(findings.some((finding) => /--small-model/.test(finding.message)), JSON.stringify(findings));
});

test('V01: `--` ends option parsing the way Commander does', async () => {
  const facts = await collectCliFacts();
  const findings = validateRunnableExamples(facts, '```bash\ntriss chat -- "Explain this"\n```');
  assert.deepEqual(findings, [], JSON.stringify(findings));
});

test('V01: a boolean flag rejects the attached `=value` spelling', async () => {
  const facts = await collectCliFacts();
  const findings = validateRunnableExamples(facts, '```bash\ntriss coder run "task" --isolate=true\n```');
  assert.ok(findings.length >= 1, JSON.stringify(findings));
});

test('V01: attached short-option values are accepted', async () => {
  const facts = await collectCliFacts();
  const findings = validateRunnableExamples(facts, '```bash\ntriss ask -pREADME.md -qx\n```');
  assert.deepEqual(findings, [], JSON.stringify(findings));
});

test('V01: a variadic option rejects an attached first value (documented non-behavior)', async () => {
  const facts = await collectCliFacts();
  const findings = validateRunnableExamples(
    facts,
    '```bash\ntriss ask --paths=README.md SECURITY.md -q x\n```',
  );
  assert.ok(findings.length >= 1, 'must stay rejected exactly as Commander rejects it');
});

test('C01: parse-only validation never runs actions, bootstrap, or engines', async () => {
  // A fixture integration at <root>/src/integrations/probe with separate
  // registration/bootstrap/action counters. Registration MUST show up in the
  // inventory (a silent discovery failure would degrade this into a vacuous
  // core-only test — review V01 4.4); bootstrap and action MUST stay at zero.
  globalThis.__trissProbeCounters = { bootstrap: 0, action: 0 };
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triss-action-probe-'));
  fs.mkdirSync(path.join(root, 'src', 'integrations', 'probe'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'integrations', 'probe', 'index.js'), [
    'export default {',
    '  name: "probe",',
    '  description: "probe integration",',
    '  async bootstrap() { globalThis.__trissProbeCounters.bootstrap += 1; },',
    '  register(program) {',
    '    program',
    '      .command("probe-cmd")',
    '      .description("probe command")',
    '      .option("--probe-flag", "declared flag so the probe invocation parses cleanly")',
    '      .action(() => { globalThis.__trissProbeCounters.action += 1; });',
    '  },',
    '};',
  ].join('\n'));
  try {
    const probedFacts = await collectCliFacts({ root });
    assert.ok(
      probedFacts.has('probe probe-cmd'),
      'the fixture command must be registered before validation means anything',
    );
    const findings = validateRunnableExamples(
      probedFacts,
      '```bash\ntriss probe probe-cmd --probe-flag\n```',
    );
    assert.deepEqual(findings, [], `the valid probe invocation must parse cleanly: ${JSON.stringify(findings)}`);
    assert.equal(globalThis.__trissProbeCounters.action, 0, 'action handlers must never run during docs validation');
    assert.equal(globalThis.__trissProbeCounters.bootstrap, 0, 'credential bootstrap must never run during docs validation');
  } finally {
    delete globalThis.__trissProbeCounters;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C01: a broken integration manifest fails discovery loudly', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triss-manifest-probe-'));
  fs.mkdirSync(path.join(root, 'src', 'integrations', 'broken'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'integrations', 'broken', 'index.js'), 'export default {};\n');
  try {
    await assert.rejects(
      () => collectCliFacts({ root }),
      (error) => /missing register\(program\)|missing a "name"/.test(error.message),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('C01: a missing integrations directory fails discovery loudly', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triss-missing-integrations-'));
  try {
    await assert.rejects(() => collectCliFacts({ root }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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

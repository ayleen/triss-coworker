// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// R01 contract: packaged-docs validation separates RUNNABLE examples from
// prose. A prose warning that a bare `--paths src` directory input fails is
// correct documentation and must pass; the same token as a runnable
// recommendation must be rejected. Removed flags (`coder run --small-model`)
// are rejected in runnable form, in one line or across a continuation, and
// never in explanatory prose.
//
// Fully offline: fixtures live in temporary directories; no npm commands,
// no publication, no spawns.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePackagedDocs } from '../scripts/verify-published-docs.mjs';

function makePackageRoot({ readme }) {
  const root = mkdtempSync(join(tmpdir(), 'triss-published-docs-'));
  const manifest = {
    name: 'triss-coworker',
    version: '1.0.0',
    bin: { triss: './bin/triss.js' },
    homepage: 'https://triss.work/',
  };
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  for (const rel of [
    'SECURITY.md',
    'CHANGELOG.md',
    'docs/configuration.md',
    'docs/cli-reference.md',
    'docs/mcp.md',
    'docs/security-model.md',
    'docs/usage-accounting.md',
    'docs/getting-started.md',
    'docs/troubleshooting.md',
    'templates/claude-full.md',
    'templates/codex-full.md',
  ]) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), '# placeholder\n');
  }
  // A small real fixture tree: the --paths classifier judges values by
  // filesystem metadata, not by the spelling of the name (review C04).
  writeFileSync(join(root, 'LICENSE'), 'MIT License\n');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'example.js'), 'export const marker = 1;\n');
  writeFileSync(join(root, 'README.md'), readme);
  return root;
}

const README_WARNING_PARAGRAPH =
  '`--paths` accepts text files or quoted glob patterns. Directories are not read\n' +
  'recursively; an input like `--paths src` fails with a "no readable file content"\n' +
  'error before any model call. Quote globs so Triss, rather than the shell, expands\n' +
  'them.';

test('the corrected README warning about --paths src is accepted, not flagged', async () => {
  const readme = [
    '# Triss Coworker',
    '',
    '```bash',
    "triss ask --paths 'src/**/*.js' --question \"find defects\"",
    '```',
    '',
    README_WARNING_PARAGRAPH,
    '',
  ].join('\n');
  const root = makePackageRoot({ readme });
  const { findings } = await validatePackagedDocs({ packageRoot: root, expectedVersion: '1.0.0' });
  assert.deepEqual(findings, [], JSON.stringify(findings, null, 2));
});

test('a runnable --paths src recommendation is rejected; its prose explanation is not', async () => {
  const readme = [
    '# Triss Coworker',
    '',
    '```bash',
    'triss ask --provider zai --paths src --question "find correctness defects"',
    '```',
    '',
    README_WARNING_PARAGRAPH,
    '',
  ].join('\n');
  const root = makePackageRoot({ readme });
  const { findings } = await validatePackagedDocs({ packageRoot: root, expectedVersion: '1.0.0' });
  assert.equal(findings.length, 1, JSON.stringify(findings, null, 2));
  assert.match(findings[0], /README\.md:4: .*bare directory input `--paths src`/);
});

test('C04: directory inputs are rejected in every relative form; extensionless files pass', async () => {
  for (const [input, expected] of [
    ['src', true],
    ['src/', true],
    ['./src', true],
    ['LICENSE', false],
    ["'src/**/*.js'", false],
  ]) {
    const readme = [
      '# Triss Coworker',
      '',
      '```bash',
      `triss ask --paths ${input} --question "explain"`,
      '```',
      '',
      README_WARNING_PARAGRAPH,
      '',
    ].join('\n');
    const root = makePackageRoot({ readme });
    const { findings } = await validatePackagedDocs({ packageRoot: root, expectedVersion: '1.0.0' });
    const directoryFindings = findings.filter((finding) => /bare directory input/.test(finding));
    assert.equal(
      directoryFindings.length > 0,
      expected,
      `--paths ${input}: expected ${expected ? 'rejection' : 'acceptance'}, got ${JSON.stringify(findings)}`,
    );
  }
});

test('C04: a directory whose name contains a dot is still rejected', async () => {
  const root = makePackageRoot({
    readme: [
      '# Triss Coworker',
      '',
      '```bash',
      'triss ask --paths v1.2 --question "explain"',
      '```',
      '',
      README_WARNING_PARAGRAPH,
      '',
    ].join('\n'),
  });
  mkdirSync(join(root, 'v1.2'), { recursive: true });
  const { findings } = await validatePackagedDocs({ packageRoot: root, expectedVersion: '1.0.0' });
  assert.ok(findings.some((finding) => /bare directory input `--paths v1\.2`/.test(finding)), JSON.stringify(findings));
});

test('a removed --small-model recommendation is rejected in one line, in a continuation, and in a console prompt', async () => {
  const template = [
    '# Codex template',
    '',
    '```bash',
    'triss coder run "task" --small-model zai/glm-5',
    '```',
    '',
    '```bash',
    'triss coder run "task" \\',
    '  --small-model zai/glm-5',
    '```',
    '',
    '```console',
    '$ triss coder run "task" --small-model zai/glm-5',
    '```',
    '',
    'There is no public `coder run --small-model` option in 1.0.0; the small role',
    'comes from the selected provider profile.',
  ].join('\n');
  const root = mkdtempSync(join(tmpdir(), 'triss-published-docs-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'triss-coworker',
    version: '1.0.0',
    bin: { triss: './bin/triss.js' },
    homepage: 'https://triss.work/',
  }));
  // Only the template under test: keeps the fixture focused.
  mkdirSync(join(root, 'templates'), { recursive: true });
  writeFileSync(join(root, 'templates', 'codex-full.md'), template);
  const { findings } = await validatePackagedDocs({ packageRoot: root, expectedVersion: '1.0.0' });
  // Required-file findings are expected in this focused fixture; the
  // template findings are what this test pins.
  const templateFindings = findings.filter((finding) => finding.startsWith('templates/codex-full.md'));
  const smallModelFindings = templateFindings.filter((finding) => /--small-model/.test(finding));
  // One finding per rejected example: single line, continuation, console.
  assert.ok(smallModelFindings.length >= 3, JSON.stringify(findings, null, 2));
  for (const line of [4, 8, 13]) {
    assert.ok(
      smallModelFindings.some((finding) => finding.startsWith(`templates/codex-full.md:${line}:`)),
      `expected a --small-model rejection at line ${line}`,
    );
  }
});

test('missing files and version drift are reported', async () => {
  const root = mkdtempSync(join(tmpdir(), 'triss-published-docs-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'triss-coworker',
    version: '2.0.0',
    bin: { triss: './bin/triss.js' },
    homepage: 'http://insecure.example',
  }));
  const { findings } = await validatePackagedDocs({ packageRoot: root, expectedVersion: '1.0.0' });
  assert.ok(findings.some((finding) => finding === 'package is missing README.md'));
  assert.ok(findings.some((finding) => finding.includes('packaged version 2.0.0 != expected 1.0.0')));
  assert.ok(findings.some((finding) => finding === 'packaged manifest homepage is not https'));
});

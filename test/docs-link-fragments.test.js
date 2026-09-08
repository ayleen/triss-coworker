// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// DOC-LINK contract tests: the documentation link checker must validate
// heading fragments for local files, intra-page anchors, and same-repository
// GitHub links. Catches the D11 drift class — links whose file exists but
// whose section was renamed.
//
// Offline: fixtures live in temporary directories, no HTTP.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkRepositoryDocs,
  githubSlug,
  headingFragments,
  validateFragment,
} from '../scripts/check-doc-links.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('DOC-LINK-01: GitHub-style slugs handle duplicates, inline code, and punctuation', () => {
  assert.equal(githubSlug('Usage and pricing'), 'usage-and-pricing');
  assert.equal(githubSlug('The `triss usage` section'), 'the-triss-usage-section');
  assert.equal(githubSlug('Network and usage controls'), 'network-and-usage-controls');
  assert.equal(githubSlug('Configuration files and precedence'), 'configuration-files-and-precedence');
  assert.equal(githubSlug('CAFÉ — plans'), 'café--plans');
});

test('DOC-LINK-01: duplicate headings get GitHub -N suffixes', () => {
  const fragments = headingFragments(['## Example', '## Example', '## Example'].join('\n'));
  assert.deepEqual([...fragments].sort(), ['example', 'example-1', 'example-2']);
});

test('DOC-LINK-01: HTML anchors are accepted fragment targets', () => {
  const fragments = headingFragments('<a id="step-4"></a>\n## Real heading');
  assert.ok(fragments.has('step-4'));
  assert.ok(fragments.has('real-heading'));
});

test('DOC-LINK-01: the four audited broken fragments are rejected while the fixed ones resolve', () => {
  const readme = headingFragments(readFileSync(join(ROOT, 'README.md'), 'utf8'));
  const configuration = headingFragments(readFileSync(join(ROOT, 'docs/configuration.md'), 'utf8'));

  assert.ok(readme.has('usage-and-pricing'), 'README must keep the Usage and pricing anchor');
  assert.ok(!readme.has('triss-usage'), 'the old #triss-usage anchor is gone');
  assert.ok(configuration.has('network-and-usage-controls'), 'configuration must keep the Network and usage controls anchor');
  assert.ok(configuration.has('configuration-files-and-precedence'));
  assert.ok(!configuration.has('tunables'), 'the old #tunables anchor is gone');

  assert.equal(
    validateFragment('x.md', '[a](README.md#triss-usage)', 'triss-usage', true, readme),
    'x.md: missing fragment anchor: [a](README.md#triss-usage)',
  );
  assert.equal(validateFragment('x.md', '[a](README.md#usage-and-pricing)', 'usage-and-pricing', true, readme), null);
  assert.equal(
    validateFragment('x.md', '[a](docs/configuration.md#tunables)', 'tunables', true, configuration),
    'x.md: missing fragment anchor: [a](docs/configuration.md#tunables)',
  );
});

test('DOC-LINK-01: the checker rejects bad fragments in a fixture tree', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'triss-doclinks-'));
  writeFileSync(
    join(fixture, 'TARGET.md'),
    '# Title\n\n## Usage and pricing\n\nbody\n',
  );
  writeFileSync(
    join(fixture, 'DOC.md'),
    [
      '# Title',
      '[bad local](TARGET.md#no-such-anchor)',
      '[bad intra](#missing-section)',
      '[bad github](https://github.com/ayleen/triss-coworker/blob/main/TARGET.md#nope)',
      '[good local](TARGET.md#usage-and-pricing)',
      '[good intra](#title)',
      '[good github](https://github.com/ayleen/triss-coworker/blob/main/TARGET.md#usage-and-pricing)',
    ].join('\n'),
  );
  const { failures } = checkRepositoryDocs(fixture);
  assert.equal(failures.length, 3, `unexpected failures:\n${failures.join('\n')}`);
  assert.ok(failures.every((line) => /missing fragment anchor/.test(line)));
});

test('DOC-LINK-01: headings and anchors inside code samples create no anchors (R05)', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'triss-doclinks-r05-'));
  writeFileSync(
    join(fixture, 'DOC.md'),
    [
      '```md',
      '## Phantom',
      '```',
      '[broken phantom](#phantom)',
      '',
      '```html',
      '<a id="example-only"></a>',
      '```',
      '[broken example-only](#example-only)',
      '',
      '## Real Heading',
      '[real](#real-heading)',
      '',
      '<a id="real-anchor"></a>',
      '[real anchor](#real-anchor)',
    ].join('\n'),
  );
  const { failures } = checkRepositoryDocs(fixture);
  assert.equal(failures.length, 2, `unexpected failures:\n${failures.join('\n')}`);
  assert.ok(failures.every((line) => /#phantom|#example-only/.test(line)));
});

test('DOC-LINK-01: a malformed fragment encoding yields a diagnostic, not a crash', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'triss-doclinks-enc-'));
  writeFileSync(join(fixture, 'README.md'), '# Title\n');
  writeFileSync(join(fixture, 'DOC.md'), '[bad](README.md#%zz)\n');
  const { failures } = checkRepositoryDocs(fixture);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /invalid URL encoding in fragment/);
});

test('DOC-LINK-01: the real repository tree passes fragment validation', () => {
  const { failures } = checkRepositoryDocs(ROOT);
  assert.equal(failures.length, 0, `repository docs have broken fragments:\n${failures.join('\n')}`);
});

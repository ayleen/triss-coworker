import test from 'node:test';
import assert from 'node:assert/strict';

import { extractMarkdownLinkTargets, extractRootDocReferences } from '../scripts/markdown-links.js';

test('extractMarkdownLinkTargets handles local link syntax used by package docs', () => {
  assert.deepEqual(extractMarkdownLinkTargets([
    '[plain](docs/configuration.md#usage)',
    '[angle](<docs/usage accounting.md> "title")',
    '[directory](docs/engines/)',
    '[anchor](#configuration)',
  ].join('\n')), [
    { raw: 'docs/configuration.md#usage', target: 'docs/configuration.md#usage' },
    { raw: '<docs/usage accounting.md> "title"', target: 'docs/usage accounting.md' },
    { raw: 'docs/engines/', target: 'docs/engines/' },
    { raw: '#configuration', target: '#configuration' },
  ]);
});

test('extractMarkdownLinkTargets ignores fenced and inline code examples', () => {
  const source = [
    '`[inline](missing.md)`',
    '```markdown',
    '[fenced](missing.md)',
    '```',
    '[visible](README.md)',
  ].join('\n');
  assert.deepEqual(extractMarkdownLinkTargets(source), [{ raw: 'README.md', target: 'README.md' }]);
});

test('extractMarkdownLinkTargets does not hide later links after an unmatched backtick', () => {
  const source = [
    'An unmatched ` code span opener is literal text.',
    '[broken](docs/missing.md)',
    'A later unmatched ` marker must not consume the intervening line.',
  ].join('\n');
  assert.deepEqual(extractMarkdownLinkTargets(source), [
    { raw: 'docs/missing.md', target: 'docs/missing.md' },
  ]);
});

test('extractMarkdownLinkTargets requires a fence closer at least as long as the opener', () => {
  const source = [
    '````markdown',
    '[hidden-one](docs/hidden-one.md)',
    '```',
    '[hidden-two](docs/hidden-two.md)',
    '````',
    '[visible](README.md)',
  ].join('\n');
  assert.deepEqual(extractMarkdownLinkTargets(source), [
    { raw: 'README.md', target: 'README.md' },
  ]);
});

test('extractMarkdownLinkTargets preserves indented fence compatibility', () => {
  const source = [
    '    ````markdown',
    '[hidden](docs/hidden.md)',
    '    ````',
    '[visible](README.md)',
  ].join('\n');
  assert.deepEqual(extractMarkdownLinkTargets(source), [
    { raw: 'README.md', target: 'README.md' },
  ]);
});

test('extractMarkdownLinkTargets rejects an unterminated angle-bracket target', () => {
  assert.throws(
    () => extractMarkdownLinkTargets('[bad](<docs/configuration.md)'),
    /invalid angle-bracket link target/,
  );
});

test('extractRootDocReferences includes inline code but excludes external URL fragments', () => {
  const source = [
    'Read `docs/missing-inline.md` before continuing.',
    '[local](docs/configuration.md)',
    'Dot-relative: `./docs/dot-relative.md`.',
    '```text',
    'docs/fenced-example.md',
    '```',
    'External: https://github.com/example/repo/blob/main/docs/not-packaged.md',
  ].join('\n');
  assert.deepEqual(extractRootDocReferences(source), [
    'docs/missing-inline.md',
    'docs/configuration.md',
    'docs/dot-relative.md',
  ]);
});

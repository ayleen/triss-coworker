import test from 'node:test';
import assert from 'node:assert/strict';

import { extractMarkdownLinkTargets } from '../scripts/markdown-links.js';

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

test('extractMarkdownLinkTargets rejects an unterminated angle-bracket target', () => {
  assert.throws(
    () => extractMarkdownLinkTargets('[bad](<docs/configuration.md)'),
    /invalid angle-bracket link target/,
  );
});

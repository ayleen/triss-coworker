/**
 * Strict structural validation of the GitHub workflow files. A duplicated
 * mapping key (e.g. two `env:` blocks on one step) is
 * a YAML error that lenient parsers resolve as last-key-wins — silently
 * dropping the first block's variables inside the tag-only publish flow
 * that PR CI never executes. The scanner below is block-scalar-aware, so
 * script bodies (heredocs, shell) never produce false positives, and
 * repeated keys across different sequence items (every step has `name:`)
 * are correctly scoped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = new URL('..', import.meta.url).pathname;
const workflowsDir = join(repoRoot, '.github', 'workflows');

/**
 * Returns every duplicated YAML block-mapping key as { line, indent, key }.
 * Handles: comments, block scalars (`key: |` / `key: >`), sequence items
 * (each `- ` item opens a fresh mapping scope). Anything else is treated
 * conservatively: a line that does not look like `key:` is ignored.
 */
export function findDuplicateKeys(text) {
  const duplicates = [];
  const scopes = []; // stack of { indent, keys: Set<string> }
  const openScope = (indent, { fresh = false } = {}) => {
    while (scopes.length > 0
      && (scopes[scopes.length - 1].indent > indent
        || (fresh && scopes[scopes.length - 1].indent === indent))) scopes.pop();
    if (scopes.length === 0 || scopes[scopes.length - 1].indent !== indent) {
      scopes.push({ indent, keys: new Set() });
    }
  };
  const seen = (indent, key) => {
    const scope = scopes[scopes.length - 1];
    if (!scope || scope.indent !== indent) return false;
    if (scope.keys.has(key)) return true;
    scope.keys.add(key);
    return false;
  };

  const lines = text.split('\n');
  let blockScalarIndent = null;
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (blockScalarIndent !== null) {
      if (indent > blockScalarIndent) continue; // scalar body
      blockScalarIndent = null; // scalar ended; fall through and process
    }
    if (trimmed.startsWith('- ')) {
      // Every sequence item opens a FRESH mapping scope at indent + 2 —
      // repeated `name:`/`uses:` keys across items are not duplicates.
      openScope(indent + 2, { fresh: true });
      const rest = trimmed.slice(2);
      const keyMatch = /^([^\s:]+):(\s|$)/.exec(rest);
      if (keyMatch && seen(indent + 2, keyMatch[1])) {
        duplicates.push({ line: i + 1, indent, key: keyMatch[1] });
      }
      if (/^[^\s:]+:\s*[|>][+-]?\s*$/.test(rest)) blockScalarIndent = indent + 2;
      continue;
    }
    const keyMatch = /^([^\s:]+):(\s|$)/.exec(trimmed);
    if (!keyMatch) continue;
    openScope(indent);
    if (seen(indent, keyMatch[1])) {
      duplicates.push({ line: i + 1, indent, key: keyMatch[1] });
    }
    if (new RegExp(`^${keyMatch[1]}:\\s*[|>][+-]?\\s*$`).test(trimmed)) {
      blockScalarIndent = indent;
    }
  }
  return duplicates;
}

test('duplicate-key scanner flags duplicated env and ignores scalar bodies', () => {
  const duplicated = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - name: x',
    '        env:',
    '          A: 1',
    '        run: |',
    '          echo hi',
    '        env:',
    '          B: 2',
  ].join('\n');
  const found = findDuplicateKeys(duplicated);
  assert.equal(found.length, 1);
  assert.equal(found[0].key, 'env');

  const scalarSafe = [
    'steps:',
    '  - name: a',
    '    run: |',
    '      nested: |',
    '        env:',
    '          env:',
    '  - name: b',
    '    run: |',
    '      key: value',
  ].join('\n');
  assert.deepEqual(findDuplicateKeys(scalarSafe), [],
    'heredoc/script bodies and repeated keys across sequence items are not duplicates');
});

test('every workflow file parses without duplicated mapping keys', () => {
  for (const file of readdirSync(workflowsDir).filter((f) => f.endsWith('.yml'))) {
    const text = readFileSync(join(workflowsDir, file), 'utf8');
    const duplicates = findDuplicateKeys(text);
    assert.deepEqual(
      duplicates.map((d) => `${file}:${d.line} duplicated key "${d.key}"`),
      [],
      `workflow files must not carry duplicated YAML keys`,
    );
  }
});

test('every external workflow action is pinned to an immutable commit', () => {
  const floating = [];
  for (const file of readdirSync(workflowsDir).filter((name) => name.endsWith('.yml'))) {
    const text = readFileSync(join(workflowsDir, file), 'utf8');
    for (const match of text.matchAll(/\buses:\s*([^\s#]+)@([^\s#]+)/g)) {
      const [, action, ref] = match;
      if (!action.startsWith('./') && !/^[0-9a-f]{40}$/.test(ref)) {
        floating.push(`${file}: ${action}@${ref}`);
      }
    }
  }
  assert.deepEqual(floating, [], 'third-party actions must not follow mutable tags or branches');
});

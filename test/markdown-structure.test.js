// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Contract for the shared Markdown block scanner (review V02): fenced code
// follows the CommonMark opener grammar (optional space before the info
// string, multi-word info strings, tilde and backtick alike), closers match
// by fence character and length, indented code is not structure, and HTML
// comments — single-line or spanning lines — never leak into visible text.

import test from 'node:test';
import assert from 'node:assert/strict';
import { annotateMarkdownLines } from '../scripts/markdown-links.js';

function visibleText(source) {
  return annotateMarkdownLines(source)
    .filter((record) => record.kind === 'text')
    .map((record) => record.visible);
}

test('V02: a fence with a space before the info string is still a fence', () => {
  const records = annotateMarkdownLines('``` markdown\n## [9.9.9]\n```');
  assert.deepEqual(records.map((record) => record.kind), ['fence-open', 'fence-body', 'fence-end']);
  assert.deepEqual(visibleText('``` markdown\n## Fixed\n- x\n```'), [], 'fence content yields no text records');
});

test('V02: multi-word info strings are part of the fence opener', () => {
  const records = annotateMarkdownLines('```markdown title=example\n### Fixed\n```');
  assert.equal(records[0].kind, 'fence-open');
  assert.equal(records[1].kind, 'fence-body');
});

test('V02: tilde fences accept any info string and only close on a matching tilde run', () => {
  const records = annotateMarkdownLines('~~~ markdown\n```md\ninner\n```\n~~~\nafter');
  assert.deepEqual(
    records.map((record) => record.kind),
    ['fence-open', 'fence-body', 'fence-body', 'fence-body', 'fence-end', 'text'],
  );
  assert.equal(records[5].visible, 'after');
});

test('V02: a backtick fence info string containing a backtick is not a fence opener', () => {
  // CommonMark: the info string of a backtick fence cannot contain ` — the
  // line is ordinary paragraph text, not the start of a code block.
  const records = annotateMarkdownLines('```md `code`\ntext\n');
  assert.equal(records[0].kind, 'text');
  assert.equal(records[1].kind, 'text');
});

test('V02: indented code is not structure', () => {
  const records = annotateMarkdownLines('    ### Fixed\n\n\t- Example only.');
  assert.deepEqual(records.map((record) => record.kind), ['indented-code', 'text', 'indented-code']);
  assert.deepEqual(visibleText('    ### Fixed'), [], 'indented code yields no text records');
});

test('V02: single-line and multi-line HTML comments never leak into visible text', () => {
  assert.deepEqual(
    visibleText('- Fixed the lexer. <!-- internal note -->'),
    ['- Fixed the lexer. '],
  );
  const multi = annotateMarkdownLines('- Fixed. <!-- note\nstill a comment\n--> after\nplain');
  assert.deepEqual(multi.map((record) => record.kind), ['text', 'comment', 'comment', 'text']);
  assert.equal(multi[0].visible, '- Fixed. ');
  assert.equal(multi[3].visible, 'plain');
});

test('V02: comment markers inside code regions are code text, not comments', () => {
  const records = annotateMarkdownLines('```md\n<!-- not a comment -->\n```');
  assert.deepEqual(records.map((record) => record.kind), ['fence-open', 'fence-body', 'fence-end']);
});

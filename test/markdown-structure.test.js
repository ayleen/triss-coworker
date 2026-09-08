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

// G02 fixtures (review round 4): an HTML comment can only start OUTSIDE an
// inline code span. `<!--` inside backticks is visible literal text — it
// must not open a comment state that hides the headings after it, and the
// code-span content must stay visible.

test('G02: `<!--` inside a code span is literal text, not a comment opener', () => {
  const line = 'Parser now preserves the `<!--` token.';
  const records = annotateMarkdownLines(line);
  assert.equal(records[0].kind, 'text');
  assert.equal(records[0].visible, line, 'the code span and its content must stay visible');
  // No comment state may leak: the next heading stays structural.
  const followUp = annotateMarkdownLines(`${line}\n## [9.9.9]`);
  assert.equal(followUp[1].kind, 'text');
  assert.equal(followUp[1].visible, '## [9.9.9]');
});

test('G02: a real comment after a code span is still stripped, span content kept', () => {
  const records = annotateMarkdownLines('- Keep `<!--` visible. <!-- internal note -->');
  assert.equal(records[0].kind, 'text');
  assert.equal(records[0].visible, '- Keep `<!--` visible. ');
});

test('G02: a code span closes only on a backtick run of the same length', () => {
  const records = annotateMarkdownLines('a ``<!--`` b <!-- note -->');
  assert.equal(records[0].visible, 'a ``<!--`` b ', 'a single backtick must not close a two-backtick span');
});

test('G02: an escaped `<!--` is literal text', () => {
  const line = String.raw`before \<!-- not a comment`;
  const records = annotateMarkdownLines(line);
  assert.equal(records[0].visible, line);
  const followUp = annotateMarkdownLines(`${line}\n## [9.9.8]`);
  assert.equal(followUp[1].visible, '## [9.9.8]');
});

test('G02: an unclosed code-span run hides nothing', () => {
  const line = 'text `<!-- more';
  const records = annotateMarkdownLines(line);
  assert.equal(records[0].kind, 'text');
  assert.equal(records[0].visible, line, 'an unclosed delimiter run stays literal text');
  const followUp = annotateMarkdownLines(`${line}\n## [9.9.7]`);
  assert.equal(followUp[1].visible, '## [9.9.7]');
});

test('G02: a real multi-line comment still swallows code-span-looking lines', () => {
  const records = annotateMarkdownLines('<!-- note\n`<!--` inside a comment\n--> after');
  // The opening line keeps kind 'text' with empty visible output (nothing of
  // it renders); the rest of the comment — including the code-span-looking
  // line — is comment-only.
  assert.deepEqual(records.map((record) => record.kind), ['text', 'comment', 'comment']);
  assert.equal(records[0].visible, '');
});

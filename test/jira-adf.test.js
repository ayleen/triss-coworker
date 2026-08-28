// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { adfToText, textToAdf } from '../src/integrations/jira/adf.js';

test('adfToText handles paragraphs, headings, and lists', () => {
  const adf = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello world.' }] },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
        ],
      },
    ],
  };
  const out = adfToText(adf);
  assert.match(out, /## Title/);
  assert.match(out, /Hello world\./);
  assert.match(out, /- one/);
  assert.match(out, /- two/);
});

test('adfToText handles inline marks', () => {
  const adf = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'bold', marks: [{ type: 'strong' }] },
          { type: 'text', text: ' and ' },
          { type: 'text', text: 'code', marks: [{ type: 'code' }] },
        ],
      },
    ],
  };
  assert.match(adfToText(adf), /\*\*bold\*\* and `code`/);
});

test('textToAdf splits on blank lines into paragraphs', () => {
  const adf = textToAdf('first paragraph\n\nsecond paragraph');
  assert.equal(adf.type, 'doc');
  assert.equal(adf.content.length, 2);
  assert.equal(adf.content[0].content[0].text, 'first paragraph');
  assert.equal(adf.content[1].content[0].text, 'second paragraph');
});

test('textToAdf preserves single newlines as hardBreaks within a paragraph', () => {
  const adf = textToAdf('line one\nline two');
  assert.equal(adf.content.length, 1);
  const para = adf.content[0];
  const types = para.content.map((c) => c.type);
  assert.deepEqual(types, ['text', 'hardBreak', 'text']);
});

test('textToAdf accepts empty input', () => {
  const adf = textToAdf('');
  assert.equal(adf.type, 'doc');
  assert.equal(adf.content.length, 1);
  assert.equal(adf.content[0].type, 'paragraph');
});

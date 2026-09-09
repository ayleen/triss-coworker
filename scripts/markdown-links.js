// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

const LINK_PATTERN = /\[[^\]]*\]\(([^)]+)\)/g;
const ROOT_DOC_REFERENCE_PATTERN = /(?<![A-Za-z0-9_./:-])(?:\.\/)?(docs\/[A-Za-z0-9._/-]+\.md)\b/gu;

// CommonMark-aware block annotation shared by this module and
// release-notes.js (review V02). Fenced code blocks recognize the full
// opener grammar — optional 0-3 space indent, any info string (a backtick
// fence's info string just may not contain a backtick) — and match closers
// by fence character and length. Lines indented 4 spaces or a tab are
// indented code, not structure. HTML comments are stripped from visible
// text across line boundaries — but only OUTSIDE inline code spans (review
// G02): `<!--` inside backticks is literal visible text and never opens a
// comment state that would hide the headings after it. A code span lives in
// its inline container — the paragraph — not in a physical line (review
// H02): an opener run of N backticks is closed by the next run of exactly N
// backticks on a later line of the SAME paragraph, its content stays
// visible and literal, and a span still unclosed at a real block boundary
// (blank line, heading, fence, indented code, comment block) is abandoned
// there — it is never an excuse to hide what follows. Backslash-escaped
// punctuation cannot open a span or a comment. A line-initial `<!--` comment
// block keeps block precedence over a carried span opener. Text inside code
// regions or comments never yields headings, list entries, anchors, or
// further comments.
//
// Records: { number, raw, kind, visible } with kind one of 'fence-open',
// 'fence-body', 'fence-end', 'indented-code', 'comment', 'text'. `visible`
// carries the renderable text of 'text' lines (HTML comment spans removed)
// and is empty for everything else.
export function annotateMarkdownLines(source) {
  const records = [];
  let fence = null; // { char, length }
  let inComment = false;
  const inline = createInlineScanner();
  source.split('\n').forEach((raw, index) => {
    const record = { number: index, raw, kind: 'text', visible: '' };
    if (fence) {
      const closer = raw.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (closer && closer[1][0] === fence.char && closer[1].length >= fence.length) {
        record.kind = 'fence-end';
        fence = null;
      } else {
        record.kind = 'fence-body';
      }
      records.push(record);
      return;
    }
    if (inComment) {
      record.kind = 'comment';
      if (raw.includes('-->')) inComment = false;
      inline.endParagraph();
      records.push(record);
      return;
    }
    const opener = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opener && (opener[1][0] !== '`' || !opener[2].includes('`'))) {
      record.kind = 'fence-open';
      fence = { char: opener[1][0], length: opener[1].length };
      inline.endParagraph();
      records.push(record);
      return;
    }
    if (/^(?: {4}|\t)/.test(raw)) {
      record.kind = 'indented-code';
      inline.endParagraph();
      records.push(record);
      return;
    }
    // Blank lines and ATX headings end the inline container, so a span
    // opened on a previous line never leaks across them (review H02).
    if (!raw.trim() || /^ {0,3}#{1,6}(?:\s|$)/.test(raw)) inline.endParagraph();
    record.visible = inline.scan(raw, () => {
      inComment = true;
    });
    records.push(record);
  });
  return records;
}

// CommonMark ASCII punctuation, for backslash-escape handling.
const ASCII_PUNCTUATION = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;

// Index just past the first backtick run of exactly `length` backticks at or
// after `from`, or -1. Runs of other lengths neither close nor block.
function backtickRunCloser(raw, from, length) {
  let probe = from;
  while (probe < raw.length) {
    if (raw[probe] !== '`') {
      probe += 1;
      continue;
    }
    let run = probe;
    while (raw[run] === '`') run += 1;
    if (run - probe === length) return run;
    probe = run;
  }
  return -1;
}

// Stateful inline scanner for paragraph text (review H02): unlike a
// line-at-a-time pass, a code span opened on one line stays open across the
// wrapped lines of the SAME paragraph, and `<!--` reached while the span is
// open is literal span content that never opens a comment state. The caller
// decides where the paragraph ends (blank line, heading, fence, indented
// code, comment block) and calls endParagraph() — an opener abandoned there
// rendered as literal backticks in the source, never as a reason to hide
// what follows.
function createInlineScanner() {
  let openSpan = 0; // backtick-run length still open from a previous line
  return {
    endParagraph() {
      openSpan = 0;
    },
    // Returns the visible text of one physical line; onComment() fires when
    // an HTML comment stays open at end of line.
    scan(raw, onComment) {
      // Block precedence: a comment block opening at line start interrupts
      // the paragraph, even mid-span.
      if (openSpan > 0 && /^ {0,3}<!--/.test(raw)) openSpan = 0;
      let out = '';
      let cursor = 0;
      if (openSpan > 0) {
        const closer = backtickRunCloser(raw, 0, openSpan);
        if (closer === -1) {
          // The whole line is inside the span: literal, visible, and no
          // comment recognition — a `<!--` here cannot hide anything.
          return raw;
        }
        out = raw.slice(0, closer);
        cursor = closer;
        openSpan = 0;
      }
      for (;;) {
        const char = raw[cursor];
        if (char === undefined) return out;
        if (char === '\\') {
          const next = raw[cursor + 1];
          if (next !== undefined && ASCII_PUNCTUATION.test(next)) {
            out += raw.slice(cursor, cursor + 2); // escaped punctuation is literal
            cursor += 2;
          } else {
            out += char;
            cursor += 1;
          }
          continue;
        }
        if (char === '`') {
          let runEnd = cursor;
          while (raw[runEnd] === '`') runEnd += 1;
          const length = runEnd - cursor;
          const closer = backtickRunCloser(raw, runEnd, length);
          if (closer !== -1) {
            out += raw.slice(cursor, closer); // the whole span, content included
            cursor = closer;
          } else {
            // Unclosed run: the rest of the line is span content — literal,
            // visible, no comment recognition — and stays open into the next
            // paragraph line (review H02).
            openSpan = length;
            out += raw.slice(cursor);
            cursor = raw.length;
          }
          continue;
        }
        if (char === '<' && raw.startsWith('<!--', cursor)) {
          const end = raw.indexOf('-->', cursor + 4);
          if (end === -1) {
            onComment();
            return out;
          }
          cursor = end + 3;
          continue;
        }
        out += char;
        cursor += 1;
      }
    },
  };
}

export function withoutFencedCode(source) {
  let fence = null;
  const visible = [];
  for (const line of source.split('\n')) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1] || null;
    if (!fence && marker) {
      fence = { character: marker[0], length: marker.length };
      visible.push('');
      continue;
    }
    if (fence) {
      const closer = line.match(/^\s*(`+|~+)\s*$/)?.[1] || null;
      if (closer && closer[0] === fence.character && closer.length >= fence.length) fence = null;
      visible.push('');
      continue;
    }
    visible.push(line);
  }
  return visible.join('\n');
}

export function withoutCode(source) {
  return withoutFencedCode(source).split('\n').map(withoutInlineCode).join('\n');
}

function withoutInlineCode(line) {
  let output = '';
  let cursor = 0;
  while (cursor < line.length) {
    if (line[cursor] !== '`') {
      output += line[cursor++];
      continue;
    }
    let openerEnd = cursor;
    while (line[openerEnd] === '`') openerEnd += 1;
    const length = openerEnd - cursor;
    let candidate = openerEnd;
    let closerEnd = -1;
    while (candidate < line.length) {
      if (line[candidate] !== '`') {
        candidate += 1;
        continue;
      }
      let runEnd = candidate;
      while (line[runEnd] === '`') runEnd += 1;
      if (runEnd - candidate === length) {
        closerEnd = runEnd;
        break;
      }
      candidate = runEnd;
    }
    if (closerEnd === -1) {
      output += line.slice(cursor, openerEnd);
      cursor = openerEnd;
      continue;
    }
    cursor = closerEnd;
  }
  return output;
}

export function extractMarkdownLinkTargets(source) {
  const targets = [];
  for (const match of withoutCode(source).matchAll(LINK_PATTERN)) {
    const raw = match[1];
    let target = raw.trim();
    if (target.startsWith('<')) {
      const end = target.indexOf('>');
      if (end === -1) throw new Error(`invalid angle-bracket link target: ${raw}`);
      target = target.slice(1, end);
    } else {
      target = target.split(/\s+/, 1)[0];
    }
    targets.push({ raw, target });
  }
  return targets;
}

// Unlike Markdown links, root-relative doc references inside inline code are
// user-facing installation guidance too. Keep them visible to package gates;
// exclude only path fragments embedded in external URLs.
export function extractRootDocReferences(source) {
  return [...withoutFencedCode(source).matchAll(ROOT_DOC_REFERENCE_PATTERN)].map((match) => match[1]);
}

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
// text across line boundaries; code regions are never touched. Text inside
// code or comments never yields headings, list entries, anchors, or
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
      records.push(record);
      return;
    }
    const opener = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opener && (opener[1][0] !== '`' || !opener[2].includes('`'))) {
      record.kind = 'fence-open';
      fence = { char: opener[1][0], length: opener[1].length };
      records.push(record);
      return;
    }
    if (/^(?: {4}|\t)/.test(raw)) {
      record.kind = 'indented-code';
      records.push(record);
      return;
    }
    let out = '';
    let cursor = 0;
    for (;;) {
      if (inComment) {
        const end = raw.indexOf('-->', cursor);
        if (end === -1) break;
        cursor = end + 3;
        inComment = false;
        continue;
      }
      const start = raw.indexOf('<!--', cursor);
      if (start === -1) {
        out += raw.slice(cursor);
        break;
      }
      out += raw.slice(cursor, start);
      const end = raw.indexOf('-->', start + 4);
      if (end === -1) {
        inComment = true;
        break;
      }
      cursor = end + 3;
    }
    record.visible = out;
    records.push(record);
  });
  return records;
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

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

const LINK_PATTERN = /\[[^\]]*\]\(([^)]+)\)/g;
const ROOT_DOC_REFERENCE_PATTERN = /(?<![A-Za-z0-9_./:-])(?:\.\/)?(docs\/[A-Za-z0-9._/-]+\.md)\b/gu;

function withoutFencedCode(source) {
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

function withoutCode(source) {
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

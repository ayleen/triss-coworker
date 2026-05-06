import { globSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertSafePath } from './safety.js';

export function expandPaths(inputs) {
  const seen = new Set();
  const out = [];
  for (const raw of inputs) {
    const matches = looksLikeGlob(raw) ? globSync(raw, { nodir: true }) : [raw];
    const list = matches.length ? matches : [raw];
    for (const m of list) {
      const abs = resolve(m);
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push(m);
    }
  }
  return out;
}

function looksLikeGlob(p) {
  return /[*?[\]{}]/.test(p);
}

// Avoid breaking the <file>…</file> framing if a source file literally
// contains the closing tag. Single-character escape — model still reads
// it as the same string.
function escapeFileFraming(s) {
  return s.replace(/<\/file>/gi, '<\\/file>');
}

// Heuristic: a binary file usually has a NUL byte in the first few KB.
function isLikelyBinary(buf) {
  const window = Math.min(buf.length, 8 * 1024);
  for (let i = 0; i < window; i++) if (buf[i] === 0) return true;
  return false;
}

export function readFilesAsCorpus(paths) {
  const docs = [];
  let totalBytes = 0;
  let skipped = 0;
  for (const p of paths) {
    try {
      assertSafePath(p, { kind: 'read' });
    } catch (err) {
      docs.push(`<file path='${p}' error='${escapeAttr(err.message.split('\n')[0])}' />`);
      skipped++;
      continue;
    }
    let stat;
    try {
      stat = statSync(p);
    } catch {
      docs.push(`<file path='${p}' error='not found' />`);
      continue;
    }
    if (stat.isDirectory()) {
      docs.push(`<file path='${p}' error='is a directory' />`);
      continue;
    }
    const buf = readFileSync(p);
    if (isLikelyBinary(buf)) {
      docs.push(
        `<file path='${p}' error='binary file (${stat.size} bytes), skipped' />`,
      );
      skipped++;
      continue;
    }
    const content = escapeFileFraming(buf.toString('utf8'));
    totalBytes += content.length;
    docs.push(`<file path='${p}'>\n${content}\n</file>`);
  }
  return {
    corpus: docs.join('\n\n'),
    totalBytes,
    fileCount: paths.length,
    skipped,
  };
}

function escapeAttr(s) {
  return String(s).replace(/'/g, '&apos;').replace(/</g, '&lt;');
}

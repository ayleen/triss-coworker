import { globSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

export function readFilesAsCorpus(paths) {
  const docs = [];
  let totalBytes = 0;
  for (const p of paths) {
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
    const content = readFileSync(p, 'utf8');
    totalBytes += content.length;
    docs.push(`<file path='${p}'>\n${content}\n</file>`);
  }
  return { corpus: docs.join('\n\n'), totalBytes, fileCount: paths.length };
}

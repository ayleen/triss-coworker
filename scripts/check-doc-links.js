#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { extractMarkdownLinkTargets } from './markdown-links.js';

const root = resolve('.');
const files = [];

function visit(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.codex' || entry.name === '.claude') continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) visit(child);
    else if (entry.name.endsWith('.md')) files.push(child);
  }
}

visit(root);
const failures = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  let links;
  try {
    links = extractMarkdownLinkTargets(text);
  } catch (error) {
    failures.push(`${file}: ${error.message}`);
    continue;
  }
  for (const link of links) {
    let { target } = link;
    if (!target || target.startsWith('#') || /^(?:https?:|mailto:)/i.test(target)) continue;
    target = target.split('#', 1)[0];
    try {
      target = decodeURIComponent(target);
    } catch {
      failures.push(`${file}: invalid URL encoding in ${link.raw}`);
      continue;
    }
    const resolved = resolve(dirname(file), target);
    if (!resolved.startsWith(`${root}${sep}`) && resolved !== root) {
      failures.push(`${file}: link escapes repository: ${link.raw}`);
    } else if (!existsSync(resolved)) {
      failures.push(`${file}: missing link target: ${link.raw}`);
    } else {
      statSync(resolved);
    }
  }
}

if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`documentation links valid across ${files.length} Markdown files\n`);

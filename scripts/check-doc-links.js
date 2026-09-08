#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractMarkdownLinkTargets, withoutCode } from './markdown-links.js';

const GITHUB_FILE_URL = /^https?:\/\/github\.com\/ayleen\/triss-coworker\/(?:blob|tree)\/[^/]+\/(.+?)(?:#.+)?$/i;
const DEFAULT_SKIP_DIRS = new Set(['.git', 'node_modules', '.codex', '.claude', 'dist', '.wrangler']);

function collectMarkdownFiles(root, skipDirs = DEFAULT_SKIP_DIRS) {
  const files = [];
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (skipDirs.has(entry.name)) continue;
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.name.endsWith('.md')) files.push(child);
    }
  };
  visit(root);
  return files;
}

// GitHub-style heading slug: lowercase, drop anything that is not a letter,
// number, mark, hyphen, or space; spaces become hyphens. Backticks and
// emphasis markers are stripped before slugging so inline code and bold text
// slug like GitHub does.
export function githubSlug(headingText) {
  const cleaned = headingText
    .replace(/[`*]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s-]/gu, '')
    .replace(/\s/g, '-');
  return cleaned;
}

// Collect every fragment a Markdown file can receive: GitHub-style heading
// slugs (with -1/-2 suffixes on duplicates) plus explicit HTML anchors
// (<a id="...">, <a name="...">, id="..." on any element). Headings and HTML
// attributes inside fenced code, inline code, and HTML comments do NOT
// create anchors — a code sample showing `## Phantom` syntax must not
// validate a link to #phantom (review R05).
export function headingFragments(source) {
  const fragments = new Set();
  const seen = new Map();
  const visible = withoutCode(stripHtmlComments(source));
  for (const line of visible.split('\n')) {
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      const base = githubSlug(heading[2].replace(/\s+#+\s*$/, ''));
      if (!base) continue;
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      fragments.add(count === 0 ? base : `${base}-${count}`);
    }
  }
  for (const match of visible.matchAll(/\b(?:id|name)="([^"]+)"/g)) {
    fragments.add(match[1]);
  }
  return fragments;
}

function stripHtmlComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, ''));
}

export function validateFragment(fileLabel, raw, fragment, targetExists, targetFragments) {
  if (!targetExists) {
    return `${fileLabel}: missing link target: ${raw}`;
  }
  if (!targetFragments.has(fragment)) {
    return `${fileLabel}: missing fragment anchor: ${raw}`;
  }
  return null;
}

function safeFragmentDecode(fileLabel, raw, fragment) {
  try {
    return { decoded: decodeURIComponent(fragment) };
  } catch {
    return { error: `${fileLabel}: invalid URL encoding in fragment of ${raw}` };
  }
}

function resolveLocalTarget(file, rawTarget, root) {
  const [pathPart, fragment] = rawTarget.split('#', 2);
  if (!pathPart) {
    // intra-page fragment
    return { path: file, fragment, intraPage: true };
  }
  let decoded;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return { error: `${file}: invalid URL encoding in ${rawTarget}` };
  }
  const resolved = resolve(dirname(file), decoded);
  if (!resolved.startsWith(`${root}${sep}`) && resolved !== root) {
    return { error: `${file}: link escapes repository: ${rawTarget}` };
  }
  return { path: resolved, fragment, intraPage: false };
}

export function checkRepositoryDocs(root) {
  const files = collectMarkdownFiles(root);
  const fragmentCache = new Map();

  const fragmentsFor = (path) => {
    if (!fragmentCache.has(path)) {
      fragmentCache.set(
        path,
        existsSync(path) && statSync(path).isFile()
          ? headingFragments(readFileSync(path, 'utf8'))
          : null,
      );
    }
    return fragmentCache.get(path);
  };

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
      const { target } = link;
      if (!target || /^(?:https?:|mailto:)/i.test(target)) {
        // Same-repository GitHub URLs are checked against the working tree so
        // a renamed heading inside the repo is caught even when the file path
        // still exists. Other external URLs stay out of scope for this
        // offline check.
        const githubMatch = target?.match(GITHUB_FILE_URL);
        if (!githubMatch) continue;
        const localPath = join(root, ...githubMatch[1].split('/'));
        const fragment = target.includes('#') ? target.split('#')[1] : undefined;
        if (fragment && githubMatch[1].endsWith('.md')) {
          const decoded = safeFragmentDecode(file, link.raw, fragment);
          if (decoded.error) {
            failures.push(decoded.error);
            continue;
          }
          const failure = validateFragment(
            file,
            link.raw,
            decoded.decoded,
            fragmentsFor(localPath) !== null,
            fragmentsFor(localPath) ?? new Set(),
          );
          if (failure) failures.push(failure);
        } else if (!existsSync(localPath) && githubMatch[1].endsWith('.md')) {
          failures.push(`${file}: missing same-repository GitHub target: ${link.raw}`);
        }
        continue;
      }
      if (target.startsWith('#')) {
        const failure = validateFragment(file, link.raw, target.slice(1), true, fragmentsFor(file) ?? new Set());
        if (failure) failures.push(failure);
        continue;
      }
      const outcome = resolveLocalTarget(file, target, root);
      if (outcome.error) {
        failures.push(outcome.error);
        continue;
      }
      const { path: targetPath, fragment } = outcome;
      if (!existsSync(targetPath)) {
        failures.push(`${file}: missing link target: ${link.raw}`);
        continue;
      }
      const stat = statSync(targetPath);
      if (!stat.isFile() && !stat.isDirectory()) {
        failures.push(`${file}: link target is not a regular file or directory: ${link.raw}`);
        continue;
      }
      if (fragment && stat.isFile()) {
        const decoded = safeFragmentDecode(file, link.raw, fragment);
        if (decoded.error) {
          failures.push(decoded.error);
          continue;
        }
        const failure = validateFragment(
          file,
          link.raw,
          decoded.decoded,
          true,
          fragmentsFor(targetPath) ?? new Set(),
        );
        if (failure) failures.push(failure);
      }
    }
  }
  return { failures, fileCount: files.length };
}

export function checkRepoRoot() {
  // Resolve the repository root from this script's location so behavior is
  // identical no matter the caller's cwd.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function main() {
  // CLI behavior stays cwd-driven so the checker can validate any Markdown
  // tree (tests run it against fixture trees); library callers pass an
  // explicit root to checkRepositoryDocs.
  const root = resolve(process.cwd());
  const { failures, fileCount } = checkRepositoryDocs(root);
  if (failures.length) {
    process.stderr.write(`${failures.join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`documentation links and fragments valid across ${fileCount} Markdown files\n`);
}

if (process.argv[1] && relative(process.argv[1], fileURLToPath(import.meta.url)) === '') {
  main();
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { globSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertSafePath } from './safety.js';

const DEFAULT_FILE_MAX_BYTES = 1 * 1024 * 1024;        // 1 MB per file
const DEFAULT_CORPUS_MAX_BYTES = 16 * 1024 * 1024;     // 16 MB total
const DEFAULT_GLOB_MAX_FILES = 500;                    // safety net for **/*

function envInt(name, def) {
  const raw = process.env[name];
  if (!raw) return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function fileMaxBytes() { return envInt('TRISS_FILE_MAX_BYTES', DEFAULT_FILE_MAX_BYTES); }
function corpusMaxBytes() { return envInt('TRISS_CORPUS_MAX_BYTES', DEFAULT_CORPUS_MAX_BYTES); }
function globMaxFiles() { return envInt('TRISS_GLOB_MAX_FILES', DEFAULT_GLOB_MAX_FILES); }

export function expandPaths(inputs) {
  const seen = new Set();
  const out = [];
  const cap = globMaxFiles();
  let truncated = false;
  outer: for (const raw of inputs) {
    const matches = looksLikeGlob(raw) ? globSync(raw, { nodir: true }) : [raw];
    const list = matches.length ? matches : [raw];
    for (const m of list) {
      const abs = resolve(m);
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push(m);
      if (out.length >= cap) {
        truncated = true;
        break outer;
      }
    }
  }
  if (truncated) {
    process.stderr.write(
      `[triss/paths] glob expansion capped at ${cap} files ` +
        `(set TRISS_GLOB_MAX_FILES to override)\n`,
    );
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

// Read at most `limit` bytes — sniffs binary on the first chunk and
// bails before allocating the rest. Returns { buf, full } where
// `full=false` means the file was bigger than the limit and `buf`
// contains the first `limit` bytes only (we don't use it in that case
// — we report the file as skipped — but keeping the API future-proof).
function readUpTo(path, limit) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(limit);
    const read = readSync(fd, buf, 0, limit, 0);
    return { buf: buf.subarray(0, read), reachedLimit: read === limit };
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

export function readFilesAsCorpus(paths) {
  const docs = [];
  const fileLimit = fileMaxBytes();
  const corpusLimit = corpusMaxBytes();
  let totalBytes = 0;
  let skipped = 0;
  for (const p of paths) {
    if (totalBytes >= corpusLimit) {
      // Stop once the cumulative cap is hit — emit a marker so the
      // caller (and the model) sees the corpus is truncated.
      docs.push(
        `<file path='${escapeAttr(p)}' error='corpus cap reached (${corpusLimit} bytes), remaining files skipped' />`,
      );
      skipped++;
      continue;
    }
    try {
      assertSafePath(p, { kind: 'read' });
    } catch (err) {
      docs.push(`<file path='${escapeAttr(p)}' error='${escapeAttr(err.message.split('\n')[0])}' />`);
      skipped++;
      continue;
    }
    let stat;
    try {
      stat = statSync(p);
    } catch {
      docs.push(`<file path='${escapeAttr(p)}' error='not found' />`);
      continue;
    }
    if (stat.isDirectory()) {
      docs.push(`<file path='${escapeAttr(p)}' error='is a directory' />`);
      continue;
    }
    if (stat.size > fileLimit) {
      docs.push(
        `<file path='${escapeAttr(p)}' error='too large (${stat.size} bytes > ${fileLimit} cap), skipped — set TRISS_FILE_MAX_BYTES to override' />`,
      );
      skipped++;
      continue;
    }
    let buf;
    try {
      ({ buf } = readUpTo(p, fileLimit));
    } catch (err) {
      docs.push(`<file path='${escapeAttr(p)}' error='${escapeAttr(err.message)}' />`);
      skipped++;
      continue;
    }
    if (isLikelyBinary(buf)) {
      docs.push(
        `<file path='${escapeAttr(p)}' error='binary file (${stat.size} bytes), skipped' />`,
      );
      skipped++;
      continue;
    }
    const content = escapeFileFraming(buf.toString('utf8'));
    if (totalBytes + content.length > corpusLimit) {
      const remaining = Math.max(0, corpusLimit - totalBytes);
      const truncated = content.slice(0, remaining);
      docs.push(
        `<file path='${escapeAttr(p)}' truncated='true'>\n${truncated}\n</file>`,
      );
      totalBytes += truncated.length;
      skipped++;
      continue;
    }
    totalBytes += content.length;
    docs.push(`<file path='${escapeAttr(p)}'>\n${content}\n</file>`);
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

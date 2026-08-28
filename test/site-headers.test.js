// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Gate for the security headers served by the site (site/public/_headers,
// applied by Cloudflare Workers Static Assets). The OpenSSF hardened_site
// criterion requires non-permissive values, so this parses the CSP into
// directives instead of substring-matching.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseHeadersFile(text) {
  const headers = {};
  let currentPath = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line || line.trim().startsWith('#')) continue;
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      currentPath = line.trim();
      headers[currentPath] = [];
    } else if (currentPath) {
      const sep = line.indexOf(':');
      assert.notEqual(sep, -1, `malformed header line: ${raw}`);
      const name = line.slice(0, sep).trim().toLowerCase();
      const value = line.slice(sep + 1).trim();
      headers[currentPath].push([name, value]);
    }
  }
  return headers;
}

function cspDirectives(headers) {
  const csp = headers['/*'].find(([n]) => n === 'content-security-policy');
  assert.ok(csp, 'CSP header must exist for /*');
  const directives = {};
  for (const part of csp[1].split(';')) {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    if (bits.length) directives[bits[0]] = bits.slice(1);
  }
  return directives;
}

function getHeader(headers, name) {
  return headers['/*'].find(([n]) => n === name);
}

test('headers: CSP forbids inline scripts and inline event handlers', () => {
  const headers = parseHeadersFile(readFileSync(join(ROOT, 'site/public/_headers'), 'utf8'));
  const d = cspDirectives(headers);
  assert.ok(d['script-src'], 'script-src directive required');
  assert.ok(!d['script-src'].includes("'unsafe-inline'"), 'script-src must not allow unsafe-inline');
  assert.ok(!d['script-src'].includes("'unsafe-eval'"), 'script-src must not allow unsafe-eval');
  assert.ok(d['script-src'].includes("'self'"));
  assert.deepEqual(d['script-src-attr'], ["'none'"]);
});

test('headers: CSP enforces the framing/object/base controls', () => {
  const headers = parseHeadersFile(readFileSync(join(ROOT, 'site/public/_headers'), 'utf8'));
  const d = cspDirectives(headers);
  assert.deepEqual(d['object-src'], ["'none'"]);
  assert.deepEqual(d['base-uri'], ["'self'"]);
  assert.deepEqual(d['frame-ancestors'], ["'none'"]);
  assert.deepEqual(d['form-action'], ["'self'"]);
  assert.ok(d['default-src'].includes("'self'"));
});

test('headers: HSTS, nosniff, and X-Frame-Options are present with strict values', () => {
  const headers = parseHeadersFile(readFileSync(join(ROOT, 'site/public/_headers'), 'utf8'));
  const hsts = getHeader(headers, 'strict-transport-security');
  assert.ok(hsts, 'HSTS required');
  assert.match(hsts[1], /max-age=31536000/);
  assert.match(hsts[1], /includeSubDomains/);
  assert.equal(getHeader(headers, 'x-content-type-options')[1], 'nosniff');
  assert.equal(getHeader(headers, 'x-frame-options')[1], 'DENY');
});

test('headers: style-src unsafe-inline is allowed only as a documented exception', () => {
  const headers = parseHeadersFile(readFileSync(join(ROOT, 'site/public/_headers'), 'utf8'));
  const d = cspDirectives(headers);
  // Inline style attributes are still widespread; until they migrate to
  // classes, style-src must carry 'unsafe-inline' AND the file must explain
  // why. When the migration lands, tighten this to forbid it.
  assert.ok(d['style-src'].includes("'unsafe-inline'"));
  const text = readFileSync(join(ROOT, 'site/public/_headers'), 'utf8');
  assert.match(text, /inline style attributes are migrated/i);
});

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The site serves a strict CSP (script-src 'self', script-src-attr 'none').
// This test keeps the BUILT output compatible with it: every <script> in
// dist must be external (src=...) or a non-executable JSON data island.
// Runs after "npm run build" in CI; skips when dist is absent locally.

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

function htmlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...htmlFiles(p));
    else if (entry.name.endsWith('.html')) out.push(p);
  }
  return out;
}

test('built pages contain no executable inline scripts', () => {
  if (!fs.existsSync(dist)) {
    console.log('dist/ not found — run "npm run build" first; skipping CSP test.');
    return;
  }
  const offenders = [];
  for (const file of htmlFiles(dist)) {
    const html = fs.readFileSync(file, 'utf8');
    for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
      const attrs = m[1];
      if (/src=/.test(attrs)) continue;
      if (/type="application\/json"/.test(attrs)) continue;
      offenders.push(`${path.relative(dist, file)}: <script${attrs.slice(0, 60)}>`);
    }
  }
  assert.deepEqual(offenders, [], 'inline executable scripts break script-src \'self\'');
});

test('pricing data islands are valid, self-contained JSON', () => {
  if (!fs.existsSync(dist)) return;
  for (const page of ['index.html', 'cost/index.html']) {
    const html = fs.readFileSync(path.join(dist, page), 'utf8');
    const m = html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(m, `${page} must carry a pricing data island`);
    const data = JSON.parse(m[1]);
    for (const key of ['profile', 'anthropic', 'deepseek', 'defaults']) {
      assert.ok(data[key], `${page} island missing ${key}`);
    }
    assert.ok(!m[1].includes('</script'), 'island must not contain a closing script tag');
  }
});

test('no inline event handlers anywhere in the built output', () => {
  if (!fs.existsSync(dist)) return;
  for (const file of htmlFiles(dist)) {
    const html = fs.readFileSync(file, 'utf8');
    const hits = html.match(/\son(click|load|error|input|change|mouseover)=/g);
    assert.equal(hits, null, `${path.relative(dist, file)} has inline event handlers`);
  }
});

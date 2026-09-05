// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const dist = path.join(process.cwd(), 'dist');

test('built site contains required entry points', () => {
  // The smoke test runs after "npm run build" in CI. If dist is missing
  // (e.g. a local run before building), skip rather than hard-fail.
  if (!fs.existsSync(dist)) {
    console.log('dist/ not found — run "npm run build" first; skipping smoke test.');
    return;
  }
  for (const f of ['index.html', 'sitemap-index.xml', 'robots.txt']) {
    assert.ok(fs.existsSync(path.join(dist, f)), `missing dist/${f}`);
  }
  // robots must reference the sitemap
  const robots = fs.readFileSync(path.join(dist, 'robots.txt'), 'utf8');
  assert.ok(robots.includes('Sitemap:'), 'robots.txt should reference a sitemap');
  // internal links: every top-level page has an index.html
  const pages = [
    'cost',
    'commands',
    'coder',
    'integrations',
    'security',
    'docs',
    'docs/getting-started',
    'workflows',
    'workflows/research',
    'workflows/review',
    'workflows/implementation',
  ];
  for (const p of pages) {
    assert.ok(fs.existsSync(path.join(dist, p, 'index.html')), `missing dist/${p}/index.html`);
  }
  for (const font of [
    'IBMPlexSans-Bold.woff2',
    'IBMPlexSans-Regular.woff2',
    'IBMPlexSans-Medium.woff2',
    'IBMPlexSans-SemiBold.woff2',
    'IBMPlexMono-Regular.woff2',
    'IBMPlexMono-Medium.woff2',
    'IBMPlexMono-SemiBold.woff2',
  ]) {
    assert.ok(fs.existsSync(path.join(dist, 'fonts', font)), `missing dist/fonts/${font}`);
  }
  const css = fs.readdirSync(dist, { recursive: true })
    .filter((name) => name.endsWith('.html') || name.endsWith('.css'))
    .map((name) => fs.readFileSync(path.join(dist, name), 'utf8'))
    .join('\n');
  assert.match(css, /\/fonts\/IBMPlexSans-Regular\.woff2/);
  assert.match(css, /\/fonts\/IBMPlexSans-Bold\.woff2/);
  assert.match(css, /\/fonts\/IBMPlexMono-Regular\.woff2/);
  assert.match(css, /safe-area-inset-left/);
  assert.match(css, /pointer:coarse/);
  assert.match(css, /min-height:44px/);
  assert.doesNotMatch(css, /fonts\.(googleapis|gstatic)\.com/);
});

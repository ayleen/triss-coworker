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
  const pages = ['cost', 'commands', 'coder', 'integrations', 'security', 'docs'];
  for (const p of pages) {
    assert.ok(fs.existsSync(path.join(dist, p, 'index.html')), `missing dist/${p}/index.html`);
  }
});

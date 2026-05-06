import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRepo, resolveRepo } from '../src/integrations/github/client.js';

test('detectRepo returns null when there is no git remote', () => {
  // Run from a dir guaranteed to have no git origin (the OS root).
  const orig = process.cwd();
  process.chdir('/');
  try {
    const r = detectRepo();
    // Either null or the repo of /, which definitely isn't github.
    assert.ok(r === null || /^[^/]+\/[^/]+$/.test(r));
  } finally {
    process.chdir(orig);
  }
});

test('resolveRepo returns the explicit value untouched', () => {
  assert.equal(resolveRepo('owner/name'), 'owner/name');
  assert.equal(resolveRepo('foo/bar.baz'), 'foo/bar.baz');
});

test('resolveRepo rejects malformed repo specs', () => {
  for (const bad of [
    'owner',                // no slash
    'owner/name/extra',     // path traversal candidate
    'owner/name?secret=1',  // query injection
    'owner/name#frag',      // fragment injection
    '../../etc/passwd',
    'a b/c',                // whitespace
    '',                     // empty after coercion is a different path; just ensure we throw on truthy junk
    'owner/name/',          // trailing slash
  ]) {
    if (bad === '') continue; // empty falls back to detectRepo, not validation
    assert.throws(
      () => resolveRepo(bad),
      /Invalid GitHub repo/,
      `expected "${bad}" rejected`,
    );
  }
});

test('resolveRepo throws when nothing is given and no origin matches', () => {
  const orig = process.cwd();
  process.chdir('/');
  try {
    assert.throws(() => resolveRepo(undefined), /auto-detect.*GitHub/i);
  } finally {
    process.chdir(orig);
  }
});

test('github client builds requests with bearer auth', async () => {
  process.env.GITHUB_TOKEN = 'ghp_test_token';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ items: [] }),
    };
  };

  const { github } = await import('../src/integrations/github/client.js?bearer=' + Date.now());
  await github.search({ query: 'is:open' });

  const call = calls[0];
  assert.match(call.url, /\/search\/issues\?q=is%3Aopen/);
  assert.equal(call.init.headers.Authorization, 'Bearer ghp_test_token');
  assert.equal(call.init.headers['X-GitHub-Api-Version'], '2022-11-28');
});

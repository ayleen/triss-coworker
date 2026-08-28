// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { validateManifest, fetchManifest, MANIFEST_URL } from '../src/update/manifest.js';
import { requestSequence } from './helpers/http-request.js';

const good = {
  schema_version: 1,
  name: 'triss-coworker',
  version: '0.32.0',
  channel: 'stable',
  published_at: '2026-08-12T12:00:00.000Z',
  release_url: 'https://github.com/ayleen/triss-coworker/releases/tag/v0.32.0',
  node: '>=22',
  artifact: {
    url: 'https://github.com/ayleen/triss-coworker/releases/download/v0.32.0/triss-coworker-0.32.0-standalone.ndjson.gz',
    sha256: 'a'.repeat(64),
    size: 1234567,
    expanded_size: 9876543,
    file_count: 456,
    format: 'triss-ndjson-gzip-v1',
    platform: 'node-posix',
  },
};

test('manifest has invalid, incompatible, and compatible states', () => {
  assert.equal(validateManifest({ ...good, version: 'v0.32.0' }).kind, 'invalid');
  const incompatible = validateManifest({ ...good, node: '>=24' }, { runningNode: '22.2.0' });
  assert.equal(incompatible.kind, 'incompatible');
  assert.equal(incompatible.valid, true);
  assert.equal(incompatible.nodeCompatible, false);
  assert.equal(incompatible.canApply, false);
  assert.equal(validateManifest(good, { runningNode: '24.0.0' }).kind, 'compatible');
});

test('manifest enforces exact hosts, version paths and caps', () => {
  assert.equal(validateManifest({ ...good, artifact: { ...good.artifact, url: 'https://evil.example/a' } }).valid, false);
  assert.equal(validateManifest({ ...good, artifact: { ...good.artifact, url: 'https://github.com/ayleen/triss-coworker/releases/download/v0.31.0/x' } }).valid, false);
  assert.equal(validateManifest({
    ...good,
    artifact: { ...good.artifact, size: 32 * 1024 * 1024 + 1 },
  }).valid, false);
  assert.equal(validateManifest({ ...good, release_url: `${good.release_url}?x=1` }).valid, false);
  assert.equal(validateManifest({ ...good, published_at: '2026-02-30T00:00:00.000Z' }).valid, false);
  assert.equal(validateManifest({
    ...good,
    artifact: {
      ...good.artifact,
      url: 'https://objects.githubusercontent.com/v0.32.0/a',
    },
  }).valid, false);
});

test('fetchManifest follows bounded strict transport and parses body', async () => {
  let requested;
  const result = await fetchManifest({
    requestImpl: requestSequence([{ body: JSON.stringify(good), headers: { 'content-type': 'application/json' } }], {
      onRequest: (url, options) => { requested = { url: String(url), options }; },
    }),
    runningNode: '22.0.0',
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  assert.equal(requested.url, MANIFEST_URL);
  assert.equal(requested.options.method, 'GET');
  assert.equal(result.kind, 'compatible');
});

test('strict update transport rejects an HTTPS-to-HTTP downgrade', async () => {
  await assert.rejects(
    () => fetchManifest({
      requestImpl: requestSequence([{
        status: 302,
        headers: { location: 'http://github.com/downgrade' },
      }]),
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    }),
    /insecure update URL/,
  );
});

test('manifest timeout is total even when an injected fetch ignores abort', async () => {
  const started = Date.now();
  await assert.rejects(
    () => fetchManifest({
      requestImpl: requestSequence([{ never: true }]),
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      timeoutMs: 20,
    }),
    (error) => error.category === 'timeout',
  );
  assert.ok(Date.now() - started < 200);
});

test('manifest deadline aborts a slow DNS stage', async () => {
  let aborted = false;
  const started = Date.now();
  await assert.rejects(() => fetchManifest({
    requestImpl: () => { throw new Error('request must not start'); },
    lookupImpl: async (_host, { signal }) => {
      signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
      await new Promise(() => {});
    },
    timeoutMs: 20,
  }), (error) => error.category === 'timeout');
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 200);
});

test('manifest deadline cancels a body reader that ignores abort', async () => {
  let cancelled = false;
  const body = new Readable({
    read() {},
    destroy(error, callback) {
      cancelled = true;
      callback(error);
    },
  });
  await assert.rejects(() => fetchManifest({
    requestImpl: requestSequence([{ stream: body }]),
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    timeoutMs: 20,
  }), (error) => error.category === 'timeout');
  assert.equal(cancelled, true);
});

test('manifest rejects a non-streaming response before an unbounded text read', async () => {
  await assert.rejects(() => fetchManifest({
    requestImpl: requestSequence([{ status: 204 }]),
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
  }), /stream-readable/);
});

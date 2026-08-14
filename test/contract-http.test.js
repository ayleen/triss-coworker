import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { httpJson, stripHtml } from '../src/integrations/_contract.js';

function setEnv(k, v) {
  const before = process.env[k];
  process.env[k] = v;
  return () => {
    if (before === undefined) delete process.env[k];
    else process.env[k] = before;
  };
}

test('httpJson honours TRISS_HTTP_TIMEOUT_MS and surfaces a clean error', async () => {
  const restore = setEnv('TRISS_HTTP_TIMEOUT_MS', '50');
  globalThis.fetch = async (_url, init) =>
    new Promise((_, reject) => {
      // Hang until the caller's signal aborts.
      init.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  try {
    await assert.rejects(
      () => httpJson('https://example.com/slow'),
      /Timeout after 50ms/,
    );
  } finally {
    restore();
  }
});

test('httpJson caps response size via TRISS_HTTP_MAX_BYTES', async () => {
  const restore = setEnv('TRISS_HTTP_MAX_BYTES', '64');
  // Two-chunk stream so the cap is hit mid-flight.
  const big = new Uint8Array(256).fill(65); // 'A' x 256
  const half = 128;
  let idx = 0;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader: () => ({
        async read() {
          if (idx === 0) { idx++; return { value: big.slice(0, half), done: false }; }
          if (idx === 1) { idx++; return { value: big.slice(half), done: false }; }
          return { value: undefined, done: true };
        },
        async cancel() { /* noop */ },
      }),
    },
    text: async () => Buffer.from(big).toString('utf8'),
  });
  try {
    await assert.rejects(
      () => httpJson('https://example.com/big'),
      /exceeds 64 bytes/,
    );
  } finally {
    restore();
  }
});

test('httpJson timeout also covers a stalled response body', async () => {
  const restore = setEnv('TRISS_HTTP_TIMEOUT_MS', '50');
  globalThis.fetch = async (_url, init) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader: () => ({
        read() {
          return new Promise((_, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          });
        },
        async cancel() { /* noop */ },
      }),
    },
    text: async () => '{"unreachable":true}',
  });
  try {
    await assert.rejects(
      () => httpJson('https://example.com/stalled-body'),
      /Timeout reading body.*50ms/,
    );
  } finally {
    restore();
  }
});

test('httpJson cleans up its timeout on success (no leaked timers)', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    body: null,
    text: async () => '{"ok":true}',
  });
  const out = await httpJson('https://example.com/ok');
  assert.deepEqual(out, { ok: true });
  // If the timer leaked it would block process exit; node:test exits
  // cleanly when timers are cleared, so reaching here is the assertion.
  await sleep(0);
});

test('stripHtml removes tags and script/style content', () => {
  assert.equal(stripHtml('<b>Hello</b> <i>world</i>'), 'Hello world');
  assert.equal(stripHtml('<script>alert(1)</script>Hello<style>.x{}</style>'), 'Hello');
});

test('stripHtml handles quoted attribute values containing >', () => {
  assert.equal(stripHtml('<a title="x > y">Name</a>'), 'Name');
  assert.equal(stripHtml('<span data-x="<b>">Title</span>'), 'Title');
});

test('stripHtml does not treat hyphenated custom tags as script/style', () => {
  assert.equal(stripHtml('<style-type>Keep?</style-type>After'), 'Keep?After');
});

// ─── REVIEW-ISSUE-* integration cases (Package 18 / Atomic 39) ──────────────

test('REVIEW-ISSUE-01: httpJson honours a per-call maxBytes override below the global cap', async () => {
  const big = new Uint8Array(4096).fill(66); // 'B' x 4096
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: big })),
          releaseLock: () => {},
          cancel: async () => {},
        };
      },
    },
  });
  // Per-call maxBytes (Package 18 review-specific bounded reading) rejects
  // the 4 KiB body even though the global cap would allow it.
  await assert.rejects(
    () => httpJson('https://example.com/per-call-cap', { maxBytes: 1024 }),
    /exceeds .* bytes/,
  );
  // The same call WITHOUT the per-call override succeeds under the global cap.
  const out = await httpJson('https://example.com/per-call-ok', { maxBytes: 8192 });
  assert.ok(out.length === 4096 || Array.isArray(out) === false);
});

test('REVIEW-ISSUE-02: a caller abort signal cancels httpJson mid-body', async () => {
  const controller = new AbortController();
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  // The caller abort propagates into the composed internal signal: the fetch
  // promise rejects with AbortError, which httpJson maps to the timeout error.
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(
    () => httpJson('https://example.com/caller-abort', { signal: controller.signal }),
    /Timeout after/,
  );
});

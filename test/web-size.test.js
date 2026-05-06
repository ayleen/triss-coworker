import test from 'node:test';
import assert from 'node:assert/strict';

function makeMockResponse(bytes, { ok = true } = {}) {
  // Two chunks so we exercise the streaming-read path with a measurable
  // cumulative size, and validate the cap kicks in mid-stream.
  const half = Math.ceil(bytes.length / 2);
  const a = bytes.slice(0, half);
  const b = bytes.slice(half);
  let chunkIdx = 0;
  const reader = {
    async read() {
      if (chunkIdx === 0) {
        chunkIdx++;
        return { value: a, done: false };
      }
      if (chunkIdx === 1) {
        chunkIdx++;
        return { value: b, done: false };
      }
      return { value: undefined, done: true };
    },
    async cancel() {
      /* noop */
    },
  };
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Server Error',
    url: 'https://example.com/x',
    headers: { get: () => 'text/html' },
    body: { getReader: () => reader },
    text: async () => new TextDecoder().decode(bytes),
  };
}

test('fetchUrl rejects oversized responses (default 10MB cap)', async () => {
  process.env.TRISS_FETCH_MAX_BYTES = '256'; // tiny cap for the test
  const big = new Uint8Array(1024); // > 256 bytes
  big.fill(65); // 'A'
  globalThis.fetch = async () => makeMockResponse(big);
  const { fetchUrl } = await import(`../src/web.js?web-size-${Date.now()}`);
  await assert.rejects(() => fetchUrl('https://example.com/x'), /exceeds 256 bytes|too large/);
  delete process.env.TRISS_FETCH_MAX_BYTES;
});

test('fetchUrl returns body unchanged when within cap', async () => {
  process.env.TRISS_FETCH_MAX_BYTES = '4096';
  const small = new TextEncoder().encode('<html>tiny</html>');
  globalThis.fetch = async () => makeMockResponse(small);
  const { fetchUrl } = await import(`../src/web.js?web-size-ok-${Date.now()}`);
  const result = await fetchUrl('https://example.com/x');
  assert.match(result.text, /<html>tiny<\/html>/);
  delete process.env.TRISS_FETCH_MAX_BYTES;
});

/**
 * Cross-cutting invariants spanning multiple modules.
 * Each test covers one broad concern; see test-plan-main.md "Cross-Cutting Tests".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmp(prefix = 'triss-cc-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * Snapshot a set of env keys and return a restore function.
 * Works correctly when a key was previously undefined.
 */
function envSnapshot(keys) {
  const before = {};
  for (const k of keys) before[k] = process.env[k];
  return () => {
    for (const k of keys) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  };
}

// ─── 1. Path-safety: runWrite refuses --target outside cwd ──────────────────

test('runWrite refuses --target outside cwd when TRISS_RESTRICT_PATHS=1', async () => {
  const tmp = makeTmp('triss-write-safety-');
  const originalCwd = process.cwd();
  const restore = envSnapshot(['TRISS_RESTRICT_PATHS']);

  process.chdir(tmp);
  process.env.TRISS_RESTRICT_PATHS = '1';

  try {
    const { runWrite } = await import('../src/commands/write.js');
    // --target outside the cwd subtree must throw with TRISS_PATH_DENIED
    await assert.rejects(
      () => runWrite({ spec: 'a simple file', target: '/tmp/outside-project.txt' }),
      (err) => {
        assert.equal(err.code, 'TRISS_PATH_DENIED');
        return true;
      },
    );
  } finally {
    process.chdir(originalCwd);
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── 2. Path-safety: runExtract refuses --output outside cwd ────────────────

test('runExtract refuses --output outside cwd when TRISS_RESTRICT_PATHS=1', async () => {
  const tmp = makeTmp('triss-extract-safety-');
  const originalCwd = process.cwd();
  const restore = envSnapshot(['TRISS_RESTRICT_PATHS']);

  // Create a minimal JSONL file inside the tmp project dir so the input path
  // passes assertSafePath (it is inside cwd).
  const jsonlFile = join(tmp, 'session.jsonl');
  writeFileSync(
    jsonlFile,
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, timestamp: '' }) + '\n',
  );

  process.chdir(tmp);
  process.env.TRISS_RESTRICT_PATHS = '1';

  try {
    const { runExtract } = await import('../src/commands/extract.js');
    assert.throws(
      () => runExtract({ jsonl: jsonlFile, output: '/tmp/outside-output.txt' }),
      (err) => {
        assert.equal(err.code, 'TRISS_PATH_DENIED');
        return true;
      },
    );
  } finally {
    process.chdir(originalCwd);
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── 3. Secret leakage: maskValue never returns the full secret ──────────────

test('maskValue never returns the full secret for various lengths', async () => {
  const { maskValue } = await import('../src/secrets.js');

  const cases = [
    'sk-short',               // <= 8 chars  → all bullets
    'sk-12345',               // exactly 8   → all bullets
    'sk-a-longer-token-123',  // > 8 chars   → partial mask
    'ATLASSIAN_TOKEN_abc_xyz_verylongtoken',
    'a', // single char
    'ab', // two chars
  ];

  for (const secret of cases) {
    const masked = maskValue(secret);
    assert.notEqual(
      masked,
      secret,
      `maskValue("${secret}") returned the full secret "${masked}"`,
    );
    // The masked form must not contain the original value as a substring
    // (unless the length is so short it's all bullets, which is also fine).
    if (secret.length > 8) {
      assert.ok(
        !masked.includes(secret),
        `maskValue("${secret}") contains the full secret in "${masked}"`,
      );
    }
  }
});

// ─── 4. Fetch size cap: default 10 MB used when TRISS_FETCH_MAX_BYTES unset ──

test('fetchUrl default 10 MB cap is used when TRISS_FETCH_MAX_BYTES is unset', async () => {
  const restore = envSnapshot(['TRISS_FETCH_MAX_BYTES']);
  delete process.env.TRISS_FETCH_MAX_BYTES;

  // Stub fetch to return a body just over 10 MB via a streaming reader.
  const LIMIT = 10 * 1024 * 1024;
  const oversize = new Uint8Array(LIMIT + 1);
  oversize.fill(65); // 'A'

  let chunkIdx = 0;
  const reader = {
    async read() {
      if (chunkIdx === 0) { chunkIdx++; return { value: oversize, done: false }; }
      return { value: undefined, done: true };
    },
    async cancel() {},
  };

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    url: 'https://example.com/big',
    headers: { get: () => 'text/html' },
    body: { getReader: () => reader },
    text: async () => '',
  });

  try {
    // Use a cache-busting query so Node's module cache doesn't return the
    // previously imported instance that had TRISS_FETCH_MAX_BYTES set.
    const { fetchUrl } = await import(`../src/web.js?default-cap-${Date.now()}`);
    await assert.rejects(
      () => fetchUrl('https://example.com/big'),
      /exceeds 10485760 bytes|exceeds.*bytes|too large/i,
    );
  } finally {
    restore();
  }
});

// ─── 5. XML escape: </file> in source does not break corpus framing ──────────

test('readFilesAsCorpus XML-escapes </file> so model framing cannot be spoofed', async () => {
  const tmp = makeTmp('triss-xmlesc-');
  const restore = envSnapshot(['TRISS_RESTRICT_PATHS']);
  delete process.env.TRISS_RESTRICT_PATHS; // CLI mode — no restriction

  const filePath = join(tmp, 'tricky.txt');
  // The content contains an exact </file> closing tag that would break framing.
  writeFileSync(filePath, 'start </file> closing end');

  try {
    const { readFilesAsCorpus } = await import('../src/paths.js');
    const { corpus } = readFilesAsCorpus([filePath]);

    // The escaped form must appear.
    assert.ok(
      corpus.includes('<\\/file>'),
      `Expected escaped form <\\/file> in corpus but got: ${corpus}`,
    );
    // The raw closing tag must NOT appear anywhere in the corpus body.
    // Note: the outer <file path='...'> wrapper contains no bare </file>.
    // We search from just after the opening tag.
    const openTagEnd = corpus.indexOf('>') + 1;
    const bodyOnward = corpus.slice(openTagEnd);
    assert.ok(
      !bodyOnward.includes('</file> closing'),
      `Raw "</file> closing" sequence still present in corpus body: ${bodyOnward}`,
    );
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── 6. Binary skip: NUL bytes in different positions all get skipped ─────────

test('readFilesAsCorpus skips binaries with NUL in start, middle, and end positions', async () => {
  const tmp = makeTmp('triss-binary-');
  const restore = envSnapshot(['TRISS_RESTRICT_PATHS']);
  delete process.env.TRISS_RESTRICT_PATHS;

  // NUL at start
  const startBuf = Buffer.alloc(16);
  startBuf[0] = 0x00;
  startBuf.fill(65, 1); // rest is 'A'
  writeFileSync(join(tmp, 'nul-start.bin'), startBuf);

  // NUL in the middle
  const midBuf = Buffer.alloc(16, 65); // all 'A'
  midBuf[8] = 0x00;
  writeFileSync(join(tmp, 'nul-mid.bin'), midBuf);

  // NUL at the end (within the 8 KB heuristic window)
  const endBuf = Buffer.alloc(16, 65);
  endBuf[15] = 0x00;
  writeFileSync(join(tmp, 'nul-end.bin'), endBuf);

  const paths = [
    join(tmp, 'nul-start.bin'),
    join(tmp, 'nul-mid.bin'),
    join(tmp, 'nul-end.bin'),
  ];

  try {
    const { readFilesAsCorpus } = await import('../src/paths.js');
    const { skipped, corpus } = readFilesAsCorpus(paths);

    assert.equal(skipped, 3, `Expected 3 skipped binary files, got ${skipped}`);
    // Each file should be reported as skipped via an error attribute.
    const skipCount = (corpus.match(/binary file.*skipped/g) || []).length;
    assert.equal(skipCount, 3, `Expected 3 "binary file … skipped" messages, got ${skipCount}`);
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── 7. Windows permission warning ──────────────────────────────────────────
//
// Monkey-patching process.platform reliably enough to trigger the branch is
// brittle: the property is not configurable on Node 18+ (Object.defineProperty
// throws "Cannot redefine property"). We therefore verify the branch logic by
// reading the source directly and confirming the warning string exists there,
// which is a stable proxy for the behaviour without touching platform state.
//
// If a future Node version allows redefining `process.platform`, this test
// can be upgraded to a proper integration test.

test('secrets.js contains a win32 permission warning for ensureEnvFile (structural check)', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join: pJoin } = await import('node:path');
  // Resolve relative to this test file.
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(pJoin(here, '..', 'src', 'secrets.js'), 'utf8');

  assert.ok(
    src.includes("process.platform === 'win32'"),
    'Expected win32 branch in secrets.js',
  );
  assert.ok(
    src.includes('POSIX permissions') || src.includes('plain text'),
    'Expected permission warning text in secrets.js win32 branch',
  );
  assert.ok(
    src.includes('process.stderr.write'),
    'Expected ensureEnvFile to write to stderr on win32',
  );
});

// ─── 8. GitHub bootstrap: loadIntegrations calls bootstrap() ─────────────────
//
// We place a fake `gh` shell script earlier on PATH that prints a known token.
// bootstrap() in github/index.js dynamically imports `node:child_process` and
// calls spawnSync('gh', ['auth', 'token'], ...) — the fake script intercepts it.

test('loadIntegrations calls github bootstrap and sets GITHUB_TOKEN from gh cli', async () => {
  const tmp = makeTmp('triss-bootstrap-');
  const restore = envSnapshot(['GITHUB_TOKEN', 'PATH']);
  delete process.env.GITHUB_TOKEN; // ensure bootstrap has work to do

  // Write a tiny fake `gh` script that prints the token we expect.
  const fakeGh = join(tmp, 'gh');
  writeFileSync(fakeGh, '#!/bin/sh\necho gh-fake-token-abc123\n');
  const { chmodSync } = await import('node:fs');
  chmodSync(fakeGh, 0o755);

  // Prepend our fake bin directory to PATH so spawnSync('gh', ...) finds it.
  process.env.PATH = tmp + ':' + (process.env.PATH || '');

  try {
    // Cache-bust the registry so bootstrap() runs again (not cached from a
    // previous import in this test session).
    const { loadIntegrations } = await import(
      `../src/integrations/_registry.js?bootstrap-${Date.now()}`
    );
    await loadIntegrations();

    assert.equal(
      process.env.GITHUB_TOKEN,
      'gh-fake-token-abc123',
      'Expected GITHUB_TOKEN to be set by github bootstrap via fake gh script',
    );
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

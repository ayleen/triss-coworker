import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const installModule = pathToFileURL(join(repoRoot, 'src/update/install.js')).href;
const cacheModule = pathToFileURL(join(repoRoot, 'src/update/cache.js')).href;
const artifactModule = pathToFileURL(join(repoRoot, 'src/update/artifact.js')).href;
const bootstrapModule = pathToFileURL(join(repoRoot, 'scripts/standalone-bootstrap.js')).href;

function fifoOrSkip(t, path) {
  try {
    execFileSync('mkfifo', [path]);
    return true;
  } catch (error) {
    t.skip(`mkfifo is unavailable on this platform: ${error.message}`);
    return false;
  }
}

function assertChildRejects(code, paths) {
  const args = Array.isArray(paths) ? paths : [paths];
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, '--', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 1_000,
  });
  assert.equal(result.error?.code, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('runtime receipt reader rejects FIFO without blocking', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'triss-fifo-runtime-'));
  const fifo = join(root, 'install.json');
  try {
    if (!fifoOrSkip(t, fifo)) return;
    assertChildRejects(`
      import { readReceipt } from ${JSON.stringify(installModule)};
      try { readReceipt(process.argv[1]); process.exit(2); }
      catch (error) { if (!/regular|read|FIFO|pipe|device/i.test(error.message)) process.exit(3); }
    `, root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cache state reader rejects FIFO without blocking', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'triss-fifo-cache-'));
  const fifo = join(root, 'update-state.json');
  try {
    if (!fifoOrSkip(t, fifo)) return;
    assertChildRejects(`
      import { readUpdateState } from ${JSON.stringify(cacheModule)};
      const state = readUpdateState(process.argv[1]);
      if (state.manifest !== null || state.consecutive_failures !== 0) process.exit(2);
    `, fifo);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('artifact path readers reject FIFO without blocking', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'triss-fifo-artifact-'));
  const fifo = join(root, 'artifact.gz');
  const stage = join(root, 'stage');
  try {
    if (!fifoOrSkip(t, fifo)) return;
    assertChildRejects(`
      import { inspectArtifact, extractArtifact } from ${JSON.stringify(artifactModule)};
      for (const action of [() => inspectArtifact(process.argv[1]), () => extractArtifact(process.argv[1], process.argv[2])]) {
        try { action(); process.exit(2); }
        catch (error) { if (!/regular|read|FIFO|pipe|device|artifact/i.test(error.message)) process.exit(3); }
      }
    `, [fifo, stage]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bootstrap metadata reader rejects FIFO without blocking', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'triss-fifo-bootstrap-'));
  const fifo = join(root, 'metadata.json');
  try {
    if (!fifoOrSkip(t, fifo)) return;
    assertChildRejects(`
      import { readBoundedJson } from ${JSON.stringify(bootstrapModule)};
      try { readBoundedJson(process.argv[1], 'metadata', 1024); process.exit(2); }
      catch (error) { if (!/regular|read|FIFO|pipe|device|metadata/i.test(error.message)) process.exit(3); }
    `, fifo);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

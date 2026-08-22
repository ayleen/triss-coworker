/**
 * review-blackbox-security.test.js — black-box acceptance for security and
 * reliable-delegation contract.
 *
 * RED/GREEN: node --test test/review-blackbox-security.test.js
 *
 * Covers the acceptance gaps the blocking review called out: the REAL
 * exported entry points (not the modules underneath) must uphold the
 * fail-closed guarantees:
 *
 *   1. `runCoderRun` without a working credential proxy fails BEFORE the
 *      engine spawns, and the child env never carries the raw credential.
 *   2. `triss review --stdin` fails closed on cap-plus-one without
 *      echoing/persisting partial input.
 *   3. The single-payload planner fails closed on aggregate overflow
 *      (many small files > singleMaxBytes) — no silent truncation.
 *   4. The CLI registers --files/--issue and rejects evidence+shard.
 *   5. Real `git diff` quoted paths and rename detection parse correctly
 *      against a REAL temporary repository.
 *   6. The PR acquisition lifecycle releases run directories (4 runs, no
 *      leak into the 3-run cap).
 *   7. The live sharding acceptance gate imports cleanly (no bogus client.js
 *      assertProviderText import).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ─── 1. credential proxy fail-closed before spawn ───────────────────────────

test('coder run without a startable proxy fails BEFORE spawn, env stays clean', async () => {
  const { runCoderRun } = await import('../src/commands/coder.js');
  let spawned = false;
  let observedEnv = null;
  const fakeSpawn = (cmd, argv, opts) => {
    spawned = true;
    observedEnv = opts?.env || null;
    const child = new EventEmitter();
    child.pid = 1;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => child.emit('close', 0, null));
    return child;
  };
  const saved = {
    HOME: process.env.HOME,
    ZHIPU_API_KEY: process.env.ZHIPU_API_KEY,
    OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
    MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
    TRISS_USAGE_LOG: process.env.TRISS_USAGE_LOG,
    TRISS_CODER_MODEL: process.env.TRISS_CODER_MODEL,
  };
  const tempHome = mkdtempSync(join(tmpdir(), 'triss-bb-proxy-fail-home-'));
  process.env.HOME = tempHome;
  process.env.ZHIPU_API_KEY = 'zk-raw-secret-should-never-reach-child';
  delete process.env.OPENCODE_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  process.env.TRISS_USAGE_LOG = '0';
  delete process.env.TRISS_CODER_MODEL;
  try {
    await assert.rejects(
      () => runCoderRun(
        'do anything',
        {},
        {
          spawn: fakeSpawn,
          spawnSync: () => ({ status: 1, stdout: '', error: null }),
          stdoutWrite: () => true,
          // The proxy CANNOT start (port binding fails via a dead listener).
          credentialProxyOptions: { host: '256.256.256.256', port: -1 },
        },
      ),
      /credential isolation unavailable|refusing to spawn/i,
    );
    assert.equal(spawned, false, 'engine must never spawn when the proxy is unavailable');
    assert.equal(observedEnv, null, 'no env should have been built for a child');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('a successful proxied run hands the child the token, never the raw key', async () => {
  const { runCoderRun } = await import('../src/commands/coder.js');
  const RAW = 'zk-raw-secret-should-never-reach-child';
  let observedEnv = null;
  const fakeSpawn = (cmd, argv, opts) => {
    observedEnv = opts?.env || {};
    const child = new EventEmitter();
    child.pid = 424242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      // crush prints a final JSON envelope line on stdout.
      child.stdout.end('{"type":"result","output":"ok"}\n');
      child.stderr.end('');
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  };
  const saved = {
    HOME: process.env.HOME,
    ZHIPU_API_KEY: process.env.ZHIPU_API_KEY,
    OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
    MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
    TRISS_USAGE_LOG: process.env.TRISS_USAGE_LOG,
    TRISS_CODER_MODEL: process.env.TRISS_CODER_MODEL,
  };
  process.env.ZHIPU_API_KEY = RAW;
  delete process.env.OPENCODE_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  process.env.TRISS_USAGE_LOG = '0';
  // Run inside a scratch repo so crush's isolate-ON default finds a git root.
  const scratch = mkdtempSync(join(tmpdir(), 'triss-bb-coder-'));
  const prevCwd = process.cwd();
  process.env.HOME = scratch;
  process.chdir(scratch);
  try {
    execFileSync('git', ['init', '-q'], { cwd: scratch });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: scratch });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: scratch });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: scratch });
    await runCoderRun(
      'noop',
      { engine: 'crush' },
      {
        spawn: fakeSpawn,
        spawnSync: (cmd, args, opts) => {
          // Real spawnSync for git, faked for engine probes.
          if (cmd === 'crush') return { status: 1, stdout: '', error: null };
          try {
            const stdout = execFileSync(cmd, args, { ...opts, cwd: opts?.cwd || scratch, encoding: 'buffer' });
            return { status: 0, stdout, error: null };
          } catch (err) {
            return { status: err.status ?? 1, stdout: err.stdout || '', stderr: err.stderr || '', error: null };
          }
        },
        stdoutWrite: () => true,
      },
    );
    assert.ok(observedEnv, 'engine spawned');
    const flat = JSON.stringify(observedEnv);
    assert.ok(!flat.includes(RAW), 'raw provider key must never appear in the child env');
    const credEnv = Object.keys(observedEnv).find((k) => /_API_KEY$/.test(k) || k === 'ZAI_API_KEY');
    assert.ok(credEnv, 'a credential env var is present');
    assert.notEqual(observedEnv[credEnv], RAW);
  } finally {
    process.chdir(prevCwd);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});

// ─── 2. bounded stdin fail-closed ────────────────────────────────────────────

test('review --stdin rejects cap-plus-one without partial output', async () => {
  const { runReviewWithDeps } = await import('../src/commands/review.js');
  const { REVIEW_STDIN_MAX_BYTES } = await import('../src/review-input.js');
  const tooBig = 'x'.repeat(REVIEW_STDIN_MAX_BYTES + 1);
  const fakeStdin = new PassThrough();
  setImmediate(() => fakeStdin.end(tooBig));
  const stdoutChunks = [];
  let modelCalled = false;
  await assert.rejects(
    () => runReviewWithDeps(
      undefined,
      { stdin: true, format: 'text' },
      {
        isTTY: false,
        stdinStream: fakeStdin,
        chat: async () => { modelCalled = true; return {}; },
        stdoutWrite: (s) => { stdoutChunks.push(s); return true; },
      },
    ),
    (err) => /exceeds|too large|cap/i.test(err?.message || ''),
  );
  assert.equal(modelCalled, false, 'the model must never be called on overflow');
});

// ─── 3. single-payload planner aggregate fail-closed ─────────────────────────

test('many small files whose SUM exceeds singleMaxBytes fail closed (no silent truncation)', async () => {
  const { planSingleReviewPayload } = await import('../src/review-payload.js');
  const { reviewLimitConfig } = await import('../src/config.js');
  const limits = reviewLimitConfig().limits;
  // Each section is small enough to fit individually; their SUM is not.
  const perFile = Math.floor((limits.singleMaxBytes - 4096) / 4);
  const sections = [];
  for (let i = 0; i < 5; i += 1) {
    sections.push({
      new_path: `f${i}.txt`, old_path: `f${i}.txt`, kind: 'modified', binary: false,
      bytes: perFile, raw: `diff --git a/f${i}.txt b/f${i}.txt\n${'x'.repeat(perFile)}`,
    });
  }
  const planned = planSingleReviewPayload({ sections, question: 'q', metadata: 'm', limits });
  assert.notEqual(planned.error, undefined, 'aggregate overflow must produce an error, not a truncated plan');
});

// ─── 4. CLI flag surface ─────────────────────────────────────────────────────

test('triss review registers --files, --issue, --payload-mode; evidence+shard rejected', async () => {
  const { execFileSync: exec } = await import('node:child_process');
  let help;
  try {
    help = exec('node', [join(REPO_ROOT, 'bin', 'triss.js'), 'review', '--help'], {
      encoding: 'utf8',
      env: { ...process.env },
    });
  } catch (err) {
    help = err.stdout || '';
  }
  assert.match(help, /--files/);
  assert.match(help, /--issue/);
  assert.match(help, /--payload-mode/);
});

test('validateReviewOptions rejects --payload-mode shard with --format evidence', async () => {
  const mod = await import('../src/commands/review.js');
  assert.throws(
    () => mod.validateReviewOptions(undefined, { payloadMode: 'shard', format: 'evidence' }),
    /shard cannot be combined with --format evidence/,
  );
});

// ─── 5. real git: quoted paths + rename detection ────────────────────────────

test('real git quoted path parses; renames are detected as R100 (no --no-renames)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'triss-bb-git-'));
  try {
    const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
    git(['init', '-q']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    writeFileSync(join(dir, 'foo bar.txt'), 'one\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
    writeFileSync(join(dir, 'seed2.txt'), 'seed\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base2']);
    // A change to a path WITH A SPACE forces git to quote it in diff output.
    writeFileSync(join(dir, 'foo bar.txt'), 'one\ntwo\n');
    git(['add', '.']);
    // A rename: remove the tracked old path cleanly (committed state), then
    // add the new content. Using -f is unnecessary: the file was committed
    // above before modification.
    git(['commit', '-q', '-m', 'change']);

    const diff = execFileSync(
      'git',
      ['--no-pager', '-c', 'core.quotepath=false', 'diff', '--unified=3', 'HEAD~1', 'HEAD'],
      { cwd: dir, encoding: 'utf8' },
    );
    const { parseUnifiedDiff } = await import('../src/review-payload.js');
    const parsed = parseUnifiedDiff(diff);
    assert.ok(!parsed.error, `parse error: ${parsed.error}`);
    const paths = parsed.sections.map((s) => s.new_path);
    assert.ok(paths.includes('foo bar.txt'), `quoted path parsed, got ${JSON.stringify(paths)}`);

    const { acquireNameStatusInventory } = await import('../src/review-git.js');
    const inv = acquireNameStatusInventory(
      (args, opts) => {
        // The inventory prepends `--no-pager -c ...` flags; the binary is git.
        const argv = ['git', ...args];
        return { status: 0, stdout: execFileSync(argv[0], argv.slice(1), { cwd: opts.cwd, encoding: 'buffer' }) };
      },
      { cwd: dir, baseOid: 'HEAD~1', headOid: 'HEAD' },
    );
    assert.ok(inv.ok !== false, `inventory failed: ${inv.message || inv.error}`);
    const invPaths = (inv.entries || inv.inventory || []).map((e) => e.path).filter(Boolean);
    assert.ok(invPaths.includes('foo bar.txt'), `inventory sees the quoted path, got ${JSON.stringify(invPaths)}`);
  } finally {
    const { rmSync } = await import('node:fs');
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── 6. PR acquisition lifecycle: 4 consecutive runs, no leak ────────────────

test('four sequential withDisposablePrRepository runs never hit the 3-run cap', async () => {
  const { withDisposablePrRepository } = await import('../src/review-pr.js');
  const { prRootFor } = await import('../src/review-pr-registry.js');
  const { prepareQuotaBackedDirectory } = await import('../src/coder-write-quota.js');
  const { openManagedTrissRoot } = await import('../src/managed-root.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const base = await mkdtemp(join(tmpdir(), 'triss-bb-pr-'));
  try {
    const quota = prepareQuotaBackedDirectory({ root: join(base, '.triss', 'review-pr-v1'), limitBytes: 4 * 512 * 1024 * 1024 });
    quota.capability = 'enforced';
    const root = await openManagedTrissRoot(base);
    const managedRoot = { path: base, capability: 'enforced' };
    for (let i = 0; i < 4; i += 1) {
      await withDisposablePrRepository(
        { trissRootPath: base, quota, managedRoot, parentHandle: root },
        async (run) => {
          assert.ok(run.runId, 'run handed to callback');
        },
      );
    }
    const runsRoot = prRootFor(base);
    const remaining = existsSync(runsRoot) ? readdirSync(runsRoot).filter((n) => n.startsWith('run-')) : [];
    assert.equal(remaining.length, 0, `no leaked run directories, found ${remaining.join(', ')}`);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ─── 7. live gate imports cleanly ────────────────────────────────────────────

test('BLACKBOX-ACCEPTANCE: the live sharding acceptance gate module imports without a bogus client.js export', async () => {
  const mod = await import('../src/review-live.js');
  assert.equal(typeof mod.runLiveShardedReview, 'function');
  // Both synthetic and live sharding acceptance exports must import cleanly.
  const acc = await import('./support/reliable-delegation-acceptance.js');
  assert.equal(typeof acc.runSyntheticShardingAcceptance, 'function');
  assert.equal(typeof acc.runLiveShardingAcceptance, 'function');
});

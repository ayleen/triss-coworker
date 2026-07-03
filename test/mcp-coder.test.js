/**
 * mcp-coder.test.js — Phase 4 (`triss_coder_run` / `triss_coder_status` MCP tools)
 *
 * Covers: listTools() gating on ZHIPU_API_KEY presence/absence,
 * triss_coder_status shape (never prints the key), triss_coder_run happy
 * path via an injected fake spawn (mirrors the Phase 0 fixture), and the
 * MCP sandbox rejecting an out-of-project-root `cwd`. No live network, no
 * real opencode/npm calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

import { listTools } from '../src/mcp/tools.js';
import { coderRunHandler, coderStatusHandler } from '../src/mcp/handlers.js';
import { setRestricted } from '../src/safety.js';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

function initRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-mcp-coder-repo-')));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'init']);
  git(dir, ['branch', '-M', 'main']);
  return dir;
}

const FIXTURE_PATH = join(new URL('.', import.meta.url).pathname, 'fixtures', 'opencode-run-events.ndjson');
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

function fakeSpawnReplayingFixture() {
  return () => {
    const child = new EventEmitter();
    child.pid = 313131;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.end(FIXTURE);
      child.stderr.end('');
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  };
}

// Isolates ZHIPU_API_KEY (and, for cwd-based tests, HOME/TRISS_PROJECT_ROOT)
// from this repo's own configured key in .triss.env.
function withIsolatedEnv(vars, fn) {
  return async () => {
    const saved = {};
    for (const k of Object.keys(vars)) saved[k] = process.env[k];
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const k of Object.keys(vars)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };
}

// ─── listTools gating ────────────────────────────────────────────────────────

test(
  'listTools: triss_coder_* tools are hidden when ZHIPU_API_KEY is missing',
  withIsolatedEnv({ ZHIPU_API_KEY: undefined }, async () => {
    // Run from an empty tmp HOME/cwd so no .triss.env / global .env can
    // reintroduce ZHIPU_API_KEY via getConfig()'s loadEnvFiles() call.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-mcp-coder-nokey-')));
    const origCwd = process.cwd();
    const origHome = process.env.HOME;
    process.env.HOME = dir;
    process.chdir(dir);
    try {
      const tools = await listTools();
      assert.equal(
        tools.filter((t) => t.name.startsWith('triss_coder_')).length,
        0,
        'expected no coder tools without ZHIPU_API_KEY',
      );
    } finally {
      process.chdir(origCwd);
      process.env.HOME = origHome;
      rmSync(dir, { recursive: true, force: true });
    }
  }),
);

test(
  'listTools: triss_coder_run and triss_coder_status appear when ZHIPU_API_KEY is set',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key' }, async () => {
    const tools = await listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('triss_coder_run'));
    assert.ok(names.includes('triss_coder_status'));
    const run = tools.find((t) => t.name === 'triss_coder_run');
    assert.deepEqual(run.inputSchema.required, ['prompt']);
    assert.ok('session' in run.inputSchema.properties);
    assert.ok('isolate' in run.inputSchema.properties);
    assert.ok('timeout' in run.inputSchema.properties);
    assert.ok(!('stdin' in run.inputSchema.properties), '--stdin is meaningless over MCP and must not be exposed');
  }),
);

// ─── triss_coder_status ──────────────────────────────────────────────────────

test(
  'coderStatusHandler: reports key presence without ever printing the value',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-super-secret-value-do-not-print' }, async () => {
    const text = await coderStatusHandler();
    assert.match(text, /ZHIPU_API_KEY: configured/);
    assert.ok(!text.includes('zk-super-secret-value-do-not-print'), 'the raw key must never appear in tool output');
    assert.match(text, /Engine:/);
    assert.match(text, /opencode\.json \[global\]/);
    assert.match(text, /opencode\.json \[local\]/);
    assert.match(text, /Worktrees \(\.triss\/wt\): \d+ live/);
  }),
);

test(
  'coderStatusHandler: reports "missing" without throwing when ZHIPU_API_KEY is unset',
  withIsolatedEnv({ ZHIPU_API_KEY: undefined }, async () => {
    const text = await coderStatusHandler();
    assert.match(text, /ZHIPU_API_KEY: missing/);
  }),
);

// ─── triss_coder_run ─────────────────────────────────────────────────────────

test(
  'coderRunHandler: happy path returns the envelope as a JSON string (fake spawn, no isolate)',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    const result = await coderRunHandler(
      { prompt: 'print hello via a shell echo' },
      { spawn: fakeSpawnReplayingFixture() },
    );
    const envelope = JSON.parse(result);
    assert.equal(envelope.engine, 'opencode');
    assert.equal(envelope.exit_reason, 'end_turn');
    assert.equal(envelope.final_text, '`hello`');
    assert.deepEqual(envelope.usage, { prompt_tokens: 303, completion_tokens: 19 });
  }),
);

test(
  'coderRunHandler: applies the MCP default timeout of 300s, not the CLI\'s 900s',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    // Verified indirectly: a fake spawn that captures the moment it's
    // invoked can't see the timeout value directly (it's internal to
    // spawnEngine), so we assert the documented default via the source
    // constant instead of re-deriving it from timing.
    const src = readFileSync(new URL('../src/mcp/handlers.js', import.meta.url), 'utf8');
    assert.match(src, /CODER_MCP_DEFAULT_TIMEOUT\s*=\s*300/);
  }),
);

test('coderRunHandler: throws when prompt is missing', async () => {
  await assert.rejects(() => coderRunHandler({}), /prompt is required/);
});

test(
  'coderRunHandler: rejects an out-of-project-root cwd via the MCP sandbox',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key' }, async () => {
    setRestricted(true);
    try {
      await assert.rejects(
        () => coderRunHandler({ prompt: 'do something', cwd: '/etc' }, { spawn: fakeSpawnReplayingFixture() }),
        /outside the project root/,
      );
    } finally {
      setRestricted(false);
    }
  }),
);

test(
  'coderRunHandler: an in-sandbox cwd is allowed through to the fake engine',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    setRestricted(true);
    try {
      const result = await coderRunHandler(
        { prompt: 'do something', cwd: '.' },
        { spawn: fakeSpawnReplayingFixture() },
      );
      const envelope = JSON.parse(result);
      assert.equal(envelope.exit_reason, 'end_turn');
    } finally {
      setRestricted(false);
    }
  }),
);

test(
  'coderRunHandler: isolate:true + an out-of-root cwd does NOT reject on the cwd — cwd is ignored whenever isolate is set',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    const repoRoot = initRepo();
    const origRoot = process.env.TRISS_PROJECT_ROOT;
    process.env.TRISS_PROJECT_ROOT = repoRoot;
    setRestricted(true);
    try {
      // cwd points outside the sandbox, but isolate:true means it's never
      // actually used (runCoderRun ignores cwd when isolating) — this
      // must NOT throw "outside the project root".
      const result = await coderRunHandler(
        { prompt: 'do something', cwd: '/etc', isolate: true, session: 'mcp-isolate-cwd' },
        { spawn: fakeSpawnReplayingFixture() },
      );
      const envelope = JSON.parse(result);
      assert.equal(envelope.exit_reason, 'end_turn');
    } finally {
      setRestricted(false);
      if (origRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = origRoot;
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }),
);

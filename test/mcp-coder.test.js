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
import { readFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

import { listTools } from '../src/mcp/tools.js';
import { coderRunHandler, coderStatusHandler } from '../src/mcp/handlers.js';
import { setRestricted } from '../src/safety.js';
import { fakeEffectiveOpenCodeConfig } from './_opencode-effective-config.js';

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

function fakeCoderRunDeps(spawn = fakeSpawnReplayingFixture()) {
  return {
    spawn,
    effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
    credentialModeParentEnv: {
      TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION: '1',
    },
  };
}

// Isolates ZHIPU_API_KEY (and, for cwd-based tests, HOME/TRISS_PROJECT_ROOT)
// from this repo's own configured key in .triss.env.
function withIsolatedEnv(vars, fn) {
  return async () => {
    const tempHome = realpathSync(mkdtempSync(join(tmpdir(), 'triss-mcp-coder-home-')));
    const fullVars = {
      HOME: tempHome,
      TRISS_PROJECT_ROOT: tempHome,
      TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION: '1',
      ...vars,
    };
    const saved = {};
    for (const k of Object.keys(fullVars)) saved[k] = process.env[k];
    for (const [k, v] of Object.entries(fullVars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn(tempHome);
    } finally {
      for (const k of Object.keys(fullVars)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(tempHome, { recursive: true, force: true });
    }
  };
}

// ─── listTools gating ────────────────────────────────────────────────────────

test(
  'listTools: triss_coder_* tools are hidden when NO provider key is set',
  // All four credentials cleared — gating is coderCredentialReady() (any key),
  // so an ambient OPENCODE/MOONSHOT/KIMI key would otherwise keep the tools
  // visible.
  withIsolatedEnv(
    {
      ZHIPU_API_KEY: undefined,
      OPENCODE_API_KEY: undefined,
      MOONSHOT_API_KEY: undefined,
      KIMI_API_KEY: undefined,
    },
    async () => {
    // Run from an empty tmp HOME/cwd so no .triss.env / global .env can
    // reintroduce a key via getConfig()'s loadEnvFiles() call.
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
        'expected no coder tools without any provider key',
      );
    } finally {
      process.chdir(origCwd);
      process.env.HOME = origHome;
      rmSync(dir, { recursive: true, force: true });
    }
    },
  ),
);

test(
  'listTools: triss_coder_* tools appear for a zen-only setup (OPENCODE_API_KEY, no ZHIPU_API_KEY)',
  withIsolatedEnv({ ZHIPU_API_KEY: undefined, OPENCODE_API_KEY: 'sk-zen-fake' }, async () => {
    // Empty HOME/cwd so .triss.env can't reintroduce ZHIPU_API_KEY — the point
    // is that OPENCODE_API_KEY alone lights up the coder tools.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-mcp-coder-zen-')));
    const origCwd = process.cwd();
    const origHome = process.env.HOME;
    process.env.HOME = dir;
    process.chdir(dir);
    try {
      const names = (await listTools()).map((t) => t.name);
      assert.ok(names.includes('triss_coder_run'), 'coder tools visible with OPENCODE_API_KEY only');
      assert.ok(names.includes('triss_coder_status'));
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

// ─── transition (component) MCP additions ─────────────────────────────────────

test(
  'listTools: triss_coder_run exposes allowBestEffortCallerWorktree (default-false opt-in)',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key' }, async () => {
    const tools = await listTools();
    const run = tools.find((t) => t.name === 'triss_coder_run');
    assert.ok('allowBestEffortCallerWorktree' in run.inputSchema.properties);
    const prop = run.inputSchema.properties.allowBestEffortCallerWorktree;
    assert.equal(prop.type, 'boolean');
    assert.ok(/default FALSE/.test(prop.description), 'the opt-in is documented as default-false');
  }),
);

test(
  'listTools: triss_coder_result_list and triss_coder_result_clean appear with a provider key',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key' }, async () => {
    const tools = await listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('triss_coder_result_list'));
    assert.ok(names.includes('triss_coder_result_clean'));
    const clean = tools.find((t) => t.name === 'triss_coder_result_clean');
    assert.deepEqual(clean.inputSchema.required, ['run_id']);
    assert.equal(clean.inputSchema.properties.run_id.pattern, '^run-[0-9a-f]{32}$');
  }),
);

test(
  'coderResultCleanHandler: validates the run-id grammar before any removal',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key' }, async () => {
    const { coderResultCleanHandler } = await import('../src/mcp/handlers.js');
    await assert.rejects(() => coderResultCleanHandler({ run_id: 'task-a' }), /run-<32 lowercase hex>/);
    await assert.rejects(() => coderResultCleanHandler({}), /run-<32 lowercase hex>/);
  }),
);

// ─── triss_coder_status ──────────────────────────────────────────────────────

test(
  'coderStatusHandler: reports key presence without ever printing the value',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-super-secret-value-do-not-print' }, async () => {
    const text = await coderStatusHandler();
    assert.match(text, /ZHIPU_API_KEY: configured/);
    assert.ok(!text.includes('zk-super-secret-value-do-not-print'), 'the raw key must never appear in tool output');
    // Every provider credential the tool's description promises must have a
    // presence line — a Kimi/Moonshot-only user needs the signal too.
    assert.match(text, /MOONSHOT_API_KEY: (configured|not set)/);
    assert.match(text, /KIMI_API_KEY: (configured|not set)/);
    assert.match(text, /Engine:/);
    assert.match(text, /opencode\.json \[global\]/);
    assert.match(text, /opencode\.json \[local\]/);
    assert.match(text, /Worktrees \(\.triss\/wt\): \d+ live/);
  }),
);

test(
  'coderStatusHandler: a Moonshot-only setup reports its key as configured, never the value',
  withIsolatedEnv(
    { ZHIPU_API_KEY: undefined, MOONSHOT_API_KEY: 'mk-super-secret-value-do-not-print' },
    async () => {
      const text = await coderStatusHandler();
      assert.match(text, /ZHIPU_API_KEY: missing/);
      assert.match(text, /MOONSHOT_API_KEY: configured/);
      assert.ok(!text.includes('mk-super-secret-value-do-not-print'), 'the raw key must never appear in tool output');
    },
  ),
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
  withIsolatedEnv(
    {
      ZHIPU_API_KEY: 'zk-fake-test-key',
      OPENCODE_API_KEY: 'sk-zen-fake',
      TRISS_USAGE_LOG: '0',
      // Pin the unpriced routing deterministically so these envelope assertions
      // (engine-reported zero is NOT known $0) hold on any machine, regardless
      // of this repo's or the global .triss.env. The pinned opencode/* route
      // needs an OPENCODE key to pass credential gating, so a fake one is set
      // alongside it.
      TRISS_CODER_MODEL: 'opencode/deepseek-v4-flash-free',
    },
    async (tempHome) => {
    const result = await coderRunHandler(
      { prompt: 'print hello via a shell echo', cwd: tempHome },
      fakeCoderRunDeps(),
    );
    const envelope = JSON.parse(result);
    assert.equal(envelope.engine, 'opencode');
    assert.equal(envelope.exit_reason, 'end_turn');
    assert.equal(envelope.final_text, '`hello`');
    // v2 usage contract (docs/usage-accounting.md, "Coder envelope"). Deprecated
    // aliases keep their pre-existing meaning and values (303 / 19)...
    assert.equal(envelope.usage.prompt_tokens, 303);
    assert.equal(envelope.usage.completion_tokens, 19);
    // ...alongside the canonical tokens/cost/schema_version members. The model
    // in play is pinned by withIsolatedEnv's TRISS_CODER_MODEL to an unpriced
    // opencode/* route, so the engine-reported zero is NOT a known $0.
    assert.equal(envelope.usage.schema_version, 2);
    assert.equal(envelope.usage.usage_status, 'reported');
    assert.equal(envelope.usage.tokens.input_uncached, 303);
    assert.equal(envelope.usage.tokens.cache_read, 14272);
    assert.equal(envelope.usage.tokens.input_total, 14575);
    assert.equal(envelope.usage.tokens.output_visible, 19);
    assert.equal(envelope.usage.tokens.output_total, 34);
    assert.equal(envelope.usage.cost.reported_total_usd, 0);
    assert.equal(envelope.usage.cost.reported_total_source, 'engine');
    assert.equal(envelope.usage.cost.total_usd, null);
    assert.equal(envelope.usage.cost.source, 'unknown');
    assert.equal(envelope.usage.cost.complete, false);
  }),
);

test(
  'coderRunHandler: applies the generous MCP default timeout of 1500s',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    // Verified indirectly: a fake spawn that captures the moment it's
    // invoked can't see the timeout value directly (it's internal to
    // spawnEngine), so we assert the documented default via the source
    // constant instead of re-deriving it from timing.
    const src = readFileSync(new URL('../src/mcp/handlers.js', import.meta.url), 'utf8');
    assert.match(src, /CODER_MCP_DEFAULT_TIMEOUT\s*=\s*1500/);
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
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async (tempHome) => {
    setRestricted(true);
    try {
      const result = await coderRunHandler(
        { prompt: 'do something', cwd: tempHome },
        fakeCoderRunDeps(),
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
        fakeCoderRunDeps(),
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

// ─── Phase 6 step 4: engine selection over MCP ───────────────────────────────

test(
  'listTools: triss_coder_run schema exposes an `engine` enum [opencode, crush]',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key' }, async () => {
    const tools = await listTools();
    const run = tools.find((t) => t.name === 'triss_coder_run');
    const engineProp = run.inputSchema.properties.engine;
    assert.ok(engineProp, 'engine property must exist on triss_coder_run');
    assert.equal(engineProp.type, 'string');
    // Phase 5: the engine enum must list all three engines — opencode2 is
    // the V2 beta (docs/engines/opencode2.md); a client discovering the tool schema
    // must never interpret plain `opencode` as V2.
    assert.deepEqual(engineProp.enum, ['opencode', 'opencode2', 'crush']);
    // isolate stays OPTIONAL with NO schema default — the undefined tristate
    // must reach runCoderRun (opencode resolves undefined -> isolate OFF;
    // crush resolves undefined -> isolate ON, since crush 0.1.3's config
    // allowlist is inert and the worktree is its reliable safety layer).
    assert.ok(!('default' in run.inputSchema.properties.isolate));
  }),
);

test(
  'coderRunHandler: forwards `engine` straight through to runCoderRun opts',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key' }, async () => {
    const seen = [];
    const spyRun = async (_prompt, opts) => {
      seen.push(opts);
    };
    // spawnSync stubbed so the engine-aware sandbox check's gitRepoRoot call
    // short-circuits (no real git); runCoderRun itself is the spy.
    await coderRunHandler(
      { prompt: 'do something', engine: 'crush' },
      { runCoderRun: spyRun, spawnSync: () => ({ status: 1, stdout: '', error: null }) },
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].engine, 'crush');
  }),
);

test(
  'triss_coder_run exposes and forwards one-shot provider + small_model',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key' }, async () => {
    const tools = await listTools();
    const run = tools.find((tool) => tool.name === 'triss_coder_run');
    assert.deepEqual(run.inputSchema.properties.provider.enum, [
      'zai',
      'worker',
      'opencode-zen',
      'opencode-go',
      'moonshot',
      'kimi-for-coding',
    ]);
    assert.equal(
      run.inputSchema.properties.model.pattern,
      '^[^\\s/]+/[^\\s/](?:[^\\s]*[^\\s/])?$',
    );
    assert.equal(run.inputSchema.properties.small_model.type, 'string');
    assert.equal(
      run.inputSchema.properties.small_model.pattern,
      '^[^\\s/]+/[^\\s/](?:[^\\s]*[^\\s/])?$',
    );

    const seen = [];
    await coderRunHandler(
      {
        prompt: 'do something',
        provider: 'zai',
        model: 'zai-coding-plan/glm-5.2',
        small_model: 'zai-coding-plan/glm-5-turbo',
      },
      {
        runCoderRun: async (_prompt, opts) => seen.push(opts),
        spawnSync: () => ({ status: 1, stdout: '', error: null }),
      },
    );
    assert.equal(seen[0].provider, 'zai');
    assert.equal(seen[0].smallModel, 'zai-coding-plan/glm-5-turbo');
  }),
);

test(
  'coderRunHandler forwards MCP cancellation to the engine lifecycle',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key' }, async () => {
    const controller = new AbortController();
    let seenSignal;
    await coderRunHandler(
      { prompt: 'do something' },
      {
        signal: controller.signal,
        runCoderRun: async (_prompt, _opts, deps) => {
          seenSignal = deps.abortSignal;
        },
        spawnSync: () => ({ status: 1, stdout: '', error: null }),
      },
    );
    assert.equal(seenSignal, controller.signal);
  }),
);

test(
  'coderRunHandler: leaves isolate UNDEFINED when the caller omits it (the tristate reaches runCoderRun)',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key' }, async () => {
    const seen = [];
    const spyRun = async (_prompt, opts) => {
      seen.push(opts);
    };
    await coderRunHandler(
      { prompt: 'do something' },
      { runCoderRun: spyRun, spawnSync: () => ({ status: 1, stdout: '', error: null }) },
    );
    // Must be strictly undefined, NOT coerced to a boolean — runCoderRun's
    // `opts.isolate === undefined ? engine === 'crush' : !!opts.isolate`
    // depends on the tristate (opencode: undefined -> OFF; crush: undefined
    // -> ON). The handler must not pre-resolve it.
    assert.equal(seen[0].isolate, undefined);
  }),
);

test(
  'triss_coder_run schema exposes protectCredentials with the best_effort_raw default documented',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key' }, async () => {
    const tools = await listTools();
    const run = tools.find((t) => t.name === 'triss_coder_run');
    assert.ok(run, 'the coder run tool is listed');
    const prop = run.inputSchema.properties.protectCredentials;
    assert.ok(prop, 'protectCredentials must be part of the input schema');
    assert.equal(prop.type, 'boolean');
    assert.match(prop.description, /best_effort_raw/u);
  }),
);

test(
  'coderRunHandler forwards protectCredentials to runCoderRun (default false)',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key' }, async () => {
    const seen = [];
    const spyRun = async (_prompt, opts) => {
      seen.push(opts);
    };
    await coderRunHandler(
      { prompt: 'do something', protectCredentials: true },
      { runCoderRun: spyRun, spawnSync: () => ({ status: 1, stdout: '', error: null }) },
    );
    assert.equal(seen[0].protectCredentials, true);

    await coderRunHandler(
      { prompt: 'do something' },
      { runCoderRun: spyRun, spawnSync: () => ({ status: 1, stdout: '', error: null }) },
    );
    // Omitted -> explicitly false so the downstream resolver contract stays
    // boolean-clean over MCP.
    assert.equal(seen[1].protectCredentials, false);
  }),
);

test(
  'coderRunHandler: a BARE crush call (no isolate arg) sandbox-checks the worktree root — crush isolates by default',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key' }, async () => {
    // crush defaults to isolate-ON (its permissions.run config is inert and
    // denied bash deadlocks, so the disposable worktree is the reliable safety
    // layer). So a bare crush call with NO isolate arg must resolve
    // effectiveIsolate=true and fire the worktree-root sandbox check. Build a
    // repo, set the sandbox to a SUBDIR — crush's worktree would land at the
    // repo root, OUTSIDE the subdir sandbox. The engine-aware check must catch
    // this even though the caller passed no isolate.
    const repoRoot = initRepo();
    const sandboxDir = join(repoRoot, 'sandbox-subdir');
    mkdirSync(sandboxDir);
    const origRoot = process.env.TRISS_PROJECT_ROOT;
    process.env.TRISS_PROJECT_ROOT = sandboxDir;
    setRestricted(true);
    try {
      await assert.rejects(
        () =>
          coderRunHandler(
            { prompt: 'do something', engine: 'crush', session: 'mcp-iso-default' },
            { spawn: fakeSpawnReplayingFixture() },
          ),
        /outside the project root/,
      );
    } finally {
      setRestricted(false);
      if (origRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = origRoot;
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }),
);

test(
  'coderRunHandler: a bare opencode call (no isolate arg) does NOT fire the worktree-root check — opencode defaults isolate-OFF',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key', TRISS_USAGE_LOG: '0' }, async () => {
    // opencode's deny-first opencode.json is the dependable safety layer, so
    // opencode stays isolate-OFF by default. A bare opencode call with an
    // out-of-root cwd must reject on the CWD (cwd is checked only when NOT
    // isolating), proving effectiveIsolate resolved false.
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
  'coderRunHandler: engine "crush" with isolate:true still sandbox-checks the worktree root (explicit flag)',
  withIsolatedEnv({ ZHIPU_API_KEY: 'zk-fake-test-key' }, async () => {
    // isolate:true is now redundant for crush (it isolates by default) but the
    // explicit flag still resolves effectiveIsolate=true and fires the check.
    // Build a repo, set the sandbox to a SUBDIR — crush's worktree would land
    // at the repo root, OUTSIDE the subdir sandbox.
    const repoRoot = initRepo();
    const sandboxDir = join(repoRoot, 'sandbox-subdir');
    mkdirSync(sandboxDir);
    const origRoot = process.env.TRISS_PROJECT_ROOT;
    process.env.TRISS_PROJECT_ROOT = sandboxDir;
    setRestricted(true);
    try {
      await assert.rejects(
        () =>
          coderRunHandler(
            { prompt: 'do something', engine: 'crush', isolate: true, session: 'mcp-iso-check' },
            { spawn: fakeSpawnReplayingFixture() },
          ),
        /outside the project root/,
      );
    } finally {
      setRestricted(false);
      if (origRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
      else process.env.TRISS_PROJECT_ROOT = origRoot;
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }),
);

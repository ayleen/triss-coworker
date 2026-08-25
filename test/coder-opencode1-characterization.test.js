/**
 * coder-opencode1-characterization.test.js — Phase 1 of
 * docs/opencode2-engine-plan.md: lock the CURRENT OpenCode 1 engine behavior
 * BEFORE any opencode2 dispatch refactor moves shared code.
 *
 * These tests are the regression shield proving `--engine opencode` keeps its
 * exact binary, argv, env allowlist, session-map shape, event fold, and
 * envelope identity while engine #3 (opencode2) slots in. They characterize
 * what the code does TODAY — a failing test here means the V1 contract
 * drifted, not that the test is wrong. Existing suites already cover fold
 * semantics and envelope shape in depth (coder-envelope.test.js); this file
 * adds the surfaces those suites do NOT pin: the exact spawned command line,
 * the env allowlist as forwarded today, the flat session-map persistence and
 * its best-effort (non-CAS) concurrency behavior, engine precedence text,
 * and the V1 pin identity. Best-effort raw mode is explicit in this fixture;
 * it still uses the canonical transient provider route and exposes only the
 * selected raw credential.
 *
 * No live network, no real opencode/npm calls.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OPENCODE_INVALID_MINIMUM_CODE,
  OPENCODE_MIN_VERSION_DEFAULT,
  OPENCODE_PIN,
  OPENCODE_SUPPORTED_FLOOR,
  assertOpencodeMinimumVersion,
  opencodeVersionMeetsMinimum,
  resolveCoderEngine,
  resolveOpencodeVersionPolicy,
  runCoderRun as runCoderRunProduction,
} from '../src/commands/coder.js';
import { fakeEffectiveOpenCodeConfig } from './_opencode-effective-config.js';

const runCoderRun = (prompt, opts, deps = {}) => runCoderRunProduction(
  prompt,
  opts,
  {
    effectiveConfigSpawnSync: fakeEffectiveOpenCodeConfig,
    ...deps,
  },
);

// ─── helpers ────────────────────────────────────────────────────────────────

function withEnv(vars, fn) {
  return async () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'triss-opencode1-home-'));
    const fullVars = {
      HOME: tempHome,
      TRISS_PROJECT_ROOT: tempHome,
      TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION: '1',
      ...vars,
    };
    const saved = {};
    for (const k of Object.keys(fullVars)) saved[k] = process.env[k];
    Object.assign(process.env, fullVars);
    try {
      await fn();
    } finally {
      for (const k of Object.keys(fullVars)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      rmSync(tempHome, { recursive: true, force: true });
    }
  };
}

function stdoutCapture() {
  const chunks = [];
  return {
    stdoutWrite: (s) => {
      chunks.push(s);
      return true;
    },
    text: () => chunks.join(''),
  };
}

async function withFixedDate(timestamp, fn) {
  const RealDate = globalThis.Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      super(args.length === 0 ? timestamp : args[0]);
    }

    static now() {
      return RealDate.parse(timestamp);
    }
  }
  globalThis.Date = FixedDate;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

// Fake spawn that records the exact (cmd, argv, options) and replays a
// fixture stream. `killProcess` is NOT injected: runCoderRun defaults it to
// noInjectedProcessGroup when spawnFn !== nodeSpawn, whose ESRCH-coded throw
// marks the group gone — the same seam the existing suites rely on.
function recordingSpawn(streamText, { code = 0, signal = null } = {}) {
  const calls = [];
  const spawnFn = (cmd, argv, options) => {
    calls.push({ cmd, argv, options });
    const child = new EventEmitter();
    child.pid = 555001;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.end(streamText);
      child.stderr.end('');
      setImmediate(() => child.emit('close', code, signal));
    });
    return child;
  };
  return { spawnFn, calls };
}

const MINIMAL_SUCCESS_STREAM = [
  JSON.stringify({ type: 'step_start', sessionID: 'ses_char_v1_0001' }),
  JSON.stringify({ type: 'text', sessionID: 'ses_char_v1_0001', part: { text: 'done' } }),
  JSON.stringify({
    type: 'step_finish',
    sessionID: 'ses_char_v1_0001',
    part: { tokens: { input: 11, output: 7, cache: { read: 3, write: 0 } }, cost: { total: 0.002 } },
  }),
].join('\n') + '\n';

const COMPLETE_PEAK_STREAM = [
  JSON.stringify({ type: 'step_start', sessionID: 'ses_char_peak_0001' }),
  JSON.stringify({ type: 'text', sessionID: 'ses_char_peak_0001', part: { text: 'done' } }),
  JSON.stringify({
    type: 'step_finish',
    sessionID: 'ses_char_peak_0001',
    part: { tokens: { input: 11, output: 7, reasoning: 0, total: 21, cache: { read: 3, write: 0 } }, cost: 0 },
  }),
].join('\n') + '\n';

const NO_SESSION_ID_STREAM = [
  JSON.stringify({ type: 'step_start', part: { type: 'step-start', id: 'prt_no_id' } }),
  JSON.stringify({ type: 'text', part: { text: 'done without an id' } }),
].join('\n') + '\n';

// ─── engine resolution & pin ────────────────────────────────────────────────

test('characterization: default engine is opencode; precedence explicit > env > default', () => {
  const prev = process.env.TRISS_CODER_ENGINE;
  try {
    delete process.env.TRISS_CODER_ENGINE;
    assert.equal(resolveCoderEngine({}), 'opencode');
    process.env.TRISS_CODER_ENGINE = 'crush';
    assert.equal(resolveCoderEngine({}), 'crush');
    assert.equal(resolveCoderEngine({ engine: 'opencode' }), 'opencode');
  } finally {
    if (prev === undefined) delete process.env.TRISS_CODER_ENGINE;
    else process.env.TRISS_CODER_ENGINE = prev;
  }
});

test('characterization: unknown engine error lists opencode, opencode2, crush (Phase 3 widened the enum)', () => {
  const prev = process.env.TRISS_CODER_ENGINE;
  try {
    delete process.env.TRISS_CODER_ENGINE;
    assert.throws(
      () => resolveCoderEngine({ engine: 'nope' }),
      /Unknown coder engine "nope" — valid values: opencode, opencode2, crush/,
    );
  } finally {
    if (prev === undefined) delete process.env.TRISS_CODER_ENGINE;
    else process.env.TRISS_CODER_ENGINE = prev;
  }
});

test('characterization: V1 supported-floor surface is opencode-ai >= 1.18.22 (module constants; env override path exercised via TRISS_CODER_OPENCODE_VERSION in status tests)', () => {
  // The default minimum IS the immutable floor; OPENCODE_PIN stays as the
  // compatibility alias for it.
  assert.equal(OPENCODE_PIN, '1.18.22');
  assert.equal(OPENCODE_MIN_VERSION_DEFAULT, '1.18.22');
  assert.equal(OPENCODE_SUPPORTED_FLOOR, '1.18.22');
});

test('OpenCode V1 authorization follows the shared >= contract under the DEFAULT minimum (owner decision 2026-08)', () => {
  // One resolver backs installation AND one-shot credential authorization:
  // installed >= effective minimum (default = immutable floor 1.18.22).
  // 1.18.21 and lower are rejected; the floor itself, newer stable, and newer
  // major releases are accepted — semver ordering IS the contract now.
  const savedMinimum = process.env.TRISS_CODER_OPENCODE_VERSION;
  delete process.env.TRISS_CODER_OPENCODE_VERSION;
  try {
    const reject = (installed) => {
      const p = resolveOpencodeVersionPolicy(installed);
      assert.equal(p.configValid, true, String(installed));
      assert.equal(p.installedCompatible, false, String(installed));
      assert.equal(p.effectiveMinimum, OPENCODE_SUPPORTED_FLOOR, String(installed));
      return p;
    };
    const accept = (installed) => {
      const p = resolveOpencodeVersionPolicy(installed);
      assert.equal(p.configValid, true, String(installed));
      assert.equal(p.reason, 'compatible', String(installed));
      assert.equal(p.installedCompatible, true, String(installed));
      return p;
    };

    assert.equal(reject('1.18.21').reason, 'below_minimum');
    accept('1.18.22');            // exact floor
    accept('1.18.23');            // newer patch
    accept('1.19.0');             // newer stable
    accept('2.0.0');              // newer major
    // Prerelease/garbage/missing never parse as compatible.
    reject('1.18.22-beta.1');
    reject('garbage');
    reject('');
    reject(null);

    // The pure comparator agrees with the resolver on the same matrix.
    assert.equal(opencodeVersionMeetsMinimum('1.18.21'), false);
    assert.equal(opencodeVersionMeetsMinimum('1.18.22'), true);
    assert.equal(opencodeVersionMeetsMinimum('1.19.0'), true);
    assert.equal(opencodeVersionMeetsMinimum('2.0.0'), true);
  } finally {
    if (savedMinimum === undefined) delete process.env.TRISS_CODER_OPENCODE_VERSION;
    else process.env.TRISS_CODER_OPENCODE_VERSION = savedMinimum;
  }
});

test('OpenCode V1 installation comparator stays a pure range check over the configured minimum', () => {
  // Installation-target concern; it shares the same >= contract as one-shot
  // credential authorization (see resolveOpencodeVersionPolicy).
  assert.equal(OPENCODE_MIN_VERSION_DEFAULT, '1.18.22');
  assert.equal(opencodeVersionMeetsMinimum('1.18.21'), false);
  assert.equal(opencodeVersionMeetsMinimum('1.18.22'), true);
  assert.equal(opencodeVersionMeetsMinimum('garbage'), false);
  assert.equal(opencodeVersionMeetsMinimum('1.18.22-beta.1'), false);
  assert.equal(opencodeVersionMeetsMinimum('1.18.22', ' 1.18.22 '), false);
  assert.equal(opencodeVersionMeetsMinimum('1.18.22', 'bad-minimum'), false);
});

test('OpenCode V1 invalid or below-floor minimum fails closed without an unsafe install suggestion', () => {
  const belowFloor = `below the supported floor ${OPENCODE_SUPPORTED_FLOOR}`;
  const cases = [
    // Malformed / whitespace values keep their existing typed rejection.
    { minimum: 'bad-minimum', reason: null },
    { minimum: ` ${OPENCODE_SUPPORTED_FLOOR} `, reason: null },
    // Canonical values BELOW the immutable supported floor are policy
    // violations too: they must never weaken the floor.
    { minimum: '1.18.21', reason: belowFloor },
    { minimum: '1.0.0', reason: belowFloor },
  ];
  for (const { minimum, reason } of cases) {
    assert.throws(
      () => assertOpencodeMinimumVersion(minimum),
      (error) => {
        assert.equal(error.code, OPENCODE_INVALID_MINIMUM_CODE);
        assert.match(error.message, /canonical stable x\.y\.z/);
        if (reason) assert.ok(error.message.includes(reason));
        assert.doesNotMatch(error.message, /npm install/);
        assert.doesNotMatch(error.message, /@bad-minimum/);
        return true;
      },
    );
  }
  // The floor itself and anything above it remain valid configuration.
  assertOpencodeMinimumVersion(OPENCODE_SUPPORTED_FLOOR);
  assertOpencodeMinimumVersion('2.0.0');
});

test(
  'V1 one-shot invalid minimum rejects before spawn and never suggests @bad-minimum',
  withEnv(
    {
      OPENCODE_API_KEY: 'sk-zen-invalid-minimum',
      ZHIPU_API_KEY: 'zk-invalid-minimum',
      TRISS_CODER_OPENCODE_VERSION: 'bad-minimum',
      TRISS_USAGE_LOG: '0',
    },
    async () => {
      let spawnCalls = 0;
      await assert.rejects(
        () => runCoderRun(
          'invalid minimum',
          { provider: 'opencode-zen', model: 'opencode/deepseek-v4-flash-free' },
          {
            disableCredentialProxy: true,
            spawn: () => {
              spawnCalls += 1;
              throw new Error('engine spawn must not be reached');
            },
            spawnSync: () => ({ status: 0, stdout: '1.19.0', error: null }),
          },
        ),
        (error) => {
          assert.equal(error.code, OPENCODE_INVALID_MINIMUM_CODE);
          assert.doesNotMatch(error.message, /npm install/);
          assert.doesNotMatch(error.message, /@bad-minimum/);
          return true;
        },
      );
      assert.equal(spawnCalls, 0);
    },
  ),
);

test(
  'V1 one-shot rejects a below-floor configured minimum even when the installed build satisfies the default floor',
  withEnv(
    {
      OPENCODE_API_KEY: 'sk-zen-below-floor',
      ZHIPU_API_KEY: 'zk-below-floor',
      TRISS_CODER_OPENCODE_VERSION: '1.16.0',
      TRISS_USAGE_LOG: '0',
    },
    async () => {
      let spawnCalls = 0;
      await assert.rejects(
        () => runCoderRun(
          'below floor',
          { provider: 'opencode-zen', model: 'opencode/deepseek-v4-flash-free' },
          {
            disableCredentialProxy: true,
            spawn: () => {
              spawnCalls += 1;
              throw new Error('engine spawn must not be reached');
            },
            // The installed binary IS the default floor build — the configured
            // below-floor minimum still fails closed first.
            spawnSync: () => ({ status: 0, stdout: OPENCODE_PIN, error: null }),
          },
        ),
        (error) => {
          assert.equal(error.code, OPENCODE_INVALID_MINIMUM_CODE);
          assert.ok(
            error.message.includes(`below the supported floor ${OPENCODE_SUPPORTED_FLOOR}`),
          );
          return true;
        },
      );
      assert.equal(spawnCalls, 0);
    },
  ),
);

test(
  'V1 one-shot rejects before spawn when the configured minimum is below floor and the install is older too',
  withEnv(
    {
      OPENCODE_API_KEY: 'sk-zen-old-pair',
      ZHIPU_API_KEY: 'zk-old-pair',
      TRISS_USAGE_LOG: '0',
    },
    async () => {
      for (const [configuredMinimum, installed] of [['1.18.21', '1.18.21'], ['1.0.0', '1.18.0']]) {
        process.env.TRISS_CODER_OPENCODE_VERSION = configuredMinimum;
        let spawnCalls = 0;
        await assert.rejects(
          () => runCoderRun(
            `old pair ${configuredMinimum}`,
            { provider: 'opencode-zen', model: 'opencode/deepseek-v4-flash-free' },
            {
              disableCredentialProxy: true,
              spawn: () => {
                spawnCalls += 1;
                throw new Error('engine spawn must not be reached');
              },
              spawnSync: (c, a) => (c === 'opencode' && a[0] === '--version'
                ? { status: 0, stdout: installed, error: null }
                : { status: 1, stdout: '', error: null }),
            },
          ),
          (error) => {
            assert.equal(error.code, OPENCODE_INVALID_MINIMUM_CODE);
            assert.match(error.message, /canonical stable x\.y\.z/);
            return true;
          },
        );
        assert.equal(spawnCalls, 0, `${configuredMinimum} + ${installed} must reject before spawn`);
      }
    },
  ),
);

test(
  'V1 one-shot whitespace-configured minimum keeps the typed rejection at run level',
  withEnv(
    {
      OPENCODE_API_KEY: 'sk-zen-ws-minimum',
      ZHIPU_API_KEY: 'zk-ws-minimum',
      TRISS_CODER_OPENCODE_VERSION: ` ${OPENCODE_SUPPORTED_FLOOR} `,
      TRISS_USAGE_LOG: '0',
    },
    async () => {
      let spawnCalls = 0;
      await assert.rejects(
        () => runCoderRun(
          'whitespace minimum',
          { provider: 'opencode-zen', model: 'opencode/deepseek-v4-flash-free' },
          {
            disableCredentialProxy: true,
            spawn: () => {
              spawnCalls += 1;
              throw new Error('engine spawn must not be reached');
            },
            spawnSync: () => ({ status: 0, stdout: OPENCODE_PIN, error: null }),
          },
        ),
        (error) => {
          assert.equal(error.code, OPENCODE_INVALID_MINIMUM_CODE);
          return true;
        },
      );
      assert.equal(spawnCalls, 0);
    },
  ),
);

test(
  'V1 one-shot accepts newer stable and newer major builds under the default minimum, and rejects an installed version below the floor — all before isolation and spawn',
  withEnv(
    {
      OPENCODE_API_KEY: 'sk-zen-floor-matrix',
      ZHIPU_API_KEY: 'zk-floor-matrix',
      TRISS_USAGE_LOG: '0',
    },
    async () => {
      delete process.env.TRISS_CODER_OPENCODE_VERSION;
      // Owner decision (2026-08): authorization is installed >= the effective
      // minimum (default = immutable floor 1.18.22). Newer stable (1.19.0) and
      // newer major (2.0.0) releases are authorized; 1.18.21 is not.
      for (const installed of ['1.19.0', '2.0.0']) {
        const rec = recordingSpawn(MINIMAL_SUCCESS_STREAM);
        await runCoderRun(
          `accepted ${installed}`,
          { provider: 'opencode-zen', model: 'opencode/deepseek-v4-flash-free' },
          {
            disableCredentialProxy: true,
            spawn: rec.spawnFn,
            spawnSync: (c, a) => (c === 'opencode' && a[0] === '--version'
              ? { status: 0, stdout: installed, error: null }
              : { status: 1, stdout: '', error: null }),
            stdoutWrite: () => true,
          },
        );
        assert.equal(rec.calls.length, 1);
        assert.ok(rec.calls[0].argv.includes('--pure'), `${installed} one-shot run reaches spawn with --pure`);
      }

      let spawnCalls = 0;
      await assert.rejects(
        () => runCoderRun(
          'below floor installed',
          { provider: 'opencode-zen', model: 'opencode/deepseek-v4-flash-free' },
          {
            disableCredentialProxy: true,
            spawn: () => {
              spawnCalls += 1;
              throw new Error('engine spawn must not be reached');
            },
            spawnSync: (c, a) => (c === 'opencode' && a[0] === '--version'
              ? { status: 0, stdout: '1.18.21', error: null }
              : { status: 1, stdout: '', error: null }),
          },
        ),
        (error) => {
          // The gate fires BEFORE any worktree/isolation machinery: a
          // rejected version must leave no side effects behind.
          assert.doesNotMatch(error.message, /worktree/i);
          assert.ok(
            error.message.includes(`require opencode >= ${OPENCODE_SUPPORTED_FLOOR}`),
          );
          assert.match(error.message, /found 1\.18\.21/);
          return true;
        },
      );
      assert.equal(spawnCalls, 0);
    },
  ),
);

test(
  'V1 one-shot enforces a VALID raised configured minimum (installed below it rejects before spawn)',
  withEnv(
    {
      OPENCODE_API_KEY: 'sk-zen-raised-minimum',
      ZHIPU_API_KEY: 'zk-raised-minimum',
      TRISS_CODER_OPENCODE_VERSION: '2.0.0',
      TRISS_USAGE_LOG: '0',
    },
    async () => {
      let spawnCalls = 0;
      await assert.rejects(
        () => runCoderRun(
          'raised minimum',
          { provider: 'opencode-zen', model: 'opencode/deepseek-v4-flash-free' },
          {
            disableCredentialProxy: true,
            spawn: () => {
              spawnCalls += 1;
              throw new Error('engine spawn must not be reached');
            },
            // The floor build would satisfy the DEFAULT minimum but not the
            // valid stricter configured one.
            spawnSync: (c, a) => (c === 'opencode' && a[0] === '--version'
              ? { status: 0, stdout: OPENCODE_MIN_VERSION_DEFAULT, error: null }
              : { status: 1, stdout: '', error: null }),
          },
        ),
        (error) => {
          assert.doesNotMatch(error.message, /worktree/i);
          assert.match(error.message, /require opencode >= 2\.0\.0/);
          assert.ok(error.message.includes(`found ${OPENCODE_MIN_VERSION_DEFAULT}`));
          return true;
        },
      );
      assert.equal(spawnCalls, 0);
    },
  ),
);

test(
  'V1 one-shot succeeds when the installed build satisfies the default supported floor',
  withEnv(
    {
      OPENCODE_API_KEY: 'sk-zen-floor-exact',
      ZHIPU_API_KEY: 'zk-floor-exact',
      TRISS_USAGE_LOG: '0',
    },
    async () => {
      delete process.env.TRISS_CODER_OPENCODE_VERSION;
      const rec = recordingSpawn(MINIMAL_SUCCESS_STREAM);
      await runCoderRun(
        'floor exact',
        { provider: 'opencode-zen', model: 'opencode/deepseek-v4-flash-free' },
        {
          disableCredentialProxy: true,
          spawn: rec.spawnFn,
          spawnSync: (c, a) => (c === 'opencode' && a[0] === '--version'
            ? { status: 0, stdout: OPENCODE_MIN_VERSION_DEFAULT, error: null }
            : { status: 1, stdout: '', error: null }),
          stdoutWrite: () => true,
        },
      );
      assert.equal(rec.calls.length, 1);
      assert.ok(rec.calls[0].argv.includes('--pure'), 'floor-satisfying one-shot run reaches spawn with --pure');
    },
  ),
);

test(
  'V1 lookup rollback always closes the credential proxy when lease release fails permanently',
  withEnv(
    {
      ZHIPU_API_KEY: 'fixture-provider-value-v1',
      TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2',
      TRISS_USAGE_LOG: '0',
    },
    async () => {
      let proxy;
      let releaseCalls = 0;
      let closeProxy;
      await assert.rejects(
        () => runCoderRun('lookup rollback', { engine: 'opencode', session: 'lookup-fails' }, {
          // Pin the already-resolved mode; the characterization must not
          // inherit a runner/global acknowledgement from another test.
          credentialMode: 'protected_proxy',
          spawnSync: () => ({ status: 1, stdout: '', stderr: '' }),
          startCredentialProxy: async () => {
            proxy = {
              closed: new Promise((resolve) => { closeProxy = resolve; }),
              revoke: () => closeProxy(),
            };
            return proxy;
          },
          reserveSessionRow: async () => ({ finalizationAttempted: false }),
          lookupSessionRealId: () => { throw new Error('lookup failed'); },
          releaseSessionRow: async () => {
            releaseCalls += 1;
            throw new Error('permanent rollback release failure');
          },
        }),
        /permanent rollback release failure/,
      );
      assert.equal(releaseCalls, 1);
      assert.ok(proxy, 'the protected run must have started a parent-owned proxy');
      assert.equal(
        await Promise.race([
          proxy.closed.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 250)),
        ]),
        true,
        'proxy cleanup must complete before the rollback error returns',
      );
    },
  ),
);

// ─── exact spawned command line + env allowlist (fake spawn seam) ───────────

test(
  'characterization: bare V1 run spawns `opencode run <prompt> --format json --auto --model <m>` with the allowlist env',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-char-1',
      OPENCODE_API_KEY: 'sk-zen-char',
      TRISS_USAGE_LOG: '0',
      TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2',
    },
    async () => {
      const rec = recordingSpawn(MINIMAL_SUCCESS_STREAM);
      const capture = stdoutCapture();
      await runCoderRun('do the thing', {}, {
        disableCredentialProxy: true,
        spawn: rec.spawnFn,
        spawnSync: () => ({ status: 1, stdout: '', error: null }),
        stdoutWrite: capture.stdoutWrite,
      });
      assert.equal(rec.calls.length, 1);
      const { cmd, argv, options } = rec.calls[0];
      assert.equal(cmd, 'opencode');
      assert.deepEqual(argv, [
        'run',
        'do the thing',
        '--format', 'json',
        '--auto',
        '--model', 'triss-coder-transient/glm-5.2',
        '--agent', 'coder',
      ]);
      // detached POSIX group + piped stdio, exactly as today
      assert.equal(options.detached, true);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      // env allowlist: base five + the ONE selected credential. HOME/LANG/
      // LC_ALL/TMPDIR ride only when present in the parent env.
      assert.equal(options.env.PATH, process.env.PATH);
      assert.equal(options.env.ZHIPU_API_KEY, 'zk-char-1');
      assert.equal(options.env.OPENCODE_API_KEY, undefined);
      const transientConfig = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
      assert.equal(transientConfig.model, 'triss-coder-transient/glm-5.2');
      assert.equal(transientConfig.provider['triss-coder-transient'].options.apiKey, '{env:ZHIPU_API_KEY}');
      assert.equal(transientConfig.provider['triss-coder-transient'].options.baseURL, 'https://api.z.ai/api/coding/paas/v4');
      for (const banned of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'TRISS_WORKER_API_KEY']) {
        assert.equal(options.env[banned], undefined, `${banned} must not be forwarded`);
      }
      const envelope = JSON.parse(capture.text().trim());
      assert.equal(envelope.engine, 'opencode');
      assert.equal(envelope.credential_mode, 'best_effort_raw');
      assert.equal(envelope.exit_reason, 'end_turn');
    },
  ),
);

test(
  'lifecycle V1: no native session id finalizes before stdout and downgrades persistence',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-lifecycle-no-id',
      TRISS_USAGE_LOG: '0',
      TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2',
    },
    async () => {
      const slug = 'v1-no-session-id';
      const inventoryPath = join(
        process.env.TRISS_PROJECT_ROOT,
        '.triss', 'engine-sessions-v2', 'opencode', '.inventory.json',
      );
      const chunks = [];
      let rowsAtStdout;
      await runCoderRun('no id', { session: slug }, {
        spawn: recordingSpawn(NO_SESSION_ID_STREAM).spawnFn,
        spawnSync: () => ({ status: 1, stdout: '', error: null }),
        ownerTuple: { pid: 711, processStartId: 'ps-v1-no-id', bootId: 'boot-v1-no-id' },
        stdoutWrite: (s) => {
          rowsAtStdout = JSON.parse(readFileSync(inventoryPath, 'utf8')).entries;
          chunks.push(s);
        },
      });
      const envelope = JSON.parse(chunks.join('').trim());
      assert.equal(envelope.session_id, null);
      assert.equal(envelope.session_persistence, 'ephemeral_downgraded');
      assert.ok(envelope.warnings.some((w) => /not confirmed/i.test(w)));
      assert.deepEqual(rowsAtStdout, [], 'finalization must finish before stdout');
    },
  ),
);

test(
  'lifecycle V1: mapping mismatch and owner mismatch retain the row and emit no envelope',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-lifecycle-mismatch',
      TRISS_USAGE_LOG: '0',
      TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2',
    },
    async () => {
      const root = process.env.TRISS_PROJECT_ROOT;
      const ownerTuple = { pid: 712, processStartId: 'ps-v1-mismatch', bootId: 'boot-v1-mismatch' };
      const runCase = async (slug, mutate) => {
        const capture = stdoutCapture();
        await assert.rejects(
          () => runCoderRun('mismatch', { session: slug }, {
            spawn: recordingSpawn(MINIMAL_SUCCESS_STREAM).spawnFn,
            spawnSync: () => ({ status: 1, stdout: '', error: null }),
            ownerTuple,
            stdoutWrite: capture.stdoutWrite,
            logUsage: () => mutate(root, slug),
          }),
          /completion retained row for recovery/,
        );
        assert.equal(capture.text(), '', 'fail-closed finalization must not print an envelope');
        const inventory = JSON.parse(readFileSync(
          join(root, '.triss', 'engine-sessions-v2', 'opencode', '.inventory.json'),
          'utf8',
        ));
        assert.equal(inventory.entries.length, 1);
        assert.equal(inventory.entries[0].state, 'running');
        return inventory.entries[0];
      };

      await runCase('v1-map-mismatch', (projectRoot, sessionSlug) => {
        const storePath = join(projectRoot, '.triss', 'sessions.json');
        const store = JSON.parse(readFileSync(storePath, 'utf8'));
        store.engines.opencode[sessionSlug] = 'ses_foreign_v1';
        writeFileSync(storePath, JSON.stringify(store) + '\n');
      });

      // Remove the retained first case so the second case can use a free slot
      // without broad cleanup; this is a test-only recovery fixture operation.
      rmSync(join(root, '.triss', 'engine-sessions-v2', 'opencode', '.inventory.json'));
      rmSync(join(root, '.triss', 'sessions.json'));

      await runCase('v1-owner-mismatch', (projectRoot) => {
        const inventoryPath = join(projectRoot, '.triss', 'engine-sessions-v2', 'opencode', '.inventory.json');
        const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'));
        inventory.entries[0].pid = 799;
        writeFileSync(inventoryPath, JSON.stringify(inventory) + '\n');
      });
    },
  ),
);

test(
  'characterization: V1 precomputed DeepSeek cost uses the run timestamp for peak pricing',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-char-peak',
      TRISS_USAGE_LOG: '0',
    },
    async () => withFixedDate('2026-08-20T01:00:00.000Z', async () => {
      const capture = stdoutCapture();
      await runCoderRun('peak pricing', { model: 'deepseek-v4-flash' }, {
        disableCredentialProxy: true,
        spawn: recordingSpawn(COMPLETE_PEAK_STREAM).spawnFn,
        spawnSync: () => ({ status: 1, stdout: '', error: null }),
        stdoutWrite: capture.stdoutWrite,
      });
      const envelope = JSON.parse(capture.text().trim());
      const expected = (11 * 0.22e-6 + 3 * 0.007e-6 + 7 * 0.66e-6) * 2;
      assert.ok(Math.abs(envelope.usage.cost.total_usd - expected) < 1e-12, JSON.stringify(envelope.usage));
    }),
  ),
);

test(
  'characterization: one-shot provider run adds --pure and protected routing overlay without widening env access',
  withEnv(
    {
      OPENCODE_API_KEY: 'sk-zen-char',
      ZHIPU_API_KEY: 'zk-char-1',
      TRISS_USAGE_LOG: '0',
    },
    async () => {
      const rec = recordingSpawn(MINIMAL_SUCCESS_STREAM);
      const capture = stdoutCapture();
      await runCoderRun(
        'task',
        { provider: 'opencode-zen', model: 'opencode/deepseek-v4-flash-free' },
        {
          disableCredentialProxy: true,
          spawn: rec.spawnFn,
          // one-shot provider runs demand a V1 build at or above the effective
          // minimum via detectOpencodeVersion; the fake binary reports exactly
          // the default supported floor.
          spawnSync: (c, a) => {
            if (c === 'opencode' && a[0] === '--version') {
              // Authorization is the shared >= contract: the floor build
              // passes the protected one-shot gate.
              return { status: 0, stdout: OPENCODE_MIN_VERSION_DEFAULT, error: null };
            }
            return { status: 1, stdout: '', error: null };
          },
          stdoutWrite: capture.stdoutWrite,
        },
      );
      const { argv, options } = rec.calls[0];
      assert.ok(argv.includes('--pure'), 'one-shot provider run carries --pure');
      const overlay = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
      assert.equal(overlay.model, 'triss-coder-transient/deepseek-v4-flash-free');
      assert.equal(overlay.small_model, 'triss-coder-transient/deepseek-v4-flash-free');
      assert.equal(overlay.provider['triss-coder-transient'].npm, '@ai-sdk/openai-compatible');
      assert.equal(overlay.provider['triss-coder-transient'].options.apiKey, '{env:OPENCODE_API_KEY}');
      assert.match(overlay.provider['triss-coder-transient'].options.baseURL, /^https:\/\/opencode\.ai\/zen\/v1$/);
      // only the selected provider's key rides along
      assert.equal(options.env.OPENCODE_API_KEY, 'sk-zen-char');
      assert.equal(options.env.ZHIPU_API_KEY, undefined);
    },
  ),
);

// ─── session map: flat {slug: realId} today, written after a successful run ─

test(
  'characterization: --session <slug> reads the flat map, unknown slug spawns with NO --session flag, then persists the ses_ id',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-char-1',
      TRISS_USAGE_LOG: '0',
      TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2',
    },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'oc1-sess-'));
      const prevRoot = process.env.TRISS_PROJECT_ROOT;
      process.env.TRISS_PROJECT_ROOT = dir;
      try {
        const rec = recordingSpawn(MINIMAL_SUCCESS_STREAM);
        const capture = stdoutCapture();
        await runCoderRun('hello', { session: 'alpha' }, {
          spawn: rec.spawnFn,
          spawnSync: () => ({ status: 1, stdout: '', error: null }),
          stdoutWrite: capture.stdoutWrite,
        });
        // unknown slug -> first run passes NO --session to opencode
        assert.equal(rec.calls[0].argv.includes('--session'), false);
        // after the run the real id landed in the VERSIONED engine-namespaced
        // store (Phase 3/4 contract: {version:2, engines:{opencode:{...}}})
        const raw = JSON.parse(readFileSync(join(dir, '.triss', 'sessions.json'), 'utf8'));
        assert.equal(raw.version, 2);
        assert.equal(raw.engines.opencode.alpha, 'ses_char_v1_0001');
        // and a second run with the known slug forwards --session <real-id>
        const rec2 = recordingSpawn(MINIMAL_SUCCESS_STREAM);
        await runCoderRun('again', { session: 'alpha' }, {
          spawn: rec2.spawnFn,
          spawnSync: () => ({ status: 1, stdout: '', error: null }),
          stdoutWrite: capture.stdoutWrite,
        });
        const sIdx = rec2.calls[0].argv.indexOf('--session');
        assert.notEqual(sIdx, -1, 'known slug forwards --session <real-id>');
        assert.equal(rec2.calls[0].argv[sIdx + 1], 'ses_char_v1_0001');
      } finally {
        if (prevRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
        else process.env.TRISS_PROJECT_ROOT = prevRoot;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  ),
);

test(
  'characterization: sequential writers to the flat session map both survive (persist re-reads fresh; the unsolvable window is between that read and the rename — best-effort, NOT CAS)',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-char-1',
      TRISS_USAGE_LOG: '0',
      TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2',
    },
    async () => {
      // What CAN be pinned deterministically: writer B, starting after writer
      // A fully persisted, re-reads the file inside its own persist and keeps
      // A's mapping. The lost-update counterexample itself (two read-modify-
      // write cycles overlapping between read and atomic rename) has no
      // injection seam today — it is the window Phase 4's locked store
      // closes; see docs/opencode2-engine-plan.md "Session contract".
      const dir = mkdtempSync(join(tmpdir(), 'oc1-seq-'));
      const prevRoot = process.env.TRISS_PROJECT_ROOT;
      process.env.TRISS_PROJECT_ROOT = dir;
      try {
        const cap = stdoutCapture();
        const deps = (stream) => ({
          spawn: recordingSpawn(stream).spawnFn,
          spawnSync: () => ({ status: 1, stdout: '', error: null }),
          stdoutWrite: cap.stdoutWrite,
        });
        await runCoderRun('a', { session: 'sa' }, deps(
          MINIMAL_SUCCESS_STREAM.replace(/ses_char_v1_0001/g, 'ses_seq_a'),
        ));
        await runCoderRun('b', { session: 'sb' }, deps(
          MINIMAL_SUCCESS_STREAM.replace(/ses_char_v1_0001/g, 'ses_seq_b'),
        ));
        const finalMap = JSON.parse(readFileSync(join(dir, '.triss', 'sessions.json'), 'utf8'));
        assert.equal(finalMap.engines.opencode.sa, 'ses_seq_a');
        assert.equal(finalMap.engines.opencode.sb, 'ses_seq_b');
      } finally {
        if (prevRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
        else process.env.TRISS_PROJECT_ROOT = prevRoot;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  ),
);

// ─── envelope identity ──────────────────────────────────────────────────────

test(
  'characterization: V1 envelope carries engine "opencode", schema v2 usage, and session ids verbatim',
  withEnv(
    {
      ZHIPU_API_KEY: 'zk-char-1',
      TRISS_USAGE_LOG: '0',
      TRISS_CODER_MODEL: 'zai-coding-plan/glm-5.2',
    },
    async () => {
      const rec = recordingSpawn(MINIMAL_SUCCESS_STREAM);
      const capture = stdoutCapture();
      await runCoderRun('x', {}, {
        disableCredentialProxy: true,
        spawn: rec.spawnFn,
        // version probe fails -> engineVersion falls back to the pin string
        spawnSync: () => ({ status: 1, stdout: '', error: null }),
        stdoutWrite: capture.stdoutWrite,
      });
      const envelope = JSON.parse(capture.text().trim());
      assert.equal(envelope.engine, 'opencode');
      assert.equal(envelope.engine_version, '1.18.22');
      assert.equal(envelope.session_id, 'ses_char_v1_0001');
      assert.equal(envelope.usage.schema_version, 2);
      assert.equal(envelope.usage.tokens.input_uncached, 11);
      assert.equal(envelope.usage.tokens.output_visible, 7);
      assert.equal(envelope.usage.tokens.input_total, 14);
      assert.deepEqual(envelope.warnings, [
        'TRISS_CODER_CREDENTIAL_ISOLATION_DOWNGRADED: best_effort_raw credential mode is active by default; the selected raw provider credential may be read by same-UID engine code, plugins, tools, or shell commands. Pass --protect-credentials to enable protected_proxy.',
      ]);
    },
  ),
);

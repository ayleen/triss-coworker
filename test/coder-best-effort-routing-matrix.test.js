/**
 * Deterministic best-effort raw routing acceptance matrix.
 *
 * Every provider route is exercised through both OpenCode engines with a
 * fake child process. No provider/API/network calls are made. The matrix is
 * deliberately about the raw-credential routing seam only; the acknowledged
 * OpenCode 2 path uses best-effort mode against the isolated HOME below, so
 * normal plugins, agents, tools, and shell policy remain available while the
 * envelope reports the credential-isolation downgrade.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  OPENCODE_PIN,
  runCoderRun,
} from '../src/commands/coder.js';
import {
  CODER_PROVIDER_REGISTRY,
  CODER_TRANSIENT_PROVIDER_ALIAS,
  resolveCoderProviderRoute,
} from '../src/coder-providers.js';

const DOWNGRADE_WARNING =
  'TRISS_CODER_CREDENTIAL_ISOLATION_DOWNGRADED: best_effort_raw passes the selected raw provider credential to a same-UID engine child; repository code, plugins, tools, and shell commands may read or print it.';
const CREDENTIAL_ENVS = [
  'TRISS_WORKER_API_KEY',
  'ZHIPU_API_KEY',
  'OPENCODE_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
];

const CASES = [
  {
    kind: 'worker',
    provider: 'worker',
    model: 'triss-worker/deepseek-v4-flash',
    credentialEnv: 'TRISS_WORKER_API_KEY',
    credential: 'raw-worker-matrix-key',
  },
  {
    kind: 'zai',
    provider: 'zai',
    model: 'zai-coding-plan/glm-5.2',
    credentialEnv: 'ZHIPU_API_KEY',
    credential: 'raw-zai-matrix-key',
  },
  {
    kind: 'opencode-zen',
    provider: 'opencode-zen',
    model: 'opencode/deepseek-v4-flash-free',
    credentialEnv: 'OPENCODE_API_KEY',
    credential: 'raw-zen-matrix-key',
  },
  {
    kind: 'opencode-go',
    provider: 'opencode-go',
    // This model exercises the Go Responses API/package override as well as
    // the ordinary OpenCode Go provider route.
    model: 'opencode-go/muse-spark-1.2-contributor',
    credentialEnv: 'OPENCODE_API_KEY',
    credential: 'raw-go-matrix-key',
  },
  {
    kind: 'moonshot',
    provider: 'moonshot',
    model: 'moonshotai/kimi-k2.7-code',
    credentialEnv: 'MOONSHOT_API_KEY',
    credential: 'raw-moonshot-matrix-key',
  },
  {
    kind: 'kimi-for-coding',
    provider: 'kimi-for-coding',
    model: 'kimi-for-coding/k3',
    credentialEnv: 'KIMI_API_KEY',
    credential: 'raw-kimi-matrix-key',
  },
];

// A real executable path is required by detectOpenCode2; the child itself is
// still the in-memory fake below, so this file is never executed.
const FAKE_OPENCODE2 = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'triss-best-effort-matrix-bin-'));
  const path = join(dir, 'opencode2');
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return { dir, path };
})();

test.after(() => {
  rmSync(FAKE_OPENCODE2.dir, { recursive: true, force: true });
});

const SUCCESS_STREAM = (session) => [
  JSON.stringify({ type: 'step_start', sessionID: session }),
  JSON.stringify({ type: 'text', sessionID: session, part: { text: 'matrix ok' } }),
  JSON.stringify({
    type: 'step_finish',
    sessionID: session,
    part: { tokens: { input: 3, output: 2, cache: { read: 0, write: 0 } }, cost: { total: 0.001 } },
  }),
].join('\n') + '\n';

const V1_ALLOWLIST = {
  '*': 'deny',
  'git status': 'allow',
  'git diff*': 'allow',
  'git log*': 'allow',
  'ls*': 'allow',
  'node --test*': 'allow',
  'npm test*': 'allow',
  'npm run test*': 'allow',
};

const TOOL_SUCCESS_STREAM = (session) => [
  JSON.stringify({ type: 'step_start', sessionID: session }),
  JSON.stringify({
    type: 'tool_use',
    sessionID: session,
    part: { tool: 'shell', state: { status: 'completed' } },
  }),
  JSON.stringify({ type: 'text', sessionID: session, part: { text: 'tool fixture ok' } }),
  JSON.stringify({
    type: 'step_finish',
    sessionID: session,
    part: { tokens: { input: 4, output: 3, cache: { read: 0, write: 0 } }, cost: { total: 0.001 } },
  }),
].join('\n') + '\n';

function recordingSpawn(stream) {
  const calls = [];
  const spawnFn = (cmd, argv, options) => {
    calls.push({ cmd, argv, options });
    const child = new EventEmitter();
    child.pid = 789001;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.end(stream);
      child.stderr.end('');
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  };
  return { calls, spawnFn };
}

function recordingSpawnSync(cmd, args) {
  if (cmd === 'opencode' && args?.[0] === '--version') {
    return { status: 0, stdout: `${OPENCODE_PIN}\n`, stderr: '', error: null };
  }
  if (cmd === 'which' && args?.[0] === 'opencode2') {
    return { status: 0, stdout: `${FAKE_OPENCODE2.path}\n`, stderr: '', error: null };
  }
  // macOS realpathSync canonicalizes /var to /private/var, so match the V2
  // probe by its command shape rather than the pre-canonicalized temp path.
  if (cmd !== 'opencode' && args?.[0] === '--version') {
    return { status: 0, stdout: 'opencode2 v0.0.0-beta-17794\n', stderr: '', error: null };
  }
  if (args?.[0] === 'run' && args?.[1] === '--help') {
    return {
      status: 0,
      stdout: '--standalone --format --auto --model\n',
      stderr: '',
      error: null,
    };
  }
  return { status: 1, stdout: '', stderr: '', error: null };
}

function makeIsolatedHome() {
  const home = mkdtempSync(join(tmpdir(), 'triss-best-effort-matrix-home-'));
  const configDir = join(home, '.config', 'opencode');
  mkdirSync(configDir, { recursive: true });
  // V2's normal preflight is intentionally still active. There are no
  // plugins/agents/tools in this HOME and the shell policy is deny-everything.
  writeFileSync(join(configDir, 'opencode.json'), JSON.stringify({
    permission: { bash: { '*': 'deny' } },
  }));
  return home;
}

function makeV2AllowlistFixture(home) {
  const project = join(home, 'v2-allowlist-fixture');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'opencode.json'), JSON.stringify({
    permission: { bash: V1_ALLOWLIST },
  }));
  mkdirSync(join(project, '.opencode', 'agents'), { recursive: true });
  writeFileSync(join(project, '.opencode', 'agents', 'fixture-agent.md'), '---\nmode: primary\n---\nfixture agent\n');
  mkdirSync(join(project, '.opencode', 'tools'), { recursive: true });
  writeFileSync(join(project, '.opencode', 'tools', 'fixture-tool.js'), 'export default async () => "fixture tool";\n');
  return project;
}

async function withMatrixEnvironment(home, routeCase, fn, { bestEffort = true } = {}) {
  const names = [
    'HOME',
    'TRISS_PROJECT_ROOT',
    'TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION',
    'TRISS_USAGE_LOG',
    'TRISS_CODER_MODEL',
    'TRISS_CODER_SMALL_MODEL',
    'TRISS_WORKER_BASE_URL',
    ...CREDENTIAL_ENVS,
  ];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.HOME = home;
  process.env.TRISS_PROJECT_ROOT = home;
  // Exercise the reloadable file source rather than mutating process.env
  // after config.js has captured the real parent shell environment.
  delete process.env.TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION;
  writeFileSync(
    join(home, '.triss.env'),
    `TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=${bestEffort ? '1' : '0'}\n`,
  );
  process.env.TRISS_USAGE_LOG = '0';
  delete process.env.TRISS_CODER_MODEL;
  delete process.env.TRISS_CODER_SMALL_MODEL;
  delete process.env.TRISS_WORKER_BASE_URL;
  for (const env of CREDENTIAL_ENVS) {
    process.env[env] = env === routeCase.credentialEnv
      ? routeCase.credential
      : `unrelated-${env}`;
  }
  try {
    await fn();
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

test('runtime credential mode reloads file edits and deletions between calls in one process', async () => {
  const home = makeIsolatedHome();
  const routeCase = CASES.find(({ kind }) => kind === 'opencode-go');
  const envPath = join(home, '.triss.env');
  try {
    await withMatrixEnvironment(home, routeCase, async () => {
      const run = async (label) => {
        const { calls, spawnFn } = recordingSpawn(SUCCESS_STREAM(`ses_reload_${label}`));
        const output = [];
        await runCoderRun(label, {
          engine: 'opencode',
          provider: routeCase.provider,
          model: routeCase.model,
        }, {
          spawn: spawnFn,
          spawnSync: recordingSpawnSync,
          credentialProxyOptions: {
            fetchImpl: async () => new Response('{}', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          },
          stdoutWrite: (chunk) => output.push(chunk),
        });
        assert.equal(calls.length, 1);
        return {
          child: calls[0],
          envelope: JSON.parse(output.join('').trim()),
        };
      };

      writeFileSync(envPath, 'TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=1\n');
      const rawFirst = await run('raw-first');
      assert.equal(rawFirst.envelope.credential_mode, 'best_effort_raw');
      assert.equal(rawFirst.envelope.execution_capabilities.credential_isolation, 'unavailable');
      assert.equal(rawFirst.child.options.env.OPENCODE_API_KEY, routeCase.credential);

      writeFileSync(envPath, 'TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=0\n');
      const protectedAfterEdit = await run('protected-after-edit');
      assert.equal(protectedAfterEdit.envelope.credential_mode, 'protected_proxy');
      assert.equal(protectedAfterEdit.envelope.execution_capabilities.credential_isolation, 'best_effort');
      assert.notEqual(protectedAfterEdit.child.options.env.OPENCODE_API_KEY, routeCase.credential);

      writeFileSync(envPath, 'TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=1\n');
      await run('raw-before-delete');
      writeFileSync(envPath, '');
      const protectedAfterDelete = await run('protected-after-delete');
      assert.equal(protectedAfterDelete.envelope.credential_mode, 'protected_proxy');
      assert.notEqual(protectedAfterDelete.child.options.env.OPENCODE_API_KEY, routeCase.credential);

      writeFileSync(envPath, 'TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=1\n');
      const rawAfterAdd = await run('raw-after-add');
      assert.equal(rawAfterAdd.envelope.credential_mode, 'best_effort_raw');
      assert.equal(rawAfterAdd.child.options.env.OPENCODE_API_KEY, routeCase.credential);
    }, { bestEffort: false });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function modelFromArgv(argv) {
  const index = argv.indexOf('--model');
  assert.notEqual(index, -1, 'engine argv must pin --model');
  return argv[index + 1];
}

for (const engine of ['opencode', 'opencode2']) {
  test(`best_effort_raw routing matrix: ${engine} × all six providers`, async (t) => {
    for (const routeCase of CASES) {
      await t.test(routeCase.kind, async () => {
        const home = makeIsolatedHome();
        try {
          await withMatrixEnvironment(home, routeCase, async () => {
            const route = resolveCoderProviderRoute(routeCase.model);
            assert.ok(route, routeCase.model);
            const expectedBaseURL = `${route.endpoint}${route.pathPrefix === '/' ? '' : route.pathPrefix}`;
            const { calls, spawnFn } = recordingSpawn(SUCCESS_STREAM(`ses_matrix_${engine}_${routeCase.kind}`));
            let proxyOptionsTouched = false;
            const credentialProxyOptions = {
              get host() {
                proxyOptionsTouched = true;
                return '127.0.0.1';
              },
              get port() {
                proxyOptionsTouched = true;
                return 0;
              },
            };
            const output = [];
            await runCoderRun(
              'best effort routing matrix',
              { engine, provider: routeCase.provider, model: routeCase.model },
              {
                spawn: spawnFn,
                spawnSync: recordingSpawnSync,
                credentialProxyOptions,
                stdoutWrite: (chunk) => output.push(chunk),
              },
            );

            assert.equal(calls.length, 1, 'one fake engine child must be spawned');
            assert.equal(proxyOptionsTouched, false, 'raw mode must not start or require the parent proxy');
            const child = calls[0];
            const envelope = JSON.parse(output.join('').trim());
            const childModel = modelFromArgv(child.argv);
            const transientModel = `${CODER_TRANSIENT_PROVIDER_ALIAS}/${route.modelId}`;
            assert.equal(childModel, transientModel, 'argv must use the transient provider alias');

            const config = JSON.parse(child.options.env.OPENCODE_CONFIG_CONTENT);
            const transient = config.provider[CODER_TRANSIENT_PROVIDER_ALIAS];
            assert.equal(config.model, transientModel);
            assert.equal(transient.options.baseURL, expectedBaseURL);
            assert.equal(transient.options.apiKey, `{env:${routeCase.credentialEnv}}`);
            assert.equal(transient.npm, route.package);
            assert.equal(route.protocol, routeCase.kind === 'kimi-for-coding'
              ? 'anthropic_messages'
              : routeCase.kind === 'opencode-go'
                ? 'openai_responses'
                : 'openai_chat');

            assert.equal(child.options.env[routeCase.credentialEnv], routeCase.credential);
            for (const env of CREDENTIAL_ENVS) {
              if (env !== routeCase.credentialEnv) assert.equal(child.options.env[env], undefined, `${env} leaked`);
            }
            assert.equal(envelope.execution_capabilities.credential_isolation, 'unavailable');
            assert.equal(envelope.credential_mode, 'best_effort_raw');
            assert.equal(envelope.requested_model, routeCase.model);
            assert.equal(envelope.requested_provider, routeCase.kind);
            assert.equal(envelope.engine_model, transientModel);
            assert.equal(envelope.engine_provider, CODER_TRANSIENT_PROVIDER_ALIAS);
            // The Go Responses row and the worker row intentionally share
            // this identity contract with the other transports; protocol and
            // credential details stay in the child config/env assertions.
            assert.equal(envelope.warnings.filter((warning) => warning === DOWNGRADE_WARNING).length, 1);
            assert.equal(JSON.stringify(envelope).split(DOWNGRADE_WARNING).length - 1, 1);
          });
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      });
    }
  });
}

test('opencode2 best_effort_raw fixture: V1 allowlist plus discovered agent/tool reaches the fake child', async () => {
  const routeCase = CASES.find(({ kind }) => kind === 'opencode-go');
  const home = makeIsolatedHome();
  try {
    const project = makeV2AllowlistFixture(home);
    await withMatrixEnvironment(home, routeCase, async () => {
      const { calls, spawnFn } = recordingSpawn(TOOL_SUCCESS_STREAM('ses_allowlist_fixture'));
      const output = [];
      let proxyOptionsTouched = false;
      let threw = null;
      try {
        await runCoderRun(
          'run the fixture tool',
          { engine: 'opencode2', provider: routeCase.provider, model: routeCase.model, cwd: project },
          {
            spawn: spawnFn,
            spawnSync: recordingSpawnSync,
            credentialProxyOptions: {
              get host() {
                proxyOptionsTouched = true;
                return '127.0.0.1';
              },
              get port() {
                proxyOptionsTouched = true;
                return 0;
              },
            },
            stdoutWrite: (chunk) => output.push(chunk),
          },
        );
      } catch (err) {
        threw = err;
      }
      // This is intentionally an executable acceptance assertion: the
      // acknowledged raw mode must reach the child instead of applying the
      // protected deny-everything executable-surface gate.
      assert.equal(threw, null, threw ? `best_effort_raw fixture rejected: ${threw.message}` : undefined);
      assert.equal(calls.length, 1, 'the acknowledged best-effort fixture must reach one child spawn');
      assert.equal(proxyOptionsTouched, false, 'best-effort fixture must not require the parent proxy');
      const envelope = JSON.parse(output.join('').trim());
      assert.equal(envelope.exit_reason, 'end_turn');
      assert.equal(envelope.execution_capabilities.credential_isolation, 'unavailable');
      assert.equal(envelope.warnings.filter((warning) => warning === DOWNGRADE_WARNING).length, 1);
      assert.equal(envelope.final_text, 'tool fixture ok');
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('opencode2 protected fixture: the same V1 allowlist plus agent/tool rejects before spawn', async () => {
  const routeCase = CASES.find(({ kind }) => kind === 'opencode-go');
  const home = makeIsolatedHome();
  try {
    const project = makeV2AllowlistFixture(home);
    await withMatrixEnvironment(home, routeCase, async () => {
      const { calls, spawnFn } = recordingSpawn(TOOL_SUCCESS_STREAM('ses_protected_fixture'));
      let threw = null;
      await assert.rejects(
        () => runCoderRun(
          'run the fixture tool',
          { engine: 'opencode2', provider: routeCase.provider, model: routeCase.model, cwd: project },
          { spawn: spawnFn, spawnSync: recordingSpawnSync },
        ),
        (err) => {
          threw = err;
          return true;
        },
      );
      assert.ok(threw);
      assert.equal(calls.length, 0, 'protected mode must reject before any child spawn');
      assert.match(threw.message, /custom tool|agent|deny-everything|allow\/ask/iu);
    }, { bestEffort: false });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('best_effort_raw matrix registry remains aligned with all six provider kinds', () => {
  assert.deepEqual(
    new Set(CASES.map(({ kind }) => kind)),
    new Set(Object.keys(CODER_PROVIDER_REGISTRY)),
  );
});

test('best_effort_raw unknown Zen/Go models use built-in metadata on both engines', async (t) => {
  for (const engine of ['opencode', 'opencode2']) {
    for (const kind of ['opencode-zen', 'opencode-go']) {
      await t.test(`${engine} × ${kind}`, async () => {
        const home = makeIsolatedHome();
        const routeCase = CASES.find((candidate) => candidate.kind === kind);
        const prefix = kind === 'opencode-zen' ? 'opencode' : 'opencode-go';
        const model = `${prefix}/newly-published-model`;
        try {
          await withMatrixEnvironment(home, routeCase, async () => {
            const { calls, spawnFn } = recordingSpawn(SUCCESS_STREAM(`ses_raw_unknown_${engine}_${kind}`));
            await runCoderRun('raw unknown route', {
              engine,
              provider: kind,
              model,
            }, {
              spawn: spawnFn,
              spawnSync: recordingSpawnSync,
              stdoutWrite: () => {},
            });
            assert.equal(calls.length, 1);
            assert.equal(modelFromArgv(calls[0].argv), model);
            const config = JSON.parse(calls[0].options.env.OPENCODE_CONFIG_CONTENT);
            assert.equal(config.model, model);
            assert.equal(config.provider, undefined, 'raw unknown models must use the built-in provider');
            assert.equal(calls[0].options.env.OPENCODE_API_KEY, routeCase.credential);
          });
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      });
    }
  }
});

test('best_effort_raw V1 chooses built-in metadata when either persisted role is unaudited', async (t) => {
  const routeCase = CASES.find(({ kind }) => kind === 'opencode-go');
  const cases = [
    {
      name: 'audited main plus unaudited small',
      main: 'opencode-go/deepseek-v4-flash',
      small: 'opencode-go/newly-published-model',
      builtIn: true,
    },
    {
      name: 'unaudited Go main plus persisted Moonshot small',
      main: 'opencode-go/newly-published-model',
      small: 'moonshotai/kimi-k2.7-code',
      builtIn: true,
      normalizedSmall: true,
    },
    {
      name: 'unaudited main plus audited small',
      main: 'opencode-go/newly-published-model',
      small: 'opencode-go/deepseek-v4-flash',
      builtIn: true,
    },
    {
      name: 'both audited',
      main: 'opencode-go/deepseek-v4-flash',
      small: 'opencode-go/muse-spark-1.2-contributor',
      builtIn: false,
    },
  ];
  for (const row of cases) {
    await t.test(row.name, async () => {
      const home = makeIsolatedHome();
      try {
        await withMatrixEnvironment(home, routeCase, async () => {
          process.env.TRISS_CODER_MODEL = row.main;
          process.env.TRISS_CODER_SMALL_MODEL = row.small;
          const { calls, spawnFn } = recordingSpawn(SUCCESS_STREAM(`ses_raw_small_${row.name}`));
          await runCoderRun('raw persisted pair', {
            engine: 'opencode',
          }, {
            spawn: spawnFn,
            spawnSync: recordingSpawnSync,
            // Deliberately unusable proxy options: a raw built-in route must
            // never attempt to start the credential proxy.
            credentialProxyOptions: { host: '256.256.256.256', port: -1 },
            stdoutWrite: () => {},
          });
          assert.equal(calls.length, 1);
          const child = calls[0];
          const childModel = modelFromArgv(child.argv);
          if (row.builtIn) {
            assert.equal(childModel, row.main);
            const config = JSON.parse(child.options.env.OPENCODE_CONFIG_CONTENT);
            assert.deepEqual(config, {
              model: row.main,
              small_model: row.normalizedSmall ? row.main : row.small,
            });
            assert.equal(config.provider, undefined);
            if (row.normalizedSmall) {
              assert.equal(child.options.env.MOONSHOT_API_KEY, undefined);
            }
          } else {
            assert.equal(childModel, `${CODER_TRANSIENT_PROVIDER_ALIAS}/${row.main.split('/')[1]}`);
            const config = JSON.parse(child.options.env.OPENCODE_CONFIG_CONTENT);
            assert.ok(config.provider[CODER_TRANSIENT_PROVIDER_ALIAS]);
            assert.ok(config.provider[`${CODER_TRANSIENT_PROVIDER_ALIAS}-small`]);
          }
          assert.equal(child.options.env.OPENCODE_API_KEY, routeCase.credential);
        });
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});

test('V1 persisted cross-scope small roles are discarded before runtime route resolution', async (t) => {
  const cases = [
    {
      name: 'Go main plus worker small',
      routeCase: CASES.find(({ kind }) => kind === 'opencode-go'),
      main: 'opencode-go/deepseek-v4-flash',
      small: 'triss-worker/deepseek-v4-flash',
      credentialEnv: 'OPENCODE_API_KEY',
    },
    {
      name: 'Z.AI main plus worker small',
      routeCase: CASES.find(({ kind }) => kind === 'zai'),
      main: 'zai-coding-plan/glm-5.2',
      small: 'triss-worker/deepseek-v4-flash',
      credentialEnv: 'ZHIPU_API_KEY',
    },
    {
      name: 'worker main plus Go small',
      routeCase: CASES.find(({ kind }) => kind === 'worker'),
      main: 'triss-worker/deepseek-v4-flash',
      small: 'opencode-go/deepseek-v4-flash',
      credentialEnv: 'TRISS_WORKER_API_KEY',
    },
    {
      name: 'Z.AI coding-plan main plus PAYG small',
      routeCase: CASES.find(({ kind }) => kind === 'zai'),
      main: 'zai-coding-plan/glm-5.2',
      small: 'zai/glm-5-turbo',
      credentialEnv: 'ZHIPU_API_KEY',
    },
    {
      name: 'Z.AI PAYG main plus coding-plan small',
      routeCase: CASES.find(({ kind }) => kind === 'zai'),
      main: 'zai/glm-5.2',
      small: 'zai-coding-plan/glm-5-turbo',
      credentialEnv: 'ZHIPU_API_KEY',
    },
    {
      name: 'Moonshot global main plus China small',
      routeCase: CASES.find(({ kind }) => kind === 'moonshot'),
      main: 'moonshotai/kimi-k2.7-code',
      small: 'moonshotai-cn/kimi-k2.6',
      credentialEnv: 'MOONSHOT_API_KEY',
    },
    {
      name: 'Moonshot China main plus global small',
      routeCase: CASES.find(({ kind }) => kind === 'moonshot'),
      main: 'moonshotai-cn/kimi-k2.7-code',
      small: 'moonshotai/kimi-k2.6',
      credentialEnv: 'MOONSHOT_API_KEY',
    },
    {
      name: 'Go models with distinct transports keep both roles',
      routeCase: CASES.find(({ kind }) => kind === 'opencode-go'),
      main: 'opencode-go/deepseek-v4-flash',
      small: 'opencode-go/muse-spark-1.2-contributor',
      credentialEnv: 'OPENCODE_API_KEY',
      preserveSmall: true,
    },
  ];
  for (const mode of ['protected', 'best_effort_raw']) {
    for (const row of cases) {
      await t.test(`${mode}: ${row.name}`, async () => {
        const home = makeIsolatedHome();
        try {
          await withMatrixEnvironment(home, row.routeCase, async () => {
            process.env.TRISS_CODER_MODEL = row.main;
            process.env.TRISS_CODER_SMALL_MODEL = row.small;
            const { calls, spawnFn } = recordingSpawn(SUCCESS_STREAM(`ses_stale_${mode}_${row.name}`));
            await runCoderRun('stale cross-provider small', { engine: 'opencode' }, {
              spawn: spawnFn,
              spawnSync: recordingSpawnSync,
              disableCredentialProxy: mode === 'protected',
              stdoutWrite: () => {},
            });
            assert.equal(calls.length, 1);
            const child = calls[0];
            const config = JSON.parse(child.options.env.OPENCODE_CONFIG_CONTENT);
            if (row.preserveSmall) {
              assert.notEqual(config.small_model, config.model);
              assert.ok(config.provider[`${CODER_TRANSIENT_PROVIDER_ALIAS}-small`]);
            } else {
              assert.equal(config.small_model, config.model);
              assert.equal(config.provider[`${CODER_TRANSIENT_PROVIDER_ALIAS}-small`], undefined);
            }
            assert.equal(child.options.env[row.credentialEnv], row.routeCase.credential);
            assert.equal(child.options.env.TRISS_WORKER_API_KEY, row.credentialEnv === 'TRISS_WORKER_API_KEY'
              ? row.routeCase.credential
              : undefined);
            if (row.credentialEnv !== 'TRISS_WORKER_API_KEY') {
              assert.equal(child.options.env.TRISS_WORKER_API_KEY, undefined);
            }
          }, { bestEffort: mode === 'best_effort_raw' });
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      });
    }
  }
});

test('protected unknown Zen/Go models fail before spawn on both engines', async (t) => {
  for (const engine of ['opencode', 'opencode2']) {
    for (const kind of ['opencode-zen', 'opencode-go']) {
      await t.test(`${engine} × ${kind}`, async () => {
        const home = makeIsolatedHome();
        const routeCase = CASES.find((candidate) => candidate.kind === kind);
        const prefix = kind === 'opencode-zen' ? 'opencode' : 'opencode-go';
        try {
          await withMatrixEnvironment(home, routeCase, async () => {
            const { calls, spawnFn } = recordingSpawn(SUCCESS_STREAM(`ses_protected_unknown_${engine}_${kind}`));
            await assert.rejects(
              runCoderRun('protected unknown route', {
                engine,
                provider: kind,
                model: `${prefix}/newly-published-model`,
              }, {
                spawn: spawnFn,
                spawnSync: recordingSpawnSync,
              }),
              /audited protected OpenCode transport metadata|refuses to guess Chat/iu,
            );
            assert.equal(calls.length, 0);
          }, { bestEffort: false });
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      });
    }
  }
});

test('protected V1 distinct transports use two scoped loopback routes and one proxy token', async () => {
  const home = makeIsolatedHome();
  const routeCase = CASES.find(({ kind }) => kind === 'opencode-go');
  const upstreamCalls = [];
  let loopbackError = null;
  let mainBaseURL;
  let smallBaseURL;
  try {
    await withMatrixEnvironment(home, routeCase, async () => {
      const spawnFn = (_cmd, _argv, options) => {
        const child = new EventEmitter();
        child.pid = 789002;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        setImmediate(async () => {
          try {
            const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
            const main = config.provider[CODER_TRANSIENT_PROVIDER_ALIAS];
            const small = config.provider[`${CODER_TRANSIENT_PROVIDER_ALIAS}-small`];
            mainBaseURL = main.options.baseURL;
            smallBaseURL = small.options.baseURL;
            assert.notEqual(mainBaseURL, smallBaseURL);
            assert.notEqual(options.env.OPENCODE_API_KEY, routeCase.credential);
            const headers = {
              authorization: `Bearer ${options.env.OPENCODE_API_KEY}`,
              'content-type': 'application/json',
            };
            const responses = await Promise.all([
              fetch(`${mainBaseURL}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [] }),
              }),
              fetch(`${smallBaseURL}/responses`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ model: 'muse-spark-1.2-contributor', input: 'x' }),
              }),
            ]);
            assert.deepEqual(responses.map(({ status }) => status), [200, 200]);
            child.stdout.end(SUCCESS_STREAM('ses_v1_distinct_routes'));
            child.stderr.end('');
            setImmediate(() => child.emit('close', 0, null));
          } catch (err) {
            loopbackError = err;
            child.stdout.end('');
            child.stderr.end(String(err.stack || err));
            setImmediate(() => child.emit('close', 1, null));
          }
        });
        return child;
      };
      await runCoderRun('protected V1 distinct transports', {
        engine: 'opencode',
        provider: 'opencode-go',
        model: 'opencode-go/deepseek-v4-flash',
        smallModel: 'opencode-go/muse-spark-1.2-contributor',
      }, {
        spawn: spawnFn,
        spawnSync: recordingSpawnSync,
        credentialProxyOptions: {
          fetchImpl: async (url, init) => {
            upstreamCalls.push({ url: String(url), headers: init.headers, body: init.body });
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          },
        },
        stdoutWrite: () => {},
      });
    }, { bestEffort: false });
    assert.equal(loopbackError, null, loopbackError?.stack);
    assert.deepEqual(upstreamCalls.map(({ url }) => url).sort(), [
      'https://opencode.ai/zen/go/v1/chat/completions',
      'https://opencode.ai/zen/go/v1/responses',
    ]);
    for (const call of upstreamCalls) {
      assert.equal(call.headers.authorization, `Bearer ${routeCase.credential}`);
    }
    await assert.rejects(fetch(`${mainBaseURL}/chat/completions`));
    await assert.rejects(fetch(`${smallBaseURL}/responses`));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('protected Go grok-4.5 reaches the exact Responses loopback/upstream path', async () => {
  const home = makeIsolatedHome();
  const routeCase = CASES.find(({ kind }) => kind === 'opencode-go');
  const upstreamCalls = [];
  let loopbackError = null;
  try {
    await withMatrixEnvironment(home, routeCase, async () => {
      const spawnFn = (_cmd, _argv, options) => {
        const child = new EventEmitter();
        child.pid = 789004;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        setImmediate(async () => {
          try {
            const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
            const provider = config.provider[CODER_TRANSIENT_PROVIDER_ALIAS];
            assert.equal(provider.npm, '@ai-sdk/openai');
            const response = await fetch(`${provider.options.baseURL}/responses`, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${options.env.OPENCODE_API_KEY}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({ model: 'grok-4.5', input: 'x' }),
            });
            assert.equal(response.status, 200);
            child.stdout.end(SUCCESS_STREAM('ses_grok_responses'));
            child.stderr.end('');
            setImmediate(() => child.emit('close', 0, null));
          } catch (err) {
            loopbackError = err;
            child.stdout.end('');
            child.stderr.end(String(err.stack || err));
            setImmediate(() => child.emit('close', 1, null));
          }
        });
        return child;
      };
      await runCoderRun('protected Go Grok Responses', {
        engine: 'opencode',
        provider: 'opencode-go',
        model: 'opencode-go/grok-4.5',
        smallModel: 'opencode-go/grok-4.5',
      }, {
        spawn: spawnFn,
        spawnSync: recordingSpawnSync,
        credentialProxyOptions: {
          fetchImpl: async (url, init) => {
            upstreamCalls.push({ url: String(url), body: JSON.parse(init.body) });
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          },
        },
        stdoutWrite: () => {},
      });
    }, { bestEffort: false });
    assert.equal(loopbackError, null, loopbackError?.stack);
    assert.deepEqual(upstreamCalls, [{
      url: 'https://opencode.ai/zen/go/v1/responses',
      body: { model: 'grok-4.5', input: 'x' },
    }]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('protected V2 routes only main and rejects the validated-unused small model at its proxy', async () => {
  const home = makeIsolatedHome();
  const routeCase = CASES.find(({ kind }) => kind === 'opencode-go');
  const upstreamModels = [];
  let loopbackError = null;
  try {
    await withMatrixEnvironment(home, routeCase, async () => {
      const spawnFn = (_cmd, _argv, options) => {
        const child = new EventEmitter();
        child.pid = 789003;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        setImmediate(async () => {
          try {
            const config = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
            assert.equal(config.small_model, undefined);
            assert.equal(config.provider[`${CODER_TRANSIENT_PROVIDER_ALIAS}-small`], undefined);
            const main = config.provider[CODER_TRANSIENT_PROVIDER_ALIAS];
            const headers = {
              authorization: `Bearer ${options.env.OPENCODE_API_KEY}`,
              'content-type': 'application/json',
            };
            const accepted = await fetch(`${main.options.baseURL}/chat/completions`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [] }),
            });
            const rejected = await fetch(`${main.options.baseURL}/chat/completions`, {
              method: 'POST',
              headers,
              body: JSON.stringify({ model: 'muse-spark-1.2-contributor', messages: [] }),
            });
            assert.equal(accepted.status, 200);
            assert.equal(rejected.status, 403);
            child.stdout.end(SUCCESS_STREAM('ses_v2_main_only_proxy'));
            child.stderr.end('');
            setImmediate(() => child.emit('close', 0, null));
          } catch (err) {
            loopbackError = err;
            child.stdout.end('');
            child.stderr.end(String(err.stack || err));
            setImmediate(() => child.emit('close', 1, null));
          }
        });
        return child;
      };
      const output = [];
      await runCoderRun('protected V2 main-only transport', {
        engine: 'opencode2',
        provider: 'opencode-go',
        model: 'opencode-go/deepseek-v4-flash',
        smallModel: 'opencode-go/muse-spark-1.2-contributor',
      }, {
        spawn: spawnFn,
        spawnSync: recordingSpawnSync,
        credentialProxyOptions: {
          fetchImpl: async (_url, init) => {
            upstreamModels.push(JSON.parse(init.body).model);
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          },
        },
        stdoutWrite: (chunk) => output.push(chunk),
      });
      const envelope = JSON.parse(output.join('').trim());
      assert.deepEqual(envelope.small_model, {
        requested: 'opencode-go/muse-spark-1.2-contributor',
        used: false,
      });
    }, { bestEffort: false });
    assert.equal(loopbackError, null, loopbackError?.stack);
    assert.deepEqual(upstreamModels, ['deepseek-v4-flash']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

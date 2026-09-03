// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-omp-version.test.js — shared OMP version-policy gate (Phase 2).
 *
 * Mirrors coder-crush-version-policy.test.js structure:
 * 1) probe hygiene (sanitized env),
 * 2) shared resolver/assertion,
 * 3) production regression through runCoderRun.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createProviderConfigSnapshot } from '../src/provider-config.js';
import {
  buildOmpProbeEnv,
  detectOmp,
  resolveOmpVersionPolicy,
  assertOmpVersionPolicy,
  probeOmpCapabilities,
  OMP_INVALID_MINIMUM_CODE
} from '../src/coder-engines/omp.js';
import { runCoderRun, describeCoderStatus } from '../src/commands/coder.js';

// --- helpers ---
function withSavedEnv(keys, fn) {
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  return () => Promise.resolve(fn()).finally(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}
const ENV_KEYS = ['TRISS_CODER_OMP_VERSION', 'ZHIPU_API_KEY', 'OPENCODE_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'TRISS_WORKER_API_KEY'];

// --- 1. probe hygiene ---
test('buildOmpProbeEnv: allowlist only', () => {
  const env = buildOmpProbeEnv({
    PATH: '/usr/bin:/bin',
    HOME: '/home/u',
    TMPDIR: '/tmp',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TZ: 'UTC',
    ZHIPU_API_KEY: 'zk-nope',
    AWS_SECRET_ACCESS_KEY: 'aws-nope',
  });
  assert.deepEqual(env, { PATH: '/usr/bin:/bin', HOME: '/home/u', TMPDIR: '/tmp', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'UTC' });
});

test('buildOmpProbeEnv: omits unset keys', () => {
  assert.deepEqual(buildOmpProbeEnv({ PATH: '/bin' }), { PATH: '/bin' });
  assert.deepEqual(buildOmpProbeEnv({}), {});
});

test('resolveOmpVersionPolicy uses sanitized probe env (no secrets leak)', withSavedEnv([...ENV_KEYS, 'AWS_SECRET_ACCESS_KEY', 'GH_TOKEN'], async () => {
  process.env.ZHIPU_API_KEY = 'zk-sentinel';
  process.env.AWS_SECRET_ACCESS_KEY = 'aws-sentinel';
  process.env.GH_TOKEN = 'gh-sentinel';
  const calls = [];
  const sh = (cmd, argv, opts) => {
    calls.push({ cmd, argv, opts });
    if (cmd === 'omp' && argv[0] === '--version') return { status: 0, stdout: 'omp/18.0.6\n', stderr: '' };
    if (cmd === 'omp' && argv[0] === '--help') return { status: 0, stdout: '--mode --model --smol --session-dir --no-session --resume --continue --config --tools --approval-mode --no-extensions --no-skills --no-title --no-pty\n', stderr: '' };
    if (cmd === 'omp' && argv[0] === 'models') return { status: 0, stdout: '--json --no-extensions\n', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
  resolveOmpVersionPolicy(sh);
  assert.ok(calls.length >= 1);
  for (const c of calls) {
    const env = c.opts && c.opts.env;
    assert.ok(env && typeof env === 'object');
    assert.equal('ZHIPU_API_KEY' in env, false);
    assert.equal('AWS_SECRET_ACCESS_KEY' in env, false);
    assert.equal('GH_TOKEN' in env, false);
    for (const k of Object.keys(env)) {
      assert.ok(['PATH','HOME','TMPDIR','LANG','LC_ALL','TZ'].includes(k), 'unexpected probe env key: '+k);
    }
    const ser = JSON.stringify(env);
    assert.equal(ser.includes('sentinel'), false);
  }
}));

// --- 2. resolver classification ---
function versionSh(stdout) {
  return (cmd, argv, _opts) => {
    if (cmd === 'omp' && argv[0] === '--version') return { status: 0, stdout, stderr: '' };
    if (cmd === 'omp' && argv[0] === '--help') return { status: 0, stdout: '--mode --model --smol --session-dir --no-session --resume --continue --config --tools --approval-mode --no-extensions --no-skills --no-title --no-pty\n', stderr: '' };
    if (cmd === 'omp' && argv[0] === 'models') return { status: 0, stdout: '--json --no-extensions\n', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
}

test('resolveOmpVersionPolicy classifies every state', withSavedEnv(ENV_KEYS, () => {
  delete process.env.TRISS_CODER_OMP_VERSION;
  let p = resolveOmpVersionPolicy(versionSh('omp/19.0.0\n'));
  assert.equal(p.reason, 'compatible');
  assert.equal(p.compatible, true);
  assert.equal(p.found, true);
  assert.equal(p.installedVersion, '19.0.0');
  assert.equal(p.supportedFloor, '18.0.6');
  assert.equal(p.effectiveMinimum, '18.0.6');
  assert.equal(p.configValid, true);
  assert.equal(p.configuredMinimum, null);

  p = resolveOmpVersionPolicy(() => ({ status: 1, stdout: '', stderr: '', error: null }));
  assert.equal(p.reason, 'missing');
  assert.equal(p.compatible, false);
  assert.equal(p.found, false);
  assert.equal(p.installedVersion, null);

  p = resolveOmpVersionPolicy(versionSh('omp/18.0.5\n'));
  assert.equal(p.reason, 'below_floor');
  assert.equal(p.compatible, false);

  p = resolveOmpVersionPolicy(versionSh('not a version'));
  assert.equal(p.reason, 'version_unknown');
  assert.equal(p.compatible, false);

  process.env.TRISS_CODER_OMP_VERSION = '19.0.0';
  p = resolveOmpVersionPolicy(versionSh('omp/18.0.6\n'));
  assert.equal(p.reason, 'below_configured_minimum');
  assert.equal(p.effectiveMinimum, '19.0.0');

  process.env.TRISS_CODER_OMP_VERSION = 'garbage';
  p = resolveOmpVersionPolicy(versionSh('omp/18.0.6\n'));
  assert.equal(p.reason, 'invalid_configured_minimum');
  assert.equal(p.configValid, false);
  assert.equal(p.compatible, false);
  assert.equal(p.effectiveMinimum, '18.0.6');
}));

test('resolveOmpVersionPolicy raise-only semantics', withSavedEnv(ENV_KEYS, () => {
  delete process.env.TRISS_CODER_OMP_VERSION;
  process.env.TRISS_CODER_OMP_VERSION = '18.0.4';
  let p = resolveOmpVersionPolicy(versionSh('omp/18.0.6\n'));
  assert.equal(p.reason, 'compatible');
  assert.equal(p.effectiveMinimum, '18.0.6');
  p = resolveOmpVersionPolicy(versionSh('omp/18.0.5\n'));
  assert.equal(p.reason, 'below_floor');

  process.env.TRISS_CODER_OMP_VERSION = '19.0.0';
  p = resolveOmpVersionPolicy(versionSh('omp/19.0.0\n'));
  assert.equal(p.reason, 'compatible');
  assert.equal(p.effectiveMinimum, '19.0.0');

  process.env.TRISS_CODER_OMP_VERSION = '';
  p = resolveOmpVersionPolicy(versionSh('omp/18.0.6\n'));
  assert.equal(p.reason, 'compatible');
}));

test('malformed minimum is primary reason', withSavedEnv(ENV_KEYS, () => {
  process.env.TRISS_CODER_OMP_VERSION = 'garbage';
  for (const sh of [versionSh('omp/19.0.0\n'), () => ({ status: 1, stdout: '' }), versionSh('totally bad')]) {
    const p = resolveOmpVersionPolicy(sh);
    assert.equal(p.reason, 'invalid_configured_minimum');
    assert.equal(p.compatible, false);
  }
}));

test('unsupported-cli-contract when capabilities missing', withSavedEnv(ENV_KEYS, () => {
  delete process.env.TRISS_CODER_OMP_VERSION;
  const shNoCaps = (cmd, argv) => {
    if (cmd === 'omp' && argv[0] === '--version') return { status: 0, stdout: 'omp/18.0.6\n', stderr: '' };
    if (cmd === 'omp' && argv[0] === '--help') return { status: 0, stdout: '--mode only\n', stderr: '' };
    if (cmd === 'omp' && argv[0] === 'models') return { status: 0, stdout: '--json only\n', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
  const p = resolveOmpVersionPolicy(shNoCaps);
  assert.equal(p.reason, 'unsupported-cli-contract');
  assert.equal(p.compatible, false);
  assert.equal(p.found, true);
}));

test('probeOmpCapabilities checks launch and models', () => {
  const ok = probeOmpCapabilities({ launchHelp: '--mode --model --smol --session-dir --no-session --resume --continue --config --tools --approval-mode --no-extensions --no-skills --no-title --no-pty', modelsHelp: '--json --no-extensions', version: '18.0.6' });
  assert.equal(ok.ok, true);
  const bad = probeOmpCapabilities({ launchHelp: '--mode', modelsHelp: '--json', version: '18.0.6' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'unsupported-cli-contract');
  const badVer = probeOmpCapabilities({ launchHelp: '--mode', modelsHelp: '--json', version: 'not-semver' });
  assert.equal(badVer.ok, false);
  assert.equal(badVer.reason, 'unsupported-version');
});

test('assertOmpVersionPolicy throws typed for malformed', withSavedEnv(ENV_KEYS, () => {
  process.env.TRISS_CODER_OMP_VERSION = 'garbage';
  const p = resolveOmpVersionPolicy(versionSh('omp/18.0.6\n'));
  assert.throws(() => assertOmpVersionPolicy(p), (err) => {
    assert.equal(err.code, OMP_INVALID_MINIMUM_CODE);
    return true;
  });
}));

test('assertOmpVersionPolicy messages for missing/below/unknown', withSavedEnv(ENV_KEYS, () => {
  delete process.env.TRISS_CODER_OMP_VERSION;
  let p = resolveOmpVersionPolicy(() => ({ status: 1, stdout: '' }));
  assert.throws(() => assertOmpVersionPolicy(p), /omp not found/);
  p = resolveOmpVersionPolicy(versionSh('omp/18.0.5\n'));
  assert.throws(() => assertOmpVersionPolicy(p), /minimum supported version is 18.0.6/);
  p = resolveOmpVersionPolicy(versionSh('totally bad'));
  assert.throws(() => assertOmpVersionPolicy(p), /could not be determined/);
}));

test('describeCoderStatus includes omp policy (read-only)', withSavedEnv(ENV_KEYS, () => {
  delete process.env.TRISS_CODER_OMP_VERSION;
  const sh = (cmd, argv) => {
    if (cmd === 'opencode' && argv[0] === '--version') return { status: 0, stdout: 'opencode 1.18.22\n', stderr: '' };
    if (cmd === 'omp' && argv[0] === '--version') return { status: 0, stdout: 'omp/18.0.6\n', stderr: '' };
    if (cmd === 'omp' && argv[0] === '--help') return { status: 0, stdout: '--mode --model --smol --session-dir --no-session --resume --continue --config --tools --approval-mode --no-extensions --no-skills --no-title --no-pty\n', stderr: '' };
    if (cmd === 'omp' && argv[0] === 'models') return { status: 0, stdout: '--json --no-extensions\n', stderr: '' };
    if (cmd === 'crush' && argv[0] === '--version') return { status: 1, stdout: '', stderr: '' };
    if (cmd === 'which' && argv[0] === 'opencode2') return { status: 1, stdout: '', stderr: '' };
    if (cmd === 'git' && argv[0] === 'rev-parse') return { status: 1, stdout: '', stderr: '' };
    return { status: 1, stdout: '', stderr: '' };
  };
  const st = describeCoderStatus({ spawnSync: sh });
  assert.ok(st.omp);
  assert.equal(typeof st.omp.found, 'boolean');
  assert.equal(typeof st.omp.version === 'string' || st.omp.version === null, true);
}));

test('detectOmp: missing binary', () => {
  const sh = () => ({ status: 1, stdout: '', stderr: '' });
  const r = detectOmp(sh);
  assert.equal(r.found, false);
  assert.equal(r.path, null);
});

test('detectOmp: non-executable or symlink rejected (inject fs)', () => {
  const fakePath = '/tmp/fake-omp';
  const sh = (cmd, argv) => {
    if (cmd === 'which' && argv[0] === 'omp') return { status: 0, stdout: fakePath + '\n', stderr: '' };
    return { status: 0, stdout: 'omp/18.0.6\n', stderr: '' };
  };
  const fsFailStat = { realpathSync: (p) => p, statSync: () => { throw Object.assign(new Error('noent'), { code: 'ENOENT' }); } };
  const r = detectOmp(sh, fsFailStat);
  assert.equal(r.found, false);
});

test('runCoderRun with engine omp incompatible version throws before side effects', async () => {
  await withSavedEnv(['TRISS_CODER_OMP_VERSION','ZHIPU_API_KEY','OPENCODE_API_KEY','TRISS_WORKER_API_KEY'], async () => {
    delete process.env.TRISS_CODER_OMP_VERSION;
    process.env.ZHIPU_API_KEY = 'test-key';
    const sh = (cmd, argv) => {
      if (cmd === 'omp' && argv[0] === '--version') return { status: 0, stdout: 'omp/18.0.5\n', stderr: '' };
      if (cmd === 'omp' && argv[0] === '--help') return { status: 0, stdout: '--mode --model --smol --session-dir --no-session --resume --continue --config --tools --approval-mode --no-extensions --no-skills --no-title --no-pty\n', stderr: '' };
      if (cmd === 'omp' && argv[0] === 'models') return { status: 0, stdout: '--json --no-extensions\n', stderr: '' };
      return { status: 1, stdout: '', stderr: '' };
    };
    let spawnCalled = false;
    try {
      await runCoderRun('hello', { engine: 'omp', model: 'zai/glm-5', isolate: false }, {
        providerConfigSnapshot: createProviderConfigSnapshot({ parentEnv: process.env, files: [] }),
        spawnSync: sh,
        spawn: () => {
          spawnCalled = true;
          throw new Error('should not spawn');
        },
      });
      assert.fail('should have thrown');
    } catch (err) {
      assert.match(String(err.message), /minimum supported version is/);
      assert.equal(spawnCalled, false);
    }
  })();
});

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * coder-crush-version-policy.test.js — the shared Crush version-policy gate.
 *
 * Covers three boundaries:
 *   1. Probe hygiene: EVERY read-only Crush probe (`crush --version`) receives
 *      an explicit minimal sanitized environment — PATH plus deterministic
 *      locale/TZ only. A sentinel secret suite proves provider/API/cloud/
 *      GitHub/AWS credentials and arbitrary parent env are NOT inherited.
 *   2. The one shared resolver/assertion (resolveCrushVersionPolicy /
 *      assertCrushVersionPolicy): explicit reasons for missing binary,
 *      unparsable install, below-floor, below-configured-minimum, malformed
 *      override; raise-only semantics preserved.
 *   3. PRODUCTION regression matrix THROUGH runCoderRun (engine=crush): an
 *      incompatible version must make spawnCrush unreachable and must not
 *      create any side effect (no isolation worktree/git call, no credential
 *      proxy, no session reservation). Plus the OpenCode status-drift fixes
 *      (resolveOpencodeVersionPolicy + describeCoderStatus coherence).
 *
 * Mirrors the existing coder test style: node:test, assert/strict, injected
 * fake spawnSync/spawn seams, no network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCrushProbeEnv,
  detectCrush,
  resolveCrushVersionPolicy,
  assertCrushVersionPolicy,
  CRUSH_INVALID_MINIMUM_CODE,
} from '../src/coder-engines/crush.js';
import {
  describeCoderStatus,
  resolveOpencodeVersionPolicy,
  assertOpencodeMinimumVersion,
  OPENCODE_INVALID_MINIMUM_CODE,
  OPENCODE_SUPPORTED_FLOOR,
} from '../src/commands/coder.js';

// ─── env snapshot helper ─────────────────────────────────────────────────────

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

const ENV_KEYS = [
  'TRISS_CODER_CRUSH_VERSION',
  'TRISS_CODER_OPENCODE_VERSION',
  'ZHIPU_API_KEY',
  // The sentinel-secret suite below also pollutes this key; without saving it
  // a fake credential would leak into every later test in this process.
  'OPENCODE_API_KEY',
];

// ─── 1. sentinel-secret probe environment ─────────────────────────────────────

test('buildCrushProbeEnv: PATH plus deterministic locale/TZ only', () => {
  const env = buildCrushProbeEnv({
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TZ: 'UTC',
    HOME: '/home/user',
    TMPDIR: '/tmp',
    ZHIPU_API_KEY: 'zk-nope',
    AWS_SECRET_ACCESS_KEY: 'aws-nope',
  });
  assert.deepEqual(env, { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', TZ: 'UTC' });
});

test('buildCrushProbeEnv: omits allowlist keys that are unset', () => {
  assert.deepEqual(buildCrushProbeEnv({ PATH: '/bin' }), { PATH: '/bin' });
  assert.deepEqual(buildCrushProbeEnv({}), {});
});

test(
  'detectCrush passes a sanitized third-argument env: sentinel secrets are absent',
  withSavedEnv([...ENV_KEYS, 'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'GH_TOKEN', 'GITHUB_TOKEN', 'TRISS_WORKER_API_KEY', 'TEAM_X_SERVICE_SECRET'], () => {
    // Pollute the parent environment with representative secrets across every
    // class the review names: provider/API (ZHIPU/OPENCODE), cloud (AWS),
    // GitHub, and arbitrary unrelated parent env.
    process.env.ZHIPU_API_KEY = 'zk-sentinel-secret';
    process.env.OPENCODE_API_KEY = 'sk-sentinel-secret';
    process.env.AWS_SECRET_ACCESS_KEY = 'aws-sentinel-secret';
    process.env.AWS_ACCESS_KEY_ID = 'awsid-sentinel-secret';
    process.env.GH_TOKEN = 'gh-sentinel-secret';
    process.env.GITHUB_TOKEN = 'github-sentinel-secret';
    process.env.TRISS_WORKER_API_KEY = 'worker-sentinel-secret';
    process.env.TEAM_X_SERVICE_SECRET = 'random-sentinel-secret';

    const calls = [];
    const sh = (cmd, argv, opts) => {
      calls.push({ cmd, argv, opts });
      return { status: 0, stdout: 'crush version v0.1.6\n', stderr: '', error: null };
    };
    detectCrush(sh);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'crush');
    assert.deepEqual(calls[0].argv, ['--version']);
    const env = calls[0].opts && calls[0].opts.env;
    assert.ok(env && typeof env === 'object', 'probe must receive an explicit env object');

    const forbidden = [
      'ZHIPU_API_KEY', 'OPENCODE_API_KEY', 'ZAI_API_KEY',
      'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SESSION_TOKEN',
      'GH_TOKEN', 'GITHUB_TOKEN',
      'TRISS_WORKER_API_KEY', 'TEAM_X_SERVICE_SECRET',
    ];
    for (const key of forbidden) {
      assert.equal(key in env, false, `${key} must not be inherited by a read-only crush probe`);
    }
    // And no sentinel VALUE leaks under any other key name either.
    const serialized = JSON.stringify(env);
    for (const value of Object.values(process.env).filter((v) => String(v).endsWith('-sentinel-secret'))) {
      assert.equal(serialized.includes(String(value)), false, 'sentinel secret value leaked into probe env');
    }
    // Only the deterministic allowlist may be present.
    for (const key of Object.keys(env)) {
      assert.ok(['PATH', 'LANG', 'LC_ALL', 'TZ'].includes(key), `unexpected probe env key: ${key}`);
    }
  }),
);

// ─── 2. the shared resolver / assertion ──────────────────────────────────────

function versionSh(stdout) {
  return (cmd, argv) => {
    if (cmd === 'crush' && argv[0] === '--version') {
      return { status: 0, stdout, stderr: '', error: null };
    }
    return { status: 1, stdout: '', stderr: '', error: null };
  };
}

test(
  'resolveCrushVersionPolicy classifies every policy state explicitly',
  withSavedEnv(ENV_KEYS, () => {
    delete process.env.TRISS_CODER_CRUSH_VERSION;

    let p = resolveCrushVersionPolicy(versionSh('crush version v0.2.0\n'));
    assert.deepEqual(
      { reason: p.reason, compatible: p.compatible, found: p.found, installedVersion: p.installedVersion },
      { reason: 'compatible', compatible: true, found: true, installedVersion: '0.2.0' },
    );
    assert.equal(p.supportedFloor, '0.1.6');
    assert.equal(p.effectiveMinimum, '0.1.6');
    assert.equal(p.configValid, true);
    assert.equal(p.configuredMinimum, null);

    p = resolveCrushVersionPolicy(() => ({ status: 1, stdout: '', stderr: '', error: null }));
    assert.equal(p.reason, 'missing');
    assert.equal(p.compatible, false);
    assert.equal(p.installedVersion, null);

    p = resolveCrushVersionPolicy(versionSh('crush version v0.1.5\n'));
    assert.equal(p.reason, 'below_floor');
    assert.equal(p.compatible, false);
    assert.equal(p.installedVersion, '0.1.5');

    p = resolveCrushVersionPolicy(versionSh('totally not a version'));
    assert.equal(p.reason, 'version_unknown');
    assert.equal(p.compatible, false);
    assert.equal(p.installedVersion, 'totally not a version');

    process.env.TRISS_CODER_CRUSH_VERSION = '0.2.0';
    p = resolveCrushVersionPolicy(versionSh('crush version v0.1.6\n'));
    assert.equal(p.reason, 'below_configured_minimum');
    assert.equal(p.effectiveMinimum, '0.2.0');
    assert.equal(p.configuredMinimum, '0.2.0');

    process.env.TRISS_CODER_CRUSH_VERSION = 'garbage';
    p = resolveCrushVersionPolicy(versionSh('crush version v0.1.6\n'));
    assert.equal(p.reason, 'invalid_configured_minimum');
    assert.equal(p.configValid, false);
    assert.equal(p.compatible, false);
    // Display degrades to the floor so advice stays actionable…
    assert.equal(p.effectiveMinimum, '0.1.6');
    // …while NOTHING is admitted (fail closed).
    assert.equal(p.compatible, false);
  }),
);

test(
  'resolveCrushVersionPolicy keeps raise-only semantics for the configured minimum',
  withSavedEnv(ENV_KEYS, () => {
    delete process.env.TRISS_CODER_CRUSH_VERSION;

    // Configured BELOW floor clamps UP to the floor.
    process.env.TRISS_CODER_CRUSH_VERSION = '0.1.4';
    let p = resolveCrushVersionPolicy(versionSh('crush version v0.1.6\n'));
    assert.equal(p.reason, 'compatible');
    assert.equal(p.effectiveMinimum, '0.1.6');
    p = resolveCrushVersionPolicy(versionSh('crush version v0.1.5\n'));
    assert.equal(p.reason, 'below_floor'); // 0.1.5 < effective 0.1.6 despite the low config

    // Configured ABOVE floor is preserved.
    process.env.TRISS_CODER_CRUSH_VERSION = '0.2.0';
    p = resolveCrushVersionPolicy(versionSh('crush version v0.2.0\n'));
    assert.equal(p.reason, 'compatible');
    assert.equal(p.effectiveMinimum, '0.2.0');

    // An exact '' value counts as unset.
    process.env.TRISS_CODER_CRUSH_VERSION = '';
    p = resolveCrushVersionPolicy(versionSh('crush version v0.1.6\n'));
    assert.equal(p.reason, 'compatible');
    assert.equal(p.effectiveMinimum, '0.1.6');
  }),
);

test(
  'resolveCrushVersionPolicy: a MALFORMED minimum is the PRIMARY reason regardless of binary state (diagnostics preserved)',
  withSavedEnv(ENV_KEYS, () => {
    process.env.TRISS_CODER_CRUSH_VERSION = 'garbage';
    const cases = [
      {
        label: 'compatible installed',
        sh: versionSh('crush version v0.2.0\n'),
        found: true,
        installedVersion: '0.2.0',
      },
      {
        label: 'missing binary',
        sh: () => ({ status: 1, stdout: '', stderr: '', error: null }),
        found: false,
        installedVersion: null,
      },
      {
        label: 'unparsable installed',
        sh: versionSh('totally not a version'),
        found: true,
        installedVersion: 'totally not a version',
      },
      {
        label: 'below-floor installed',
        sh: versionSh('crush version v0.1.5\n'),
        found: true,
        installedVersion: '0.1.5',
      },
    ];
    for (const c of cases) {
      const p = resolveCrushVersionPolicy(c.sh);
      assert.deepEqual(
        {
          reason: p.reason,
          configValid: p.configValid,
          compatible: p.compatible,
          found: p.found,
          installedVersion: p.installedVersion,
          effectiveMinimum: p.effectiveMinimum,
        },
        {
          reason: 'invalid_configured_minimum',
          configValid: false,
          compatible: false,
          found: c.found,
          installedVersion: c.installedVersion,
          effectiveMinimum: '0.1.6',
        },
        c.label,
      );
      // The assertion stays TYPED for every binary state — never a plain
      // "crush not found"/"upgrade" error that would bury the config fault.
      try {
        assertCrushVersionPolicy(p);
        assert.fail(`must throw (${c.label})`);
      } catch (err) {
        assert.equal(err.code, CRUSH_INVALID_MINIMUM_CODE, c.label);
        assert.match(err.message, /Invalid Crush minimum version "garbage"/, c.label);
      }
    }
  }),
);

test('assertCrushVersionPolicy throws the narrow typed error for a malformed configured minimum', () => {
  const policy = {
    found: true,
    installedVersion: '0.1.6',
    configuredMinimum: 'HEAD',
    configValid: false,
    supportedFloor: '0.1.6',
    effectiveMinimum: '0.1.6',
    compatible: false,
    reason: 'invalid_configured_minimum',
  };
  try {
    assertCrushVersionPolicy(policy);
    assert.fail('must throw');
  } catch (err) {
    assert.equal(err.code, CRUSH_INVALID_MINIMUM_CODE);
    assert.match(err.message, /Invalid Crush minimum version "HEAD"/);
  }
});

test('assertCrushVersionPolicy returns the policy unchanged when compatible', () => {
  const policy = { found: true, installedVersion: '0.1.6', configValid: true, effectiveMinimum: '0.1.6', compatible: true, reason: 'compatible' };
  assert.equal(assertCrushVersionPolicy(policy), policy);
});

// ─── 3. OpenCode status drift: ONE resolver + adapter assert ──────────────────

test(
  `resolveOpencodeVersionPolicy: below-floor and malformed configs are invalid with effective floor ${OPENCODE_SUPPORTED_FLOOR}`,
  withSavedEnv(ENV_KEYS, () => {
    // Configured 1.0.0 (below floor): invalid configuration, never compatible.
    let p = resolveOpencodeVersionPolicy('2.0.5', '1.0.0');
    assert.equal(p.configValid, false);
    assert.equal(p.reason, 'below_supported_floor');
    assert.equal(p.effectiveMinimum, OPENCODE_SUPPORTED_FLOOR);
    assert.equal(p.installedCompatible, false, 'never meetsMinimum=true on invalid config');

    // Malformed: same fail-closed shape.
    p = resolveOpencodeVersionPolicy(OPENCODE_SUPPORTED_FLOOR, 'latest');
    assert.equal(p.configValid, false);
    assert.equal(p.reason, 'invalid_configured_minimum');
    assert.equal(p.effectiveMinimum, OPENCODE_SUPPORTED_FLOOR);
    assert.equal(p.installedCompatible, false);

    // Exact floor with the exact installed build: compatible.
    p = resolveOpencodeVersionPolicy(OPENCODE_SUPPORTED_FLOOR, OPENCODE_SUPPORTED_FLOOR);
    assert.deepEqual(
      { configValid: p.configValid, reason: p.reason, installedCompatible: p.installedCompatible, effectiveMinimum: p.effectiveMinimum },
      { configValid: true, reason: 'compatible', installedCompatible: true, effectiveMinimum: OPENCODE_SUPPORTED_FLOOR },
    );

    // A VALID raised minimum is honored against the installed version.
    p = resolveOpencodeVersionPolicy('1.19.0', '2.0.0');
    assert.equal(p.configValid, true);
    assert.equal(p.reason, 'below_minimum');
    assert.equal(p.effectiveMinimum, '2.0.0');
    assert.equal(p.installedCompatible, false);
    p = resolveOpencodeVersionPolicy('2.0.5', '2.0.0');
    assert.equal(p.reason, 'compatible');

    // Unknown/missing install stays honest.
    p = resolveOpencodeVersionPolicy(null, OPENCODE_SUPPORTED_FLOOR);
    assert.equal(p.reason, 'version_unknown');
    assert.equal(p.installedCompatible, false);
  }),
);

test(
  `resolveOpencodeVersionPolicy DEFAULT minimum (${OPENCODE_SUPPORTED_FLOOR}): 1.18.21 rejects; floor/newer stable/newer major accept`,
  withSavedEnv(ENV_KEYS, () => {
    delete process.env.TRISS_CODER_OPENCODE_VERSION;
    const expect = (installed, compatible) => {
      const p = resolveOpencodeVersionPolicy(installed);
      assert.deepEqual(
        { configValid: p.configValid, reason: p.reason, installedCompatible: p.installedCompatible, effectiveMinimum: p.effectiveMinimum },
        compatible
          ? { configValid: true, reason: 'compatible', installedCompatible: true, effectiveMinimum: OPENCODE_SUPPORTED_FLOOR }
          : { configValid: true, reason: 'below_minimum', installedCompatible: false, effectiveMinimum: OPENCODE_SUPPORTED_FLOOR },
        String(installed),
      );
    };
    expect('1.18.21', false);          // one patch below the immutable floor
    expect(OPENCODE_SUPPORTED_FLOOR, true);
    expect('1.19.0', true);            // newer stable
    expect('2.0.0', true);             // newer major
  }),
);

test(
  'assertOpencodeMinimumVersion remains the typed throwing adapter over the resolver',
  withSavedEnv(ENV_KEYS, () => {
    for (const bad of ['1.0.0', 'garbage', '']) {
      try {
        assertOpencodeMinimumVersion(bad === '' ? undefined : bad);
        if (bad !== '') assert.fail(`must throw for ${bad}`);
        // Default (unset env) is the valid floor and must NOT throw.
      } catch (err) {
        assert.equal(err.code, OPENCODE_INVALID_MINIMUM_CODE, bad);
        assert.match(err.message, /No installation was attempted\.$/);
      }
    }
    // Exact-floor return value preserved (parsed version object).
    const parsed = assertOpencodeMinimumVersion(OPENCODE_SUPPORTED_FLOOR);
    assert.equal(parsed.major, 1);
    assert.equal(parsed.minor, 18);
    assert.equal(parsed.patch, 22);
    assert.doesNotThrow(() => assertOpencodeMinimumVersion('2.0.0'));
  }),
);

test(
  'describeCoderStatus reports real policy state for BOTH engines (read-only)',
  withSavedEnv(ENV_KEYS, () => {
    const fakeSh = (cmd, args) => {
      if (cmd === 'opencode' && args[0] === '--version') {
        return { status: 0, stdout: '1.19.9\n', stderr: '', error: null };
      }
      if (cmd === 'crush' && args[0] === '--version') {
        return { status: 0, stdout: 'crush version v0.1.5\n', stderr: '', error: null };
      }
      return { status: 1, stdout: '', stderr: '', error: null };
    };

    // OpenCode: configured 1.0.0 is INVALID configuration -> effective floor
    // shown, meetsMinimum NEVER true.
    process.env.TRISS_CODER_OPENCODE_VERSION = '1.0.0';
    delete process.env.TRISS_CODER_CRUSH_VERSION;
    let s = describeCoderStatus({ spawnSync: fakeSh });
    assert.equal(s.meetsMinimum, false);
    assert.equal(s.configValid, false);
    assert.equal(s.effectiveMinimum, OPENCODE_SUPPORTED_FLOOR);
    assert.equal(s.reason, 'below_supported_floor');

    // Crush: 0.1.5 found vs default floor 0.1.6 -> incompatible with an
    // explicit reason; compatibility fields stay coherent.
    process.env.TRISS_CODER_OPENCODE_VERSION = undefined;
    delete process.env.TRISS_CODER_OPENCODE_VERSION;
    s = describeCoderStatus({ spawnSync: fakeSh });
    assert.equal(s.crush.found, true);
    assert.equal(s.crush.version, '0.1.5');
    assert.equal(s.crush.meetsMinimum, false);
    assert.equal(s.crush.satisfiesPin, false);
    assert.equal(s.crush.minimumVersion, '0.1.6');
    assert.equal(s.crush.pin, '0.1.6');
    assert.equal(s.crush.reason, 'below_floor');
    assert.equal(s.crush.configValid, true);

    // A raised crush minimum flows through coherently too. 0.1.5 sits below
    // the FLOOR, so the reason stays below_floor while the effective minimum
    // text reflects the stricter configuration.
    process.env.TRISS_CODER_CRUSH_VERSION = '0.2.0';
    s = describeCoderStatus({ spawnSync: fakeSh });
    assert.equal(s.crush.meetsMinimum, false);
    assert.equal(s.crush.minimumVersion, '0.2.0');
    assert.equal(s.crush.reason, 'below_floor');

    // Compatible crush reports green across all compatibility aliases.
    const okSh = (cmd, args) => {
      if (cmd === 'opencode' && args[0] === '--version') {
        return { status: 0, stdout: `${OPENCODE_SUPPORTED_FLOOR}\n`, stderr: '', error: null };
      }
      if (cmd === 'crush' && args[0] === '--version') {
        return { status: 0, stdout: 'crush version v0.2.0\n', stderr: '', error: null };
      }
      return { status: 1, stdout: '', stderr: '', error: null };
    };
    delete process.env.TRISS_CODER_CRUSH_VERSION;
    s = describeCoderStatus({ spawnSync: okSh });
    assert.equal(s.meetsMinimum, true);
    assert.equal(s.crush.meetsMinimum, true);
    assert.equal(s.crush.satisfiesPin, true);
  }),
);

test(
  'describeCoderStatus: a malformed crush minimum reports invalid_configured_minimum regardless of installed state',
  withSavedEnv(ENV_KEYS, () => {
    delete process.env.TRISS_CODER_OPENCODE_VERSION;
    process.env.TRISS_CODER_CRUSH_VERSION = 'garbage';
    // Status must reflect the CONFIG fault for every binary state — never
    // swap it for a probe-derived reason.
    const states = [
      ['compatible installed', 'crush version v0.2.0\n'],
      ['missing binary', null],
      ['unparsable installed', 'crush version vnot-a-semver\n'],
      ['below-floor installed', 'crush version v0.1.5\n'],
    ];
    for (const [label, crushOut] of states) {
      const sh = (cmd, args) => {
        if (cmd === 'crush' && args[0] === '--version') {
          return crushOut == null
            ? { status: 1, stdout: '', stderr: '', error: null }
            : { status: 0, stdout: crushOut, stderr: '', error: null };
        }
        if (cmd === 'opencode' && args[0] === '--version') {
          return { status: 0, stdout: `${OPENCODE_SUPPORTED_FLOOR}\n`, stderr: '', error: null };
        }
        return { status: 1, stdout: '', stderr: '', error: null };
      };
      const s = describeCoderStatus({ spawnSync: sh });
      assert.equal(s.crush.configValid, false, label);
      assert.equal(s.crush.reason, 'invalid_configured_minimum', label);
      assert.equal(s.crush.meetsMinimum, false, label);
      assert.equal(s.crush.satisfiesPin, false, label);
      assert.equal(s.crush.effectiveMinimum, '0.1.6', label);
    }
  }),
);

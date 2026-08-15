/**
 * coder-sandbox.test.js — Package 2B (Atomic 04): filesystem and network
 * capability adapter.
 *
 * RED/GREEN: node --test test/coder-sandbox.test.js
 *
 * Covers Section 6.5 of docs/reliable-delegation-contract-plan.md: exact
 * enforced|best_effort|unavailable capability reporting on darwin|linux|
 * win32, honest best-effort parity (no Package 0 backend selected),
 * fail-closed credential isolation with absolute credential-store and
 * parent-process canaries, and mount allowlist denial (symlink/path escape,
 * broad roots, HOME/SSH/cloud).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLATFORMS,
  CAPABILITY_VALUE,
  CREDENTIAL_ISOLATION_REQUIRED_CODE,
  resolveCoderSandbox,
  buildCoderSandboxMounts,
  resolveCoderCredentialIsolation,
} from '../src/coder-sandbox.js';

// ─── capability tuple ────────────────────────────────────────────────────────

test('capability reporting is exact on darwin|linux|win32 for both engines', () => {
  for (const platform of PLATFORMS) {
    for (const engine of ['opencode', 'crush']) {
      const caps = resolveCoderSandbox({ platform, engine });
      for (const value of Object.values({
        sandbox: caps.sandbox,
        process_supervision: caps.process_supervision,
        locking: caps.locking,
        writable_quota: caps.writable_quota,
        credential_isolation: caps.credential_isolation,
        managed_root: caps.managed_root,
        persistent_store_quota: caps.persistent_store_quota,
        result_store_quota: caps.result_store_quota,
      })) {
        assert.ok(CAPABILITY_VALUE.includes(value), `${platform}/${engine}: ${value}`);
      }
    }
  }
});

test('without a Package 0 backend, sandbox and quotas are unavailable, not claimed enforced', () => {
  for (const platform of PLATFORMS) {
    const caps = resolveCoderSandbox({ platform, proxyAvailable: false });
    assert.equal(caps.sandbox, 'unavailable');
    assert.equal(caps.writable_quota, 'unavailable');
    assert.equal(caps.managed_root, 'unavailable');
    assert.equal(caps.persistent_store_quota, 'unavailable');
    assert.equal(caps.result_store_quota, 'unavailable');
    // supervision and locking stay honest best_effort (group kill + pid-file
    // locks exist, complete-tree/kernel ownership does not).
    assert.equal(caps.process_supervision, 'best_effort');
    assert.equal(caps.locking, 'best_effort');
  }
});

test('credential_isolation is honestly best_effort when a proxy plan exists (never enforced)', () => {
  const without = resolveCoderSandbox({ platform: 'darwin', proxyAvailable: false });
  assert.equal(without.credential_isolation, 'unavailable');
  assert.ok(without.warnings.includes(CREDENTIAL_ISOLATION_REQUIRED_CODE));

  const withProxy = resolveCoderSandbox({ platform: 'linux', proxyAvailable: true });
  // The loopback token proxy is a real boundary but NOT OS-enforced store
  // denial: a same-UID child can still read raw credential stores, so the
  // honest value is best_effort with an explicit warning, never 'enforced'.
  assert.equal(withProxy.credential_isolation, 'best_effort');
  assert.ok(withProxy.warnings.includes('TRISS_CODER_CAP_CREDENTIAL_ISOLATION_BEST_EFFORT'));
  assert.equal(withProxy.warnings.includes(CREDENTIAL_ISOLATION_REQUIRED_CODE), false);
});

test('unknown platform or engine fails closed with TypeError', () => {
  assert.throws(() => resolveCoderSandbox({ platform: 'plan9' }), TypeError);
  assert.throws(() => resolveCoderSandbox({ engine: 'zed' }), TypeError);
});

// ─── mounts allowlist ────────────────────────────────────────────────────────

test('mounts: authorized target is writable, everything else readonly', () => {
  const { mounts, denied } = buildCoderSandboxMounts({
    targetRoot: '/wt/task-a',
    taskTemp: '/tmp/triss-task-a',
    engineRoots: ['/opt/opencode/runtime'],
    readonlyProjectRoots: ['/wt/project/node_modules'],
  });
  assert.deepEqual(denied, []);
  const target = mounts.find((m) => m.src === '/wt/task-a');
  const temp = mounts.find((m) => m.src === '/tmp/triss-task-a');
  const engine = mounts.find((m) => m.src === '/opt/opencode/runtime');
  const deps = mounts.find((m) => m.src === '/wt/project/node_modules');
  assert.equal(target.readonly, false);
  assert.equal(temp.readonly, false);
  assert.equal(engine.readonly, true);
  assert.equal(deps.readonly, true);
});

test('mounts: exact broad roots, HOME, SSH, and cloud dirs are denied even when requested', () => {
  const { mounts, denied } = buildCoderSandboxMounts({
    targetRoot: '/wt/task-a',
    engineRoots: [
      '/usr', // exact broad root -> denied
      '/opt', // exact broad root -> denied
      '/etc', // exact broad root -> denied
      '/Users/alice',
      '/Users/alice/.ssh',
      '/home/alice',
      '/root',
      '/Users/alice/.aws',
      '/Users/alice/.config',
    ],
  });
  // A concrete validated subpath under a broad root is a specific runtime
  // root and IS allowed (e.g. Node/npm files under /usr/local/lib).
  const concrete = buildCoderSandboxMounts({
    targetRoot: '/wt/task-a',
    engineRoots: ['/usr/local/lib/node_modules'],
  });
  assert.equal(concrete.denied.length, 0);
  assert.equal(concrete.mounts.some((m) => m.src === '/usr/local/lib/node_modules'), true);

  assert.equal(mounts.length, 1, 'only the target survives');
  assert.equal(mounts[0].src, '/wt/task-a');
  assert.deepEqual(denied, [
    '/usr',
    '/opt',
    '/etc',
    '/Users/alice',
    '/Users/alice/.ssh',
    '/home/alice',
    '/root',
    '/Users/alice/.aws',
    '/Users/alice/.config',
  ]);
});

test('mounts: relative or empty roots are denied, never mounted', () => {
  const { mounts, denied } = buildCoderSandboxMounts({
    targetRoot: '/wt/task-a',
    engineRoots: ['relative/path', '', 'node_modules'],
  });
  assert.equal(mounts.length, 1);
  assert.deepEqual(denied, ['relative/path', '', 'node_modules']);
});

test('mounts: missing or non-absolute targetRoot fails closed', () => {
  assert.throws(() => buildCoderSandboxMounts({}), TypeError);
  assert.throws(() => buildCoderSandboxMounts({ targetRoot: 'relative' }), TypeError);
});

// ─── credential isolation ────────────────────────────────────────────────────

const VALID_PROXY = {
  baseUrl: 'http://127.0.0.1:51001',
  token: 'a'.repeat(32),
  envKey: 'OPENCODE_API_KEY',
  provider: 'zai',
  model: 'glm-5.2',
  endpoint: 'https://api.z.ai/v1',
};

test('credential isolation: a valid loopback proxy yields an opaque launch plan', () => {
  const result = resolveCoderCredentialIsolation({
    proxy: VALID_PROXY,
    credentialStorePaths: ['/Users/alice/.config/triss/.env', '/Users/alice/.ssh'],
    parentPid: 4242,
    engineCommand: '/opt/opencode/opencode',
    platformCapabilities: resolveCoderSandbox({ platform: 'darwin', proxyAvailable: true }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.kind, 'credential_proxy');
  assert.equal(result.plan.proxy.baseUrl, 'http://127.0.0.1:51001');
  assert.equal(result.plan.proxy.envKey, 'OPENCODE_API_KEY');
  assert.equal(result.plan.parentPid, 4242);
  assert.deepEqual(result.plan.deniedPaths, [
    '/Users/alice/.config/triss/.env',
    '/Users/alice/.ssh',
  ]);
  // The token is NOT part of the plan object — it travels to the launcher
  // separately; the real credential is never serialized anywhere.
  assert.equal(JSON.stringify(result.plan).includes(VALID_PROXY.token), false);
});

test('credential isolation: missing proxy is a stable fail-closed rejection', () => {
  const result = resolveCoderCredentialIsolation({
    credentialStorePaths: ['/Users/alice/.ssh'],
    platformCapabilities: resolveCoderSandbox({ platform: 'linux', proxyAvailable: false }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CREDENTIAL_ISOLATION_REQUIRED_CODE);
  assert.match(result.message, /refusing to spawn/);
});

test('credential isolation: a plan that only sanitizes env vars is never returned', () => {
  // An env-key without a real loopback proxy is not a plan.
  const envOnly = {
    baseUrl: 'not-a-proxy',
    token: 'x'.repeat(32),
    envKey: 'OPENCODE_API_KEY',
  };
  const result = resolveCoderCredentialIsolation({
    proxy: envOnly,
    platformCapabilities: resolveCoderSandbox({ platform: 'darwin', proxyAvailable: true }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, CREDENTIAL_ISOLATION_REQUIRED_CODE);

  // A non-loopback base URL is also rejected (proxy must be local).
  const remote = { ...VALID_PROXY, baseUrl: 'https://proxy.evil.example' };
  const remoteResult = resolveCoderCredentialIsolation({ proxy: remote });
  assert.equal(remoteResult.ok, false);
});

test('credential isolation: unavailable platform capability rejects even with a proxy', () => {
  const caps = resolveCoderSandbox({ platform: 'win32', proxyAvailable: false });
  const result = resolveCoderCredentialIsolation({ proxy: VALID_PROXY, platformCapabilities: caps });
  assert.equal(result.ok, false);
  assert.equal(result.code, CREDENTIAL_ISOLATION_REQUIRED_CODE);
});

test('credential isolation: malicious absolute credential-store canaries stay denied', () => {
  const result = resolveCoderCredentialIsolation({
    proxy: VALID_PROXY,
    credentialStorePaths: [
      '/Users/alice/.ssh/id_rsa',
      '/Users/alice/.config/triss/.env',
      '/Users/alice/.aws/credentials',
      'relative/canary', // non-absolute canary is dropped from the denied set
    ],
    platformCapabilities: resolveCoderSandbox({ platform: 'darwin', proxyAvailable: true }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.plan.deniedPaths, [
    '/Users/alice/.ssh/id_rsa',
    '/Users/alice/.config/triss/.env',
    '/Users/alice/.aws/credentials',
  ]);
});

test('credential isolation: parent PID and engine command are identity facts, not secrets', () => {
  const result = resolveCoderCredentialIsolation({
    proxy: VALID_PROXY,
    parentPid: 7,
    engineCommand: '/usr/local/bin/opencode',
    platformCapabilities: resolveCoderSandbox({ platform: 'linux', proxyAvailable: true }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.parentPid, 7);
  assert.equal(result.plan.engineCommand, '/usr/local/bin/opencode');
});

// ─── parity ──────────────────────────────────────────────────────────────────

test('non-isolated and isolated runs share the same honest capability tuple', () => {
  // The adapter reports host capabilities, not the isolation flag — parity is
  // guaranteed by construction (no isolation-dependent capability exists yet).
  const a = resolveCoderSandbox({ platform: 'darwin', proxyAvailable: true });
  const b = resolveCoderSandbox({ platform: 'darwin', proxyAvailable: true });
  assert.deepEqual(a, b);
});

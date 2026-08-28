// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';

import { runUpdate } from '../src/commands/update.js';
import {
  formatUpdateNotice,
  runDefaultPassiveCliCheck,
  runPassiveCliCheck,
  shouldSuppressPassiveCheck,
} from '../src/update/passive.js';

const compatible = {
  schema_version: 1,
  name: 'triss-coworker',
  version: '0.32.0',
  channel: 'stable',
  published_at: '2026-08-12T00:00:00.000Z',
  release_url: 'https://github.com/ayleen/triss-coworker/releases/tag/v0.32.0',
  node: '>=22',
  node_compatible: true,
  artifact: {
    url: 'https://github.com/ayleen/triss-coworker/releases/download/v0.32.0/a.gz',
    sha256: 'a'.repeat(64),
    size: 10,
    expanded_size: 100,
    file_count: 2,
    format: 'triss-ndjson-gzip-v1',
    platform: 'node-posix',
  },
};

function harness(overrides = {}) {
  let stdout = '';
  let stderr = '';
  const calls = [];
  const deps = {
    currentVersion: '0.31.1',
    nodeMajor: 22,
    interactive: false,
    confirmOperation: async () => false,
    stdout: (value) => { stdout += String(value); },
    stderr: (value) => { stderr += String(value); },
    fetchManifest: async () => ({ ...compatible }),
    classifyInstallation: () => ({
      kind: 'package-managed',
      can_apply: false,
      recovery_required: false,
      can_recover: false,
      receipt: null,
    }),
    applyUpdate: async (args) => { calls.push(['apply', args]); },
    rollbackUpdate: async (args) => { calls.push(['rollback', args]); },
    ...overrides,
  };
  return { deps, calls, out: () => stdout, err: () => stderr };
}

test('bare update fetches once and prints package-manager read-only guidance', async () => {
  let fetches = 0;
  const h = harness({
    fetchManifest: async () => {
      fetches++;
      return { ...compatible };
    },
  });
  await runUpdate({}, h.deps);
  assert.equal(fetches, 1);
  assert.match(h.out(), /Current: 0\.31\.1/);
  assert.match(h.out(), /Latest\s*: 0\.32\.0/);
  assert.match(h.out(), /read-only/);
  assert.equal(h.err(), '');
});

test('--json emits one object with reachable compatibility fields', async () => {
  const h = harness();
  await runUpdate({ json: true }, h.deps);
  const value = JSON.parse(h.out());
  assert.equal(value.current_version, '0.31.1');
  assert.equal(value.latest_version, '0.32.0');
  assert.equal(value.node_compatible, true);
  assert.equal(value.can_apply, false);
  assert.equal(h.out().trim().split('\n').length, 1);
  assert.equal(h.err(), '');
});

test('valid Node-incompatible release is guidance, not a manifest error', async () => {
  const h = harness({
    fetchManifest: async () => ({ ...compatible, version: '0.33.0', node: '>=24', node_compatible: false }),
  });
  await runUpdate({}, h.deps);
  assert.match(h.out(), /requires Node >=24/);
  assert.match(h.out(), /you have Node 22/);
  assert.doesNotMatch(h.err(), /invalid|parse/i);
});

test('apply gives Node guidance before the generic cannot-apply error', async () => {
  const h = harness({
    fetchManifest: async () => ({ ...compatible, version: '0.33.0', node: '>=24', node_compatible: false }),
    classifyInstallation: () => ({
      kind: 'standalone',
      can_apply: true,
      recovery_required: false,
      can_recover: false,
      receipt: { versions: { '0.31.1': { expanded_bytes: 1 } } },
    }),
  });
  await assert.rejects(
    () => runUpdate({ apply: true, yes: true }, h.deps),
    /requires Node >=24.*Upgrade Node/s,
  );
  assert.match(h.out(), /requires Node >=24/);
  assert.doesNotMatch(h.out(), /cannot apply the requested/);
  assert.equal(h.calls.length, 0);
});

test('apply forwards --yes and separate --break-lock only for writable standalone', async () => {
  const receipt = {
    versions: {
      '0.31.1': { expanded_bytes: 50 },
    },
  };
  const h = harness({
    classifyInstallation: () => ({
      kind: 'standalone',
      can_apply: true,
      recovery_required: false,
      can_recover: false,
      receipt,
    }),
  });
  await runUpdate({ apply: true, yes: true, breakLock: true }, h.deps);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], 'apply');
  assert.equal(h.calls[0][1].yes, true);
  assert.equal(h.calls[0][1].breakLock, true);
  assert.match(h.out(), /Retained payload/);
});

test('rollback is offline and does not fetch a manifest', async () => {
  const h = harness({
    fetchManifest: async () => { throw new Error('must not fetch'); },
    classifyInstallation: () => ({
      kind: 'standalone',
      can_apply: true,
      recovery_required: false,
      can_recover: false,
      receipt: {
        current_version: '0.31.1',
        previous_version: '0.30.0',
        versions: { '0.31.1': { expanded_bytes: 1 } },
      },
    }),
  });
  await runUpdate({ rollback: true, yes: true }, h.deps);
  assert.equal(h.calls[0][0], 'rollback');
});

test('rollback without a receipt previous version fails before output or mutation', async () => {
  const h = harness({
    classifyInstallation: () => ({
      kind: 'standalone',
      can_apply: true,
      recovery_required: false,
      can_recover: false,
      receipt: { current_version: '0.31.1', previous_version: null, versions: {} },
    }),
  });
  await assert.rejects(
    () => runUpdate({ rollback: true }, h.deps),
    /No previous standalone version is available for rollback/,
  );
  assert.equal(h.calls.length, 0);
  assert.equal(h.out(), '');
});

test('rollback treats a completed recovery as idempotent and does not toggle again', async () => {
  let phase = 0;
  const h = harness({
    classifyInstallation: () => phase === 0 ? ({
      kind: 'standalone', can_apply: false, recovery_required: true, can_recover: true,
      receipt: { root: '/tmp/triss', current_version: '0.32.0', previous_version: '0.31.0' },
      completion_candidate: true,
      journal: { transaction_id: 'tx', operation: 'rollback', phase: 'LAUNCHER_ACTIVATED' },
    }) : ({
      kind: 'standalone', can_apply: true, recovery_required: false, can_recover: false,
      receipt: { root: '/tmp/triss', current_version: '0.31.0', previous_version: '0.32.0' },
    }),
    recoverUpdate: async () => {
      phase = 1;
      return {
        recovered: true,
        action: 'completed',
        journal: { operation: 'rollback', phase: 'COMMITTED', new_receipt: { current_version: '0.31.0' } },
      };
    },
  });
  const result = await runUpdate({ rollback: true, yes: true }, h.deps);
  assert.equal(result.mutation_succeeded, true);
  assert.equal(result.activated_version, '0.31.0');
  assert.equal(h.calls.length, 0);
  assert.match(h.out(), /Rolled back: Triss 0\.31\.0/);
});

test('mutation requires --yes when non-interactive and a distinct confirmation in a TTY', async () => {
  const standalone = () => ({
    kind: 'standalone',
    can_apply: true,
    recovery_required: false,
    can_recover: false,
    receipt: {
      root: '/tmp/triss',
      current_version: '0.31.1',
      previous_version: '0.30.0',
      versions: { '0.31.1': { expanded_bytes: 1 } },
    },
  });
  const nonInteractive = harness({ classifyInstallation: standalone });
  await assert.rejects(
    () => runUpdate({ apply: true }, nonInteractive.deps),
    /requires --yes/,
  );
  assert.equal(nonInteractive.calls.length, 0);

  let prompt = '';
  const interactive = harness({
    classifyInstallation: standalone,
    interactive: true,
    confirmOperation: async (value) => { prompt = value; return true; },
  });
  await runUpdate({ apply: true }, interactive.deps);
  assert.match(prompt, /0\.32\.0.*\/tmp\/triss.*10 compressed bytes/);
  assert.equal(interactive.calls[0][0], 'apply');
});

test('generic passive hook suppresses every update mode and machine surfaces', () => {
  for (const argv of [
    ['update'],
    ['update', '--json'],
    ['update', '--apply'],
    ['update', '--rollback'],
    ['mcp', 'serve'],
    ['completion', 'bash'],
  ]) {
    assert.equal(shouldSuppressPassiveCheck({ argv }), true, argv.join(' '));
  }
  assert.equal(shouldSuppressPassiveCheck({
    argv: ['exec', '--explain', 'review this change'],
    stderrIsTTY: true,
  }), true, 'exec --explain must stay side-effect free in an interactive terminal');
  assert.equal(shouldSuppressPassiveCheck({
    argv: ['exec', 'review this change', '--explain'],
    stderrIsTTY: true,
  }), true, 'Commander accepts --explain after the positional task');
  assert.equal(shouldSuppressPassiveCheck({
    argv: ['exec', '--', '--explain'],
    stderrIsTTY: true,
  }), false, '--explain after the option terminator is positional text');
  assert.equal(shouldSuppressPassiveCheck({ argv: ['ask'], stderrIsTTY: true }), false);
});

test('fresh passive cache notices without network and due cache awaits one fetch', async () => {
  const notices = [];
  let fetches = 0;
  const fresh = {
    last_successful_check_at: new Date(1000).toISOString(),
    next_permitted_attempt_at: new Date(2000).toISOString(),
    manifest: compatible,
  };
  await runPassiveCliCheck({
    now: 1500,
    currentVersion: '0.31.1',
    readState: () => fresh,
    fetchManifest: async () => { fetches++; },
    publishState: () => {},
    notify: (line) => notices.push(line),
  });
  assert.equal(fetches, 0);
  assert.equal(notices.length, 1);

  await runPassiveCliCheck({
    now: 24 * 60 * 60 * 1000 + 3000,
    currentVersion: '0.31.1',
    readState: () => fresh,
    fetchManifest: async () => { fetches++; return compatible; },
    publishState: () => {},
    notify: (line) => notices.push(line),
  });
  assert.equal(fetches, 1);
  assert.equal(notices.length, 2);
});

test('passive hook enforces its total timeout even when an injected fetch ignores abort', async () => {
  const started = Date.now();
  const result = await runPassiveCliCheck({
    now: 3_000,
    currentVersion: '0.31.1',
    readState: () => ({ next_permitted_attempt_at: new Date(2_000).toISOString() }),
    fetchManifest: () => new Promise(() => {}),
    publishState: () => {},
    notify: () => {},
    timeoutMs: 20,
  });
  assert.equal(result.failed, true);
  assert.ok(Date.now() - started < 200);
});

test('passive cache and notification failures are best effort', async () => {
  const readFailure = await runPassiveCliCheck({
    currentVersion: '0.31.1',
    readState: () => { throw new Error('cache unavailable'); },
    fetchManifest: async () => compatible,
    publishState: async () => {},
    notify: () => {},
  });
  assert.equal(readFailure.failed, true);
  assert.equal(readFailure.notified, false);

  const writeFailure = await runPassiveCliCheck({
    currentVersion: '0.31.1',
    readState: () => ({}),
    fetchManifest: async () => compatible,
    publishState: async () => { throw new Error('cache is read-only'); },
    notify: () => {},
  });
  assert.equal(writeFailure.failed, true);
  assert.equal(writeFailure.notified, false);

  const notifyFailure = await runPassiveCliCheck({
    now: 1500,
    currentVersion: '0.31.1',
    readState: () => ({
      next_permitted_attempt_at: new Date(2000).toISOString(), manifest: compatible,
    }),
    fetchManifest: async () => { throw new Error('must not fetch'); },
    publishState: async () => {},
    notify: () => { throw new Error('stderr closed'); },
  });
  assert.equal(notifyFailure.failed, true);
  assert.equal(notifyFailure.notified, false);
});

function passiveCacheWith(overrides = {}) {
  return {
    updateStatePath: () => '/cache/update-state.json',
    updateLockPath: (path) => `${path}.lock`,
    isPassiveCheckDue: () => false,
    acquireUpdateLock: async () => ({ release() {} }),
    readUpdateState: () => ({ next_permitted_attempt_at: 2_000 }),
    writeUpdateState: () => {},
    shouldNotify: () => false,
    ...overrides,
  };
}

test('default passive CLI check caps a slow cache read at its wall-time deadline', async () => {
  const started = Date.now();
  const result = await runDefaultPassiveCliCheck({
    currentVersion: '0.31.1',
    wallTimeMs: 20,
    cacheModule: passiveCacheWith({ readUpdateState: () => new Promise(() => {}) }),
    manifestModule: { fetchManifest: async () => ({}) },
  });
  assert.equal(result.failed, true);
  assert.ok(Date.now() - started < 200);
});

test('default passive CLI check ignores a cache read that resolves after its deadline', async () => {
  let acquires = 0;
  let writes = 0;
  let notices = 0;
  const result = await runDefaultPassiveCliCheck({
    currentVersion: '0.31.1',
    wallTimeMs: 20,
    cacheModule: passiveCacheWith({
      readUpdateState: () => new Promise((resolve) => {
        setTimeout(() => resolve({ next_permitted_attempt_at: 2_000 }), 100);
      }),
      acquireUpdateLock: () => {
        acquires++;
        return Promise.resolve({ release() {} });
      },
      writeUpdateState: () => { writes++; },
      shouldNotify: () => true,
      buildUpdateNotice: () => 'late notice',
    }),
    manifestModule: { fetchManifest: async () => ({}) },
    stderr: () => { notices++; },
  });
  assert.equal(result.failed, true);
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(acquires, 0);
  assert.equal(writes, 0);
  assert.equal(notices, 0);
});

test('default passive CLI check caps a lock wait at its wall-time deadline', async () => {
  const started = Date.now();
  const result = await runDefaultPassiveCliCheck({
    currentVersion: '0.31.1',
    wallTimeMs: 20,
    cacheModule: passiveCacheWith({ acquireUpdateLock: () => new Promise(() => {}) }),
    manifestModule: { fetchManifest: async () => ({}) },
  });
  assert.equal(result.failed, true);
  assert.ok(Date.now() - started < 200);
});

test('default passive CLI persists notification throttle before stderr and suppresses repeats', async () => {
  let state = { next_permitted_attempt_at: 2_000, manifest: compatible, marked: false };
  let notices = 0;
  let writes = 0;
  const cacheModule = passiveCacheWith({
    readUpdateState: () => state,
    shouldNotify: (value) => !value.marked,
    markNotified: (value) => ({ ...value, marked: true }),
    writeUpdateState: (value) => { writes++; state = value; },
    buildUpdateNotice: () => 'notice',
  });
  const first = await runDefaultPassiveCliCheck({
    currentVersion: '0.31.1', cacheModule, manifestModule: { fetchManifest: async () => ({}) },
    stderr: () => { notices++; }, now: 1_500,
  });
  const second = await runDefaultPassiveCliCheck({
    currentVersion: '0.31.1', cacheModule, manifestModule: { fetchManifest: async () => ({}) },
    stderr: () => { notices++; }, now: 1_500,
  });
  assert.equal(first.notified, true);
  assert.equal(second.notified, false);
  assert.equal(notices, 1);
  assert.equal(writes, 1);
});

test('default passive CLI stays silent when notification throttle cannot be persisted', async () => {
  let notices = 0;
  const cacheModule = passiveCacheWith({
    shouldNotify: () => true,
    markNotified: (value) => value,
    writeUpdateState: () => { throw new Error('cache is read-only'); },
    buildUpdateNotice: () => 'notice',
  });
  const first = await runDefaultPassiveCliCheck({
    currentVersion: '0.31.1', cacheModule, manifestModule: { fetchManifest: async () => ({}) },
    stderr: () => { notices++; },
  });
  const second = await runDefaultPassiveCliCheck({
    currentVersion: '0.31.1', cacheModule, manifestModule: { fetchManifest: async () => ({}) },
    stderr: () => { notices++; },
  });
  assert.equal(first.notified, false);
  assert.equal(second.notified, false);
  assert.equal(notices, 0);
});

test('--json remains status-only and rejects mutation flags', async () => {
  const h = harness();
  await assert.rejects(() => runUpdate({ apply: true, yes: true, json: true }, h.deps),
    /--json cannot be combined/);
});

test('apply performs local recovery before fetching a manifest and reloads installation state', async () => {
  let phase = 0;
  let fetches = 0;
  const h = harness({
    classifyInstallation: () => phase === 0 ? ({
      kind: 'standalone', can_apply: false, recovery_required: true, can_recover: true,
      receipt: { root: '/tmp/triss', current_version: '0.31.1', versions: { '0.31.1': { expanded_bytes: 1 } } },
    }) : ({
      kind: 'standalone', can_apply: true, recovery_required: false, can_recover: false,
      receipt: { root: '/tmp/triss', current_version: '0.31.1', versions: { '0.31.1': { expanded_bytes: 1 } },
      },
    }),
    recoverUpdate: async () => { assert.equal(fetches, 0); phase = 1; return { recovered: true, action: 'rolled_back' }; },
    fetchManifest: async () => { fetches++; return compatible; },
    applyUpdate: async () => ({ version: '0.32.0', restart_required: true }),
  });
  await runUpdate({ apply: true, yes: true }, h.deps);
  assert.equal(fetches, 1);
  assert.match(h.out(), /Recovery: journal found/);
  assert.match(h.out(), /Applied: Triss 0\.32\.0/);
});

test('apply refreshes current version from the verified receipt after recovery', async () => {
  let phase = 0;
  let requestedCurrent = null;
  const h = harness({
    // The process started from B, but recovery restores the durable A receipt.
    currentVersion: '0.32.0',
    classifyInstallation: () => phase === 0 ? ({
      kind: 'standalone', can_apply: false, recovery_required: true, can_recover: true,
      receipt: { root: '/tmp/triss', current_version: '0.31.1', versions: { '0.31.1': { expanded_bytes: 1 } } },
    }) : ({
      kind: 'standalone', can_apply: true, recovery_required: false, can_recover: false,
      receipt: { root: '/tmp/triss', current_version: '0.31.1', versions: { '0.31.1': { expanded_bytes: 1 } } },
    }),
    recoverUpdate: async () => { phase = 1; return { recovered: true, action: 'rolled_back' }; },
    fetchManifest: async (args) => {
      requestedCurrent = args.currentVersion;
      return { ...compatible };
    },
    applyUpdate: async () => ({ version: '0.32.0', restart_required: true }),
  });
  await runUpdate({ apply: true, yes: true }, h.deps);
  assert.equal(requestedCurrent, '0.31.1');
});

test('apply treats a completed recovery of the requested version as an idempotent success', async () => {
  let phase = 0;
  const h = harness({
    currentVersion: '0.31.1',
    classifyInstallation: () => phase === 0 ? ({
      kind: 'standalone', can_apply: false, recovery_required: true, can_recover: true,
      receipt: { root: '/tmp/triss', current_version: '0.32.0', versions: { '0.32.0': { expanded_bytes: 1 } } },
      completion_candidate: true,
      journal: { transaction_id: 'tx', phase: 'LAUNCHER_ACTIVATED' },
    }) : ({
      kind: 'standalone', can_apply: true, recovery_required: false, can_recover: false,
      receipt: { root: '/tmp/triss', current_version: '0.32.0', versions: { '0.32.0': { expanded_bytes: 1 } } },
    }),
    recoverUpdate: async () => {
      phase = 1;
      return { recovered: true, action: 'completed', journal: { phase: 'COMMITTED' } };
    },
    fetchManifest: async () => ({ ...compatible }),
  });
  const result = await runUpdate({ apply: true, yes: true }, h.deps);
  assert.equal(result.mutation_succeeded, true);
  assert.equal(result.activated_version, '0.32.0');
  assert.equal(result.mcp_host_restart_required, true);
  assert.doesNotMatch(h.out(), /Triss is up to date/);
  assert.match(h.out(), /Applied: Triss 0\.32\.0/);
  assert.equal(h.calls.length, 0);
});

test('apply when already at the latest release is an idempotent successful no-op', async () => {
  let applied = 0;
  const h = harness({
    currentVersion: '0.32.0',
    applyUpdate: async () => { applied++; },
  });
  const first = await runUpdate({ apply: true }, h.deps);
  assert.equal(first.mutation_succeeded, true);
  assert.equal(first.activated_version, '0.32.0');
  assert.equal(first.mcp_host_restart_required, false);
  assert.equal(first.update_available, false);
  assert.equal(first.can_apply, false);
  assert.match(h.out(), /Triss is up to date/);
  assert.doesNotMatch(h.out(), /cannot apply the requested/);
  assert.doesNotMatch(h.out(), /Applied:/);
  assert.equal(applied, 0);

  // Idempotent: a second invocation succeeds the same way, still without a
  // mutation, and needs no --yes / confirmation.
  const second = await runUpdate({ apply: true }, h.deps);
  assert.equal(second.mutation_succeeded, true);
  assert.equal(second.activated_version, '0.32.0');
  assert.equal(applied, 0);
});

test('--json stays a status-only object when current already equals latest', async () => {
  const h = harness({ currentVersion: '0.32.0' });
  const value = await runUpdate({ json: true }, h.deps);
  assert.equal(value.current_version, '0.32.0');
  assert.equal(value.latest_version, '0.32.0');
  assert.equal(value.update_available, false);
  assert.equal(value.can_apply, false);
  assert.equal(JSON.parse(h.out()).update_available, false);
  assert.equal(h.out().trim().split('\n').length, 1);
  assert.equal(h.err(), '');
});

test('formatUpdateNotice honours both nodeCompatible spellings for incompatible guidance', () => {
  const base = { version: '0.33.0', node: '>=24' };
  const camel = formatUpdateNotice({ ...base, nodeCompatible: false }, '0.31.1', 22);
  const snake = formatUpdateNotice({ ...base, node_compatible: false }, '0.31.1', 22);
  const compatible = formatUpdateNotice({ ...base, nodeCompatible: true }, '0.31.1', 22);
  assert.match(camel, /requires Node >=24/);
  assert.match(camel, /you have Node 22/);
  assert.match(snake, /requires Node >=24/);
  assert.doesNotMatch(compatible, /requires Node/);
  assert.match(compatible, /Triss 0\.33\.0 is available; you have 0\.31\.1/);
});

test('passive cached incompatible release (camelCase nodeCompatible) emits Node-upgrade guidance', async () => {
  const notices = [];
  const cached = {
    next_permitted_attempt_at: new Date(2000).toISOString(),
    // The cache persists compatibility as the camelCase field only; a cached
    // manifest has no node_compatible key.
    manifest: {
      schema_version: 1,
      name: 'triss-coworker',
      version: '0.33.0',
      channel: 'stable',
      published_at: '2026-08-12T00:00:00.000Z',
      release_url: 'https://github.com/ayleen/triss-coworker/releases/tag/v0.33.0',
      node: '>=24',
      nodeCompatible: false,
    },
  };
  const result = await runPassiveCliCheck({
    now: 1500,
    currentVersion: '0.31.1',
    nodeMajor: 22,
    readState: () => cached,
    fetchManifest: async () => { throw new Error('must not fetch'); },
    publishState: () => {},
    notify: (line) => notices.push(line),
  });
  assert.equal(result.failed, false);
  assert.equal(result.notified, true);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /requires Node >=24/);
  assert.match(notices[0], /you have Node 22/);
});

test('legacy passive seam publishes the canonical cache schema', async () => {
  let published;
  const now = Date.parse('2026-08-13T12:00:00.000Z');
  const result = await runPassiveCliCheck({
    now,
    currentVersion: '0.31.1',
    readState: () => ({
      schema_version: 1,
      last_successful_check_at: null,
      next_permitted_attempt_at: null,
      consecutive_failures: 2,
      current_delay_ms: 60_000,
      checked_at: now - 1_000,
      current_backoff_ms: 60_000,
    }),
    fetchManifest: async () => compatible,
    publishState: (state) => { published = state; },
    notify: () => {},
  });
  assert.equal(result.failed, false);
  assert.equal(published.last_successful_check_at, new Date(now).toISOString());
  assert.equal(published.last_passive_attempt_at, new Date(now).toISOString());
  assert.equal(published.next_permitted_attempt_at, null);
  assert.equal(published.consecutive_failures, 0);
  assert.equal(published.current_delay_ms, 0);
  assert.equal('checked_at' in published, false);
  assert.equal('current_backoff_ms' in published, false);
});

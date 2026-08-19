import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createEmptyState, readUpdateState, writeUpdateState, isPassiveCheckDue,
  recordPassiveFailure, recordSuccessfulCheck, recordExplicitFailure,
  shouldNotify, markNotified, buildUpdateNotice, acquireUpdateLock,
  processStartIdentity,
  UPDATE_STATE_MAX_BYTES, CACHE_LOCK_MAX_BYTES,
} from '../src/update/cache.js';
import { updateProcessIdentity } from '../src/update/install.js';

function tempState() {
  const dir = mkdtempSync(join(tmpdir(), 'triss-update-'));
  return join(dir, 'nested', 'update-state.json');
}

function cachePublicationTemp(path, owner) {
  const tuple = [1, owner.nonce, owner.pid, owner.process_start_identity, owner.acquired_at];
  return `${path}.${Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url')}.tmp`;
}

test('cache persists backoff and keeps explicit failures separate', () => {
  const path = tempState();
  const empty = createEmptyState();
  const failed = recordPassiveFailure(empty, 'timeout', 0);
  assert.equal(failed.consecutive_failures, 1);
  assert.equal(failed.current_delay_ms, 60 * 60 * 1000);
  const explicit = recordExplicitFailure(failed, 'http', 1000);
  assert.equal(explicit.consecutive_failures, 1);
  assert.equal(explicit.last_passive_attempt_at, failed.last_passive_attempt_at);
  writeUpdateState(explicit, path);
  assert.deepEqual(readUpdateState(path), explicit);
  assert.equal(isPassiveCheckDue(explicit, 1), false);
});

test('cache state fsyncs its parent after the atomic rename', () => {
  const path = tempState();
  const events = [];
  writeUpdateState(createEmptyState(), path, {
    rename: (temporary, target) => {
      events.push('rename');
      renameSync(temporary, target);
    },
    fsyncDirectory: (directory) => events.push(`fsync:${directory}`),
  });
  assert.deepEqual(events, ['rename', `fsync:${dirname(path)}`]);
});

test('a structurally valid cache with an invalid manifest is a cache miss', () => {
  const path = tempState();
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({
    ...createEmptyState(),
    manifest: { version: 'not-semver' },
  }));
  assert.deepEqual(readUpdateState(path), createEmptyState());
});

test('cache state and lock metadata reads are bounded and reject symlink swaps', async () => {
  const path = tempState();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.alloc(UPDATE_STATE_MAX_BYTES + 1, 0x20));
  assert.deepEqual(readUpdateState(path), createEmptyState());

  const outside = join(dirname(path), 'outside-state.json');
  writeFileSync(outside, JSON.stringify(createEmptyState()));
  unlinkSync(path);
  symlinkSync(outside, path);
  assert.deepEqual(readUpdateState(path), createEmptyState());

  const lock = `${path}.lock`;
  writeFileSync(lock, Buffer.alloc(CACHE_LOCK_MAX_BYTES + 1, 0x20));
  assert.equal(await acquireUpdateLock({
    lockPath: lock,
    probe: () => ({ exists: false, identity: null }),
  }), null);
});

test('an impossible future cache timestamp is a cache miss and passive work is due', () => {
  const path = tempState();
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({
    ...createEmptyState(),
    last_successful_check_at: '9999-01-01T00:00:00.000Z',
  }));
  assert.deepEqual(readUpdateState(path), createEmptyState());
  assert.equal(isPassiveCheckDue({
    ...createEmptyState(),
    next_permitted_attempt_at: '9999-01-01T00:00:00.000Z',
  }), true);
});

test('successful explicit check resets passive backoff and records its own attempt', () => {
  const failed = recordPassiveFailure(createEmptyState(), 'dns', 0);
  const success = recordSuccessfulCheck(failed, { manifest: { version: '0.32.0' } }, { now: 2, mode: 'explicit' });
  assert.equal(success.consecutive_failures, 0);
  assert.equal(success.last_explicit_attempt_at, new Date(2).toISOString());
  assert.equal(success.manifest.version, '0.32.0');
});

test('a late older response cannot replace a newer cached manifest generation', () => {
  const newer = recordSuccessfulCheck(createEmptyState(), {
    checked_at: '2026-08-12T12:00:02.000Z',
    manifest: { version: '0.33.0' },
  });
  const stale = recordSuccessfulCheck(newer, {
    checked_at: '2026-08-12T12:00:01.000Z',
    manifest: { version: '0.32.0' },
  });
  assert.equal(stale.manifest.version, '0.33.0');
  assert.equal(stale.last_successful_check_at, '2026-08-12T12:00:02.000Z');
});

test('notification throttle rechecks current version and supports incompatible guidance', () => {
  let state = recordSuccessfulCheck(createEmptyState(), {
    manifest: { version: '0.33.0', node: '>=24', nodeCompatible: false },
  }, { now: 0 });
  assert.equal(shouldNotify(state, { channel: 'cli', currentVersion: '0.32.0', now: 1 }), true);
  state = markNotified(state, 'cli', '0.33.0', 1);
  assert.equal(shouldNotify(state, { channel: 'cli', currentVersion: '0.32.0', now: 2 }), false);
  assert.equal(shouldNotify(state, { channel: 'cli', currentVersion: '0.34.0', now: 2 }), false);
  assert.match(buildUpdateNotice(state.manifest, '0.32.0', 22), /requires Node >=24/);
});

test('cache lock recovers absent owner but does not remove ambiguous owner', async () => {
  const path = tempState() + '.lock';
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ nonce: 'old', pid: 123, process_start_identity: 'a', acquired_at: new Date(0).toISOString() }));
  const lock = await acquireUpdateLock({ lockPath: path, pid: 456, identity: 'b', probe: () => ({ exists: false }), now: () => 1000 });
  assert.ok(lock);
  lock.release();
  writeFileSync(path, JSON.stringify({ nonce: 'old', pid: 123, process_start_identity: 'a', acquired_at: new Date(0).toISOString() }));
  const skipped = await acquireUpdateLock({ lockPath: path, pid: 456, identity: 'b', probe: () => null, now: () => 1000 });
  assert.equal(skipped, null);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).nonce, 'old');
});

test('cache stale-break contention cannot unlink the other breaker claim', async () => {
  const path = tempState() + '.lock';
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({
    nonce: 'old', pid: 123, process_start_identity: 'proc:old',
    acquired_at: new Date(0).toISOString(),
  }));
  const alias = `${path}.break-link`;
  linkSync(path, alias);
  const skipped = await acquireUpdateLock({
    lockPath: path, pid: 456, identity: 'proc:new',
    probe: () => ({ exists: false }), now: () => 1000,
  });
  assert.equal(skipped, null);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).nonce, 'old');
  assert.equal(existsSync(alias), false, 'an orphaned claim alias must be recoverable');
  const lock = await acquireUpdateLock({
    lockPath: path, pid: 456, identity: 'proc:new',
    probe: () => ({ exists: false }), now: () => 1000,
  });
  assert.ok(lock);
  lock.release();
});

test('cache stale-break never removes a foreign break-link', async () => {
  const path = tempState() + '.lock';
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ nonce: 'old', pid: 123, process_start_identity: 'proc:old' }));
  const alias = `${path}.break-link`;
  symlinkSync(join(path, '..', 'foreign'), alias);
  await assert.rejects(() => acquireUpdateLock({
    lockPath: path, pid: 456, identity: 'proc:new',
    probe: () => ({ exists: false }), now: () => 1000,
  }), /break-link|owned|symlink/i);
  assert.equal(lstatSync(alias).isSymbolicLink(), true);
});

test('cache recovers a break-link orphan left after final lock unlink', async () => {
  const path = tempState() + '.lock';
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({
    nonce: 'old', pid: 123, process_start_identity: 'proc:old',
  }));
  const alias = `${path}.break-link`;
  linkSync(path, alias);
  unlinkSync(path); // crash simulation after the final-name unlink
  const lock = await acquireUpdateLock({
    lockPath: path, pid: 456, identity: 'proc:new',
    probe: () => ({ exists: false }), now: () => 1000,
  });
  assert.ok(lock);
  assert.equal(existsSync(alias), false);
  lock.release();
});

test('cache removes a same-inode marker/temp/final publication alias before stale recovery', async () => {
  const path = tempState() + '.lock';
  mkdirSync(join(path, '..'), { recursive: true });
  const metadata = {
    nonce: 'old', pid: 123, process_start_identity: 'proc:old',
    acquired_at: new Date(0).toISOString(),
  };
  writeFileSync(path, JSON.stringify(metadata));
  const alias = cachePublicationTemp(path, metadata);
  mkdirSync(`${alias}.owner`);
  linkSync(path, join(`${alias}.owner`, 'payload'));
  const lock = await acquireUpdateLock({
    lockPath: path, pid: 456, identity: 'proc:new',
    probe: () => ({ exists: false }), now: () => 1000,
  });
  assert.ok(lock);
  lock.release();
  assert.equal(existsSync(alias), false);
  assert.equal(existsSync(path), false);
});

test('cache validates every publication container before removing any contender', async () => {
  const makeMarker = (path, owner, payload = '{', invalid = false) => {
    const marker = `${cachePublicationTemp(path, owner)}.owner`;
    mkdirSync(marker);
    writeFileSync(join(marker, 'payload'), payload);
    if (invalid) writeFileSync(join(marker, 'foreign'), 'foreign');
    return marker;
  };
  for (const withFinal of [false, true]) {
    const path = tempState() + '.lock';
    mkdirSync(join(path, '..'), { recursive: true });
    if (withFinal) writeFileSync(path, JSON.stringify({
      nonce: 'final', pid: 333, process_start_identity: 'proc:final', acquired_at: new Date(0).toISOString(),
    }));
    const abandoned = makeMarker(path, {
      nonce: 'a', pid: 111, process_start_identity: 'proc:old', acquired_at: new Date(0).toISOString(),
    });
    const live = makeMarker(path, {
      nonce: 'b', pid: 222, process_start_identity: 'proc:live', acquired_at: new Date(0).toISOString(),
    });
    const before = withFinal ? readFileSync(path) : null;
    await assert.rejects(() => acquireUpdateLock({
      lockPath: path, pid: 456, identity: 'proc:new', maxWaitMs: 0,
      probe: (pid) => pid === 111 ? { exists: false } : { exists: true, identity: 'proc:live' },
      now: () => 1000,
    }), /ambiguous|owner/);
    assert.equal(existsSync(abandoned), true);
    assert.equal(existsSync(live), true);
    if (withFinal) assert.deepEqual(readFileSync(path), before);
  }
  const path = tempState() + '.lock';
  mkdirSync(join(path, '..'), { recursive: true });
  const finalText = '{"final":true}\n';
  writeFileSync(path, finalText);
  const invalid = makeMarker(path, {
    nonce: 'c', pid: 111, process_start_identity: 'proc:old', acquired_at: new Date(0).toISOString(),
  }, '{', true);
  await assert.rejects(() => acquireUpdateLock({ lockPath: path, probe: () => ({ exists: false }) }), /invalid|owner/);
  assert.equal(existsSync(invalid), true);
  assert.equal(readFileSync(path, 'utf8'), finalText);
});

test('cache removes abandoned losing contenders without touching a live final lock', async () => {
  const path = tempState() + '.lock';
  mkdirSync(join(path, '..'), { recursive: true });
  const final = {
    nonce: 'final', pid: 777777, process_start_identity: 'proc:live',
    acquired_at: new Date(0).toISOString(),
  };
  const finalText = `${JSON.stringify(final)}\n`;
  writeFileSync(path, finalText);
  for (const payload of ['{', JSON.stringify({
    nonce: 'loser', pid: 123, process_start_identity: 'proc:old', acquired_at: new Date(0).toISOString(),
  })]) {
    const owner = { ...final, nonce: `loser-${payload.length}`, pid: 123, process_start_identity: 'proc:old' };
    const temporary = cachePublicationTemp(path, owner);
    mkdirSync(`${temporary}.owner`);
    writeFileSync(join(`${temporary}.owner`, 'payload'), payload);
    let probeCalls = 0;
    const lock = await acquireUpdateLock({
      lockPath: path, pid: 456, identity: 'proc:new', maxWaitMs: 0,
      probe: () => (probeCalls++ === 0 ? { exists: false } : { exists: true, identity: 'proc:live' }),
      now: () => 1000,
    });
    assert.equal(lock, null);
    assert.equal(readFileSync(path, 'utf8'), finalText);
    assert.equal(existsSync(`${temporary}.owner`), false);
  }
});

test('cache recovers a marker-only publication before final lock', async () => {
  const path = tempState() + '.lock';
  mkdirSync(join(path, '..'), { recursive: true });
  const metadata = {
    nonce: 'partial-cache-owner', pid: 123, process_start_identity: 'proc:old',
    acquired_at: new Date(0).toISOString(),
  };
  const temporary = cachePublicationTemp(path, metadata);
  mkdirSync(`${temporary}.owner`);
  const lock = await acquireUpdateLock({
    lockPath: path, pid: 456, identity: 'proc:new', probe: () => ({ exists: false }),
    now: () => 1000,
  });
  assert.ok(lock);
  assert.equal(existsSync(temporary), false);
  assert.equal(existsSync(`${temporary}.owner`), false);
  lock.release();
});

test('cache leaves a marker-less partial publication temp untouched', async () => {
  const path = tempState() + '.lock';
  mkdirSync(join(path, '..'), { recursive: true });
  const temporary = `${path}.foreign.tmp`;
  writeFileSync(temporary, '{');
  await assert.rejects(() => acquireUpdateLock({
    lockPath: path, pid: 456, identity: 'proc:new', probe: () => ({ exists: false }),
    now: () => 1000,
  }), /publication alias|owner|metadata/i);
  assert.equal(existsSync(temporary), true);
});

test('cache never claims or deletes a foreign temp when the injected nonce collides', async () => {
  const path = tempState() + '.lock';
  mkdirSync(join(path, '..'), { recursive: true });
  const nonce = 'fixed-collision-nonce';
  const temporary = `${path}.${nonce}.tmp`;
  const foreign = '{foreign bytes that must survive}';
  writeFileSync(temporary, foreign);

  await assert.rejects(() => acquireUpdateLock({
    lockPath: path, nonce, pid: 456, identity: 'proc:new',
    probe: () => ({ exists: false }), now: () => 1000,
  }), /publication alias|owner|metadata/i);
  assert.equal(readFileSync(temporary, 'utf8'), foreign);
  assert.equal(existsSync(`${temporary}.owner`), false);
});

test('cache lock publishes a complete marker/temp/final lock and releases it', async () => {
  const path = tempState() + '.lock';
  const lock = await acquireUpdateLock({ lockPath: path, pid: 456, identity: 'proc:456', now: () => 1000 });
  lock.release();
  assert.equal(existsSync(path), false);
});

test('cache lock creates fresh owner metadata after a stale-lock retry', async () => {
  const path = tempState() + '.lock';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    nonce: 'stale-owner',
    pid: 123,
    process_start_identity: 'proc:old',
    acquired_at: new Date(0).toISOString(),
  })}\n`);
  const generated = ['first-attempt', 'second-attempt'];
  const lock = await acquireUpdateLock({
    lockPath: path,
    pid: 456,
    identity: 'proc:new',
    random: () => generated.shift(),
    probe: () => ({ exists: false, identity: null }),
    now: () => 1000,
  });
  assert.ok(lock);
  assert.equal(lock.nonce, 'second-attempt');
  assert.deepEqual(generated, []);
  lock.release();
});

test('cache lock publication tuple supports safe pid and canonical macOS ps identity', async () => {
  const path = tempState() + '.lock';
  const lock = await acquireUpdateLock({
    lockPath: path,
    pid: Number.MAX_SAFE_INTEGER,
    identity: 'ps:Wed Aug 13 12:34:56 2026',
    nonce: 'b'.repeat(32),
    now: () => Date.parse('2026-08-13T12:34:56.000Z'),
  });
  const names = readdirSync(dirname(path));
  assert.ok(names.every((name) => Buffer.byteLength(name, 'utf8') <= 240));
  lock.release();
});

test('cache lock with a live null-identity owner remains ambiguous', async () => {
  const path = tempState() + '.lock';
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({
    nonce: 'old', pid: 123, process_start_identity: null,
    acquired_at: new Date(0).toISOString(),
  }));
  const skipped = await acquireUpdateLock({
    lockPath: path,
    pid: 456,
    identity: 'new',
    probe: () => ({ exists: true, identity: 'different' }),
    now: () => 1000,
  });
  assert.equal(skipped, null);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).nonce, 'old');
});

test('cache lock with an ambiguous live probe identity remains held', async () => {
  const path = tempState() + '.lock';
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({
    nonce: 'old', pid: 123, process_start_identity: 'known-owner',
    acquired_at: new Date(0).toISOString(),
  }));
  const skipped = await acquireUpdateLock({
    lockPath: path,
    pid: 456,
    identity: 'new',
    probe: () => ({ exists: true, identity: null }),
    now: () => 1000,
  });
  assert.equal(skipped, null);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).nonce, 'old');
});

test('cache lock does not compare identities from different probe schemes', async () => {
  const path = tempState() + '.lock';
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({
    nonce: 'old', pid: 123, process_start_identity: 'proc:100',
    acquired_at: new Date(0).toISOString(),
  }));
  const skipped = await acquireUpdateLock({
    lockPath: path,
    probe: () => ({ exists: true, identity: 'ps:Mon Aug 12 00:00:00 2026' }),
    now: () => 1000,
  });
  assert.equal(skipped, null);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).nonce, 'old');
});

test('macOS process-start identities use one canonical ps environment across runtimes', async () => {
  let cachePsOptions;
  let installPsOptions;
  const cacheIdentity = processStartIdentity(123, {
    readProc: () => { throw new Error('no procfs'); },
    execPs: (_command, _args, options) => {
      cachePsOptions = options;
      return '  Tue   Aug 12 10:00:00 2026\n';
    },
  });
  const installIdentity = updateProcessIdentity(123, {
    readProc: () => { throw new Error('no procfs'); },
    spawnPs: (_command, _args, options) => {
      installPsOptions = options;
      return { status: 0, stdout: 'Tue Aug 12 10:00:00 2026\n' };
    },
  });
  assert.equal(cacheIdentity, 'ps:Tue Aug 12 10:00:00 2026');
  assert.equal(installIdentity, cacheIdentity);
  for (const options of [cachePsOptions, installPsOptions]) {
    assert.equal(options.env.TZ, 'UTC');
    assert.equal(options.env.LC_ALL, 'C');
  }

  const path = tempState() + '.lock';
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({
    nonce: 'old', pid: 123, process_start_identity: cacheIdentity,
    acquired_at: new Date(0).toISOString(),
  }));
  const skipped = await acquireUpdateLock({
    lockPath: path,
    probe: () => ({ exists: true, identity: installIdentity }),
    now: () => 1000,
  });
  assert.equal(skipped, null, 'the same process must not be treated as PID reuse');
});

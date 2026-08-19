import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  linkSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  existsSync,
  unlinkSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';

import {
  acquireUpdateLock,
  classifyInstallation,
  computeRetainedStats,
  downloadArtifact,
  releaseUpdateLock,
  resolveStandalonePaths,
  writeReceiptAtomic,
  applyStandaloneUpdate,
  rollbackStandaloneUpdate,
  recoverStandaloneTransaction,
  readTransactionJournal,
  readReceipt,
  writeJournalAtomic,
  MAX_RECEIPT_BYTES,
  MAX_JOURNAL_BYTES,
  MAX_LOCK_BYTES,
} from '../src/update/install.js';
import { buildArtifact } from '../src/update/artifact.js';
import { inventoryFromDirectory, validateTree } from '../src/update/integrity.js';
import { canonicalJson } from '../src/update/artifact.js';
import { createHash } from 'node:crypto';
import { requestSequence } from './helpers/http-request.js';

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'triss-update-install-'));
}

function runtimePublicationTemp(root, metadata) {
  const tuple = [1, metadata.nonce, metadata.pid, metadata.start_identity, metadata.operation, metadata.acquired_at];
  return join(root, `.update.lock.${Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url')}.tmp`);
}

function downloadManifest(bytes) {
  return {
    artifact: {
      url: 'https://github.com/ayleen/triss-coworker/releases/download/v0.32.0/test.gz',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  };
}

function publicLookup() {
  return [{ address: '93.184.216.34', family: 4 }];
}

test('runtime artifact download permits continuous progress beyond the old total deadline', async () => {
  const bytes = Buffer.from('continuous artifact body');
  const chunks = [...bytes].map((value) => Uint8Array.of(value));
  const body = Readable.from((async function* streamChunks() {
    while (chunks.length) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 4));
      yield chunks.shift();
    }
  }()));
  const result = await downloadArtifact(downloadManifest(bytes), {
    requestImpl: requestSequence([{ stream: body }]),
    lookupImpl: publicLookup,
    downloadHeadersTimeoutMs: 50,
    downloadInactivityTimeoutMs: 20,
    downloadTotalTimeoutMs: 1_000,
  });
  assert.deepEqual(result, bytes);
});

test('runtime artifact download aborts a body that stops making progress', async () => {
  const bytes = Buffer.from('never delivered');
  const body = new Readable({ read() {} });
  await assert.rejects(() => downloadArtifact(downloadManifest(bytes), {
    requestImpl: requestSequence([{ stream: body }]),
    lookupImpl: publicLookup,
    downloadHeadersTimeoutMs: 50,
    downloadInactivityTimeoutMs: 20,
    downloadTotalTimeoutMs: 1_000,
  }), /inactivity timed out/);
});

function receipt(root, binPath, current = '0.31.1') {
  return {
    schema_version: 1,
    name: 'triss-coworker',
    managed_by: 'triss-standalone',
    state: 'active',
    root,
    bin_path: binPath,
    current_version: current,
    previous_version: null,
    channel: 'stable',
    installed_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
    versions: {
      [current]: {
        artifact_sha256: 'a'.repeat(64),
        inventory_path: `integrity/${current}.json`,
        inventory_sha256: 'b'.repeat(64),
        tree_digest: 'c'.repeat(64),
        file_count: 2,
        expanded_bytes: 1234,
        installed_at: '2026-08-12T00:00:00.000Z',
      },
    },
  };
}

test('standalone paths ignore legacy TRISS_HOME and use the new override', () => {
  const paths = resolveStandalonePaths({
    HOME: '/tmp/home',
    TRISS_HOME: '/tmp/legacy-custom',
    TRISS_STANDALONE_HOME: '/tmp/standalone-custom',
    TRISS_BIN_DIR: '/tmp/bin',
  });
  assert.equal(paths.root, '/tmp/standalone-custom');
  assert.equal(paths.legacyRoot, '/tmp/legacy-custom');
  assert.equal(paths.binPath, '/tmp/bin/triss');
});

test('validated receipt/current/launcher classify as writable standalone', () => {
  const base = tempRoot();
  const root = join(base, 'share', 'triss');
  const binDir = join(base, 'bin');
  const versionDir = join(root, 'versions', '0.31.1');
  const executable = join(versionDir, 'bin', 'triss.js');
  mkdirSync(join(versionDir, 'bin'), { recursive: true });
  mkdirSync(join(root, 'integrity'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(executable, '#!/usr/bin/env node\n');
  writeFileSync(join(root, 'integrity', '0.31.1.json'), '{}\n');
  symlinkSync('versions/0.31.1', join(root, 'current'));
  symlinkSync(join(root, 'current', 'bin', 'triss.js'), join(binDir, 'triss'));
  writeReceiptAtomic(receipt(root, join(binDir, 'triss')));

  try {
    const state = classifyInstallation({
      executablePath: join(binDir, 'triss'),
      env: { HOME: base, TRISS_STANDALONE_HOME: root, TRISS_BIN_DIR: binDir },
    });
    assert.equal(state.kind, 'standalone', state.error || state.guidance);
    assert.equal(state.can_apply, true);
    assert.equal(state.recovery_required, false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('direct versions launcher is not an active standalone layout', () => {
  const fixture = standaloneFixture();
  try {
    unlinkSync(join(fixture.binDir, 'triss'));
    symlinkSync(join(fixture.root, 'versions', fixture.receipt.current_version, 'bin', 'triss.js'), join(fixture.binDir, 'triss'));
    const state = classifyInstallation({
      executablePath: join(fixture.binDir, 'triss'),
      env: fixture.env,
    });
    assert.equal(state.kind, 'unknown');
    assert.equal(state.can_apply, false);
    assert.match(state.error, /lexical target is not canonical/i);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('standalone classification rediscovers a custom root from the running launcher', () => {
  const fixture = standaloneFixture();
  try {
    const state = classifyInstallation({
      executablePath: join(fixture.binDir, 'triss'),
      env: { HOME: fixture.base, TRISS_STANDALONE_HOME: join(fixture.base, 'wrong-root') },
    });
    assert.equal(state.kind, 'standalone', state.error || state.guidance);
    assert.equal(state.paths.root, fixture.root);
    assert.equal(state.paths.binPath, join(fixture.binDir, 'triss'));
    assert.equal(state.can_apply, true);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('missing HOME falls back to the platform home for read-only classification', () => {
  const base = tempRoot();
  const executable = join(base, 'node_modules', 'triss', 'bin', 'triss.js');
  mkdirSync(join(base, 'node_modules', 'triss', 'bin'), { recursive: true });
  writeFileSync(executable, '#!/usr/bin/env node\n');
  try {
    const state = classifyInstallation({ executablePath: executable, env: {} });
    assert.equal(state.can_apply, false);
    assert.equal(state.kind, 'package-managed');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('non-default legacy checkout stays read-only and is not standalone authority', () => {
  const base = tempRoot();
  const legacy = join(base, 'legacy-anywhere');
  mkdirSync(join(legacy, '.git'), { recursive: true });
  mkdirSync(join(legacy, 'bin'), { recursive: true });
  writeFileSync(join(legacy, 'bin', 'triss.js'), '#!/usr/bin/env node\n');
  try {
    const state = classifyInstallation({
      executablePath: join(legacy, 'bin', 'triss.js'),
      env: { HOME: base, TRISS_HOME: legacy },
    });
    assert.equal(state.kind, 'legacy-git');
    assert.equal(state.can_apply, false);
    assert.match(state.guidance, /TRISS_STANDALONE_HOME/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('retained stats sum receipt-recorded payload and project a new target', () => {
  const data = receipt('/tmp/root', '/tmp/bin/triss');
  data.versions['0.30.0'] = {
    ...data.versions['0.31.1'],
    expanded_bytes: 500,
  };
  const stats = computeRetainedStats(data, { expanded_size: 250 });
  assert.deepEqual(stats, {
    retained_versions: 2,
    retained_payload_bytes: 1734,
    projected_retained_versions: 3,
    projected_retained_payload_bytes: 1984,
  });
});

test('--yes alone cannot break a proven stale update lock', () => {
  const root = tempRoot();
  const lockPath = join(root, 'update.lock');
  writeFileSync(
    lockPath,
    JSON.stringify({ schema_version: 1, nonce: 'old', pid: 999999, start_identity: 'old' }),
  );
  try {
    assert.throws(
      () => acquireUpdateLock(root, {
        yes: true,
        breakLock: false,
        probeOwner: () => ({ state: 'absent' }),
      }),
      /--break-lock/,
    );
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).nonce, 'old');

    const lock = acquireUpdateLock(root, {
      yes: true,
      breakLock: true,
      probeOwner: () => ({ state: 'absent' }),
      pid: 123,
      startIdentity: 'proc:new',
      nonce: 'new',
    });
    assert.equal(lock.nonce, 'new');
    releaseUpdateLock(lock);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime stale-break contention preserves the other breaker claim', () => {
  const root = tempRoot();
  const lockPath = join(root, 'update.lock');
  writeFileSync(lockPath, JSON.stringify({
    schema_version: 1, nonce: 'old', pid: 999999, start_identity: 'old',
  }));
  const alias = `${lockPath}.break-link`;
  linkSync(lockPath, alias);
  try {
    assert.throws(
      () => acquireUpdateLock(root, {
        yes: true, breakLock: true,
        probeOwner: () => ({ state: 'absent' }),
        nonce: 'new', pid: 123, startIdentity: 'proc:new',
      }),
      /break is already in progress/,
    );
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).nonce, 'old');
    assert.equal(existsSync(alias), false, 'an orphaned claim alias must be recoverable');
    const lock = acquireUpdateLock(root, {
      yes: true, breakLock: true,
      probeOwner: () => ({ state: 'absent' }),
      nonce: 'new', pid: 123, startIdentity: 'proc:new',
    });
    assert.equal(lock.nonce, 'new');
    releaseUpdateLock(lock);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime stale-break never removes a foreign break-link', () => {
  const root = tempRoot();
  const lockPath = join(root, 'update.lock');
  const alias = `${lockPath}.break-link`;
  writeFileSync(lockPath, JSON.stringify({ schema_version: 1, nonce: 'old', pid: 999999, start_identity: 'old' }));
  symlinkSync(join(root, 'foreign'), alias);
  try {
    assert.throws(() => acquireUpdateLock(root, {
      yes: true, breakLock: true, probeOwner: () => ({ state: 'absent' }),
    }), /break-link|owned|symlink/i);
    assert.equal(lstatSync(alias).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime recovers a break-link orphan left after final lock unlink', () => {
  const root = tempRoot();
  const lockPath = join(root, 'update.lock');
  writeFileSync(lockPath, JSON.stringify({
    schema_version: 1, nonce: 'old', pid: 999999, start_identity: 'old',
  }));
  const alias = `${lockPath}.break-link`;
  linkSync(lockPath, alias);
  unlinkSync(lockPath); // crash simulation after the final-name unlink
  try {
    const lock = acquireUpdateLock(root, {
      yes: true, breakLock: true,
      probeOwner: () => ({ state: 'absent' }),
      nonce: 'new', pid: 123, startIdentity: 'proc:new',
    });
    assert.equal(lock.nonce, 'new');
    assert.equal(existsSync(alias), false);
    releaseUpdateLock(lock);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime removes a same-inode marker/temp/final publication alias before stale recovery', () => {
  const root = tempRoot();
  const lockPath = join(root, 'update.lock');
  const metadata = {
    schema_version: 1, nonce: 'old', pid: 999999, start_identity: 'proc:old', operation: 'update',
    acquired_at: new Date(0).toISOString(),
  };
  writeFileSync(lockPath, JSON.stringify(metadata));
  const alias = runtimePublicationTemp(root, metadata);
  mkdirSync(`${alias}.owner`);
  linkSync(lockPath, join(`${alias}.owner`, 'payload'));
  try {
    const lock = acquireUpdateLock(root, {
      yes: true, breakLock: true, probeOwner: () => ({ state: 'absent' }),
      nonce: 'new', pid: 123, startIdentity: 'proc:new',
    });
    releaseUpdateLock(lock);
    assert.equal(existsSync(alias), false);
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime validates every publication container before removing any contender', () => {
  const makeMarker = (root, metadata, payload = '{', invalid = false) => {
    const marker = `${runtimePublicationTemp(root, metadata)}.owner`;
    mkdirSync(marker);
    writeFileSync(join(marker, 'payload'), payload);
    if (invalid) writeFileSync(join(marker, 'foreign'), 'foreign');
    return marker;
  };
  for (const withFinal of [false, true]) {
    const root = tempRoot();
    const lockPath = join(root, 'update.lock');
    if (withFinal) writeFileSync(lockPath, JSON.stringify({
      schema_version: 1, nonce: 'f', pid: 333, start_identity: 'proc:final', operation: 'update',
      acquired_at: new Date(0).toISOString(),
    }));
    const abandoned = makeMarker(root, {
      schema_version: 1, nonce: 'a', pid: 111, start_identity: 'proc:old', operation: 'update',
      acquired_at: new Date(0).toISOString(),
    });
    const live = makeMarker(root, {
      schema_version: 1, nonce: 'b', pid: 222, start_identity: 'proc:live', operation: 'update',
      acquired_at: new Date(0).toISOString(),
    });
    const before = withFinal ? readFileSync(lockPath) : null;
    assert.throws(() => acquireUpdateLock(root, {
      nonce: 'new', pid: 456, startIdentity: 'proc:new', yes: true, breakLock: true,
      probeOwner: (metadata) => metadata.pid === 111 ? { state: 'absent' } : { state: 'live' },
    }), /ambiguous|held|publication/);
    assert.equal(existsSync(abandoned), true);
    assert.equal(existsSync(live), true);
    if (withFinal) assert.deepEqual(readFileSync(lockPath), before);
  }
  const root = tempRoot();
  const lockPath = join(root, 'update.lock');
  const finalText = '{"final":true}\n';
  writeFileSync(lockPath, finalText);
  const invalid = makeMarker(root, {
    schema_version: 1, nonce: 'c', pid: 111, start_identity: 'proc:old', operation: 'update',
    acquired_at: new Date(0).toISOString(),
  }, '{', true);
  assert.throws(() => acquireUpdateLock(root, { probeOwner: () => ({ state: 'absent' }) }), /invalid|owner/);
  assert.equal(existsSync(invalid), true);
  assert.equal(readFileSync(lockPath, 'utf8'), finalText);
});

test('runtime removes abandoned losing contenders without touching a live final lock', () => {
  const root = tempRoot();
  const lockPath = join(root, 'update.lock');
  const final = {
    schema_version: 1, nonce: 'final', pid: 777777, start_identity: 'proc:live', operation: 'update',
    acquired_at: new Date(0).toISOString(),
  };
  const finalText = `${JSON.stringify(final)}\n`;
  writeFileSync(lockPath, finalText);
  for (const payload of ['{', JSON.stringify({
    schema_version: 1, nonce: 'loser', pid: 123, start_identity: 'proc:old', operation: 'update',
    acquired_at: new Date(0).toISOString(),
  })]) {
    const metadata = { ...final, nonce: `loser-${payload.length}`, pid: 123, start_identity: 'proc:old' };
    const temporary = runtimePublicationTemp(root, metadata);
    mkdirSync(`${temporary}.owner`);
    writeFileSync(join(`${temporary}.owner`, 'payload'), payload);
    let probeCalls = 0;
    assert.throws(() => acquireUpdateLock(root, {
      yes: true, breakLock: true, nonce: 'new', pid: 456, startIdentity: 'proc:new',
      probeOwner: () => (probeCalls++ === 0 ? { state: 'absent' } : { state: 'live' }),
    }), /held by live|ambiguous/);
    assert.equal(readFileSync(lockPath, 'utf8'), finalText);
    assert.equal(existsSync(`${temporary}.owner`), false);
  }
});

test('runtime recovers a marker-only publication before final lock', () => {
  const root = tempRoot();
  const metadata = {
    schema_version: 1, nonce: 'partial-runtime-owner', pid: 999999, start_identity: 'proc:old', operation: 'update',
    acquired_at: new Date(0).toISOString(),
  };
  const temporary = runtimePublicationTemp(root, metadata);
  mkdirSync(`${temporary}.owner`);
  try {
    const lock = acquireUpdateLock(root, {
      yes: true, breakLock: true, probeOwner: () => ({ state: 'absent' }),
      nonce: 'new', pid: 123, startIdentity: 'proc:new',
    });
    assert.equal(lock.nonce, 'new');
    assert.equal(existsSync(temporary), false);
    assert.equal(existsSync(`${temporary}.owner`), false);
    releaseUpdateLock(lock);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime never claims or deletes a foreign temp when the injected nonce collides', () => {
  const root = tempRoot();
  const nonce = 'fixed-runtime-collision';
  const temporary = join(root, `.update.lock.${nonce}.tmp`);
  const foreign = '{foreign bytes that must survive}';
  writeFileSync(temporary, foreign);
  try {
    assert.throws(() => acquireUpdateLock(root, {
      nonce, pid: 123, startIdentity: 'proc:new',
      probeOwner: () => ({ state: 'ambiguous' }),
    }), /publication alias|owner|metadata|ambiguous/i);
    assert.equal(readFileSync(temporary, 'utf8'), foreign);
    assert.equal(existsSync(`${temporary}.owner`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime leaves a marker-less partial publication temp untouched', () => {
  const root = tempRoot();
  const temporary = join(root, `.update.lock.${'A'.repeat(16)}.tmp`);
  writeFileSync(temporary, '{');
  try {
    assert.throws(() => acquireUpdateLock(root, {
      yes: true, breakLock: true, probeOwner: () => ({ state: 'absent' }),
    }), /publication alias|owner|metadata/i);
    assert.equal(existsSync(temporary), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runtime lock publication tuple supports safe pid, canonical ps identity, and bounded long operation', () => {
  const root = tempRoot();
  try {
    const operation = 'operation-' + 'x'.repeat(32);
    const lock = acquireUpdateLock(root, {
      pid: Number.MAX_SAFE_INTEGER,
      startIdentity: 'ps:Wed Aug 13 12:34:56 2026',
      operation,
      nonce: 'a'.repeat(32),
    });
    const names = readdirSync(root);
    assert.ok(names.every((name) => Buffer.byteLength(name, 'utf8') <= 240));
    assert.equal(JSON.parse(readFileSync(join(root, 'update.lock'), 'utf8')).pid, Number.MAX_SAFE_INTEGER);
    assert.equal(JSON.parse(readFileSync(join(root, 'update.lock'), 'utf8')).operation, operation);
    releaseUpdateLock(lock);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('publishes a complete marker/temp/final lock and leaves no final lock after release', () => {
  const root = tempRoot();
  const lockPath = join(root, 'update.lock');
  try {
    const lock = acquireUpdateLock(root, { nonce: 'failed' });
    releaseUpdateLock(lock);
    assert.equal(existsSync(lockPath), false);
    assert.deepEqual(readdirSync(root), []);

    const foreign = { schema_version: 1, nonce: 'foreign', pid: 123, start_identity: 'foreign' };
    writeFileSync(lockPath, `${JSON.stringify(foreign)}\n`);
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).nonce, 'foreign');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ambiguous process identity cannot be overridden by both flags', () => {
  const root = tempRoot();
  writeFileSync(
    join(root, 'update.lock'),
    JSON.stringify({ schema_version: 1, nonce: 'old', pid: 123, start_identity: 'old' }),
  );
  try {
    assert.throws(
      () => acquireUpdateLock(root, {
        yes: true,
        breakLock: true,
        probeOwner: () => ({ state: 'ambiguous' }),
      }),
      /identity.*ambiguous/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('next locked runtime operation cleans only owned pre-journal leftovers', async () => {
  const fixture = standaloneFixture();
  const stagingParent = join(fixture.root, 'staging');
  const nonce = '12345678-1234-4123-8123-123456789abc';
  const owned = join(stagingParent, '0.32.0.abandoned');
  const unowned = join(stagingParent, 'keep-me');
  const inventoryTemp = join(fixture.root, 'integrity', `.0.32.0.${nonce}.inventory.tmp`);
  mkdirSync(owned, { recursive: true });
  mkdirSync(unowned, { recursive: true });
  writeFileSync(join(unowned, 'user-file'), 'keep');
  writeFileSync(inventoryTemp, '{}\n');
  writeFileSync(`${owned}.owner.json`, JSON.stringify({
    schema_version: 1,
    kind: 'runtime-staging',
    root: fixture.root,
    staging_path: owned,
    inventory_temp_path: inventoryTemp,
    owner_nonce: nonce,
  }));
  try {
    await assert.rejects(
      rollbackStandaloneUpdate({
        installation: classifyInstallation({
          executablePath: join(fixture.binDir, 'triss'), env: fixture.env,
        }),
        env: fixture.env,
      }),
      /No previous standalone version/,
    );
    assert.equal(existsSync(owned), false);
    assert.equal(existsSync(`${owned}.owner.json`), false);
    assert.equal(existsSync(inventoryTemp), false);
    assert.equal(existsSync(join(unowned, 'user-file')), true);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function standaloneFixture() {
  const base = tempRoot();
  const root = join(base, 'standalone');
  const binDir = join(base, 'bin');
  const currentVersion = '0.31.1';
  const currentPath = join(root, 'versions', currentVersion);
  mkdirSync(join(currentPath, 'bin'), { recursive: true });
  mkdirSync(join(root, 'integrity'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(currentPath, 'bin', 'triss.js'),
    '#!/usr/bin/env node\nconsole.log(\'0.31.1\');\n', { mode: 0o755 });
  writeFileSync(join(currentPath, 'package.json'), '{"name":"triss-coworker"}\n');
  const inventory = inventoryFromDirectory(currentPath);
  const verified = validateTree(currentPath, inventory);
  writeFileSync(join(root, 'integrity', `${currentVersion}.json`), `${canonicalJson(inventory)}\n`);
  symlinkSync(`versions/${currentVersion}`, join(root, 'current'));
  symlinkSync(join(root, 'current', 'bin', 'triss.js'), join(binDir, 'triss'));
  const entry = {
    artifact_sha256: 'a'.repeat(64),
    inventory_path: `integrity/${currentVersion}.json`,
    inventory_sha256: hash(canonicalJson(inventory)),
    tree_digest: verified.tree_digest,
    file_count: verified.file_count,
    expanded_bytes: verified.expanded_bytes,
    installed_at: '2026-08-12T00:00:00.000Z',
  };
  const receipt = {
    schema_version: 1,
    name: 'triss-coworker',
    managed_by: 'triss-standalone',
    state: 'active',
    root,
    bin_path: join(binDir, 'triss'),
    current_version: currentVersion,
    previous_version: null,
    channel: 'stable',
    installed_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
    versions: { [currentVersion]: entry },
  };
  writeReceiptAtomic(receipt);
  return { base, root, binDir, receipt, env: { HOME: base, TRISS_STANDALONE_HOME: root, TRISS_BIN_DIR: binDir } };
}

function updateManifest(version = '0.32.0', artifact) {
  return {
    version,
    node_compatible: true,
    node: '>=22',
    artifact: {
      size: artifact.length,
      sha256: hash(artifact),
      expanded_size: 0,
      file_count: 2,
    },
  };
}

function versionArtifact(version = '0.32.0') {
  const script = `#!/usr/bin/env node\nconsole.log('${version}');\n`;
  const packageJson = `{"name":"triss-coworker","version":"${version}"}\n`;
  return buildArtifact({ version, records: [
    { type: 'file', path: 'bin/triss.js', mode: 0o755, size: Buffer.byteLength(script), sha256: hash(script), data: Buffer.from(script).toString('base64') },
    { type: 'file', path: 'package.json', mode: 0o644, size: Buffer.byteLength(packageJson), sha256: hash(packageJson), data: Buffer.from(packageJson).toString('base64') },
  ] });
}

test('apply persists PREPARED before publish and activates receipt-anchored target', async () => {
  const fixture = standaloneFixture();
  const artifact = versionArtifact();
  // The test records the durable journal write while keeping the actual
  // transaction intact; the journal must exist before any final version.
  const phases = [];
  try {
    const result = await applyStandaloneUpdate({
      installation: { ...classifyInstallation({ executablePath: join(fixture.binDir, 'triss'), env: fixture.env }), paths: resolveStandalonePaths(fixture.env) },
      manifest: updateManifest('0.32.0', artifact),
      artifactBytes: artifact,
      skipSmoke: true,
      env: fixture.env,
      allowUnclassified: true,
      now: '2026-08-12T00:01:00.000Z',
    });
    phases.push(result.version);
    const receipt = JSON.parse(readFileSync(join(fixture.root, 'install.json'), 'utf8'));
    assert.equal(receipt.current_version, '0.32.0');
    assert.equal(existsSync(join(fixture.root, 'versions', '0.32.0')), true);
    assert.equal(existsSync(join(fixture.root, 'transaction.json')), false);
    assert.deepEqual(phases, ['0.32.0']);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('apply holds one transaction lock across recovery, refresh, and preparation', async () => {
  const fixture = standaloneFixture();
  const operations = [];
  try {
    const state = classifyInstallation({ executablePath: join(fixture.binDir, 'triss'), env: fixture.env });
    const result = await applyStandaloneUpdate({
      installation: { ...state, paths: resolveStandalonePaths(fixture.env) },
      manifest: updateManifest('0.32.0', versionArtifact()),
      artifactBytes: versionArtifact(),
      skipSmoke: true,
      env: fixture.env,
      allowUnclassified: true,
      acquireLock(root, options) {
        operations.push({ root, operation: options.operation });
        return { path: join(root, 'injected.lock'), nonce: 'injected' };
      },
      releaseLock() {},
    });
    assert.equal(result.version, '0.32.0');
    assert.deepEqual(operations.map(({ operation }) => operation), ['apply']);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('apply validates and executes the exact stable launcher with exact version output', async () => {
  const fixture = standaloneFixture();
  const artifact = versionArtifact();
  const originalLauncherLexical = readlinkSync(join(fixture.binDir, 'triss'));
  try {
    const state = classifyInstallation({
      executablePath: join(fixture.binDir, 'triss'), env: fixture.env,
    });
    const result = await applyStandaloneUpdate({
      installation: { ...state, paths: resolveStandalonePaths(fixture.env) },
      manifest: updateManifest('0.32.0', artifact),
      artifactBytes: artifact,
      env: fixture.env,
      allowUnclassified: true,
      smoke(path, _version, label) {
        if (label !== 'candidate') return;
        const journal = JSON.parse(readFileSync(join(fixture.root, 'transaction.json'), 'utf8'));
        assert.equal(journal.old_launcher_lexical, originalLauncherLexical);
      },
    });
    assert.equal(result.version, '0.32.0');
    assert.equal(realpathSync(join(fixture.binDir, 'triss')),
      realpathSync(join(fixture.root, 'versions', '0.32.0', 'bin', 'triss.js')));
    assert.equal(
      resolve(dirname(join(fixture.binDir, 'triss')), readlinkSync(join(fixture.binDir, 'triss'))),
      resolve(fixture.root, 'current', 'bin', 'triss.js'),
    );
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('apply executes the installed public launcher before committing the transaction', async () => {
  const fixture = standaloneFixture();
  const paths = resolveStandalonePaths(fixture.env);
  try {
    const artifact = versionArtifact();
    const result = await applyStandaloneUpdate({
      installation: { ...classifyInstallation({ executablePath: paths.binPath, env: fixture.env }), paths },
      manifest: updateManifest('0.32.0', artifact),
      artifactBytes: artifact,
      env: fixture.env,
      allowUnclassified: true,
    });
    assert.equal(result.version, '0.32.0');
    assert.equal(execFileSync(paths.binPath, ['--version'], { encoding: 'utf8' }).trim(), '0.32.0');
    assert.equal(existsSync(paths.journalPath), false);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('public launcher smoke failure restores the committed receipt and launcher', async () => {
  const fixture = standaloneFixture();
  const paths = resolveStandalonePaths(fixture.env);
  try {
    const artifact = versionArtifact();
    await assert.rejects(() => applyStandaloneUpdate({
      installation: { ...classifyInstallation({ executablePath: paths.binPath, env: fixture.env }), paths },
      manifest: updateManifest('0.32.0', artifact),
      artifactBytes: artifact,
      env: fixture.env,
      allowUnclassified: true,
      smoke(path, _version, label) {
        if (label === 'launcher') throw new Error(`forced ${label} smoke failure`);
      },
    }), /forced launcher smoke failure/);
    assert.equal(JSON.parse(readFileSync(paths.receiptPath, 'utf8')).current_version, '0.31.1');
    assert.equal(readlinkSync(join(fixture.root, 'current')), 'versions/0.31.1');
    assert.equal(execFileSync(paths.binPath, ['--version'], { encoding: 'utf8' }).trim(), '0.31.1');
    assert.equal(existsSync(paths.journalPath), false);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('pending launcher smoke phases are recoverable through the public apply path', async () => {
  for (const phase of ['RECEIPT_COMMITTED', 'LAUNCHER_ACTIVATED']) {
    const fixture = standaloneFixture();
    const paths = resolveStandalonePaths(fixture.env);
    const artifact = versionArtifact();
    try {
      await applyStandaloneUpdate({
        installation: { ...classifyInstallation({ executablePath: paths.binPath, env: fixture.env }), paths },
        manifest: updateManifest('0.32.0', artifact),
        artifactBytes: artifact,
        skipSmoke: true,
        env: fixture.env,
        allowUnclassified: true,
      });
      const newReceipt = JSON.parse(readFileSync(paths.receiptPath, 'utf8'));
      const oldReceipt = fixture.receipt;
      const oldVersionPath = join(fixture.root, 'versions', oldReceipt.current_version);
      const newVersionPath = join(fixture.root, 'versions', newReceipt.current_version);
      writeReceiptAtomic(oldReceipt);
      // Durable pending-smoke state has already activated current and the
      // candidate receipt may or may not have been published. The public
      // launcher is the canonical root/current link in both durable phases.
      unlinkSync(paths.binPath);
      symlinkSync(join(fixture.root, 'current', 'bin', 'triss.js'), paths.binPath);
      const journal = {
        schema_version: 1,
        transaction_id: '12345678-1234-4123-8123-123456789abc',
        operation: 'apply',
        phase,
        root: fixture.root,
        receipt_path: paths.receiptPath,
        staging_path: join(fixture.root, 'staging', '0.32.0-crash'),
        final_path: newVersionPath,
        inventory_path: join(fixture.root, 'integrity', '0.32.0.json'),
        inventory_temp_path: null,
        old_current: oldVersionPath,
        target_current: newVersionPath,
        old_launcher: join(oldVersionPath, 'bin', 'triss.js'),
        old_launcher_target: join(oldVersionPath, 'bin', 'triss.js'),
        old_launcher_lexical: join(fixture.root, 'current', 'bin', 'triss.js'),
        launcher_smoke_pending: true,
        reused_target: false,
        old_receipt_sha256: hash(canonicalJson(oldReceipt)),
        new_receipt_sha256: hash(canonicalJson(newReceipt)),
        old_receipt: canonicalJson(oldReceipt),
        new_receipt: newReceipt,
        created_at: '2026-08-12T00:00:00.000Z',
      };
      writeFileSync(paths.journalPath, JSON.stringify(journal));

      const classified = classifyInstallation({ executablePath: paths.binPath, env: fixture.env });
      assert.equal(classified.recovery_required, true);
      assert.equal(classified.can_recover, true, classified.recovery_error || 'pending recovery unavailable');

      // This is the documented update entrypoint path: recovery runs before
      // preparation. Stop the subsequent download so the test can prove that
      // recovery itself restored the old durable state.
      await assert.rejects(() => applyStandaloneUpdate({
        installation: { ...classified, paths },
        manifest: updateManifest('0.32.0', artifact),
        downloadArtifact: async () => { throw new Error(`stop after ${phase} recovery`); },
        env: fixture.env,
        allowUnclassified: true,
      }), new RegExp(`stop after ${phase} recovery`));
      assert.equal(JSON.parse(readFileSync(paths.receiptPath, 'utf8')).current_version, '0.31.1');
      assert.equal(realpathSync(join(fixture.root, 'current')), realpathSync(oldVersionPath));
      assert.equal(execFileSync(paths.binPath, ['--version'], { encoding: 'utf8' }).trim(), '0.31.1');
      assert.equal(existsSync(paths.journalPath), false);
    } finally {
      rmSync(fixture.base, { recursive: true, force: true });
    }
  }
});

test('apply failure before PREPARED removes staging and integrity metadata', async () => {
  const fixture = standaloneFixture();
  const paths = resolveStandalonePaths(fixture.env);
  const artifact = versionArtifact();
  try {
    await assert.rejects(
      applyStandaloneUpdate({
        installation: {
          ...classifyInstallation({ executablePath: join(fixture.binDir, 'triss'), env: fixture.env }),
          paths,
        },
        manifest: updateManifest('0.32.0', artifact),
        artifactBytes: artifact,
        env: fixture.env,
        allowUnclassified: true,
        smoke() { throw new Error('forced staged smoke failure'); },
      }),
      /forced staged smoke failure/,
    );
    const staging = join(fixture.root, 'staging');
    assert.deepEqual(existsSync(staging) ? readdirSync(staging) : [], []);
    assert.equal(existsSync(join(fixture.root, 'integrity', '0.32.0.json')), false);
    assert.deepEqual(
      readdirSync(join(fixture.root, 'integrity')).filter((name) => name.includes('0.32.0')),
      [],
    );
    assert.equal(existsSync(paths.journalPath), false);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('apply fails closed with a controlled diagnostic when the public launcher is missing', async () => {
  const fixture = standaloneFixture();
  const paths = resolveStandalonePaths(fixture.env);
  const artifact = versionArtifact();
  try {
    unlinkSync(paths.binPath);
    await assert.rejects(
      () => applyStandaloneUpdate({
        installation: {
          ...classifyInstallation({ executablePath: paths.binPath, env: fixture.env }),
          paths,
        },
        manifest: updateManifest('0.32.0', artifact),
        artifactBytes: artifact,
        env: fixture.env,
        allowUnclassified: true,
      }),
      /Previous launcher is missing; refusing to publish an update/,
    );
    assert.equal(existsSync(join(fixture.root, 'versions', '0.32.0')), false);
    assert.equal(existsSync(paths.journalPath), false);
    assert.equal(JSON.parse(readFileSync(paths.receiptPath, 'utf8')).current_version, '0.31.1');
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('payload fsync failure leaves the committed launcher active before publication', async () => {
  const fixture = standaloneFixture();
  const paths = resolveStandalonePaths(fixture.env);
  const artifact = versionArtifact();
  try {
    await assert.rejects(() => applyStandaloneUpdate({
      installation: {
        ...classifyInstallation({ executablePath: join(fixture.binDir, 'triss'), env: fixture.env }),
        paths,
      },
      manifest: updateManifest('0.32.0', artifact),
      artifactBytes: artifact,
      env: fixture.env,
      allowUnclassified: true,
      extractOptions: {
        fsyncFile() { throw new Error('injected payload fsync failure'); },
      },
    }), /injected payload fsync failure/);
    assert.equal(execFileSync(join(fixture.binDir, 'triss'), [], { encoding: 'utf8' }).trim(), '0.31.1');
    assert.equal(existsSync(join(fixture.root, 'versions', '0.32.0')), false);
    assert.equal(existsSync(paths.journalPath), false);
    const active = JSON.parse(readFileSync(paths.receiptPath, 'utf8'));
    assert.equal(active.current_version, '0.31.1');
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('runtime apply rejects symlinked integrity namespace before writing outside root', async () => {
  const fixture = standaloneFixture();
  const paths = resolveStandalonePaths(fixture.env);
  const outside = tempRoot();
  try {
    const outsideIntegrity = join(outside, 'integrity');
    renameSync(join(fixture.root, 'integrity'), outsideIntegrity);
    symlinkSync(outsideIntegrity, join(fixture.root, 'integrity'));
    const artifact = versionArtifact();
    await assert.rejects(
      () => applyStandaloneUpdate({
        installation: {
          ...classifyInstallation({ executablePath: join(fixture.binDir, 'triss'), env: fixture.env }),
          paths,
        },
        manifest: updateManifest('0.32.0', artifact),
        artifactBytes: artifact,
        skipSmoke: true,
        env: fixture.env,
        allowUnclassified: true,
      }),
      /integrity namespace is not a real directory|inventory path escapes standalone root/i,
    );
    assert.deepEqual(readdirSync(outside), ['integrity']);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('rollback validates retained inventory and keeps both version trees', async () => {
  const fixture = standaloneFixture();
  try {
    // Seed a second valid version through apply, then rollback to the receipt's previous.
    const artifact = versionArtifact();
    await applyStandaloneUpdate({ installation: { ...classifyInstallation({ executablePath: join(fixture.binDir, 'triss'), env: fixture.env }), paths: resolveStandalonePaths(fixture.env) }, manifest: updateManifest('0.32.0', artifact), artifactBytes: artifact, skipSmoke: true, env: fixture.env, allowUnclassified: true });
    const result = await rollbackStandaloneUpdate({ installation: { ...classifyInstallation({ executablePath: join(fixture.binDir, 'triss'), env: fixture.env }), paths: resolveStandalonePaths(fixture.env) }, skipSmoke: true, env: fixture.env, allowUnclassified: true });
    assert.equal(result.version, '0.31.1');
    assert.equal(JSON.parse(readFileSync(join(fixture.root, 'install.json'), 'utf8')).current_version, '0.31.1');
    assert.equal(existsSync(join(fixture.root, 'versions', '0.32.0')), true);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('PREPARED reused-target recovery preserves receipt-owned inventory metadata', async () => {
  const fixture = standaloneFixture();
  const paths = resolveStandalonePaths(fixture.env);
  try {
    const artifact = versionArtifact();
    await applyStandaloneUpdate({
      installation: { ...classifyInstallation({ executablePath: paths.binPath, env: fixture.env }), paths },
      manifest: updateManifest('0.32.0', artifact),
      artifactBytes: artifact,
      skipSmoke: true,
      env: fixture.env,
      allowUnclassified: true,
    });
    await rollbackStandaloneUpdate({
      installation: { ...classifyInstallation({ executablePath: paths.binPath, env: fixture.env }), paths },
      skipSmoke: true,
      env: fixture.env,
      allowUnclassified: true,
    });
    const oldReceipt = readReceipt(fixture.root);
    const nextReceipt = {
      ...oldReceipt,
      current_version: '0.32.0',
      previous_version: oldReceipt.current_version,
      updated_at: '2026-08-13T12:00:00.000Z',
    };
    const oldVersion = join(fixture.root, 'versions', oldReceipt.current_version);
    const targetVersion = join(fixture.root, 'versions', '0.32.0');
    const inventoryPath = join(fixture.root, 'integrity', '0.32.0.json');
    writeJournalAtomic(paths.journalPath, {
      schema_version: 1,
      transaction_id: '12345678-1234-4123-8123-123456789abc',
      operation: 'apply',
      phase: 'PREPARED',
      root: fixture.root,
      receipt_path: paths.receiptPath,
      staging_path: null,
      final_path: targetVersion,
      inventory_path: inventoryPath,
      inventory_temp_path: null,
      old_current: oldVersion,
      target_current: targetVersion,
      old_launcher: join(oldVersion, 'bin', 'triss.js'),
      old_launcher_target: join(oldVersion, 'bin', 'triss.js'),
      old_launcher_lexical: join(fixture.root, 'current', 'bin', 'triss.js'),
      reused_target: true,
      old_receipt_sha256: hash(canonicalJson(oldReceipt)),
      new_receipt_sha256: hash(canonicalJson(nextReceipt)),
      old_receipt: canonicalJson(oldReceipt),
      new_receipt: nextReceipt,
      created_at: '2026-08-13T12:00:00.000Z',
    });
    const result = await recoverStandaloneTransaction({ paths });
    assert.equal(result.action, 'rolled_back');
    assert.equal(existsSync(inventoryPath), true);
    assert.equal(readReceipt(fixture.root).current_version, oldReceipt.current_version);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('rollback refuses a damaged active tree before writing a journal or changing launchers', async () => {
  const fixture = standaloneFixture();
  const paths = resolveStandalonePaths(fixture.env);
  try {
    const artifact = versionArtifact();
    await applyStandaloneUpdate({
      installation: { ...classifyInstallation({ executablePath: paths.binPath, env: fixture.env }), paths },
      manifest: updateManifest('0.32.0', artifact),
      artifactBytes: artifact,
      skipSmoke: true,
      env: fixture.env,
      allowUnclassified: true,
    });
    const activeExecutable = join(fixture.root, 'versions', '0.32.0', 'bin', 'triss.js');
    writeFileSync(activeExecutable, `${readFileSync(activeExecutable, 'utf8')}tampered\n`);
    const beforeCurrent = readlinkSync(join(fixture.root, 'current'));
    const beforeLauncher = readlinkSync(paths.binPath);
    await assert.rejects(
      () => rollbackStandaloneUpdate({
        installation: { ...classifyInstallation({ executablePath: paths.binPath, env: fixture.env }), paths },
        skipSmoke: true,
        env: fixture.env,
        allowUnclassified: true,
      }),
      /digest|integrity|tree/i,
    );
    assert.equal(existsSync(paths.journalPath), false);
    assert.equal(readlinkSync(join(fixture.root, 'current')), beforeCurrent);
    assert.equal(readlinkSync(paths.binPath), beforeLauncher);
    assert.equal(JSON.parse(readFileSync(paths.receiptPath, 'utf8')).current_version, '0.32.0');
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('apply reactivates a receipt-anchored retained version after rollback', async () => {
  const fixture = standaloneFixture();
  const artifact = versionArtifact();
  try {
    await applyStandaloneUpdate({
      installation: { ...classifyInstallation({ executablePath: join(fixture.binDir, 'triss'), env: fixture.env }), paths: resolveStandalonePaths(fixture.env) },
      manifest: updateManifest('0.32.0', artifact),
      artifactBytes: artifact,
      skipSmoke: true,
      env: fixture.env,
      allowUnclassified: true,
    });
    await rollbackStandaloneUpdate({
      installation: { ...classifyInstallation({ executablePath: join(fixture.binDir, 'triss'), env: fixture.env }), paths: resolveStandalonePaths(fixture.env) },
      skipSmoke: true,
      env: fixture.env,
      allowUnclassified: true,
    });
    const afterRollback = JSON.parse(readFileSync(join(fixture.root, 'install.json'), 'utf8'));
    const retained = afterRollback.versions['0.32.0'];
    const result = await applyStandaloneUpdate({
      installation: { ...classifyInstallation({ executablePath: join(fixture.binDir, 'triss'), env: fixture.env }), paths: resolveStandalonePaths(fixture.env) },
      manifest: {
        version: '0.32.0',
        node_compatible: true,
        artifact: {
          size: artifact.length,
          sha256: retained.artifact_sha256,
          expanded_size: retained.expanded_bytes,
          file_count: retained.file_count,
        },
      },
      downloadArtifact: async () => { throw new Error('retained target must not be downloaded'); },
      statfs() { throw new Error('retained target must not require disk space'); },
      skipSmoke: true,
      env: fixture.env,
      allowUnclassified: true,
    });
    assert.equal(result.version, '0.32.0');
    assert.equal(JSON.parse(readFileSync(join(fixture.root, 'install.json'))).current_version, '0.32.0');
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('retained target is not counted as a new projected version or payload', () => {
  const data = receipt('/tmp/root', '/tmp/bin/triss');
  const stats = computeRetainedStats(data, {
    sha256: data.versions['0.31.1'].artifact_sha256,
    expanded_size: 9999,
  }, '0.31.1');
  assert.deepEqual(stats, {
    retained_versions: 1,
    retained_payload_bytes: 1234,
    projected_retained_versions: 1,
    projected_retained_payload_bytes: 1234,
  });
});

test('invalid journal is recovery-required and cannot enter normal apply', async () => {
  const fixture = standaloneFixture();
  try {
    writeFileSync(join(fixture.root, 'transaction.json'), JSON.stringify({ schema_version: 1, operation: 'apply', phase: 'PREPARED', root: '/outside' }));
    const state = classifyInstallation({ executablePath: join(fixture.binDir, 'triss'), env: fixture.env });
    assert.equal(state.recovery_required, true);
    assert.equal(state.can_recover, false);
    assert.equal(state.can_apply, false);
    await assert.rejects(() => recoverStandaloneTransaction({ installation: state, paths: resolveStandalonePaths(fixture.env) }), /journal|root|schema/i);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('receipt, journal, and lock JSON are bounded before parsing', () => {
  const receiptFixture = standaloneFixture();
  try {
    writeFileSync(join(receiptFixture.root, 'install.json'), Buffer.alloc(MAX_RECEIPT_BYTES + 1, 0x20));
    const state = classifyInstallation({
      executablePath: join(receiptFixture.binDir, 'triss'),
      env: receiptFixture.env,
    });
    assert.match(state.error, /exceeds/);
  } finally {
    rmSync(receiptFixture.base, { recursive: true, force: true });
  }

  const journalFixture = standaloneFixture();
  try {
    writeFileSync(join(journalFixture.root, 'transaction.json'), Buffer.alloc(MAX_JOURNAL_BYTES + 1, 0x20));
    assert.throws(() => readTransactionJournal(journalFixture.root), /exceeds/);
  } finally {
    rmSync(journalFixture.base, { recursive: true, force: true });
  }

  const lockRoot = tempRoot();
  try {
    writeFileSync(join(lockRoot, 'update.lock'), Buffer.alloc(MAX_LOCK_BYTES + 1, 0x20));
    assert.throws(() => acquireUpdateLock(lockRoot, {
      breakLock: true,
      yes: true,
      probeOwner: () => ({ state: 'absent' }),
    }), /metadata is invalid|exceeds/);
  } finally {
    rmSync(lockRoot, { recursive: true, force: true });
  }
});

test('runtime metadata reads reject pathname-swapped symlinks on the opened fd', () => {
  const receiptFixture = standaloneFixture();
  const outside = join(receiptFixture.base, 'outside.json');
  writeFileSync(outside, '{}\n');
  try {
    unlinkSync(join(receiptFixture.root, 'install.json'));
    symlinkSync(outside, join(receiptFixture.root, 'install.json'));
    const state = classifyInstallation({
      executablePath: join(receiptFixture.binDir, 'triss'),
      env: receiptFixture.env,
    });
    assert.match(state.error, /receipt|read|symbolic|symlink|levels/i);
  } finally {
    rmSync(receiptFixture.base, { recursive: true, force: true });
  }

  const journalFixture = standaloneFixture();
  try {
    const journal = join(journalFixture.root, 'transaction.json');
    const journalOutside = join(journalFixture.base, 'journal-outside.json');
    writeFileSync(journalOutside, '{}\n');
    symlinkSync(journalOutside, journal);
    assert.throws(() => readTransactionJournal(journalFixture.root), /journal|read|symbolic|symlink|levels/i);
  } finally {
    rmSync(journalFixture.base, { recursive: true, force: true });
  }
});

test('runtime receipt and journal writers stay below their reader caps', () => {
  const fixture = standaloneFixture();
  try {
    const nearBoundary = {
      ...fixture.receipt,
      padding: 'x'.repeat(MAX_RECEIPT_BYTES - 4096),
    };
    writeReceiptAtomic(nearBoundary);
    assert.equal(readReceipt(fixture.root).padding.length, nearBoundary.padding.length);

    unlinkSync(join(fixture.root, 'install.json'));
    assert.throws(() => writeReceiptAtomic({
      ...nearBoundary,
      padding: 'x'.repeat(MAX_RECEIPT_BYTES),
    }), /exceeds/);
    assert.equal(existsSync(join(fixture.root, 'install.json')), false);

    const journalPath = join(fixture.root, 'transaction.json');
    assert.throws(() => writeJournalAtomic(journalPath, {
      phase: 'PREPARED',
      padding: 'x'.repeat(MAX_JOURNAL_BYTES),
    }), /exceeds/);
    assert.equal(existsSync(journalPath), false);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('readTransactionJournal accepts a custom standalone root string', () => {
  const fixture = standaloneFixture();
  try {
    const targetVersion = '0.32.0';
    const targetEntry = {
      ...fixture.receipt.versions[fixture.receipt.current_version],
      inventory_path: `integrity/${targetVersion}.json`,
    };
    const targetReceipt = {
      ...fixture.receipt,
      current_version: targetVersion,
      previous_version: fixture.receipt.current_version,
      versions: { ...fixture.receipt.versions, [targetVersion]: targetEntry },
    };
    const journal = {
      schema_version: 1,
      transaction_id: '12345678-1234-4123-8123-123456789abc',
      operation: 'rollback',
      phase: 'PREPARED',
      root: fixture.root,
      receipt_path: join(fixture.root, 'install.json'),
      staging_path: null,
      final_path: join(fixture.root, 'versions', targetVersion),
      inventory_path: join(fixture.root, 'integrity', `${targetVersion}.json`),
      old_current: join(fixture.root, 'versions', '0.31.1'),
      target_current: join(fixture.root, 'versions', targetVersion),
      old_launcher: join(fixture.root, 'current', 'bin', 'triss.js'),
      old_receipt_sha256: hash(canonicalJson(fixture.receipt)),
      new_receipt_sha256: hash(canonicalJson(targetReceipt)),
      old_receipt: canonicalJson(fixture.receipt),
      new_receipt: targetReceipt,
      inventory_temp_path: null,
      created_at: '2026-08-12T00:00:00.000Z',
    };
    writeFileSync(join(fixture.root, 'transaction.json'), JSON.stringify(journal));
    assert.equal(readTransactionJournal(fixture.root).transaction_id, journal.transaction_id);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('recovery rolls back to the verified old state when a published apply tree is missing', async () => {
  const fixture = standaloneFixture();
  const paths = resolveStandalonePaths(fixture.env);
  const targetVersion = '0.32.0';
  const targetPath = join(fixture.root, 'versions', targetVersion);
  const targetEntry = {
    ...fixture.receipt.versions[fixture.receipt.current_version],
    inventory_path: `integrity/${targetVersion}.json`,
  };
  const targetReceipt = {
    ...fixture.receipt,
    current_version: targetVersion,
    previous_version: fixture.receipt.current_version,
    versions: { ...fixture.receipt.versions, [targetVersion]: targetEntry },
  };
  const journal = {
    schema_version: 1,
    transaction_id: '12345678-1234-4123-8123-123456789abc',
    operation: 'apply',
    phase: 'CURRENT_ACTIVATED',
    root: fixture.root,
    receipt_path: paths.receiptPath,
    staging_path: join(fixture.root, 'staging', `${targetVersion}-test`),
    final_path: targetPath,
    inventory_path: join(fixture.root, 'integrity', `${targetVersion}.json`),
    inventory_temp_path: null,
    old_current: join(fixture.root, 'versions', fixture.receipt.current_version),
    target_current: targetPath,
    old_launcher: join(fixture.root, 'versions', fixture.receipt.current_version, 'bin', 'triss.js'),
    old_receipt_sha256: hash(canonicalJson(fixture.receipt)),
    new_receipt_sha256: hash(canonicalJson(targetReceipt)),
    old_receipt: canonicalJson(fixture.receipt),
    new_receipt: targetReceipt,
    created_at: '2026-08-12T00:00:00.000Z',
  };
  try {
    // Simulate CURRENT_ACTIVATED: `current` points at the new, now-missing
    // tree, while the public launcher remains anchored to the old committed
    // entrypoint and can therefore start recovery.
    unlinkSync(join(fixture.root, 'current'));
    symlinkSync(targetPath, join(fixture.root, 'current'));
    unlinkSync(paths.binPath);
    symlinkSync(journal.old_current + '/bin/triss.js', paths.binPath);
    writeFileSync(paths.journalPath, JSON.stringify(journal));
    assert.equal(
      execFileSync(process.execPath, [paths.binPath, '--version'], { encoding: 'utf8' }).trim(),
      '0.31.1',
    );
    const state = classifyInstallation({ executablePath: join(fixture.binDir, 'triss'), env: fixture.env });
    assert.equal(state.recovery_required, true);
    assert.equal(state.can_recover, true, state.recovery_error || 'recovery unavailable');
    const result = await recoverStandaloneTransaction({ paths });
    assert.equal(result.action, 'rolled_back');
    assert.equal(JSON.parse(readFileSync(paths.receiptPath)).current_version, fixture.receipt.current_version);
    assert.equal(realpathSync(join(fixture.root, 'current')), realpathSync(journal.old_current));
    assert.equal(
      resolve(dirname(paths.binPath), readlinkSync(paths.binPath)),
      resolve(fixture.root, 'current', 'bin', 'triss.js'),
    );
    assert.equal(existsSync(paths.journalPath), false);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('runtime recovery restores old state and retains a corrupted new tree', async () => {
  const fixture = standaloneFixture();
  const artifact = versionArtifact();
  const paths = resolveStandalonePaths(fixture.env);
  try {
    await assert.rejects(
      applyStandaloneUpdate({
        installation: {
          ...classifyInstallation({ executablePath: join(fixture.binDir, 'triss'), env: fixture.env }),
          paths,
        },
        manifest: updateManifest('0.32.0', artifact),
        artifactBytes: artifact,
        env: fixture.env,
        allowUnclassified: true,
        smoke(path, _version, label) {
          if (label === 'candidate') {
            writeFileSync(join(fixture.root, 'versions', '0.32.0', 'bin', 'triss.js'), 'corrupt');
            assert.equal(
              execFileSync(process.execPath, [paths.binPath, '--version'], { encoding: 'utf8' }).trim(),
              '0.31.1',
              'the real installed launcher must remain runnable while the candidate is damaged',
            );
            throw new Error('forced launcher failure');
          }
        },
      }),
      /retained untrusted version for inspection/,
    );
    assert.equal(
      realpathSync(join(fixture.root, 'current')),
      realpathSync(join(fixture.root, 'versions', '0.31.1')),
    );
    assert.equal(
      realpathSync(join(fixture.binDir, 'triss')),
      realpathSync(join(fixture.root, 'versions', '0.31.1', 'bin', 'triss.js')),
    );
    assert.equal(JSON.parse(readFileSync(paths.receiptPath)).current_version, '0.31.1');
    assert.equal(existsSync(paths.journalPath), false);
    assert.equal(existsSync(join(fixture.root, 'versions', '0.32.0')), true);
    assert.equal(existsSync(join(fixture.root, 'integrity', '0.32.0.json')), true);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('recovery completes a committed receipt without requiring the old tree', async () => {
  const fixture = standaloneFixture();
  const artifact = versionArtifact();
  const paths = resolveStandalonePaths(fixture.env);
  try {
    await applyStandaloneUpdate({
      installation: {
        ...classifyInstallation({ executablePath: join(fixture.binDir, 'triss'), env: fixture.env }),
        paths,
      },
      manifest: updateManifest('0.32.0', artifact),
      artifactBytes: artifact,
      skipSmoke: true,
      env: fixture.env,
      allowUnclassified: true,
    });
    const nextReceipt = JSON.parse(readFileSync(paths.receiptPath, 'utf8'));
    const oldReceipt = {
      ...nextReceipt,
      current_version: '0.31.1',
      previous_version: null,
      versions: { '0.31.1': nextReceipt.versions['0.31.1'] },
    };
    rmSync(join(fixture.root, 'versions', '0.31.1'), { recursive: true, force: true });
    writeFileSync(paths.journalPath, JSON.stringify({
      schema_version: 1,
      transaction_id: '12345678-1234-4123-8123-123456789abc',
      operation: 'apply',
      phase: 'LAUNCHER_ACTIVATED',
      root: fixture.root,
      receipt_path: paths.receiptPath,
      staging_path: join(fixture.root, 'staging', '0.32.0-test'),
      final_path: join(fixture.root, 'versions', '0.32.0'),
      inventory_path: join(fixture.root, 'integrity', '0.32.0.json'),
      inventory_temp_path: null,
      old_current: join(fixture.root, 'versions', '0.31.1'),
      target_current: join(fixture.root, 'versions', '0.32.0'),
      old_launcher: join(fixture.root, 'versions', '0.31.1', 'bin', 'triss.js'),
      old_receipt_sha256: hash(canonicalJson(oldReceipt)),
      new_receipt_sha256: hash(canonicalJson(nextReceipt)),
      old_receipt: canonicalJson(oldReceipt),
      new_receipt: nextReceipt,
      created_at: '2026-08-12T00:00:00.000Z',
    }));
    const result = await recoverStandaloneTransaction({ paths });
    assert.equal(result.action, 'completed');
    assert.equal(existsSync(paths.journalPath), false);
    assert.equal(JSON.parse(readFileSync(paths.receiptPath, 'utf8')).current_version, '0.32.0');
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('recovery refuses to overwrite an unrelated launcher symlink', async () => {
  const fixture = standaloneFixture();
  const artifact = versionArtifact();
  const paths = resolveStandalonePaths(fixture.env);
  try {
    await applyStandaloneUpdate({
      installation: {
        ...classifyInstallation({ executablePath: join(fixture.binDir, 'triss'), env: fixture.env }),
        paths,
      },
      manifest: updateManifest('0.32.0', artifact),
      artifactBytes: artifact,
      skipSmoke: true,
      env: fixture.env,
      allowUnclassified: true,
    });
    const nextReceipt = JSON.parse(readFileSync(paths.receiptPath, 'utf8'));
    const oldReceipt = fixture.receipt;
    const unrelated = join(fixture.base, 'unrelated.js');
    writeFileSync(unrelated, '#!/usr/bin/env node\n');
    rmSync(paths.binPath);
    symlinkSync(unrelated, paths.binPath);
    writeFileSync(paths.journalPath, JSON.stringify({
      schema_version: 1,
      transaction_id: '12345678-1234-4123-8123-123456789abc',
      operation: 'apply',
      phase: 'LAUNCHER_ACTIVATED',
      root: fixture.root,
      receipt_path: paths.receiptPath,
      staging_path: join(fixture.root, 'staging', '0.32.0-test'),
      final_path: join(fixture.root, 'versions', '0.32.0'),
      inventory_path: join(fixture.root, 'integrity', '0.32.0.json'),
      inventory_temp_path: null,
      old_current: join(fixture.root, 'versions', '0.31.1'),
      target_current: join(fixture.root, 'versions', '0.32.0'),
      old_launcher: join(fixture.root, 'versions', '0.31.1', 'bin', 'triss.js'),
      old_receipt_sha256: hash(canonicalJson(oldReceipt)),
      new_receipt_sha256: hash(canonicalJson(nextReceipt)),
      old_receipt: canonicalJson(oldReceipt),
      new_receipt: nextReceipt,
      created_at: '2026-08-12T00:00:00.000Z',
    }));
    await assert.rejects(
      () => recoverStandaloneTransaction({ paths }),
      /launcher target does not match.*refusing to overwrite/i,
    );
    assert.equal(realpathSync(paths.binPath), realpathSync(unrelated));
    assert.equal(existsSync(paths.journalPath), true);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('runtime recovery accepts the exact configured legacy launcher target', async () => {
  const fixture = standaloneFixture();
  const oldReceipt = fixture.receipt;
  const artifact = versionArtifact();
  const legacyRoot = join(fixture.base, 'legacy');
  fixture.env.TRISS_HOME = legacyRoot;
  const paths = resolveStandalonePaths(fixture.env);
  try {
    await applyStandaloneUpdate({
      installation: {
        ...classifyInstallation({ executablePath: join(fixture.binDir, 'triss'), env: fixture.env }),
        paths,
      },
      manifest: updateManifest('0.32.0', artifact),
      artifactBytes: artifact,
      skipSmoke: true,
      env: fixture.env,
      allowUnclassified: true,
    });
    const nextReceipt = JSON.parse(readFileSync(paths.receiptPath));
    const legacyLauncher = join(legacyRoot, 'bin', 'triss.js');
    mkdirSync(join(legacyRoot, 'bin'), { recursive: true });
    writeFileSync(legacyLauncher, '#!/usr/bin/env node\n');
    writeReceiptAtomic(oldReceipt);
    writeFileSync(paths.journalPath, JSON.stringify({
      schema_version: 1,
      transaction_id: '12345678-1234-4123-8123-123456789abc',
      operation: 'apply',
      phase: 'CURRENT_ACTIVATED',
      root: fixture.root,
      receipt_path: paths.receiptPath,
      staging_path: join(fixture.root, 'staging', '0.32.0-test'),
      final_path: join(fixture.root, 'versions', '0.32.0'),
      inventory_path: join(fixture.root, 'integrity', '0.32.0.json'),
      old_current: join(fixture.root, 'versions', '0.31.1'),
      target_current: join(fixture.root, 'versions', '0.32.0'),
      old_launcher: legacyLauncher,
      old_receipt_sha256: hash(canonicalJson(oldReceipt)),
      new_receipt_sha256: hash(canonicalJson(nextReceipt)),
      old_receipt: canonicalJson(oldReceipt),
      new_receipt: nextReceipt,
      created_at: '2026-08-12T00:00:00.000Z',
    }));
    const result = await recoverStandaloneTransaction({ paths });
    assert.equal(result.action, 'rolled_back');
    assert.equal(realpathSync(paths.binPath), realpathSync(legacyLauncher));
    assert.equal(realpathSync(join(fixture.root, 'current')),
      realpathSync(join(fixture.root, 'versions', '0.31.1')));
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('runtime recovery removes pointers created by an interrupted initial install', async () => {
  const fixture = standaloneFixture();
  const paths = resolveStandalonePaths(fixture.env);
  const nextReceipt = fixture.receipt;
  const initializing = {
    ...nextReceipt,
    state: 'initializing',
    current_version: null,
    previous_version: null,
    versions: {},
  };
  try {
    writeReceiptAtomic(initializing);
    writeFileSync(paths.journalPath, JSON.stringify({
      schema_version: 1,
      transaction_id: '12345678-1234-4123-8123-123456789abc',
      operation: 'install',
      phase: 'CURRENT_ACTIVATED',
      root: fixture.root,
      receipt_path: paths.receiptPath,
      staging_path: join(fixture.root, 'staging', '0.31.1-test'),
      final_path: join(fixture.root, 'versions', '0.31.1'),
      inventory_path: join(fixture.root, 'integrity', '0.31.1.json'),
      inventory_temp_path: null,
      old_current: null,
      target_current: join(fixture.root, 'versions', '0.31.1'),
      old_launcher: null,
      old_receipt_sha256: null,
      new_receipt_sha256: hash(canonicalJson(nextReceipt)),
      old_receipt: null,
      new_receipt: nextReceipt,
      launcher_smoke_pending: true,
      created_at: '2026-08-12T00:00:00.000Z',
    }));
    const classified = classifyInstallation({ executablePath: paths.binPath, env: fixture.env });
    assert.equal(classified.recovery_required, true);
    assert.equal(classified.can_recover, true, classified.recovery_error || 'initial-install recovery unavailable');
    const result = await recoverStandaloneTransaction({ paths });
    assert.equal(result.action, 'rolled_back');
    assert.equal(existsSync(join(fixture.root, 'current')), false);
    assert.equal(existsSync(paths.binPath), false);
    assert.equal(existsSync(paths.journalPath), false);
  } finally {
    rmSync(fixture.base, { recursive: true, force: true });
  }
});

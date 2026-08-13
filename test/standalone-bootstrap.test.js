import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync,
  readlinkSync, realpathSync, readdirSync, rmSync, symlinkSync, truncateSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  atomicJson,
  paths, validateManifest, assertRootSafe, installManifest, pinnedLookup,
  privateV6, processIdentity, recoverJournal, safeRecordPath, ensureDiskSpace,
  legacyFallback,
  extractArtifact, hashesEqual, request, validateTree,
  readBoundedJson,
  MAX_RECEIPT_BYTES, MAX_JOURNAL_BYTES, MAX_LOCK_BYTES,
  MAX_STAGING_MARKER_BYTES, MAX_LEGACY_MARKER_BYTES,
} from '../scripts/standalone-bootstrap.js';
import { stageStandalone } from '../scripts/build-standalone.js';
import { updateProcessIdentity } from '../src/update/install.js';

const manifest = {
  schema_version: 1,
  name: 'triss-coworker',
  version: '0.32.0',
  channel: 'stable',
  published_at: '2026-08-12T12:00:00.000Z',
  release_url: 'https://github.com/ayleen/triss-coworker/releases/tag/v0.32.0',
  node: '>=22',
  artifact: {
    url: 'https://github.com/ayleen/triss-coworker/releases/download/v0.32.0/triss.gz',
    sha256: 'a'.repeat(64),
    size: 10,
    expanded_size: 100,
    file_count: 2,
    format: 'triss-ndjson-gzip-v1',
    platform: 'node-posix',
  },
};

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function bootstrapPublicationTemp(lock, metadata) {
  const tuple = [1, metadata.nonce, metadata.pid, metadata.start_identity, metadata.acquired_at];
  return `${lock}.${Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url')}.tmp`;
}

function bootstrapPublicationMarker(temporary) {
  const marker = `${temporary}.owner`;
  mkdirSync(marker);
  return marker;
}

function fixture(version = '0.32.0', launcherSource = null) {
  const home = mkdtempSync(join(tmpdir(), 'triss-bootstrap-home-'));
  const p = paths({
    HOME: home,
    TRISS_HOME: join(home, 'legacy'),
    TRISS_STANDALONE_HOME: join(home, 'standalone'),
    TRISS_BIN_DIR: join(home, 'bin'),
  });
  const finalPath = join(p.root, 'versions', version);
  const entryPath = join(finalPath, 'bin', 'triss.js');
  mkdirSync(join(finalPath, 'bin'), { recursive: true });
  const source = launcherSource || `#!/usr/bin/env node\nconsole.log('${version}');\n`;
  writeFileSync(entryPath, source, { mode: 0o755 });
  chmodSync(entryPath, 0o755);
  const file = {
    path: 'bin/triss.js', mode: 0o755, size: Buffer.byteLength(source),
    sha256: hash(Buffer.from(source)),
  };
  const inventory = { schema_version: 1, files: [file] };
  const digest = hash(Buffer.from(canonicalJson(inventory)));
  mkdirSync(join(p.root, 'integrity'), { recursive: true });
  writeFileSync(join(p.root, 'integrity', `${version}.json`), `${canonicalJson(inventory)}\n`);
  const receipt = {
    schema_version: 1, name: 'triss-coworker', managed_by: 'triss-standalone',
    state: 'active', root: p.root, bin_path: p.binPath, current_version: version,
    previous_version: null, channel: 'stable', installed_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
    versions: {
      [version]: {
        artifact_sha256: 'a'.repeat(64), inventory_path: `integrity/${version}.json`,
        inventory_sha256: digest, tree_digest: digest, file_count: 1,
        expanded_bytes: file.size, installed_at: '2026-08-12T00:00:00.000Z',
      },
    },
  };
  writeFileSync(p.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  return { p, receipt, finalPath };
}

function activateFixture({ p, finalPath }) {
  mkdirSync(p.binDir, { recursive: true });
  symlinkSync(`versions/${finalPath.split('/versions/')[1]}`, join(p.root, 'current'));
  symlinkSync(join(p.root, 'current', 'bin', 'triss.js'), p.binPath);
}

function recoveryFixture() {
  const { p, receipt: oldReceipt, finalPath: oldFinal } = fixture('0.31.0');
  const version = '0.32.0';
  const finalPath = join(p.root, 'versions', version);
  const source = Buffer.from(`#!/usr/bin/env node\nconsole.log('${version}');\n`);
  mkdirSync(join(finalPath, 'bin'), { recursive: true });
  writeFileSync(join(finalPath, 'bin', 'triss.js'), source, { mode: 0o755 });
  chmodSync(join(finalPath, 'bin', 'triss.js'), 0o755);
  const inventory = { schema_version: 1, files: [{
    path: 'bin/triss.js', mode: 0o755, size: source.length, sha256: hash(source),
  }] };
  const digest = hash(Buffer.from(canonicalJson(inventory)));
  writeFileSync(join(p.root, 'integrity', `${version}.json`), `${canonicalJson(inventory)}\n`);
  const nextReceipt = {
    ...oldReceipt, current_version: version, previous_version: '0.31.0',
    versions: { ...oldReceipt.versions, [version]: {
      artifact_sha256: 'b'.repeat(64), inventory_path: `integrity/${version}.json`,
      inventory_sha256: digest, tree_digest: digest, file_count: 1,
      expanded_bytes: source.length, installed_at: '2026-08-12T01:00:00.000Z',
    } },
  };
  const oldReceiptText = canonicalJson(oldReceipt);
  writeFileSync(p.journal, JSON.stringify({
    schema_version: 1, transaction_id: 'test', operation: 'install', phase: 'CURRENT_ACTIVATED',
    root: p.root, receipt_path: p.receipt, staging_path: join(p.root, 'staging', `${version}-test`),
    final_path: finalPath, inventory_path: join(p.root, 'integrity', `${version}.json`),
    inventory_temp_path: null, old_current: oldFinal, target_current: finalPath,
    old_launcher: join(oldFinal, 'bin', 'triss.js'),
    old_launcher_lexical: join(p.root, 'current', 'bin', 'triss.js'),
    old_receipt_sha256: hash(Buffer.from(oldReceiptText)),
    new_receipt_sha256: hash(Buffer.from(canonicalJson(nextReceipt))),
    old_receipt: oldReceiptText, new_receipt: nextReceipt,
    created_at: '2026-08-12T01:00:00.000Z',
  }));
  return { p, oldFinal, finalPath, nextReceipt };
}

test('embedded bootstrap is byte-identical to canonical source', () => {
  const install = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
  const start = 'exec node --input-type=module - "$@" <<\'TRISS_STANDALONE_BOOTSTRAP\'\n';
  const begin = install.indexOf(start);
  assert.notEqual(begin, -1);
  const bodyStart = begin + start.length;
  const endMarker = '\nTRISS_STANDALONE_BOOTSTRAP\n';
  const end = install.indexOf(endMarker, bodyStart);
  assert.notEqual(end, -1);
  const embedded = `${install.slice(bodyStart, end)}\n`;
  const canonical = readFileSync(new URL('../scripts/standalone-bootstrap.js', import.meta.url), 'utf8');
  assert.equal(embedded, canonical);
});

test('standalone root uses TRISS_STANDALONE_HOME and leaves TRISS_HOME as legacy input', () => {
  const result = paths({
    HOME: '/tmp/triss-home',
    TRISS_HOME: '/tmp/legacy-checkout',
    TRISS_STANDALONE_HOME: '/tmp/standalone-root',
    TRISS_BIN_DIR: '/tmp/triss-bin',
  });
  assert.equal(result.root, '/tmp/standalone-root');
  assert.equal(result.legacy, '/tmp/legacy-checkout');
  assert.equal(result.binPath, '/tmp/triss-bin/triss');
});

test('standalone and legacy roots must not contain each other', () => {
  const home = '/tmp/triss-overlap-home';
  assert.throws(() => paths({
    HOME: home,
    TRISS_HOME: join(home, 'legacy'),
    TRISS_STANDALONE_HOME: join(home, 'legacy', 'standalone'),
  }), /overlaps/);
  assert.throws(() => paths({
    HOME: home,
    TRISS_HOME: join(home, 'legacy', 'checkout'),
    TRISS_STANDALONE_HOME: join(home, 'legacy'),
  }), /overlaps/);
});

test('symlinked standalone root into legacy checkout is rejected by realpath containment', () => {
  const home = mkdtempSync(join(tmpdir(), 'triss-symlink-root-'));
  const legacy = join(home, 'legacy');
  const target = join(legacy, 'nested-standalone');
  mkdirSync(legacy, { recursive: true });
  symlinkSync(target, join(home, 'standalone'));
  assert.throws(() => paths({
    HOME: home, TRISS_HOME: legacy, TRISS_STANDALONE_HOME: join(home, 'standalone'),
  }), /overlaps/);
});

test('standalone root rejects an arbitrary symlinked ancestor', () => {
  const home = mkdtempSync(join(tmpdir(), 'triss-symlink-ancestor-'));
  const realParent = join(home, 'real-parent');
  const aliasParent = join(home, 'alias-parent');
  mkdirSync(realParent, { recursive: true });
  symlinkSync(realParent, aliasParent);
  assert.throws(() => paths({
    HOME: home,
    TRISS_HOME: join(home, 'legacy'),
    TRISS_STANDALONE_HOME: join(aliasParent, 'standalone'),
  }), /crosses symlink ancestor/);
});

test('standalone launcher directory cannot overlap managed or legacy roots', () => {
  const home = mkdtempSync(join(tmpdir(), 'triss-bin-overlap-'));
  assert.throws(() => paths({
    HOME: home,
    TRISS_HOME: join(home, 'legacy'),
    TRISS_STANDALONE_HOME: join(home, 'standalone'),
    TRISS_BIN_DIR: join(home, 'standalone', 'current', 'bin'),
  }), /overlaps/);
  assert.throws(() => paths({
    HOME: home,
    TRISS_HOME: join(home, 'legacy'),
    TRISS_STANDALONE_HOME: join(home, 'standalone'),
    TRISS_BIN_DIR: home,
  }), /overlaps/);
  assert.throws(() => paths({
    HOME: home,
    TRISS_HOME: join(home, 'legacy'),
    TRISS_STANDALONE_HOME: join(home, 'standalone'),
    TRISS_BIN_DIR: join(home, 'legacy', 'bin'),
  }), /overlaps/);
});

test('DNS pinning rejects private IPv4 embedded in supported IPv6 transition forms', () => {
  for (const address of [
    '::ffff:c0a8:101', '::c0a8:101', '::ffff:192.168.1.1',
    '2002:c0a8:0101::', '64:ff9b::c0a8:101',
    '64:ff9b:0:0:0:0:c0a8:101', '64:ff9b:1::c0a8:101',
  ]) assert.equal(privateV6(address), true, address);
  assert.equal(privateV6('2606:4700:4700::1111'), false);
  const resolver = pinnedLookup([{ address: '8.8.8.8', family: 4 }]);
  resolver('github.com', { family: 4 }, (error, address, family) => {
    assert.ifError(error);
    assert.equal(address, '8.8.8.8');
    assert.equal(family, 4);
  });
  resolver('github.com', { family: 6 }, (error) => assert.equal(error.code, 'ENOTFOUND'));
});

test('bootstrap lock identity is available for the running process', () => {
  const identity = processIdentity(process.pid);
  if (identity !== null) assert.match(identity, /^(?:proc|ps):/);
  assert.equal(updateProcessIdentity(process.pid), identity);
  const source = readFileSync(new URL('../scripts/standalone-bootstrap.js', import.meta.url), 'utf8');
  assert.match(source, /'ps', \['-o', 'lstart=', '-p', String\(pid\)\]/);
});

test('bootstrap lock claims an exclusive hard link only after durable marker payload metadata', () => {
  const source = readFileSync(new URL('../scripts/standalone-bootstrap.js', import.meta.url), 'utf8');
  assert.match(source, /const temp = `update\.lock\.\$\{encodeLockMetadata\(metadata\)\}\.tmp`;/);
  assert.match(source, /writeLockOwnerMarker\(markerPath\)/);
  assert.match(source, /mkdirSync\(path, \{ mode: 0o700 \}\)/);
  assert.match(source, /const payloadPath = join\(markerPath, 'payload'\)/);
  assert.match(source, /linkSync\(payloadPath, p\.lock\)/);
  assert.doesNotMatch(source, /openSync\(p\.lock, 'wx'/);
});

test('bootstrap disk-space gate includes compressed, expanded, and safety bytes', () => {
  const p = { root: '/tmp/triss-disk-check' };
  const artifact = { size: 10, expanded_size: 100 };
  const enough = ensureDiskSpace(p, artifact, () => ({ bavail: 70 * 1024, bsize: 1024 }));
  assert.equal(enough.required, 10 + 100 + 64 * 1024 * 1024);
  assert.throws(
    () => ensureDiskSpace(p, artifact, () => ({ bavail: 1, bsize: 1 })),
    /insufficient disk space/,
  );
});

test('bootstrap digest comparison requires strict decoded SHA-256 values', () => {
  assert.equal(hashesEqual('a'.repeat(64), 'a'.repeat(64)), true);
  assert.equal(hashesEqual('a'.repeat(64), 'b'.repeat(64)), false);
  assert.equal(hashesEqual('A'.repeat(64), 'A'.repeat(64)), false);
});

test('manifest compatibility is distinct from malformed manifest', () => {
  assert.equal(validateManifest(manifest, 22).node_compatible, true);
  assert.equal(validateManifest({ ...manifest, node: '>=24' }, 22).node_compatible, false);
  assert.throws(() => validateManifest({ ...manifest, version: 'v0.32.0' }, 22), /invalid release manifest/);
  assert.throws(() => validateManifest({
    ...manifest,
    artifact: { ...manifest.artifact, size: 32 * 1024 * 1024 + 1 },
  }, 22), /invalid artifact manifest/);
});

test('root and artifact path checks fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'triss-bootstrap-'));
  assert.throws(() => safeRecordPath(root, '../escape'), /invalid artifact path|escapes staging/);
  assert.throws(() => safeRecordPath(root, 'bin\\triss.js'), /invalid artifact path/);
  const nonEmpty = join(root, 'non-empty');
  mkdirSync(nonEmpty);
  writeFileSync(join(nonEmpty, 'user-file'), 'owned by user');
  assert.throws(() => assertRootSafe(nonEmpty), /not owned by Triss/);
});

test('bootstrap metadata readers enforce per-record caps and reject symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'triss-bootstrap-metadata-'));
  const cases = [
    ['receipt', MAX_RECEIPT_BYTES],
    ['journal', MAX_JOURNAL_BYTES],
    ['lock', MAX_LOCK_BYTES],
    ['staging marker', MAX_STAGING_MARKER_BYTES],
    ['legacy marker', MAX_LEGACY_MARKER_BYTES],
  ];
  for (const [label, limit] of cases) {
    const path = join(root, `${label.replaceAll(' ', '-')}.json`);
    writeFileSync(path, Buffer.alloc(limit + 1, 0x20));
    assert.throws(() => readBoundedJson(path, label, limit), /exceeds/);
    unlinkSync(path);
    const outside = join(root, `${label.replaceAll(' ', '-')}-outside.json`);
    writeFileSync(outside, '{}\n');
    symlinkSync(outside, path);
    assert.throws(() => readBoundedJson(path, label, limit), /read|symbolic|symlink|levels/i);
    unlinkSync(path);
  }
});

test('bootstrap durable metadata writers preflight receipt and journal caps', () => {
  const root = mkdtempSync(join(tmpdir(), 'triss-bootstrap-writer-'));
  try {
    const receiptPath = join(root, 'install.json');
    atomicJson(receiptPath, { state: 'initializing', padding: 'x'.repeat(MAX_RECEIPT_BYTES - 4096) }, MAX_RECEIPT_BYTES);
    assert.equal(existsSync(receiptPath), true);
    assert.throws(() => atomicJson(join(root, 'too-large-receipt.json'), {
      state: 'initializing', padding: 'x'.repeat(MAX_RECEIPT_BYTES + 1),
    }, MAX_RECEIPT_BYTES), /exceeds/);
    assert.equal(existsSync(join(root, 'too-large-receipt.json')), false);

    const journalPath = join(root, 'transaction.json');
    assert.throws(() => atomicJson(journalPath, {
      phase: 'PREPARED', padding: 'x'.repeat(MAX_JOURNAL_BYTES),
    }, MAX_JOURNAL_BYTES), /exceeds/);
    assert.equal(existsSync(journalPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bootstrap can resume a crash-era root containing only its durable lock', () => {
  const home = mkdtempSync(join(tmpdir(), 'triss-lock-only-'));
  const p = paths({
    HOME: home,
    TRISS_HOME: join(home, 'legacy'),
    TRISS_STANDALONE_HOME: join(home, 'standalone'),
    TRISS_BIN_DIR: join(home, 'bin'),
  });
  mkdirSync(p.root, { recursive: true });
  writeFileSync(p.lock, `${JSON.stringify({
    schema_version: 1, nonce: 'a'.repeat(32), pid: process.pid,
    start_identity: processIdentity(process.pid), acquired_at: '2026-08-12T01:00:00.000Z',
  })}\n`);
  assert.doesNotThrow(() => assertRootSafe(p.root, p));
});

test('bootstrap removes one bounded stale pre-publication lock temp from an unreceipted root', () => {
  const home = mkdtempSync(join(tmpdir(), 'triss-lock-temp-'));
  const p = paths({
    HOME: home,
    TRISS_HOME: join(home, 'legacy'),
    TRISS_STANDALONE_HOME: join(home, 'standalone'),
    TRISS_BIN_DIR: join(home, 'bin'),
  });
  mkdirSync(p.root, { recursive: true });
  const metadata = {
    schema_version: 1, nonce: 'a'.repeat(32), pid: 2_147_483_647,
    start_identity: 'proc:stale', acquired_at: '2026-08-12T01:00:00.000Z',
  };
  const temporary = bootstrapPublicationTemp(p.lock, metadata);
  bootstrapPublicationMarker(temporary);
  writeFileSync(join(`${temporary}.owner`, 'payload'), `${JSON.stringify({
    schema_version: 1, kind: 'standalone-lock-publication', root: p.root,
    temporary: temporary.split('/').at(-1), ...metadata,
  })}\n`);

  assert.doesNotThrow(() => assertRootSafe(p.root, p));
  assert.equal(existsSync(temporary), false);
  assert.equal(existsSync(`${temporary}.owner`), false);
});

test('bootstrap fails closed for a live, foreign, malformed, or ambiguous lock temp', () => {
  const home = mkdtempSync(join(tmpdir(), 'triss-lock-temp-invalid-'));
  const p = paths({
    HOME: home,
    TRISS_HOME: join(home, 'legacy'),
    TRISS_STANDALONE_HOME: join(home, 'standalone'),
    TRISS_BIN_DIR: join(home, 'bin'),
  });
  mkdirSync(p.root, { recursive: true });
  const metadata = {
    schema_version: 1, nonce: 'a'.repeat(32), pid: process.pid,
    start_identity: processIdentity(process.pid), acquired_at: '2026-08-12T01:00:00.000Z',
  };
  const temporary = bootstrapPublicationTemp(p.lock, metadata);
  bootstrapPublicationMarker(temporary);
  const complete = `${JSON.stringify({
    schema_version: 1, kind: 'standalone-lock-publication', root: p.root,
    temporary: temporary.split('/').at(-1), ...metadata,
  })}\n`;
  writeFileSync(join(`${temporary}.owner`, 'payload'), complete);
  assert.throws(() => assertRootSafe(p.root, p), /held or ambiguous/);
  assert.equal(readFileSync(join(`${temporary}.owner`, 'payload'), 'utf8'), complete);

  rmSync(join(`${temporary}.owner`, 'payload'), { force: true });
  rmSync(`${temporary}.owner`, { recursive: true, force: true });
  writeFileSync(`${p.lock}.not-a-uuid.tmp`, `${JSON.stringify(metadata)}\n`);
  assert.throws(() => assertRootSafe(p.root, p), /not owned|owner marker/);
  assert.equal(existsSync(`${p.lock}.not-a-uuid.tmp`), true);

  unlinkSync(`${p.lock}.not-a-uuid.tmp`);
  writeFileSync(`${temporary}.owner`, '{not-json');
  assert.throws(() => assertRootSafe(p.root, p), /not valid JSON|owner marker/);
  assert.equal(readFileSync(`${temporary}.owner`, 'utf8'), '{not-json');

  writeFileSync(join(p.root, 'foreign'), 'foreign');
  assert.throws(() => assertRootSafe(p.root, p), /ambiguous unpublished lock state/);
  assert.equal(existsSync(`${temporary}.owner`), true);
});

test('bootstrap persists initializing ownership before creating staging state', () => {
  const source = readFileSync(new URL('../scripts/standalone-bootstrap.js', import.meta.url), 'utf8');
  const receiptWrite = source.indexOf("state: 'initializing'");
  const stagingCreate = source.indexOf(
    "ensureRealDirectory(join(p.root, 'staging'), 'standalone staging namespace')",
  );
  assert.ok(receiptWrite > 0);
  assert.ok(stagingCreate > receiptWrite);
});

test('bootstrap removes only a same-inode temp alias left after lock publication', () => {
  const home = mkdtempSync(join(tmpdir(), 'triss-lock-alias-'));
  const p = paths({
    HOME: home,
    TRISS_HOME: join(home, 'legacy'),
    TRISS_STANDALONE_HOME: join(home, 'standalone'),
    TRISS_BIN_DIR: join(home, 'bin'),
  });
  mkdirSync(p.root, { recursive: true });
  writeFileSync(p.lock, `${JSON.stringify({
    schema_version: 1, nonce: 'a'.repeat(32), pid: process.pid,
    start_identity: processIdentity(process.pid), acquired_at: '2026-08-12T01:00:00.000Z',
  })}\n`);
  const lockMetadata = JSON.parse(readFileSync(p.lock, 'utf8'));
  const alias = bootstrapPublicationTemp(p.lock, lockMetadata);
  const marker = bootstrapPublicationMarker(alias);
  linkSync(p.lock, join(marker, 'payload'));

  assert.doesNotThrow(() => assertRootSafe(p.root, p));
  assert.equal(existsSync(alias), false);
  assert.equal(existsSync(p.lock), true);

  const breakAlias = `${p.lock}.break-link`;
  linkSync(p.lock, breakAlias);
  assert.doesNotThrow(() => assertRootSafe(p.root, p));
  assert.equal(existsSync(breakAlias), false);

  const unrelated = `${p.lock}.abcdefab-cdef-4abc-8def-abcdefabcdef.tmp`;
  writeFileSync(unrelated, readFileSync(p.lock));
  assert.throws(() => assertRootSafe(p.root, p), /unowned lock alias|no owner marker|multiple interrupted lock aliases/);
  assert.equal(existsSync(unrelated), true);
});

test('bootstrap removes abandoned losing contenders without touching the final lock', () => {
  const home = mkdtempSync(join(tmpdir(), 'triss-lock-losing-'));
  const p = paths({
    HOME: home, TRISS_HOME: join(home, 'legacy'),
    TRISS_STANDALONE_HOME: join(home, 'standalone'), TRISS_BIN_DIR: join(home, 'bin'),
  });
  mkdirSync(p.root, { recursive: true });
  const final = {
    schema_version: 1, nonce: 'f'.repeat(32), pid: 777777, start_identity: 'ps:live',
    acquired_at: new Date(0).toISOString(),
  };
  const finalText = `${JSON.stringify(final)}\n`;
  writeFileSync(p.lock, finalText);
  const metadata = {
    schema_version: 1, nonce: 'e'.repeat(32), pid: 2_147_483_647,
    start_identity: 'proc:stale', acquired_at: new Date(0).toISOString(),
  };
  const temporary = bootstrapPublicationTemp(p.lock, metadata);
  const marker = bootstrapPublicationMarker(temporary);
  writeFileSync(join(marker, 'payload'), '{');
  assert.doesNotThrow(() => assertRootSafe(p.root, p));
  assert.equal(readFileSync(p.lock, 'utf8'), finalText);
  assert.equal(existsSync(marker), false);

  const liveMetadata = { ...metadata, nonce: 'd'.repeat(32), pid: process.pid, start_identity: processIdentity(process.pid) };
  const liveTemporary = bootstrapPublicationTemp(p.lock, liveMetadata);
  const liveMarker = bootstrapPublicationMarker(liveTemporary);
  writeFileSync(join(liveMarker, 'payload'), '{');
  assert.throws(() => assertRootSafe(p.root, p), /held or ambiguous/);
  assert.equal(readFileSync(p.lock, 'utf8'), finalText);
  assert.equal(existsSync(liveMarker), true);
});

test('receipt-owned root recovers an abandoned marker-only lock publication', () => {
  const { p } = fixture();
  const metadata = {
    schema_version: 1, nonce: 'c'.repeat(32), pid: 2_147_483_647,
    start_identity: 'proc:stale', acquired_at: '2026-08-12T01:00:00.000Z',
  };
  const temporary = bootstrapPublicationTemp(p.lock, metadata);
  bootstrapPublicationMarker(temporary);
  assert.doesNotThrow(() => assertRootSafe(p.root, p));
  assert.equal(existsSync(`${temporary}.owner`), false);
  assert.equal(existsSync(temporary), false);
});

test('bootstrap cleans multiple abandoned publication containers and enforces the bound', () => {
  const home = mkdtempSync(join(tmpdir(), 'triss-lock-multiple-'));
  const p = paths({ HOME: home, TRISS_HOME: join(home, 'legacy'),
    TRISS_STANDALONE_HOME: join(home, 'standalone'), TRISS_BIN_DIR: join(home, 'bin') });
  mkdirSync(p.root, { recursive: true });
  for (let index = 0; index < 2; index++) {
    const metadata = { schema_version: 1, nonce: String(index).repeat(32), pid: 2_147_483_647,
      start_identity: 'proc:stale', acquired_at: '2026-08-12T01:00:00.000Z' };
    bootstrapPublicationMarker(bootstrapPublicationTemp(p.lock, metadata));
  }
  assert.doesNotThrow(() => assertRootSafe(p.root, p));
  assert.equal(readdirSync(p.root).length, 0);

  for (let index = 0; index < 9; index++) {
    const metadata = { schema_version: 1, nonce: index.toString(16).padStart(1, '0').repeat(32),
      pid: 2_147_483_647, start_identity: 'proc:stale', acquired_at: '2026-08-12T01:00:00.000Z' };
    bootstrapPublicationMarker(bootstrapPublicationTemp(p.lock, metadata));
  }
  assert.throws(() => assertRootSafe(p.root, p), /multiple|too many|not owned|ambiguous/i);
  assert.equal(readdirSync(p.root).filter((name) => name.endsWith('.owner')).length, 9);
});

test('bootstrap validates all publication containers before mutating when one owner is live', () => {
  const home = mkdtempSync(join(tmpdir(), 'triss-lock-mixed-'));
  const p = paths({ HOME: home, TRISS_HOME: join(home, 'legacy'),
    TRISS_STANDALONE_HOME: join(home, 'standalone'), TRISS_BIN_DIR: join(home, 'bin') });
  mkdirSync(p.root, { recursive: true });
  const stale = { schema_version: 1, nonce: 'a'.repeat(32), pid: 2_147_483_647,
    start_identity: 'proc:stale', acquired_at: '2026-08-12T01:00:00.000Z' };
  const live = { schema_version: 1, nonce: 'b'.repeat(32), pid: process.pid,
    start_identity: processIdentity(process.pid), acquired_at: '2026-08-12T01:00:00.000Z' };
  const staleMarker = bootstrapPublicationMarker(bootstrapPublicationTemp(p.lock, stale));
  const liveMarker = bootstrapPublicationMarker(bootstrapPublicationTemp(p.lock, live));
  assert.throws(() => assertRootSafe(p.root, p), /held or ambiguous/);
  assert.equal(existsSync(staleMarker), true);
  assert.equal(existsSync(liveMarker), true);
});

test('bootstrap publication tuple supports safe pid and canonical macOS ps identity', () => {
  const home = mkdtempSync(join(tmpdir(), 'triss-lock-portable-'));
  const p = paths({
    HOME: home,
    TRISS_HOME: join(home, 'legacy'),
    TRISS_STANDALONE_HOME: join(home, 'standalone'),
    TRISS_BIN_DIR: join(home, 'bin'),
  });
  mkdirSync(p.root, { recursive: true });
  const metadata = {
    schema_version: 1,
    nonce: 'd'.repeat(32),
    pid: Number.MAX_SAFE_INTEGER,
    start_identity: 'ps:Wed Aug 13 12:34:56 2026',
    acquired_at: '2026-08-13T12:34:56.000Z',
  };
  const temporary = bootstrapPublicationTemp(p.lock, metadata);
  assert.ok(Buffer.byteLength(temporary.split('/').at(-1), 'utf8') <= 240);
  assert.ok(Buffer.byteLength(`${temporary}.owner`.split('/').at(-1), 'utf8') <= 240);
  bootstrapPublicationMarker(temporary);
  writeFileSync(join(`${temporary}.owner`, 'payload'), `${JSON.stringify({
    schema_version: 1, kind: 'standalone-lock-publication', root: p.root,
    temporary: temporary.split('/').at(-1), ...metadata,
  })}\n`);
  assert.doesNotThrow(() => assertRootSafe(p.root, p));
});

test('owned bootstrap namespaces and bin directory reject symlink aliases', () => {
  for (const namespace of ['versions', 'integrity', 'staging']) {
    const home = mkdtempSync(join(tmpdir(), `triss-${namespace}-link-`));
    const p = paths({
      HOME: home,
      TRISS_HOME: join(home, 'legacy'),
      TRISS_STANDALONE_HOME: join(home, 'standalone'),
      TRISS_BIN_DIR: join(home, 'bin'),
    });
    mkdirSync(p.root, { recursive: true });
    writeFileSync(p.receipt, `${JSON.stringify({
      schema_version: 1, name: 'triss-coworker', managed_by: 'triss-standalone',
      state: 'initializing', root: p.root, bin_path: p.binPath, current_version: null,
      previous_version: null, channel: 'stable', installed_at: '2026-08-12T00:00:00.000Z',
      updated_at: null, versions: {},
    })}\n`);
    symlinkSync(home, join(p.root, namespace));
    assert.throws(() => assertRootSafe(p.root, p), /not a real directory/);
  }

  const home = mkdtempSync(join(tmpdir(), 'triss-bin-link-'));
  const p = paths({
    HOME: home,
    TRISS_HOME: join(home, 'legacy'),
    TRISS_STANDALONE_HOME: join(home, 'standalone'),
    TRISS_BIN_DIR: join(home, 'bin'),
  });
  mkdirSync(p.root, { recursive: true });
  writeFileSync(p.receipt, `${JSON.stringify({
    schema_version: 1, name: 'triss-coworker', managed_by: 'triss-standalone',
    state: 'initializing', root: p.root, bin_path: p.binPath, current_version: null,
    previous_version: null, channel: 'stable', installed_at: '2026-08-12T00:00:00.000Z',
    updated_at: null, versions: {},
  })}\n`);
  symlinkSync(home, p.binDir);
  assert.throws(() => assertRootSafe(p.root, p), /not a real directory/);
});

test('standalone staging refuses filesystem roots and source ancestors', () => {
  const source = mkdtempSync(join(tmpdir(), 'triss-stage-source-'));
  assert.throws(() => stageStandalone({ sourceDir: source, stageDir: '/' }), /filesystem root/);
  assert.throws(() => stageStandalone({ sourceDir: join(source, 'nested'), stageDir: source }),
    /sourceDir must be a directory|overlap/);
  const parent = mkdtempSync(join(tmpdir(), 'triss-stage-parent-'));
  const nested = join(parent, 'source');
  mkdirSync(nested);
  assert.throws(() => stageStandalone({ sourceDir: nested, stageDir: parent }), /overlap/);
});

test('installer acquires the lock before attempting journal recovery', async () => {
  const { p } = fixture();
  writeFileSync(p.journal, 'not-json');
  writeFileSync(p.lock, JSON.stringify({
    schema_version: 1, nonce: 'held', pid: process.pid,
    start_identity: processIdentity(process.pid), acquired_at: new Date().toISOString(),
  }));
  await assert.rejects(
    installManifest({ ...manifest, node_compatible: true }, p),
    /update lock is held/,
  );
  assert.equal(readFileSync(p.journal, 'utf8'), 'not-json');
});

test('recovery restores the previous tree before reporting a corrupted new tree', () => {
  const { p, receipt: oldReceipt, finalPath: oldFinal } = fixture('0.31.0');
  mkdirSync(p.binDir, { recursive: true });
  symlinkSync(oldFinal, join(p.root, 'current'));
  symlinkSync(join(p.root, 'current', 'bin', 'triss.js'), p.binPath);

  const nextVersion = '0.32.0';
  const nextFinal = join(p.root, 'versions', nextVersion);
  mkdirSync(join(nextFinal, 'bin'), { recursive: true });
  writeFileSync(join(nextFinal, 'bin', 'triss.js'), 'corrupted');
  const wanted = Buffer.from(`#!/usr/bin/env node\nconsole.log('${nextVersion}');\n`);
  const nextInventory = { schema_version: 1, files: [{
    path: 'bin/triss.js', mode: 0o755, size: wanted.length, sha256: hash(wanted),
  }] };
  const nextDigest = hash(Buffer.from(canonicalJson(nextInventory)));
  writeFileSync(join(p.root, 'integrity', `${nextVersion}.json`), `${canonicalJson(nextInventory)}\n`);
  const nextReceipt = {
    ...oldReceipt, current_version: nextVersion, previous_version: '0.31.0',
    versions: {
      ...oldReceipt.versions,
      [nextVersion]: {
        artifact_sha256: 'b'.repeat(64), inventory_path: `integrity/${nextVersion}.json`,
        inventory_sha256: nextDigest, tree_digest: nextDigest, file_count: 1,
        expanded_bytes: wanted.length, installed_at: '2026-08-12T01:00:00.000Z',
      },
    },
  };
  const oldReceiptText = canonicalJson(oldReceipt);
  writeFileSync(p.journal, JSON.stringify({
    schema_version: 1, transaction_id: 'test', operation: 'install', phase: 'CURRENT_ACTIVATED',
    root: p.root, receipt_path: p.receipt,
    staging_path: join(p.root, 'staging', `${nextVersion}-test`), final_path: nextFinal,
    inventory_path: join(p.root, 'integrity', `${nextVersion}.json`),
    inventory_temp_path: null, old_current: oldFinal, target_current: nextFinal,
    old_launcher: join(oldFinal, 'bin', 'triss.js'),
    old_launcher_lexical: join(p.root, 'current', 'bin', 'triss.js'),
    old_receipt_sha256: hash(Buffer.from(oldReceiptText)),
    new_receipt_sha256: hash(Buffer.from(canonicalJson(nextReceipt))),
    old_receipt: oldReceiptText, new_receipt: nextReceipt,
    created_at: '2026-08-12T01:00:00.000Z',
  }));
  unlinkSync(join(p.root, 'current'));
  symlinkSync(nextFinal, join(p.root, 'current'));
  assert.throws(() => recoverJournal(p), /restored the previous launcher; retained untrusted version/);
  assert.equal(resolveLink(join(p.root, 'current')), oldFinal);
  assert.equal(JSON.parse(readFileSync(p.receipt)).current_version, '0.31.0');
  assert.equal(existsSync(p.journal), false);
  assert.equal(existsSync(nextFinal), true);
});

test('recovery fails closed and preserves a crash-era launcher replaced by a regular file', () => {
  const { p, oldFinal, finalPath } = recoveryFixture();
  mkdirSync(join(p.root, 'current'), { recursive: true });
  mkdirSync(p.binDir, { recursive: true });
  writeFileSync(p.binPath, 'user bytes that must survive\n');
  const before = readFileSync(p.binPath);
  assert.throws(() => recoverJournal(p), /recovery launcher is not a symlink/);
  assert.deepEqual(readFileSync(p.binPath), before);
  assert.equal(existsSync(oldFinal), true);
  assert.equal(existsSync(finalPath), true);
  assert.equal(existsSync(p.journal), true);
  unlinkSync(p.binPath);
  symlinkSync(join(p.legacy, 'bin', 'triss.js'), p.binPath);
  assert.throws(() => recoverJournal(p), /recovery launcher target changed unexpectedly/);
  assert.equal(existsSync(p.journal), true);
});

test('recovery rejects a self-referential PREPARED journal without deleting the active tree', () => {
  const { p, receipt, finalPath } = fixture('0.31.0');
  const receiptText = canonicalJson(receipt);
  writeFileSync(p.journal, JSON.stringify({
    schema_version: 1, transaction_id: 'self', operation: 'install', phase: 'PREPARED',
    root: p.root, receipt_path: p.receipt, staging_path: join(p.root, 'staging', 'self'),
    final_path: finalPath, inventory_path: join(p.root, 'integrity', '0.31.0.json'),
    inventory_temp_path: null, old_current: finalPath, target_current: finalPath,
    old_launcher: null, old_receipt_sha256: hash(Buffer.from(receiptText)),
    new_receipt_sha256: hash(Buffer.from(receiptText)), old_receipt: receiptText,
    new_receipt: receipt, created_at: '2026-08-12T01:00:00.000Z',
  }));
  assert.throws(() => recoverJournal(p), /old and target versions alias/);
  assert.equal(existsSync(finalPath), true);
  assert.equal(JSON.parse(readFileSync(p.receipt)).current_version, '0.31.0');
  assert.equal(existsSync(p.journal), true);
});

test('bootstrap recovery rejects receipt-mismatched and symlink-escaping journal paths', () => {
  const { p, receipt: oldReceipt, finalPath: oldFinal } = fixture('0.31.0');
  const outside = mkdtempSync(join(tmpdir(), 'triss-bootstrap-outside-'));
  symlinkSync(outside, join(p.root, 'escape'));
  const oldReceiptText = canonicalJson(oldReceipt);
  const nextReceipt = { ...oldReceipt };
  const baseJournal = {
    schema_version: 1, transaction_id: 'test', operation: 'install', phase: 'PREPARED',
    root: p.root, receipt_path: p.receipt,
    staging_path: join(p.root, 'staging', '0.31.0-test'),
    final_path: oldFinal, inventory_path: join(p.root, 'integrity', '0.31.0.json'),
    inventory_temp_path: join(p.root, 'integrity', '0.31.0.json.test.prepared'),
    old_current: oldFinal, target_current: oldFinal, old_launcher: null,
    old_receipt_sha256: hash(Buffer.from(oldReceiptText)),
    new_receipt_sha256: hash(Buffer.from(canonicalJson(nextReceipt))),
    old_receipt: oldReceiptText, new_receipt: nextReceipt,
    created_at: '2026-08-12T01:00:00.000Z',
  };
  writeFileSync(p.journal, JSON.stringify({
    ...baseJournal,
    final_path: join(p.root, 'escape', 'victim'),
    target_current: join(p.root, 'escape', 'victim'),
  }));
  assert.throws(() => recoverJournal(p), /escapes standalone root/);
  assert.equal(existsSync(outside), true);
  writeFileSync(p.journal, JSON.stringify({
    ...baseJournal,
    final_path: join(p.root, 'versions', '9.9.9'),
    target_current: join(p.root, 'versions', '9.9.9'),
  }));
  assert.throws(() => recoverJournal(p), /receipt-anchored targets/);
});

test('recovery completes when the new receipt was durable before the COMMITTED phase', () => {
  const { p, receipt: oldReceipt, finalPath: oldFinal } = fixture('0.31.0');
  const nextVersion = '0.32.0';
  const nextFinal = join(p.root, 'versions', nextVersion);
  const nextEntry = join(nextFinal, 'bin', 'triss.js');
  const nextSource = `#!/usr/bin/env node\nconsole.log('${nextVersion}');\n`;
  mkdirSync(join(nextFinal, 'bin'), { recursive: true });
  writeFileSync(nextEntry, nextSource, { mode: 0o755 });
  chmodSync(nextEntry, 0o755);
  const nextInventory = { schema_version: 1, files: [{
    path: 'bin/triss.js', mode: 0o755, size: Buffer.byteLength(nextSource),
    sha256: hash(Buffer.from(nextSource)),
  }] };
  const nextDigest = hash(Buffer.from(canonicalJson(nextInventory)));
  writeFileSync(join(p.root, 'integrity', `${nextVersion}.json`), `${canonicalJson(nextInventory)}\n`);
  const nextReceipt = {
    ...oldReceipt, current_version: nextVersion, previous_version: '0.31.0',
    versions: {
      ...oldReceipt.versions,
      [nextVersion]: {
        artifact_sha256: 'b'.repeat(64), inventory_path: `integrity/${nextVersion}.json`,
        inventory_sha256: nextDigest, tree_digest: nextDigest, file_count: 1,
        expanded_bytes: Buffer.byteLength(nextSource),
        installed_at: '2026-08-12T01:00:00.000Z',
      },
    },
  };
  mkdirSync(p.binDir, { recursive: true });
  symlinkSync(nextFinal, join(p.root, 'current'));
  symlinkSync(join(p.root, 'current', 'bin', 'triss.js'), p.binPath);
  writeFileSync(p.receipt, `${JSON.stringify(nextReceipt, null, 2)}\n`);
  const oldReceiptText = canonicalJson(oldReceipt);
  writeFileSync(p.journal, JSON.stringify({
    schema_version: 1, transaction_id: 'test', operation: 'install',
    phase: 'LAUNCHER_ACTIVATED', root: p.root, receipt_path: p.receipt,
    staging_path: join(p.root, 'staging', `${nextVersion}-test`), final_path: nextFinal,
    inventory_path: join(p.root, 'integrity', `${nextVersion}.json`),
    inventory_temp_path: null, old_current: oldFinal, target_current: nextFinal,
    old_launcher: null, old_receipt_sha256: hash(Buffer.from(oldReceiptText)),
    new_receipt_sha256: hash(Buffer.from(canonicalJson(nextReceipt))),
    old_receipt: oldReceiptText, new_receipt: nextReceipt,
    created_at: '2026-08-12T01:00:00.000Z',
  }));
  assert.equal(recoverJournal(p), true);
  assert.equal(existsSync(p.journal), false);
  assert.equal(resolveLink(join(p.root, 'current')), nextFinal);
  assert.equal(JSON.parse(readFileSync(p.receipt)).current_version, nextVersion);
  assert.equal(existsSync(nextFinal), true);
});

test('recovery checks the committed candidate before an irrelevant corrupted old tree', () => {
  const { p, oldFinal, finalPath, nextReceipt } = recoveryFixture();
  writeFileSync(join(oldFinal, 'bin', 'triss.js'), 'corrupted old tree');
  mkdirSync(p.binDir, { recursive: true });
  symlinkSync(finalPath, join(p.root, 'current'));
  symlinkSync(join(p.root, 'current', 'bin', 'triss.js'), p.binPath);
  writeFileSync(p.receipt, `${JSON.stringify(nextReceipt)}\n`);
  const journal = JSON.parse(readFileSync(p.journal));
  journal.phase = 'LAUNCHER_ACTIVATED';
  writeFileSync(p.journal, JSON.stringify(journal));
  assert.equal(recoverJournal(p), true);
  assert.equal(existsSync(p.journal), false);
  assert.equal(existsSync(finalPath), true);
});

test('recovery accepts the launcher rename crash window and restores old state', () => {
  const { p, oldFinal, finalPath } = recoveryFixture();
  mkdirSync(p.binDir, { recursive: true });
  symlinkSync(oldFinal, join(p.root, 'current'));
  unlinkSync(join(p.root, 'current'));
  symlinkSync(finalPath, join(p.root, 'current'));
  symlinkSync(join(p.root, 'current', 'bin', 'triss.js'), p.binPath);
  const journal = JSON.parse(readFileSync(p.journal));
  journal.phase = 'CURRENT_ACTIVATED';
  writeFileSync(p.journal, JSON.stringify(journal));
  assert.equal(recoverJournal(p), true);
  assert.equal(realpathSync(join(p.root, 'current')), realpathSync(oldFinal));
  assert.equal(existsSync(finalPath), false);
  assert.equal(existsSync(p.journal), false);
});

test('recovery completes a durable new receipt while a recorded legacy launcher remains active', () => {
  const { p, finalPath, nextReceipt } = recoveryFixture();
  const legacyLauncher = join(p.legacy, 'bin', 'triss.js');
  mkdirSync(dirname(legacyLauncher), { recursive: true });
  writeFileSync(legacyLauncher, '#!/usr/bin/env node\n', { mode: 0o755 });
  mkdirSync(p.binDir, { recursive: true });
  symlinkSync(finalPath, join(p.root, 'current'));
  symlinkSync(legacyLauncher, p.binPath);
  writeFileSync(p.receipt, `${JSON.stringify(nextReceipt)}\n`);
  const journal = JSON.parse(readFileSync(p.journal));
  journal.phase = 'CURRENT_ACTIVATED';
  journal.old_launcher = legacyLauncher;
  journal.old_launcher_lexical = legacyLauncher;
  writeFileSync(p.journal, JSON.stringify(journal));

  assert.equal(recoverJournal(p), true);
  assert.equal(realpathSync(join(p.root, 'current')), realpathSync(finalPath));
  assert.equal(resolveLink(p.binPath), join(p.root, 'current', 'bin', 'triss.js'));
  assert.equal(JSON.parse(readFileSync(p.receipt)).current_version, '0.32.0');
});

test('recovery accepts a durable rollback phase after launcher smoke failure', () => {
  const { p, oldFinal, finalPath } = recoveryFixture();
  mkdirSync(p.binDir, { recursive: true });
  symlinkSync(oldFinal, join(p.root, 'current'));
  symlinkSync(join(p.root, 'current', 'bin', 'triss.js'), p.binPath);
  const journal = JSON.parse(readFileSync(p.journal));
  journal.phase = 'ROLLED_BACK';
  writeFileSync(p.journal, JSON.stringify(journal));
  assert.equal(recoverJournal(p), true);
  assert.equal(realpathSync(join(p.root, 'current')), realpathSync(oldFinal));
  assert.equal(existsSync(finalPath), false);
  assert.equal(existsSync(p.journal), false);
});

test('recovery retains final trees for production-shaped reused apply and rollback journals', () => {
  for (const operation of ['apply', 'rollback']) {
    const { p, oldFinal, finalPath } = recoveryFixture();
    mkdirSync(p.binDir, { recursive: true });
    symlinkSync(finalPath, join(p.root, 'current'));
    symlinkSync(join(p.root, 'current', 'bin', 'triss.js'), p.binPath);
    const journal = JSON.parse(readFileSync(p.journal));
    journal.operation = operation;
    journal.staging_path = null;
    journal.inventory_path = operation === 'rollback' ? null : journal.inventory_path;
    journal.reused_target = operation === 'apply';
    journal.phase = 'CURRENT_ACTIVATED';
    writeFileSync(p.journal, JSON.stringify(journal));

    assert.equal(recoverJournal(p), true);
    assert.equal(existsSync(finalPath), true, `${operation} recovery must retain its final tree`);
    assert.equal(resolveLink(join(p.root, 'current')), oldFinal);
    assert.equal(existsSync(p.journal), false);
  }
});

test('first-install recovery treats null old_current as null even when cwd is the candidate tree', () => {
  const { p, receipt: activeReceipt } = fixture('0.32.0');
  const oldReceipt = {
    ...activeReceipt,
    state: 'initializing', current_version: null, previous_version: null,
    updated_at: null, versions: {},
  };
  const version = '0.33.0';
  const finalPath = join(p.root, 'versions', version);
  const source = Buffer.from(`#!/usr/bin/env node\nconsole.log('${version}');\n`);
  mkdirSync(join(finalPath, 'bin'), { recursive: true });
  writeFileSync(join(finalPath, 'bin', 'triss.js'), source, { mode: 0o755 });
  const inventory = { schema_version: 1, files: [{
    path: 'bin/triss.js', mode: 0o755, size: source.length, sha256: hash(source),
  }] };
  const digest = hash(Buffer.from(canonicalJson(inventory)));
  writeFileSync(join(p.root, 'integrity', `${version}.json`), `${canonicalJson(inventory)}\n`);
  const nextReceipt = {
    ...activeReceipt, current_version: version, previous_version: null,
    versions: { [version]: {
      artifact_sha256: 'b'.repeat(64), inventory_path: `integrity/${version}.json`,
      inventory_sha256: digest, tree_digest: digest, file_count: 1,
      expanded_bytes: source.length, installed_at: '2026-08-12T01:00:00.000Z',
    } },
  };
  writeFileSync(p.receipt, `${canonicalJson(oldReceipt)}\n`);
  writeFileSync(p.journal, JSON.stringify({
    schema_version: 1, transaction_id: 'first-install-cwd', operation: 'install', phase: 'PREPARED',
    root: p.root, receipt_path: p.receipt,
    staging_path: join(p.root, 'staging', `${version}-test`), final_path: finalPath,
    inventory_path: join(p.root, 'integrity', `${version}.json`), inventory_temp_path: null,
    old_current: null, target_current: finalPath, old_launcher: null,
    old_receipt_sha256: hash(Buffer.from(canonicalJson(oldReceipt))),
    new_receipt_sha256: hash(Buffer.from(canonicalJson(nextReceipt))),
    old_receipt: canonicalJson(oldReceipt), new_receipt: nextReceipt,
    created_at: '2026-08-12T01:00:00.000Z',
  }));
  const previousCwd = process.cwd();
  try {
    process.chdir(finalPath);
    assert.equal(recoverJournal(p), true);
  } finally {
    process.chdir(previousCwd);
  }
  assert.equal(JSON.parse(readFileSync(p.receipt)).state, 'initializing');
  assert.equal(existsSync(join(p.root, 'current')), false);
  assert.equal(existsSync(p.binPath), false);
  assert.equal(existsSync(finalPath), false);
  assert.equal(existsSync(p.journal), false);
});

test('bootstrap recovers a pending first install before any network discovery', async () => {
  const { p, receipt: activeReceipt } = fixture('0.32.0');
  const initializing = { ...activeReceipt, state: 'initializing', current_version: null,
    previous_version: null, updated_at: null, versions: {} };
  writeFileSync(p.receipt, `${canonicalJson(initializing)}\n`);
  const candidateEntry = { ...activeReceipt.versions['0.32.0'], inventory_path: 'integrity/0.33.0.json' };
  const candidateReceipt = { ...activeReceipt, current_version: '0.33.0', previous_version: null,
    versions: { '0.33.0': candidateEntry } };
  writeFileSync(join(p.root, 'integrity', '0.33.0.json'), readFileSync(join(p.root, 'integrity', '0.32.0.json')));
  writeFileSync(p.journal, JSON.stringify({
    schema_version: 1, transaction_id: 'offline-recovery', operation: 'install', phase: 'PREPARED',
    root: p.root, receipt_path: p.receipt, staging_path: join(p.root, 'staging', '0.33.0-test'),
    final_path: join(p.root, 'versions', '0.33.0'), inventory_path: join(p.root, 'integrity', '0.33.0.json'),
    inventory_temp_path: null, old_current: null, target_current: join(p.root, 'versions', '0.33.0'),
    old_launcher: null, old_receipt_sha256: null,
    new_receipt_sha256: hash(Buffer.from(canonicalJson(candidateReceipt))),
    old_receipt: null,
    new_receipt: candidateReceipt,
    created_at: '2026-08-12T01:00:00.000Z',
  }));
  let requested = false;
  const originalRequest = globalThis.fetch;
  try {
    globalThis.fetch = async () => { requested = true; throw new Error('network must not be reached'); };
    const { recoverBeforeDiscovery } = await import('../scripts/standalone-bootstrap.js');
    assert.equal(recoverBeforeDiscovery(p), true);
  } finally { globalThis.fetch = originalRequest; }
  assert.equal(requested, false);
  assert.equal(existsSync(p.journal), false);
  assert.equal(JSON.parse(readFileSync(p.receipt)).state, 'initializing');
});

test('missing launcher is repaired before a newer download is staged', async () => {
  const active = fixture('0.31.0');
  activateFixture(active);
  unlinkSync(active.p.binPath);
  const source = '#!/usr/bin/env node\nconsole.log(\'0.32.0\');\n';
  const artifact = bootstrapArtifact([bootstrapRecord('bin/triss.js', source, 0o755)], '0.32.0');
  const nextManifest = {
    ...manifest,
    artifact: { ...manifest.artifact, sha256: hash(artifact), size: artifact.length,
      expanded_size: Buffer.byteLength(source), file_count: 1 },
    node_compatible: true,
  };
  let downloaded = false;
  await installManifest(nextManifest, active.p, {
    download: async () => { downloaded = true; return { status: 200, bytes: artifact }; },
    statfs: () => ({ bavail: 1024 * 1024 * 1024, bsize: 1 }),
  });
  assert.equal(downloaded, true);
  assert.equal(realpathSync(active.p.binPath), realpathSync(join(active.p.root, 'versions', '0.32.0', 'bin', 'triss.js')));
  assert.equal(existsSync(active.p.journal), false);
});

test('artifact extraction compares actual totals to the signed manifest', async () => {
  const home = mkdtempSync(join(tmpdir(), 'triss-manifest-total-'));
  const p = paths({ HOME: home, TRISS_HOME: join(home, 'legacy'), TRISS_STANDALONE_HOME: join(home, 'standalone'), TRISS_BIN_DIR: join(home, 'bin') });
  const source = Buffer.from('#!/usr/bin/env node\nconsole.log("0.32.0");\n');
  const record = { type: 'file', path: 'bin/triss.js', mode: 0o755, size: source.length, sha256: hash(source), data: source.toString('base64') };
  const artifact = gzipSync(Buffer.from(`${JSON.stringify({ type: 'header', schema_version: 1, format: 'triss-ndjson-gzip-v1', version: '0.32.0', file_count: 1, expanded_bytes: source.length })}\n${JSON.stringify(record)}\n`));
  const signed = { ...manifest, node_compatible: true, artifact: { ...manifest.artifact, size: artifact.length, sha256: hash(artifact), expanded_size: source.length + 1, file_count: 2 } };
  await assert.rejects(() => installManifest(signed, p, {
    download: async () => ({ status: 200, bytes: artifact }),
    statfs: () => ({ bavail: 1024 * 1024 * 1024, bsize: 1 }),
  }), /artifact inventory totals do not match signed manifest/);
  assert.equal(existsSync(p.lock), false);
});

test('active receipt layout is validated before download, staging, or journal creation', async () => {
  const cases = [
    {
      name: 'corrupt active tree',
      mutate: ({ finalPath }) => writeFileSync(join(finalPath, 'bin', 'triss.js'), 'corrupted'),
      error: /installed tree integrity mismatch/,
    },
    {
      name: 'missing current pointer',
      mutate: ({ p }) => unlinkSync(join(p.root, 'current')),
      error: /current pointer is missing/,
    },
    {
      name: 'wrong in-root current target',
      mutate: ({ p }) => {
        unlinkSync(join(p.root, 'current'));
        symlinkSync('versions/0.32.0', join(p.root, 'current'));
      },
      error: /receipt and current pointer disagree/,
    },
    {
      name: 'outside current target',
      mutate: ({ p }) => {
        const outside = mkdtempSync(join(tmpdir(), 'triss-bootstrap-outside-'));
        unlinkSync(join(p.root, 'current'));
        symlinkSync(outside, join(p.root, 'current'));
      },
      error: /receipt and current pointer disagree/,
    },
  ];
  for (const scenario of cases) {
    const active = fixture('0.31.0');
    activateFixture(active);
    scenario.mutate(active);
    let downloaded = false;
    await assert.rejects(() => installManifest({ ...manifest, node_compatible: true }, active.p, {
      download: async () => {
        downloaded = true;
        return { status: 200, bytes: Buffer.alloc(10) };
      },
      statfs: () => ({ bavail: 1024 * 1024 * 1024, bsize: 1 }),
    }), scenario.error, scenario.name);
    assert.equal(downloaded, false, `${scenario.name}: download must not start`);
    assert.equal(existsSync(active.p.journal), false, `${scenario.name}: journal must not be created`);
    assert.equal(existsSync(join(active.p.root, 'staging')), false, `${scenario.name}: staging must not be created`);
    assert.equal(existsSync(active.p.lock), false, `${scenario.name}: lock must be released`);
  }
});

test('corrupt active receipt cannot authorize an install', async () => {
  const { p } = fixture('0.32.0');
  const corrupt = JSON.parse(readFileSync(p.receipt));
  corrupt.versions = {};
  writeFileSync(p.receipt, `${JSON.stringify(corrupt)}\n`);
  await assert.rejects(() => installManifest({ ...manifest, node_compatible: true }, p), /receipt current entry is missing/);
});

test('semantic downgrade is rejected before download, staging, or journal creation', async () => {
  const active = fixture('0.33.0');
  activateFixture(active);
  let downloaded = false;
  await assert.rejects(() => installManifest({
    ...manifest,
    version: '0.32.0',
    release_url: 'https://github.com/ayleen/triss-coworker/releases/tag/v0.32.0',
    artifact: { ...manifest.artifact, url: 'https://github.com/ayleen/triss-coworker/releases/download/v0.32.0/triss.gz' },
    node_compatible: true,
  }, active.p, {
    download: async () => { downloaded = true; return { status: 200, bytes: Buffer.alloc(10) }; },
    statfs: () => ({ bavail: 1024 * 1024 * 1024, bsize: 1 }),
  }), /older than the active/);
  assert.equal(downloaded, false);
  assert.equal(existsSync(active.p.journal), false);
  assert.equal(existsSync(join(active.p.root, 'staging')), false);
  assert.equal(existsSync(active.p.lock), false);
});

test('next locked run removes only bounded, owned pre-PREPARED leftovers', async () => {
  const active = fixture('0.32.0');
  activateFixture(active);
  const { p } = active;
  const stagingParent = join(p.root, 'staging');
  const owned = join(stagingParent, 'abandoned');
  const unowned = join(stagingParent, 'keep-me');
  mkdirSync(owned, { recursive: true });
  mkdirSync(unowned, { recursive: true });
  writeFileSync(join(unowned, 'user-file'), 'keep');
  writeFileSync(`${owned}.owner.json`, JSON.stringify({
    schema_version: 1, kind: 'standalone-staging', root: p.root, staging_path: owned,
    inventory_temp_path: null, owner_nonce: 'a'.repeat(32), created_at: '2026-08-12T01:00:00.000Z',
  }));
  await installManifest({ ...manifest, node_compatible: true }, p, {
    statfs: () => ({ bavail: 1024 * 1024 * 1024, bsize: 1 }),
  });
  assert.equal(existsSync(owned), false);
  assert.equal(existsSync(`${owned}.owner.json`), false);
  assert.equal(existsSync(join(unowned, 'user-file')), true);
});

test('idempotent relink restores previous links when stable smoke fails', async () => {
  const source = [
    '#!/usr/bin/env node',
    "if (process.argv[1].endsWith('/triss')) process.exit(9);",
    "console.log('0.32.0');",
    '',
  ].join('\n');
  const active = fixture('0.32.0', source);
  activateFixture(active);
  const { p, finalPath } = active;
  await assert.rejects(
    installManifest({ ...manifest, node_compatible: true }, p),
    /staged launcher --version smoke failed/,
  );
  assert.equal(resolveLink(join(p.root, 'current')), finalPath);
  assert.equal(resolveLink(p.binPath), join(p.root, 'current', 'bin', 'triss.js'));
  assert.equal(existsSync(p.lock), false);
});

test('non-idempotent public smoke failure rolls back the old committed state immediately', async () => {
  const source = [
    '#!/usr/bin/env node',
    "if (process.argv[1].endsWith('/triss')) process.exit(9);",
    "console.log('0.33.0');",
    '',
  ].join('\n');
  const artifact = bootstrapArtifact([bootstrapRecord('bin/triss.js', source, 0o755)], '0.33.0');
  const nextManifest = {
    ...manifest,
    version: '0.33.0',
    release_url: 'https://github.com/ayleen/triss-coworker/releases/tag/v0.33.0',
    artifact: {
      ...manifest.artifact,
      url: 'https://github.com/ayleen/triss-coworker/releases/download/v0.33.0/triss.gz',
      sha256: hash(artifact), size: artifact.length,
      expanded_size: Buffer.byteLength(source), file_count: 1,
    },
    node_compatible: true,
  };
  const active = fixture('0.32.0');
  activateFixture(active);
  const oldReceipt = JSON.parse(readFileSync(active.p.receipt, 'utf8'));
  await assert.rejects(() => installManifest(nextManifest, active.p, {
    download: async () => ({ status: 200, bytes: artifact }),
    statfs: () => ({ bavail: 1024 * 1024 * 1024, bsize: 1 }),
  }), /public launcher --version smoke failed/);
  assert.equal(resolveLink(join(active.p.root, 'current')), active.finalPath);
  assert.equal(realpathSync(active.p.binPath), realpathSync(join(active.finalPath, 'bin', 'triss.js')));
  assert.deepEqual(JSON.parse(readFileSync(active.p.receipt, 'utf8')), oldReceipt);
  assert.equal(existsSync(active.p.journal), false);
  assert.equal(existsSync(join(active.p.root, 'versions', '0.33.0')), false);
  assert.equal(existsSync(active.p.lock), false);
});

test('first-install public smoke failure restores the initializing receipt', async () => {
  const source = [
    '#!/usr/bin/env node',
    "if (process.argv[1].endsWith('/triss')) process.exit(9);",
    "console.log('0.33.0');",
    '',
  ].join('\n');
  const artifact = bootstrapArtifact([bootstrapRecord('bin/triss.js', source, 0o755)], '0.33.0');
  const home = mkdtempSync(join(tmpdir(), 'triss-bootstrap-first-install-'));
  const p = paths({
    HOME: home,
    TRISS_HOME: join(home, 'legacy'),
    TRISS_STANDALONE_HOME: join(home, 'standalone'),
    TRISS_BIN_DIR: join(home, 'bin'),
  });
  const nextManifest = {
    ...manifest,
    version: '0.33.0',
    release_url: 'https://github.com/ayleen/triss-coworker/releases/tag/v0.33.0',
    artifact: {
      ...manifest.artifact,
      url: 'https://github.com/ayleen/triss-coworker/releases/download/v0.33.0/triss.gz',
      sha256: hash(artifact), size: artifact.length,
      expanded_size: Buffer.byteLength(source), file_count: 1,
    },
    node_compatible: true,
  };
  await assert.rejects(() => installManifest(nextManifest, p, {
    download: async () => ({ status: 200, bytes: artifact }),
    statfs: () => ({ bavail: 1024 * 1024 * 1024, bsize: 1 }),
  }), /public launcher --version smoke failed/);
  const receipt = JSON.parse(readFileSync(p.receipt, 'utf8'));
  assert.equal(receipt.state, 'initializing');
  assert.equal(receipt.current_version, null);
  assert.equal(existsSync(join(p.root, 'current')), false);
  assert.equal(existsSync(p.binPath), false);
  assert.equal(existsSync(p.journal), false);
  assert.equal(existsSync(join(p.root, 'versions', '0.33.0')), false);
  assert.equal(existsSync(p.lock), false);
});

function resolveLink(path) {
  assert.equal(lstatSync(path).isSymbolicLink(), true);
  return resolve(dirname(path), readlinkSync(path));
}

function bootstrapArtifact(records, version = '0.32.0') {
  const expandedBytes = records.reduce((sum, record) => sum + record.size, 0);
  const header = {
    type: 'header', schema_version: 1, format: 'triss-ndjson-gzip-v1',
    version, file_count: records.length, expanded_bytes: expandedBytes,
  };
  return gzipSync(Buffer.from(`${[header, ...records].map(JSON.stringify).join('\n')}\n`));
}

function bootstrapRecord(path, content, mode = 0o644) {
  const data = Buffer.from(content);
  return {
    type: 'file', path, mode, size: data.length, sha256: hash(data),
    data: data.toString('base64'),
  };
}

test('bootstrap extraction uses UTF-8 order and flushes payloads before directories', () => {
  const stage = join(mkdtempSync(join(tmpdir(), 'triss-bootstrap-durable-')), 'stage');
  mkdirSync(stage);
  const events = [];
  const result = extractArtifact(bootstrapArtifact([
    bootstrapRecord('ä.txt', 'a'),
    bootstrapRecord('z.txt', 'z'),
  ]), stage, '0.32.0', {
    fsyncFile(_fd, path) { events.push(`file:${path}`); },
    fsyncDirectory(path) { events.push(`dir:${path}`); },
  });
  assert.deepEqual(result.inventory.map((entry) => entry.path), ['z.txt', 'ä.txt']);
  assert.equal(events.filter((event) => event.startsWith('file:')).length, 2);
  assert.ok(events.slice(2).every((event) => event.startsWith('dir:')));
  assert.throws(() => extractArtifact(
    bootstrapArtifact([bootstrapRecord('app.js', 'x')]),
    join(mkdtempSync(join(tmpdir(), 'triss-bootstrap-fsync-fail-')), 'stage'),
    '0.32.0',
    { fsyncFile() { throw new Error('injected payload fsync failure'); } },
  ), /injected payload fsync failure/);
});

test('bootstrap payload fsync failure leaves the committed launcher active', async () => {
  const active = fixture('0.31.0');
  activateFixture(active);
  const record = bootstrapRecord('bin/triss.js', '#!/usr/bin/env node\nconsole.log("0.32.0");\n', 0o755);
  const artifact = bootstrapArtifact([record]);
  const signed = {
    ...manifest,
    node_compatible: true,
    artifact: {
      ...manifest.artifact,
      size: artifact.length,
      sha256: hash(artifact),
      expanded_size: record.size,
      file_count: 1,
    },
  };
  await assert.rejects(() => installManifest(signed, active.p, {
    download: async () => ({ status: 200, bytes: artifact }),
    statfs: () => ({ bavail: 1024 * 1024 * 1024, bsize: 1 }),
    extractOptions: {
      fsyncFile() { throw new Error('injected payload fsync failure'); },
    },
  }), /injected payload fsync failure/);
  assert.equal(resolveLink(active.p.binPath), join(active.p.root, 'current', 'bin', 'triss.js'));
  assert.equal(resolveLink(join(active.p.root, 'current')), active.finalPath);
  assert.equal(existsSync(join(active.p.root, 'versions', '0.32.0')), false);
  assert.equal(existsSync(active.p.journal), false);
  assert.equal(JSON.parse(readFileSync(active.p.receipt)).current_version, '0.31.0');
});

test('bootstrap tree validation is bounded and rejects symlink roots and sparse extras', () => {
  const root = mkdtempSync(join(tmpdir(), 'triss-bootstrap-tree-'));
  writeFileSync(join(root, 'app.js'), 'ok\n', { mode: 0o644 });
  const inventory = { schema_version: 1, files: [bootstrapRecord('app.js', 'ok\n')] };
  for (const specialBits of [0o4000, 0o2000, 0o1000]) {
    chmodSync(join(root, 'app.js'), 0o644 | specialBits);
    if ((lstatSync(join(root, 'app.js')).mode & 0o7000) === 0) continue;
    assert.throws(() => validateTree(root, inventory), /special permission bits/);
    chmodSync(join(root, 'app.js'), 0o644);
  }
  const alias = join(mkdtempSync(join(tmpdir(), 'triss-bootstrap-tree-alias-')), 'version');
  symlinkSync(root, alias);
  assert.throws(() => validateTree(alias, inventory), /root must be a real directory/);

  const sparse = join(root, 'unexpected-sparse');
  writeFileSync(sparse, '');
  truncateSync(sparse, 64 * 1024 * 1024 + 1);
  assert.throws(() => validateTree(root, inventory), /unexpected file/);
  unlinkSync(sparse);
  mkdirSync(join(root, 'unexpected-empty'));
  assert.throws(() => validateTree(root, inventory), /unexpected directory/);

  const deep = mkdtempSync(join(tmpdir(), 'triss-bootstrap-depth-'));
  let current = deep;
  for (let index = 0; index <= 64; index++) {
    current = join(current, `d${index}`);
    mkdirSync(current);
  }
  assert.throws(() => validateTree(deep, { schema_version: 1, files: [] }), /depth exceeds/);
});

class FakeResponse extends EventEmitter {
  constructor(chunks, delayMs, statusCode = 200) {
    super();
    this.statusCode = statusCode;
    this.headers = {};
    this.chunks = chunks;
    this.delayMs = delayMs;
    this.timer = null;
    this.destroyed = null;
  }

  setTimeout(ms, callback) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = ms > 0 ? setTimeout(callback, ms) : null;
    return this;
  }

  destroy(error) {
    this.destroyed = error || new Error('destroyed');
    if (this.timer) clearTimeout(this.timer);
  }

  async *[Symbol.asyncIterator]() {
    for (const chunk of this.chunks) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      if (this.destroyed) throw this.destroyed;
      this.emit('data', chunk);
      yield chunk;
    }
    this.emit('end');
  }
}

function fakeRequest(chunks, delayMs, responseDelayMs = 0, statusCode = 200) {
  return (_url, _options, callback) => {
    const requestObject = new EventEmitter();
    requestObject.destroyed = null;
    requestObject.destroy = (error) => { requestObject.destroyed = error || new Error('destroyed'); };
    requestObject.end = () => setTimeout(() => {
      if (!requestObject.destroyed) callback(new FakeResponse(chunks, delayMs, statusCode));
    }, responseDelayMs);
    queueMicrotask(() => {
      if (!requestObject.destroyed) {
        const socket = new EventEmitter();
        socket.connecting = false;
        requestObject.emit('socket', socket);
      }
    });
    return requestObject;
  };
}

test('standalone download permits continuous chunks beyond the old five-second deadline', async () => {
  const chunks = Array.from({ length: 6 }, (_, index) => Buffer.from(`chunk-${index}`));
  const result = await request('https://github.com/ayleen/triss-coworker/artifact', {
    maxBytes: 1024,
    totalTimeoutMs: 1000,
    connectTimeoutMs: 100,
    headersTimeoutMs: 100,
    inactivityTimeoutMs: 80,
    lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
    requestImpl: fakeRequest(chunks, 25),
  });
  assert.deepEqual(result.bytes, Buffer.concat(chunks));
});

test('standalone download aborts a stalled response despite a generous total deadline', async () => {
  await assert.rejects(() => request('https://github.com/ayleen/triss-coworker/artifact', {
    maxBytes: 1024,
    totalTimeoutMs: 1000,
    connectTimeoutMs: 100,
    headersTimeoutMs: 100,
    inactivityTimeoutMs: 25,
    lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
    requestImpl: fakeRequest([Buffer.from('chunk')], 100),
  }), /inactivity timed out/);
});

test('standalone request preserves an empty 404 for the verified legacy bridge', async () => {
  const result = await request('https://github.com/ayleen/triss-coworker/manifest', {
    maxBytes: 1024,
    lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }],
    requestImpl: fakeRequest([], 0, 0, 404),
  });
  assert.equal(result.status, 404);
  assert.equal(result.bytes.length, 0);
});

test('bootstrap source contains fail-closed 404 bridge and no package-manager path after manifest success', () => {
  const source = readFileSync(new URL('../scripts/standalone-bootstrap.js', import.meta.url), 'utf8');
  assert.match(source, /status !== 404/);
  assert.match(source, /LATEST_RELEASE_URL/);
  assert.match(source, /assets\.some\(.*update-manifest\.json/);
  assert.match(source, /legacyFallback\(p\)/);
  assert.match(source, /spawn\('git'/);
  assert.match(source, /spawn\('npm'/);
  assert.match(source, /LEGACY_REPOSITORY_URL = 'https:\/\/github\.com\/ayleen\/triss-coworker\.git'/);
  assert.match(source, /LEGACY_REPOSITORY_REF = 'main'/);
  assert.match(source, /'--single-branch', '--branch', LEGACY_REPOSITORY_REF/);
  assert.match(source, /'--ignore-scripts'/);
  assert.match(source, /if \(manifest\.status === 200\)/);
});

test('lock acquisition uses a bounded iterative retry budget', () => {
  const source = readFileSync(new URL('../scripts/standalone-bootstrap.js', import.meta.url), 'utf8');
  assert.match(source, /const LOCK_ACQUIRE_MAX_ATTEMPTS = 16/);
  assert.match(source, /for \(let attempt = 0; attempt < LOCK_ACQUIRE_MAX_ATTEMPTS; attempt\+\+\)/);
  assert.doesNotMatch(source, /return acquireLock\(p\)/);
});

test('legacy bridge cleans an owned temporary checkout after install failure', () => {
  const home = mkdtempSync(join(tmpdir(), 'triss-legacy-cleanup-'));
  const p = paths({
    HOME: home,
    TRISS_HOME: join(home, 'legacy'),
    TRISS_STANDALONE_HOME: join(home, 'standalone'),
    TRISS_BIN_DIR: join(home, 'bin'),
  });
  const calls = [];
  assert.throws(() => legacyFallback(p, {
    spawn(command, args) {
      calls.push({ command, args });
      if (command === 'git') {
        const target = args.at(-1);
        mkdirSync(join(target, 'bin'), { recursive: true });
        writeFileSync(join(target, 'bin', 'triss.js'), '#!/usr/bin/env node\n');
        return { status: 0 };
      }
      return { status: 1 };
    },
    writeOutput: () => {},
  }), /legacy bridge npm install failed/);
  assert.equal(existsSync(p.legacy), false);
  assert.equal(readdirSync(home).some((name) => name.startsWith('legacy.install-')), false);
  assert.deepEqual(calls, [
    {
      command: 'git',
      args: [
        'clone', '--depth=1', '--single-branch', '--branch', 'main', '--',
        'https://github.com/ayleen/triss-coworker.git', calls[0].args.at(-1),
      ],
    },
    {
      command: 'npm',
      args: ['install', '--omit=dev', '--ignore-scripts', '--silent'],
    },
  ]);
});

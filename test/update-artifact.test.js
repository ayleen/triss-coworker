// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ARTIFACT_FORMAT,
  buildArtifact,
  createArtifact,
  extractArtifact,
  inspectArtifact,
  ARTIFACT_LIMITS,
} from '../src/update/artifact.js';
import { buildStandalone } from '../scripts/build-standalone.js';

function temp(prefix) {
  return mkdtempSync(join(tmpdir(), `triss-${prefix}-`));
}

test('artifact bytes are canonical and deterministic', () => {
  const one = createArtifact({
    version: '0.32.0',
    records: [
      { type: 'file', path: 'src/b.js', mode: 0o644, data: Buffer.from('b') },
      { type: 'file', path: 'src/a.js', mode: 0o644, data: Buffer.from('a') },
    ].map((record) => ({
      ...record,
      size: record.data.length,
      sha256: requireHash(record.data),
      data: record.data.toString('base64'),
    })),
  });
  const two = createArtifact({
    version: '0.32.0',
    records: [
      { type: 'file', path: 'src/a.js', mode: 0o644, data: Buffer.from('a') },
      { type: 'file', path: 'src/b.js', mode: 0o644, data: Buffer.from('b') },
    ].map((record) => ({
      ...record,
      size: record.data.length,
      sha256: requireHash(record.data),
      data: record.data.toString('base64'),
    })),
  });
  assert.deepEqual(one, two);
  assert.equal(inspectArtifact(one).header.format, ARTIFACT_FORMAT);
});

test('artifact canonical path order is UTF-8 byte order', () => {
  const record = (path, data) => ({
    type: 'file', path, mode: 0o644, size: Buffer.byteLength(data),
    sha256: requireHash(Buffer.from(data)), data: Buffer.from(data).toString('base64'),
  });
  const artifact = createArtifact({
    version: '0.32.0',
    records: [record('ä.txt', 'a'), record('z.txt', 'z')],
  });
  assert.deepEqual(inspectArtifact(artifact).records.map((entry) => entry.path), ['z.txt', 'ä.txt']);
});

test('artifact round trip extracts only regular files with exact modes and bytes', () => {
  const source = temp('artifact-source');
  mkdirSync(join(source, 'bin'));
  writeFileSync(join(source, 'bin', 'triss.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  writeFileSync(join(source, 'README.md'), 'hello\n', { mode: 0o644 });
  const archive = buildArtifact({ version: '0.32.0', sourceDir: source });
  const destination = join(temp('artifact-dest'), 'stage');
  const result = extractArtifact(archive, destination);
  assert.equal(result.header.file_count, 2);
  assert.equal(readFileSync(join(destination, 'README.md'), 'utf8'), 'hello\n');
  assert.equal(readFileSync(join(destination, 'bin', 'triss.js'), 'utf8'), '#!/usr/bin/env node\n');
});

test('artifact extraction flushes payloads before directories and surfaces flush failures', () => {
  const record = {
    type: 'file', path: 'bin/triss.js', mode: 0o755, size: 3,
    sha256: requireHash(Buffer.from('ok\n')), data: Buffer.from('ok\n').toString('base64'),
  };
  const archive = createArtifact({ version: '0.32.0', records: [record] });
  const events = [];
  const destination = join(temp('artifact-durable'), 'stage');
  extractArtifact(archive, destination, {
    fsyncFile(_fd, path) { events.push(`file:${path}`); },
    fsyncDirectory(path) { events.push(`dir:${path}`); },
  });
  assert.match(events[0], /file:.*bin\/triss\.js$/);
  assert.ok(events.slice(1).every((event) => event.startsWith('dir:')));
  assert.equal(events.at(-1), `dir:${join(destination, '..')}`);

  const failed = join(temp('artifact-durable-failure'), 'stage');
  assert.throws(() => extractArtifact(archive, failed, {
    fsyncFile() { throw new Error('injected file fsync failure'); },
  }), /injected file fsync failure/);
});

test('artifact rejects traversal, duplicates, overlap, symlink, and special records', () => {
  const bad = (records) => assert.throws(
    () => createArtifact({ version: '0.32.0', records }),
    /Invalid standalone artifact/,
  );
  const record = (path, data = 'x') => ({
    type: 'file', path, mode: 0o644, size: data.length,
    sha256: requireHash(Buffer.from(data)), data: Buffer.from(data).toString('base64'),
  });
  bad([record('../escape')]);
  bad([record('a'), record('a')]);
  bad([record('a'), record('a/b')]);
  bad([record('a'), record('a-foo'), record('a/bar')]);
  bad([{ type: 'symlink', path: 'link' }]);
  const source = temp('artifact-link');
  writeFileSync(join(source, 'actual'), 'x');
  symlinkSync('actual', join(source, 'link'));
  assert.throws(() => buildArtifact({ version: '0.32.0', sourceDir: source }), /symlink/);
});

test('standalone builder bounds source traversal before reading sparse payloads', () => {
  const source = temp('artifact-sparse-source');
  const sparse = join(source, 'unexpected.bin');
  writeFileSync(sparse, '');
  truncateSync(sparse, ARTIFACT_LIMITS.maxExpandedBytes + 1);
  assert.throws(
    () => buildArtifact({ version: '0.32.0', sourceDir: source }),
    /expanded size exceeds/,
  );
});

test('artifact and standalone staging reject special permission bits', () => {
  const source = temp('artifact-special-mode');
  mkdirSync(join(source, 'src'));
  writeFileSync(join(source, 'package.json'), '{"name":"triss-coworker","version":"0.32.0"}\n');
  const file = join(source, 'src', 'app.js');
  writeFileSync(file, 'ok\n', { mode: 0o644 });
  chmodSync(file, 0o644 | 0o1000);
  assert.notEqual(lstatSync(file).mode & 0o7000, 0, 'fixture must retain a special permission bit');
  assert.throws(() => buildArtifact({ version: '0.32.0', sourceDir: source }), /special permission bits/);
  const stage = join(temp('artifact-special-stage'), 'stage');
  assert.throws(() => buildStandalone({ sourceDir: source, stageDir: stage, version: '0.32.0' }), /special permission bits/);
  assert.equal(existsSync(stage), false);
});

test('standalone staging ignores the workspace companion symlink', () => {
  const source = temp('artifact-companion-symlink');
  mkdirSync(join(source, 'node_modules'), { recursive: true });
  writeFileSync(join(source, 'package.json'), '{"name":"triss-coworker","version":"0.35.0"}\n');
  symlinkSync('../../packages/dsh-provider-bundle', join(source, 'node_modules', 'triss-dsh-provider-bundle'));
  const stage = join(temp('artifact-companion-stage'), 'stage');
  buildStandalone({ sourceDir: source, stageDir: stage, version: '0.35.0' });
  assert.equal(existsSync(join(stage, 'node_modules', 'triss-dsh-provider-bundle')), false,
    'the companion is a workspace dev-surface, never a standalone runtime dependency');
  // The registry install path (real directory, not symlink) still stages.
  const registry = temp('artifact-companion-real');
  mkdirSync(join(registry, 'node_modules', 'triss-dsh-provider-bundle'), { recursive: true });
  writeFileSync(join(registry, 'package.json'), '{"name":"triss-coworker","version":"0.35.0"}\n');
  writeFileSync(join(registry, 'node_modules', 'triss-dsh-provider-bundle', 'package.json'), '{"name":"triss-dsh-provider-bundle"}\n');
  const stage2 = join(temp('artifact-companion-real-stage'), 'stage');
  buildStandalone({ sourceDir: registry, stageDir: stage2, version: '0.35.0' });
  assert.equal(existsSync(join(stage2, 'node_modules', 'triss-dsh-provider-bundle', 'package.json')), true);
});

test('standalone staging ships only public docs and the third-party notice', () => {
  const source = temp('artifact-public-docs');
  mkdirSync(join(source, 'docs', 'integrations'), { recursive: true });
  mkdirSync(join(source, 'docs', 'promo'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({
    name: 'triss-coworker',
    version: '0.37.1',
    files: [
      'docs/configuration.md',
      'docs/new-public.md',
      'docs/integrations/',
    ],
  }));
  writeFileSync(join(source, 'THIRD_PARTY_NOTICES'), 'notices\n');
  writeFileSync(join(source, 'docs', 'configuration.md'), 'public\n');
  writeFileSync(join(source, 'docs', 'new-public.md'), 'newly allowlisted public doc\n');
  writeFileSync(join(source, 'docs', 'integrations', 'github.md'), 'public integration\n');
  writeFileSync(join(source, 'docs', 'internal-plan.md'), 'internal\n');
  writeFileSync(join(source, 'docs', 'promo', 'launch.md'), 'promo\n');

  const stage = join(temp('artifact-public-docs-stage'), 'stage');
  buildStandalone({ sourceDir: source, stageDir: stage, version: '0.37.1' });

  assert.equal(existsSync(join(stage, 'THIRD_PARTY_NOTICES')), true);
  assert.equal(existsSync(join(stage, 'docs', 'configuration.md')), true);
  assert.equal(existsSync(join(stage, 'docs', 'new-public.md')), true,
    'standalone docs must follow the source package.json files allowlist');
  assert.equal(existsSync(join(stage, 'docs', 'integrations', 'github.md')), true);
  assert.equal(existsSync(join(stage, 'docs', 'internal-plan.md')), false);
  assert.equal(existsSync(join(stage, 'docs', 'promo')), false);
});

test('standalone docs policy accepts npm directory entries without a trailing slash', () => {
  const source = temp('artifact-public-doc-directory');
  mkdirSync(join(source, 'docs', 'engines'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({
    name: 'triss-coworker',
    version: '0.37.1',
    files: ['docs/engines'],
  }));
  writeFileSync(join(source, 'docs', 'engines', 'public.md'), 'public\n');

  const stage = join(temp('artifact-public-doc-directory-stage'), 'stage');
  buildStandalone({ sourceDir: source, stageDir: stage, version: '0.37.1' });
  assert.equal(existsSync(join(stage, 'docs', 'engines', 'public.md')), true);
});

test('standalone docs policy fails closed when package.json has no files allowlist', () => {
  const source = temp('artifact-public-doc-missing-policy');
  mkdirSync(join(source, 'docs'));
  writeFileSync(join(source, 'package.json'), '{"name":"triss-coworker","version":"0.37.1"}\n');
  writeFileSync(join(source, 'docs', 'public.md'), 'public\n');

  const stage = join(temp('artifact-public-doc-missing-policy-stage'), 'stage');
  assert.throws(
    () => buildStandalone({ sourceDir: source, stageDir: stage, version: '0.37.1' }),
    /package\.json files must declare the public docs/,
  );
  assert.equal(existsSync(stage), false);
});

test('standalone builder reports directory depth violations before generic path validation', () => {
  const source = temp('artifact-deep-source');
  let current = source;
  for (let index = 0; index <= ARTIFACT_LIMITS.maxDepth; index++) {
    current = join(current, `d${index}`);
    mkdirSync(current);
  }
  assert.throws(
    () => buildArtifact({ version: '0.32.0', sourceDir: source }),
    /directory depth exceeds 64/,
  );
});

test('standalone staging bounds deep trees before copying and cleans partial output', () => {
  const source = temp('artifact-stage-deep-source');
  const stage = join(temp('artifact-stage-deep-target'), 'stage');
  writeFileSync(join(source, 'package.json'), '{"version":"0.32.0"}\n');
  mkdirSync(join(source, 'src'));
  let current = join(source, 'src');
  for (let index = 0; index <= ARTIFACT_LIMITS.maxDepth; index++) {
    current = join(current, `d${index}`);
    mkdirSync(current);
  }
  assert.throws(
    () => buildStandalone({ sourceDir: source, stageDir: stage, version: '0.32.0' }),
    /directory depth exceeds 64/,
  );
  assert.equal(existsSync(stage), false);
});

test('artifact refuses non-empty staging roots and corrupted records', () => {
  const archive = createArtifact({ version: '0.32.0', records: [] });
  const destination = temp('artifact-existing');
  writeFileSync(join(destination, 'owned'), 'do not touch');
  assert.throws(() => extractArtifact(archive, destination), /staging root must be empty/);
  const corrupted = Buffer.from(archive);
  corrupted[corrupted.length - 1] ^= 1;
  assert.throws(() => extractArtifact(corrupted, join(temp('artifact-corrupt'), 'stage')),
    /Invalid standalone artifact/);
});

test('artifact path inputs are bounded before allocation and reject symlinks', () => {
  const parent = temp('artifact-path-input');
  const sparse = join(parent, 'oversized.gz');
  writeFileSync(sparse, '');
  truncateSync(sparse, ARTIFACT_LIMITS.maxCompressedBytes + 1);
  assert.throws(() => inspectArtifact(sparse), /compressed artifact exceeds/);
  assert.throws(() => extractArtifact(sparse, join(parent, 'stage')), /compressed artifact exceeds/);

  const outside = join(parent, 'outside.gz');
  writeFileSync(outside, 'not an artifact');
  const alias = join(parent, 'alias.gz');
  symlinkSync(outside, alias);
  assert.throws(() => inspectArtifact(alias), /artifact input|symbolic|symlink|levels/i);
});

test('standalone build rejects platform-constrained production dependencies', () => {
  const root = temp('platform-constraint');
  mkdirSync(join(root, 'node_modules', 'platform-only'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"triss-coworker","version":"0.32.0"}');
  writeFileSync(
    join(root, 'node_modules', 'platform-only', 'package.json'),
    '{"name":"platform-only","os":["linux"]}',
  );
  assert.throws(
    () => buildStandalone({ sourceDir: root, version: '0.32.0' }),
    /package constraints/,
  );
});

test('standalone builder resolves real paths before staging or writing output', () => {
  const source = temp('builder-path-safety');
  writeFileSync(join(source, 'package.json'), '{"name":"triss-coworker","version":"0.32.0"}\n');

  const sourceAlias = join(temp('builder-stage-alias'), 'source');
  symlinkSync(source, sourceAlias);
  assert.throws(
    () => buildStandalone({ sourceDir: source, stageDir: join(sourceAlias, 'stage'), version: '0.32.0' }),
    /overlap/,
  );
  assert.equal(existsSync(join(source, 'stage')), false);

  const output = join(temp('builder-output'), 'triss.gz');
  const outputAlias = join(temp('builder-output-alias'), 'package.json');
  symlinkSync(join(source, 'package.json'), outputAlias);
  assert.throws(
    () => buildStandalone({ sourceDir: source, outputPath: outputAlias, version: '0.32.0' }),
    /outputPath.*symlink/,
  );
  assert.equal(readFileSync(join(source, 'package.json'), 'utf8'), '{"name":"triss-coworker","version":"0.32.0"}\n');

  const metadataAlias = `${output}.integrity.json`;
  symlinkSync(join(source, 'package.json'), metadataAlias);
  assert.throws(
    () => buildStandalone({ sourceDir: source, outputPath: output, version: '0.32.0' }),
    /output metadata path.*symlink/,
  );
});

test('builder rejects an NDJSON envelope the extractor would reject', () => {
  const payload = Buffer.alloc(5 * 1024 * 1024, 0x5a);
  const records = Array.from({ length: 10 }, (_, index) => ({
    type: 'file',
    path: `payload/${index}.bin`,
    mode: 0o644,
    size: payload.length,
    sha256: requireHash(payload),
    data: payload,
  }));
  assert.throws(
    () => createArtifact({ version: '0.32.0', records }),
    /expanded artifact envelope|bounded input limit/,
  );
});

function requireHash(value) {
  // Keep the fixture independent of the implementation's private helpers.
  return createHash('sha256').update(value).digest('hex');
}

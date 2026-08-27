import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { buildStandalone } from '../scripts/build-standalone.js';
import { inspectArtifact } from '../src/update/artifact.js';
import {
  buildTwice,
  copyCleanSource,
  ensureRelease,
  promotionIncidentBody,
  promotionOutcome,
  recoverPromotion,
  persistPromotionState,
  loadPromotionState,
  clearPromotionState,
  promotionStateMarker,
  releaseAction,
  releaseStatus,
  snapshotLatest,
  smokeArtifact,
  verifyAnonymous,
  verifyArtifact,
  writeChecksum,
  writeManifest,
} from '../scripts/release-gates.js';

function temp(prefix) {
  return mkdtempSync(join(tmpdir(), `triss-release-${prefix}-`));
}

test('publish workflow fetches main into the remote-tracking ref used by the gate', () => {
  const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  assert.match(
    workflow,
    /git fetch --no-tags origin \\\n\s+'\+refs\/heads\/main:refs\/remotes\/origin\/main'/,
  );
  assert.match(workflow, /refs\/remotes\/origin\/main\^\{commit\}/);
});

test('publish workflow builds one canonical artifact and smokes only downloaded bytes', () => {
  const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
  assert.match(workflow, /NPM_VERSION:\s*['"]11\.6\.2['"]/);
  assert.match(workflow, /standalone-build:/);
  assert.match(workflow, /standalone-smoke:/);
  assert.match(workflow, /node:\s*\['22', '24'\]/);
  assert.match(workflow, /os:\s*\[ubuntu-latest, macos-latest\]/);
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a[\s\S]*name: standalone-canonical/);
  assert.match(workflow, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c[\s\S]*name: standalone-canonical/);
  assert.match(workflow, /verify-artifact[\s\S]*--checksum/);

  const smoke = workflow.slice(workflow.indexOf('  standalone-smoke:'));
  const release = workflow.slice(workflow.indexOf('  release:'));
  assert.doesNotMatch(smoke.slice(0, smoke.indexOf('\n  npm-publish:')), /build-twice/);
  assert.match(release, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c[\s\S]*name: standalone-canonical/);
  assert.doesNotMatch(release, /build-twice/);
  assert.match(release, /release-gates\.js ensure-release/);
  assert.match(release, /release-gates\.js release-status/);
  assert.match(release, /release-gates\.js release-action[\s\S]*--snapshot dist\/previous-latest\.json/);
  assert.match(release, /release-action[\s\S]*release-status[\s\S]*is_latest[\s\S]*recover-promotion/);
  assert.match(release, /release-gates\.js promotion-outcome[\s\S]*promotion_outcome/);
  assert.match(release, /is_latest[\s\S]*verify_status[\s\S]*recover-promotion[\s\S]*--load/);
  assert.match(release, /promotion_phase[\s\S]*incident_pending[\s\S]*recover-promotion[\s\S]*--load[\s\S]*is_latest/);
  assert.doesNotMatch(release, /gh release upload[\s\S]*--clobber/);
});

test('PR workflow smokes the same canonical artifact on min/max Node and macOS', () => {
  const workflow = readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf8');
  assert.match(workflow, /NPM_VERSION:\s*['"]11\.6\.2['"]/);
  assert.match(workflow, /standalone-build:/);
  assert.match(workflow, /standalone-smoke:/);
  assert.match(workflow, /os:\s*\[ubuntu-latest, macos-latest\]/);
  assert.match(workflow, /node:\s*\['22', '24'\]/);
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a[\s\S]*name: standalone-canonical/);
  const smoke = workflow.slice(workflow.indexOf('  standalone-smoke:'));
  assert.doesNotMatch(smoke, /build-twice/);
  assert.match(smoke, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c[\s\S]*name: standalone-canonical/);
  assert.match(smoke, /verify-artifact[\s\S]*--checksum/);
});

test('release smoke proves canonical installation works without package tools', async () => {
  const source = temp('source');
  mkdirSync(join(source, 'bin'), { recursive: true });
  mkdirSync(join(source, 'src', 'integrations'), { recursive: true });
  mkdirSync(join(source, 'src', 'mcp'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'triss-coworker', version: '0.32.0' }));
  const launcher = join(source, 'bin', 'triss.js');
  writeFileSync(launcher, [
    '#!/usr/bin/env node',
    'if (process.argv.includes("--version")) console.log("0.32.0");',
    'else if (process.argv.includes("status")) console.log("status: standalone smoke");',
    'else console.log("Usage: triss [options]");',
  ].join('\n'));
  chmodSync(launcher, 0o755);
  writeFileSync(join(source, 'src', 'integrations', '_registry.js'), 'export const registry = [];\n');
  writeFileSync(join(source, 'src', 'mcp', 'server.js'), 'export const runServer = () => {};\n');
  writeFileSync(join(source, 'src', 'mcp', 'tools.js'), 'export const listTools = async () => [{ name: "smoke" }];\n');
  const artifact = join(temp('output'), 'triss.ndjson.gz');
  buildStandalone({ sourceDir: source, outputPath: artifact, version: '0.32.0' });
  assert.deepEqual(await smokeArtifact(artifact), {
    version: '0.32.0', file_count: 5, installation_verified: true,
  });
});

test('release smoke fails closed when artifact launcher is missing', async () => {
  const source = temp('missing-launcher');
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'triss-coworker', version: '0.32.0' }));
  const artifact = join(temp('missing-output'), 'triss.ndjson.gz');
  buildStandalone({ sourceDir: source, outputPath: artifact, version: '0.32.0' });
  await assert.rejects(() => smokeArtifact(artifact), /does not contain bin\/triss\.js/);
});

test('release smoke executes the public launcher and rejects a non-executable mode', async () => {
  const source = temp('non-executable-launcher');
  mkdirSync(join(source, 'bin'), { recursive: true });
  mkdirSync(join(source, 'src', 'integrations'), { recursive: true });
  mkdirSync(join(source, 'src', 'mcp'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'triss-coworker', version: '0.32.0' }));
  writeFileSync(join(source, 'bin', 'triss.js'), [
    '#!/usr/bin/env node',
    'if (process.argv.includes("--version")) console.log("0.32.0");',
    'else if (process.argv.includes("status")) console.log("status: standalone smoke");',
    'else console.log("Usage: triss [options]");',
  ].join('\n'), { mode: 0o644 });
  writeFileSync(join(source, 'src', 'integrations', '_registry.js'), 'export const registry = [];\n');
  writeFileSync(join(source, 'src', 'mcp', 'server.js'), 'export const runServer = () => {};\n');
  writeFileSync(join(source, 'src', 'mcp', 'tools.js'), 'export const listTools = async () => [{ name: "smoke" }];\n');
  const artifact = join(temp('non-executable-output'), 'triss.ndjson.gz');
  buildStandalone({ sourceDir: source, outputPath: artifact, version: '0.32.0' });
  await assert.rejects(
    () => smokeArtifact(artifact),
    /EACCES|permission denied|failed/i,
  );
});

test('smoke output does not mutate the published artifact', async () => {
  const source = temp('immutable-source');
  mkdirSync(join(source, 'bin'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'triss-coworker', version: '0.32.0' }));
  writeFileSync(join(source, 'bin', 'triss.js'),
    '#!/usr/bin/env node\nif (process.argv.includes("--version")) console.log("0.32.0");\nelse if (process.argv.includes("status")) console.log("status: smoke");\nelse console.log("Usage: test");\n',
    { mode: 0o755 });
  const artifact = join(temp('immutable-output'), 'triss.ndjson.gz');
  buildStandalone({ sourceDir: source, outputPath: artifact, version: '0.32.0' });
  const before = readFileSync(artifact);
  await assert.rejects(() => smokeArtifact(artifact), /integrations/);
  assert.deepEqual(readFileSync(artifact), before);
});

test('direct standalone builds stage a fresh filtered tree and clean it up', () => {
  const source = temp('direct-stage');
  mkdirSync(join(source, 'bin'), { recursive: true });
  mkdirSync(join(source, 'test'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'triss-coworker', version: '0.32.0' }));
  writeFileSync(join(source, 'bin', 'triss.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  writeFileSync(join(source, '.env'), 'DO_NOT_PUBLISH=1\n');
  writeFileSync(join(source, 'test', 'secret.js'), 'DO_NOT_PUBLISH=1\n');
  const result = buildStandalone({ sourceDir: source, version: '0.32.0' });
  const paths = inspectArtifact(result.bytes).records.map((record) => record.path);
  assert.deepEqual(paths, ['bin/triss.js', 'package.json']);
  assert.equal(existsSync(result.stageDir), false);
});

test('standalone builder preserves caller paths and rejects output overlap', () => {
  const source = temp('builder-paths');
  mkdirSync(join(source, 'bin'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({
    name: 'triss-coworker', version: '0.32.0',
  }));
  writeFileSync(join(source, 'bin', 'triss.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  const stage = temp('caller-stage');
  const sentinel = join(stage, 'sentinel');
  writeFileSync(sentinel, 'preserve');
  assert.throws(
    () => buildStandalone({ sourceDir: source, stageDir: stage, version: '0.32.0' }),
    /must not already exist/,
  );
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve');
  const packageBefore = readFileSync(join(source, 'package.json'));
  assert.throws(
    () => buildStandalone({
      sourceDir: source, outputPath: join(source, 'package.json'), version: '0.32.0',
    }),
    /outputPath cannot overlap/,
  );
  assert.deepEqual(readFileSync(join(source, 'package.json')), packageBefore);
});

test('build-twice validates caller paths before deleting or writing anything', () => {
  const root = temp('build-twice-paths');
  const work = join(root, 'work');
  const sentinel = join(work, 'clean-1', 'user-data.txt');
  mkdirSync(join(work, 'clean-1'), { recursive: true });
  writeFileSync(sentinel, 'preserve');
  assert.throws(
    () => buildTwice({ sourceDir: join(root, 'missing'), workDir: work, version: '0.32.0' }),
    /source must be a real directory/,
  );
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve');

  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, 'package.json'), JSON.stringify({
    name: 'triss-coworker', version: '0.32.0',
  }));
  assert.throws(
    () => buildTwice({
      sourceDir: source,
      workDir: join(root, 'fresh-work'),
      outputPath: join(source, 'package.json'),
      version: '0.32.0',
    }),
    /output path must not overlap source/,
  );
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')));
  assert.equal(existsSync(join(root, 'fresh-work')), false);
});

test('release clean copy excludes only .git and node_modules path segments', () => {
  const root = temp('clean-copy');
  const source = join(root, 'source');
  const target = join(root, 'target');
  for (const path of ['.git', '.github', 'nested/node_modules', 'nested/keep']) {
    mkdirSync(join(source, path), { recursive: true });
  }
  writeFileSync(join(source, '.git', 'config'), 'exclude');
  writeFileSync(join(source, '.github', 'workflow.yml'), 'preserve');
  writeFileSync(join(source, '.gitignore'), 'preserve');
  writeFileSync(join(source, '.gitattributes'), 'preserve');
  writeFileSync(join(source, 'nested', 'node_modules', 'dependency'), 'exclude');
  writeFileSync(join(source, 'nested', 'keep', 'file'), 'preserve');
  copyCleanSource(source, target);
  assert.equal(existsSync(join(target, '.git')), false);
  assert.equal(existsSync(join(target, 'nested', 'node_modules')), false);
  assert.equal(readFileSync(join(target, '.github', 'workflow.yml'), 'utf8'), 'preserve');
  assert.equal(readFileSync(join(target, '.gitignore'), 'utf8'), 'preserve');
  assert.equal(readFileSync(join(target, '.gitattributes'), 'utf8'), 'preserve');
  assert.equal(readFileSync(join(target, 'nested', 'keep', 'file'), 'utf8'), 'preserve');
});

test('release metadata uses tag-specific asset names and a Node-generated checksum', () => {
  const root = temp('metadata');
  const artifact = join(root, 'triss-coworker-0.32.0-standalone.ndjson.gz');
  writeFileSync(artifact, 'artifact bytes');
  writeFileSync(`${artifact}.metadata.json`, JSON.stringify({
    version: '0.32.0', expanded_size: 14, file_count: 7,
  }));
  const checksum = join(root, 'artifact.sha256');
  const manifest = join(root, 'update-manifest.json');
  const checksumResult = writeChecksum({ artifact, output: checksum });
  const manifestResult = writeManifest({
    artifact,
    output: manifest,
    'artifact-name': 'triss-coworker-0.32.0-standalone.ndjson.gz',
    tag: 'v0.32.0',
    version: '0.32.0',
  });
  assert.match(readFileSync(checksum, 'utf8'), new RegExp(checksumResult.sha256));
  assert.equal(manifestResult.artifact.url.endsWith('/v0.32.0/triss-coworker-0.32.0-standalone.ndjson.gz'), true);
});

test('manifest generation is byte-identical when the canonical tag timestamp is supplied', () => {
  const root = temp('manifest-deterministic');
  const artifact = join(root, 'triss-coworker-0.32.0-standalone.ndjson.gz');
  writeFileSync(artifact, 'artifact bytes');
  writeFileSync(`${artifact}.metadata.json`, JSON.stringify({ version: '0.32.0', expanded_size: 14, file_count: 7 }));
  const base = {
    artifact, 'artifact-name': basename(artifact), tag: 'v0.32.0', version: '0.32.0',
    'published-at': '2026-08-12T12:00:00.000Z',
  };
  const first = join(root, 'one.json');
  const second = join(root, 'two.json');
  writeManifest({ ...base, output: first });
  writeManifest({ ...base, output: second });
  assert.deepEqual(readFileSync(first), readFileSync(second));
  assert.throws(() => writeManifest({ ...base, output: join(root, 'bad.json'), 'published-at': '2026-08-12T12:00:00Z' }), /canonical ISO/);
});

test('canonical artifact verification binds bytes, metadata, and checksum', () => {
  const root = temp('canonical-verify');
  const artifact = join(root, 'standalone.ndjson.gz');
  const checksum = join(root, 'standalone.sha256');
  const metadata = join(root, 'standalone.ndjson.gz.metadata.json');
  const bytes = Buffer.from('canonical artifact bytes');
  writeFileSync(artifact, bytes);
  writeFileSync(metadata, JSON.stringify({
    schema_version: 1,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    artifact_size: bytes.length,
  }));
  writeChecksum({ artifact, output: checksum });
  assert.deepEqual(verifyArtifact({ artifact, metadata, checksum }), {
    artifact,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  });
  writeFileSync(artifact, Buffer.from('rebuilt artifact bytes'));
  assert.throws(
    () => verifyArtifact({ artifact, metadata, checksum }),
    /canonical metadata checksum/,
  );
});

test('anonymous verification retries the complete transaction on stale metadata and bytes', async () => {
  const root = temp('anonymous-retry');
  const source = temp('anonymous-source');
  mkdirSync(join(source, 'bin'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'triss-coworker', version: '0.32.0' }));
  writeFileSync(join(source, 'bin', 'triss.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
  const artifact = join(root, 'triss-coworker-0.32.0-standalone.ndjson.gz');
  const build = buildStandalone({ sourceDir: source, outputPath: artifact, version: '0.32.0' });
  writeFileSync(`${artifact}.metadata.json`, JSON.stringify(build.metadata));
  const checksum = join(root, 'triss-coworker-0.32.0-standalone.sha256');
  const manifest = join(root, 'update-manifest.json');
  writeChecksum({ artifact, output: checksum });
  writeManifest({ artifact, output: manifest, 'artifact-name': 'triss-coworker-0.32.0-standalone.ndjson.gz', tag: 'v0.32.0', version: '0.32.0' });
  const local = {
    artifact: readFileSync(artifact), checksum: readFileSync(checksum), manifest: readFileSync(manifest),
  };
  let metadataCalls = 0;
  let currentAttempt = 0;
  const downloaded = [];
  const sleeps = [];
  const github = async (_path, requestOptions = {}) => {
    assert.equal(requestOptions.token, undefined);
    currentAttempt = ++metadataCalls;
    return { draft: false, prerelease: false, tag_name: currentAttempt === 1 ? 'v0.31.0' : 'v0.32.0' };
  };
  const boundedFetch = async (url) => {
    const name = url.split('/').at(-1);
    downloaded.push(`${currentAttempt}:${url}`);
    const stale = currentAttempt === 2 && name === 'triss-coworker-0.32.0-standalone.ndjson.gz';
    return { response: { ok: true, status: 200 }, bytes: stale ? Buffer.from('stale bytes') : local[
      name.endsWith('.sha256') ? 'checksum' : name === 'update-manifest.json' ? 'manifest' : 'artifact'] };
  };
  const result = await verifyAnonymous({ tag: 'v0.32.0', artifact, checksum, manifest }, false, {
    github, boundedFetch, maxAttempts: 3, sleep: async (milliseconds) => sleeps.push(milliseconds),
  });
  assert.equal(result.tag_name, 'v0.32.0');
  assert.equal(metadataCalls, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.deepEqual(downloaded, [
    '2:https://github.com/ayleen/triss-coworker/releases/download/v0.32.0/triss-coworker-0.32.0-standalone.ndjson.gz',
    '3:https://github.com/ayleen/triss-coworker/releases/download/v0.32.0/triss-coworker-0.32.0-standalone.ndjson.gz',
    '3:https://github.com/ayleen/triss-coworker/releases/download/v0.32.0/triss-coworker-0.32.0-standalone.sha256',
    '3:https://github.com/ayleen/triss-coworker/releases/download/v0.32.0/update-manifest.json',
  ]);

  const latestUrls = [];
  await verifyAnonymous({ tag: 'v0.32.0', artifact, checksum, manifest }, true, {
    github: async (path) => {
      assert.equal(path, '/releases/latest');
      return { draft: false, prerelease: false, tag_name: 'v0.32.0' };
    },
    boundedFetch: async (url) => {
      latestUrls.push(url);
      const name = url.split('/').at(-1);
      return {
        response: { ok: true, status: 200 },
        bytes: local[name.endsWith('.sha256') ? 'checksum' : name === 'update-manifest.json' ? 'manifest' : 'artifact'],
      };
    },
  });
  assert.deepEqual(latestUrls, [
    'https://github.com/ayleen/triss-coworker/releases/latest/download/triss-coworker-0.32.0-standalone.ndjson.gz',
    'https://github.com/ayleen/triss-coworker/releases/latest/download/triss-coworker-0.32.0-standalone.sha256',
    'https://github.com/ayleen/triss-coworker/releases/latest/download/update-manifest.json',
  ]);
});

test('first standalone release snapshots a previous latest without standalone assets', async () => {
  const root = temp('first-standalone-snapshot');
  const output = join(root, 'previous.json');
  const result = await snapshotLatest({
    tag: 'v0.33.0', output, token: 'test-token',
  }, {
    github: async (path) => path === '/releases/latest'
      ? { tag_name: 'v0.32.0', id: 32, assets: [] }
      : { tag_name: 'v0.33.0', id: 33, body: 'notes', assets: [] },
    boundedFetch: async () => assert.fail('legacy previous latest has no manifest to fetch'),
  });
  assert.equal(result.previous_tag, 'v0.32.0');
  assert.equal(result.asset_names, null);
  assert.equal(result.manifest_sha256, null);
  assert.deepEqual(Object.keys(result).sort(), [
    'asset_names', 'captured_at', 'manifest_sha256', 'phase', 'previous_release_id', 'previous_tag',
    'schema_version',
  ]);
  assert.equal('failed_tag' in result, false);
  assert.deepEqual(JSON.parse(readFileSync(output)), result);
});

test('promotion state persists in the authenticated candidate body and reloads on rerun', async () => {
  const root = temp('promotion-body-state');
  const output = join(root, 'previous.json');
  let candidate = { id: 33, tag_name: 'v0.33.0', body: 'release notes', draft: false, prerelease: false, assets: [] };
  let latest = { id: 32, tag_name: 'v0.32.0', assets: [] };
  const calls = [];
  const github = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/releases/latest') return latest;
    if (path === '/releases/tags/v0.33.0') return candidate;
    if (path === '/releases/33' && options.method === 'PATCH') {
      candidate = { ...candidate, ...options.body };
      return candidate;
    }
    throw new Error(`unexpected github call ${path}`);
  };
  const first = await snapshotLatest({ tag: 'v0.33.0', output, token: 'test-token', persist: true }, { github });
  assert.equal(first.previous_tag, 'v0.32.0');
  latest = { id: 33, tag_name: 'v0.33.0', assets: [] };
  const rerunOutput = join(root, 'rerun.json');
  const second = await snapshotLatest({ tag: 'v0.33.0', output: rerunOutput, token: 'test-token' }, { github });
  assert.deepEqual(second, first);
  assert.deepEqual(JSON.parse(readFileSync(rerunOutput)), first);
  await loadPromotionState({ tag: 'v0.33.0', output: join(root, 'loaded.json'), token: 'test-token' }, { github });
  await clearPromotionState({ tag: 'v0.33.0', token: 'test-token' }, { github });
  assert.doesNotMatch(candidate.body, /triss-previous-latest/);
  assert.equal(calls.filter((call) => call.path === '/releases/33' && call.options.method === 'PATCH').length, 2);
});

test('clear promotion state rejects a malformed single marker without PATCH', async () => {
  let patches = 0;
  await assert.rejects(
    () => clearPromotionState({ tag: 'v0.33.0', token: 'test-token' }, {
      github: async (path, options = {}) => {
        if (path === '/releases/tags/v0.33.0') return {
          id: 33, tag_name: 'v0.33.0', body: 'notes\n<!-- triss-previous-latest:v1:not-base64! -->',
        };
        if (options.method === 'PATCH') patches++;
        return {};
      },
    }),
    /invalid|canonical|snapshot|schema/,
  );
  assert.equal(patches, 0);
});

test('clear promotion state removes exactly one canonical marker', async () => {
  const snapshot = {
    schema_version: 1, previous_tag: 'v0.32.0', previous_release_id: 32,
    asset_names: null, manifest_sha256: null, captured_at: '2026-08-12T00:00:00.000Z',
  };
  let patchedBody;
  await clearPromotionState({ tag: 'v0.33.0', token: 'test-token' }, {
    github: async (path, options = {}) => {
      if (path === '/releases/tags/v0.33.0') return {
        id: 33, tag_name: 'v0.33.0', body: `notes\n\n${promotionStateMarker(snapshot)}\n`,
      };
      patchedBody = options.body.body;
      return {};
    },
  });
  assert.equal(patchedBody, 'notes');
  assert.doesNotMatch(patchedBody, /triss-previous-latest/);
});

test('every promotion-state consumer fails closed on truncated, unknown, nested, or duplicate markers', async () => {
  const valid = promotionStateMarker({
    schema_version: 2,
    previous_tag: 'v0.32.0',
    previous_release_id: 32,
    asset_names: null,
    manifest_sha256: null,
    captured_at: '2026-08-12T00:00:00.000Z',
  });
  const bodies = [
    '<!-- triss-previous-latest:v2:truncated',
    '<!-- triss-previous-latest:v99:unknown -->',
    '<!-- triss-previous-latest:v2:nested <!-- triss-previous-latest:v2:x -->',
    `${valid}\n${valid}`,
  ];
  for (const body of bodies) {
    let patches = 0;
    const github = async (path, options = {}) => {
      if (path === '/releases/tags/v0.33.0') {
        return { id: 33, tag_name: 'v0.33.0', body, assets: [] };
      }
      if (path === '/releases/latest') return { id: 32, tag_name: 'v0.32.0', assets: [] };
      if (options.method === 'PATCH') patches++;
      return {};
    };
    await assert.rejects(
      () => releaseStatus({ tag: 'v0.33.0', token: 'test-token' }, { github }),
      /invalid|canonical|ambiguous|schema|missing/,
    );
    await assert.rejects(
      () => clearPromotionState({ tag: 'v0.33.0', token: 'test-token' }, { github }),
      /invalid|canonical|ambiguous|schema|missing/,
    );
    await assert.rejects(
      () => persistPromotionState({
        tag: 'v0.33.0', token: 'test-token', snapshot: JSON.parse(JSON.stringify({
          schema_version: 2, previous_tag: 'v0.32.0', previous_release_id: 32,
          asset_names: null, manifest_sha256: null, captured_at: '2026-08-12T00:00:00.000Z',
        })),
      }, { github }),
      /invalid|canonical|ambiguous|schema|missing/,
    );
    await assert.rejects(
      () => snapshotLatest({ tag: 'v0.33.0', output: join(temp('marker-corruption'), 'state.json'), token: 'test-token' }, { github }),
      /invalid|canonical|ambiguous|schema|missing/,
    );
    assert.equal(patches, 0);
  }
});

test('snapshot rerun resumes the exact marker after a lost PATCH response', async () => {
  const root = temp('snapshot-lost-patch');
  const output = join(root, 'previous.json');
  const snapshot = {
    schema_version: 1, previous_tag: 'v0.32.0', previous_release_id: 32,
    asset_names: null, manifest_sha256: null, captured_at: '2026-08-12T00:00:00.000Z',
  };
  let candidate = { id: 33, tag_name: 'v0.33.0', body: 'notes', assets: [] };
  let patchAttempts = 0;
  const github = async (path, options = {}) => {
    if (path === '/releases/tags/v0.33.0') return candidate;
    if (path === '/releases/latest') return { id: 32, tag_name: 'v0.32.0', assets: [] };
    if (path === '/releases/33' && options.method === 'PATCH') {
      patchAttempts++;
      candidate = { ...candidate, body: options.body.body };
      if (patchAttempts === 1) throw new Error('response lost after commit');
      return candidate;
    }
    throw new Error(`unexpected ${path}`);
  };
  await assert.rejects(
    () => persistPromotionState({ tag: 'v0.33.0', snapshot, token: 'test-token' }, { github }),
    /response lost/,
  );
  const result = await snapshotLatest({ tag: 'v0.33.0', output, token: 'test-token' }, { github });
  assert.equal(result.previous_release_id, 32);
  assert.equal(result.captured_at, snapshot.captured_at);
  assert.equal(patchAttempts, 1);
  assert.deepEqual(JSON.parse(readFileSync(output)), result);
});

test('snapshot marker refuses a changed current latest without mutation', async () => {
  const root = temp('snapshot-marker-cas');
  const snapshot = {
    schema_version: 1, previous_tag: 'v0.32.0', previous_release_id: 32,
    asset_names: null, manifest_sha256: null, captured_at: '2026-08-12T00:00:00.000Z',
  };
  const candidate = { id: 33, tag_name: 'v0.33.0', body: `notes\n${promotionStateMarker(snapshot)}`, assets: [] };
  const calls = [];
  await assert.rejects(
    () => snapshotLatest({ tag: 'v0.33.0', output: join(root, 'state.json'), token: 'test-token' }, {
      github: async (path, options = {}) => {
        calls.push({ path, options });
        if (path === '/releases/tags/v0.33.0') return candidate;
        if (path === '/releases/latest') return { id: 34, tag_name: 'v0.34.0', assets: [] };
        return assert.fail(`unexpected mutation ${path}`);
      },
    }),
    /does not match current latest|newer than previous/,
  );
  assert.equal(calls.some((call) => call.options.method === 'PATCH'), false);
});

test('rerun recovery loads persisted state when candidate is already latest', async () => {
  const root = temp('promotion-rerun-recovery');
  const snapshot = {
    schema_version: 1, previous_tag: 'v0.32.0', previous_release_id: 32,
    asset_names: null, manifest_sha256: null, captured_at: '2026-08-12T00:00:00.000Z',
  };
  let candidate = {
    id: 33, tag_name: 'v0.33.0', body: `notes\n\n${promotionStateMarker(snapshot)}`,
  };
  const calls = [];
  const github = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/releases/tags/v0.33.0') return candidate;
    if (path === '/releases/latest') return { id: 32, tag_name: 'v0.32.0' };
    if (path === '/releases/33' && options.method === 'PATCH') {
      candidate = { ...candidate, ...options.body };
      return candidate;
    }
    throw new Error(`unexpected ${path}`);
  };
  const state = join(root, 'state.json');
  writeFileSync(state, JSON.stringify(snapshot));
  const result = await recoverPromotion({ tag: 'v0.33.0', state, token: 'test-token' }, {
    github,
    verifyAnonymous: async () => {},
  });
  assert.equal(result.recovered, true);
  assert.equal(calls.some((call) => call.path === '/releases/33' && call.options.body?.body), true);
});

test('promotion recovery retries a stale latest alias after demotion', async () => {
  const root = temp('promotion-recovery-retry');
  const state = join(root, 'previous-latest.json');
  writeFileSync(state, JSON.stringify({
    schema_version: 1,
    previous_tag: 'v0.31.0',
    previous_release_id: 31,
    asset_names: null,
    manifest_sha256: null,
  }));
  const latestResponses = [
    { id: 32, tag_name: 'v0.32.0' },
    { id: 31, tag_name: 'v0.31.0' },
    { id: 31, tag_name: 'v0.31.0' },
  ];
  const calls = [];
  let candidate = { id: 32, body: promotionStateMarker(JSON.parse(readFileSync(state))) };
  const github = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/releases/tags/v0.32.0') return candidate;
    if (path === '/releases/latest') return latestResponses.shift();
    if (path === '/releases/32' && options.method === 'PATCH') {
      candidate = { ...candidate, ...options.body };
      return candidate;
    }
    return { ok: true };
  };
  const result = await recoverPromotion({
    tag: 'v0.32.0', state, token: 'test-token',
  }, {
    github,
    maxAttempts: 2,
    sleep: async () => {},
  });
  assert.deepEqual(result, {
    recovered: true, failed_tag: 'v0.32.0', previous_tag: 'v0.31.0',
  });
  assert.equal(calls.filter((call) => call.path === '/releases/latest').length, 3);
});

test('promotion recovery demotes and annotates failed release, restores previous latest', async () => {
  const root = temp('promotion-recovery');
  const state = join(root, 'previous-latest.json');
  const manifestBytes = Buffer.from('{"version":"0.31.0"}\n');
  writeFileSync(state, JSON.stringify({
    schema_version: 1,
    previous_tag: 'v0.31.0',
    previous_release_id: 31,
    asset_names: {
      artifact: 'triss-coworker-0.31.0-standalone.ndjson.gz',
      checksum: 'triss-coworker-0.31.0-standalone.sha256',
      manifest: 'update-manifest.json',
    },
    manifest_sha256: createHash('sha256').update(manifestBytes).digest('hex'),
    captured_at: '2026-08-12T00:00:00.000Z',
  }));
  const calls = [];
  const order = [];
  let candidate = { id: 32, body: promotionStateMarker(JSON.parse(readFileSync(state))) };
  const github = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/releases/tags/v0.32.0') return candidate;
    if (path === '/releases/latest') return { id: 31, tag_name: 'v0.31.0' };
    if (path === '/releases/32' && options.body?.make_latest === 'false' && !options.body?.body) order.push('demote');
    if (path === '/releases/32' && options.body?.body) {
      order.push(options.body.body.includes('incident') ? 'annotate' : 'phase');
      candidate = { ...candidate, ...options.body };
    }
    return { ok: true };
  };
  const result = await recoverPromotion({
    tag: 'v0.32.0', state, token: 'test-token',
  }, {
    github,
    boundedFetch: async () => ({ response: { ok: true }, bytes: manifestBytes }),
    verifyAnonymous: async (options) => {
      order.push('verify');
      assert.equal(options.tag, 'v0.31.0');
      assert.equal(options.assetNames.manifest, 'update-manifest.json');
      assert.equal(options.expectedManifestSha256,
        createHash('sha256').update(manifestBytes).digest('hex'));
    },
  });
  assert.deepEqual(result, {
    recovered: true, failed_tag: 'v0.32.0', previous_tag: 'v0.31.0',
  });
  const failedPatch = calls.find((call) =>
    call.path === '/releases/32' && call.options.body?.body?.includes('not standalone-updateable'));
  assert.equal(failedPatch.options.body.make_latest, 'false');
  assert.match(failedPatch.options.body.body, /not standalone-updateable/);
  assert.deepEqual(order, ['phase', 'demote', 'verify', 'annotate']);
  assert.equal(calls.some((call) => call.path === '/releases/31'), false);
});

test('promotion recovery resumes after a lost phase transition response', async () => {
  const root = temp('promotion-phase-rerun');
  const state = join(root, 'previous-latest.json');
  const snapshot = {
    schema_version: 2,
    previous_tag: 'v0.31.0',
    previous_release_id: 31,
    asset_names: null,
    manifest_sha256: null,
    captured_at: '2026-08-12T00:00:00.000Z',
    phase: 'prepared',
  };
  writeFileSync(state, `${JSON.stringify(snapshot)}\n`);
  let candidate = { id: 32, tag_name: 'v0.32.0', body: `notes\n${promotionStateMarker(snapshot)}\n` };
  let phasePatchAttempts = 0;
  const github = async (path, options = {}) => {
    if (path === '/releases/tags/v0.32.0') return candidate;
    if (path === '/releases/latest') return { id: 31, tag_name: 'v0.31.0', draft: false };
    if (path === '/releases/32' && options.method === 'PATCH') {
      if (options.body?.body && !options.body.body.includes('not standalone-updateable') && phasePatchAttempts++ === 0) {
        candidate = { ...candidate, body: options.body.body };
        throw new Error('phase PATCH response lost');
      }
      candidate = { ...candidate, ...options.body };
      return candidate;
    }
    throw new Error(`unexpected GitHub call ${path}`);
  };
  await assert.rejects(
    () => recoverPromotion({ tag: 'v0.32.0', state, token: 'test-token' }, { github }),
    /phase PATCH response lost/,
  );
  const result = await recoverPromotion({ tag: 'v0.32.0', state, token: 'test-token' }, { github });
  assert.equal(result.recovered, true);
  assert.doesNotMatch(candidate.body, /triss-previous-latest/);
  assert.match(candidate.body, /triss-standalone-incident:v0\.32\.0/);
});

test('promotion recovery retries final incident annotation after a transient PATCH failure', async () => {
  const root = temp('promotion-annotation-rerun');
  const state = join(root, 'previous-latest.json');
  const snapshot = {
    schema_version: 2,
    previous_tag: 'v0.31.0',
    previous_release_id: 31,
    asset_names: null,
    manifest_sha256: null,
    captured_at: '2026-08-12T00:00:00.000Z',
    phase: 'prepared',
  };
  writeFileSync(state, `${JSON.stringify(snapshot)}\n`);
  let candidate = { id: 32, tag_name: 'v0.32.0', body: `notes\n${promotionStateMarker(snapshot)}\n` };
  let annotationAttempts = 0;
  const github = async (path, options = {}) => {
    if (path === '/releases/tags/v0.32.0') return candidate;
    if (path === '/releases/latest') return { id: 31, tag_name: 'v0.31.0', draft: false };
    if (path === '/releases/32' && options.method === 'PATCH') {
      if (options.body?.body?.includes('not standalone-updateable') && annotationAttempts++ === 0) {
        throw new Error('annotation PATCH transient failure');
      }
      candidate = { ...candidate, ...options.body };
      return candidate;
    }
    throw new Error(`unexpected GitHub call ${path}`);
  };
  await assert.rejects(
    () => recoverPromotion({ tag: 'v0.32.0', state, token: 'test-token' }, { github }),
    /annotation PATCH transient failure/,
  );
  assert.match(candidate.body, /triss-previous-latest:v2/);
  const result = await recoverPromotion({ tag: 'v0.32.0', state, token: 'test-token' }, { github });
  assert.equal(result.recovered, true);
  assert.doesNotMatch(candidate.body, /triss-previous-latest/);
  assert.match(candidate.body, /not standalone-updateable/);
});

test('promotion incident annotation is idempotent', () => {
  const once = promotionIncidentBody('notes', 'v0.32.0', 'v0.31.0');
  assert.equal(promotionIncidentBody(once, 'v0.32.0', 'v0.31.0'), once);
});

test('promotion recovery does not overwrite a third release latest alias', async () => {
  const root = temp('promotion-cas');
  const state = join(root, 'previous-latest.json');
  writeFileSync(state, JSON.stringify({
    schema_version: 1,
    previous_tag: 'v0.31.0',
    previous_release_id: 31,
    asset_names: {
      artifact: 'triss-coworker-0.31.0-standalone.ndjson.gz',
      checksum: 'triss-coworker-0.31.0-standalone.sha256',
      manifest: 'update-manifest.json',
    },
    manifest_sha256: null,
  }));
  const calls = [];
  let candidate = { id: 32, body: promotionStateMarker(JSON.parse(readFileSync(state))) };
  const github = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/releases/tags/v0.32.0') return candidate;
    if (path === '/releases/latest') return { tag_name: 'v0.33.0' };
    if (path === '/releases/32' && options.method === 'PATCH' && options.body?.body) {
      candidate = { ...candidate, ...options.body };
      return candidate;
    }
    return { ok: true };
  };
  await assert.rejects(
    () => recoverPromotion({ tag: 'v0.32.0', state, token: 'test-token' }, {
      github,
      verifyAnonymous: async () => assert.fail('third release must not be verified as restored'),
    }),
    /will not overwrite it/,
  );
  assert.equal(calls.some((call) => call.path === '/releases/31'), false);
  assert.equal(calls.filter((call) => call.path === '/releases/32' && call.options.body?.body).length, 1);
});

test('promotion recovery rejects a recreated previous tag with a different release id', async () => {
  const root = temp('promotion-release-id-cas');
  const state = join(root, 'previous-latest.json');
  writeFileSync(state, JSON.stringify({
    schema_version: 1,
    previous_tag: 'v0.31.0',
    previous_release_id: 31,
    asset_names: null,
    manifest_sha256: null,
  }));
  const calls = [];
  let candidate = { id: 32, body: promotionStateMarker(JSON.parse(readFileSync(state))) };
  await assert.rejects(
    () => recoverPromotion({ tag: 'v0.32.0', state, token: 'test-token' }, {
      github: async (path, options = {}) => {
        calls.push({ path, options });
        if (path === '/releases/tags/v0.32.0') return candidate;
        if (path === '/releases/latest') return { id: 999, tag_name: 'v0.31.0' };
        if (path === '/releases/32' && options.method === 'PATCH' && options.body?.body) {
          candidate = { ...candidate, ...options.body };
          return candidate;
        }
        return { ok: true };
      },
      verifyAnonymous: async () => assert.fail('a different release id must not be verified'),
    }),
    /expected snapshotted release id 31/,
  );
  assert.equal(calls.some((call) =>
    call.path === '/releases/32' && call.options.body?.body?.includes('not standalone-updateable')), false);
});

test('promotion uses an authenticated latest compare-and-set immediately before mutation', async () => {
  const root = temp('promotion-precondition');
  const state = join(root, 'previous-latest.json');
  writeFileSync(state, JSON.stringify({
    schema_version: 1,
    previous_tag: 'v0.31.0',
    previous_release_id: 31,
    asset_names: null,
    manifest_sha256: null,
  }));
  const calls = [];
  await assert.rejects(
    () => releaseAction({
      action: 'promote', tag: 'v0.32.0', snapshot: state, token: 'test-token',
    }, {
      github: async (path, options = {}) => {
        calls.push({ path, options });
        if (path === '/releases/tags/v0.32.0') {
          return { id: 32, tag_name: 'v0.32.0', target_commitish: 'sha', draft: false, prerelease: false };
        }
        if (path === '/releases/latest') return { id: 99, tag_name: 'v0.33.0' };
        return { ok: true };
      },
    }),
    /latest changed before promotion/,
  );
  assert.equal(calls.some((call) => call.options.method === 'PATCH'), false);
});

test('promotion aborts without recovery when a third release wins the latest race', () => {
  assert.equal(promotionOutcome({
    promoteStatus: 1,
    candidateTag: 'v0.32.0',
    status: {
      is_latest: false,
      release_tag: 'v0.32.0',
      latest_tag: 'v0.33.0',
    },
  }), 'promotion-failed-without-latest');
  assert.equal(promotionOutcome({
    promoteStatus: 1,
    candidateTag: 'v0.32.0',
    status: { is_latest: true, release_tag: 'v0.32.0' },
  }), 'verify-latest');
});

test('snapshot refuses to promote an older tag over a newer latest release', async () => {
  const root = temp('promotion-order');
  await assert.rejects(
    () => snapshotLatest({ tag: 'v0.32.0', output: join(root, 'previous.json'), token: 'test-token' }, {
      github: async (path) => path === '/releases/latest'
        ? { id: 33, tag_name: 'v0.33.0', assets: [] }
        : { id: 32, tag_name: 'v0.32.0', body: 'notes', assets: [] },
    }),
    /must be newer than previous latest v0\.33\.0/,
  );
});

test('draft releases are invisible to /releases/tags and must be found via the list endpoint', async () => {
  // The REAL GitHub API returns 404 from /releases/tags/{tag} for DRAFT
  // releases — only published releases are addressable by tag. The v0.35.0
  // run created its draft with all assets and then failed the very next
  // tag lookup; the older test fake answered drafts on the tag endpoint and
  // hid exactly this. Here the tag endpoint 404s unconditionally while the
  // draft is discoverable through GET /releases.
  const root = temp('release-draft-invisible');
  const source = temp('release-draft-invisible-src');
  mkdirSync(join(source, 'bin'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'triss-coworker', version: '0.32.0' }));
  const sourceLauncher = join(source, 'bin', 'triss.js');
  writeFileSync(sourceLauncher, '#!/usr/bin/env node\n');
  chmodSync(sourceLauncher, 0o755);
  const artifact = join(root, 'triss-coworker-0.32.0-standalone.ndjson.gz');
  const build = buildStandalone({ sourceDir: source, outputPath: artifact, version: '0.32.0' });
  writeFileSync(`${artifact}.metadata.json`, JSON.stringify(build.metadata));
  const checksum = join(root, 'triss-coworker-0.32.0-standalone.sha256');
  const manifest = join(root, 'update-manifest.json');
  writeChecksum({ artifact, output: checksum });
  writeManifest({ artifact, output: manifest, 'artifact-name': basename(artifact), tag: 'v0.32.0', version: '0.32.0' });
  let release = null;
  let creates = 0;
  let uploads = 0;
  const github = async (path, options = {}) => {
    if (path === '/releases/tags/v0.32.0') {
      // Real API behavior: drafts are NOT addressable by tag.
      const error = new Error('release gate: GitHub API GET /releases/tags/v0.32.0 returned 404');
      error.retryableAnonymousVerification = true;
      throw error;
    }
    if (path.startsWith('/releases?')) {
      return release ? [release] : [];
    }
    if (path === '/releases' && options.method === 'POST') {
      creates++;
      release = {
        id: 32, tag_name: 'v0.32.0', target_commitish: 'release-sha',
        draft: true, prerelease: false, body: 'notes', assets: [],
      };
      return release;
    }
    throw new Error(`unexpected github call ${path}`);
  };
  const uploadAsset = async (_id, name, bytes) => {
    uploads++;
    release.assets.push({ id: uploads, name, bytes: Buffer.from(bytes) });
  };
  const downloadAsset = async (asset) => asset.bytes;
  const options = {
    tag: 'v0.32.0', target: 'release-sha', artifact, checksum, manifest, token: 'test-token',
  };
  const first = await ensureRelease(options, { github, uploadAsset, downloadAsset });
  assert.equal(first.draft, true);
  assert.equal(creates, 1);
  assert.equal(uploads, 3);
  // Second invocation finds the existing draft through the list and neither
  // creates nor re-uploads anything.
  const second = await ensureRelease(options, { github, uploadAsset, downloadAsset });
  assert.equal(second.draft, true);
  assert.equal(creates, 1);
  assert.equal(uploads, 3);
});

test('get-or-create release resumes draft uploads and then verifies a published release without overwriting assets', async () => {
  const root = temp('release-resume');
  const source = temp('release-resume-source');
  mkdirSync(join(source, 'bin'), { recursive: true });
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'triss-coworker', version: '0.32.0' }));
  const sourceLauncher = join(source, 'bin', 'triss.js');
  writeFileSync(sourceLauncher, '#!/usr/bin/env node\n');
  chmodSync(sourceLauncher, 0o755);
  const artifact = join(root, 'triss-coworker-0.32.0-standalone.ndjson.gz');
  const build = buildStandalone({ sourceDir: source, outputPath: artifact, version: '0.32.0' });
  writeFileSync(`${artifact}.metadata.json`, JSON.stringify(build.metadata));
  const checksum = join(root, 'triss-coworker-0.32.0-standalone.sha256');
  const manifest = join(root, 'update-manifest.json');
  writeChecksum({ artifact, output: checksum });
  writeManifest({ artifact, output: manifest, 'artifact-name': basename(artifact), tag: 'v0.32.0', version: '0.32.0' });
  let release = null;
  let creates = 0;
  let uploads = 0;
  const github = async (path, options = {}) => {
    if (path === '/releases/tags/v0.32.0') {
      if (!release) throw new Error('404');
      return release;
    }
    if (path.startsWith('/releases?')) {
      return release ? [release] : [];
    }
    if (path === '/releases' && options.method === 'POST') {
      creates++;
      release = {
        id: 32, tag_name: 'v0.32.0', target_commitish: 'release-sha',
        draft: true, prerelease: false, body: 'notes', assets: [],
      };
      return release;
    }
    throw new Error(`unexpected github call ${path}`);
  };
  const uploadAsset = async (_id, name, bytes) => {
    uploads++;
    release.assets.push({ id: uploads, name, bytes: Buffer.from(bytes) });
  };
  const downloadAsset = async (asset) => asset.bytes;
  const options = {
    tag: 'v0.32.0', target: 'release-sha', artifact, checksum, manifest, token: 'test-token',
  };
  const first = await ensureRelease(options, { github, uploadAsset, downloadAsset });
  assert.equal(first.draft, true);
  assert.equal(creates, 1);
  assert.equal(uploads, 3);
  release.draft = false;
  const second = await ensureRelease(options, { github, uploadAsset, downloadAsset });
  assert.equal(second.draft, false);
  assert.equal(creates, 1);
  assert.equal(uploads, 3);
});

test('release status exposes rerun-safe promotion state', async () => {
  const status = await releaseStatus({ tag: 'v0.32.0', token: 'test-token' }, {
    github: async (path) => path === '/releases/latest'
      ? { id: 32, tag_name: 'v0.32.0' }
      : { id: 32, tag_name: 'v0.32.0', draft: false },
  });
  assert.equal(status.is_latest, true);
  assert.equal(status.promotion_phase, null);
});

test('release status exposes an authenticated incident-pending phase', async () => {
  const marker = promotionStateMarker({
    schema_version: 2,
    previous_tag: 'v0.31.0',
    previous_release_id: 31,
    asset_names: null,
    manifest_sha256: null,
    captured_at: '2026-08-12T00:00:00.000Z',
    phase: 'incident_pending',
  });
  const status = await releaseStatus({ tag: 'v0.32.0', token: 'test-token' }, {
    github: async (path) => path === '/releases/latest'
      ? { id: 31, tag_name: 'v0.31.0' }
      : { id: 32, tag_name: 'v0.32.0', draft: false, body: `notes\n${marker}\n` },
  });
  assert.equal(status.promotion_phase, 'incident_pending');
});

test('release status rejects malformed promotion phase markers', async () => {
  await assert.rejects(
    () => releaseStatus({ tag: 'v0.32.0', token: 'test-token' }, {
      github: async (path) => path === '/releases/latest'
        ? { id: 31, tag_name: 'v0.31.0' }
        : { id: 32, tag_name: 'v0.32.0', body: '<!-- triss-previous-latest:v2:not-base64! -->' },
    }),
    /invalid|canonical|schema/,
  );
});

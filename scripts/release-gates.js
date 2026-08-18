#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { buildStandalone } from './build-standalone.js';
import { inspectArtifact } from '../src/update/artifact.js';
import { validateManifest } from '../src/update/manifest.js';
import { compareStableVersions, parseStableVersion } from '../src/version.js';
import { assertPublicUrl, fetchWithRedirects } from '../src/net.js';
import {
  installManifest as installStandaloneManifest,
  paths as standalonePaths,
} from './standalone-bootstrap.js';

const OWNER = 'ayleen';
const REPOSITORY = 'triss-coworker';
const API_ROOT = `https://api.github.com/repos/${OWNER}/${REPOSITORY}`;
const UPLOAD_ROOT = `https://uploads.github.com/repos/${OWNER}/${REPOSITORY}`;
const API_HOSTS = [
  'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
];
const DOWNLOAD_HOSTS = ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'];
const REMOTE_BODY_LIMIT = 256 * 1024 * 1024;
const ANONYMOUS_VERIFY_DELAYS_MS = [1000, 2000, 4000];

function die(message) {
  throw new Error(`release gate: ${message}`);
}

function retryableVerificationError(message) {
  const error = new Error(`release gate: ${message}`);
  error.retryableAnonymousVerification = true;
  return error;
}

function isRetryableAnonymousVerificationError(error) {
  if (error?.retryableAnonymousVerification || error?.status === 404) return true;
  return /\b404\b|anonymous release metadata mismatch|anonymous asset .* returned|anonymous asset bytes differ/i
    .test(error?.message || '');
}

function argMap(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      if (['resume', 'persist', 'load'].includes(key)) {
        result[key] = true;
        continue;
      }
      die(`missing value for --${key}`);
    }
    result[key] = value;
    i++;
  }
  return result;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) {
    die(`${command} ${args.join(' ')} failed${result.error ? `: ${result.error.message}` : ''}`);
  }
  return result;
}

function hash(data) {
  return createHash('sha256').update(data).digest('hex');
}

async function readBoundedBody(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) die(`remote body exceeds ${maxBytes} bytes`);
    return bytes;
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        die(`remote body exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* best effort */ }
  }
  return Buffer.concat(chunks, total);
}

export function copyCleanSource(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, {
    recursive: true,
    filter: (entry) => !['node_modules', '.git'].includes(basename(entry)),
  });
}

function realpathWithMissingLeaf(path) {
  let cursor = resolve(path);
  const missing = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) die(`cannot resolve existing parent for ${path}`);
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  return join(realpathSync(cursor), ...missing);
}

function containsPath(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function tagVersion(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) return null;
  return parseStableVersion(tag.slice(1));
}

function requireCandidateNewer(candidateTag, previousTag) {
  const candidate = tagVersion(candidateTag);
  const previous = tagVersion(previousTag);
  if (!candidate || !previous || compareStableVersions(candidate, previous) <= 0) {
    die(`candidate ${candidateTag} must be newer than previous latest ${previousTag}`);
  }
}

export function promotionOutcome({ promoteStatus, status, candidateTag } = {}) {
  if (status?.is_latest === true && status.release_tag === candidateTag) return 'verify-latest';
  return promoteStatus === 0 ? 'promotion-not-observed' : 'promotion-failed-without-latest';
}

/**
 * Perform two independent production installs and require matching inventory
 * and archive bytes. The clean copies are intentionally separate trees so a
 * successful second build cannot reuse node_modules from the first one.
 */
export function buildTwice({ sourceDir, workDir, version, outputPath } = {}) {
  if (!sourceDir || !workDir) die('build-twice requires --source and --work-dir');
  const source = resolve(sourceDir);
  const work = resolve(workDir);
  if (!existsSync(source) || !lstatSync(source).isDirectory() || lstatSync(source).isSymbolicLink()) {
    die('build-twice source must be a real directory');
  }
  if (existsSync(work) && (!lstatSync(work).isDirectory() || lstatSync(work).isSymbolicLink())) {
    die('build-twice work directory must be a real directory');
  }
  const safeSource = realpathSync(source);
  const safeWork = realpathWithMissingLeaf(work);
  if (containsPath(safeSource, safeWork) || containsPath(safeWork, safeSource)) {
    die('build-twice source and work directories must not overlap');
  }
  const reserved = [1, 2].flatMap((index) => [
    join(work, `clean-${index}`),
    join(work, `stage-${index}`),
    join(work, `artifact-${index}.ndjson.gz`),
    join(work, `artifact-${index}.ndjson.gz.integrity.json`),
  ]);
  if (reserved.some((path) => existsSync(path))) {
    die('build-twice work directory contains reserved build paths');
  }
  const destination = outputPath ? resolve(outputPath) : join(work, 'standalone.ndjson.gz');
  const destinationMetadata = `${destination}.metadata.json`;
  for (const path of [destination, destinationMetadata]) {
    const safePath = realpathWithMissingLeaf(path);
    if (containsPath(safeSource, safePath)) {
      die('build-twice output path must not overlap source');
    }
    if (existsSync(path)) die('build-twice output path already exists');
  }
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const builds = [];
  for (const index of [1, 2]) {
    const clean = join(work, `clean-${index}`);
    const stage = join(work, `stage-${index}`);
    const artifact = join(work, `artifact-${index}.ndjson.gz`);
    copyCleanSource(source, clean);
    run('npm', ['ci', '--omit=dev'], { cwd: clean });
    builds.push(buildStandalone({
      sourceDir: clean,
      stageDir: stage,
      outputPath: artifact,
      version,
    }));
  }
  const first = builds[0];
  const second = builds[1];
  if (!first.metadata.inventory_sha256 || first.metadata.inventory_sha256 !== second.metadata.inventory_sha256) {
    die('independent staged inventories differ');
  }
  if (first.metadata.tree_digest !== second.metadata.tree_digest) die('independent tree digests differ');
  const firstBytes = readFileSync(join(work, 'artifact-1.ndjson.gz'));
  const secondBytes = readFileSync(join(work, 'artifact-2.ndjson.gz'));
  if (!firstBytes.equals(secondBytes)) die('independent artifact bytes differ');
  if (hash(firstBytes) !== hash(secondBytes)) die('independent artifact checksums differ');
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, firstBytes, { mode: 0o600 });
  const result = {
    artifact: destination,
    sha256: hash(firstBytes),
    artifact_size: first.metadata.artifact_size,
    expanded_size: first.metadata.expanded_size,
    file_count: first.metadata.file_count,
    inventory_sha256: first.metadata.inventory_sha256,
    tree_digest: first.metadata.tree_digest,
    version: first.metadata.version,
  };
  writeFileSync(`${destination}.metadata.json`, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return result;
}

function nodeOnlyEnvironment(root) {
  const nodeBin = join(root, 'bin');
  mkdirSync(nodeBin, { recursive: true, mode: 0o700 });
  symlinkSync(process.execPath, join(nodeBin, 'node'));
  // Do not leak CI runner credentials into a published-artifact smoke.
  return { PATH: nodeBin, HOME: join(root, 'home'), CI: '1', TRISS_UPDATE_CHECK: '0' };
}

export async function smokeArtifact(artifactPath) {
  const root = mkdtempSync(join(tmpdir(), 'triss-release-smoke-'));
  const env = nodeOnlyEnvironment(root);
  mkdirSync(env.HOME, { recursive: true, mode: 0o700 });
  try {
    const parsed = inspectArtifact(artifactPath);
    const artifactBytes = readFileSync(artifactPath);
    const installEnv = {
      ...env,
      TRISS_STANDALONE_HOME: join(root, 'standalone'),
      TRISS_BIN_DIR: join(root, 'launcher'),
      TRISS_HOME: join(root, 'legacy'),
    };
    const installPaths = standalonePaths(installEnv);
    const manifest = {
      version: parsed.header.version,
      node: '>=22',
      node_compatible: true,
      artifact: {
        url: `https://github.com/ayleen/triss-coworker/releases/download/` +
          `v${parsed.header.version}/triss-standalone-${parsed.header.version}.ndjson.gz`,
        sha256: hash(artifactBytes),
        size: artifactBytes.length,
        expanded_size: parsed.header.expanded_bytes,
        file_count: parsed.header.file_count,
      },
    };
    await installStandaloneManifest(manifest, installPaths, {
      download: async () => ({ status: 200, bytes: artifactBytes }),
      statfs: () => ({ bavail: Number.MAX_SAFE_INTEGER, bsize: 1 }),
      writeOutput: () => {},
    });
    const entry = installPaths.binPath;
    const current = join(installPaths.root, 'current');
    const receipt = JSON.parse(readFileSync(installPaths.receipt, 'utf8'));
    if (!existsSync(entry) || !lstatSync(entry).isSymbolicLink() ||
        !lstatSync(current).isSymbolicLink() ||
        receipt.state !== 'active' || receipt.current_version !== parsed.header.version) {
      die('canonical standalone installation layout smoke failed');
    }
    for (const command of ['npm', 'pnpm', 'yarn', 'npx', 'git', 'gh']) {
      const probe = spawnSync(command, ['--version'], { env, encoding: 'utf8' });
      if (!probe.error && probe.status === 0) die(`forbidden package/repository tool is visible: ${command}`);
    }
    const childOutput = {
      env: installEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    };
    // Execute the public launcher exactly as users do.  Invoking `node
    // <launcher>` would bypass the artifact's executable mode and shebang,
    // allowing a non-executable published launcher to pass this smoke.
    const version = run(entry, ['--version'], childOutput);
    if (!version.stdout.includes(parsed.header.version)) die('standalone --version disagrees with artifact header');
    const help = run(entry, ['--help'], childOutput);
    if (!/Usage:|Commands:/i.test(help.stdout)) die('standalone --help smoke failed');
    const status = run(entry, ['status'], childOutput);
    if (!/status|API base/i.test(status.stdout)) die('standalone status smoke failed');
    const modules = [
      pathToFileURL(join(current, 'src', 'integrations', '_registry.js')).href,
      pathToFileURL(join(current, 'src', 'mcp', 'server.js')).href,
      pathToFileURL(join(current, 'src', 'mcp', 'tools.js')).href,
    ];
    const toolModule = modules[2];
    run(process.execPath, ['--input-type=module', '-e',
      `await Promise.all(${JSON.stringify(modules)}.map((url) => import(url)));` +
      `const listed = await (await import(${JSON.stringify(toolModule)})).listTools();` +
      'if (!Array.isArray(listed) || listed.length === 0) throw new Error("MCP tool listing is empty");'],
    { cwd: current, env: installEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    return {
      version: parsed.header.version,
      file_count: parsed.header.file_count,
      installation_verified: true,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function boundedFetch(url, {
  headers = {},
  allowedHosts,
  maxBytes = REMOTE_BODY_LIMIT,
  timeoutMs = 15_000,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const { response } = await fetchWithRedirects(url, {
        headers,
        signal: controller.signal,
        strict: true,
        allowedHosts,
        maxRedirects: 5,
      });
      const bytes = await readBoundedBody(response, maxBytes);
      return { response, bytes };
    } catch (error) {
      lastError = error;
      if (attempt === 1) throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function github(path, { token, method = 'GET', body, accept = 'application/vnd.github+json' } = {}) {
  // The pinned-request transport (src/net.js requestPinned) sends raw
  // https.request with ONLY these headers — global fetch would have added a
  // User-Agent automatically, and the GitHub API answers headerless requests
  // with 403 "Request forbidden by administrative rules" (reproduced in the
  // v0.35.0 release run and with a bare node https.get).
  const headers = {
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'triss-release-gates',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  if (method === 'GET') {
    const { response, bytes } = await boundedFetch(`${API_ROOT}${path}`, {
      headers,
      allowedHosts: API_HOSTS,
      maxBytes: 16 * 1024 * 1024,
    });
    if (!response.ok) {
      if (response.status === 404) throw retryableVerificationError(
        `GitHub API ${method} ${path} returned ${response.status}`,
      );
      die(`GitHub API ${method} ${path} returned ${response.status}`);
    }
    return { response, bytes, json: () => JSON.parse(bytes.toString('utf8')) };
  }
  {
    // GitHub's API calls below are mutations and must not be retried after a
    // request may have reached the server.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const mutationUrl = `${API_ROOT}${path}`;
      await assertPublicUrl(mutationUrl, { strict: true });
      const mutationResponse = await fetch(mutationUrl, {
        method,
        headers,
        signal: controller.signal,
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
      });
      const mutationBytes = await readBoundedBody(mutationResponse, 16 * 1024 * 1024);
      if (!mutationResponse.ok) die(`GitHub API ${method} ${path} returned ${mutationResponse.status}`);
      return { response: mutationResponse, bytes: mutationBytes, json: () => JSON.parse(mutationBytes.toString('utf8')) };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function uploadGithubAsset(releaseId, name, bytes, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const url = `${UPLOAD_ROOT}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
    const headers = {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'User-Agent': 'triss-release-gates',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    await assertPublicUrl(url, { strict: true, signal: controller.signal });
    const response = await fetch(url, {
      method: 'POST', headers, body: bytes, signal: controller.signal, redirect: 'error',
    });
    const responseBytes = await readBoundedBody(response, 16 * 1024 * 1024);
    if (!response.ok) die(`GitHub asset upload ${name} returned ${response.status}`);
    return JSON.parse(responseBytes.toString('utf8'));
  } finally {
    clearTimeout(timer);
  }
}

function expectedAssets(options) {
  const names = [options.artifact, options.checksum, options.manifest].map((path) => basename(path || ''));
  if (names.some((name) => !name)) die('release verification requires --artifact, --checksum and --manifest');
  return names;
}

function verifyAssetSemantics(options, artifactBytes, checksumBytes, manifestBytes) {
  const artifactName = basename(options.artifact || '');
  const checksumText = checksumBytes.toString('utf8');
  const match = checksumText.match(/^([a-f0-9]{64})\x20{2}([^\n]+)\n?$/);
  if (!match || match[1] !== hash(artifactBytes) || match[2] !== artifactName) {
    die('checksum asset does not describe the exact artifact bytes and filename');
  }
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch (error) {
    die(`manifest asset is not valid JSON: ${error.message}`);
  }
  const validation = validateManifest(manifest, { runningNode: process.versions.node });
  if (!validation.valid) die(`manifest asset is invalid: ${validation.errors.join('; ')}`);
  const tag = options.tag || '';
  const expectedVersion = tag.startsWith('v') ? tag.slice(1) : tag;
  const expectedUrl = `https://github.com/${OWNER}/${REPOSITORY}/releases/download/${tag}/${artifactName}`;
  if (manifest.version !== expectedVersion || manifest.artifact.sha256 !== hash(artifactBytes) ||
      manifest.artifact.size !== artifactBytes.length || manifest.artifact.url !== expectedUrl) {
    die('manifest asset does not match the tag, checksum, size, or artifact URL');
  }
  const artifact = inspectArtifact(artifactBytes);
  if (artifact.header.version !== manifest.version ||
      artifact.header.file_count !== manifest.artifact.file_count ||
      artifact.header.expanded_bytes !== manifest.artifact.expanded_size) {
    die('manifest asset does not match the artifact header totals');
  }
}

async function verifyDraft(options, dependencies = {}) {
  const requestGitHub = dependencies.github || github;
  const token = options.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) die('draft verification requires GH_TOKEN or GITHUB_TOKEN');
  const release = await releaseByTagAnyState(options.tag, requestGitHub, token);
  if ((!options.resume && !release.draft) || release.prerelease || release.tag_name !== options.tag) {
    die('draft release state/tag mismatch');
  }
  const names = expectedAssets(options);
  const actualNames = release.assets.map((asset) => asset.name).sort();
  if (actualNames.join('\n') !== [...names].sort().join('\n')) die('draft assets do not exactly match expected assets');
  const localArtifacts = {
    artifact: readFileSync(resolve(options.artifact)),
    checksum: readFileSync(resolve(options.checksum)),
    manifest: readFileSync(resolve(options.manifest)),
  };
  verifyAssetSemantics(options, localArtifacts.artifact, localArtifacts.checksum, localArtifacts.manifest);
  for (const asset of release.assets) {
    const localPath = [options.artifact, options.checksum, options.manifest]
      .find((candidate) => basename(candidate) === asset.name);
    if (!localPath) die(`no local fixture for draft asset ${asset.name}`);
    const local = readFileSync(resolve(localPath));
    const remote = await boundedFetch(`${API_ROOT}/releases/assets/${asset.id}`, {
      headers: {
        Accept: 'application/octet-stream',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'triss-release-gates',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      allowedHosts: API_HOSTS,
      maxBytes: REMOTE_BODY_LIMIT,
    });
    if (!remote.response.ok) die(`draft asset ${asset.name} returned ${remote.response.status}`);
    if (!local.equals(remote.bytes)) die(`draft asset bytes differ for ${asset.name}`);
  }
  return release;
}

function incidentMarker(tag) {
  return `<!-- triss-standalone-incident:${tag} -->`;
}

const PROMOTION_STATE_SCHEMA_VERSION = 2;
const PROMOTION_STATE_PREFIX = '<!-- triss-previous-latest:v2:';
const PROMOTION_STATE_SUFFIX = ' -->';
// Match the whole namespace so an old or malformed marker cannot be silently
// ignored by cleanup/status.  extractPromotionState performs the strict
// schema/version and canonical-byte validation.
const PROMOTION_STATE_PATTERN = /<!-- triss-previous-latest:v[0-9]+:[\s\S]*? -->/g;
const PROMOTION_STATE_NAMESPACE = '<!-- triss-previous-latest:';

export function promotionStateMarker(snapshot) {
  const value = JSON.stringify({
    schema_version: PROMOTION_STATE_SCHEMA_VERSION,
    previous_tag: snapshot.previous_tag,
    previous_release_id: snapshot.previous_release_id,
    asset_names: snapshot.asset_names,
    manifest_sha256: snapshot.manifest_sha256,
    captured_at: snapshot.captured_at,
    phase: snapshot.phase || 'prepared',
  });
  return `${PROMOTION_STATE_PREFIX}${Buffer.from(value, 'utf8').toString('base64url')}${PROMOTION_STATE_SUFFIX}`;
}

function decodePromotionStateMarker(marker) {
  const markerParts = marker.match(/^<!-- triss-previous-latest:v([0-9]+):([\s\S]*) -->$/);
  if (!markerParts || markerParts[1] !== String(PROMOTION_STATE_SCHEMA_VERSION)) {
    die('authenticated previous-latest state marker uses an unsupported schema');
  }
  const encoded = markerParts[2];
  let value;
  try { value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { die('authenticated previous-latest state marker is invalid'); }
  const snapshot = validateLatestSnapshot(value);
  if (promotionStateMarker(snapshot) !== marker) {
    die('authenticated previous-latest state marker is not canonical');
  }
  return snapshot;
}

// Presence is deliberately stricter than matching the valid marker grammar.
// A reserved namespace that is truncated, nested, duplicated, or uses an
// unknown version must never be treated as if no state marker existed.
function parsePromotionStatePresence(body) {
  const value = String(body || '');
  const prefixPositions = [];
  let offset = 0;
  while (true) {
    const position = value.indexOf(PROMOTION_STATE_NAMESPACE, offset);
    if (position < 0) break;
    prefixPositions.push(position);
    offset = position + PROMOTION_STATE_NAMESPACE.length;
  }
  const matches = [...value.matchAll(PROMOTION_STATE_PATTERN)];
  if (prefixPositions.length === 0) return { present: false, marker: null, snapshot: null };
  if (prefixPositions.length !== 1 || matches.length !== 1 || matches[0].index !== prefixPositions[0]) {
    die('authenticated previous-latest state marker is missing or ambiguous');
  }
  const marker = matches[0][0];
  return { present: true, marker, snapshot: decodePromotionStateMarker(marker) };
}

function extractPromotionState(body) {
  const state = parsePromotionStatePresence(body);
  if (!state.present) die('authenticated previous-latest state marker is missing or ambiguous');
  return state.snapshot;
}

async function snapshotForLatest(latest, fetchBounded) {
  const releaseAssetNames = latest.assets?.map((asset) => asset.name) || [];
  const artifactNames = releaseAssetNames.filter((name) => name.endsWith('.ndjson.gz'));
  const checksumNames = releaseAssetNames.filter((name) => name.endsWith('.sha256'));
  const manifestNames = releaseAssetNames.filter((name) => name === 'update-manifest.json');
  if (artifactNames.length > 1 || checksumNames.length > 1 || manifestNames.length > 1) {
    die('previous latest release contains duplicate standalone asset names');
  }
  const assetNames = {
    artifact: artifactNames[0],
    checksum: checksumNames[0],
    manifest: manifestNames[0],
  };
  const standaloneAssetCount = Object.values(assetNames).filter(Boolean).length;
  if (standaloneAssetCount !== 0 && standaloneAssetCount !== 3) {
    die('previous latest release does not contain the three standalone assets');
  }
  const verifiedAssetNames = standaloneAssetCount === 3 ? assetNames : null;
  let manifestSha256 = null;
  if (verifiedAssetNames) {
    const remote = await fetchBounded(
      `https://github.com/${OWNER}/${REPOSITORY}/releases/download/` +
      `${latest.tag_name}/update-manifest.json`,
      { headers: { 'User-Agent': 'triss-release-gates' }, allowedHosts: DOWNLOAD_HOSTS, maxBytes: 64 * 1024 },
    );
    if (!remote.response.ok) die('previous latest manifest is not publicly readable');
    manifestSha256 = hash(remote.bytes);
  }
  return {
    schema_version: PROMOTION_STATE_SCHEMA_VERSION,
    previous_tag: latest.tag_name,
    previous_release_id: latest.id,
    asset_names: verifiedAssetNames,
    manifest_sha256: manifestSha256,
    phase: 'prepared',
  };
}

function assertSnapshotMatchesLatest(snapshot, latest, expected) {
  const actual = {
    ...expected,
    previous_tag: latest.tag_name,
    previous_release_id: latest.id,
  };
  if (snapshot.previous_tag !== actual.previous_tag || snapshot.previous_release_id !== actual.previous_release_id ||
      JSON.stringify(snapshot.asset_names) !== JSON.stringify(actual.asset_names) ||
      snapshot.manifest_sha256 !== actual.manifest_sha256) {
    die('authenticated previous-latest state does not match current latest release');
  }
}

function bodyWithoutPromotionState(body, marker) {
  const value = String(body || '');
  const index = value.indexOf(marker);
  if (index < 0) die('authenticated previous-latest state marker is missing');
  let before = value.slice(0, index);
  let after = value.slice(index + marker.length);
  if (after.startsWith('\n')) after = after.slice(1);
  if (before.endsWith('\n') && after.startsWith('\n')) after = after.slice(1);
  return `${before}${after}`.trimEnd();
}

function assertReleaseIdentity(release, options) {
  if (!release || release.tag_name !== options.tag) die('release tag mismatch');
  if (options.target && release.target_commitish !== options.target) {
    die(`release target mismatch: expected ${options.target}, got ${release.target_commitish}`);
  }
  parsePromotionStatePresence(release.body);
  if (release.prerelease || (release.body || '').includes(incidentMarker(options.tag))) {
    die('release is marked as a standalone promotion incident');
  }
}

function localReleaseAssets(options) {
  const values = {
    artifact: readFileSync(resolve(options.artifact)),
    checksum: readFileSync(resolve(options.checksum)),
    manifest: readFileSync(resolve(options.manifest)),
  };
  verifyAssetSemantics(options, values.artifact, values.checksum, values.manifest);
  return new Map([
    [basename(options.artifact), values.artifact],
    [basename(options.checksum), values.checksum],
    [basename(options.manifest), values.manifest],
  ]);
}

async function verifyOrUploadReleaseAssets(release, options, dependencies = {}) {
  const expected = localReleaseAssets(options);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const names = [...expected.keys()];
  const actualNames = assets.map((asset) => asset.name);
  if (actualNames.some((name) => !expected.has(name))) die('release contains unexpected assets');
  if (new Set(actualNames).size !== actualNames.length) die('release contains duplicate asset names');
  const downloadAsset = dependencies.downloadAsset || (async (asset, token) => {
    const remote = await boundedFetch(`${API_ROOT}/releases/assets/${asset.id}`, {
      headers: {
        Accept: 'application/octet-stream',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'triss-release-gates',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      allowedHosts: API_HOSTS,
      maxBytes: REMOTE_BODY_LIMIT,
    });
    if (!remote.response.ok) die(`release asset ${asset.name} returned ${remote.response.status}`);
    return remote.bytes;
  });
  const uploadAsset = dependencies.uploadAsset || uploadGithubAsset;
  const token = options.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  for (const asset of assets) {
    const actual = await downloadAsset(asset, token);
    if (!Buffer.from(actual).equals(expected.get(asset.name))) {
      die(`release asset bytes differ for ${asset.name}`);
    }
  }
  if (!release.draft && assets.length !== names.length) {
    die('published release is missing immutable assets');
  }
  for (const [name, bytes] of expected) {
    if (assets.some((asset) => asset.name === name)) continue;
    if (!release.draft) die(`published release is missing immutable asset ${name}`);
    await uploadAsset(release.id, name, bytes, token);
  }
}

/**
 * Reconcile the release object and its immutable assets. This is deliberately
 * get-or-create: a retry after create/upload/publish can only fill missing
 * draft assets or verify existing bytes; it never overwrites an asset.
 */
/**
 * Draft releases are NOT addressable through /releases/tags/{tag} — the
 * real GitHub API answers 404 for them (only published releases resolve by
 * tag). Find the release by paging GET /releases instead; throw a
 * distinguishable retryable error when no release carries the tag.
 */
async function releaseByTagFromList(tag, requestGitHub, token) {
  for (let page = 1; page <= 10; page += 1) {
    const list = releaseJson(await requestGitHub(`/releases?per_page=100&page=${page}`, { token }));
    if (!Array.isArray(list)) die('GitHub API /releases did not return a list');
    const hit = list.find((entry) => entry?.tag_name === tag);
    if (hit) return hit;
    if (list.length < 100) break;
  }
  throw retryableVerificationError(`release-by-tag list lookup found nothing for ${tag}`);
}

/** Release by tag in ANY state: tag endpoint first, list fallback for drafts. */
async function releaseByTagAnyState(tag, requestGitHub, token) {
  try {
    return releaseJson(await requestGitHub(`/releases/tags/${encodeURIComponent(tag)}`, { token }));
  } catch (error) {
    if (!/\b404\b/.test(error?.message || '')) throw error;
    return releaseByTagFromList(tag, requestGitHub, token);
  }
}

export async function ensureRelease(options, dependencies = {}) {
  const requestGitHub = dependencies.github || github;
  const token = options.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) die('get-or-create release requires GH_TOKEN or GITHUB_TOKEN');
  for (const key of ['tag', 'target', 'artifact', 'checksum', 'manifest']) {
    if (!options[key]) die(`get-or-create release requires --${key}`);
  }
  const expected = {
    tag_name: options.tag,
    target_commitish: options.target,
    name: options.title || options.tag,
    body: options.notes || `Standalone artifact for ${options.tag}`,
    draft: true,
    prerelease: false,
    make_latest: 'false',
  };
  let release;
  try {
    release = await releaseByTagAnyState(options.tag, requestGitHub, token);
  } catch (error) {
    if (!/list lookup found nothing/.test(error?.message || '')) throw error;
    try {
      release = releaseJson(await requestGitHub('/releases', {
        token, method: 'POST', body: expected,
      }));
    } catch (createError) {
      // Another rerun may have won the create race. Re-read and validate it;
      // otherwise preserve the original failure rather than guessing.
      try {
        release = await releaseByTagAnyState(options.tag, requestGitHub, token);
      } catch {
        throw createError;
      }
    }
  }
  assertReleaseIdentity(release, options);
  await verifyOrUploadReleaseAssets(release, options, {
    ...dependencies,
    uploadAsset: dependencies.uploadAsset || uploadGithubAsset,
  });
  const refreshed = await releaseByTagAnyState(options.tag, requestGitHub, token);
  assertReleaseIdentity(refreshed, options);
  await verifyOrUploadReleaseAssets(refreshed, options, dependencies);
  return {
    id: refreshed.id,
    tag_name: refreshed.tag_name,
    target_commitish: refreshed.target_commitish,
    draft: refreshed.draft,
    prerelease: refreshed.prerelease,
    asset_names: refreshed.assets.map((asset) => asset.name).sort(),
  };
}

export async function releaseStatus(options, dependencies = {}) {
  const requestGitHub = dependencies.github || github;
  const token = options.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) die('release status requires GH_TOKEN or GITHUB_TOKEN');
  const release = await releaseByTagAnyState(options.tag, requestGitHub, token);
  const latest = releaseJson(await requestGitHub('/releases/latest', { token }));
  const promotionState = parsePromotionStatePresence(release.body);
  return {
    release_id: release.id,
    release_tag: release.tag_name,
    draft: release.draft,
    latest_id: latest.id,
    latest_tag: latest.tag_name,
    is_latest: release.id === latest.id && release.tag_name === latest.tag_name,
    promotion_phase: promotionState.present ? promotionState.snapshot.phase : null,
  };
}

function anonymousAssetNames(options) {
  if (options.assetNames) return options.assetNames;
  return {
    artifact: basename(options.artifact || ''),
    checksum: basename(options.checksum || ''),
    manifest: basename(options.manifest || ''),
  };
}

async function verifyAnonymousAttempt(options, latest, dependencies, expected) {
  const requestGitHub = dependencies.github || github;
  const fetchBounded = dependencies.boundedFetch || boundedFetch;
  const names = anonymousAssetNames(options);
  if (Object.values(names).some((name) => !name)) die(
    'anonymous release verification requires artifact, checksum and manifest asset names',
  );
  const releasePath = latest ? '/releases/latest' : `/releases/tags/${encodeURIComponent(options.tag)}`;
  // Exercise the same anonymous API/CDN surface that update clients see.
  const release = releaseJson(await requestGitHub(releasePath));
  if (release.draft || release.prerelease || release.tag_name !== options.tag) {
    throw retryableVerificationError('anonymous release metadata mismatch');
  }
  const remoteBytes = {};
  for (const key of ['artifact', 'checksum', 'manifest']) {
    const name = names[key];
    const assetUrl = latest
      ? `https://github.com/${OWNER}/${REPOSITORY}/releases/latest/download/${name}`
      : `https://github.com/${OWNER}/${REPOSITORY}/releases/download/${options.tag}/${name}`;
    const remote = await fetchBounded(assetUrl, {
      // github.com asset downloads 302 to the CDN; every hop of the pinned
      // transport sends only these headers, and a User-Agent-less request is
      // rejected with 403 by the administrative rules.
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'triss-release-gates' },
      allowedHosts: DOWNLOAD_HOSTS,
      maxBytes: REMOTE_BODY_LIMIT,
    });
    if (!remote.response.ok) throw retryableVerificationError(
      `anonymous asset ${name} returned ${remote.response.status}`,
    );
    const actual = remote.bytes;
    if (expected?.[key] && !expected[key].equals(actual)) {
      throw retryableVerificationError(`anonymous asset bytes differ for ${name}`);
    }
    remoteBytes[key] = actual;
  }
  if (options.expectedManifestSha256 &&
      hash(remoteBytes.manifest) !== options.expectedManifestSha256) {
    throw retryableVerificationError('anonymous manifest differs from the snapshotted release');
  }
  try {
    verifyAssetSemantics({
      ...options,
      artifact: names.artifact,
      checksum: names.checksum,
      manifest: names.manifest,
    }, remoteBytes.artifact, remoteBytes.checksum, remoteBytes.manifest);
  } catch (error) {
    error.retryableAnonymousVerification = true;
    throw error;
  }
  return release;
}

/**
 * Verify metadata, all three public assets, and their cross-asset semantics as
 * one transaction. GitHub's CDN can briefly return a stale tag or stale asset;
 * retry the complete transaction so a mixed response can never pass.
 */
export async function verifyAnonymous(options, latest = false, dependencies = {}) {
  const expected = options.assetNames
    ? null
    : {
      artifact: readFileSync(resolve(options.artifact)),
      checksum: readFileSync(resolve(options.checksum)),
      manifest: readFileSync(resolve(options.manifest)),
    };
  const maxAttempts = Math.max(1, Math.min(
    Number(dependencies.maxAttempts || ANONYMOUS_VERIFY_DELAYS_MS.length + 1),
    ANONYMOUS_VERIFY_DELAYS_MS.length + 1,
  ));
  const sleep = dependencies.sleep || ((milliseconds) => new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  }));
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await verifyAnonymousAttempt(options, latest, dependencies, expected);
    } catch (error) {
      lastError = error;
      if (!isRetryableAnonymousVerificationError(error) || attempt === maxAttempts - 1) throw error;
      await sleep(ANONYMOUS_VERIFY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

export async function releaseAction(options, dependencies = {}) {
  const requestGitHub = dependencies.github || github;
  const token = options.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) die('release action requires GH_TOKEN or GITHUB_TOKEN');
  const release = await releaseByTagAnyState(options.tag, requestGitHub, token);
  assertReleaseIdentity(release, options);
  const action = options.action;
  if (action === 'publish-nonlatest' && !release.draft) return release;
  if (action === 'return-to-draft' && release.draft) return release;
  if (action === 'promote') {
    if (!options.snapshot) die('promote requires --snapshot for compare-and-set');
    const snapshot = validateLatestSnapshot(JSON.parse(readFileSync(resolve(options.snapshot), 'utf8')));
    if (snapshot.phase !== 'prepared') die('promote requires a prepared promotion snapshot');
    if (snapshot.previous_tag === options.tag) die('candidate tag cannot be its own previous latest');
    requireCandidateNewer(options.tag, snapshot.previous_tag);
    const latest = releaseJson(await requestGitHub('/releases/latest', { token }));
    if (latest.tag_name === options.tag && latest.id === release.id) return release;
    if (latest.tag_name !== snapshot.previous_tag || latest.id !== snapshot.previous_release_id) {
      die(
        `latest changed before promotion: expected ${snapshot.previous_tag}#${snapshot.previous_release_id}, ` +
        `got ${latest.tag_name}#${latest.id}`,
      );
    }
  }
  const body = action === 'publish-nonlatest'
    ? { draft: false, prerelease: false, make_latest: 'false' }
    : action === 'promote'
      ? { draft: false, prerelease: false, make_latest: 'true' }
      : action === 'demote'
        ? { make_latest: 'false' }
        : action === 'return-to-draft'
          ? { draft: true, make_latest: 'false' }
          : null;
  if (!body) die(`unknown release action ${action}`);
  return releaseJson(await requestGitHub(`/releases/${release.id}`, { token, method: 'PATCH', body }));
}

function releaseJson(result) {
  return typeof result?.json === 'function' ? result.json() : result;
}

export function promotionIncidentBody(body, tag, previousTag) {
  const marker = `<!-- triss-standalone-incident:${tag} -->`;
  if ((body || '').includes(marker)) return body;
  const note = [
    marker,
    `> Standalone update incident: ${tag} failed latest-alias verification and`,
    '> is not standalone-updateable. Its assets and tag remain immutable.',
    `> Latest was restored to ${previousTag} and anonymously verified; publish a new patch release through`,
    '> the complete pipeline.',
  ].join('\n');
  return `${body ? `${body.trimEnd()}\n\n` : ''}${note}\n`;
}

export async function snapshotLatest(options, dependencies = {}) {
  const requestGitHub = dependencies.github || github;
  const fetchBounded = dependencies.boundedFetch || boundedFetch;
  const token = options.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) die('latest snapshot requires GH_TOKEN or GITHUB_TOKEN');
  if (!options.output) die('latest snapshot requires --output');
  let candidate = null;
  try {
    candidate = await releaseByTagAnyState(options.tag, requestGitHub, token);
  } catch (error) {
    if (!/\b404\b/.test(error?.message || '')) throw error;
  }
  const candidateBody = String(candidate?.body || '');
  const promotionState = parsePromotionStatePresence(candidateBody);
  const hasStateMarker = promotionState.present;
  if (candidate) assertReleaseIdentity(candidate, { tag: options.tag, target: undefined });
  const latest = releaseJson(await requestGitHub('/releases/latest', { token }));
  if (!latest?.tag_name) {
    die('previous latest release is missing');
  }
  if (latest.tag_name === options.tag) {
    const snapshot = extractPromotionState(candidate.body);
    if (snapshot.phase === 'incident_pending') die('promotion recovery is pending for this candidate');
    writePromotionStateFile(options.output, snapshot);
    return snapshot;
  }
  requireCandidateNewer(options.tag, latest.tag_name);
  const expected = await snapshotForLatest(latest, fetchBounded);
  if (hasStateMarker) {
    if (!candidate) die('previous-latest state marker cannot be authenticated');
    const snapshot = extractPromotionState(candidateBody);
    if (snapshot.phase === 'incident_pending') die('promotion recovery is pending for this candidate');
    assertSnapshotMatchesLatest(snapshot, latest, expected);
    writePromotionStateFile(options.output, snapshot);
    return snapshot;
  }
  const snapshot = {
    ...expected,
    captured_at: new Date().toISOString(),
  };
  writePromotionStateFile(options.output, snapshot);
  if (options.persist) await persistPromotionState({ ...options, snapshot }, dependencies);
  return snapshot;
}

function writePromotionStateFile(output, snapshot) {
  mkdirSync(dirname(resolve(output)), { recursive: true, mode: 0o700 });
  writeFileSync(resolve(output), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
}

export async function persistPromotionState(options, dependencies = {}) {
  const requestGitHub = dependencies.github || github;
  const token = options.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) die('persist promotion state requires GH_TOKEN or GITHUB_TOKEN');
  const snapshot = validateLatestSnapshot(options.snapshot || JSON.parse(readFileSync(resolve(options.state), 'utf8')));
  const candidate = await releaseByTagAnyState(options.tag, requestGitHub, token);
  assertReleaseIdentity(candidate, { ...options, tag: options.tag, target: undefined });
  const marker = promotionStateMarker(snapshot);
  const existing = String(candidate.body || '');
  const existingState = parsePromotionStatePresence(existing);
  if (existingState.present && existingState.marker !== marker) {
    die('candidate release contains a conflicting previous-latest state marker');
  }
  if (existingState.present) return snapshot;
  await requestGitHub(`/releases/${candidate.id}`, {
    token,
    method: 'PATCH',
    body: { body: `${existing.trimEnd()}${existing.trimEnd() ? '\n\n' : ''}${marker}\n` },
  });
  return snapshot;
}

function replacePromotionStateMarker(body, oldMarker, newMarker) {
  const value = String(body || '');
  const index = value.indexOf(oldMarker);
  if (index < 0) die('authenticated previous-latest state marker is missing');
  return `${value.slice(0, index)}${newMarker}${value.slice(index + oldMarker.length)}`;
}

export async function markPromotionIncidentPending(options, dependencies = {}) {
  const requestGitHub = dependencies.github || github;
  const token = options.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) die('promotion phase transition requires GH_TOKEN or GITHUB_TOKEN');
  const candidate = await releaseByTagAnyState(options.tag, requestGitHub, token);
  const before = extractPromotionState(candidate.body);
  if (before.phase === 'incident_pending') {
    const reread = await releaseByTagAnyState(options.tag, requestGitHub, token);
    const verified = extractPromotionState(reread.body);
    if (promotionStateMarker(verified) !== promotionStateMarker(before)) {
      die('incident-pending promotion marker changed during verification');
    }
    return verified;
  }
  if (before.phase !== 'prepared') die('promotion phase is invalid for recovery');
  const after = { ...before, phase: 'incident_pending' };
  const oldMarker = promotionStateMarker(before);
  const newMarker = promotionStateMarker(after);
  await requestGitHub(`/releases/${candidate.id}`, {
    token,
    method: 'PATCH',
    body: { body: replacePromotionStateMarker(candidate.body, oldMarker, newMarker) },
  });
  const reread = await releaseByTagAnyState(options.tag, requestGitHub, token);
  const verified = extractPromotionState(reread.body);
  if (promotionStateMarker(verified) !== newMarker) {
    die('incident-pending promotion marker was not durably verified');
  }
  return verified;
}

export async function loadPromotionState(options, dependencies = {}) {
  const requestGitHub = dependencies.github || github;
  const token = options.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) die('load promotion state requires GH_TOKEN or GITHUB_TOKEN');
  if (!options.output) die('load promotion state requires --output');
  const candidate = await releaseByTagAnyState(options.tag, requestGitHub, token);
  const snapshot = extractPromotionState(candidate.body);
  writePromotionStateFile(options.output, snapshot);
  return snapshot;
}

export async function clearPromotionState(options, dependencies = {}) {
  const requestGitHub = dependencies.github || github;
  const token = options.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) die('clear promotion state requires GH_TOKEN or GITHUB_TOKEN');
  const candidate = await releaseByTagAnyState(options.tag, requestGitHub, token);
  const body = String(candidate.body || '');
  const state = parsePromotionStatePresence(body);
  if (!state.present) return candidate;
  const marker = state.marker;
  return releaseJson(await requestGitHub(`/releases/${candidate.id}`, {
    token, method: 'PATCH', body: { body: bodyWithoutPromotionState(body, marker) },
  }));
}

function validateLatestSnapshot(value) {
  if (!value || ![1, PROMOTION_STATE_SCHEMA_VERSION].includes(value.schema_version) ||
      typeof value.previous_tag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(value.previous_tag) ||
      !Number.isSafeInteger(value.previous_release_id) || value.previous_release_id <= 0 ||
      (value.asset_names !== null && (!value.asset_names ||
        Object.values(value.asset_names).some((name) => typeof name !== 'string' || !name))) ||
      (value.manifest_sha256 !== null && !/^[a-f0-9]{64}$/.test(value.manifest_sha256)) ||
      (value.phase !== undefined && !['prepared', 'incident_pending'].includes(value.phase))) {
    die('previous latest snapshot is invalid');
  }
  return { ...value, schema_version: PROMOTION_STATE_SCHEMA_VERSION, phase: value.phase || 'prepared' };
}

export async function recoverPromotion(options, dependencies = {}) {
  const requestGitHub = dependencies.github || github;
  const fetchBounded = dependencies.boundedFetch || boundedFetch;
  const verify = dependencies.verifyAnonymous || verifyAnonymous;
  const token = options.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) die('promotion recovery requires GH_TOKEN or GITHUB_TOKEN');
  if (!options.state) die('promotion recovery requires --state');
  if (options.load && !existsSync(resolve(options.state))) {
    await loadPromotionState({ ...options, output: options.state }, dependencies);
  }
  let snapshot = validateLatestSnapshot(JSON.parse(readFileSync(resolve(options.state), 'utf8')));
  if (snapshot.previous_tag === options.tag) die('candidate tag cannot be its own previous latest');
  requireCandidateNewer(options.tag, snapshot.previous_tag);
  snapshot = await markPromotionIncidentPending({ ...options, snapshot }, dependencies);
  writePromotionStateFile(options.state, snapshot);
  const failed = releaseJson(await requestGitHub(
    `/releases/tags/${encodeURIComponent(options.tag)}`,
    { token },
  ));
  let demoteError;
  try {
    // Demote the candidate before writing any incident annotation. The
    // annotation is only truthful after the old latest has been restored and
    // anonymously verified below.
    await requestGitHub(`/releases/${failed.id}`, {
      token,
      method: 'PATCH',
      body: { make_latest: 'false' },
    });
  } catch (error) {
    demoteError = error;
  }

  // Reconcile an ambiguous demotion. GitHub's latest alias may briefly keep
  // returning the candidate through its API/CDN after the PATCH. Poll that
  // one expected stale state with the same bounded retry window used by the
  // anonymous asset verification. A third release is a compare-and-set
  // conflict: never overwrite it with the snapshot's previous release.
  const maxAttempts = Math.max(1, Math.min(
    Number(dependencies.maxAttempts || ANONYMOUS_VERIFY_DELAYS_MS.length + 1),
    ANONYMOUS_VERIFY_DELAYS_MS.length + 1,
  ));
  const sleep = dependencies.sleep || ((milliseconds) => new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  }));
  let currentLatest;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    currentLatest = releaseJson(await requestGitHub('/releases/latest', { token }));
    if (currentLatest.tag_name !== options.tag) break;
    if (attempt === maxAttempts - 1) break;
    await sleep(ANONYMOUS_VERIFY_DELAYS_MS[attempt]);
  }
  if (currentLatest.tag_name !== snapshot.previous_tag && currentLatest.tag_name !== options.tag) {
    die(`latest alias changed to ${currentLatest.tag_name}; recovery will not overwrite it`);
  }
  if (currentLatest.tag_name === options.tag) {
    die('candidate remains latest after demotion; recovery will not overwrite the shared alias');
  }
  if (currentLatest.tag_name !== snapshot.previous_tag) {
    die(`latest alias was not restored to ${snapshot.previous_tag}`);
  }
  if (currentLatest.id !== snapshot.previous_release_id) {
    die(
      `latest alias restored tag ${snapshot.previous_tag} with release id ` +
      `${currentLatest.id}; expected snapshotted release id ${snapshot.previous_release_id}`,
    );
  }

  if (snapshot.asset_names) {
    await verify({
      tag: snapshot.previous_tag,
      assetNames: snapshot.asset_names,
      expectedManifestSha256: snapshot.manifest_sha256,
    }, true, { github: requestGitHub, boundedFetch: fetchBounded, sleep: dependencies.sleep });
  } else {
    const restored = releaseJson(await requestGitHub('/releases/latest'));
    if (restored.draft || restored.prerelease || restored.tag_name !== snapshot.previous_tag) {
      die(`latest alias was not anonymously restored to ${snapshot.previous_tag}`);
    }
  }

  // Only now append a confirmed incident note. If this PATCH fails, no
  // success result is returned and no false confirmed recovery is reported.
  const failedMarker = promotionStateMarker(snapshot);
  const cleanBody = bodyWithoutPromotionState(failed.body, failedMarker);
  await requestGitHub(`/releases/${failed.id}`, {
    token,
    method: 'PATCH',
    body: {
      make_latest: 'false',
      body: promotionIncidentBody(cleanBody, options.tag, snapshot.previous_tag),
    },
  });
  if (demoteError) {
    // The state was reconciled successfully, so an ambiguous initial PATCH is
    // informational rather than a recovery failure.
    process.stderr.write(`release gate: candidate demotion was ambiguous: ${demoteError.message}\n`);
  }
  return { recovered: true, failed_tag: options.tag, previous_tag: snapshot.previous_tag };
}

export function writeManifest(options) {
  const metadata = JSON.parse(readFileSync(`${resolve(options.artifact)}.metadata.json`, 'utf8'));
  const artifactBytes = readFileSync(resolve(options.artifact));
  const artifactName = options.artifact_name || options['artifact-name'];
  if (!artifactName) die('write-manifest requires --artifact-name');
  const providedPublishedAt = options.published_at ?? options['published-at'];
  let publishedAt = providedPublishedAt;
  if (publishedAt !== undefined) {
    const parsed = Date.parse(publishedAt);
    if (typeof publishedAt !== 'string' || !Number.isFinite(parsed) ||
        new Date(parsed).toISOString() !== publishedAt) {
      die('write-manifest --published-at must be a canonical ISO timestamp');
    }
  } else publishedAt = new Date().toISOString();
  const manifest = {
    schema_version: 1,
    name: 'triss-coworker',
    version: options.version || metadata.version,
    channel: 'stable',
    published_at: publishedAt,
    release_url: `https://github.com/${OWNER}/${REPOSITORY}/releases/tag/${options.tag}`,
    node: options.node || '>=22',
    artifact: {
      url: `https://github.com/${OWNER}/${REPOSITORY}/releases/download/${options.tag}/${artifactName}`,
      sha256: hash(artifactBytes),
      size: artifactBytes.length,
      expanded_size: metadata.expanded_size,
      file_count: metadata.file_count,
      format: 'triss-ndjson-gzip-v1',
      platform: 'node-posix',
    },
  };
  const validation = validateManifest(manifest, { runningNode: process.versions.node });
  if (!validation.valid) die(`generated manifest is invalid: ${validation.errors.join('; ')}`);
  writeFileSync(resolve(options.output), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

export function writeChecksum(options) {
  const artifact = resolve(options.artifact);
  const output = resolve(options.output);
  const bytes = readFileSync(artifact);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${hash(bytes)}  ${basename(artifact)}\n`, { mode: 0o600 });
  return { sha256: hash(bytes), artifact: basename(artifact), output };
}

/**
 * Verify that a downloaded canonical artifact is byte-for-byte identical to
 * the builder's recorded release input.  Smoke jobs and the release job use
 * this gate before doing any work with the artifact.
 */
export function verifyArtifact(options = {}) {
  if (!options.artifact || !options.metadata) {
    die('verify-artifact requires --artifact and --metadata');
  }
  const artifactPath = resolve(options.artifact);
  const metadataPath = resolve(options.metadata);
  const bytes = readFileSync(artifactPath);
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  } catch (error) {
    die(`artifact metadata is not valid JSON: ${error.message}`);
  }
  const actualSha256 = hash(bytes);
  if (!/^[a-f0-9]{64}$/.test(metadata.sha256) || metadata.sha256 !== actualSha256) {
    die('artifact bytes do not match the canonical metadata checksum');
  }
  if (!Number.isSafeInteger(metadata.artifact_size) || metadata.artifact_size !== bytes.length) {
    die('artifact bytes do not match the canonical metadata size');
  }
  if (options.checksum) {
    const checksumText = readFileSync(resolve(options.checksum), 'utf8');
    const match = checksumText.match(/^([a-f0-9]{64})\x20{2}([^\n]+)\n?$/);
    if (!match || match[1] !== actualSha256 || match[2] !== basename(artifactPath)) {
      die('artifact checksum file does not describe the canonical artifact');
    }
  }
  return { artifact: artifactPath, sha256: actualSha256, size: bytes.length };
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const options = argMap(argv);
  if (command === 'build-twice') {
    process.stdout.write(`${JSON.stringify(buildTwice({
      sourceDir: options.source,
      workDir: options['work-dir'],
      outputPath: options.output,
      version: options.version,
    }))}\n`);
  } else if (command === 'smoke') {
    process.stdout.write(`${JSON.stringify(await smokeArtifact(options.artifact))}\n`);
  } else if (command === 'write-manifest') {
    process.stdout.write(`${JSON.stringify(writeManifest(options))}\n`);
  } else if (command === 'write-checksum') {
    process.stdout.write(`${JSON.stringify(writeChecksum(options))}\n`);
  } else if (command === 'verify-artifact') {
    process.stdout.write(`${JSON.stringify(verifyArtifact(options))}\n`);
  } else if (command === 'verify-draft') {
    process.stdout.write(`${JSON.stringify(await verifyDraft(options))}\n`);
  } else if (command === 'ensure-release') {
    process.stdout.write(`${JSON.stringify(await ensureRelease(options))}\n`);
  } else if (command === 'release-status') {
    process.stdout.write(`${JSON.stringify(await releaseStatus(options))}\n`);
  } else if (command === 'promotion-outcome') {
    if (!options['status-file'] || options['promote-status'] === undefined || !options.tag) {
      die('promotion-outcome requires --status-file, --promote-status and --tag');
    }
    const status = JSON.parse(readFileSync(resolve(options['status-file']), 'utf8'));
    process.stdout.write(`${promotionOutcome({
      promoteStatus: Number(options['promote-status']),
      status,
      candidateTag: options.tag,
    })}\n`);
  } else if (command === 'verify-tag') {
    process.stdout.write(`${JSON.stringify(await verifyAnonymous(options))}\n`);
  } else if (command === 'verify-latest') {
    process.stdout.write(`${JSON.stringify(await verifyAnonymous(options, true))}\n`);
  } else if (command === 'release-action') {
    process.stdout.write(`${JSON.stringify(await releaseAction(options))}\n`);
  } else if (command === 'snapshot-latest') {
    process.stdout.write(`${JSON.stringify(await snapshotLatest(options))}\n`);
  } else if (command === 'persist-promotion-state') {
    process.stdout.write(`${JSON.stringify(await persistPromotionState(options))}\n`);
  } else if (command === 'load-promotion-state') {
    process.stdout.write(`${JSON.stringify(await loadPromotionState(options))}\n`);
  } else if (command === 'clear-promotion-state') {
    process.stdout.write(`${JSON.stringify(await clearPromotionState(options))}\n`);
  } else if (command === 'recover-promotion') {
    process.stdout.write(`${JSON.stringify(await recoverPromotion(options))}\n`);
  } else {
    die('command must be build-twice, smoke, write-checksum, verify-artifact, write-manifest, ' +
      'verify-draft, verify-tag, verify-latest, release-action, snapshot-latest, ' +
      'recover-promotion, persist-promotion-state, load-promotion-state, clear-promotion-state, ' +
      'ensure-release, release-status, or promotion-outcome');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

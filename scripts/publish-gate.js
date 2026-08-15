#!/usr/bin/env node
/**
 * Release gates for the triss-dsh-provider-bundle companion package.
 *
 * The companion shares the root triss-coworker version and the v<version>
 * tag but keeps its own npm identity. This tool implements the plan's
 * release contract for it: both manifests agree on the tag version, both
 * tarballs contain exactly their allowlisted public files, publication is
 * safely retryable when one npm package succeeded before the other, and an
 * already-published target version is acceptable ONLY when registry
 * metadata and tarball integrity match the locally verified artifact.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const companionDir = join(repoRoot, 'packages', 'dsh-provider-bundle');
const COMPANION_NAME = 'triss-dsh-provider-bundle';
const ROOT_NAME = 'triss-coworker';
const REGISTRY = 'https://registry.npmjs.org';

function die(message) {
  throw new Error(`publish gate: ${message}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function npmPack(cwd, workdir) {
  const stdout = execFileSync(
    'npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', workdir],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(stdout)[0];
}

function tarEntries(tarballPath) {
  const out = execFileSync('tar', ['-tf', tarballPath], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((line) => line.replace(/^package\//, '')).sort();
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Both manifests carry the same version and it matches the release tag. */
export function verifyVersions({ tag } = {}) {
  const root = readJson(join(repoRoot, 'package.json'));
  const companion = readJson(join(companionDir, 'package.json'));
  if (root.name !== ROOT_NAME) die(`root package is ${root.name}, expected ${ROOT_NAME}`);
  if (companion.name !== COMPANION_NAME) {
    die(`companion package is ${companion.name}, expected ${COMPANION_NAME}`);
  }
  if (root.version !== companion.version) {
    die(`version mismatch: root ${root.version} vs companion ${companion.version}`);
  }
  if (tag !== undefined) {
    const tagVersion = tag.startsWith('v') ? tag.slice(1) : tag;
    if (root.version !== tagVersion) {
      die(`tag ${tag} does not match manifest version ${root.version}`);
    }
  }
  return { version: root.version, root, companion };
}

/** Pack both tarballs and verify their public contents against the allowlists. */
export function packAndInspect({ workdir } = {}) {
  // npm pack never creates the pack destination; when the workflow passes an
  // explicit --workdir (e.g. $RUNNER_TEMP/publish-pack, absent on a fresh
  // runner) we must own its creation or the very first pack dies with ENOENT.
  const dir = workdir ?? mkdtempSync(join(tmpdir(), 'triss-publish-gate-'));
  if (workdir) mkdirSync(dir, { recursive: true });
  const companion = npmPack(companionDir, dir);
  const root = npmPack(repoRoot, dir);
  const companionEntries = tarEntries(join(dir, companion.filename));
  const rootEntries = tarEntries(join(dir, root.filename));

  const companionAllowed = [
    'LICENSE', 'README.md', 'cordis.patch.yml', 'package.json',
  ];
  const extras = companionEntries.filter((entry) => !companionAllowed.includes(entry));
  if (extras.length > 0) die(`companion tarball carries unexpected files: ${extras.join(', ')}`);
  for (const required of companionAllowed) {
    if (!companionEntries.includes(required)) {
      die(`companion tarball is missing ${required}`);
    }
  }
  if (rootEntries.some((entry) => entry.startsWith('packages/')
    || entry.includes('cordis.patch.yml')
    || entry.includes('triss-dsh-provider-bundle'))) {
    die('root tarball carries companion package content');
  }
  return {
    workdir: dir,
    companion: {
      name: companion.name,
      version: companion.version,
      filename: companion.filename,
      path: join(dir, companion.filename),
      sha256: sha256(readFileSync(join(dir, companion.filename))),
      entries: companionEntries,
    },
    root: {
      name: root.name,
      version: root.version,
      filename: root.filename,
      path: join(dir, root.filename),
      sha256: sha256(readFileSync(join(dir, root.filename))),
      entries: rootEntries,
    },
  };
}

/**
 * Registry verification with safe-retry semantics, for EITHER npm package:
 * an already-published version is acceptable only when the registry tarball's
 * sha256 equals the locally verified artifact's AND the registry's own
 * sha512 integrity matches the tarball bytes; any mismatch fails closed.
 * `fetchJson`/`fetchBytes` are injectable for tests.
 */
export async function verifyRegistryPackage(local, {
  fetchJson, fetchBytes, registry = REGISTRY,
} = {}) {
  const requestJson = fetchJson ?? (async (url) => {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    return { status: response.status, body: await response.json() };
  });
  const requestBytes = fetchBytes ?? (async (url) => {
    const response = await fetch(url);
    return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
  });

  const name = local.name ?? COMPANION_NAME;
  const url = `${registry}/${name}/${local.version}`;
  const manifestResponse = await requestJson(url);
  if (manifestResponse.status === 404) {
    return { published: false, integrityOk: null };
  }
  if (manifestResponse.status !== 200) {
    die(`registry metadata for ${name}@${local.version} returned ${manifestResponse.status}`);
  }
  const dist = manifestResponse.body?.dist;
  if (!dist?.tarball) die(`registry metadata for ${url} carries no dist.tarball`);
  const tarballResponse = await requestBytes(dist.tarball);
  if (tarballResponse.status !== 200) {
    die(`registry tarball for ${url} returned ${tarballResponse.status}`);
  }
  const registrySha = sha256(tarballResponse.bytes);
  if (registrySha !== local.sha256) {
    die([
      `registry tarball for ${name}@${local.version} differs from the local artifact`,
      `(registry ${registrySha}, local ${local.sha256}) — fail closed, select a new version`,
    ].join(' '));
  }
  // npm publishes dist.integrity as sha512-<base64>. Verify it is genuinely
  // derived from the served bytes — a stale/hijacked CDN edge or a proxy
  // rewriting the metadata must not pass a hash we never computed.
  if (typeof dist.integrity === 'string' && dist.integrity.length >= 10) {
    const expected = `sha512-${createHash('sha512').update(tarballResponse.bytes).digest('base64')}`;
    if (dist.integrity !== expected) {
      die(`registry integrity for ${url} does not match the served tarball (metadata ${dist.integrity.slice(0, 24)}…, tarball ${expected.slice(0, 24)}…)`);
    }
  }
  return { published: true, integrityOk: true, sha256: registrySha };
}

// Backwards-compatible alias: the companion was the first gated package.
export const verifyRegistryCompanion = verifyRegistryPackage;

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const [key, ...rest] = argv[i].slice(2).split('=');
    args[key] = rest.length > 0 ? rest.join('=') : argv[i + 1] ?? true;
  }

  if (command === 'verify-versions') {
    const { version } = verifyVersions({ tag: args.tag === true ? undefined : args.tag });
    process.stdout.write(`${JSON.stringify({ ok: true, version })}\n`);
    return;
  }
  if (command === 'pack-inspect') {
    const result = packAndInspect({ workdir: args.workdir === true ? undefined : args.workdir });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      companion: { name: result.companion.name, version: result.companion.version, sha256: result.companion.sha256, entries: result.companion.entries },
      root: { name: result.root.name, version: result.root.version, sha256: result.root.sha256 },
    }, null, 2)}\n`);
    return;
  }
  if (command === 'verify-registry') {
    const local = JSON.parse(readFileSync(args['local-manifest'], 'utf8'));
    const result = await verifyRegistryCompanion(local);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    return;
  }
  die(`unknown command ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}

// Exported API used by tests.
export { die, main };

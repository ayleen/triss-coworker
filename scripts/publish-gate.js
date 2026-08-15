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
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
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
  // Own the destination: `npm pack --pack-destination` does NOT create the
  // parent directory (verified on npm 11.6.2 — it writeFile()s the tarball
  // straight into it and fails with ENOENT). The publish workflow passes an
  // explicit --workdir that does not exist yet on a clean runner, so the
  // gate must mkdir it itself instead of relying on the caller.
  const dir = workdir ?? mkdtempSync(join(tmpdir(), 'triss-publish-gate-'));
  mkdirSync(dir, { recursive: true });
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
 * Registry verification with safe-retry semantics for EITHER release package
 * (root `triss-coworker` or companion `triss-dsh-provider-bundle`): an
 * already-published version is acceptable only when the registry tarball's
 * sha256 equals the locally verified artifact's; any mismatch fails closed.
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

  const expectedNames = [ROOT_NAME, COMPANION_NAME];
  if (!expectedNames.includes(local.name)) {
    die(`verifyRegistryPackage expects name ${expectedNames.join(' or ')}, got ${local.name}`);
  }
  const url = `${registry}/${local.name}/${local.version}`;
  const manifestResponse = await requestJson(url);
  if (manifestResponse.status === 404) {
    return { name: local.name, published: false, integrityOk: null };
  }
  if (manifestResponse.status !== 200) {
    die(`registry metadata for ${local.name}@${local.version} returned ${manifestResponse.status}`);
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
      `registry tarball for ${local.name}@${local.version} differs from the local artifact`,
      `(registry ${registrySha}, local ${local.sha256}) — fail closed, select a new version`,
    ].join(' '));
  }
  // The registry declares dist.integrity as an SRI sha512 of the tarball.
  // Byte equality above is the authoritative check; the SRI value is
  // additionally validated for shape and must match the very bytes we just
  // downloaded — a malformed or mismatched declaration is a hard failure,
  // never a warning (review §2).
  const expectedSri = `sha512-${createHash('sha512').update(tarballResponse.bytes).digest('base64')}`;
  if (dist.integrity) {
    if (!/^sha512-[A-Za-z0-9+/]{86}={2}$/.test(dist.integrity)) {
      die(`registry integrity for ${url} is malformed: ${dist.integrity}`);
    }
    if (dist.integrity !== expectedSri) {
      die(`registry integrity for ${url} does not match the registry tarball bytes`);
    }
  }
  return { name: local.name, published: true, integrityOk: true, sha256: registrySha };
}

/** Back-compat alias: the original companion-only name. */
export const verifyRegistryCompanion = verifyRegistryPackage;

/**
 * Safe-retry publication plan for the two-package release train (review §2):
 * consult the live registry for BOTH packages and decide what still needs
 * publishing. A package already published with byte-identical content is
 * skipped; any byte mismatch fails closed (a re-publish of the same version
 * is impossible on npm). Injectable fetchers for the retry-matrix tests.
 */
export async function planPublication(manifest, opts = {}) {
  const companion = await verifyRegistryPackage({
    name: COMPANION_NAME,
    version: manifest.companion.version,
    sha256: manifest.companion.sha256,
  }, opts);
  const root = await verifyRegistryPackage({
    name: ROOT_NAME,
    version: manifest.root.version,
    sha256: manifest.root.sha256,
  }, opts);
  return {
    companion,
    root,
    actions: {
      publishCompanion: !companion.published,
      publishRoot: !root.published,
    },
  };
}

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
    const result = await verifyRegistryPackage(local);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    return;
  }
  if (command === 'plan-publish') {
    // Decide, from the pack-inspect manifest + live registry state, which of
    // the two packages still need publishing. Idempotent on retry: a package
    // already published with identical bytes is skipped, so re-running the
    // workflow after a partial failure never re-publishes an existing
    // version (review §2).
    const manifest = JSON.parse(readFileSync(args['local-manifest'], 'utf8'));
    const plan = await planPublication(manifest);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      companion: plan.companion,
      root: plan.root,
      actions: plan.actions,
    }, null, 2)}\n`);
    return;
  }
  die(`unknown command ${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}

// Exported API used by tests.
export { die, main };

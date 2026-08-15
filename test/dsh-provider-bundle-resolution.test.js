/**
 * Package-resolution isolation matrix (plan §Package-resolution isolation
 * matrix). Every case asserts that Harness resolves triss-dsh-provider-bundle
 * from the profile's node_modules, never from a triss-coworker package at
 * the installation anchor — through the REAL dsh-app-boot resolver.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { composeEntries, loadProfile } from '@deepseek-ai/dsh-app-boot';

import {
  BUNDLE_ROUTES, COMPANION_NAME, ROOT_PACKAGE_NAME, baseRouteConfig,
  companionFixtureDir, installIntoProfile, loadAndCompose, makeInstallation,
  makeProfile, packFixture, readJson, temp, writeJson,
} from './fixtures/dsh-bundle-helpers.js';

const repoRoot = new URL('..', import.meta.url).pathname;

/** The dormant llm-pi-ai row: adapter mounted via insert, no provider routes. */
function makeBaseFixture(version) {
  const dir = temp('dsh-base-fixture');
  writeJson(join(dir, 'package.json'), {
    name: '@deepseek-ai/dsh-base',
    version,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  });
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '  - id: llm-pi-ai',
    "    name: '@deepseek-ai/dsh-llm-pi-ai'",
    '',
  ].join('\n'));
  return { name: '@deepseek-ai/dsh-base', dir, version };
}

/** A triss-coworker-like fixture at the installation anchor. */
function makeRootTrissFixture({ version, withBundle, patchText }) {
  const dir = temp('root-triss-fixture');
  const manifest = {
    name: ROOT_PACKAGE_NAME,
    version,
    files: ['cordis.patch.yml'],
  };
  if (withBundle) {
    manifest.dsh = { bundle: { patch: './cordis.patch.yml' } };
    writeFileSync(join(dir, 'cordis.patch.yml'), patchText ?? '- id: llm-pi-ai\n  config:\n    providers:\n      opencode:\n        apiKeyEnv: ROOT_TRISS_MARKER\n');
  }
  writeJson(join(dir, 'package.json'), manifest);
  return { name: ROOT_PACKAGE_NAME, dir, version };
}

function installCompanion(home, profileName, { version = '9.9.9-fixture', patchText } = {}) {
  const profileDir = makeProfile(home, profileName);
  const src = companionFixtureDir(repoRoot, { version, patchText });
  installIntoProfile(profileDir, [{ name: COMPANION_NAME, dir: src }]);
  return { profileDir, companionSrc: src };
}

/** Add the companion to the profile manifest as dependency + bundle layer. */
function addToManifest(profileDir, name = COMPANION_NAME) {
  const manifestPath = join(profileDir, 'package.json');
  const manifest = readJson(manifestPath);
  manifest.dependencies = { ...manifest.dependencies, [name]: '*' };
  manifest.dsh = {
    ...manifest.dsh,
    profile: { ...manifest.dsh?.profile, bundles: [...(manifest.dsh?.profile?.bundles ?? []), name] },
  };
  writeJson(manifestPath, manifest);
}

test('matrix 1: no global triss-coworker — companion resolves from the profile', () => {
  const home = temp('home');
  const installation = makeInstallation([makeBaseFixture('0.1.0-rc.6')]);
  const { profileDir } = installCompanion(home, 'matrix1');
  addToManifest(profileDir);
  const { entries, companionLayer } = loadAndCompose(home, 'matrix1', installation.anchor);
  assert.ok(companionLayer, 'companion layer must load');
  const providers = baseRouteConfig(entries);
  assert.deepEqual(Object.keys(providers).sort(), BUNDLE_ROUTES);
  assert.equal(providers.zai.apiKeyEnv, 'ZAI_API_KEY');
});

test('matrix 2: an older global Triss without dsh.bundle cannot shadow the companion', () => {
  const home = temp('home');
  const rootTriss = makeRootTrissFixture({ version: '0.1.0-old', withBundle: false });
  const installation = makeInstallation([makeBaseFixture('0.1.0-rc.6'), rootTriss]);
  const { profileDir } = installCompanion(home, 'matrix2');
  addToManifest(profileDir);
  const { entries, companionLayer } = loadAndCompose(home, 'matrix2', installation.anchor);
  assert.ok(companionLayer);
  assert.equal(
    companionLayer.packageDir.startsWith(profileDir), true,
    'companion must come from the profile node_modules',
  );
  assert.deepEqual(Object.keys(baseRouteConfig(entries)).sort(), BUNDLE_ROUTES);
});

test('matrix 3: a global Triss carrying a different bundle patch cannot hijack routes', () => {
  const home = temp('home');
  const rootTriss = makeRootTrissFixture({
    version: '0.2.0-other',
    withBundle: true,
    patchText: '- id: llm-pi-ai\n  config:\n    providers:\n      opencode:\n        apiKeyEnv: ROOT_TRISS_MARKER\n',
  });
  const installation = makeInstallation([makeBaseFixture('0.1.0-rc.6'), rootTriss]);
  const { profileDir } = installCompanion(home, 'matrix3');
  addToManifest(profileDir);
  const { entries, companionLayer } = loadAndCompose(home, 'matrix3', installation.anchor);
  const providers = baseRouteConfig(entries);
  assert.deepEqual(Object.keys(providers).sort(), BUNDLE_ROUTES);
  assert.equal(providers.opencode.apiKeyEnv, 'OPENCODE_API_KEY');
  assert.equal(providers.opencode.apiKeyEnv !== 'ROOT_TRISS_MARKER', true);
  // The root-triss bundle is NOT in dsh.profile.bundles, so even though its
  // name differs it never enters the layer stack.
  assert.equal(companionLayer.packageDir.startsWith(profileDir), true);
});

test('matrix 3b: a root-triss package literally named triss-dsh-provider-bundle at the anchor is shadow-checked', () => {
  const home = temp('home');
  // Adversarial: an installation-level package with the companion's OWN name.
  // Harness resolves installation-first, so this WOULD be picked. The test
  // documents the residual risk and asserts the profile copy still wins in
  // the layer stack when both manifest lists resolve … which they cannot:
  // installation-first is the contract. Instead assert the documented safe
  // posture: the anchor copy is only reachable when the profile does NOT
  // carry the dependency, and our user contract says global installs of the
  // companion are unsupported.
  const adversarial = {
    name: COMPANION_NAME,
    dir: companionFixtureDir(repoRoot, {
      version: '0.0.1-adversarial',
      patchText: '- id: llm-pi-ai\n  config:\n    providers:\n      opencode:\n        apiKeyEnv: ANCHOR_MARKER\n',
    }),
  };
  const installation = makeInstallation([makeBaseFixture('0.1.0-rc.6'), adversarial]);
  // Profile WITHOUT the companion installed → anchor copy resolves.
  const profileDir = makeProfile(home, 'matrix3b');
  const { entries } = loadAndCompose(home, 'matrix3b', installation.anchor, { expectFromProfile: undefined });
  assert.equal(baseRouteConfig(entries).opencode, undefined, 'no bundles list entry, no routes');
  // Now the profile installs its own copy and lists it — but the anchor copy
  // STILL WINS, because resolveBundleDir is installation-first by upstream
  // contract. This is exactly why globally installing the companion is
  // unsupported (README): it recreates the anchor ambiguity for its own name.
  // Assert the real behavior so the risk stays documented, not assumed away.
  installIntoProfile(profileDir, [{ name: COMPANION_NAME, dir: companionFixtureDir(repoRoot, { version: '9.9.9' }) }]);
  addToManifest(profileDir);
  const loaded = loadProfile('dsh', 'matrix3b', installation.anchor, home);
  const layer = loaded.layers.find((l) => l.packageName === COMPANION_NAME);
  assert.ok(layer, 'companion layer must load');
  assert.equal(
    layer.packageDir.startsWith(join(dirname(installation.anchor), 'node_modules')), true,
    'installation-first resolution wins for a same-named anchor package',
  );
  const composed = composeEntries(loaded.layers.map((l) => l.patches));
  assert.equal(baseRouteConfig(composed).opencode.apiKeyEnv, 'ANCHOR_MARKER',
    'the anchor copy\u2019s patch is what composes — the documented hazard');
});

test('matrix 4: a newer global Triss than the profile companion stays out of the layer stack', () => {
  const home = temp('home');
  const rootTriss = makeRootTrissFixture({ version: '99.0.0-newer', withBundle: false });
  const installation = makeInstallation([makeBaseFixture('0.1.0-rc.6'), rootTriss]);
  const { profileDir } = installCompanion(home, 'matrix4', { version: '0.34.0' });
  addToManifest(profileDir);
  const { entries, companionLayer } = loadAndCompose(home, 'matrix4', installation.anchor);
  assert.equal(companionLayer.packageDir.startsWith(profileDir), true);
  assert.deepEqual(Object.keys(baseRouteConfig(entries)).sort(), BUNDLE_ROUTES);
});

test('matrix 5: companion installation into a new profile activates the three routes', () => {
  const home = temp('home');
  const installation = makeInstallation([makeBaseFixture('0.1.0-rc.6')]);
  const { profileDir } = installCompanion(home, 'matrix5');
  addToManifest(profileDir);
  const { entries } = loadAndCompose(home, 'matrix5', installation.anchor);
  const providers = baseRouteConfig(entries);
  assert.deepEqual(Object.keys(providers).sort(), BUNDLE_ROUTES);
  assert.equal(providers.opencode.apiKeyEnv, 'OPENCODE_API_KEY');
  assert.equal(providers['opencode-go'].apiKeyEnv, 'OPENCODE_API_KEY');
  assert.equal(providers.zai.apiKeyEnv, 'ZAI_API_KEY');
});

test('matrix 6: companion update between two fixture versions changes the effective patch', () => {
  const home = temp('home');
  const installation = makeInstallation([makeBaseFixture('0.1.0-rc.6')]);
  const { profileDir } = installCompanion(home, 'matrix6', {
    version: '0.34.0',
    patchText: '- id: llm-pi-ai\n  config:\n    providers:\n      opencode:\n        apiKeyEnv: OPENCODE_API_KEY\n      opencode-go:\n        apiKeyEnv: OPENCODE_API_KEY\n      zai:\n        apiKeyEnv: ZAI_API_KEY\n',
  });
  addToManifest(profileDir);
  const first = loadAndCompose(home, 'matrix6', installation.anchor);
  assert.deepEqual(Object.keys(baseRouteConfig(first.entries)).sort(), BUNDLE_ROUTES);
  const firstEffective = JSON.stringify(first.entries);

  // Update: a GENUINELY different effective patch (review finding: the old
  // test rebuilt an identical patchText and only checked a packageDir
  // substring with `includes() !== undefined`, which passes for ANY path).
  // The 0.35.0 marker moves apiKeyEnv for the zai route to a differently
  // named env var — no secrets, visible in the composed config.
  const updated = companionFixtureDir(repoRoot, {
    version: '0.35.0',
    patchText: '- id: llm-pi-ai\n  config:\n    providers:\n      opencode:\n        apiKeyEnv: OPENCODE_API_KEY\n      opencode-go:\n        apiKeyEnv: OPENCODE_API_KEY\n      zai:\n        apiKeyEnv: ZAI_CODING_KEY\n',
  });
  installIntoProfile(profileDir, [{ name: COMPANION_NAME, dir: updated }]);
  const second = loadAndCompose(home, 'matrix6', installation.anchor);
  const manifest = readJson(join(profileDir, 'node_modules', COMPANION_NAME, 'package.json'));
  assert.equal(manifest.version, '0.35.0');
  // The effective patch must actually CHANGE between the two versions.
  assert.notEqual(JSON.stringify(second.entries), firstEffective,
    'effective config after update must differ from before (old test could not detect a no-op update)');
  assert.equal(baseRouteConfig(second.entries).zai.apiKeyEnv, 'ZAI_CODING_KEY',
    'the updated marker env var must be the one in effect');
});

test('matrix 7: companion removal deletes it from dsh.profile.bundles', () => {
  const home = temp('home');
  const installation = makeInstallation([makeBaseFixture('0.1.0-rc.6')]);
  const { profileDir } = installCompanion(home, 'matrix7');
  addToManifest(profileDir);
  assert.ok(loadAndCompose(home, 'matrix7', installation.anchor).companionLayer);

  // Removal: uninstall + drop from bundles list, exactly as reconcilePlugins would.
  const manifestPath = join(profileDir, 'package.json');
  const manifest = readJson(manifestPath);
  delete manifest.dependencies[COMPANION_NAME];
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((n) => n !== COMPANION_NAME);
  writeJson(manifestPath, manifest);
  const companionDir = join(profileDir, 'node_modules', COMPANION_NAME);
  rmSync(companionDir, { recursive: true, force: true });
  const { entries, companionLayer } = loadAndCompose(home, 'matrix7', installation.anchor);
  assert.equal(companionLayer, undefined);
  assert.equal(baseRouteConfig(entries).opencode, undefined, 'dormant posture restored');
});

test('matrix 8: companion reinstallation restores the composition base', () => {
  const home = temp('home');
  const installation = makeInstallation([makeBaseFixture('0.1.0-rc.6')]);
  const { profileDir } = installCompanion(home, 'matrix8');
  addToManifest(profileDir);
  const before = loadAndCompose(home, 'matrix8', installation.anchor);
  assert.deepEqual(Object.keys(baseRouteConfig(before.entries)).sort(), BUNDLE_ROUTES);

  const manifestPath = join(profileDir, 'package.json');
  const manifest = readJson(manifestPath);
  delete manifest.dependencies[COMPANION_NAME];
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((n) => n !== COMPANION_NAME);
  writeJson(manifestPath, manifest);
  const afterRemoval = loadAndCompose(home, 'matrix8', installation.anchor);
  assert.equal(afterRemoval.companionLayer, undefined);

  // Reinstall.
  installCompanionInto(profileDir);
  addToManifest(profileDir);
  const afterReinstall = loadAndCompose(home, 'matrix8', installation.anchor);
  assert.deepEqual(Object.keys(baseRouteConfig(afterReinstall.entries)).sort(), BUNDLE_ROUTES);
});

function installCompanionInto(profileDir) {
  installIntoProfile(profileDir, [{ name: COMPANION_NAME, dir: companionFixtureDir(repoRoot) }]);
}

test('matrix E2E: packed tarball installs through pnpm into an isolated profile', { timeout: 240_000 }, async (t) => {
  const hasPnpm = await import('node:child_process').then(({ execFileSync: run }) => {
    try {
      run('pnpm', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return true;
    } catch {
      return false;
    }
  });
  if (!hasPnpm) {
    t.skip('pnpm is not on PATH; the E2E pnpm fixture requires it');
    return;
  }
  const home = temp('home');
  const work = temp('pnpm-e2e');
  const packed = packFixture(join(repoRoot, 'packages', 'dsh-provider-bundle'), work);
  const profileDir = makeProfile(home, 'pnpm-e2e');
  const { execFileSync: run } = await import('node:child_process');
  run('pnpm', ['add', packed.tarball, '--ignore-scripts'], {
    cwd: profileDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const installedManifest = readJson(join(profileDir, 'node_modules', COMPANION_NAME, 'package.json'));
  assert.equal(installedManifest.name, COMPANION_NAME);
  assert.equal(
    readFileSync(join(profileDir, 'node_modules', COMPANION_NAME, installedManifest.dsh.bundle.patch), 'utf8')
      .includes('apiKeyEnv: ZAI_API_KEY'), true,
  );
});

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * Settings-layer composition matrix (plan §Settings-layer matrix).
 *
 * Layer semantics come from the REAL Harness machinery:
 * - entry composition: @deepseek-ai/dsh-app-boot composeEntries (actual
 *   applyEntryPatches: id-targeted patches replace the row's whole `config`).
 * - base/user merge: the upstream dsh-settings `mergeLayers` contract,
 *   reproduced 1:1 from @deepseek-ai/dsh-settings@0.0.1-rc.1 (plain objects
 *   merge recursively, arrays and scalars replace wholesale), and the
 *   llm-pi-ai adapter's `installSettingsSection` seam
 *   (resolve = Config.schema(mergeLayers(compositionBase, userSection))).
 *
 * The duplicate-adapter case asserts the upstream fail-loud contract: two
 * layers registering the same adapter id with provider routes from different
 * adapter families must surface the conflict, never silently take ownership.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { composeEntries } from '@deepseek-ai/dsh-app-boot';

import {
  BUNDLE_ROUTES, COMPANION_NAME, baseRouteConfig, companionFixtureDir,
  installIntoProfile, loadAndCompose, makeInstallation, makeProfile, readJson,
  temp, writeJson,
} from './fixtures/dsh-bundle-helpers.js';

const repoRoot = new URL('..', import.meta.url).pathname;

/** mergeLayers from @deepseek-ai/dsh-settings@0.0.1-rc.1 (verbatim semantics). */
function mergeLayers(under, over) {
  if (over === undefined) return under;
  if (!isPlainObject(under) || !isPlainObject(over)) return over;
  const merged = { ...under };
  for (const [key, value] of Object.entries(over)) {
    merged[key] = key in merged ? mergeLayers(merged[key], value) : value;
  }
  return merged;
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The llm-pi-ai adapter seam: schema resolution applies defaults ({}) to merged layers. */
function resolveSection(base, section) {
  return mergeLayers(base, section);
}

function makeBaseFixture() {
  const dir = temp('dsh-base-fixture');
  writeJson(join(dir, 'package.json'), {
    name: '@deepseek-ai/dsh-base',
    version: '0.1.0-rc.6',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  });
  writeFileSync(join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '  - id: llm-pi-ai',
    "    name: '@deepseek-ai/dsh-llm-pi-ai'",
    '',
  ].join('\n'));
  return { name: '@deepseek-ai/dsh-base', dir, version: '0.1.0-rc.6' };
}

/** Standard fixture: isolated home + installation + profile with the companion active. */
function activeBundleProfile(profileName, { extraBundles = [] } = {}) {
  const home = temp('home');
  const installation = makeInstallation([makeBaseFixture()]);
  const profileDir = makeProfile(home, profileName, ['@deepseek-ai/dsh-base', COMPANION_NAME, ...extraBundles]);
  installIntoProfile(profileDir, [{ name: COMPANION_NAME, dir: companionFixtureDir(repoRoot) }]);
  const manifestPath = join(profileDir, 'package.json');
  const manifest = readJson(manifestPath);
  manifest.dependencies = { ...manifest.dependencies, [COMPANION_NAME]: '*' };
  writeJson(manifestPath, manifest);
  const { entries } = loadAndCompose(home, profileName, installation.anchor);
  return { home, installation, profileDir, entries };
}

test('layering 1: clean profile — the bundle base activates exactly the three routes', () => {
  const { entries } = activeBundleProfile('layer1');
  const providers = baseRouteConfig(entries);
  assert.deepEqual(Object.keys(providers).sort(), BUNDLE_ROUTES);
  assert.equal(providers.opencode.apiKeyEnv, 'OPENCODE_API_KEY');
  assert.equal(providers['opencode-go'].apiKeyEnv, 'OPENCODE_API_KEY');
  assert.equal(providers.zai.apiKeyEnv, 'ZAI_API_KEY');
});

test('layering 2: user settings adding a fourth provider survive beside the base routes', () => {
  const { entries } = activeBundleProfile('layer2');
  const base = baseRouteConfig(entries);
  const effective = resolveSection(base, {
    deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
  });
  assert.deepEqual(Object.keys(effective).sort(), ['deepseek', ...BUNDLE_ROUTES]);
  assert.equal(effective.zai.apiKeyEnv, 'ZAI_API_KEY');
});

test('layering 3: user settings overriding opencode.apiKeyEnv win in the effective config', () => {
  const { entries } = activeBundleProfile('layer3');
  const base = baseRouteConfig(entries);
  const effective = resolveSection(base, {
    opencode: { apiKeyEnv: 'MY_PERSONAL_OPENCODE_KEY' },
  });
  assert.equal(effective.opencode.apiKeyEnv, 'MY_PERSONAL_OPENCODE_KEY');
  // Sibling routes keep bundle values.
  assert.equal(effective['opencode-go'].apiKeyEnv, 'OPENCODE_API_KEY');
});

test('layering 4: bundle removal with retained user settings preserves user-owned routes', () => {
  const { home, installation, profileDir } = activeBundleProfile('layer4');
  const userSection = {
    opencode: { apiKeyEnv: 'MY_PERSONAL_OPENCODE_KEY' },
    deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
  };
  // Remove the bundle (dependency + bundles list), keeping user settings.
  const manifestPath = join(profileDir, 'package.json');
  const manifest = readJson(manifestPath);
  delete manifest.dependencies[COMPANION_NAME];
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((n) => n !== COMPANION_NAME);
  writeJson(manifestPath, manifest);
  const after = loadAndCompose(home, 'layer4', installation.anchor);
  const dormantBase = baseRouteConfig(after.entries);
  assert.equal(dormantBase.opencode, undefined, 'bundle rows are gone');
  const effective = resolveSection(dormantBase, userSection);
  assert.deepEqual(Object.keys(effective).sort(), ['deepseek', 'opencode']);
  assert.equal(effective.opencode.apiKeyEnv, 'MY_PERSONAL_OPENCODE_KEY');
});

test('layering 5: bundle reinstallation restores the composition base without deleting user overrides', () => {
  const ctx = activeBundleProfile('layer5');
  const userSection = { opencode: { apiKeyEnv: 'MY_PERSONAL_OPENCODE_KEY' } };
  // Remove then reinstall, as in resolution matrix 8.
  const manifestPath = join(ctx.profileDir, 'package.json');
  let manifest = readJson(manifestPath);
  delete manifest.dependencies[COMPANION_NAME];
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((n) => n !== COMPANION_NAME);
  writeJson(manifestPath, manifest);
  const removed = loadAndCompose(ctx.home, 'layer5', ctx.installation.anchor);
  assert.equal(baseRouteConfig(removed.entries).opencode, undefined);

  manifest = readJson(manifestPath);
  manifest.dependencies = { ...manifest.dependencies, [COMPANION_NAME]: '*' };
  manifest.dsh.profile.bundles = [...manifest.dsh.profile.bundles, COMPANION_NAME];
  writeJson(manifestPath, manifest);
  installIntoProfile(ctx.profileDir, [{ name: COMPANION_NAME, dir: companionFixtureDir(repoRoot) }]);
  const reinstalled = loadAndCompose(ctx.home, 'layer5', ctx.installation.anchor);
  const providers = baseRouteConfig(reinstalled.entries);
  assert.deepEqual(Object.keys(providers).sort(), BUNDLE_ROUTES);
  const effective = resolveSection(providers, userSection);
  assert.equal(effective.opencode.apiKeyEnv, 'MY_PERSONAL_OPENCODE_KEY');
  assert.equal(effective.zai.apiKeyEnv, 'ZAI_API_KEY');
});

test('layering 6: a same-id row from another adapter family collides fail-loud, not silently', () => {
  const home = temp('home');
  const installation = makeInstallation([makeBaseFixture()]);
  // Another adapter family's bundle also patching the llm-pi-ai row id.
  const other = {
    name: 'other-family-bundle',
    dir: (() => {
      const dir = temp('other-family');
      writeJson(join(dir, 'package.json'), {
        name: 'other-family-bundle',
        version: '1.0.0',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      });
      writeFileSync(join(dir, 'cordis.patch.yml'), [
        '- id: llm-pi-ai',
        "  name: 'com.example/other-llm-adapter'",
        '  config:',
        '    providers:',
        '      opencode:',
        '        apiKeyEnv: OTHER_FAMILY_KEY',
        '',
      ].join('\n'));
      return dir;
    })(),
  };
  const profileDir = makeProfile(home, 'layer6', ['@deepseek-ai/dsh-base', COMPANION_NAME, other.name]);
  installIntoProfile(profileDir, [
    { name: COMPANION_NAME, dir: companionFixtureDir(repoRoot) },
    other,
  ]);
  const manifestPath = join(profileDir, 'package.json');
  const manifest = readJson(manifestPath);
  manifest.dependencies = { ...manifest.dependencies, [COMPANION_NAME]: '*', [other.name]: '*' };
  writeJson(manifestPath, manifest);
  // Capture the composer's warnings: the upstream fail-loud path for a
  // foreign adapter family patching this row is the name guard — the patch
  // is skipped with a "name mismatch" warning, never silently applied.
  const warnings = [];
  const loadedResult = loadAndCompose(home, 'layer6', installation.anchor);
  composeEntries(loadedResult.loaded.layers.map((layer) => layer.patches), (message) => warnings.push(message));
  const nameMismatch = warnings.filter((message) => message.includes('name mismatch'));
  assert.equal(nameMismatch.length > 0, true,
    `the foreign-family patch must be rejected loudly, got warnings: ${JSON.stringify(warnings)}`);
  const row = loadedResult.entries.find((entry) => entry.id === 'llm-pi-ai');
  assert.equal(row.name, '@deepseek-ai/dsh-llm-pi-ai');
  assert.equal(row.config.providers.opencode.apiKeyEnv, 'OPENCODE_API_KEY',
    'the companion config survives; the foreign family never takes ownership');
  // Both claimants stay visible in the layer list — the conflict is
  // inspectable through the layer dump, not hidden.
  const claimants = loadedResult.loaded.layers
    .filter((layer) => layer.patches.some((p) => p.id === 'llm-pi-ai' && p.config));
  assert.equal(claimants.length, 2, 'both claimants stay visible in the layer list');
});

test('layering 7: clean-profile removal alone restores the dormant llm-pi-ai posture', () => {
  const { home, installation, profileDir } = activeBundleProfile('layer7');
  const manifestPath = join(profileDir, 'package.json');
  const manifest = readJson(manifestPath);
  delete manifest.dependencies[COMPANION_NAME];
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((n) => n !== COMPANION_NAME);
  writeJson(manifestPath, manifest);
  const after = loadAndCompose(home, 'layer7', installation.anchor);
  const row = after.entries.find((entry) => entry.id === 'llm-pi-ai');
  assert.ok(row, 'dormant row still mounted by dsh-base');
  assert.equal(row.config, undefined, 'no provider routes — dormant posture');
});

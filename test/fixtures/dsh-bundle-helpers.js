/**
 * Shared fixtures for triss-dsh-provider-bundle acceptance tests.
 *
 * The tests exercise the REAL Harness (dsh) profile machinery —
 * `@deepseek-ai/dsh-app-boot`'s resolveBundleDir / loadProfile /
 * composeEntries — against on-disk profile fixtures, with an isolated
 * DSH_HOME and installation anchors built from real npm tarballs. No
 * credential value is ever read, stored, or logged: fixtures carry only
 * credential REFERENCES (env var names).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  composeEntries, initProfile, loadProfile, resolveProfileDir,
} from '@deepseek-ai/dsh-app-boot';

export const BIN_NAME = 'dsh';
export const COMPANION_NAME = 'triss-dsh-provider-bundle';
export const ROOT_PACKAGE_NAME = 'triss-coworker';
/** pi-ai provider ids the bundle activates (the stable contract). */
export const BUNDLE_ROUTES = ['opencode', 'opencode-go', 'zai'];
/** Credential references named by the bundle patch (never values). */
export const BUNDLE_CREDENTIAL_REFS = {
  opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  zai: 'ZAI_API_KEY',
};

export function temp(prefix) {
  return mkdtempSync(join(tmpdir(), `triss-dsh-${prefix}-`));
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** npm-pack a fixture package directory into a registry-style tarball. */
export function packFixture(pkgDir, workdir) {
  const stdout = execFileSync(
    'npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', workdir],
    { cwd: pkgDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const info = JSON.parse(stdout)[0];
  return { tarball: join(workdir, info.filename), name: info.name, version: info.version };
}

/** Copy the real companion source tree into a fixture package directory. */
export function companionFixtureDir(repoRoot, overrides = {}) {
  const dir = temp('companion-src');
  cpSync(join(repoRoot, 'packages', 'dsh-provider-bundle'), dir, { recursive: true });
  if (overrides.version || overrides.name || overrides.patchText) {
    const manifest = readJson(join(dir, 'package.json'));
    if (overrides.version) manifest.version = overrides.version;
    if (overrides.name) manifest.name = overrides.name;
    if (overrides.dsh !== undefined) manifest.dsh = overrides.dsh;
    writeJson(join(dir, 'package.json'), manifest);
  }
  if (overrides.patchText !== undefined) {
    writeFileSync(join(dir, 'cordis.patch.yml'), overrides.patchText);
  }
  return dir;
}

/**
 * A fake "dsh installation" fixture: a plain directory with node_modules
 * laid out exactly as createRequire(anchor).resolve.paths would search, so
 * resolveBundleDir's installation-first arm sees it. `anchorDir` holds a
 * package.json (the dsh app) whose node_modules holds the given packages.
 */
export function makeInstallation(packages = []) {
  const dir = temp('dsh-install');
  writeJson(join(dir, 'package.json'), { name: 'fake-dsh-app', private: true });
  for (const pkg of packages) {
    const target = join(dir, 'node_modules', pkg.name);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(pkg.dir, target, { recursive: true });
  }
  return { dir, anchor: join(dir, 'package.json') };
}

/** An initialized empty dsh profile under an isolated DSH_HOME. */
export function makeProfile(home, name, bundles = ['@deepseek-ai/dsh-base']) {
  const dir = resolveProfileDir(name, home);
  initProfile(dir, bundles);
  return dir;
}

/** Install fixture packages into a profile directory's node_modules (pnpm-style hoisted layout). */
export function installIntoProfile(profileDir, packages) {
  for (const pkg of packages) {
    const target = join(profileDir, 'node_modules', pkg.name);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(pkg.dir, target, { recursive: true });
  }
}

/**
 * Resolve the companion through the real Harness machinery and return the
 * composed entry list plus the resolved layer, asserting the companion came
 * from the profile's node_modules, never from the installation anchor.
 */
export function loadAndCompose(home, profileName, installAnchor, {
  expectFromProfile = COMPANION_NAME,
} = {}) {
  const profileDir = resolveProfileDir(profileName, home);
  const loaded = loadProfile(BIN_NAME, profileName, installAnchor, home);
  const companionLayer = loaded.layers.find((layer) => layer.packageName === expectFromProfile);
  const anchorCompanion = join(dirname(installAnchor), 'node_modules', expectFromProfile);
  if (companionLayer) {
    assert.equal(
      companionLayer.packageDir.startsWith(profileDir),
      true,
      `companion must resolve from the profile (${companionLayer.packageDir}), not the installation`,
    );
    assert.notEqual(companionLayer.packageDir, anchorCompanion);
  }
  const entries = composeEntries(loaded.layers.map((layer) => layer.patches));
  return { loaded, entries, companionLayer };
}

/** Extract the llm-pi-ai row's provider config from composed entries. */
export function llmPiAiRow(entries) {
  return entries.find((entry) => entry.id === 'llm-pi-ai');
}

/** The three base routes as they must appear in the effective config. */
export function baseRouteConfig(entries) {
  const row = llmPiAiRow(entries);
  const providers = row?.config?.providers ?? {};
  return providers;
}

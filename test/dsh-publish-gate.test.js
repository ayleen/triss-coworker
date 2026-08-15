/**
 * Release-gate tests for the two-package release train (plan §Package and
 * release topology): both manifests share the tag version, both tarballs
 * are inspected, registry verification is safely retryable and fails
 * closed on integrity mismatch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  packAndInspect, verifyRegistryPackage, verifyVersions,
} from '../scripts/publish-gate.js';

const repoRoot = new URL('..', import.meta.url).pathname;

test('both manifests agree on the version and the release tag', () => {
  const { version } = verifyVersions();
  assert.match(version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(verifyVersions({ tag: `v${version}` }), { version, ...verifyVersions() });
  assert.throws(() => verifyVersions({ tag: 'v0.0.0' }), /does not match manifest version/);
});

test('pack-inspect verifies both tarballs against their allowlists', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'publish-gate-test-'));
  const result = packAndInspect({ workdir });
  assert.equal(result.companion.name, 'triss-dsh-provider-bundle');
  assert.equal(result.root.name, 'triss-coworker');
  assert.equal(result.companion.version, result.root.version);
  assert.deepEqual(result.companion.entries, [
    'LICENSE', 'README.md', 'cordis.patch.yml', 'package.json',
  ]);
  assert.equal(
    result.root.entries.some((entry) => entry.startsWith('packages/')
      || entry.includes('cordis.patch.yml')),
    false,
    'root tarball must not carry companion content',
  );
  assert.match(result.companion.sha256, /^[0-9a-f]{64}$/);
});

test('pack-inspect creates a missing --workdir instead of failing ENOENT (P0 review finding)', () => {
  // The publish workflow passes $RUNNER_TEMP/publish-pack, which does not
  // exist on a fresh runner. npm pack never creates the destination
  // directory, so packAndInspect must own it.
  const workdir = join(mkdtempSync(join(tmpdir(), 'publish-gate-test-')), 'nested', 'publish-pack');
  assert.equal(existsSync(workdir), false);
  const result = packAndInspect({ workdir });
  assert.equal(existsSync(join(workdir, `triss-dsh-provider-bundle-${result.companion.version}.tgz`)), true);
  assert.equal(existsSync(join(workdir, `triss-coworker-${result.root.version}.tgz`)), true);
});

test('registry verification reports unpublished versions', async () => {
  const result = await verifyRegistryPackage({ version: '0.34.0', sha256: 'a'.repeat(64) }, {
    fetchJson: async () => ({ status: 404, body: {} }),
  });
  assert.deepEqual(result, { published: false, integrityOk: null });
});

test('registry verification accepts an already-published version only on identical bytes', async () => {
  const bytes = Buffer.from('tarball-bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const accepted = await verifyRegistryPackage({ version: '0.34.0', sha256 }, {
    fetchJson: async () => ({ status: 200, body: { dist: { tarball: 'https://x/t.tgz', integrity } } }),
    fetchBytes: async () => ({ status: 200, bytes }),
  });
  assert.deepEqual(accepted, { published: true, integrityOk: true, sha256 });

  await assert.rejects(
    () => verifyRegistryPackage({ version: '0.34.0', sha256 }, {
      fetchJson: async () => ({ status: 200, body: { dist: { tarball: 'https://x/t.tgz', integrity } } }),
      fetchBytes: async () => ({ status: 200, bytes: Buffer.from('different-bytes') }),
    }),
    /differs from the local artifact/,
  );
});

// ── Safe-retry matrix for BOTH npm packages (P0 review finding) ──────────
// The workflow must be re-runnable when one package is already published
// and the other is not. Publish steps may be skipped ONLY on a verified
// byte-identical registry tarball; any mismatch fails closed.

function registryStub({ published, bytes }) {
  const sha256 = bytes ? createHash('sha256').update(bytes).digest('hex') : null;
  // Honest metadata: integrity is derived from the same bytes the stub serves.
  const integrity = bytes ? `sha512-${createHash('sha512').update(bytes).digest('base64')}` : null;
  return {
    fetchJson: async () => published
      ? { status: 200, body: { dist: { tarball: 'https://x/t.tgz', integrity } } }
      : { status: 404, body: {} },
    fetchBytes: async () => ({ status: 200, bytes }),
    sha256,
  };
}

test('safe-retry matrix: neither / one / both packages published with identical bytes', async () => {
  const localBytes = Buffer.from('local-artifact');
  const localSha = createHash('sha256').update(localBytes).digest('hex');
  const base = { version: '0.35.0', sha256: localSha };

  // neither published → both publish steps must run
  const none = registryStub({ published: false });
  assert.equal((await verifyRegistryPackage(base, none)).published, false);

  // both published with identical bytes → both publish steps may be skipped
  const both = registryStub({ published: true, bytes: localBytes });
  assert.equal((await verifyRegistryPackage(base, both)).published, true);
  assert.equal((await verifyRegistryPackage(base, both)).integrityOk, true);

  // each package is verified independently (companion-only / root-only)
  for (const name of ['triss-dsh-provider-bundle', 'triss-coworker']) {
    const result = await verifyRegistryPackage({ ...base, name }, registryStub({ published: true, bytes: localBytes }));
    assert.equal(result.published, true, `${name} verifies independently`);
  }
});

test('safe-retry matrix: published-but-different bytes fail closed for either package', async () => {
  const localSha = createHash('sha256').update(Buffer.from('local')).digest('hex');
  for (const name of ['triss-dsh-provider-bundle', 'triss-coworker']) {
    await assert.rejects(
      () => verifyRegistryPackage(
        { version: '0.35.0', name, sha256: localSha },
        registryStub({ published: true, bytes: Buffer.from('tampered') }),
      ),
      /differs from the local artifact/,
      `${name} must fail closed on a mismatched registry tarball`,
    );
  }
});

test('registry gate compares sha512 integrity, not just sha256 (misleading check removed)', async () => {
  // dist.integrity is npm's sha512 of the tarball. A gate that accepts an
  // arbitrary integrity string without deriving it is not a check.
  const bytes = Buffer.from('tarball-bytes');
  const localSha = createHash('sha256').update(bytes).digest('hex');
  const realIntegrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const mismatched = { status: 200, body: { dist: { tarball: 'https://x/t.tgz', integrity: realIntegrity.replace(/.$/, 'X') } } };
  await assert.rejects(
    () => verifyRegistryPackage({ version: '0.35.0', sha256: localSha }, {
      fetchJson: async () => mismatched,
      fetchBytes: async () => ({ status: 200, bytes }),
    }),
    /integrity/,
  );
});

test('publish workflow gates both packages from one tag', () => {
  const workflow = readFileSyncWorkflow();
  // Tag-to-version covers BOTH manifests.
  assert.match(workflow, /packages\/dsh-provider-bundle\/package\.json/);
  assert.match(workflow, /publish-gate\.js verify-versions/);
  assert.match(workflow, /publish-gate\.js pack-inspect/);
  // Both npm packages publish with provenance.
  const publishMatches = workflow.match(/npm publish[^\n]*/g) ?? [];
  assert.equal(publishMatches.length, 2, 'exactly two npm publish invocations');
  for (const invocation of publishMatches) {
    assert.match(invocation, /--provenance/);
  }
  // The companion publish runs from its own package directory.
  assert.match(workflow, /working-directory: packages\/dsh-provider-bundle/);
  // Registry verification runs after publication (safe retry).
  assert.match(workflow, /publish-gate\.js verify-registry/);
});

test('publish workflow verifies BOTH packages against the registry before and after publish (P0 review finding)', () => {
  const workflow = readFileSyncWorkflow();
  // The safe-retry contract: each publish step is gated on a verify-registry
  // call for ITS OWN package, and the skip decision is owned by the gate
  // (published + identical bytes), not by an unconditional npm publish that
  // would E409 on re-run.
  const verifyInvocations = workflow.match(/verify-registry[^\n]*/g) ?? [];
  assert.ok(verifyInvocations.length >= 4, `expected >=4 verify-registry invocations (pre+post for both packages), got ${verifyInvocations.length}`);
  for (const invocation of verifyInvocations) {
    assert.match(invocation, /--package (triss-dsh-provider-bundle|triss-coworker)/,
      'every verify-registry call must name its package');
  }
  // Both publish steps are conditional on their own gate outcome.
  const conditionalPublishes = workflow.match(/if: steps\.[a-z-]+\.(outputs\.)?published == 'false'/g) ?? [];
  assert.ok(conditionalPublishes.length >= 2, 'both npm publish steps must be skipped only when their own gate says unpublished');
});

test('README install command version must equal the companion manifest version (P2 review finding)', () => {
  const readme = readFileSync(join(repoRoot, 'packages', 'dsh-provider-bundle', 'README.md'), 'utf8');
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'packages', 'dsh-provider-bundle', 'package.json'), 'utf8'));
  const installCommand = readme.match(/dsh plugin --profile headless add triss-dsh-provider-bundle@([0-9][^\s`<]*)/);
  assert.ok(installCommand, 'README carries a dsh plugin add install command');
  assert.equal(installCommand[1], manifest.version,
    `README pins @${installCommand[1]} but companion manifest is ${manifest.version}`);
});

test('projectRoot does NOT escape .codex worktrees (sandbox boundary, P1 review finding)', async () => {
  const { projectRoot, assertSafePath, setRestricted } = await import('../src/safety.js');
  // A sandbox rooted in one Codex worktree must not reach a sibling worktree.
  // projectRoot() must not step up above the worktree itself.
  const wtA = join(repoRoot, '.codex', 'worktrees', 'task-a');
  const sibling = join(repoRoot, '.codex', 'worktrees', 'task-b', 'secret.txt');
  const savedCwd = process.cwd();
  const savedRestrict = process.env.TRISS_RESTRICT_PATHS;
  const savedRoot = process.env.TRISS_PROJECT_ROOT;
  try {
    mkdirSync(wtA, { recursive: true });
    process.chdir(wtA);
    delete process.env.TRISS_PROJECT_ROOT;
    setRestricted(true);
    assert.equal(projectRoot(), wtA, 'projectRoot stays inside the .codex worktree');
    assert.throws(
      () => assertSafePath(sibling, { kind: 'read' }),
      (err) => err.code === 'TRISS_PATH_DENIED' && /outside the project root/.test(err.message),
      'a sibling worktree file must be denied by the restricted sandbox',
    );
  } finally {
    process.chdir(savedCwd);
    setRestricted(false);
    if (savedRestrict === undefined) delete process.env.TRISS_RESTRICT_PATHS;
    else process.env.TRISS_RESTRICT_PATHS = savedRestrict;
    if (savedRoot === undefined) delete process.env.TRISS_PROJECT_ROOT;
    else process.env.TRISS_PROJECT_ROOT = savedRoot;
  }
});

function readFileSyncWorkflow() {
  return readFileSync(join(repoRoot, '.github', 'workflows', 'publish.yml'), 'utf8');
}

// safety.js is imported lazily inside the async test so the process-global
// env manipulation cannot leak into the other suites sharing this file.

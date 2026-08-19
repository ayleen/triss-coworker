/**
 * Release-gate tests for the two-package release train and
 * release topology): both manifests share the tag version, both tarballs
 * are inspected, registry verification is safely retryable and fails
 * closed on integrity mismatch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  authorizeTagRelease, packAndInspect, planPublication, selectLocalPackage,
  verifyRegistryPackage, verifyVersions,
} from '../scripts/publish-gate.js';

const COMPANION_NAME = 'triss-dsh-provider-bundle';
const ROOT_NAME = 'triss-coworker';

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

test('pack-inspect creates an explicitly passed --workdir that does not exist yet', () => {
  // Publish-workflow scenario (release contract): the runner passes
  // $RUNNER_TEMP/publish-pack, which does not exist on a clean runner.
  // npm pack --pack-destination does NOT create the parent directory
  // (verified on npm 11.6.2), so the gate itself must own mkdir.
  const workdir = join(mkdtempSync(join(tmpdir(), 'publish-gate-missing-')), 'nested', 'publish-pack');
  assert.equal(existsSync(workdir), false, 'precondition: workdir must not exist');
  const result = packAndInspect({ workdir });
  assert.equal(existsSync(join(workdir, result.companion.filename)), true);
  assert.equal(existsSync(join(workdir, result.root.filename)), true);
  assert.match(result.companion.sha256, /^[0-9a-f]{64}$/);
  assert.match(result.root.sha256, /^[0-9a-f]{64}$/);
});

test('registry verification reports unpublished versions', async () => {
  for (const name of [COMPANION_NAME, ROOT_NAME]) {
    const result = await verifyRegistryPackage({ name, version: '0.34.0', sha256: 'a'.repeat(64) }, {
      fetchJson: async () => ({ status: 404, body: {} }),
    });
    assert.deepEqual(result, { name, published: false, integrityOk: null });
  }
});

test('registry verification accepts an already-published version only on identical bytes', async () => {
  const bytes = Buffer.from('tarball-bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const sri = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const fetchJson = async () => ({ status: 200, body: { dist: { tarball: 'https://x/t.tgz', integrity: sri } } });
  const fetchBytes = async () => ({ status: 200, bytes });
  for (const name of [COMPANION_NAME, ROOT_NAME]) {
    const accepted = await verifyRegistryPackage({ name, version: '0.34.0', sha256 }, {
      fetchJson, fetchBytes,
    });
    assert.deepEqual(accepted, { name, published: true, integrityOk: true, sha256 });

    await assert.rejects(
      () => verifyRegistryPackage({ name, version: '0.34.0', sha256 }, {
        fetchJson,
        fetchBytes: async () => ({ status: 200, bytes: Buffer.from('different-bytes') }),
      }),
      /differs from the local artifact/,
    );
  }
});

test('registry verification fails closed on a malformed or lying dist.integrity', async () => {
  const bytes = Buffer.from('tarball-bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const url = 'https://x/t.tgz';
  // Malformed shape (the old gate accepted "sha512-abc" here — release contract).
  await assert.rejects(
    () => verifyRegistryPackage({ name: COMPANION_NAME, version: '0.34.0', sha256 }, {
      fetchJson: async () => ({ status: 200, body: { dist: { tarball: url, integrity: 'sha512-abc' } } }),
      fetchBytes: async () => ({ status: 200, bytes }),
    }),
    /malformed/,
  );
  // Well-formed SRI but NOT the hash of the bytes actually served.
  const lyingSri = `sha512-${createHash('sha512').update(Buffer.from('other')).digest('base64')}`;
  await assert.rejects(
    () => verifyRegistryPackage({ name: ROOT_NAME, version: '0.34.0', sha256 }, {
      fetchJson: async () => ({ status: 200, body: { dist: { tarball: url, integrity: lyingSri } } }),
      fetchBytes: async () => ({ status: 200, bytes }),
    }),
    /does not match the registry tarball bytes/,
  );
});

test('retry matrix: plan-publish publishes only what is missing, for either package', async () => {
  const manifest = {
    companion: { name: COMPANION_NAME, version: '0.35.0', sha256: 'c'.repeat(64) },
    root: { name: ROOT_NAME, version: '0.35.0', sha256: 'r'.repeat(64) },
  };
  const sri = (b) => `sha512-${createHash('sha512').update(b).digest('base64')}`;
  const companionBytes = Buffer.from('companion-tarball');
  const rootBytes = Buffer.from('root-tarball');
  // Local sha256 must equal the registry-served bytes for the "identical
  // bytes" branch; make the local inputs match the served tarball hashes.
  manifest.companion.sha256 = createHash('sha256').update(companionBytes).digest('hex');
  manifest.root.sha256 = createHash('sha256').update(rootBytes).digest('hex');
  const registryFor = (published) => async (url) => {
    const name = url.includes(`/${ROOT_NAME}/`) ? ROOT_NAME : COMPANION_NAME;
    if (!published[name]) return { status: 404, body: {} };
    const bytes = name === ROOT_NAME ? rootBytes : companionBytes;
    return { status: 200, body: { dist: { tarball: `https://x/${name}.tgz`, integrity: sri(bytes) } } };
  };
  const bytesFor = async (url) => {
    const bytes = url.includes(`${ROOT_NAME}.tgz`) ? rootBytes : companionBytes;
    return { status: 200, bytes };
  };
  const cases = [
    { title: 'nothing published → publish both', published: {}, want: { companion: true, root: true } },
    { title: 'companion published, root not → publish only root', published: { [COMPANION_NAME]: true }, want: { companion: false, root: true } },
    { title: 'root published, companion not → publish only companion', published: { [ROOT_NAME]: true }, want: { companion: true, root: false } },
    { title: 'both published with identical bytes → publish nothing', published: { [COMPANION_NAME]: true, [ROOT_NAME]: true }, want: { companion: false, root: false } },
  ];
  for (const c of cases) {
    const plan = await planPublication(manifest, {
      fetchJson: registryFor(c.published),
      fetchBytes: bytesFor,
    });
    assert.deepEqual(plan.actions, {
      publishCompanion: c.want.companion,
      publishRoot: c.want.root,
    }, c.title);
  }
  // Mismatched bytes for an already-published package must fail closed…
  await assert.rejects(
    () => planPublication(manifest, {
      fetchJson: registryFor({ [COMPANION_NAME]: true }),
      fetchBytes: async () => ({ status: 200, bytes: Buffer.from('tampered') }),
    }),
    /differs from the local artifact/,
  );
  // …for either package, including the root.
  await assert.rejects(
    () => planPublication(manifest, {
      fetchJson: registryFor({ [ROOT_NAME]: true }),
      fetchBytes: async () => ({ status: 200, bytes: Buffer.from('tampered') }),
    }),
    /differs from the local artifact/,
  );
});

test('publish workflow gates both packages from one tag', () => {
  const workflow = readFileSyncWorkflow();
  // Tag-to-version covers BOTH manifests.
  assert.match(workflow, /packages\/dsh-provider-bundle\/package\.json/);
  assert.match(workflow, /publish-gate\.js verify-versions/);
  assert.match(workflow, /publish-gate\.js pack-inspect/);
  // Safe retry: publication is PLANNED from live registry state for BOTH
  // packages, publish steps are conditional on the gates job's plan outputs
  // (release contract), and the fresh-vs-retry tag authorization runs in the
  // unprivileged release-gates job, before any publish credentials exist.
  assert.match(workflow, /publish-gate\.js plan-publish/);
  assert.match(workflow, /publish-gate\.js authorize-tag/);
  assert.match(workflow, /merge-base --is-ancestor/);
  assert.match(workflow, /if: needs\.release-gates\.outputs\.publish_companion == 'true'/);
  assert.match(workflow, /if: needs\.release-gates\.outputs\.publish_root == 'true'/);
  const publishMatches = workflow.match(/npm publish[^\n]*/g) ?? [];
  assert.equal(publishMatches.length, 2, 'exactly two npm publish invocations');
  for (const invocation of publishMatches) {
    assert.match(invocation, /--provenance/);
    assert.match(invocation, /--ignore-scripts/);
  }
  // The companion publish runs from its own package directory.
  assert.match(workflow, /working-directory: packages\/dsh-provider-bundle/);
  // The published bytes are the verified bytes: the publish job repacks with
  // scripts disabled and byte-compares against the gates artifact (review
  // release-integrity contract).
  assert.match(workflow, /Repack and byte-verify both tarballs against the gates artifact/);
  assert.match(workflow, /sha256sum/);
});

test('id-token lives only in the minimal publish job behind npm-production', () => {
  const workflow = readFileSyncWorkflow();
  const jobBlocks = workflow.split(/\n {2}(?=[a-z][a-z0-9-]*:)/);
  // Anchored to the actual permissions entry so prose comments about
  // id-token do not count.
  const withIdToken = jobBlocks.filter((block) => /^ {6}id-token: write$/m.test(block));
  assert.equal(withIdToken.length, 1, 'exactly one job may hold id-token: write');
  assert.match(withIdToken[0], /^npm-publish:/, 'the id-token job must be npm-publish');
  assert.match(withIdToken[0], /environment: npm-production/,
    'the publish job must run behind the npm-production environment');
  assert.equal(/publish-gate\.js/.test(withIdToken[0]), false,
    'the privileged job must not run repository scripts');
  assert.match(withIdToken[0], /needs: \[release-gates\]/,
    'the privileged job must depend on the unprivileged gates');
});

test('publish workflow creates the pack workdir before the pack-inspect | tee pipeline', () => {
  const workflow = readFileSyncWorkflow();
  // Both sides of a shell pipeline start concurrently: unless mkdir -p runs
  // BEFORE the pipeline, tee opens local-manifest.json before Node gets to
  // its own mkdirSync() and dies with ENOENT (release contract — reproduced 20/20
  // on the runner shell; pack-inspect's internal mkdir cannot help its own
  // stdout consumer).
  const step = workflow.match(
    /name: Inspect both packed tarballs before publishing\n\s+run: \|\n([\s\S]*?)(?=\n\s+- name:)/,
  )?.[1];
  assert.ok(step, 'the pack-inspect step must exist in publish.yml');
  const mkdirIndex = step.indexOf('mkdir -p "$RUNNER_TEMP/publish-pack"');
  const pipelineIndex = step.indexOf('node scripts/publish-gate.js pack-inspect');
  assert.ok(mkdirIndex !== -1, 'the pack-inspect step must mkdir -p the workdir itself');
  assert.ok(pipelineIndex !== -1, 'the step must run pack-inspect');
  assert.ok(mkdirIndex < pipelineIndex, 'mkdir -p must precede the pack-inspect | tee pipeline');
});

test('publish workflow runs registry acceptance on the published package before releasing', () => {
  const workflow = readFileSyncWorkflow();
  // Plan step 16 (automatable half): the published REGISTRY package must be
  // installed into fresh profiles — not re-packed locally — before the GitHub
  // release is created (release contract).
  assert.match(workflow, /registry-acceptance:/);
  assert.match(workflow, /dsh plugin --profile headless add -w "triss-dsh-provider-bundle@\$\{VERSION\}"/);
  assert.match(workflow, /dsh plugin --profile headless remove triss-dsh-provider-bundle/);
  // Provenance is verified, not assumed: attestations are read from
  // dist.attestations (where npm/pacote store them) AND checked
  // cryptographically via npm audit signatures.
  assert.match(workflow, /dist\?\.attestations/);
  assert.match(workflow, /npm audit signatures --json --include-attestations/);
  // The compatibility tuple is fail-closed and backed by artifacts: the
  // profile pnpm list and lockfile are saved, and any missing field fails
  // the job; missing attestations must fail publication.
  assert.match(workflow, /pnpm --dir "\$PROFILE" list --depth Infinity --json/);
  assert.match(workflow, /compatibility tuple is incomplete/);
  assert.match(workflow, /pnpm-list\.json[\s\S]*pnpm-lock\.yaml[\s\S]*audit-signatures\.json/);
  const releaseNeeds = workflow.match(/release:\n {4}needs: \[([^\]]+)\]/)?.[1];
  assert.ok(releaseNeeds, 'release job must declare its needs');
  for (const needed of ['standalone-smoke', 'npm-publish', 'registry-acceptance']) {
    assert.ok(
      releaseNeeds.split(',').map((s) => s.trim()).includes(needed),
      `release job must wait for ${needed}`,
    );
  }
});

test('registry verification fails closed when dist.integrity is absent', async () => {
  const bytes = Buffer.from('tarball-bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await assert.rejects(
    () => verifyRegistryPackage({ name: COMPANION_NAME, version: '0.35.0', sha256 }, {
      fetchJson: async () => ({ status: 200, body: { dist: { tarball: 'https://x/t.tgz' } } }),
      fetchBytes: async () => ({ status: 200, bytes }),
    }),
    /carries no dist\.integrity/,
  );
});

test('tag authorization: fresh requires exact main, retry accepts an ancestor', () => {
  const plan = (companion, root) => ({
    companion: { published: companion }, root: { published: root },
  });
  // Fresh release: nothing published — only the exact origin/main tip authorizes.
  assert.deepEqual(authorizeTagRelease(plan(false, false), { exactMain: true, ancestorMain: true }), { mode: 'fresh' });
  assert.throws(
    () => authorizeTagRelease(plan(false, false), { exactMain: false, ancestorMain: true }),
    /fresh release authorization failed: neither package is published/,
  );
  // Invariant §1 scenario: companion published + root missing + main
  // advanced past the tag — the retry MUST stay authorized.
  assert.deepEqual(
    authorizeTagRelease(plan(true, false), { exactMain: false, ancestorMain: true }),
    { mode: 'retry' },
  );
  // Fully published train, main advanced — retry for release completion.
  assert.deepEqual(
    authorizeTagRelease(plan(true, true), { exactMain: false, ancestorMain: true }),
    { mode: 'retry' },
  );
  // A tag that left main's history entirely authorizes nothing.
  assert.throws(
    () => authorizeTagRelease(plan(true, false), { exactMain: false, ancestorMain: false }),
    /retry authorization failed/,
  );
  assert.throws(
    () => authorizeTagRelease({ companion: {} }, { exactMain: true, ancestorMain: true }),
    /'companion\.published' missing/,
  );
});

test('verify-registry resolves the local package from either manifest shape', () => {
  const direct = { name: ROOT_NAME, version: '0.35.0', sha256: 'a'.repeat(64) };
  assert.equal(selectLocalPackage(direct), direct,
    'a direct {name, version, sha256} object passes through untouched');
  const packInspect = {
    ok: true,
    companion: { name: COMPANION_NAME, version: '0.35.0', sha256: 'b'.repeat(64) },
    root: direct,
  };
  assert.equal(selectLocalPackage(packInspect, 'companion'), packInspect.companion,
    '--package companion selects the companion entry of a pack-inspect manifest');
  assert.equal(selectLocalPackage(packInspect, 'root'), packInspect.root,
    '--package root selects the root entry');
  // The old CLI died on the pack-inspect manifest with a confusing
  // "expects name …, got undefined" — the selector must fail loud and helpful.
  assert.throws(
    () => selectLocalPackage(packInspect, undefined),
    /--package companion or --package root/,
  );
});

test('CHANGELOG integrity section pins the exact companion tarball bytes', () => {
  // `npm pack` output is byte-deterministic (tar entries carry the fixed npm
  // epoch mtime; verified identical across repeated runs and across npm
  // 10.9.8 and 11.6.2), so the recorded release evidence must match the
  // packed artifact exactly. A README edit after recording the hash used to
  // silently invalidate the evidence (release contract) — this test makes that a
  // hard failure.
  const result = packAndInspect();
  const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const headerPattern = `### Artifact integrity \\(${result.companion.version}\\)`;
  const headers = changelog.match(new RegExp(headerPattern, 'g')) ?? [];
  assert.equal(headers.length, 1,
    `expected exactly one Artifact integrity section for ${result.companion.version}, found ${headers.length}`);
  const section = changelog.match(new RegExp(`${headerPattern}[\\s\\S]*?(?=\\n### |\\n## )`))?.[0];
  assert.ok(section, `Artifact integrity section for ${result.companion.version} must exist`);
  assert.ok(section.includes(result.companion.sha256),
    `recorded sha256 does not match the packed tarball (${result.companion.sha256})`);
  const sri = `sha512-${createHash('sha512').update(readFileSync(result.companion.path)).digest('base64')}`;
  assert.ok(section.includes(sri),
    `recorded sha512 integrity does not match the packed tarball (${sri})`);
});

function readFileSyncWorkflow() {
  return readFileSync(join(repoRoot, '.github', 'workflows', 'publish.yml'), 'utf8');
}

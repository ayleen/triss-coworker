/**
 * Release-gate tests for the two-package release train (plan §Package and
 * release topology): both manifests share the tag version, both tarballs
 * are inspected, registry verification is safely retryable and fails
 * closed on integrity mismatch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  packAndInspect, verifyRegistryCompanion, verifyVersions,
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

test('registry verification reports unpublished versions', async () => {
  const result = await verifyRegistryCompanion({ version: '0.34.0', sha256: 'a'.repeat(64) }, {
    fetchJson: async () => ({ status: 404, body: {} }),
  });
  assert.deepEqual(result, { published: false, integrityOk: null });
});

test('registry verification accepts an already-published version only on identical bytes', async () => {
  const bytes = Buffer.from('tarball-bytes');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const accepted = await verifyRegistryCompanion({ version: '0.34.0', sha256 }, {
    fetchJson: async () => ({ status: 200, body: { dist: { tarball: 'https://x/t.tgz', integrity: 'sha512-abc' } } }),
    fetchBytes: async () => ({ status: 200, bytes }),
  });
  assert.deepEqual(accepted, { published: true, integrityOk: true, sha256 });

  await assert.rejects(
    () => verifyRegistryCompanion({ version: '0.34.0', sha256 }, {
      fetchJson: async () => ({ status: 200, body: { dist: { tarball: 'https://x/t.tgz', integrity: 'sha512-abc' } } }),
      fetchBytes: async () => ({ status: 200, bytes: Buffer.from('different-bytes') }),
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

function readFileSyncWorkflow() {
  return readFileSync(join(repoRoot, '.github', 'workflows', 'publish.yml'), 'utf8');
}

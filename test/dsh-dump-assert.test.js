/**
 * dsh-dump-assert tests: route assertions must parse
 * the dumped llm-pi-ai.config.providers object instead of grepping
 * substrings. The negative fixtures are the exact false-positive shapes the
 * reviewer reproduced: a dump missing the standalone opencode route, a
 * post-removal dump still carrying zai, a mis-bound credential, and an
 * update that dropped one of the original routes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = new URL('..', import.meta.url).pathname;
const script = join(repoRoot, 'scripts', 'dsh-dump-assert.js');

const PRESENT_ROW = [
  '# == @deepseek-ai/dsh-base, patched by triss-dsh-provider-bundle',
  '- id: llm-pi-ai',
  "  name: '@deepseek-ai/dsh-llm-pi-ai'",
  '  config:',
  '    providers:',
  '      opencode:',
  '        apiKeyEnv: OPENCODE_API_KEY',
  '      opencode-go:',
  '        apiKeyEnv: OPENCODE_API_KEY',
  '      zai:',
  '        apiKeyEnv: ZAI_API_KEY',
].join('\n');

const NEIGHBOR_ROWS = [
  '- id: session-persistence-jsonl',
  "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
  '  config:',
  "    root: !!js dshHomePath('sessions')",
  '- id: session-query-sqlite',
  "  name: '@deepseek-ai/dsh-session-query-sqlite'",
  '  config:',
  "    path: ':memory:'",
  '    openAt: never',
].join('\n');

function runAssert(mode, dump) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dump-assert-'));
  const dumpPath = join(dir, 'dump.yml');
  writeFileSync(dumpPath, dump);
  try {
    return spawnSync(process.execPath, [script, mode, dumpPath], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('present accepts the real dump shape and rejects partial configurations', () => {
  const ok = runAssert('present', `${PRESENT_ROW}\n${NEIGHBOR_ROWS}\n`);
  assert.equal(ok.status, 0, `real shape must pass:\n${ok.stderr}`);

  // Negative (reviewer-reproduced): only opencode-go and zai — `grep
  // opencode` used to pass on the substring of opencode-go.
  const noStandaloneOpencode = PRESENT_ROW.replace(
    '      opencode:\n        apiKeyEnv: OPENCODE_API_KEY\n',
    '',
  );
  assert.notEqual(
    runAssert('present', noStandaloneOpencode).status, 0,
    'a dump without the standalone opencode route must fail',
  );

  // Negative: opencode mis-bound to the zai credential.
  const misBound = PRESENT_ROW.replace(
    '      opencode:\n        apiKeyEnv: OPENCODE_API_KEY',
    '      opencode:\n        apiKeyEnv: ZAI_API_KEY',
  );
  assert.notEqual(
    runAssert('present', misBound).status, 0,
    'opencode carrying ZAI_API_KEY must fail',
  );

  // Negative: an extra unexpected provider (exact set, not subset).
  const extraProvider = PRESENT_ROW.replace(
    '      zai:\n        apiKeyEnv: ZAI_API_KEY',
    '      zai:\n        apiKeyEnv: ZAI_API_KEY\n      rogue:\n        apiKeyEnv: WHATEVER',
  );
  assert.notEqual(runAssert('present', extraProvider).status, 0);
});

test('updated requires the three original routes plus the v2 marker', () => {
  const updated = PRESENT_ROW.replace(
    '      zai:\n        apiKeyEnv: ZAI_API_KEY',
    '      zai:\n        apiKeyEnv: ZAI_API_KEY\n      lifecycle-marker-v2:\n        apiKeyEnv: LIFECYCLE_MARKER_V2',
  );
  assert.equal(runAssert('updated', updated).status, 0, 'three routes + marker must pass');

  // Negative: update dropped one of the original routes — marker alone
  // must not satisfy the assertion.
  const droppedOpencode = updated.replace(
    '      opencode:\n        apiKeyEnv: OPENCODE_API_KEY\n',
    '',
  );
  const result = runAssert('updated', droppedOpencode);
  assert.notEqual(result.status, 0, 'an update that drops opencode must fail');
  assert.match(result.stderr, /providers mismatch/);
});

test('absent rejects residual routes and residual credential references', () => {
  const bareRow = '- id: llm-pi-ai\n  name: \'@deepseek-ai/dsh-llm-pi-ai\'\n';
  assert.equal(runAssert('absent', `${bareRow}${NEIGHBOR_ROWS}\n`).status, 0,
    'a row with no providers block is the clean dormant posture');

  // Negative (reviewer-reproduced): after remove, zai with ZAI_API_KEY
  // survived — grep for OPENCODE_API_KEY alone could not see it.
  const residualZai = [
    '- id: llm-pi-ai',
    "  name: '@deepseek-ai/dsh-llm-pi-ai'",
    '  config:',
    '    providers:',
    '      zai:',
    '        apiKeyEnv: ZAI_API_KEY',
  ].join('\n');
  const result = runAssert('absent', residualZai);
  assert.notEqual(result.status, 0, 'a residual zai route must fail');
  assert.match(result.stderr, /zai.*still present|still references/);
});

test('malformed dumps fail closed', () => {
  const tabbed = PRESENT_ROW.replace('      opencode:', '\t  opencode:');
  assert.notEqual(runAssert('present', tabbed).status, 0);
  const unknownMode = runAssert('sometimes', PRESENT_ROW);
  assert.notEqual(unknownMode.status, 0);
  assert.match(unknownMode.stderr, /unknown mode/);
});

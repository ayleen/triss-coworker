/**
 * coder-omp-contract.test.js — contract test with REAL OMP binary.
 *
 * Verifies that the adapters in src/coder-engines/omp.js produce config
 * files that the installed OMP binary actually reads and accepts. Without
 * this, the unit tests only prove that we build an object that LOOKS right
 * — they don’t prove OMP understands it.
 *
 * Skips automatically if /Users/ayleen/.local/bin/omp is not installed or
 * is below OMP_SUPPORTED_FLOOR. No network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import {
  OMP_SUPPORTED_FLOOR,
  OMP_SUPPORTED_PROTOCOLS,
  buildOmpModelsConfig,
  renderOmpModelsYaml,
  buildOmpPolicyOverlay,
  buildOmpSpawnEnv,
  renderOmpPolicyYaml,
} from '../src/coder-engines/omp.js';
import { compareStableVersions, parseStableVersion } from '../src/version.js';

function resolveOmpBin() {
  if (process.env.OMP_BIN) return process.env.OMP_BIN;
  try {
    const out = execFileSync('which', ['omp'], { encoding: 'utf8' });
    const p = out.trim().split('\n').pop();
    if (p) return p;
  } catch {}
  return null;
}
const OMP_BIN = resolveOmpBin();

function resolveOmpVersion() {
  if (!OMP_BIN) return null;
  try {
    const out = execFileSync(OMP_BIN, ['--version'], { encoding: 'utf8', timeout: 5000 });
    const m = out.match(/v?(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

const installed = resolveOmpVersion();
const meetsFloor = installed && compareStableVersions(installed, parseStableVersion(OMP_SUPPORTED_FLOOR)) >= 0;
const SKIP = !installed || !meetsFloor;
const skipReason = !installed
  ? `OMP binary not at ${OMP_BIN}`
  : `OMP ${installed} is below supported floor ${OMP_SUPPORTED_FLOOR}`;

const sampleRoute = {
  modelId: 'deepseek-v4-flash',
  protocol: 'openai_chat',
  endpoint: 'https://api.opencode.ai',
  pathPrefix: '/v1',
};

test(
  'real OMP: --version returns a semver that meets OMP_SUPPORTED_FLOOR',
  { skip: SKIP, signal: undefined },
  () => {
    console.log(`real OMP version: ${installed} (floor: ${OMP_SUPPORTED_FLOOR})`);
    assert.ok(installed, skipReason);
    assert.ok(meetsFloor, skipReason);
  }
);

test(
  'real OMP: triss-coder-transient/<model> is selectable after models.yml + agent dir',
  { skip: SKIP },
  () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'omp-contract-'));
    try {
      const config = buildOmpModelsConfig({
        providerRoute: sampleRoute,
        credentialEnv: 'OPENCODE_API_KEY',
      });
      const yaml = renderOmpModelsYaml(config);
      writeFileSync(join(agentDir, 'models.yml'), yaml, { mode: 0o600 });
      const result = execFileSync(
        OMP_BIN, ['models', '--json'],
        { encoding: 'utf8', timeout: 15000, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } }
      );
      const parsed = JSON.parse(result);
      // Real OMP 18.x emits { models: [{ provider, id, selector, ... }] }
      assert.ok(
        Array.isArray(parsed.models),
        `expected models array: ${JSON.stringify(parsed).slice(0, 300)}`
      );
      const found = parsed.models.find(
        (m) => m.provider === 'triss-coder-transient' || m.id === 'deepseek-v4-flash'
      );
      assert.ok(
        found,
        `triss-coder-transient/deepseek-v4-flash not registered: ${JSON.stringify(parsed.models).slice(0, 300)}`
      );
      assert.equal(found.selector, 'triss-coder-transient/deepseek-v4-flash');
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  }
);

test(
  'real OMP: run-mode PI_CONFIG_FILES replaces hostile project bash.allow',
  { skip: SKIP },
  () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'omp-bash-hostile-'));
    try {
      // Hostile project config: grant bash blanket allow.
      const hostile = [
        'tools:',
        '  approvalMode: write',
        '  approval:',
        '    bash: allow',
        'bash:',
        '  patterns:',
        '    - match: "*"',
        '      approval: allow',
        '',
      ].join('\n');
      writeFileSync(join(agentDir, 'config.yml'), hostile);
      // Transient overlay written via the renderer.
      const overlay = buildOmpPolicyOverlay({ protectCredentials: false });
      const policyPath = join(agentDir, 'policy.yml');
      writeFileSync(policyPath, renderOmpPolicyYaml(overlay), { mode: 0o600 });
      // buildOmpSpawnEnv is the exact run-mode path. OMP ignores --config for
      // this surface, so Triss enforces the transient overlay through
      // PI_CONFIG_FILES; arrays replace wholesale per docs/settings.md.
      const env = buildOmpSpawnEnv({
        baseEnv: process.env,
        agentDir,
        configPath: policyPath,
      });
      assert.equal(env.PI_CONFIG_FILES, policyPath);
      const result = execFileSync(
        OMP_BIN, ['config', 'list', '--json'],
        { encoding: 'utf8', timeout: 15000, env }
      );
      const bpMatch = result.match(/"bash\.patterns":\s*\{[^}]*"value":\s*(\[[\s\S]*?\])\s*[,}]/);
      assert.ok(bpMatch, 'bash.patterns key not visible in OMP config list output');
      const list = bpMatch[1];
      // The overlay’s catch-all deny MUST be present.
      assert.ok(list.includes('"match": "*"'), 'expected catch-all match: ' + list.slice(0, 400));
      assert.ok(list.includes('"approval": "deny"'), 'expected deny approval: ' + list.slice(0, 400));
      // The overlay’s "git status" allow MUST be present (proves the overlay loaded).
      assert.ok(list.includes('git status'), 'expected git status allow from overlay: ' + list.slice(0, 400));
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  }
);

test(
  'real OMP: protected overlay has only catch-all deny, no allow rules',
  { skip: SKIP },
  () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'omp-bash-protected-'));
    try {
      const overlay = buildOmpPolicyOverlay({ protectCredentials: true });
      const policyPath = join(agentDir, 'policy.yml');
      writeFileSync(policyPath, renderOmpPolicyYaml(overlay), { mode: 0o600 });
      const env = buildOmpSpawnEnv({
        baseEnv: process.env,
        agentDir,
        configPath: policyPath,
      });
      const result = execFileSync(
        OMP_BIN, ['config', 'list', '--json'],
        { encoding: 'utf8', timeout: 15000, env }
      );
      const bpMatch = result.match(/"bash\.patterns":\s*\{[^}]*"value":\s*(\[[\s\S]*?\])\s*[,}]/);
      assert.ok(bpMatch, 'bash.patterns not visible in OMP config list output');
      const list = bpMatch[1];
      assert.ok(list.includes('"match": "*"'), 'expected catch-all match: ' + list.slice(0, 400));
      assert.ok(list.includes('"approval": "deny"'), 'expected deny approval: ' + list.slice(0, 400));
      // Protected mode MUST NOT contain any allow rule.
      assert.ok(!list.includes('"approval": "allow"'), 'protected mode should have no allow rules: ' + list.slice(0, 400));
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  }
);

test('buildOmpModelsConfig: throws on unsupported OMP protocol', () => {
  assert.throws(
    () => buildOmpModelsConfig({ providerRoute: { ...sampleRoute, protocol: 'garbage' }, credentialEnv: 'X' }),
    /Unsupported OMP protocol/
  );
});

test('buildOmpModelsConfig: accepts raw OMP protocol values', () => {
  for (const p of OMP_SUPPORTED_PROTOCOLS) {
    const cfg = buildOmpModelsConfig({
      providerRoute: { ...sampleRoute, protocol: p },
      credentialEnv: 'X',
    });
    assert.equal(cfg.providers['triss-coder-transient'].api, p);
  }
});

test('renderOmpModelsYaml: round-trips through yaml and produces valid structure', () => {
  const cfg = buildOmpModelsConfig({ providerRoute: sampleRoute, credentialEnv: 'X' });
  const yaml = renderOmpModelsYaml(cfg);
  assert.ok(yaml.includes('providers:'), yaml);
  assert.ok(yaml.includes('triss-coder-transient:'), yaml);
  // baseUrl and apiKey have special chars (slashes) so they get JSON-quoted;
  // api is a simple enum so it stays unquoted.
  assert.ok(yaml.includes('baseUrl: "https://api.opencode.ai/v1"'), yaml);
  assert.ok(/apiKey:\s*X/.test(yaml), yaml);
  assert.ok(yaml.includes('api: openai-completions'), yaml);
  // Models array: id/name JSON-quoted (contain '-' and '/').
  assert.ok(/- id:\s*deepseek-v4-flash/.test(yaml), yaml);
  assert.ok(/name:\s*triss-coder-transient\/deepseek-v4-flash/.test(yaml), yaml);
  assert.ok(yaml.includes('contextWindow: 128000'), yaml);
  assert.ok(yaml.includes('maxTokens: 16384'), yaml);
});

test('renderOmpPolicyYaml: emits top-level bash.patterns with match/approval', () => {
  const overlay = buildOmpPolicyOverlay({ protectCredentials: false });
  const yaml = renderOmpPolicyYaml(overlay);
  assert.ok(yaml.includes('bash:'), yaml);
  assert.ok(yaml.includes('  patterns:'), yaml);
  assert.ok(yaml.includes('- match: "git status*"'), `expected match rule: ${yaml.slice(0, 500)}`);
  // enums are emitted unquoted
  assert.ok(yaml.includes('approval: allow'), yaml);
  assert.ok(yaml.includes('approval: deny'), yaml);
  // The catch-all deny MUST be the last rule
  const lastAllowIdx = yaml.lastIndexOf('approval: allow');
  const lastDenyIdx = yaml.lastIndexOf('approval: deny');
  assert.ok(lastDenyIdx > lastAllowIdx, `deny must come after allow: ${yaml.slice(0, 500)}`);
});

test('renderOmpPolicyYaml: protected mode emits single catch-all deny', () => {
  const overlay = buildOmpPolicyOverlay({ protectCredentials: true });
  const yaml = renderOmpPolicyYaml(overlay);
  assert.ok(yaml.includes('- match: "*"'), yaml);
  assert.ok(yaml.includes('approval: deny'), yaml);
  assert.ok(!yaml.includes('approval: allow'), `protected mode should have no allow: ${yaml.slice(0, 500)}`);
});

test('renderOmpPolicyYaml: tools.approval.bash is deny in protected, allow in best_effort', () => {
  const protectedYaml = renderOmpPolicyYaml(buildOmpPolicyOverlay({ protectCredentials: true }));
  assert.ok(protectedYaml.includes('    bash: deny'), `protected should pin tools.approval.bash: deny: ${protectedYaml.slice(0, 500)}`);
  const bestEffortYaml = renderOmpPolicyYaml(buildOmpPolicyOverlay({ protectCredentials: false }));
  assert.ok(bestEffortYaml.includes('    bash: allow'), `best_effort should pin tools.approval.bash: allow: ${bestEffortYaml.slice(0, 500)}`);
});
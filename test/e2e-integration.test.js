/**
 * Multi-module E2E integration tests — no real network, no external processes.
 * Each scenario exercises a user-visible flow across two or more source modules.
 * See test-plan-main.md "Cross-Service E2E Tests".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmp(prefix = 'triss-e2e-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * Capture a set of env keys and return a restore callback.
 * Handles undefined (previously unset) correctly.
 */
function envSnapshot(keys) {
  const before = {};
  for (const k of keys) before[k] = process.env[k];
  return () => {
    for (const k of keys) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  };
}

// ─── 1. Wizard write → status read ──────────────────────────────────────────
//
// Simulates `triss config set TRISS_WORKER_API_KEY=sk-foo` then verifies
// getConfig() returns the value from the written file.

test('config set TRISS_WORKER_API_KEY then getConfig returns it', async () => {
  const tmp = makeTmp('triss-config-rw-');
  const configDir = join(tmp, '.config', 'triss');
  mkdirSync(configDir, { recursive: true });
  const globalEnvFile = join(configDir, '.env');
  writeFileSync(globalEnvFile, '');

  // Run the body from a fresh project dir so a contributor's local
  // .triss.env in the repo root does not leak into getConfig() and shadow
  // the value we just wrote to the global file.
  const projectDir = makeTmp('triss-config-rw-proj-');
  const originalCwd = process.cwd();
  const restore = envSnapshot(['TRISS_WORKER_API_KEY', 'HOME']);
  // Point HOME to our tmp dir so getEnvFilePath('global') resolves there.
  process.env.HOME = tmp;
  delete process.env.TRISS_WORKER_API_KEY; // avoid process.env winning over file
  process.chdir(projectDir);

  try {
    // Import setVar fresh so it picks up the redirected HOME.
    const { setVar } = await import(`../src/secrets.js?config-rw-${Date.now()}`);
    setVar(globalEnvFile, 'TRISS_WORKER_API_KEY', 'sk-foo');

    // getConfig reads env files then overlays process.env.
    const { getConfig } = await import(`../src/config.js?config-rw-${Date.now()}`);
    const cfg = getConfig();
    assert.equal(cfg.apiKey, 'sk-foo', `Expected apiKey=sk-foo, got ${cfg.apiKey}`);
  } finally {
    process.chdir(originalCwd);
    restore();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ─── 2. Project-local override wins over global ───────────────────────────────
//
// Global env has TRISS_WORKER_API_KEY=global-key; project .triss.env has
// TRISS_WORKER_API_KEY=local-key. getConfig() must return the local one.

test('project .triss.env overrides global TRISS_WORKER_API_KEY', async () => {
  const tmp = makeTmp('triss-local-override-');
  const globalDir = join(tmp, '.config', 'triss');
  mkdirSync(globalDir, { recursive: true });
  const globalEnvFile = join(globalDir, '.env');
  writeFileSync(globalEnvFile, 'TRISS_WORKER_API_KEY=global-key\n');

  // Write a project-local .triss.env in a separate project dir.
  const projectDir = makeTmp('triss-project-');
  writeFileSync(join(projectDir, '.triss.env'), 'TRISS_WORKER_API_KEY=local-key\n');

  const originalCwd = process.cwd();
  const restore = envSnapshot(['TRISS_WORKER_API_KEY', 'HOME']);

  process.env.HOME = tmp;
  delete process.env.TRISS_WORKER_API_KEY;
  process.chdir(projectDir);

  try {
    const { getConfig } = await import(`../src/config.js?local-override-${Date.now()}`);
    const cfg = getConfig();
    assert.equal(
      cfg.apiKey,
      'local-key',
      `Expected project-local key "local-key", got "${cfg.apiKey}"`,
    );
  } finally {
    process.chdir(originalCwd);
    restore();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ─── 3. Init + MCP awareness: CLAUDE.md gets MCP hint when entry is installed ─

test('runInit writes MCP tools hint into CLAUDE.md when entry is present', async () => {
  const tmp = makeTmp('triss-init-mcp-');
  const projectDir = makeTmp('triss-init-proj-');
  const originalCwd = process.cwd();
  const restore = envSnapshot(['HOME', 'TRISS_WORKER_API_KEY']);

  // Set HOME so ~/.claude.json and global env path resolve into tmp.
  process.env.HOME = tmp;
  delete process.env.TRISS_WORKER_API_KEY; // avoid spurious postInit hints

  // Pre-install the MCP entry in the fake ~/.claude.json.
  const claudeJson = { mcpServers: { triss: { command: 'triss', args: ['mcp', 'serve'] } } };
  writeFileSync(join(tmp, '.claude.json'), JSON.stringify(claudeJson, null, 2) + '\n');

  process.chdir(projectDir);

  try {
    const { runInit } = await import(`../src/commands/init.js?init-mcp-${Date.now()}`);
    await runInit({ target: 'claude' }); // writes CLAUDE.md to projectDir

    const claudeMd = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8');
    assert.ok(
      claudeMd.includes('MCP tools') || claudeMd.includes('triss_ask') || claudeMd.includes('MCP'),
      `Expected MCP hint in CLAUDE.md but got:\n${claudeMd.slice(0, 500)}`,
    );
  } finally {
    process.chdir(originalCwd);
    restore();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ─── 4. Init keeps CLAUDE.md tiny — integration commands live in agent-help ──
//
// The full integration cookbook (with `triss jira <subcmd>` examples) is
// rendered by `triss agent-help`, not inlined into CLAUDE.md. See
// test/agent-help.test.js for the inverse contract.

test('runInit produces the nano CLAUDE.md regardless of ATLASSIAN_* env vars', async () => {
  const tmp = makeTmp('triss-init-jira-');
  const projectDir = makeTmp('triss-init-jira-proj-');
  const originalCwd = process.cwd();

  const JIRA_VARS = ['ATLASSIAN_BASE_URL', 'ATLASSIAN_EMAIL', 'ATLASSIAN_API_TOKEN'];
  const restore = envSnapshot(['HOME', 'TRISS_WORKER_API_KEY', ...JIRA_VARS]);

  process.env.HOME = tmp;
  delete process.env.TRISS_WORKER_API_KEY;
  // Provide full Atlassian credentials so the jira integration is "ready".
  process.env.ATLASSIAN_BASE_URL = 'https://example.atlassian.net';
  process.env.ATLASSIAN_EMAIL = 'test@example.com';
  process.env.ATLASSIAN_API_TOKEN = 'test-token-xyz';

  // Ensure ~/.claude.json does NOT contain the MCP entry so the MCP hint
  // doesn't interfere with what we're checking.
  writeFileSync(join(tmp, '.claude.json'), JSON.stringify({ mcpServers: {} }) + '\n');

  process.chdir(projectDir);

  try {
    const { runInit } = await import(`../src/commands/init.js?init-jira-${Date.now()}`);
    await runInit({ target: 'claude' });

    const claudeMd = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf8');
    assert.ok(
      !claudeMd.includes('triss jira search'),
      `nano CLAUDE.md must not inline integration command syntax. Got:\n${claudeMd.slice(0, 800)}`,
    );
    assert.ok(
      claudeMd.includes('triss agent-help'),
      `nano CLAUDE.md must point at \`triss agent-help\`. Got:\n${claudeMd.slice(0, 800)}`,
    );
  } finally {
    process.chdir(originalCwd);
    restore();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ─── 5. logUsage → readLog round-trip with cost_usd > 0 ──────────────────────
//
// Calls logUsage with a known model, then readLog from the same file and
// verifies the record is present with a positive cost.

test('logUsage then readLog returns the record with cost_usd > 0', async () => {
  const tmp = makeTmp('triss-usage-e2e-');

  const restore = envSnapshot(['HOME']);
  // Point HOME so USAGE_FILE resolves into our tmp dir.
  process.env.HOME = tmp;

  try {
    // Import with cache-bust so USAGE_FILE is re-evaluated with the new HOME.
    const { logUsage, readLog } = await import(`../src/usage.js?usage-e2e-${Date.now()}`);

    const record = logUsage({
      model: 'deepseek-v4-flash',
      prompt_tokens: 1000,
      cached_tokens: 200,
      completion_tokens: 100,
      label: 'e2e-test',
    });

    // The returned record should already have cost_usd.
    assert.ok(record, 'logUsage should return the record');
    assert.ok(record.cost_usd > 0, `Expected cost_usd > 0 but got ${record.cost_usd}`);

    // Now read it back from the file written to ~/.cache/triss/usage.jsonl.
    const usageCacheFile = join(tmp, '.cache', 'triss', 'usage.jsonl');
    assert.ok(existsSync(usageCacheFile), `Expected usage file at ${usageCacheFile}`);
    const records = readLog(usageCacheFile);
    assert.ok(records.length >= 1, 'Expected at least one record in usage log');
    const found = records.find((r) => r.label === 'e2e-test');
    assert.ok(found, 'Could not find the e2e-test record in usage log');
    assert.ok(found.cost_usd > 0, `Expected cost_usd > 0 in log record but got ${found.cost_usd}`);
    assert.equal(found.model, 'deepseek-v4-flash');
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── 6. MCP tool list transitions: add then remove ATLASSIAN_* creds ─────────
//
// Verifies that jira tools appear only when credentials are present, and
// disappear again once they are removed — testing the transition in both
// directions (not just the static "present" case already in mcp-tools.test.js).

test('jira tools appear then disappear as ATLASSIAN_* creds are toggled', async () => {
  const JIRA_VARS = ['ATLASSIAN_BASE_URL', 'ATLASSIAN_EMAIL', 'ATLASSIAN_API_TOKEN'];
  const restore = envSnapshot(JIRA_VARS);

  try {
    // Phase 1: remove all Jira credentials — no jira tools expected.
    for (const v of JIRA_VARS) delete process.env[v];
    const { listTools } = await import('../src/mcp/tools.js');
    const toolsWithout = await listTools();
    const jiraToolsWithout = toolsWithout.filter((t) => t.name.startsWith('triss_jira_'));
    assert.equal(
      jiraToolsWithout.length,
      0,
      `Expected 0 jira tools without creds, got ${jiraToolsWithout.length}: ${jiraToolsWithout.map((t) => t.name).join(', ')}`,
    );

    // Phase 2: add credentials — jira tools must now appear.
    process.env.ATLASSIAN_BASE_URL = 'https://example.atlassian.net';
    process.env.ATLASSIAN_EMAIL = 'a@b.c';
    process.env.ATLASSIAN_API_TOKEN = 'tok';
    const toolsWith = await listTools();
    const jiraToolsWith = toolsWith.filter((t) => t.name.startsWith('triss_jira_'));
    assert.ok(
      jiraToolsWith.length > 0,
      'Expected jira tools after setting ATLASSIAN_* env vars',
    );

    // Phase 3: remove credentials again — jira tools disappear.
    for (const v of JIRA_VARS) delete process.env[v];
    const toolsAfterRemoval = await listTools();
    const jiraAfterRemoval = toolsAfterRemoval.filter((t) => t.name.startsWith('triss_jira_'));
    assert.equal(
      jiraAfterRemoval.length,
      0,
      `Expected 0 jira tools after removing creds, got ${jiraAfterRemoval.length}`,
    );
  } finally {
    restore();
  }
});

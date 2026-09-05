// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// test/init.test.js — covers INIT-01..INIT-07
//
// Strategy: runInit() writes to process.cwd() (local) or homedir() (global).
// We control both by swapping process.cwd via chdir() and by pointing HOME
// to a tmp dir.  renderTemplate / replaceBlock / postInit are not exported
// directly so we exercise them through runInit() end-to-end and by reading
// the file that was written.
//
// mcpStatus reads ~/.claude.json; we control that via the tmp HOME.
// getConfig / requireApiKey reads process.env; we manipulate that directly.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── shared constants ──────────────────────────────────────────────────────────

const START_MARKER = '<!-- triss:start -->';
const END_MARKER = '<!-- triss:end -->';

// ── helper: make isolated tmp dirs ───────────────────────────────────────────

function makeTmpDir(prefix = 'triss-init-') {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/**
 * Run a callback with HOME and cwd swapped to tmp dirs.
 * Returns { projectDir, homeDir }.
 * Always cleans up in finally.
 */
async function withTmpEnv(fn) {
  const projectDir = makeTmpDir('triss-proj-');
  const homeDir = makeTmpDir('triss-home-');
  const origCwd = process.cwd();
  const origHome = process.env.HOME;

  process.chdir(projectDir);
  process.env.HOME = homeDir;

  // Capture stdout so tests don't spray output
  const captured = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (...args) => {
    captured.push(typeof args[0] === 'string' ? args[0] : args[0].toString());
    return true;
  };

  try {
    await fn({ projectDir, homeDir, captured });
  } finally {
    process.stdout.write = origWrite;
    process.chdir(origCwd);
    process.env.HOME = origHome;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
}

// ── INIT-01: creates CLAUDE.md when missing ───────────────────────────────────

test('INIT-01: creates CLAUDE.md with triss marker block when file does not exist', async () => {
  // We must clear any TRISS_WORKER_API_KEY so the postInit tip path doesn't error
  const origApiKey = process.env.TRISS_WORKER_API_KEY;
  const origWorkerKey = process.env.WORKER_API_KEY;
  delete process.env.TRISS_WORKER_API_KEY;
  delete process.env.WORKER_API_KEY;

  await withTmpEnv(async ({ projectDir }) => {
    const destPath = join(projectDir, 'CLAUDE.md');
    assert.ok(!existsSync(destPath), 'CLAUDE.md should not exist yet');

    const { runInit } = await import('../src/commands/init.js');
    await runInit({ target: 'claude' });

    assert.ok(existsSync(destPath), 'CLAUDE.md should have been created');
    const content = readFileSync(destPath, 'utf8');
    assert.ok(content.includes(START_MARKER), 'should contain <!-- triss:start -->');
    assert.ok(content.includes(END_MARKER), 'should contain <!-- triss:end -->');
    assert.ok(content.includes('triss'), 'should contain triss content');
  });

  // Restore
  if (origApiKey !== undefined) process.env.TRISS_WORKER_API_KEY = origApiKey;
  if (origWorkerKey !== undefined) process.env.WORKER_API_KEY = origWorkerKey;
});

// ── INIT-02: --global writes to ~/.claude/CLAUDE.md ──────────────────────────

test('INIT-02: --global writes to ~/.claude/CLAUDE.md', async () => {
  const origApiKey = process.env.TRISS_WORKER_API_KEY;
  const origWorkerKey = process.env.WORKER_API_KEY;
  delete process.env.TRISS_WORKER_API_KEY;
  delete process.env.WORKER_API_KEY;

  await withTmpEnv(async ({ homeDir }) => {
    const globalDir = join(homeDir, '.claude');
    const destPath = join(globalDir, 'CLAUDE.md');

    const { runInit } = await import('../src/commands/init.js');
    await runInit({ target: 'claude', global: true });

    assert.ok(existsSync(destPath), '~/.claude/CLAUDE.md should have been created');
    const content = readFileSync(destPath, 'utf8');
    assert.ok(content.includes(START_MARKER), 'global CLAUDE.md should contain start marker');
    assert.ok(content.includes(END_MARKER), 'global CLAUDE.md should contain end marker');
  });

  if (origApiKey !== undefined) process.env.TRISS_WORKER_API_KEY = origApiKey;
  if (origWorkerKey !== undefined) process.env.WORKER_API_KEY = origWorkerKey;
});

// ── Codex target: creates AGENTS.md locally and globally ─────────────────────

test('INIT-CODEX-01: creates AGENTS.md with triss marker block', async () => {
  const origApiKey = process.env.TRISS_WORKER_API_KEY;
  const origWorkerKey = process.env.WORKER_API_KEY;
  delete process.env.TRISS_WORKER_API_KEY;
  delete process.env.WORKER_API_KEY;

  await withTmpEnv(async ({ projectDir }) => {
    const destPath = join(projectDir, 'AGENTS.md');
    assert.ok(!existsSync(destPath), 'AGENTS.md should not exist yet');

    const { runInit } = await import('../src/commands/init.js');
    await runInit({ target: 'codex' });

    assert.ok(existsSync(destPath), 'AGENTS.md should have been created');
    const content = readFileSync(destPath, 'utf8');
    assert.ok(content.includes(START_MARKER), 'AGENTS.md should contain start marker');
    assert.ok(content.includes(END_MARKER), 'AGENTS.md should contain end marker');
    assert.ok(content.includes('triss_ask'), 'AGENTS.md should mention Triss MCP tools by name');
    assert.ok(
      content.includes('triss agent-help --target codex'),
      'AGENTS.md must point at codex-flavored agent-help so Codex agents do not get the Claude cookbook',
    );
    assert.ok(!content.includes('experimental'), 'Codex target should not be marked experimental');
  });

  if (origApiKey !== undefined) process.env.TRISS_WORKER_API_KEY = origApiKey;
  if (origWorkerKey !== undefined) process.env.WORKER_API_KEY = origWorkerKey;
});

test('INIT-CODEX-02: --global writes to ~/.codex/AGENTS.md', async () => {
  const origApiKey = process.env.TRISS_WORKER_API_KEY;
  const origWorkerKey = process.env.WORKER_API_KEY;
  delete process.env.TRISS_WORKER_API_KEY;
  delete process.env.WORKER_API_KEY;

  await withTmpEnv(async ({ homeDir }) => {
    const destPath = join(homeDir, '.codex', 'AGENTS.md');

    const { runInit } = await import('../src/commands/init.js');
    await runInit({ target: 'codex', global: true });

    assert.ok(existsSync(destPath), '~/.codex/AGENTS.md should have been created');
    const content = readFileSync(destPath, 'utf8');
    assert.ok(content.includes(START_MARKER), 'global AGENTS.md should contain start marker');
    assert.ok(content.includes(END_MARKER), 'global AGENTS.md should contain end marker');
  });

  if (origApiKey !== undefined) process.env.TRISS_WORKER_API_KEY = origApiKey;
  if (origWorkerKey !== undefined) process.env.WORKER_API_KEY = origWorkerKey;
});

test('INIT-BOTH: rejects destinations that resolve to the same symlink target before writes', async () => {
  await withTmpEnv(async ({ projectDir }) => {
    const claudePath = join(projectDir, 'CLAUDE.md');
    const codexPath = join(projectDir, 'AGENTS.md');
    const backingPath = join(projectDir, 'shared-rules.md');
    const { runInit } = await import('../src/commands/init.js');

    await runInit({ target: 'claude' });
    renameSync(claudePath, backingPath);
    symlinkSync('shared-rules.md', claudePath);
    symlinkSync('shared-rules.md', codexPath);
    const before = readFileSync(backingPath);
    const entriesBefore = readdirSync(projectDir).sort();

    await assert.rejects(
      () => runInit({ target: 'both' }),
      /CLAUDE\.md.*AGENTS\.md|AGENTS\.md.*CLAUDE\.md|resolve to the same target/i,
    );
    assert.deepEqual(readFileSync(backingPath), before);
    assert.deepEqual(readdirSync(projectDir).sort(), entriesBefore);
  });
});

// ── INIT-03: existing CLAUDE.md without markers → appends block ───────────────

test('INIT-03: existing CLAUDE.md without markers gets block appended', async () => {
  const origApiKey = process.env.TRISS_WORKER_API_KEY;
  const origWorkerKey = process.env.WORKER_API_KEY;
  delete process.env.TRISS_WORKER_API_KEY;
  delete process.env.WORKER_API_KEY;

  await withTmpEnv(async ({ projectDir }) => {
    const destPath = join(projectDir, 'CLAUDE.md');
    const existing = '# My project notes\n\nSome existing content.\n';
    writeFileSync(destPath, existing);

    const { runInit } = await import('../src/commands/init.js');
    await runInit({ target: 'claude' });

    const content = readFileSync(destPath, 'utf8');
    assert.ok(content.startsWith('# My project notes'), 'should preserve existing content at start');
    assert.ok(content.includes('Some existing content'), 'should preserve existing lines');
    assert.ok(content.includes(START_MARKER), 'should have appended triss:start');
    assert.ok(content.includes(END_MARKER), 'should have appended triss:end');
    // Markers must appear AFTER the pre-existing content
    const existingEnd = content.indexOf('Some existing content');
    const markerStart = content.indexOf(START_MARKER);
    assert.ok(markerStart > existingEnd, 'triss block should come after existing content');
  });

  if (origApiKey !== undefined) process.env.TRISS_WORKER_API_KEY = origApiKey;
  if (origWorkerKey !== undefined) process.env.WORKER_API_KEY = origWorkerKey;
});

// ── INIT-04: idempotent re-run — same content stays untouched ─────────────────

test('INIT-04: re-running init on unchanged CLAUDE.md is idempotent', async () => {
  const origApiKey = process.env.TRISS_WORKER_API_KEY;
  const origWorkerKey = process.env.WORKER_API_KEY;
  delete process.env.TRISS_WORKER_API_KEY;
  delete process.env.WORKER_API_KEY;

  await withTmpEnv(async ({ projectDir, captured }) => {
    const destPath = join(projectDir, 'CLAUDE.md');

    const { runInit } = await import('../src/commands/init.js');
    // First run
    await runInit({ target: 'claude' });
    const afterFirst = readFileSync(destPath, 'utf8');

    // Second run
    await runInit({ target: 'claude' });
    const afterSecond = readFileSync(destPath, 'utf8');

    assert.equal(afterFirst, afterSecond, 'file content should be identical after second run');

    // The second run should say "already up to date"
    const output = captured.join('');
    assert.ok(
      output.includes('already up to date') || output.includes('Updated'),
      `expected idempotency message in: ${output}`,
    );
  });

  if (origApiKey !== undefined) process.env.TRISS_WORKER_API_KEY = origApiKey;
  if (origWorkerKey !== undefined) process.env.WORKER_API_KEY = origWorkerKey;
});

test('INIT-CODEX-03: re-running init on unchanged AGENTS.md is idempotent', async () => {
  const origApiKey = process.env.TRISS_WORKER_API_KEY;
  const origWorkerKey = process.env.WORKER_API_KEY;
  delete process.env.TRISS_WORKER_API_KEY;
  delete process.env.WORKER_API_KEY;

  await withTmpEnv(async ({ projectDir, captured }) => {
    const destPath = join(projectDir, 'AGENTS.md');

    const { runInit } = await import('../src/commands/init.js');
    await runInit({ target: 'codex' });
    const afterFirst = readFileSync(destPath, 'utf8');

    await runInit({ target: 'codex' });
    const afterSecond = readFileSync(destPath, 'utf8');

    assert.equal(afterFirst, afterSecond, 'AGENTS.md should be identical after second run');
    assert.match(captured.join(''), /already up to date|Updated/);
  });

  if (origApiKey !== undefined) process.env.TRISS_WORKER_API_KEY = origApiKey;
  if (origWorkerKey !== undefined) process.env.WORKER_API_KEY = origWorkerKey;
});

// ── INIT-04 (update path): updates only the block, preserves other content ────

test('INIT-04: re-run updates triss block but preserves surrounding content', async () => {
  const origApiKey = process.env.TRISS_WORKER_API_KEY;
  const origWorkerKey = process.env.WORKER_API_KEY;
  delete process.env.TRISS_WORKER_API_KEY;
  delete process.env.WORKER_API_KEY;

  await withTmpEnv(async ({ projectDir }) => {
    const destPath = join(projectDir, 'CLAUDE.md');

    // Manually write a CLAUDE.md that already has markers with stale content
    const staleBlock = [
      '# Project Notes\n',
      'Important context above.\n',
      '\n',
      START_MARKER + '\n',
      'OLD STALE TRISS CONTENT\n',
      END_MARKER + '\n',
      '\n',
      'Content after the block.\n',
    ].join('');
    writeFileSync(destPath, staleBlock);

    const { runInit } = await import('../src/commands/init.js');
    await runInit({ target: 'claude' });

    const content = readFileSync(destPath, 'utf8');
    assert.ok(content.includes('Important context above'), 'should preserve content before block');
    // The stale content between markers should be replaced
    assert.ok(!content.includes('OLD STALE TRISS CONTENT'), 'stale block content should be replaced');
    assert.ok(content.includes(START_MARKER), 'markers should still be present');
    assert.ok(content.includes(END_MARKER), 'markers should still be present');
  });

  if (origApiKey !== undefined) process.env.TRISS_WORKER_API_KEY = origApiKey;
  if (origWorkerKey !== undefined) process.env.WORKER_API_KEY = origWorkerKey;
});

test('INIT-04b: --force never bypasses malformed marker validation', async () => {
  await withTmpEnv(async ({ projectDir }) => {
    const destPath = join(projectDir, 'CLAUDE.md');
    const malformed = `user content\n${START_MARKER}\nunterminated managed block\n`;
    writeFileSync(destPath, malformed);

    const { runInit } = await import('../src/commands/init.js');
    await assert.rejects(
      () => runInit({ target: 'claude', force: true }),
      /invalid Triss marker layout/i,
    );
    assert.equal(readFileSync(destPath, 'utf8'), malformed);
  });
});

// ── INIT-07: {{INTEGRATIONS}} placeholder — empty when no integration ready ───

test('INIT-07: {{INTEGRATIONS}} renders empty when no integration credentials are set', async () => {
  const origApiKey = process.env.TRISS_WORKER_API_KEY;
  const origWorkerKey = process.env.WORKER_API_KEY;
  // Remove all known integration env vars
  const origAtlBase = process.env.ATLASSIAN_BASE_URL;
  const origAtlEmail = process.env.ATLASSIAN_EMAIL;
  const origAtlToken = process.env.ATLASSIAN_API_TOKEN;
  const origLinearKey = process.env.LINEAR_API_KEY;

  delete process.env.TRISS_WORKER_API_KEY;
  delete process.env.WORKER_API_KEY;
  delete process.env.ATLASSIAN_BASE_URL;
  delete process.env.ATLASSIAN_EMAIL;
  delete process.env.ATLASSIAN_API_TOKEN;
  delete process.env.LINEAR_API_KEY;

  await withTmpEnv(async ({ projectDir }) => {
    const destPath = join(projectDir, 'CLAUDE.md');

    const { runInit } = await import('../src/commands/init.js');
    await runInit({ target: 'claude' });

    const content = readFileSync(destPath, 'utf8');
    // The {{INTEGRATIONS}} placeholder should be replaced with ''
    // meaning no "Integrations enabled" section should appear
    assert.ok(!content.includes('{{INTEGRATIONS}}'), 'placeholder should be replaced');
    assert.ok(
      !content.includes('Integrations enabled for this project'),
      'no integrations section when no creds set',
    );
  });

  if (origApiKey !== undefined) process.env.TRISS_WORKER_API_KEY = origApiKey;
  if (origWorkerKey !== undefined) process.env.WORKER_API_KEY = origWorkerKey;
  if (origAtlBase !== undefined) process.env.ATLASSIAN_BASE_URL = origAtlBase;
  if (origAtlEmail !== undefined) process.env.ATLASSIAN_EMAIL = origAtlEmail;
  if (origAtlToken !== undefined) process.env.ATLASSIAN_API_TOKEN = origAtlToken;
  if (origLinearKey !== undefined) process.env.LINEAR_API_KEY = origLinearKey;
});

// ── INIT-07: nano init does NOT inject integration command snippets ──────────
//
// Integration-specific commands (`triss jira <subcmd>`) are part of the FULL
// cookbook served by `triss agent-help` — the always-loaded nano block stays
// short. See test/agent-help.test.js for the inverse contract.

test('INIT-07: nano init keeps CLAUDE.md tiny even when ATLASSIAN_* env vars are set', async () => {
  const origApiKey = process.env.TRISS_WORKER_API_KEY;
  const origWorkerKey = process.env.WORKER_API_KEY;
  const origAtlBase = process.env.ATLASSIAN_BASE_URL;
  const origAtlEmail = process.env.ATLASSIAN_EMAIL;
  const origAtlToken = process.env.ATLASSIAN_API_TOKEN;
  const origLinearKey = process.env.LINEAR_API_KEY;

  delete process.env.TRISS_WORKER_API_KEY;
  delete process.env.WORKER_API_KEY;
  delete process.env.LINEAR_API_KEY;
  // Set Jira creds
  process.env.ATLASSIAN_BASE_URL = 'https://example.atlassian.net';
  process.env.ATLASSIAN_EMAIL = 'test@example.com';
  process.env.ATLASSIAN_API_TOKEN = 'test-token-abc';

  await withTmpEnv(async ({ projectDir }) => {
    const destPath = join(projectDir, 'CLAUDE.md');

    const { runInit } = await import('../src/commands/init.js');
    await runInit({ target: 'claude' });

    const content = readFileSync(destPath, 'utf8');
    assert.ok(!content.includes('{{INTEGRATIONS}}'), 'no leftover template placeholder');
    // Nano keeps things short: integration command syntax does NOT leak in.
    assert.ok(
      !content.includes('triss jira search'),
      'integration command syntax must NOT be inlined into the nano block',
    );
    assert.ok(
      !content.includes('triss linear'),
      'linear instructions should not appear regardless of env',
    );
    // Nano must point at the full reference instead.
    assert.ok(
      content.includes('triss agent-help'),
      'nano must point at `triss agent-help` for the full integration cookbook',
    );
  });

  if (origApiKey !== undefined) process.env.TRISS_WORKER_API_KEY = origApiKey;
  if (origWorkerKey !== undefined) process.env.WORKER_API_KEY = origWorkerKey;
  if (origAtlBase !== undefined) process.env.ATLASSIAN_BASE_URL = origAtlBase;
  else delete process.env.ATLASSIAN_BASE_URL;
  if (origAtlEmail !== undefined) process.env.ATLASSIAN_EMAIL = origAtlEmail;
  else delete process.env.ATLASSIAN_EMAIL;
  if (origAtlToken !== undefined) process.env.ATLASSIAN_API_TOKEN = origAtlToken;
  else delete process.env.ATLASSIAN_API_TOKEN;
  if (origLinearKey !== undefined) process.env.LINEAR_API_KEY = origLinearKey;
});

test('INIT-CODEX-04: nano init keeps AGENTS.md tiny even when ATLASSIAN_* env vars are set', async () => {
  const origApiKey = process.env.TRISS_WORKER_API_KEY;
  const origWorkerKey = process.env.WORKER_API_KEY;
  const origAtlBase = process.env.ATLASSIAN_BASE_URL;
  const origAtlEmail = process.env.ATLASSIAN_EMAIL;
  const origAtlToken = process.env.ATLASSIAN_API_TOKEN;
  const origLinearKey = process.env.LINEAR_API_KEY;

  delete process.env.TRISS_WORKER_API_KEY;
  delete process.env.WORKER_API_KEY;
  delete process.env.LINEAR_API_KEY;
  process.env.ATLASSIAN_BASE_URL = 'https://example.atlassian.net';
  process.env.ATLASSIAN_EMAIL = 'test@example.com';
  process.env.ATLASSIAN_API_TOKEN = 'test-token-abc';

  await withTmpEnv(async ({ projectDir }) => {
    const destPath = join(projectDir, 'AGENTS.md');

    const { runInit } = await import('../src/commands/init.js');
    await runInit({ target: 'codex' });

    const content = readFileSync(destPath, 'utf8');
    assert.ok(!content.includes('{{INTEGRATIONS}}'), 'no leftover template placeholder');
    assert.ok(
      !content.includes('triss jira search'),
      'integration command syntax must NOT be inlined into the nano AGENTS.md block',
    );
    assert.ok(
      !content.includes('triss linear'),
      'linear instructions should not appear in AGENTS.md regardless of env',
    );
    assert.ok(
      content.includes('triss agent-help'),
      'nano AGENTS.md must point at `triss agent-help` for the full integration cookbook',
    );
  });

  if (origApiKey !== undefined) process.env.TRISS_WORKER_API_KEY = origApiKey;
  if (origWorkerKey !== undefined) process.env.WORKER_API_KEY = origWorkerKey;
  if (origAtlBase !== undefined) process.env.ATLASSIAN_BASE_URL = origAtlBase;
  else delete process.env.ATLASSIAN_BASE_URL;
  if (origAtlEmail !== undefined) process.env.ATLASSIAN_EMAIL = origAtlEmail;
  else delete process.env.ATLASSIAN_EMAIL;
  if (origAtlToken !== undefined) process.env.ATLASSIAN_API_TOKEN = origAtlToken;
  else delete process.env.ATLASSIAN_API_TOKEN;
  if (origLinearKey !== undefined) process.env.LINEAR_API_KEY = origLinearKey;
  else delete process.env.LINEAR_API_KEY;
});

// ── INIT-06: nano init does NOT branch on MCP registration ───────────────────
//
// The full MCP-hint blockquote is part of `triss agent-help` output (see
// test/agent-help.test.js). The nano init block is identical regardless of
// whether ~/.claude.json registers mcpServers.triss — it always names the
// MCP tools and points at the full reference.

test('INIT-06: nano init output is identical with or without mcpServers.triss in ~/.claude.json', async () => {
  const origApiKey = process.env.TRISS_WORKER_API_KEY;
  const origWorkerKey = process.env.WORKER_API_KEY;
  const origAtlBase = process.env.ATLASSIAN_BASE_URL;
  const origAtlEmail = process.env.ATLASSIAN_EMAIL;
  const origAtlToken = process.env.ATLASSIAN_API_TOKEN;
  const origLinearKey = process.env.LINEAR_API_KEY;

  delete process.env.TRISS_WORKER_API_KEY;
  delete process.env.WORKER_API_KEY;
  delete process.env.ATLASSIAN_BASE_URL;
  delete process.env.ATLASSIAN_EMAIL;
  delete process.env.ATLASSIAN_API_TOKEN;
  delete process.env.LINEAR_API_KEY;

  await withTmpEnv(async ({ homeDir, projectDir }) => {
    const destPath = join(projectDir, 'CLAUDE.md');
    const { runInit } = await import('../src/commands/init.js');

    // First run: no MCP registered.
    await runInit({ target: 'claude' });
    const without = readFileSync(destPath, 'utf8');

    // Now register MCP and re-run.
    const claudeConfigDir = join(homeDir, '.claude');
    mkdirSync(claudeConfigDir, { recursive: true });
    writeFileSync(
      join(homeDir, '.claude.json'),
      JSON.stringify({ mcpServers: { triss: { command: 'triss', args: ['mcp', 'serve'] } } }) + '\n',
    );
    await runInit({ target: 'claude' });
    const withMcp = readFileSync(destPath, 'utf8');

    assert.equal(without, withMcp, 'nano init must produce identical output regardless of MCP registration');
    assert.ok(without.includes('triss_ask'), 'nano always names the MCP tools');
    assert.ok(
      !without.includes('Triss is also available as MCP tools'),
      'long MCP-hint blockquote belongs to `triss agent-help`, not the nano block',
    );
  });

  if (origApiKey !== undefined) process.env.TRISS_WORKER_API_KEY = origApiKey;
  if (origWorkerKey !== undefined) process.env.WORKER_API_KEY = origWorkerKey;
  if (origAtlBase !== undefined) process.env.ATLASSIAN_BASE_URL = origAtlBase;
  if (origAtlEmail !== undefined) process.env.ATLASSIAN_EMAIL = origAtlEmail;
  if (origAtlToken !== undefined) process.env.ATLASSIAN_API_TOKEN = origAtlToken;
  if (origLinearKey !== undefined) process.env.LINEAR_API_KEY = origLinearKey;
});

// ── INIT-BOTH: target='both' writes both CLAUDE.md and AGENTS.md ─────────────

test('INIT-BOTH-01: target="both" creates CLAUDE.md and AGENTS.md in one call', async () => {
  const origApiKey = process.env.TRISS_WORKER_API_KEY;
  const origWorkerKey = process.env.WORKER_API_KEY;
  delete process.env.TRISS_WORKER_API_KEY;
  delete process.env.WORKER_API_KEY;

  await withTmpEnv(async ({ projectDir }) => {
    const claudePath = join(projectDir, 'CLAUDE.md');
    const codexPath = join(projectDir, 'AGENTS.md');
    assert.ok(!existsSync(claudePath));
    assert.ok(!existsSync(codexPath));

    const { runInit } = await import('../src/commands/init.js');
    await runInit({ target: 'both' });

    assert.ok(existsSync(claudePath), 'CLAUDE.md should have been created');
    assert.ok(existsSync(codexPath), 'AGENTS.md should have been created');
    const claude = readFileSync(claudePath, 'utf8');
    const codex = readFileSync(codexPath, 'utf8');
    assert.ok(claude.includes(START_MARKER) && claude.includes(END_MARKER));
    assert.ok(codex.includes(START_MARKER) && codex.includes(END_MARKER));
    assert.ok(codex.includes('triss_ask'), 'AGENTS.md should mention Triss MCP tools by name');
    assert.ok(claude.includes('triss agent-help'), 'CLAUDE.md should point at the full reference command');
  });

  if (origApiKey !== undefined) process.env.TRISS_WORKER_API_KEY = origApiKey;
  if (origWorkerKey !== undefined) process.env.WORKER_API_KEY = origWorkerKey;
});

test('INIT-BOTH-02: target="both" with --global writes to ~/.claude and ~/.codex', async () => {
  const origApiKey = process.env.TRISS_WORKER_API_KEY;
  const origWorkerKey = process.env.WORKER_API_KEY;
  delete process.env.TRISS_WORKER_API_KEY;
  delete process.env.WORKER_API_KEY;

  await withTmpEnv(async ({ homeDir }) => {
    const claudePath = join(homeDir, '.claude', 'CLAUDE.md');
    const codexPath = join(homeDir, '.codex', 'AGENTS.md');

    const { runInit } = await import('../src/commands/init.js');
    await runInit({ target: 'both', global: true });

    assert.ok(existsSync(claudePath), '~/.claude/CLAUDE.md should exist');
    assert.ok(existsSync(codexPath), '~/.codex/AGENTS.md should exist');
  });

  if (origApiKey !== undefined) process.env.TRISS_WORKER_API_KEY = origApiKey;
  if (origWorkerKey !== undefined) process.env.WORKER_API_KEY = origWorkerKey;
});

test('INIT-BOTH-03: omitted target falls back to "claude" in non-TTY', async () => {
  // tests run with stdin not a TTY → chooseTarget() must default to 'claude'
  // without prompting (otherwise the test would hang).
  const origApiKey = process.env.TRISS_WORKER_API_KEY;
  const origWorkerKey = process.env.WORKER_API_KEY;
  delete process.env.TRISS_WORKER_API_KEY;
  delete process.env.WORKER_API_KEY;

  await withTmpEnv(async ({ projectDir }) => {
    const claudePath = join(projectDir, 'CLAUDE.md');
    const codexPath = join(projectDir, 'AGENTS.md');

    const { runInit } = await import('../src/commands/init.js');
    await runInit({}); // no target

    assert.ok(existsSync(claudePath), 'should default to CLAUDE.md in non-TTY');
    assert.ok(!existsSync(codexPath), 'should not create AGENTS.md when defaulting to claude');
  });

  if (origApiKey !== undefined) process.env.TRISS_WORKER_API_KEY = origApiKey;
  if (origWorkerKey !== undefined) process.env.WORKER_API_KEY = origWorkerKey;
});

test('INIT-BOTH-04: unknown target throws a clear error', async () => {
  await withTmpEnv(async () => {
    const { runInit } = await import('../src/commands/init.js');
    await assert.rejects(() => runInit({ target: 'xyz' }), /Unknown --target.*xyz/);
  });
});

// ── INIT-05 / postInit: prints next-step tips when TRISS_WORKER_API_KEY missing ──

test('INIT-05 / postInit: prints API-key tip when TRISS_WORKER_API_KEY is missing', async () => {
  const origApiKey = process.env.TRISS_WORKER_API_KEY;
  const origWorkerKey = process.env.WORKER_API_KEY;
  delete process.env.TRISS_WORKER_API_KEY;
  delete process.env.WORKER_API_KEY;

  await withTmpEnv(async ({ captured }) => {
    const { _postInit } = await import('../src/commands/init.js');
    await _postInit({});

    const output = captured.join('');
    assert.ok(
      output.includes('DeepSeek') || output.includes('TRISS_WORKER_API_KEY') || output.includes('triss config wizard'),
      `expected API key hint in postInit output, got: ${output}`,
    );
  });

  if (origApiKey !== undefined) process.env.TRISS_WORKER_API_KEY = origApiKey;
  if (origWorkerKey !== undefined) process.env.WORKER_API_KEY = origWorkerKey;
});


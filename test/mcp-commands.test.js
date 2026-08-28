// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Unit tests for the `triss mcp` command layer (src/commands/mcp.js):
// install/uninstall/status against throwaway HOME and cwd sandboxes, and the
// serve path via its dependency-injection seam.

function sandbox() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-mcp-home-')));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'triss-mcp-cwd-')));
  const prevHome = process.env.HOME;
  const prevCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(cwd);
  return {
    home,
    cwd,
    claudePath: join(home, '.claude.json'),
    codexPath: join(home, '.codex', 'config.toml'),
    localPath: join(cwd, '.mcp.json'),
    restore: () => {
      process.env.HOME = prevHome;
      process.chdir(prevCwd);
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

async function importCommands(tag) {
  return import(`../src/commands/mcp.js?tag=${tag}`);
}

function captureStdout(fn) {
  const chunks = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => chunks.push(String(c));
  return Promise.resolve()
    .then(fn)
    .finally(() => { process.stdout.write = original; })
    .then(() => chunks.join(''));
}

test('runMcpInstall registers Claude globally and both agents behind --target both', async () => {
  const s = sandbox();
  try {
    const { runMcpInstall } = await importCommands('install-claude');
    const out = await captureStdout(() => runMcpInstall({ target: 'claude', global: true }));
    assert.match(out, /✓ MCP server "triss" added in /);
    assert.match(out, /\(claude, scope=global\)/);
    assert.match(out, /Restart your Claude Code session/);
    const config = JSON.parse(readFileSync(s.claudePath, 'utf8'));
    assert.equal(config.mcpServers.triss.command, 'triss');

    const { runMcpInstall: both } = await importCommands('install-both');
    const out2 = await captureStdout(() => both({ target: 'both', global: true, args: 'mcp serve --extra' }));
    assert.match(out2, /\(codex, scope=global\)/);
    assert.match(out2, /Restart your agent session/);
    assert.ok(existsSync(s.codexPath));
    const claude = JSON.parse(readFileSync(s.claudePath, 'utf8'));
    assert.deepEqual(claude.mcpServers.triss.args, ['mcp', 'serve', '--extra']);
  } finally {
    s.restore();
  }
});

test('runMcpInstall validates the target and rejects local Codex installs', async () => {
  const s = sandbox();
  try {
    const { runMcpInstall } = await importCommands('install-bad');
    await assert.rejects(
      () => runMcpInstall({ target: 'vscode', global: true }),
      /Unknown --target "vscode". Supported: claude, codex, both/,
    );
    await assert.rejects(
      () => runMcpInstall({ target: 'codex', local: true }),
      /Codex doesn't support project-local MCP config/,
    );
  } finally {
    s.restore();
  }
});

test('runMcpStatus shows registered entries and the not-registered fallback', async () => {
  const s = sandbox();
  try {
    const { runMcpInstall, runMcpStatus } = await importCommands('status');
    await runMcpInstall({ target: 'claude', global: true });
    const out = await captureStdout(() => runMcpStatus({}));
    assert.match(out, /── claude ──/);
    assert.match(out, /triss is registered:/);
    assert.match(out, /── codex ──/);
    assert.match(out, /triss is not registered as an MCP server here/);

    const out2 = await captureStdout(() => runMcpStatus({ local: true, target: 'claude' }));
    assert.match(out2, /Path: .*\.mcp\.json/);
    assert.match(out2, /triss is not registered as an MCP server here/);
  } finally {
    s.restore();
  }
});

test('runMcpStatus rejects unknown targets without prompting', async () => {
  const s = sandbox();
  try {
    const { runMcpStatus } = await importCommands('status-bad');
    await assert.rejects(
      () => runMcpStatus({ target: 'nope' }),
      /Unknown --target "nope". Supported: claude, codex, both/,
    );
  } finally {
    s.restore();
  }
});

test('runMcpUninstall removes entries and reports absent ones', async () => {
  const s = sandbox();
  try {
    const { runMcpInstall, runMcpUninstall } = await importCommands('uninstall');
    await runMcpInstall({ target: 'claude', global: true });
    const out = await captureStdout(() => runMcpUninstall({ global: true, target: 'claude' }));
    assert.match(out, /✓ MCP server "triss" removed from /);
    const out2 = await captureStdout(() => runMcpUninstall({ global: true, target: 'claude' }));
    assert.match(out2, /\(no triss entry found in /);
  } finally {
    s.restore();
  }
});

test('runMcpServe migrates, warns on update, tolerates failures, and serves', async () => {
  const { runMcpServe } = await importCommands('serve');
  const warnings = [];
  const warns = (m) => warnings.push(m);
  let served = 0;
  const serve = () => { served += 1; };

  await runMcpServe({
    warn: warns,
    migrateCodexToolTimeout: async () => ({ status: 'updated', from: 120, to: 5460, path: '/tmp/x' }),
    runServer: serve,
  });
  assert.equal(served, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /upgraded Codex tool_timeout_sec 120 → 5460/);

  await runMcpServe({
    warn: warns,
    migrateCodexToolTimeout: async () => ({ status: 'conflict' }),
    runServer: serve,
  });
  assert.equal(served, 2);
  assert.equal(warnings.length, 1); // conflict is silent by design

  await runMcpServe({
    warn: warns,
    migrateCodexToolTimeout: async () => { throw new Error('boom'); },
    runServer: serve,
  });
  assert.equal(served, 3);
  assert.equal(warnings.length, 2);
  assert.match(warnings[1], /best effort.*boom/);
});

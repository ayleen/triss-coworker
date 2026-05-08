// Regression coverage for the fixes raised in the second review pass:
//   - Linear team UUID-or-key resolution (was silently sending key as id)
//   - `config edit` exit-code propagation (was glossing over editor failures)
//   - MCP project root via TRISS_PROJECT_ROOT (was tying sandbox to cwd)

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Linear team UUID-or-key ────────────────────────────────────────────────

function envSnap(keys) {
  const before = {};
  for (const k of keys) before[k] = process.env[k];
  return () => {
    for (const k of keys) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  };
}

function mockGqlOnce(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const result = await handler(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      body: null,
      text: async () => JSON.stringify(result),
    };
  };
  return calls;
}

test('resolveTeamId returns a UUID input unchanged (no GraphQL call)', async () => {
  const restore = envSnap(['LINEAR_API_KEY']);
  process.env.LINEAR_API_KEY = 'lin_test';
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, body: null, text: async () => '{}' }; };
  try {
    const { resolveTeamId } = await import(`../src/integrations/linear/client.js?team-uuid=${Date.now()}`);
    const uuid = '12345678-1234-1234-1234-1234567890ab';
    const out = await resolveTeamId(uuid);
    assert.equal(out, uuid);
    assert.equal(called, false, 'GraphQL must not be called for UUID input');
  } finally {
    restore();
  }
});

test('resolveTeamId looks up a team key via the teams query', async () => {
  const restore = envSnap(['LINEAR_API_KEY']);
  process.env.LINEAR_API_KEY = 'lin_test';
  const calls = mockGqlOnce(({ variables }) => ({
    data: {
      teams: { nodes: [{ id: 'team-uuid-eng', key: variables.key, name: 'Engineering' }] },
    },
  }));
  try {
    const { resolveTeamId } = await import(`../src/integrations/linear/client.js?team-key=${Date.now()}`);
    const out = await resolveTeamId('ENG');
    assert.equal(out, 'team-uuid-eng');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.variables.key, 'ENG');
  } finally {
    restore();
  }
});

test('resolveTeamId throws a clear IntegrationError for unknown team keys', async () => {
  const restore = envSnap(['LINEAR_API_KEY']);
  process.env.LINEAR_API_KEY = 'lin_test';
  mockGqlOnce(() => ({ data: { teams: { nodes: [] } } }));
  try {
    const { resolveTeamId } = await import(`../src/integrations/linear/client.js?team-miss=${Date.now()}`);
    await assert.rejects(() => resolveTeamId('NONEXISTENT'), /not found/);
  } finally {
    restore();
  }
});

// ─── config edit exit code ──────────────────────────────────────────────────

test('runEdit throws when the editor exits non-zero', async () => {
  // Use a tmp HOME so config-edit doesn't touch the user's real env file.
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), 'triss-edit-home-')));
  const restore = envSnap(['HOME', 'EDITOR', 'VISUAL']);
  process.env.HOME = tmpHome;
  // `false` is a coreutils binary that does nothing and exits with status 1.
  process.env.EDITOR = 'false';
  delete process.env.VISUAL;
  try {
    const { runEdit } = await import(`../src/commands/config.js?edit-fail=${Date.now()}`);
    await assert.rejects(
      () => runEdit({ global: true }),
      /Editor "false" exited with status 1/,
    );
  } finally {
    restore();
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('runEdit throws a launch error when the editor is not on PATH', async () => {
  const tmpHome = realpathSync(mkdtempSync(join(tmpdir(), 'triss-edit-home-')));
  const restore = envSnap(['HOME', 'EDITOR', 'VISUAL']);
  process.env.HOME = tmpHome;
  process.env.EDITOR = '/no/such/editor/binary-xyz-12345';
  delete process.env.VISUAL;
  try {
    const { runEdit } = await import(`../src/commands/config.js?edit-missing=${Date.now()}`);
    await assert.rejects(
      () => runEdit({ global: true }),
      /Failed to launch editor|exited with status/,
    );
  } finally {
    restore();
    rmSync(tmpHome, { recursive: true, force: true });
  }
});

// ─── TRISS_PROJECT_ROOT ─────────────────────────────────────────────────────

test('projectRoot prefers TRISS_PROJECT_ROOT over process.cwd', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'triss-root-')));
  const restore = envSnap(['TRISS_PROJECT_ROOT']);
  process.env.TRISS_PROJECT_ROOT = tmp;
  try {
    const { projectRoot } = await import(`../src/safety.js?root-env=${Date.now()}`);
    assert.equal(projectRoot(), tmp);
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('projectRoot falls back to process.cwd when env unset', async () => {
  const restore = envSnap(['TRISS_PROJECT_ROOT']);
  delete process.env.TRISS_PROJECT_ROOT;
  try {
    const { projectRoot } = await import(`../src/safety.js?root-cwd=${Date.now()}`);
    assert.equal(projectRoot(), realpathSync(process.cwd()));
  } finally {
    restore();
  }
});

test('projectRoot strips .claude/worktrees/<id> suffix', async () => {
  const restore = envSnap(['TRISS_PROJECT_ROOT']);
  delete process.env.TRISS_PROJECT_ROOT;
  const fakeWorktreeCwd = '/Users/dev/myproject/.claude/worktrees/agent-abc123/subdir';
  const origCwd = process.cwd;
  process.cwd = () => fakeWorktreeCwd;
  try {
    const { projectRoot } = await import(`../src/safety.js?root-wt=${Date.now()}`);
    assert.equal(projectRoot(), '/Users/dev/myproject');
  } finally {
    process.cwd = origCwd;
    restore();
  }
});

test('assertSafePath sandboxes against TRISS_PROJECT_ROOT, not cwd', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'triss-root-sb-')));
  writeFileSync(join(tmp, 'allowed.txt'), 'x');
  const restore = envSnap(['TRISS_PROJECT_ROOT', 'TRISS_RESTRICT_PATHS']);
  process.env.TRISS_PROJECT_ROOT = tmp;
  process.env.TRISS_RESTRICT_PATHS = '1';
  try {
    const { assertSafePath } = await import(`../src/safety.js?root-sb=${Date.now()}`);
    // File inside the configured root is allowed.
    assertSafePath(join(tmp, 'allowed.txt'));
    // process.cwd path that is NOT inside the root is rejected.
    assert.throws(
      () => assertSafePath('/etc/passwd', { kind: 'read' }),
      /outside the project root/,
    );
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('local .triss.env is resolved under the project root', async () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'triss-root-env-')));
  const restore = envSnap(['TRISS_PROJECT_ROOT']);
  process.env.TRISS_PROJECT_ROOT = tmp;
  try {
    const { getEnvFilePath } = await import(`../src/secrets.js?root-local-env=${Date.now()}`);
    assert.equal(getEnvFilePath('local'), join(tmp, '.triss.env'));
  } finally {
    restore();
    rmSync(tmp, { recursive: true, force: true });
  }
});

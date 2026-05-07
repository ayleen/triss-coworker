import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installEntry, uninstallEntry, showStatus } from '../src/mcp/install.js';

function withTempCwd(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-mcp-')));
  const original = process.cwd();
  process.chdir(dir);
  try {
    return fn(dir);
  } finally {
    process.chdir(original);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('installEntry creates ./.mcp.json with the triss entry', () => {
  withTempCwd((dir) => {
    const result = installEntry('local');
    assert.equal(result.status, 'added');
    const config = JSON.parse(readFileSync(result.path, 'utf8'));
    assert.deepEqual(config.mcpServers.triss, {
      command: 'triss',
      args: ['mcp', 'serve'],
      env: { TRISS_PROJECT_ROOT: dir },
    });
  });
});

test('installEntry preserves other top-level keys and other servers', () => {
  withTempCwd(() => {
    writeFileSync(
      '.mcp.json',
      JSON.stringify(
        {
          someOtherKey: 'preserved',
          mcpServers: {
            other: { command: 'other-tool', args: [] },
          },
        },
        null,
        2,
      ),
    );
    installEntry('local');
    const config = JSON.parse(readFileSync('.mcp.json', 'utf8'));
    assert.equal(config.someOtherKey, 'preserved');
    assert.deepEqual(config.mcpServers.other, { command: 'other-tool', args: [] });
    assert.equal(config.mcpServers.triss.command, 'triss');
  });
});

test('installEntry with custom command/args overrides defaults', () => {
  withTempCwd(() => {
    const result = installEntry('local', { command: '/abs/path/triss.js', args: ['mcp'] });
    const config = JSON.parse(readFileSync(result.path, 'utf8'));
    assert.equal(config.mcpServers.triss.command, '/abs/path/triss.js');
    assert.deepEqual(config.mcpServers.triss.args, ['mcp']);
    assert.equal(config.mcpServers.triss.env.TRISS_PROJECT_ROOT, process.cwd());
  });
});

test('installEntry pins TRISS_PROJECT_ROOT and preserves custom env', () => {
  withTempCwd((dir) => {
    const result = installEntry('local', { env: { EXTRA: '1' } });
    const config = JSON.parse(readFileSync(result.path, 'utf8'));
    assert.deepEqual(config.mcpServers.triss.env, {
      EXTRA: '1',
      TRISS_PROJECT_ROOT: dir,
    });
  });
});

test('installEntry on existing entry returns "updated"', () => {
  withTempCwd(() => {
    installEntry('local');
    const second = installEntry('local', { command: 'triss-v2' });
    assert.equal(second.status, 'updated');
    const config = JSON.parse(readFileSync(second.path, 'utf8'));
    assert.equal(config.mcpServers.triss.command, 'triss-v2');
  });
});

test('uninstallEntry removes the triss key but keeps other servers', () => {
  withTempCwd(() => {
    writeFileSync(
      '.mcp.json',
      JSON.stringify({
        mcpServers: {
          triss: { command: 'triss', args: ['mcp', 'serve'] },
          other: { command: 'x', args: [] },
        },
      }),
    );
    const r = uninstallEntry('local');
    assert.equal(r.status, 'removed');
    const config = JSON.parse(readFileSync('.mcp.json', 'utf8'));
    assert.equal('triss' in config.mcpServers, false);
    assert.equal('other' in config.mcpServers, true);
  });
});

test('uninstallEntry on absent file is a noop', () => {
  withTempCwd(() => {
    const r = uninstallEntry('local');
    assert.equal(r.status, 'absent');
    assert.equal(existsSync('.mcp.json'), false);
  });
});

test('showStatus reports presence and entry shape', () => {
  withTempCwd(() => {
    let s = showStatus('local');
    assert.equal(s.present, false);
    installEntry('local');
    s = showStatus('local');
    assert.equal(s.present, true);
    assert.equal(s.entry.command, 'triss');
  });
});

test('installEntry rejects malformed config files', () => {
  withTempCwd(() => {
    writeFileSync('.mcp.json', '{ this is not json');
    assert.throws(() => installEntry('local'), /not valid JSON/);
  });
});

// ─── Codex (TOML) ────────────────────────────────────────────────────────────

import { mkdirSync } from 'node:fs';

function withTmpHome(fn) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-codex-home-')));
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    fn(home);
  } finally {
    process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
}

test('CODEX-01: installEntry --target codex writes TOML to ~/.codex/config.toml', () => {
  withTmpHome((home) => {
    withTempCwd((cwd) => {
      const result = installEntry('global', { target: 'codex' });
      assert.equal(result.target, 'codex');
      assert.equal(result.status, 'added');
      assert.equal(result.path, join(home, '.codex', 'config.toml'));

      const toml = readFileSync(result.path, 'utf8');
      assert.match(toml, /^\[mcp_servers\.triss\]$/m);
      assert.match(toml, /^command = "triss"$/m);
      assert.match(toml, /^args = \["mcp", "serve"\]$/m);
      assert.match(toml, /^startup_timeout_sec = 30$/m);
      assert.match(toml, /^tool_timeout_sec = 120$/m);
      assert.match(toml, /^\[mcp_servers\.triss\.env\]$/m);
      // TRISS_PROJECT_ROOT must point at the cwd we used.
      assert.match(toml, new RegExp(`TRISS_PROJECT_ROOT = "${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'm'));
    });
  });
});

test('CODEX-02: installEntry --target codex preserves other sections and comments', () => {
  withTmpHome((home) => {
    const dir = join(home, '.codex');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'config.toml');
    const existing = [
      '# user config',
      'model = "gpt-5"',
      '',
      '[mcp_servers.other]',
      'command = "other-tool"',
      'args = []',
      '',
      '[ui]',
      'theme = "dark"',
      '',
    ].join('\n');
    writeFileSync(path, existing);

    withTempCwd(() => {
      const r = installEntry('global', { target: 'codex' });
      assert.equal(r.status, 'added');
      const toml = readFileSync(path, 'utf8');
      assert.ok(toml.includes('# user config'));
      assert.ok(toml.includes('model = "gpt-5"'));
      assert.ok(toml.includes('[mcp_servers.other]'));
      assert.ok(toml.includes('command = "other-tool"'));
      assert.ok(toml.includes('[ui]'));
      assert.ok(toml.includes('theme = "dark"'));
      assert.ok(toml.includes('[mcp_servers.triss]'));
    });
  });
});

test('CODEX-03: re-installing returns "updated" and replaces the block in place', () => {
  withTmpHome(() => {
    withTempCwd(() => {
      installEntry('global', { target: 'codex' });
      const second = installEntry('global', {
        target: 'codex',
        command: '/abs/triss-v2',
        args: ['mcp'],
      });
      assert.equal(second.status, 'updated');
      const toml = readFileSync(second.path, 'utf8');
      assert.match(toml, /^command = "\/abs\/triss-v2"$/m);
      assert.match(toml, /^args = \["mcp"\]$/m);
      // No duplicate block — the section should appear exactly once.
      const hits = toml.match(/^\[mcp_servers\.triss\]$/gm) || [];
      assert.equal(hits.length, 1, 'block should not be duplicated on re-install');
    });
  });
});

test('CODEX-04: uninstallEntry --target codex removes only our block', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      path,
      [
        'model = "gpt-5"',
        '',
        '[mcp_servers.other]',
        'command = "other-tool"',
        'args = []',
        '',
      ].join('\n'),
    );

    withTempCwd(() => {
      installEntry('global', { target: 'codex' });
      const r = uninstallEntry('global', { target: 'codex' });
      assert.equal(r.status, 'removed');
      const toml = readFileSync(path, 'utf8');
      assert.ok(!toml.includes('[mcp_servers.triss]'), 'triss block should be gone');
      assert.ok(toml.includes('[mcp_servers.other]'), 'other section preserved');
      assert.ok(toml.includes('model = "gpt-5"'), 'top-level keys preserved');
    });
  });
});

test('CODEX-05: uninstallEntry on absent codex config returns "absent"', () => {
  withTmpHome(() => {
    const r = uninstallEntry('global', { target: 'codex' });
    assert.equal(r.status, 'absent');
  });
});

test('CODEX-06: showStatus --target codex reports presence and the rendered block', () => {
  withTmpHome(() => {
    withTempCwd(() => {
      let s = showStatus('global', { target: 'codex' });
      assert.equal(s.present, false);
      installEntry('global', { target: 'codex' });
      s = showStatus('global', { target: 'codex' });
      assert.equal(s.present, true);
      assert.match(String(s.entry), /\[mcp_servers\.triss\]/);
      assert.match(String(s.entry), /command = "triss"/);
    });
  });
});

test('CODEX-07: --local --target codex throws a clear error', () => {
  assert.throws(
    () => installEntry('local', { target: 'codex' }),
    /Codex doesn't support project-local/,
  );
});

test('CODEX-08: TOML escapes backslashes and double quotes in paths', () => {
  withTmpHome(() => {
    withTempCwd(() => {
      const result = installEntry('global', {
        target: 'codex',
        command: 'C:\\path with "quotes"\\triss.exe',
      });
      const toml = readFileSync(result.path, 'utf8');
      assert.match(
        toml,
        /^command = "C:\\\\path with \\"quotes\\"\\\\triss\.exe"$/m,
        'special chars must be escaped',
      );
    });
  });
});

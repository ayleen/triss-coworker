import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installEntry, uninstallEntry, showStatus } from '../src/mcp/install.js';

function withTempCwd(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'triss-mcp-'));
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
  withTempCwd(() => {
    const result = installEntry('local');
    assert.equal(result.status, 'added');
    const config = JSON.parse(readFileSync(result.path, 'utf8'));
    assert.deepEqual(config.mcpServers.triss, { command: 'triss', args: ['mcp', 'serve'] });
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

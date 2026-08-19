import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  realpathSync,
  chmodSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installEntry, uninstallEntry, showStatus, atomicReplaceCodexConfig } from '../src/mcp/install.js';

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

test('CODEX-01: installEntry --target codex writes TOML to ~/.codex/config.toml without pinning sandbox root', () => {
  withTmpHome((home) => {
    withTempCwd(() => {
      const result = installEntry('global', { target: 'codex' });
      assert.equal(result.target, 'codex');
      assert.equal(result.status, 'added');
      assert.equal(result.path, join(home, '.codex', 'config.toml'));

      const toml = readFileSync(result.path, 'utf8');
      assert.match(toml, /^\[mcp_servers\.triss\]$/m);
      assert.match(toml, /^command = "triss"$/m);
      assert.match(toml, /^args = \["mcp", "serve"\]$/m);
      assert.match(toml, /^startup_timeout_sec = 30$/m);
      // The outer tool timeout (5460s = 3 attempts × 1800s + 60s headroom)
      // must cover the OpenAI SDK's default 2 retries plus the first attempt
      // of the internal 30-minute GLM-review timeout, so the host never kills
      // a long thinking review.
      assert.match(toml, /^tool_timeout_sec = 5460$/m);
      // Codex global must NOT bake TRISS_PROJECT_ROOT — that would pin every
      // Codex session to a single fixed directory regardless of which project
      // it was launched in (see install.js comment).
      assert.ok(
        !/TRISS_PROJECT_ROOT/.test(toml),
        'global Codex install must not pin TRISS_PROJECT_ROOT',
      );
      // No env section at all when there are no custom env keys to render.
      assert.ok(!/^\[mcp_servers\.triss\.env\]$/m.test(toml));
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

test('CODEX-09: re-installing replaces an old tool_timeout_sec=120 block with 5460 and preserves unrelated TOML', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    // Simulate a Codex entry written by an older triss version, with an
    // unrelated top-level key, another MCP server, and a comment alongside.
    writeFileSync(
      path,
      [
        '# user config',
        'model = "gpt-5"',
        '',
        '[mcp_servers.triss]',
        'command = "triss"',
        'args = ["mcp", "serve"]',
        'startup_timeout_sec = 30',
        'tool_timeout_sec = 120',
        '',
        '[mcp_servers.other]',
        'command = "other-tool"',
        'args = []',
        '',
        '[ui]',
        'theme = "dark"',
        '',
      ].join('\n'),
    );
    withTempCwd(() => {
      const r = installEntry('global', { target: 'codex' });
      assert.equal(r.status, 'updated');
      const toml = readFileSync(path, 'utf8');
      // The stale cap is replaced with the current default.
      assert.match(toml, /^tool_timeout_sec = 5460$/m);
      assert.ok(!/tool_timeout_sec = 120/.test(toml), 'stale 120s cap must be gone');
      // Unrelated TOML is preserved byte-for-byte.
      assert.ok(toml.includes('# user config'));
      assert.ok(toml.includes('model = "gpt-5"'));
      assert.ok(toml.includes('[mcp_servers.other]'));
      assert.ok(toml.includes('command = "other-tool"'));
      assert.ok(toml.includes('[ui]'));
      assert.ok(toml.includes('theme = "dark"'));
    });
  });
});

test('CODEX-10: a quoted ["mcp_servers.triss"] user table after the block survives install, reinstall, uninstall, and status', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    // A quoted SINGLE-component table whose literal key name contains a dot.
    // TOML treats ["mcp_servers.triss"] as ONE key whose name is literally
    // "mcp_servers.triss" — a completely different table from
    // [mcp_servers.triss] (two components). Only the two-component quoted
    // form (["mcp_servers"."triss"]) names the same table (see CODEX-16/17),
    // so install/status/uninstall must never absorb, remove, or report this
    // single-component collision table as part of the generated block.
    const quotedTable = [
      '',
      '["mcp_servers.triss"]',
      'custom_key = "user value"',
      '',
    ].join('\n');
    writeFileSync(path, 'model = "gpt-5"\n' + quotedTable);

    withTempCwd(() => {
      // Install: the quoted table must be preserved next to the added block.
      const added = installEntry('global', { target: 'codex' });
      assert.equal(added.status, 'added');
      let toml = readFileSync(path, 'utf8');
      assert.ok(
        toml.includes('["mcp_servers.triss"]\ncustom_key = "user value"'),
        'quoted table must survive install',
      );
      // Status: the quoted user table is NOT part of the generated block.
      let s = showStatus('global', { target: 'codex' });
      assert.equal(s.present, true);
      assert.ok(
        !String(s.entry).includes('custom_key'),
        'quoted user table must not be reported inside the generated block',
      );

      // Reinstall: the block is replaced in place; the quoted table survives.
      const updated = installEntry('global', { target: 'codex', command: 'triss-v2' });
      assert.equal(updated.status, 'updated');
      toml = readFileSync(path, 'utf8');
      assert.match(toml, /^command = "triss-v2"$/m);
      assert.ok(
        toml.includes('["mcp_servers.triss"]\ncustom_key = "user value"'),
        'quoted table must survive reinstall',
      );
      const bareHits = toml.match(/^\[mcp_servers\.triss\]$/gm) || [];
      assert.equal(bareHits.length, 1, 'the bare block must still appear exactly once');

      // Uninstall: only the generated bare block is removed; the quoted user
      // table must be preserved byte-for-byte.
      const removed = uninstallEntry('global', { target: 'codex' });
      assert.equal(removed.status, 'removed');
      toml = readFileSync(path, 'utf8');
      assert.ok(
        !/^\[mcp_servers\.triss\]$/m.test(toml),
        'the generated bare block must be gone',
      );
      assert.ok(
        toml.includes('["mcp_servers.triss"]\ncustom_key = "user value"'),
        'quoted table must survive uninstall',
      );
      assert.ok(toml.includes('model = "gpt-5"'), 'other top-level content preserved');
    });
  });
});

test('CODEX-11: a generated Triss block following cross-line multiline arrays is found and replaced exactly once on reinstall; status/uninstall survive', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    // User config with valid TOML arrays whose elements are CROSS-LINE
    // multi-line basic/literal strings: the closing delimiter is followed by a
    // comma (`""",`) and further elements. The generated bare Triss block sits
    // AFTER these arrays. A scan that rejects the file as malformed would fail
    // to find the block and append a duplicate on reinstall — the exact defect
    // this regression guards against.
    const existing = [
      '[foo]',
      'values = [',
      '"""',
      'basic one',
      '""",',
      '"plain",',
      "['''",
      'literal one',
      "''',",
      ']',
      ']',
      '',
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(path, existing);

    withTempCwd(() => {
      // Reinstall: the existing block must be FOUND and replaced in place —
      // "updated", never "added", and never duplicated.
      const r = installEntry('global', { target: 'codex', command: 'triss-v2' });
      assert.equal(r.status, 'updated');
      const toml = readFileSync(path, 'utf8');
      assert.match(toml, /^command = "triss-v2"$/m);
      assert.match(toml, /^tool_timeout_sec = 5460$/m);
      const hits = toml.match(/^\[mcp_servers\.triss\]$/gm) || [];
      assert.equal(hits.length, 1, 'block should not be duplicated on reinstall');
      // The user arrays must survive byte-for-byte, `""",` commas included.
      assert.ok(
        toml.includes(
          '[foo]\nvalues = [\n"""\nbasic one\n""",\n"plain",\n' +
            "['''\nliteral one\n''',\n]\n]",
        ),
        'cross-line multiline arrays must survive reinstall byte-for-byte',
      );

      // Status: the generated block is found and reported present; the user
      // arrays are NOT part of its reported entry.
      const s = showStatus('global', { target: 'codex' });
      assert.equal(s.present, true);
      assert.ok(
        !String(s.entry).includes('basic one'),
        'user arrays must not be reported inside the generated block',
      );

      // Uninstall: only the generated block is removed; the user arrays and
      // their cross-line multiline content survive.
      const removed = uninstallEntry('global', { target: 'codex' });
      assert.equal(removed.status, 'removed');
      const after = readFileSync(path, 'utf8');
      assert.ok(!/^\[mcp_servers\.triss\]$/m.test(after), 'the generated block must be gone');
      assert.ok(after.includes('[foo]'), 'user arrays must survive uninstall');
      assert.ok(
        after.includes('"""\nbasic one\n""",\n"plain"'),
        'cross-line multiline array content must survive uninstall',
      );
    });
  });
});

test('CODEX-12: a generated Triss block surrounded by nested multi-line arrays ([1, 2] element lines) is found and replaced exactly once on reinstall; status/uninstall survive', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    // User config whose arrays hold array / inline-table elements that open
    // on their OWN lines while the enclosing array is still open: `[1, 2],`
    // inside an array of arrays, `[[1], [2]],`, and `{ a = [1, 2] },` inline
    // tables. These lines are VALUES, never table headers — a scanner that
    // treats every code line starting with `[` as a header marks the file
    // malformed, misses the generated bare Triss block, and appends a
    // duplicate on reinstall. Nested arrays sit BEFORE and AFTER the block
    // (around it), plus one inside the block itself.
    const existing = [
      '[foo]',
      'matrix = [',
      '[1, 2],',
      '[3, 4],',
      ']',
      'nested = [',
      '[[1], [2]],',
      ']',
      'inline = [',
      '{ a = [1, 2] },',
      ']',
      '',
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      'matrix = [',
      '[1, 2],',
      ']',
      'tool_timeout_sec = 120',
      '',
      '[bar]',
      'after = [',
      '[7, 8],',
      ']',
      '',
    ].join('\n');
    writeFileSync(path, existing);

    withTempCwd(() => {
      // Reinstall: the existing block must be FOUND and replaced in place —
      // "updated", never "added", and never duplicated.
      const r = installEntry('global', { target: 'codex', command: 'triss-v2' });
      assert.equal(r.status, 'updated');
      const toml = readFileSync(path, 'utf8');
      assert.match(toml, /^command = "triss-v2"$/m);
      const hits = toml.match(/^\[mcp_servers\.triss\]$/gm) || [];
      assert.equal(hits.length, 1, 'block should not be duplicated on reinstall');
      // The user arrays — before, inside, and after the block — survive
      // byte-for-byte, `[1, 2],` element lines included.
      assert.ok(
        toml.includes(
          '[foo]\nmatrix = [\n[1, 2],\n[3, 4],\n]\nnested = [\n[[1], [2]],\n]\n' +
            'inline = [\n{ a = [1, 2] },\n]',
        ),
        'before-block nested array element lines must survive reinstall byte-for-byte',
      );
      assert.ok(
        toml.includes('[bar]\nafter = [\n[7, 8],\n]'),
        'after-block nested array element lines must survive reinstall byte-for-byte',
      );

      // Status: the generated block is found and reported present; the user
      // arrays are NOT part of its reported entry.
      const s = showStatus('global', { target: 'codex' });
      assert.equal(s.present, true);
      assert.ok(
        !String(s.entry).includes('[1, 2]'),
        'user arrays must not be reported inside the generated block',
      );

      // Uninstall: only the generated block is removed; the user arrays and
      // their nested element lines survive.
      const removed = uninstallEntry('global', { target: 'codex' });
      assert.equal(removed.status, 'removed');
      const after = readFileSync(path, 'utf8');
      assert.ok(!/^\[mcp_servers\.triss\]$/m.test(after), 'the generated block must be gone');
      assert.ok(
        after.includes('[foo]\nmatrix = [\n[1, 2],\n[3, 4],\n]\nnested = [\n[[1], [2]],\n]\n'),
        'before-block nested arrays must survive uninstall',
      );
      assert.ok(
        after.includes('[bar]\nafter = [\n[7, 8],\n]'),
        'after-block nested arrays must survive uninstall',
      );
    });
  });
});

// ─── lexically malformed TOML fails closed (install/status/uninstall) ────────
//
// A malformed Claude config makes installEntry throw (readJson, "not valid
// JSON"). The Codex TOML operations must behave the same: a lexically
// malformed config throws a clear error and its bytes stay untouched —
// install must never treat it as absent and append a duplicate block,
// status must not silently report "not registered", and uninstall must not
// silently no-op.

test('CODEX-13: installEntry --target codex throws on lexically malformed TOML and leaves bytes unchanged', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    for (const malformed of [
      // An unparseable header-like line.
      ['[mcp_servers.triss]', 'tool_timeout_sec = 120', '[unclosed', ''].join('\n'),
      // A header with a trailing dot: after a dot another key part is mandatory.
      ['[mcp_servers.triss.]', 'tool_timeout_sec = 120', ''].join('\n'),
      // An unterminated multi-line string.
      ['[mcp_servers.triss]', 'msg = """', 'never closed', ''].join('\n'),
    ]) {
      writeFileSync(path, malformed);
      assert.throws(() => installEntry('global', { target: 'codex' }), /not lexically valid TOML/);
      assert.equal(
        readFileSync(path, 'utf8'),
        malformed,
        'a malformed config must never be modified by install (no duplicate append)',
      );
    }
  });
});

test('CODEX-14: showStatus --target codex throws on lexically malformed TOML and leaves bytes unchanged', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    for (const malformed of [
      ['[mcp_servers.triss.]', 'tool_timeout_sec = 120', ''].join('\n'),
      ['[mcp_servers.triss]', 'tool_timeout_sec = 120', ']', ''].join('\n'),
    ]) {
      writeFileSync(path, malformed);
      assert.throws(() => showStatus('global', { target: 'codex' }), /not lexically valid TOML/);
      assert.equal(
        readFileSync(path, 'utf8'),
        malformed,
        'a malformed config must never be reported as merely "not registered"',
      );
    }
  });
});

test('CODEX-15: uninstallEntry --target codex throws on lexically malformed TOML and leaves bytes unchanged', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    for (const malformed of [
      ['[mcp_servers.triss.]', 'tool_timeout_sec = 120', ''].join('\n'),
      ['[mcp_servers.triss]', 'msg = """', 'never closed', ''].join('\n'),
    ]) {
      writeFileSync(path, malformed);
      assert.throws(() => uninstallEntry('global', { target: 'codex' }), /not lexically valid TOML/);
      assert.equal(
        readFileSync(path, 'utf8'),
        malformed,
        'a malformed config must never be silently left as a "absent" no-op',
      );
    }
  });
});

// ─── quoted / mixed two-component roots are the same Triss table ─────────────
//
// TOML dotted keys: ["mcp_servers"."triss"] and ["mcp_servers".triss] (mixed
// quoting) name the SAME table as the generated bare [mcp_servers.triss] —
// quoting never changes which table a dotted key names. install/status/
// uninstall must recognize these forms so install replaces them without
// creating a duplicate, status reports them, and uninstall removes them. The
// SINGLE-component ["mcp_servers.triss"] stays a different table (CODEX-10),
// and the automatic legacy-timeout migration stays deliberately narrow to the
// exact bare form (LEXER-08/MIGRATE-22 in mcp-codex-timeout-migration.test.js).

test('CODEX-16: a two-component quoted root is updated in place by install and removed by uninstall; status sees it', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      path,
      [
        'model = "gpt-5"',
        '',
        '["mcp_servers"."triss"]',
        'command = "triss"',
        'args = ["mcp", "serve"]',
        'tool_timeout_sec = 120',
        '',
        '["mcp_servers"."triss"."env"]',
        'TRISS_PROJECT_ROOT = "/old/codex/path"',
        '',
      ].join('\n'),
    );

    withTempCwd(() => {
      // Status: the two-component quoted root IS the Triss table — reported
      // present with the quoted block as its entry.
      const s = showStatus('global', { target: 'codex' });
      assert.equal(s.present, true);
      assert.match(String(s.entry), /command = "triss"/);
      assert.match(String(s.entry), /\["mcp_servers"\."triss"\]/);

      // Install: replaces the quoted root AND its quoted env sub-table with
      // the generated bare block — "updated", never a duplicate append.
      const r = installEntry('global', { target: 'codex' });
      assert.equal(r.status, 'updated');
      assert.equal(r.migratedFrom, '/old/codex/path', 'stale pin inside the quoted root must be surfaced');
      let toml = readFileSync(path, 'utf8');
      const bareHits = toml.match(/^\[mcp_servers\.triss\]$/gm) || [];
      assert.equal(bareHits.length, 1, 'exactly one semantic Triss root after install');
      assert.ok(
        !/^\["mcp_servers"\."triss"\]/m.test(toml) && !/^\["mcp_servers"\."triss"\."env"\]/m.test(toml),
        'the quoted root and its env sub-table must be replaced by the bare form',
      );
      assert.match(toml, /^tool_timeout_sec = 5460$/m);
      assert.ok(!/TRISS_PROJECT_ROOT/.test(toml), 'stale pin must be dropped with the replaced block');
      assert.ok(toml.includes('model = "gpt-5"'), 'unrelated TOML preserved');

      // Reinstall: still exactly one semantic Triss root — never duplicated.
      const second = installEntry('global', { target: 'codex', command: 'triss-v2' });
      assert.equal(second.status, 'updated');
      toml = readFileSync(path, 'utf8');
      const bareHitsAfter = toml.match(/^\[mcp_servers\.triss\]$/gm) || [];
      assert.equal(bareHitsAfter.length, 1, 'exactly one semantic Triss root after reinstall');
      assert.match(toml, /^command = "triss-v2"$/m);

      // Uninstall: removes the semantic root entirely (bare form), keeping
      // the rest of the file byte-for-byte.
      const removed = uninstallEntry('global', { target: 'codex' });
      assert.equal(removed.status, 'removed');
      toml = readFileSync(path, 'utf8');
      assert.ok(!/^\[mcp_servers\.triss\]$/m.test(toml), 'the bare root must be gone');
      assert.ok(
        !/mcp_servers/.test(toml) && !/triss/.test(toml),
        'no quoted or bare Triss remnant may survive uninstall',
      );
      assert.ok(toml.includes('model = "gpt-5"'), 'unrelated TOML preserved');
    });
  });
});

test('CODEX-17: a mixed-quoting two-component root is the same table for install/status/uninstall', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      path,
      ['["mcp_servers".triss]', 'command = "triss"', 'args = ["mcp", "serve"]', ''].join('\n'),
    );

    withTempCwd(() => {
      // Status sees the mixed-quoting root as the registered Triss entry.
      const s = showStatus('global', { target: 'codex' });
      assert.equal(s.present, true);
      assert.match(String(s.entry), /command = "triss"/);

      // Install replaces it with the bare generated form — "updated", and
      // exactly one semantic Triss root afterwards.
      const r = installEntry('global', { target: 'codex' });
      assert.equal(r.status, 'updated');
      const toml = readFileSync(path, 'utf8');
      const bareHits = toml.match(/^\[mcp_servers\.triss\]$/gm) || [];
      assert.equal(bareHits.length, 1, 'exactly one semantic Triss root after install');
      assert.ok(!toml.includes('["mcp_servers".triss]'), 'mixed root must be replaced by the bare form');

      // Uninstall removes it.
      const removed = uninstallEntry('global', { target: 'codex' });
      assert.equal(removed.status, 'removed');
      const after = readFileSync(path, 'utf8');
      assert.ok(!/mcp_servers/.test(after) && !/triss/.test(after), 'no Triss remnant may survive');
    });
  });
});

// ─── escaped quoted roots are the same Triss table ───────────────────────────
//
// A backslash inside a BASIC quoted key is a TOML basic-string escape that the
// header parser DECODES. ["mcp\u005Fservers"."triss"] therefore names the same
// two components as ["mcp_servers"."triss"] — the Triss root — so install/
// status/uninstall must recognize it exactly like the plain quoted root
// (CODEX-16/17): install replaces it without creating a duplicate, status
// reports it, uninstall removes it. An escape that DECODES TO A DOT
// (["mcp_servers\u002Etriss"]) is ONE component literally named
// "mcp_servers.triss" — the same different table as ["mcp_servers.triss"]
// (CODEX-10) — and must never be absorbed, reported, or removed. Invalid or
// incomplete escapes make the header undecodable; the config is lexically
// malformed and every public path fails closed without touching a byte.

test('CODEX-18: an escaped two-component root is updated in place by install and removed by uninstall; status sees it', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    // \u005F is underscore, \u0073 is 's', \x73 is also 's' (TOML 1.1 8-bit
    // escape): each escaped spelling decodes to mcp_servers / triss.
    writeFileSync(
      path,
      [
        'model = "gpt-5"',
        '',
        '["mcp\\u005Fservers"."triss"]',
        'command = "triss"',
        'args = ["mcp", "serve"]',
        'tool_timeout_sec = 120',
        '',
        '["mcp\\u005Fservers"."triss"."env"]',
        'TRISS_PROJECT_ROOT = "/old/codex/path"',
        '',
      ].join('\n'),
    );

    withTempCwd(() => {
      // Status: the escaped root IS the Triss table — reported present with
      // the escaped block as its entry.
      const s = showStatus('global', { target: 'codex' });
      assert.equal(s.present, true);
      assert.match(String(s.entry), /command = "triss"/);

      // Install: replaces the escaped root AND its escaped env sub-table with
      // the generated bare block — "updated", never a duplicate append.
      const r = installEntry('global', { target: 'codex' });
      assert.equal(r.status, 'updated');
      assert.equal(r.migratedFrom, '/old/codex/path', 'stale pin inside the escaped root must be surfaced');
      let toml = readFileSync(path, 'utf8');
      const bareHits = toml.match(/^\[mcp_servers\.triss\]$/gm) || [];
      assert.equal(bareHits.length, 1, 'exactly one semantic Triss root after install');
      assert.ok(!toml.includes('\\u005Fservers'), 'the escaped root must be replaced by the bare form');
      assert.match(toml, /^tool_timeout_sec = 5460$/m);
      assert.ok(!/TRISS_PROJECT_ROOT/.test(toml), 'stale pin must be dropped with the replaced block');
      assert.ok(toml.includes('model = "gpt-5"'), 'unrelated TOML preserved');

      // Reinstall: still exactly one semantic Triss root — never duplicated.
      const second = installEntry('global', { target: 'codex', command: 'triss-v2' });
      assert.equal(second.status, 'updated');
      toml = readFileSync(path, 'utf8');
      const bareHitsAfter = toml.match(/^\[mcp_servers\.triss\]$/gm) || [];
      assert.equal(bareHitsAfter.length, 1, 'exactly one semantic Triss root after reinstall');
      assert.match(toml, /^command = "triss-v2"$/m);

      // Uninstall: removes the semantic root entirely, keeping the rest of
      // the file byte-for-byte.
      const removed = uninstallEntry('global', { target: 'codex' });
      assert.equal(removed.status, 'removed');
      toml = readFileSync(path, 'utf8');
      assert.ok(!/^\[mcp_servers\.triss\]$/m.test(toml), 'the bare root must be gone');
      assert.ok(
        !/mcp_servers/.test(toml) && !/triss/.test(toml),
        'no escaped, quoted, or bare Triss remnant may survive uninstall',
      );
      assert.ok(toml.includes('model = "gpt-5"'), 'unrelated TOML preserved');
    });
  });
});

test('CODEX-19: an escape decoding to a literal dot keeps a single-component table distinct — never absorbed, reported, or removed', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    // ["mcp_servers\u002Etriss"] decodes to ONE component whose literal name
    // is "mcp_servers.triss" — the same different table as
    // ["mcp_servers.triss"] (CODEX-10), never the two-component Triss root.
    const escapedTable = [
      '',
      '["mcp_servers\\u002Etriss"]',
      'custom_key = "user value"',
      '',
    ].join('\n');
    writeFileSync(path, 'model = "gpt-5"\n' + escapedTable);

    withTempCwd(() => {
      // Install: the escaped single-component table must be preserved next to
      // the added block.
      const added = installEntry('global', { target: 'codex' });
      assert.equal(added.status, 'added');
      let toml = readFileSync(path, 'utf8');
      assert.ok(
        toml.includes('["mcp_servers\\u002Etriss"]\ncustom_key = "user value"'),
        'escaped single-component table must survive install',
      );
      // Status: the escaped single-component table is NOT part of the
      // generated block's entry.
      const s = showStatus('global', { target: 'codex' });
      assert.equal(s.present, true);
      assert.ok(
        !String(s.entry).includes('custom_key'),
        'escaped single-component table must not be reported inside the generated block',
      );

      // Reinstall: the block is replaced in place; the escaped table survives.
      const updated = installEntry('global', { target: 'codex', command: 'triss-v2' });
      assert.equal(updated.status, 'updated');
      toml = readFileSync(path, 'utf8');
      assert.match(toml, /^command = "triss-v2"$/m);
      assert.ok(
        toml.includes('["mcp_servers\\u002Etriss"]\ncustom_key = "user value"'),
        'escaped single-component table must survive reinstall',
      );
      const bareHits = toml.match(/^\[mcp_servers\.triss\]$/gm) || [];
      assert.equal(bareHits.length, 1, 'the bare block must still appear exactly once');

      // Uninstall: only the generated bare block is removed; the escaped
      // single-component table must be preserved byte-for-byte.
      const removed = uninstallEntry('global', { target: 'codex' });
      assert.equal(removed.status, 'removed');
      toml = readFileSync(path, 'utf8');
      assert.ok(
        !/^\[mcp_servers\.triss\]$/m.test(toml),
        'the generated bare block must be gone',
      );
      assert.ok(
        toml.includes('["mcp_servers\\u002Etriss"]\ncustom_key = "user value"'),
        'escaped single-component table must survive uninstall',
      );
      assert.ok(toml.includes('model = "gpt-5"'), 'other top-level content preserved');
    });
  });
});

test('CODEX-20: invalid escapes in quoted headers fail closed on install/status/uninstall, bytes unchanged', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    for (const malformed of [
      // Unknown escape letter.
      ['["\\q"]', 'tool_timeout_sec = 120', ''].join('\n'),
      // Truncated 16-bit escape in the second component of an otherwise-valid root.
      ['["mcp\\u005Fservers"."\\u12"]', 'tool_timeout_sec = 120', ''].join('\n'),
      // A surrogate code point is not a Unicode scalar value.
      ['["mcp\\u005Fservers"."\\uD800"]', 'tool_timeout_sec = 120', ''].join('\n'),
      // Above U+10FFFF via a 32-bit escape.
      ['["mcp\\U0000005Fservers"."\\UFFFFFFFF"]', 'tool_timeout_sec = 120', ''].join('\n'),
    ]) {
      writeFileSync(path, malformed);
      assert.throws(() => installEntry('global', { target: 'codex' }), /not lexically valid TOML/);
      assert.throws(() => showStatus('global', { target: 'codex' }), /not lexically valid TOML/);
      assert.throws(() => uninstallEntry('global', { target: 'codex' }), /not lexically valid TOML/);
      assert.equal(
        readFileSync(path, 'utf8'),
        malformed,
        'an invalid escape in a header must fail closed — bytes stay byte-for-byte',
      );
    }
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

// ─── scope-aware TRISS_PROJECT_ROOT pinning ──────────────────────────────────

test('SCOPE-01: global Claude install does not pin TRISS_PROJECT_ROOT', () => {
  withTmpHome((home) => {
    withTempCwd(() => {
      const r = installEntry('global', { target: 'claude' });
      assert.equal(r.path, join(home, '.claude.json'));
      const config = JSON.parse(readFileSync(r.path, 'utf8'));
      const entry = config.mcpServers.triss;
      assert.equal(entry.command, 'triss');
      assert.deepEqual(entry.args, ['mcp', 'serve']);
      // Either no env at all, or env without TRISS_PROJECT_ROOT.
      assert.ok(
        !entry.env || !('TRISS_PROJECT_ROOT' in entry.env),
        'global install must not pin TRISS_PROJECT_ROOT',
      );
    });
  });
});

test('SCOPE-02: global Claude install with custom env keeps custom keys, drops TRISS_PROJECT_ROOT', () => {
  withTmpHome(() => {
    withTempCwd(() => {
      const r = installEntry('global', {
        target: 'claude',
        env: { CUSTOM_FLAG: '1' },
      });
      const config = JSON.parse(readFileSync(r.path, 'utf8'));
      assert.deepEqual(config.mcpServers.triss.env, { CUSTOM_FLAG: '1' });
    });
  });
});

test('SCOPE-03: re-installing globally drops a stale TRISS_PROJECT_ROOT and surfaces it via migratedFrom', () => {
  withTmpHome((home) => {
    const path = join(home, '.claude.json');
    // Simulate an entry written by an older triss version.
    writeFileSync(
      path,
      JSON.stringify(
        {
          mcpServers: {
            triss: {
              command: 'triss',
              args: ['mcp', 'serve'],
              env: { TRISS_PROJECT_ROOT: '/old/project/path' },
            },
          },
        },
        null,
        2,
      ),
    );
    withTempCwd(() => {
      const r = installEntry('global', { target: 'claude' });
      assert.equal(r.status, 'updated');
      assert.equal(r.migratedFrom, '/old/project/path');
      const config = JSON.parse(readFileSync(path, 'utf8'));
      assert.ok(
        !config.mcpServers.triss.env ||
          !('TRISS_PROJECT_ROOT' in (config.mcpServers.triss.env || {})),
        'stale TRISS_PROJECT_ROOT must be removed on re-install',
      );
    });
  });
});

test('SCOPE-04: re-installing locally refreshes TRISS_PROJECT_ROOT and does not flag migration', () => {
  withTempCwd((dir) => {
    // First install pins one path.
    installEntry('local');
    // Second install from the same cwd just refreshes; migratedFrom stays
    // undefined because the new entry still pins a (current) value.
    const second = installEntry('local');
    assert.equal(second.status, 'updated');
    assert.equal(second.migratedFrom, undefined);
    const config = JSON.parse(readFileSync(second.path, 'utf8'));
    assert.equal(config.mcpServers.triss.env.TRISS_PROJECT_ROOT, dir);
  });
});

test('SCOPE-05: re-installing for Codex drops a previously baked TRISS_PROJECT_ROOT', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    // Hand-write a Codex block that previous triss versions used to emit.
    writeFileSync(
      path,
      [
        '[mcp_servers.triss]',
        'command = "triss"',
        'args = ["mcp", "serve"]',
        '',
        '[mcp_servers.triss.env]',
        'TRISS_PROJECT_ROOT = "/old/codex/path"',
        '',
      ].join('\n'),
    );
    withTempCwd(() => {
      const r = installEntry('global', { target: 'codex' });
      assert.equal(r.status, 'updated');
      assert.equal(r.migratedFrom, '/old/codex/path');
      const toml = readFileSync(path, 'utf8');
      assert.ok(!/TRISS_PROJECT_ROOT/.test(toml), 'stale pin must be gone');
    });
  });
});

// ─── public-path atomicity: validated-snapshot CAS races (GLM 5.3) ───────────
//
// install/uninstall must read AND scan the existing config from ONE validated
// snapshot (snapshotCodexConfig) and commit with that SAME snapshot as the
// atomicReplace CAS precondition. A change that lands between the read and the
// write — content, symlink retarget (even to a same-content sibling), inode,
// or mode — fails closed with a thrown precondition error and every byte is
// preserved. A MISSING config installs through the atomic no-clobber create,
// so a concurrently-appearing file is never overwritten and readers only ever
// see a complete inode (never partial bytes). Success paths preserve the
// symlink and the mode. The races are driven deterministically through the
// same injected atomicWrite/readFile seams the migration tests use.

test('PUBLIC-RACE-01: install fails closed when the config content changes between read and replace', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    const original = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(path, original);
    const userEdit = original + '# concurrent user edit\n';
    let mutated = false;
    withTempCwd(() => {
      assert.throws(
        () =>
          installEntry('global', {
            target: 'codex',
            // Deterministic race seam: while the atomic temp file is written,
            // the user rewrites the config (same inode, new bytes). The CAS
            // precondition must refuse to rename over it.
            atomicWrite: (p, content, opts) =>
              atomicReplaceCodexConfig(p, content, {
                ...opts,
                write(fd, buffer, offset, length) {
                  if (!mutated) {
                    mutated = true;
                    writeFileSync(p, userEdit);
                  }
                  return writeSync(fd, buffer, offset, length);
                },
              }),
          }),
        (error) => {
          assert.match(
            error.message,
            /content changed since planning|refusing to overwrite|refusing to replace/i,
            'the concurrent edit must surface as a precondition failure, not a silent overwrite',
          );
          return true;
        },
      );
    });
    assert.equal(mutated, true, 'the write seam must have run (temp writing started)');
    assert.equal(
      readFileSync(path, 'utf8'),
      userEdit,
      'the concurrent edit must survive install byte-for-byte',
    );
    assert.ok(
      !/tool_timeout_sec = 5460/.test(readFileSync(path, 'utf8')),
      'install must not land its block over the concurrent edit',
    );
    assert.deepEqual(readdirSync(join(home, '.codex')), ['config.toml'], 'no leftover temp files');
  });
});

test('PUBLIC-RACE-02: install fails closed when the config symlink is retargeted to identical bytes', () => {
  withTmpHome((home) => {
    const dir = join(home, '.codex');
    mkdirSync(dir, { recursive: true });
    const link = join(dir, 'config.toml');
    const targetA = join(dir, 'real-a.toml');
    const targetB = join(dir, 'real-b.toml');
    const identical = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(targetA, identical);
    writeFileSync(targetB, identical);
    symlinkSync('real-a.toml', link);
    let mutated = false;
    withTempCwd(() => {
      assert.throws(
        () =>
          installEntry('global', {
            target: 'codex',
            // Deterministic late race: the symlink is retargeted to a sibling
            // whose bytes are IDENTICAL to the analyzed target while the temp
            // file is being written. Content alone cannot see this — only the
            // snapshot CAS (resolved target / real identity) can.
            atomicWrite: (p, content, opts) =>
              atomicReplaceCodexConfig(p, content, {
                ...opts,
                write(fd, buffer, offset, length) {
                  if (!mutated) {
                    mutated = true;
                    unlinkSync(link);
                    symlinkSync('real-b.toml', link);
                  }
                  return writeSync(fd, buffer, offset, length);
                },
              }),
          }),
        (error) => {
          assert.match(
            error.message,
            /changed|swap|refusing|identity|resolved/i,
            'the retarget must surface as a precondition failure, not a status result',
          );
          return true;
        },
      );
    });
    assert.equal(mutated, true, 'the write seam must have run (temp writing started)');
    assert.equal(readlinkSync(link), 'real-b.toml', 'the retargeted symlink must be left alone');
    assert.equal(
      readFileSync(targetA, 'utf8'),
      identical,
      'the originally-analyzed target must stay byte-for-byte',
    );
    assert.equal(
      readFileSync(targetB, 'utf8'),
      identical,
      'the new target must stay byte-for-byte (identical bytes are not a reason to write)',
    );
    assert.deepEqual(readdirSync(dir).sort(), ['config.toml', 'real-a.toml', 'real-b.toml']);
  });
});

test('PUBLIC-RACE-03: install on a missing config never overwrites a file that appears mid-write', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    assert.equal(existsSync(path), false);
    const appeared = 'model = "concurrent-appeared"\n';
    let created = false;
    withTempCwd(() => {
      assert.throws(
        () =>
          installEntry('global', {
            target: 'codex',
            // Deterministic create race: while the atomic temp file is
            // written, another process creates the config. The no-clobber
            // create must never overwrite it.
            atomicWrite: (p, content, opts) =>
              atomicReplaceCodexConfig(p, content, {
                ...opts,
                write(fd, buffer, offset, length) {
                  if (!created) {
                    created = true;
                    writeFileSync(p, appeared);
                  }
                  return writeSync(fd, buffer, offset, length);
                },
              }),
          }),
        (error) => {
          assert.match(
            error.message,
            /appeared|clobber|EEXIST|refusing/i,
            'a file that appeared meanwhile must never be overwritten',
          );
          return true;
        },
      );
    });
    assert.equal(created, true, 'the create seam must have run (temp writing started)');
    assert.equal(
      readFileSync(path, 'utf8'),
      appeared,
      'the concurrently-appeared file must survive byte-for-byte',
    );
    assert.ok(
      !/triss/.test(readFileSync(path, 'utf8')),
      'the install block must not have landed over the appeared file',
    );
    assert.deepEqual(readdirSync(join(home, '.codex')), ['config.toml'], 'no leftover temp files');
  });
});

test('PUBLIC-RACE-04: uninstall fails closed when the config content changes between read and replace', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    const original = [
      '# user config',
      'model = "gpt-5"',
      '',
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      'tool_timeout_sec = 5460',
      '',
    ].join('\n');
    writeFileSync(path, original);
    const userEdit = original + '# concurrent user edit\n';
    let mutated = false;
    withTempCwd(() => {
      assert.throws(
        () =>
          uninstallEntry('global', {
            target: 'codex',
            atomicWrite: (p, content, opts) =>
              atomicReplaceCodexConfig(p, content, {
                ...opts,
                write(fd, buffer, offset, length) {
                  if (!mutated) {
                    mutated = true;
                    writeFileSync(p, userEdit);
                  }
                  return writeSync(fd, buffer, offset, length);
                },
              }),
          }),
        /content changed since planning|refusing to overwrite|refusing to replace/i,
      );
    });
    assert.equal(mutated, true, 'the write seam must have run (temp writing started)');
    assert.equal(
      readFileSync(path, 'utf8'),
      userEdit,
      'the concurrent edit must survive uninstall byte-for-byte',
    );
    assert.ok(
      readFileSync(path, 'utf8').includes('[mcp_servers.triss]'),
      'uninstall must not strip the block over the concurrent edit',
    );
    assert.deepEqual(readdirSync(join(home, '.codex')), ['config.toml'], 'no leftover temp files');
  });
});

test('PUBLIC-RACE-05: uninstall fails closed when the config symlink is retargeted to identical bytes', () => {
  withTmpHome((home) => {
    const dir = join(home, '.codex');
    mkdirSync(dir, { recursive: true });
    const link = join(dir, 'config.toml');
    const targetA = join(dir, 'real-a.toml');
    const targetB = join(dir, 'real-b.toml');
    // Unrelated content beyond the block keeps the stripped output non-empty,
    // so the atomic temp write actually runs (an empty replacement writes no
    // bytes and would never exercise the write seam).
    const identical = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      'tool_timeout_sec = 5460',
      '',
    ].join('\n');
    writeFileSync(targetA, identical);
    writeFileSync(targetB, identical);
    symlinkSync('real-a.toml', link);
    let mutated = false;
    withTempCwd(() => {
      assert.throws(
        () =>
          uninstallEntry('global', {
            target: 'codex',
            atomicWrite: (p, content, opts) =>
              atomicReplaceCodexConfig(p, content, {
                ...opts,
                write(fd, buffer, offset, length) {
                  if (!mutated) {
                    mutated = true;
                    unlinkSync(link);
                    symlinkSync('real-b.toml', link);
                  }
                  return writeSync(fd, buffer, offset, length);
                },
              }),
          }),
        (error) => {
          assert.match(
            error.message,
            /changed|swap|refusing|identity|resolved/i,
            'the retarget must surface as a precondition failure',
          );
          return true;
        },
      );
    });
    assert.equal(mutated, true, 'the write seam must have run (temp writing started)');
    assert.equal(readlinkSync(link), 'real-b.toml', 'the retargeted symlink must be left alone');
    assert.equal(
      readFileSync(targetA, 'utf8'),
      identical,
      'the originally-analyzed target must stay byte-for-byte',
    );
    assert.equal(
      readFileSync(targetB, 'utf8'),
      identical,
      'the new target must stay byte-for-byte (identical bytes are not a reason to write)',
    );
    assert.deepEqual(readdirSync(dir).sort(), ['config.toml', 'real-a.toml', 'real-b.toml']);
  });
});

test('PUBLIC-RACE-06: install fails closed when the config changes while its content is being read', () => {
  withTmpHome((home) => {
    const dir = join(home, '.codex');
    mkdirSync(dir, { recursive: true });
    const link = join(dir, 'config.toml');
    const targetA = join(dir, 'real-a.toml');
    const targetB = join(dir, 'real-b.toml');
    const identical = [
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(targetA, identical);
    writeFileSync(targetB, identical);
    symlinkSync('real-a.toml', link);
    let reads = 0;
    withTempCwd(() => {
      assert.throws(
        () =>
          installEntry('global', {
            target: 'codex',
            // Deterministic FIRST-read race: the snapshot owns the injected
            // read, so this reader is called with the resolved target. While
            // it reads target A, the symlink is retargeted to an IDENTICAL
            // sibling B before the read returns — the snapshot's post-read
            // recapture must fail the install BEFORE any analysis or write.
            readFile: (p) => {
              reads += 1;
              const content = readFileSync(p, 'utf8');
              unlinkSync(link);
              symlinkSync('real-b.toml', link);
              return content;
            },
          }),
        /changed while its content was being read/,
      );
    });
    assert.equal(reads, 1, 'only the validating read may happen — no analysis or write follows');
    assert.equal(readlinkSync(link), 'real-b.toml', 'the retargeted symlink must be left alone');
    assert.equal(
      readFileSync(targetA, 'utf8'),
      identical,
      'the originally-read target must stay byte-for-byte',
    );
    assert.equal(
      readFileSync(targetB, 'utf8'),
      identical,
      'the new target must stay byte-for-byte (identical bytes are not a reason to write)',
    );
    assert.deepEqual(readdirSync(dir).sort(), ['config.toml', 'real-a.toml', 'real-b.toml']);
  });
});

test('PUBLIC-RACE-07: install fails closed when the config mode changes between read and replace', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    const original = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      'tool_timeout_sec = 5460',
      '',
    ].join('\n');
    writeFileSync(path, original);
    chmodSync(path, 0o640);
    let mutated = false;
    withTempCwd(() => {
      assert.throws(
        () =>
          installEntry('global', {
            target: 'codex',
            // Deterministic race: the user chmods the config while the atomic
            // temp file is written. The CAS precondition must fail closed —
            // mode is part of the validated snapshot.
            atomicWrite: (p, content, opts) =>
              atomicReplaceCodexConfig(p, content, {
                ...opts,
                write(fd, buffer, offset, length) {
                  if (!mutated) {
                    mutated = true;
                    chmodSync(p, 0o600);
                  }
                  return writeSync(fd, buffer, offset, length);
                },
              }),
          }),
        (error) => {
          assert.match(
            error.message,
            /mode changed since planning|refusing|changed since planning/i,
            'the chmod must surface as a precondition failure, not a silent rewrite',
          );
          return true;
        },
      );
    });
    assert.equal(mutated, true, 'the write seam must have run (temp writing started)');
    assert.equal(statSync(path).mode & 0o777, 0o600, 'the new mode must survive untouched');
    assert.equal(readFileSync(path, 'utf8'), original, 'the bytes must stay byte-for-byte');
    assert.deepEqual(readdirSync(join(home, '.codex')), ['config.toml'], 'no leftover temp files');
  });
});

// ─── public-path atomicity: success cases (mode / symlink / no temp) ──────────

test('PUBLIC-ATOMIC-01: install on a symlinked config keeps the symlink and the real target mode', () => {
  withTmpHome((home) => {
    const dir = join(home, '.codex');
    mkdirSync(dir, { recursive: true });
    const link = join(dir, 'config.toml');
    const target = join(dir, 'real-codex-config.toml');
    writeFileSync(
      target,
      [
        'model = "gpt-5"',
        '',
        '[mcp_servers.triss]',
        'command = "triss"',
        'args = ["mcp", "serve"]',
        'tool_timeout_sec = 120',
        '',
      ].join('\n'),
    );
    symlinkSync('real-codex-config.toml', link);
    chmodSync(target, 0o640);
    withTempCwd(() => {
      const r = installEntry('global', { target: 'codex', command: 'triss-v2' });
      assert.equal(r.status, 'updated');
    });
    assert.ok(lstatSync(link).isSymbolicLink(), 'config.toml must still be a symlink');
    assert.equal(readlinkSync(link), 'real-codex-config.toml', 'the link target name must survive');
    const toml = readFileSync(target, 'utf8');
    assert.match(toml, /^command = "triss-v2"$/m, 'the real target must be rewritten in place');
    assert.match(toml, /^tool_timeout_sec = 5460$/m);
    const bareHits = toml.match(/^\[mcp_servers\.triss\]$/gm) || [];
    assert.equal(bareHits.length, 1, 'the block must be present exactly once');
    assert.equal(statSync(target).mode & 0o777, 0o640, 'the real target mode must be preserved');
    assert.deepEqual(readdirSync(dir).sort(), ['config.toml', 'real-codex-config.toml']);
  });
});

test('PUBLIC-ATOMIC-02: an install write failure leaves no temp file and preserves the original bytes', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    const original = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      'tool_timeout_sec = 5460',
      '',
    ].join('\n');
    writeFileSync(path, original);
    withTempCwd(() => {
      assert.throws(
        () =>
          installEntry('global', {
            target: 'codex',
            atomicWrite: (p, content, opts) =>
              atomicReplaceCodexConfig(p, content, {
                ...opts,
                write: () => {
                  throw new Error('simulated write failure');
                },
              }),
          }),
        /simulated write failure/,
      );
    });
    assert.equal(readFileSync(path, 'utf8'), original, 'original must be untouched on failure');
    assert.deepEqual(readdirSync(join(home, '.codex')), ['config.toml'], 'no leftover temp files');
  });
});

test('PUBLIC-ATOMIC-03: a failed no-clobber create leaves no config and no temp file', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    assert.equal(existsSync(path), false);
    withTempCwd(() => {
      assert.throws(
        () =>
          installEntry('global', {
            target: 'codex',
            atomicWrite: (p, content, opts) =>
              atomicReplaceCodexConfig(p, content, {
                ...opts,
                write: () => {
                  throw new Error('simulated create failure');
                },
              }),
          }),
        /simulated create failure/,
      );
    });
    assert.equal(existsSync(path), false, 'a failed create must leave no config behind');
    assert.deepEqual(readdirSync(join(home, '.codex')), [], 'no leftover temp files');
  });
});

// ─── multiple semantic Triss roots fail closed (GLM 5.3) ─────────────────────
//
// TOML forbids redefining a table, so a config that declares the Triss root
// table MORE than once — in any mix of the bare, quoted, mixed, or
// escape-decoded equivalent spellings — is ambiguous: no one block can be
// chosen over the others. install/status/uninstall must FAIL CLOSED and leave
// every byte untouched. A semantic array-of-tables header ([[mcp_servers.triss]]
// and its quoted/mixed/escape-decoded two-component forms) occupies the same
// path with an incompatible ARRAY shape and is equally refused — alone or
// next to a regular root. The distinct SINGLE-component ["mcp_servers.triss"]
// table and [["mcp_servers.triss"]] array (one key whose literal name contains
// a dot) are different tables and never count toward the total —
// install/status/uninstall keep working next to any number of those (see also
// CODEX-10/19).

test('MULTIROOT-01: two semantic Triss roots make install/status/uninstall fail closed, bytes unchanged', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    const inputs = [
      // Two bare roots.
      ['[mcp_servers.triss]', 'command = "triss"', '', '[mcp_servers.triss]', 'command = "triss"', ''].join('\n'),
      // Bare + two-component quoted equivalent.
      ['[mcp_servers.triss]', 'command = "triss"', '', '["mcp_servers"."triss"]', 'command = "triss"', ''].join('\n'),
      // Two-component quoted + mixed-quoting equivalents.
      ['["mcp_servers"."triss"]', 'command = "triss"', '', '["mcp_servers".triss]', 'command = "triss"', ''].join('\n'),
      // Quoted + escape-decoded equivalent (\u005F is underscore).
      ['["mcp_servers"."triss"]', 'command = "triss"', '', '["mcp\\u005Fservers"."triss"]', 'command = "triss"', ''].join('\n'),
      // Bare + escaped equivalent.
      ['[mcp_servers.triss]', 'command = "triss"', '', '["mcp\\u005Fservers"."tris\\u0073"]', 'command = "triss"', ''].join('\n'),
    ];
    for (const input of inputs) {
      writeFileSync(path, input);
      withTempCwd(() => {
        assert.throws(
          () => installEntry('global', { target: 'codex' }),
          /declares the Triss \[mcp_servers\.triss\] table more than once/,
          `install must fail closed for:\n${input}`,
        );
        assert.throws(
          () => showStatus('global', { target: 'codex' }),
          /declares the Triss \[mcp_servers\.triss\] table more than once/,
          `status must fail closed for:\n${input}`,
        );
        assert.throws(
          () => uninstallEntry('global', { target: 'codex' }),
          /declares the Triss \[mcp_servers\.triss\] table more than once/,
          `uninstall must fail closed for:\n${input}`,
        );
        assert.equal(
          readFileSync(path, 'utf8'),
          input,
          'a duplicate-root config must stay byte-for-byte across all three operations',
        );
      });
    }
  });
});

test('MULTIROOT-02: single-component ["mcp_servers.triss"] tables are never semantic roots', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    // TWO single-component tables — the literal key name "mcp_servers.triss"
    // is one component, a completely different table from the two-component
    // Triss root. Neither is a semantic root, so nothing is ambiguous and
    // install/status/uninstall keep working next to them.
    const userTables = [
      '["mcp_servers.triss"]',
      'custom_key = "user value"',
      '',
      '["mcp_servers.triss"]',
      'other_key = 1',
      '',
    ].join('\n');
    writeFileSync(path, userTables);
    withTempCwd(() => {
      // Status: the single-component tables are NOT the Triss root.
      const s = showStatus('global', { target: 'codex' });
      assert.equal(s.present, false, 'single-component tables must not be reported as the root');

      // Install: the real root is added; both single-component tables survive.
      const r = installEntry('global', { target: 'codex' });
      assert.equal(r.status, 'added');
      let toml = readFileSync(path, 'utf8');
      const bareHits = toml.match(/^\[mcp_servers\.triss\]$/gm) || [];
      assert.equal(bareHits.length, 1, 'exactly one real root after install');
      assert.ok(toml.includes('["mcp_servers.triss"]\ncustom_key = "user value"'));
      assert.ok(toml.includes('["mcp_servers.triss"]\nother_key = 1'));

      // Reinstall stays single-root, then uninstall removes only the real block.
      const second = installEntry('global', { target: 'codex', command: 'triss-v2' });
      assert.equal(second.status, 'updated');
      const removed = uninstallEntry('global', { target: 'codex' });
      assert.equal(removed.status, 'removed');
      toml = readFileSync(path, 'utf8');
      assert.ok(!/^\[mcp_servers\.triss\]$/m.test(toml), 'the generated block must be gone');
      assert.ok(toml.includes('["mcp_servers.triss"]'), 'single-component tables must survive uninstall');
      assert.ok(toml.includes('other_key = 1'), 'both single-component tables must survive uninstall');
    });
  });
});

test('MULTIROOT-03: a semantic array-of-tables root makes install/status/uninstall fail closed, bytes unchanged', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    // [[mcp_servers.triss]] (and its quoted/mixed/escaped two-component
    // spellings) occupies the mcp_servers/triss path as an ARRAY of tables —
    // an incompatible shape for the regular Triss table. Alone OR next to a
    // regular semantic root, no operation may append, report, or remove a
    // regular table there: all three fail closed with a clear error and the
    // bytes stay untouched.
    const inputs = [
      // AoT only (bare spelling).
      ['[[mcp_servers.triss]]', 'command = "triss"', 'args = []', ''].join('\n'),
      // AoT only, quoted two-component spelling.
      ['[["mcp_servers"."triss"]]', 'command = "triss"', ''].join('\n'),
      // AoT only, mixed-quoting spelling.
      ['[["mcp_servers".triss]]', 'command = "triss"', ''].join('\n'),
      // AoT only, escape-decoded spelling (\u005F is underscore).
      ['[["mcp\\u005Fservers"."triss"]]', 'command = "triss"', ''].join('\n'),
      // Regular bare root coexisting with a semantic AoT root.
      [
        '[mcp_servers.triss]',
        'command = "triss"',
        '',
        '[[mcp_servers.triss]]',
        'command = "triss"',
        '',
      ].join('\n'),
      // Quoted regular root coexisting with an AoT root.
      [
        '["mcp_servers"."triss"]',
        'command = "triss"',
        '',
        '[[mcp_servers.triss]]',
        'command = "triss"',
        '',
      ].join('\n'),
    ];
    for (const input of inputs) {
      writeFileSync(path, input);
      withTempCwd(() => {
        assert.throws(
          () => installEntry('global', { target: 'codex' }),
          /\[\[mcp_servers\.triss\]\] as an array of tables/,
          `install must fail closed for:\n${input}`,
        );
        assert.throws(
          () => showStatus('global', { target: 'codex' }),
          /\[\[mcp_servers\.triss\]\] as an array of tables/,
          `status must fail closed for:\n${input}`,
        );
        assert.throws(
          () => uninstallEntry('global', { target: 'codex' }),
          /\[\[mcp_servers\.triss\]\] as an array of tables/,
          `uninstall must fail closed for:\n${input}`,
        );
        assert.equal(
          readFileSync(path, 'utf8'),
          input,
          'an AoT-root config must stay byte-for-byte across all three operations',
        );
      });
    }
  });
});

test('MULTIROOT-04: a single-component [["mcp_servers.triss"]] array is never a semantic AoT root', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    // [["mcp_servers.triss"]] is ONE component whose literal name contains a
    // dot — a completely different array from the two-component Triss AoT.
    // It is never a semantic root or a semantic AoT root, so nothing fails
    // closed: install adds the real block, status reports the real block,
    // and uninstall removes only the real block, leaving the user array
    // byte-for-byte.
    const userArray = ['[["mcp_servers.triss"]]', 'custom_key = "user value"', ''].join('\n');
    writeFileSync(path, userArray);
    withTempCwd(() => {
      // Status: the single-component array is NOT the Triss root.
      const s = showStatus('global', { target: 'codex' });
      assert.equal(s.present, false, 'single-component array must not be reported as the root');

      // Install: the real root is added; the single-component array survives.
      const r = installEntry('global', { target: 'codex' });
      assert.equal(r.status, 'added');
      let toml = readFileSync(path, 'utf8');
      const bareHits = toml.match(/^\[mcp_servers\.triss\]$/gm) || [];
      assert.equal(bareHits.length, 1, 'exactly one real root after install');
      assert.ok(
        toml.includes('[["mcp_servers.triss"]]\ncustom_key = "user value"'),
        'single-component array must survive install',
      );

      // Reinstall stays single-root, then uninstall removes only the real
      // block; the single-component array must survive byte-for-byte.
      const second = installEntry('global', { target: 'codex', command: 'triss-v2' });
      assert.equal(second.status, 'updated');
      const removed = uninstallEntry('global', { target: 'codex' });
      assert.equal(removed.status, 'removed');
      toml = readFileSync(path, 'utf8');
      assert.ok(!/^\[mcp_servers\.triss\]$/m.test(toml), 'the generated block must be gone');
      assert.ok(
        toml.includes('[["mcp_servers.triss"]]\ncustom_key = "user value"'),
        'single-component array must survive uninstall',
      );
    });
  });
});

// ─── previousCodexProjectRoot: multiline text is not a stale pin (GLM 5.3) ───

test('MIGRATED-FROM-01: a TRISS_PROJECT_ROOT-looking line inside a multi-line string is not a stale pin', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    // The value lives inside a multi-line basic string inside the block: the
    // line that merely LOOKS like a TRISS_PROJECT_ROOT assignment is string
    // content (inMultiline), never a key of this table — install must not
    // report a spurious dropped-pin migration from it.
    writeFileSync(
      path,
      [
        '[mcp_servers.triss]',
        'command = "triss"',
        'args = ["mcp", "serve"]',
        'msg = """',
        'TRISS_PROJECT_ROOT = "/old/codex/path"',
        '"""',
        '',
      ].join('\n'),
    );
    withTempCwd(() => {
      const r = installEntry('global', { target: 'codex' });
      assert.equal(r.status, 'updated');
      assert.equal(
        r.migratedFrom,
        undefined,
        'multiline string content must never be surfaced as a stale pin',
      );
      assert.ok(!/TRISS_PROJECT_ROOT/.test(readFileSync(path, 'utf8')), 'the new block has no pin');
    });
  });
});

// ─── previousCodexProjectRoot: single-line strings are not stale pins (GLM 5.3) ───
//
// A TRISS_PROJECT_ROOT-looking assignment inside a SINGLE-line TOML string —
// basic or literal — is string content, never a key of this table. The
// line-based scanner records the exact index spans of every single-line
// string, and previousCodexProjectRoot skips any match that overlaps one, so
// `note = 'TRISS_PROJECT_ROOT = "/x"'` cannot surface a spurious
// migratedFrom. A real legacy marker OUTSIDE any string is still detected.

test('MIGRATED-FROM-02: a TRISS_PROJECT_ROOT-looking text inside a single-line literal string is not a stale pin', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      path,
      [
        '[mcp_servers.triss]',
        'command = "triss"',
        'args = ["mcp", "serve"]',
        "note = 'TRISS_PROJECT_ROOT = \"/old/codex/path\"'",
        '',
      ].join('\n'),
    );
    withTempCwd(() => {
      const r = installEntry('global', { target: 'codex' });
      assert.equal(r.status, 'updated');
      assert.equal(
        r.migratedFrom,
        undefined,
        'single-line literal string content must never be surfaced as a stale pin',
      );
      assert.ok(!/TRISS_PROJECT_ROOT/.test(readFileSync(path, 'utf8')), 'the new block has no pin');
    });
  });
});

test('MIGRATED-FROM-03: a TRISS_PROJECT_ROOT-looking text inside a single-line basic string is not a stale pin', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      path,
      [
        '[mcp_servers.triss]',
        'command = "triss"',
        'args = ["mcp", "serve"]',
        'note = "TRISS_PROJECT_ROOT = \\"/old/codex/path\\""',
        '',
      ].join('\n'),
    );
    withTempCwd(() => {
      const r = installEntry('global', { target: 'codex' });
      assert.equal(r.status, 'updated');
      assert.equal(
        r.migratedFrom,
        undefined,
        'single-line basic string content must never be surfaced as a stale pin',
      );
      assert.ok(!/TRISS_PROJECT_ROOT/.test(readFileSync(path, 'utf8')), 'the new block has no pin');
    });
  });
});

test('MIGRATED-FROM-04: a real legacy marker is still detected next to single-line string decoys', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      path,
      [
        '[mcp_servers.triss]',
        'command = "triss"',
        'args = ["mcp", "serve"]',
        "note = 'TRISS_PROJECT_ROOT = \"/decoy/one\"'",
        'desc = "TRISS_PROJECT_ROOT = \\"/decoy/two\\""',
        'TRISS_PROJECT_ROOT = "/old/codex/path"',
        '',
      ].join('\n'),
    );
    withTempCwd(() => {
      const r = installEntry('global', { target: 'codex' });
      assert.equal(r.status, 'updated');
      assert.equal(
        r.migratedFrom,
        '/old/codex/path',
        'the real key assignment outside any string must still be surfaced',
      );
      assert.ok(!/TRISS_PROJECT_ROOT/.test(readFileSync(path, 'utf8')), 'the new block has no pin');
    });
  });
});

// ─── previousCodexProjectRoot: multiline strings that OPEN mid-line (GLM 5.3) ───
//
// A TRISS_PROJECT_ROOT-looking assignment can also hide inside a MULTI-line
// string — basic (""") or literal (''') — that opens mid-line, whether it
// closes on that same line or on a LATER line, and even when that multiline
// string sits inside a same-line container. Those lines do NOT start inside
// the string (so `inMultiline` is false) and do NOT start inside a container
// (so `startedInContainer` is false), and the single-line `strings` spans
// never cover them — so the scanner must additionally record the spans of
// every multiline string that OPENS on the line, and previousCodexProjectRoot
// must skip any match that overlaps one. A real legacy marker OUTSIDE every
// string is still detected.

test('MIGRATED-FROM-05: text inside a same-line open/close multiline BASIC string is not a stale pin', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      path,
      [
        '[mcp_servers.triss]',
        'command = "triss"',
        'args = ["mcp", "serve"]',
        'note = """TRISS_PROJECT_ROOT = "/old/codex/path" """',
        '',
      ].join('\n'),
    );
    withTempCwd(() => {
      const r = installEntry('global', { target: 'codex' });
      assert.equal(r.status, 'updated');
      assert.equal(
        r.migratedFrom,
        undefined,
        'same-line multiline basic string content must never be surfaced as a stale pin',
      );
      assert.ok(!/TRISS_PROJECT_ROOT/.test(readFileSync(path, 'utf8')), 'the new block has no pin');
    });
  });
});

test('MIGRATED-FROM-06: text inside a cross-line multiline BASIC string on its opening line is not a stale pin', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      path,
      [
        '[mcp_servers.triss]',
        'command = "triss"',
        'args = ["mcp", "serve"]',
        'note = """TRISS_PROJECT_ROOT = "/old/codex/path"',
        'still inside the string',
        '"""',
        '',
      ].join('\n'),
    );
    withTempCwd(() => {
      const r = installEntry('global', { target: 'codex' });
      assert.equal(r.status, 'updated');
      assert.equal(
        r.migratedFrom,
        undefined,
        'content on the opening line of a cross-line multiline basic string must never be a stale pin',
      );
      assert.ok(!/TRISS_PROJECT_ROOT/.test(readFileSync(path, 'utf8')), 'the new block has no pin');
    });
  });
});

test('MIGRATED-FROM-07: text inside a same-line open/close multiline LITERAL string is not a stale pin', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      path,
      [
        '[mcp_servers.triss]',
        'command = "triss"',
        'args = ["mcp", "serve"]',
        "note = '''TRISS_PROJECT_ROOT = \"/old/codex/path\" '''",
        '',
      ].join('\n'),
    );
    withTempCwd(() => {
      const r = installEntry('global', { target: 'codex' });
      assert.equal(r.status, 'updated');
      assert.equal(
        r.migratedFrom,
        undefined,
        'same-line multiline literal string content must never be surfaced as a stale pin',
      );
      assert.ok(!/TRISS_PROJECT_ROOT/.test(readFileSync(path, 'utf8')), 'the new block has no pin');
    });
  });
});

test('MIGRATED-FROM-08: text inside a multiline string in a SAME-LINE container is not a stale pin', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      path,
      [
        '[mcp_servers.triss]',
        'command = "triss"',
        'args = ["mcp", "serve"]',
        'note = ["""TRISS_PROJECT_ROOT = "/old/codex/path" """]',
        '',
      ].join('\n'),
    );
    withTempCwd(() => {
      const r = installEntry('global', { target: 'codex' });
      assert.equal(r.status, 'updated');
      assert.equal(
        r.migratedFrom,
        undefined,
        'a multiline string inside a same-line container must never be surfaced as a stale pin',
      );
      assert.ok(!/TRISS_PROJECT_ROOT/.test(readFileSync(path, 'utf8')), 'the new block has no pin');
    });
  });
});

test('MIGRATED-FROM-09: a real legacy marker is still detected next to multiline string decoys', () => {
  withTmpHome((home) => {
    const path = join(home, '.codex', 'config.toml');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      path,
      [
        '[mcp_servers.triss]',
        'command = "triss"',
        'args = ["mcp", "serve"]',
        'note = """TRISS_PROJECT_ROOT = "/decoy/one" """',
        "note2 = '''TRISS_PROJECT_ROOT = \"/decoy/two\" '''",
        'note3 = ["""TRISS_PROJECT_ROOT = "/decoy/three" """]',
        'TRISS_PROJECT_ROOT = "/old/codex/path"',
        '',
      ].join('\n'),
    );
    withTempCwd(() => {
      const r = installEntry('global', { target: 'codex' });
      assert.equal(r.status, 'updated');
      assert.equal(
        r.migratedFrom,
        '/old/codex/path',
        'the real key assignment outside every string must still be surfaced',
      );
      assert.ok(!/TRISS_PROJECT_ROOT/.test(readFileSync(path, 'utf8')), 'the new block has no pin');
    });
  });
});

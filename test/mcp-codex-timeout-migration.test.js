import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  chmodSync,
  statSync,
  symlinkSync,
  readlinkSync,
  lstatSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  migrateCodexToolTimeout,
  atomicReplaceCodexConfig,
  scanToml,
  parseHeaderLine,
} from '../src/mcp/install.js';
import { runMcpServe } from '../src/commands/mcp.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

async function withTmpHome(fn) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'triss-codex-migrate-')));
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(home);
  } finally {
    process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
}

function codexConfig(home) {
  const dir = join(home, '.codex');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'config.toml');
}

function trissConfigWith(line = 'tool_timeout_sec = 120', { extraTail = '' } = {}) {
  return [
    '# user config',
    'model = "gpt-5"',
    '',
    '[mcp_servers.other]',
    'command = "other-tool"',
    'args = []',
    '',
    '[mcp_servers.triss]',
    'command = "triss"',
    'args = ["mcp", "serve"]',
    'startup_timeout_sec = 30',
    line,
    extraTail,
    '',
    '[ui]',
    'theme = "dark"',
    '',
  ].join('\n');
}

// ─── migration function ───────────────────────────────────────────────────────

test('MIGRATE-01: a single historical tool_timeout_sec = 120 is migrated to 5460', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    writeFileSync(path, trissConfigWith());
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.target, 'codex');
    assert.equal(result.status, 'updated');
    // An "updated" result reports the exact values that were migrated so the
    // caller (runMcpServe) can derive its message instead of hardcoding them.
    assert.equal(result.from, 120);
    assert.equal(result.to, 5460);
    const toml = readFileSync(path, 'utf8');
    assert.match(toml, /^tool_timeout_sec = 5460$/m);
    assert.ok(!/tool_timeout_sec = 120/.test(toml));
  });
});

test('MIGRATE-02: whitespace and inline comments around the value are preserved', async () => {
  await withTmpHome((home) => {
    for (const [line, expected] of [
      ['tool_timeout_sec=120', 'tool_timeout_sec=5460'],
      ['tool_timeout_sec = 120', 'tool_timeout_sec = 5460'],
      ['tool_timeout_sec   =   120   # legacy cap', 'tool_timeout_sec   =   5460   # legacy cap'],
      ['  tool_timeout_sec = 120', '  tool_timeout_sec = 5460'],
      ['tool_timeout_sec = 120 # outer cap from 0.14', 'tool_timeout_sec = 5460 # outer cap from 0.14'],
      ['tool_timeout_sec = 120#compact', 'tool_timeout_sec = 5460#compact'],
    ]) {
      const path = codexConfig(home);
      writeFileSync(path, trissConfigWith(line));
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'updated', `for line: ${line}`);
      const toml = readFileSync(path, 'utf8');
      const block = toml.split('\n').find((l) => l.includes('tool_timeout_sec'));
      assert.equal(block, expected, `for line: ${line}`);
    }
  });
});

test('MIGRATE-03: unrelated TOML is preserved byte-for-byte, only the value token changes', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '# user config',
      'model = "gpt-5"',
      '',
      '[mcp_servers.other]',
      'command = "other-tool"',
      'args = []',
      '',
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      'startup_timeout_sec = 30',
      'tool_timeout_sec = 120',
      '',
      '[mcp_servers.triss.env]',
      'EXTRA = "1"',
      '',
      '[ui]',
      'theme = "dark"',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'updated');
    const expected = input.replace('tool_timeout_sec = 120', 'tool_timeout_sec = 5460');
    assert.equal(readFileSync(path, 'utf8'), expected, 'every byte outside the value token must be identical');
  });
});

test('MIGRATE-04: missing file is "absent" and the config is never created', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    assert.equal(existsSync(path), false);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'absent');
    assert.equal(existsSync(path), false, 'migration must never create the config');
  });
});

test('MIGRATE-05: config without a Triss block is "absent" and untouched', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
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
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'absent');
    assert.equal(readFileSync(path, 'utf8'), input, 'config without a Triss block must stay untouched');
  });
});

test('MIGRATE-06: custom values (1860 / 300 / 6000 / quoted / float) are never overwritten', async () => {
  await withTmpHome((home) => {
    for (const line of [
      'tool_timeout_sec = 1860',
      'tool_timeout_sec = 300',
      'tool_timeout_sec = 6000',
      'tool_timeout_sec = "120"',
      'tool_timeout_sec = 120.0',
    ]) {
      const path = codexConfig(home);
      const input = trissConfigWith(line);
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'custom', `for line: ${line}`);
      assert.equal(readFileSync(path, 'utf8'), input, `for line: ${line} — must stay byte-for-byte`);
    }
  });
});

test('MIGRATE-07: an already-current 5460 is "current"; a missing root key is "absent"', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = trissConfigWith('tool_timeout_sec = 5460');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'current');
    assert.equal(readFileSync(path, 'utf8'), input, 'must stay byte-for-byte');
    // No tool_timeout_sec assignment inside the root block at all: the root
    // key is absent, so there is nothing to migrate.
    const absentPath = codexConfig(home);
    const absentInput = [
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      'startup_timeout_sec = 30',
      '',
    ].join('\n');
    writeFileSync(absentPath, absentInput);
    const absentResult = migrateCodexToolTimeout({ path: absentPath });
    assert.equal(absentResult.status, 'absent');
    assert.equal(readFileSync(absentPath, 'utf8'), absentInput);
  });
});

test('MIGRATE-08: duplicate tool_timeout_sec lines are "ambiguous" and untouched', async () => {
  await withTmpHome((home) => {
    for (const input of [
      trissConfigWith('tool_timeout_sec = 120', { extraTail: 'tool_timeout_sec = 300' }),
      trissConfigWith('tool_timeout_sec = 120', { extraTail: 'tool_timeout_sec = 120' }),
    ]) {
      const path = codexConfig(home);
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'ambiguous');
      assert.equal(readFileSync(path, 'utf8'), input, 'ambiguous config must stay byte-for-byte');
    }
  });
});

// ─── multiple semantic Triss roots (GLM review) ──────────────────────────────
//
// TOML forbids redefining a table, so a config that declares the Triss root
// MORE than once — in any mix of the bare, quoted, mixed, or escape-decoded
// equivalent spellings, which all name the same two-component table — is
// ambiguous: no block can be chosen over the others, and the migration must
// report `ambiguous` and leave every byte untouched. A single quoted/mixed/
// escaped root is still ONE root but is never rewritten ("absent"; see
// LEXER-08/32), and the distinct single-component ["mcp_servers.triss"] table
// is a different table that never makes a root ambiguous (see MIGRATE-20).

test('MIGRATE-19: more than one exact bare Triss root is "ambiguous" and left byte-for-byte untouched', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    for (const input of [
      [
        '[mcp_servers.triss]',
        'command = "triss"',
        'tool_timeout_sec = 120',
        '',
        '[mcp_servers.triss]',
        'command = "triss"',
        'tool_timeout_sec = 120',
        '',
      ].join('\n'),
      // Trailing-comment bare roots count too — the comment is stripped before
      // the header parses, so both lines are the exact bare root.
      [
        '[mcp_servers.triss] # generated',
        'tool_timeout_sec = 120',
        '',
        '[mcp_servers.triss]',
        'tool_timeout_sec = 120',
        '',
      ].join('\n'),
      // Two bare roots, only one of which holds a 120: still ambiguous — the
      // duplicate table declaration alone is enough to refuse.
      [
        '[mcp_servers.triss]',
        'command = "triss"',
        'tool_timeout_sec = 120',
        '',
        '[mcp_servers.triss]',
        'command = "triss"',
        '',
      ].join('\n'),
    ]) {
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'ambiguous', `for input:\n${input}`);
      assert.equal(
        readFileSync(path, 'utf8'),
        input,
        'a duplicate bare root must never be rewritten',
      );
    }
  });
});

test('MIGRATE-20: a single-component ["mcp_servers.triss"] table does not make a bare root ambiguous', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    // ["mcp_servers.triss"] is ONE component whose literal name contains a
    // dot — a completely different table from the two-component Triss root.
    // It must never count toward the root total, so the single bare root is
    // unambiguous and migrates; the user table survives byte-for-byte.
    const input = [
      '[mcp_servers.triss]',
      'command = "triss"',
      'tool_timeout_sec = 120',
      '',
      '["mcp_servers.triss"]',
      'custom_key = "user value"',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'updated');
    const toml = readFileSync(path, 'utf8');
    assert.match(toml, /^tool_timeout_sec = 5460$/m);
    assert.ok(
      toml.includes('["mcp_servers.triss"]\ncustom_key = "user value"'),
      'the single-component user table must survive byte-for-byte',
    );
  });
});

// Every spelling of the two-component mcp_servers / triss key names the SAME
// table in TOML (quoting and escape-decoding never change which table a
// dotted key names), so a config that holds TWO of them — bare+quoted,
// quoted+quoted, mixed, or escape-decoded — declares the table twice and is
// `ambiguous`, byte-for-byte untouched.

test('MIGRATE-21: a bare root next to any quoted/mixed/escaped root is "ambiguous" and never rewritten', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const inputs = [
      // Bare + fully-quoted two-component root.
      [
        '[mcp_servers.triss]',
        'command = "triss"',
        'tool_timeout_sec = 120',
        '',
        '["mcp_servers"."triss"]',
        'tool_timeout_sec = 120',
        '',
      ].join('\n'),
      // Quoted + quoted (same table declared twice in two quoted spellings).
      [
        '["mcp_servers"."triss"]',
        'tool_timeout_sec = 120',
        '',
        '["mcp_servers"."triss"]',
        'tool_timeout_sec = 120',
        '',
      ].join('\n'),
      // Bare + mixed-quoting root.
      [
        '[mcp_servers.triss]',
        'tool_timeout_sec = 120',
        '',
        '["mcp_servers".triss]',
        'tool_timeout_sec = 120',
        '',
      ].join('\n'),
      // Quoted + escape-decoded equivalent (\u005F is underscore).
      [
        '["mcp_servers"."triss"]',
        'tool_timeout_sec = 120',
        '',
        '["mcp\\u005Fservers"."triss"]',
        'tool_timeout_sec = 120',
        '',
      ].join('\n'),
      // Bare + escape-decoded equivalent.
      [
        '[mcp_servers.triss]',
        'tool_timeout_sec = 120',
        '',
        '["mcp\\u005Fservers"."tris\\u0073"]',
        'tool_timeout_sec = 120',
        '',
      ].join('\n'),
      // Bare + literal-quoted two-component root (['mcp_servers'.'triss']).
      [
        '[mcp_servers.triss]',
        'tool_timeout_sec = 120',
        '',
        "['mcp_servers'.'triss']",
        'tool_timeout_sec = 120',
        '',
      ].join('\n'),
    ];
    for (const input of inputs) {
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'ambiguous', `for input:\n${input}`);
      assert.equal(
        readFileSync(path, 'utf8'),
        input,
        'two semantic roots must never be rewritten',
      );
    }
  });
});

// The migration stays narrow in WHAT it rewrites: a single two-component root
// that is not the exact bare form — quoted, mixed, or escape-decoded — is
// never rewritten, even though it is semantically the Triss table.

test('MIGRATE-22: a single mixed/escape-decoded root is "absent" and never rewritten', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    for (const input of [
      // Mixed quoting: one component bare, one quoted.
      ['["mcp_servers".triss]', 'tool_timeout_sec = 120', ''].join('\n'),
      // Escape-decoded two-component root.
      ['["mcp\\u005Fservers"."triss"]', 'tool_timeout_sec = 120', ''].join('\n'),
      // Literal-quoted two-component root.
      ["['mcp_servers'.'triss']", 'tool_timeout_sec = 120', ''].join('\n'),
    ]) {
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'absent', `for input:\n${input}`);
      assert.equal(
        readFileSync(path, 'utf8'),
        input,
        'a single non-bare root must stay byte-for-byte (the migration only rewrites the bare form)',
      );
    }
  });
});

test('MIGRATE-09: a tool_timeout_sec under [mcp_servers.triss.env] is an env var, not the host timeout — untouched', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      '',
      '[mcp_servers.triss.env]',
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    // The root key is absent (the scan stops at the env sub-table header), so
    // there is nothing to migrate — "absent", not "current".
    assert.equal(result.status, 'absent');
    assert.equal(
      readFileSync(path, 'utf8'),
      input,
      'an env-subtable-only 120 must stay byte-for-byte unchanged',
    );
  });
});

test('MIGRATE-10: a root 120 is migrated while an env-subtable 120 remains unchanged', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      'startup_timeout_sec = 30',
      'tool_timeout_sec = 120',
      '',
      '[mcp_servers.triss.env]',
      'EXTRA = "1"',
      'tool_timeout_sec = 120',
      '',
      '[ui]',
      'theme = "dark"',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'updated');
    const toml = readFileSync(path, 'utf8');
    // The root direct key is the Codex host timeout — migrated.
    assert.match(toml, /^tool_timeout_sec = 5460$/m);
    // The env-subtable 120 is an env var, not a host key — must survive.
    assert.ok(
      toml.includes('[mcp_servers.triss.env]\nEXTRA = "1"\ntool_timeout_sec = 120'),
      'env-subtable 120 must stay byte-for-byte',
    );
  });
});

test('MIGRATE-11: a failed write propagates, leaves no temp file, and never touches the original', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = trissConfigWith();
    writeFileSync(path, input);
    assert.throws(
      () =>
        migrateCodexToolTimeout({
          path,
          atomicWrite: () => {
            throw new Error('simulated atomic write failure');
          },
        }),
      /simulated atomic write failure/,
    );
    assert.equal(readFileSync(path, 'utf8'), input, 'original must be untouched');
    assert.deepEqual(readdirSync(dirname(path)), ['config.toml'], 'no leftover temp files');
  });
});

test('MIGRATE-12: CRLF config — root migration works, env subtable is not scanned, CRLF is preserved byte-for-byte', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      'startup_timeout_sec = 30',
      'tool_timeout_sec = 120',
      '',
      '[mcp_servers.triss.env]',
      'EXTRA = "1"',
      'tool_timeout_sec = 120',
      '',
      '[ui]',
      'theme = "dark"',
      '',
    ].join('\r\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'updated');
    const toml = readFileSync(path, 'utf8');
    // String.replace only swaps the FIRST occurrence — the root key. The env
    // subtable's 120 must stay untouched, and every CRLF must survive.
    const expected = input.replace('tool_timeout_sec = 120', 'tool_timeout_sec = 5460');
    assert.equal(toml, expected, 'only the root value token may change; CRLF preserved');
    assert.ok(toml.includes('\r\n'), 'CRLF line endings must survive');
    assert.match(toml, /tool_timeout_sec = 5460\r/);
    assert.ok(
      toml.includes('[mcp_servers.triss.env]\r\nEXTRA = "1"\r\ntool_timeout_sec = 120'),
      'env-subtable 120 must stay byte-for-byte in a CRLF file',
    );
  });
});

test('MIGRATE-13: CRLF config with only an env-subtable 120 is "absent" and untouched byte-for-byte', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      '',
      '[mcp_servers.triss.env]',
      'tool_timeout_sec = 120',
      '',
    ].join('\r\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'absent');
    assert.equal(readFileSync(path, 'utf8'), input, 'CRLF config must stay byte-for-byte');
  });
});

test('MIGRATE-14: the atomic rewrite preserves the config file permissions', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    writeFileSync(path, trissConfigWith());
    chmodSync(path, 0o640);
    const before = statSync(path).mode & 0o777;
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'updated');
    const after = statSync(path).mode & 0o777;
    assert.equal(after, before, `permissions must be preserved (0o${before.toString(8)})`);
  });
});

test('MIGRATE-15: a concurrently-changed config yields "conflict" and is never written', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = trissConfigWith();
    writeFileSync(path, input);
    let reads = 0;
    const result = migrateCodexToolTimeout({
      path,
      // Deterministic race seam: simulate another process rewriting the file
      // between our initial read and the pre-write re-read by returning
      // different bytes on the second read.
      readFile: (p) => {
        reads += 1;
        if (reads === 2) return input + '# edited concurrently\n';
        return readFileSync(p, 'utf8');
      },
    });
    assert.equal(reads, 2, 'the pre-write concurrency re-read must have happened');
    assert.equal(result.status, 'conflict');
    assert.equal(readFileSync(path, 'utf8'), input, 'file must be untouched on conflict');
    assert.deepEqual(
      readdirSync(dirname(path)),
      ['config.toml'],
      'no temp file may be left behind',
    );
  });
});

// ─── atomic rewrite helper (repository atomicReplace wrapper) ────────────────

// The failure-cleanup behaviour of the shared atomicReplace helper itself
// (temp-file cleanup, no-clobber, AggregateError on cleanup failure) is
// covered comprehensively in test/atomic-write.test.js — these tests only
// pin the migration contract: the commit goes through atomicReplaceCodexConfig
// (the repository atomicReplace wrapper) with its narrow injected options
// (write / rename / unlink) forwarded, and a failed rewrite never touches the
// original config or leaves temp litter.

test('ATOMIC-01: a write failure during migration cleans up the temp file and preserves the original', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const original = trissConfigWith();
    writeFileSync(path, original);
    assert.throws(
      () =>
        migrateCodexToolTimeout({
          path,
          atomicWrite: (p, content) =>
            atomicReplaceCodexConfig(p, content, {
              write: () => {
                throw new Error('simulated write failure');
              },
            }),
        }),
      /simulated write failure/,
    );
    assert.equal(readFileSync(path, 'utf8'), original, 'original must be untouched');
    assert.deepEqual(readdirSync(dirname(path)), ['config.toml'], 'no leftover temp files');
  });
});

test('ATOMIC-02: a rename failure during migration cleans up the temp file and preserves the original', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const original = trissConfigWith();
    writeFileSync(path, original);
    assert.throws(
      () =>
        migrateCodexToolTimeout({
          path,
          atomicWrite: (p, content) =>
            atomicReplaceCodexConfig(p, content, {
              rename: () => {
                throw new Error('simulated rename failure');
              },
            }),
        }),
      /simulated rename failure/,
    );
    assert.equal(readFileSync(path, 'utf8'), original, 'original must be untouched');
    assert.deepEqual(readdirSync(dirname(path)), ['config.toml'], 'no leftover temp files');
  });
});

test('MIGRATE-16: a symlinked config.toml keeps the symlink and atomically rewrites its real target', async () => {
  await withTmpHome((home) => {
    const dir = join(home, '.codex');
    mkdirSync(dir, { recursive: true });
    const link = join(dir, 'config.toml');
    const target = join(dir, 'real-codex-config.toml');
    writeFileSync(target, trissConfigWith());
    symlinkSync('real-codex-config.toml', link);

    const result = migrateCodexToolTimeout({ path: link });
    assert.equal(result.status, 'updated');
    assert.equal(result.path, link);
    // The symlink itself must survive and keep pointing at the same name…
    assert.ok(lstatSync(link).isSymbolicLink(), 'config.toml must still be a symlink');
    assert.equal(readlinkSync(link), 'real-codex-config.toml');
    // …and the real target was rewritten atomically in place.
    assert.match(readFileSync(target, 'utf8'), /^tool_timeout_sec = 5460$/m);
    assert.ok(!/tool_timeout_sec = 120/.test(readFileSync(target, 'utf8')));
    // No temp litter in either directory.
    assert.deepEqual(readdirSync(dir).sort(), ['config.toml', 'real-codex-config.toml']);
    assert.deepEqual(readdirSync(home), ['.codex']);
  });
});

// ─── runMcpServe integration ──────────────────────────────────────────────────

test('SERVE-01: runMcpServe migrates 120 → 5460 and warns to restart the Codex session before server start', async () => {
  await withTmpHome(async (home) => {
    const path = codexConfig(home);
    writeFileSync(path, trissConfigWith());
    const events = [];
    await runMcpServe({
      codexConfigPath: path,
      warn: (msg) => events.push(`warn: ${msg}`),
      runServer: async () => events.push('server started'),
    });
    // The migration ran before the server started…
    assert.match(readFileSync(path, 'utf8'), /tool_timeout_sec = 5460/);
    // …and the restart warning came before server start.
    assert.equal(events.length, 2, `expected warn + server start, got: ${events.join(' | ')}`);
    assert.ok(events[0].startsWith('warn: '), 'first event must be the warning');
    assert.match(events[0], /restart any currently running Codex sessions once/);
    assert.match(events[0], /120 → 5460/);
    assert.equal(events[1], 'server started');
  });
});

test('SERVE-02: a migration failure warns on stderr and still starts the server', async () => {
  const warnings = [];
  let started = false;
  await runMcpServe({
    migrateCodexToolTimeout: async () => {
      throw new Error('simulated migration failure');
    },
    warn: (msg) => warnings.push(msg),
    runServer: async () => {
      started = true;
    },
  });
  assert.equal(started, true, 'server must still start after a migration failure');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /best effort/);
  assert.match(warnings[0], /simulated migration failure/);
});

test('SERVE-03: injected migration seams are used and runServer is invoked with no changes needed', async () => {
  const calls = [];
  const warnings = [];
  let started = false;
  await runMcpServe({
    migrateCodexToolTimeout: async (opts) => {
      calls.push(opts);
      return { path: opts.path, target: 'codex', status: 'current' };
    },
    warn: (msg) => warnings.push(msg),
    runServer: async () => {
      started = true;
    },
  });
  assert.equal(calls.length, 1, 'migration must be invoked');
  assert.equal(started, true);
  assert.equal(warnings.length, 0, 'a no-op migration must not warn');
});

test('SERVE-04: default stderr writer is used when no warn seam is injected', async () => {
  await withTmpHome(async (home) => {
    const path = codexConfig(home);
    writeFileSync(path, trissConfigWith());
    const chunks = [];
    const fakeStderr = { write: (c) => chunks.push(String(c)) };
    await runMcpServe({
      codexConfigPath: path,
      stderr: fakeStderr,
      runServer: async () => {},
    });
    assert.ok(chunks.length >= 1, 'restart warning must be written to stderr');
    assert.match(chunks[0], /restart any currently running Codex sessions once/);
  });
});

test('SERVE-05: real CLI `triss mcp serve` migrates a stale 120 config and warns on stderr', async () => {
  await withTmpHome(async (home) => {
    const path = codexConfig(home);
    writeFileSync(path, trissConfigWith());
    const result = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'bin', 'triss.js'), 'mcp', 'serve'],
      {
        input: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n',
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env, HOME: home, TRISS_UPDATE_CHECK: '0' },
      },
    );
    assert.equal(result.signal, null, `CLI must exit (not hang); stderr: ${result.stderr}`);
    // The migration ran through the real commander wiring, before the server.
    assert.match(readFileSync(path, 'utf8'), /tool_timeout_sec = 5460/);
    assert.match(result.stderr || '', /restart any currently running Codex sessions once/);
  });
});

test('SERVE-06: a conflict result never emits the restart warning and the server still starts', async () => {
  const warnings = [];
  let started = false;
  await runMcpServe({
    migrateCodexToolTimeout: async () => ({
      path: '/x/config.toml',
      target: 'codex',
      status: 'conflict',
    }),
    warn: (msg) => warnings.push(msg),
    runServer: async () => {
      started = true;
    },
  });
  assert.equal(started, true, 'server must still start after a conflict');
  assert.equal(warnings.length, 0, 'a conflict must not emit the restart warning');
});

test('SERVE-07: the restart warning derives from/to from the migration result', async () => {
  const warnings = [];
  let started = false;
  await runMcpServe({
    migrateCodexToolTimeout: async () => ({
      path: '/x/config.toml',
      target: 'codex',
      status: 'updated',
      from: 120,
      to: 5460,
    }),
    warn: (msg) => warnings.push(msg),
    runServer: async () => {
      started = true;
    },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tool_timeout_sec 120 → 5460/);
  assert.match(warnings[0], /old 120s cap/);
  assert.equal(started, true);
});

test('SERVE-08: the warning reflects non-default from/to rather than hardcoded 120/5460', async () => {
  const warnings = [];
  let started = false;
  await runMcpServe({
    migrateCodexToolTimeout: async () => ({
      path: '/x/config.toml',
      target: 'codex',
      status: 'updated',
      from: 90,
      to: 9999,
    }),
    warn: (msg) => warnings.push(msg),
    runServer: async () => {
      started = true;
    },
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tool_timeout_sec 90 → 9999/);
  assert.match(warnings[0], /old 90s cap/);
  assert.equal(started, true);
});

// ─── late race: user edit during the atomic temp write ───────────────────────
//
// The optimistic re-read in migrateCodexToolTimeout only covers changes that
// land before the write begins. A user edit that lands *while the temp file is
// being written* is caught by the atomicReplace CAS precondition (the expected
// snapshot passed by atomicReplaceCodexConfig), which throws instead of
// returning the early `status: 'conflict'`. This test drives that later window
// deterministically from inside the injected write seam: the first temp write
// rewrites the real config, so verifyPrecondition must fail closed afterwards.

test('MIGRATE-17: a user edit during temp writing is caught by the atomic CAS precondition, never clobbered', async () => {
  await withTmpHome(async (home) => {
    const path = codexConfig(home);
    const input = trissConfigWith();
    writeFileSync(path, input);
    const userEdit = input + '# user edit during migration\n';
    let mutated = false;

    // Direct migration: the late race throws a clear precondition error.
    assert.throws(
      () =>
        migrateCodexToolTimeout({
          path,
          atomicWrite: (p, content, opts) =>
            atomicReplaceCodexConfig(p, content, {
              ...opts,
              // Deterministic late-race seam: while the temp file is written,
              // the user rewrites the config (same inode, new bytes).
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
          'the late race must surface as a precondition failure, not a status result',
        );
        return true;
      },
    );
    assert.equal(mutated, true, 'the write seam must have run (temp writing started)');
    // The user edit survived: the CAS precondition refused to clobber it.
    assert.equal(
      readFileSync(path, 'utf8'),
      userEdit,
      'the user edit made during temp writing must be preserved',
    );
    assert.ok(
      !/tool_timeout_sec = 5460/.test(readFileSync(path, 'utf8')),
      'the migration must not install 5460 over the late user edit',
    );
    assert.deepEqual(readdirSync(dirname(path)), ['config.toml'], 'no leftover temp files');

    // runMcpServe: the same late race is best-effort — it warns and still
    // starts the server, leaving the user edit untouched.
    const warnings = [];
    let started = false;
    mutated = false;
    writeFileSync(path, input); // restore the pre-race config for the serve run
    await runMcpServe({
      codexConfigPath: path,
      migrateCodexToolTimeout: (opts) =>
        migrateCodexToolTimeout({
          ...opts,
          atomicWrite: (p, content, o) =>
            atomicReplaceCodexConfig(p, content, {
              ...o,
              write(fd, buffer, offset, length) {
                if (!mutated) {
                  mutated = true;
                  writeFileSync(p, userEdit);
                }
                return writeSync(fd, buffer, offset, length);
              },
            }),
        }),
      warn: (msg) => warnings.push(msg),
      runServer: async () => {
        started = true;
      },
    });
    assert.equal(started, true, 'server must still start after a late-race precondition failure');
    assert.equal(warnings.length, 1, 'the late race must produce exactly one warning');
    assert.match(warnings[0], /best effort/);
    assert.match(
      warnings[0],
      /content changed since planning|refusing to overwrite|refusing to replace/,
    );
    assert.equal(
      readFileSync(path, 'utf8'),
      userEdit,
      'the user edit must be preserved across the best-effort serve run',
    );
    assert.ok(
      !/tool_timeout_sec = 5460/.test(readFileSync(path, 'utf8')),
      'the migration must not install 5460 over the late user edit during serve',
    );
    assert.deepEqual(readdirSync(dirname(path)), ['config.toml'], 'no leftover temp files');
  });
});

// ─── CRLF + inline comment (GLM 5.3 final regex bug) ──────────────────────────
//
// The tool_timeout_sec line regex must accept CRLF lines that also carry an
// inline TOML comment — both with a whitespace separator (`120 # cap`) and
// glued to the value (`120#compact`) — and byte-preserve the CR and the
// comment. The comment pattern must never consume the carriage return, and the
// suffix capture (group 3) includes the optional CR so reconstruction keeps it.

test('MIGRATE-18: CRLF with spaced/compact inline comments — only 120 changes to 5460, every CRLF and comment byte is preserved', async () => {
  await withTmpHome((home) => {
    for (const [line, expectedLine] of [
      ['tool_timeout_sec = 120 # legacy cap', 'tool_timeout_sec = 5460 # legacy cap'],
      ['tool_timeout_sec = 120#compact', 'tool_timeout_sec = 5460#compact'],
    ]) {
      const path = codexConfig(home);
      const input = [
        '# user config',
        'model = "gpt-5"',
        '',
        '[mcp_servers.triss]',
        'command = "triss"',
        'args = ["mcp", "serve"]',
        'startup_timeout_sec = 30',
        line,
        '',
        '[ui]',
        'theme = "dark"',
        '',
      ].join('\r\n');
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'updated', `for line: ${line}`);
      assert.equal(result.from, 120);
      assert.equal(result.to, 5460);
      const toml = readFileSync(path, 'utf8');
      // Only the value token may change: the CRLF endings and the inline
      // comment must survive byte-for-byte.
      const expected = input.replace(line, expectedLine);
      assert.equal(toml, expected, `for line: ${line} — only 120 → 5460 may change`);
      assert.ok(toml.includes('\r\n'), 'CRLF line endings must survive');
      assert.ok(
        toml.includes(`${expectedLine}\r`),
        `for line: ${line} — the rewritten line must keep its CR and comment`,
      );
      assert.ok(
        !/tool_timeout_sec = 120/.test(toml),
        `for line: ${line} — the historical 120 must be gone`,
      );
    }
  });
});

// ─── conservative TOML lexer (PR #49 review) ──────────────────────────────────
//
// The migration must never recognize table headers or key assignments whose
// text lives inside a TOML multi-line basic (""") or literal (''') string, must
// recognize valid table headers with trailing comments as boundaries, and must
// treat quoted headers safely. Quoting never changes which table a dotted key
// names: ["mcp_servers"."triss"] is the SAME table as [mcp_servers.triss], but
// the automatic legacy-timeout migration is deliberately narrow — it only ever
// rewrites the exact bare header triss generated — so a quoted header still
// stops the prior table scan and its keys are never counted or rewritten (the
// installer, by contrast, treats the two-component quoted root as the same
// table; see mcp-install.test.js CODEX-16/17). Every byte outside the exact
// bare root value token is preserved. Malformed or lexically ambiguous TOML is
// left untouched.

test('LEXER-01: fake table/key text inside a multi-line basic string is never scanned', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[foo]',
      'msg = """',
      '[mcp_servers.triss]',
      'tool_timeout_sec = 120',
      '"""',
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    // The fake header inside the string is not the block start; the REAL bare
    // root after it is. Only that root token may change.
    assert.equal(result.status, 'updated');
    const expected = input.replace(
      '[mcp_servers.triss]\ncommand = "triss"\nargs = ["mcp", "serve"]\ntool_timeout_sec = 120',
      '[mcp_servers.triss]\ncommand = "triss"\nargs = ["mcp", "serve"]\ntool_timeout_sec = 5460',
    );
    assert.equal(readFileSync(path, 'utf8'), expected, 'only the real root token may change');
    assert.ok(
      readFileSync(path, 'utf8').includes('tool_timeout_sec = 120\n"""'),
      'the string-embedded 120 must survive byte-for-byte',
    );
  });
});

test('LEXER-02: a tool_timeout_sec line inside a multi-line literal string in the block is not a hit', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      "msg = '''",
      'tool_timeout_sec = 120',
      "'''",
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    // The only 120 lives inside the literal string — the root key is absent.
    assert.equal(result.status, 'absent');
    assert.equal(
      readFileSync(path, 'utf8'),
      input,
      'a string-embedded key must never be migrated; config stays byte-for-byte',
    );
  });
});

test('LEXER-03: a multi-line basic string opened inside the block swallows following header-like lines', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[mcp_servers.triss]',
      'command = "triss"',
      'msg = """',
      '[mcp_servers.other]',
      'tool_timeout_sec = 120',
      '"""',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    // `[mcp_servers.other]` is string content, NOT a boundary — but the only
    // 120 is also string content, so the root key is absent. The fake header
    // must not stop the scan with a hit either way.
    assert.equal(result.status, 'absent');
    assert.equal(readFileSync(path, 'utf8'), input, 'must stay byte-for-byte');
  });
});

test('LEXER-04: escaped quotes keep a multi-line basic string open; the fake header inside is not a boundary', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[mcp_servers.triss]',
      'command = "triss"',
      'tool_timeout_sec = 120',
      '',
      '[foo]',
      'desc = """',
      'line with \\"""',
      '[mcp_servers.other]',
      'tool_timeout_sec = 120',
      '"""',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    // The root 120 migrates; the escaped `\"""` must NOT close the string, so
    // the fake `[mcp_servers.other]` header and its 120 are string content.
    assert.equal(result.status, 'updated');
    const toml = readFileSync(path, 'utf8');
    // String.replace swaps the FIRST 120 — the real root line. The string
    // content copy (after the escaped `\"""`) must survive.
    const expected = input.replace('tool_timeout_sec = 120', 'tool_timeout_sec = 5460');
    assert.equal(toml, expected, 'only the first (real root) token may change');
    assert.ok(
      toml.includes('desc = """\nline with \\"""\n[mcp_servers.other]\ntool_timeout_sec = 120\n"""'),
      'escaped-quote content and the fake header must survive byte-for-byte',
    );
  });
});

test('LEXER-05: trailing-comment env-subtable header is a boundary — its 120 is untouched', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[mcp_servers.triss]',
      'command = "triss"',
      'tool_timeout_sec = 120',
      '',
      '[mcp_servers.triss.env] # env vars below',
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'updated');
    const expected = input.replace(
      'tool_timeout_sec = 120\n\n[mcp_servers.triss.env]',
      'tool_timeout_sec = 5460\n\n[mcp_servers.triss.env]',
    );
    assert.equal(readFileSync(path, 'utf8'), expected, 'trailing-comment header survives; env 120 untouched');
    assert.ok(
      readFileSync(path, 'utf8').includes('[mcp_servers.triss.env] # env vars below\ntool_timeout_sec = 120'),
      'the env-subtable 120 and its comment must survive byte-for-byte',
    );
  });
});

test('LEXER-06: a trailing-comment next-table header is a boundary', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[mcp_servers.triss]',
      'tool_timeout_sec = 120',
      '',
      '[ui] # theme section',
      'theme = "dark"',
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'updated');
    const toml = readFileSync(path, 'utf8');
    assert.match(toml, /^tool_timeout_sec = 5460$/m);
    assert.ok(
      toml.includes('[ui] # theme section\ntheme = "dark"\ntool_timeout_sec = 120'),
      'keys under the trailing-comment [ui] header must survive byte-for-byte',
    );
  });
});

test('LEXER-07: a bare root next to a quoted/mixed root declares the same table twice — "ambiguous", never rewritten', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[mcp_servers.triss]',
      'command = "triss"',
      'tool_timeout_sec = 120',
      '',
      '["mcp_servers"."triss"]',
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    // ["mcp_servers"."triss"] is the SAME table as [mcp_servers.triss] in
    // TOML. Two semantic roots — one bare, one quoted — declare that table
    // twice, so the migration reports `ambiguous` and leaves every byte
    // untouched; the quoted root is never rewritten (the migration only ever
    // touches the exact bare form triss generated).
    assert.equal(result.status, 'ambiguous');
    assert.equal(readFileSync(path, 'utf8'), input, 'two semantic roots must stay byte-for-byte');
  });
});

test('LEXER-08: a two-component quoted root is semantically the same table, yet the narrow migration never touches it', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '["mcp_servers"."triss"]',
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    // No BARE [mcp_servers.triss] block exists. The quoted root names the
    // same table, but the migration is deliberately narrow to the exact
    // generated bare form — so there is nothing to migrate ("absent"), and
    // the quoted form stays byte-for-byte (the installer recognizes it;
    // see CODEX-16/17 in mcp-install.test.js).
    assert.equal(result.status, 'absent');
    assert.equal(readFileSync(path, 'utf8'), input, 'quoted-only config must stay byte-for-byte');
  });
});

test('LEXER-09: a trailing-comment bare root header is still recognized as the block start', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[mcp_servers.triss] # generated by triss',
      'command = "triss"',
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'updated');
    const expected = input.replace('tool_timeout_sec = 120', 'tool_timeout_sec = 5460');
    assert.equal(readFileSync(path, 'utf8'), expected, 'header comment must survive byte-for-byte');
  });
});

test('LEXER-10: single-line strings with escaped quotes and # inside stay inert', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[mcp_servers.triss]',
      'command = "triss \\"#not-a-comment\\""',
      'args = ["mcp", "serve"]',
      'tool_timeout_sec = 120',
      '',
      '[mcp_servers.other]',
      'command = "other # also not a comment"',
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'updated');
    const expected = input.replace(
      'tool_timeout_sec = 120\n\n[mcp_servers.other]',
      'tool_timeout_sec = 5460\n\n[mcp_servers.other]',
    );
    assert.equal(readFileSync(path, 'utf8'), expected, 'strings/comments must survive byte-for-byte');
  });
});

test('LEXER-11: CRLF — multiline string content, trailing-comment headers, and byte preservation', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[foo]',
      'msg = """',
      'tool_timeout_sec = 120',
      '[mcp_servers.triss]',
      '"""',
      '[mcp_servers.triss]',
      'command = "triss"',
      'tool_timeout_sec = 120',
      '[mcp_servers.triss.env] # env',
      'tool_timeout_sec = 120',
      '',
    ].join('\r\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'updated');
    const toml = readFileSync(path, 'utf8');
    assert.ok(toml.includes('\r\n'), 'CRLF must survive');
    // The string-embedded 120 (inside [foo]) and the env 120 survive; the
    // bare root 120 (under the real [mcp_servers.triss]) becomes 5460.
    assert.ok(toml.includes('msg = """\r\ntool_timeout_sec = 120\r\n[mcp_servers.triss]\r\n"""'));
    assert.ok(toml.includes('[mcp_servers.triss.env] # env\r\ntool_timeout_sec = 120'));
    // The real bare-root line is migrated (the string-embedded copy is not).
    assert.ok(
      toml.includes('[mcp_servers.triss]\r\ncommand = "triss"\r\ntool_timeout_sec = 5460'),
      'the bare root token must be migrated in a CRLF file',
    );
  });
});

test('LEXER-12: an unterminated multi-line string leaves the config untouched', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[mcp_servers.triss]',
      'tool_timeout_sec = 120',
      'msg = """',
      'never closed',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'malformed');
    assert.equal(readFileSync(path, 'utf8'), input, 'lexically ambiguous TOML must stay byte-for-byte');
  });
});

test('LEXER-13: an unparseable header-like line leaves the config untouched', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    for (const input of [
      ['[mcp_servers.triss]', 'tool_timeout_sec = 120', '[unclosed', ''].join('\n'),
      ['[mcp_servers.triss]', 'tool_timeout_sec = 120', '[a#b]', ''].join('\n'),
      ['[mcp_servers.triss]', 'tool_timeout_sec = 120', '["quoted"', ''].join('\n'),
    ]) {
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'malformed');
      assert.equal(readFileSync(path, 'utf8'), input, 'malformed TOML must stay byte-for-byte');
    }
  });
});

test('LEXER-14: a semantic array-of-tables header next to a bare root is "ambiguous", never rewritten', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[mcp_servers.triss]',
      'tool_timeout_sec = 120',
      '',
      '[[mcp_servers.triss]]',
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    // [[mcp_servers.triss]] occupies the same dotted path as the bare root
    // with an incompatible ARRAY shape — TOML forbids a table and an array of
    // tables from sharing a path. The redefinition conflict is `ambiguous`
    // and every byte stays untouched; the AoT element key is never rewritten.
    assert.equal(result.status, 'ambiguous');
    assert.equal(readFileSync(path, 'utf8'), input, 'a bare root next to an AoT root must stay byte-for-byte');
  });
});

// ─── semantic array-of-tables roots (migration) ──────────────────────────────
//
// [[mcp_servers.triss]] — and its quoted/mixed/escape-decoded two-component
// spellings — declares an ARRAY of tables at the path the Triss root table
// occupies. The migration never rewrites an AoT-only config ("absent", every
// byte untouched), reports `ambiguous` when an AoT root coexists with a
// regular semantic root (TOML forbids a table and an array of tables sharing
// a path), and keeps the single-component [["mcp_servers.triss"]] array — a
// completely different key — out of every count.

test('AOT-01: an array-of-tables-only config is "absent" and never rewritten', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const inputs = [
      // Bare AoT with a 120 inside an element.
      [
        '[[mcp_servers.triss]]',
        'command = "triss"',
        'tool_timeout_sec = 120',
        '',
      ].join('\n'),
      // Quoted two-component AoT spelling.
      [
        '[["mcp_servers"."triss"]]',
        'tool_timeout_sec = 120',
        '',
      ].join('\n'),
      // Mixed-quoting two-component AoT spelling.
      [
        '[["mcp_servers".triss]]',
        'tool_timeout_sec = 120',
        '',
      ].join('\n'),
      // Escape-decoded two-component AoT spelling (\u005F is underscore).
      [
        '[["mcp\\u005Fservers"."triss"]]',
        'tool_timeout_sec = 120',
        '',
      ].join('\n'),
      // Two AoT elements are a VALID TOML array — still never rewritten.
      [
        '[[mcp_servers.triss]]',
        'command = "a"',
        'tool_timeout_sec = 120',
        '',
        '[[mcp_servers.triss]]',
        'command = "b"',
        'tool_timeout_sec = 120',
        '',
      ].join('\n'),
    ];
    for (const input of inputs) {
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'absent', `for input:\n${input}`);
      assert.equal(
        readFileSync(path, 'utf8'),
        input,
        'an AoT-only config must never be rewritten',
      );
    }
  });
});

test('AOT-02: an array-of-tables root next to a quoted/mixed root is "ambiguous", never rewritten', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    for (const input of [
      [
        '[["mcp_servers"."triss"]]',
        'tool_timeout_sec = 120',
        '',
        '["mcp_servers"."triss"]',
        'tool_timeout_sec = 120',
        '',
      ].join('\n'),
      [
        '[[mcp_servers.triss]]',
        'tool_timeout_sec = 120',
        '',
        '["mcp_servers".triss]',
        'tool_timeout_sec = 120',
        '',
      ].join('\n'),
    ]) {
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'ambiguous', `for input:\n${input}`);
      assert.equal(
        readFileSync(path, 'utf8'),
        input,
        'an AoT root plus a regular root must stay byte-for-byte',
      );
    }
  });
});

test('AOT-03: a single-component [["mcp_servers.triss"]] array is distinct and never makes a bare root ambiguous', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    // [["mcp_servers.triss"]] is ONE component whose literal name contains a
    // dot — a completely different array from the two-component Triss AoT. It
    // must never count toward the AoT total, so the single bare root is
    // unambiguous and migrates; the single-component array survives
    // byte-for-byte.
    const input = [
      '[mcp_servers.triss]',
      'command = "triss"',
      'tool_timeout_sec = 120',
      '',
      '[["mcp_servers.triss"]]',
      'custom_key = "user value"',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'updated');
    const toml = readFileSync(path, 'utf8');
    assert.match(toml, /^tool_timeout_sec = 5460$/m);
    assert.ok(
      toml.includes('[["mcp_servers.triss"]]\ncustom_key = "user value"'),
      'the single-component user array must survive byte-for-byte',
    );
  });
});

test('LEXER-15: quoted header keys with # and spaces parse; the header still stops the scan', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[mcp_servers.triss]',
      'tool_timeout_sec = 120',
      '',
      "['mcp_servers'.'triss env'.'a#b']",
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'updated');
    const toml = readFileSync(path, 'utf8');
    assert.match(toml, /^tool_timeout_sec = 5460$/m);
    assert.ok(
      toml.includes("['mcp_servers'.'triss env'.'a#b']\ntool_timeout_sec = 120"),
      'the literal-quoted header and its key must survive byte-for-byte',
    );
  });
});

// ─── same-line multi-line strings (GLM cross-review) ─────────────────────────
//
// A valid TOML multi-line string can open AND close on the same line
// (`note = """text"""`), and a multi-line string can be an array element
// (`values = ["""a""", "b"]`). The line lexer must track real lexical state:
// an opener and a closer on the same line leave NO residual state, so these
// values never mark the file malformed and never swallow the lines after
// them. Same-line multi-line values before and inside the Triss block must
// not block the exact-120 migration and must remain byte-identical.

test('LEXER-16: same-line multiline basic/literal values before and inside the block do not block the exact-120 migration', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[foo]',
      'note = """same-line text"""',
      "note2 = '''same-line literal'''",
      'note3 = """same-line with comment""" # trailing comment',
      'values = ["""a""", "b"]',
      '',
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      'note = """same-line text"""',
      "note2 = '''same-line literal'''",
      'values = ["""a""", "b"]',
      'tool_timeout_sec = 120',
      '',
      '[ui]',
      'theme = "dark"',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'updated');
    // Only the exact root value token may change; every same-line multi-line
    // value — basic, literal, comment-terminated, and array-of-multiline-
    // elements, both before and inside the block — stays byte-identical.
    const expected = input.replace(
      'tool_timeout_sec = 120\n\n[ui]',
      'tool_timeout_sec = 5460\n\n[ui]',
    );
    assert.equal(readFileSync(path, 'utf8'), expected, 'only 120 → 5460 may change');
    assert.ok(
      readFileSync(path, 'utf8').includes(
        '[foo]\nnote = """same-line text"""\nnote2 = \'\'\'same-line literal\'\'\'\n' +
          'note3 = """same-line with comment""" # trailing comment\nvalues = ["""a""", "b"]',
      ),
      'before-block same-line multiline values must survive byte-for-byte',
    );
    assert.ok(
      readFileSync(path, 'utf8').includes(
        '[mcp_servers.triss]\ncommand = "triss"\nargs = ["mcp", "serve"]\n' +
          'note = """same-line text"""\nnote2 = \'\'\'same-line literal\'\'\'\nvalues = ["""a""", "b"]\n' +
          'tool_timeout_sec = 5460',
      ),
      'inside-block same-line multiline values must survive byte-for-byte',
    );
  });
});

test('LEXER-17: a same-line multiline string with NO closer is still conservative — malformed, untouched', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    for (const input of [
      ['[mcp_servers.triss]', 'tool_timeout_sec = 120', 'note = """never closed', ''].join('\n'),
      ['[mcp_servers.triss]', "note2 = '''never closed", 'tool_timeout_sec = 120', ''].join('\n'),
    ]) {
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'malformed');
      assert.equal(readFileSync(path, 'utf8'), input, 'unterminated input must stay byte-for-byte');
    }
  });
});

// ─── cross-line multi-line strings inside arrays (GLM cross-review) ──────────
//
// A valid TOML array may hold a multi-line basic/literal string that opens on
// one line and closes on a LATER line, with the closing delimiter followed by
// array punctuation (`""",`) and further elements. The multi-line state
// inherited from a previous line must be lexed by the SAME whole-line scanner:
// the close hands the remainder of the line — commas, brackets, further
// strings, comments — back to normal lexing, so such arrays are valid, never
// mark the file malformed, and never swallow the lines after them. Cross-line
// array values before and inside the Triss block must not block the exact-120
// migration and must remain byte-identical.

test('LEXER-18: cross-line multiline basic/literal strings inside arrays before and inside the block do not block the exact-120 migration', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[foo]',
      'values = [',
      '"""',
      'basic line one',
      'basic line two',
      '""",',
      '"plain element",',
      "['''",
      'literal line one',
      "''',",
      ']',
      ']',
      '',
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      'values = [',
      '"""',
      'in-block basic',
      '""",',
      ']',
      'tool_timeout_sec = 120',
      '',
      '[ui]',
      'theme = "dark"',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'updated');
    // Only the exact root value token may change; every cross-line multi-line
    // array element — basic and literal, before and inside the block — stays
    // byte-identical, including the `""",` comma that follows each closer.
    const expected = input.replace(
      'tool_timeout_sec = 120\n\n[ui]',
      'tool_timeout_sec = 5460\n\n[ui]',
    );
    assert.equal(readFileSync(path, 'utf8'), expected, 'only 120 → 5460 may change');
    assert.ok(
      readFileSync(path, 'utf8').includes(
        '[foo]\nvalues = [\n"""\nbasic line one\nbasic line two\n""",\n"plain element",\n' +
          "['''\nliteral line one\n''',\n]\n]",
      ),
      'before-block cross-line array multiline values must survive byte-for-byte',
    );
    assert.ok(
      readFileSync(path, 'utf8').includes(
        '[mcp_servers.triss]\ncommand = "triss"\nargs = ["mcp", "serve"]\nvalues = [\n"""\n' +
          'in-block basic\n""",\n]\ntool_timeout_sec = 5460',
      ),
      'inside-block cross-line array multiline values must survive byte-for-byte',
    );
  });
});

test('LEXER-19: a fake header/key inside a cross-line array multiline string is never scanned', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[foo]',
      'values = [',
      '"""',
      '[mcp_servers.triss]',
      'tool_timeout_sec = 120',
      '""",',
      ']',
      '[mcp_servers.triss]',
      'command = "triss"',
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    // The fake header and key inside the array string are string content; the
    // REAL bare root after the array is the block, and only its token may
    // change. The `""",` close must not be mistaken for a boundary either.
    assert.equal(result.status, 'updated');
    const expected = input.replace(
      '[mcp_servers.triss]\ncommand = "triss"\ntool_timeout_sec = 120',
      '[mcp_servers.triss]\ncommand = "triss"\ntool_timeout_sec = 5460',
    );
    assert.equal(readFileSync(path, 'utf8'), expected, 'only the real root token may change');
    assert.ok(
      readFileSync(path, 'utf8').includes(
        '[foo]\nvalues = [\n"""\n[mcp_servers.triss]\ntool_timeout_sec = 120\n""",\n]',
      ),
      'the string-embedded fake header and key must survive byte-for-byte',
    );
  });
});

test('LEXER-20: a cross-line multiline string inside an array with NO closer is still conservative — malformed, untouched', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    for (const input of [
      ['[mcp_servers.triss]', 'tool_timeout_sec = 120', 'values = [', '"""', 'never closed', ']', ''].join('\n'),
      ['[mcp_servers.triss]', 'values = [', "'''", 'tool_timeout_sec = 120', ']', ''].join('\n'),
    ]) {
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'malformed');
      assert.equal(readFileSync(path, 'utf8'), input, 'unterminated input must stay byte-for-byte');
    }
  });
});

// ─── container nesting: arrays of arrays / inline tables (cross-review) ───────
//
// A valid TOML array may hold array or inline-table elements that OPEN on
// their own line while the enclosing array is still open: `[1, 2],` and
// `[[1], [2]],` inside a multi-line array, `{ a = 1 },` inside another. Those
// lines start inside an open square/curly container, so they are VALUES — the
// scanner must track container nesting across lines and only attempt table
// header parsing at statement depth zero. Without that, a scanner that treats
// every code line starting with `[` as a header marks valid TOML malformed,
// the generated Triss block is missed, and the exact-120 migration refuses to
// run. Nested arrays before and inside the config around the Triss block must
// not block the migration and must remain byte-identical.

test('LEXER-21: nested multi-line arrays with [1, 2] element lines before and inside the config around the Triss block do not block the exact-120 migration', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[foo]',
      'matrix = [',
      '[1, 2],',
      '[3, 4],',
      ']',
      'nested = [',
      '[[1], [2]],',
      '[[3]],',
      ']',
      'inline = [',
      '{ a = 1 },',
      '{ b = [1, 2] },',
      ']',
      '',
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      'matrix = [',
      '[1, 2],',
      '[3, 4],',
      ']',
      'tool_timeout_sec = 120',
      '',
      '[ui]',
      'theme = "dark"',
      'after = [',
      '[7, 8],',
      ']',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    // The [1, 2] / [[1], [2]] / { a = 1 } element lines are values, not
    // headers, so the file is valid and the generated block is found.
    assert.equal(result.status, 'updated');
    const toml = readFileSync(path, 'utf8');
    // Exactly one bare root block exists and was located for the rewrite.
    const hits = toml.match(/^\[mcp_servers\.triss\]$/gm) || [];
    assert.equal(hits.length, 1, 'the bare root block must appear exactly once');
    // Only the exact root value token may change; every nested array element
    // line — before, inside, and after the block — stays byte-identical.
    const expected = input.replace('tool_timeout_sec = 120', 'tool_timeout_sec = 5460');
    assert.equal(toml, expected, 'only 120 → 5460 may change');
    assert.ok(
      toml.includes(
        '[foo]\nmatrix = [\n[1, 2],\n[3, 4],\n]\nnested = [\n[[1], [2]],\n[[3]],\n]\n' +
          'inline = [\n{ a = 1 },\n{ b = [1, 2] },\n]',
      ),
      'before-block nested array element lines must survive byte-for-byte',
    );
    assert.ok(
      toml.includes(
        '[mcp_servers.triss]\ncommand = "triss"\nargs = ["mcp", "serve"]\nmatrix = [\n' +
          '[1, 2],\n[3, 4],\n]\ntool_timeout_sec = 5460',
      ),
      'inside-block nested array element lines must survive byte-for-byte',
    );
    assert.ok(
      toml.includes('[ui]\ntheme = "dark"\nafter = [\n[7, 8],\n]'),
      'after-block nested array element lines must survive byte-for-byte',
    );
  });
});

test('LEXER-22: an unterminated container at EOF is still conservative — malformed, untouched', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    for (const input of [
      ['[mcp_servers.triss]', 'tool_timeout_sec = 120', 'values = [', '1,', '2,', ''].join('\n'),
      ['[foo]', 'x = {', 'a = 1,', 'b = 2', ''].join('\n'),
    ]) {
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'malformed', `for input:\n${input}`);
      assert.equal(readFileSync(path, 'utf8'), input, 'unterminated input must stay byte-for-byte');
    }
  });
});

// ─── typed container nesting: mismatched / stray closers (fail-closed) ────────
//
// Container nesting is tracked as a TYPED stack of expected closers, not a
// bare depth that clamps closers at zero. A `]` must close the `[` that is
// currently open and a `}` must close a `{`; a mismatched closer (`}` where a
// `[` is open, or `]` where a `{` is open) or a stray closer with nothing open
// is malformed TOML. A scalar depth would let `values = [` followed by `}` —
// or a root `]` — sink back to depth zero and look balanced, which would let
// the migration rewrite a file that is actually garbage. These must report
// `malformed` and stay byte-for-byte untouched.

test('LEXER-23: mismatched nested delimiters are conservative — malformed, untouched', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const inputs = [
      // A `[` is open; the next line closes it with `}` — wrong kind.
      ['[mcp_servers.triss]', 'tool_timeout_sec = 120', 'values = [', '}', ''].join('\n'),
      // A `{` is open; the next line closes it with `]` — wrong kind.
      ['[foo]', 'x = {', 'a = 1,', ']', '[mcp_servers.triss]', 'tool_timeout_sec = 120', ''].join('\n'),
      // `]` closes a `{` (top of the typed stack is `}`).
      ['[foo]', 'x = {', ']', ''].join('\n'),
      // A nested element array is open when a `}` arrives.
      ['[foo]', 'matrix = [', '[1,', '}', ''].join('\n'),
      // A valid inner array closes, but the enclosing `[` is then closed with `}`.
      ['[mcp_servers.triss]', 'values = [', '[1],', '}', 'tool_timeout_sec = 120', ''].join('\n'),
    ];
    for (const input of inputs) {
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'malformed', `for input:\n${input}`);
      assert.equal(
        readFileSync(path, 'utf8'),
        input,
        'mismatched-delimiter input must stay byte-for-byte',
      );
    }
  });
});

test('LEXER-24: stray closers with nothing open are conservative — malformed, untouched', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const inputs = [
      // A root `]` after the block.
      ['[mcp_servers.triss]', 'tool_timeout_sec = 120', ']', ''].join('\n'),
      // A root `}` after the block.
      ['[mcp_servers.triss]', 'tool_timeout_sec = 120', '}', ''].join('\n'),
      // An extra `]` after the array already closed — everything is balanced,
      // then a stray closer appears at depth zero.
      ['[mcp_servers.triss]', 'tool_timeout_sec = 120', 'values = [', '1,', ']', ']', ''].join('\n'),
      // A stray closer BEFORE the block.
      [']', '[mcp_servers.triss]', 'tool_timeout_sec = 120', ''].join('\n'),
      // A stray closer inside a header-less value line.
      ['[foo]', 'tool_timeout_sec = 120', '}', ''].join('\n'),
    ];
    for (const input of inputs) {
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'malformed', `for input:\n${input}`);
      assert.equal(
        readFileSync(path, 'utf8'),
        input,
        'stray-closer input must stay byte-for-byte',
      );
    }
  });
});

test('LEXER-25: deep mixed square/curly nesting — element lines inside arrays of inline tables and arrays inside those tables do not block the exact-120 migration', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[foo]',
      'mixed = [',
      '[ { a = 1 }, { b = [2, 3] } ],',
      '{ c = { d = 1 } },',
      ']',
      '',
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      'nested = [',
      '[ { k = [1] } ],',
      '{ list = [7, 8] },',
      ']',
      'tool_timeout_sec = 120',
      '',
      '[ui]',
      'theme = "dark"',
      'after = [',
      '{ pair = [1] },',
      ']',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    // Every element line starts inside an open square/curly container, so it
    // is a VALUE, never a header — the typed stack balances across lines
    // (`[ { … } ],` opens square then curly, closes curly then square) and the
    // file is valid. The generated block is found and only its token may
    // change; every nested element line survives byte-for-byte.
    assert.equal(result.status, 'updated');
    const toml = readFileSync(path, 'utf8');
    const hits = toml.match(/^\[mcp_servers\.triss\]$/gm) || [];
    assert.equal(hits.length, 1, 'the bare root block must appear exactly once');
    const expected = input.replace('tool_timeout_sec = 120', 'tool_timeout_sec = 5460');
    assert.equal(toml, expected, 'only 120 → 5460 may change');
    assert.ok(
      toml.includes('[foo]\nmixed = [\n[ { a = 1 }, { b = [2, 3] } ],\n{ c = { d = 1 } },\n]'),
      'before-block mixed nesting must survive byte-for-byte',
    );
    assert.ok(
      toml.includes(
        '[mcp_servers.triss]\ncommand = "triss"\nargs = ["mcp", "serve"]\nnested = [\n' +
          '[ { k = [1] } ],\n{ list = [7, 8] },\n]\ntool_timeout_sec = 5460',
      ),
      'inside-block mixed nesting must survive byte-for-byte',
    );
    assert.ok(
      toml.includes('[ui]\ntheme = "dark"\nafter = [\n{ pair = [1] },\n]'),
      'after-block mixed nesting must survive byte-for-byte',
    );
  });
});

// ─── single-line string state at EOL (fail-closed) ───────────────────────────
//
// TOML single-line basic and literal strings can never span a newline. The
// line lexer tracks single-line quote state (`quote`) while scanning a line
// but must NOT discard it at EOL: an unterminated quote — including a basic
// string whose closing quote was escaped away by a trailing backslash — is a
// lexical error. If that state were dropped, a later fake-looking
// `[mcp_servers.triss]` header and its `tool_timeout_sec = 120` line would be
// processed as if the file were valid and the migration would rewrite a
// syntactically broken config. These must report `malformed` and stay
// byte-for-byte untouched.

test('LEXER-26: an unterminated single-line basic string before a fake Triss block is conservative — malformed, untouched', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      'model = "gpt-5',
      '[mcp_servers.triss]',
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    // The unclosed `"` must poison the whole file, so the fake-looking header
    // and its exact-120 line are never processed as a real Triss block.
    assert.equal(result.status, 'malformed');
    assert.equal(
      readFileSync(path, 'utf8'),
      input,
      'unterminated-basic-string input must stay byte-for-byte',
    );
  });
});

test('LEXER-27: an unterminated single-line literal string before a fake Triss block is conservative — malformed, untouched', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      "model = 'gpt-5",
      '[mcp_servers.triss]',
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'malformed');
    assert.equal(
      readFileSync(path, 'utf8'),
      input,
      'unterminated-literal-string input must stay byte-for-byte',
    );
  });
});

test('LEXER-28: a single-line basic string with a trailing backslash before a fake Triss block is conservative — malformed, untouched', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      'model = "gpt-5\\',
      '[mcp_servers.triss]',
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    // The trailing `\` escapes the character that would have closed the
    // string, so the quote is still open at EOL — malformed, never migrated.
    assert.equal(result.status, 'malformed');
    assert.equal(
      readFileSync(path, 'utf8'),
      input,
      'trailing-backslash input must stay byte-for-byte',
    );
  });
});

// ─── full snapshot revalidation (PR #49 review) ──────────────────────────────
//
// The migration captures the symlink entry, resolved target path, target
// inode/mode, and content as ONE validated snapshot before analysis. The
// pre-write re-read must revalidate ALL of those fields — identical content
// bytes are not enough, so a symlink retargeted to a same-content sibling is
// a conflict, not a silent write. atomicReplaceCodexConfig consumes the exact
// pre-analysis snapshot as its CAS precondition instead of taking a fresh one
// after the re-read, so a retarget that lands while the temp file is being
// written fails closed via the atomicReplace precondition.

test('SNAPSHOT-01: a symlink retargeted to identical bytes before the re-read is a conflict, never written', async () => {
  await withTmpHome((home) => {
    const dir = join(home, '.codex');
    mkdirSync(dir, { recursive: true });
    const link = join(dir, 'config.toml');
    const targetA = join(dir, 'real-a.toml');
    const targetB = join(dir, 'real-b.toml');
    const identical = trissConfigWith();
    writeFileSync(targetA, identical);
    writeFileSync(targetB, identical);
    symlinkSync('real-a.toml', link);

    let reads = 0;
    const result = migrateCodexToolTimeout({
      path: link,
      readFile: (p) => {
        reads += 1;
        if (reads === 2) {
          // Deterministic early race: the symlink is retargeted to a sibling
          // whose bytes are IDENTICAL to the analyzed target. Content alone
          // cannot see this — only the full snapshot revalidation can.
          unlinkSync(link);
          symlinkSync('real-b.toml', link);
        }
        return readFileSync(p, 'utf8');
      },
    });
    assert.equal(reads, 2, 'the pre-write re-read must have happened');
    assert.equal(result.status, 'conflict');
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

test('SNAPSHOT-02: a symlink retargeted to identical bytes during temp writing fails the CAS precondition', async () => {
  await withTmpHome(async (home) => {
    const dir = join(home, '.codex');
    mkdirSync(dir, { recursive: true });
    const link = join(dir, 'config.toml');
    const targetA = join(dir, 'real-a.toml');
    const targetB = join(dir, 'real-b.toml');
    const identical = trissConfigWith();
    writeFileSync(targetA, identical);
    writeFileSync(targetB, identical);
    symlinkSync('real-a.toml', link);
    let mutated = false;

    // The retarget happens while the atomic temp file is being written — after
    // the optimistic re-read, so only the CAS precondition can catch it. The
    // new target's bytes are identical to the analyzed ones.
    assert.throws(
      () =>
        migrateCodexToolTimeout({
          path: link,
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
      'the retargeted target must stay byte-for-byte',
    );
    assert.deepEqual(
      readdirSync(dir).sort(),
      ['config.toml', 'real-a.toml', 'real-b.toml'],
      'no leftover temp files',
    );
  });
});

test('SNAPSHOT-03: a symlink retargeted during the FIRST read — before analysis — is a conflict, nothing written', async () => {
  await withTmpHome((home) => {
    const dir = join(home, '.codex');
    mkdirSync(dir, { recursive: true });
    const link = join(dir, 'config.toml');
    const targetA = join(dir, 'real-a.toml');
    const targetB = join(dir, 'real-b.toml');
    const identical = trissConfigWith();
    writeFileSync(targetA, identical);
    writeFileSync(targetB, identical);
    symlinkSync('real-a.toml', link);

    let reads = 0;
    const result = migrateCodexToolTimeout({
      path: link,
      // Deterministic FIRST-read race: the snapshot owns the injected read,
      // so this reader is called with the resolved target. While it reads
      // target A, the symlink is retargeted to an IDENTICAL sibling B before
      // the read returns. The snapshot's post-read recapture must see the
      // resolved target change and fail the migration BEFORE any analysis or
      // write — no second snapshot is ever taken.
      readFile: (p) => {
        reads += 1;
        const content = readFileSync(p, 'utf8');
        unlinkSync(link);
        symlinkSync('real-b.toml', link);
        return content;
      },
    });
    assert.equal(reads, 1, 'only the first (validating) read may happen — no pre-write re-read');
    assert.equal(result.status, 'conflict');
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

// ─── header parse: trailing dot (GLM 5.3 review) ─────────────────────────────
//
// After a dot another key part is MANDATORY in a dotted key list. A header
// body like `mcp_servers.triss.` (trailing dot) must not parse — a scanner
// that silently dropped the trailing dot would treat `[mcp_servers.triss.]`
// as the root header and rewrite a syntactically broken config. These
// header-like lines must be rejected at parse time and the files reported
// malformed, byte-for-byte untouched.

test('PARSE-01: parseHeaderBody rejects a trailing dot — after a dot another key part is mandatory', () => {
  for (const bad of [
    '[mcp_servers.triss.]',
    '["mcp_servers"."triss".]',
    '["mcp_servers.triss".]',
    '[mcp_servers..triss]',
    '[.triss]',
    '[mcp_servers.]',
    '[[mcp_servers.triss.]]',
    '["a".]',
  ]) {
    assert.equal(parseHeaderLine(bad), null, `trailing-dot / broken-dot header must not parse: ${bad}`);
  }
  for (const good of [
    '[mcp_servers.triss]',
    '["mcp_servers"."triss"]',
    '["mcp_servers.triss"]',
    '[[mcp_servers.triss]]',
    '[mcp_servers.triss.env]',
  ]) {
    assert.ok(parseHeaderLine(good), `valid header must parse: ${good}`);
  }
});

test('PARSE-02: component boundaries survive quoting — two-component vs single-component quoted roots', () => {
  // ["mcp_servers"."triss"] and mixed ["mcp_servers".triss] are TWO parts and
  // name the same table as [mcp_servers.triss]; ["mcp_servers.triss"] is ONE
  // part whose literal name contains a dot — a different table. The joined
  // dotted text alone cannot tell these apart; the parts can.
  const texts = (h) => h.parts.map((p) => p.text);
  assert.deepEqual(texts(parseHeaderLine('[mcp_servers.triss]')), ['mcp_servers', 'triss']);
  assert.equal(parseHeaderLine('[mcp_servers.triss]').quoted, false);
  assert.deepEqual(texts(parseHeaderLine('["mcp_servers"."triss"]')), ['mcp_servers', 'triss']);
  assert.equal(parseHeaderLine('["mcp_servers"."triss"]').quoted, true);
  assert.deepEqual(texts(parseHeaderLine('["mcp_servers".triss]')), ['mcp_servers', 'triss']);
  assert.equal(parseHeaderLine('["mcp_servers".triss]').quoted, true);
  assert.deepEqual(texts(parseHeaderLine('["mcp_servers.triss"]')), ['mcp_servers.triss']);
  assert.equal(parseHeaderLine('["mcp_servers.triss"]').parts.length, 1);
  assert.deepEqual(texts(parseHeaderLine('["mcp_servers"."triss"."env"]')), [
    'mcp_servers',
    'triss',
    'env',
  ]);
});

// ─── quoted-key escape decoding (GLM 5.3 review) ─────────────────────────────
//
// A backslash inside a BASIC quoted key is a TOML basic-string escape and must
// be DECODED into the component text, never dropped along with the next
// character: ["mcp\u005Fservers"."triss"] decodes to the same two components
// as ["mcp_servers"."triss"] (semantically the Triss root), while
// ["mcp_servers\u002Etriss"] decodes to ONE component whose literal name
// contains a dot — the same table as ["mcp_servers.triss"], never the
// two-component root. Literal quoted keys (single quotes) never decode
// escapes. Invalid or incomplete escapes must fail closed: the header does
// not parse, the scan reports the file malformed, and no caller rewrites a
// byte of it.

test('PARSE-04: basic quoted keys decode TOML basic-string escapes into their key text', () => {
  const texts = (h) => h.parts.map((p) => p.text);
  // \u005F is underscore: the escaped root decodes to the same two parts as
  // the plain quoted root, in any quoting mix.
  assert.deepEqual(texts(parseHeaderLine('["mcp\\u005Fservers"."triss"]')), [
    'mcp_servers',
    'triss',
  ]);
  assert.deepEqual(texts(parseHeaderLine('["mcp\\u005Fservers".triss]')), [
    'mcp_servers',
    'triss',
  ]);
  assert.equal(parseHeaderLine('["mcp\\u005Fservers".triss]').quoted, true);
  assert.deepEqual(texts(parseHeaderLine('["mcp_servers"."tris\\u0073"]')), [
    'mcp_servers',
    'triss',
  ]);
  // \xHH (TOML 1.1 8-bit escape) and \UHHHHHHHH (32-bit) decode too.
  assert.deepEqual(texts(parseHeaderLine('["mcp\\x5Fservers"."triss"]')), [
    'mcp_servers',
    'triss',
  ]);
  assert.deepEqual(texts(parseHeaderLine('["mcp\\U0000005Fservers"."triss"]')), [
    'mcp_servers',
    'triss',
  ]);
  // A non-BMP scalar decoded via \U lands in the key text as that code point.
  assert.deepEqual(texts(parseHeaderLine('["mcp\\U0001F600"]')), ['mcp\u{1F600}']);
  // Single-character escapes decode to their control / quote / backslash char.
  assert.deepEqual(texts(parseHeaderLine('["a\\tb"]')), ['a\tb']);
  assert.deepEqual(texts(parseHeaderLine('["a\\nb"]')), ['a\nb']);
  assert.deepEqual(texts(parseHeaderLine('["a\\rb"]')), ['a\rb']);
  assert.deepEqual(texts(parseHeaderLine('["a\\bb"]')), ['a\bb']);
  assert.deepEqual(texts(parseHeaderLine('["a\\fb"]')), ['a\fb']);
  // \e is a TOML 1.1 single-character escape (U+001B).
  assert.deepEqual(texts(parseHeaderLine('["a\\eb"]')), ['a\u001bb']);
  // An escaped quote / backslash is content, never a string delimiter.
  assert.deepEqual(texts(parseHeaderLine('["a\\"b"]')), ['a"b']);
  assert.deepEqual(texts(parseHeaderLine('["a\\\\b"]')), ['a\\b']);
  // A bare key that happens to contain a backslash is not valid TOML and
  // still fails closed — only quoted keys may escape.
  assert.equal(parseHeaderLine('[mcp_servers\\u005F.triss]'), null);
});

test('PARSE-05: an escape decoding to a literal dot keeps the key a SINGLE component; literal quotes never decode', () => {
  const texts = (h) => h.parts.map((p) => p.text);
  // \u002E is a literal dot: the whole key is ONE component literally named
  // "mcp_servers.triss" — the same table as ["mcp_servers.triss"], never the
  // two-component Triss root.
  const h = parseHeaderLine('["mcp_servers\\u002Etriss"]');
  assert.deepEqual(texts(h), ['mcp_servers.triss']);
  assert.equal(h.parts.length, 1);
  assert.equal(h.dotted, 'mcp_servers.triss');
  assert.equal(h.quoted, true);
  // Literal quoted keys preserve backslashes verbatim — no decoding.
  const lit = parseHeaderLine("['mcp\\u005Fservers'.'triss']");
  assert.deepEqual(texts(lit), ['mcp\\u005Fservers', 'triss']);
});

test('PARSE-06: invalid or incomplete basic-string escapes fail closed — the header does not parse', () => {
  for (const bad of [
    '["\\q"]', // unknown escape letter
    '["\\u"]', // hex escape with no digits
    '["\\u1"]',
    '["\\u12"]', // truncated 16-bit escape
    '["\\u123"]',
    '["\\u123G"]', // non-hex digit
    '["\\u005G"]',
    '["\\x"]',
    '["\\xG"]',
    '["\\U0000000"]', // truncated 32-bit escape
    '["\\UFFFFFFFF"]', // above U+10FFFF
    '["\\U00110000"]',
    '["\\uD800"]', // surrogate code point
    '["\\uDFFF"]',
    '["\\U0000D800"]',
    '["\\"]', // the escaped quote swallows the closer — string never closes
    '["a\\"]',
    '["mcp\\u005Fservers"."\\q"]', // valid part followed by an invalid one
  ]) {
    assert.equal(parseHeaderLine(bad), null, `invalid escape must not parse: ${bad}`);
  }
});

test('LEXER-31: header-like lines with a trailing dot are malformed and left byte-for-byte untouched', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    for (const input of [
      ['[mcp_servers.triss.]', 'tool_timeout_sec = 120', ''].join('\n'),
      ['["mcp_servers"."triss".]', 'tool_timeout_sec = 120', ''].join('\n'),
      ['[mcp_servers.triss.] # generated by triss', 'tool_timeout_sec = 120', ''].join('\n'),
      ['[mcp_servers.triss]', 'tool_timeout_sec = 120', '[mcp_servers.triss.]', ''].join('\n'),
    ]) {
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'malformed', `for input:\n${input}`);
      assert.equal(
        readFileSync(path, 'utf8'),
        input,
        'a trailing-dot header must never be accepted as the root; config stays byte-for-byte',
      );
    }
  });
});

test('LEXER-32: valid escaped quoted headers scan cleanly; a single escaped root stays outside the narrow migration', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    // ["mcp\u005Fservers"."triss"] decodes to the two-component Triss root —
    // valid TOML, so the file scans clean. It IS a semantic root, so a second
    // semantic root next to it would be ambiguous (see MIGRATE-21), but a
    // single one is never rewritten: the automatic migration is deliberately
    // narrow to the exact BARE header triss generated, so the escaped-quoted
    // root is "absent" and stays byte-for-byte.
    const input = [
      '["mcp\\u005Fservers"."triss"]',
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'absent');
    assert.equal(readFileSync(path, 'utf8'), input, 'escaped-quoted-only config must stay byte-for-byte');
  });
});

test('LEXER-33: invalid escapes in quoted headers are malformed and left byte-for-byte untouched', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    for (const input of [
      ['["\\q"]', 'tool_timeout_sec = 120', ''].join('\n'),
      ['[mcp_servers.triss]', 'tool_timeout_sec = 120', '["mcp\\u005Fservers"."\\u12"]', ''].join('\n'),
      ['["mcp\\u005Fservers"."\\uD800"]', 'tool_timeout_sec = 120', ''].join('\n'),
    ]) {
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'malformed', `for input:\n${input}`);
      assert.equal(
        readFileSync(path, 'utf8'),
        input,
        'an invalid escape in a header must fail closed; config stays byte-for-byte',
      );
    }
  });
});

// ─── container-interior key-looking lines (GLM 5.3 review) ───────────────────
//
// A line that STARTS inside an open square/curly container is VALUE content
// (array elements, inline-table bodies) — never a key assignment of the root
// table. The migration key-hit scan must skip such lines, so a
// container-interior line that merely looks like `tool_timeout_sec = 120` is
// neither counted (toward hits / "ambiguous") nor rewritten.

test('PARSE-03: scanToml records startedInContainer for value lines inside open containers', () => {
  const scan = scanToml(
    [
      '[mcp_servers.triss]',
      'values = [',
      '[1, 2],',
      'tool_timeout_sec = 120',
      ']',
      'tool_timeout_sec = 120',
      '',
    ].join('\n').split('\n'),
  );
  assert.equal(scan.malformed, false);
  assert.ok(scan.lines[0].header, 'the bare root header is parsed at depth zero');
  assert.equal(scan.lines[1].startedInContainer, false, 'the array opener is at depth zero');
  assert.equal(scan.lines[2].startedInContainer, true, '[1, 2], starts inside the open array');
  assert.equal(scan.lines[3].startedInContainer, true, 'tool_timeout_sec = 120 starts inside the open array');
  assert.equal(scan.lines[3].header, null, 'container-interior lines never carry a header');
  assert.equal(scan.lines[4].startedInContainer, true, 'the closer line starts inside the open array');
  assert.equal(scan.lines[5].startedInContainer, false, 'after the closer, depth zero again');
});

test('LEXER-29: container-interior tool_timeout_sec-looking lines are never counted', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      'matrix = [',
      'tool_timeout_sec = 120,',
      'tool_timeout_sec = 120',
      ']',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    // Both 120-looking lines are array element lines inside an open container
    // — value content, never root key assignments. No root key exists, so
    // there is nothing to migrate; the two container-interior lines must NOT
    // count toward hits (that would report "ambiguous" and still leave the
    // bytes untouched, hiding the real reason) — "absent" proves they are
    // never counted.
    assert.equal(result.status, 'absent');
    assert.equal(
      readFileSync(path, 'utf8'),
      input,
      'container-interior lines must never be counted or rewritten',
    );
  });
});

test('LEXER-30: a real root 120 migrates while container-interior tool_timeout_sec-looking lines survive byte-for-byte', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    const input = [
      '[mcp_servers.triss]',
      'command = "triss"',
      'args = ["mcp", "serve"]',
      'matrix = [',
      'tool_timeout_sec = 120,',
      ']',
      'tool_timeout_sec = 120',
      '',
    ].join('\n');
    writeFileSync(path, input);
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'updated');
    const toml = readFileSync(path, 'utf8');
    // The container-interior copy (inside the array) must survive
    // byte-for-byte — only the real root key after the closer may change.
    assert.ok(
      toml.includes('matrix = [\ntool_timeout_sec = 120,\n]'),
      'the container-interior 120 must survive byte-for-byte',
    );
    assert.ok(
      toml.includes(']\ntool_timeout_sec = 5460'),
      'the real root key must migrate to 5460',
    );
    assert.ok(!/tool_timeout_sec = 120\n$/.test(toml), 'the historical root 120 must be gone');
  });
});

// ─── value-token strictness (GLM 5.3 review) ─────────────────────────────────
//
// The migration must fail closed on strict-TOML-invalid (or non-canonical)
// value spellings instead of normalizing them: `+120` and `0120` both
// Number()-normalize to 120 today and would be rewritten, and an assignment
// line with MULTIPLE adjacent value expressions/tokens is not a single
// key-value pair. Only the canonical decimal spelling (`0` / [1-9]\d*, no
// sign, no leading zeros, no underscores) that triss itself writes may ever
// be rewritten; everything else is a custom value the migration leaves
// byte-for-byte untouched. Nearby VALID controls must keep migrating.

test('MIGRATE-23: non-canonical integer spellings (+120 / 0120) are never rewritten, valid controls still migrate', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    // Every non-canonical spelling must be left byte-for-byte, never
    // Number()-normalized into a rewrite.
    for (const line of [
      'tool_timeout_sec = +120',
      'tool_timeout_sec = 0120',
      'tool_timeout_sec = +120 # legacy cap',
      'tool_timeout_sec = 0120 # legacy cap',
      'tool_timeout_sec = 0',
    ]) {
      const input = trissConfigWith(line);
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'custom', `for line: ${line}`);
      assert.equal(
        readFileSync(path, 'utf8'),
        input,
        `for line: ${line} — non-canonical spelling must stay byte-for-byte`,
      );
    }
    // Nearby valid controls: the canonical spelling still migrates.
    for (const [line, expected] of [
      ['tool_timeout_sec = 120', 'tool_timeout_sec = 5460'],
      ['tool_timeout_sec = 120 # legacy cap', 'tool_timeout_sec = 5460 # legacy cap'],
    ]) {
      writeFileSync(path, trissConfigWith(line));
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'updated', `for line: ${line}`);
      assert.ok(
        readFileSync(path, 'utf8').includes(expected),
        `for line: ${line} — the canonical spelling must migrate to ${expected}`,
      );
    }
  });
});

test('MIGRATE-24: an assignment line with multiple adjacent value expressions/tokens is never rewritten', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    // A TOML key-value line is exactly one `key = value` pair; a second
    // value expression/token on the same line is not a single assignment and
    // must never be half-rewritten (the first token alone is not the value).
    for (const line of [
      'tool_timeout_sec = 120 120',
      'tool_timeout_sec = 120 "extra"',
      'tool_timeout_sec = 120 = 120',
      'tool_timeout_sec = 120, 120',
      'tool_timeout_sec = 120 5460',
    ]) {
      const input = trissConfigWith(line);
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'custom', `for line: ${line}`);
      assert.equal(
        readFileSync(path, 'utf8'),
        input,
        `for line: ${line} — a multi-token assignment line must stay byte-for-byte`,
      );
    }
    // Nearby valid control: the canonical single assignment still migrates.
    writeFileSync(path, trissConfigWith('tool_timeout_sec = 120'));
    const result = migrateCodexToolTimeout({ path });
    assert.equal(result.status, 'updated');
    assert.match(readFileSync(path, 'utf8'), /tool_timeout_sec = 5460/);
  });
});

// ─── basic-string escape validation (GLM 5.3 review) ─────────────────────────
//
// TOML basic strings (single-line and multi-line) only allow the escape set
// \b \t \n \f \r \" \\ \e \uHHHH \UHHHHHHHH \xHH plus the multi-line
// line-ending backslash. An invalid escape — \q, an incomplete fixed-width
// hex escape, a surrogate/out-of-range codepoint — makes the whole config
// lexically invalid, so the scanner must report `malformed` and leave every
// byte untouched instead of rewriting the 120 next to a broken string. Literal
// strings never process escapes, so a backslash there is plain content.
// Nearby VALID escapes (and line-ending backslashes) must keep scanning
// cleanly and the exact-120 migration must still run.

test('LEXER-34: an invalid escape in a single-line basic value string is conservative — malformed, untouched', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    for (const badLine of [
      'model = "bad\\qescape"',
      'note = "incomplete \\u12 escape"',
      'note = "incomplete \\x4 escape"',
      'note = "invalid \\U00110000 escape"',
      'note = "surrogate \\uD800 escape"',
    ]) {
      const input = [
        '[mcp_servers.triss]',
        'command = "triss"',
        'args = ["mcp", "serve"]',
        'tool_timeout_sec = 120',
        badLine,
        '',
      ].join('\n');
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'malformed', `for line: ${badLine}`);
      assert.equal(
        readFileSync(path, 'utf8'),
        input,
        `for line: ${badLine} — a config with an invalid escape must stay byte-for-byte`,
      );
    }
  });
});

test('LEXER-35: valid single-line basic-string escapes keep scanning cleanly and the 120 still migrates', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    for (const okLine of [
      'note = "tab\\tseparated"',
      'note = "unicode \\u0041"',
      'note = "8-bit \\x41"',
      'note = "escape \\e char"',
      'note = "quoted \\"inside\\""',
      "note = 'literal backslash \\q is content'",
    ]) {
      const input = [
        '[mcp_servers.triss]',
        'command = "triss"',
        'args = ["mcp", "serve"]',
        'tool_timeout_sec = 120',
        okLine,
        '',
      ].join('\n');
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'updated', `for line: ${okLine}`);
      const toml = readFileSync(path, 'utf8');
      assert.match(toml, /tool_timeout_sec = 5460/);
      assert.ok(toml.includes(okLine), `for line: ${okLine} — valid string must survive byte-for-byte`);
    }
  });
});

test('LEXER-36: an invalid escape in a multi-line basic string is conservative — malformed, untouched', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    for (const input of [
      // Same-line open+close multi-line basic string with an invalid escape.
      [
        '[mcp_servers.triss]',
        'tool_timeout_sec = 120',
        'msg = """bad\\q inside"""',
        '',
      ].join('\n'),
      // Cross-line multi-line basic string with an invalid escape inside.
      [
        '[mcp_servers.triss]',
        'tool_timeout_sec = 120',
        'msg = """',
        'bad \\q inside',
        '"""',
        '',
      ].join('\n'),
    ]) {
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'malformed', `for input:\n${input}`);
      assert.equal(
        readFileSync(path, 'utf8'),
        input,
        'a config with an invalid multi-line escape must stay byte-for-byte',
      );
    }
  });
});

test('LEXER-37: valid multi-line basic-string escapes and line-ending backslashes keep the 120 migrating', async () => {
  await withTmpHome((home) => {
    const path = codexConfig(home);
    for (const input of [
      // Same-line multi-line string with a valid escape.
      [
        '[mcp_servers.triss]',
        'command = "triss"',
        'tool_timeout_sec = 120',
        'msg = """valid\\t tab"""',
        '',
      ].join('\n'),
      // Cross-line multi-line string ending with a line-ending backslash.
      [
        '[mcp_servers.triss]',
        'command = "triss"',
        'tool_timeout_sec = 120',
        'msg = """line ending\\',
        'continuation"""',
        '',
      ].join('\n'),
    ]) {
      writeFileSync(path, input);
      const result = migrateCodexToolTimeout({ path });
      assert.equal(result.status, 'updated', `for input:\n${input}`);
      const toml = readFileSync(path, 'utf8');
      assert.match(toml, /tool_timeout_sec = 5460/);
      assert.ok(!/tool_timeout_sec = 120/.test(toml), 'the historical 120 must be gone');
    }
  });
});

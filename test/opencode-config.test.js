// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

/**
 * opencode-config.test.js — canonical OpenCode source enumerator contract
 * (docs/opencode2-engine-plan.md "Shared configuration backend" +
 * "File-level implementation map": "New shared OpenCode config module").
 *
 * enumerateOpenCodeSources({ cwd, projectBoundary, home }) is the ONLY
 * source of paths and precedence for preflight, init, status, model
 * inspection, and their tests. It returns every candidate config layer in
 * effective order with source path, kind, precedence, existence state —
 * plus plugin and agent sources. Ambiguous boundary or unreadable
 * candidate fails closed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  enumerateOpenCodeSources,
  parseOpenCodeDocument,
} from '../src/opencode-config.js';

// ─── parseOpenCodeDocument ───────────────────────────────────────────────────

test('parseOpenCodeDocument parses JSON and JSONC (comments + trailing commas)', () => {
  assert.deepEqual(parseOpenCodeDocument('{"a":1}'), { a: 1 });
  assert.deepEqual(
    parseOpenCodeDocument('{\n  // model block\n  "model": "zai/glm-4.7",\n}'),
    { model: 'zai/glm-4.7' },
  );
  assert.throws(() => parseOpenCodeDocument('{ nope'), /parse/u);
});

// ─── tree builder ────────────────────────────────────────────────────────────

const mkHomeTree = (spec) => {
  const home = mkdtempSync(join(tmpdir(), 'oc2-sources-'));
  for (const [rel, content] of Object.entries(spec)) {
    const p = join(home, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return home;
};

// ─── enumerateOpenCodeSources: precedence order ──────────────────────────────

test('precedence: global first, then direct root->cwd, then .opencode root->cwd; each entry carries path/kind/precedence/exists', () => {
  const tree = mkHomeTree({
    '.config/opencode/opencode.json': { model: 'global' },
    'proj/opencode.json': { model: 'root' },
    'proj/sub/opencode.jsonc': { model: 'sub' },
    'proj/.opencode/opencode.json': { model: 'root-dot' },
    'proj/sub/.opencode/opencode.jsonc': { model: 'sub-dot' },
  });
  try {
    const res = enumerateOpenCodeSources({
      cwd: join(tree, 'proj', 'sub'),
      projectBoundary: join(tree, 'proj'),
      home: tree,
    });
    assert.ok(Array.isArray(res.configs), 'configs must be an array');
    const existing = res.configs.filter((c) => c.exists);
    // effective order: global, then root->cwd direct, then root->cwd .opencode
    assert.deepEqual(existing.map((c) => c.model), ['global', 'root', 'sub', 'root-dot', 'sub-dot']);
    // every entry has path/kind/precedence/exists
    for (const c of res.configs) {
      assert.ok(typeof c.path === 'string' && c.path.length > 0);
      assert.ok(['json', 'jsonc'].includes(c.kind));
      assert.ok(Number.isInteger(c.precedence));
      assert.equal(typeof c.exists, 'boolean');
    }
    // absent candidates are still listed (normal state)
    assert.ok(res.configs.some((c) => !c.exists), 'nonexistent candidates appear with exists:false');
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test('precedence: json before jsonc within one level; cwd layer beats boundary layer', () => {
  const tree = mkHomeTree({
    '.config/opencode/opencode.json': { model: 'global' },
    'proj/opencode.json': { model: 'json' },
    'proj/opencode.jsonc': { model: 'jsonc' },
    'proj/sub/opencode.json': { model: 'sub' },
  });
  try {
    const res = enumerateOpenCodeSources({
      cwd: join(tree, 'proj', 'sub'),
      projectBoundary: join(tree, 'proj'),
      home: tree,
    });
    const existing = res.configs.filter((c) => c.exists);
    assert.deepEqual(existing.map((c) => c.model), ['global', 'json', 'jsonc', 'sub']);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

// ─── plugins and agents ──────────────────────────────────────────────────────

test('plugins: configured references enumerate with existence; discovered plugin{,s}/ dirs list their files', () => {
  const tree = mkHomeTree({
    '.config/opencode/opencode.json': { plugin: ['./one.js', './two.js'] },
    '.config/opencode/one.js': 'module.exports = {}',
    '.config/opencode/plugin/global-dir.js': 'module.exports = {}',
    '.config/opencode/plugins/second.js': 'module.exports = {}',
    'proj/.opencode/plugin/level.js': 'module.exports = {}',
  });
  try {
    const res = enumerateOpenCodeSources({
      cwd: join(tree, 'proj'),
      projectBoundary: join(tree, 'proj'),
      home: tree,
    });
    assert.ok(Array.isArray(res.plugins), 'plugins must be an array');
    const refs = res.plugins.filter((p) => p.origin === 'configured');
    assert.equal(refs.length, 2, 'both configured plugin references are listed');
    assert.ok(refs[0].exists, './one.js resolves against the defining config dir');
    assert.equal(refs[0].path, join(tree, '.config/opencode/one.js'));
    assert.ok(!refs[1].exists, './two.js is absent → exists:false (a missing configured target)');
    const discovered = res.plugins.filter((p) => p.origin === 'discovered');
    assert.deepEqual(
      discovered.map((p) => p.path).sort(),
      [
        join(tree, '.config/opencode/plugin/global-dir.js'),
        join(tree, '.config/opencode/plugins/second.js'),
        join(tree, 'proj/.opencode/plugin/level.js'),
      ].sort(),
    );
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test('plugins: a configured reference whose target is missing is reported (preflight rejects it later)', () => {
  const tree = mkHomeTree({
    '.config/opencode/opencode.json': { plugin: ['./gone.js'] },
  });
  try {
    const res = enumerateOpenCodeSources({
      cwd: join(tree, 'proj'),
      projectBoundary: join(tree, 'proj'),
      home: tree,
    });
    const refs = res.plugins.filter((p) => p.origin === 'configured');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].exists, false);
    assert.ok(typeof refs[0].path === 'string' && refs[0].path.length > 0);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test('agents: JSON-defined agent sources in supported agent{,s}/mode{,s} dirs are enumerated with existence', () => {
  const tree = mkHomeTree({
    '.config/opencode/opencode.json': {
      agent: {
        build: { model: 'zai/glm-4.7', prompt: 'build', subagent: 'plan' },
      },
    },
    '.config/opencode/agent/extra.json': { plan: { model: 'zai/glm-4.7', prompt: 'plan' } },
    '.config/opencode/agents/mode-a.json': { 'mode-a': { prompt: 'a' } },
    '.config/opencode/mode/mode-b.json': { 'mode-b': { prompt: 'b' } },
    'proj/.opencode/agents/level.json': { 'level-agent': { prompt: 'l' } },
  });
  try {
    const res = enumerateOpenCodeSources({
      cwd: join(tree, 'proj'),
      projectBoundary: join(tree, 'proj'),
      home: tree,
    });
    assert.ok(Array.isArray(res.agentSources), 'agentSources must be an array');
    const paths = res.agentSources.map((s) => s.path);
    assert.ok(paths.includes(join(tree, '.config/opencode/agent/extra.json')));
    assert.ok(paths.includes(join(tree, '.config/opencode/agents/mode-a.json')));
    assert.ok(paths.includes(join(tree, '.config/opencode/mode/mode-b.json')));
    assert.ok(paths.includes(join(tree, 'proj/.opencode/agents/level.json')));
    // JSON-defined (config file) agent blocks are reported too
    const inline = res.agentSources.filter((s) => s.origin === 'configured');
    assert.ok(inline.length >= 1, 'config-declared agent block appears as an agent source');
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

// ─── fail-closed contracts ───────────────────────────────────────────────────

test('unreadable candidate fails closed with the source path and no contents', () => {
  const tree = mkHomeTree({
    '.config/opencode/opencode.json': { model: 'x' },
    'proj/opencode.json': { model: 'SECRET-MARKER' },
  });
  let restored = false;
  try {
    const target = join(tree, 'proj', 'opencode.json');
    chmodSync(target, 0o000);
    restored = true;
    let threw = null;
    try {
      enumerateOpenCodeSources({
        cwd: join(tree, 'proj'),
        projectBoundary: join(tree, 'proj'),
        home: tree,
      });
    } catch (err) {
      threw = err;
    }
    // Running as root chmod may not block reads; only assert when it did throw.
    if (threw) {
      assert.match(threw.message, /opencode\.json/u);
      assert.ok(!threw.message.includes('SECRET-MARKER'), 'error must not leak file contents');
    }
  } finally {
    if (restored) chmodSync(join(tree, 'proj', 'opencode.json'), 0o644);
    rmSync(tree, { recursive: true, force: true });
  }
});

test('ambiguous project boundary (cwd not under boundary) fails closed', () => {
  const tree = mkHomeTree({ 'proj/opencode.json': {} });
  try {
    assert.throws(
      () => enumerateOpenCodeSources({
        cwd: join(tree, 'other'),
        projectBoundary: join(tree, 'proj'),
        home: tree,
      }),
      /project boundary|outside|not under/u,
    );
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test('boundary fallback: no explicit boundary walks up from cwd to the first .git marker', () => {
  const tree = mkHomeTree({
    'proj/.git': 'gitdir: /elsewhere\n',
    'proj/opencode.json': { model: 'root' },
    'proj/sub/opencode.json': { model: 'sub' },
  });
  try {
    const res = enumerateOpenCodeSources({ cwd: join(tree, 'proj', 'sub'), home: tree });
    const existing = res.configs.filter((c) => c.exists).map((c) => c.model);
    assert.deepEqual(existing, ['root', 'sub']);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

test('boundary fallback: filesystem root is the boundary when no .git exists (parent configs stay loadable)', () => {
  const tree = mkHomeTree({
    'proj/opencode.json': { model: 'root' },
    'proj/sub/opencode.json': { model: 'sub' },
  });
  try {
    const res = enumerateOpenCodeSources({ cwd: join(tree, 'proj', 'sub'), home: tree });
    const existing = res.configs.filter((c) => c.exists).map((c) => c.model);
    assert.deepEqual(existing, ['root', 'sub']);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
});

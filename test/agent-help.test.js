// test/agent-help.test.js — covers `triss agent-help`
//
// Contract:
//   - prints the FULL cookbook (long form) to stdout
//   - injects integration agentInstructions when env vars are set
//   - --target codex switches templates and headings
//
// The nano init contract is in test/init.test.js (INIT-07 / INIT-CODEX-04).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TRISS_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'triss.js');

function captureStdout(fn) {
  const captured = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (...args) => {
    captured.push(typeof args[0] === 'string' ? args[0] : args[0].toString());
    return true;
  };
  return Promise.resolve(fn())
    .finally(() => {
      process.stdout.write = orig;
    })
    .then(() => captured.join(''));
}

test('AGENT-HELP-01: prints full cookbook by default (CLI examples present)', async () => {
  const { runAgentHelp } = await import('../src/commands/agent-help.js');
  const out = await captureStdout(() => runAgentHelp({}));

  assert.ok(out.includes('triss ask'), 'full cookbook should include CLI examples like `triss ask`');
  assert.ok(out.includes('triss review'), 'full cookbook should describe `triss review`');
  assert.ok(out.includes('triss exec'), 'full cookbook should describe `triss exec`');
  assert.ok(out.includes('--format evidence'), 'full cookbook should describe evidence mode');
  assert.ok(
    out.includes('omit `--max-tokens`') && out.includes('at least 16384'),
    'full cookbook should recommend GLM auto-budget and the explicit minimum',
  );
  assert.ok(out.includes('When NOT to delegate'), 'full cookbook should include policy section');
});

test('AGENT-HELP-02: --target codex switches headings to AGENTS.md style', async () => {
  const { runAgentHelp } = await import('../src/commands/agent-help.js');
  const out = await captureStdout(() => runAgentHelp({ target: 'codex' }));

  // codex template uses `# Triss …` (h1) instead of `## Triss …` (h2)
  assert.ok(out.startsWith('# Triss'), `codex flavour should start with h1, got: ${out.slice(0, 30)}`);
  assert.ok(out.includes('triss ask'), 'codex full cookbook should also include CLI examples');
  assert.ok(out.includes('triss exec'), 'codex cookbook should describe `triss exec`');
  assert.ok(out.includes('--format evidence'), 'codex cookbook should describe evidence mode');
  assert.ok(
    out.includes('omit `--max-tokens`') && out.includes('at least 16384'),
    'codex cookbook should recommend GLM auto-budget and the explicit minimum',
  );
});

test('AGENT-HELP-03: integrations are injected into full output when env vars set', async () => {
  // Run from a temp cwd so a project-local .triss.env (e.g. for the live
  // Linear integration test) cannot reintroduce LINEAR_API_KEY via getConfig().
  const origCwd = process.cwd();
  const tempCwd = realpathSync(mkdtempSync(join(tmpdir(), 'triss-agent-help-')));

  const origAtlBase = process.env.ATLASSIAN_BASE_URL;
  const origAtlEmail = process.env.ATLASSIAN_EMAIL;
  const origAtlToken = process.env.ATLASSIAN_API_TOKEN;
  const origLinearKey = process.env.LINEAR_API_KEY;

  process.env.ATLASSIAN_BASE_URL = 'https://example.atlassian.net';
  process.env.ATLASSIAN_EMAIL = 'test@example.com';
  process.env.ATLASSIAN_API_TOKEN = 'test-token-abc';
  delete process.env.LINEAR_API_KEY;

  try {
    process.chdir(tempCwd);
    const { runAgentHelp } = await import('../src/commands/agent-help.js');
    const out = await captureStdout(() => runAgentHelp({}));

    assert.ok(!out.includes('{{INTEGRATIONS}}'), 'placeholder should be replaced');
    assert.ok(
      out.includes('triss jira') || out.includes('Jira'),
      'agent-help should inline jira instructions when ATLASSIAN_* creds are present',
    );
    assert.ok(
      !out.includes('triss linear'),
      'linear instructions should not appear when LINEAR_API_KEY is missing',
    );
  } finally {
    process.chdir(origCwd);
    rmSync(tempCwd, { recursive: true, force: true });
    if (origAtlBase !== undefined) process.env.ATLASSIAN_BASE_URL = origAtlBase;
    else delete process.env.ATLASSIAN_BASE_URL;
    if (origAtlEmail !== undefined) process.env.ATLASSIAN_EMAIL = origAtlEmail;
    else delete process.env.ATLASSIAN_EMAIL;
    if (origAtlToken !== undefined) process.env.ATLASSIAN_API_TOKEN = origAtlToken;
    else delete process.env.ATLASSIAN_API_TOKEN;
    if (origLinearKey !== undefined) process.env.LINEAR_API_KEY = origLinearKey;
  }
});

test('AGENT-HELP-04: unknown target throws a clear error', async () => {
  const { runAgentHelp } = await import('../src/commands/agent-help.js');
  await assert.rejects(() => runAgentHelp({ target: 'xyz' }), /Unknown --target.*xyz/);
});

test('AGENT-HELP-06: integrations are detected when creds live in ~/.config/triss/.env (not exported)', () => {
  // Regression guard: envReadiness() only checks process.env, so renderTemplate
  // must call loadEnvFiles() first or integrations whose creds live only in the
  // wizard-installed env file won't show up in the cookbook.
  //
  // We run the CLI in a subprocess with a clean env so the global env
  // path (join(homedir(), '.config', 'triss', '.env') in src/secrets.js,
  // resolved lazily via getEnvFilePath) resolves relative to the temp
  // HOME we set up.
  const homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-home-envfile-')));
  try {
    const trissEnvDir = join(homeDir, '.config', 'triss');
    mkdirSync(trissEnvDir, { recursive: true });
    writeFileSync(
      join(trissEnvDir, '.env'),
      'ATLASSIAN_BASE_URL=https://example.atlassian.net\n' +
        'ATLASSIAN_EMAIL=test@example.com\n' +
        'ATLASSIAN_API_TOKEN=test-token-abc\n',
    );

    const r = spawnSync(process.execPath, [TRISS_BIN, 'agent-help'], {
      env: { HOME: homeDir, PATH: process.env.PATH || '' },
      encoding: 'utf8',
    });

    assert.equal(r.status, 0, `agent-help exited ${r.status}: ${r.stderr}`);
    assert.ok(
      r.stdout.includes('Integrations enabled for this project'),
      'agent-help must include integration sections when creds live in ~/.config/triss/.env',
    );
    assert.ok(
      r.stdout.includes('triss jira'),
      'jira instructions must appear when ATLASSIAN_* are set via env file',
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test('AGENT-HELP-05: MCP-hint blockquote appears when mcpServers.triss is registered', async () => {
  const homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-home-')));
  const origHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(
      join(homeDir, '.claude.json'),
      JSON.stringify({ mcpServers: { triss: { command: 'triss', args: ['mcp', 'serve'] } } }) + '\n',
    );

    const { runAgentHelp } = await import('../src/commands/agent-help.js');
    const out = await captureStdout(() => runAgentHelp({}));

    assert.ok(
      out.includes('Triss is also available as MCP tools'),
      'agent-help should prepend the MCP-hint blockquote when MCP is registered',
    );
  } finally {
    if (origHome !== undefined) process.env.HOME = origHome;
    rmSync(homeDir, { recursive: true, force: true });
  }
});


test('AGENT-HELP-07: both full cookbooks teach the one-host/one-coder workflow contract', async () => {
  const { runAgentHelp } = await import('../src/commands/agent-help.js');
  // Collapse line wrapping in the rendered cookbook — prose assertions check
  // exact words in order, not where the template happened to wrap a line.
  const flat = (s) => s.replace(/\s+/g, ' ');
  for (const target of ['claude', 'codex']) {
    const out = flat(await captureStdout(() => runAgentHelp({ target })));

    assert.ok(out.includes('Recommended host-agent workflow'), `${target} full cookbook needs the workflow section`);
    assert.ok(out.includes('Core workflow'), `${target} full cookbook needs a Core workflow section`);
    assert.ok(
      out.includes('one coder in charge') || out.includes('one coder owns'),
      `${target} full cookbook must state the one-host/one-coder default`,
    );
    assert.ok(
      out.includes('repository investigation, implementation, tests, debugging, and self-verification'),
      `${target} full cookbook must assign repository research, implementation, tests, debugging, and self-verification to the coder`,
    );
    assert.ok(
      out.includes('Independent diff review') && out.includes('security-sensitive'),
      `${target} full cookbook must make review use risk-based`,
    );
    assert.ok(
      out.includes('independently executable') && out.includes('explicit merge or handoff boundary'),
      `${target} full cookbook must allow parallelism only for independent workstreams with explicit boundaries`,
    );
    assert.ok(
      out.includes('task packet') && out.includes('fresh run without intentional session reuse'),
      `${target} full cookbook must prefer fresh explicit task packets`,
    );
    assert.ok(
      out.includes('final acceptance') && out.includes('inspect the actual diff'),
      `${target} full cookbook must reserve final acceptance to the host after inspecting the actual diff`,
    );
    assert.ok(
      out.includes('git -C "$worktree" status --short') && out.includes('diff --cached'),
      `${target} full cookbook must inspect staged and unstaged state in the retained worktree`,
    );
    assert.ok(
      out.includes('not browser automation'),
      `${target} full cookbook must not claim browser automation for triss fetch`,
    );
    assert.ok(
      out.includes('Approval boundaries: no commit, push, deploy, external write, or destructive action'),
      `${target} full cookbook task packet must unconditionally forbid commit (no host-authorized escape hatch)`,
    );
    assert.ok(
      out.includes('no retained deliverable'),
      `${target} full cookbook checklist must treat a null worktree plus empty run_files_changed as no retained deliverable`,
    );
    assert.ok(
      out.includes('files_changed` on the `opencode2` beta'),
      `${target} full cookbook checklist must also accept the opencode2 no-deliverable form (files_changed)`,
    );
    assert.ok(
      out.includes('older envelope'),
      `${target} full cookbook must note the opencode2 beta returns the older envelope without Release A fields`,
    );
  }
});

test('AGENT-HELP-08: task packets are complete and acceptance fences stay in the list item', () => {
  const repoRoot = resolve(dirname(TRISS_BIN), '..');
  const read = (file) => readFileSync(join(repoRoot, file), 'utf8');
  const packetFiles = ['README.md', 'templates/claude-full.md', 'templates/codex-full.md'];
  for (const file of packetFiles) {
    const content = read(file);
    const packet = content.match(/triss coder run --stdin --isolate <<'TASK'\n([\s\S]*?)\nTASK\n```/);
    assert.ok(packet, `${file} must include the copy-paste task-packet heredoc`);
    assert.match(
      packet[1],
      /Relevant context\n- Known entry points, related files, prior findings, errors, or reference behavior\.\n- Include only context needed for this task; let the coder inspect the repository for the rest\.\n\nSuccess criteria/,
      `${file} task packet must include Relevant context before Success criteria`,
    );
  }
  const acceptanceFences = ['templates/claude-full.md', 'templates/codex-full.md'].map((file) => {
    const content = read(file);
    const checklist = content.slice(content.indexOf('### Final acceptance checklist'));
    const fence = checklist.match(/\n {2}```bash\n([\s\S]*?)\n {2}```\n\n {2}Isolation worktrees/);

    assert.ok(fence, `${file} must indent the acceptance fence and following base note inside the list item`);
    assert.doesNotMatch(
      checklist,
      /\n```bash\n(?:git -C "\$worktree" [^\n]*\n){4}/,
      `${file} must not split the list item with a column-0 fence`,
    );
    return fence[0];
  });

  assert.equal(
    acceptanceFences[0],
    acceptanceFences[1],
    'Claude and Codex acceptance checklist fences must remain semantically identical',
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── Env helpers ─────────────────────────────────────────────────────────────

const _origToken = process.env.GITLAB_TOKEN;
const _origUrl   = process.env.GITLAB_URL;

function setEnv(overrides = {}) {
  process.env.GITLAB_TOKEN = 'glpat-TEST';
  delete process.env.GITLAB_URL;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

function restoreEnv() {
  if (_origToken === undefined) {
    delete process.env.GITLAB_TOKEN;
  } else {
    process.env.GITLAB_TOKEN = _origToken;
  }
  if (_origUrl === undefined) {
    delete process.env.GITLAB_URL;
  } else {
    process.env.GITLAB_URL = _origUrl;
  }
}

// ─── Fetch mock helper ────────────────────────────────────────────────────────

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const result = await handler(url, init);
    const body =
      typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
    return {
      ok: (result.status ?? 200) < 400,
      status: result.status ?? 200,
      statusText: result.statusText ?? 'OK',
      text: async () => body,
    };
  };
  return calls;
}

// Helper: run a git command inside a specific directory using spawnSync (no shell).
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

// ─── GL-01: search without project hits /issues?search=, with project hits /projects/encoded/issues ──

test('GL-01: gitlab.search hits /issues?search= when no projectPath, /projects/{encoded}/issues when given one', async () => {
  setEnv();

  const calls = mockFetch(() => ({ body: [{ iid: 1, title: 'Bug' }] }));

  const { gitlab } = await import(
    `../src/integrations/gitlab/client.js?gl-01-${Date.now()}`
  );

  // Without projectPath → cross-project endpoint
  await gitlab.search({ search: 'bug' });
  assert.equal(calls.length, 1);
  const globalUrl = new URL(calls[0].url);
  assert.ok(
    globalUrl.pathname === '/api/v4/issues',
    `Expected /api/v4/issues but got ${globalUrl.pathname}`,
  );
  assert.equal(globalUrl.searchParams.get('search'), 'bug');

  // With projectPath → per-project endpoint
  await gitlab.search({ projectPath: 'foo/bar', search: 'bug' });
  assert.equal(calls.length, 2);
  const projUrl = new URL(calls[1].url);
  assert.ok(
    projUrl.pathname.startsWith('/api/v4/projects/'),
    `Expected /api/v4/projects/... but got ${projUrl.pathname}`,
  );
  assert.ok(
    projUrl.pathname.endsWith('/issues'),
    `Expected path to end with /issues: ${projUrl.pathname}`,
  );

  // Authorization header must be Bearer
  assert.equal(calls[0].init.headers.Authorization, 'Bearer glpat-TEST');

  restoreEnv();
});

// ─── GL-02: project path is URL-encoded ──────────────────────────────────────

test('GL-02: gitlab encodes slashes in project path (foo/bar → foo%2Fbar)', async () => {
  setEnv();
  const calls = mockFetch(() => ({ body: [{ iid: 5, title: 'Test' }] }));

  const { gitlab } = await import(
    `../src/integrations/gitlab/client.js?gl-02-${Date.now()}`
  );

  await gitlab.search({ projectPath: 'foo/bar', search: 'test' });

  assert.equal(calls.length, 1);
  const { url } = calls[0];
  // The raw URL string must contain the percent-encoded form
  assert.ok(
    url.includes('foo%2Fbar'),
    `Expected foo%2Fbar in URL but got: ${url}`,
  );
  assert.ok(
    !url.includes('/foo/bar/issues'),
    `URL must not contain un-encoded path segment: ${url}`,
  );

  restoreEnv();
});

// ─── GL-03: createIssue sends correct body, with optional labels ──────────────

test('GL-03: gitlab.createIssue sends correct body including optional labels', async () => {
  setEnv();
  const calls = mockFetch(() => ({
    body: { iid: 7, title: 'New Issue', web_url: 'https://gitlab.com/ns/proj/-/issues/7' },
  }));

  const { gitlab } = await import(
    `../src/integrations/gitlab/client.js?gl-03-${Date.now()}`
  );

  const issue = await gitlab.createIssue('ns/proj', {
    title: 'New Issue',
    description: 'Some body',
    labels: 'bug,enhancement',
  });

  assert.equal(calls.length, 1);
  const { url, init } = calls[0];

  // Correct endpoint
  assert.ok(url.includes('/issues'), `Expected /issues in URL: ${url}`);
  assert.ok(url.includes('ns%2Fproj'), `Expected encoded namespace in URL: ${url}`);
  assert.equal(init.method, 'POST');

  // Body fields
  const sent = JSON.parse(init.body);
  assert.equal(sent.title, 'New Issue');
  assert.equal(sent.description, 'Some body');
  assert.equal(sent.labels, 'bug,enhancement');

  // Returned data passes through
  assert.equal(issue.iid, 7);

  restoreEnv();
});

// ─── GL-04: updateIssue maps state_event='close' correctly ────────────────────

test('GL-04: gitlab.updateIssue forwards state_event=close in the request body', async () => {
  setEnv();
  const calls = mockFetch(() => ({
    body: { iid: 3, state: 'closed' },
  }));

  const { gitlab } = await import(
    `../src/integrations/gitlab/client.js?gl-04-${Date.now()}`
  );

  // The GitLab API uses state_event='close' to close an issue.
  // updateIssue is a thin wrapper that forwards the fields object as-is.
  await gitlab.updateIssue('ns/proj', 3, { state_event: 'close' });

  assert.equal(calls.length, 1);
  const { init } = calls[0];

  assert.equal(init.method, 'PUT');
  const sent = JSON.parse(init.body);
  assert.equal(sent.state_event, 'close', 'state_event must be forwarded as-is');

  restoreEnv();
});

// ─── GL-05: detectProject parses SSH and HTTPS git origins ───────────────────

test('GL-05: detectProject parses SSH (git@gitlab.com:foo/bar.git) and HTTPS (https://gitlab.com/foo/bar) origins', async () => {
  // Create a temporary git repo with an SSH origin
  const sshDir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-gl-ssh-')));
  git(['init'], sshDir);
  git(['remote', 'add', 'origin', 'git@gitlab.com:myorg/myrepo.git'], sshDir);

  // Create a temporary git repo with an HTTPS origin
  const httpsDir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-gl-https-')));
  git(['init'], httpsDir);
  git(['remote', 'add', 'origin', 'https://gitlab.com/myorg/myrepo'], httpsDir);

  // Create a repo with a non-GitLab origin (should return null)
  const otherDir = realpathSync(mkdtempSync(join(tmpdir(), 'triss-gl-other-')));
  git(['init'], otherDir);
  git(['remote', 'add', 'origin', 'git@github.com:myorg/myrepo.git'], otherDir);

  const orig = process.cwd();
  const { detectProject } = await import(
    `../src/integrations/gitlab/client.js?gl-05-${Date.now()}`
  );

  try {
    // SSH origin
    process.chdir(sshDir);
    const sshResult = detectProject();
    assert.equal(sshResult, 'myorg/myrepo', `SSH: expected myorg/myrepo but got ${sshResult}`);

    // HTTPS origin
    process.chdir(httpsDir);
    const httpsResult = detectProject();
    assert.equal(
      httpsResult,
      'myorg/myrepo',
      `HTTPS: expected myorg/myrepo but got ${httpsResult}`,
    );

    // Non-GitLab origin → null
    process.chdir(otherDir);
    const otherResult = detectProject();
    assert.equal(otherResult, null, 'Non-gitlab origin must return null');
  } finally {
    process.chdir(orig);
  }
});

// ─── GL-06: resolveProject throws when no origin + no flag ───────────────────

test('GL-06: gitlab.resolveProject throws when no origin remote and no explicit flag', async () => {
  const { resolveProject } = await import(
    `../src/integrations/gitlab/client.js?gl-06-${Date.now()}`
  );

  // Run from a directory with no git config (OS root has no .git)
  const orig = process.cwd();
  process.chdir('/');
  try {
    assert.throws(
      () => resolveProject(undefined),
      /auto-detect.*GitLab|Could not auto-detect/i,
    );
  } finally {
    process.chdir(orig);
  }

  // Explicit value is returned untouched
  assert.equal(resolveProject('owner/name'), 'owner/name');
});

// ─── GITLAB_URL env override ──────────────────────────────────────────────────

test('GITLAB_URL env override changes the API base URL', async () => {
  setEnv({ GITLAB_URL: 'https://mygitlab.example.com' });

  const calls = mockFetch(() => ({ body: [{ iid: 1, title: 'T' }] }));

  const { gitlab } = await import(
    `../src/integrations/gitlab/client.js?gl-url-override-${Date.now()}`
  );

  await gitlab.search({ search: 'test' });

  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].url.startsWith('https://mygitlab.example.com'),
    `Expected custom base URL, got: ${calls[0].url}`,
  );

  restoreEnv();
});

// ─── Missing GITLAB_TOKEN throws ─────────────────────────────────────────────

test('missing GITLAB_TOKEN throws IntegrationError via requireEnv', async () => {
  delete process.env.GITLAB_TOKEN;

  globalThis.fetch = async () => { throw new Error('fetch should not be called'); };

  const { gitlab } = await import(
    `../src/integrations/gitlab/client.js?gl-token-miss-${Date.now()}`
  );

  await assert.rejects(
    () => gitlab.search({ search: 'x' }),
    /Missing required env/,
  );

  restoreEnv();
});

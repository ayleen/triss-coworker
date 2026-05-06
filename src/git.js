import { spawnSync } from 'node:child_process';

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024, // 50MB — diffs can be large
    ...opts,
  });
  if (result.error) {
    throw new Error(`Failed to run ${cmd}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const msg = (result.stderr || result.stdout || '').trim() || `exit ${result.status}`;
    throw new Error(`${cmd} ${args.join(' ')} failed: ${msg}`);
  }
  return result.stdout;
}

export function git(args, opts = {}) {
  return run('git', args, opts);
}

export function gh(args, opts = {}) {
  return run('gh', args, opts);
}

export function hasCommand(cmd) {
  try {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    return r.status === 0;
  } catch {
    return false;
  }
}

export function currentBranch() {
  return git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
}

export function defaultBranch() {
  try {
    const out = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    return out.trim().replace(/^origin\//, '');
  } catch {
    /* fall through */
  }
  for (const b of ['main', 'master', 'develop']) {
    try {
      git(['rev-parse', '--verify', `refs/heads/${b}`]);
      return b;
    } catch {
      /* try next */
    }
  }
  throw new Error('Could not determine default branch — pass --base <branch>');
}

export function gitDiff(base, head = 'HEAD') {
  return git(['diff', '--no-color', `${base}...${head}`]);
}

export function gitChangedFiles(base, head = 'HEAD') {
  const out = git(['diff', '--name-status', `${base}...${head}`]).trim();
  return out ? out.split('\n') : [];
}

const TICKET_KEY_RE = /\b([A-Z][A-Z0-9_]+-\d+)\b/;
export function parseTicketKey(...texts) {
  for (const t of texts) {
    if (!t) continue;
    const m = String(t).match(TICKET_KEY_RE);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

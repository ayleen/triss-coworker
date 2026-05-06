import { spawnSync } from 'node:child_process';
import { httpJson, requireEnv } from '../_contract.js';

export const ENV = {
  token: 'GITLAB_TOKEN',
  url: 'GITLAB_URL',
};

export function gitlabConfig() {
  requireEnv([ENV.token]);
  const base = (process.env[ENV.url] || 'https://gitlab.com').replace(/\/+$/, '');
  return {
    base,
    headers: {
      Authorization: `Bearer ${process.env[ENV.token]}`,
      Accept: 'application/json',
    },
  };
}

async function call(path, init = {}) {
  const { base, headers } = gitlabConfig();
  const url = path.startsWith('http') ? path : `${base}/api/v4${path}`;
  return httpJson(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
}

export const gitlab = {
  // Cross-project search at /issues?search=. Per-project narrows via /projects/{id}/issues.
  async search({ projectPath, search, scope, limit = 30 }) {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (scope) params.set('scope', scope); // title, description, etc.
    params.set('per_page', String(Math.min(limit, 100)));
    const path = projectPath
      ? `/projects/${encodeURIComponent(projectPath)}/issues?${params}`
      : `/issues?${params}`;
    return call(path);
  },

  async getIssue(projectPath, iid) {
    return call(`/projects/${encodeURIComponent(projectPath)}/issues/${iid}`);
  },

  async listNotes(projectPath, iid) {
    return call(
      `/projects/${encodeURIComponent(projectPath)}/issues/${iid}/notes?per_page=100`,
    );
  },

  async createIssue(projectPath, fields) {
    return call(`/projects/${encodeURIComponent(projectPath)}/issues`, {
      method: 'POST',
      body: fields,
    });
  },

  async updateIssue(projectPath, iid, fields) {
    return call(`/projects/${encodeURIComponent(projectPath)}/issues/${iid}`, {
      method: 'PUT',
      body: fields,
    });
  },

  async addNote(projectPath, iid, body) {
    return call(`/projects/${encodeURIComponent(projectPath)}/issues/${iid}/notes`, {
      method: 'POST',
      body: { body },
    });
  },
};

export function detectProject() {
  let url;
  try {
    const r = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    url = r.stdout.trim();
  } catch {
    return null;
  }
  if (!url) return null;
  // Match SSH and HTTPS for gitlab.com and self-hosted gitlab.example.com.
  const ssh = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (ssh && /gitlab/i.test(ssh[1])) return ssh[2];
  const https = url.match(/^https:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/);
  if (https && /gitlab/i.test(https[1])) return https[2];
  return null;
}

export function resolveProject(projectOpt) {
  if (projectOpt) return projectOpt;
  const detected = detectProject();
  if (!detected) {
    throw new Error('Could not auto-detect GitLab project from origin. Pass --project namespace/name.');
  }
  return detected;
}

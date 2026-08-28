// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { spawnSync } from 'node:child_process';
import { httpJson, requireEnv } from '../_contract.js';

export const ENV = {
  token: 'GITHUB_TOKEN',
};

function authHeader() {
  // Prefer explicit env, fall back to `gh auth token` if available so
  // logged-in `gh` users don't have to re-export their token.
  const fromEnv = process.env[ENV.token];
  if (fromEnv) return fromEnv;
  try {
    const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
    if (r.status === 0) {
      const t = r.stdout.trim();
      if (t) return t;
    }
  } catch {
    /* gh not installed */
  }
  return null;
}

export function ghConfig() {
  const token = authHeader();
  if (!token) requireEnv([ENV.token]); // throws with the standard "missing env" message
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };
}

async function call(path, init = {}) {
  const { headers } = ghConfig();
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  return httpJson(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
}

export const github = {
  async search({ query, limit = 30 }) {
    const q = encodeURIComponent(query);
    return call(`/search/issues?q=${q}&per_page=${Math.min(limit, 100)}`);
  },
  async getIssue(repo, number) {
    return call(`/repos/${repo}/issues/${number}`);
  },
  async listComments(repo, number) {
    return call(`/repos/${repo}/issues/${number}/comments`);
  },
  async createIssue(repo, { title, body, labels, assignees, milestone }) {
    const payload = { title };
    if (body != null) payload.body = body;
    if (labels?.length) payload.labels = labels;
    if (assignees?.length) payload.assignees = assignees;
    if (milestone != null) payload.milestone = milestone;
    return call(`/repos/${repo}/issues`, { method: 'POST', body: payload });
  },
  async updateIssue(repo, number, fields) {
    return call(`/repos/${repo}/issues/${number}`, { method: 'PATCH', body: fields });
  },
  async addComment(repo, number, body) {
    return call(`/repos/${repo}/issues/${number}/comments`, {
      method: 'POST',
      body: { body },
    });
  },
};

// Auto-detect "owner/repo" from the current git origin so users don't
// have to pass --repo when running inside a checkout.
export function detectRepo() {
  let url;
  try {
    const r = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
    if (r.status !== 0) return null;
    url = r.stdout.trim();
  } catch {
    return null;
  }
  if (!url) return null;
  const ssh = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = url.match(/^https:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}

// owner/name pattern: each segment is the GitHub-allowed character set
// (alphanumerics, dot, hyphen, underscore). No slashes, no path traversal,
// no query/fragment injection.
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export function resolveRepo(repoOpt) {
  if (repoOpt) {
    if (!REPO_RE.test(repoOpt)) {
      throw new Error(
        `Invalid GitHub repo "${repoOpt}". Expected owner/name with only ` +
          `letters, digits, dot, hyphen, underscore.`,
      );
    }
    return repoOpt;
  }
  const detected = detectRepo();
  if (!detected) {
    throw new Error('Could not auto-detect GitHub repo from origin. Pass --repo owner/name.');
  }
  return detected;
}

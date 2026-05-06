// Shared Atlassian (Jira + Confluence) auth and request helper.
// Both products live on the same Cloud tenant and share the same triple
// of env vars; centralising avoids drift if Atlassian changes auth.

import { httpJson, requireEnv } from './_contract.js';

export const ATLASSIAN_ENV = {
  baseUrl: 'ATLASSIAN_BASE_URL',
  email: 'ATLASSIAN_EMAIL',
  token: 'ATLASSIAN_API_TOKEN',
};

export function atlassianConfig() {
  requireEnv([ATLASSIAN_ENV.baseUrl, ATLASSIAN_ENV.email, ATLASSIAN_ENV.token]);
  const base = process.env[ATLASSIAN_ENV.baseUrl].replace(/\/+$/, '');
  const auth = Buffer.from(
    `${process.env[ATLASSIAN_ENV.email]}:${process.env[ATLASSIAN_ENV.token]}`,
  ).toString('base64');
  return {
    base,
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  };
}

// Single-stop call helper: paths starting with `/` are joined to the
// tenant base; absolute URLs pass through unchanged. Per-call headers
// merge over the auth header.
export async function atlassianCall(path, init = {}) {
  const { base, headers } = atlassianConfig();
  const url = path.startsWith('http') ? path : `${base}${path}`;
  return httpJson(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
}

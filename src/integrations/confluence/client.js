// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { ATLASSIAN_ENV, atlassianConfig, atlassianCall } from '../_atlassian.js';

export const ENV = ATLASSIAN_ENV;
export const confluenceConfig = atlassianConfig;
const call = atlassianCall;

export const confluence = {
  // Search via CQL — covers everything (pages, blogposts, attachments, …).
  // The result shape includes `title` and `excerpt`.
  async search({ cql, limit = 25 }) {
    const params = new URLSearchParams({ cql, limit: String(Math.min(limit, 100)) });
    return call(`/wiki/rest/api/search?${params}`);
  },

  // Read a page by id. Pass body-format=atlas_doc_format so the result
  // is ADF JSON we can convert to readable text.
  async getPage(id) {
    return call(`/wiki/api/v2/pages/${encodeURIComponent(id)}?body-format=atlas_doc_format`);
  },

  async listSpaces({ limit = 50 } = {}) {
    return call(`/wiki/api/v2/spaces?limit=${limit}`);
  },

  // Find a space id from a key. Confluence v2 needs the numeric id, not
  // the human key, when you create or query pages.
  async resolveSpaceId(spaceKey) {
    if (/^\d+$/.test(spaceKey)) return spaceKey; // already an id
    const data = await call(`/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}&limit=1`);
    const sp = data?.results?.[0];
    if (!sp) throw new Error(`Confluence space "${spaceKey}" not found`);
    return sp.id;
  },

  async createPage({ spaceId, title, body, parentId }) {
    const payload = {
      spaceId: String(spaceId),
      status: 'current',
      title,
      body: { representation: 'storage', value: body },
    };
    if (parentId) payload.parentId = String(parentId);
    return call(`/wiki/api/v2/pages`, { method: 'POST', body: payload });
  },

  async updatePage(id, { title, body, version }) {
    const current = await confluence.getPage(id);
    const nextVersion = (version ?? current.version?.number ?? 0) + 1;
    const payload = {
      id,
      status: 'current',
      title: title ?? current.title,
      version: { number: nextVersion, message: 'updated via triss' },
      body: { representation: 'storage', value: body ?? '' },
    };
    return call(`/wiki/api/v2/pages/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: payload,
    });
  },
};

// Naive plain-text → minimal storage XHTML. Each blank-line-separated
// paragraph becomes a <p>; single newlines stay as <br/>.
export function textToStorage(text) {
  const blocks = String(text ?? '').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  if (!blocks.length) return '<p></p>';
  return blocks
    .map((b) => '<p>' + escapeXml(b).replace(/\n/g, '<br/>') + '</p>')
    .join('\n');
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

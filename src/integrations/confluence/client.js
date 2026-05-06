import { httpJson, requireEnv } from '../_contract.js';

export const ENV = {
  baseUrl: 'ATLASSIAN_BASE_URL',
  email: 'ATLASSIAN_EMAIL',
  token: 'ATLASSIAN_API_TOKEN',
};

export function confluenceConfig() {
  requireEnv([ENV.baseUrl, ENV.email, ENV.token]);
  const base = process.env[ENV.baseUrl].replace(/\/+$/, '');
  const auth = Buffer.from(`${process.env[ENV.email]}:${process.env[ENV.token]}`).toString('base64');
  return {
    base,
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  };
}

async function call(path, init = {}) {
  const { base, headers } = confluenceConfig();
  const url = path.startsWith('http') ? path : `${base}${path}`;
  return httpJson(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
}

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

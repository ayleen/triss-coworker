import { IntegrationError } from '../_contract.js';
import { ATLASSIAN_ENV, atlassianConfig, atlassianCall } from '../_atlassian.js';

// Re-export under the historical names so existing imports / `triss config
// wizard jira` keep working.
export const ENV = ATLASSIAN_ENV;
export const jiraConfig = atlassianConfig;
const call = atlassianCall;

export const jira = {
  // Search via the new JQL endpoint (POST). Works on both classic & next-gen.
  async search({ jql, fields = ['summary', 'status', 'assignee', 'issuetype'], limit = 50, nextPageToken } = {}) {
    const body = { jql, fields, maxResults: Math.min(limit, 100) };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    return call(`/rest/api/3/search/jql`, { method: 'POST', body });
  },

  async getIssue(key, { fields, expand } = {}) {
    const params = new URLSearchParams();
    if (fields?.length) params.set('fields', fields.join(','));
    if (expand?.length) params.set('expand', expand.join(','));
    const qs = params.toString();
    return call(`/rest/api/3/issue/${encodeURIComponent(key)}${qs ? '?' + qs : ''}`);
  },

  async createIssue({ projectKey, issueType, summary, descriptionAdf, fields = {} }) {
    const body = {
      fields: {
        project: { key: projectKey },
        summary,
        issuetype: { name: issueType },
        description: descriptionAdf,
        ...fields,
      },
    };
    return call(`/rest/api/3/issue`, { method: 'POST', body });
  },

  async updateIssue(key, fields) {
    return call(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: { fields },
    });
  },

  async getEditMeta(key) {
    return call(`/rest/api/3/issue/${encodeURIComponent(key)}/editmeta`);
  },

  async listComments(key, { limit = 50 } = {}) {
    return call(`/rest/api/3/issue/${encodeURIComponent(key)}/comment?maxResults=${limit}`);
  },

  async addComment(key, bodyAdf) {
    return call(`/rest/api/3/issue/${encodeURIComponent(key)}/comment`, {
      method: 'POST',
      body: { body: bodyAdf },
    });
  },

  async listTransitions(key) {
    return call(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
  },

  async transitionIssue(key, transitionId) {
    return call(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      body: { transition: { id: String(transitionId) } },
    });
  },

  async listAttachments(key) {
    const issue = await jira.getIssue(key, { fields: ['attachment'] });
    return issue?.fields?.attachment ?? [];
  },
};

// Try to attach `parent` as a real parent first (modern Jira), and fall
// back to the Epic Link customfield (legacy) on a 4xx that mentions it.
export async function setParentSmart(key, parentKey) {
  try {
    await jira.updateIssue(key, { parent: { key: parentKey } });
    return { method: 'parent', parentKey };
  } catch (err) {
    if (err instanceof IntegrationError && err.status >= 400 && err.status < 500) {
      // Probe edit meta to find the Epic Link customfield id (default 10014).
      const meta = await jira.getEditMeta(key);
      const epicField = Object.entries(meta?.fields || {}).find(
        ([, def]) => def?.schema?.custom === 'com.pyxis.greenhopper.jira:gh-epic-link',
      );
      const fieldId = epicField?.[0] || 'customfield_10014';
      await jira.updateIssue(key, { [fieldId]: parentKey });
      return { method: fieldId, parentKey };
    }
    throw err;
  }
}

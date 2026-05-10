import { httpJson, requireEnv, IntegrationError } from '../_contract.js';

export const ENV = {
  apiKey: 'LINEAR_API_KEY',
  endpoint: 'LINEAR_API_URL', // optional override
};

export function linearConfig() {
  requireEnv([ENV.apiKey]);
  return {
    endpoint: process.env[ENV.endpoint] || 'https://api.linear.app/graphql',
    headers: {
      // Linear personal API keys go in Authorization as the bare token —
      // no `Bearer ` prefix (this differs from GitHub/GitLab on purpose).
      Authorization: process.env[ENV.apiKey],
      'Content-Type': 'application/json',
    },
  };
}

export async function gql(query, variables = {}) {
  const { endpoint, headers } = linearConfig();
  const data = await httpJson(endpoint, {
    method: 'POST',
    headers,
    body: { query, variables },
  });
  if (data.errors?.length) {
    throw new IntegrationError(
      `Linear GraphQL error: ${data.errors.map((e) => e.message).join('; ')}`,
      { body: data },
    );
  }
  return data.data;
}

const ISSUE_FIELDS = `
  id identifier title description url state { name type } priority
  assignee { name email } creator { name } team { id key name }
  project { id name } parent { identifier title }
  dueDate
  createdAt updatedAt
`;

const PROJECT_FIELDS = `id name startDate targetDate url status { name type }`;

export const linear = {
  async search({ term, limit = 50 }) {
    const data = await gql(
      `query($term: String!, $limit: Int!) {
        searchIssues(term: $term, first: $limit) {
          nodes { ${ISSUE_FIELDS} }
        }
      }`,
      { term, limit },
    );
    return data.searchIssues.nodes;
  },

  async getIssue(idOrIdentifier) {
    // Linear's issue(id:) accepts both UUIDs and identifiers like "ENG-42".
    const data = await gql(
      `query($id: String!) {
        issue(id: $id) {
          ${ISSUE_FIELDS}
          comments(first: 100) {
            nodes { id body createdAt user { name } }
          }
          attachments(first: 100) {
            nodes { id url title sourceType createdAt }
          }
        }
      }`,
      { id: idOrIdentifier },
    );
    if (!data.issue) throw new IntegrationError(`Linear issue not found: ${idOrIdentifier}`);
    return data.issue;
  },

  async createIssue(input) {
    const data = await gql(
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { ${ISSUE_FIELDS} }
        }
      }`,
      { input },
    );
    if (!data.issueCreate.success) throw new IntegrationError('issueCreate returned success=false');
    return data.issueCreate.issue;
  },

  async updateIssue(id, input) {
    const data = await gql(
      `mutation($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue { ${ISSUE_FIELDS} }
        }
      }`,
      { id, input },
    );
    if (!data.issueUpdate.success) throw new IntegrationError('issueUpdate returned success=false');
    return data.issueUpdate.issue;
  },

  async addComment(issueId, body) {
    const data = await gql(
      `mutation($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { id url } }
      }`,
      { input: { issueId, body } },
    );
    if (!data.commentCreate.success) throw new IntegrationError('commentCreate returned success=false');
    return data.commentCreate.comment;
  },

  async listProjects(teamKey) {
    const data = await gql(
      `query($key: String!) {
        team(id: $key) {
          projects(first: 100) {
            nodes { ${PROJECT_FIELDS} }
          }
        }
      }`,
      { key: teamKey },
    );
    if (!data.team) throw new IntegrationError(`Linear team not found: ${teamKey}`);
    return data.team.projects.nodes;
  },

  async createProject({ teamId, name, startDate, targetDate, initiativeId }) {
    const input = { teamIds: [teamId], name };
    if (startDate) input.startDate = startDate;
    if (targetDate) input.targetDate = targetDate;
    const data = await gql(
      `mutation($input: ProjectCreateInput!) {
        projectCreate(input: $input) {
          success
          project { ${PROJECT_FIELDS} }
        }
      }`,
      { input },
    );
    if (!data.projectCreate.success) throw new IntegrationError('projectCreate returned success=false');
    const project = data.projectCreate.project;
    if (initiativeId) {
      const link = await gql(
        `mutation($input: InitiativeToProjectCreateInput!) {
          initiativeToProjectCreate(input: $input) { success }
        }`,
        { input: { initiativeId, projectId: project.id } },
      );
      if (!link.initiativeToProjectCreate.success) {
        throw new IntegrationError('initiativeToProjectCreate returned success=false');
      }
    }
    return project;
  },

  async listInitiatives() {
    const data = await gql(
      `query {
        initiatives(first: 100) {
          nodes {
            id name
            projects(first: 50) {
              nodes { id name }
            }
          }
        }
      }`,
    );
    return data.initiatives?.nodes ?? [];
  },

  async listStates(teamKey) {
    const data = await gql(
      `query($key: String!) {
        team(id: $key) {
          states(first: 100) { nodes { id name type position } }
        }
      }`,
      { key: teamKey },
    );
    if (!data.team) throw new IntegrationError(`Linear team not found: ${teamKey}`);
    return data.team.states.nodes;
  },
};

// UUID v4-ish — used to short-circuit the team-key lookup.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolve a Linear team to its UUID. Accepts either:
//   - a UUID (returned unchanged)
//   - a team key like "ENG" (looked up via the teams query)
// Throws IntegrationError when the key isn't found.
export async function resolveTeamId(team) {
  if (!team) throw new IntegrationError('Linear team is required (UUID or key)');
  if (UUID_RE.test(team)) return team;
  const data = await gql(
    `query($key: String!) {
      teams(filter: { key: { eq: $key } }, first: 2) {
        nodes { id key name }
      }
    }`,
    { key: team },
  );
  const nodes = data.teams?.nodes || [];
  if (!nodes.length) {
    throw new IntegrationError(
      `Linear team "${team}" not found. Pass a UUID or an existing team key (e.g. ENG).`,
    );
  }
  return nodes[0].id;
}

export async function transitionIssue(idOrIdentifier, stateName) {
  const issue = await linear.getIssue(idOrIdentifier);
  const states = await linear.listStates(issue.team.key);
  const target = states.find((s) => s.name.toLowerCase() === stateName.toLowerCase());
  if (!target) {
    const names = states.map((s) => s.name).join(', ');
    throw new IntegrationError(`No state matches "${stateName}". Available: ${names}`);
  }
  return linear.updateIssue(issue.id, { stateId: target.id });
}

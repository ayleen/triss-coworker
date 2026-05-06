import pc from 'picocolors';
import { chat, chatStream, reportUsage } from '../client.js';
import { resolveModel } from '../models.js';
import { shouldStream } from './chat.js';
import {
  currentBranch,
  defaultBranch,
  gitDiff,
  gitChangedFiles,
  gh,
  hasCommand,
  parseTicketKey,
} from '../git.js';
import { loadIntegrations, envReadiness } from '../integrations/_registry.js';

const SYSTEM_PROMPT = `You are a senior code reviewer. Read the supplied
diff, branch/PR metadata, and any linked ticket. Identify:

1. Bugs or regressions
2. Security / safety issues
3. Edge cases not covered
4. Missing or wrong tests
5. Documentation gaps
6. Style or convention violations

Output rules:
- One short bullet per concrete issue.
- Quote file paths and line numbers exactly.
- Skip generic praise; do not summarise the diff.
- If you find no real issues, say "No issues found." in one line.`;

const DEFAULT_QUESTION =
  'Review this change. List concrete issues; do not summarise the diff.';

export async function runReview(prNumber, opts) {
  const model = resolveModel(opts.model || 'pro');

  let title = '';
  let description = '';
  let diff = '';
  let baseRef = opts.base;
  let headRef = 'HEAD';
  let urlNote = '';

  if (prNumber) {
    if (!hasCommand('gh')) {
      throw new Error(
        'PR mode requires the GitHub CLI (`gh`). Install: https://cli.github.com/',
      );
    }
    const json = gh(['pr', 'view', prNumber, '--json', 'title,body,headRefName,baseRefName,url']);
    const pr = JSON.parse(json);
    title = pr.title;
    description = pr.body || '';
    baseRef = baseRef || pr.baseRefName;
    headRef = pr.headRefName;
    urlNote = pr.url;
    diff = gh(['pr', 'diff', prNumber]);
  } else {
    headRef = currentBranch();
    baseRef = baseRef || defaultBranch();
    title = headRef;
    diff = gitDiff(baseRef, 'HEAD');
  }

  if (!diff.trim()) {
    process.stdout.write(pc.dim('(no changes between branches — nothing to review)\n'));
    return;
  }

  const ticketCorpus = opts.skipIssue
    ? ''
    : await tryLoadLinkedIssue(parseTicketKey(title, headRef, description));

  let changedFiles = [];
  if (!prNumber) {
    try {
      changedFiles = gitChangedFiles(baseRef);
    } catch {
      /* okay if base doesn't resolve */
    }
  }

  const sections = [
    `<change base="${baseRef}" head="${headRef}">`,
    `Title: ${title}`,
    urlNote ? `URL: ${urlNote}` : null,
    description ? `\nDescription:\n${description}` : null,
    changedFiles.length ? `\nChanged files:\n${changedFiles.join('\n')}` : null,
    `</change>`,
    ticketCorpus || null,
    `<diff>\n${diff}\n</diff>`,
  ].filter(Boolean);
  const corpus = sections.join('\n\n');

  process.stderr.write(
    pc.dim(`[triss/review] model=${model} bytes=${corpus.length} base=${baseRef} head=${headRef}\n`),
  );

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: corpus },
    { role: 'user', content: opts.question || DEFAULT_QUESTION },
  ];
  const maxTokens = parseInt(opts.maxTokens, 10) || 8192;
  const useStream = shouldStream(opts);
  const resp = useStream
    ? await chatStream({
        model,
        maxTokens,
        messages,
        label: 'triss/review',
        onChunk: (d) => process.stdout.write(d),
      })
    : await chat({ model, maxTokens, messages, label: 'triss/review' });

  const out = resp.choices?.[0]?.message?.content;
  if (!out) {
    process.stderr.write(pc.red('[triss/review] empty response — try --max-tokens 16384\n'));
    process.exit(1);
  }
  if (!useStream) process.stdout.write(out + '\n');
  else process.stdout.write('\n');
  process.stderr.write(pc.dim('\n' + reportUsage(resp, 'triss/review') + '\n'));
}

async function tryLoadLinkedIssue(key) {
  if (!key) return '';
  const integrations = await loadIntegrations();
  for (const m of integrations) {
    if (!envReadiness(m).ready) continue;
    try {
      if (m.name === 'jira') {
        const { jira } = await import('../integrations/jira/client.js');
        const { adfToText } = await import('../integrations/jira/adf.js');
        const issue = await jira.getIssue(key);
        const f = issue.fields || {};
        process.stderr.write(pc.dim(`[triss/review] linked Jira issue: ${key}\n`));
        return [
          `<linked-issue source="jira" key="${key}">`,
          `Summary: ${f.summary ?? ''}`,
          `Status:  ${f.status?.name ?? ''}`,
          `Type:    ${f.issuetype?.name ?? ''}`,
          '',
          'Description:',
          adfToText(f.description) || '(none)',
          `</linked-issue>`,
        ].join('\n');
      }
      if (m.name === 'linear') {
        const { linear } = await import('../integrations/linear/client.js');
        const issue = await linear.getIssue(key);
        process.stderr.write(pc.dim(`[triss/review] linked Linear issue: ${key}\n`));
        return [
          `<linked-issue source="linear" key="${key}">`,
          `Title: ${issue.title ?? ''}`,
          `State: ${issue.state?.name ?? ''}`,
          '',
          'Description:',
          issue.description || '(none)',
          `</linked-issue>`,
        ].join('\n');
      }
    } catch (err) {
      const msg = (err.message || String(err)).split('\n')[0];
      process.stderr.write(pc.dim(`[triss/review] couldn't fetch ${key} from ${m.name}: ${msg}\n`));
    }
  }
  return '';
}

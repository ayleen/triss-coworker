import pc from 'picocolors';
import { chat, chatStream, reportUsage, responseText } from '../client.js';
import { resolveModelRequest } from '../models.js';
import { REVIEW_SYSTEM_PROMPT } from '../review-prompt.js';
import { readStdin } from '../secrets.js';
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

const DEFAULT_QUESTION =
  'Review this change. List concrete issues; do not summarise the diff.';

export async function runReview(prNumber, opts) {
  return runReviewWithDeps(prNumber, opts);
}

// Test seam matching ask.js: the production entry point cannot accidentally
// receive Commander's extra action argument as dependencies, while focused
// tests can inject the provider response without making a network call.
export async function runReviewWithDeps(prNumber, opts, deps = {}) {
  const stdinMode = Boolean(opts.stdin);
  if (stdinMode && prNumber !== undefined) {
    throw new Error(
      'Cannot combine a PR number with --stdin. Use: git diff | triss review --stdin',
    );
  }
  if (stdinMode && opts.base !== undefined) {
    throw new Error(
      'Cannot combine --base with --stdin. Use: git diff | triss review --stdin',
    );
  }

  const isTTY = deps.isTTY ?? process.stdin.isTTY;
  const readInput = deps.readStdin || readStdin;
  let stdinDiff;
  if (stdinMode) {
    if (isTTY) {
      throw new Error(
        '--stdin requires piped input. Try: git diff | triss review --stdin',
      );
    }
    stdinDiff = await readInput({ trim: false });
    if (typeof stdinDiff !== 'string') {
      throw new Error(
        'stdin input must be UTF-8 text. Try: git diff | triss review --stdin',
      );
    }
    if (!stdinDiff.trim()) {
      throw new Error(
        'stdin diff is empty or whitespace-only. Try: git diff | triss review --stdin',
      );
    }
  }

  const resolveRequest = deps.resolveModelRequest || resolveModelRequest;
  const sendChat = deps.chat || chat;
  const sendChatStream = deps.chatStream || chatStream;
  const loadLinkedIssue = deps.loadLinkedIssue || tryLoadLinkedIssue;
  const request = resolveRequest({
    provider: opts.provider,
    model: opts.model || 'pro',
  });
  const { provider, model } = request;

  let title;
  let description = '';
  let diff;
  let baseRef = opts.base;
  let headRef;
  let urlNote = '';

  if (stdinMode) {
    title = 'stdin';
    diff = stdinDiff;
  } else if (prNumber) {
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

  const ticketCorpus = stdinMode || opts.skipIssue
    ? ''
    : await loadLinkedIssue(parseTicketKey(title, headRef, description));

  let changedFiles = [];
  if (!prNumber && !stdinMode) {
    try {
      changedFiles = gitChangedFiles(baseRef);
    } catch {
      /* okay if base doesn't resolve */
    }
  }

  const sections = stdinMode
    ? [
        '<change source="stdin">\nTitle: stdin\n</change>',
        `<diff>\n${diff}\n</diff>`,
      ]
    : [
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

  const diagnostic = stdinMode
    ? `[triss/review] provider=${provider} model=${model} source=stdin ` +
      `bytes=${Buffer.byteLength(stdinDiff, 'utf8')}\n`
    : `[triss/review] provider=${provider} model=${model} bytes=${corpus.length} ` +
      `base=${baseRef} head=${headRef}\n`;
  process.stderr.write(pc.dim(diagnostic));

  const messages = [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: corpus },
    { role: 'user', content: opts.question || DEFAULT_QUESTION },
  ];
  const maxTokens = parseInt(opts.maxTokens, 10) || 8192;
  const useStream = shouldStream(opts);
  const resp = useStream
    ? await sendChatStream({
        ...request,
        maxTokens,
        messages,
        label: 'triss/review',
        onChunk: (d) => process.stdout.write(d),
      })
    : await sendChat({ ...request, maxTokens, messages, label: 'triss/review' });

  const out = responseText(resp);
  if (!out) {
    process.stderr.write(pc.red('[triss/review] empty response — try --max-tokens 16384\n'));
    process.exit(1);
  }
  if (!useStream) process.stdout.write(out + '\n');
  else process.stdout.write('\n');
  process.stderr.write(pc.dim('\n' + reportUsage(resp, 'triss/review', { provider: request.provider }) + '\n'));
  return out;
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

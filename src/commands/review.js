import pc from 'picocolors';
import { chat, chatStream, reportUsage, responseText } from '../client.js';
import { assertProviderText } from '../provider-errors.js';
import { resolveModelRequest } from '../models.js';
import {
  createReviewBoundaryId,
  reviewSystemPromptForFormat,
  wrapReviewSection,
} from '../review-prompt.js';
import { readBoundedReviewStdin, REVIEW_STDIN_MAX_BYTES } from '../review-input.js';
import { executeSingleReview, REVIEW_EXIT_CODES } from '../review-executor.js';
import { parseUnifiedDiff, planSingleReviewPayload } from '../review-payload.js';
import { reviewLimitConfig } from '../config.js';
import { shouldStream } from './chat.js';
import {
  currentBranch,
  defaultBranch,
  gitDiff,
  gitChangedFiles,
  gh,
  hasCommand,
} from '../git.js';
import { loadIntegrations, envReadiness } from '../integrations/_registry.js';
import { emptyReviewResponse, validateResponseFormat } from '../response-format.js';
import { positiveIntegerOption } from '../option-validation.js';

const DEFAULT_QUESTION =
  'Review this change. List concrete issues; do not summarise the diff.';

export async function runReview(prNumber, opts) {
  return runReviewWithDeps(prNumber, opts);
}

export function validateReviewOptions(prNumber, opts) {
  const responseFormat = validateResponseFormat(opts.format);
  const maxTokens = positiveIntegerOption(opts.maxTokens, '--max-tokens', 8192);
  if (opts.stdin && prNumber !== undefined) {
    throw new Error(
      'Cannot combine a PR number with --stdin. Use: git diff | triss review --stdin',
    );
  }
  if (opts.stdin && opts.base !== undefined) {
    throw new Error(
      'Cannot combine --base with --stdin. Use: git diff | triss review --stdin',
    );
  }
  // Atomic 45 / Package 24: evidence + shard is rejected in the CLI router.
  if (opts.payloadMode === 'shard' && responseFormat === 'evidence') {
    throw new Error('--payload-mode shard cannot be combined with --format evidence');
  }
  // Release B trust boundary: --files selectors and --issue are literal,
  // explicit options; they cannot be derived from PR prose.
  if (opts.files !== undefined && !Array.isArray(opts.files)) {
    throw new Error('--files expects literal path selectors');
  }
  return { responseFormat, maxTokens };
}

// Test seam matching ask.js: the production entry point cannot accidentally
// receive Commander's extra action argument as dependencies, while focused
// tests can inject the provider response without making a network call.
export async function runReviewWithDeps(prNumber, opts, deps = {}) {
  const { responseFormat, maxTokens } = validateReviewOptions(prNumber, opts);
  const stdinMode = Boolean(opts.stdin);

  const isTTY = deps.isTTY ?? process.stdin.isTTY;
  let stdinDiff;
  if (stdinMode) {
    if (isTTY) {
      throw new Error(
        '--stdin requires piped input. Try: git diff | triss review --stdin',
      );
    }
    // Release B: bounded streaming stdin — cap-plus-one bytes, fail closed
    // on overflow instead of buffering unbounded input.
    const bounded = await (deps.readBoundedStdin || readBoundedReviewStdin)({
      stream: process.stdin,
      maxBytes: REVIEW_STDIN_MAX_BYTES,
    });
    if (!bounded.ok) {
      throw new Error(
        `${bounded.message || 'bounded stdin read failed'}. Try: git diff | triss review --stdin`,
      );
    }
    stdinDiff = bounded.text;
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
    diff = (deps.gitDiff || gitDiff)(baseRef, 'HEAD');
  }

  if (!diff.trim()) {
    const empty = emptyReviewResponse(responseFormat);
    process.stdout.write(responseFormat === 'evidence' ? `${empty}\n` : pc.dim(`${empty}\n`));
    return responseFormat === 'evidence' ? empty : undefined;
  }

  const resolveRequest = deps.resolveModelRequest || resolveModelRequest;
  const sendChat = deps.chat || chat;
  const sendChatStream = deps.chatStream || chatStream;
  const request = resolveRequest({
    provider: opts.provider,
    model: opts.model || 'pro',
  });
  const { provider, model } = request;

  // Release B trust boundary: the linked issue is ONLY loaded from the
  // explicit --issue option (or, as a legacy convenience, from the LOCAL
  // branch name when no PR is involved). PR prose (title/body) can never
  // trigger tracker access — parseTicketKey auto-extraction was removed.
  const loadLinkedIssue = deps.loadLinkedIssue || tryLoadLinkedIssue;
  let ticketCorpus = '';
  if (!stdinMode && opts.issue) {
    ticketCorpus = await loadLinkedIssue(String(opts.issue).trim());
  } else if (!stdinMode && !opts.skipIssue && opts.payloadMode !== 'shard') {
    if (!prNumber && headRef) {
      ticketCorpus = await loadLinkedIssue(branchTicketKey(headRef));
    }
  }

  let changedFiles = [];
  if (!prNumber && !stdinMode) {
    try {
      changedFiles = gitChangedFiles(baseRef);
    } catch {
      /* okay if base doesn't resolve */
    }
  }

  const boundaryId = deps.reviewBoundaryId || createReviewBoundaryId();
  const changeCorpus = stdinMode
    ? '<change source="stdin">\nTitle: stdin\n</change>'
    : [
        `<change base="${baseRef}" head="${headRef}">`,
        `Title: ${title}`,
        urlNote ? `URL: ${urlNote}` : null,
        description ? `\nDescription:\n${description}` : null,
        changedFiles.length ? `\nChanged files:\n${changedFiles.join('\n')}` : null,
        `</change>`,
      ].filter(Boolean).join('\n');

  // Atomic 45 / Package 24: CLI shard mode — sequential whole-file shards,
  // separated execution/scope/coverage/context fields, no global verdict.
  if (opts.payloadMode === 'shard') {
    if (shouldStream(opts)) {
      throw new Error('--payload-mode shard cannot be combined with --stream');
    }
    const { parseUnifiedDiff, planSequentialShards } = await import('../review-payload.js');
    const { executeReviewPlan, REVIEW_EXIT_CODES } = await import('../review-executor.js');
    const { reviewLimitConfig } = await import('../config.js');
    const limits = reviewLimitConfig().limits;

    const parsed = parseUnifiedDiff(diff);
    if (parsed.error) {
      process.stderr.write(pc.dim(`[triss/review] ${parsed.error}\n`));
      process.exitCode = 2;
      return undefined;
    }
    const planned = planSequentialShards({
      sections: parsed.sections,
      question: opts.question || DEFAULT_QUESTION,
      metadata: changeCorpus,
      limits,
    });
    if (planned.error) {
      process.stderr.write(pc.dim(`[triss/review] ${planned.error}${planned.path ? `: ${planned.path}` : ''}\n`));
      process.exitCode = 2;
      return undefined;
    }

    const result = await executeReviewPlan(
      {
        callModel: async ({ shard, question, metadata }) => {
          const shardCorpus = [
            wrapReviewSection(boundaryId, 'change', metadata),
            wrapReviewSection(boundaryId, 'diff', `<diff>\n${shard.sections.map((s) => s.raw).join('\n')}\n</diff>`),
          ].join('\n\n');
          const resp = await sendChat({
            ...request,
            maxTokens,
            messages: [
              { role: 'system', content: reviewSystemPromptForFormat('text', { boundaryId }) },
              { role: 'user', content: shardCorpus },
              { role: 'user', content: question },
            ],
            label: 'triss/review',
          });
          return assertProviderText(responseText(resp));
        },
        limits,
      },
      {
        shards: planned.plan.shards,
        question: opts.question || DEFAULT_QUESTION,
        metadata: changeCorpus,
        signal: undefined,
      },
    );

    if (!result.ok) {
      process.stderr.write(pc.dim(`[triss/review] shard execution failed: ${result.message}\n`));
      process.exitCode = result.exit ?? REVIEW_EXIT_CODES.provider;
      return undefined;
    }
    // Separated execution/scope fields + no global verdict (per-shard only).
    process.stderr.write(pc.dim(`[triss/review] shards=${result.attempts} bytes=${result.shards.reduce((a, s) => a + s.bytes, 0)}\n`));
    for (const shard of result.shards) {
      process.stdout.write(`--- shard ${shard.shard_index} ---\n`);
      process.stdout.write(`${shard.verdict}\n`);
    }
    process.stdout.write('global verdict: unavailable_for_sharded\n');
    return result.shards.map((s) => s.verdict).join('\n\n');
  }

  const diagnostic = stdinMode
    ? `[triss/review] provider=${provider} model=${model} source=stdin ` +
      `bytes=${Buffer.byteLength(diff, 'utf8')} limits=bounded-stdin\n`
    : `[triss/review] provider=${provider} model=${model} ` +
      `bytes=${Buffer.byteLength(diff, 'utf8')} ` +
      `base=${baseRef} head=${headRef}\n`;
  process.stderr.write(pc.dim(diagnostic));

  // Release B: bounded single-request payload planning (P0 fix — a payload
  // that cannot fit singleMaxBytes fails closed with a shard hint instead
  // of a silent clean verdict over truncated files).
  const limits = reviewLimitConfig().limits;
  const selectors = Array.isArray(opts.files) ? opts.files : [];
  const parsedSections = parseUnifiedDiff(diff);
  if (parsedSections.error) {
    throw new Error(`failed to parse diff: ${parsedSections.error}`);
  }
  // Coverage flows through executeSingleReview; requested-scope reporting
  // is derived there from the literal selectors.
  const plan = planSingleReviewPayload({
    sections: parsedSections.sections,
    question: opts.question || DEFAULT_QUESTION,
    metadata: changeCorpus,
    limits,
  });
  if (plan.error) {
    process.stderr.write(pc.dim(
      `[triss/review] ${plan.error}${plan.path ? `: ${plan.path}` : ''} — ` +
        `retry with --payload-mode shard\n`,
    ));
    process.exitCode = REVIEW_EXIT_CODES.limit;
    return undefined;
  }
  // Literal --files selection: only the requested sections are sent.
  const selectedDiff = selectors.length > 0
    ? plan.plan.sections
        .filter((s) => selectors.includes(s.new_path) || selectors.includes(s.old_path))
        .map((s) => s.raw)
        .join('\n')
    : diff;

  const singleResult = await executeSingleReview(
    {
      callModel: async ({ diff: reviewDiff, question }) => {
        const sections = [
          ...(ticketCorpus ? [wrapReviewSection(boundaryId, 'ticket', ticketCorpus)] : []),
          wrapReviewSection(boundaryId, 'change', changeCorpus),
          wrapReviewSection(boundaryId, 'diff', `<diff>\n${reviewDiff}\n</diff>`),
        ].join('\n\n');
        const messages = [
          {
            role: 'system',
            content: reviewSystemPromptForFormat(responseFormat, { boundaryId }),
          },
          { role: 'user', content: sections },
          { role: 'user', content: question },
        ];
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
        process.stderr.write(pc.dim('\n' + reportUsage(resp, 'triss/review', { provider: request.provider }) + '\n'));
        return assertProviderText(responseText(resp));
      },
      limits,
    },
    {
      diff: selectedDiff,
      question: opts.question || DEFAULT_QUESTION,
      selectors,
    },
  );

  if (!singleResult.ok) {
    process.stderr.write(pc.dim(`✗ ${singleResult.message || singleResult.code}\n`));
    process.exitCode = singleResult.exit ?? REVIEW_EXIT_CODES.provider;
    return undefined;
  }
  process.stdout.write(singleResult.verdict + '\n');
  return singleResult.verdict;
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

// Extract a ticket key from a LOCAL branch name only (Release B: PR prose
// never triggers tracker access; the branch name is operator-chosen, not
// attacker-controlled PR text).
function branchTicketKey(headRef) {
  if (typeof headRef !== 'string') return '';
  const m = /([A-Z][A-Z0-9]+-\d+)/.exec(headRef);
  return m ? m[1] : '';
}

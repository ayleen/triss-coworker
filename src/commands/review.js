// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import pc from 'picocolors';
import { executeModelTask, printModelResultWarnings } from '../model-runtime.js';
import { reportNormalizedUsage } from '../model-usage.js';
import { assertProviderText } from '../provider-errors.js';
import {
  createReviewBoundaryId,
  reviewSystemPromptForFormat,
  wrapReviewSection,
} from '../review-prompt.js';
import { readBoundedReviewStdin, REVIEW_STDIN_MAX_BYTES } from '../review-input.js';
import { executeSingleReview, REVIEW_EXIT_CODES } from '../review-executor.js';
import { parseUnifiedDiff, planSingleReviewPayload } from '../review-payload.js';
import { acquireScopedReviewDiff, validateReviewSelectors } from '../review-scoped.js';
import { reviewLimitConfig } from '../config.js';
import { shouldStream } from './chat.js';
import {
  currentBranch,
  defaultBranch,
  gitChangedFiles,
  gh,
  hasCommand,
} from '../git.js';
import { loadIntegrations, envReadiness } from '../integrations/_registry.js';
import { emptyReviewResponse, validateResponseFormat } from '../response-format.js';
import { positiveIntegerOption } from '../option-validation.js';
import { emptyReviewResponseMessage } from '../review-defaults.js';

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
  // shared contract: evidence + shard is rejected in the CLI router.
  if (opts.payloadMode === 'shard' && responseFormat === 'evidence') {
    throw new Error('--payload-mode shard cannot be combined with --format evidence');
  }
  // review acceptance trust boundary: --files selectors and --issue are literal,
  // explicit options; they cannot be derived from PR prose.
  if (opts.files !== undefined && !Array.isArray(opts.files)) {
    throw new Error('--files expects literal path selectors');
  }
  const selectorCheck = validateReviewSelectors(Array.isArray(opts.files) ? opts.files : []);
  if (!selectorCheck.ok) throw new Error(selectorCheck.message);
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
    // review acceptance: bounded streaming stdin — cap-plus-one bytes, fail closed
    // on overflow instead of buffering unbounded input. The legacy
    // deps.readStdin seam (tests, embedders) is honoured as a plain string
    // source and cap-checked the same way; the production path always uses
    // the bounded streaming reader.
    const legacyReader = typeof deps.readStdin === 'function' ? deps.readStdin : null;
    if (legacyReader) {
      stdinDiff = await legacyReader({ trim: false, fatalUtf8: true });
      const bytes = Buffer.byteLength(String(stdinDiff), 'utf8');
      if (bytes > REVIEW_STDIN_MAX_BYTES) {
        throw new Error(
          `stdin input of ${bytes} bytes exceeds the ${REVIEW_STDIN_MAX_BYTES}-byte cap. Try: git diff -- <path> | triss review --stdin`,
        );
      }
    } else {
      const bounded = await (deps.readBoundedStdin || readBoundedReviewStdin)({
        stream: deps.stdinStream || process.stdin,
        maxBytes: REVIEW_STDIN_MAX_BYTES,
      });
      if (!bounded.ok) {
        throw new Error(
          `${bounded.message || 'bounded stdin read failed'}. Try: git diff | triss review --stdin`,
        );
      }
      stdinDiff = bounded.text;
    }
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
  let changedFilesFromInventory = null;

  // review acceptance: literal --files selectors validated up front; exact merge-base
  // comparison under the sealed Git projection.
  const scopedSelectors = Array.isArray(opts.files) ? opts.files : [];
  if (stdinMode) {
    title = 'stdin';
    diff = stdinDiff;
  } else if (scopedSelectors.length > 0) {
    const scoped = await (deps.acquireScopedDiff || acquireScopedReviewDiff)(
      deps.scopedDeps || {},
      {
        pr: prNumber,
        base: baseRef,
        selectors: scopedSelectors,
      },
    );
    if (!scoped.ok) {
      if (scoped.code === 'TRISS_REVIEW_SCOPE_EMPTY') {
        process.stderr.write(pc.dim(`✗ ${scoped.message}\n`));
        process.exitCode = REVIEW_EXIT_CODES.invalidInput;
        return undefined;
      }
      throw new Error(`${scoped.code || 'TRISS_REVIEW_LIMIT'}: ${scoped.message || 'scoped acquisition failed'}`);
    }
    diff = scoped.diff;
    baseRef = scoped.base_ref || baseRef;
    headRef = scoped.head_ref || headRef;
    title = prNumber ? `PR #${prNumber}` : headRef || 'scoped review';
    const unmatched = scoped.unmatched || [];
    if (unmatched.length > 0) {
      process.stderr.write(pc.dim(
        `[triss/review] scope: ${unmatched.length} requested file(s) not in the change: ` +
          `${unmatched.join(', ')}\n`,
      ));
    }
    if (!diff.trim()) {
      process.stderr.write(pc.dim('✗ none of the requested files appear in the acquired diff\n'));
      process.exitCode = REVIEW_EXIT_CODES.invalidInput;
      return undefined;
    }
    changedFilesFromInventory = scoped.changed_files || [];
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
    if (deps.prDiff) {
      diff = deps.prDiff(prNumber);
    } else {
      const scoped = await (deps.acquireScopedDiff || acquireScopedReviewDiff)(
        deps.scopedDeps || {},
        { pr: prNumber, base: baseRef, selectors: [] },
      );
      if (!scoped.ok) {
        throw new Error(`${scoped.code || 'TRISS_REVIEW_LIMIT'}: ${scoped.message || 'PR acquisition failed'}`);
      }
      diff = scoped.diff;
    }
  } else {
    headRef = currentBranch();
    baseRef = baseRef || defaultBranch();
    title = headRef;
    if (deps.gitDiff) {
      diff = deps.gitDiff(baseRef, 'HEAD');
    } else {
      const scoped = await (deps.acquireScopedDiff || acquireScopedReviewDiff)(
        deps.scopedDeps || {},
        { base: baseRef, selectors: [] },
      );
      if (!scoped.ok) {
        throw new Error(`${scoped.code || 'TRISS_REVIEW_LIMIT'}: ${scoped.message || 'local diff acquisition failed'}`);
      }
      diff = scoped.diff;
    }
  }

  if (!diff.trim()) {
    const empty = emptyReviewResponse(responseFormat);
    if (responseFormat === 'text') {
      process.stdout.write(pc.dim(`${empty}\n`));
      return undefined;
    }
    process.stdout.write(`${empty}\n`);
    return empty;
  }

  const execute = deps.executeModelTask || executeModelTask;
  const explicitMaxTokens = opts.maxTokens !== undefined;

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
  if (changedFilesFromInventory) {
    changedFiles = changedFilesFromInventory;
  } else if (!prNumber && !stdinMode) {
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
    const fullMetadata = [
      wrapReviewSection(boundaryId, 'change', changeCorpus),
      ...(ticketCorpus ? [wrapReviewSection(boundaryId, 'ticket', ticketCorpus)] : []),
    ].join('\n\n');

    const planned = planSequentialShards({
      sections: parsed.sections,
      question: opts.question || DEFAULT_QUESTION,
      metadata: fullMetadata,
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
            metadata,
            wrapReviewSection(boundaryId, 'diff', `<diff>\n${shard.sections.map((s) => s.raw).join('')}\n</diff>`),
          ].join('\n\n');
          const output = await execute({
            task: 'review-shard',
            provider: opts.provider,
            model: opts.model,
            engine: opts.engine,
            effort: opts.effort,
            protectCredentials: opts.protectCredentials,
            signal: deps.signal,
            input: {
              maxOutputTokens: maxTokens,
              messages: [
                { role: 'system', content: reviewSystemPromptForFormat('text', { boundaryId }) },
                { role: 'user', content: shardCorpus },
                { role: 'user', content: question },
              ],
              label: 'triss/review',
            },
          }, deps.runtimeDeps);
          printModelResultWarnings(output.result, { color: pc.yellow });
          const text = output.result.text;
          if (!text || !text.trim()) {
            const err = new Error(emptyReviewResponseMessage({
              finishReason: output.result.finishReason,
              explicitMaxTokens,
              labeled: true,
            }));
            err.code = 'TRISS_PROVIDER_EMPTY';
            throw err;
          }
          return assertProviderText(text);
        },
        limits,
      },
      {
        shards: planned.plan.shards,
        question: opts.question || DEFAULT_QUESTION,
        metadata: fullMetadata,
        signal: undefined,
      },
    );

    if (!result.ok) {
      process.stderr.write(pc.dim(`[triss/review] shard execution failed: ${result.message}\n`));
      // shard body).
      if (Array.isArray(result.shards)) {
        for (const shard of result.shards) {
          if (shard && shard.verdict !== undefined) {
            process.stdout.write(`--- shard ${shard.shard_index} (completed before failure) ---\n`);
            process.stdout.write(`${shard.verdict}\n`);
          }
        }
      }
      process.stdout.write('global verdict: unavailable_for_sharded\n');
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
    ? `[triss/review] source=stdin bytes=${Buffer.byteLength(diff, 'utf8')} limits=bounded-stdin\n`
    : `[triss/review] bytes=${Buffer.byteLength(diff, 'utf8')} base=${baseRef} head=${headRef}\n`;
  process.stderr.write(pc.dim(diagnostic));

  // review acceptance: bounded single-request payload planning (Invariant — a payload
  // that cannot fit singleMaxBytes fails closed with a shard hint instead
  // of a silent clean verdict over truncated files).
  const limits = reviewLimitConfig().limits;
  const selectors = scopedSelectors;
  const parsedSections = parseUnifiedDiff(diff);
  if (parsedSections.error) {
    throw new Error(`failed to parse diff: ${parsedSections.error}`);
  }
  // Literal --files selection happens BEFORE planning (Invariant): the planner
  // sees only the requested sections, so an unrelated huge file in the same
  // change can no longer fail a small scoped review with single_max_exceeded.
  const selectedSections = selectors.length > 0
    ? parsedSections.sections.filter((s) => selectors.includes(s.new_path) || selectors.includes(s.old_path))
    : parsedSections.sections;
  // Byte-exactness: a selector-less review forwards the acquired diff
  // VERBATIM (a section rebuild would drop pre-header bytes like a BOM
  // line); only the scoped path uses the section-filtered rebuild.
  const selectedDiff = selectors.length > 0
    ? selectedSections.map((s) => s.raw).join('\n')
    : diff;
  // Coverage flows through executeSingleReview; requested-scope reporting
  // is derived there from the literal selectors.
  const plan = planSingleReviewPayload({
    sections: selectedSections,
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
        // Reasoning stays on stderr and the verdict on stdout. Combined
        // terminal output needs a visible boundary between them: the first
        // reasoning chunk opens a "[triss/review thinking]" line, chunks
        // concatenate on it (no per-chunk newlines), and exactly one newline
        // is written before the verdict — or before the no-verdict failure —
        // so the final content never joins the reasoning line. Streaming can
        // interleave reasoning and content, so a reasoning chunk that arrives
        // AFTER content has started is buffered instead of reopening the
        // marker in the middle of the verdict, and is emitted only once the
        // verdict line is complete. A partial streamed verdict line is
        // terminated so the error never joins it; usage reporting on the
        // final chunk preserves the same line invariants.
        let contentStarted = false;
        let reasoningOpen = false;
        let pendingReasoning = '';
        let stdoutLineOpen = false;
        const closeReasoning = () => {
          if (!reasoningOpen) return;
          process.stderr.write('\n');
          reasoningOpen = false;
        };
        const onReasoning = (d) => {
          if (contentStarted) { pendingReasoning += d; return; }
          if (!reasoningOpen) {
            process.stderr.write(pc.dim('[triss/review thinking]\n'));
            reasoningOpen = true;
          }
          process.stderr.write(pc.dim(d));
        };
        const flushPendingReasoning = () => {
          if (!pendingReasoning) return;
          process.stderr.write(pc.dim('[triss/review thinking]\n'));
          process.stderr.write(pc.dim(pendingReasoning) + '\n');
          pendingReasoning = '';
        };
        const terminatePartialStdout = () => {
          if (!stdoutLineOpen) return;
          process.stdout.write('\n');
          stdoutLineOpen = false;
        };
        let output;
        try {
          output = await execute({
            task: 'review',
            provider: opts.provider,
            model: opts.model,
            engine: opts.engine,
            effort: opts.effort,
            protectCredentials: opts.protectCredentials,
            signal: deps.signal,
            timeout: opts.timeoutMs,
            input: {
              maxOutputTokens: maxTokens,
              messages,
              stream: useStream,
              onText: useStream ? (d) => {
                if (!contentStarted) { contentStarted = true; closeReasoning(); }
                process.stdout.write(d);
                stdoutLineOpen = !String(d).endsWith('\n');
              } : undefined,
              onReasoning,
              outputContract: responseFormat,
              label: 'triss/review',
            },
          }, deps.runtimeDeps);
        } catch (error) {
          closeReasoning();
          terminatePartialStdout();
          flushPendingReasoning();
          throw error;
        }
        printModelResultWarnings(output.result, { color: pc.yellow });
        const out = output.result.text;
        if (!out || !out.trim()) {
          closeReasoning();
          terminatePartialStdout();
          flushPendingReasoning();
          const err = new Error(
            emptyReviewResponseMessage({
              finishReason: output.result.finishReason,
              explicitMaxTokens,
              labeled: true,
            }),
          );
          err.code = 'TRISS_PROVIDER_EMPTY';
          throw err;
        }
        if (useStream) {
          terminatePartialStdout();
          flushPendingReasoning();
          // Verdict already streamed; usage line handled below
          const usage = reportNormalizedUsage(output.result, 'triss/review');
          if (usage) process.stderr.write(pc.dim('\n' + usage + '\n'));
          return out;
        }
        // Non-streaming path: usage is emitted here; the verdict itself is
        // printed exactly once by the runReviewWithDeps tail (shouldStream check).
        closeReasoning();
        const usage = reportNormalizedUsage(output.result, 'triss/review');
        if (usage) process.stderr.write(pc.dim('\n' + usage + '\n'));
        return out;
      },
      limits,
    },
    {
      diff: selectedDiff,
      question: opts.question || DEFAULT_QUESTION,
      selectors,
      metadataBytes:
        Buffer.byteLength(changeCorpus, 'utf8') + Buffer.byteLength(ticketCorpus, 'utf8'),
    },
  );

  if (!singleResult.ok) {
    // Provider/empty failures are typed rejections so programmatic callers
    // (and the PR's REV-GLM-THINK-* tests) can classify and retry on the
    // stable code. Limit/scope/parse failures remain a structured return
    // with an exit code so the CLI can print and exit without throwing.
    const providerFailure =
      singleResult.code === 'TRISS_PROVIDER_EMPTY' ||
      singleResult.code === 'TRISS_PROVIDER_UNKNOWN' ||
      (typeof singleResult.code === 'string' && singleResult.code.startsWith('TRISS_PROVIDER_')) ||
      singleResult.code === 'TRISS_CANCELLED';
    if (providerFailure) {
      // Preserve the original provider error (sentinel) when available so
      // terminal-invariant tests (REV-GLM-THINK-12..17) see `error === sentinel`.
      // Fall through to a synthetic typed error only when no cause survived
      // the executor (e.g. a bare emptyResponseMessage).
      const cause = singleResult.cause;
      if (cause && cause instanceof Error) {
        // Do not mutate a frozen/sealed cause — attaching properties would throw
        // TypeError and obscure the provider failure. Try to attach safely;
        // if the object is not extensible, wrap it instead.
        let attached = true;
        if (!Object.isExtensible(cause)) attached = false;
        else {
          try {
            if (!cause.code && singleResult.code) cause.code = singleResult.code;
          } catch { attached = false; }
          try {
            if (cause.exit === undefined && singleResult.exit !== undefined) cause.exit = singleResult.exit;
          } catch { attached = false; }
        }
        if (attached) throw cause;
        const wrapped = new Error(cause.message || singleResult.message || singleResult.code);
        wrapped.code = singleResult.code;
        if (singleResult.exit !== undefined) wrapped.exit = singleResult.exit;
        wrapped.cause = cause;
        throw wrapped;
      }
      const err = new Error(singleResult.message || singleResult.code);
      err.code = singleResult.code;
      if (singleResult.exit !== undefined) err.exit = singleResult.exit;
      throw err;
    }
    process.stderr.write(pc.dim(`✗ ${singleResult.message || singleResult.code}\n`));
    process.exitCode = singleResult.exit ?? REVIEW_EXIT_CODES.provider;
    return undefined;
  }
  // Scoped reviews surface their honest coverage on stderr (stdout stays the
  // verdict only): a partial scope must never read as a full clean review.
  if (singleResult.coverage?.requested) {
    const req = singleResult.coverage.requested;
    process.stderr.write(pc.dim(
      `[triss/review] scope: ${req.coverage} — ${req.matched.length}/${req.matched.length + req.unmatched.length} requested file(s) reviewed\n`,
    ));
  }
  // When streaming, the verdict was already printed chunk-by-chunk; printing
  // it again would duplicate the full text on stdout.
  if (!shouldStream(opts)) {
    process.stdout.write(singleResult.verdict + '\n');
  }
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

// Extract a ticket key from a LOCAL branch name only (review acceptance: PR prose
// never triggers tracker access; the branch name is operator-chosen, not
// attacker-controlled PR text).
function branchTicketKey(headRef) {
  if (typeof headRef !== 'string') return '';
  const m = /([A-Z][A-Z0-9]+-\d+)/.exec(headRef);
  return m ? m[1] : '';
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import pc from 'picocolors';
import { executeModelTask } from '../model-runtime.js';
import { reportNormalizedUsage } from '../model-usage.js';
import { assertProviderText } from '../provider-errors.js';
import { expandPaths, readFilesAsCorpus } from '../paths.js';
import { fetchAsMarkdown } from '../web.js';
import { readStdin } from '../secrets.js';
import { shouldStream } from './chat.js';
import { validateResponseFormat, withEvidenceInstructions } from '../response-format.js';
import { positiveIntegerOption } from '../option-validation.js';

const SYSTEM_PROMPT =
  'You are a precise code/document analyst. Read the provided sources and ' +
  'answer the question concisely. Quote file paths, line numbers, or URLs ' +
  'when relevant. Output structured bullets, not prose. Keep your answer ' +
  'under 800 words unless asked otherwise.';

// Commander passes its Command instance as a second action argument. Keep the
// production entrypoint opts-only so that instance can never be mistaken for
// injectable dependencies.
export async function runAsk(opts) {
  return runAskWithDeps(opts);
}

export function validateAskOptions(opts, { checkTty = true } = {}) {
  const responseFormat = validateResponseFormat(opts.format);
  const maxTokens = positiveIntegerOption(opts.maxTokens, '--max-tokens', 8192);
  if (!opts.question) throw new Error('--question is required');
  if (!opts.paths?.length && !opts.urls?.length && !opts.stdin) {
    throw new Error('Pass at least one of --paths, --urls, or --stdin');
  }
  if (checkTty && opts.stdin && process.stdin.isTTY) {
    throw new Error(
      '--stdin requires piped input. Try: cmd | triss ask --stdin --question "..."',
    );
  }
  return { responseFormat, maxTokens };
}

// Test-only seam for deterministic model-call assertions.
export async function runAskWithDeps(opts, deps = {}) {
  const { responseFormat, maxTokens } = validateAskOptions(opts);
  const {
    paths,
    urls,
    stdin,
    question,
    model,
    provider,
    engine,
    effort,
    protectCredentials,
    system,
  } = opts;
  const execute = deps.executeModelTask || executeModelTask;

  let corpus = '';
  let fileCount = 0;
  let totalBytes = 0;
  let hasUsableContext = false;
  if (paths?.length) {
    const expanded = expandPaths(paths);
    const fileResult = readFilesAsCorpus(expanded);
    corpus += fileResult.corpus;
    fileCount += fileResult.fileCount;
    totalBytes += fileResult.totalBytes;
    hasUsableContext ||= fileResult.readFileCount > 0;
  }

  if (urls?.length) {
    const parts = [];
    for (const u of urls) {
      process.stderr.write(pc.dim(`[triss/ask] GET ${u}\n`));
      const { url, markdown, contentType } = await fetchAsMarkdown(u);
      parts.push(`<source url="${url}" content-type="${contentType}">\n${markdown}\n</source>`);
      totalBytes += markdown.length;
      hasUsableContext ||= Boolean(markdown);
    }
    if (parts.length) corpus += (corpus ? '\n\n' : '') + parts.join('\n\n');
    fileCount += urls.length;
  }

  if (stdin) {
    process.stderr.write(pc.dim('[triss/ask] reading stdin…\n'));
    const stdinText = await readStdin();
    if (stdinText) {
      corpus += (corpus ? '\n\n' : '') + `<source kind="stdin">\n${stdinText}\n</source>`;
      totalBytes += stdinText.length;
      fileCount += 1;
      hasUsableContext = true;
    }
  }

  if (paths?.length && !hasUsableContext) {
    throw new Error(
      'No readable file content was collected from --paths. Pass files or a glob such as "src/**/*.js"; ' +
      'directories are not read recursively.',
    );
  }

  process.stderr.write(
    pc.dim(`[triss/ask] sources=${fileCount} bytes=${totalBytes}\n`),
  );

  const messages = [
    { role: 'system', content: withEvidenceInstructions(system || SYSTEM_PROMPT, responseFormat) },
    { role: 'user', content: `<corpus>\n${corpus}\n</corpus>` },
    { role: 'user', content: question },
  ];

  const useStream = shouldStream(opts);
  const { resolved, result } = await execute({
    task: 'ask',
    provider,
    model,
    engine,
    effort,
    protectCredentials,
    signal: deps.signal,
    timeout: opts.timeoutMs,
    input: {
      messages,
      maxOutputTokens: maxTokens,
      stream: useStream,
      onText: useStream ? (chunk) => process.stdout.write(chunk) : undefined,
      onReasoning: deps.onReasoning,
      outputContract: responseFormat,
      label: 'triss/ask',
    },
  }, deps.runtimeDeps);
  const answer = assertProviderText(result.text);
  // Warnings (e.g. best-effort projection limitations) go to stderr only;
  // stdout keeps its machine-readable/text contract.
  for (const warning of result.warnings || []) {
    process.stderr.write(pc.yellow(`  ⚠ ${warning}\n`));
  }
  if (!useStream) process.stdout.write(answer + '\n');
  else process.stdout.write('\n');
  process.stderr.write(
    pc.dim(
      `\n${reportNormalizedUsage(result, 'triss/ask')} provider=${resolved.providerId} model=${resolved.publicModel}\n`,
    ),
  );
  return answer;
}

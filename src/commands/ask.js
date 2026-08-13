import pc from 'picocolors';
import { chat, chatStream, reportUsage, responseText } from '../client.js';
import { resolveModelRequest } from '../models.js';
import { expandPaths, readFilesAsCorpus } from '../paths.js';
import { fetchAsMarkdown } from '../web.js';
import { readStdin } from '../secrets.js';
import { shouldStream } from './chat.js';
import { validateResponseFormat, withEvidenceInstructions } from '../response-format.js';
import { positiveIntegerOption } from '../option-validation.js';
import { EmptyModelResponseError } from '../errors.js';

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
    model: modelInput,
    provider: providerInput,
    system,
  } = opts;
  // Same default the direct `triss ask` CLI applies (its --max-tokens
  // option defaults to 8192). A routed ask without --max-tokens must behave
  // identically to a direct ask, mirroring review.js's own default.
  const resolveRequest = deps.resolveModelRequest || resolveModelRequest;
  const sendChat = deps.chat || chat;
  const sendChatStream = deps.chatStream || chatStream;
  const request = resolveRequest({ provider: providerInput, model: modelInput });
  const { provider, model } = request;

  let corpus = '';
  let fileCount = 0;
  let totalBytes = 0;

  if (paths?.length) {
    const expanded = expandPaths(paths);
    const fileResult = readFilesAsCorpus(expanded);
    corpus += fileResult.corpus;
    fileCount += fileResult.fileCount;
    totalBytes += fileResult.totalBytes;
  }

  if (urls?.length) {
    const parts = [];
    for (const u of urls) {
      process.stderr.write(pc.dim(`[triss/ask] GET ${u}\n`));
      const { url, markdown, contentType } = await fetchAsMarkdown(u);
      parts.push(`<source url="${url}" content-type="${contentType}">\n${markdown}\n</source>`);
      totalBytes += markdown.length;
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
    }
  }

  process.stderr.write(
    pc.dim(
      `[triss/ask] provider=${provider} model=${model} sources=${fileCount} bytes=${totalBytes}\n`,
    ),
  );

  const messages = [
    { role: 'system', content: withEvidenceInstructions(system || SYSTEM_PROMPT, responseFormat) },
    { role: 'user', content: `<corpus>\n${corpus}\n</corpus>` },
    { role: 'user', content: question },
  ];

  const useStream = shouldStream(opts);
  const resp = useStream
    ? await sendChatStream({
        ...request,
        maxTokens,
        messages,
        label: 'triss/ask',
        onChunk: (d) => process.stdout.write(d),
      })
    : await sendChat({ ...request, maxTokens, messages, label: 'triss/ask' });

  const answer = responseText(resp);
  if (!answer) {
    throw new EmptyModelResponseError(
      '[triss/ask] empty response — the model returned no final text. ' +
        'Retry with a smaller source payload or a different provider; this is not a successful result.',
    );
  }
  if (!useStream) process.stdout.write(answer + '\n');
  else process.stdout.write('\n');
  process.stderr.write(pc.dim('\n' + reportUsage(resp, 'triss/ask', { provider: request.provider }) + '\n'));
  return answer;
}

import pc from 'picocolors';
import { chat, reportUsage } from '../client.js';
import { resolveModel } from '../models.js';
import { expandPaths, readFilesAsCorpus } from '../paths.js';
import { fetchAsMarkdown } from '../web.js';
import { readStdin } from '../secrets.js';

const SYSTEM_PROMPT =
  'You are a precise code/document analyst. Read the provided sources and ' +
  'answer the question concisely. Quote file paths, line numbers, or URLs ' +
  'when relevant. Output structured bullets, not prose. Keep your answer ' +
  'under 800 words unless asked otherwise.';

export async function runAsk(opts) {
  const { paths, urls, stdin, question, maxTokens, model: modelInput, system } = opts;
  if (!question) throw new Error('--question is required');
  if (!paths?.length && !urls?.length && !stdin) {
    throw new Error('Pass at least one of --paths, --urls, or --stdin');
  }
  if (stdin && process.stdin.isTTY) {
    throw new Error(
      '--stdin requires piped input. Try: cmd | triss ask --stdin --question "..."',
    );
  }

  const model = resolveModel(modelInput);

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
    pc.dim(`[triss/ask] model=${model} sources=${fileCount} bytes=${totalBytes}\n`),
  );

  const resp = await chat({
    model,
    maxTokens,
    messages: [
      { role: 'system', content: system || SYSTEM_PROMPT },
      { role: 'user', content: `<corpus>\n${corpus}\n</corpus>` },
      { role: 'user', content: question },
    ],
  });

  const answer = resp.choices?.[0]?.message?.content;
  if (!answer) {
    process.stderr.write(
      pc.red(
        '[triss/ask] empty response — model may have run out of tokens during reasoning. ' +
          'Try --max-tokens 16384.\n',
      ),
    );
    process.exit(1);
  }
  process.stdout.write(answer + '\n');
  process.stderr.write(pc.dim('\n' + reportUsage(resp, 'triss/ask') + '\n'));
}

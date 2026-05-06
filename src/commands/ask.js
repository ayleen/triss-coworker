import pc from 'picocolors';
import { chat, reportUsage } from '../client.js';
import { resolveModel } from '../models.js';
import { expandPaths, readFilesAsCorpus } from '../paths.js';

const SYSTEM_PROMPT =
  'You are a precise code/document analyst. Read the provided files and ' +
  'answer the question concisely. Quote file paths and line numbers when ' +
  'relevant. Output structured bullets, not prose. Keep your answer under ' +
  '800 words unless asked otherwise.';

export async function runAsk(opts) {
  const { paths, question, maxTokens, model: modelInput, system } = opts;
  if (!paths?.length) throw new Error('--paths is required (one or more files or globs)');
  if (!question) throw new Error('--question is required');

  const model = resolveModel(modelInput);
  const expanded = expandPaths(paths);
  const { corpus, totalBytes, fileCount } = readFilesAsCorpus(expanded);

  process.stderr.write(
    pc.dim(`[triss/ask] model=${model} files=${fileCount} bytes=${totalBytes}\n`),
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

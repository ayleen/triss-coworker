// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import pc from 'picocolors';
import { fetchAsMarkdown } from '../web.js';
import { summarize, printResult } from '../integrations/_contract.js';
import { positiveIntegerOption } from '../option-validation.js';

export async function runFetch(urls, opts) {
  const maxTokens = positiveIntegerOption(opts.maxTokens, '--max-tokens', 4096);
  if (!urls?.length) throw new Error('Pass at least one URL');
  const corpus = [];
  for (const u of urls) {
    process.stderr.write(pc.dim(`[triss/fetch] GET ${u}\n`));
    const { url, markdown, contentType } = await fetchAsMarkdown(u, {
      timeoutMs: parseInt(opts.timeout, 10) || 30000,
    });
    corpus.push(`<source url="${url}" content-type="${contentType}">\n${markdown}\n</source>`);
  }

  if (opts.json) {
    return printResult(
      corpus.map((c, i) => ({ url: urls[i], markdown: c })),
      { json: true },
    );
  }

  const joined = corpus.join('\n\n');
  if (opts.question) {
    const out = await summarize({
      corpus: joined,
      question: opts.question,
      model: opts.model,
      maxTokens,
    });
    printResult(out);
  } else {
    printResult(joined);
  }
}

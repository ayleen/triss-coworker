import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pc from 'picocolors';
import { chat, reportUsage } from '../client.js';
import { resolveModel } from '../models.js';

const SYSTEM_PROMPT =
  'Generate clean, idiomatic code matching the style of any reference ' +
  'provided. No explanations, no markdown fences — output ONLY the file ' +
  'contents.';

export async function runWrite(opts) {
  const { spec, context, target, maxTokens, model: modelInput } = opts;
  if (!spec) throw new Error('--spec is required');
  if (!target) throw new Error('--target is required');

  const model = resolveModel(modelInput);
  const ctx = context ? `<reference path='${context}'>\n${readFileSync(context, 'utf8')}\n</reference>\n` : '';

  process.stderr.write(pc.dim(`[triss/write] model=${model} target=${target}\n`));

  const resp = await chat({
    model,
    maxTokens,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `${ctx}Write: ${spec}` },
    ],
  });

  let content = resp.choices?.[0]?.message?.content;
  if (!content) {
    process.stderr.write(
      pc.red('[triss/write] empty response — try --max-tokens 32768\n'),
    );
    process.exit(1);
  }
  content = stripFences(content);

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  process.stderr.write(pc.dim(`Wrote ${target} (${content.length} chars)\n`));
  process.stderr.write(pc.dim(reportUsage(resp, 'triss/write') + '\n'));
}

function stripFences(s) {
  const trimmed = s.trim();
  if (!trimmed.startsWith('```')) return s;
  const firstNl = trimmed.indexOf('\n');
  if (firstNl === -1) return s;
  const body = trimmed.slice(firstNl + 1);
  const lastFence = body.lastIndexOf('```');
  return lastFence === -1 ? body : body.slice(0, lastFence);
}

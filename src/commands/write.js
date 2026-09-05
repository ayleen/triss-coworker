// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import pc from 'picocolors';
import { executeModelTask, printModelResultWarnings } from '../model-runtime.js';
import { reportNormalizedUsage } from '../model-usage.js';
import { assertSafePath } from '../safety.js';
import { positiveIntegerOption } from '../option-validation.js';

const SYSTEM_PROMPT =
  'Generate clean, idiomatic code matching the style of any reference ' +
  'provided. No explanations, no markdown fences — output ONLY the file ' +
  'contents.';

export async function runWrite(opts) {
  return runWriteWithDeps(opts);
}

export async function runWriteWithDeps(opts, deps = {}) {
  const { spec, context, target, maxTokens } = opts;
  if (!spec) throw new Error('--spec is required');
  if (!target) throw new Error('--target is required');
  const validatedMaxTokens = positiveIntegerOption(maxTokens, '--max-tokens', 16384);

  assertSafePath(target, { kind: 'write' });
  if (context) assertSafePath(context, { kind: 'read' });

  const ctx = context ? `<reference path='${context}'>\n${readFileSync(context, 'utf8')}\n</reference>\n` : '';
  const execute = deps.executeModelTask || executeModelTask;

  const output = await execute({
    task: 'write',
    provider: opts.provider,
    model: opts.model,
    engine: opts.engine,
    effort: opts.effort,
    protectCredentials: opts.protectCredentials,
    signal: deps.signal,
    timeout: opts.timeoutMs,
    input: {
      maxOutputTokens: validatedMaxTokens,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `${ctx}Write: ${spec}` },
      ],
      label: 'triss/write',
    },
  }, deps.runtimeDeps);
  process.stderr.write(
    pc.dim(
      `[triss/write] provider=${output.resolved.providerId} model=${output.resolved.publicModel} target=${target}\n`,
    ),
  );
  printModelResultWarnings(output.result, { color: pc.yellow });
  let content = output.result.text;

  if (!content) throw new Error('[triss/write] model returned empty content — try --max-tokens 32768');
  content = stripFences(content);

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  process.stderr.write(pc.dim(`Wrote ${target} (${content.length} chars)\n`));
  process.stderr.write(pc.dim(reportNormalizedUsage(output.result, 'triss/write') + '\n'));
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

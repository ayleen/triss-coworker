import { readFileSync, writeFileSync } from 'node:fs';
import pc from 'picocolors';
import { assertSafePath } from '../safety.js';

export function runExtract({ jsonl, output }) {
  if (!jsonl) throw new Error('JSONL path is required');
  assertSafePath(jsonl, { kind: 'read' });
  if (output) assertSafePath(output, { kind: 'write' });
  const text = extract(jsonl);
  if (output) {
    writeFileSync(output, text);
    const lines = text.split('\n').length;
    process.stderr.write(
      pc.dim(`Wrote ${lines} lines (${text.length} chars) to ${output}\n`),
    );
  } else {
    process.stdout.write(text + '\n');
  }
}

function extract(jsonlPath) {
  const raw = readFileSync(jsonlPath, 'utf8');
  const messages = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const type = msg.type;
    if (type !== 'user' && type !== 'assistant') continue;

    const inner = msg.message ?? {};
    const role = inner.role ?? type;
    const content = inner.content ?? '';
    const ts = msg.timestamp ?? '';

    const texts = [];
    if (typeof content === 'string') {
      const t = content.trim();
      if (t) texts.push(t);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && block.type === 'text') {
          const t = (block.text ?? '').trim();
          if (t) texts.push(t);
        }
      }
    }

    if (texts.length) {
      const tag = ts ? ` (${ts})` : '';
      messages.push(`[${String(role).toUpperCase()}]${tag}:\n${texts.join('\n')}`);
    }
  }
  return messages.join('\n\n---\n\n');
}

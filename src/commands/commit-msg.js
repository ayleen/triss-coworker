import { spawnSync } from 'node:child_process';
import pc from 'picocolors';
import { chat, reportUsage } from '../client.js';
import { resolveModel } from '../models.js';
import { git } from '../git.js';

const CONVENTIONAL_SYSTEM = `You are a senior engineer writing a Git commit
message in Conventional Commits format. Output only the message itself —
no explanation, no markdown fences, no surrounding quotes.

Format:
- First line: <type>(<optional scope>): <imperative summary, ≤ 72 chars>
- Blank line
- Body (optional): wrap at 72 chars; explain *why* not *what*; bullet
  list if there are multiple distinct changes; reference issue keys if
  they appear in the diff.

Allowed types: feat, fix, refactor, docs, test, chore, perf, ci, build, style.
Pick the type that best matches the dominant change. Do not invent types.`;

const PLAIN_SYSTEM = `You are a senior engineer writing a Git commit
message. Output only the message itself — no explanation, no markdown
fences, no surrounding quotes.

Format: short imperative subject line (≤72 chars), blank line, then
optional body wrapped at 72 chars explaining *why*.`;

export async function runCommitMsg(opts) {
  const diff = git(['diff', '--staged']);
  if (!diff.trim()) {
    throw new Error(
      'Nothing staged. Run `git add <paths>` first, or use `--include-unstaged` to draft from working-tree changes.',
    );
  }

  const stat = git(['diff', '--staged', '--stat']);
  const fileList = git(['diff', '--staged', '--name-only']).trim().split('\n').filter(Boolean);

  const conventional = opts.noConventional ? false : true;
  const system = conventional ? CONVENTIONAL_SYSTEM : PLAIN_SYSTEM;

  const hints = [];
  if (opts.type) hints.push(`Force the type to "${opts.type}".`);
  if (opts.scope) hints.push(`Use the scope "${opts.scope}".`);

  const userPrompt = [
    `Files changed:\n${fileList.join('\n')}`,
    `\nDiffstat:\n${stat.trim()}`,
    hints.length ? `\nGuidance:\n- ${hints.join('\n- ')}` : '',
    `\nFull diff:\n${diff}`,
    `\nWrite the commit message now.`,
  ]
    .filter(Boolean)
    .join('\n');

  const model = resolveModel(opts.model);
  process.stderr.write(pc.dim(`[triss/commit-msg] model=${model} files=${fileList.length}\n`));

  const resp = await chat({
    model,
    maxTokens: parseInt(opts.maxTokens, 10) || 2048,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ],
    label: 'triss/commit-msg',
  });

  let message = resp.choices?.[0]?.message?.content?.trim() || '';
  if (!message) throw new Error('Worker returned empty message — try larger --max-tokens');
  // Defensive: strip accidental triple-backtick fences if the model adds them.
  if (message.startsWith('```')) {
    message = message.replace(/^```[a-z]*\n?/, '').replace(/```$/, '').trim();
  }

  if (opts.apply) {
    const r = spawnSync('git', ['commit', '-m', message], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('git commit failed');
    process.stderr.write(pc.dim('\n' + reportUsage(resp, 'triss/commit-msg') + '\n'));
    return;
  }

  process.stdout.write(message + '\n');
  process.stderr.write(pc.dim('\n' + reportUsage(resp, 'triss/commit-msg') + '\n'));

  if (opts.print) {
    process.stderr.write(
      pc.dim('\nTo apply: `git commit -m "<paste above>"` or run again with `--apply`.\n'),
    );
  }
}

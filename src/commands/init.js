import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import pc from 'picocolors';
import { getConfig } from '../config.js';
import { loadIntegrations, envReadiness } from '../integrations/_registry.js';
import { runWizard } from './config.js';
import { promptChoice } from '../secrets.js';
import {
  TARGETS,
  SUPPORTED_TARGETS,
  START_MARKER,
  END_MARKER,
  renderRules,
} from '../agent-rules.js';

const SUPPORTED = [...SUPPORTED_TARGETS, 'both'];

export async function runInit(opts) {
  let raw = opts.target ? String(opts.target).toLowerCase() : '';
  if (!raw) raw = await chooseTarget();
  if (!SUPPORTED.includes(raw)) {
    throw new Error(`Unknown --target "${raw}". Supported: ${SUPPORTED.join(', ')}`);
  }

  const targets = raw === 'both' ? [...SUPPORTED_TARGETS] : [raw];
  for (const t of targets) {
    await writeAgentRules(t, opts);
  }

  await postInit(opts);
}

async function chooseTarget() {
  // Non-interactive shell (CI / pipes / hooks): preserve historical default.
  if (!process.stdin.isTTY) return 'claude';
  return promptChoice(
    'Where should triss install its agent rules?',
    [
      { label: 'Claude — CLAUDE.md', value: 'claude' },
      { label: 'Codex  — AGENTS.md', value: 'codex' },
      { label: 'Both   — CLAUDE.md and AGENTS.md', value: 'both' },
    ],
    { defaultIndex: 0 },
  );
}

async function writeAgentRules(target, opts) {
  const meta = TARGETS[target];
  // `init` writes the nano variant — the always-loaded block stays small.
  // Full reference is on demand via `triss agent-help`.
  const block = (await renderRules(target, { variant: 'nano' })).trim();
  const wrapped = `${START_MARKER}\n${block}\n${END_MARKER}\n`;

  const destPath = opts.global
    ? join(homedir(), meta.globalDir, meta.filename)
    : join(process.cwd(), meta.filename);

  mkdirSync(dirname(destPath), { recursive: true });

  if (!existsSync(destPath)) {
    writeFileSync(destPath, wrapped);
    process.stdout.write(pc.green(`✓ Created ${destPath}\n`));
    return;
  }
  const existing = readFileSync(destPath, 'utf8');
  if (existing.includes(START_MARKER) && existing.includes(END_MARKER)) {
    const replaced = replaceBlock(existing, wrapped);
    if (replaced === existing) {
      process.stdout.write(pc.dim(`= ${destPath} already up to date\n`));
    } else {
      writeFileSync(destPath, replaced);
      process.stdout.write(
        pc.cyan(`${opts.force ? '↻ Force-updated' : '↻ Updated'} triss block in ${destPath}\n`),
      );
    }
  } else {
    const sep = existing.endsWith('\n') ? '\n' : '\n\n';
    writeFileSync(destPath, existing + sep + wrapped);
    process.stdout.write(pc.green(`+ Appended triss block to ${destPath}\n`));
  }
}

async function postInit(opts) {
  if (opts.setup) {
    process.stdout.write('\n' + pc.bold('Running setup wizard…') + '\n');
    // Don't conflate the `init` scope (where to write agent rules) with the
    // `wizard` scope (where to write env files). Let the wizard ask
    // (or default to global silently in non-TTY).
    await runWizard(undefined, {});
    return;
  }

  // Auto-detect missing credentials and print friendly next-step hints.
  const cfg = getConfig();
  const integrations = await loadIntegrations();
  const tips = [];

  if (!cfg.apiKey) {
    tips.push({
      level: 'warn',
      msg: 'Worker API key is not set — required for `triss ask`/`triss write`.',
      cmd: 'triss config wizard worker',
    });
  }

  for (const m of integrations) {
    const r = envReadiness(m);
    if (!r.ready) {
      tips.push({
        level: 'info',
        msg: `Integration "${m.name}" is missing: ${r.missing.join(', ')}`,
        cmd: `triss config wizard ${m.name}`,
      });
    }
  }

  if (tips.length) {
    process.stdout.write('\n');
    for (const t of tips) {
      const tag = t.level === 'warn' ? pc.yellow('⚠') : pc.dim('·');
      process.stdout.write(`  ${tag} ${t.msg}\n`);
      process.stdout.write(`     → ${pc.cyan(t.cmd)}\n`);
    }
    process.stdout.write(
      '\n' + pc.dim('  Tip: ') + pc.cyan('triss init --setup') + pc.dim(' creates the file and runs the wizard in one go.\n'),
    );
  }
}

// Re-export the helper for tests.
export { postInit as _postInit };

function replaceBlock(text, replacement) {
  const start = text.indexOf(START_MARKER);
  const end = text.indexOf(END_MARKER, start);
  if (start === -1 || end === -1) return text;
  const tail = end + END_MARKER.length;
  // Trim a trailing newline from the original block to avoid duplicates.
  const before = text.slice(0, start);
  const after = text.slice(tail).replace(/^\n+/, '');
  return `${before}${replacement.trimEnd()}\n${after}`;
}

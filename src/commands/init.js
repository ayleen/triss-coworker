import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { getConfig } from '../config.js';
import { loadIntegrations, envReadiness, getCoreManifest } from '../integrations/_registry.js';
import { runWizard } from './config.js';
import { showStatus as mcpStatus } from '../mcp/install.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = resolve(HERE, '..', '..', 'templates');

const START_MARKER = '<!-- triss:start -->';
const END_MARKER = '<!-- triss:end -->';

const TARGETS = {
  claude: { template: 'claude.md', filename: 'CLAUDE.md', globalDir: '.claude' },
  // Reserved for future support — codex/agents.md, etc.
  codex: { template: 'codex.md', filename: 'AGENTS.md', globalDir: '.codex' },
};

export async function runInit(opts) {
  const target = (opts.target || 'claude').toLowerCase();
  const meta = TARGETS[target];
  if (!meta) {
    throw new Error(`Unknown --target "${target}". Supported: ${Object.keys(TARGETS).join(', ')}`);
  }

  const templatePath = join(TEMPLATE_DIR, meta.template);
  if (!existsSync(templatePath)) {
    throw new Error(`Template not found for target "${target}" at ${templatePath}`);
  }
  const rawTemplate = readFileSync(templatePath, 'utf8');
  const block = (await renderTemplate(rawTemplate, target)).trim();
  const wrapped = `${START_MARKER}\n${block}\n${END_MARKER}\n`;

  const destPath = opts.global
    ? join(homedir(), meta.globalDir, meta.filename)
    : join(process.cwd(), meta.filename);

  mkdirSync(dirname(destPath), { recursive: true });

  if (!existsSync(destPath)) {
    writeFileSync(destPath, wrapped);
    process.stdout.write(pc.green(`✓ Created ${destPath}\n`));
  } else {
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

  await postInit(opts);
}

async function postInit(opts) {
  if (opts.setup) {
    process.stdout.write('\n' + pc.bold('Running setup wizard…') + '\n');
    // Don't conflate the `init` scope (where to write CLAUDE.md) with the
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
      msg: 'DeepSeek API key is not set — required for `triss ask`/`triss write`.',
      cmd: 'triss config wizard deepseek',
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

// Render the {{INTEGRATIONS}} placeholder. Two layers:
//   1. If the MCP server is registered in Claude Code config, prepend a hint
//      that the same operations are also available as native MCP tools so
//      the agent prefers those.
//   2. Splice in agentInstructions snippets from each integration whose
//      required env vars are all set (so users who don't use Linear never
//      see Linear instructions).
async function renderTemplate(raw, target) {
  if (!raw.includes('{{INTEGRATIONS}}')) return raw;
  const integrations = await loadIntegrations();
  const active = integrations.filter((m) => envReadiness(m).ready && m.agentInstructions?.[target]);

  let mcpHint = '';
  try {
    const { present } = mcpStatus('global');
    if (present) {
      mcpHint =
        '\n> 💡 **Triss is also available as MCP tools in this Claude Code session.**\n' +
        '> Native tools — `triss_ask`, `triss_chat`, `triss_review`, `triss_jira_*`,\n' +
        '> `triss_linear_*` etc. — are usually faster and have per-tool permissions.\n' +
        '> Prefer them over the Bash invocations described below; the CLI block stays\n' +
        '> as a fallback if MCP is not loaded.\n\n';
    }
  } catch {
    /* ~/.claude.json unreadable — silently fall back to CLI-only block */
  }

  let block;
  if (!active.length && !mcpHint) {
    block = '';
  } else {
    const integrationsBody = active.length
      ? '\n## Integrations enabled for this project\n\n' +
        active.map((m) => m.agentInstructions[target].trim()).join('\n\n') +
        '\n\n'
      : '';
    block = mcpHint + integrationsBody;
  }
  return raw.replace(/\{\{INTEGRATIONS\}\}\n?/g, block);
}

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

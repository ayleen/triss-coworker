// Shared agent-rules rendering. Used by `triss init` (writes the nano block
// into CLAUDE.md / AGENTS.md) and by `triss agent-help` (prints the full
// cookbook on demand). The split keeps the always-loaded block tiny while
// still letting agents pull the long reference once they need it.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFiles } from './config.js';
import { loadIntegrations, envReadiness } from './integrations/_registry.js';
import { showStatus as mcpStatus } from './mcp/install.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = resolve(HERE, '..', 'templates');

export const START_MARKER = '<!-- triss:start -->';
export const END_MARKER = '<!-- triss:end -->';

export const TARGETS = {
  claude: {
    template: 'claude.md',
    fullTemplate: 'claude-full.md',
    filename: 'CLAUDE.md',
    globalDir: '.claude',
  },
  codex: {
    template: 'codex.md',
    fullTemplate: 'codex-full.md',
    filename: 'AGENTS.md',
    globalDir: '.codex',
  },
};

export const SUPPORTED_TARGETS = Object.keys(TARGETS);

export async function renderRules(target, { variant = 'nano' } = {}) {
  const meta = TARGETS[target];
  if (!meta) throw new Error(`Unknown target: ${target}`);
  const file = variant === 'full' ? meta.fullTemplate : meta.template;
  const path = join(TEMPLATE_DIR, file);
  if (!existsSync(path)) {
    throw new Error(`Template not found for target "${target}" (${variant}) at ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  return renderTemplate(raw, target);
}

// Render the {{INTEGRATIONS}} placeholder. Two layers:
//   1. If the MCP server is registered, prepend a hint that the same
//      operations are also available as native MCP tools so the agent
//      prefers those over the CLI block.
//   2. Splice in agentInstructions snippets from each integration whose
//      required env vars are all set (so users who don't use Linear never
//      see Linear instructions).
//
// The nano templates intentionally do NOT include {{INTEGRATIONS}} —
// rendering on them is a no-op and returns the raw text.
async function renderTemplate(raw, target) {
  if (!raw.includes('{{INTEGRATIONS}}')) return raw;
  // envReadiness() only inspects process.env. Load Triss env files first so
  // integrations whose credentials live in ~/.config/triss/.env or
  // ./.triss.env (i.e. the wizard-installed default) are detected as ready.
  loadEnvFiles();
  const integrations = await loadIntegrations();
  const active = integrations.filter(
    (m) => envReadiness(m).ready && m.agentInstructions?.[target],
  );

  let mcpHint = '';
  try {
    const { present } = mcpStatus('global', { target });
    if (present) {
      const sessionLabel = target === 'codex' ? 'Codex' : 'Claude Code';
      mcpHint =
        `\n> 💡 **Triss is also available as MCP tools in this ${sessionLabel} session.**\n` +
        '> Native tools — `triss_ask`, `triss_chat`, `triss_review`, `triss_jira_*`,\n' +
        '> `triss_linear_*` etc. — are usually faster and have per-tool permissions.\n' +
        '> Prefer them over the Bash invocations described below; the CLI block stays\n' +
        '> as a fallback if MCP is not loaded.\n\n';
    }
  } catch {
    /* config unreadable — silently fall back to CLI-only block */
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

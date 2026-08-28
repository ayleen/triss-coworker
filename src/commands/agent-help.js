// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Print the full Triss delegation cookbook to stdout. The nano block in
// CLAUDE.md / AGENTS.md points here so the agent loads the long reference
// only when it actually needs to look something up — saving the per-session
// token cost of always-loaded full instructions.

import { renderRules, SUPPORTED_TARGETS } from '../agent-rules.js';

export async function runAgentHelp(opts = {}) {
  const target = (opts.target || 'claude').toLowerCase();
  if (!SUPPORTED_TARGETS.includes(target)) {
    throw new Error(
      `Unknown --target "${target}". Supported: ${SUPPORTED_TARGETS.join(', ')}`,
    );
  }
  const rendered = await renderRules(target, { variant: 'full' });
  process.stdout.write(rendered);
  if (!rendered.endsWith('\n')) process.stdout.write('\n');
}

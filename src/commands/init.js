// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import pc from 'picocolors';
import { readProviderConfigSnapshot } from '../provider-config.js';
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
import {
  planManagedPath,
  validateFileTransaction,
  applyFileTransaction,
} from '../marker-transaction.js';

const SUPPORTED = [...SUPPORTED_TARGETS, 'both'];

export async function runInit(opts) {
  let raw = opts.target ? String(opts.target).toLowerCase() : '';
  if (!raw) raw = await chooseTarget();
  if (!SUPPORTED.includes(raw)) {
    throw new Error(`Unknown --target "${raw}". Supported: ${SUPPORTED.join(', ')}`);
  }

  const targets = raw === 'both' ? [...SUPPORTED_TARGETS] : [raw];
  const plans = [];
  for (const t of targets) {
    const meta = TARGETS[t];
    const block = (await renderRules(t, { variant: 'nano' })).trim();
    const wrapped = `${START_MARKER}\n${block}\n${END_MARKER}\n`;
    const destPath = opts.global
      ? join(homedir(), meta.globalDir, meta.filename)
      : join(process.cwd(), meta.filename);
    // All marker validation and reads happen before any destination is written.
    plans.push(planManagedPath(destPath, wrapped));
  }
  // This call protects the pre-mkdir boundary. applyFileTransaction repeats
  // the check as defense in depth for callers that do not use runInit.
  validateFileTransaction(plans);
  // Directory creation is deliberately after every target has been preflighted.
  for (const plan of plans) mkdirSync(dirname(plan.targetPath), { recursive: true });
  applyFileTransaction(plans);
  for (const plan of plans) reportPlan(plan, opts);

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

function reportPlan(plan, opts) {
  if (plan.action === 'create') {
    process.stdout.write(pc.green(`✓ Created ${plan.destination}\n`));
  } else if (plan.action === 'unchanged') {
    process.stdout.write(pc.dim(`= ${plan.destination} already up to date\n`));
  } else if (plan.action === 'update') {
    process.stdout.write(pc.cyan(`${opts.force ? '↻ Force-updated' : '↻ Updated'} triss block in ${plan.destination}\n`));
  } else {
    process.stdout.write(pc.green(`+ Appended triss block to ${plan.destination}\n`));
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
  const cfg = readProviderConfigSnapshot();
  const integrations = await loadIntegrations();
  const tips = [];

  const defaultProfile = cfg.providers[cfg.defaultProvider.value];
  if (!defaultProfile.credential.value) {
    tips.push({
      level: 'warn',
      msg: `Credential for default provider "${cfg.defaultProvider.value}" is not set.`,
      cmd: 'triss config wizard',
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
      '\n' +
        pc.dim('  Tip: ') +
        pc.cyan('triss init --setup') +
        pc.dim(' creates the file and runs the wizard in one go.\n'),
    );
  }
}

// Re-export the helper for tests.
export { postInit as _postInit };

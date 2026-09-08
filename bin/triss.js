#!/usr/bin/env node

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 12)) {
  process.stderr.write(
    `triss requires Node.js >= 22.12.0 (you are on ${process.versions.node}).\n` +
      `Upgrade via nvm/fnm or https://nodejs.org/.\n`,
  );
  process.exit(1);
}

import { readFileSync } from 'node:fs';
import { buildProgram } from '../src/cli-program.js';
import { loadIntegrations } from '../src/integrations/_registry.js';
import { loadEnvFiles } from '../src/config.js';
import {
  runDefaultPassiveCliCheck,
  shouldSuppressPassiveCheck,
} from '../src/update/passive.js';
import { isExecExplainInvocation } from '../src/cli-argv.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

// Plugin-style integrations (jira, linear, ...). See docs/extending.md.
// `exec --explain` is an inspection mode that performs no work at all, so it
// must not trigger integration *startup* side effects: the github integration
// bootstraps by spawning `gh auth token` (a credential child process) at load
// time. Explain skips the load entirely — its route decision needs none of
// the integration subcommands. Every other command still loads and registers
// them normally.
const isExplainOnly = isExecExplainInvocation(process.argv.slice(2));
const integrations = isExplainOnly ? [] : await loadIntegrations();

const program = buildProgram({ integrations });

program.hook('postAction', async () => {
  loadEnvFiles();
  const argv = process.argv.slice(2);
  if (shouldSuppressPassiveCheck({
    argv,
    stderrIsTTY: Boolean(process.stderr.isTTY),
    ci: /^(1|true|yes)$/i.test(process.env.CI || ''),
    optOut: process.env.TRISS_UPDATE_CHECK === '0',
    commandFailed: Boolean(process.exitCode),
  })) return;
  await runDefaultPassiveCliCheck({ currentVersion: packageJson.version });
});

await program.parseAsync(process.argv);

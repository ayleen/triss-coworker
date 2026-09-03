// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import pc from 'picocolors';
import { runMigration } from '../migration/migrate.js';

export function runMigrate(opts = {}, deps = {}) {
  const migrate = deps.runMigration || runMigration;
  const result = migrate({ cwd: opts.cwd || process.cwd(), home: opts.home });
  if (opts.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return result;
  }
  if (result.state === 'already_migrated') {
    process.stdout.write(pc.green('Triss configuration is already migrated to schema 2.\n'));
    return result;
  }
  process.stdout.write(
    pc.green(`Migration ${result.migrationId} complete across ${result.targets.length} target(s).\n`) +
      'Run `triss status`, then restart MCP hosts and agent sessions.\n' +
      pc.yellow('Downgrading Triss below 0.42.0 after this migration is unsupported.\n'),
  );
  return result;
}

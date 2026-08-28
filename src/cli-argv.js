// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

export function isExecExplainInvocation(argv = []) {
  if (argv[0] !== 'exec') return false;
  const commandArgs = argv.slice(1);
  const optionTerminator = commandArgs.indexOf('--');
  const optionArgs = optionTerminator < 0
    ? commandArgs
    : commandArgs.slice(0, optionTerminator);
  return optionArgs.includes('--explain');
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Shared OpenCode catalogue retry semantics. Init and persistent model
// management use separate clients, but must agree on which failures are truly
// transient and therefore eligible for an explicit safety opt-in.

export const OPENCODE_CATALOGUE_TRANSIENT_HTTP_STATUSES = new Set([
  408,
  429,
  500,
  502,
  503,
  504,
]);

export function isTransientOpenCodeReadError(error) {
  return error instanceof TypeError || error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

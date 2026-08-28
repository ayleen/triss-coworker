// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Per-invocation call context propagated via AsyncLocalStorage.
//
// Each CLI subcommand or MCP tool handler runs inside `withCall(fn)`; any
// `logUsage()` triggered from that async tree picks up the generated
// `call_id` automatically, so consumers (the local `triss usage` reader,
// external dashboards like tokentelemetry) can group records by invocation.
//
// `parent_call_id` is opt-in. Hosts that wrap Triss (Claude Code, Cursor,
// future multi-step Triss flows) can set TRISS_PARENT_CALL_ID in the
// environment, or callers can pass `{ parentCallId }` to withCall.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const store = new AsyncLocalStorage();

export function withCall(fn, opts = {}) {
  const ctx = {
    callId: opts.callId || randomUUID(),
    parentCallId:
      opts.parentCallId || process.env.TRISS_PARENT_CALL_ID || null,
  };
  return store.run(ctx, fn);
}

export function currentCall() {
  return store.getStore() || null;
}

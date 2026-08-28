// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// The Triss managed-block markers, isolated in their own tiny module so the
// marker transaction primitive can reference them without pulling in
// agent-rules.js — which itself depends on the MCP install module. Without
// this split the dependency graph would cycle: install → marker-transaction →
// agent-rules → install. agent-rules.js imports and re-exports these constants
// so existing imports of the markers from './agent-rules.js' keep working.

export const START_MARKER = '<!-- triss:start -->';
export const END_MARKER = '<!-- triss:end -->';

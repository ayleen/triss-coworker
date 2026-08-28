// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Shared by the coder test files: picocolors enables ANSI color codes in
// GitHub Actions (its isColorSupported check treats the CI env var as
// color-capable), even though it's off locally (no TTY, no CI var). Any
// assertion that regex/substring-matches captured stderr/stdout across a
// styled fragment's boundary — e.g. /coder\s+⚠ missing X/ against
// "coder      \x1B[33m⚠ missing X\x1B[39m" — silently breaks in CI only.
// Strip escapes before asserting on human-readable output text.
export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

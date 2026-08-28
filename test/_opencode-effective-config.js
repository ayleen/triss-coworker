// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

function resolveEnvReferences(value, env) {
  if (Array.isArray(value)) return value.map((item) => resolveEnvReferences(item, env));
  if (!value || typeof value !== 'object') {
    const match = /^\{env:([^}]+)\}$/u.exec(String(value));
    return match ? env[match[1]] : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, resolveEnvReferences(item, env)]),
  );
}

// Deterministic stand-in for `opencode debug config --pure`. It models the
// only behavior these unit tests need: OPENCODE_CONFIG_CONTENT is loaded and
// {env:KEY} references are resolved from the probe environment. Security
// regressions may pass a mutate callback to emulate a later MDM/managed layer.
export function fakeEffectiveOpenCodeConfig(_cmd, _args, options = {}, { mutate } = {}) {
  const content = options.env?.OPENCODE_CONFIG_CONTENT;
  if (typeof content !== 'string') return { status: 1, stdout: '', stderr: 'missing config content' };
  const resolved = resolveEnvReferences(JSON.parse(content), options.env || {});
  const output = mutate ? mutate(structuredClone(resolved)) : resolved;
  return { status: 0, stdout: JSON.stringify(output), stderr: '', error: null };
}

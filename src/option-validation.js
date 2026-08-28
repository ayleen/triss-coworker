// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

export function positiveIntegerOption(value, name = '--max-tokens', defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${name} must be a positive integer`);
  }
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

export function positiveNumberOption(value, name = '--timeout', defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${name} must be a positive number`);
  }
  if (typeof value === 'string' && value.trim() === '') {
    throw new Error(`${name} must be a positive number`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return number;
}

// Node timers clamp values above 2^31 - 1 ms (the OpenAI-compatible clients
// enforce the same bound), so a request timeout must fit in that range.
export const NODE_TIMER_MAX_MS = 2_147_483_647;

export function timerMsOption(value, name = 'timeout_ms', defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${name} must be an integer between 1 and ${NODE_TIMER_MAX_MS}`);
  }
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be an integer between 1 and ${NODE_TIMER_MAX_MS}`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > NODE_TIMER_MAX_MS) {
    throw new Error(`${name} must be an integer between 1 and ${NODE_TIMER_MAX_MS}`);
  }
  return number;
}

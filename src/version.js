// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
const packageIdentity = JSON.parse(readFileSync(packagePath, 'utf8'));

export const PACKAGE_NAME = packageIdentity.name;
export const PACKAGE_VERSION = packageIdentity.version;

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const NODE_RANGE = /^>=(0|[1-9]\d*)$/;

export function parseStableVersion(value) {
  if (typeof value !== 'string') return null;
  const match = STABLE_VERSION.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) return null;
  return Object.freeze({ major: parts[0], minor: parts[1], patch: parts[2], value });
}

export function isStableVersion(value) {
  return parseStableVersion(value) !== null;
}

export function compareStableVersions(left, right) {
  const a = typeof left === 'string' ? parseStableVersion(left) : left;
  const b = typeof right === 'string' ? parseStableVersion(right) : right;
  if (!a || !b) throw new TypeError('Both versions must be canonical stable semantic versions');
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

export function parseNodeRequirement(value) {
  if (typeof value !== 'string') return null;
  const match = NODE_RANGE.exec(value);
  if (!match) return null;
  const major = Number(match[1]);
  return Number.isSafeInteger(major) && major > 0 ? major : null;
}

export function nodeMajor(version = process.versions.node) {
  const major = Number.parseInt(String(version).split('.')[0], 10);
  return Number.isSafeInteger(major) && major >= 0 ? major : null;
}

export function isNodeCompatible(requirement, running = process.versions.node) {
  const requiredMajor = typeof requirement === 'number' ? requirement : parseNodeRequirement(requirement);
  const runningMajor = typeof running === 'number' ? running : nodeMajor(running);
  return requiredMajor !== null && runningMajor !== null && runningMajor >= requiredMajor;
}

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Build-time facts derived from the repository manifest, so the site can
// never drift from the package by hand. This module runs only at build time
// (Astro frontmatter / SSR) — it is never shipped to the browser.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT_PACKAGE_PATH = fileURLToPath(new URL("../../../package.json", import.meta.url));

function readDirectDependencyCount() {
  const manifest = JSON.parse(readFileSync(ROOT_PACKAGE_PATH, "utf8"));
  return Object.keys(manifest.dependencies ?? {}).length;
}

export const DIRECT_DEPENDENCY_COUNT = readDirectDependencyCount();

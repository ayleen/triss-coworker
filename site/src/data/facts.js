// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Build-time facts derived from the repository manifest and the actual
// checkout, so the site can never drift from the package by hand. This
// module runs only at build time (Astro frontmatter / SSR) — it is never
// shipped to the browser.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT_PACKAGE_PATH = fileURLToPath(new URL("../../../package.json", import.meta.url));

function readRootManifest() {
  return JSON.parse(readFileSync(ROOT_PACKAGE_PATH, "utf8"));
}

function readDirectDependencyCount(manifest) {
  return Object.keys(manifest.dependencies ?? {}).length;
}

// The commit the site was actually built from — not the latest npm release.
// Unavailable (null) when building outside a git checkout, e.g. from a
// source tarball; callers must render that honestly instead of guessing.
function readSourceCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

const manifest = readRootManifest();
export const DOCS_VERSION = manifest.version;
export const DIRECT_DEPENDENCY_COUNT = readDirectDependencyCount(manifest);
export const SOURCE_COMMIT = readSourceCommit();
export const DOCUMENTATION_MODE = process.env.DOCS_BUILD_MODE === "release" ? "release" : "source-build";

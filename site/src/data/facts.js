// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Build-time facts derived from the repository manifest and the actual
// checkout, so the site can never drift from the package by hand. This
// module runs only at build time (Astro frontmatter / SSR) — it is never
// shipped to the browser.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the repository root by walking up until the package manifest named
// "triss-coworker" is found. Resolving from import.meta.url alone is not
// enough: inside the Astro/Vite prerender bundle import.meta.url points at a
// chunk under dist/.prerender/, not at this source file. Candidate starting
// points therefore include the build-time working directory first.
function findRepositoryRoot() {
  const candidates = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  for (const start of candidates) {
    let dir = resolve(start);
    for (;;) {
      const manifestPath = join(dir, "package.json");
      if (existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
          if (manifest.name === "triss-coworker") return { dir, manifest };
        } catch {
          /* unreadable manifest: keep walking */
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

const repository = findRepositoryRoot();

function readRootManifest() {
  if (!repository) throw new Error("cannot locate the triss-coworker repository manifest from the site build");
  return repository.manifest;
}

function readDirectDependencyCount(manifest) {
  return Object.keys(manifest.dependencies ?? {}).length;
}

// The commit the site was actually built from — not the latest npm release.
// Unavailable (null) when building outside a git checkout, e.g. from a
// source tarball; callers must render that honestly instead of guessing.
function readSourceCommit(repoDir) {
  if (!repoDir) return null;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

const manifest = readRootManifest();
export const DOCS_VERSION = manifest.version;
export const DIRECT_DEPENDENCY_COUNT = readDirectDependencyCount(manifest);
export const SOURCE_COMMIT = readSourceCommit(repository?.dir);
export const DOCUMENTATION_MODE = process.env.DOCS_BUILD_MODE === "release" ? "release" : "source-build";

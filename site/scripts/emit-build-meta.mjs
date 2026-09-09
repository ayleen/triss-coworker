// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Emit dist/version.json — the public build metadata endpoint. Runs as the
// last step of the site build so the deployed site always answers "which
// version of the documentation am I looking at, built from which commit".
// `sourceCommit` comes from the actual checkout; it is null (omitted) when
// building outside a git tree. The production deploy path can set
// DOCS_BUILD_MODE=release; anything else is reported as "source-build"
// rather than pretending to be a released snapshot.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { DOCS_VERSION, SOURCE_COMMIT, DOCUMENTATION_MODE } from "../src/data/facts.js";

const meta = {
  docsVersion: DOCS_VERSION,
  documentationMode: DOCUMENTATION_MODE,
  ...(SOURCE_COMMIT ? { sourceCommit: SOURCE_COMMIT } : {}),
};

const outPath = path.join(process.cwd(), "dist", "version.json");
writeFileSync(outPath, `${JSON.stringify(meta, null, 2)}\n`);
console.log(`wrote ${path.relative(process.cwd(), outPath)} (${meta.documentationMode})`);

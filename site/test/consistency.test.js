// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DEEPSEEK_PRICING } from "../../src/usage.js";
import {
  ANTHROPIC,
  DEEPSEEK,
  DEEPSEEK_EFFECTIVE_AT,
  DEEPSEEK_SOURCE,
  DEFAULTS,
  PROFILE,
} from "../src/data/pricing.js";
import { COMMANDS } from "../src/data/commands.js";

const read = (file) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

test("calculator clients receive the canonical pricing data", () => {
  assert.deepEqual(PROFILE, { inK: 28, outK: 4.7, sumInK: 1.5, sumOutK: 0.3 });
  assert.deepEqual(ANTHROPIC, {
    sonnet: { input: 3, output: 15 },
    opus: { input: 5, output: 25 },
  });
  assert.deepEqual(DEEPSEEK.standard, { input: 0.22, cache: 0.007, output: 0.66 });
  // The homepage no longer consumes pricing data; the Cost calculator does
  // (its built data island is validated in csp.test.js).
  const costSource = read("src/pages/cost.astro");
  assert.match(costSource, /id="pricing-data"/);
  assert.doesNotMatch(costSource, /const PROFILE = \{/);
  assert.doesNotMatch(costSource, /const DEEPSEEK = \{\s*standard:/);
  assert.equal(read("src/pages/index.astro").includes("pricing-data"), false);
  assert.deepEqual(DEFAULTS, { reqs: 40, share: 65, primary: "sonnet", providerModel: "standard", cacheHit: 77 });
});

test("website and CLI DeepSeek schedules stay in sync", () => {
  const toWebsiteRow = ({ input_uncached, cache_read, output }) => ({
    input: input_uncached,
    cache: cache_read,
    output,
  });
  assert.deepEqual(DEEPSEEK.standard, toWebsiteRow(DEEPSEEK_PRICING.offPeak.standard));
  assert.deepEqual(DEEPSEEK.advanced, toWebsiteRow(DEEPSEEK_PRICING.offPeak.advanced));
  assert.deepEqual(DEEPSEEK.standardPeak, {
    input: DEEPSEEK.standard.input * DEEPSEEK_PRICING.peakMultiplier,
    cache: DEEPSEEK.standard.cache * DEEPSEEK_PRICING.peakMultiplier,
    output: DEEPSEEK.standard.output * DEEPSEEK_PRICING.peakMultiplier,
  });
  assert.deepEqual(DEEPSEEK.advancedPeak, {
    input: DEEPSEEK.advanced.input * DEEPSEEK_PRICING.peakMultiplier,
    cache: DEEPSEEK.advanced.cache * DEEPSEEK_PRICING.peakMultiplier,
    output: DEEPSEEK.advanced.output * DEEPSEEK_PRICING.peakMultiplier,
  });
  assert.equal(DEEPSEEK_EFFECTIVE_AT, DEEPSEEK_PRICING.effectiveAt);
  assert.deepEqual(DEEPSEEK_SOURCE, DEEPSEEK_PRICING.source);
});

test("README presents the canonical 0.42 provider migration", () => {
  const readme = read("../README.md");
  assert.match(readme, /one configurable provider runtime/);
  assert.match(readme, /Upgrading from Triss < 0\.42\.0/);
  assert.match(readme, /triss migrate/);
  assert.doesNotMatch(readme, /--small-model/);
});

test("website documents persistent engine defaults for ask and review", () => {
  // Engine selection stays a documented, optional route: the command reference
  // exposes --engine for model-backed commands. Optional setup walkthroughs
  // live in the quickstart's advanced disclosures and are reviewed manually.
  for (const name of ["ask", "review"]) {
    const command = COMMANDS.find((entry) => entry.name === name);
    assert.ok(command);
    assert.ok(command.flags.includes("--engine <id>"));
  }
});

test("site CI retries transient npm audit outages without weakening the audit", () => {
  const workflow = read("../.github/workflows/site.yml");
  assert.match(workflow, /NPM_CONFIG_FETCH_TIMEOUT: 60000/);
  assert.match(workflow, /for attempt in 1 2 3/);
  assert.match(workflow, /audit endpoint returned an error\|network timeout\|503 Service Unavailable/);
  assert.match(workflow, /npm run audit:dependencies/);
});

test("implementation workflow command is self-contained and cleans up from the project root", () => {
  const page = read("src/pages/workflows/implementation.astro");
  // The engine never sees the page: the run prompt must embed the concrete
  // task it is supposed to implement.
  assert.match(
    page,
    /triss coder run --isolate --session bounded-change "Add retries with exponential backoff to the HTTP client in src\/http\/client\.js/,
  );
  // Triss resolves project state from cwd: inventory and cleanup must run
  // from the saved project root, never from inside the worktree.
  assert.match(page, /PROJECT="\$PWD"/);
  assert.match(page, /cd "\$PROJECT"\ntriss coder result clean/);
});

test("website coder engines and quickstarts match repository contracts", () => {
  const pkg = JSON.parse(read("../package.json"));
  const coderPage = read("src/pages/coder.astro");
  const gettingStarted = read("src/pages/docs/getting-started.astro");
  const readme = read("../README.md");
  const ompAdapter = read("../src/coder-engines/omp.js");
  const opencode2Adapter = read("../src/coder-engines/opencode2.js");
  const floor = ompAdapter.match(/OMP_SUPPORTED_FLOOR = '([^']+)'/)?.[1];
  assert.ok(floor, "OMP supported floor must be parseable from the adapter");
  const opencode2Floor = opencode2Adapter.match(/OPENCODE2_MIN_VERSION_DEFAULT = '([^']+)'/)?.[1];
  assert.ok(opencode2Floor, "OpenCode 2 supported floor must be parseable from the adapter");

  for (const engine of ["opencode", "opencode2", "crush", "omp"]) {
    assert.match(coderPage, new RegExp(`data-engine="${engine}"`));
  }
  assert.match(coderPage, /data-engine="harness"[\s\S]*DSH plugin, not --engine/);
  const escapedOpenCode2Floor = opencode2Floor.replaceAll(".", "\\.");
  assert.match(coderPage, new RegExp(`OpenCode 2 ${escapedOpenCode2Floor} or newer`));
  assert.match(readme, new RegExp(`OpenCode 2 has a supported floor of \`${escapedOpenCode2Floor}\``));
  // Protected-credential fact stays synchronized across README and the coder page.
  assert.match(coderPage, /project fingerprint stays local/);
  assert.match(readme, /project fingerprint stays local/);

  const coder = COMMANDS.find((command) => command.name === "coder");
  assert.ok(coder);
  assert.match(coder.flags.join(" "), /opencode\|opencode2\|crush\|omp/);
  assert.equal(
    coder.example,
    '$ triss coder run --engine omp --model opencode-go/deepseek-v4-flash --effort high "Create result.txt"',
  );

  assert.equal(pkg.name, "triss-coworker");
  assert.equal(pkg.engines.node, ">=22.12.0");
  const setupScript = read("src/data/setup.js");
  assert.match(setupScript, /npm install -g triss-coworker/);
  assert.match(gettingStarted, /Node\.js ≥ 22\.12/);
  assert.match(readme, new RegExp(`supported floor of \`${floor.replaceAll(".", "\\.")}\``));
  assert.match(readme, /triss coder run --engine omp \\\n\s+--model opencode-go\/deepseek-v4-flash/);
});

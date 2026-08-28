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
  assert.deepEqual(DEEPSEEK.flash, { input: 0.22, cache: 0.007, output: 0.66 });
  for (const file of ["src/pages/index.astro", "src/pages/cost.astro"]) {
    const source = read(file);
    assert.match(source, /type="application\/json" id="pricing-data" set:html=\{JSON\.stringify\(\{ profile: PROFILE, anthropic: ANTHROPIC, deepseek: DEEPSEEK, defaults: DEFAULTS \}\)\}/);
    assert.doesNotMatch(source, /const PROFILE = \{/);
    assert.doesNotMatch(source, /const DEEPSEEK = \{\s*flash:/);
  }
  assert.deepEqual(DEFAULTS, { reqs: 40, share: 65, primary: "sonnet", worker: "flash", cacheHit: 77 });
});

test("website and CLI DeepSeek schedules stay in sync", () => {
  const toWebsiteRow = ({ input_uncached, cache_read, output }) => ({
    input: input_uncached,
    cache: cache_read,
    output,
  });
  assert.deepEqual(DEEPSEEK.flash, toWebsiteRow(DEEPSEEK_PRICING.offPeak.flash));
  assert.deepEqual(DEEPSEEK.pro, toWebsiteRow(DEEPSEEK_PRICING.offPeak.pro));
  assert.deepEqual(DEEPSEEK.flashPeak, {
    input: DEEPSEEK.flash.input * DEEPSEEK_PRICING.peakMultiplier,
    cache: DEEPSEEK.flash.cache * DEEPSEEK_PRICING.peakMultiplier,
    output: DEEPSEEK.flash.output * DEEPSEEK_PRICING.peakMultiplier,
  });
  assert.deepEqual(DEEPSEEK.proPeak, {
    input: DEEPSEEK.pro.input * DEEPSEEK_PRICING.peakMultiplier,
    cache: DEEPSEEK.pro.cache * DEEPSEEK_PRICING.peakMultiplier,
    output: DEEPSEEK.pro.output * DEEPSEEK_PRICING.peakMultiplier,
  });
  assert.equal(DEEPSEEK_EFFECTIVE_AT, DEEPSEEK_PRICING.effectiveAt);
  assert.deepEqual(DEEPSEEK_SOURCE, DEEPSEEK_PRICING.source);
});

test("historical benchmark keeps its May 2026 list-price result", () => {
  const readme = read("../README.md");
  assert.match(readme, /May 6–13, 2026, all at the list price then in effect/);
  assert.match(readme, /\*\*\\\$2\.22\*\*/);
  assert.doesNotMatch(readme, /off-peak window[\s\S]{0,100}75%/);
  assert.doesNotMatch(readme, /DeepSeek \(pro, -75%\)/);
});

test("website coder engines and OMP quickstart match repository contracts", () => {
  const pkg = JSON.parse(read("../package.json"));
  const coderPage = read("src/pages/coder.astro");
  const gettingStarted = read("src/pages/docs/getting-started.astro");
  const readme = read("../README.md");
  const ompAdapter = read("../src/coder-engines/omp.js");
  const floor = ompAdapter.match(/OMP_SUPPORTED_FLOOR = '([^']+)'/)?.[1];
  assert.ok(floor, "OMP supported floor must be parseable from the adapter");

  for (const engine of ["opencode", "opencode2", "crush", "omp"]) {
    assert.match(coderPage, new RegExp(`data-engine="${engine}"`));
  }
  assert.match(coderPage, /data-engine="harness"[\s\S]*DSH plugin, not --engine/);

  const coder = COMMANDS.find((command) => command.name === "coder");
  assert.ok(coder);
  assert.match(coder.flags.join(" "), /opencode\|opencode2\|crush\|omp/);
  assert.equal(
    coder.example,
    '$ triss coder run --engine omp --model opencode-go/deepseek-v4-flash "Create result.txt containing OMP_OK"',
  );

  assert.equal(pkg.name, "triss-coworker");
  assert.equal(pkg.engines.node, ">=22.12.0");
  const gsScript = read("public/scripts/getting-started.js");
  assert.match(gsScript, /npm install -g triss-coworker/);
  assert.match(gettingStarted, /Node\.js ≥ 22\.12/);
  assert.match(gettingStarted, new RegExp(`OMP ${floor.replaceAll(".", "\\.")} or newer`));
  assert.match(gettingStarted, /triss coder run --engine omp --model opencode-go\/deepseek-v4-flash/);
  assert.match(readme, new RegExp(`supported floor of \`${floor.replaceAll(".", "\\.")}\``));
  assert.match(readme, /triss coder run --engine omp --model opencode-go\/deepseek-v4-flash/);
});

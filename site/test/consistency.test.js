import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ANTHROPIC, DEEPSEEK, DEFAULTS, PROFILE } from "../src/data/pricing.js";

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
    assert.match(source, /is:inline define:vars=\{\{ profile: PROFILE, anthropic: ANTHROPIC, deepseek: DEEPSEEK, defaults: DEFAULTS \}\}/);
    assert.doesNotMatch(source, /const PROFILE = \{/);
    assert.doesNotMatch(source, /const DEEPSEEK = \{\s*flash:/);
  }
  assert.deepEqual(DEFAULTS, { reqs: 40, share: 65, primary: "sonnet", worker: "flash", cacheHit: 77 });
});

test("historical benchmark keeps its May 2026 list-price result", () => {
  const readme = read("../README.md");
  assert.match(readme, /May 6–13, 2026, all at the list price then in effect/);
  assert.match(readme, /\*\*\\\$2\.22\*\*/);
  assert.doesNotMatch(readme, /off-peak window[\s\S]{0,100}75%/);
  assert.doesNotMatch(readme, /DeepSeek \(pro, -75%\)/);
});

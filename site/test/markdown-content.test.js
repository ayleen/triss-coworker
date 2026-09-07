// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Markdown mirror content preservation (review finding R1). The fixtures are
// reduced shapes of real built pages; the dist checks at the bottom run
// against the actual build output and hard-fail when it is missing — the
// build-contract suite must not silently pass before "npm run build".

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { htmlToMarkdown, selectAgentContent } from "../scripts/html-to-markdown.mjs";
import { COMMANDS } from "../src/data/commands.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, "fixtures", name), "utf8");
const dist = path.join(here, "..", "dist");
const readDist = (...parts) => fs.readFileSync(path.join(dist, ...parts), "utf8");
const base = "https://triss.work";

test("void inputs preserve adjacent descriptive text and values", () => {
  const md = htmlToMarkdown(fixture("cost-input.html"), `${base}/cost/`);
  for (const phrase of ["Share delegated to Triss", "65%", "Measured week ran at roughly two thirds"]) {
    assert.ok(md.includes(phrase), `lost substantive text: ${phrase}`);
  }
});

test("marked command flags remain distinct literal arguments", () => {
  const md = htmlToMarkdown(fixture("command-flags-marked.html"), `${base}/commands/`);
  for (const flag of ["--paths <glob…>", "--urls <url…>", "--question <text>"]) assert.ok(md.includes(flag));
  assert.doesNotMatch(md, /<glob…>--urls|<url…>--question/);
});

test("bare pre remains a fenced code block with exact commands", () => {
  const md = htmlToMarkdown(fixture("bare-pre.html"), `${base}/commands/`);
  assert.match(md, /(?:`{3,}|~{3,})[^\n]*\n\$ triss status\n\$ triss agent-help\n(?:`{3,}|~{3,})/);
});

test("inline code in a list retains literal angle-bracket placeholders", () => {
  const md = htmlToMarkdown(fixture("inline-placeholder-list.html"), `${base}/commands/`);
  assert.match(md, /--model <native-id>/);
});

test("nested list retains children and a separate sibling", () => {
  const md = htmlToMarkdown(fixture("nested-list.html"), `${base}/docs/`);
  assert.match(md, /(?:^|\n)[ \t]+[-*+] Child A/);
  assert.match(md, /(?:^|\n)[ \t]+[-*+] Child B/);
  assert.match(md, /(?:^|\n)[-*+] Sibling/);
});

test("hidden-attribute subtrees stay out of the mirror", () => {
  const md = htmlToMarkdown('<div hidden><span>js-only chrome</span></div><p>visible text</p>', `${base}/`);
  assert.ok(md.includes("visible text"));
  assert.doesNotMatch(md, /js-only chrome/);
});

test("real tables keep header rows paired with cells", () => {
  const md = htmlToMarkdown(fixture("key-value-table.html"), `${base}/cost/`);
  assert.match(md, /\| Model \| Price \|/);
  assert.match(md, /\| --- \| --- \|/);
  assert.match(md, /\| Alpha \| \$1 \|/);
  assert.match(md, /\| Beta \| \$9 \|/);
});

test("marked areas win over main-only extraction and drop chrome", () => {
  const html = fixture("getting-started-marked.html");
  const md = htmlToMarkdown(selectAgentContent(html).join("\n\n"), `${base}/docs/getting-started/`);
  assert.match(md, /^# Your first delegated task\.$/m);
  assert.ok(md.includes("Five steps."), "marked hero content lost");
  assert.ok(md.includes("$ node --version"), "marked main content lost");
  for (const chrome of ["Site navigation", "Repeated step navigation", "Footer links"]) {
    assert.doesNotMatch(md, new RegExp(chrome), `${chrome} must stay out of the mirror`);
  }
});

test("unknown elements fall through to their text instead of being deleted", () => {
  const md = htmlToMarkdown("<weird-tag>keep me</weird-tag>", `${base}/`);
  assert.ok(md.includes("keep me"));
});

// --- built output (hard-fails without dist: run npm run build first) --------

test("dist exists for the build-contract suite", () => {
  assert.ok(fs.existsSync(path.join(dist, "index.html")), "dist/ is missing — run `npm run build` before `npm test`");
});

test("built command mirror preserves all published flags and literal examples", () => {
  const md = readDist("commands", "index.md");
  const fencedBodies = [...md.matchAll(/^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm)].map((m) => m[2].replace(/\n$/, ""));
  for (const command of COMMANDS) {
    assert.ok(md.includes(`triss ${command.name}`), `missing command ${command.name}`);
    for (const flag of command.flags) assert.ok(md.includes(flag), `${command.name}: missing literal flag ${flag}`);
    assert.ok(
      fencedBodies.some((block) => block.includes(command.example)),
      `${command.name}: example missing from code blocks`,
    );
  }
});

test("built getting-started preserves the actual H1 and hero introduction", () => {
  const html = readDist("docs", "getting-started", "index.html");
  const md = readDist("docs", "getting-started", "index.md");
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  assert.ok(h1, "HTML page must have its actual H1");
  const headings = [...md.matchAll(/^# ([^\n]+)$/gm)].map((m) => m[1].trim());
  assert.ok(headings.includes("Your first delegated task."), "markdown must keep the hero H1");
  assert.ok(h1[1].includes("Your first delegated task."), "reviewed hero structure changed: reconcile this test");
  assert.ok(md.includes("Node.js ≥ 22.12 and a credential"), "getting-started lost the hero introduction");
});

test("built cost mirror preserves the explanatory copy and labeled values", () => {
  const md = readDist("cost", "index.md");
  for (const phrase of ["Share delegated to Triss", "65%", "Measured week ran at roughly two thirds", "Calculator defaults"]) {
    assert.ok(md.includes(phrase), `cost mirror lost ${phrase}`);
  }
  assert.match(md, /\| Cost \(USD\) \| \$1\.88 \| \$0\.34 \| \$2\.22 \|/);
});

test("hidden calculator defaults stay in sync with the controls", () => {
  const html = readDist("cost", "index.html");
  const spanValue = (id) => html.match(new RegExp(`id="${id}"[^>]*>([^<]+)<`))?.[1]?.trim();
  const requests = spanValue("c-reqs");
  const share = spanValue("c-share");
  const cache = spanValue("c-cache");
  const primaryModel = html.match(/id="c-mid"[^>]*>([^<]+)</)?.[1]?.trim();
  assert.ok(requests && share && cache && primaryModel, "reviewed calculator markup changed: reconcile this test");

  const defaults = html.match(/Calculator defaults:([^<]+)</)?.[1];
  assert.ok(defaults, "the hidden defaults block is missing from the cost page");
  assert.ok(defaults.includes(`requests per day ${requests}`), `defaults drifted from the requests control (${requests}): ${defaults}`);
  assert.ok(defaults.includes(`Triss ${share}`), `defaults drifted from the share control (${share}): ${defaults}`);
  assert.ok(defaults.includes(`cache hit rate ${cache}`), `defaults drifted from the cache control (${cache}): ${defaults}`);
  assert.ok(defaults.includes(`primary model ${primaryModel}`), `defaults drifted from the primary-model button (${primaryModel}): ${defaults}`);
  assert.match(defaults, /model class standard/, `defaults drifted from the delegated-class button: ${defaults}`);
});

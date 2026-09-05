// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Build step: generate an agent-facing Markdown mirror of every built page
// (dist/<route>/index.md next to index.html) plus llms-full.txt, a single
// Markdown file with the usage-critical documentation. Runs after
// "astro build"; pure Node, no dependencies.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { htmlToMarkdown, extractMain } from "./html-to-markdown.mjs";

export const SITE_URL = process.env.SITE_URL || "https://triss.work";

// Pages whose full text ships inside llms-full.txt and /api/v1/docs — the
// operating manual for agents. The remaining pages still get individual
// markdown mirrors but stay link-only in llms.txt.
export const LLMS_FULL_ROUTES = [
  "/",
  "/docs/",
  "/docs/getting-started/",
  "/commands/",
  "/coder/",
  "/workflows/",
  "/workflows/research/",
  "/workflows/review/",
  "/workflows/implementation/",
];

export function collectPages(dist) {
  const pages = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === "index.html") {
        const relativeDir = path.relative(dist, path.dirname(full)).split(path.sep).join("/");
        const route = relativeDir === "." || relativeDir === "" ? "/" : `/${relativeDir}/`;
        const html = fs.readFileSync(full, "utf8");
        const title = html.match(/<title>([^<]+)<\/title>/i)?.[1] ?? route;
        pages.push({
          route,
          title,
          htmlPath: full,
          markdownRoute: route === "/" ? "/index.md" : `${route}index.md`,
        });
      }
    }
  };
  walk(dist);
  pages.sort((a, b) => a.route.localeCompare(b.route));
  return pages;
}

function isMain(importMetaUrl) {
  return process.argv[1] && fileURLToPath(importMetaUrl) === path.resolve(process.argv[1]);
}

export function generateMarkdown(dist) {
  const pages = collectPages(dist);
  const selection = [];
  for (const page of pages) {
    const markdown = htmlToMarkdown(extractMain(fs.readFileSync(page.htmlPath, "utf8")), SITE_URL + page.route);
    const mirrorPath = path.join(dist, page.markdownRoute.replace(/^\//, ""));
    fs.writeFileSync(mirrorPath, markdown);
    if (LLMS_FULL_ROUTES.includes(page.route)) {
      selection.push({ ...page, url: SITE_URL + page.route, markdownUrl: page.markdownRoute });
    }
  }

  const header = [
    "# Triss — documentation (llms-full)",
    "",
    `> Full-text Markdown export of the usage-critical ${SITE_URL} pages for AI agents.`,
    "> Guidance and resource map: /llms.txt. Machine index of these pages: /api/v1/docs.",
    "",
  ].join("\n");
  const body = selection
    .map((page) => `---\n\nSource: ${page.url}\n\n${fs.readFileSync(path.join(dist, page.markdownRoute.replace(/^\//, "")), "utf8")}`)
    .join("\n");
  fs.writeFileSync(path.join(dist, "llms-full.txt"), `${header}\n${body}`);

  return { pages: pages.length, selection };
}

if (isMain(import.meta.url)) {
  const dist = path.join(process.cwd(), "dist");
  if (!fs.existsSync(dist)) {
    console.error("dist/ not found — run astro build first");
    process.exit(1);
  }
  const { pages, selection } = generateMarkdown(dist);
  console.log(`markdown mirrors: ${pages} pages, llms-full selection: ${selection.length}`);
}

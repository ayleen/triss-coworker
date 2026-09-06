// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// Build step: publish the public read-only JSON API surface.
// dist/openapi.json describes the API; dist/api/v1/*.json are the endpoints
// themselves, generated from the same build-time data the site renders, so
// the spec and the responses cannot drift from the published site. Runs
// after "astro build" (and the markdown mirror step).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS } from "../src/data/commands.js";
import { SITE_URL, collectPages, LLMS_FULL_ROUTES } from "./generate-markdown.mjs";

const REPO = "https://github.com/ayleen/triss-coworker";

function isMain(importMetaUrl) {
  return process.argv[1] && fileURLToPath(importMetaUrl) === path.resolve(process.argv[1]);
}

function buildMeta(pkg) {
  return {
    name: pkg.name,
    displayName: "Triss Coworker",
    version: pkg.version,
    description: pkg.description,
    license: "MIT",
    repository: REPO,
    homepage: SITE_URL,
    cli: {
      bin: "triss",
      npm: pkg.name,
      install: `npm install -g ${pkg.name}`,
      node: pkg.engines?.node ?? ">=22.12.0",
    },
    resources: {
      llms: "/llms.txt",
      llmsFull: "/llms-full.txt",
      openapi: "/openapi.json",
      docs: "/api/v1/docs",
      commands: "/api/v1/commands",
    },
  };
}

function buildCommands() {
  return {
    count: COMMANDS.length,
    commands: COMMANDS.map(({ name, group, tier, body, flags, example }) => ({
      name,
      group,
      tier,
      summary: body,
      flags,
      example,
      reference: "/commands/",
    })),
  };
}

function buildDocs(dist) {
  const pages = collectPages(dist).filter((page) => LLMS_FULL_ROUTES.includes(page.route));
  return {
    pages: pages.map((page) => ({
      title: page.title,
      url: SITE_URL + page.route,
      markdownUrl: page.markdownRoute,
    })),
  };
}

function openApiSpec(pkg, docs) {
  const errorResponse = (description) => ({
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  });
  const ok = (schemaRef, example) => ({
    description: "The requested resource as application/json.",
    content: { "application/json": { schema: { $ref: `#/components/schemas/${schemaRef}` }, example } },
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "Triss Public API",
      version: pkg.version,
      summary: "Read-only, build-derived metadata about the Triss CLI, its commands, and its documentation.",
      description:
        "Static, read-only JSON endpoints published by the triss.work website. There is no authentication, no user data, and no state: every response is derived from the published release and site content. Unknown /api paths return a structured JSON error (see the Error schema); agents should start from /api/v1/meta or the llms.txt resource map.",
      license: { name: "MIT", url: `${REPO}/blob/main/LICENSE` },
    },
    servers: [{ url: SITE_URL }],
    tags: [{ name: "public", description: "Read-only public metadata" }],
    paths: {
      "/api/v1/meta": {
        get: {
          operationId: "getMeta",
          tags: ["public"],
          summary: "Package identity, current version, and resource map.",
          description:
            "Returns the npm package name, the published version, the install command, and pointers to the machine-readable resources (llms.txt, OpenAPI spec, docs index). Use this first to discover everything else.",
          responses: {
            "200": ok("Meta", { name: "triss-coworker", displayName: "Triss Coworker", version: pkg.version, cli: { bin: "triss", npm: pkg.name, install: `npm install -g ${pkg.name}` } }),
            "405": errorResponse("Method is not GET or HEAD."),
          },
        },
      },
      "/api/v1/commands": {
        get: {
          operationId: "getCommands",
          tags: ["public"],
          summary: "The full CLI command and MCP tool catalogue.",
          description:
            "Every top-level command with its group, credential tier, summary, flags, and a canonical example, mirroring the /commands reference page and the CLI's own help output.",
          responses: {
            "200": ok("CommandsResponse", { count: COMMANDS.length, commands: [{ name: "ask", summary: COMMANDS[0].body }] }),
            "405": errorResponse("Method is not GET or HEAD."),
          },
        },
      },
      "/api/v1/docs": {
        get: {
          operationId: "getDocs",
          tags: ["public"],
          summary: "Index of documentation pages with Markdown mirror URLs.",
          description:
            "Lists the usage-critical documentation pages with their canonical URL and the matching Markdown variant (served through Accept: text/markdown negotiation or as the .md path).",
          responses: {
            "200": ok("DocsResponse", { pages: docs.pages.slice(0, 1) }),
            "405": errorResponse("Method is not GET or HEAD."),
          },
        },
      },
    },
    components: {
      schemas: {
        Error: {
          type: "object",
          description: "Structured error returned by /api endpoints and unknown API paths.",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string", description: "Stable machine-readable code, e.g. not_found or method_not_allowed." },
                message: { type: "string", description: "Human-readable explanation." },
                hint: { type: "string", description: "Resolution hint, usually a path to fetch next." },
              },
              required: ["code", "message", "hint"],
            },
          },
          required: ["error"],
        },
        Meta: {
          type: "object",
          properties: {
            name: { type: "string", description: "npm package name." },
            displayName: { type: "string", description: "Full product brand name (short form: Triss)." },
            version: { type: "string", description: "Published package version." },
            description: { type: "string" },
            license: { type: "string" },
            repository: { type: "string", format: "uri" },
            homepage: { type: "string", format: "uri" },
            cli: {
              type: "object",
              properties: {
                bin: { type: "string", description: "Executable name after install." },
                npm: { type: "string", description: "Package to install; the bare `triss` npm name is unrelated." },
                install: { type: "string", description: "Ready-to-run install command." },
                node: { type: "string", description: "Minimum Node.js version." },
              },
              required: ["bin", "npm", "install", "node"],
            },
            resources: {
              type: "object",
              properties: {
                llms: { type: "string" },
                llmsFull: { type: "string" },
                openapi: { type: "string" },
                docs: { type: "string" },
                commands: { type: "string" },
              },
              required: ["llms", "llmsFull", "openapi", "docs", "commands"],
            },
          },
          required: ["name", "displayName", "version", "description", "license", "repository", "homepage", "cli", "resources"],
        },
        Command: {
          type: "object",
          properties: {
            name: { type: "string" },
            group: { type: "string", description: "Command family, e.g. delegate, core, setup, trackers." },
            tier: { type: "string", description: "Credential tier needed: main, small, local, setup, agent." },
            summary: { type: "string" },
            flags: { type: "array", items: { type: "string" } },
            example: { type: "string" },
            reference: { type: "string", description: "Site path of the full reference page." },
          },
          required: ["name", "group", "tier", "summary", "flags", "example", "reference"],
        },
        CommandsResponse: {
          type: "object",
          properties: {
            count: { type: "integer" },
            commands: { type: "array", items: { $ref: "#/components/schemas/Command" } },
          },
          required: ["count", "commands"],
        },
        DocsEntry: {
          type: "object",
          properties: {
            title: { type: "string" },
            url: { type: "string", format: "uri", description: "Canonical HTML page." },
            markdownUrl: { type: "string", description: "Path of the Markdown mirror." },
          },
          required: ["title", "url", "markdownUrl"],
        },
        DocsResponse: {
          type: "object",
          properties: {
            pages: { type: "array", items: { $ref: "#/components/schemas/DocsEntry" } },
          },
          required: ["pages"],
        },
      },
    },
  };
}

export function generateApi(dist) {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "..", "package.json"), "utf8"));
  const docs = buildDocs(dist);
  const apiDir = path.join(dist, "api", "v1");
  fs.mkdirSync(apiDir, { recursive: true });
  const write = (file, data) => fs.writeFileSync(path.join(dist, file), `${JSON.stringify(data, null, 2)}\n`);
  write("openapi.json", openApiSpec(pkg, docs));
  write("api/v1/meta.json", buildMeta(pkg));
  write("api/v1/commands.json", buildCommands());
  write("api/v1/docs.json", docs);
  return { version: pkg.version, commands: COMMANDS.length, docs: docs.pages.length };
}

if (isMain(import.meta.url)) {
  const dist = path.join(process.cwd(), "dist");
  if (!fs.existsSync(dist)) {
    console.error("dist/ not found — run astro build first");
    process.exit(1);
  }
  const result = generateApi(dist);
  console.log(`openapi + api/v1: version ${result.version}, ${result.commands} commands, ${result.docs} doc pages`);
}

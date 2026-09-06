// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ayleen

// OpenAPI contract enforcement (review finding R4): the published spec, its
// embedded examples, and the actual dist/api/v1 payloads must validate
// against the published schemas with a real JSON Schema (2020-12) validator.
// Missing dist is an error here, not a skip — this suite is only meaningful
// after "npm run build".

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "dist");

assert.ok(fs.existsSync(path.join(dist, "openapi.json")), "dist/openapi.json is missing — run `npm run build` before `npm test`");

const specId = "https://triss.work/openapi.json";
const spec = JSON.parse(fs.readFileSync(path.join(dist, "openapi.json"), "utf8"));
const readPayload = (name) => JSON.parse(fs.readFileSync(path.join(dist, "api", "v1", `${name}.json`), "utf8"));

const ajv = new Ajv2020({ strict: false, allErrors: true });
spec.$id = specId;
ajv.addSchema(spec);

const validator = (schemaRef) => {
  const validate = ajv.getSchema(`${specId}#${schemaRef}`);
  assert.ok(validate, `schema ${schemaRef} must exist in the published spec`);
  return validate;
};

const assertValid = (schemaRef, payload, label) => {
  const validate = validator(schemaRef);
  const ok = validate(payload);
  assert.ok(ok, `${label} does not satisfy ${schemaRef}: ${JSON.stringify(validate.errors)}`);
};

test("spec is OpenAPI 3.1 with unique operation ids and full descriptions", () => {
  assert.match(spec.openapi, /^3\.1\./);
  assert.ok(spec.info.title.includes("metadata"), "the API title must not overstate a general product API");
  const operationIds = new Set();
  for (const [routePath, methods] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (["parameters", "servers", "summary", "description"].includes(method)) continue;
      assert.ok(operation.operationId, `${method} ${routePath} needs an operationId`);
      assert.ok(!operationIds.has(operation.operationId), `duplicate operationId ${operation.operationId}`);
      operationIds.add(operation.operationId);
      assert.ok(operation.description, `${method} ${routePath} needs a description`);
      const success = operation.responses["200"];
      assert.ok(success?.content?.["application/json"]?.schema, `200 of ${routePath} needs a JSON schema`);
      const methodNotAllowed = operation.responses["405"];
      assert.ok(methodNotAllowed, `${routePath} must document the 405 contract`);
    }
  }
});

test("every component schema compiles under JSON Schema 2020-12", () => {
  for (const name of Object.keys(spec.components.schemas)) {
    const validate = validator(`/components/schemas/${name}`);
    assert.ok(typeof validate === "function", `${name} must compile`);
  }
});

test("descriptions do not promise execution or a full MCP registry", () => {
  const specText = JSON.stringify(spec);
  assert.doesNotMatch(specText, /full CLI command and MCP tool catalogue/i);
  assert.doesNotMatch(specText, /cannot drift/i);
  assert.match(specText, /not an execution interface/i, "the spec must say the API does not execute tools");
  assert.match(specText, /docs\/mcp\.md/, "MCP tooling must be pointed at its real documentation");
});

test("embedded examples satisfy their response schemas", () => {
  assertValid("/components/schemas/Meta", spec.paths["/api/v1/meta"].get.responses["200"].content["application/json"].example, "meta example");
  assertValid("/components/schemas/CommandsResponse", spec.paths["/api/v1/commands"].get.responses["200"].content["application/json"].example, "commands example");
  assertValid("/components/schemas/DocsResponse", spec.paths["/api/v1/docs"].get.responses["200"].content["application/json"].example, "docs example");
});

test("published endpoint payloads satisfy their response schemas", () => {
  assertValid("/components/schemas/Meta", readPayload("meta"), "dist/api/v1/meta.json");
  assertValid("/components/schemas/CommandsResponse", readPayload("commands"), "dist/api/v1/commands.json");
  assertValid("/components/schemas/DocsResponse", readPayload("docs"), "dist/api/v1/docs.json");
});

test("structured error bodies satisfy the Error schema", () => {
  const errorSchema = "/components/schemas/Error";
  assertValid(errorSchema, { error: { code: "not_found", message: "Unknown API endpoint.", hint: "Fetch /openapi.json" } }, "404 body");
  assertValid(errorSchema, { error: { code: "method_not_allowed", message: "Only GET and HEAD are supported on API endpoints.", hint: "GET /openapi.json" } }, "405 body");
  const invalid = validator(errorSchema);
  assert.equal(invalid({ error: { code: "not_found" } }), false, "error bodies without message/hint must fail the schema");
});

test("commands payload stays consistent with the site catalogue", () => {
  const payload = readPayload("commands");
  assert.equal(payload.count, payload.commands.length, "count must equal the actual array length");
  for (const command of payload.commands) {
    assert.ok(command.name && command.summary && command.example, `${command.name} needs summary and example`);
    assert.ok(Array.isArray(command.flags), `${command.name} flags must be an array`);
  }
});

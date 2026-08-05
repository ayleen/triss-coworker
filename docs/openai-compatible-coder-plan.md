# OpenAI-compatible coder provider plan

Implementation contract for running `triss coder` through a user-supplied
OpenAI-compatible Chat Completions endpoint without adding a provider-specific
branch to Triss for every vendor.

## Accepted v1 decisions

- One active profile: the existing `TRISS_WORKER_*` configuration.
- Chat Completions only through `@ai-sdk/openai-compatible`.
- OpenCode engine only; Crush remains Z.AI-only.
- No additional coder API key, endpoint, or named-profile namespace.

## Status and first acceptance provider

OpenCode supports custom providers in `opencode.json` through
`@ai-sdk/openai-compatible`. A provider definition names a stable provider id,
an API base URL, an environment-backed key, and the model ids that OpenCode may
run.

The first live acceptance provider is the official DeepSeek API:

| Setting | Value |
| --- | --- |
| OpenCode provider id | `triss-worker` |
| Base URL | `TRISS_WORKER_BASE_URL` (`https://api.deepseek.com/v1` by default) |
| Main model | `TRISS_WORKER_FLASH_MODEL` (`deepseek-v4-flash` by default) |
| Small model | `TRISS_WORKER_FLASH_MODEL` (`deepseek-v4-flash` by default) |
| Triss model | `triss-worker/deepseek-v4-flash` |
| Credential | Existing `TRISS_WORKER_API_KEY` |

DeepSeek is an acceptance recipe, not a hard-coded provider kind. The same
implementation must work when the existing worker profile points to another
compatible endpoint. The provider deliberately reuses that profile instead of
creating a second API-key namespace.

## Goals

- Add `openai-compatible` as a first-class provider kind for the OpenCode coder
  engine.
- Make the existing OpenAI-compatible worker profile available to the coder
  under the stable OpenCode provider id `triss-worker`.
- Generate the corresponding `opencode.json.provider` entry with no literal
  secret.
- Support the custom provider in `coder init`, `coder run`, `coder models`,
  `coder model set`, status, the config wizard, MCP, and shell completion.
- Preserve provider-key isolation: a worker-provider run receives only
  `TRISS_WORKER_API_KEY`, never every configured provider key.
- Preserve unknown `opencode.json` fields, the deny-first bash policy, and
  transactional rollback guarantees while adding the provider definition and
  model pins.
- Reuse the worker key, base URL, and model presets directly, without copying
  or duplicating the secret.

## Non-goals for v1

- Custom providers for the Crush engine. Crush remains Z.AI-only.
- Multiple simultaneously active worker profiles managed by Triss.
- OpenAI Responses API providers (`@ai-sdk/openai`). V1 targets the widely
  supported `/chat/completions` contract through
  `@ai-sdk/openai-compatible`.
- Provider-specific pricing, subscription, region, or privacy management.
- Automatic billable inference during setup.
- Arbitrary custom headers or arbitrary credential environment-variable names.
- A second coder-specific OpenAI-compatible key or endpoint namespace.

## Configuration contract

The coder consumes the existing worker variables:

| Variable | Purpose |
| --- | --- |
| `TRISS_WORKER_API_KEY` | Existing worker secret; the only credential forwarded for this provider |
| `TRISS_WORKER_BASE_URL` | Existing OpenAI-compatible base URL |
| `TRISS_WORKER_FLASH_MODEL` | Default cheap/fast model id |
| `TRISS_WORKER_PRO_MODEL` | Optional larger model id exposed to model selection |
| `TRISS_CODER_MODEL` | Provider-qualified main pin, for example `triss-worker/deepseek-v4-flash` |
| `TRISS_CODER_SMALL_MODEL` | Provider-qualified small pin under `triss-worker/` |

The OpenCode provider id is the fixed `triss-worker`, so changing the worker
backend does not create stale provider prefixes. HTTPS is required for remote
hosts. Plain HTTP is accepted only for loopback hosts so the already documented
Ollama worker recipe remains usable without adding an insecure remote-key path.

For the DeepSeek example, Triss writes this provider shape while retaining the
existing permission policy and unrelated fields:

```json
{
  "model": "triss-worker/deepseek-v4-flash",
  "small_model": "triss-worker/deepseek-v4-flash",
  "provider": {
    "triss-worker": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Triss worker (OpenAI-compatible)",
      "options": {
        "baseURL": "https://api.deepseek.com/v1",
        "apiKey": "{env:TRISS_WORKER_API_KEY}"
      },
      "models": {
        "deepseek-v4-flash": {
          "name": "deepseek-v4-flash"
        }
      }
    }
  }
}
```

No key value may appear in `opencode.json`, logs, errors, status JSON,
transaction snapshots, or recovery commands.

## CLI contract

```bash
# Guided setup reuses the configured worker key, endpoint, and model presets.
triss coder init --provider worker --global

# Configure a different compatible backend through the existing worker surface.
triss config set TRISS_WORKER_BASE_URL https://example.test/v1
triss config set TRISS_WORKER_FLASH_MODEL example-code-model
triss coder init --provider worker --global

# Read-only state and optional catalogue result.
triss coder models --provider worker

# Persistent switch within the configured custom provider.
triss coder model set triss-worker/deepseek-v4-pro \
  --small triss-worker/deepseek-v4-flash \
  --provider worker --engine opencode --global --yes

# One-run override. The prefix resolves the active custom credential.
triss coder run --model triss-worker/deepseek-v4-flash "implement the task"
```

`--provider openai-compatible` and `--provider openai` are aliases for
`--provider worker`. Model strings use `triss-worker/<model-id>` because that is
the stable identity OpenCode uses. The worker's unqualified flash/pro model ids
are converted to that form during init; run and model-management surfaces
continue to require a qualified id.

## Discovery and validation

An OpenAI-compatible server is not required to expose `GET /models`.
Initialization therefore performs a non-billable best-effort catalogue read
and retains the full outcome instead of treating every failure as success:

- `available`: a valid, non-empty model list; both selected ids must be listed;
- `unauthenticated` / `forbidden`: HTTP 401/403 blocks setup;
- `not-supported`: HTTP 404/405 allows explicitly supplied model ids with an
  unverified warning;
- `empty`: a valid empty catalogue is authoritative and blocks setup;
- `invalid`: malformed JSON, malformed entries, redirects outside the
  configured origin, or another non-retryable response blocks setup;
- `transient`: transport failures and HTTP 408/429/500/502/503/504 block by
  default and require explicit `--allow-unverified` to continue.

Setup never sends a chat/completions request because that can incur cost and
send content to the provider. A real minimal `coder run` is the live acceptance
test after configuration.

## Existing-config and transaction rules

Custom-provider setup cannot use the historical create-only
`writeOpencodeConfig()` path: an existing file needs the provider definition in
addition to model pins. The operation must instead use the model-management
transaction guarantees:

1. Acquire the same cross-process filesystem lock before reading either file.
2. Parse and audit the effective `opencode.json`; malformed JSON or a missing
   deny-first policy blocks unless the existing explicit safety override
   applies.
3. Reject a collision on `provider["triss-worker"]` when the existing
   definition is not exactly compatible. V1 never silently replaces it.
4. Plan one mutation containing only `model`, `small_model`, and
   `provider["triss-worker"]`, while preserving every unrelated field and byte
   convention supported by the existing transaction layer.
5. Persist only the coder model pins in the selected Triss env scope; never
   duplicate or rewrite the existing worker secret/profile.
6. Audit the committed files and effective higher-precedence config. On any
   failure, roll back both config and env changes without deleting concurrent
   user edits.

An identical provider definition is idempotent. A provider entry that uses a
literal API key is a blocking security finding; Triss must not copy, print, or
silently preserve that secret as its managed definition.

## Docs-first TDD sequence

1. Add RED tests for worker base-URL validation, closed-enum routing,
   DeepSeek config generation, credential isolation, and Crush rejection.
2. Add RED transaction tests for a new file, a safe existing file, idempotency,
   provider collision, malformed JSON, missing deny-first policy, rollback,
   and higher-precedence shadowing.
3. Add RED catalogue tests for 200/non-empty, 200/empty, 401, 403, 404/405,
   malformed 200, redirect, transient transport, and retryable HTTP outcomes.
4. Implement the minimum provider metadata, custom profile resolver, config
   builder, transaction extension, and run-time credential mapping.
5. Update CLI/wizard/MCP/help, `.env.example`, README, configuration docs, and
   generated agent instruction templates in lockstep.
6. Run focused tests, lint, `git diff --check`, and the complete suite.
7. With the existing worker DeepSeek key, run a minimal isolated live coder
   task and verify the child receives no unrelated credential.
8. Run an adversarial review with at least 16384 output tokens, remediate every
   confirmed finding, and repeat until no actionable findings remain.

## Acceptance criteria

- `--provider openai-compatible` is accepted only with the OpenCode engine.
- A valid worker profile produces `triss-worker/deepseek-v4-flash` without hard-coding
  DeepSeek into generic routing logic.
- The generated provider block uses `@ai-sdk/openai-compatible`, the exact
  normalized worker base URL, and `{env:TRISS_WORKER_API_KEY}`.
- An existing safe config is updated transactionally and retains unknown
  fields and its permission policy; a conflicting provider entry is unchanged
  and blocks setup.
- Main and small model prefixes must equal `triss-worker`.
- A worker-provider run succeeds with only `TRISS_WORKER_API_KEY` configured
  and forwards only that provider key.
- Missing custom credentials, invalid profile metadata, insecure remote HTTP,
  cross-provider model pairs, and Crush usage fail before spawning OpenCode.
- Catalogue authorization, empty, invalid, redirect, and non-retryable errors
  fail closed. Only unsupported catalogues and explicitly allowed transient
  failures can use user-supplied model ids without catalogue verification.
- Existing Z.AI, OpenCode Zen, OpenCode Go, Moonshot, and Kimi behavior remains
  unchanged.
- DeepSeek live acceptance completes through its official API and reports the
  exact provider error if the endpoint rejects the request.
- User-facing documentation explains the one-profile v1 limit, secret
  boundary, optional catalogue, and Chat Completions-only scope.

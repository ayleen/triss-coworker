# OpenAI-compatible coder provider plan

> **Historical pre-0.42 design record.** Legacy provider names, environment
> variables, model selectors, and commands below are migration history, not
> valid runtime guidance. See [`configuration.md`](configuration.md).

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
- Preserve unknown `opencode.json` fields and the deny-first bash policy, and
  use a locked atomic write while adding the provider definition and model
  pins.
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

# Read-only state from the configured worker profile.
triss coder models --provider worker

# Persistent switch within the configured custom provider.
# Run init again first whenever the worker endpoint or flash/pro ids change.
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

An OpenAI-compatible server is not required to expose `GET /models`, and its
catalogue authentication or response shape may differ from Chat Completions.
Triss therefore does not probe a generic worker endpoint during setup. The
configured `TRISS_WORKER_FLASH_MODEL` and `TRISS_WORKER_PRO_MODEL` values form
the authoritative local model list and are the only ids written into the
managed OpenCode provider. `coder models` reports that list with catalogue
status `not-supported`. `coder model set` rejects ids outside it and also
requires the selected `opencode.json` to contain the matching env-backed
provider definition; `coder init --provider worker` creates or refreshes it.

Setup validates the profile locally: the base URL must be absolute, remote
hosts require HTTPS, loopback HTTP is allowed, and credentials, query strings,
or fragments may not be embedded in the URL. It never sends a
`chat/completions` request because that can incur cost and send content to the
provider. A real minimal `coder run` is the live acceptance test after
configuration and reports the provider's exact runtime error on failure.

## Existing-config and atomic-write rules

Custom-provider setup cannot use only the historical create-only behavior: an
existing file needs the provider definition in addition to model pins. For an
existing `opencode.json`, setup follows these rules:

1. Acquire a sibling exclusive filesystem lock before reading the file.
2. Parse and audit the effective `opencode.json`; malformed JSON or a missing
   deny-first policy blocks unless the existing explicit safety override
   applies.
3. Reject a collision on `provider["triss-worker"]` unless it has the exact
   Triss-managed shape. A managed definition may be refreshed when the worker
   endpoint or flash/pro settings change; unknown fields and literal keys
   block replacement.
4. Mutate only `model`, `small_model`, and `provider["triss-worker"]`, while
   preserving unrelated fields, indentation, newline convention, and file
   mode; publish through a same-directory temporary file and atomic rename.
5. Persist only the coder model pins in the selected Triss env scope; never
   duplicate or rewrite the existing worker secret/profile.
6. Audit effective higher-precedence config as part of setup. A blocking
   finding stops completion, although the selected-scope atomic config update
   may already be present and is safe to rerun. If a later env-pin write fails,
   setup reports failure and can likewise be rerun; it does not claim a
   cross-file transaction across `opencode.json` and the env file.

An identical provider definition is idempotent. A provider entry that uses a
literal API key is a blocking security finding; Triss must not copy, print, or
silently preserve that secret as its managed definition.

## Docs-first TDD sequence

1. Add RED tests for worker base-URL validation, closed-enum routing,
   DeepSeek config generation, credential isolation, and Crush rejection.
2. Add RED atomic-write tests for a new file, a safe existing file,
   idempotency, provider collision, malformed JSON, missing deny-first policy,
   managed-profile refresh, and higher-precedence shadowing.
3. Add RED model-management tests proving that discovery is local, performs no
   network request, and accepts only the configured flash/pro ids.
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
- An existing safe config is updated under a lock with atomic replacement and
  retains unknown fields and its permission policy; a conflicting provider
  entry is unchanged and blocks setup.
- Main and small model prefixes must equal `triss-worker`.
- `coder model set --provider worker` fails with an exact init command unless
  the target scope already contains the current env-backed worker provider and
  both requested model definitions.
- A worker-provider run succeeds with only `TRISS_WORKER_API_KEY` configured
  and forwards only that provider key.
- Missing custom credentials, invalid profile metadata, insecure remote HTTP,
  cross-provider model pairs, and Crush usage fail before spawning OpenCode.
- No generic catalogue request is made. Only the configured worker flash/pro
  ids can be selected or persisted by Triss.
- Existing Z.AI, OpenCode Zen, OpenCode Go, Moonshot, and Kimi behavior remains
  unchanged.
- DeepSeek live acceptance completes through its official API and reports the
  exact provider error if the endpoint rejects the request.
- User-facing documentation explains the one-profile v1 limit, secret
  boundary, local model list, and Chat Completions-only scope.

## PR review remediation contract

The implementation must preserve these additional invariants across init,
model management, and run:

1. Worker settings are resolved for the requested scope. A global operation
   reads the global Triss env file only; a local operation reads local values
   with global fallback. Values inherited from the parent shell override either
   scope, but dotenv-injected values are never mistaken for shell overrides.
2. A global setup audits any higher-precedence project
   `provider["triss-worker"]`. If present, it must exactly match the managed
   env-backed provider, endpoint, and complete flash/pro model set. Project
   worker model pins must also belong to that set.
3. Every worker run validates the effective managed provider, current endpoint,
   and selected model before isolation or engine spawn. A missing or stale
   definition fails closed with an engine-explicit, scope-explicit init command.
4. Worker init, `coder model set`, and rollback use the same
   `(engine, scope)` filesystem lock, including PID/token ownership and dead-PID
   recovery. Init holds it from its first config read through the config rename
   and model-pin persistence; new-file creation is not an unlocked exception.
5. Worker readiness metadata has one shared source used by status and MCP.
6. Tracker responses never include coder credential inventory; Jira issue
   output and summarization corpus are independent of `TRISS_WORKER_API_KEY`.

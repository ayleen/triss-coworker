# OpenCode Go support plan

> **Historical pre-0.42 design record.** Legacy provider names, environment
> variables, model selectors, and commands below are migration history, not
> valid runtime guidance. See [`configuration.md`](configuration.md).

Implementation contract for using a paid OpenCode Go subscription from
`triss coder` without changing the existing OpenCode Zen or Z.AI paths.

## Status

OpenCode currently exposes Go models through the OpenAI-compatible endpoint
`https://opencode.ai/zen/go/v1` and identifies them to the OpenCode CLI with
the `opencode-go/<model-id>` prefix. Go and Zen deliberately share
`OPENCODE_API_KEY`, but they are separate providers with separate model
prefixes and catalogue endpoints.

The first target model is `opencode-go/deepseek-v4-flash`. The live catalogue
reported that model during implementation, but an account can still require a
workspace-level regional hosting opt-in before an actual inference succeeds.
Triss must report that provider response; it must never enable the opt-in or
weaken privacy settings on the user's behalf.

## Goals

- Treat `opencode-go/*` as a first-class OpenCode-engine provider.
- Use the existing `OPENCODE_API_KEY`; never require a second Go-specific key.
- Support Go in `coder init`, `coder models`, `coder model set`, and
  `coder run`.
- Discover current Go models from the authenticated Go catalogue.
- Default a new explicit Go setup to
  `opencode-go/deepseek-v4-flash` for both main and small roles when it is
  available.
- Preserve the deny-first OpenCode command policy and provider-key isolation.

## Non-goals

- Purchasing or managing an OpenCode Go subscription.
- Automatically accepting regional data-hosting or privacy terms.
- Changing the one-shot `triss ask` / `triss review` worker providers.
- Changing the existing meaning of `opencode/*` (OpenCode Zen).
- Making Go the default coder provider or adding Go support to Crush.

## Provider and credential contract

| Provider | Model prefix | Catalogue | Credential |
| --- | --- | --- | --- |
| OpenCode Zen | `opencode/` | `https://opencode.ai/zen/v1/models` | `OPENCODE_API_KEY` |
| OpenCode Go | `opencode-go/` | `https://opencode.ai/zen/go/v1/models` | `OPENCODE_API_KEY` |

The shared credential is ambiguous by itself. Consequently:

1. `--provider opencode-go`, aliases `go` and `opencode-go`, selects Go.
2. An explicit `opencode-go/*` main or small model selects Go.
3. A lone `OPENCODE_API_KEY`, with no provider or model intent, continues to
   infer `opencode-zen` for backward compatibility.
4. Explicit provider intent wins over stale cross-provider model pins.
5. Main and small models must use the same provider prefix, even though Zen
   and Go happen to share one environment variable.
6. Only `OPENCODE_API_KEY` is forwarded to a Go engine process. Other provider
   credentials are excluded and no credential value is printed.

## CLI contract

```bash
# Guided global setup; validates the live Go catalogue first.
triss coder init --provider opencode-go --global

# Read-only live discovery.
triss coder models --engine opencode --provider opencode-go

# Safe persistent switch.
triss coder model set opencode-go/deepseek-v4-flash \
  --small opencode-go/deepseek-v4-flash \
  --engine opencode --provider opencode-go --global --yes

# One-run main-model override.
triss coder run --model opencode-go/deepseek-v4-flash "implement the task"
```

The provider alias `opencode` remains Zen; it is not accepted as a Go alias.
Crush rejects both an explicit Go provider and any `opencode-go/*` model before
spawning an engine.

Go initialization preserves the authenticated catalogue outcome instead of
collapsing every failure into an offline default:

- `available`: HTTP 200 contains a parseable, non-empty model list;
- `unauthenticated`: HTTP 401 blocks setup and asks for a valid workspace key;
- `forbidden`: HTTP 403 blocks setup and asks for Go entitlement/workspace
  access;
- `empty`: HTTP 200 with `data: []` is authoritative and blocks setup;
- `invalid`: malformed JSON, an invalid response shape, or a non-transient HTTP
  error blocks setup;
- `transient`: network/timeout failures and HTTP 408/429/500/502/503/504 block
  by default. `coder init --allow-unverified` is the only way to accept the
  built-in Go model fallback for these transient outcomes.

`--allow-unverified` never bypasses 401, 403, an authoritative empty
catalogue, or an invalid response.

An inference-time subscription, quota, or regional-opt-in rejection is not a
catalogue failure. It is returned as the original OpenCode error and the local
configuration remains unchanged.

## Docs-first TDD sequence

1. Add focused tests for prefix routing, shared-key isolation, provider
   inference, catalogue URL/normalization, explicit init defaults, persistent
   model compatibility, and Crush rejection.
2. Run those tests and capture the expected failures against the current
   Zen-only implementation.
3. Add the minimum provider metadata and routing branches needed to make the
   tests pass, reusing the existing OpenCode provider lifecycle.
4. Update user documentation, help, configuration references, MCP descriptions,
   and status wording so Go is discoverable without implying that a key alone
   proves subscription or regional readiness.
5. Run focused tests, then lint and the complete test suite.
6. With an already-configured paid account, run one minimal live
   `opencode-go/deepseek-v4-flash` smoke. If OpenCode requires regional opt-in,
   stop and report the exact workspace setting instead of changing it.

## Acceptance criteria

- `coderModelCredential('opencode-go/deepseek-v4-flash')` resolves to
  `{ env: 'OPENCODE_API_KEY', provider: 'opencode-go' }`.
- A Go run succeeds with only `OPENCODE_API_KEY` present and receives only the
  required provider credential.
- A Go run without `OPENCODE_API_KEY` fails before spawning OpenCode.
- `resolveProviderIntent` distinguishes an explicit Go prefix/provider from
  Zen while preserving lone-key Zen inference.
- `listProviderModels` calls the Go endpoint and returns normalized
  `opencode-go/*` ids.
- Explicit Go init uses the live catalogue, pins a Go main/small pair, and does
  not probe Z.AI or Zen.
- Go init fails before writing model configuration on HTTP 401, HTTP 403, a
  valid empty catalogue, or an invalid catalogue response.
- Every Go catalogue entry must contain a non-empty, whitespace-free string
  `id`; mixed valid/malformed arrays are invalid rather than partially trusted.
- An unverified built-in Go fallback is available only for transport or HTTP
  408/429/500/502/503/504 failures and only with explicit
  `--allow-unverified`.
- `coder model set --allow-unverified` uses the same Go outcome contract as
  init and cannot bypass authorization, empty, malformed, or non-retryable HTTP
  responses.
- Model management rejects Zen/Go mixed pairs despite their shared key.
- Crush rejects Go before spawning.
- Existing Zen, Z.AI, Moonshot, and Kimi tests remain green.
- No key value appears in logs, status, JSON output, or transaction records.

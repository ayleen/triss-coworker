# Usage accounting v2

> **Historical pre-0.42 design record.** Legacy provider names, environment
> variables, model selectors, and commands below are migration history, not
> valid runtime guidance. See [`configuration.md`](configuration.md).

Status: implementation plan for the next release after v0.30.0.

## Objective

Triss must preserve the maximum token and cost detail reported by each
supported provider or coder engine. It must not merge ordinary input, cache
read, cache write, visible output, or reasoning into one stored category when
the source reports them separately.

Unknown data is not zero:

- `0` means the source explicitly reported zero;
- `null` means the source did not report the field, the provider does not
  expose that detail, or Triss cannot prove the field's semantics;
- derived totals are stored separately from atomic reported values and carry
  explicit provenance.

The implementation order is mandatory docs-first TDD:

```text
public documentation and contract lock
  -> focused failing tests (RED)
  -> smallest vertical implementation
  -> focused tests pass (GREEN)
  -> refactor with tests green
  -> full validation and final diff review
```

Production code must not change before the documentation phase is complete.
Tests must not weaken this contract to accommodate the current implementation.

## Current problem

The current JSONL schema persists only `prompt_tokens`, `cached_tokens`, and
`completion_tokens`. The renderer exposes only prompt, cached prompt, and
completion totals.

This loses materially different usage classes:

- OpenCode `step_finish` events expose `input`, `output`, `reasoning`,
  `cache.read`, `cache.write`, and `cost`; the pinned runtime fixture also
  exposes `total`. The current fold sums only `input` and `output`.
- The repository fixture reports 14,609 total tokens, consisting of 303 input,
  14,272 cache-read, 19 visible-output, and 15 reasoning tokens. The current
  fold persists only 322 tokens, or about 2.2% of the reported total.
- DeepSeek-compatible responses can expose top-level prompt cache hit/miss
  counters and completion reasoning details. The current client reads only the
  nested OpenAI/Z.AI cached-token shape.
- Kimi exposes top-level `cached_tokens`; the current client does not read it.
- Z.AI exposes an authoritative total and nested cached-token detail; the
  current client discards the total.
- Crush exposes combined `delta_tokens` and a real `delta_cost_usd`. Triss
  currently labels all combined tokens as completion and does not persist the
  reported cost in the usage log.

Different categories may have different rates. In particular, cache read and
cache write must never be priced as ordinary input merely because they
contribute to a request total.

## Scope

This work covers:

- one-shot worker, GLM, and Kimi calls through the OpenAI-compatible client;
- streaming and non-streaming calls;
- OpenCode coder runs for all Triss-supported OpenCode provider prefixes;
- Crush coder runs;
- JSONL persistence and legacy record reading;
- price configuration and cost estimation;
- aggregate and grouped `triss usage` output;
- JSON and MCP coder usage envelopes where they expose the same call data.

This work does not:

- fabricate historical token details that were never persisted;
- infer reasoning tokens from the length of `reasoning_content`;
- infer cache write from cache read or ordinary input;
- assign a component cost by proportionally splitting a provider-reported
  total cost;
- rewrite the existing usage log in place;
- change provider selection, model routing, or coder lifecycle behavior.

## Canonical record schema

New records use `schema_version: 2`. Token counts are integers or `null`.
Component costs are finite numbers or `null`.

```json
{
  "schema_version": 2,
  "ts": "2026-08-07T00:00:00.000Z",
  "model": "opencode/deepseek-v4-flash-free",
  "billing_model": "opencode/deepseek-v4-flash-free",
  "billing_mode": "free",
  "provider": "opencode-zen",
  "usage_source": "opencode",
  "usage_status": "reported",
  "engine": "opencode",
  "label": "coder",
  "call_id": null,
  "parent_call_id": null,
  "cwd": "/project",
  "tokens": {
    "input_uncached": 303,
    "cache_read": 14272,
    "cache_write": 0,
    "output_visible": 19,
    "reasoning": 15,
    "input_total": 14575,
    "input_total_source": "derived",
    "output_total": 34,
    "output_total_source": "derived",
    "total": 14609,
    "total_source": "reported",
    "combined": null
  },
  "cost": {
    "input_uncached_usd": null,
    "cache_read_usd": null,
    "cache_write_usd": null,
    "output_visible_usd": null,
    "reasoning_usd": null,
    "output_total_usd": null,
    "reported_total_usd": 0,
    "reported_total_source": "engine",
    "total_usd": 0,
    "source": "free",
    "complete": true,
    "unknown_components": []
  }
}
```

### Atomic token fields

The following fields are atomic and must never contain another category:

| Field | Meaning |
| --- | --- |
| `input_uncached` | Input tokens processed without a cache-read hit |
| `cache_read` | Input/context tokens served from cache |
| `cache_write` | Tokens written into a provider cache |
| `output_visible` | Generated output excluding separately reported reasoning |
| `reasoning` | Separately reported reasoning/thinking tokens |
| `combined` | An unsplittable source total, used only when no component split exists |

An unavailable atomic field is `null`. A source-reported zero remains `0`.

### Total token fields

Totals are not atomic categories and must not be added to their own
components during aggregation:

- `input_total` is the complete input-side count when known;
- `output_total` is the complete output-side count when known;
- `total` is the complete call count when known;
- each total carries `reported` or `derived` provenance;
- a reported total is preserved even when components are incomplete;
- a derived total is created only when every required component is known;
- if a reported total disagrees with known components, Triss preserves the
  reported value and records a warning instead of silently correcting either
  side.

`combined` is retained in addition to `total` for a source such as Crush so
consumers know that `total` cannot be split into input and output.

### Provider and source identity

`usage_source` identifies the payload contract parsed by Triss:

- `api` for direct OpenAI-compatible chat completions;
- `opencode` for folded OpenCode `step_finish` events;
- `crush` for the Crush JSON envelope.

`provider` is informational identity for grouping and diagnostics. It never
selects a price and is not inferred from an API key. `billing_model` is the
single price lookup key and preserves the resolved endpoint/plan prefix (for
example, `zai/glm-5.2` versus `zai-coding-plan/glm-5.2`). Existing
`billingModelFor()` behavior remains the starting point for direct API calls.

Coder calls populate identity from the resolved model prefix, not from the set
of credentials present in the environment:

- `triss-worker/*` -> provider `worker`;
- `zai/*` and `zai-coding-plan/*` -> provider `zai`;
- `opencode/*` -> provider `opencode-zen`;
- `opencode-go/*` -> provider `opencode-go`;
- `moonshotai/*` and `moonshotai-cn/*` -> provider `moonshot`;
- `kimi-for-coding/*` -> provider `kimi-for-coding`;
- Crush -> provider `zai` and engine `crush`; use the explicit/resolved model as
  `billing_model` when available, otherwise the stable `crush` sentinel. The
  sentinel is not eligible for a component price estimate.

`billing_mode` is `payg`, `subscription`, `free`, or `unknown`. It is a
per-call billing classification, not merely an alias for the model prefix.
When a route can fall back from a subscription to a balance-funded call and
the event does not prove which path served the request, the mode is `unknown`.
`engine` is `opencode`, `crush`, or `null`.

Initial classification rules are fail-closed:

| Resolved route | Billing mode |
| --- | --- |
| `zai/*` | `payg` |
| `zai-coding-plan/*` | `subscription` |
| `moonshotai/*`, `moonshotai-cn/*` | `payg` |
| `kimi-for-coding/*` | `subscription` |
| exact verified OpenCode free-tier model | `free` |
| OpenCode Zen model without verified free status | `unknown` |
| OpenCode Go with per-call subscription route proven | `subscription` |
| OpenCode Go with possible Zen-balance fallback | `unknown` |
| configurable `triss-worker/*` route | `unknown`; configured prices can still produce an estimate |
| Crush | cost trust follows `delta_cost_usd`; token pricing mode may remain `unknown` |

This table is a contract-lock input, not a permanent hardcoded catalogue. The
implementation must use the authenticated/pinned route facts available for
the call and fail to `unknown` when it cannot prove a stronger classification.

`usage_status` is `reported` or `missing`. A call with no token or
source-reported cost counters remains observable as `missing`; partial detail is
represented by nullable fields, not by an all-zero record or a third status.

## Source normalization contracts

### OpenCode

For every `step_finish` event, independently sum:

- `part.tokens.input` into `input_uncached`;
- `part.tokens.cache.read` into `cache_read`;
- `part.tokens.cache.write` into `cache_write`;
- `part.tokens.output` into `output_visible`;
- `part.tokens.reasoning` into `reasoning`;
- `part.tokens.total`, when present, into the reported `total`;
- `part.cost`, when present, into the engine-reported cost signal.

Each event is step-level, not cumulative. Missing fields are handled per event
without discarding values from other events. A field remains `null` for the
whole call only when no event reports it; an explicitly reported zero counts as
known.

Phase 1 resolved the cache-write question against the pinned runtime
(opencode 1.18.7), which normalizes a provider `usage` object as:

```text
input       = max(0, usage.inputTokens - cacheReadInputTokens - cacheWriteInputTokens)
output      = max(0, usage.outputTokens - usage.reasoningTokens)
reasoning   = usage.reasoningTokens
cache.read  = usage.cacheReadInputTokens
cache.write = usage.cacheWriteInputTokens (or the provider-metadata equivalent)
total       = usage.totalTokens, passed through as-is (absent when the provider omits it)
```

Both cache classes are therefore subtracted out of `input`, and reasoning out
of `output`, so these relationships hold **including a non-zero cache write**:

```text
input_total  = input_uncached + cache_read + cache_write
output_total = output_visible + reasoning
total        = input_total + output_total  (only if no reported total exists)
```

The fixture (`cache_write === 0`) is consistent with this and remains the
regression case; the derivation rule itself rests on the pinned-runtime
evidence recorded in `docs/usage-accounting.md`. A reported `tokens.total` is
still preferred when present, and a total that remains underdetermined for any
other reason stays `null` rather than being guessed at.

The same pinned runtime computes its cost as

```text
cost = input*price.input + output*price.output + cache.read*price.cache_read
     + cache.write*price.cache_write + reasoning*price.output   (all /1e6)
```

with every missing rate defaulting to `0`. This confirms both that an OpenCode
`cost: 0` cannot prove a free call and that the engine bills reasoning at the
output rate.

The optional runtime `tokens.total` is accepted but not required. The fold
must continue to tolerate unknown event types and truncated NDJSON lines.

### DeepSeek-compatible API responses

Normalize documented fields as follows:

| Provider field | Canonical field |
| --- | --- |
| `prompt_tokens` | reported `input_total` |
| `prompt_cache_miss_tokens` | `input_uncached` |
| `prompt_cache_hit_tokens` | `cache_read` |
| `completion_tokens` | reported `output_total` |
| `completion_tokens_details.reasoning_tokens` | `reasoning` |
| `total_tokens` | reported `total` |

`cache_write` remains `null` unless the response explicitly reports it.
`output_visible` is derived from `output_total - reasoning` only when the
provider contract guarantees reasoning is a subset of completion and the
result is non-negative. Otherwise it remains `null`.

If hit plus miss disagrees with `prompt_tokens`, preserve all reported fields
and surface a normalization warning.

### Z.AI API responses

Normalize:

| Provider field | Canonical field |
| --- | --- |
| `prompt_tokens` | reported `input_total` |
| `prompt_tokens_details.cached_tokens` | `cache_read` |
| `completion_tokens` | reported `output_total` |
| `total_tokens` | reported `total` |

When `input_total` and `cache_read` are known and valid,
`input_uncached = input_total - cache_read` with derived provenance.
`cache_write`, `output_visible`, and `reasoning` remain `null` unless a future
documented response field supplies them.

Reasoning content is not a token counter and must not be measured locally.

### Kimi API responses

Normalize:

| Provider field | Canonical field |
| --- | --- |
| `prompt_tokens` | reported `input_total` |
| top-level `cached_tokens` | `cache_read` |
| `completion_tokens` | reported `output_total` |
| `total_tokens` | reported `total` |

Derive `input_uncached` only when the documented cache value is a subset of
prompt tokens and the subtraction is valid. `cache_write`, `output_visible`,
and `reasoning` remain `null` when not reported.

### Generic OpenAI-compatible worker responses

The worker endpoint is configurable, so normalization must recognize supported
documented aliases without assuming every endpoint implements them:

1. preserve `prompt_tokens`, `completion_tokens`, and `total_tokens` when
   present;
2. recognize nested `prompt_tokens_details.cached_tokens`;
3. recognize DeepSeek top-level prompt cache hit/miss fields;
4. recognize Kimi top-level `cached_tokens`;
5. recognize `completion_tokens_details.reasoning_tokens`;
6. leave every unsupported detail `null`.

Conflicting aliases are not silently combined. A provider-specific documented
shape wins when the resolved provider is known; otherwise Triss preserves the
common total and emits a warning for conflicting details.

Streaming and non-streaming calls must pass through the same normalizer.

### Crush

Normalize the Crush envelope without inventing a split:

| Crush field | Canonical field |
| --- | --- |
| `usage.delta_tokens` | reported `combined` and reported `total` |
| `usage.delta_cost_usd` | engine-reported real `cost.total_usd` |

All input, cache, visible-output, reasoning, input-total, and output-total
fields remain `null`. Combined tokens must not be stored as completion tokens
in the canonical record.

## Cost contract

Token storage and cost calculation use the same separation. Price definitions
support independent rates for:

```text
input_uncached
cache_read
cache_write
output_visible
reasoning
```

The cost object may also contain `output_total_usd` when only an unsplit output
total is available and the provider documents one common output rate.

`reported_total_usd` preserves a provider/engine signal even when it is not
trusted as the canonical monetary total. `reported_total_source` is
`provider`, `engine`, or `null`. Canonical `cost.source` is one of
`provider_reported`, `engine_reported`, `plan`, `free`, `estimated`, or
`unknown`. Thus an OpenCode PAYG zero can remain observable in
`reported_total_usd` while `total_usd` comes from a complete estimate or stays
`null`.

Cost source precedence is:

1. a provider-reported total whose API contract defines it as the monetary
   charge for this call;
2. an engine-reported total whose engine contract defines it as the real
   monetary call cost, or a positive OpenCode engine estimate with known model
   identity;
3. a proven subscription-plan or free-tier monetary total;
4. a complete Triss component estimate;
5. unknown.

Rules:

- A provider-reported monetary total is authoritative for the call but is not
  split across components.
- OpenCode `part.cost` is an engine-calculated signal, not a raw provider bill.
  Preserve it separately as `reported_total_usd` with
  `reported_total_source: "engine"`.
- OpenCode cost is retained as engine-reported evidence but is never alone
  sufficient for a complete total: missing catalogue rates become zero, so even
  a positive value can be partial. A proven plan/free mode or a separately
  complete component estimate decides the canonical total.
- For a `payg` or `unknown` OpenCode call, engine-reported zero is not
  authoritative. Fall through to a complete component estimate; if no complete
  estimate is possible, the total cost is unknown.
- Model prefix alone must not prove a zero-cost mode when the provider can fall
  back from subscription quota to a balance-funded route.
- Crush `delta_cost_usd` is accepted, including explicit zero, because the
  pinned Crush envelope defines it as real per-call cost. It remains labelled
  engine-reported rather than provider-reported.
- A component is priced only when both its token count and rate are known.
- If a non-zero known component has no rate, an estimated total is incomplete
  and must not be presented as the complete call cost.
- A missing token count or price is not treated as zero.
- Reasoning uses the ordinary output rate only when that is the documented
  billing rule for the model/provider.
- For a subscription plan with no per-call monetary charge, `total_usd` is
  `0`, `source` is `plan`, and component costs remain `null` unless the plan
  explicitly reports them. Proven free-tier calls use `source: "free"`.
- `cost.complete` states whether `total_usd` represents the complete monetary
  call cost.
- `unknown_components` names every non-zero or indeterminate component that
  prevented a complete estimate.

Existing three-value overrides remain accepted for backward compatibility:

```text
TRISS_PRICE_<MODEL>=input_uncached,cache_read,output
```

The expanded form is:

```text
TRISS_PRICE_<MODEL>=input_uncached,cache_read,cache_write,output
```

The parser must distinguish the formats by arity. The three-value format leaves
the cache-write rate unknown; it must not copy the ordinary input rate.

### Built-in price-table migration

Existing built-in rows migrate explicitly:

| v1 key | v2 meaning |
| --- | --- |
| `input_cache_miss` | `input_uncached` |
| `input_cache_hit` | `cache_read` |
| `output` | the provider's documented total-output rate |

No current built-in row implicitly acquires a cache-write rate. Its
`cache_write` rate is `null` until current provider documentation supplies a
model-specific value. A non-zero cache-write count therefore makes a Triss
estimate incomplete unless an expanded override or verified built-in row
provides the rate.

The v1 `output` rate is applied as follows:

- when only `output_total` is known, price that total once;
- when `output_visible` and `reasoning` are separately known, use the same
  output rate for both only when the current provider/model billing contract
  confirms reasoning is billed as output;
- otherwise leave the reasoning component and complete estimated total
  unknown rather than double-counting or assuming a free component.

Phase 1 must re-verify the current DeepSeek, Z.AI, Kimi, OpenCode, and Crush
billing contracts and record the result in `docs/usage-accounting.md`. Each
built-in model family needs a fixture that proves its real v2 price mapping;
synthetic override tests alone do not satisfy the acceptance criteria.

`priceFor()` continues to look up only `billing_model`. The informational
`provider` field never participates in price selection. Existing Moonshot
prefix normalization and Z.AI endpoint/plan prefixes remain part of the
billing-model lookup contract.

The exported `estimateCost(record)` function remains available for one
transition release as a deprecated v1 compatibility wrapper. It accepts the
existing flat record shape, normalizes it with `normalizeUsageRecord()`, and
delegates to the new canonical component estimator. Existing numeric/null
return behavior is locked by tests. Production v2 paths call the canonical
estimator directly; removing the wrapper or changing its signature requires a
separate breaking-change decision.

## Persistence and backward compatibility

### New records

`logUsage()` accepts the canonical v2 token and cost objects and appends one
serialized JSONL record. This plan does not claim cross-process transactional
or atomic-line guarantees beyond the behavior of the existing append path.

The v1 `prompt_tokens == null` admission guard is removed for canonical calls.
A v2 record is written when:

- `model` and `billing_model` are known; and
- a direct provider response, parsed coder envelope, or terminal engine event
  reached the usage-recording boundary.

At least one numeric usage field is not required. A completed call with no
reported counters is written with `usage_status: "missing"` and nullable token
and cost fields. Preflight, credential, configuration, and spawn failures that
never reach a provider/engine call remain outside usage logging. The
`TRISS_USAGE_LOG=0` opt-out remains authoritative.

Direct API callers must invoke the recording boundary after a successful
response even when `resp.usage` is absent. OpenCode calls with parsed events but
no `step_finish`, and parsed Crush envelopes without counters, use the same
missing-usage record rather than fabricating zeros or disappearing.

For a transition period, v2 records retain the existing top-level
`prompt_tokens`, `cached_tokens`, `completion_tokens`, `cost_usd`, and
`cost_usd_known` fields for external readers. These are compatibility fields
only:

- they preserve the existing per-source meaning;
- v2 aggregation and rendering never read them when canonical fields exist;
- they are documented as deprecated and ambiguous;
- they are not allowed to overwrite canonical values.

In particular, the canonical Crush record remains combined-only even if the
legacy `completion_tokens` compatibility field retains `delta_tokens` for one
release.

### Coder envelope compatibility

The CLI and MCP coder envelope retain the existing top-level envelope fields.
Its `usage` member becomes:

```json
{
  "usage": {
    "schema_version": 2,
    "usage_status": "reported",
    "tokens": {
      "input_uncached": 303,
      "cache_read": 14272,
      "cache_write": 0,
      "output_visible": 19,
      "reasoning": 15,
      "input_total": 14575,
      "output_total": 34,
      "total": 14609,
      "combined": null
    },
    "cost": {
      "reported_total_usd": 0,
      "reported_total_source": "engine",
      "total_usd": 0,
      "source": "free",
      "complete": true
    },
    "prompt_tokens": 303,
    "completion_tokens": 19
  }
}
```

`prompt_tokens` and `completion_tokens` remain deprecated compatibility aliases
for one transition release and preserve their existing per-engine meaning.
Canonical consumers use `usage.tokens` and `usage.cost` only. For Crush,
`tokens.combined` and `tokens.total` contain `delta_tokens`, all split fields
are `null`, and the deprecated `completion_tokens` alias may retain
`delta_tokens` for the transition release.

The CLI and MCP coder paths return the same `usage` shape. `docs/mcp.md`, MCP
tool descriptions, fixtures, and both coder-envelope test suites must document
and assert it.

### Legacy records

Records without `schema_version` are read without modifying the file.

Keep raw parsing separate from normalization: `readLog()` (or an explicitly
renamed raw reader with a compatibility wrapper) returns persisted objects,
while a pure `normalizeUsageRecord()` produces the in-memory canonical shape
for aggregation. The compatibility normalizer:

- preserves the old prompt, cached, completion, and flat cost values as
  compatibility evidence, while non-plan v1 estimates remain canonically incomplete;
- derives only a legacy `total = prompt_tokens + completion_tokens`;
- treats old cached tokens as reported cache-read detail but does not infer all
  other atomic fields;
- leaves unrecoverable reasoning and cache-write fields `null`;
- marks the normalized record as legacy/incomplete;
- never claims that old OpenCode input/output represented the complete call.

Previously discarded OpenCode cache/reasoning values can be recovered only
from retained engine events or OpenCode session storage, not from the old Triss
usage JSONL.

`triss usage --json` preserves its current compatibility contract in this
release: it returns raw persisted records from the active `usage.jsonl`, before
period or grouping filters. `--since`, `--month`, and grouping flags therefore
do not change raw JSON output. Normalized or filtered JSON requires a separate
flag and is outside this change; it must not silently replace the existing raw
surface.

`readLog()` and all v2 aggregates continue to read only the active
`usage.jsonl`. The single rotated `usage.jsonl.old` archive is not included in
long-horizon totals in this scope. Public documentation must state this limit;
archive-inclusive history is a separate feature.

The larger record is part of the retention contract, not a neutral
implementation detail. A representative record grows from about 268 bytes in
v1 to about 996 bytes in v2 with compatibility fields, so retaining the old
10 MiB default would reduce the active-log call horizon from roughly 39,000 to
roughly 10,500 similar calls. The v2 release therefore raises the default
`TRISS_USAGE_LOG_MAX_BYTES` from 10 MiB to 40 MiB (`41943040`). Explicit user
overrides remain unchanged. With one rotated archive, default disk use is
approximately 80 MiB plus the records that cross each rotation threshold.
README, `.env.example`, and the public accounting/configuration documentation
must state the new default, the approximate nature of the call horizon, and
that reports still exclude `usage.jsonl.old`.

## Aggregation contract

Every token and component-cost aggregate tracks:

- `sum` of known numeric values;
- `known_calls`, where explicit zero counts as known;
- `unknown_calls`;
- optional `reported_calls` and `derived_calls` for totals.

Aggregates must never convert `null` to zero before calculating coverage.
Totals are aggregated independently from their components and are never added
to a component sum.

Grouped views by model, project, and label use the same canonical aggregation.
`--by-model` remains keyed strictly by the persisted `model` field.
`billing_model` participates only in price lookup and never replaces or
normalizes the reporting group key. Thus distinct persisted routes such as
`zai/glm-5.2` and `zai-coding-plan/glm-5.2` remain distinct model groups.
Sorting by cost uses complete known total cost and must not present a partial
estimate as a complete total.

For one transition release, `summarize()` also retains its existing
`prompt_tokens`, `cached_tokens`, `completion_tokens`, `cost_usd`,
`known_cost_usd`, `known_cost_calls`, and `unknown_cost_calls` keys on total and
group objects. These deprecated values are computed from compatibility fields
and never drive the v2 CLI. Canonical field aggregates and coverage are added
alongside them. Focused tests lock both return shapes so the migration cannot
silently break current internal or deep-import consumers.

## CLI contract

When all OpenCode fixture details are known, `triss usage` presents separate
categories:

```text
Triss usage · 1 call · last 24h

  total:         14,609

  input:
    uncached:       303
    cache read:  14,272
    cache write:      0

  output:
    visible:         19
    reasoning:       15

  cost:          $0.0000 · free
```

When a breakdown is incomplete, the CLI reports coverage rather than implying
zero:

```text
  reasoning: 930 · reported by 12/25 calls
  cache write: unavailable
```

For Crush, the CLI labels the value as combined and does not render it under
completion/output:

```text
  total:    42
  combined: 42 · input/output split unavailable
```

Compact grouped rows may omit zero-detail lines, but must expose incomplete
coverage or provide a clearly documented detail/JSON path to it.

### Per-call usage output

`reportUsage()` uses the same normalized usage object as persistence. It must
not independently re-parse only `prompt_tokens_details.cached_tokens`.

The compact stderr/MCP suffix preserves a one-line form but exposes every known
atomic category and marks incomplete detail. For example:

```text
[triss/ask: 303 uncached input + 14,272 cache-read / 19 visible + 15 reasoning | total 14,609 | finish: stop]
```

Unknown categories are omitted from the arithmetic and represented by an
`incomplete usage detail` marker; they are never printed as zero. When a
reported input/output total exists but its atomic split does not, render the
total with `split unavailable` rather than hiding it. Existing commands and MCP
handlers that call `reportUsage()` receive the same format. Focused tests cover
DeepSeek, Z.AI, Kimi, generic worker, streaming, and missing usage responses.

### MCP content/usage boundary

Human-readable usage text is not an internal framing protocol. The existing
`callModel()`/`writeHandler` contract is already inconsistent: `callModel()`
appends a `[triss: ...]` suffix while `writeHandler` searches for `[triss/`, so
`triss_write` can copy the suffix into the target file. The v2 implementation
removes marker parsing instead of blessing either spelling.

Internally, `callModel()` returns `{ content, usageReport }`, keeping generated
content and the rendered usage report in separate fields. Text-returning MCP
handlers compose those fields at the response boundary. `writeHandler` writes
only `content` and includes `usageReport` once in its MCP status
response; the usage report must never be persisted in the target file. If no
target is supplied, the handler returns the generated content plus the usage
report once. Focused tests vary the human-readable `reportUsage()` format to
prove that file-content separation does not depend on a magic prefix.

## Implementation phases

### Phase 1 — public documentation and contract lock

Complete before production code or RED tests:

- add `docs/usage-accounting.md` as the public usage schema and CLI contract;
- update the README usage section to link to it and show the new categories;
- update `.env.example` with the three-value/four-value override forms,
  nullable cache-write semantics, and the 40 MiB usage-log default;
- update `docs/configuration.md` with three-value and four-value price override
  semantics;
- update `docs/glm-clients.md` where it compares OpenCode and Crush usage/cost;
- update `docs/mcp.md` with JSONL compatibility, cost completeness, the coder
  envelope v2, and raw `triss usage --json` behavior;
- update MCP tool descriptions when the public envelope wording changes;
- update `templates/claude-full.md`, which documents the coder envelope
  verbatim (`"usage": { "prompt_tokens": 0, "completion_tokens": 0 }`) and
  therefore cannot stay unchanged; audit `templates/claude.md`,
  `templates/codex.md`, and `templates/codex-full.md`, which only name the
  `usage` member, and record explicitly if no change is required there;
- document that active-log aggregation excludes `usage.jsonl.old`, why the v2
  default rotation threshold rises to 40 MiB, and the resulting approximate
  report horizon/disk bound;
- verify non-zero OpenCode cache-write total semantics against the pinned
  runtime before publishing a derivation rule;
- reconcile this plan with repository findings before declaring the contract
  locked.

Documentation acceptance criteria:

- `null` versus explicit zero is stated unambiguously;
- atomic categories and totals are distinguished;
- every supported source has an explicit mapping table;
- reported, plan, estimated, partial, and unknown costs are distinguished;
- OpenCode positive/zero cost trust rules and ambiguous billing-mode fallback
  are explicit;
- the built-in price-table migration is documented per model family;
- legacy records and compatibility fields are documented;
- coder CLI/MCP envelopes and `reportUsage()` have explicit compatibility
  contracts;
- the `triss_write` content/usage boundary is structural rather than based on
  a display-string marker;
- raw JSON and rotated-log boundaries are explicit;
- the new rotation default and retention trade-off are explicit;
- the CLI examples cover complete, partial, and combined-only usage;
- no production-code behavior is described only in this internal plan.

### Phase 2 — focused RED

Add executable tests before changing production code.

API normalization tests establish:

1. DeepSeek top-level hit/miss and reasoning fields map separately.
2. Z.AI nested cached tokens map separately and uncached input is derived.
3. Kimi top-level cached tokens are captured.
4. Streaming and non-streaming shapes normalize identically.
5. Missing detail remains `null`.
6. Explicit zero remains `0` and counts toward coverage.
7. Conflicting or invalid totals produce warnings rather than silent repair.
8. A successful response without `usage` produces a `usage_status: "missing"`
   record rather than disappearing.
9. `reportUsage()` consumes normalized usage and never prints an unavailable
   category as zero.

OpenCode tests replay the existing fixture and require exactly:

```text
input_uncached = 303
cache_read = 14,272
cache_write = 0
output_visible = 19
reasoning = 15
input_total = 14,575
output_total = 34
total = 14,609
```

They also prove that fields sum across every `step_finish`, optional totals are
accepted, explicit zeros remain known, and reported/component mismatches warn.
Because Phase 1 verified the pinned-runtime normalization, a synthetic
non-zero cache-write case must also assert
`input_total = input_uncached + cache_read + cache_write` and the derived
`total`.

OpenCode cost tests require:

- positive engine-reported cost is preserved separately and can become the
  complete total only under the documented trust rule;
- engine-reported zero is known for a proven subscription/free call;
- the same zero does not override a complete PAYG component estimate;
- zero for an unknown or ambiguous billing mode yields estimate-or-unknown,
  never known-free;
- a parsed event stream without `step_finish` produces a missing-usage record.

Crush tests require:

- `delta_tokens` is canonical combined/total usage, not output;
- input/output/cache/reasoning remain `null`;
- `delta_cost_usd` reaches the persisted record;
- missing reported cost remains unknown.

Usage and cost tests require:

- distinct input, cache-read, cache-write, and output rates produce the exact
  component and total cost;
- a missing cache-write rate makes a non-zero cache-write estimate incomplete;
- trusted provider-reported total cost wins without fabricated component
  splits;
- subscription-plan total cost is known zero while component costs remain
  unavailable;
- every built-in price row uses the documented v2 mapping and has a real-model
  regression test;
- v1 records remain readable and incomplete;
- the exported `estimateCost()` keeps accepting the v1 flat shape and delegates
  to the canonical estimator without changing its legacy return behavior;
- v2 aggregation preserves null coverage;
- deprecated `summarize()` keys remain available for the transition release;
- `--by-model` groups by `model`, never by `billing_model`;
- `--json` remains raw, active-log-only, and unaffected by period/group flags;
- the default rotation threshold is 40 MiB while explicit overrides still win;
- coder CLI and MCP envelopes expose the same canonical v2 usage plus legacy
  aliases;
- `triss_write` never writes the usage report into its target, returns the
  report exactly once, and does not depend on the report prefix for framing;
- the renderer emits complete, partial, and combined-only formats.

The focused RED run must fail for missing production behavior, not for fixture,
environment, or import errors. Record the failing assertions before GREEN.

### Phase 3 — minimum GREEN vertical slices

Implement in this order, keeping each focused suite green before moving on:

1. canonical v2 validation, billing identity, admission rules, and v1 read
   normalization;
2. built-in price-table migration and separated override parsing;
3. direct API usage normalizer shared by streaming, non-streaming, persistence,
   and `reportUsage()`;
4. OpenCode event folding, billing-mode cost trust, and envelope propagation;
5. Crush combined usage and reported-cost persistence;
6. separated component cost calculation and the deprecated `estimateCost()`
   compatibility wrapper;
7. canonical aggregation with field coverage and deprecated summary keys;
8. CLI, grouped, and per-call rendering;
9. structured MCP content/usage separation across every `callModel()` caller,
   including the injected `callModel` dependency consumed by
   `src/mcp/review-core.js`, plus coder envelope compatibility and tool
   documentation;
10. legacy compatibility fields, 40 MiB rotation default, and raw JSON
    behavior.

Do not introduce a broad provider abstraction unrelated to usage accounting.
Prefer pure normalizer and aggregator functions with provider-shaped fixtures.

### Phase 4 — refactor with GREEN held

After the complete focused suite is green:

- remove duplicated streaming/non-streaming extraction;
- centralize nullable numeric validation and provenance handling;
- centralize reported-versus-derived total reconciliation;
- ensure cost calculation consumes canonical atomic fields only;
- ensure the CLI consumes canonical aggregate structures only;
- inspect naming for accidental input/cache or output/reasoning conflation;
- rerun focused tests after every refactor step.

### Phase 5 — validation and review

Run the focused suite:

```bash
node --test \
  test/usage.test.js \
  test/usage-command.test.js \
  test/coder-envelope.test.js \
  test/coder-crush.test.js \
  test/mcp-coder.test.js \
  test/mcp-tools.test.js \
  test/ask.test.js \
  test/review.test.js \
  test/mcp-handlers.test.js \
  test/mcp-handlers-extra.test.js
```

Run any new provider-normalization test file explicitly if it is not included
above, then run the full suite:

```bash
npm test
```

Final review must compare documentation, tests, implementation, JSONL output,
coder envelopes, and CLI output. It must inspect the final diff for unrelated
changes and confirm the pre-existing untracked files were not modified.

## Acceptance criteria

The work is complete only when all of the following are true:

1. Public documentation was completed before production code.
2. Focused tests demonstrated genuine RED before GREEN.
3. Every supported source preserves its maximum reported detail.
4. Input, cache read, cache write, visible output, and reasoning remain separate
   in persistence, aggregation, and cost calculation.
5. Unknown fields are `null`; only explicit or valid derived zero is `0`.
6. The OpenCode fixture accounts for all 14,609 reported tokens.
7. Kimi top-level cached tokens and DeepSeek hit/miss fields are captured.
8. Z.AI authoritative totals are preserved without fabricated reasoning detail.
9. Crush tokens are combined-only and its reported cost is persisted.
10. OpenCode zero cost is known-free only for a proven free/subscription call;
    PAYG or ambiguous zero falls through to estimate-or-unknown.
11. Built-in real-model prices and custom overrides preserve distinct
    input/cache-read/cache-write/output rates.
12. The v2 recording boundary persists missing-usage calls without depending
    on legacy prompt fields.
13. CLI and MCP coder envelopes expose the same canonical usage shape while
    retaining documented transition aliases.
14. `reportUsage()` uses canonical normalization and exposes incomplete detail.
15. Partial estimates are not presented as complete costs.
16. Legacy JSONL remains readable without an automatic rewrite.
17. Deprecated `summarize()` keys remain available for the transition release.
18. Raw JSON and active-versus-rotated log behavior match the documented scope.
19. Aggregate output exposes field coverage and never hides unknowns as zero.
20. Non-zero cache-write totals are derived only after pinned-runtime evidence;
    otherwise underdetermined totals remain `null`.
21. Focused and full test suites pass with real non-zero test counts.
22. The final diff contains no unrelated changes.
23. The default active-log rotation threshold is 40 MiB, explicit overrides
    still win, and the public docs explain the approximate reporting horizon.
24. `triss_write` never writes a usage suffix into the generated file and
    returns the usage report exactly once without parsing a display marker.
25. `--by-model` groups strictly by `model`; `billing_model` is used only for
    price lookup.
26. Exported `estimateCost()` remains a tested deprecated v1 wrapper for the
    transition release while v2 code uses the canonical estimator.

## Rollout notes

- No historical usage file is migrated automatically.
- Aggregation remains active-log-only; the rotated `.old` archive is not
  silently merged.
- The default active-log threshold rises from 10 MiB to 40 MiB to offset the
  approximately 3.7x representative v2 record-size increase. This preserves a
  similar call-count horizon rather than silently shortening reports; explicit
  `TRISS_USAGE_LOG_MAX_BYTES` values remain authoritative.
- Default active-plus-rotated disk usage is approximately 80 MiB, and the
  archive remains excluded from aggregation.
- `triss usage --json` remains the raw, unfiltered compatibility surface.
- The first v2 release retains deprecated flat compatibility fields.
- A later release may remove those fields only through a separately documented
  compatibility decision.
- The first v2 release also retains exported `estimateCost()` as a deprecated
  flat-record wrapper; canonical code does not use that surface, and removing
  it requires a separate breaking-change decision.
- Provider response fixtures should be retained as contract fixtures so SDK or
  provider schema drift produces a focused failure.
- Current provider documentation and live fixture shapes must be re-verified at
  implementation time because API response contracts can change.

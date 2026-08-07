# Usage accounting

How Triss records what a call consumed, what it cost, and what it does **not**
know. This is the public contract for `~/.cache/triss/usage.jsonl`, the
`triss usage` report, the coder envelope's `usage` member, and the per-call
usage line Triss prints to stderr.

If you only want the commands, see the [`triss usage` section of the
README](../README.md#triss-usage). This page is the schema.

## The one rule: unknown is not zero

| Value | Meaning |
| --- | --- |
| a number | the source reported this value, including a reported `0` |
| `null` | the source did not report it, cannot report it, or Triss cannot prove its meaning |

Triss never writes `0` to stand in for "not reported". A cost of `$0.00` and a
cost of "unknown" are different outcomes, and `triss usage` renders them
differently.

## Record schema (`schema_version: 2`)

One JSONL line per model call. Token counts are integers or `null`; component
costs are finite numbers or `null`.

```json
{
  "schema_version": 2,
  "ts": "2026-08-07T00:00:00.000Z",
  "model": "opencode/deepseek-v4-flash-free",
  "billing_model": "opencode/deepseek-v4-flash-free",
  "billing_mode": "unknown",
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
    "total_usd": null,
    "source": "unknown",
    "complete": false,
    "unknown_components": ["input_total"]
  }
}
```

Note the cost in that example. The engine reported `0`, and Triss keeps that
signal in `reported_total_usd` — but an OpenCode Zen route is not *proven*
free, so the zero does not become the call's cost. See
[Proving a free call](#proving-a-free-call).

### Atomic token fields

These five never contain each other. Adding all five gives the call total.

| Field | Meaning |
| --- | --- |
| `input_uncached` | input tokens processed without a cache-read hit |
| `cache_read` | input/context tokens served from a provider cache |
| `cache_write` | tokens written into a provider cache |
| `output_visible` | generated output **excluding** separately reported reasoning |
| `reasoning` | separately reported reasoning/thinking tokens |

`combined` is the sixth token field and is not atomic: it holds a source total
that cannot be split at all (Crush). When `combined` is set, every atomic field
is `null`.

### Total fields and provenance

`input_total`, `output_total`, and `total` are *totals*, not categories. Each
carries `"reported"` or `"derived"` in its `*_source` sibling:

- **reported** — the source sent this number;
- **derived** — Triss computed it from known components;
- `null` — neither available.

Rules:

- a reported total is preserved even when its components are incomplete;
- a derived total is produced only when **every** contributing component is
  known;
- when a reported total disagrees with the known components, Triss keeps the
  reported value and records a normalization warning; it never silently
  "repairs" either side;
- aggregation adds totals to totals and components to components, never
  totals into a component sum.

### Identity fields

| Field | Purpose |
| --- | --- |
| `model` | the reporting/grouping key. `triss usage --by-model` groups strictly by this. |
| `billing_model` | the **only** key used for price lookup. Keeps the endpoint/plan prefix (`zai/glm-5.2` vs `zai-coding-plan/glm-5.2`). |
| `provider` | informational identity for diagnostics. Never selects a price. Never inferred from which API keys happen to be set. |
| `usage_source` | which payload contract Triss parsed: `api`, `opencode`, or `crush`. |
| `engine` | `opencode`, `crush`, or `null` for direct API calls. |
| `billing_mode` | `payg`, `subscription`, `free`, or `unknown`. |
| `usage_status` | `reported` or `missing`. |

`provider` is derived from the resolved model prefix:

| Prefix | `provider` |
| --- | --- |
| `triss-worker/*` | `worker` |
| `zai/*`, `zai-coding-plan/*` | `zai` |
| `opencode/*` | `opencode-zen` |
| `opencode-go/*` | `opencode-go` |
| `moonshotai/*`, `moonshotai-cn/*` | `moonshot` |
| `kimi-for-coding/*` | `kimi-for-coding` |
| Crush runs | `zai`, with `engine: "crush"` |

`billing_mode` classification is **fail-closed** — when a route could have been
served either by a subscription quota or by a balance-funded fallback and the
event does not prove which, the mode is `unknown`, not `subscription`:

| Resolved route | `billing_mode` |
| --- | --- |
| `zai/*` | `payg` |
| `zai-coding-plan/*` | `subscription` |
| `moonshotai/*`, `moonshotai-cn/*` | `payg` |
| `kimi-for-coding/*` | `subscription` |
| OpenCode Zen model proven free by a caller-supplied set | `free` |
| OpenCode Zen model without that proof | `unknown` |
| OpenCode Go with a proven per-call subscription route | `subscription` |
| OpenCode Go that may fall back to Zen balance | `unknown` |
| `triss-worker/*` (configurable endpoint) | `unknown` — a configured price can still produce an estimate |
| Crush | token pricing may stay `unknown`; cost trust follows `delta_cost_usd` |

### Proving a free call

`billing_mode: "free"` requires the caller to pass a set of model ids it has
*proven* free. A `-free` suffix is not proof, and neither is a zero cost from
the engine — OpenCode computes that zero from its own catalogue and returns it
just as readily for a model the catalogue prices incompletely.

Triss's own coder path does not have that proof today: the authenticated Zen
catalogue it queries returns model **ids only**, with no rates, so a Zen run is
classified `unknown` and its engine-reported zero stays in
`reported_total_usd` without becoming the call's cost. A Zen call therefore
reports its cost as unknown rather than as `$0`. Set a matching
`TRISS_PRICE_<MODEL_ID>` override (all zeros for a free model) if you want it
priced. Should the catalogue start publishing rates, this classification can
tighten without changing the record schema.

`usage_status: "missing"` means the call completed but reported no counters at
all. Such a call is still logged, with `null` token fields — absence is never
represented as an all-zero record. Anything else is `reported`; how much of the
detail a source supplied is expressed by which token fields are `null`, not by
a third status value.

## Source mappings

### OpenCode (`usage_source: "opencode"`)

Triss folds every `step_finish` event. Events are **step-level, not
cumulative**, so each field is summed independently across events. A missing
field in one event does not discard the value reported by another; a field
stays `null` for the whole call only when no event reported it.

| OpenCode event field | Canonical field |
| --- | --- |
| `part.tokens.input` | `input_uncached` |
| `part.tokens.cache.read` | `cache_read` |
| `part.tokens.cache.write` | `cache_write` |
| `part.tokens.output` | `output_visible` |
| `part.tokens.reasoning` | `reasoning` |
| `part.tokens.total` | reported `total` |
| `part.cost` | `cost.reported_total_usd`, with `reported_total_source: "engine"` |

Derivations (see [Verified engine facts](#verified-engine-facts) for the
evidence):

```text
input_total  = input_uncached + cache_read + cache_write
output_total = output_visible + reasoning
total        = input_total + output_total     (only when no reported total exists)
```

The `cache_write` term is included in `input_total` because the pinned engine
subtracts both cache classes out of the provider's input count. `output_visible`
excludes reasoning for the same reason: the pinned engine subtracts reasoning
out of the provider's output count.

The fold tolerates unknown event types and truncated NDJSON lines. Parsed event
streams containing no `step_finish` produce a `usage_status: "missing"` record
rather than a zero-filled one.

### DeepSeek-compatible API responses (`usage_source: "api"`)

| Provider field | Canonical field |
| --- | --- |
| `prompt_tokens` | reported `input_total` |
| `prompt_cache_miss_tokens` | `input_uncached` |
| `prompt_cache_hit_tokens` | `cache_read` |
| `completion_tokens` | reported `output_total` |
| `completion_tokens_details.reasoning_tokens` | `reasoning` |
| `total_tokens` | reported `total` |

`cache_write` stays `null` — DeepSeek does not report or charge for cache
creation. `output_visible` is derived as `output_total - reasoning` only when
the provider contract guarantees reasoning is a subset of the completion count
and the result is non-negative; otherwise it stays `null`.

If cache hit + cache miss disagrees with `prompt_tokens`, every reported field
is preserved and a normalization warning is emitted. Such warnings are written
once to stderr (dimmed, prefixed `[triss] usage warning: `) — they never alter
the persisted record or the printed usage line.

### Z.AI API responses (`usage_source: "api"`)

| Provider field | Canonical field |
| --- | --- |
| `prompt_tokens` | reported `input_total` |
| `prompt_tokens_details.cached_tokens` | `cache_read` |
| `completion_tokens` | reported `output_total` |
| `total_tokens` | reported `total` |

`input_uncached = input_total - cache_read` (derived) when both are known and
the subtraction is valid. `cache_write`, `output_visible`, and `reasoning` stay
`null`: Z.AI prices cached-input *storage* separately but does not report a
cache-write token count in the chat-completions response.

Reasoning **content** is not a token counter. Triss never measures the length
of `reasoning_content` to invent a reasoning count.

### Kimi (Moonshot) API responses (`usage_source: "api"`)

| Provider field | Canonical field |
| --- | --- |
| `prompt_tokens` | reported `input_total` |
| top-level `cached_tokens` | `cache_read` |
| `completion_tokens` | reported `output_total` |
| `total_tokens` | reported `total` |

`input_uncached` is derived only when the documented cached value is a subset
of the prompt count and the subtraction is valid. `cache_write`,
`output_visible`, and `reasoning` stay `null` when not reported.

### Generic OpenAI-compatible worker (`usage_source: "api"`)

The worker endpoint is user-configurable, so normalization recognises the
documented aliases without assuming any endpoint implements them:

1. `prompt_tokens`, `completion_tokens`, `total_tokens` when present;
2. nested `prompt_tokens_details.cached_tokens`;
3. DeepSeek top-level `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`,
   each recognised on its own — a response reporting only one half still keeps
   that half rather than discarding it as unknown;
4. Kimi top-level `cached_tokens`;
5. `completion_tokens_details.reasoning_tokens`;
6. everything else stays `null`.

Conflicting aliases are never silently combined. When the resolved provider is
known, its documented shape wins. When it is not, and a response carries both
the DeepSeek hit/miss pair and a nested or top-level cached count that
disagrees with it, the hit/miss pair is used — it is the only alias that
reports the uncached and cached halves independently — and the disagreement is
recorded as a warning. Streaming and non-streaming responses go through the
same normalizer and produce identical records.

### Crush (`usage_source: "crush"`)

| Crush field | Canonical field |
| --- | --- |
| `usage.delta_tokens` | reported `combined` **and** reported `total` |
| `usage.delta_cost_usd` | `cost.total_usd` with `source: "engine_reported"` |

Every split field — `input_uncached`, `cache_read`, `cache_write`,
`output_visible`, `reasoning`, `input_total`, `output_total` — stays `null`.
Crush's combined count is never stored as completion tokens in the canonical
record.

## Cost

### Price components

A price definition supports independent rates for `input_uncached`,
`cache_read`, and `cache_write`, plus one output rate.

Input is priced per component: `input_uncached_usd`, `cache_read_usd`, and
`cache_write_usd`. Output is priced once, as `output_total_usd`, because every
provider Triss supports today documents a single output rate — see
[How reasoning is priced](#how-reasoning-is-priced). `output_visible_usd` and
`reasoning_usd` exist in the schema for a future provider that bills them
apart, and stay `null` in this release.

### What makes an estimate complete

An estimate is complete when the priced components account for the **whole**
call, not merely when some component happened to be priced:

- the **input side** is covered when the known input components sum exactly to
  a known `input_total`, or when all three input components are known and no
  `input_total` was reported;
- the **output side** is covered when `output_total` is known (reported, or
  derived from a fully known `output_visible` + `reasoning`);
- every covered component that is non-zero also has a known rate.

This is what lets a DeepSeek or Z.AI call be complete without a cache-write
rate: those providers report `input_uncached + cache_read == prompt_tokens`, so
the input side is already fully accounted for and no cache-write class exists
in the response. Conversely, a non-zero `cache_write` with no configured rate
leaves the estimate incomplete and names `cache_write` in `unknown_components`.

### Precedence

1. a **provider-reported** monetary total whose API contract defines it as the
   charge for this call;
2. an **engine-reported** total whose engine contract defines it as the real
   monetary cost (Crush `delta_cost_usd`), or a **positive** OpenCode engine
   estimate with known model identity;
3. a proven **subscription-plan** or **free-tier** total. A plan or free call
   takes this branch even when the engine also reported a zero: the zero is
   known because the plan proves it, so the call is labelled `plan`/`free`
   rather than `engine_reported`, and its component costs stay `null`;
4. a **complete** Triss component estimate;
5. **unknown**.

`cost.source` is one of `provider_reported`, `engine_reported`, `plan`, `free`,
`estimated`, or `unknown`. `reported_total_source` is `provider`, `engine`, or
`null`.

### Rules

- A provider-reported total is authoritative for the call and is never split
  back across components.
- OpenCode's `part.cost` is an **engine-calculated** signal, not a provider
  bill. It is always preserved in `reported_total_usd` with
  `reported_total_source: "engine"`, separately from `total_usd`.
- A **positive** OpenCode cost may become the complete total when the pinned
  engine contract and the billing model are both known.
- An OpenCode **zero** is known-zero only when `billing_mode` is proven
  `subscription` or `free`. For a `payg` or `unknown` mode it is not
  authoritative: Triss falls through to a complete component estimate, and if
  no complete estimate is possible the total cost is unknown. See
  [Verified engine facts](#verified-engine-facts) — the engine computes a zero
  whenever the catalogue has no rate for a component.
- A model prefix alone never proves a zero-cost mode when the provider can fall
  back from subscription quota to a balance-funded route.
- Crush's `delta_cost_usd` is accepted, **including an explicit zero**, because
  the pinned Crush envelope defines it as the real per-call cost. It is still
  labelled engine-reported, not provider-reported.
- A component is priced only when both its token count and its rate are known.
- A non-zero known component with no rate makes the estimate **incomplete**;
  an incomplete estimate is never presented as the call's complete cost.
- A missing count or a missing price is never treated as zero.
- Reasoning uses the ordinary output rate only where that is the documented
  billing rule for the provider (see below).
- For a subscription plan with no per-call charge, `total_usd` is `0`,
  `source` is `plan`, and component costs stay `null` unless the plan reports
  them. Proven free-tier calls use `source: "free"`.
- `cost.complete` states whether `total_usd` is the complete monetary cost.
- `unknown_components` lists every non-zero or indeterminate component that
  prevented a complete estimate.

### How reasoning is priced

Two different provider shapes exist, and Triss must not conflate them:

- **DeepSeek, Z.AI, Kimi** report `completion_tokens` as a count that already
  *includes* reasoning. Triss prices the reported `output_total` **once** at
  the output rate. Reasoning is not free here — it is already inside the priced
  total — so no assumption about a separate reasoning rate is required.
- **OpenCode** reports `output` with reasoning already subtracted. The pinned
  engine prices `reasoning` at the model's **output** rate, so `output_total`
  (`output_visible + reasoning`) priced once at the output rate is exactly what
  the engine itself would charge.

Both cases therefore reduce to one `output_total_usd` at the output rate.
Where neither rule applies, the output cost and the complete estimated total
stay unknown rather than being guessed at.

### Price overrides

The legacy three-value form stays supported:

```text
TRISS_PRICE_<MODEL>=<input_uncached>,<cache_read>,<output>
```

The expanded four-value form adds the cache-write rate:

```text
TRISS_PRICE_<MODEL>=<input_uncached>,<cache_read>,<cache_write>,<output>
```

Rates are USD **per token**. The parser distinguishes the two forms by arity.
The three-value form leaves the cache-write rate **unknown** — it never copies
the ordinary input rate into it. The model key is the uppercased
`billing_model` with non-alphanumerics replaced by `_`, after the
`moonshotai/`/`moonshotai-cn/` prefix is stripped (so `TRISS_PRICE_KIMI_K3`
covers both the bare and the prefixed route).

An override also beats a subscription-plan's built-in zero: pricing a
`zai-coding-plan/<model>` (or `kimi-for-coding/<model>`) model explicitly makes
that call a component estimate with `source: "estimated"` instead of the plan
zero, so a user can account for a plan model whose contract differs.

### Built-in price table

Built-in rows migrate from the v1 keys as follows:

| v1 key | v2 meaning |
| --- | --- |
| `input_cache_miss` | `input_uncached` rate |
| `input_cache_hit` | `cache_read` rate |
| `output` | the provider's documented total-output rate |

No built-in row silently acquires a cache-write rate. Every built-in
`cache_write` rate is `null` until provider documentation supplies a
model-specific value. A non-zero cache-write count therefore makes a Triss
estimate incomplete unless a four-value override supplies the rate.

`priceFor()` looks up `billing_model` only. The informational `provider` field
never participates in price selection.

## Verified engine facts

These are the pinned-runtime and provider facts the contract above rests on.
Re-verify them when the pin moves — API and engine contracts do change.

### OpenCode 1.18.7 (pinned)

Normalization of a provider `usage` object into the `tokens` shape Triss parses:

```text
input     = max(0, usage.inputTokens - cacheReadInputTokens - cacheWriteInputTokens)
output    = max(0, usage.outputTokens - usage.reasoningTokens)
reasoning = usage.reasoningTokens
cache.read  = usage.cacheReadInputTokens
cache.write = usage.cacheWriteInputTokens
              (or the provider metadata equivalent, e.g. Anthropic's
               cacheCreationInputTokens)
total     = usage.totalTokens, passed through as-is and therefore absent
            when the provider omits it
```

Consequences locked into this contract:

- `cache_write` is **outside** `input`, so `input_total = input + cache.read +
  cache.write` holds even when `cache.write` is non-zero;
- `output` **excludes** reasoning, so `output_total = output + reasoning`;
- a reported `total` comes straight from the provider and can be missing.

Cost, as computed by the same engine:

```text
cost = input       * price.input      / 1e6
     + output      * price.output     / 1e6
     + cache.read  * price.cache_read / 1e6
     + cache.write * price.cache_write/ 1e6
     + reasoning   * price.output     / 1e6
```

Each missing rate defaults to `0`. This is why an OpenCode `cost: 0` is not
evidence of a free call — it is equally consistent with a model the catalogue
prices incompletely. It also establishes that the engine bills reasoning at the
output rate.

The repository fixture `test/fixtures/opencode-run-events.ndjson` reports two
steps totalling 303 input, 14,272 cache-read, 0 cache-write, 19 visible output,
and 15 reasoning tokens — 14,609 in all, matching both reported step totals.

### Provider billing contracts

Re-verified 2026-08-07 unless noted:

| Provider | Cache-read rate | Cache-write charge | Reasoning |
| --- | --- | --- | --- |
| DeepSeek | separate published cache-hit rate | none published | inside `completion_tokens` |
| Z.AI | separate published "Cached Input" rate | "Cached Input Storage" line, currently *limited-time free*; no cache-write token count in the API response | inside `completion_tokens` |
| Kimi (Moonshot) | published; **prices not re-verifiable from the public docs page on 2026-08-07** (rendered client-side), so the built-in rows keep their 2026-07-27 snapshot | none published | inside `completion_tokens` |
| OpenCode | per-model `cache_read` in the live catalogue | per-model `cache_write` where the catalogue supplies one; absent for several models | billed at the output rate |
| Crush | not itemised | not itemised | not itemised; only `delta_cost_usd` |

Because Z.AI's cache-write charge is explicitly temporary and its API reports
no cache-write token count, Triss keeps the Z.AI `cache_write` rate `null`
rather than baking in a zero that would expire.

## Persistence

### What gets written

A v2 record is written when `model` and `billing_model` are known **and** a
provider response, a parsed coder envelope, or a terminal engine event reached
the recording boundary. At least one numeric field is *not* required.

Failures that never reach a provider or engine call — preflight, credential,
configuration, and spawn errors — are not logged as usage. `TRISS_USAGE_LOG=0`
still disables logging entirely.

### Compatibility fields

For one transition release, every v2 record also carries the flat v1 fields
`prompt_tokens`, `cached_tokens`, `completion_tokens`, `cost_usd`, and
`cost_usd_known`, with their existing per-source meaning. They are
**deprecated and ambiguous**:

- v2 aggregation and rendering never read them when canonical fields exist;
- they never overwrite a canonical value.

In particular, a canonical Crush record stays combined-only even though its
legacy `completion_tokens` field keeps `delta_tokens` for this release.

### Reading older records

Records without `schema_version` are read as-is; the log is never rewritten in
place. A pure normalizer produces the in-memory canonical shape for
aggregation, and for a v1 record it:

- preserves the old prompt, cached, completion, and cost values;
- derives only `total = prompt_tokens + completion_tokens`;
- treats the old cached count as reported cache-read detail;
- leaves reasoning and cache-write `null`;
- marks the record legacy/incomplete, and never claims the old OpenCode
  input/output pair represented the complete call.

Cache and reasoning detail that v1 discarded cannot be recovered from the old
JSONL. It only survives in retained engine events or OpenCode session storage.

### Rotation and reporting horizon

`triss usage` and every aggregate read **only the active `usage.jsonl`**. The
single rotated `usage.jsonl.old` archive is excluded; archive-inclusive history
is a separate feature, not part of this release.

A representative record grows from roughly 268 bytes in v1 to roughly 996 bytes
in v2 with compatibility fields — about 3.7x. Keeping the old 10 MiB default
would have cut the active-log horizon from roughly 39,000 to roughly 10,500
similar calls, silently shortening every report. The v2 default
`TRISS_USAGE_LOG_MAX_BYTES` is therefore **40 MiB (`41943040`)**, which
preserves a comparable call horizon. Explicit overrides still win. With one
rotated archive, default disk use is about 80 MiB plus whatever crosses each
rotation threshold. All of these call counts are approximations — record size
varies with model id, cwd, and how much detail the source reported.

## Aggregation

Every token and component-cost aggregate tracks:

- `sum` of the known numeric values;
- `known_calls` — an explicit `0` counts as known;
- `unknown_calls`;
- `reported_calls` / `derived_calls` for totals.

`null` is never coerced to zero before coverage is computed. Totals aggregate
independently from their components.

Grouped views by model, project, and label use the same canonical aggregation.
`--by-model` groups strictly by the persisted `model` field, so `zai/glm-5.2`
and `zai-coding-plan/glm-5.2` stay distinct groups; `billing_model` is only
ever a price key. Sorting by cost uses the complete known total and never
presents a partial estimate as a complete one.

The canonical `cost` object is aggregated too: its `reported_total_usd` carries
its own `sum`/`known_calls`/`unknown_calls` (an explicit 0 is known, `null`/absent
is unknown). When the canonical total is unavailable but an engine-reported
total exists, the CLI renders it separately — `cost: unknown · engine reported
$0.0000` — rather than discarding it.

For one transition release, `summarize()` keeps its existing `prompt_tokens`,
`cached_tokens`, `completion_tokens`, `cost_usd`, `known_cost_usd`,
`known_cost_calls`, and `unknown_cost_calls` keys alongside the canonical
aggregates. They are computed from the compatibility fields and never drive the
v2 CLI.

## CLI output

With full detail available:

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

  cost:          unknown · engine reported $0.0000
```

With partial detail, coverage is reported instead of implying zero:

```text
  reasoning: 930 · reported by 12/25 calls
  cache write: unavailable
```

For Crush, the value is labelled combined and never rendered as output:

```text
  total:    42
  combined: 42 · input/output split unavailable
```

Compact grouped rows may omit zero-detail lines, but incomplete coverage is
always reachable — either in the row itself or through a documented detail/JSON
path.

`triss usage --json` keeps its current contract in this release: it prints the
**raw persisted records** from the active `usage.jsonl`, before period or
grouping filters. `--since`, `--month`, and the grouping flags therefore do not
change its output. A normalized or filtered JSON surface would be a separate
flag.

## Per-call usage line

`reportUsage()` consumes the same normalized usage object as persistence — it
never re-parses a single provider field on its own. The compact one-line form
exposes every known atomic category and marks incomplete detail:

```text
[triss/ask: 303 uncached input + 14,272 cache-read / 19 visible + 15 reasoning | total 14,609 | finish: stop]
```

Unknown categories are omitted from the arithmetic and flagged with an
`incomplete usage detail` marker; they are never printed as `0`. When a
reported input or output total exists but its split does not, the total is
rendered with `split unavailable` rather than hidden.

### MCP content and usage are separate values

The usage line is display text, not a framing protocol. Internally
`callModel()` returns `{ content, usageReport }`, and text-returning MCP
handlers compose the two at the response boundary.

`triss_write` writes **only** `content` to the target file and returns
`usageReport` once in its status response. The usage report is never persisted
into the written file, and nothing depends on the report's prefix or wording —
changing the human-readable format cannot leak it into a file.

## Coder envelope

The CLI and MCP coder paths return the same `usage` member:

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

`prompt_tokens` and `completion_tokens` are deprecated compatibility aliases
kept for one transition release with their existing per-engine meaning.
Canonical consumers read `usage.tokens` and `usage.cost` only.

For Crush, `tokens.combined` and `tokens.total` hold `delta_tokens`, every
split field is `null`, and the deprecated `completion_tokens` alias may still
carry `delta_tokens` during the transition.

## Scope limits

Triss does **not**:

- fabricate historical detail that was never persisted;
- infer reasoning tokens from the length of `reasoning_content`;
- infer cache write from cache read or from ordinary input;
- split a provider-reported total cost proportionally across components;
- rewrite an existing usage log in place;
- merge `usage.jsonl.old` into reports.

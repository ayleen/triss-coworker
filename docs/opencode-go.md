# OpenCode Go coder provider

OpenCode Go is a paid provider for the `opencode` coder engine. It is not a
new Triss worker backend: `triss ask` and `triss review` keep their existing
providers, while agentic coding runs can select `opencode-go/*` models.

## Setup

Use the OpenCode workspace key already associated with the Go subscription:

```bash
triss coder init --provider opencode-go --global
```

Project-local setup uses `--local` instead. Triss stores the key as
`OPENCODE_API_KEY`, verifies the authenticated Go catalogue, writes a
deny-first `opencode.json`, and pins the selected main and small models. The
current default is `opencode-go/deepseek-v4-flash` when the catalogue offers
it.

Initialization fails closed when the catalogue returns HTTP 401/403, malformed
data, or a successful but empty `data: []` response. Network/timeout failures
and HTTP 408/429/500/502/503/504 also block by default. If the account was
already verified and you deliberately want the built-in DeepSeek fallback
during a temporary provider outage, opt in explicitly:

```bash
triss coder init --provider opencode-go --allow-unverified --global
```

This flag never bypasses authentication, authorization, empty-catalogue, or
malformed-response failures.

`triss config wizard coder` intentionally has no unverified-catalogue bypass.
It fails closed on a transient Go catalogue error and prints the explicit
`triss coder init --provider opencode-go --allow-unverified --local|--global`
recovery command. Run that direct command only after deciding to accept the
temporary unverified fallback.

Zen and Go share the same environment variable, but they are separate
providers:

| Provider | Model prefix | Catalogue |
| --- | --- | --- |
| OpenCode Zen | `opencode/` | `https://opencode.ai/zen/v1/models` |
| OpenCode Go | `opencode-go/` | `https://opencode.ai/zen/go/v1/models` |

A lone `OPENCODE_API_KEY` still infers Zen for backward compatibility. Select
Go explicitly with `--provider opencode-go` (or `--provider go`) or an
`opencode-go/*` model id.

## Discover, switch, and run

```bash
triss coder models --engine opencode --provider opencode-go

triss coder model set opencode-go/deepseek-v4-flash \
  --small opencode-go/deepseek-v4-flash \
  --engine opencode --provider opencode-go --global --yes

triss coder run --model opencode-go/deepseek-v4-flash "implement the task"
```

The same fail-closed boundary applies to `coder model set --allow-unverified`:
only transport failures and HTTP 408/429/500/502/503/504 are bypassable. HTTP
401/403, an empty catalogue, malformed model entries, and every other HTTP
error remain blocking and cannot mutate the stored pair.

`coder models` prints a model-set recovery command only after a successful,
non-empty Go catalogue response supplies a verified recommended pair. For
authentication/authorization failures, an authoritative empty catalogue,
invalid data, or a transient failure, it reports the specific catalogue state
without inventing a cross-provider or otherwise unverified repair command.

The run process receives only `OPENCODE_API_KEY`; Z.AI and Kimi credentials
are not forwarded. Crush remains Z.AI-only and rejects Go models before
spawning.

## Subscription and regional readiness

A configured key and a successful catalogue lookup do not prove that a Go
inference is permitted. The workspace must have an active Go subscription,
remaining quota, and any required regional-hosting opt-in. For
`deepseek-v4-flash`, OpenCode may require the China-hosting opt-in in the
workspace Go settings.

Triss does not change account, billing, privacy, or regional settings. If the
provider rejects inference, the coder run returns the original OpenCode error
and leaves local configuration unchanged.

## Troubleshooting

- `OPENCODE_API_KEY is not set`: run `triss coder init --provider opencode-go`
  or store the key with `triss config set OPENCODE_API_KEY`.
- Catalogue returned HTTP 401: verify that the key belongs to the intended
  OpenCode workspace.
- Catalogue returned HTTP 403: verify that the workspace has OpenCode Go
  entitlement and permits access to the Go catalogue.
- Catalogue is empty: treat it as authoritative; check subscription/workspace
  availability rather than pinning a built-in model.
- Catalogue is temporarily unavailable: retry after checking connectivity, or
  rerun the exact direct `triss coder init --provider opencode-go
  --allow-unverified --local|--global` command; the configuration wizard cannot
  opt in on your behalf. Use it only when accepting an unverified built-in
  fallback is intentional.
- `RegionError`: enable the required hosting region in the OpenCode workspace
  only after accepting its data-residency implications, then retry the run.
- Zen/Go main-small mismatch: choose two models with the same prefix even
  though both providers use the same key.

See also [configuration.md](configuration.md),
[glm-clients.md](glm-clients.md), and [opencode-zen.md](opencode-zen.md).

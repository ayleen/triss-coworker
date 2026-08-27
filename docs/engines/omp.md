# Oh My Pi engine (`omp`) — integration guide

Status: supported. `omp` is the fourth `triss coder` engine alongside `opencode`, `opencode2`, and `crush`. The default engine remains `opencode`.

## Installation

OMP runs as a compiled binary. User installations use the official installer:

```bash
curl https://omp.sh/install | sh   # official installer — writes `omp` to PATH
omp --version                          # must print `omp/<semver>`
```

The repository's `omp-contract` CI job intentionally installs the pinned
`@oh-my-pi/pi-coding-agent@18.0.6` npm distribution to provision that compiled
CLI reproducibly. This is a CI-only installation choice: Triss runtime
detection still resolves an executable `omp` binary and never assumes an npm
installation or reads Node package metadata.

Triss never executes the installer. `triss coder init --engine omp` only probes the already-installed binary and prints the hint above when it is missing or incompatible.

- Hard supported floor: `18.0.6` (`omp/18.0.6`, verified 2026-08-26, arm64).
- `TRISS_CODER_OMP_VERSION` may **raise** the minimum (e.g. `18.1.0`) but can never lower it below the floor. A malformed value fails closed (nothing admitted); the display degrades to the floor so install advice stays actionable.
- Admission requires **both** a parsable `omp/<semver>` version **and** a capability probe. Version text alone is insufficient.

Required capabilities (verified against `omp --help` and `omp models --help` at 18.0.6):

- launch: `--mode`, `--model`, `--smol`, `--session-dir`, `--no-session`, `--resume`, `--continue`, `--tools`, `--approval-mode`, `--no-extensions`, `--no-skills`, `--no-title`, `--no-pty`
- models: `--json`, `--no-extensions`

An incompatible binary is rejected before any isolation worktree, credential proxy, or session reservation is created.

## Quickstart

```bash
triss coder init --engine omp --provider opencode-go
triss coder status
triss coder models --engine omp --json
triss coder model set --engine omp --provider opencode-go opencode-go/deepseek-v4-flash --small opencode-go/deepseek-v4-flash --yes
triss coder run --engine omp --model opencode-go/deepseek-v4-flash "Create result.txt containing OMP_OK"
triss coder run --engine omp --session task-a "Remember ALPHA"
triss coder run --engine omp --session task-a "Repeat the remembered value"
triss coder session list --engine omp
triss coder session clean task-a --engine omp
```

One-shot overrides: `triss coder run --engine omp --model <provider>/<id> [--small-model <provider>/<id>]` maps `--small-model` to OMP `--smol`.

## Headless protocol

Managed invocation (Triss builds the argv; callers do not):

```bash
omp -p \
  --mode json \
  --model <omp-selector> \
  [--smol <omp-small-selector>] \
  --session-dir <triss-owned-session-dir> \
  --no-title --no-extensions --no-skills --no-pty \
  --approval-mode write \
  --tools <triss-tool-set> \
  [--no-session | --resume <real-id> | --continue] \
  -- <prompt>
```

The child receives the run-private overlay through `PI_CONFIG_FILES=<triss-owned-overlay>`; OMP run mode ignores `--config`.

- `--mode json` emits newline-delimited JSON events: `session` (version 3), `agent_start`/`turn_start`/`turn_end`/`agent_end`, `message_start`/`message_update`/`message_end`, `tool_execution_start`/`update`/`end`.
- `agent_end.isTerminal === false` is non-terminal; missing `isTerminal` is terminal for older compatible releases.
- `message_end.message` carries `provider`, `model`, `usage` (input/output/cacheRead/cacheWrite/totalTokens/cost), `stopReason`, `errorMessage`, and `content` text blocks.
- Parent Triss owns the public `--timeout` contract (process-group kill); OMP `--max-time` is never used because it can abort a tool and exit 0.

## Provider / model translation

Triss model IDs stay the public API; translation happens only at the adapter boundary:

| Triss prefix | OMP catalogue provider | Actual run selector | Credential |
|---|---|---|---|
| `opencode` | `opencode-zen` | audited: `triss-coder-transient/<model-id>`; unaudited raw: `opencode-zen/<model-id>` | `OPENCODE_API_KEY` |
| `opencode-go` | `opencode-go` | audited: `triss-coder-transient/<model-id>`; unaudited raw: `opencode-go/<model-id>` | `OPENCODE_API_KEY` |
| `zai-coding-plan` | `zhipu-coding-plan` | `triss-coder-transient/<model-id>` | `ZHIPU_API_KEY` |
| `zai` | `zai` | `triss-coder-transient/<model-id>` | bridge `ZHIPU_API_KEY` → `ZAI_API_KEY` |
| `moonshotai` | `moonshot` | `triss-coder-transient/<model-id>` | `MOONSHOT_API_KEY` |
| `moonshotai-cn` | `moonshot` | `triss-coder-transient/<model-id>` | `MOONSHOT_API_KEY` |
| `kimi-for-coding` | `kimi-code` | `triss-coder-transient/<model-id>` | `KIMI_API_KEY` |
| `triss-worker` | none (transient only) | `triss-coder-transient/<model-id>` | `TRISS_WORKER_API_KEY` + worker base URL |

The catalogue provider column describes selector translation for isolated `omp models`; it is not always the run route. Audited routes use transient `models.yml` entries under the run-private agent directory (provider `triss-coder-transient`, env-var indirection, never a secret value). If main and small share a transport, both IDs are registered in that provider; different audited transports use `triss-coder-transient-small` plus a second scoped proxy in protected mode. Unaudited Zen/Go routes are never assigned a guessed protocol: `best_effort_raw` uses OMP's built-in provider selector, while protected mode rejects them before proxy, session reservation, or spawn. Billing preserves the original Triss `billing_model`.

## Credential modes

- Default: `best_effort_raw` — one selected provider credential forwarded into the OMP child; curated bash allowlist; proxy not started.
- `--protect-credentials`: `protected_proxy` — only the short-lived proxy credential forwarded; deny-all bash; unknown transports fail before proxy startup.

No raw upstream key is persisted into OMP YAML, SQLite, JSONL, result artifacts, argv, logs, warnings, or usage records.

## Tool policy

Generated overlay forces at minimum:

```yaml
memory:
  backend: off
async:
  enabled: false
tools:
  approvalMode: write
  approval:
    eval: deny
    task: deny
    hub: deny
    web_search: deny
```

Launch tool set: `read,write,edit,glob,grep,bash,todo` plus `--no-extensions --no-skills --no-pty --no-title`. Bash:

- protected: `*` → `deny`
- best-effort: allowlist (`git status`, `git diff*`, `git log*`, `ls*`, `node --test*`, `npm test*`, `npm run test*`) then `*` → `deny`.

Project `.omp/config.yml` cannot weaken the overlay; higher-precedence overlay + CLI flags win.

## Sessions and filesystem

- Bare runs: `--no-session` (no session files).
- `--session <slug>`: reserve v2 inventory row → existing mapping uses `--resume <real-id>`, new mapping captures first `session.id` and publishes after resumable session established.
- `--continue` → OMP `--continue` inside Triss-owned session directory.
- Session directory: `<project>/.triss/omp/sessions` (original project root, not disposable worktree).
- Run-private agent directory: `<project>/.triss/omp/runs/<run-id>/agent` (0700, 0600 temp files, removed after run). Only `.triss/omp/sessions` persists.
- A worktree limits accidental mutations but is not an OS sandbox — OMP file tools accept absolute paths.

## Capability floor

Verified against `omp/18.0.6` on 2026-08-26:

- `omp --version` prints `omp/18.0.6`
- `omp --help` and `omp models --help` contain the capability strings listed above (see fixtures `test/fixtures/omp-*.ndjson` for event samples)

Deterministic unit tests replay fixtures; no OMP binary or network is required. Live smoke is opt-in and uses an isolated `PI_CODING_AGENT_DIR`.

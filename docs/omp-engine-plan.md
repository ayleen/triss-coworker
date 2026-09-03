# Oh My Pi coder engine integration plan

> **Historical pre-0.42 design record.** Legacy provider names, environment
> variables, model selectors, and commands below are migration history, not
> valid runtime guidance. See [`configuration.md`](configuration.md).

Status: implementation-ready plan  
Target branch: `plan/omp-coder-engine`  
Repository baseline: `b4884e6`  
Verified against: Oh My Pi `18.0.6`, 2026-08-26

## 1. Objective

Add `omp` as a first-class fourth `triss coder` engine, with the same supported lifecycle as the existing OpenCode V1, OpenCode 2, and Crush engines:

- CLI, config wizard, environment selection, status, and MCP discovery;
- engine detection, version policy, installation guidance, and initialization;
- all Triss coder provider routes and one-shot model selection;
- isolated and caller-worktree execution;
- deterministic machine-readable result envelopes;
- timeouts, signals, process-group cleanup, and retained results;
- persistent named sessions, resume/continue, inventory, cleanup, migration, backup, and validation;
- model inspection, persistent model switching, transaction rollback, and usage accounting;
- deny-first tool policy, credential modes, documentation, public website, npm package metadata, fixtures, regression tests, and release gates.

The implementation is a native engine adapter. It must not route through DeepSeek Harness, install an OMP extension, or depend on the user's OMP profile.

## 2. Definition of done

The engine is complete only when all of these work through both CLI and MCP:

```bash
triss coder init --engine omp --provider opencode-go
triss coder status
triss coder models --engine omp --json
triss coder model set --engine omp --provider opencode-go \
  opencode-go/deepseek-v4-flash --small opencode-go/deepseek-v4-flash --yes
triss coder run --engine omp --model opencode-go/deepseek-v4-flash \
  "Create result.txt containing OMP_OK"
triss coder run --engine omp --session task-a "Remember ALPHA"
triss coder run --engine omp --session task-a "Repeat the remembered value"
triss coder session list --engine omp
triss coder session clean task-a --engine omp
triss coder state backup
triss coder state validate <backup>
```

Required outcomes:

1. `engine: "omp"` and the detected OMP version appear in the canonical result envelope.
2. `final_text`, usage, tool activity, warnings, session identity, timeout reason, changed files, and isolation metadata are populated from OMP events rather than inferred from prose.
3. A started, parseable failed run emits an envelope; a missing binary, failed spawn, or wholly unparseable stream throws. This preserves `docs/coder-agent-plan.md`.
4. Named sessions resume across separate Triss isolation worktrees.
5. The child never reads the user's `~/.omp/agent` auth, config, memory, sessions, extensions, or skills.
6. Protected credential mode never forwards the upstream provider credential to OMP.
7. Every engine enum, schema, help string, status projection, backup validator, test matrix, documentation page, website engine list, and npm package manifest recognizes `omp`.
8. Root checks, site checks, npm tarball checks, and the live OMP smoke matrix pass.

## 3. Verified OMP facts

These facts were exercised against the installed compiled arm64 binary `omp/18.0.6`; they are not assumptions.

### 3.1 Headless protocol

The managed invocation is:

```bash
omp -p \
  --mode json \
  --model <omp-selector> \
  [--smol <omp-small-selector>] \
  --session-dir <triss-owned-session-dir> \
  --no-title \
  --no-extensions \
  --no-skills \
  --no-pty \
  --approval-mode write \
  --tools <triss-tool-set> \
  --config <triss-owned-overlay> \
  [--no-session | --resume <real-id> | --continue] \
  -- <prompt>
```

`--cwd` may be used, but the child process `cwd` remains authoritative and matches the existing `spawnEngine` seam.

`--mode json` emits newline-delimited JSON events. Observed event types include:

- `session` with `version: 3`, `id`, timestamp, and cwd;
- `agent_start`, `turn_start`, `turn_end`, and terminal `agent_end`;
- `message_start`, `message_update`, and `message_end`;
- `tool_execution_start`, `tool_execution_update`, and `tool_execution_end`;
- retry/compaction/notice events documented by OMP.

An assistant `message_end` contains:

```json
{
  "provider": "opencode-go",
  "model": "deepseek-v4-flash",
  "usage": {
    "input": 9135,
    "output": 4,
    "cacheRead": 896,
    "cacheWrite": 0,
    "totalTokens": 10035,
    "cost": {
      "input": 0.0020097,
      "output": 0.00000264,
      "cacheRead": 0.000006272,
      "cacheWrite": 0,
      "total": 0.002018612
    }
  },
  "stopReason": "stop",
  "errorMessage": null,
  "content": [{ "type": "text", "text": "EVENT_OK" }]
}
```

`agent_end.isTerminal === false` is non-terminal. Missing `isTerminal` is terminal for older compatible releases.

### 3.2 Behavior already proven

- Text run returned `READY` in 5.91 seconds.
- Coding run called the write tool, created exactly `result.txt` with `OMP_OK\n`, and returned `DONE` in 7.92 seconds.
- A persisted session resumed by ID and recalled its prior value.
- The same session resumed from a different cwd and returned the remembered value, proving compatibility with disposable Triss worktrees.
- `SIGTERM` exited OMP with status 143 and left no `sleep 120` descendant.
- OMP's own `--max-time` aborted a running bash command but may exit 0. Triss therefore must own the public timeout contract.
- A `bash.patterns` final deny rule blocked `touch`; an explicit `pwd` allow rule executed in headless `write` mode.
- `PI_CODING_AGENT_DIR` plus a Triss config overlay isolated configuration and authentication. A raw `OPENCODE_API_KEY` from Triss was sufficient; no user OMP auth store was required.
- `memory.backend: off` prevented OMP memory integration inside the isolated profile.

### 3.3 Installation and compatibility

- Binary name: `omp`.
- Version output: `omp/<semver>`.
- Official installation path documented by OMP: `curl https://omp.sh/install | sh`.
- OMP is available as a compiled binary; Triss must not assume an npm global package.
- The initial hard floor is `18.0.6`, raised but never lowered by `TRISS_CODER_OMP_VERSION`.
- Version admission also requires a capability probe. Version text alone is insufficient.

Required capabilities:

- launch help contains `--mode`, `--model`, `--smol`, `--session-dir`, `--no-session`, `--resume`, `--continue`, `--config`, `--tools`, `--approval-mode`, `--no-extensions`, `--no-skills`, `--no-title`, and `--no-pty`;
- models help contains `--json` and `--no-extensions`;
- a local no-provider probe can parse one `session` frame in JSON mode without loading user state. If a network-free session-frame probe is not possible on a future release, help capability checks remain the admission gate and live init reports the provider smoke separately.

Unsupported development, prerelease, or malformed version channels fail closed unless explicitly added to the parser and tested.

## 4. Public contract decisions

### 4.1 Engine identity

- Canonical ID: `omp`.
- Default engine remains `opencode`; this feature is additive.
- `TRISS_CODER_ENGINE=omp` is supported.
- CLI/MCP engine order becomes `opencode, opencode2, crush, omp`.
- No alias such as `pi`; one stable ID avoids migration baggage.

### 4.2 Isolation

OMP defaults to `--isolate`, like Crush. `--no-isolate` remains an explicit opt-out. `--allow-best-effort-caller-worktree` retains its existing downgrade semantics.

A worktree limits accidental repository mutations but is not an OS sandbox. OMP file tools accept absolute paths. Documentation and website copy must not claim host-filesystem confinement.

### 4.3 Agent and restriction flags

- OMP uses its own primary coding prompt. A bare run does not synthesize an OpenCode `coder` agent.
- `--agent` is rejected for `omp` with an engine-specific error because OMP has no equivalent launch flag. It is never silently ignored.
- `--restrict` and `--no-restrict` remain Crush-only and are rejected for OMP.
- OMP receives a mandatory Triss-owned policy overlay; callers cannot replace it through current `triss coder run` options.

### 4.4 Credential mode

OMP follows the OpenCode public mode contract:

- default: `best_effort_raw`;
- `--protect-credentials`: `protected_proxy`.

Best-effort raw mode forwards one selected provider credential into the OMP child. Its curated bash allowlist can execute repository code, so this mode explicitly accepts credential exposure, matching the existing OpenCode warning model.

Protected mode forwards only the short-lived Triss proxy credential and applies deny-all bash. It still permits read/write/edit/grep/glob/todo work but advertises test execution as unavailable. Unknown or unaudited provider transports fail before proxy startup.

No raw upstream key may be persisted into OMP YAML, SQLite, session JSONL, result artifacts, command arguments, logs, warnings, or usage records.

### 4.5 Provider/model support

Keep Triss model IDs and provider aliases as the public API. Translate only at the adapter boundary.

| Triss selector prefix | OMP catalogue provider | Actual run selector | Credential/environment handling |
| --- | --- | --- | --- |
| `opencode` | `opencode-zen` | audited: `triss-coder-transient/<model-id>`; unaudited raw: `opencode-zen/<model-id>` | `OPENCODE_API_KEY` |
| `opencode-go` | `opencode-go` | audited: `triss-coder-transient/<model-id>`; unaudited raw: `opencode-go/<model-id>` | `OPENCODE_API_KEY` |
| `zai-coding-plan` | `zhipu-coding-plan` | `triss-coder-transient/<model-id>` | `ZHIPU_API_KEY` |
| `zai` | `zai` | `triss-coder-transient/<model-id>` | bridge `ZHIPU_API_KEY` to OMP's `ZAI_API_KEY` |
| `moonshotai` | `moonshot` | `triss-coder-transient/<model-id>` | `MOONSHOT_API_KEY` |
| `moonshotai-cn` | `moonshot` | `triss-coder-transient/<model-id>` | `MOONSHOT_API_KEY` |
| `kimi-for-coding` | `kimi-code` | `triss-coder-transient/<model-id>` | `KIMI_API_KEY` |
| `triss-worker` | none (transient only) | `triss-coder-transient/<model-id>` | `TRISS_WORKER_API_KEY` and worker base URL |

The catalogue provider is used only to project isolated `omp models` output back to public Triss selectors. Audited runs generate OMP `models.yml` entries under a run-private agent directory using provider ID `triss-coder-transient`; a different small-model transport uses `triss-coder-transient-small`. Unaudited Zen/Go in `best_effort_raw` use OMP's built-in selectors instead, and protected mode fails before proxy startup. Missing protocol metadata is never guessed. Map audited Triss protocols exactly:

- `openai_chat` -> `openai-completions`;
- `openai_responses` -> `openai-responses`;
- `anthropic_messages` -> `anthropic-messages`.

The file contains an environment variable name, never a secret value. Protected mode points the transient provider at the Triss credential proxy. Raw mode uses the same transient provider so the audited endpoint and protocol cannot drift to a user-configured OMP route.

Preserve the original Triss model as `billing_model` and result metadata. The rewritten OMP selector is execution metadata only and must not corrupt cost/provider classification.

The run option `triss coder run --small-model` maps to OMP `--smol`. The persistent option remains `triss coder model set --small`; it writes `TRISS_CODER_SMALL_MODEL`, which a later OMP run resolves and passes through the same `--smol` path. The projection registers both IDs in one transient provider when they share a transport and creates a second provider (plus a second scoped proxy in protected mode) when they do not. Existing same-provider/same-credential validation remains authoritative. The small-model path never sends a second raw credential into the child.

### 4.6 Model configuration backend

Add a model backend named `triss-env` for OMP:

- persistent main: `TRISS_CODER_MODEL`;
- persistent small: `TRISS_CODER_SMALL_MODEL`;
- local scope: `<project>/.triss.env`;
- global scope: `~/.config/triss/.env`;
- no persistent mutation of user or project OMP config;
- transaction records snapshot only those two env pins;
- rollback restores only those pins.

`triss coder models --engine omp` combines the effective Triss env pins with a read-only, isolated `omp models --json --no-extensions` catalog projection. The command must distinguish unavailable, unauthenticated, transient catalog failure, and unsupported selector translation.

### 4.7 Sessions

- Bare runs use `--no-session` and do not accumulate OMP session files.
- `--session <slug>` reserves the canonical v2 inventory row, then:
  - existing mapping -> `--resume <real-id>`;
  - new mapping -> omit `--resume`, capture the first `session.id`, and publish it only after the run establishes a resumable session.
- `--continue` maps to OMP `--continue` inside the Triss-owned session directory.
- `--session` and `--continue` are mutually exclusive before reservation or spawn.
- Add `omp` to the versioned `sessions.json` namespace because its caller slug differs from the generated OMP ID.
- Session directory: `<project>/.triss/omp/sessions` under the original project root, not a disposable worktree.
- Runtime agent directory: `<project>/.triss/omp/runs/<run-id>/agent`; remove it after each run.
- Existing inventory ordering remains: reserve -> revalidate owner -> spawn -> publish native ID -> complete/idle; rollback unpublished rows on every failure edge.

`coder session clean` removes the Triss mapping and inventory row. Native OMP JSONL deletion is not added in the first implementation because the current cross-engine command does not delete native OpenCode/Crush session artifacts. Document this exact parity rather than implying transcript erasure.

## 5. Architecture

### 5.1 Small engine registry, not a plugin system

Create `src/coder-engine-registry.js` with frozen metadata for the four built-in engines:

- ID and display name;
- configuration backend;
- session-store namespace ownership;
- default isolation;
- default credential mode;
- `supportsAgent`, `supportsSmallModel`, and `supportsRestrict`;
- supported provider kinds.

Derive canonical engine arrays and validation messages from this registry. Keep actual run branches explicit in `src/commands/coder.js`; do not introduce dynamic loading or lifecycle hooks.

This removes the current duplicated three-engine lists without turning four known adapters into a framework.

### 5.2 Pure OMP adapter

Create `src/coder-engines/omp.js`. Match the established pure-adapter boundary in `crush.js` and `opencode2.js`:

- `ompVersionMinimum()`;
- `buildOmpProbeEnv()`;
- `resolveOmpVersionPolicy()` and `assertOmpVersionPolicy()`;
- `detectOmp()` with absolute-path pinning, realpath, executable regular-file checks, version parsing, and capability probe;
- `installHintOmp()`;
- `buildOmpRunArgv()`;
- `buildOmpSpawnEnv()`;
- `ensureOmpRuntimeDirs()`;
- `buildOmpPolicyOverlay()`;
- `buildOmpModelsConfig()`;
- `createOmpEventFolder()`;
- `foldOmpEventLine()`;
- `finalizeOmpEnvelopeState()`;
- adapter capability metadata.

No process spawning, worktree lifecycle, session reservation, usage logging, or stdout writes belong in this module.

### 5.3 Run-private filesystem

Before credentials or proxy tokens exist:

1. resolve the original project root;
2. create `.triss/omp`, `sessions`, and the run-specific agent directory with mode `0700`;
3. reject symlinks/non-directories at every managed path component below the project root, following the hardened OpenCode 2 runtime-dir implementation;
4. write `config.yml` and `models.yml` via sibling temporary files, mode `0600`, fsync/rename/directory-fsync using existing durable-write primitives;
5. set `PI_CODING_AGENT_DIR` to the run-private agent directory;
6. spawn the already-detected absolute OMP path;
7. recursively remove the run-private directory after child and credential proxy settlement.

Only `.triss/omp/sessions` persists.

### 5.4 Mandatory OMP policy

The generated overlay must force, at minimum:

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

Launch with a curated tool list rather than OMP's default all-tools set:

```text
read,write,edit,glob,grep,bash,todo
```

Use `--no-extensions`, `--no-skills`, `--no-pty`, and `--no-title`. Keep repository context rules enabled; the isolated agent directory removes user-global rules, while project rules are part of the coding contract. Critical tool policy comes from the higher-precedence Triss overlay plus the adapter-owned `--tools` and `--approval-mode` launch flags; the rejected user-facing `--restrict` flags are not part of OMP policy resolution.

Bash policy:

- protected mode: `* -> deny`;
- best-effort raw mode: port the existing OpenCode allowlist (`git status`, `git diff*`, `git log*`, `ls*`, `node --test*`, `npm test*`, `npm run test*`) followed by `* -> deny` in OMP's first-match order.

Add adversarial tests for command substitution, compound commands, environment expansion, absolute writes, `xd://` dispatch, MCP/custom tools, background jobs, and project settings attempting to weaken the overlay. Expected behavior must be recorded; do not overstate confinement where OMP does not provide it.

### 5.5 Process lifecycle

Reuse `spawnEngine`, `killProcessGroup`, signal forwarding, output caps, isolation cleanup, and retained-result logic.

Do not pass OMP `--max-time` for the public `--timeout` path. The observed OMP deadline can abort a tool and exit 0, which conflicts with Triss's canonical `exit_reason`. The parent Triss timer remains authoritative:

1. deadline -> signal OMP process group;
2. grace period -> SIGKILL process group;
3. verify the group no longer exists;
4. emit `timeout` only when the parent deadline fired;
5. external SIGINT/SIGTERM -> `killed`;
6. residual live group -> typed failure/warning according to the existing lifecycle contract.

### 5.6 NDJSON fold and result mapping

The fold is order-independent and tolerant of unknown additive events.

State fields:

- `sawParseableEvent`, `sessionId`, `terminalAgentEnd`;
- current/final assistant text;
- assistant messages already counted for usage;
- normalized tool activity keyed by `toolCallId`;
- provider/model and raw stop reason;
- terminal error and bounded warnings;
- retry, compaction, and notice diagnostics.

Rules:

1. `session`: capture the first stable ID; conflicting IDs are a terminal adapter error.
2. `message_update`: optional progress only; do not make deltas authoritative final text.
3. assistant `message_end`: concatenate text blocks for the current final answer, aggregate its usage once, record provider/model/stop reason/error.
4. `tool_execution_start/update/end`: normalize tool name, projected arguments, status, result/error, and timestamps without retaining unbounded output or secrets.
5. `agent_end`: terminal only when `isTerminal !== false`; prefer its last assistant message if it is more complete than prior events.
6. unknown valid JSON event: warning, not failure.
7. invalid line: bounded warning; a wholly invalid stream triggers the established thrown-error branch.
8. OMP terminal error beats process exit 0.

Exit-reason precedence:

1. parent timeout -> `timeout`;
2. forwarded external signal -> `killed`;
3. terminal `errorMessage`, error stop reason, or nonzero exit -> `error`;
4. terminal `agent_end` plus normal assistant stop -> `end_turn`;
5. parseable but incomplete stream -> `error` with a protocol warning.

Usage mapping:

- `input` -> prompt tokens;
- `output` -> completion tokens;
- `cacheRead` and `cacheWrite` -> canonical cache token fields;
- `cost.total` -> reported cost when finite and nonnegative;
- keep request-level aggregation deterministic across retries;
- use original Triss `billing_model` and existing `resolveBillingMode`/free-model logic;
- source/engine is `omp`, provider is the original Triss provider kind.

## 6. Implementation phases

### Phase 0 — lock fixtures and compatibility floor

Files:

- `test/fixtures/omp-run-no-tool.ndjson`
- `test/fixtures/omp-run-tool.ndjson`
- `test/fixtures/omp-run-error.ndjson`
- `test/fixtures/omp-run-retry.ndjson`
- `test/fixtures/omp-run-nonterminal-agent-end.ndjson`
- initial `docs/engines/omp.md` compatibility record

Work:

1. Capture sanitized event streams from OMP `18.0.6` for text, tool, provider error, retry, and non-terminal lifecycle cases.
2. Verify no credential, home path, or unrelated repository content remains.
3. Record exact `omp --version`, launch help, and models help outputs used by capability tests.
4. Add one live opt-in smoke script or documented command; deterministic unit tests consume fixtures and never require OMP/network.

Acceptance:

- every event field consumed by the adapter exists in a fixture;
- fixture replay produces stable final text, usage, activity, session ID, and error classification;
- capability floor is documented in `docs/engines/omp.md`.

### Phase 1 — canonical engine registry

Files:

- new `src/coder-engine-registry.js`;
- `src/commands/coder.js`;
- `src/coder-session-engines.js`;
- `src/coder-sandbox.js`;
- `src/coder-result.js`;
- `src/coder-run-state.js`;
- `src/coder-models.js`;
- `src/mcp/tools.js`.

Work:

1. Add registry metadata for all four engines without changing existing defaults.
2. Derive engine validation lists, session engine lists, session-store namespaces, sandbox validation, and MCP enum from the registry.
3. Extend activity normalization for `omp`.
4. Replace user-visible three-engine errors with registry-derived values.
5. Keep configuration-backend selection explicit and fail closed on unknown backends.

Acceptance:

- old three-engine tests remain byte-for-byte compatible except intentional help/enum additions;
- unknown engines still fail before side effects;
- `omp` reaches validation surfaces but cannot spawn until later phases.

### Phase 2 — OMP adapter and version gate

Files:

- new `src/coder-engines/omp.js`;
- `src/commands/coder.js`;
- new `test/coder-omp-version.test.js`;
- new `test/coder-omp-adapter.test.js`.

Work:

1. Implement strict `omp/<semver>` parsing and raise-only minimum policy.
2. Add `TRISS_CODER_OMP_VERSION` to non-secret configuration keys.
3. Resolve an absolute executable once and spawn that exact path.
4. Probe with a sanitized environment containing only path/home/temp/locale fields and an isolated temporary `PI_CODING_AGENT_DIR`.
5. Implement argv/env/config/models builders and runtime-dir validation.
6. Add typed malformed-minimum and unsupported-capability errors.

Acceptance:

- missing, malformed, below-floor, raised-minimum, unsupported-capability, symlink-swap, non-executable, and compatible cases are tested;
- no provider credential reaches version/help probes;
- run is impossible unless the single resolved policy is compatible.

### Phase 3 — init, wizard, status, and model catalogue

Files:

- `src/commands/coder.js` (`runCoderInit`, wizard setup, `describeCoderStatus`);
- `src/commands/coder-models.js`;
- `src/coder-models.js`;
- `src/commands/status.js`;
- `src/mcp/handlers.js`;
- `bin/triss.js`;
- focused OMP init/status/models tests.

Work:

1. Add `--engine omp` to init and wizard provider selection.
2. Reuse existing provider credential setup and model picking.
3. Never modify persistent OMP config/auth state.
4. Run catalogue inspection inside an isolated agent directory.
5. Report installed path/version/minimum/capabilities, default isolation, credential mode, session path, and model backend.
6. Make all human and JSON status projections say which model IDs are translated for OMP.

Acceptance:

- init is idempotent at local/global scope;
- init with missing OMP prints the official install hint without executing it;
- status contains no secrets and remains total when OMP is absent/broken;
- models output has stable JSON fields and deterministic diagnostics.

### Phase 4 — model mutation backend and rollback

Files:

- `src/coder-models.js`;
- `src/commands/coder-models.js`;
- model state/rollback tests.

Work:

1. Add `triss-env` backend planning, lock key, apply, manifest, validate, and rollback paths.
2. Reuse durable env-file transaction primitives; do not duplicate atomic-write code.
3. Extend `renderEngineRequired`, engine-specific model labels, plan rendering, and recovery commands.
4. Preserve cross-scope and shell-export shadow detection.
5. Update rollback validation to recognize OMP while refusing mismatched backends.

Acceptance:

- dry plan writes nothing;
- `--yes` atomically changes only the two model pins;
- injected failures restore the original env file;
- rollback is idempotent, lock-safe, and rejects cross-engine records.

### Phase 5 — run flow and credentials

Files:

- `src/commands/coder.js`;
- `src/coder-providers.js` only where selector translation/proxy metadata belongs;
- `src/coder-credential-proxy.js` only if an existing audited protocol is not already accepted;
- OMP routing/security tests.

Work:

1. Add OMP option validation and default isolation.
2. Resolve original and OMP model selectors without changing public IDs.
3. Create run-private config/models files before proxy/key forwarding.
4. Implement best-effort raw and protected-proxy spawn environments using strict env allowlists.
5. Invoke shared `spawnEngine` with OMP fold callbacks.
6. Always dispose proxy, process group, and run-private directory in reverse ownership order.
7. Emit capability warnings when protected mode denies test execution.

Acceptance:

- all six Triss provider kinds have positive route tests;
- wrong/missing credential, unqualified model, unknown transport, mixed small-provider, and unsafe project override fail before spawn;
- child env snapshots contain only expected variables;
- secrets never appear in argv, generated YAML, stdout, stderr, results, or usage logs.

### Phase 6 — event fold, usage, and result envelope

Files:

- `src/coder-engines/omp.js`;
- `src/usage-schema.js`;
- `src/usage.js`;
- `src/coder-result.js`;
- fixture replay and malformed-stream tests.

Work:

1. Fold OMP events into canonical final text, activity, usage, warnings, and raw diagnostics.
2. Handle multiple assistant messages, retry usage, terminal/non-terminal `agent_end`, tool errors, unknown events, invalid lines, and output caps.
3. Map reported cost and cache tokens without recomputing when OMP supplies authoritative finite values.
4. Preserve the original Triss provider/model for billing.
5. Apply the envelope-vs-throw split exactly.

Acceptance:

- fixtures prove normal, tool, retry, provider error, incomplete, malformed, and nonzero-exit paths;
- no double-counting across message and `agent_end` copies;
- activity output is bounded and secret-redacted;
- MCP and CLI receive identical canonical objects.

### Phase 7 — sessions and process lifecycle

Files:

- `src/coder-session-engines.js`;
- `src/coder-session-store.js`;
- `src/coder-session-inventory-codec.js`;
- `src/coder-session-transitions.js`;
- `src/coder-session-owner-adapter.js`;
- `src/coder-state-backup.js`;
- `src/commands/coder-state-backup.js`;
- `src/commands/coder.js`;
- session inventory/CLI/state-backup tests;
- new OMP lifecycle tests.

Work:

1. Add the OMP store namespace and backward-compatible default normalization for old `sessions.json` files.
2. Wire new/resume/continue argv semantics.
3. Publish the captured native ID using the full owner tuple and existing transition ordering.
4. Roll back reservation/mapping on every pre-spawn, spawn, parse, and completion failure edge.
5. Exercise parent timeout, SIGINT/SIGTERM, SIGKILL escalation, residual process groups, and delayed close.
6. Include OMP inventory in session list/clean/migrate, backup, and validation.

Acceptance:

- named session remembers state across separate isolation worktrees;
- concurrent claims, stale owners, deleting recovery, missing mapping, missing native ID, and crash windows fail closed;
- parent timeout emits `timeout` even if OMP would have exited 0 under its own deadline;
- no child/grandchild remains after success, error, timeout, or external cancellation.

### Phase 8 — CLI, MCP, and repository documentation

Files:

- `bin/triss.js`;
- `src/mcp/tools.js`;
- `src/mcp/handlers.js`;
- new `docs/engines/omp.md`;
- `docs/engines/index.md`;
- `docs/cli-reference.md`;
- `docs/getting-started.md`;
- `docs/configuration.md`;
- `docs/mcp.md`;
- `docs/security-model.md`;
- `docs/compatibility.md`;
- `docs/troubleshooting.md`;
- `docs/usage-accounting.md`;
- `docs/reliable-delegation-contract.md`;
- `docs/data-flows.md` where the engine flow is enumerated;
- `README.md` engine summaries/examples;
- `CHANGELOG.md`.

Work:

1. Update every engine help string, description, example, and enum.
2. Document installation, minimum version, model translation, raw/protected modes, mandatory policy, session storage, cleanup semantics, and lack of OS-level filesystem confinement.
3. Update MCP tool descriptions and status output.
4. Add an end-to-end OMP quickstart and troubleshooting commands that do not read the user's OMP profile.
5. Ensure repository docs distinguish `omp` from the DSH provider bundle; OMP is a real `--engine`, Harness remains a separate plugin integration.

Acceptance:

- `npm run check:docs` passes;
- no help/documentation text still claims only three engines or describes flags as OpenCode-only when OMP supports them;
- security claims match exercised behavior.

### Phase 9 — public website update

Files to audit and update:

- `site/src/pages/coder.astro`;
- `site/src/data/commands.js`;
- `site/src/pages/commands.astro`;
- `site/src/pages/docs/getting-started.astro`;
- `site/src/pages/security.astro`;
- `site/src/pages/index.astro` if the engine count or coder summary appears there;
- `site/test/consistency.test.js`;
- `site/test/quality.test.js`;
- `site/test/browser/site.spec.js`;
- `docs/website/product-requirements.md` and `docs/website/implementation-plan.md` only where their content-sync lists or acceptance matrix must change.

Work:

1. Add an `omp` engine control to the coder page beside `opencode`, `opencode2`, and `crush`; update both the rendered button row and the inline `ENGINES`/`renderEngine` script so body, flag, isolation label, keyboard state, and selected content stay synchronized.
2. Explain that OMP is a first-class `--engine omp`, defaults to worktree isolation, supports structured events/sessions, and has raw/protected credential modes.
3. Keep the existing Harness bundle control explicitly labeled as a DSH plugin, not an engine.
4. Update command-search data from `opencode/opencode2/crush` to `opencode/opencode2/crush/omp` and add a copyable OMP example.
5. Update the getting-started and security pages with the same installation, isolation, and credential boundaries as repository docs.
6. Add consistency assertions tying website engine names, npm package name, Node minimum, install command, and canonical CLI examples to repository sources.
7. Extend browser tests for the new engine tab/button, keyboard selection, narrow/mobile wrapping, copy behavior, and no horizontal overflow.
8. Review SEO title/description only if engine support is mentioned; do not add unsupported marketing claims.

Website verification:

```bash
npm --prefix site run lint
npm --prefix site run check
npm --prefix site test
npm --prefix site run build
npm --prefix site run test:browser
npm --prefix site run test:lighthouse
npm --prefix site run cloudflare:check
```

Then browser-drive the built site at 320, 375, 768, 900, and 1440 px. Verify the OMP control, keyboard focus, screen-reader state, copyable command, reduced motion, console errors, failed resources, and responsive layout. Inspect the Cloudflare branch preview before merge; after merge, verify `https://triss.work/coder` and the changed documentation/security pages on production.

Acceptance:

- the public site names four actual coder engines and separately describes the Harness plugin;
- website copy matches CLI defaults and security limitations exactly;
- site tests/build and preview browser acceptance pass;
- no generated `site/dist` output is committed.

### Phase 10 — npm package information and publish contract

Files and published surfaces:

- root `package.json`;
- `scripts/package-contents-manifest.json`;
- `scripts/check-package-contents.js` if validation rules need extension;
- `README.md` and `CHANGELOG.md` as rendered on npm;
- npm release notes/dist-tag metadata in the existing release workflow.

Work:

1. Add `oh-my-pi` and `omp` to `package.json#keywords`; update the description only if it can remain accurate for every Triss feature, not merely this engine.
2. Do not change the package name, bin name, repository, homepage, license, Node minimum, or default engine.
3. Add `src/coder-engine-registry.js`, `src/coder-engines/omp.js`, and `docs/engines/omp.md` to `scripts/package-contents-manifest.json`.
4. Keep the existing root `package.json#files` broad entries (`src/` and `docs/engines/`) unchanged after verifying they include the new files and still exclude internal plans and `site/`; `scripts/package-contents-manifest.json` remains the exact authoritative tarball allowlist and must carry the explicit additions from item 3.
5. Add an npm-facing README example for `triss coder run --engine omp`; keep installation centered on `npm install -g triss-coworker`.
6. Add the feature and minimum OMP version to `CHANGELOG.md` under the release selected by the maintainer. Do not pre-bump version merely to land code.
7. Before publish, inspect `npm pack --dry-run --json`; reject missing adapter/docs, unexpected site/build files, secrets, absolute paths, oversized output, or untracked generated files.
8. After the release workflow publishes, verify registry information rather than assuming CI success:
   - expected version and dist-tag;
   - description and keywords include current metadata;
   - repository/homepage/bin/engines remain correct;
   - tarball contains the OMP adapter, registry, and engine documentation;
   - a clean temporary global install can run `triss coder status` and recognize `--engine omp`.

Npm verification:

```bash
npm run check:package
npm pack --dry-run --json
npm view triss-coworker version dist-tags description keywords repository homepage bin engines --json
```

Acceptance:

- package manifest and actual tarball agree;
- npm package page exposes accurate OMP discoverability without changing default behavior;
- clean install finds the `triss` bin and OMP engine enum;
- website and npm README examples use the same command and minimum OMP version.

## 7. Required test matrix

### Adapter/unit

- version parse, configured minimum, capability probe, absolute-path pinning;
- argv ordering and `--` prompt boundary;
- env allowlist and credential bridge;
- policy YAML and models YAML generation;
- selector translation for every provider prefix;
- NDJSON event folding and exit-reason precedence;
- usage/cost/cache normalization;
- runtime directory permissions, symlinks, cleanup.

### Run behavior

For both `best_effort_raw` and `protected_proxy` where applicable:

- no-tool success;
- file edit success;
- tool failure followed by recovery;
- provider auth error;
- OMP exit 0 with terminal error event;
- nonzero exit after partial text;
- empty/unparseable output;
- timeout while a child command runs;
- external signal while a child command runs;
- output truncation and retained artifacts;
- isolated clean diff, isolated changed diff, no-isolate, and explicit downgrade.

### Sessions/state

- new slug -> generated ID publication;
- resume existing slug;
- continue most recent Triss-owned OMP session;
- cross-worktree resume;
- concurrent reservation rejection;
- rollback before/after ID publication;
- session clean/migrate/list;
- old `sessions.json` without `omp` namespace upgrades in memory and writes the new namespace only during an actual mutation;
- backup/validate round-trip and unknown-engine fail-closed behavior.

### Security

- probe environment excludes all credential variables;
- raw child gets exactly one upstream credential;
- protected child gets no upstream credential;
- config/model files never contain credential values;
- project `.omp/config.yml` cannot override approval mode, memory-off, async-off, or explicit tool list;
- extensions, skills, eval, task, hub, web search, and unknown custom/MCP tools are unavailable or denied;
- protected bash always denied;
- raw bash deny catches compound commands and command substitution attempts not covered by exact allow rules;
- generated run/session paths reject symlinks and unsafe permissions;
- warning/error/activity redaction covers API keys and proxy tokens.

### Compatibility/regression

- default engine remains OpenCode V1;
- all existing OpenCode V1, OpenCode 2, and Crush fixtures/envelopes remain unchanged;
- engine lists and user-facing messages add OMP without reordering existing values;
- MCP input schemas and handler tristates preserve undefined option semantics;
- model rollback records from old versions remain readable;
- coder-state backups without OMP remain valid;
- website and npm metadata checks fail when their engine lists drift from the CLI.

## 8. Verification sequence

Run focused checks as each phase lands; run project-wide and publication gates once after integration:

```bash
node --test test/coder-omp-*.test.js
node --test test/*session*.test.js test/*state-backup*.test.js
node --test test/mcp-coder.test.js test/protect-credentials-entrypoints.test.js
npm run lint
npm run typecheck
npm test
npm run check:docs
npm run check:package
npm run check
npm --prefix site run lint
npm --prefix site run check
npm --prefix site test
npm --prefix site run build
npm --prefix site run test:browser
npm --prefix site run test:lighthouse
npm --prefix site run cloudflare:check
npm pack --dry-run --json
```

Then run live acceptance against the admitted OMP binary and one cheap model:

1. isolated text response;
2. isolated file edit and diff envelope;
3. named session creation and cross-worktree resume;
4. protected-mode run proving the upstream key is absent;
5. timeout during `sleep 120`, followed by process-tree inspection;
6. external SIGTERM during `sleep 120`, followed by process-tree inspection;
7. model list and one-run override;
8. local model set, rollback, and unchanged global scope;
9. browser verification of the website branch preview;
10. clean install from the packed tarball and `--engine omp` status/run smoke.

Live tests must use temporary projects and isolated `PI_CODING_AGENT_DIR`; they must not touch the operator's OMP profile or memory.

## 9. Risks and controls

| Risk | Control |
| --- | --- |
| OMP JSON schema changes | minimum version plus capability probe; tolerate additive events; fixtures pin consumed fields |
| OMP exits 0 after its own deadline | Triss owns timeout and process-group termination; do not use OMP `--max-time` for the public contract |
| User OMP state changes behavior | run-private `PI_CODING_AGENT_DIR`, mandatory overlay, explicit tool list, extensions/skills disabled |
| Project config weakens safety | higher-precedence overlay/CLI flags plus adversarial tests |
| Raw credential exposed to repository commands | explicit best-effort warning; protected mode available; deny-first raw bash allowlist |
| Protected mode cannot run tests safely | deny bash, advertise capability warning, never silently claim verification |
| Provider IDs differ between Triss and OMP | one adapter translation table; original model retained for billing/results |
| Concurrent runs race on OMP config | one run-private agent directory; persistent sessions stored separately |
| Session resumes from deleted worktree | fixed project session directory plus explicit child cwd; cross-cwd live test already passed |
| Scattered engine lists drift | central frozen registry for identity/capabilities; explicit adapter branches remain reviewable |
| Native OMP transcript survives `session clean` | document current cross-engine parity; do not claim secure transcript deletion |
| Website becomes stale | same-PR website update plus source-consistency and browser tests |
| npm tarball omits new files | explicit package manifest entries, package-content gate, dry-run tarball inspection, clean-install smoke |

## 10. Explicit non-goals

- Making OMP the default engine.
- Exposing OMP TUI, RPC, ACP, browser relay, collaboration, memory, extensions, skills, subagents, async jobs, or provider login flows through Triss.
- Importing arbitrary user OMP auth/config into managed runs.
- Treating worktree isolation as an OS sandbox.
- Automatically executing the remote OMP install script.
- Deleting native OMP transcript JSONL during generic session cleanup before the cross-engine cleanup contract is redesigned.
- Building a generic third-party engine plugin API.
- Publishing `docs/omp-engine-plan.md` or website source inside the npm package.
- Changing npm dist-tags or deploying the production website before the implementation PR passes review and preview verification.

## 11. Final implementation review checklist

Before merge, reviewer must confirm:

- every new engine branch is reached through registry validation;
- OMP adapter remains pure;
- no secret crosses probe/config/result/log boundaries;
- protected mode cannot execute repository commands;
- raw mode warnings state the real exposure boundary;
- parser completion waits for terminal `agent_end`;
- usage is not double-counted;
- parent timeout always wins exit classification;
- session publication and rollback use the full owner tuple;
- old stores/backups/configs remain readable;
- repository docs, website copy, and npm README match the exact shipped flags and tested OMP minimum;
- npm package contains the adapter, registry, and `docs/engines/omp.md`, but excludes the internal plan and `site/`;
- the website preview passes responsive/accessibility/browser checks and still distinguishes OMP engine support from the DSH plugin;
- live smoke leaves no child processes or operator-profile state;
- post-publish npm metadata and post-merge production website are verified, not inferred from CI status.

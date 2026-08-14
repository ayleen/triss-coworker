# OpenCode 2 coder engine plan

Implementation contract for adding OpenCode 2 as a third `triss coder` engine
without replacing or changing the existing OpenCode 1 engine.

## Status

Plan only. Phase 0 live recon was completed on 2026-08-14 against
`@opencode-ai/cli@next` version `0.0.0-next-17430`. No production code has been
implemented yet.

OpenCode 2 is still a beta. Its package, CLI, server, configuration, plugin,
and event contracts can change before a stable 2.0 release. Triss therefore
pins one exact verified build and treats every pin update as a compatibility
change that must repeat the Phase 0 contract smoke.

## Product decision

Add `opencode2` as an additive engine identity:

```text
triss coder run --engine opencode2 ...
TRISS_CODER_ENGINE=opencode2
```

The existing engine remains unchanged:

```text
engine identity:       opencode
binary:                opencode
npm package:           opencode-ai
default pin:           1.18.7
pin override:          TRISS_CODER_OPENCODE_VERSION
default engine:        yes
```

The new engine is separate:

```text
engine identity:       opencode2
binary:                opencode2
npm package:           @opencode-ai/cli
initial exact pin:     0.0.0-next-17430
pin override:          TRISS_CODER_OPENCODE2_VERSION
default engine:        no
```

`opencode` must not become an alias for whichever OpenCode major version is
installed. No version detection branch may silently redirect an existing
`--engine opencode` invocation to `opencode2`.

## Goals

- Install, detect, initialize, run, resume, inspect, and report OpenCode 2 as a
  first-class coder engine.
- Preserve `opencode` as the default engine with its current binary, pin,
  configuration, argv, event parser, safety checks, model-management behavior,
  status output, and envelope identity.
- Reuse the existing provider catalogue and credential routing for Z.AI, the
  Triss OpenAI-compatible worker, OpenCode Zen, OpenCode Go, Moonshot, and Kimi
  for Coding.
- Preserve provider-key isolation: an engine process receives only the one key
  required by the selected model.
- Preserve the enforced deny-first command policy.
- Keep the stable `triss coder` JSON envelope while reporting
  `engine: "opencode2"` and honest usage completeness.
- Keep OpenCode 2 runtime state and logs separate from OpenCode 1.
- Preserve current session-slug and worktree-isolation behavior.
- Expose the engine consistently through CLI, MCP, status, help, configuration,
  docs, and generated agent templates.

## Non-goals

- Replacing OpenCode 1 or changing the default coder engine.
- Migrating the user's V1 `opencode.json` to native V2 configuration.
- Creating or editing V2 `cli.json`.
- Porting arbitrary third-party V1 plugins to the V2 plugin API.
- Using the V2 background service, server API, client SDK, or `export` command
  in the initial implementation.
- Sharing Triss-created OpenCode 2 sessions with direct user-run `opencode2`
  sessions.
- Inventing an OpenCode 2 small-model role. The V2 beta has no effective
  top-level `small_model` equivalent.
- Changing provider catalogue endpoints, credentials, model prefixes, or
  provider inference rules.
- Adding Windows support. The existing POSIX process-group contract remains.
- Adding dependencies.

## Fixed Phase 0 findings

These facts were verified locally on 2026-08-14 against
`0.0.0-next-17430`. A future pin must re-verify them before implementation or
release.

### Installation and coexistence

- `npm install -g @opencode-ai/cli@next` installs the `opencode2` binary.
- The package's `bin` map contains `opencode2`; it does not replace the
  `opencode` binary supplied by `opencode-ai`.
- `opencode2 --version` returned `opencode2 v0.0.0-next-17430`.
- The beta package uses a postinstall script and platform-specific optional
  packages. Triss must install an exact pin rather than a moving `next` tag.

### CLI contract

The verified non-interactive surface is:

```text
opencode2 run [flags] <message...>
  --standalone
  --continue, -c
  --session, -s <id>
  --model, -m <provider/model#variant>
  --agent <name>
  --format <default|json>
  --auto
```

Differences from the OpenCode 1 argv currently built by
`buildOpencodeArgv()`:

- V2 has no `--pure` flag.
- V2 `run` has no `--dir` flag.
- Triss must select the runtime directory with the child process `cwd` option.
- V2 must run with `--standalone`; otherwise it may start or reuse a persistent
  background service.

### Configuration compatibility

- V2 accepts `OPENCODE_CONFIG_CONTENT`.
- V2 reads V1-shaped `opencode.json` and translates it in memory.
- A synthetic V1 deny-first policy translated as expected:
  `permission.bash["*"] = "deny"` became a V2 `shell/*/deny` rule, and a
  specific `pwd` allow rule remained effective.
- `opencode2 debug config` returns an ordered array of config sources and
  documents, not the flat resolved object consumed by the current OpenCode 1
  effective-config audit.
- `opencode2 debug config --pure` is invalid.
- V2 omitted the legacy top-level `small_model` from its translated effective
  document. OpenCode 1 still needs that field, so Triss must preserve it in the
  shared V1 config without claiming that V2 uses it.

### Event stream and sessions

- `--format json` emits newline-delimited JSON.
- The verified event names were `step_start`, `tool_use`, `step_finish`,
  `text`, and `error`.
- Tool-bearing runs used the same `part.tokens`, `part.cost`, `part.text`,
  `part.tool`, and `part.state` shapes already consumed by the OpenCode 1 fold.
- V2 issued `ses_...` session IDs. A second standalone invocation with
  `--session <real-id>` resumed the same session successfully, so the existing
  Triss slug-to-real-ID map remains applicable.
- Two successful no-tool runs emitted `step_start` and `text`, exited `0`, and
  emitted no `step_finish`. The current usage fold would correctly report
  `usage_status: "missing"`; the V2 adapter must preserve that result and add a
  V2-specific warning.
- A cancelled stalled run emitted an error shaped as
  `{error: {type: "unknown", message: "Transport"}}`. The current OpenCode 1
  parser does not read `error.message` and would degrade it to
  `unknown engine error`.

### Lifecycle

- `opencode2 run --standalone` completed and exited without a persistent
  service in successful smokes.
- A non-standalone diagnostic/export flow started `opencode2 serve --service`
  processes and did not return promptly. The initial Triss integration must not
  use that path.
- OpenCode 2 uses a separate `opencode-next.db`, but its default log location
  overlaps the OpenCode data tree used by V1. The V2 engine must use a
  Triss-owned XDG data/state root so V1 and V2 log watchers cannot consume each
  other's lines.

## Architecture contract

### Separate engine identity from configuration backend

Introduce two explicit concepts:

```text
engine identity
  opencode   -> OpenCode 1 process adapter
  opencode2  -> OpenCode 2 process adapter
  crush      -> Crush process adapter

configuration backend
  opencode-v1 -> shared by opencode and opencode2
  crush       -> used by crush
```

Both OpenCode engines read the same V1-compatible configuration locations:

```text
global: ~/.config/opencode/opencode.json
local:  <project>/opencode.json
```

This is deliberate: the V1 file is the compatibility source of truth that both
engines can consume. Triss never rewrites it to V2-native fields.

Consequences that must be documented in help and human output:

- `coder init --engine opencode2` validates and, when required, creates the
  same V1-compatible config used by OpenCode 1.
- If a safe config already exists, OpenCode 2 init must preserve it byte for
  byte except for changes explicitly requested by normal init behavior.
- `coder model set --engine opencode2` changes the shared OpenCode config and
  therefore changes the persistent model intent seen by both OpenCode engines.
- The transaction lock is shared between `opencode` and `opencode2` model
  mutations.
- Existing OpenCode 1 transaction manifests and rollback records remain valid.

### Adapter boundary

Add `src/coder-engines/opencode2.js` as a pure sibling of
`src/coder-engines/crush.js`. It owns only V2-specific contracts:

- `OPENCODE2_PIN_DEFAULT` and `opencode2VersionPin()`;
- `detectOpenCode2(spawnSync)`;
- `installHintOpenCode2()`;
- `buildOpenCode2RunArgv()`;
- `buildOpenCode2SpawnEnv()` or V2 additions consumed by the shared env builder;
- `createOpenCode2EventFolder()` / `foldOpenCode2EventLine()` only where V2
  differs from the shared OpenCode fold;
- V2 error-message extraction;
- version/pin metadata used by status;
- declared capabilities such as `needsSessionMap`, `supportsSmallModel`,
  `requiresStandalone`, and `supportsPureConfig`.

The adapter must not own worktree creation, git diff collection, transaction
writes, usage persistence, MCP rendering, or process-group orchestration.

Refactor only the minimum shared process code necessary so `spawnEngine()` can
receive:

```js
{
  binary,
  argv,
  cwd,
  env,
  label,
  createState,
  foldLine,
  scanRateLimit,
}
```

The existing OpenCode 1 call must pass values equivalent to today's hard-coded
behavior. Characterization tests must prove that its binary, argv, env, parser,
session mapping, log watchdog, output envelope, and cleanup behavior did not
change.

### Engine resolution

`resolveCoderEngine()` and `resolveWizardCoderEngine()` accept exactly:

```text
opencode
opencode2
crush
```

Precedence stays unchanged:

```text
explicit --engine
  > TRISS_CODER_ENGINE
  > opencode
```

The default remains `opencode`.

Replace semantic `engine === "crush"` / `engine !== "crush"` forks with named
capabilities or explicit engine families where they currently mean
"OpenCode-like". Do not mechanically treat every non-Crush engine as OpenCode
1; that is the source of the current `--pure`, `--dir`, version, config-audit,
and error-parser incompatibilities.

The implementation must audit and branch before every current non-Crush
fallthrough, specifically including:

- `runCoderInit()` before it calls the OpenCode 1 `runCoderSetup()` path;
- `runCoderSetup()` / `runCoderSetupUnlocked()` before `ensureEngine()`;
- `resolveWizardCoderProvider()` and `CODER_MANIFEST.resolveWizardCtx` before
  they infer the OpenCode 1 provider/setup contract;
- `runCoderRun()` before it builds V1 audit options, detects the V1 binary, or
  calls `buildOpencodeArgv()` / `spawnEngine()`;
- the model CLI handlers before they interpret every non-Crush engine as the
  existing OpenCode backend.

Until a subcommand has an explicit V2 implementation, `--engine opencode2`
must throw an engine-specific `not implemented yet` error before it can invoke
an OpenCode 1 binary, setup helper, audit, or writer.

### Installation and version policy

The new default pin is:

```text
OPENCODE2_PIN_DEFAULT = "0.0.0-next-17430"
```

The override is:

```text
TRISS_CODER_OPENCODE2_VERSION
```

Detection executes only:

```text
opencode2 --version
```

Installation executes with argv arrays, never a shell:

```text
npm install -g @opencode-ai/cli@<exact-pin>
```

The adapter must parse the beta version string without assuming stable semver.
Init and one-shot credential auditing require an exact verified pin during the
beta. Status reports a mismatch without silently replacing either engine.

The existing `OPENCODE_PIN`, `opencodeVersionPin()`,
`TRISS_CODER_OPENCODE_VERSION`, `detectOpencodeVersion()`, and
`opencode-ai@1.18.7` install path remain unchanged.

### Runtime state isolation

Every Triss-managed V2 run uses stable project-owned runtime roots derived from
the original project root, not an isolated worktree path:

```text
XDG_DATA_HOME=<project-root>/.triss/opencode2/data
XDG_STATE_HOME=<project-root>/.triss/opencode2/state
```

Do not forward or set `XDG_CONFIG_HOME`. The existing OpenCode 1 child env also
omits it, and Triss's shared config backend deliberately resolves the global
file as `~/.config/opencode/opencode.json` from `HOME`. V2 must use that exact
same Triss-managed source of truth even when the parent shell has a non-default
`XDG_CONFIG_HOME`. Project config remains selected by the child `cwd`.

The state directories must be created with user-only permissions before the
credential is forwarded. They are harness-owned and excluded from
`files_changed` / `diff_stat` just like other `.triss` state.

This gives Triss:

- a persistent V2 database for session continuation;
- a V2-only log for rate-limit inspection;
- no collision with the V1 database/log;
- no dependency on the user's direct OpenCode 2 service state.

No service registration may survive a run. `--standalone` is mandatory even
with isolated XDG state.

Derive the V2 log path from the same original-project-root runtime object and
pass it explicitly to both the live `spawnEngine()` watchdog and the
post-spawn fallback scan:

```text
<project-root>/.triss/opencode2/data/opencode/log/opencode.log
```

Neither V2 rate-limit path may fall back to `opencodeLogPath()`, because that
helper derives its path from the parent process environment and can select the
V1 log.

### Run argv and cwd

The V2 argv is:

```text
run
--standalone
--format json
--auto
--model <resolved-model>
[--agent <agent>]
[--session <real-session-id>]
[--continue]
<prompt>
```

Use the child process `cwd` option for `--cwd` and isolated worktrees. Never
pass V1-only `--pure` or `--dir` to V2.

The prompt remains an argv item. Never use `shell: true`.

### Provider and credential contract

Provider/model behavior is engine-family shared unless a live V2 smoke proves
otherwise:

| Provider        | Model prefix                    | Credential             |
| --------------- | ------------------------------- | ---------------------- |
| Triss worker    | `triss-worker/`                 | `TRISS_WORKER_API_KEY` |
| Z.AI            | `zai-coding-plan/`, `zai/`      | `ZHIPU_API_KEY`        |
| OpenCode Zen    | `opencode/`                     | `OPENCODE_API_KEY`     |
| OpenCode Go     | `opencode-go/`                  | `OPENCODE_API_KEY`     |
| Moonshot        | `moonshotai/`, `moonshotai-cn/` | `MOONSHOT_API_KEY`     |
| Kimi for Coding | `kimi-for-coding/`              | `KIMI_API_KEY`         |

`buildEngineEnv()` continues to start from an allowlist. It must not spread
`process.env`. V2 receives only:

- `PATH`, `HOME`, `TMPDIR`, `LANG`, and `LC_ALL` when present;
- the selected provider credential;
- `OPENCODE_CONFIG_CONTENT` only for a one-shot provider run;
- the two Triss-owned XDG runtime variables.

No credential value may appear in logs, status, JSON, help, transaction
records, test snapshots, or errors.

### Configuration and permission audit

Keep the persisted file V1-shaped. The existing deny-first source policy stays
authoritative:

```json
{
  "permission": {
    "bash": {
      "*": "deny"
    }
  }
}
```

The V2 preflight is separate from the V1 `debug config --pure` preflight. In
`runCoderRun()`, engine dispatch must select the V2 preflight before
`oneShotAuditOptions`, `detectedOpencodeVersion`,
`auditEffectiveOneShotProviderConfiguration()`, `pure: !!oneShotProvider`, or
the V1 argv are evaluated:

1. Audit every applicable global/project V1 config layer before forwarding a
   credential.
2. Reject malformed JSON/JSONC states under the same fail-closed rules used by
   the V1 one-shot audit.
3. Reject an effective cross-provider override for the selected model.
4. Run `opencode2 debug config` in the exact runtime `cwd` and sanitized env.
5. Parse the returned ordered source/document array.
6. Verify that the selected model and translated deny-first shell rule are
   present in the effective document.
7. Reject incompatible configured V1 plugins with an actionable message. Do
   not migrate or disable them automatically.
8. Never write V2 `cli.json` as part of preflight or init.

For one-shot provider selection, generate a V1-compatible in-memory overlay
containing `model` and only the provider definition required by the existing
worker path. Do not add or validate a V2 `small_model` override.

### Small-model contract

The shared persisted V1 config retains `small_model` for OpenCode 1.

For `--engine opencode2`:

- the runtime never claims V2 used the persisted small model;
- explicit `coder run --small-model` is rejected before spawn with a clear
  engine-specific error;
- `coder run --provider ... --model ...` does not synthesize a small-model
  override;
- `coder models` may display the shared V1 compatibility value, but its stable
  JSON adds an explicit additive field indicating that V2 has no effective
  small role;
- `coder model set` keeps updating the shared pair transactionally because the
  same file remains OpenCode 1's source of truth. Human output states that the
  small value is for OpenCode 1 compatibility.

### Session contract

Reuse `.triss/sessions.json`, but namespace mappings by engine so equal user
slugs cannot resume a session from the wrong major version.

The new persisted shape is versioned and backward compatible:

```json
{
  "version": 2,
  "engines": {
    "opencode": {
      "example": "ses_v1_real_id"
    },
    "opencode2": {
      "example": "ses_v2_real_id"
    }
  }
}
```

Migration rules:

- the current flat `{slug: realId}` shape is read as OpenCode 1 mappings;
- the first successful write upgrades it atomically to the versioned shape;
- no existing V1 mapping is dropped;
- Crush continues using native caller-supplied session IDs and is not added to
  the map;
- unknown versions fail closed without rewriting the file.

Replace the current unversioned `readSessionsMap()` /
`persistSessionMapping()` pair as one transaction-safe change. No old caller
may receive the versioned root object and then execute `map[slug] = realId`.
The new API returns an engine-scoped map and performs read-normalize-modify-
verify-write under the existing atomic retry/CAS behavior. Characterization
tests must capture the current concurrent-write retry behavior before the
migration, then prove it for both V1 flat input and V2 versioned input.

All existing atomic-write, malformed-file, lock, collision, and concurrent
writer protections remain.

### Event, error, and usage contract

Reuse the canonical OpenCode step fold for verified common event shapes.

The V2 adapter adds:

- `error.message` before the existing fallbacks;
- engine-specific unknown-event warnings;
- a warning when an exit-0 response contains final text but no `step_finish`;
- V2-specific rate-limit parsing only from the isolated V2 log.

A successful exit with final text and no counters returns an envelope, not an
exception:

```json
{
  "engine": "opencode2",
  "exit_reason": "end_turn",
  "final_text": "...",
  "usage": {
    "schema_version": 2,
    "usage_status": "missing"
  },
  "warnings": [
    "OpenCode 2 emitted no step_finish event; token and cost usage are unavailable"
  ]
}
```

Never infer zero tokens or zero cost from a missing V2 event.

When `step_finish` exists, fold tokens and engine cost with the existing
OpenCode usage normalizer. Persist `engine: "opencode2"` and
`usage_source: "opencode2"` so accounting can distinguish the beta contract
from V1. Billing-mode resolution may reuse OpenCode provider pricing, but only
through an explicit engine-family mapping covered by tests.

The existing OpenCode 1 envelope and usage records remain byte-for-byte
compatible for equivalent fixtures.

### Envelope versus thrown error

Preserve the current split:

- A spawned V2 process that emits parseable events returns an envelope, even
  when the final `exit_reason` is `error`, `killed`, or `timeout`.
- A binary-not-found error, spawn failure, invalid pin/preflight, unsafe config,
  unparseable-only output, or no parseable output throws before an envelope is
  emitted.
- A rate-limit event after partial output returns the partial envelope with a
  warning.
- A rate limit before final text throws the actionable rate-limit error after
  the process group is gone.
- Stdout contains only the final JSON envelope. Progress and diagnostics use
  stderr.

### Process lifecycle

OpenCode 2 uses the existing POSIX detached-process-group boundary:

- spawn detached;
- forward host `SIGINT` and `SIGTERM`;
- forward MCP cancellation;
- on timeout or cancellation, send group `SIGTERM`, wait, then `SIGKILL`;
- on immediate child exit, verify no residual group member can continue;
- fail closed if the group remains observable;
- never signal pid `0`, pid `1`, a non-integer pid, or an unowned injected
  process group.

The process label and errors say `OpenCode 2`, not `OpenCode`.

After every live smoke, verify both:

1. no `opencode2 run` descendant remains;
2. no `opencode2 serve --service` process was created for the Triss XDG state.

### Model management and rollback

`coder models`, `coder model set`, and rollback must understand the distinction
between engine identity and config backend.

For new transaction manifests, record both:

```json
{
  "engine": "opencode2",
  "config_backend": "opencode-v1"
}
```

Compatibility rules:

- a legacy manifest with `engine: "opencode"` and no `config_backend` maps to
  `opencode-v1`;
- a new `opencode` manifest may also record `config_backend: "opencode-v1"`;
- `opencode2` rollback dispatches to the existing OpenCode config/env restore
  implementation through the backend field;
- `applyModelChange()` derives the mutation-lock key from
  `config_backend: "opencode-v1"`, never from raw `plan.engine`, so concurrent
  `opencode` and `opencode2` writes contend on the same lock;
- unknown engines/backends fail closed;
- config paths, modes, hashes, CAS checks, backup validation, rollback locks,
  and post-commit audits remain unchanged;
- `opencode` and `opencode2` acquire the same mutation lock because they target
  the same files.

### Plugin compatibility gate

V1 plugin implementations are not assumed to work in V2.

Initial behavior:

- no plugins in the effective configuration: proceed;
- a V2-native plugin explicitly proven compatible with the pinned build:
  proceed only when a fixture and live smoke cover it;
- any other configured plugin: fail before forwarding the selected credential,
  naming the config source and the unsupported plugin without printing secrets;
- local `.opencode/plugin*` discovery must be included in the audit;
- Triss never rewrites, moves, installs, disables, or migrates a plugin.

## CLI and MCP contract

Update every engine help/enum surface to list `opencode`, `opencode2`, and
`crush` in that order.

Examples:

```bash
# Install/validate V2 while preserving the V1-compatible config.
triss coder init --engine opencode2 --provider opencode-go --global

# Read model state through the V2 engine identity.
triss coder models --engine opencode2 --provider opencode-go

# Run V2 explicitly. V1 remains the default when --engine is omitted.
triss coder run --engine opencode2 \
  --model opencode-go/deepseek-v4-flash \
  "implement the task"

# Persist a model pair in the shared OpenCode config.
triss coder model set opencode-go/deepseek-v4-flash \
  --small opencode-go/deepseek-v4-flash \
  --engine opencode2 --provider opencode-go --global --yes
```

`triss_coder_run.engine` adds `opencode2` to its enum. MCP descriptions state:

- `opencode` remains the default;
- V2 is pinned beta software;
- V2 has no effective `small_model` run override;
- the returned envelope identifies `engine: "opencode2"`;
- cancellation reaches the same process-group cleanup boundary.

The schema test must assert the exact ordered enum
`["opencode", "opencode2", "crush"]`; help/description tests must assert that
`opencode` is still the default and that `opencode2` is the explicit beta
choice. An MCP call that omits `engine` must have a regression test proving it
still reaches the V1 adapter.

Status reports three engine rows independently:

```text
default engine                opencode
● opencode                    1.18.7 (matches pin)
● opencode2                   0.0.0-next-17430 (matches pin, beta)
● crush                       0.1.6 (matches pin)
```

The shared `opencode.json` paths are rendered once and labeled as used by both
OpenCode engines. Status remains read-only and never starts a V2 service or
makes a network request.

## Implementation phases

### Phase 1 — document and lock current OpenCode 1 behavior

Add characterization tests before changing dispatch:

- engine precedence and default remain `opencode`;
- exact V1 binary and argv, including `--pure` / `--dir` where applicable;
- exact V1 env allowlist;
- current config preflight and deny-first audit;
- current session flat-map reading/writing;
- current concurrent session-write retry/CAS behavior;
- current event/error fold;
- current usage and envelope identity;
- current process-group cleanup;
- current CLI/MCP/status enums and text snapshots where stable.

Run the focused tests and record GREEN before the refactor. These tests are the
regression shield for the requirement that OpenCode 1 stay as it is.

Acceptance: behavior of `--engine opencode` is captured before any shared code
moves.

### Phase 2 — RED OpenCode 2 adapter contract

Add fixtures captured from the pinned live binary:

- no-tool success without `step_finish`;
- tool success with two `step_finish` events and usage;
- `error.message` event;
- session resume using the same real ID;
- translated V1 config source/document array;
- invalid V1-only `--pure` / `--dir` expectations.

Add focused failing tests for:

- engine resolution and pin override;
- detect/install command and exact package;
- V2 argv and child `cwd`;
- mandatory `--standalone`;
- XDG runtime isolation;
- no unrelated credential forwarding;
- config-array parsing and deny-first verification;
- plugin rejection;
- no effective small-model override;
- namespaced session-map migration;
- V2 error text and missing-usage behavior;
- `engine` / `usage_source` output identity;
- service-process absence and group cleanup through deterministic fakes.

Acceptance: the new focused suite is RED only because no V2 adapter/dispatch
exists; existing V1 and Crush suites remain GREEN.

### Phase 3 — implement the pure adapter and shared spawn seam

Add `src/coder-engines/opencode2.js`. Refactor `spawnEngine()` to accept the
adapter-owned binary, argv, cwd, event folder/fold, label, and optional log
scanner.

Add explicit `opencode2` rejection guards to init, setup, wizard, model, and
rollback entry points before wiring only `coder run --engine opencode2` at
first. Unsupported V2 subcommands must throw an explicit `not implemented yet`
error during this phase; no silent fallback to V1 or Crush is allowed.

Acceptance:

- V2 run tests are GREEN;
- all Phase 1 V1 characterization tests remain GREEN;
- all Crush lifecycle tests remain GREEN;
- no production branch treats every non-Crush engine as V1.

### Phase 4 — configuration, init, status, and model management

Introduce the explicit config-backend mapping. Add V2 detection/init, effective
config parsing, plugin preflight, XDG state setup, model inspection, shared
transaction writes, manifest compatibility, rollback dispatch, and status.

Update the session store to the versioned engine-namespaced shape with atomic
flat-map migration.

Acceptance:

- existing safe V1 config is not migrated or rewritten merely by V2 init;
- unsafe or incompatible config fails before credential forwarding;
- model mutations state that the config is shared;
- old rollback records still restore correctly;
- V1 and V2 equal slugs never cross-resume;
- status detects V2 without starting its service.
- both OpenCode engines contend on one backend-derived model mutation lock;
- a parent-shell `XDG_CONFIG_HOME` override is not forwarded, and preflight and
  runtime both resolve the documented `~/.config/opencode/opencode.json`;
- both live and fallback V2 rate-limit scans receive the explicit isolated V2
  log path.

### Phase 5 — CLI, MCP, docs, and generated templates

Update in lockstep:

- `bin/triss.js`;
- `src/mcp/tools.js` and `src/mcp/handlers.js`;
- `src/commands/status.js`;
- `README.md`;
- `.env.example`;
- `docs/configuration.md`;
- `docs/glm-clients.md`;
- `docs/mcp.md`;
- `docs/usage-accounting.md`;
- `templates/codex.md` and `templates/codex-full.md`;
- `templates/claude.md` and `templates/claude-full.md`;
- active help and `triss agent-help --target codex` expectations.

Add a focused user guide at `docs/opencode2.md` covering beta status,
installation, shared config implications, missing small-model role, usage gaps,
plugin gate, rollback, and how to return to the unchanged V1 engine.

Acceptance: a user can discover, initialize, run, resume, inspect, and
troubleshoot V2 from both CLI and MCP documentation without interpreting
`opencode` as V2.

### Phase 6 — validation and live acceptance

Run focused tests first, then the repository-wide checks:

```bash
node --test \
  test/coder-opencode2.test.js \
  test/coder-envelope.test.js \
  test/coder-isolate.test.js \
  test/coder-model-management.test.js \
  test/coder-model-transaction.test.js \
  test/coder-model-rollback.test.js \
  test/coder-process-lifecycle.test.js \
  test/coder-usage-v2.test.js \
  test/mcp-coder.test.js \
  test/status-coder.test.js
npm run lint
npm test
```

Use the actual filenames introduced by implementation if the lifecycle tests
remain embedded in existing suites; do not create duplicate test files only to
match this command block.

Then run one minimal live matrix against the exact pin with already-configured
credentials:

1. `opencode` no-tool V1 smoke to prove the old default still works.
2. `opencode2` no-tool smoke and honest missing-usage assertion when no
   `step_finish` appears.
3. `opencode2` read-only tool smoke proving deny-first plus one explicit allow.
4. `opencode2` session-resume smoke through a Triss slug.
5. `opencode2` isolated-worktree smoke with no changes and automatic cleanup.
6. A V2 denied-command smoke proving `--auto` never overrides explicit deny.
7. Process-list verification proving no run descendant or service remains.
8. A delayed-file check proving no writes occur after the envelope.
9. Redacted status/help/MCP inspection proving no secret value is exposed.

Do not enable subscriptions, regional hosting, privacy opt-ins, or plugin
migrations during validation.

Acceptance: focused tests, lint, full suite, and the live matrix pass; every
observed beta difference is reflected in this plan and the user docs before
release.

## File-level implementation map

| File                               | Required change                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/coder-engines/opencode2.js`   | New pure V2 adapter, pin, detection, argv, capabilities, event differences                      |
| `src/commands/coder.js`            | Engine resolution, adapter dispatch, cwd/env, config preflight, sessions, init, status metadata |
| `src/coder-models.js`              | Engine-to-backend mapping, V2 state metadata, transaction manifest compatibility, shared lock   |
| `src/commands/coder-models.js`     | V2 rendering, shared-config warnings, small-role semantics, rollback routing                    |
| `src/usage-schema.js`              | Reuse fold; add only explicit V2 source/metadata handling if required                           |
| `src/usage.js`                     | Accept `opencode2` engine/source without conflating it with V1                                  |
| `src/commands/status.js`           | Independent V2 binary/pin row and shared-config labels                                          |
| `src/mcp/tools.js`                 | Add engine enum and V2 capability descriptions                                                  |
| `src/mcp/handlers.js`              | Preserve engine/cancellation routing and status text                                            |
| `bin/triss.js`                     | Update CLI help for all engine-aware commands                                                   |
| `test/fixtures/opencode2-*.ndjson` | Sanitized live-contract fixtures                                                                |
| `test/coder-opencode2.test.js`     | Adapter, run, config, session, error, usage, and safety contract                                |
| Existing coder tests               | OpenCode 1 characterization and shared regression coverage                                      |
| Docs/templates listed in Phase 5   | Same-PR public contract update                                                                  |

## Acceptance criteria

- `triss coder run` without `--engine` still resolves to OpenCode 1.
- `--engine opencode` still spawns `opencode` with the existing pin and V1
  contract.
- `--engine opencode2` spawns only `opencode2` at the exact verified pin.
- Installing or running V2 never replaces, upgrades, or invokes the V1 binary.
- V2 always runs standalone and leaves no service or process descendant.
- V1 and V2 runtime databases/logs do not collide.
- Both engines consume the V1-compatible `opencode.json`; Triss never writes
  native V2 config.
- Existing safe V1 config and unrelated fields are preserved.
- Effective deny-first enforcement is verified before a provider credential is
  forwarded.
- Only the selected provider key enters the V2 environment.
- Configured incompatible plugins fail closed without mutation.
- V2 uses child `cwd`; it never receives unsupported `--dir` or `--pure`.
- V2 session mappings are namespaced and existing V1 flat mappings migrate
  without loss.
- V2 `error.message` is preserved in diagnostics.
- Missing `step_finish` produces `usage_status: "missing"`, null canonical
  counters/cost, and an explicit warning; it is never reported as zero usage.
- Tool-bearing V2 usage folds all reported steps exactly once.
- The envelope and usage log identify `opencode2`, never `opencode`.
- Persistent model mutation uses the shared OpenCode lock and transaction
  backend; legacy rollback records remain supported.
- `--small-model` is not silently accepted for a V2 run.
- CLI, MCP, status, docs, and templates expose the same three-engine contract.
- Existing OpenCode 1 and Crush tests stay green.
- Focused tests, lint, full suite, and the live acceptance matrix pass.

## Guardrails for implementation

- Follow docs-first TDD: update this contract first if live beta behavior
  differs, add a RED fixture/test, then implement the smallest GREEN change.
- Preserve unrelated dirty/untracked worktree content.
- Never use `shell: true` or interpolate a prompt/model/path/key into a shell
  command.
- Never pass the full parent environment to an engine.
- Never print or persist credential values.
- Never start, attach to, inspect through, or stop the user's normal OpenCode 2
  background service.
- Never infer that exit code `0` implies usage counters were reported.
- Never recover V2 usage by reading its SQLite database or invoking `export` in
  the initial implementation.
- Never rewrite V1 plugin/config files to make V2 accept them.
- Never weaken deny-first permissions to make a smoke pass.
- Never change the existing engine default as part of this work.
- Do not add a dependency; use Node builtins and current repository helpers.
- Keep stdout machine-clean: one final envelope only.
- Keep every destructive cleanup scoped to the exact process group, worktree,
  or transaction record created by the current operation.

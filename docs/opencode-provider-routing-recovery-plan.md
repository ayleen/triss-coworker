# OpenCode provider routing and OpenCode 2 recovery plan

Status: implementation plan. No production code is changed by this document.

This plan supersedes the exact OpenCode 2 build pin, unconditional
deny-everything preflight, and incomplete provider assumptions in
`docs/opencode2-engine-plan.md` and `docs/engines/opencode2.md`. Those files
continue to describe the current implementation until this plan is executed;
they must be updated as part of Phase 6 rather than treated as concurrent
requirements.

Last verified: 2026-08-21 against Triss `0.37.2`, OpenCode 1 `1.18.7`,
and `@opencode-ai/cli@beta` / `opencode2 v0.0.0-beta-17793`.

## Outcome

Restore `triss coder run` for every provider supported by the OpenCode engine,
make the current OpenCode 2 beta usable, and keep the security posture explicit
instead of silently substituting a broken proxy token or claiming isolation
that is not enforced.

The completed change must provide these user-visible guarantees:

1. `opencode2` installs from the current V2 beta release line and accepts any
   compatible installed version greater than or equal to the minimum supported
   version. It is no longer tied to one exact opaque build.
2. `TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=1 triss coder run --engine
   opencode2 ...` reaches the engine even when OS-enforced credential isolation
   is unavailable. This mode may pass the selected raw provider credential to
   the child and may load the user's normal agents/tools, but reports that
   downgrade honestly.
3. Every advertised provider works through `opencode` and `opencode2`:
   `worker`, `zai`, `opencode-zen`, `opencode-go`, `moonshot`, and
   `kimi-for-coding`, including every documented prefix belonging to those
   provider kinds.
4. The protected path does not depend on undocumented provider-specific base
   URL environment variables. It routes through a transient, audited provider
   definition carried in `OPENCODE_CONFIG_CONTENT` and a protocol-aware
   parent-owned credential proxy.
5. No mode forwards a credential to a repository-controlled provider endpoint
   by accident. Best-effort means reduced isolation, not disabled endpoint,
   model, or credential-selection validation.

## Current failures

### OpenCode 1 provider redirection is ineffective

`coderCredentialEndpoint()` currently assumes that setting
`OPENCODE_BASE_URL`, `ZAI_BASE_URL`, or `ZHIPU_BASEURL` redirects the selected
built-in OpenCode provider. OpenCode 1.18.7 does not consume those variables.
The child therefore presents the one-run proxy token to the real provider and
fails authentication.

The existing unit tests only prove that Triss placed a token and base URL in
the spawned environment. They do not prove that the real engine used the
loopback proxy.

### The proxy has one OpenAI-compatible route shape

The credential proxy currently permits only
`<pathPrefix>/chat/completions` for bearer-auth providers. That is insufficient:

- OpenAI-compatible providers use `POST /chat/completions`;
- OpenAI Responses providers use `POST /responses`;
- Kimi for Coding uses the Anthropic protocol at `POST /messages`;
- OpenCode Zen and OpenCode Go have different upstream prefixes;
- an OpenCode model may override its provider package and therefore its
  protocol. The current Go model `opencode-go/muse-spark-1.2-contributor`
  selects `@ai-sdk/openai` and uses Responses.

### OpenCode 2 is pinned to an obsolete build

The adapter requires exact equality with `0.0.0-next-17430`. The current V2
beta tag is `0.0.0-beta-17793`, so an otherwise usable installation is rejected.
The current npm tags must not be conflated:

- `@opencode-ai/cli@latest` is the stable V1 package line and currently does
  not install the `opencode2` binary;
- `@opencode-ai/cli@beta` is the current V2 line and installs `opencode2`.

### OpenCode 2's safe-mode gates make normal coding impossible

The current preflight always requires a deny-everything shell policy and
rejects every discovered agent, plugin, and custom tool. It does so even after
the operator explicitly sets `TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=1`.
OpenCode 2 then starts with the raw credential rather than the already-created
credential proxy, so the proxy cost is paid without supplying the boundary the
preflight claims to require.

One-shot `--provider` is also rejected for OpenCode 2, preventing a complete
provider acceptance matrix.

## Verified current-beta facts

The following facts were checked directly against
`opencode2 v0.0.0-beta-17793` in an isolated XDG root:

- `run` still supports `--standalone`, `--format json`, `--auto`, `--model`,
  `--agent`, `--session`, `--continue`, and `--fork`;
- `OPENCODE_CONFIG_CONTENT` accepts a V1-shaped transient custom-provider
  definition during a standalone run;
- `@ai-sdk/openai-compatible` plus `options.baseURL` produced
  `POST <base>/chat/completions`;
- `@ai-sdk/openai` plus `options.baseURL` produced
  `POST <base>/responses`;
- `@ai-sdk/anthropic` plus `options.baseURL` produced
  `POST <base>/messages` with `x-api-key` authentication;
- all three local-route smokes reached the configured loopback endpoint with a
  dummy credential and did not need a real provider key.

These observations establish the implementation direction but do not replace
the provider-specific live acceptance matrix later in this plan.

## User contract

### Version floor

Define the default supported floor as:

```text
OPENCODE2_MIN_VERSION_DEFAULT = 0.0.0-beta-17793
install channel = @opencode-ai/cli@beta
runtime acceptance = installed version >= minimum version
```

Retain `TRISS_CODER_OPENCODE2_VERSION` for compatibility, but document and
implement it as an override of the minimum accepted version, not an exact pin.
Internally rename the concepts to `minimumVersion`, `meetsMinimum`, and
`installChannel`; keep deprecated exported aliases only where tests or public
imports require a transition period.

The comparator must understand the V2 beta shape rather than comparing strings:

- `0.0.0-beta-17792` is below the default floor;
- `0.0.0-beta-17793` meets it;
- `0.0.0-beta-17794` meets it;
- a later stable V2 semantic version meets the numeric floor if the required
  CLI capability probe also passes;
- malformed output and non-release channels such as `dev` or `tui-v2` fail
  closed by default, even if their numeric suffix is larger;
- legacy `next-*` builds do not become greater than a beta merely because the
  prerelease label sorts differently.

Do not add a general semver dependency for this. Implement and unit-test the
small OpenCode 2 version grammar explicitly.

Installation and runtime checks have different jobs:

- installation help points to `npm install -g @opencode-ai/cli@beta` so a user
  obtains the latest V2 beta rather than the V1 `latest` tag;
- runtime checks accept an already-installed compatible version at or above
  the floor and never auto-downgrade it;
- `OPENCODE_DISABLE_AUTOUPDATE=1` remains set for every managed process so the
  executable cannot mutate during a run;
- the post-run check requires the same canonical executable path and the same
  version observed before spawn, not equality with the minimum version.

### Capability qualification for newer versions

An open-ended `>=` check must not turn version text into the only compatibility
proof. Before forwarding any credential, probe the resolved absolute binary
without starting its background service:

```text
opencode2 --version
opencode2 run --help
```

Require the help surface to contain `--standalone`, `--format`, `--auto`, and
`--model`. Do not call `opencode2 debug config`: current beta builds can leave a
resident service behind. Cache the successful capability result per canonical
binary path plus version for the lifetime of the Triss process.

A version above the floor with a missing required flag fails with a clear
`unsupported OpenCode 2 CLI contract` error and forwards no credential.

### Isolation modes

Resolve one explicit credential mode before config auditing or proxy startup:

```text
protected_proxy
best_effort_raw
```

`protected_proxy` remains the default. It supplies only a run-scoped proxy
token to the engine and synthesizes a provider transport that points to the
loopback proxy. It must never fall back to a raw credential silently.

`best_effort_raw` is selected only when
`TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=1`. In this mode:

- pass only the credential required by the selected provider;
- allow normal shell policy, agents, plugins, and custom tools after ordinary
  parse/shape checks instead of applying the deny-everything beta gate;
- allow readable same-UID credential stores and the absence of an OS sandbox;
- do not require a credential proxy to start;
- preserve endpoint trust, provider/model matching, config parsing,
  canonical-cwd, binary provenance, process supervision, timeout, and cleanup
  checks;
- emit one stable warning code on stderr and in the result envelope:
  `TRISS_CODER_CREDENTIAL_ISOLATION_DOWNGRADED`;
- report `execution_capabilities.credential_isolation = "unavailable"`, not
  `best_effort` or `enforced`, because the raw credential is present in the
  child process;
- state plainly that repository code and same-UID processes may read or print
  the credential.

The flag is an explicit operational acknowledgement, not a way to disable
model and endpoint pinning. A repository-defined provider URL, credential
binding, or model transport still cannot capture a user credential unnoticed.

The existing `--allow-best-effort-caller-worktree` remains a separate choice.
It controls filesystem worktree downgrade; it must not implicitly enable raw
credentials, and the environment flag must not implicitly disable requested
worktree isolation.

## Unified provider transport model

Create a pure provider-transport resolver shared by OpenCode 1 and OpenCode 2.
Its input is the requested provider kind, fully qualified model, trusted
provider settings, and credential mode. Its output is data, not an engine env:

```text
provider kind
requested model
engine model/provider alias
credential env name
credential value source
upstream origin
upstream path prefix
protocol: openai_chat | openai_responses | anthropic_messages
AI SDK package
auth style
trusted model metadata source
```

The supported provider matrix is:

| Provider kind | Model prefixes | Credential | Transport requirement |
| --- | --- | --- | --- |
| `worker` | `triss-worker/*` | `TRISS_WORKER_API_KEY` | Trusted worker profile; OpenAI-compatible chat unless the profile contract is extended explicitly |
| `zai` | `zai-coding-plan/*`, `zai/*` | `ZHIPU_API_KEY` | Coding-plan or PAYG prefix; OpenAI-compatible chat |
| `opencode-zen` | `opencode/*` | `OPENCODE_API_KEY` | Zen prefix and model/provider package from trusted OpenCode metadata |
| `opencode-go` | `opencode-go/*` | `OPENCODE_API_KEY` | Go prefix and model/provider package from trusted OpenCode metadata; Responses must be supported |
| `moonshot` | `moonshotai/*`, `moonshotai-cn/*` | `MOONSHOT_API_KEY` | Region-specific trusted base; OpenAI-compatible chat |
| `kimi-for-coding` | `kimi-for-coding/*` | `KIMI_API_KEY` | `/coding/v1`; Anthropic `messages` with `x-api-key` |

The resolver must distinguish OpenCode Zen `/zen/v1` from OpenCode Go
`/zen/go/v1`. It must also honor a trusted model-level package override when
that model selects `@ai-sdk/openai` instead of the provider default. It must
not infer protocol solely from a provider prefix when trusted model metadata
says otherwise.

For Zen/Go, use current authenticated catalogue/model metadata already
obtained through the parent process. Do not ask the credential-bearing engine
to discover its transport after receiving a proxy token. If the protected path
cannot resolve a model's package/protocol from trusted metadata, fail before
spawn with a recovery message. The explicit best-effort path may use the
engine's built-in provider with the raw key, but must still reject persistent
repository endpoint overrides.

## Transient provider overlay

Build one engine-neutral `OPENCODE_CONFIG_CONTENT` overlay from the resolved
transport. Do not mutate global or project `opencode.json` for a run.

For protected proxy mode, use a Triss-owned transient provider alias rather
than relying on undocumented built-in environment overrides. The alias must:

- select the AI SDK package required by the protocol;
- point `options.baseURL` at the proxy's scoped loopback URL;
- bind the one-run proxy token;
- expose only the selected model;
- preserve the requested model separately for catalogue, billing, usage, and
  the public result envelope;
- be passed to both OpenCode engines through their supported transient config
  surface;
- never merge arbitrary lower-precedence provider headers/options into the
  generated definition.

For best-effort raw mode, prefer the built-in provider where it is sufficient.
Use a transient provider definition for `triss-worker` and any route whose
trusted base/package must be made explicit. The overlay binds only the selected
raw credential and is never persisted. Secrets must not be embedded in thrown
errors, status output, debug dumps, or retained result files.

Remove OpenCode 2's unconditional rejection of `--provider` and
`--small-model`. OpenCode 2 may ignore the small-model role at runtime, but the
CLI/MCP contract should accept a selected provider and main model; when a
small model is supplied, validate it belongs to the same provider and report
that V2 did not use a separate small role rather than rejecting the run.

## Protocol-aware credential proxy

Replace the implicit `authStyle -> one allowed path` rule with an explicit
protocol profile. The proxy still binds one provider, model set, credential,
deadline, request count, body size, response size, and rate limit.

Allowed inference routes are exactly:

```text
openai_chat       -> <prefix>/chat/completions, Authorization: Bearer
openai_responses  -> <prefix>/responses, Authorization: Bearer
anthropic_messages -> <prefix>/messages, x-api-key + anthropic-version
```

The proxy must continue to reject CONNECT, absolute-URI requests, other paths,
other models, malformed bodies, and mismatched auth. Add request-body model
extraction fixtures for both Chat Completions and Responses shapes. Preserve
query strings only on the exact allowed path.

OpenCode-specific account/config endpoints are not inference routes and must
not be opened in the credential proxy. The transient provider alias must avoid
triggering built-in account discovery with the proxy token.

## OpenCode 2 preflight changes

Split the current all-or-nothing audit into invariant checks and mode checks.

Invariant checks run in both modes:

- canonical runtime directory and Git/project boundary;
- parse every effective config document or reject;
- selected model belongs to the selected provider;
- selected credential is the one mapped to that provider;
- no untrusted endpoint, package, header, or credential-binding override is
  merged into the selected transport;
- transient overlay matches the resolved transport exactly;
- canonical binary path, minimum version, capability probe, no mid-run binary
  change;
- process lifecycle, timeout, cancellation, output limits, and cleanup.

Protected-mode checks additionally require:

- a successfully started loopback credential proxy;
- only the proxy token reaches the engine;
- raw credential stores do not become an alternative child-readable source
  under the current same-UID policy;
- executable config surfaces satisfy the protected policy selected by the
  implementation.

Best-effort mode does not reject solely because the effective shell policy has
allow/ask rules or because agents/plugins/tools are discovered. It records
those surfaces in diagnostics and continues with the explicit downgrade
warning.

Do not rewrite the user's shared V1 config from an allowlist to deny-everything
merely because `coder init --engine opencode2` ran. Init should validate and
report the selected mode, configure the chosen provider/model, and leave
unrelated user policy byte-identical.

## Result and status contract

Bring the OpenCode 2 envelope up to the current envelope v2 shape instead of
continuing its reduced legacy object. It must include:

- `envelope_version`, run identity, lifecycle fields, activity, timestamps,
  and `execution_capabilities`;
- requested model/provider and actual transient engine provider/model when an
  alias is used;
- `credential_mode: protected_proxy | best_effort_raw`;
- the stable downgrade warning in best-effort mode;
- honest `usage_status: missing` when the current engine emits no terminal
  usage event;
- no credential, proxy token, request body, or full provider response headers.

`triss status` should render:

```text
opencode2 <installed> (minimum: 0.0.0-beta-17793, compatible)
```

or a clear below-minimum / missing-capability message. Status stays read-only,
does not contact provider APIs, and does not start an OpenCode 2 service.

Update help and docs so `@beta`, minimum-version semantics, best-effort risk,
and provider coverage are consistent across CLI, MCP, README, configuration,
engine guide, status, and generated agent guidance.

## Implementation sequence

### Phase 0 — lock the live compatibility matrix

Before production edits, add executable diagnostic fixtures for the current
beta:

1. version parser and `>=` examples;
2. `run --help` capability output;
3. standalone transient-provider calls to local echo servers for Chat
   Completions, Responses, and Anthropic Messages;
4. NDJSON success, tool use, provider error, timeout, and missing-usage shapes;
5. proof that no standalone smoke leaves an `opencode2 serve --service`
   descendant.

Keep these smokes isolated under temporary HOME/XDG roots and use dummy keys.

### Phase 1 — version floor and capability probe

Change `src/coder-engines/opencode2.js`, status, init, run errors, tests, and
docs to use the beta install channel plus minimum-version comparison. Preserve
canonical-path validation, executable-file validation, auto-update disable,
and same-binary post-run verification.

### Phase 2 — provider transport resolver

Extract provider/model/credential routing out of `src/commands/coder.js` into
a pure module. Add complete table-driven tests for every prefix, endpoint,
protocol, package, credential, invalid model, and hostile override. Reuse it
from both OpenCode engines before changing proxy behavior.

### Phase 3 — protocol-aware proxy and overlay builder

Extend `src/coder-credential-proxy.js` with explicit protocol profiles and
add the transient provider overlay builder. Test the real installed engines
against loopback echo servers; a fake spawn assertion is not sufficient.

### Phase 4 — credential-mode orchestration

Resolve `protected_proxy` versus `best_effort_raw` once in
`runCoderRun()`. Remove duplicated engine-specific credential decisions.
Make proxy startup conditional on protected mode and pass the resolved
transport/overlay to the selected adapter. Ensure every early failure revokes
the proxy and removes only freshly created isolation worktrees.

### Phase 5 — OpenCode 2 policy and one-shot support

Make OpenCode 2 preflight mode-aware, stop rejecting normal tools/agents in
explicit best-effort mode, stop rewriting the shared config to
deny-everything, and accept one-shot provider selection. Keep invariant
endpoint/model/config/binary checks in both modes.

### Phase 6 — envelope, status, docs, and migration

Emit the complete envelope v2 fields for OpenCode 2, update status/help/docs,
and add migration text for users with the obsolete exact pin or a V2-created
deny-everything shared config. Do not silently edit existing user config during
upgrade.

## TDD matrix

Add RED tests before each production change.

### Version tests

- below/equal/above current beta floor;
- multi-digit build ordinals;
- malformed, `next`, `dev`, and `tui-v2` versions;
- future stable V2 plus capability pass/fail;
- install hint uses `@beta`, never npm `@latest`;
- pre/post binary path or version change aborts.

### Mode tests

- absent flag never silently selects raw credentials;
- `TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=1` reaches OpenCode 2 with a V1
  allowlist and discovered agents;
- best-effort passes only the selected raw credential;
- best-effort emits the stable warning and reports credential isolation as
  unavailable;
- hostile provider endpoint/package/header overrides still reject in
  best-effort mode;
- caller-worktree downgrade remains independently controlled.

### Provider tests

For both `opencode` and `opencode2`, cover:

- `worker` / `triss-worker/*`;
- `zai` coding-plan and PAYG prefixes;
- `opencode-zen`;
- `opencode-go` with Chat and Responses model metadata;
- Moonshot global and China prefixes;
- Kimi for Coding Anthropic transport;
- one-shot CLI and MCP selection;
- missing/wrong credential and provider/model mismatch;
- catalogue-unavailable protected-mode behavior and explicit best-effort
  fallback.

Each protected-mode case must prove with a real local engine smoke that:

1. the loopback server received the request;
2. the path and auth style match the selected protocol;
3. the child did not receive the real provider credential;
4. the proxy forwarded only the pinned model and exact inference route;
5. no request reached the real upstream.

Each best-effort case must prove that the selected built-in/custom provider can
complete a synthetic response without requiring deny-everything policy.

### Regression tests

- OpenCode 1 remains the default engine;
- Crush behavior is unchanged;
- persistent config/env bytes are unchanged by one-shot runs;
- no secret/token appears in stdout, stderr, envelope, logs, retained state,
  or thrown errors;
- session namespace, continuation, worktree cleanup, cancellation, rate-limit,
  and usage accounting remain engine-specific and correct;
- targeted tests that previously passed while live routing was broken are
  supplemented, not merely rewritten to assert a new env shape.

## Release acceptance

The change is ready for a release only after all of the following pass in the
exact implementation worktree:

1. focused version, transport, proxy, preflight, provider, CLI, MCP, status,
   lifecycle, session, and usage tests;
2. full `npm test`, lint, and `git diff --check`;
3. packaged CLI smoke, not only source invocation;
4. latest-beta OpenCode 2 local protocol smokes with dummy keys;
5. one minimal live completion for every provider kind on both engines where
   the user has a configured credential/entitlement;
6. a best-effort OpenCode 2 tool-using run from a normal V1-configured project
   containing the standard allowlist and agents;
7. process inspection proving no residual OpenCode/OpenCode 2 service or tool
   descendant remains;
8. diff review confirming no credential values or unrelated user files were
   added;
9. independent security review of the proxy/overlay boundary and independent
   compatibility review of the OpenCode 2 `>=` policy.

Provider credentials, publication, PR creation, merge, npm release, and tag
creation remain separate authorization gates.

## Files expected to change during implementation

At minimum:

- `src/coder-engines/opencode2.js`;
- `src/commands/coder.js`;
- `src/coder-credential-proxy.js`;
- `src/opencode2-preflight.js`;
- a new pure provider-transport/overlay module;
- `src/coder-orchestration.js` and status rendering;
- CLI and MCP help/schema/handler surfaces;
- focused provider, proxy, OpenCode 1, and OpenCode 2 tests;
- `README.md`, `docs/configuration.md`, `docs/engines/opencode2.md`, and the
  relevant provider guides.

Avoid modifying generated files by hand. Do not change the default engine,
publish a release, or remove the existing V1 adapter as part of this recovery.

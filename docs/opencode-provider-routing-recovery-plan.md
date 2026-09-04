# OpenCode provider routing and OpenCode 2 recovery plan

> **Historical pre-0.42 design record.** Legacy provider names, environment
> variables, model selectors, and commands below are migration history, not
> valid runtime guidance. See [`configuration.md`](configuration.md).

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
   `kimi-for-coding`, including every prefix exported by Triss's canonical
   provider registry for those provider kinds.
4. The protected path does not depend on undocumented provider-specific base
   URL environment variables. It routes through a transient, audited provider
   definition carried in `OPENCODE_CONFIG_CONTENT` and a protocol-aware
   parent-owned credential proxy.
5. Triss never merges a repository-controlled provider endpoint, package,
   header, or credential binding into the selected transport. In
   `best_effort_raw`, repository code can still read and exfiltrate the raw
   credential from the child environment; that risk is explicit and is not
   presented as credential isolation.

## Accepted risks and non-goals

The following decisions are intentional for this recovery and are not release
blockers:

- Triss does not retain an exact-version pin or add a denylist/rollback switch
  for a future broken OpenCode 2 beta above the supported floor. The required
  option probe and release qualification reduce this risk; they do not
  eliminate it.
- Backward compatibility for the obsolete
  `TRISS_CODER_OPENCODE2_VERSION=0.0.0-next-17430` exact-pin override is not
  preserved as a pin. Lower or malformed minimum overrides now fall back to the
  built-in floor; an installed binary on an unsupported prerelease channel
  still fails closed.
- `best_effort_raw` does not protect a credential from repository code,
  plugins, tools, shell commands, or other same-UID processes. It protects only
  Triss's provider/model/endpoint selection from accidental configuration
  redirection and reports credential isolation as unavailable.

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

The corresponding OpenCode 1.18.7 route was also checked directly. A
`triss-proxy/*` provider supplied through `OPENCODE_CONFIG_CONTENT` sent both
its title request and main request to the configured loopback
`POST /v1/chat/completions` endpoint with the overlay token. Repeating the
smoke with a conflicting same-id provider in the project `opencode.json`
still used the transient overlay endpoint and token. The implementation must
nevertheless reject a project collision with Triss's reserved transient alias
rather than relying only on precedence.

In an isolated HOME/XDG root, `opencode2 --version` and
`opencode2 run --help` completed without creating a new
`opencode2 serve --service` process. Preserve this as an executable regression
check; do not infer it only from help text.

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

The override accepts the same supported release grammar as the default floor.
An obsolete `next-*` value is an unsupported override and fails with guidance
to remove it or replace it with a beta minimum. No automatic conversion or
legacy exact-pin compatibility is required; this is the accepted migration
risk above.

The comparator must understand the V2 beta shape rather than comparing strings:

- `0.0.0-beta-17792` is below the default floor;
- `0.0.0-beta-17793` meets it;
- `0.0.0-beta-17794` meets it;
- a later stable V2 semantic version meets the numeric floor if the required
  CLI capability probe also passes;
- malformed output and every unsupported prerelease channel, including
  `next`, `dev`, and `tui-v2`, is rejected before comparison even if its
  numeric suffix is larger;
- only the supported `beta-<ordinal>` grammar and a later stable V2 semantic
  version participate in the minimum-version comparison.

For a plain stable semantic version, do not invent a numeric V1/V2 major
boundary. It is eligible for ordering only when it came from the resolved
`opencode2` executable and that exact path/version passes the complete
capability probe; the V1 `opencode` executable is never a candidate.

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

Run both probes under the same isolated HOME/XDG policy used for the managed
child, snapshot matching `opencode2 ... serve --service` PIDs before the probe,
and assert after a bounded grace period that the probe created no new service.
The regression test must cover the two probe commands themselves, not only a
later standalone inference smoke.

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
loopback proxy. It must never fall back to a raw credential silently. Its
credential guarantee is precise: the raw provider secret is absent from the
child. It does not claim that the authorized engine cannot spend the scoped
token; request, model, route, rate, deadline, and revocation caps bound that
use.

For this recovery, the protected executable-surface policy is the existing
strict policy: use the engine's pure mode where available, reject project/global
MCP, plugin, custom-tool, and user-agent executable surfaces for OpenCode 2,
and retain the deny-everything shell gate. Relaxing those restrictions while
keeping a run-scoped token is separate work, not an implementation choice left
undefined inside this plan.

`best_effort_raw` is selected only when
`TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=1`. Only the literal value `1`
selects this mode; absent, empty, `0`, `false`, `true`, and arbitrary non-empty
values do not. In this mode:

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
model and endpoint pinning. Triss still refuses repository-defined provider
URL, package, header, and credential-binding overrides. This does not prevent
repository code, plugins, tools, or shell commands from reading or exfiltrating
the raw credential by other means; that is the explicitly accepted risk of
this mode.

The existing `--allow-best-effort-caller-worktree` remains a separate choice.
It controls filesystem worktree downgrade; it must not implicitly enable raw
credentials, and the environment flag must not implicitly disable requested
worktree isolation.

## Unified provider transport model

Create a pure provider-transport resolver shared by OpenCode 1 and OpenCode 2.
Its input is the requested provider kind, fully qualified main model, optional
fully qualified small model, trusted provider settings, and credential mode.
Its output is data, not an engine env:

```text
provider kind
requested model
optional requested small model
engine model/provider alias
engine main/small alias mapping
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
| `kimi-for-coding` | `kimi-for-coding/*` | `KIMI_API_KEY` | `https://api.kimi.com/coding/v1`; Anthropic `messages` with `x-api-key` |

The resolver must distinguish OpenCode Zen `/zen/v1` from OpenCode Go
`/zen/go/v1`. It must also honor a trusted model-level package override when
that model selects `@ai-sdk/openai` instead of the provider default. It must
not infer protocol solely from a provider prefix when trusted model metadata
says otherwise.

Make one exported Triss provider registry the source of truth for provider
kinds, accepted prefixes, credential env names, canonical origins/prefixes,
default protocols/packages, and audited model-level protocol overrides.
`coderModelCredential`, provider-flag normalization, model/provider matching,
CLI/MCP enums, status, and the transport resolver must consume that registry;
do not copy the matrix into independent switch statements.

For Zen/Go, authenticated catalogue results confirm model availability but do
not become a mandatory runtime transport dependency. The protected resolver
uses the versioned audited transport registry; release qualification refreshes
known model-level package overrides against the current engine/catalogue
metadata. A catalogue outage therefore does not break an already configured
known transport. If a newly discovered model has no audited protocol/package,
protected mode fails before spawn with a recovery message, while explicit
best-effort mode may use the built-in provider with the raw key after rejecting
persistent repository transport overrides.

## Transient provider overlay

Build one engine-neutral `OPENCODE_CONFIG_CONTENT` overlay from the resolved
transport. Do not mutate global or project `opencode.json` for a run.

For protected proxy mode, use a Triss-owned transient provider alias rather
than relying on undocumented built-in environment overrides. The alias must:

- select the AI SDK package required by the protocol;
- point `options.baseURL` at the proxy's scoped loopback URL;
- bind the one-run proxy token;
- use a reserved per-run alias, reject any effective config layer that defines
  the same alias, and audit the final overlay as the highest-precedence layer;
- expose the selected main model and, for OpenCode 1, the selected small model
  when it differs; OpenCode 2 receives only the main alias after validating the
  optional small model as unused;
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
other models, malformed bodies, and mismatched auth. Its existing generic
`body.model` pin already applies to Chat Completions, Responses, and Anthropic
Messages; preserve it and add an explicit wrong-model fixture for each of the
three protocol profiles. Preserve query strings only on the exact allowed
path.

Preserve the existing streaming relay rather than buffering provider
responses: carry status and content type, stream chunks with backpressure,
enforce the cumulative response-byte cap, and abort upstream on overflow or
revocation. Add chunked/SSE regression fixtures for all three profiles,
including a stream longer than one chunk and a mid-stream cap overflow. The
proxy lifetime deadline governs admission/revocation; it must not silently
turn a valid long response into a buffered body.

OpenCode-specific account/config endpoints are not inference routes and must
not be opened in the credential proxy. The transient provider alias must avoid
triggering built-in account discovery with the proxy token. A real-engine
loopback test must record every requested path and fail if the engine attempts
an account, catalogue, config, or other non-inference request before or during
the synthetic completion.

## OpenCode 2 preflight changes

Split the current all-or-nothing audit into invariant checks and mode checks.

Invariant checks run in both modes:

- canonical runtime directory and Git/project boundary;
- reuse `enumerateOpenCodeSources()` and `parseOpenCodeDocument()` as the
  canonical config backend: global `~/.config/opencode/opencode.json(c)`, then
  boundary-to-cwd direct layers, then boundary-to-cwd `.opencode` layers;
  parse every existing document or reject, append the generated transient
  overlay as the audited final layer, and recheck existing file hashes before
  spawn to close the audit-to-spawn window;
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
- executable config surfaces satisfy the explicit strict protected policy
  defined under Isolation modes; the implementation may not choose a weaker
  policy ad hoc.

Best-effort mode does not reject solely because the effective shell policy has
allow/ask rules or because agents/plugins/tools are discovered. It records
those surfaces in diagnostics and continues with the explicit downgrade
warning.

Do not rewrite the user's shared V1 config from an allowlist to deny-everything
merely because `coder init --engine opencode2` ran. Init should validate and
report the selected mode, configure the chosen provider/model, and leave
unrelated user policy byte-identical.

The current writer already does not overwrite an existing shared
`opencode.json`; it only created deny-everything policy in a fresh V2 file.
Update that fresh-file behavior according to the selected mode and correct the
documentation, but do not invent a restoration migration for an existing file
that Triss did not overwrite.

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
does not contact provider APIs, and does not start an OpenCode 2 service. It
may execute the isolated `--version`/`run --help` capability probes after the
no-new-service regression is in place. Render the effective minimum, including
a valid `TRISS_CODER_OPENCODE2_VERSION` override, rather than always printing
the default floor.

Update help and docs so `@beta`, minimum-version semantics, best-effort risk,
and provider coverage are consistent across CLI, MCP, README, configuration,
engine guide, status, and generated agent guidance.

## Implementation sequence

These phases are implementation checkpoints, not independently releasable
features. Do not publish installation guidance or a build containing only the
version-floor change. Phases 1 through 6 ship atomically after the complete
release acceptance matrix passes; intermediate commits must retain the old
user-facing contract or remain unreleased.

### Phase 0 — lock the live compatibility matrix

Before production edits, add executable diagnostic fixtures for the current
beta:

1. version parser and `>=` examples;
2. `run --help` capability output;
3. standalone transient-provider calls to local echo servers for Chat
   Completions, Responses, and Anthropic Messages;
4. NDJSON success, tool use, provider error, timeout, and missing-usage shapes;
5. OpenCode 1.18.7 overlay routing and precedence over a conflicting project
   provider definition;
6. before/after PID proof that neither capability probe nor any standalone
   smoke leaves a new `opencode2 serve --service` descendant.

Keep these smokes isolated under temporary HOME/XDG roots and use dummy keys.

### Phase 1 — version floor and capability probe

Change `src/coder-engines/opencode2.js`, status, init, run errors, tests, and
docs to use the beta install channel plus minimum-version comparison. Preserve
canonical-path validation, executable-file validation, auto-update disable,
and same-binary post-run verification.

### Phase 2 — provider transport resolver

Extract provider/model/credential routing out of `src/commands/coder.js` into
the single exported provider registry and a pure resolver. Add complete
table-driven tests for every prefix, endpoint, protocol, package, credential,
main/small combination, invalid model, and hostile override. Reuse the same
registry from CLI/MCP/model/status surfaces and both OpenCode engines before
changing proxy behavior.

### Phase 3 — protocol-aware proxy and overlay builder

Extend `src/coder-credential-proxy.js` with explicit protocol profiles and
add the transient provider overlay builder while preserving the existing
streaming relay/backpressure behavior. Test the real installed engines against
loopback echo servers, including forbidden account routes and multi-chunk
streams; a fake spawn assertion is not sufficient.

### Phase 4 — credential-mode orchestration

Resolve `protected_proxy` versus `best_effort_raw` once in
`runCoderRun()`. Remove duplicated engine-specific credential decisions.
Make proxy startup conditional on protected mode and pass the resolved
transport/overlay to the selected adapter. Ensure every early failure revokes
the proxy and removes only freshly created isolation worktrees.

### Phase 5 — OpenCode 2 policy and one-shot support

Make OpenCode 2 preflight mode-aware, stop rejecting normal tools/agents in
explicit best-effort mode, make fresh-file init follow the selected mode, and
accept one-shot provider selection. Existing configs remain byte-identical;
protected fresh init keeps the strict protected policy. Keep invariant
endpoint/model/config/binary checks in both modes.

### Phase 6 — envelope, status, docs, and migration

Emit the complete envelope v2 fields for OpenCode 2, update status/help/docs,
replace the obsolete exact-pin guidance, and explain that a stale legacy
override must be removed or updated. Correct the fresh-file deny-everything
documentation without claiming that existing files were overwritten. Do not
silently edit existing user config during upgrade, and do not add legacy-pin
conversion or rollback machinery.

## TDD matrix

Add RED tests before each production change.

### Version tests

- below/equal/above current beta floor;
- multi-digit build ordinals;
- malformed, `next`, `dev`, and `tui-v2` installed versions and minimum
  overrides all reject as unsupported rather than entering ordering;
- future stable V2 plus capability pass/fail;
- install hint uses `@beta`, never npm `@latest`;
- capability probes run under isolated HOME/XDG roots and create no service;
- pre/post binary path or version change aborts.

### Mode tests

- absent flag never silently selects raw credentials;
- empty, `0`, `false`, `true`, and arbitrary non-empty flag values do not
  select best-effort; only literal `1` does;
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
- distinct same-provider main/small models on OpenCode 1 and validated-unused
  small model reporting on OpenCode 2;
- missing/wrong credential and provider/model mismatch;
- catalogue-unavailable behavior for a known audited transport, plus unknown
  transport rejection in protected mode and explicit best-effort fallback.

Each protected-mode case must prove with a real local engine smoke that:

1. the loopback server received the request;
2. the path and auth style match the selected protocol;
3. the child did not receive the real provider credential;
4. the proxy forwarded only the pinned model and exact inference route;
5. no request reached the real upstream and no account/catalogue/config route
   was attempted;
6. each protocol relayed a multi-chunk streaming response with backpressure
   and enforced its cumulative byte cap.

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
5. a recorded 24-row live matrix (`opencode` and `opencode2` crossed with all
   six provider kinds and both `protected_proxy` and `best_effort_raw`), with
   one minimal completion per row using the currently configured model. The
   protected rows must reach the real upstream through the overlay/proxy, and
   the best-effort rows must use the selected raw credential path. Every row
   must be `PASS`; a missing credential, entitlement, or catalogue access is
   `BLOCKED`, not a silent skip or pass;
6. a best-effort OpenCode 2 tool-using run from a deterministic temporary
   project fixture containing the current V1 template's exact shell rules
   (`git status/diff/log`, `ls`, `node --test`, `npm test`, `npm run test`), one
   discovered agent, and one custom tool; assert the tool ran and the downgrade
   warning/envelope fields are exact;
7. before/after process snapshots under an isolated HOME/XDG root: record all
   OpenCode/OpenCode 2 and descendant PIDs, wait a bounded five-second grace
   period after exit, and fail if any PID created by the probe/run remains;
8. sentinel-secret tests that scan captured stdout, stderr, envelope, thrown
   errors, logs, and retained temporary state, plus a final staged-diff review
   confirming neither sentinels nor unrelated files are present;
9. two review records tied to the exact release-candidate commit: one for the
   proxy/overlay security boundary and one for OpenCode 2 version/capability
   compatibility. Each record names the reviewer or model, commands/evidence,
   verdict, and resolved finding list; no blocking finding may remain.

Provider credentials, publication, PR creation, merge, npm release, and tag
creation remain separate authorization gates.

## Files expected to change during implementation

At minimum:

- `src/coder-engines/opencode2.js`;
- `src/commands/coder.js`;
- `src/coder-providers.js`, expanded into the canonical provider registry;
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

# One-shot coder provider selection

> **Historical pre-0.42 design record.** Legacy provider names, environment
> variables, model selectors, and commands below are migration history, not
> valid runtime guidance. Engine restrictions below are superseded: every
> engine now accepts every canonical provider, including Crush.
> See [`configuration.md`](configuration.md).

Status: implementation contract for v0.30.0.

## Problem

`triss coder run --model` currently overrides only OpenCode's main model. The
persisted `small_model` remains active, so changing from GLM to the Triss worker
(or back) for one run can create a cross-provider pair and is rejected. Users
must persistently switch both roles even when they only want another provider
for one task.

## User contract

The OpenCode engine accepts an explicit one-shot provider pair:

```bash
triss coder run "mechanical task" \
  --provider worker \
  --model triss-worker/deepseek-v4-flash

triss coder run "hard task" \
  --provider zai \
  --model zai-coding-plan/glm-5.2 \
  --small-model zai-coding-plan/glm-5-turbo
```

- `--provider` is one-run only and never rewrites the project `.triss.env`,
  the global Triss `.env`, or any `opencode.json`.
- `--provider` requires a provider-qualified `--model`. This keeps Z.AI
  coding-plan versus pay-as-you-go selection explicit and avoids guessing a
  model from whichever credentials happen to be present.
- `--small-model` is valid only with `--provider`. When omitted, the one-shot
  small model equals the explicit main model.
- Main and small must resolve to the selected provider and must use the same
  raw provider prefix. A regional/plan mix is rejected before credentials are
  forwarded.
- The feature is OpenCode-only. Crush remains Z.AI-only and rejects
  `--provider`/`--small-model` before spawning.
- Existing `--model` without `--provider` keeps its v0.29 main-only semantics.

The MCP `triss_coder_run` tool exposes the same operation through `provider`,
`model`, and `small_model` fields.

## Runtime design and security invariants

For an explicit provider run, Triss supplies an in-memory
`OPENCODE_CONFIG_CONTENT` overlay containing only the selected `model` and
`small_model`. No temporary or persistent config file is published. The
overlay is not assumed to have final precedence: the installed OpenCode build can
merge account/organization, managed-directory, and macOS MDM configuration
after it.

The overlay must not define or replace providers. OpenCode deep-merges provider
objects, which could retain untrusted lower-precedence options such as custom
headers. Credential authorization rests on two separate gates:

1. **Configuration gate.** `TRISS_CODER_OPENCODE_VERSION` is an installation
   preference only — it selects which release `triss coder init` installs and
   never authorizes a credential by itself. It must parse as a canonical stable
   x.y.z value and may never sit below the immutable supported floor;
   malformed or below-floor values fail closed with the typed
   `TRISS_CODER_OPENCODE_MINIMUM_INVALID` error instead of weakening policy.
2. **Authorization gate.** A credential-bearing one-shot run is authorized
   when the installed binary satisfies the effective minimum: the immutable
   supported floor (`1.18.22`) or any valid higher configured
   `TRISS_CODER_OPENCODE_VERSION`. A valid higher configured minimum raises
   the effective runtime/install minimum; it can never lower the floor. Under
   the default minimum, compatible newer releases — including `1.19.0` and
   `2.0.0` — are authorized; an installed version below the effective minimum,
   a missing install, or an unparsable version string fails closed before
   isolation and spawn.

Once the installed build is admitted by these gates, Triss audits its global `config.json`
and `opencode.json(c)`, the legacy
`~/.opencode/opencode.json(c)` source, and direct config ancestors from the
actual runtime directory to its Git root (or filesystem root outside Git).
Built-in providers reject any persistent block for the selected provider id;
managed worker blocks must match the complete expected definition in every
layer. JSONC is rejected because Triss cannot prove that commented config
contains no hidden endpoint/header override.

After this file audit, Triss runs `opencode debug config --pure` under the exact
sanitized child environment. The real selected credential is absent; a random
canary is supplied instead so the managed worker's env binding can still be
verified. The final merged main model, small model, and selected-provider block
must match. The actual one-shot `opencode run` also receives `--pure`, disabling
external plugins in both phases. Any probe failure or unknown final shape is
fail-closed. This remains a pre-spawn check; concurrent same-user mutation
between preflight and spawn is outside the guard's threat model. OpenCode
versions not admitted by the two gates above fail closed so changed discovery
rules cannot silently bypass the audit. The runtime directory is explicit `--cwd`, inherited `process.cwd()`,
or the created/reused isolation worktree. The Triss worker
therefore retains its existing setup prerequisite:
`triss coder init --engine opencode --provider worker --global|--local`
registers the env-backed provider once. Every worker run then verifies the
effective provider package, endpoint, credential binding, and complete model
allowlist before forwarding `TRISS_WORKER_API_KEY`. In one-shot mode the audit
checks the selected transient pair rather than requiring the persisted
main/small pair to be worker models.

Only the credential required by the explicit main model is forwarded. The
selected provider must equal the provider implied by both model prefixes, so a
flag cannot relabel a model to obtain a different credential.

The user-facing variable contract (`TRISS_CODER_OPENCODE_VERSION`) lives in
`docs/configuration.md` and `.env.example`; this plan records only the
security-relevant gate separation above, not a second copy of the policy text.

## Failure contract

All usage failures happen before isolation. Provider-config auditing happens
after an isolation worktree is resolved but before engine spawn or credential
forwarding; a newly created clean worktree is removed if that audit fails, while
a reused worktree is preserved for inspection. Failure cases are:

- missing `--model` with `--provider`;
- `--small-model` without `--provider`;
- unknown provider or model/provider mismatch;
- empty or whitespace-containing provider/model id;
- different main/small raw prefixes;
- non-Z.AI provider flags on Crush;
- missing selected-provider credential;
- missing, stale, or conflicting managed worker provider;
- selected-provider overrides or unauditable JSONC in effective config layers;
- an invalid configured installation minimum: `TRISS_CODER_OPENCODE_VERSION`
  malformed or below the immutable supported floor (`1.18.22`) — typed
  `TRISS_CODER_OPENCODE_MINIMUM_INVALID`, never lowering the floor;
- a missing OpenCode install, or an installed version that cannot be parsed;
- an installed version below the effective minimum: the immutable supported
  floor (`1.18.22`) by default — e.g. `1.18.21` — or a valid higher configured
  minimum. Compatible newer releases (`1.19.0`, `2.0.0`) are authorized under
  the default minimum.

Errors name the invalid flags and include the exact worker init recovery
command when applicable. A malformed minimum fails closed without suggesting
installation of an invalid version. No failure writes model pins or OpenCode
config.

## TDD and acceptance

RED tests must establish:

1. Commander help exposes `--provider` and `--small-model` with one-shot and
   non-persistent wording.
2. GLM-persisted config can run a worker one-shot pair, and worker-persisted
   config can run a GLM one-shot pair.
3. Spawn receives a matching in-memory main/small overlay and only the selected
   provider credential.
4. The persistent env/config bytes are unchanged after success and failure.
5. Every failure case above occurs before spawn.
6. Legacy main-only `--model` behavior remains unchanged.
7. MCP forwards `provider` and `small_model` without changing isolation
   defaults.

Acceptance requires focused tests, the full Node test/lint suite, package
smoke, a live synthetic worker run from a GLM-persisted temporary project, and
sequential GLM 5.2 plus independent agent reviews.

## Current credential-proxy limitation (2026-08)

The parent-owned credential proxy pins the upstream ORIGIN plus a path prefix
per provider. For opencode built-in providers without a documented base-URL
override (`moonshot`, `kimi-for-coding`), the engine cannot be verifiably
pointed at the proxy, so `triss coder run` fails closed BEFORE spawn instead
of handing the real upstream a one-run proxy token it would reject. `zai`
(ZAI_BASE_URL/ZHIPU_BASEURL), `opencode-zen/go` (OPENCODE_BASE_URL), the
managed `triss-worker` overlay, and every crush run keep working. Direct
non-coder calls (`triss ask/review/chat --provider kimi|moonshot`) are
unaffected — they never spawn an engine. Lifting the limitation requires an
audited provider overlay (the same mechanism the worker block uses) for these
providers.

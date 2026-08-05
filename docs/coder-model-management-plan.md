# Coder model management and recovery UX

Implementation plan for making model selection, persistent model changes, and
recovery from retired or incompatible models understandable and safe for Triss
users.

## Status and motivating incident

This plan is based on the failure observed on 2026-08-03 during a global
`triss config wizard` run:

- the user had both `ZHIPU_API_KEY` and `OPENCODE_API_KEY` configured;
- global `opencode.json` still selected the retired promotional model
  `opencode/hy3-free` for both `model` and `small_model`;
- the authenticated OpenCode Zen models API no longer listed `hy3-free`;
- the wizard could not infer one provider from multiple credentials, silently
  fell back to Z.AI GLM, then audited the existing Zen config as if the user had
  asked to migrate it to GLM;
- the final error described several low-level repairs but did not state which
  provider the wizard had selected, why it selected it, which replacement
  models were currently available, or one exact safe recovery command.

The safety checks correctly prevented a known-bad mixed configuration and did
not overwrite a user-owned file. The missing piece is a first-class model
management and recovery workflow.

## Current system facts that the implementation must preserve

### Engines and providers are separate choices

| Engine | Supported providers | Persistent model store |
| --- | --- | --- |
| `opencode` | Z.AI GLM, OpenCode Zen, Moonshot Kimi, Kimi for Coding | `opencode.json` plus `TRISS_CODER_MODEL` / `TRISS_CODER_SMALL_MODEL` |
| `crush` | Z.AI GLM only | crush large/fast model roles in `crush.json` |

OpenCode Zen is not an engine and `hy3-free` was not a GLM model. It was one
temporary model offered by the OpenCode Zen provider. Removing it from the Zen
catalogue must not affect GLM through either engine.

### A one-run override is not a persistent repair

`triss coder run --model <provider/model>` changes only the main model passed to
one engine invocation. OpenCode still reads `small_model` from
`opencode.json`; Triss cannot override it at run time. Therefore a per-run
override must never be suggested as the complete repair for a stale,
cross-provider, or cross-plan `small_model`.

### Configuration precedence is role- and engine-specific

Do not flatten all model sources into one precedence list. The implementation
must inspect and report this matrix:

| Engine / role | Effective runtime order |
| --- | --- |
| OpenCode main through Triss | one-run CLI/MCP model override -> shell `TRISS_CODER_MODEL` -> project `.triss.env` -> global Triss env -> built-in default |
| OpenCode small/fast | project `opencode.json.small_model` -> global `opencode.json.small_model` -> OpenCode default |
| Direct OpenCode main (config-only) | project `opencode.json.model` -> global `opencode.json.model` -> OpenCode default |
| Crush one-run main | explicit `--model` -> configured Crush large/smart role |
| Crush persistent roles | project Crush large/fast roles -> global Crush roles -> Crush defaults |

**Critical distinction:** For the opencode engine, `current.main` in inspection output MUST represent the effective runtime main model (resolved exactly as `runCoderRun`: one-run override -> shell `TRISS_CODER_MODEL` -> project `.triss.env` -> global Triss env -> built-in default). This is distinct from the OpenCode config's `model` field (`opencode.json.model`), which represents the config-only main model used only when running OpenCode directly (not through Triss). The two can differ when shell/project env pins or one-run overrides shadow the config value. JSON and human output must name these unambiguously: use "runtime main" or "effective main" for the Triss-resolved value and "config main" or "OpenCode config main" for the `opencode.json.model` value.

`TRISS_CODER_SMALL_MODEL` is persisted intent used by init/model-management; it
is not a runtime override because Triss cannot pass a small-model flag to
OpenCode. Crush ignores both Triss model pins for its persistent roles.

**Role-specific precedence for OpenCode config small/fast:** Each role has its own source_path and scope. The local config's `small_model` value (if present) is the effective small model; if the local config lacks `small_model`, the global config's `small_model` wins. Do not choose one whole file for both roles — a local opencode.json may have only `model` defined while the global defines only `small_model`, in which case the effective state is config main from local, config small from global, with distinct source_paths for each role.

Model management still synchronizes OpenCode's `model`, `small_model`, and the
two Triss intent pins so later init runs remain idempotent, but final runtime
verification must use the matrix above. A shell or project override that would
make the requested persistent result ineffective causes a pre-write failure.
There is no `--allow-shadowed` escape hatch: print exact alternatives for
changing the winning scope or unsetting the specific override. For shell
exports, print exact `unset` commands. For a project env override shadowing a
global request, offer `model set ... --local` or
`triss config unset TRISS_CODER_MODEL --local` (and the small intent pin when
present). For a project `opencode.json`, offer only the scoped model-set command;
never suggest deleting the file.

### Existing config is user-owned

Never delete or replace `opencode.json` as the primary repair. A successful
model change may update only Triss-managed model fields after explicit user
confirmation, while preserving unknown keys and the deny-first permission
policy. Invalid JSON, missing safety policy, or a write failure must leave the
original file untouched.

## Product contract

### 1. Keep the existing per-run override

The existing command remains the lightweight, non-persistent option:

```bash
triss coder run --engine opencode \
  --model opencode/deepseek-v4-flash-free \
  "implement the task"
```

Help text must explicitly say that this changes the main model for one run and
does not rewrite `small_model` or repair persistent configuration.

### 2. Add first-class model discovery

Add:

```bash
triss coder models [--engine <opencode|crush>] \
  [--provider <name>] [--json]
```

Human output must show:

- selected scope and effective higher-precedence scope;
- current main and small/fast models;
- engine and provider compatibility;
- credential readiness without printing secrets;
- live availability for providers with a catalogue API;
- free/promotional status when the API supplies it;
- which available model Triss recommends for main and small roles;
- an explicit `unavailable`, `available`, or `not verified` state. Network
  failure must never be presented as proof that a model was removed.

State definitions are normative:

- `available`: an authenticated, parseable catalogue response contains the
  model ID;
- `unavailable`: an authenticated, parseable catalogue response returns a
  complete model list that does not contain the model ID;
- `not verified`: the request times out, authentication fails, returns another
  non-2xx response, or returns a payload without a parseable model list.

`--allow-unverified` may apply only to a provider-defined transient/not-verified
state; it must never override authentication, authorization, invalid data, an
authoritative empty catalogue, or an authoritative `unavailable` result. For
OpenCode Go, the bypassable set is transport plus HTTP
408/429/500/502/503/504 only.
`not-supported` is not a failed verification: it means the provider exposes no
catalogue API. Once credential and local provider/plan-prefix checks pass, a
switch for that provider proceeds without `--allow-unverified`.

`--json` must expose a stable machine-readable object with `engine`,
`provider`, `scope`, `current`, `credential`, `available_models`, `recommended`,
`catalogue_status`, and `warnings` fields. `current.main` and `current.small`
are separate `{value, scope, source_path, availability, compatibility}` objects
because their winning sources can differ. For OpenCode, `current.main` represents the effective **runtime main** (not the config-only `opencode.json.model`). When runtime main differs from config main, the output must include a `config_main` field with `{value, scope, source_path}` to show both values distinctly. For Crush, `current.main` and `current.small` report the actual configured roles from `~/.local/share/crush/crush.json` or `.crush/crush.json` with distinct source/scope, never a synthetic null.

`recommended` is `{main, small}` or `null`; `credential` is `{env, ready}` and never contains a value; `warnings`
is an array of `{code, severity, message, scope}`, where `severity` is `info`,
`warn`, or `error`; and `catalogue_status` is one of `ok`, `not-supported`,
`unauthenticated`, `timeout`, `http-error`, or `parse-error`. All model/path
values are strings or `null`. Crush and providers without a catalogue API use
`not-supported`, never a fabricated network error. Do not make ordinary
`triss status` perform a network request; it may point users to
`triss coder models` for live verification.

If an effective OpenCode or Crush JSON layer exists but is malformed,
inspection MUST NOT silently fall through to a lower-precedence file. The
affected role keeps the malformed file's exact `source_path`/scope with an
unset value, and `warnings` contains a structured `config-parse-error`
(`severity: error`) naming that path. Human output must show the same path and
message.

For OpenCode Zen, reuse the authenticated
`GET https://opencode.ai/zen/v1/models` path already used during init. The live
API is authoritative for availability; hardcoded free-model priorities are
only an offline fallback and must be labelled as unverified.

For Crush, the engine adapter owns translation between public Triss model IDs
and engine-native large/fast atoms. Reject Zen, Moonshot, and other unsupported
providers before invoking Crush.

### 3. Add one safe persistent switching command

Add:

```bash
triss coder model set [<main-model>] \
  [--small <small-model>] \
  [--engine <opencode|crush>] \
  [--provider <name>] \
  [--global|--local] \
  [--allow-unverified] \
  [--allow-unsafe-bash] \
  [--yes]
```

Examples:

```bash
# Interactive: fetch the live Zen catalogue and choose both roles.
triss coder model set --engine opencode --provider opencode-zen --global

# Non-interactive persistent Zen switch.
triss coder model set opencode/deepseek-v4-flash-free \
  --small opencode/deepseek-v4-flash-free \
  --engine opencode --global --yes

# Persistent GLM roles through Crush; the adapter translates to Crush atoms.
triss coder model set zai-coding-plan/glm-5.2 \
  --small zai-coding-plan/glm-5-turbo --engine crush --global
```

Engine and scope are never guessed for a non-interactive persistent mutation.
Passing both scope flags exits non-zero without writing. If scope or engine is
missing, a TTY prompts with the effective value highlighted; a non-interactive
invocation exits non-zero and prints explicit commands for each valid choice.
Every generated recovery command includes both `--engine` and one scope flag,
even if an environment default currently points to the same engine. This is
intentionally stricter than read-only commands and older setup flows that
default to OpenCode/global.

**Help text for `coder model set`** must describe both engines and their exact configuration targets:
- OpenCode: `opencode.json` at project `.crush/crush.json` or global `~/.local/share/crush/crush.json`
- Show that OpenCode has two separate main model sources (runtime main from env pins vs config main from `opencode.json.model`)
- List the exact file paths for each scope

The command must:

1. Resolve engine, scope, and provider without silently defaulting across an
   ambiguity. An explicit model prefix is provider intent but does not select
   an engine because Z.AI GLM works through both engines.
2. Load both main and small model state from every relevant precedence layer.
3. Fetch and validate against the live provider catalogue where available.
4. Require both roles to use compatible credentials and, for Z.AI, the same
   verified plan prefix. If `--small` is omitted, keep the existing value only
   when it is compatible and currently available; otherwise propose the
   provider's current recommended small model.
5. Verify the required credential exists and, when supported, that it serves
   the chosen endpoint. Never print the credential.
6. Print a before/after summary including exact scope and files.
7. In a TTY, ask for confirmation before changing an existing config. `--yes`
   is required for non-interactive mutation; without it, print the proposed
   change and exit non-zero without writing.
8. Create a collision-resistant transaction record before the first mutation.
   Back up existing engine config bytes/mode, but snapshot only the two model
   pin lines from Triss env files; never duplicate unrelated API keys.
9. Preserve every unknown JSON field and the complete permission policy. Only
   update the engine's model fields/roles.
10. Stage the engine config and persisted Triss env pin files (`.triss.env` or
    the global env file), validate their parsed result, then commit them as one
    logical transaction. Env loading is last-assignment-wins, so rendering,
    snapshots, post-commit audit, and rollback MUST use that same parser.
    Updating either model pin removes every duplicate occurrence and writes
    exactly one canonical assignment; unsetting removes every occurrence.
    Shell-exported model variables are read-only signals.
    A different `TRISS_CODER_MODEL` is a runtime shadow and blocks before
    writing. A different `TRISS_CODER_SMALL_MODEL` does not shadow a fresh run,
    but is a separate `management-intent-conflict` because the next init could
    restore that value; it also blocks persistent mutation by default. Report
    the distinct reason and exact `unset` command for each. If any write or
    final audit fails, restore all touched files from backups and report their
    paths.
    The shared apply service performs the same global-to-local shadow preflight
    before creating a transaction record or staging either target. Existing
    project env/config overrides fail without mutation; the post-commit audit
    remains required to catch a project override created during the
    transaction.
11. Re-run the same compatibility and precedence audit used by init. A green
    result must mean that a fresh `triss coder run` resolves the selected model.
12. Print the effective model pair, provider, engine, and a rollback command.

`--allow-unverified` is valid only when both main and small models are explicit,
the required credential is present, and catalogue status is `timeout`,
`http-error`, or `parse-error`. It never bypasses `unauthenticated` or an
authoritative `unavailable` result. Non-interactive use requires `--yes` too.

For the public service API, omitted `small` means "preserve the currently
configured small role and persisted small pin". It must not serialize
`undefined`, delete `small_model`, or remove the small env pin. An explicit
CLI repair may still resolve and submit both roles.

`--allow-unsafe-bash` has the same narrow meaning as on `coder init`: it permits
model-field repair while preserving an existing OpenCode config that lacks the
canonical deny-first policy. It never installs or rewrites a policy. TTY output
requires a second explicit confirmation; non-interactive use requires both
`--allow-unsafe-bash` and `--yes`, and success retains a prominent safety
warning. Without the flag, print the exact model-set command with the flag and
the safer alternative of reviewing/adding a deny-first policy first.

Step 10 is engine-specific: OpenCode changes both `opencode.json` and the two
Triss env pins; Crush changes only its large/fast roles and must not rewrite the
OpenCode-scoped `TRISS_CODER_MODEL` variables. Back up the effective Crush
config before invoking `crush models use`; if the subprocess fails after a
partial write, restore that backup and report the failed command.

Store transaction records outside the project under
`~/.config/triss/backups/coder-model/<timestamp>-<random>/` with directory mode
`0700` and file mode `0600`. The manifest records each target's absolute path,
whether it existed, original mode, and content hash, but no credential values.
The env rollback snapshot records only presence/value of
`TRISS_CODER_MODEL` and `TRISS_CODER_SMALL_MODEL`, which are not secrets. It
must never copy a whole `.triss.env` or global env file into a backup.

### OpenCode transaction safety guarantees

OpenCode apply and rollback MUST enforce these exact CAS verification and hash
guard contracts. Any violation is a rollback-failed (exit 3) condition that
preserves foreign/user bytes without mutation.

#### Apply guarantees

1. **Snapshot and CAS verification on commit**: apply snapshots both config and
   env at transaction start. Immediately before each commit rename, it CAS-
   verifies that the current bytes/existence on disk still equal the snapshot.
   Any non-cooperating external change (concurrent writer, user edit, or race)
   fails closed without overwriting the foreign bytes.

2. **outputHash recording for BOTH targets**: A successful apply MUST record
   `outputHash` for BOTH config and env in the manifest targets, whether the
   target existed (`existed:true`) or was created (`existed:false`). The hash
   covers the complete file bytes written by the transaction.

3. **Final post-commit audit**: After BOTH config and env commits succeed, the
   apply re-reads both outputs, verifies their hashes equal the recorded
   `outputHash` values, and verifies the actual runtime precedence equals the
   intended main/small models before reporting success. Any mismatch fails
   closed with rollback.

#### Compensation guarantees

Compensation (rollback on failure) MUST follow these hash-based guards:

1. **Hash-based restore guard**: Compensation restores a target from its
   backup ONLY when the target's current content hash equals this transaction's
   recorded `outputHash`. A mismatch means the file was modified after the
   transaction wrote it (foreign/user bytes), so compensation MUST fail closed
   without overwriting.

2. **Hash-based removal guard**: Compensation removes a file created by the
   transaction (`existed:false`) ONLY when the file's current content hash
   equals the transaction's recorded `outputHash`. A mismatch or absent file
   means it was modified or removed by the user/concurrent writer, so
   compensation MUST fail closed without removing foreign bytes.

#### Rollback guarantees

1. **Hash-verified overwrite**: When `target.existed === true`, rollback MUST
   verify the current file hash equals `target.outputHash` before overwrite.
   If the hash differs, rollback MUST fail closed and mutate nothing — the user
   changed the file after the transaction.

2. **Hash-verified removal**: When `target.existed === false`, rollback MUST
   verify the current file hash equals `target.outputHash` before removal. If
   the hash differs or the file is absent, rollback MUST fail closed and mutate
   nothing — the file was mutated or removed by the user/concurrent writer.

3. **Both targets required**: Rollback MUST verify BOTH config and env targets
   before ANY mutation. A single hash mismatch across BOTH targets fails the
   entire rollback closed — no partial rollback is permitted.

4. **Exit code 3 on guard failure**: Any hash guard failure (compensation or
   rollback) MUST surface as a structured `rollback-failed` result with exitCode
   3, retain the protected transaction record, and print absolute manual restore
   paths. The foreign bytes remain untouched.

Every target file is first rendered and validated in a sibling temporary file;
env rendering must preserve every unrelated line. Create an env sibling temp
with exclusive-open semantics and mode `0600`, verify its mode before rename,
and best-effort remove it on every validation, success, error, and handled-signal
path. Tests must prove that failures leave no orphan temp containing env bytes.
Commit uses per-file atomic rename. On failure, restore existing engine config
bytes/mode, restore or unset only the two prior env pins, and remove a file
created by the transaction only when its post-write hash still matches the
transaction output. Then re-audit the restored state. A validation/write
failure exits 2; a rollback failure exits 3, retains the protected transaction
record, and prints absolute paths plus manual restore commands. After a fully
successful apply and audit, retain the engine-config backup and pin-only
rollback manifest for the printed rollback command; they contain no provider
credentials and are never placed in the project/Git worktree.

The rollback command printed by `model set` and wizard recovery is a first-class
verb, not a manual instruction:

```bash
triss coder model rollback --from <absolute-record-dir> --global|--local
```

`--from` is the absolute path of a transaction record directory produced by a
prior `model set` or accepted wizard repair; `--global|--local` matches the
original mutation's scope. The record's manifest `engine` field selects OpenCode
vs Crush restoration, so rollback never re-derives engine from live config.
Before any write, validate fail-closed that the record directory exists, the
manifest parses, every backup referenced by the manifest exists, and every
target path recorded in the manifest is absolute and in-scope for the chosen
scope. Restore the original engine config bytes and file mode from the protected
backup via a temporary sibling plus atomic rename. OpenCode additionally
restores or unsets only `TRISS_CODER_MODEL` and `TRISS_CODER_SMALL_MODEL` to the
recorded pin-only state; Crush restores only its large/fast roles. Rollback
never replays credentials, never copies a whole env file, and never touches
provider blocks, `$schema`, permission policy, agents, plugins, or unknown
fields. A missing record directory, malformed manifest, or missing backup
mutates nothing and exits nonzero. A successful rollback reports the restored
targets with absolute paths and does not delete the forensic record, so it
remains available for evidence or re-running.

Do not add a generic `--force` that bypasses provider/key compatibility.

## Wizard behaviour

Add an optional scripted selector to the generic wizard:

```bash
triss config wizard [coder] \
  --coder-engine <opencode|crush> \
  --coder-provider <name>
```

These are intentionally coder-specific so they cannot be confused with worker
or integration providers. Interactive users do not need the flags because the
wizard resolves or prompts before requesting any coder credential.

### Provider selection

Refactor `config wizard` and `coder init` to share engine- and provider-intent
resolvers. Resolve both before the coder manifest's credential loop. The wizard
must then request, require, and write only the credential for the selected
provider; choosing Zen, Moonshot, or Kimi must not prompt for or mark
`ZHIPU_API_KEY` as required.

Engine resolution order:

1. explicit `coder init --engine` or wizard `--coder-engine`;
2. effective shell/project/global `TRISS_CODER_ENGINE`, matching bare
   `coder run` runtime precedence;
3. engine implied by the effective config when only one engine config exists;
4. interactive engine prompt;
5. non-interactive failure with exact OpenCode and Crush commands.

Provider resolution order after engine is known:

1. explicit `coder init --provider`, wizard `--coder-provider`, or explicit
   model prefix;
2. effective `TRISS_CODER_MODEL` prefix;
3. provider prefix in the effective engine config;
4. exactly one configured provider credential;
5. interactive provider prompt;
6. non-interactive failure with an exact `--provider` command.

Having zero or multiple provider credentials is ambiguous. The wizard must not
silently choose Z.AI in either case. It must say which signals conflict, without
showing secret values.

Crush fixes provider intent to Z.AI coding plan and rejects any other explicit
provider before credential prompting. For OpenCode, Z.AI, Zen, Moonshot, and
Kimi remain selectable. An explicit provider/model conflict exits before
credentials are written.

For non-interactive wizard recovery, the exact alternative command should use
`triss config wizard coder --coder-engine ... --coder-provider ...` when the
user intends to stay in the wizard, or
`triss coder init --engine ... --provider ...` when only coder setup is needed.

### Stale-model recovery in a TTY

If a live catalogue positively reports that the configured model is absent,
the wizard must present a recovery screen before the generic post-setup error:

```text
OpenCode Zen model unavailable

  Current main:  opencode/hy3-free        unavailable
  Current small: opencode/hy3-free        unavailable
  Config:        ~/.config/opencode/opencode.json

This was a temporary OpenCode Zen model and it is no longer returned by the
authenticated models API. Your GLM configuration and ZHIPU_API_KEY are not
affected.

Available replacements:
  1. opencode/<current-recommended-main>   recommended main
  2. opencode/<current-recommended-small>  recommended small
  3. Choose other available Zen models
  4. Switch this OpenCode config to another provider
  5. Keep the file unchanged and show recovery commands
  6. Skip coder setup and continue the full wizard
```

The placeholders are rendered from the authenticated API response and current
priority policy. The exact catalogue contents are dynamic; never serialize a
concrete recommended ID into permanent recovery prose.

If the user chooses a replacement, call the same transactional model-set
service as `triss coder model set`; do not maintain a separate wizard-only
writer. Show the before/after pair and request confirmation. The operation must
preserve custom config fields and safety policy.

If the user chooses another provider, return to provider selection and explain
engine restrictions (for example, Crush supports Z.AI GLM only). Do not imply
that selecting a provider changes an unrelated engine's configuration.

If the user declines mutation:

- targeted `triss config wizard coder` exits non-zero with the exact next
  command;
- the full multi-integration wizard continues configuring unrelated targets,
  reports coder as unresolved in its final summary, and exits non-zero;
- the only way for the full wizard to exit zero with coder unresolved is to
  choose option 6 (`Skip coder setup and continue`) explicitly. That records a
  skipped result and prints a persistent warning that coder was not repaired.

### Crush-specific inspection and recovery

For the crush engine, `current.main` and `current.small` must report the actual configured roles from the effective Crush config file (`~/.local/share/crush/crush.json` for global, `.crush/crush.json` for local) with distinct `source_path` and `scope`. Never report a synthetic null when the config file exists and is parseable. When a local Crush config exists, its roles win over the global config's roles per-role (the local `models.large` wins even if the local lacks `models.small`, in which case `current.small` comes from global with global `source_path`). Missing local role falls back to global.

**Wizard incomplete recovery for Crush:** When the Crush setup flow cannot complete (crush not detected, `crush models use` failed, or `permissions.run` not seeded), the wizard's incomplete recovery command MUST always include the selected `--local` or `--global` scope flag that matches the wizard's original intent. Never omit the scope flag; the exact recovery must be reproducible.

### Non-interactive recovery

Never choose a provider or replacement model silently. Print:

- the stale model and its scope;
- how availability was established (`authenticated OpenCode Zen API`, etc.);
- the recommended compatible pair;
- one copy-paste
  `triss coder model set ... --engine <engine> --global|--local --yes` command;
- any higher-precedence override that would still win;
- a separate command for choosing another provider.

Exit non-zero and do not modify files.

### Other blocking config failures

Use the same structured diagnostic format for:

- invalid JSON;
- missing deny-first OpenCode bash policy;
- main/small provider mismatch;
- Z.AI coding-plan versus PAYG prefix mismatch;
- missing provider credential;
- local config shadowing a global change;
- shell-exported model shadowing file configuration;
- unavailable catalogue;
- unsupported engine/provider combination.

Every error must distinguish `unavailable` from `not verified`, identify the
exact winning scope, and end with either an interactive choice or one exact
copy-paste recovery command. Avoid generic conclusions such as "fix the issues
reported above" without a command.

### Shell-safety invariant for copy-paste commands

Every emitted copy-paste shell command is built from raw argv by one shared POSIX
formatter. Safe literal tokens may remain unquoted; every dynamic model/provider/path
argument with space, apostrophe, semicolon, dollar command substitution, backtick,
tab, or newline must parse back as exactly one original argv item. Never concatenate
quoted fragments or use unsafe double quotes for arbitrary paths.

The formatter must:
- Accept a raw argv array and return a POSIX-shell-safe command string
- Leave conservative safe tokens (alphanumerics, hyphens, underscores, slashes, dots) unquoted for readability
- POSIX-single-quote unsafe values, correctly escaping embedded apostrophes with `'\''` and preserving newline
- Never use double quotes for arbitrary user-controlled values (they allow `$()`, backticks, and variable expansion)
- Verify that `/bin/sh -c` parsing recovers exact argv with no extra command execution

This invariant is enforced by deterministic injection tests using `/bin/sh` with
a shadow function that captures NUL-delimited argv. Tests cover all dynamic command
branches including formatModelRecovery, planModelChange diagnostics, CLI render helpers,
cross-scope commands, malformed-config mv paths, and rollback commands.

## Internal design

### Shared model-management service

Extract the model/provider resolution and auditing logic currently concentrated
in `src/commands/coder.js` into a small internal service, for example
`src/coder-models.js`. Keep engine-specific writes in adapters.

The service should expose testable operations equivalent to:

- `resolveProviderIntent(...)`;
- `inspectCoderModelState(...)`;
- `listProviderModels(...)`;
- `planModelChange(...)` (pure, no writes);
- `applyModelChange(...)` (transactional write plus rollback);
- `formatModelRecovery(...)`.

Return structured diagnostics (`code`, `severity`, `scope`, `path`, `current`,
`proposed`, `commands`) instead of composing all decisions directly into
stderr strings. CLI, wizard, status hints, and future MCP exposure must render
the same facts consistently.

### OpenCode adapter

Refactor `readOpencodeModels`, catalogue resolution, provider mismatch checks,
and `auditExistingConfig` to consume the shared state. Add a narrow
read-modify-write operation that:

- refuses malformed JSON;
- retains `$schema`, `permission`, provider blocks, agents, plugins, and unknown
  fields;
- updates only `model` and `small_model`;
- preserves key order and detects/reuses indentation, LF/CRLF style, and final
  newline presence; tests compare the parsed unknown fields and these formatting
  properties rather than requiring an unspecified formatter;
- writes with the original file mode;
- uses a temporary sibling plus atomic rename;
- creates the non-overwriting config backup in the protected transaction
  directory before rename.

The existing no-clobber rule remains correct for unrelated setup changes. Model
mutation is allowed only through the explicit model-set/recovery transaction.

### Crush adapter

Extend `src/coder-engines/crush.js` so the shared command can inspect and change
large/fast roles through Crush's supported CLI rather than rewriting its model
schema independently. Keep the Z.AI-only capability check at the adapter
boundary. A failed Crush command is a failed model change and must not be
reported as a non-fatal warning.

The first implementation accepts only the canonical public pair currently
verified by the repository:

| Public Triss ID | Crush atom | Role |
| --- | --- | --- |
| `zai-coding-plan/glm-5.2` | `glm5_2` | large/smart |
| `zai-coding-plan/glm-5-turbo` | `glm5_turbo` | small/fast |

Crush is fixed to the Z.AI coding-plan endpoint in the current adapter. Reject
`zai/*` PAYG and every non-Z.AI prefix before spawning, with an exact OpenCode
alternative when appropriate. Do not invent a `zai-payg` prefix. Supporting
additional Crush atoms requires adding an explicit adapter mapping and tests;
never derive atom names heuristically from model IDs.

#### Crush apply locking and hash verification

Crush apply operations MUST follow the same interprocess locking and hash
verification contract as OpenCode applies (Corrective Blocker A):

- `applyCrushModelChange` MUST acquire the same real default filesystem lock
  keyed by `(crush, scope)` BEFORE the first pre-read/snapshot and hold it
  through spawn, verification, and any compensation/rollback. The lock is
  released on every exit (success, failure, rollback-failed).
- `deps.lock` is an OVERRIDE seam for deterministic unit tests ONLY. Absence of
  `deps.lock` MUST NEVER mean unlocked: when `deps.lock` is not supplied the
  operation MUST use the built-in filesystem lock via `acquireDefaultLock`.
- The lock seam is `deps.lock(engine, scope)` returning `{ release() }`. When
  `deps.lock` is injected, the apply MUST call it; tests assert acquire happens
  before the config read and release happens after verification completes.
- Fail CLOSED on an existing/stale lock: when the lock cannot be acquired because
  it is already held, the apply MUST abort with a structured `lock-held`
  diagnostic, write NOTHING, and exit non-zero.
- On success, `applyCrushModelChange` MUST record the resulting `outputHash`
  (SHA-256 of the post-write bytes) in the manifest target for BOTH the
  `existed:true` and `existed:false` cases — so a later rollback can
  verify-and-restore or verify-and-remove safely.

Both Crush rollback branches MUST verify the current target hash equals the
transaction's recorded `outputHash` before overwrite or removal, and fail closed
if the user changed it:

- When `target.existed === true` (restore from backup): rollback MUST verify the
  current file hash equals `target.outputHash` before overwrite. If the hash
  differs, throw an error and mutates nothing — the user changed the file after
  the transaction, so restoring would overwrite their work.
- When `target.existed === false` (remove created file): rollback MUST verify the
  current file hash equals `target.outputHash` before removal. If the hash differs
  or the file is absent, throw an error and mutates nothing — the file was
  mutated or removed by the user/concurrent writer.

### Wizard integration

Add a coder-specific preflight before `runFullWizard()` iterates manifest
credentials. It resolves engine/provider, materializes a dynamic credential
contract containing only the selected provider key, and passes immutable intent
through setup and recovery. `CODER_MANIFEST.postSetup` then consumes that intent
instead of attempting the first provider decision after all credentials were
already prompted. `inferCoderProvider()` must no longer use
`providerFromEnv() || 'zai'` on the wizard path.

Make coder readiness provider-aware too: a Zen-only setup with a valid
`OPENCODE_API_KEY` is ready without `ZHIPU_API_KEY`; equivalent rules apply to
Moonshot and Kimi. The wizard's post-setup result must be structured so the
full wizard can distinguish repaired, unresolved, and explicitly skipped coder
setup from failures in unrelated integrations.

## Implementation phases

The execution order is mandatory docs-first TDD:

```text
user-facing docs and contract
  -> focused failing tests (RED)
  -> smallest vertical implementation
  -> focused tests pass (GREEN)
  -> refactor with tests green
  -> full validation and diff review
```

Do not start production-code changes while Phase 1 documentation is
incomplete, and do not weaken the documented contract to make an implementation
test pass.

### Phase 1 — documentation and contract lock

Update before production code or new tests:

- `README.md`;
- `docs/configuration.md`;
- `docs/opencode-zen.md`;
- `docs/glm-clients.md`;
- this implementation plan if repository findings require a contract change.

Document the public commands, output states, confirmation and non-interactive
semantics, scope precedence, backup/rollback behavior, engines versus
providers, one-run versus persistent changes, and the motivating stale-model
recovery flow. Include the structured JSON output contract for `coder models`.

Replace wording that presents `hy3-free` as a current default with dynamic,
time-bounded examples. Examples may name a currently verified model only when
clearly labelled as an example; discovery instructions must use
`triss coder models`.

Acceptance criteria:

- the documentation describes every externally visible behavior before it is
  implemented;
- examples do not require manual deletion or replacement of `opencode.json`;
- `hy3-free` remains only in historical incident/migration examples;
- the documented recovery path ends in one exact command or an interactive
  choice, never "fix the issues above";
- review and agree the documentation diff before starting Phase 2.

### Phase 2 — focused RED tests

Files:

- add `test/coder-model-management.test.js`;
- extend `test/coder-init.test.js`;
- extend `test/coder-init-crossproc.test.js`;
- extend `test/coder-provider-detect.test.js`;
- extend `test/coder-crush.test.js`;
- extend `test/wizard-full.test.js`;
- extend `test/status-coder.test.js` and `test/completion.test.js` as needed.

Write failing tests for:

1. the exact 2026-08-03 incident: both keys, existing `hy3-free`, live Zen API
   omits it, and the wizard offers Zen replacements instead of selecting GLM;
2. an existing main model that is available but a stale `small_model`;
3. both models stale;
4. switching Zen to Z.AI and Z.AI to Zen with explicit confirmation;
5. same-provider model changes;
6. coding-plan/PAYG prefix mismatch;
7. every catalogue state, including `not-supported`, timeout, authentication
   failure, parse failure, and authoritative absence;
8. global change shadowed by project env and by project engine config, with
   exact winning-scope alternatives;
9. shell main and small-intent exports, proving that only main is a runtime
   override while both can affect future model-management/init intent;
10. custom `opencode.json` fields and permission policy remain deeply equal;
    key order, detected indentation, line endings, and final-newline presence
    remain unchanged outside the two model values;
11. malformed JSON produces no mutation;
12. transaction records for existing/absent env and engine files, backup ID
    collision, `0700`/`0600` modes, no credential duplication, clean project
    Git status, no orphan sibling temps, partial writes, rollback, and
    rollback-failure exit 3;
13. non-interactive invocation requires engine, scope, confirmation, and exact
    command; `--yes` is tested in TTY and non-TTY modes;
14. full wizard continues unrelated integrations after an unresolved coder
    issue;
15. wizard resolves engine/provider before credentials; Zen, Moonshot, and
    Kimi flows neither prompt for nor write `ZHIPU_API_KEY`; Z.AI asks only for
    ZHIPU; explicit provider/model and engine/provider conflicts write nothing;
16. targeted/full wizard matrices for Zen-only, Z.AI-only, Moonshot-only,
    Kimi-only, multiple-key, and zero-key environments;
17. Crush accepts only the mapped coding-plan GLM roles and rejects PAYG/Zen
    before spawning; OpenCode/Crush ambiguity requires explicit engine in
    non-interactive recovery; effective `TRISS_CODER_ENGINE=crush` wins over a
    lone stale `opencode.json` in a cross-process test;
18. split-source `current.main`/`current.small`, redacted credential readiness,
    and every JSON catalogue status;
19. `--allow-unverified` accepts only explicit main+small on timeout/http/parse
    failures and never bypasses missing credentials or authoritative absence;
20. missing deny-first policy blocks by default and the explicit
    `--allow-unsafe-bash --yes` recovery changes only model fields;
21. confirmation decline leaves every byte unchanged;
22. provider-aware `status` marks each provider ready from its own credential;
23. `coder run --model` help clearly describes its one-run/main-model limit;
24. JSON model-list output remains stable and contains no secret material.

All API behavior must use injected fixtures. Keep one fixture with a retired
model absent and multiple replacement models present; never make CI depend on
the live catalogue.

RED evidence required before implementation:

- run each new focused test file/selection against the unchanged production
  code;
- record the expected assertion failure, not a syntax/import/environment
  failure;
- confirm the existing relevant tests are green so the new failures are
  attributable to the new contract.

### Phase 3 — shared inspection and change planning, then GREEN

Files:

- add `src/coder-models.js` (or an equivalently focused module);
- refactor `src/commands/coder.js` without changing run behavior;
- update `src/coder-engines/crush.js` for model-role inspection/translation;
- update `src/commands/status.js` for provider-aware readiness.

Implement provider intent, effective-scope inspection, catalogue status,
compatibility validation, and pure change planning. Make existing init audits
consume structured diagnostics before adding mutations.

Acceptance criteria:

- current init success cases remain idempotent;
- no live API is called by default `status`;
- the incident fixture resolves to `opencode-zen`, not Z.AI;
- all failures identify the winning scope and one next action.
- run the focused resolution/audit tests and record GREEN before refactoring or
  starting command mutation work.

### Phase 4 — model list and transactional set commands, then GREEN

Files:

- update `bin/triss.js` command registration;
- add command handlers in `src/commands/coder.js` or a focused command module;
- update shell completion sources/tests;
- update engine adapters.

Implement `coder models` and `coder model set`, including confirmation,
non-interactive `--yes`, backups, atomic writes, rollback, and final audit.

Acceptance criteria:

- a successful command changes both effective roles and nothing else;
- a failed command leaves all original files effective and reports recovery;
- a fresh process resolves the new model pair;
- `--global`/`--local` and shadowing behavior are explicit and tested.
- the command, rollback, completion, and structured-output test selections are
  GREEN before wizard integration begins.

### Phase 5 — wizard recovery UX, then GREEN

Files:

- update `src/commands/config.js`;
- update `CODER_MANIFEST` / setup integration in `src/commands/coder.js`;
- extend wizard unit and cross-process tests.

Replace silent Z.AI fallback with the shared intent resolver. Add the
interactive stale-model screen, alternative-provider path, safe update path,
show-commands path, and explicit skip semantics. Use the model-set transaction
for every accepted repair.

Acceptance criteria:

- the motivating incident can be resolved without manual JSON editing;
- declining a repair never changes model fields;
- full wizard results clearly separate unrelated successful integrations from
  unresolved coder setup;
- no terminal error ends only with "fix the issues above".
- the exact incident cross-process test and all wizard-focused tests are GREEN
  before cleanup/refactoring.

### Phase 6 — refactor, generated-copy reconciliation, full GREEN, and review

With all focused tests green:

- refactor duplicated provider/model diagnostic formatting into the shared
  service without changing the Phase 1 contract;
- update CLI descriptions in `bin/triss.js`, credential/model help strings in
  `src/commands/coder.js`, shell completions, and generated/copied agent
  guidance to match the already-written documentation;
- add a repository check or focused assertion preventing a retired model ID
  from remaining in active help/default text after it is removed from the
  priority list. Historical incident fixtures and migration tests may retain
  the old ID;
- compare the final command output and diff back to the Phase 1 documentation
  and the motivating incident.

Run at minimum:

```bash
node --test test/coder-model-management.test.js
node --test test/coder-init.test.js test/coder-init-crossproc.test.js test/coder-provider-detect.test.js
node --test test/wizard-full.test.js
node --test test/coder-crush.test.js test/status-coder.test.js test/completion.test.js
npm run lint
npm test
git diff --check
```

Then perform two manual, isolated smoke tests with temporary HOME/project
directories and synthetic keys/API fixtures:

1. reproduce the retired-Zen-model incident and complete the suggested repair;
2. switch GLM roles through Crush and verify OpenCode Zen config is untouched.

Do not run a live coding task or send repository content to an external model
as part of the smoke test. A live catalogue check may use only the provider's
models endpoint and must redact credentials.

## Definition of done

- The implementation history shows the docs-first TDD sequence: reviewed
  contract diff, expected RED evidence, minimal implementation, focused GREEN,
  then full GREEN and final diff review.
- Users can discover current models and distinguish engine from provider.
- Users can change persistent main and small/fast models with one command.
- OpenCode and Crush expose consistent public model-management semantics while
  retaining engine-specific validation.
- The wizard never silently selects Z.AI when provider intent is ambiguous.
- A retired model produces live alternatives and an exact repair command.
- Interactive repair preserves custom configuration and requires confirmation.
- Non-interactive repair is deterministic, non-mutating by default, and
  scriptable with `--yes`.
- Global/local/shell precedence cannot produce a false green result.
- Backups, atomic writes, and rollback are covered by tests.
- Active help and documentation do not claim that `hy3-free` is available.
- Existing run, safety-policy, isolation, credential-scoping, and no-clobber
  guarantees remain intact.

## Explicit non-goals

- Do not make OpenCode Zen models available through Crush.
- Do not merge provider billing or subscriptions; credentials stay
  provider-specific.
- Do not auto-select paid replacements for a retired free model.
- Do not make `triss status` depend on network availability.
- Do not silently rewrite custom engine configuration during ordinary init.
- Do not treat a catalogue network failure as evidence that a model is gone.

## Independently verified blockers — RED-phase contracts

The following ten blockers were independently verified against the current
production tree. Each is stated as an explicit, machine-testable contract that
the focused RED tests in `test/coder-model-*-blocker*.test.js` enforce. The
contracts are normative: a GREEN implementation must satisfy every bullet
without weakening the wording. Tests use injected catalogues/spawn seams and
isolated temp HOMEs; no test reaches the real network or a real model API.

### Blocker 1 — OpenCode Zen `/models` returns BARE ids; all public/config ids must be canonical `opencode/<id>`

Contract:

- The OpenCode Zen catalogue API (`GET https://opencode.ai/zen/v1/models`)
  returns entries whose `id` is BARE (for example `deepseek-v4-flash-free`),
  NOT the canonical `opencode/<id>` form used everywhere else in triss.
- `listProviderModels` MUST normalize every bare catalogue id to its canonical
  `opencode/<id>` form before returning it. The returned `models` array, the
  `available_models` inspection field, the `recommended.{main,small}` pair, the
  `availability`/`compatibility` comparison set, and every recovery command
  MUST use canonical ids exclusively.
- `inspectCoderModelState` computes availability by comparing the configured
  model (canonical, e.g. `opencode/deepseek-v4-flash-free`) against the
  canonicalized catalogue set. A configured canonical model that the bare-id
  catalogue lists MUST resolve to `available`, not `unavailable`.
- `pickRecommended` MUST return canonical ids. Falling back to `models[0]` is
  allowed only after canonicalization, so the fallback is still canonical.
- Test fixtures MUST use API-realistic bare ids in the `data[].id` field
  (`{data:[{id:'deepseek-v4-flash-free'},...]}`). Fixtures that pre-prefix the
  ids with `opencode/` hide the bug and are not acceptable evidence.

RED signal today: `listProviderModels` returns the bare ids verbatim;
availability comparisons and recommendations therefore resolve to bare ids,
and a canonical configured model is falsely reported `unavailable`.

### Blocker 2 — Stale-model recovery must emit one executable persistent repair command and an execution-level smoke

Contract:

- For any `inspectCoderModelState` whose `current.main.availability` or
  `current.small.availability` is `unavailable`, `formatModelRecovery` MUST
  emit at least one command that is a copy-paste `triss coder model set`
  invocation containing, all at once: an explicit canonical main model
  (`opencode/<id>`), an explicit `--small opencode/<id>`, `--engine opencode`,
  `--provider opencode-zen`, exactly one of `--global`/`--local`, and `--yes`.
- The recovery command MUST NOT omit the required main model (a small-only
  command is not a valid repair) and MUST NOT route the operator through the
  no-clobber/`coder init` path (which would refuse to overwrite an existing
  `opencode.json`). The persistent repair verb is `coder model set`.
- No recovery command may embed the credential value.
- An execution-level smoke test MUST drive the full inspect → recommend →
  format pipeline under an isolated temp HOME with an INJECTED catalogue
  fixture and `globalThis.fetch` blocked (no real network), then assert the
  produced command is well-formed and POSIX-shell-runnable (see Blocker 9).

RED signal today: the recovery command's model ids are bare (a consequence of
Blocker 1), so it is neither canonical nor copy-paste-runnable against the
documented `opencode/<id>` surface.

### Blocker 3 — Non-TTY `coder init` with zero or multiple provider credentials must fail before spawn/fetch/write

Contract:

- `triss coder init` invoked non-interactively (no TTY) with NO explicit
  `--model`/`--provider` and with ZERO or MORE THAN ONE provider credential
  set (`ZHIPU_API_KEY`, `OPENCODE_API_KEY`, `MOONSHOT_API_KEY`,
  `KIMI_API_KEY`) MUST exit non-zero BEFORE any engine spawn, any catalogue
  fetch, and any file write (`opencode.json`, env pins, agent templates).
- It MUST NOT silently select `zai` (the historical `|| 'zai'` default). The
  failure MUST be a provider-intent failure, not an engine-binary-not-found
  failure, a missing-credential failure, or a malformed-config failure.
- stderr MUST list the EXACT provider alternatives, one per provider
  (`--provider zai`, `--provider opencode-zen`, `--provider moonshot`,
  `--provider kimi-for-coding`), and MUST frame the cause as ambiguous/missing
  provider intent.
- This contract applies to the `coder init` path specifically. The wizard path
  (`resolveWizardCoderProvider`) already throws; the regression is that
  `resolveInitProvider` still falls back to `'zai'` for non-TTY ambiguous
  intent.

RED signal today: `resolveInitProvider` returns `'zai'` for non-TTY zero/multi
credential state, so `coder init` spawns the engine and only fails later
(binary missing or `ZHIPU_API_KEY is not set`), never naming provider
alternatives.

### Blocker 4 — `config wizard coder --coder-engine crush` must not print a generic green "Done." unless Crush setup actually completed

Contract:

- `triss config wizard coder --coder-engine crush` MUST NOT report a generic
  green "Done." completion for the coder target unless Crush setup actually
  completed: the crush binary was detected AND `crush models use` seeded the
  model atoms AND `permissions.run` was seeded (the same steps
  `triss coder init --engine crush` performs).
- When Crush setup did NOT complete (binary absent, `crush models use` failed,
  or the wizard defers crush setup to `coder init`), the wizard MUST emit a
  STRUCTURED incomplete signal — an explicit "incomplete"/"not configured"
  marker tied to crush — and the EXACT next command
  `triss coder init --engine crush`. The generic green "Done." line is not a
  permitted completion signal in this state.
- The exit status reflects the incomplete state (non-zero, or zero only when
  the incomplete marker and next command are both present and the coder target
  is reported unresolved rather than done).

RED signal today: the wizard's crush `postSetup` (`runCoderSetup` with
`engine==='crush'`) returns `{}` after only checking the ZHIPU key; the wizard
then prints the generic green "Done." while crush models + permissions were
never configured.

### Blocker 5 — `coder models` must resolve effective project-over-global state by default

Contract:

- `inspectCoderModelState` (and therefore `triss coder models`) MUST resolve
  the EFFECTIVE model state across scopes by default: when a project
  (local) `opencode.json` exists, its `model`/`small_model` win over the
  global file at runtime, so the effective `current.main`/`current.small`
  MUST reflect the project values and `source_path` MUST point at the
  winning project file.
- The displayed `scope`, `source_path`, and every recovery command's scope
  flag MUST match the WINNING scope, not an arbitrarily defaulted one.
- The CLI MAY expose explicit `--global`/`--local` to force inspection of a
  single scope, but the default (no flag) is effective resolution.
- A configured model absent from the live catalogue is reported `unavailable`
  at the winning scope; a project value that wins but is itself stale is not
  hidden by a healthy global value.

RED signal today: `inspectCoderModelState` reads only the single `scope`
passed in (defaulting to `'global'`), so with a project file overriding
global it reports the global model and the global `source_path`.

### Blocker 6 — OpenCode model apply/rollback must hold an exclusive engine+scope interprocess lock

Contract:

- `applyModelChange` MUST acquire an exclusive lock keyed by
  `(engine, scope)` BEFORE the first pre-read/snapshot and hold it through
  BOTH commits (config rename AND env rename) plus any compensation/rollback.
  The lock is released only after the critical section ends, on success,
  failure, and rollback paths alike.
- The lock seam is `deps.lock(engine, scope)` returning `{ release() }` (or
  an equivalent documented seam). When `deps.lock` is injected, the apply
  MUST call it; tests assert acquire happens before the config read and
  release happens after the env commit.
- Stale-lock behaviour: when acquire reports the lock is held by another
  writer (or a stale lock cannot be acquired cleanly), the apply MUST abort
  with a structured `lock-held` diagnostic, write NOTHING, and exit
  non-zero. It MUST NOT block indefinitely in a unit test.
- CAS/hash safety: concurrent writers MUST NOT mix roles or overwrite newer
  state. The apply MUST detect that the on-disk config hash diverges from the
  pre-read hash at commit time when another writer committed in between, and
  abort rather than clobber.
- A deterministic concurrency seam (an `onPostConfigRename` hook that
  re-enters the lock while the first writer is inside the critical section)
  MUST observe the lock still held — no `sleep`-based timing.

RED signal today: `applyModelChange` performs no locking at all; two
concurrent writers can interleave their config/env commits and clobber one
another, and `deps.lock` is ignored.

### Blocker 7 — Crush local apply must align cwd to the manifest path and verify success

Contract:

- `applyCrushModelChange` for `scope === 'local'` MUST run `crush models use`
  with `cwd` set to the project root used by the manifest's config path
  (`<projectRoot>/.crush/crush.json`). For `scope === 'global'` cwd is the
  user home. The spawn seam MUST receive the cwd so `crush models use --local`
  writes the file at the exact absolute path recorded in the manifest.
- Success is not merely `crush` exiting 0. After a status-0 spawn, the apply
  MUST verify the manifest's config path EXISTS and is READABLE, and MUST
  record the resulting `outputHash` (SHA-256 of the post-write bytes) in the
  manifest target for BOTH the `existed:true` and `existed:false` cases — so
  a later rollback can verify-and-remove or verify-and-restore safely.
- A status-0 spawn that leaves no readable file at the manifest path is a
  FAILURE (rollback + non-zero), not a silent success.

RED signal today: the spawn seam signature is `sh('crush', argv)` with no
cwd option, so local applies run at the triss process cwd (which need not be
the project root); and the `existed:true` success path records no
`outputHash` (only the `existed:false` path does, best-effort).

### Blocker 8 — Crush failure compensation must not remove an unowned/concurrently-created file; restoration failures must surface as rollback-failed

Contract:

- When `applyCrushModelChange` snapshots `existed:false` and the spawn then
  FAILS, compensation MAY remove a file at the config path ONLY when its
  current content hash equals the bytes the failing spawn wrote (a partial
  artifact). It MUST NOT remove a file whose hash differs — that file was
  created by a concurrent writer or the user and is unowned. This mirrors the
  hash guard `rollbackModelChange` already enforces on the rollback path.
- A restoration FAILURE (rename/permission/etc.) MUST be surfaced as a
  structured `rollback-failed` result with the retained protected record and
  absolute manual-recovery paths — the same exit-3 contract as the OpenCode
  apply. It MUST NOT be swallowed into a best-effort `catch {}` that reports
  only the original crush error.
- Compensation and rollback share the same hash-verify-then-act discipline so
  no path deletes state it did not create.
- When the pre-call snapshot is `existed:false` and a failing Crush process
  leaves a file whose ownership cannot be proved, compensation MUST return a
  structured `partial-state-retained` failure (exit 3), not normal success or a
  bare spawn error. The result and CLI output name the live config path and
  retained transaction record and give explicit inspect/remove guidance. They
  MUST NOT claim rollback succeeded or emit a rollback command that cannot
  safely remove the unowned file.

RED signal today: `restoreCrushConfig` does `rmSync(configPath, {force:true})`
unconditionally when `!snap.existed`, removing any file at that path
regardless of ownership; and every restoration error is swallowed, so a
rollback failure is never reported as `rollback-failed`.

### Blocker 9 — Every dynamic argument in a printed recovery/rollback command must be POSIX-shell quoted

Contract:

- Every dynamic value interpolated into a copy-paste command — the
  `--from <record-dir>` of `triss coder model rollback`, the positional main
  model, `--small <model>`, and any path — MUST be POSIX-shell single-quoted
  with embedded single quotes escaped (`'\''`), so the printed command is
  byte-for-byte runnable in `sh`/`bash` and passes the value as a single
  argument.
- This MUST hold for values containing: spaces, a single apostrophe (`'`), a
  semicolon (`;`), command substitution (`$(...)`), and an embedded newline.
- The injection guard is real, not cosmetic: an unquoted `--from` whose path
  contains `$(...)` would execute the substitution when the operator
  copy-pastes the command.
- Tests MUST verify by parsing the printed command the way a POSIX shell
  would (single-quoted spans are atomic; nothing outside quotes is
  interpolated), not by naive substring match.

RED signal today: `buildRollbackCommand` and `formatModelRecovery`
shell-join dynamic values with bare spaces; a record dir or model id
containing shell metacharacters breaks or injects.

### Blocker 10 — Active help/docs must not advertise `hy3`/`hy3-free`; README and Crush help paths must be accurate

Contract (active-help cleanup is assertion-only in RED; production help text
is NOT modified in this phase):

- Active help and shipped docs MUST NOT advertise `hy3` or `hy3-free` as a
  current/available model. Historical incident/migration examples and
  migration tests may retain the id; active help/option text/default copy may
  not. Specifically the `triss coder init --provider <name>` option help, the
  README coder/init prose, and `.env.example` active comments must not present
  `hy3`/`hy3-free` as a live default.
- The README MUST describe `TRISS_CODER_MODEL` as a runtime MAIN-model
  override (it sits in the OpenCode-main precedence chain: one-run CLI/MCP
  override → shell `TRISS_CODER_MODEL` → project env → global env → default).
  It MUST NOT claim `TRISS_CODER_MODEL` is "not a runtime override".
- The README MUST NOT claim `triss coder models` lists "everything" wired up
  when the command resolves ONE effective engine/provider per invocation.
- Crush help paths MUST be exact: the local Crush config path is
  `./.crush/crush.json` (NOT `./crush.json`); the global path is
  `~/.local/share/crush/crush.json`. Any `--help`/doc text naming a Crush
  config path MUST match the path the adapters actually read/write.

RED signal today: `coder init --provider` help says "free models incl. hy3";
the README coder/init line advertises "free OpenCode Zen models like `hy3`"
and says `TRISS_CODER_MODEL` is "not runtime overrides"; the README says
`triss coder models` shows "everything wired up"; `coder model rollback
--local` help names `./crush.json` instead of `./.crush/crush.json`.

### Corrective Blocker A — Default interprocess filesystem lock for EVERY real apply AND rollback (strengthens Blocker 6)

Independent re-inspection found that Blocker 6's contract was implemented with
an OPTIONAL `deps.lock` seam only: `applyModelChange` acquires a lock solely
when `deps.lock` is a function, and the real CLI (`runCoderModelSet`) calls
`applyModelChange({ ...plan, confirmed: true }, {})` with empty deps — so in
production NO interprocess lock exists. `rollbackModelChange` has no lock at
all. Blocker 6's contract is therefore tightened:

Contract:

- Every REAL apply AND rollback — OpenCode `applyModelChange`,
  `rollbackModelChange`, and the Crush `applyCrushModelChange` /
  `rollbackModelChange` paths — MUST acquire a built-in cross-process
  filesystem lock BY DEFAULT, keyed by `(engine, scope)`, BEFORE the first
  pre-read/snapshot/target read, and hold it through ALL commits and any
  compensation/rollback. The lock is released on every exit (success, failure,
  rollback-failed).
- `deps.lock` is an OVERRIDE seam for deterministic unit tests ONLY. Absence of
  `deps.lock` MUST NEVER mean unlocked: when `deps.lock` is not supplied the
  operation MUST use the built-in filesystem lock. (Existing tests that inject
  `deps.lock` continue to drive the override; the CLI path — empty deps — now
  locks for real.)
- The lock MUST be a genuine cross-process primitive (e.g. `flock`/`O_EXCL` on
  a real file), not an in-process flag, so two `triss coder model set ...`
  processes (or a set + a concurrent rollback) cannot interleave their
  config/env commits and clobber one another or mix roles.
- The lock path is deterministic and HOME-relative (so a temp HOME isolates
  it), and the service MUST export a safe test seam `lockPathFor(engine,
  scope)` returning the absolute lock file path, so deterministic tests can
  observe/hold it with no `sleep`-based timing.
- Fail CLOSED on a live, malformed, unreadable, or indeterminate lock. A lock
  containing a valid Triss token may be reclaimed only when its recorded PID
  is proven dead (`process.kill(pid, 0)` reports `ESRCH`) and the token is still
  unchanged. Otherwise the operation aborts with a structured `lock-held`
  diagnostic that names the lock PATH and gives MANUAL guidance, writes
  NOTHING, and exits non-zero.
- CAS/hash safety from Blocker 6 still applies: even with the lock, the apply
  MUST detect an on-disk hash divergence at commit time and abort rather than
  clobber.

RED signal today: `applyModelChange` only locks when `deps.lock` is a function
(so the CLI's empty-deps call is unlocked) and `rollbackModelChange` never
locks; two concurrent writers can interleave, and no `lockPathFor` seam exists.

Deterministic RED tests (no sleeps), using the `onPostConfigRename`
re-entrancy seam and/or the exported `lockPathFor` seam:

1. Default apply creates/holds the real lock and a concurrent second apply
   cannot write: while apply #1 is inside its critical section
   (`onPostConfigRename`), a second `applyModelChange(..., {})` (empty deps,
   the CLI shape) for the same `(engine, scope)` MUST return a `lock-held`
   non-result and write nothing; apply #1's commit is the only one that lands.
2. Rollback uses the SAME default lock and refuses while held: while apply #1
   holds the lock, `rollbackModelChange` for the same `(engine, scope)` MUST
   refuse with a `lock-held` diagnostic and restore nothing.
3. Release after success AND after error: the lock file exists during the
   critical section and is RELEASED (gone) after a successful apply and after
   an apply that errors and rolls back — so a subsequent operation is not
   blocked forever.

### Corrective Blocker B — Wizard stale-Zen incident recovery command must be a single executable `coder model set` (no main-less command, no repeat-wizard)

Independent re-inspection found that the actual wizard stale-Zen incident
emitter (`emitZenStaleIncident` in `src/commands/coder.js`) prints

```
triss coder model set --engine opencode --provider opencode-zen <scope>
```

with NO main model, NO `--small`, and NO `--yes`, followed by a SECOND command
that re-runs the wizard (`triss config wizard coder --coder-engine opencode
--coder-provider opencode-zen <scope>`). The first is not a runnable repair (a
`coder model set` with no positional main is rejected), and the second loops
the operator back into the no-clobber wizard they just came from.

Contract:

- The wizard stale-Zen incident recovery output MUST offer ONE executable
  persistent repair command built from the replacements triss just resolved:
  `triss coder model set <canonical-main> --small <canonical-small>
  --engine opencode --provider opencode-zen <scope> --yes`, where
  `<canonical-main>`/`<canonical-small>` are the live `opencode/<id>` ids the
  authenticated catalogue returned (the same values `formatModelRecovery`
  produces). The command MUST include an explicit main AND `--small` AND
  `--yes`.
- The recovery command MUST be POSIX-shell safe (dynamic ids quoted per
  Blocker 9) and MUST be copy-paste executable: when run through the real CLI
  against the fixture it APPLIES the replacement pair (updates opencode.json)
  without looping back into the wizard and without hitting the no-clobber
  guard.
- The recovery output MUST NOT offer `triss config wizard coder ...` (or any
  repeat-wizard/no-clobber command) as a SUCCESSFUL recovery alternative. The
  wizard is where the incident was detected; re-running it is not a repair.

RED signal today: `emitZenStaleIncident` prints a main-less, `--small`-less,
`--yes`-less `coder model set` line and a second repeat-wizard line.

Deterministic RED test (execution-level, temp HOME, injected catalogue, no real
network): drive `runWizard('coder', {global:true}, deps)` with an injected Zen
catalogue fixture and a project opencode.json pinned to `opencode/hy3-free`;
extract the printed `triss coder model set ...` recovery line; assert the
canonical explicit main + `--small` + `--engine` + `--provider` + scope +
`--yes`, POSIX-parse it, assert the repeat-wizard command is absent, and prove
the extracted command applies through the real CLI against the fixture (no
loop, no no-clobber) using an offline/local seam (e.g. `--allow-unverified`).

### RED-phase scope and discipline

- These contracts are added in a docs-first RED phase. Production source,
  templates, README active help, generated agent guidance, and command help
  text are NOT modified in this phase. Existing user changes in the worktree
  are preserved untouched.
- The focused tests added under this section MUST fail against the current
  production tree for the right reason — an assertion about the contract
  above — never because of a syntax/import/environment error. A test that
  fails for the wrong reason is treated as a non-result and corrected before
  evidence is recorded.
- No new test reaches the real network or a real model API. Catalogue states
  are injected; spawn seams are injected; temp HOMEs are isolated; no secrets
  are read or written.

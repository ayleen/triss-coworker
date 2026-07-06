# `triss coder` — delegate coding tasks to a GLM agent (opencode engine)

Implementation plan. Written to be executed by a mid-tier model (Sonnet/Opus):
every step names the exact files, existing helpers to reuse, and acceptance
criteria. Follow the repo conventions in `CLAUDE.md` at all times.

> Supersedes the execution-engine choice in `docs/crush-glm-integration.md`:
> **engine #1 is opencode** (`opencode-ai` on npm, MIT, Z.AI built in as the
> `zai` provider). The crush fork becomes engine #2, added later behind the
> same adapter interface (Phase 6). The background research and the
> control-plane/execution-engine split from that document still apply.

## Product vision (what we are building)

triss stays the **control plane**; opencode is the **execution engine** with
GLM hands; the orchestrator (Claude Code) is the **brain** that decomposes,
supervises, reviews.

```
triss coder init          # one-time: install engine, key, policy, templates
triss coder run [opts] "<task>"   # spawn a GLM coding agent, get a JSON envelope
triss coder clean         # remove finished isolation worktrees
triss status              # gains a "coder" block
```

Three safety layers, all owned by triss (engine-agnostic):
1. **Tool policy** — generated `opencode.json` denies bash by default and
   allowlists safe commands (`git diff`, `npm test`, …). Deny-first, not
   deny-list-of-bad-things.
2. **Secret scoping** — the engine subprocess receives a minimal env
   (PATH/HOME/locale + `ZHIPU_API_KEY` only), never the caller's full env.
3. **Worktree isolation** — `--isolate` runs the agent in a disposable
   `git worktree`; irreversible actions (DB, deploy, push) stay with the
   orchestrator, which reviews the diff before anything merges.

## Naming decision (do not rename without checking this)

"Agent" is taken in this codebase: it means the AI assistant that *uses*
triss (`triss agent-help`, `src/agent-rules.js`, `templates/claude.md`).
The new feature is therefore **`coder`** everywhere: command group
`triss coder`, file `src/commands/coder.js`, env prefix `TRISS_CODER_*`,
MCP tools `triss_coder_*`.

## Fixed technical facts (verified 2026-07-03 — do not re-research)

- npm package **`opencode-ai`** (MIT, bin `opencode`), verified working via
  `npx -y opencode-ai --version` → `1.17.13`. Pin the version (see Phase 1).
- Z.AI is a **built-in provider** in opencode's catalog (models.dev):
  provider id `zai`, base `https://api.z.ai/api/paas/v4`, env
  **`ZHIPU_API_KEY`**, models incl. `glm-5.2`, `glm-5-turbo`, `glm-4.7`.
  There is also `zai-coding-plan` (subscription endpoint
  `https://api.z.ai/api/coding/paas/v4`). No custom provider block needed.
- Config: `~/.config/opencode/opencode.json` (global) and `./opencode.json`
  (project; overrides global). Top-level `model` / `small_model` as
  `<provider>/<model>`. `{env:VAR}` interpolation supported.
- Custom agents: markdown + YAML frontmatter in `.opencode/agents/*.md`
  (project) or `~/.config/opencode/agents/` (global). Frontmatter:
  `description` (required), `mode`, `model`, `prompt`, `permission`,
  `temperature`, `steps`.
- Permissions: per-tool `allow|ask|deny`, bash supports command patterns
  (`"git *": "allow"`, `"*": "deny"`, last match wins). Headless needs
  `--auto` (auto-approves every `ask`; `deny` still blocks).
- Headless: `opencode run [message..] --format json --model <p/m>
  --agent <name> --session <id> | --continue | --fork --dir <path> --auto`.
  `--format json` emits a **stream of JSON events**, not a single envelope.
- NOT verified yet (Phase 0 resolves): exact event schema, exit codes,
  stdin behavior, usage/token fields in the stream.

## Envelope contract (the adapter's output)

`triss coder run` prints exactly one JSON object to **stdout** (logs go to
stderr via `pc.dim()`, per repo convention). Shape mirrors the crush fork's
envelope so engine #2 slots in later:

```json
{
  "engine": "opencode",
  "engine_version": "1.17.13",
  "session_id": "task-3",
  "exit_reason": "end_turn | error | timeout | killed",
  "final_text": "...",
  "files_changed": ["src/a.js"],
  "diff_stat": " 2 files changed, 40 insertions(+)",
  "worktree": "/path/.triss/wt/task-3 | null",
  "usage": { "prompt_tokens": 0, "completion_tokens": 0 },
  "warnings": []
}
```

`files_changed`/`diff_stat`/`worktree` are populated only with `--isolate`
(computed via `git -C <wt> diff --stat` etc.); otherwise `null`/`[]`.

**Envelope vs thrown Error — the exact split** (do not improvise):
- Engine started and produced parseable events, but exited non-zero, hit
  the timeout, or was killed → **emit the envelope** with
  `exit_reason: "error" | "timeout" | "killed"` and exit 0 (the caller
  inspects `exit_reason`).
- Engine binary not found, failed to spawn, or produced nothing
  parseable → **throw a plain `Error`** (formatted by `wrap()` in
  `bin/triss.js:223`, exits 1, no envelope). MCP handlers follow the
  same split: envelope as tool result vs tool error.

---

## Execution staffing (model / effort per phase)

The orchestrator (Fable/Opus, medium effort) decomposes, reviews diffs
against each phase's acceptance criteria, and runs `node --test` +
`/code-review` before the PR. All coding is delegated to Sonnet subagents:

| Phase | Model | Effort | Rationale |
|---|---|---|---|
| 0 — live recon | sonnet | high | Only phase with unknowns; a wrong event-schema fixture poisons everything downstream |
| 1 — `coder init` | sonnet | medium | Mechanical, fully specified against existing wizard primitives |
| 2 — `coder run` | sonnet | high | The core adapter: ndjson folding, worktree lifecycle, process-group kill, envelope-vs-throw edge cases |
| 3 — clean + status | sonnet | medium | Simple mechanics following the existing status grammar |
| 4 — MCP tools | sonnet | medium | Copies the established tools/handlers pattern + sandbox |
| 5 — docs + tests | sonnet | medium | Tests replay the Phase 0 fixture; docs follow the lockstep checklist |

Do not use haiku (even docs require code cross-checking here — a single
wrong field name silently broke three subsystems during plan review) and
do not use opus for coding (the plan deliberately front-loads the
reasoning so Sonnet suffices).

## Phase 0 — live recon (requires a Z.AI key; ~1 hour)

Blocking prerequisite for Phase 2. Ask the user for `ZHIPU_API_KEY` if not
configured.

1. `npx -y opencode-ai@1.17.13 run --format json --model zai/glm-5-turbo
   --auto "print hello via a shell echo"` in a scratch dir.
2. Capture the raw stream to `test/fixtures/opencode-run-events.ndjson`
   (redact any key material). This fixture drives the Phase 2 parser tests.
3. Record in this doc's "Recon results" section (append it): event types
   observed, where the final assistant text lives, where usage/tokens live,
   exit code on success, exit code on API error (kill the key to test),
   whether stdin is accepted as the message.
4. Confirm `--session` reuse works headlessly (run twice with the same id,
   second prompt referencing the first).
5. **Exercise the safety layer — this is the worst silent-failure risk.**
   Generate the Phase 1 `opencode.json` in the scratch dir, then prompt
   the agent to run a denied command (`curl example.com`, `rm /tmp/x`)
   under `--auto`; assert the call is blocked. If the permission JSON
   shape or pattern semantics ("last match wins", `"git diff*"` globs)
   differ from this plan's template, fix the template HERE before
   Phase 1. Also confirm: `--dir` is honored (agent writes land in the
   given dir), and the global config path
   `~/.config/opencode/opencode.json` is actually picked up.

## Phase 1 — `triss coder init`

New file `src/commands/coder.js` (one file per subcommand group — mirror how
`src/commands/config.js` hosts `runWizard`/`runSet`/…). Register in
`bin/triss.js` using the nested-group pattern of `config` (see the
`program.command('config')` block):

```js
const coder = program.command('coder').description('Run a GLM coding agent (opencode engine)');
coder.command('init').option('-g, --global').option('-l, --local').action(wrap(runCoderInit));
// register run/clean in their own phases; if registered early, stub with
// `throw new Error('not implemented yet')` — never a silent no-op
coder.command('run [prompt]').action(wrap(runCoderRun));   // options in Phase 2
coder.command('clean').action(wrap(runCoderClean));        // Phase 3
```

Shell completion needs zero work: `src/commands/completion.js:19-44`
walks the Commander tree dynamically.

### Two entry points, one implementation

Setup must be reachable both ways, converging on the same function:

- **`triss config wizard`** — register coder as a wizard target via a
  minimal pseudo-manifest. Field name is `name`, NOT `key` — every
  consumer reads `e.name` (`envReadiness` in
  `src/integrations/_registry.js:83`, wizard prompts in
  `src/commands/config.js:382`, status markers in
  `src/commands/status.js:59`):

  ```js
  export const CODER_MANIFEST = {
    name: 'coder',
    description: 'GLM coding agent (opencode engine)',
    envVars: [{ name: 'ZHIPU_API_KEY', required: true, secret: true,
                doc: 'Z.AI API key for GLM models' }],
    postSetup: runCoderSetup,   // steps 1, 3, 4 below
  };
  ```

  Exact touch points (there is no hook mechanism today — build it):
  (a) add `CODER_MANIFEST` inside `listManifests()` in
  `src/commands/config.js:42-45`; (b) add it to `allManifests` in
  `src/commands/status.js:12`; (c) add support for an **optional
  `postSetup()`** manifest field, invoked in `runFullWizard`
  (`config.js:372-447`) after the env-var loop completes — other
  manifests don't define it and are unaffected; (d) do NOT add it to
  `loadIntegrations()`: `validateManifest`
  (`src/integrations/_contract.js:182`) requires a `register` function
  the pseudo-manifest lacks, and the integrations loop in
  `bin/triss.js:270-274` would try to call it. Note the advanced-mode
  multi-select (`config.js:378-401`) filters on `!m.isCore &&
  m.envVars?.length`, so coder appears in the picker — desired.
- **`triss coder init`** — direct CLI path, same function. This is the
  command the CLAUDE.md rule tells users/orchestrators to run.

Both paths are idempotent: key present → show masked, skip; engine
present → version check against the pin only; config present → no
clobber.

`runCoderInit(opts)` steps:

1. **Detect engine.** `spawnSync('opencode', ['--version'])` (never
   `shell: true`). If missing → offer `npm install -g opencode-ai@<PIN>`;
   run it on confirm (spawnSync `npm`, argv array). If npm missing → print
   install instructions and stop. Store the pin as a constant
   `OPENCODE_PIN = '1.17.13'` in `src/commands/coder.js`; overridable via
   env `TRISS_CODER_OPENCODE_VERSION`.
2. **Key.** Reuse the config wizard primitives from
   `src/commands/config.js` / `src/secrets.js`: `chooseScope()` →
   `getEnvFilePath(scope)` → `ensureEnvFile(scope)` → `setVar(path,
   'ZHIPU_API_KEY', value)`. **`chooseScope` is currently module-private
   (`config.js:29`) — export it first.** Mask echo with `maskValue()`.
   If already set, show masked value and skip. IMPORTANT: call
   `loadEnvFiles()` from `src/config.js` at the top of `runCoderInit`
   AND `runCoderRun` before reading `ZHIPU_API_KEY` — the key lives in
   `~/.config/triss/.env` / `.triss.env` and reaches `process.env` only
   via that loader (same defensive pattern as `listTools()` calling
   `getConfig()` in `src/mcp/tools.js:805`).
3. **Generate `opencode.json`.** Scope follows the same global/local choice:
   global → `~/.config/opencode/opencode.json`, local → `./opencode.json`.
   If the file exists, do NOT overwrite — print a diff-style hint of the
   keys we would set and exit that step (idempotent init). Template:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "model": "zai-coding-plan/glm-5.2",
     "small_model": "zai-coding-plan/glm-5-turbo",
     "permission": {
       "bash": {
         "*": "deny",
         "git status": "allow", "git diff*": "allow", "git log*": "allow",
         "ls*": "allow",
         "node --test*": "allow", "npm test*": "allow", "npm run test*": "allow"
       },
       "webfetch": "deny",
       "websearch": "deny"
     }
   }
   ```

   Models are constants at the top of `coder.js`, overridable via
   `TRISS_CODER_MODEL` / `TRISS_CODER_SMALL_MODEL` (same pattern as
   `TRISS_WORKER_FLASH_MODEL` in `src/models.js`).
4. **Scaffold agent templates.** Write `.opencode/agents/coder.md`
   (implementation agent, default permissions from opencode.json) and
   `.opencode/agents/researcher.md` (read-only: `permission: { edit: deny,
   bash: deny }`). Keep them short; store templates as string constants,
   not new template files, unless they exceed ~40 lines.
5. **Wire the orchestrator.** Add a "coder" section to
   `templates/claude.md` (nano: one paragraph — when to delegate, the
   `triss coder run` one-liner) and `templates/claude-full.md` (full
   contract: flags, envelope fields, isolation, sessions). Same for the
   codex templates. `triss init` then propagates it via the existing
   `writeAgentRules()` machinery — no new writer needed.
6. **Summary.** Print what was installed/written/skipped, stderr, dim.

Acceptance: running `triss coder init` twice in a row is a no-op the second
time; no file is clobbered; `ZHIPU_API_KEY` never printed unmasked.

## Phase 2 — `triss coder run`

The core adapter. Options:

```
triss coder run [prompt]
  --session <id>        # get-or-create; maps to opencode --session
  --continue            # maps to --continue
  --agent <name>        # maps to --agent (default: coder)
  --model <p/m>         # override model for this run
  --isolate             # run in a fresh git worktree (see below)
  --cwd <path>          # working dir (default: cwd; ignored with --isolate)
  --timeout <sec>       # default 900; kill + exit_reason "timeout"
  --stdin               # read prompt from stdin (mirror `triss ask --stdin`)
  --json                # no-op (envelope is always the output; flag kept
                        # for symmetry with other commands — do not invent
                        # a non-JSON mode)
```

Implementation notes:

1. **Spawn.** `spawn('opencode', ['run', ...argv], { detached: true })`
   with an **allowlist env**: `{ PATH, HOME, TMPDIR, LANG, LC_ALL,
   ZHIPU_API_KEY }` — build it explicitly, do not spread `process.env`.
   Never `shell: true`. `detached: true` puts the engine in its own
   process group so timeout/kill can reap its bash children:
   `process.kill(-child.pid, 'SIGTERM')`, escalate to `SIGKILL` after a
   grace period. (Remember `loadEnvFiles()` first — Phase 1 step 2.)
2. **Stream folding.** Parse stdout as ndjson line-by-line against the
   Phase 0 fixture schema. Accumulate: final assistant text, tool-call
   counts, usage. Unknown event types → count into `warnings`, don't crash.
   Forward a compact progress line per tool call to stderr (dim) so a
   human/orchestrator tailing the process sees liveness.
3. **Isolation.** With `--isolate`: derive a slug from `--session` (or a
   short random suffix). Order matters: FIRST `addToGitignore('.triss/')`
   (exported helper, `src/secrets.js:141` — NOT `maybeAddGitignore`,
   which is private to `config.js` and hardcodes `.triss.env`), THEN
   `git worktree add .triss/wt/<slug> -b coder/<slug>` via
   `spawnSync('git', [...])` — otherwise the first run pollutes the
   worktree diff with `.triss/` itself. Pass the worktree as `--dir`.
   **Same slug re-run (session continuation):** if `.triss/wt/<slug>`
   already exists and its branch is `coder/<slug>`, reuse it; if it
   exists but doesn't match, throw a clear Error. After the run, compute
   `files_changed` + `diff_stat`; if the diff is empty, `git worktree
   remove` immediately. Refuse `--isolate` outside a git repo: there is
   no detection helper in `src/git.js` — use `try { git(['rev-parse',
   '--show-toplevel']) } catch { throw new Error(...) }` (or add an
   `isGitRepo()` helper there).
4. **Usage accounting.** On completion call `logUsage({ model,
   prompt_tokens, completion_tokens, label: 'coder', call_id })`
   (`src/usage.js:79`). Note `logUsage` silently returns when
   `prompt_tokens == null` (`usage.js:88`) — if Phase 0 finds no token
   fields in the event stream, pass `prompt_tokens: 0` and add a
   `warnings` entry rather than letting runs vanish from accounting.
   `DEFAULT_PRICES` (`usage.js:41`, non-exported) keys must be the exact
   string passed as `model`; add `zai-coding-plan/glm-5.2` and
   `zai-coding-plan/glm-5-turbo` entries (see Recon results: the
   configured key is a coding-plan/subscription key, `cost` came back
   `0` on every observed event — treat these as `$0`/token in
   `DEFAULT_PRICES` but still log `prompt_tokens`/`completion_tokens`
   for observability). If a future key targets the pay-as-you-go `zai`
   provider instead, look those prices up on https://docs.z.ai at
   implementation time; do not guess.
5. **Errors.** Follow the envelope-vs-throw split defined under the
   envelope contract above: parseable-but-failed run → envelope with
   `exit_reason`; failed to start / nothing parseable → throw plain
   `Error` with the last stderr lines attached (`wrap()` in
   `bin/triss.js:223` formats it). Never print-and-exit inside the
   command body.
6. **MCP mode.** When invoked via MCP (Phase 4), `--cwd`/worktree paths
   must pass `assertSafePath(p, { kind: 'write' })` from `src/safety.js`.

Acceptance: with the fixture replayed through the parser (unit test), the
envelope matches the contract above; a live `triss coder run --isolate
"add a comment to README"` produces a worktree with the change and a valid
envelope; timeout path produces `exit_reason: "timeout"` and kills the
child.

## Phase 3 — `triss coder clean` + status block

1. `runCoderClean()`: list `.triss/wt/*` worktrees, `git worktree remove`
   the ones whose branch has no diff vs its base, print kept ones. `--all`
   forces removal.
2. `src/commands/status.js`: add a "coder" block after the integrations
   list, same visual grammar (`●`/`○` markers, `[global]`/`[local]`/`[env]`
   source tags): engine found + version vs pin, `ZHIPU_API_KEY` presence
   (masked source only), config file(s) found, count of live worktrees.

## Phase 4 — MCP tools

In `src/mcp/tools.js`, add `CODER_TOOLS`: `triss_coder_run` (schema
mirrors the CLI options; prompt required) and `triss_coder_status`. Gate in
`listTools()` on env readiness: include only when
`envReadiness(CODER_MANIFEST).ready` (the same `CODER_MANIFEST` defined in
Phase 1; do NOT create a full `src/integrations/coder/` directory, this is
not a tracker integration).
Handlers in `src/mcp/handlers.js` call the same functions as the CLI.
`triss_coder_run` in MCP mode must enforce the `safety.js` sandbox (Phase 2
note 6). GLM runs over MCP are expected to be long, and stdio MCP has no
client-side per-call cap — use a generous MCP-side default timeout
(1500 s), allow per-call override via the `timeout` arg, document the
constraint in `docs/mcp.md`, and point runs that may exceed it to the
CLI-in-background path in the templates rule.

## Phase 5 — docs lockstep + tests (definition of done)

Update in the same PR (repo rule):
1. `README.md` — command catalogue (`coder init/run/clean`), env-var table
   (`ZHIPU_API_KEY`, `TRISS_CODER_MODEL`, `TRISS_CODER_SMALL_MODEL`,
   `TRISS_CODER_OPENCODE_VERSION`).
2. `.env.example` — the same vars, one-line use-case each.
3. `docs/mcp.md` — `triss_coder_*` tools + gating var.
4. `templates/claude.md` / `claude-full.md` / codex twins — done in
   Phase 1 step 5; verify they render via `triss agent-help`.
5. `docs/extending.md` — NOT applicable (not an integration); do not touch.

Tests (`node --test test/*.test.js`, no live network):
- `test/coder-envelope.test.js` — feed `test/fixtures/opencode-run-events.ndjson`
  through the stream folder; assert envelope fields, unknown-event
  tolerance, truncated-line tolerance.
- `test/coder-init.test.js` — config generation into a temp dir:
  idempotency, no-clobber, gitignore append.
- `test/coder-isolate.test.js` — worktree lifecycle against a temp git
  repo (git IS allowed in tests — it's local, not network); empty-diff
  auto-cleanup.
- Spawning of the engine itself is injected: export the runner so tests can
  pass a fake `spawn` (same spirit as mocking `globalThis.fetch` elsewhere).

## Phase 6 — crush fork as engine #2 (later, separate PR)

Prereq: `PHPCraftdream/crush` publishes an npm package or releases
(Plans 1–2 of `docs/crush-glm-integration.md`).

1. Introduce `TRISS_CODER_ENGINE=opencode|crush` (default `opencode`) and
   split engine specifics behind a tiny adapter interface inside
   `src/commands/coder.js` (or `src/coder-engines/` if it outgrows one
   file): `{ detect(), installHint(), buildArgv(opts), foldOutput(stream),
   configTemplate(scope) }`.
2. crush mapping: `--session/--cwd` align 1:1; output is already a single
   JSON envelope (easier than opencode — no folding).
3. Known gap to carry into the config template: crush permissions have no
   bash command patterns (`allowed_tools`/`disabled_tools`/`--yolo` only).
   The generated `crush.json` must put `bash` in `disabled_tools` by
   default and the docs must state the trade-off (agent can't self-run
   tests). Verify what headless `crush run` does with a non-allowed tool
   before shipping.

## Guardrails for the implementing model

- Do not add dependencies. ndjson parsing, worktree management and env
  handling are all doable with node builtins + what's already in
  `package.json`.
- stdout is for the envelope only; every log/progress line goes to stderr
  with `pc.dim()`.
- Never pass the caller's full env to the engine subprocess.
- Never log or echo `ZHIPU_API_KEY` — use `maskValue()`.
- All subprocesses via `spawn`/`spawnSync` with argv arrays.
- If Phase 0 reveals the event schema differs from assumptions here,
  update THIS document first, then implement against the fixture.
- Keep `docs/crush-glm-integration.md` untouched except adding a one-line
  pointer at the top to this document.

## Recon results (Phase 0, 2026-07-03)

Live recon performed against `opencode-ai@1.17.13` in a scratch git repo
outside this checkout, using the `ZHIPU_API_KEY` configured in
`.triss.env`. `npx -y opencode-ai@1.17.13` and `--version`/`--help` are
fast and reliable; the pinned version is confirmed installable.

### Provider correction (important — changes Phase 1's template)

The configured `ZHIPU_API_KEY` is a **`zai-coding-plan` (subscription)
key, not a pay-as-you-go `zai` key**. Calling `--model zai/glm-5-turbo`
with this key fails every time with
`AI_APICallError: Insufficient balance or no resource package. Please
recharge.` — the wording ("no resource package") is the tell. Switching
the provider prefix to `zai-coding-plan/glm-5-turbo` (same model id,
different provider) succeeds immediately with `cost: 0` on every event
(subscription, not metered). **Phase 1's `opencode.json` template model
fields have been corrected in this document** (`"zai-coding-plan/glm-5.2"`
/ `"zai-coding-plan/glm-5-turbo"`) and the `DEFAULT_PRICES` note in
Phase 2 updated to match. If a future key targets the metered `zai`
endpoint instead, this default needs to flip back — not guaranteed to
generalize beyond this account's key.

### Event schema (from `--format json`)

Stdout is newline-delimited JSON (ndjson), one object per line, no
wrapping array and no terminal "done" sentinel — completion is signaled
by the process exiting. Every object has a top-level `type` field.
Observed `type` values across all recon runs: `step_start`, `tool_use`,
`step_finish`, `text`, `error`. No other types appeared (no
session-start/session-end wrapper, no explicit heartbeat/ping type).

Common envelope for step-ish events: `{"type", "timestamp"
(epoch ms), "sessionID", "part": {...}}`. The shape of `part` depends on
`type`:

- `step_start` → `part: {id, messageID, sessionID, snapshot, type:
  "step-start"}`.
- `tool_use` → `part: {type: "tool", tool: "<name>", callID,
  state: {status: "completed"|"error", input, output?, error?,
  metadata?, title, time: {start, end}}, id, sessionID, messageID}`.
  `tool` observed values: `"bash"`, `"read"`. On a permission denial,
  `state.status` is `"error"` and `state.error` is a human-readable
  string embedding the exact matched rule set as JSON (see Safety layer
  below) — there is no separate `"denied"` status; denial is just a
  tool-call error.
- `step_finish` → `part: {id, reason: "tool-calls"|"stop", snapshot,
  messageID, sessionID, type: "step-finish", tokens: {total, input,
  output, reasoning, cache: {write, read}}, cost}`. `reason: "stop"`
  marks the true end of the assistant's turn for that step.
- `text` → `part: {id, messageID, sessionID, type: "text", text,
  time: {start, end}}`. `text` is the literal assistant reply text
  (may include markdown/code fences).
- `error` (top-level run failure, not a per-tool error) → `{"type":
  "error", "timestamp", "sessionID", "error": {"name": "APIError",
  "data": {"message", "statusCode", "isRetryable", "responseHeaders",
  "responseBody", "metadata": {"url"}}}}`.

**Where the final assistant text lives:** the `text` field of the last
`text`-type event in the stream (in every successful run observed, this
coincided with the event preceding the final `step_finish` with
`reason: "stop"`). A run can have multiple `text` events across multiple
steps (intermediate commentary before a tool call); the fold logic
should keep overwriting a "latest text" accumulator rather than
concatenating, and trust the one that lines up with the final `stop`.

**Where usage/tokens live:** `part.tokens` on **every** `step_finish`
event, not just the last one — each step reports its own step-level
token counts, they are **not cumulative**. A run with N steps (e.g. one
tool call + one final reply = 2 steps) emits N `step_finish` events, each
with its own `tokens.input`/`tokens.output`/`tokens.total`. To populate
the envelope's `usage.prompt_tokens`/`usage.completion_tokens`, **sum**
`tokens.input` and `tokens.output` across all `step_finish` events for
the run. `part.cost` was `0` on every single event observed (subscription
key — see provider correction above); still pass the summed
`prompt_tokens`/`completion_tokens` (not `0`) to `logUsage()` so runs
don't silently vanish from accounting per the `usage.js:88` short-circuit
noted in Phase 2.

### Exit codes

| Scenario | Exit code | Stdout | Notes |
|---|---|---|---|
| Success (incl. runs where a tool call was permission-denied and the model worked around it) | `0` | valid ndjson stream | |
| Unrecoverable API error (401, e.g. bad key — tested by corrupting the last 4 chars) | `1` | single `{"type":"error",...}` line | fails in ~1-2s, `isRetryable:false` in the payload |
| **Recoverable/retryable API error** (e.g. insufficient balance on the wrong provider) | **never exits on its own** | nothing on stdout | retries indefinitely with exponential backoff (observed retry gaps ~19s, 33s, 66s, ...); **must** be killed externally |
| No message and no `--command` given (incl. piping a prompt via stdin with no positional arg) | `1` | nothing (plain ANSI text on stderr: `Error: You must provide a message or a command`) | confirms the throw-`Error` path, not the envelope path |
| `--session <id>` where `<id>` was never created by opencode | `1` | nothing (plain ANSI text on stderr: `Error: Session not found`) | see Session reuse below |
| `--version` / `--help` | `0` | plain text, not JSON | `--format json` only affects `run` |

The retryable-error row is the most consequential finding: opencode does
**not** give up and exit on its own for retryable failures, so Phase 2's
`--timeout` + process-group `SIGTERM`→`SIGKILL` logic is not a nice-to-have
edge case, it is the *only* way such a run ever terminates. Confirmed
live (a run against the wrong provider retried for 3+ minutes before
being killed by the recon harness).

### stdin verdict

**Not accepted.** There is no `--stdin` flag (see `run --help` output),
and running with no positional `message` and nothing on argv — even with
text piped into stdin — errors immediately with `Error: You must provide
a message or a command` (exit 1, nothing on stdout). Phase 2's `--stdin`
option must read stdin itself in Node and pass the read text as a
**positional argv message** to the `opencode run` invocation; it cannot
rely on opencode reading its own stdin.

### Session reuse verdict — correction to Phase 2's option description

**Confirmed working, but not as "get-or-create" the way Phase 2 describes
it.** `opencode run --session <id>` requires `<id>` to be a
**real, opencode-issued session id** (format `ses_<24ish
alphanumeric chars>`, e.g. `ses_0d7b5c721ffeouI80ItCOxAJ3g`). Passing an
arbitrary caller-chosen slug (the plan's example, `task-3`) throws
`Error: Session not found` — opencode does **not** create a session
keyed by a caller-supplied id.

The correct headless pattern, confirmed live (second run correctly
recalled "hello" from the first run's echo):
1. First invocation for a new logical session: **omit** `--session`
   entirely. Capture the real `sessionID` from the first JSON event of
   the resulting stream.
2. Persist a mapping from triss's own session concept (whatever `--session
   <id>` the *caller* passed to `triss coder run`) to that real
   `ses_...` id — e.g. `.triss/sessions.json`.
3. Subsequent invocations pass the **captured real id** via opencode's
   `--session` flag, not the caller's original slug.

**Phase 2's option table line for `--session` needs this correction**
when implemented: `--session <id>` maps to triss's own slug→real-id
lookup table, not directly to opencode's `--session` flag on the first
call.

### Safety layer verdict — template confirmed correct, two denial mechanisms observed

The Phase 1 `opencode.json` permission template (JSON shape, `"git
diff*"`-style globs, `"*": "deny"` catch-all) works exactly as the plan
assumed — **no shape/semantics correction needed**. Two distinct denial
mechanisms were observed depending on how "deny" is expressed:

1. **Partial allowlist** (some patterns `allow`, `"*": "deny"` catches
   the rest — the plan's actual template): the `bash` tool **is** exposed
   to the model, and a denied command becomes a `tool_use` event with
   `state.status: "error"` and a message that embeds the exact matched
   rule set as JSON, e.g.:
   `{"permission":"*","action":"allow","pattern":"*"},{"permission":"bash","pattern":"*","action":"deny"},{"permission":"bash","pattern":"git status","action":"allow"},...`.
   Note the implicit **leading `{"permission":"*","action":"allow","pattern":"*"}`** — there is a default global allow-all baseline that the config's explicit `bash` rules override for that tool; this matches "last match wins" semantics. Confirmed blocking both `curl example.com` and `rm <file>` under `--auto`; the target file was untouched and no network call the model could make.
2. **Full deny** (`"bash": {"*": "deny"}`, no allow patterns at all —
   used to test global config pickup): the `bash` tool is **not exposed
   to the model's tool list at all**. The model explicitly reported
   "I don't have a Bash tool available... tools I have access to are:
   edit, glob, grep, read, write, task, todowrite, skill" — a stronger
   and cleaner form of denial than case 1, worth using for the
   `researcher.md` agent template (Phase 1 step 4) which already
   specifies `bash: deny`.

**`--dir <path>` confirmed honored:** ran opencode from a cwd different
from the target repo, passed `--dir <repo>`, and a file the agent created
landed inside `<repo>`, not the actual process cwd.

**Global config pickup (`~/.config/opencode/opencode.json`) confirmed
working**, tested via `HOME=<scratch-home>` (never touching the real
`~/.config/opencode`) with no local project `opencode.json` present —
the global file's full-deny bash permission was picked up and reflected
in the model's available tool list (case 2 above).

### Fixture

`test/fixtures/opencode-run-events.ndjson` — **6 lines**, genuine bytes
from a live successful run (`--model zai-coding-plan/glm-5-turbo`,
prompt "print hello via a shell echo", `--auto`), no redaction needed
(scanned for the configured key's first 10 characters — zero matches).
Contains one full turn: `step_start` → `tool_use` (bash `echo "hello"`)
→ `step_finish` (`reason: tool-calls`) → `step_start` → `text`
(`` `hello` ``) → `step_finish` (`reason: stop`).

### Cost

All recon calls landed on the `zai-coding-plan` (subscription) provider,
which reports `cost: 0` on every event — **no determinable per-call USD
cost from the usage events**. Call volume for the record: roughly a
dozen `run` invocations (1 baseline, 1 bad-key, 1 stdin-check, 2 session
reuse, 2 safety-layer denial checks, 2 `--dir`/global-config checks, plus
retries) against the `zai-coding-plan` endpoint, all subscription-covered.
One `zai` (non-coding-plan) call was attempted and failed before any
tokens were billed (`isRetryable` error prior to a completion).

## Phase 6 recon (crush fork — 2026-07-05)

The prereq is unblocked: the fork publishes **`@phpcraftdream/crush`** on
npm (`0.1.0`, FSL-1.1-MIT, bin `crush`, node ≥18, Go-free prebuilt binary
via per-platform optionalDependencies). Live recon of that binary
(`v0.0.0-20260704…+dirty`) in a scratch dir against the existing
`ZHIPU_API_KEY` — the fork's `crush run` **diverges substantially from
this plan's Phase 6 assumptions**. Corrections, all verified live:

- **Provider / key var mismatch.** crush ships Z.AI as a built-in Catwalk
  provider `zai` (`type: openai-compat`, endpoint
  `https://api.z.ai/api/coding/paas/v4` — same coding-plan endpoint as
  opencode), models `glm-5.2 / glm-5.1 / glm-5-turbo / glm-4.7 / …`. But
  it reads **`ZAI_API_KEY`**, NOT `ZHIPU_API_KEY`. Adapter must bridge
  this: simplest is to map the value into `ZAI_API_KEY` inside crush's
  spawn-env allowlist so triss keeps a single user-facing `ZHIPU_API_KEY`.
  Confirmed working: `crush ping` → `zai / glm-5.2 … status: ok`; a
  `crush run --role smart --json` returned a clean `end_turn` envelope.
- **Single JSON envelope (no ndjson fold).** `crush run --json` prints ONE
  object to stdout at end-of-run:
  `{session_id, exit_reason, final_text, assistant_notes?, tool_calls,
   usage:{delta_tokens, delta_cost_usd}, duration_ms, error}`. `exit_reason`
  vocabulary: `end_turn | done | canceled | timeout | max_cost |
  max_tokens | error`. Tool-call heartbeat still goes to stderr as
  `▶ <toolName>`. So the crush adapter's `foldOutput` is a trivial
  parse-last-line, not a streaming fold. **cost is real here**
  (`delta_cost_usd: 0.000048` observed) — unlike opencode's coding-plan
  cost:0. Usage is a combined `delta_tokens`, NOT split prompt/completion.
- **Native sessions — no slug→id map needed.** `crush run --session <id>`
  is genuine get-or-create with a **caller-supplied arbitrary id** (docs:
  "an arbitrary new id to start a fresh session with that exact id — handy
  for CI"). So for crush, pass triss's own slug straight through; the
  `.triss/sessions.json` mapping (an opencode-only workaround) is
  unnecessary. Adapter flag e.g. `needsSessionMap: false`.
- **`--role` is REQUIRED.** Every `crush run` must declare `--role
  smart|large` (big model) or `--role fast|small` (cheap). `--model
  <provider/model[@level]>` overrides per invocation. Default large model
  resolved from `crush models use <large> <small>` (atoms `glm5_2`,
  `glm5_turbo`) written to `crush.json` (global
  `~/.local/share/crush/crush.json`, local `./.crush/crush.json`).
- **SAFETY MODEL IS WEAKER — the headline caveat.** This confirms Phase 6
  note 3, but stronger: `crush run` is non-interactive and
  **auto-approves EVERY permission request; the agent gets the full tool
  set with no prompting** and there is **no bash command-pattern
  allowlist** like opencode's deny-first `opencode.json`. crush's own
  `run --help` warns runs are "fast but irreversible — only run in a
  workspace you can afford to lose." Mitigations available, all must be
  applied by triss for crush: (a) force/strongly-default `--isolate`
  (disposable git worktree) for crush; (b) `CRUSH_FORBID_WRITES=<paths>`
  env blocks write/edit tools from named paths; (c) `--agents single`
  (default) disables sub-agent fan-out/recursion; (d) `--max-cost` /
  `--max-tokens` runaway caps. There is NO way to reproduce opencode's
  per-command bash allowlist — document this trade-off prominently
  (agent can't be given a curated safe-command list; it's all-or-nothing
  inside the sandbox).
- **stdin IS accepted** (unlike opencode): prompt = `<stdin>\n\n<args>`.
- **Extra levers worth surfacing in the adapter/docs:** `--timeout`
  (accepts `900`/`900s`/`15m`; preserves partial answer in envelope),
  `--on-finish "cmd"` (sets `CRUSH_SESSION_ID`/`CRUSH_EXIT_REASON`/…),
  `crush sessions cancel <id>` for external cancellation, `--format json`
  post-processing that strips code fences from `final_text`.

Net: the crush adapter is in most respects SIMPLER than opencode
(single-envelope parse, native sessions, no template-shape guessing) but
its **safety story is the one place it is worse** and must not be papered
over. The engine-abstraction shape in Phase 6 step 1 still holds; the
`configTemplate` member becomes a `crush.json` + `crush models use`
writer, and a new adapter member is needed for the spawn-env key bridge
(`ZHIPU_API_KEY` → `ZAI_API_KEY`) and the crush-only safety env
(`CRUSH_FORBID_WRITES`).

## Phase 6 re-eval (crush 0.1.3 — 2026-07-06)

The fork maintainer shipped three releases (0.1.1 → 0.1.3, all 2026-07-05)
in direct response to `docs/crush-issues.md`. Re-verified every one of the
seven reported issues live on `0.1.3` (real `ZHIPU_API_KEY`, live Z.AI
coding-plan endpoint). Scorecard:

| # | Sev | Issue | Status | Evidence (0.1.3) |
|---|-----|-------|--------|------------------|
| 1 | High | `--version` = `v0.0.0…+dirty` | ✅ fixed | reports clean `v0.1.3` |
| 2 | High | `zai` reads only `ZAI_API_KEY` | ✅ fixed | with only `ZHIPU_API_KEY` set (`ZAI_API_KEY` unset), `zai` hit the network and returned 401 → key read natively |
| 3 | Med | `--role fast` (glm-5-turbo) hung to timeout | ✅ fixed | original repro (`crush run --role fast --model zai/glm-5-turbo`) → `exit_reason:end_turn`, `final_text:"PONG"` in 47s |
| 4 | Med | no allowlist, everything auto-approved | ✅ fixed | `--restrict-run` + `--allow-bash` (forms: prefix / `exact:` / `glob:` / `regex:`, chaining-guarded) + `--allow-tool` + config `permissions.run.{restrict,allow_bash,allow_tools}`; CLI merges with config |
| 5 | Med | `models list` does network + disk writes | ✅ fixed | default reads cache/embedded, no network, no writes; `--refresh` is opt-in |
| 6 | Low | `ping` rejects `--role` | ✅ fixed | `ping --role smart\|fast` + dedicated `ping-fast` |
| 7 | Low | startup WARN noise on stderr | 🟡 mostly | old git-repo / Apple-Terminal warnings gone; stderr is clean once models are configured; one WARN remains only on misconfig (large-as-small fallback for `local-cli`) |

**6/7 fully fixed, 1 (low) mostly. Every High and Medium is resolved.**
Issue #4 was closed exactly as suggested (command-pattern allowlist honored
by `crush run`), and better — CLI flags merge with `crush.json`.

Bonus levers added (not requested), worth surfacing later: `--effort
low|medium|high`, `--on-finish` hook (`CRUSH_SESSION_ID/EXIT_REASON/COST_USD/
TOKENS/DURATION_SEC`), watchdog `--timeout-extends-on-progress` +
`--timeout-hard-cap`, `--small-model`, `--format json-schema:<file>`,
`--aggregation attach|concat` for sub-agent fan-out + reduction-loss
warning, per-session budget persistence, default `--timeout` now 60m.

The `exit_reason` vocabulary is unchanged (`done | canceled | timeout |
max_cost | max_tokens | error`, plus `end_turn`) → `mapCrushExitReason`
already covers all of them; **no mapper change needed.**

### What to do now (adapter work — implement via GLM, Claude reviews)

Assignee: GLM (`triss coder run --engine crush`). Reviewer: Claude.
All changes are in `src/coder-engines/crush.js` + tests + docs. Ship on
`feat/coder-crush-engine`.

1. **Bump the pin + enforce the version.**
   - `CRUSH_PIN_DEFAULT`: `0.1.0` → `0.1.3`.
   - `detectCrush()` is presence-only today with a TODO "enforce pin once
     crush --version reports clean semver." That precondition now holds
     (`v0.1.3`). Parse the `vX.Y.Z` out of `crush --version` and return a
     structured `{found, version, satisfiesPin}`; the caller warns (dim
     stderr, non-fatal) on mismatch. Keep it non-fatal — a newer crush must
     still run. Drop the two `TODO: enforce pin` comments.
   - Test: feed a fake `sh` returning `crush version v0.1.3` and assert
     parsed `version === '0.1.3'` / `satisfiesPin === true`; also a
     `v0.2.0` (newer, still `found:true`) and a garbage string.

2. **Retire / re-annotate the ZHIPU→ZAI env bridge.**
   - crush now reads `ZHIPU_API_KEY` natively (issue #2), so the
     `ZHIPU_API_KEY → ZAI_API_KEY` copy in `buildCrushSpawnEnv` is no longer
     required. Decision: **keep it as belt-and-suspenders** (harmless, helps
     anyone still on 0.1.0) BUT rewrite the "silently unconfigured zai
     provider" comment — it is now false for 0.1.1+. New comment: crush
     ≥0.1.1 reads `ZHIPU_API_KEY` directly; we still forward `ZAI_API_KEY`
     as a compatibility alias for older binaries. Also forward
     `ZHIPU_API_KEY` itself into the env allowlist so the native path works.
   - Test: assert the spawn env contains BOTH `ZHIPU_API_KEY` and
     `ZAI_API_KEY` when the base env has `ZHIPU_API_KEY`.

3. **Adopt real restricted-run safety — DECISION: Variant A (parity with
   opencode), restrict ON by default.** This closes the one gap we flagged.
   The design mirrors opencode's deny-first `opencode.json`: persist the
   policy in `crush.json`, do NOT inject the allowlist as per-run CLI flags.
   Rationale: crush merges `permissions.run.allow_bash` from config with CLI
   flags and honors `permissions.run.restrict:true` — so a config-seeded
   policy travels into isolated worktrees and lets users add/remove/replace
   commands by editing ONE file, exactly like `opencode.json`. Injecting via
   CLI flags would let users only ADD, not remove our defaults.
   - **Seed `permissions.run` into `crush.json` at init**
     (`configureCrushModels` / the crush init path). `crush models use`
     already writes `.crush/crush.json` (local) / `~/.local/share/crush/
     crush.json` (global) with a `models` block and NO permissions — there
     is no `crush config` CLI, so read-modify-write that JSON, merging the
     `permissions.run` block into the existing object (never clobber the
     `models` block). Write:
     ```json
     "permissions": { "run": {
       "restrict": true,
       "allow_bash": [ …shared read-only set… ],
       "allow_tools": ["view"]
     }}
     ```
   - **Shared allowlist constant.** Mirror the opencode adapter's trusted
     set verbatim so both engines behave identically. opencode's is
     `opencode.json` `permission.bash` (see coder.js ~L453): `git status`,
     `git diff*`, `git log*`, `ls*`, `node --test*`, `npm test*`,
     `npm run test*`, with `webfetch/websearch: deny`. Translate to crush
     forms (`'git diff'` prefix, `'glob:ls *'`, `'glob:npm test *'`,
     `'glob:node --test *'`, etc.) in ONE named constant so a bump is one
     edit. crush's chaining-guard on prefix patterns is stricter than
     opencode's glob — fine, keep it.
   - **No-clobber, like opencode.** If the user already has a
     `permissions.run` block in crush.json, do NOT overwrite it; if an
     existing crush.json has no restrict policy, warn on stderr (dim), same
     as the opencode "existing config lacks deny policy" warning path
     (coder.js ~L503).
   - **Flip crush's isolate default to OFF** to complete the parity. Today
     `coder.js:1697` defaults crush isolate-ON because it had no allowlist;
     under Variant A the config-seeded deny-first policy is the safety layer,
     so crush should default isolate-OFF like opencode. Update that line AND
     its comment. `--isolate` / `--no-isolate` tristate still wins.

   **User override surface (precedence high → low) — document all four:**
   1. Per-run CLI: add `--no-restrict` / `--restrict` tristate on `coder
      run` in `bin/triss.js` (mirror the existing `--isolate` tristate — no
      Commander default, undefined = "use env/config default"). `--no-restrict`
      drops to auto-approve for one run; `--isolate` brings back the
      disposable worktree for one run.
   2. Env: `TRISS_CODER_CRUSH_RESTRICT=0` disables restrict by default
      without touching config or flags. (Add to README + .env.example.)
   3. Persistent: edit `crush.json` `permissions.run` — set
      `restrict:false`, or add/remove/replace `allow_bash`/`allow_tools`.
      This is the recommended, opencode-equivalent override.
   4. Fallback default when none of the above is set: restrict ON.

   Resolution order in code: CLI flag (if defined) > `TRISS_CODER_CRUSH_
   RESTRICT` env (if set) > `crush.json` `permissions.run.restrict` (if the
   user hand-set it) > built-in default `true`. When restrict resolves ON
   and we control the config, `buildCrushRunArgv` passes `--restrict-run`
   (belt-and-suspenders even though config also has `restrict:true`); when
   it resolves OFF, pass nothing (crush's auto-approve default).
   - Tests: (a) init seeds `permissions.run.restrict:true` + the shared
     allow_bash into a fresh crush.json WITHOUT dropping the `models` block;
     (b) init does NOT clobber a user's existing `permissions.run`;
     (c) `buildCrushRunArgv` with restrict ON contains `--restrict-run`,
     with restrict OFF contains neither `--restrict-run` nor allow flags;
     (d) resolution order: CLI `--no-restrict` beats env=1 beats config.

4. **Docs lockstep (per CLAUDE.md "user-visible change" rule).**
   - `docs/crush-issues.md`: add a "Resolved in 0.1.3 (2026-07-06)" header
     block at the top mapping each issue → fixed/mostly, so the report reads
     as closed, not open. Do not delete the original findings (they are the
     provenance).
   - `README.md` + `.env.example`: document any new env var introduced in
     step 3 (`TRISS_CODER_CRUSH_RESTRICT` / allowlist) and the
     `TRISS_CODER_CRUSH_VERSION` pin now defaulting to `0.1.3`.
   - `docs/mcp.md` only if a new gating env var is added.

5. **Do NOT (out of scope for this pass, note for later):** wiring
   `--effort`, `--on-finish`, or the progress-watchdog flags. They are real
   upside but belong in a follow-up; keep this PR to "close the 7 issues +
   safety parity."

Review focus for Claude: (a) version parse handles `+dirty`/garbage/newer
without throwing; (b) the env bridge keeps BOTH keys and the comment no
longer claims the provider is "silently unconfigured"; (c) Variant A parity
is correct — init seeds `permissions.run` WITHOUT clobbering the `models`
block or an existing user policy, the shared allowlist actually matches the
opencode set, crush isolate default is flipped to OFF, and the override
resolution order (CLI > env > config > default-ON) is exactly as specified;
(d) `spawnSync` stays argv-array (never `shell:true`); (e) all three doc
files moved in lockstep, and the `--no-restrict` flag + `TRISS_CODER_CRUSH_
RESTRICT` env are both documented in README + .env.example.

## Phase 6 fix — restrict enforcement is CLI-only (2026-07-06, live-verified)

Post-merge review (Fable + live crush runs) found that the committed Variant A
(commit `2ad14dc`) **does not actually restrict crush**, and by flipping crush
to isolate-OFF it shipped a net safety *regression*. All facts below were
verified live against `@phpcraftdream/crush@0.1.3` with a real Z.AI key; see
`docs/crush-restrict-issues.md` for the maintainer bug report.

**What's broken (verified live):**
- **Config `permissions.run` is inert.** `crush run --restrict-run` with an
  `allow_bash` policy seeded into `crush.json` (tried `./crush.json`,
  `./.crush/crush.json`, and both) still ran a non-allowlisted `echo` to
  completion. Our `seedCrushPermissions` writes a policy crush ignores.
- **`--restrict-run` with no CLI allow flags == unrestricted** (auto-approves
  everything), not deny-all.
- **CLI `--allow-bash` / `--allow-tool` DO enforce.** Only the command-line
  flags take effect. Verified tool taxonomy: file tools are `view`, `edit`,
  `write`, `ls` (accepts `name` or `tool:action`, e.g. `edit:write`); a coder
  successfully created a file via `write` under `--restrict-run` + those
  allow-tools with no deadlock.
- **A denied *bash* command deadlocks to timeout** (`Context deadline
  exceeded`, no envelope) instead of denying cleanly. File-tool denials were
  not observed to deadlock; only bash.

**Consequence for the default.** A coding agent routinely runs bash outside a
read-only allowlist (`npm run build`, `tsc`, `npm run lint`, …). With the
deadlock bug, every such call dead-ends the whole run at the timeout. So
**Variant-A "restrict ON by default" is NOT viable for the coder use case
until the maintainer fixes the deadlock** — it would make crush runs
routinely dead-end. This supersedes the "restrict ON by default" decision
above: that decision assumed clean deny (as the crush `--help` text promises),
which live testing disproved.

**Revised interim stance (until the two crush bugs are fixed upstream):**
- **crush isolate default → back to ON** (revert the flip in `2ad14dc`). The
  disposable worktree is the reliable, deadlock-free safety layer — the same
  posture crush shipped with originally.
- **crush restrict default → OFF**, but **opt-in restrict actually works**:
  when the user passes `--restrict` / `TRISS_CODER_CRUSH_RESTRICT=1`,
  `buildCrushRunArgv` emits the allowlist as **CLI flags** (not config).
- Net interim posture: *worktree containment (default) + opt-in CLI allowlist
  for defense-in-depth*. Once the maintainer fixes deadlock + config, revisit
  flipping restrict back ON by default for true opencode parity.

### Tasks (implement, then live-verify — enforcement can't be unit-tested)

1. **`buildCrushRunArgv` — emit CLI allow flags when restrict is ON.**
   For each pattern in `CRUSH_ALLOW_BASH_PATTERNS` push `--allow-bash <p>`,
   and for each tool in a new `CRUSH_ALLOW_TOOLS = ['view','edit','write','ls']`
   constant push `--allow-tool <t>`, alongside the existing `--restrict-run`.
   When restrict is OFF, emit none of them (unchanged). Keep argv an array.
2. **Revert the isolate default for crush to ON.** In `src/commands/coder.js`
   change `opts.isolate === undefined ? false` back to `? engine === 'crush'`
   (opencode stays OFF). Update the comment to cite the deadlock/inert-config
   reason, not the old "policy is the safety layer" reason.
3. **Change `CRUSH_RESTRICT_DEFAULT` to `false`.** `resolveCrushRestrict`
   precedence is unchanged (CLI > env > crush.json > default); only the final
   default flips. `--restrict` / `TRISS_CODER_CRUSH_RESTRICT=1` still turn it on.
4. **Keep `seedCrushPermissions` but label it forward-compat.** The config is
   inert today; keep seeding it (harmless, and correct once the maintainer
   honors it) BUT update the comment + any user-facing message to say the
   allowlist is currently enforced via CLI flags, not this config block.
5. **Fable low fixes:**
   - `seedCrushPermissions`: a valid-JSON-but-non-object crush.json (e.g. `[]`)
     must route into the same warn-and-skip branch as a parse error — do NOT
     silently overwrite it.
   - `detectCrush`/pin: when the pin string itself doesn't parse to semver
     (e.g. `TRISS_CODER_CRUSH_VERSION=latest`), skip the comparison (treat as
     satisfied / emit a dim "pin unparseable" note) instead of a perpetual
     `satisfiesPin:false` warning.
6. **Docs lockstep + reconcile the now-false parity claims:** `glm-clients.md`
   §2 table (Safety/Isolation rows) + §8, `crush-issues.md` row #4, README
   Engines section, and `.env.example` currently say crush has working
   `permissions.run` parity and isolate-OFF. Correct all to the interim stance:
   config inert / CLI-flag enforcement / isolate-ON / restrict opt-in.

**Live-verify after implementing (mandatory — this is the whole point):**
`triss coder run --engine crush --restrict "<edit a file + run an allowed
test>"` actually edits and runs; a run that tries a disallowed bash command
fails safe (times out) rather than executing it; default (no `--restrict`)
runs isolated. Passing unit tests are necessary but NOT sufficient — the
`2ad14dc` regression passed 431 tests.

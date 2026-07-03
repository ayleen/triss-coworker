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
     "model": "zai/glm-5.2",
     "small_model": "zai/glm-5-turbo",
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
   string passed as `model`; add `zai/glm-5.2` and `zai/glm-5-turbo`
   entries — look prices up on the https://docs.z.ai pricing page at
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
note 6). MCP hosts often time tool calls out before the CLI's 900 s
default — use a lower MCP-side default timeout (300 s), document the
constraint in `docs/mcp.md`, and point long tasks to the CLI-in-background
path in the templates rule.

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

# Codex Workflow Improvements Plan

Status: implementation-ready
Base: `origin/main` at `8890ff09257f973e706eca75dd08da6678e95171`
Branch: `feature/codex-workflow-improvements`

## Goal

Adopt the useful, portable parts of the reviewed `codex_workflow` project
without turning Triss into a multi-agent workflow runtime:

1. make `triss init` marker updates strict, atomic, and recoverable;
2. add an optional evidence-oriented response contract to `triss ask` and
   `triss review` without changing their default output;
3. add an explainable `triss exec` router over existing Triss commands.

The expensive host agent remains responsible for architecture, authorization,
and final acceptance. Triss remains a CLI/MCP delegator and coding-agent
launcher.

## Non-goals

- Do not add Light/Medium/Heavy session state, persistent project diaries,
  end-of-session commits, or worker-to-worker orchestration to Triss.
- Do not add an LLM call merely to choose a route.
- Do not create a second implementation of `ask`, `review`, `chat`, or
  `coder run`; `exec` must compose their existing callable entry points.
- Do not change the default stdout contract of an existing command.
- Do not create or merge a pull request as part of this work.

## Current behavior and gaps

### Agent-rule installation

`src/commands/init.js` edits `CLAUDE.md` and `AGENTS.md` with direct
`writeFileSync` calls. Marker handling uses the first start/end pair and does
not reject partial, duplicate, reversed, or nested marker layouts. A failed
`--target both` run can update one file before failing on the other.

### Ask and review output

`ask` and `review` return concise free-form text. Their defaults are useful and
must remain byte-for-byte compatible apart from existing nondeterministic model
content. They do not offer a shared evidence-oriented report shape. Streaming
currently writes model chunks directly to stdout.

### Routing

The README lists `triss exec <task>` as planned. Today the host agent selects a
command from advisory rules. There is no executable, testable explanation of
that selection.

## Public contracts

### 1. Strict transactional marker writes

`triss init` must preflight every selected target before writing any target.

Accepted marker states:

- no Triss markers: append one managed block;
- exactly one ordered, non-nested start/end pair: replace only that block;
- the rendered result is unchanged: report already up to date and perform no
  filesystem mutation.

Rejected states:

- only one marker is present;
- an end marker precedes its start marker;
- duplicate start or end markers exist;
- a second/nested Triss block exists;
- an existing destination or resolved symlink target is not a regular file.

Rejection must happen before any selected target changes and the error must
name the destination and marker problem. `--force` must not bypass malformed
markers; it only retains its current user-facing update label.
When one init invocation selects multiple destinations, their resolved target
paths must also be distinct. If (for example) `CLAUDE.md` and `AGENTS.md` are
symlinks to the same backing file, preflight must reject the transaction before
directory creation or writes instead of installing one agent's rules over the
other agent's rules. On a case-insensitive filesystem, missing destinations
that differ only by case are the same transaction target and must be rejected
by the same zero-write preflight. Because portable JavaScript does not expose
the filesystem's full Unicode case-folding table, a missing non-ASCII suffix
on a case-insensitive filesystem is rejected rather than compared unsafely.
If an empty directory exposes no read-only case-sensitivity probe, Triss does
not inherit the parent's semantics because some filesystems configure this per
directory. It rejects only pairs that could be case aliases; a single target
and unrelated ASCII target names remain valid.
Destination paths containing a `..` component are rejected before filesystem
mutation. Resolving such a component lexically is unsafe when an earlier path
component is a symlink because it can select a different file than filesystem
lookup.

Writes must:

- use a unique temporary file in the destination directory;
- preserve the existing file mode when replacing a file;
- flush and atomically rename the complete replacement;
- preserve an existing symlink by resolving and updating its regular-file
  target rather than replacing the symlink itself;
- remove temporary files on failure;
- roll back already-applied targets if a later target fails;
- never modify unrelated bytes outside the managed block.

An interrupted process can leave a complete old or new file, never a torn
file. Existing targets use a same-directory final `rename(temp, target)`;
there is no move-away/link window in which the public pathname is absent or a
raced directory is hidden. The immediate identity, mode, kind, and content
checks are the supported portable pure-Node compare-and-exchange boundary:
Node does not expose a cross-platform kernel `rename-if-unchanged` primitive,
so an external actor that mutates the same pathname after the final check and
before the kernel rename is outside this guarantee. A non-regular entry
observed at the final check fails closed and remains at the public pathname.
Rollback failures must be reported alongside the original failure rather than
hidden.

### 2. Optional evidence response format

Add `--format <text|evidence>` to CLI `ask` and `review`, defaulting to `text`.
Add the corresponding optional MCP argument `response_format` with the same
values and default.

`text` preserves all current prompt, streaming, return, stdout, stderr, and MCP
behavior.

`evidence` adds a shared trusted system-prompt suffix requiring this compact
Markdown contract:

```text
Outcome: <one concise conclusion>

Evidence:
- <claim> | <result> | <exact source or method> | <confidence>

Uncertainty:
- none

Decision required: none
```

Rules:

- the model must not invent commands, source locations, or verification;
- use `none` explicitly when a section has no entries;
- `review` keeps its existing defect-finding rules and clean verdict phrase;
- the response remains model-authored Markdown; Triss does not pretend it can
  validate semantic claims merely by parsing headings;
- custom `ask --system` remains authoritative, but the evidence suffix is
  appended after it when evidence mode is selected;
- evidence mode supports streaming because its wire format is still text;
- invalid format values fail before reading files, Git diffs, stdin, URLs, or
  making a model request.

The format helper must be shared by CLI and MCP paths so their prompt contract
cannot drift.

### 3. Explainable deterministic `triss exec`

Add:

```text
triss exec [task] [routing inputs/options]
triss exec --explain [task] [routing inputs/options]
```

`--explain` is an inspection mode, not the normal execution path. It prints a
stable JSON route decision and performs no model call, network access, Git
diff, stdin read, or filesystem mutation.

The decision object has schema version 1 and contains:

```json
{
  "schema_version": 1,
  "route": "ask",
  "reason": "source inputs require corpus analysis",
  "signals": ["paths"],
  "executes": "triss ask"
}
```

Routing precedence is deterministic and based on explicit inputs first:

1. `--pr`, `--base`, or `--review` routes to `review`;
2. `--paths` or `--urls` routes to `ask`;
3. `--code` routes to `coder run`;
4. `--chat` routes to `chat`;
5. without an explicit route, conservative lexical classification selects:
   review only for an explicit review/audit request, coder only for an explicit
   implementation/change request, otherwise chat.

Ambiguous or contradictory explicit signals fail closed and list the conflict.
Explicit options that the selected downstream route does not support also fail
closed instead of being silently discarded or sent through a default provider.
In inspection mode, those option failures remain side-effect free and are
returned as a schema-versioned decision with `route: null` and the validation
message in `reason`; normal execution raises the same message as an error.
This pure preflight also covers downstream structural validation such as
response formats, positive integer token budgets, incompatible stdin/base
inputs, required ask questions, and coder-engine token-budget support.
Every core CLI and MCP command that accepts a token budget (`ask`, `chat`,
`fetch`, `review`, `write`, and `commit-msg`) must use the same strict
validator before corpus, network, Git, filesystem, or model I/O. Only a
positive safe integer supplied as a decimal string or JavaScript number is
valid; booleans, arrays, objects, fractional values, partial numeric strings,
zero, negative values, explicit `null`, and values above JavaScript's maximum
safe integer must fail instead of being coerced or replaced by a default. MCP
schemas must describe the same positive-safe-integer contract, but
handlers still enforce it because schema validation is not a trusted runtime
boundary.
There is no `direct` route because a standalone Triss process cannot hand the
task back to its host agent.

Forwarded options are a documented bounded subset:

- common: task/prompt, `--stdin`, and `--model`; `--max-tokens` is forwarded
  to ask, review, and chat, and to coder only with the Crush engine (OpenCode
  exposes no per-run token-budget flag, so that combination fails explicitly);
- ask: `--paths`, `--urls`, `--provider`, `--format`, `--system`, stream flags;
- review: `--pr`, `--base`, `--skip-issue`, `--provider`, `--format`, stream
  flags;
- coder: `--engine`, `--provider`, `--model`, `--small-model`, isolation,
  restriction, session, cwd, and timeout flags;
- chat: `--system`, `--model`, max tokens, and stream flags.

`exec` calls exported JavaScript entry points directly. It must never build a
shell command from user text. The selected command keeps its existing output,
usage label, cancellation, safety, and error semantics. Normal execution emits
one concise route explanation to stderr before invoking the selected command.

`--stdin` retains the selected downstream command's meaning and is read only by
that command: ask corpus, review diff, or coder/chat prompt. Ask/review require
the positional task as their question when stdin supplies the corpus/diff.
Coder/chat may take their prompt from stdin when their explicit route flag is
present. Because routing never inspects stdin, stdin-only execution without an
explicit route is rejected as ambiguous. `--explain` never reads stdin.

## Architecture and expected files

The implementation may refine names after RED tests, but should keep these
boundaries:

- `src/agent-rules.js` or a focused new marker module: strict marker parser and
  pure render plan;
- a small shared filesystem transaction module: same-directory atomic writes,
  symlink-aware target resolution, mode preservation, rollback;
- `src/commands/init.js`: preflight all targets, then apply one transaction;
- a shared response-format module: validation and trusted evidence suffix;
- `src/commands/ask.js`, `src/commands/review.js`,
  `src/mcp/handlers.js`, and `src/mcp/review-core.js`: format propagation;
- `src/commands/exec.js`: pure route decision plus dependency-injected dispatch;
- `bin/triss.js`: public CLI registration only;
- `src/mcp/tools.js`: response-format schema parity for ask/review;
- `templates/`, `README.md`, `docs/mcp.md`, and completion output where the new
  public surfaces require documentation.

Prefer extracting the existing private JSON atomic-write behavior from
`src/commands/coder.js` only if the resulting shared helper retains its exact
session-map behavior. Do not expand this feature into unrelated configuration
rewrites.

## TDD sequence

### Phase 1: documentation and RED contracts

1. Commit this plan before production implementation.
2. Add focused failing tests for malformed marker layouts, zero-write
   preflight, atomic replacement, mode/symlink preservation, temp cleanup, and
   two-target rollback.
3. Add failing CLI and MCP tests proving text-mode compatibility, evidence
   suffix placement, format validation before I/O, and review clean-verdict
   compatibility.
4. Add failing pure-router and dispatch tests covering precedence, conflicts,
   conservative defaults, `--explain` non-execution, no shell construction,
   stdin ownership/ambiguity behavior, and option forwarding.
5. Add CLI help/registration tests before implementing the new command.

### Phase 2: minimum GREEN

1. Implement the strict pure marker planner.
2. Implement the smallest transaction helper that satisfies the failure and
   rollback tests; migrate `init` only.
3. Implement the shared evidence prompt suffix and thread it through CLI/MCP.
4. Implement the pure route decision and dependency-injected direct dispatch.
5. Register and document the public options and command.

### Phase 3: refactor and compatibility

1. Remove duplication only where tests prove shared behavior.
2. Verify no default prompts or outputs changed.
3. Verify no new runtime dependency was added.
4. Inspect all changed error paths and cleanup behavior.

## Verification matrix

Required focused checks:

```bash
node --test test/init.test.js test/atomic-write.test.js
node --test test/ask.test.js test/review.test.js test/mcp-handlers.test.js test/mcp-tools.test.js
node --test test/exec.test.js test/completion.test.js test/active-help-content-blocker.test.js
```

Required repository gates:

```bash
npm test
npm run lint
git diff --check origin/main...HEAD
```

Required manual CLI smoke checks with model calls replaced by test seams or
`--explain` where possible:

```bash
node bin/triss.js exec --explain --paths README.md "summarize this project"
node bin/triss.js exec --explain --review "review the current branch"
node bin/triss.js exec --explain --code "add a bounded validation"
node bin/triss.js ask --help
node bin/triss.js review --help
node bin/triss.js exec --help
```

## Review and repair gates

1. DeepSeek Free implements bounded packages first. If it fails to produce an
   auditable diff or stalls, retry with a smaller package, then use DeepSeek
   Flash through OpenCode Go.
2. After implementation and self-tests, run GLM 5.2 review with at least 16,384
   output tokens on bounded diffs. Verify every finding directly, fix confirmed
   defects, and repeat until the review returns an explicit clean verdict. An
   empty/no-verdict response is not approval.
3. Run independent GPT-5.6 Sol reviews on the latest exact HEAD. Fix confirmed
   defects and repeat on the new HEAD until no blocking or non-blocking concrete
   defects remain.
4. A green suite never overrides a demonstrated contract defect.

## Acceptance criteria

- Every public contract above is documented and covered by focused tests.
- Existing command behavior remains backward compatible by default.
- `triss init --target both` is preflighted and transactionally recoverable.
- `ask` and `review` evidence mode share one prompt contract across CLI and MCP.
- `triss exec --explain` is deterministic, side-effect free, and machine
  readable; normal dispatch does not use a shell.
- No new dependency, telemetry, secret exposure, automatic commit, PR, or merge
  is introduced.
- Focused tests, the full suite, lint, and `git diff --check` pass.
- GLM 5.2 and Sol reviews have explicit clean final verdicts on the final HEAD.

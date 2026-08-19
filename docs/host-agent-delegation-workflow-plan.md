# Host-Agent Delegation Workflow Plan

Status: implementation-ready for the workflow-guidance slice; expectation-gate publication is conditional on the capability gate in Phase 5

Base: `origin/main` at `80cf39eaa3065b360d3170f1e889786dc3acd213` (`v0.37.1`)

Branch: `codex/triss-agent-workflow-plan`

## Goal

Make Triss easier for host coding agents to use correctly and economically:

- the host agent owns request interpretation, architecture, authorization, task decomposition, and final acceptance;
- one Triss coder owns a normal implementation stream end-to-end: repository investigation, implementation, relevant tests, debugging, and self-verification;
- research-only work, browser/runtime investigation, and independent review are optional specialist lanes, not mandatory stages for every task;
- fresh, explicit task packets are preferred over implicit conversation continuity;
- cheap/default models handle bulk execution, while stronger review models are used only when the risk justifies them;
- reported completion is never accepted without checking the actual artifact and evidence.

This plan improves the CLI/MCP guidance and generated agent rules. It does not turn Triss into a persistent multi-agent team manager.

## User outcome

For a typical implementation request, the generated host-agent workflow should be:

```text
User request
  -> host agent understands the request and makes the plan
  -> host sends one complete task packet to one Triss coder
  -> coder investigates the repository
  -> coder implements
  -> coder runs relevant checks and debugs failures
  -> coder inspects its result and reports evidence
  -> host inspects the actual diff and evidence
  -> host makes the final decision and answers the user
```

The default must not become:

```text
researcher -> planner -> coder -> verifier -> reviewer
```

That longer chain is justified only when its stages are genuinely independent or materially improve confidence.

## Current verified state

### What already exists

- `templates/codex.md` and `templates/claude.md` define when bulk reads, web fetches, reviews, and implementation work should be delegated.
- `templates/codex-full.md` and `templates/claude-full.md` document `flash`/`pro`, provider selection, `triss coder`, isolation, sessions, and the result envelope.
- `src/commands/coder.js` installs a writable `coder` agent and a read-only `researcher` agent.
- `triss coder run` starts a separate coding runtime. A new run does not inherit the host conversation; continuity requires an explicit `--session` or `--continue` choice.
- `triss review` supports stronger one-shot review providers and evidence-format output.
- isolated coder runs report `files_changed`, `run_files_changed`, `diff_stat`, `worktree`, lifecycle facts, capabilities, usage, and warnings.
- the existing architecture already assigns architecture, authorization, and final acceptance to the expensive host agent.

### Gaps in the current guidance

- The nano templates explain *when* to delegate but do not describe the preferred one-host/one-coder implementation workflow.
- The full templates list commands and flags but do not define task ownership or discourage routine researcher/coder/reviewer chains.
- The coder template says to make the change and run tests "when the task calls for it"; it does not clearly assign repository research, debugging, final diff inspection, and unresolved-blocker reporting to the coder.
- There is no reusable task-packet format for passing the goal, plan, constraints, success criteria, validation, and approval boundaries through `--stdin` or MCP.
- Fresh runs versus deliberate session reuse are documented as mechanics, not as a context-hygiene policy.
- Browser/runtime investigation has no Triss implementation, but the documentation does not explicitly distinguish host browser tools from Triss capabilities.

### Confirmed expectation-contract drift

The public documentation currently advertises the unsupported command
`triss coder run --expect changes --isolate` (drift reference only — NOT a
runnable current command) and says that `--expect changes|analysis` applies
a deterministic expectation gate. The current public implementation does not
expose that contract:

- `bin/triss.js` does not declare `--expect` for `coder run`;
- `src/mcp/tools.js` has no expectation property in `triss_coder_run`;
- `src/mcp/handlers.js` does not accept or forward an expectation;
- `validateCoderRunOptions()` does not resolve an expectation;
- `runCoderRun()` always receives lifecycle output whose expectation is `either`.

The repository contains pure expectation machinery in `src/coder-result.js`, but it is not wired into the production coder paths.

There is also a deeper capability constraint: `deriveV2LifecycleFields()` currently reports `cleanup_status: "best_effort"` and `change_detection.status: "not_checked"` because Triss cannot claim complete descendant-tree ownership. Under the approved strict result matrix, a best-effort run cannot satisfy an explicit `changes` or `analysis` requirement. Merely adding a CLI flag would therefore expose a gate that can never truthfully succeed.

## Decisions

### D1. Keep Triss a delegator, not a team runtime

Do not add persistent named host agents, automatic worker-to-worker handoffs, project diaries, automatic fan-out, or a scheduler. Codex/Claude agent configuration remains owned by the host product.

### D2. Prefer one coder for one implementation stream

For small and medium implementation work, the host should send one complete plan to one coder. The coder performs the routine repository investigation and test/debug loop itself.

The host may split work only when the workstreams are independently executable and have explicit merge or handoff boundaries.

### D3. Keep specialists conditional

| Need | Preferred Triss route | Default use |
| --- | --- | --- |
| Bulk repository or official-page research without edits | `triss ask` / `triss fetch` | Only for research-only work or an independent research lane |
| Tool-using implementation | `triss coder run` / `triss_coder_run` | One coder owns the normal implementation stream |
| Independent diff review | `triss review` / `triss_review` | Only for complex, risky, security-sensitive, or regression-prone changes |
| Browser/runtime evidence | Host browser or DevTools capability | Outside Triss; never imply that `fetch` is browser automation |

### D4. Separate self-verification from final acceptance

The coder must run checks, debug failures, inspect its own result, and report evidence. The host must still inspect the actual diff and make the final acceptance decision. Model prose alone is never acceptance evidence.

### D5. Prefer fresh explicit context

Normal tasks use a fresh non-persistent coder run. The host passes a complete task packet explicitly, preferably via MCP structured input or `triss coder run --stdin` for long prompts.

Use `--session` only when continuation is intentional and the previous task context remains relevant. Do not use `--continue` as a general default.

### D6. Keep model routing host-agnostic

Do not hard-code Sol, Luna, Terra, or another host-vendor model into Triss templates. State the portable rule instead:

- primary/host model: architecture, authorization, difficult decisions, final acceptance;
- default/cheap worker: bulk reading and normal implementation;
- stronger worker/reviewer: difficult analysis or independent review when it materially improves confidence.

Do not recommend maximum reasoning for every delegated call. Model/effort changes should be justified by representative task quality, latency, and cost.

### D7. Do not publish a misleading expectation flag

The first delivery must make the current documentation truthful. The strict expectation gate may be published only after at least one supported execution path can satisfy it without weakening the existing cleanup and change-verification contract.

## Proposed task packet

Add this reusable shape to the full cookbook and README:

```text
Goal
- The concrete user-visible outcome.

Plan
- The implementation steps already decided by the host.

Constraints
- Scope boundaries, compatibility requirements, files or APIs that must not change.
- Approval boundaries: no commit, push, deploy, external write, or destructive action — commit is never delegated; the orchestrator collects and stages the diff itself.

Relevant context
- Known entry points, related files, prior findings, errors, or reference behavior.
- Include only context needed for this task; let the coder inspect the repository for the rest.

Success criteria
- Observable behavior that must work.
- Required regression cases and edge cases.

Validation
- Repository-native tests, lint, type checks, builds, or focused checks to run.
- State what to do if a check is unavailable.

Return
- Outcome.
- Files changed.
- Checks run and exact pass/fail state.
- Important diff or behavior evidence.
- Remaining blockers or unresolved risks.
```

CLI example:

```bash
triss coder run --stdin --isolate <<'TASK'
Goal
- Add the requested behavior.

Plan
- Follow the host-approved implementation steps.

Constraints
- Preserve existing public behavior outside the requested scope.
- Do not commit, push, deploy, or modify files outside this checkout.

Relevant context
- Known entry points, related files, prior findings, errors, or reference behavior.
- Include only context needed for this task; let the coder inspect the repository for the rest.

Success criteria
- Focused regression tests pass.
- The final diff contains only the requested change.

Validation
- Run the relevant repository-native focused tests.

Return
- Outcome, files changed, checks, and unresolved blockers.
TASK
```

The documentation must note that shell heredoc syntax is a user example; MCP callers should pass the same packet as the `prompt` string rather than constructing shell commands.

## Implementation phases

### Phase 1: Establish RED documentation and rendering tests

Add focused tests before changing templates.

#### `test/agent-help.test.js`

Assert that both Claude and Codex full cookbooks contain:

- a `Core workflow` section;
- the one-host/one-coder default;
- explicit wording that the coder owns repository research, implementation, tests, debugging, and self-verification;
- risk-based reviewer use;
- independent-workstream-only parallelism;
- fresh-task-packet guidance;
- host final acceptance;
- a browser/runtime boundary that does not claim browser automation for Triss.

#### `test/init.test.js`

Assert that nano output for both targets contains the compact workflow rule while staying bounded. Preserve the purpose of nano templates: the always-loaded block must remain short and direct users to `triss agent-help` for the complete packet and examples.

Add a size or line-count regression assertion only if the existing test suite already treats nano size as a stable contract; otherwise assert required phrases without inventing a brittle byte limit.

#### `test/coder-init.test.js`

Assert that newly scaffolded coder and researcher templates contain the updated ownership/boundary language. Preserve no-clobber behavior: existing user-edited agent files must not be overwritten.

### Phase 2: Update generated host-agent rules

#### Nano templates

Update:

- `templates/codex.md`
- `templates/claude.md`

Add a compact paragraph after the existing delegate/don't-delegate policy:

- host plans and makes final decisions;
- normal implementation goes to one coder with the complete plan;
- coder owns routine repository investigation, implementation, tests, debugging, and self-verification;
- do not automatically chain researcher, coder, and reviewer;
- use specialists and parallelism only when justified;
- prefer fresh explicit task packets.

Keep provider-specific details already present. Do not duplicate the long task packet in nano output.

#### Full templates

Update:

- `templates/codex-full.md`
- `templates/claude-full.md`

Add, in this order:

1. `Core workflow` with the normal host -> one coder -> host path.
2. A routing decision table for ask/fetch, coder, review, and host browser tools.
3. The reusable task packet.
4. Context/session policy: fresh non-persistent run by default (an unnamed run gets an engine/isolation-specific generated per-run session id and anonymity status; see the Release A matrix), explicit session reuse only when needed.
5. Final acceptance checklist based on the actual envelope, worktree, `git status`, and `git diff`.
6. A short section on independent parallel workstreams and explicit handoff boundaries.

Do not duplicate model/provider reference text already present elsewhere in the full templates; link the workflow section to it.

### Phase 3: Strengthen installed coder roles

Update `CODER_AGENT_TEMPLATE` in `src/commands/coder.js` so a newly installed coder is responsible for:

1. reading applicable repository instructions;
2. locating relevant files and existing patterns;
3. executing the complete scoped plan;
4. adding or updating focused tests when behavior changes;
5. running relevant allowed checks;
6. debugging failures caused by its change;
7. inspecting the final diff for accidental or unrelated edits;
8. reporting outcome, files, checks, and unresolved blockers truthfully.

Retain the existing hard boundaries:

- stay inside the assigned checkout;
- do not push or deploy;
- do not touch unrelated files;
- obey the deny-first command policy;
- do not claim checks passed unless they ran successfully.

Update `RESEARCHER_AGENT_TEMPLATE` only enough to clarify that it is a research-only specialist and is not a mandatory precursor to coder work. Keep `edit: deny` and `bash: deny` unchanged.

Do not overwrite existing generated agent files during `triss coder init`; the stronger templates apply to new scaffolds. Document how existing users can compare/update their local templates manually if needed.

### Phase 4: Align public documentation with the workflow

#### `README.md`

Add a short `Recommended host-agent workflow` section near the existing explanation that the expensive primary agent decides what to do and Triss performs delegated work.

Include:

- the normal one-coder route;
- the optional specialist routes;
- the task-packet example;
- fresh run/session guidance;
- final host acceptance;
- a link to `triss agent-help` for the generated cookbook.

#### Truthful expectation wording

Until Phase 5 passes its capability gate:

- replace the unsupported `--expect changes --isolate` recommendation in `README.md` with instructions to use `--isolate`, inspect `run_files_changed`, and verify the retained worktree/diff directly;
- add a current-version note to `docs/reliable-delegation-release-a.md` distinguishing the designed expectation contract from the v0.37.1 public CLI/MCP surface;
- ensure `docs/mcp.md` does not imply that `triss_coder_run` accepts an expectation field;
- do not silently rewrite the historical plan as if the missing adapter had never been specified.

The documentation should explicitly say that process completion, non-empty final text, and a model-authored success sentence are not task satisfaction.

### Phase 5: Restore the strict expectation adapter behind a capability gate

This is a separate, higher-risk implementation slice. It must not be bundled into the documentation/template patch merely because pure helper functions already exist.

#### 5.1 Capability prerequisite

Before exposing the flag, establish a supported path that can produce all facts required by `deriveCoderResultFacts()`:

- `cleanup_status: "verified"` rather than `best_effort`;
- `change_detection.status: "verified"` with a stable run comparison;
- no delayed descendant can mutate the retained result after the comparison;
- effective isolation and credential isolation meet the strict contract;
- analysis runs can prove a verified empty diff plus usable final text.

Do not redefine `best_effort` as `verified` and do not weaken the result matrix. If no platform/engine adapter can provide these facts, keep the public expectation flag unavailable and retain the truthful documentation from Phase 4.

Document the selected process-ownership adapter and its platform support before implementation. POSIX process-group polling alone is insufficient if descendants can escape the group.

#### 5.2 Public inputs

Once the prerequisite is met:

- add `--expect <changes|analysis|either>` to `coder run` in `bin/triss.js`;
- keep `either` as the compatibility default;
- add MCP input `expectation` with the same closed enum in `src/mcp/tools.js`;
- accept both the canonical MCP field and no undocumented aliases;
- forward it through `coderRunHandler()` in `src/mcp/handlers.js`;
- validate it before credentials, Git mutation, or engine spawn;
- preserve the existing `--isolate` tristate and provider/model validation.

#### 5.3 Run/result integration

In `src/commands/coder.js` and `src/coder-orchestration.js`:

- pass the resolved expectation into lifecycle derivation instead of hard-coding `either`;
- call `deriveCoderResultFacts()` from the normalized final run facts;
- emit `expectation`, `artifact_status`, `requirement_status`, and change-detection facts consistently for OpenCode, OpenCode 2, and Crush;
- preserve artifact evidence even when a requirement is unsatisfied;
- never infer success from `final_text` phrases;
- emit exactly one JSON envelope on every envelope-eligible path;
- apply a deterministic non-zero CLI result when an explicit expectation is `unsatisfied` or cannot be evaluated under the promised contract;
- preserve the envelope for MCP callers so they can inspect the exact requirement result rather than receiving only an unstructured thrown error.

Define the MCP error/return convention explicitly before coding. If the MCP framework cannot represent both structured evidence and a failed tool status, prefer returning the structured envelope with `requirement_status` over discarding evidence in an exception, and document the difference from CLI exit status.

#### 5.4 Expectation tests

Add `test/coder-expectation-cli.test.js` for:

- help exposes the closed enum and default;
- invalid values fail before credential lookup/spawn;
- default `either` preserves compatibility;
- `changes` succeeds only with verified non-empty run changes;
- `changes` fails on verified empty changes;
- `analysis` succeeds only with usable text and a verified empty diff;
- `analysis` fails on empty/whitespace output;
- best-effort or unavailable change detection never claims satisfaction;
- the envelope is printed exactly once before a non-zero expectation exit.

Extend `test/mcp-coder.test.js` for:

- schema enum exposure;
- handler forwarding;
- default omission behavior;
- structured unsatisfied/not-evaluated return behavior.

Extend integration/envelope tests for every engine path. Reuse the existing pure matrix coverage in `test/coder-result.test.js`; do not duplicate its entire truth table at the CLI layer.

### Phase 6: Verification and release gates

Run, at minimum:

```bash
node --test test/agent-help.test.js
node --test test/init.test.js
node --test test/coder-init.test.js
node --test test/mcp-coder.test.js
node --test test/coder-result.test.js
npm run lint
npm test
```

For the expectation slice, also run its new focused CLI test and the existing coder envelope/orchestration/process-supervisor suites.

Render and inspect both generated targets:

```bash
node bin/triss.js agent-help --target codex
node bin/triss.js agent-help --target claude
```

Use temporary HOME/project fixtures for `triss init` checks. Never run init against the developer's real global Codex/Claude configuration during automated validation.

Perform one bounded live smoke only after hermetic tests pass:

- one research-only call demonstrating the research route;
- one isolated implementation call with a fresh explicit task packet;
- one optional review of the actual resulting diff;
- expectation smoke only if Phase 5's capability prerequisite is met.

Empty, truncated, or reasoning-only provider output is unavailable validation, never approval.

## File-level change map

| File | Planned change |
| --- | --- |
| `templates/codex.md` | Compact one-host/one-coder routing and context policy |
| `templates/claude.md` | Same portable routing for Claude hosts |
| `templates/codex-full.md` | Core workflow, routing table, task packet, acceptance checklist |
| `templates/claude-full.md` | Same full workflow for Claude hosts |
| `src/commands/coder.js` | Stronger new coder/researcher templates; later expectation input/result wiring |
| `README.md` | Recommended workflow and truthful current expectation guidance |
| `docs/reliable-delegation-release-a.md` | Version note separating designed and currently exposed expectation surfaces |
| `docs/mcp.md` | Match actual MCP schema and later document expectation when shipped |
| `bin/triss.js` | Phase 5 CLI expectation option only after capability gate |
| `src/mcp/tools.js` | Phase 5 MCP expectation schema |
| `src/mcp/handlers.js` | Phase 5 expectation forwarding/result convention |
| `src/coder-orchestration.js` | Phase 5 lifecycle derivation from the resolved expectation |
| `src/coder-result.js` | Prefer reuse; change only if the approved truth matrix needs a proven correction |
| `test/agent-help.test.js` | Full cookbook workflow assertions |
| `test/init.test.js` | Nano workflow assertions |
| `test/coder-init.test.js` | Scaffolded role contract/no-clobber assertions |
| `test/mcp-coder.test.js` | Phase 5 schema and forwarding assertions |
| `test/coder-expectation-cli.test.js` | Phase 5 public CLI and exit/envelope contract |

## Compatibility requirements

- Existing `triss ask`, `fetch`, `review`, `chat`, and `coder run` defaults remain compatible.
- The default coder expectation remains `either`; no existing call becomes a strict gate implicitly.
- Existing user-edited `opencode.json`, `crush.json`, and agent templates are preserved.
- `triss init` continues to modify only its managed markers and preserves unrelated host rules.
- Nano rule growth stays small; full guidance remains on demand through `triss agent-help`.
- Provider selection and credential precedence do not change.
- No new provider key is required.
- No host-specific model or `fork_turns` configuration is written.
- No automatic commit, push, PR creation, merge, deployment, or external publication is added.

## Acceptance criteria

### Workflow-guidance slice

- Both host targets teach the same one-host/one-coder default.
- A normal implementation task no longer implies a mandatory researcher/reviewer chain.
- Coder ownership includes repository investigation, implementation, tests, debugging, and self-verification.
- Host ownership includes architecture, authorization, actual-diff inspection, and final acceptance.
- Research, review, parallelism, and browser/runtime work have clear conditional boundaries.
- Long task packets have a copy-pasteable CLI form and a clear MCP equivalent.
- Fresh runs are the default; session reuse is deliberate.
- Current docs no longer advertise a CLI/MCP expectation option that the shipped surface does not accept.
- Generated agent files remain no-clobber and unrelated configuration remains intact.
- Focused tests, lint, and the full suite pass.

### Expectation slice

- At least one supported engine/platform path can truthfully produce verified cleanup and verified stable change evidence.
- CLI and MCP accept the same closed expectation enum.
- Invalid expectation input fails before side effects.
- Explicit expectations produce deterministic structured outcomes.
- `changes` cannot pass without verified non-empty run changes.
- `analysis` cannot pass without usable text and a verified empty run diff.
- Best-effort execution never claims requirement satisfaction.
- Default `either` preserves prior behavior.
- Documentation, help, MCP schema, envelope fields, exit behavior, and tests agree exactly.

## Rollout order

1. Land the workflow-guidance and truthful-documentation slice.
2. Validate generated Codex and Claude rules in temporary projects.
3. Collect feedback on whether the one-coder default reduces unnecessary delegation chains and prompt overhead.
4. Complete the process-ownership/change-stability capability design.
5. Implement and ship the expectation adapter only if the strict capability gate passes.
6. Run a bounded live smoke and publish updated guidance in the next release notes.

## Explicit non-goals

- Creating or managing `~/.codex/agents/` or another host's named-agent directory.
- Configuring a host's default subagent model or conversation-fork policy.
- Enforcing a vendor-specific "no Sol subagent" rule inside Triss.
- Adding Chrome DevTools, browser screenshots, DOM inspection, or network capture to `triss fetch`.
- Automatic researcher/coder/reviewer chains.
- Automatic parallel fan-out.
- Worker-to-worker delegation or persistent team state.
- Weakening the reliable-delegation result matrix to make `--expect` appear functional.
- Treating provider prose, an engine zero exit code, or process completion as final task acceptance.

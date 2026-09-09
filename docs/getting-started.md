# Getting started

Triss is a local CLI and MCP server for managed delegation in AI development.
Use it for focused research, code review, or bounded implementation work while
you keep control of the provider, model, and execution engine. A host agent
still owns the plan, authorization, and final acceptance; inspect the returned
evidence and any diff before treating work as complete.

## 1. Install and verify

Triss requires Node.js **22.12.0 or newer**:

```bash
node --version
npm install -g triss-coworker
triss --version
triss status
```

If upgrading from a release before 0.42, migrate the old configuration before
running model-backed commands, then restart MCP hosts and agent sessions:

```bash
triss migrate
triss status
```

## 2. Choose how Triss should run

### With a host agent

Run the guided setup:

```bash
triss config wizard
```

Easy is the default path, and it opens directly. Pick any canonical provider
(`openai-compatible`, `zai`, `opencode-zen`, `opencode-go`, `moonshot`,
`kimi-for-coding`), paste its credential, and choose whether to wire Triss
into **Claude**, **Codex**, **Both**, or to skip host wiring. The summary
before apply shows exactly what will be written, and the run ends with a
first command to try. Rerunning the wizard reuses your existing
configuration instead of resetting it. Choose the global or project scope
when prompted; Codex MCP registration is global, while Claude can use
`./.mcp.json` for a project-local setup.

Everything else is one flag away. **Advanced** exposes the full tuning
sections — providers, execution (engine, effort, credential protection),
connections (MCP and rules, selectable independently), integrations, and
runtime:

```bash
triss config wizard --advanced
```

A target argument configures a single piece instead of the whole setup, and
non-interactive shells apply a complete configuration headlessly from
existing files, the environment, and explicit flags:

```bash
triss config wizard zai
triss config wizard coder
triss config wizard --yes --agent none
```

You can also install the two host-facing pieces explicitly. `mcp install`
registers the server; `init` writes the rules fallback:

```bash
triss mcp install --target claude --global
triss init --target claude --global
```

Use `--target codex` or `--target both` as appropriate, and restart the host
session after installation.

### Terminal only

No host integration is required. Set the profile fields globally; omitting the
value makes `config set` prompt (and masks secret fields):

```bash
triss config set -g TRISS_OPENAI_COMPATIBLE_BASE_URL
triss config set -g TRISS_OPENAI_COMPATIBLE_API_KEY
triss config set -g TRISS_OPENAI_COMPATIBLE_MODEL
triss config set -g TRISS_OPENAI_COMPATIBLE_SMALL_MODEL
triss status
```

`openai-compatible` is a configurable profile, not a provider detector: its
built-in endpoint is `https://api.deepseek.com/v1`. Set the base URL
explicitly when using another compatible endpoint. These commands edit profile
fields; they do not reset an existing default provider or engine. Check that
`triss status` shows the endpoint, credential, and defaults you intend; use
`triss config wizard --advanced` if you need to change them. For headless
use, interactive prompts do not apply — assemble a complete configuration
with `triss config wizard --yes` instead.


Advanced provider and engine fields are documented in
[configuration.md](configuration.md). Explicit `--provider`, `--model`, and
`--engine` options override the configured defaults for one command.

## 3. Run a first useful task

From a project containing `README.md`, pass the file and a specific question:

```bash
triss ask --paths README.md \
  --question "What does this project do, and which setup steps does its README require? Cite the relevant lines."
```

Inspect the answer against the file. For a review, use `triss review` with a branch, PR, selected files, or an
explicit piped diff. For implementation, send a complete bounded task and
inspect the actual files and diff returned by the run. Start with the workflow
guides:

- [Research workflow](https://triss.work/workflows/research/)
- [Review workflow](https://triss.work/workflows/review/)
- [Implementation workflow](https://triss.work/workflows/implementation/)

## Data and trust

Model-backed commands send the prompt and the files, URLs, or diff you
explicitly select to the configured provider. Integrations send their request
payloads to the configured service. Triss has no developer telemetry, but it
does perform a credential-free passive update check unless you set
`TRISS_UPDATE_CHECK=0`. Review a provider's retention, training, residency,
and access policies before sending confidential material; Triss cannot enforce
those external policies.

Results are evidence for your decision, not an automatic approval. Inspect
files, diffs, and relevant checks yourself. Worktree isolation for coder runs
separates the working copy; it does not prevent all writes outside that copy
and is not an OS-level sandbox. Cost and quality depend on your provider, model,
engine, workload, and choices; savings are not guaranteed.

See [data-flows.md](data-flows.md) and [security-model.md](security-model.md)
for the detailed data and trust boundaries.

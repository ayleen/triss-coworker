# Configuration

Triss reads its credentials from `.env` files. **You should never need to
create or edit those files by hand** — `triss config` handles everything.

## TL;DR

```bash
triss config wizard         # interactive setup, prompts for every credential
triss status                # verify what's loaded and from where
```

That is the entire happy path.

---

## Where credentials live

Triss looks at two files, in this precedence order (highest first):

| Scope     | Path                              | Purpose                                             |
| --------- | --------------------------------- | --------------------------------------------------- |
| `process.env` | exported in your shell        | Always wins. Use for CI / one-off overrides.        |
| `local`   | `<project>/.triss.env`            | **Per-project** credentials. Overrides global here. |
| `global`  | `~/.config/triss/.env`            | Default for every project.                          |

**Same project, different Jira instances?** Put the org-wide DeepSeek key in
the global file, and the project-specific Jira `ATLASSIAN_*` triple in
`./.triss.env` for that repo. When you `cd` into another repo with its own
`.triss.env`, Triss automatically uses *that* repo's credentials. The
global Jira credentials (if any) keep working everywhere else.

`.triss.env` is auto-`chmod 600` and auto-added to that project's
`.gitignore` (if a `.gitignore` or `.git` exists). It is intentionally a
different filename from the more common `.env` so it never collides with
your application's own `.env`.

---

## `triss config` reference

### `triss config wizard [target]`

Interactive prompt-driven setup.

When invoked **without a target**, the first question is **Standard vs
Advanced**:

| Mode      | What it asks                                                             | Use when                                  |
| --------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| Standard  | API key + one worker-model name (written to both `flash` & `pro`)        | You just want it to work. Default.        |
| Advanced  | Every variable for every integration, with confirm-before-each provider  | You need Jira/Linear, separate presets, custom base URL |

```bash
triss config wizard                       # asks Standard / Advanced first
triss config wizard --standard            # straight into Standard
triss config wizard --advanced            # straight into Advanced
triss config wizard linear                # targeted: only Linear, no mode prompt
triss config wizard linear --local        # targeted, project-local
triss config wizard --advanced --force    # re-prompt for already-set keys
```

Behaviour:

- Asks "Global or Project?" up front (skip with `--global` / `--local`).
- Standard mode never asks about non-core integrations — run
  `triss config wizard --advanced` (or a targeted invocation) later when
  you actually need Jira/Linear.
- Advanced mode asks "Configure jira? (y/N)" before each non-core
  provider so you only walk through the ones you use.
- Skips already-set values unless `--force`.
- Masks secret inputs (anything matching `*KEY*`, `*TOKEN*`, `*SECRET*`,
  `*PASS*`).
- Uses every integration's `envVars` declaration — when you add a new
  integration, the Advanced wizard picks up its variables for free.

### `triss config set <KEY> [value]`

Set a single variable.

```bash
triss config set DEEPSEEK_API_KEY                    # interactive masked prompt → global
triss config set ATLASSIAN_API_TOKEN --local         # interactive → project
triss config set DEEPSEEK_FLASH_MODEL deepseek-chat  # value as argument → global
echo "$KEY" | triss config set LINEAR_API_KEY -      # read from stdin (CI-friendly)
```

### `triss config get <KEY>`

```bash
triss config get DEEPSEEK_API_KEY        # → "global  sk-d…294"  (masked)
triss config get DEEPSEEK_API_KEY --local
```

Exits with code 1 if the key is missing.

### `triss config list [--global|--local]`

Lists every variable in each env file, with masking on secrets.

### `triss config path [--global|--local]`

Prints the absolute path(s) Triss will use, with `exists` / `missing`.

### `triss config edit [--global|--local]`

Opens the env file in `$VISUAL` → `$EDITOR` → `vi`. Without a flag, asks
which file you mean.

### `triss config unset <KEY> [--global|--local]`

Removes a variable.

---

## Known credentials

`triss config wizard` knows about:

| Target     | Variables                                                                | Required                                  |
| ---------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| `deepseek` | `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `DEEPSEEK_FLASH_MODEL`, `DEEPSEEK_PRO_MODEL` | only `DEEPSEEK_API_KEY` is required |
| `jira`     | `ATLASSIAN_BASE_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`           | all three                                 |
| `linear`   | `LINEAR_API_KEY`, `LINEAR_API_URL`                                       | only `LINEAR_API_KEY` is required         |

When you add a new integration (see [extending.md](extending.md)), its
`envVars` declaration is automatically picked up — no wizard changes needed.

---

## Troubleshooting

**"No DeepSeek API key found"** — `triss config wizard deepseek`.

**Wrong credentials picked up** — `triss status` shows the source for each
variable in `[global]` / `[local]` / `[env]` brackets. If you expected
project-local to win and it didn't, check that the file is named exactly
`.triss.env` (not `.env`) in your project root, and that you ran the
command from that directory.

**Switching organisations / Jira instances** — drop a `.triss.env` in the
project root with the project-specific keys; nothing else needs to change.

**Enabled an integration after `triss init`** — the agent's CLAUDE.md is
re-rendered on every `triss init`, including only integrations whose
required env vars are set. Run `triss init` again and your new
integration's delegation rules will appear in the file.

**CI** — set the variables as environment variables directly. `process.env`
wins over both files.

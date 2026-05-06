# Linear

Backed by the Linear GraphQL API.

## Configuration

```bash
triss config wizard linear             # global ~/.config/triss/.env
triss config wizard linear --local     # this project only (./.triss.env)
```

Variables Triss recognises:

```
LINEAR_API_KEY=lin_api_...
LINEAR_API_URL=https://api.linear.app/graphql   # optional override
```

Get a personal API key at <https://linear.app/settings/api>.

For per-project setups (different Linear teams per project), see the
[recipes in docs/configuration.md](../configuration.md#recipes--common-setups-end-to-end).

## Commands

```bash
# Full-text search (Linear's native search endpoint).
triss linear search "auth bug" --question "Which are still open and assigned?"

# Read by identifier (TEAM-42) or UUID.
triss linear issue ENG-42 --with-comments --question "What is the latest status?"

# Update — any subset.
triss linear update ENG-42 \
  --title "New title" \
  --description "Markdown body OK here." \
  --priority 2 \
  --state "In Review"

# Create — --project links to a Project, --parent makes a sub-issue.
triss linear create \
  --team ENG \
  --title "Refactor auth middleware" \
  --description "Background…" \
  --project 4f3e1c5a-... \
  --priority 2

triss linear create \
  --team ENG \
  --title "Sub-task: write tests" \
  --parent ENG-42

# Comments.
triss linear comments ENG-42 --question "Any unanswered questions?"
triss linear comments ENG-42 --post "I'll grab this."

# States — list a team's workflow states, or apply one.
triss linear states ENG
triss linear states ENG --apply "In Progress" --issue ENG-42

# Attachments.
triss linear attachments ENG-42
```

## "Epic" mapping

Linear has two distinct hierarchy concepts; pick the one your team uses:

| Linear concept | Triss flag        | Meaning                                  |
| -------------- | ----------------- | ---------------------------------------- |
| Project        | `--project <id>`  | Group several issues under a Project     |
| Sub-issue      | `--parent <id>`   | Make this issue a child of another issue |

If your workspace uses *Initiatives* on top of Projects, set the project
through `--project` and manage the Initiative link in the Linear UI — Triss
does not expose Initiatives yet.

## Identifier vs UUID

Most read commands accept both the human identifier (`ENG-42`) and the
GraphQL UUID. Mutations that take an `--issue`/`--parent` argument also
accept either form — Triss resolves identifiers via `issue(id:)` first.

## Description formatting

Linear stores descriptions as raw markdown, so Triss passes your `--description`
input through verbatim.

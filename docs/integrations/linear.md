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
  --state "In Review" \
  --due-date 2025-08-15

# Create — --project links to a Project, --parent makes a sub-issue.
triss linear create \
  --team ENG \
  --title "Refactor auth middleware" \
  --description "Background…" \
  --project 4f3e1c5a-... \
  --priority 2 \
  --assignee jane@acme.com \
  --labels bug,legal \
  --milestone <milestone-uuid>

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

# Projects, initiatives, and milestones.
triss linear project-list ENG
triss linear project-create --team ENG --name "Q3 Backend" \
  --start-date 2025-07-01 --target-date 2025-09-30
triss linear initiative-list
triss linear milestone-list <project-uuid>
triss linear milestone-create --project <project-uuid> \
  --name "Alpha" --target-date 2025-08-15

# Labels.
triss linear label-list ENG

# Bulk operations.
triss linear bulk-update \
  --ids ENG-5,ENG-6,ENG-7 \
  --milestone <uuid> \
  --due-date 2025-09-30
```

## "Epic" mapping

Linear has two distinct hierarchy concepts; pick the one your team uses:

| Linear concept    | Triss flag          | Meaning                                   |
| ----------------- | ------------------- | ----------------------------------------- |
| Project           | `--project <id>`    | Group several issues under a Project      |
| Project milestone | `--milestone <id>`  | Pin the issue to a milestone (Gantt diamond) |
| Sub-issue         | `--parent <id>`     | Make this issue a child of another issue  |
| Initiative        | (UI only)           | Roll up multiple Projects under a roadmap |

`--milestone` requires the milestone UUID — get it from `triss linear
milestone-list <project-uuid>`. Use `triss linear milestone-create` to
add new ones for Gantt key dates.

## Gantt dates

Linear's GraphQL API exposes only `dueDate` (TimelessDate `YYYY-MM-DD`) on
the issue level — there is **no input field for a planned start date**.
`--due-date` sets the right edge of the Gantt bar; the left edge uses the
read-only `startedAt`, which Linear auto-populates when the workflow
state transitions to "started". For an explicit start anchor before work
begins, attach the issue to a project milestone with `--milestone` —
milestones render as diamonds on the Gantt and accept `--target-date`.

If you need to override `startedAt` retroactively, that has to happen
via the Linear UI; the GraphQL `IssueUpdateInput` does not accept it
(verified via introspection — see `test/linear-integration.test.js`).

## Assignees and labels

`--assignee` accepts a UUID, email, or display name — Triss resolves names
to UUIDs via `users(filter:)`. `--labels` is comma-separated, mixing UUIDs
and label names freely. On `update`, `--labels` REPLACES the existing label
set; pass `--labels ''` (empty) to clear all labels, or omit `--labels`
entirely to leave the existing set untouched. Use `triss linear
label-list ENG` to discover names and UUIDs.

## Bulk update

`triss linear bulk-update --ids ENG-1,ENG-2,…` applies the same field
changes to many issues in one call (parallel, bounded by `--concurrency`,
default 5). Returns one line per issue with `✓` or `✗ <reason>` so a
single failure does not abort the rest. Use it for retroactive bucketing
into a milestone or moving a batch of issues onto a new project.

## Identifier vs UUID

Most read commands accept both the human identifier (`ENG-42`) and the
GraphQL UUID. Mutations that take an `--issue`/`--parent` argument also
accept either form — Triss resolves identifiers via `issue(id:)` first.

## Description formatting

Linear stores descriptions as raw markdown, so Triss passes your `--description`
input through verbatim.

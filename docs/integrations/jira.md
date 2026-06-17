# Jira (Atlassian Cloud)

Backed by the Jira REST API v3.

## Configuration

The easy way:

```bash
triss config wizard jira             # global ~/.config/triss/.env
triss config wizard jira --local     # this project only (./.triss.env)
```

Both prompts ask for:

```
ATLASSIAN_BASE_URL=https://yourorg.atlassian.net
ATLASSIAN_EMAIL=you@example.com
ATLASSIAN_API_TOKEN=ATATT...
```

Get a token at <https://id.atlassian.com/manage-profile/security/api-tokens>.
Verify with `triss status` — the `jira` row should be green and the
ATLASSIAN_* lines should show a `[local]` or `[global]` source tag.

**Different Jira instances per project?** Use `--local` in each project
root. The MCP server picks up whichever `.triss.env` is in your current
working directory; a worker on `~/proj-a` hits proj-a's Jira, a worker
on `~/proj-b` hits proj-b's. See the [recipes in docs/configuration.md](../configuration.md#recipes--common-setups-end-to-end)
for the full step-by-step.

## Commands

```bash
# Search via JQL — large result sets get summarised when you pass --question.
triss jira search "project = TRISS AND status = 'In Progress'" \
  --question "Which issues are blocked? Group by assignee."

# Read a single issue (without --question prints the full body).
triss jira issue TRISS-123 --with-comments \
  --question "What changed in the description over the last week?"

# Update — any combination of fields and a status transition in one shot.
triss jira update TRISS-123 \
  --summary "Better title" \
  --description "Plain text body. Blank lines split paragraphs." \
  --status "In Review"

# Create + link to an epic (auto-detects the right mechanism).
triss jira create \
  --project TRISS \
  --type Task \
  --summary "Implement DeepSeek caching" \
  --description "Detailed body here." \
  --parent TRISS-100

# Comments — list, summarise, or post.
triss jira comments TRISS-123 --question "Has anyone asked about scope?"
triss jira comments TRISS-123 --post "I'll take this — picking up tomorrow."

# Status transitions — list the names then apply.
triss jira transitions TRISS-123
triss jira transitions TRISS-123 --apply "In Progress"

# Attachments.
triss jira attachments TRISS-123

# Who am I? Prints your accountId — the value --assignee / create --assignee want.
triss jira whoami
```

## Epics

Modern Jira projects link issues to an epic via the standard `parent`
field. Older / company-managed projects keep the link in a custom field
(usually `customfield_10014`, the *Epic Link*). `triss jira update --parent`
and `triss jira create --parent` try the modern path first and fall back to
the custom field automatically — no flag needed.

## Description formatting (ADF)

Jira stores descriptions as Atlassian Document Format (ADF), a JSON tree.
Triss converts on the fly:

- Reading: ADF → light markdown (headings, bullets, code, links).
- Writing: plain text → minimal ADF. Blank lines start new paragraphs;
  single newlines become hard breaks. Markdown syntax in your input is
  not parsed — passes through as text.

If you need richer formatting (tables, panels, embedded media), use the
Jira UI — Triss intentionally keeps the converter small.

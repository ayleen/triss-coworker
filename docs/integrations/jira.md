# Jira (Atlassian Cloud)

Backed by the Jira REST API v3.

## Configuration

Add to `~/.config/triss/.env`, your shell profile, or the project's `.env`:

```
ATLASSIAN_BASE_URL=https://yourorg.atlassian.net
ATLASSIAN_EMAIL=you@example.com
ATLASSIAN_API_TOKEN=ATATT...
```

Get a token at <https://id.atlassian.com/manage-profile/security/api-tokens>.
Verify with `triss status` — the `jira` row should turn green.

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

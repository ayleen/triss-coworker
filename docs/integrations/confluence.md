# Confluence (Atlassian Cloud)

Backed by the Confluence REST API v2, with CQL search via the
older `/wiki/rest/api/search` endpoint.

## Configuration

Confluence reuses the **same Atlassian credentials** as
[`triss jira`](jira.md):

```
ATLASSIAN_BASE_URL=https://yourorg.atlassian.net
ATLASSIAN_EMAIL=you@example.com
ATLASSIAN_API_TOKEN=ATATT...
```

If you've already configured Jira, Confluence is automatically ready —
both integrations show as `✓ ready` in `triss status`.

## Commands

```bash
# CQL search across the whole instance
triss confluence search "type = page AND space = ENG AND text ~ 'auth'" \
  --question "which page is the canonical one for OAuth setup?"

# Read a page (ADF body is converted to readable text on the way out)
triss confluence page 12345 --question "summarise the migration plan"

# Create — minimal text body, paragraphs split on blank lines
triss confluence create \
  --space ENG \
  --title "Auth refactor — RFC" \
  --body "Background paragraph one.\n\nBackground paragraph two."

# Create as a child of an existing page
triss confluence create --space ENG --title "..." --body "..." --parent 23456

# Update title and/or body (version is bumped automatically)
triss confluence update 12345 --title "Auth refactor — RFC v2" --body "..."

# List spaces (id, key, name) — useful when you only know the human key
triss confluence spaces
```

## Body formatting

- **Reading**: Triss requests `body-format=atlas_doc_format` and converts
  the ADF JSON to plain text using the same Markdown-style converter as
  Jira. Headings, bullet lists, code blocks, links, and basic inline
  formatting come through; tables and panels are flattened.
- **Writing**: `--body` is plain text. Each blank line starts a new
  `<p>`; single newlines become `<br/>`. For richer formatting (panels,
  tables, embeds) edit the page in the Confluence UI afterwards.

## Cost considerations

Confluence pages can be huge. Always pass `--question` for read calls
unless you actually need the full body — the question summarises before
results land in the agent's context.

```bash
triss confluence page 12345                           # full body — careful
triss confluence page 12345 --question "what's…?"     # summary, much cheaper
```

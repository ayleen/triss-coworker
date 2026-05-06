# GitHub Issues

Backed by the GitHub REST API.

## Configuration

```bash
triss config wizard github             # global ~/.config/triss/.env
triss config wizard github --local     # this project only (./.triss.env)
```

Variables Triss recognises:

```
GITHUB_TOKEN=ghp_…   # personal access token with `repo` (or `public_repo`) scope
```

Get a token at <https://github.com/settings/tokens>.

### `gh` CLI fallback

If `gh` (the official GitHub CLI) is logged in but `GITHUB_TOKEN` is
unset, Triss runs `gh auth token` once at startup and uses that token.
You'll see the variable show up as `[env]` in `triss status` even though
you never exported it. To opt out, just `export GITHUB_TOKEN=…` with
your own value.

### Repo auto-detection

Most subcommands take an issue number and infer the repo from
`git remote get-url origin` of the current working directory. Both
HTTPS and SSH origin URLs are recognised. Override explicitly with
`--repo owner/name` when needed (e.g., calling cross-repo).

## Commands

```bash
# Search (full GitHub search syntax — same as github.com)
triss github search "is:issue is:open repo:owner/x" \
  --question "which are stale (no activity 30d)?"

# Read a single issue (auto-detects repo from origin)
triss github issue 42 --with-comments \
  --question "what's the latest status?"

# Cross-repo
triss github issue 42 --repo owner/name

# Create
triss github create --title "..." --body "..." --labels bug,priority:high

# Update — close, retitle, relabel, etc.
triss github update 42 --state closed
triss github update 42 --labels "wontfix"
triss github update 42 --assignees alice,bob

# Comments — list, summarise, or post
triss github comment 42 --question "any unanswered questions?"
triss github comment 42 --post "Looking into this — should have a fix by Friday."
```

## Linked tickets in `triss review`

`triss review` parses ticket keys like `PROJ-42` from the branch name or
PR title. GitHub doesn't use that format, so by default review only
auto-links Jira/Linear tickets — not GitHub issue numbers. If you'd
like that, open an issue and we can add a regex for `(repo)#42` or
`fixes #42`.

## Permission scope

The token only needs `repo` (private repos) or `public_repo` (public
only). Triss never modifies workflows, releases, or settings — only
issue read/write.

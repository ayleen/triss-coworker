# GitLab

Backed by the GitLab REST API v4. Works with `gitlab.com` out of the
box and any self-hosted GitLab via `GITLAB_URL`.

## Configuration

```bash
triss config wizard gitlab            # global ~/.config/triss/.env
triss config wizard gitlab --local    # this project only (./.triss.env)
```

Variables Triss recognises:

```
GITLAB_TOKEN=glpat-…           # required, scope: api
GITLAB_URL=https://gitlab.com  # optional override (self-hosted)
```

Token: <https://gitlab.com/-/profile/personal_access_tokens> (scope `api`).
For self-hosted: `https://your-gitlab.example.com/-/profile/personal_access_tokens`.

## Project auto-detection

Most subcommands accept an issue IID and infer the project from
`git remote get-url origin` of the current working directory. Both
SSH (`git@gitlab.example.com:foo/bar.git`) and HTTPS
(`https://gitlab.example.com/foo/bar.git`) origins are recognised.
Override explicitly with `--project namespace/name` when needed.

## Commands

```bash
# Search (across all visible projects, or scoped to one)
triss gitlab search "performance" --question "which are open and assigned to me?"
triss gitlab search "..." --project mygroup/myproject

# Read a single issue (auto-detects project from origin)
triss gitlab issue 42 --with-comments --question "what's the latest blocker?"

# Cross-project
triss gitlab issue 42 --project othergroup/otherrepo

# Create
triss gitlab create --title "..." --body "..." --labels "bug,priority::high"

# Update — close, retitle, relabel
triss gitlab update 42 --state closed
triss gitlab update 42 --labels "wontfix,duplicate"

# Notes (GitLab calls comments "notes")
triss gitlab comment 42 --question "any unresolved questions?"
triss gitlab comment 42 --post "Reproduced — looking into the cache layer."
```

## Self-hosted

```bash
triss config set GITLAB_URL https://gitlab.example.com --local
triss config set GITLAB_TOKEN glpat-... --local
```

`--local` keeps the self-hosted credentials scoped to that one project,
so other repos still hit `gitlab.com` (or whichever default you've set
globally).

## Linked tickets in `triss review`

GitLab issue references in the form `#42` aren't currently auto-linked
in `triss review` — only `PROJ-42`-style Jira/Linear keys are. If you
want GitLab integration here, file an issue and we'll add the regex.

# Releasing

Releases are cut from `main` and published by the tag-triggered
[publish pipeline](../.github/workflows/publish.yml). This page documents
the maintainer-side procedure, the one-time GPG signing setup, and the
safe-retry (retag) rules.

## One-time signing setup

Release tags must be annotated and GPG-signed. The publish pipeline fails
closed when a tag is unsigned, lightweight, or signed by a key that is not
committed in the repository.

1. Generate a dedicated signing key (or reuse an existing one):

   ```bash
   gpg --full-generate-key
   # RSA and RSA, 4096 bits, a uid like "Triss releases <you@example.com>"
   ```

2. Configure git to use the key and to sign new tags by default:

   ```bash
   git config --global user.signingkey <KEYID>
   git config --global tag.gpgSign true
   ```

3. Export the public half into the repository and commit it — CI imports
   this file before verifying release tags:

   ```bash
   mkdir -p .github/keys
   gpg --armor --export <KEYID> > .github/keys/release-tag-signing.asc
   ```

The committed public key is protected by review and git history. Rotating
the signing key means replacing this file in a PR first, then signing the
next release with the new key.

## Keep public descriptions synchronized

When positioning or onboarding changes, update `README.md`, the packaged
quickstart and MCP documentation, `templates/`, and the website together.
`package.json.description` is also the CLI help description; use the same
short description for GitHub About. Keep README links absolute so they work
on both GitHub and npm. Do not maintain a separate npm README.

GitHub About, topics, and any custom social preview are repository settings,
not files. Verify them separately. Merging to `main` updates the GitHub README
and triggers the Cloudflare production build; npm metadata and README change
only after a new package version is published.

For the version-bump PR, align the root and companion package versions and
lockfile, update the companion README's install command/version table, and
record its newly packed tarball's SHA-256 and SHA-512 in the matching
`CHANGELOG.md` release entry. Never rewrite historical artifact hashes.
Run `npm run check` and the site checks before merging.

After publication, verify GitHub About and README, the production workflow
links, and `npm view triss-coworker version description dist-tags --json`.
Inspect the registry README as well: a successful push alone does not mean
all public surfaces have updated.

## Cutting a release

After the version-bump PR is merged into `main`:

```bash
git checkout main
git pull --ff-only
VERSION="$(node -p "require('./package.json').version")"
git tag -s "v${VERSION}" -m "triss-coworker v${VERSION}"
git push origin "v${VERSION}"
```

Pushing the tag triggers the publish pipeline: the full test and bundle
matrix, the standalone artifact build, tag-signature verification, and npm
publication with provenance attestations.
Instructions for users to verify what was published — provenance,
checksums, and the tag signature — live in
[verifying-releases.md](verifying-releases.md).

## Retag (safe retry)

Tags are protected by repository rules; deleting one requires maintainer
permission. Only retag when the publish plan authorizes a retry (nothing
published yet, or a partially published set that the planner can complete):

1. Delete the remote and local tag:
   `git push origin :refs/tags/v<VERSION> && git tag -d v<VERSION>`
2. Re-create it signed against the same commit (or the corrected one on
   `main`), exactly as in *Cutting a release*.
3. Push the tag again. The pipeline re-plans from live registry state.

Never force-move a published version's tag to a different commit.

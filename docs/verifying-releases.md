# Verifying releases

How to check that a Triss release you downloaded is authentic and intact.
Every official release ships three verifiable artifacts: the npm package
with a Sigstore provenance attestation, the standalone bundle with a sha256
checksum, and the GPG-signed `vX.Y.Z` git tag that identifies the release
author.

## npm package

The `triss-coworker` package is published through an OpenID Connect–backed
workflow with `--provenance`. To verify:

1. Check the **Provenance** section on
   [the npm package page](https://www.npmjs.com/package/triss-coworker) —
   it must tie the version to the building workflow run and commit.
2. Verify the attestation locally against the registry:

   ```bash
   npm provenance verify triss-coworker@<version>
   ```

3. npm itself enforces content integrity: the `dist.integrity` sha512 for
   the version must match what `npm install` fetched (any mismatch fails
   the install).

## Standalone bundle

Releases carry `triss-coworker-<version>-standalone.ndjson.gz` and the
matching `triss-coworker-<version>-standalone.sha256`:

```bash
curl -fsSLO https://github.com/ayleen/triss-coworker/releases/download/v<version>/triss-coworker-<version>-standalone.sha256
sha256sum -c triss-coworker-<version>-standalone.sha256
```

The in-place updater (`triss update --apply`) performs the same
receipt-backed integrity and inventory checks before activating anything;
manual verification above is for first installs or audits.

## Release author (tag signature)

Release tags are annotated and signed with the GPG key whose public half is
committed in the repository — anyone can verify that a release was made by
the project's maintainer, not someone with push access to a mirror:

```bash
git clone https://github.com/ayleen/triss-coworker.git && cd triss-coworker
git fetch --tags
gpg --import .github/keys/release-tag-signing.asc
git verify-tag v<version>
```

`git verify-tag` must report a good signature; the GitHub Release page
additionally shows the *Verified* badge on the tag. If verification fails,
treat the artifacts as untrusted and report it through
[SECURITY.md](https://github.com/ayleen/triss-coworker/blob/main/SECURITY.md#reporting-vulnerabilities).

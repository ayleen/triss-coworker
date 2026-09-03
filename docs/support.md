# Support policy

## Scope and duration

Triss is pre-1.0 and ships fast, so support is deliberately narrow:

- **The latest release line is the only supported line.** Each `vX.Y.Z`
  release is supported from publication until the next release is
  published — including bug and security fixes.
- **There is no LTS stream during 0.x.** Older minors do not receive
  backports; fixes land on `main` and ship in the next release.
- **Breaking changes** are called out in
  [CHANGELOG.md](https://github.com/ayleen/triss-coworker/blob/main/CHANGELOG.md)
  under the release that introduces them, together with the migration note
  (see also [deprecations.md](deprecations.md) for phased removals).

## Security updates and end of life

- Security fixes are released as part of the next regular version (patch
  or minor), coordinated per the disclosure timetable in
  [SECURITY.md](https://github.com/ayleen/triss-coworker/blob/main/SECURITY.md#reporting-vulnerabilities).
- **A version stops receiving security updates the moment its successor is
  published.** There is no overlap window: upgrade to the latest release to
  stay within support.
- `npm update -g triss-coworker` (or `triss update --apply` for standalone
  installs) moves you onto the supported line; the update path is
  integrity-checked end to end (see
  [verifying-releases.md](verifying-releases.md)).

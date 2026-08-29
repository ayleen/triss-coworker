# Update notification and standalone self-update system

Status: implementation plan for a release after v0.31.1.

## Objective

Triss must tell an active user when a newer stable release is available even
when the user never runs an update command. Version discovery must not require
an `npm` executable. Applying an update remains an explicit operation and must
never overwrite an installation owned by npm, pnpm, yarn, npx/dlx, a source
checkout, or the legacy git-based installer.

The system has three separate responsibilities:

1. discover a complete, installable stable release;
2. notify interactive CLI and long-running MCP users without corrupting command
   or protocol output;
3. update only a receipt-backed standalone installation after explicit user
   confirmation.

Each responsibility must remain useful when either of the later responsibilities
is unavailable. In particular, notification works for every installation type,
while self-update is deliberately narrower.

## Verified current state

The plan is based on `origin/main` at
`a2ac2e6fd03f1f26ea19857ecac6bb1bd7d8e8a9` (`v0.31.1`). At that revision:

- `package.json` is the CLI and MCP version source and requires Node.js 22 or
  newer;
- `bin/triss.js` is the npm binary and reserves stdout for command output;
- the documented install methods are npm, pnpm, yarn, npx/dlx, the bash
  installer, and a linked source checkout;
- `install.sh` clones or pulls a git checkout under
  `~/.local/share/triss-coworker`, runs `npm install --omit=dev`, and links its
  `bin/triss.js` into `~/.local/bin`;
- `install.sh` accepts Node.js 18 even though the actual CLI rejects versions
  below 22;
- `.github/workflows/publish.yml` runs its test job only on Node 24, validates a
  tag, and publishes only to npm;
- the MCP server declares only the `tools` capability and writes its startup
  diagnostics to stderr;
- the pinned MCP SDK exposes the `logging` server capability and
  `Server.sendLoggingMessage()`;
- Triss already uses `~/.cache/triss` for non-secret usage metadata.

Consequently, the existing installer is not an npm-independent distribution
path. A real npm-free update requires a separately published artifact that
already contains all production dependencies.

## Scope

This change includes:

- automatic stable-release checks for active CLI and MCP users;
- a bounded local cache and notification-throttling state;
- MCP logging notifications without modifying normal tool result content;
- `triss update`, `triss update --json`, and explicit standalone apply and
  rollback operations;
- a receipt-backed, versioned standalone layout;
- a portable runtime artifact containing Triss and its production dependencies;
- release manifest, checksum, provenance, and smoke-test gates;
- migration guidance for existing package-manager, source, and legacy git
  installations;
- public documentation, configuration documentation, security documentation,
  and agent guidance updates.

## Non-goals

The first implementation does not:

- silently install an update;
- spawn a permanent daemon, cron job, `launchd` job, or OS notification agent;
- mutate npm-, pnpm-, yarn-, npx/dlx-, source-, or legacy git-owned files;
- run `git reset`, discard a dirty checkout, or pull a user repository;
- restart Codex, Claude Code, another MCP host, or an already running MCP
  server;
- install or upgrade Node.js;
- notify a user while Triss is completely idle and no MCP server is running;
- support prerelease channels in the first release;
- claim cryptographic authenticity from a checksum downloaded from the same
  release location. The checksum provides integrity; the release account and
  HTTPS endpoint remain trust roots unless a later signing design is adopted.

The npm-free standalone installer is initially a POSIX contract for macOS and
Linux, matching the existing bash installer. Version discovery and read-only
update guidance remain cross-platform. A Windows standalone installer requires
a separate plan or an explicit extension of this one with Windows-specific
launcher, atomic-switch, and CI acceptance criteria.

## Terminology and ownership boundary

- **Release manifest**: a small immutable JSON document attached to a stable
  GitHub Release. It names the release artifact and its integrity metadata.
- **Passive check**: a cached, bounded version check performed during ordinary
  Triss use without an update command.
- **Standalone installation**: a versioned installation created by the new
  installer and carrying a valid installation receipt.
- **Managed installation**: an installation owned by npm, pnpm, yarn, npx/dlx,
  a source checkout, or the legacy git installer.
- **Unknown installation**: any installation for which Triss cannot validate a
  standalone receipt and root.

Only a valid standalone receipt grants authority to change installation files.
Path heuristics may improve instructions, but they never grant write authority.
Managed and unknown installations are always read-only from `triss update`.

## Public user contract

### Automatic CLI notification

After a successful interactive CLI command, Triss performs a passive check when
the cache says a check is due. Here, interactive means that stderr is a TTY and
none of the suppression conditions below holds; piped stdout alone does not
make a command non-interactive. The check is automatic; the user does not have
to invoke `triss update`.

The short-lived CLI uses an awaited, cache-first contract rather than a
detached background task. A fresh cache is read synchronously and can produce
a notice without network I/O. When the cache is due, the command awaits one
bounded fetch before process exit, updates the cache, and may print a notice
from that fresh response. The entire passive network path, including redirects
and body consumption, is aborted at five seconds; focused timing tests allow no
more than 5.1 seconds of added command wall time. A timeout or failed check
produces no notice on that invocation. The CLI never starts an unreferenced
fetch, child process, or post-exit cache writer.

When a newer stable release is known, Triss writes one short notice to stderr:

```text
Triss 0.32.0 is available; you have 0.31.1. Run `triss update` for details.
```

A valid newer release that needs a newer Node uses a distinct notice:

```text
Triss 0.33.0 is available but requires Node >=24; you have Node 22.
Run `triss update` for guidance.
```

The notice must never be written to stdout. It is suppressed when:

- stderr is not a TTY;
- `CI` is set to a truthy CI value;
- `TRISS_UPDATE_CHECK=0`;
- the top-level command is `update` in any mode, `mcp serve`, or `completion`;
- Commander is producing help, a parse error, or `--version` output;
- the command failed;
- no newer stable version is known.

Commands with machine-readable stdout, including coder envelopes and `--json`,
remain byte-for-byte compatible because passive notices use only interactive
stderr. A passive network or cache failure never changes the command exit code.

### Automatic MCP notification

The MCP server must declare `{ logging: {} }` in addition to its existing tools
capability. `runServer()` registers `server.oninitialized` and
`server.onclose` before `server.connect(transport)`. Only the initialized
callback may read cached update state, emit an update notification, and start
the passive scheduler; the close callback clears it. Nothing is sent between
transport connection and the client's `notifications/initialized`. Although
`runServer()` returns after `connect()`, the callbacks and timer remain owned by
the live `Server`. While the server remains alive it checks again when the cache
becomes due.

For each newly observed release version, the server sends one MCP warning-level
logging notification and writes the same concise notice to stderr as a host-log
fallback. It must not append update text to tool result content and must not
write protocol data outside the MCP transport.

The timer is unreferenced, stops with the server process, and cannot keep a
disconnected process alive. Client support determines whether an MCP logging
notification is rendered visibly; `triss_status` therefore adds a concise
update section to its existing text response from cache without making a
network request. This does not introduce a `triss status --json` surface.
Focused tests preserve every existing status section while asserting the new
additive text section.

Sending the protocol log and writing stderr is intentional redundancy because
not every host renders MCP logging notifications. A host that displays both
surfaces may show the same text twice for one notification event; each surface
remains subject to the per-version notification throttle.

An MCP process that was updated on disk continues to run its loaded version.
The notice and successful apply output both state that the MCP host must be
restarted before it uses the new version. Triss never restarts the host itself.

### Manual command

The command surface is:

```text
triss update                 fetch fresh status and print guidance
triss update --json          emit machine-readable status only
triss update --apply         apply to a validated standalone install
triss update --apply --yes   allow explicit non-interactive apply
triss update --rollback      select the previous validated standalone version
triss update --rollback --yes allow explicit non-interactive rollback/recovery
triss update --apply --break-lock
                             explicitly authorize a proven-stale lock break
triss update --rollback --break-lock
                             explicitly authorize a proven-stale lock break
```

`--apply`, `--rollback`, and `--json` are mutually constrained as documented by
Commander help. A bare `triss update` always performs a fresh check rather than
trusting the passive cache. It does not modify files. Human status and guidance
are primary command output written to stdout; failures and diagnostics use
stderr. `--json` replaces the human stdout with the single JSON object.

Interactive `--apply` shows current version, target version, install root, and
artifact size, then requires confirmation. Non-interactive apply fails before
download unless `--yes` is also present. Rollback follows the same confirmation
contract. `--yes` is valid only with `--apply` or `--rollback`; it is rejected
for bare and JSON status checks. It skips the operation/recovery confirmation
only and never authorizes breaking an update lock. `--break-lock` is valid only
with `--apply` or `--rollback`. A TTY invocation with `--break-lock` receives a
distinct lock-owner prompt in addition to the operation prompt; a
non-interactive invocation must pass both `--break-lock` and `--yes`.

Every `update` mode is excluded from the generic passive post-command hook. A
bare or JSON command performs exactly its one explicit fresh check. Apply and
rollback perform only the fetches required by their own operation. No update
mode can trigger a second passive check or passive notice after completion.

If an incomplete standalone transaction exists, bare and JSON modes report
`recovery_required` without mutation. `--apply` and `--rollback` enter the
separate recovery authority path before normal classification, show the exact
durable phase and intended reconciliation, and require their normal interactive
confirmation or `--yes`. After recovery they re-read ownership and integrity
state before continuing the requested operation.

Example package-manager/unknown result:

```text
Current: 0.31.1
Latest : 0.32.0
Install: package-managed or unknown (read-only)

Update with the same package manager that installed Triss:
  npm install -g triss-coworker@0.32.0
  pnpm add -g triss-coworker@0.32.0
  yarn global add triss-coworker@0.32.0

If no package manager is available, run the standalone installer shown in the
README. Triss will not overwrite this installation.
```

Example standalone result:

```text
Current: 0.31.1
Latest : 0.32.0
Install: standalone at ~/.local/share/triss

Run `triss update --apply` to install 0.32.0.
```

Standalone human status and apply/rollback confirmation also show the retained
version count and the sum of receipt-recorded `expanded_bytes`, including the
projected target for apply. This is labelled as managed payload size rather than
exact filesystem allocation. The JSON object includes integer
`retained_versions`, `retained_payload_bytes`,
`projected_retained_versions`, and `projected_retained_payload_bytes` fields.
Package-managed, unknown, and unavailable values use `null`, not zero.

### JSON contract

On success, `triss update --json` writes exactly one JSON object to stdout and
no passive notice:

```json
{
  "schema_version": 1,
  "current_version": "0.31.1",
  "latest_version": "0.32.0",
  "update_available": true,
  "channel": "stable",
  "checked_at": "2026-08-12T12:00:00.000Z",
  "install_kind": "standalone",
  "can_apply": true,
  "recovery_required": false,
  "can_recover": false,
  "node_compatible": true,
  "retained_versions": 2,
  "retained_payload_bytes": 19753086,
  "projected_retained_versions": 3,
  "projected_retained_payload_bytes": 29629629,
  "requires_node": ">=22",
  "release_url": "https://github.com/ayleen/triss-coworker/releases/tag/v0.32.0"
}
```

Unknown values are `null`, not invented strings. Network failure returns a
non-zero exit with a concise stderr error for the explicit command. The same
failure remains silent and successful at the passive-check boundary.

### Configuration

The only public passive-check opt-out is:

```text
TRISS_UPDATE_CHECK=0
```

It disables passive CLI and MCP network checks and notices. It does not disable
an explicit `triss update`, because that command is the user's direct request.
The CLI resolves the opt-out through the existing process-env, project, and
global Triss env precedence before deciding whether to check; commands that do
not otherwise need provider configuration must still honor the setting.
Intervals, clocks, endpoints, and fetch functions are dependency-injected test
seams rather than public environment overrides. A configurable manifest URL
would allow a project `.triss.env` to redirect a background request and is
therefore not introduced.

## Release discovery contract

### Source of truth

Passive and explicit checks fetch a fixed HTTPS URL under the project's GitHub
Release namespace, for example:

```text
https://github.com/ayleen/triss-coworker/releases/latest/download/update-manifest.json
```

The update system does not execute `npm view`, `npx`, `pnpm`, `yarn`, `git`, or
`gh`. The absence of those binaries therefore does not affect discovery.

The `latest` manifest must be published only after the tag, package version,
artifact, checksum, and smoke tests agree. Prerelease GitHub Releases are not
eligible for the stable endpoint.

### Manifest schema

The first schema is intentionally small:

```json
{
  "schema_version": 1,
  "name": "triss-coworker",
  "version": "0.32.0",
  "channel": "stable",
  "published_at": "2026-08-12T12:00:00.000Z",
  "release_url": "https://github.com/ayleen/triss-coworker/releases/tag/v0.32.0",
  "node": ">=22",
  "artifact": {
    "url": "https://github.com/ayleen/triss-coworker/releases/download/v0.32.0/triss-coworker-0.32.0-standalone.ndjson.gz",
    "sha256": "<64 lowercase hexadecimal characters>",
    "size": 1234567,
    "expanded_size": 9876543,
    "file_count": 456,
    "format": "triss-ndjson-gzip-v1",
    "platform": "node-posix"
  }
}
```

The parser rejects unknown schema versions, a wrong package name, non-stable
channel, invalid stable semver, tag/version mismatch, malformed timestamps,
unsupported `node` field grammar, missing fields, non-HTTPS URLs, unexpected
hosts, fragments, credentials in URLs, invalid checksum, non-positive
compressed or expanded size/file count, inconsistent header totals, and
artifacts above the documented limits. The `node` field grammar is exactly
`>=MAJOR`, where `MAJOR` is a canonical positive safe integer with no whitespace
or leading zero. Unknown extra fields are ignored only within schema version 1.

Manifest validity and local runtime compatibility are separate decisions:

1. a malformed manifest is invalid and cannot be cached or announced;
2. a valid newer manifest whose `node` requirement exceeds the running Node is
   cached as an available but incompatible release with
   `node_compatible=false` and `can_apply=false`;
3. a valid newer manifest compatible with the running Node is available and may
   become an apply target after installation classification succeeds.

Passive CLI and MCP notices for case 2 state both the required and running Node
majors instead of suppressing the release. Human `triss update` prints the same
upgrade-Node guidance, and JSON keeps `requires_node` reachable while exposing
`node_compatible=false`. An incompatible runtime is never reported as a parser
error.

Redirects are followed only across an exact hostname allowlist initially
limited to `github.com`, `release-assets.githubusercontent.com`, and
`objects.githubusercontent.com`; wildcards and `codeload.github.com` are not
allowed because source archives are not update artifacts. Phase 0 must observe
the actual draft-asset redirect chain and remove or add a hostname only with
recorded GitHub evidence and focused tests. The manifest response is capped at
64 KiB. Passive and explicit checks have a five-second total timeout, including
redirects and body consumption. Neither path accepts an agent-controlled URL.

The dedicated update client does not call the public `fetchUrl`, whose contract
accepts arbitrary caller URLs and HTML-oriented limits. It reuses a lower-level
redirect primitive in `src/net.js` and applies `assertPublicUrl` in strict mode
to the initial URL and every hop. Strict mode ignores
`TRISS_ALLOW_PRIVATE_NETWORKS`; update endpoints always require public DNS,
HTTPS, exact-host allowlisting, response caps, and their own timeout. The
existing agent-controlled `fetchUrl` behavior and opt-out remain unchanged.

### Version comparison

Only canonical stable semantic versions (`MAJOR.MINOR.PATCH`) participate in
the first release. Leading `v`, build metadata, prerelease identifiers, partial
versions, negative components, leading-zero components, and unsafe integers
are rejected. Numeric components are compared as integers, never as strings.

Triss considers an update only when `latest > current`. Equal, older, or invalid
manifests cannot produce an update notice or apply target. A valid but locally
Node-incompatible manifest produces the documented incompatible-release notice
but cannot become an apply target.

## Cache and notification state machine

Update state is stored at:

```text
~/.cache/triss/update-state.json
```

The cache contains no credentials. Schema version 1 records:

- the last successful check time;
- the last passive attempt time and the last explicit attempt time;
- the next permitted attempt time;
- the consecutive passive-failure count and current backoff duration;
- the validated latest manifest fields needed for a notice;
- the last network error category, without secret-bearing response bodies;
- the last notified version and notification time for CLI;
- the last notified version and notification time for MCP.

Defaults:

- successful checks are fresh for 24 hours;
- the same release is notified at most once every 72 hours per channel;
- failures retry after one hour, with bounded exponential backoff up to 24
  hours;
- an explicit `triss update` bypasses freshness and failure backoff.

Each passive failure increments `consecutive_failures`, derives the next delay
deterministically from that count, records `last_passive_attempt_at`, and
advances `next_permitted_attempt_at`. A successful passive or explicit check
resets the failure count and current delay to zero and records the successful
time plus the appropriate attempt time. A failed explicit check records only
`last_explicit_attempt_at`: it bypasses the deadline but does not increment,
reset, or otherwise perturb passive backoff. Repeated manual checks therefore
cannot postpone background recovery or erase failure history.

The state file is written through a unique same-directory temporary file,
flushed, renamed atomically, and created with user-only permissions where
supported. Concurrent readers tolerate a missing file. A writer first creates
the cache parent recursively, then acquires an `open(..., "wx")` lock file.
After the network response it re-reads state while holding the lock and refuses
to replace a newer `checked_at`/manifest generation; publication uses the same
flush-plus-rename boundary. A passive caller that cannot obtain the lock within
its time budget skips the write and succeeds. Invalid JSON, unknown cache
schema, impossible timestamps, or an unreadable/unwritable cache are treated as
cache misses. Passive operation continues without error.

The cache lock contains a random nonce, pid, platform process-start identity,
and acquisition time, but no secrets. Its owner removes it in `finally` only
after re-reading and matching the nonce. A later process may remove and retry a
lock only when a platform probe proves that the pid is absent or belongs to a
different start identity; it re-reads and compares the nonce immediately before
unlinking. Age alone never proves abandonment. If process identity is
unavailable, permission-denied, or ambiguous, passive work skips this cycle and
explicit status reports the lock path without deleting it. Tests cover crash
abandonment, PID reuse, nonce replacement, ambiguous probes, and concurrent
parent-directory creation.

Cached state is re-compared with the running version before every notice. A
cache that names the running version or an older release never produces a stale
notification after update or rollback.

## Installation classification

Classification returns one of:

```text
standalone | package-managed | ephemeral | source | legacy-git | unknown
```

The classifier may inspect the real executable path, ancestor package files,
symlinks, `.git`, and the standalone receipt. These observations improve
diagnostics only.

Recovery is evaluated before normal installation classification. The presence
of a transaction journal suspends `can_apply` evaluation and produces a
separate `can_recover` decision. `can_recover=true` only when all of the
following hold under the exclusive update lock:

1. an active or first-install bootstrap ownership receipt validly names the
   expected standalone root and launcher;
2. the journal schema, transaction id, operation, phase, old/new paths, and
   expected receipt hashes are internally consistent;
3. every journal path remains contained by the recorded root after realpath or
   safe missing-leaf resolution;
4. the on-disk receipt bytes match the journal's expected old or new receipt
   hash for the recorded durable phase;
5. every version tree needed to complete or reverse that phase passes its
   receipt-anchored per-file integrity inventory before any version code runs;
   before the new receipt exists, the journal anchors the staged inventory and
   expected digest instead.

An invalid, ambiguous, or unowned journal yields `recovery_required=true` and
`can_recover=false`; no normal apply or rollback mutation is attempted. Triss
prints the exact journal and retained paths for manual inspection. A valid
journal may deliberately coexist with a `current`/receipt mismatch because
that mismatch is an expected crash state governed by the journal, not evidence
for normal `can_apply` authority.

`can_apply` is true exclusively when all of the following hold:

1. the receipt exists inside the expected standalone root;
2. its schema, package name, install kind, absolute root, and active version
   are valid;
3. the launcher and resolved executable are contained by that root after
   realpath resolution;
4. the active version directory and receipt agree;
5. no target path crosses the install root through a symlink;
6. the platform is supported by the standalone contract.

These normal conditions are evaluated only when no journal exists. Any failed
or ambiguous check then results in `can_apply=false`; `--apply` prints guidance
and exits before download or write. A path containing
`node_modules` is evidence for a read-only package-managed classification, not
proof of a specific manager. Triss does not guess which manager to execute. A
missing path, permission failure, loop, or any other realpath error is an
ambiguous check and therefore fails closed with a diagnostic.

## Standalone distribution

### Layout

The new installer uses a root that does not overlap the legacy git checkout:

```text
~/.local/share/triss/
  install.json
  transaction.json           # present only during a prepared transaction
  current -> versions/0.32.0
  integrity/
    0.31.1.json
    0.32.0.json
  versions/
    0.31.1/
      bin/triss.js
      package.json
      src/
      templates/
      node_modules/
    0.32.0/
      ...
  staging/
~/.local/bin/triss -> ~/.local/share/triss/current/bin/triss.js
```

The standalone root input is the new `TRISS_STANDALONE_HOME`, defaulting to
`~/.local/share/triss`. `TRISS_BIN_DIR` remains the launcher-directory input.
Their normalized absolute values are recorded in the receipt, and the runtime
updater uses only those receipt values; it never reinterprets changed
environment variables as write authority.

`TRISS_HOME` remains reserved for the old git installer and the transition
bridge only. The standalone path never treats it as a root override. If
`TRISS_HOME` names an existing legacy checkout, the transition installer
reports that the checkout will remain untouched and instructs the user to set
`TRISS_STANDALONE_HOME` only when a non-default standalone root is desired. If
`TRISS_STANDALONE_HOME` itself names a legacy checkout or any other non-empty
unowned root, installation fails before mutation with the same separate-root
guidance.

The ownership receipt records schema, package name,
`managed_by: "triss-standalone"`, lifecycle state (`initializing` or `active`),
root, bin path, current version, previous version, channel, install time, last
update time, and a `versions` map. Each installed-version entry independently
records artifact checksum, integrity-inventory path and checksum, tree digest,
file count, expanded bytes, and installation time. It contains no credentials.

The integrity inventory is canonical JSON derived from the validated artifact
records. It lists every expected relative path, mode, size, and SHA-256. Its
own digest is anchored in the receipt; the receipt's version entry and inventory
together allow Triss to hash every target file, reject missing/extra files and
mode drift, and derive the same tree digest before executing that version or
switching `current`. Artifact checksum alone is not treated as proof of the
current extracted tree.

For first install, the bootstrap writes and fsyncs an `initializing` ownership
receipt into a newly created, previously empty root before downloading or
publishing any version. This limited receipt grants authority only to resume or
reverse the bootstrap transaction; it does not make `can_apply=true`. Successful
activation replaces it atomically with the active receipt. A root containing an
invalid initializing receipt fails closed rather than being adopted.

The installer refuses `/`, the user's home directory, an existing non-empty
unowned root, or a root reached through an unexpected symlink. It also inspects
the requested launcher path before writing. A missing launcher, an existing
standalone launcher, or the documented legacy-installer symlink is eligible; a
regular file or any unrelated/package-manager symlink fails without change and
prints an alternative `TRISS_BIN_DIR` instruction. The first release has no
force-overwrite option for an unowned launcher.

The artifact contains the exact published Triss sources and all production
dependencies. It excludes `.git`, tests, development dependencies, local env
files, caches, promo material, and release credentials. Because integration
discovery imports files dynamically from `src/integrations`, the initial
artifact expands to a staged application directory rather than assuming a
single-file bundle. A future bundle is allowed only after dynamic integration
and MCP smoke tests prove parity.

The first artifact format is deterministically gzip-compressed NDJSON generated
by release CI. Records use stable path order and canonical JSON serialization;
the gzip header uses `mtime=0` with no source filename or variable host field.
CI performs two independent clean dependency installations from the same source
commit and lockfile, requires identical canonical staged-tree inventories and
digests, then requires byte-identical artifacts. SECURITY.md states that this is
a same-run deterministic-build gate, not independent third-party reproducible
build provenance; the published checksum covers the exact release bytes.

Its header declares schema, package version, file count, and total expanded
bytes. Each subsequent record represents one regular file with a unique
normalized relative path, an allowlisted mode (`0644` or `0755`), byte length,
SHA-256, and base64 data. The format cannot represent symlinks, hard links,
devices, sockets, or FIFOs. The first implementation uses bounded buffered
extraction with conservative fixed caps: 32 MiB compressed, 64 MiB decoded
payload, 64 MiB for the expanded NDJSON/base64 envelope, 25,000 files, and
25,000 directories, 50,000 filesystem objects, 64 path components, and 8 MiB
per NDJSON line. Canonical paths use unsigned UTF-8 byte order rather than
locale collation. It rejects duplicate/overlapping paths,
empty or special path components, absolute paths, separators inappropriate to
the schema, cap violations, digest mismatches, trailing records, and writes
outside a newly created staging root. These limits keep worst-case transient
memory below the supported Node heap while avoiding a system `tar` dependency.
Installed-tree validation rejects a symlinked root, walks iteratively, rejects
unexpected paths before reading them, compares the expected size and mode
before hashing, and hashes expected files in bounded chunks under the same
file/directory/object/depth/byte budgets.

Release CI scans for native `.node` modules and platform-specific package
constraints. The portable `node-posix` artifact fails closed if either appears;
the release must then add per-platform artifacts through a separately reviewed
contract rather than mislabel a Linux-built dependency tree as portable.

### New installer

`install.sh` is rewritten to require Node.js 22 and the download mechanism used
to obtain the script. It must not require npm, pnpm, yarn, git, gh, tar, unzip,
or a checksum utility. A small embedded Node bootstrap, generated from the same
tested extraction source used by the runtime updater, performs subsequent
manifest fetch, download, hashing, and extraction with Node built-ins. CI proves
that the embedded bootstrap has not drifted from its canonical source.

The first merged installer is a transition build because the public command
downloads `install.sh` from `main` before the first standalone manifest can be
advertised. It attempts the fixed manifest first. Only a validated HTTPS `404`
returned under the fixed endpoint's normal redirect policy for the absent
`update-manifest.json` asset may begin fallback classification. The bridge then
fetches the fixed anonymous latest-release API, requires a valid stable Release
for this repository, and confirms that its asset list does not advertise the
manifest. An absent/malformed latest Release, wrong repository or tag shape, or
an advertised manifest whose download returned 404 fails closed. Only the
verified missing-asset state may invoke a separately tested copy of the prior
git-plus-npm installer path, and only for a fresh install into an empty
`TRISS_HOME` target. An existing legacy checkout is never pulled or modified by
this bridge. The compatibility bridge has a fixed origin boundary: it clones
only `https://github.com/ayleen/triss-coworker.git`, the explicit `main` branch,
and accepts no URL, ref, or package name from the environment or manifest. The
clone is shallow and single-branch so the selected compatibility source is
explicit without pinning an obsolete commit before the standalone release
exists. Its dependency install uses
`npm install --omit=dev --ignore-scripts --silent`; the legacy checkout is then
launched only through its checked-out `bin/triss.js`.

Timeout, redirect violation, invalid manifest, checksum failure, or any other
error fails closed and never downgrades to legacy installation. This bridge
preserves fresh public installation during the merge-to-release gap, including
the existing git/npm requirements when no standalone release exists. Users
without those tools, and users pointing it at an existing legacy checkout,
receive an explicit message that the standalone release is not yet available,
rather than a false successful install or an implicit legacy update. A
follow-up may remove the bridge only after the complete manifest and artifact
have been publicly verified and the latest alias has remained healthy for the
documented observation window.

This temporary bridge cannot prove from runtime evidence that the fixed
manifest path itself contains no implementation typo. A path regression or an
asset deleted from an otherwise valid latest Release can still appear as a
verified missing asset. Exact endpoint fixture tests reduce the first risk. The
remaining limitation is documented, is confined to a fresh empty legacy
target, and ends when the bridge is removed.

The installer:

1. validates root and launcher ownership, acquires the update lock, and performs
   journal recovery before any normal install work;
2. for an active receipt, validates the complete current and rollback trees,
   receipt/current agreement, and launcher chain under the lock before network
   or staging work; for a fresh empty root, writes and fsyncs the limited
   `initializing` ownership receipt;
3. fetches and validates the fixed stable manifest;
4. checks the current Node version before downloading the artifact;
5. checks free space against compressed size, expanded size, and safety
   headroom;
6. downloads into a unique staging directory under the target filesystem with
   separate connect/header and resettable inactivity deadlines plus a bounded
   five-minute total deadline;
7. verifies byte count and SHA-256 using Node's crypto support;
8. validates every bounded NDJSON file record and builds its canonical
   integrity inventory;
9. fsyncs every payload after its final mode, fsyncs created directories from
   deepest to shallowest, then verifies every staged byte against the inventory
   before running the staged `--version` smoke and checking the exact manifest
   version;
10. writes and fsyncs a `PREPARED` journal containing staging/final paths,
    integrity metadata, prior launcher state, and expected old/new receipt
    hashes before publishing the final version directory;
11. renames staging to the version directory, fsyncs the parent, and advances
    the journal to `VERSION_PUBLISHED`;
12. anchors the public launcher directly to the prior receipt-committed entry,
    then atomically activates `current`; a crash still starts trusted recovery
    code rather than the candidate;
13. smokes the candidate by its direct verified path, durably publishes the
    active receipt, normalizes the public launcher through `root/current`, and
    runs the stable launcher smoke; pre-receipt failure restores the exact prior
    lexical launcher/current state from the journal;
14. leaves every legacy or previous version directory untouched.

Re-running the installer is idempotent. It follows the same versioned install
path as `triss update --apply` and can repair a missing launcher without
redownloading a verified active version.

If the legacy `~/.local/share/triss-coworker/.git` checkout exists, the new
installer neither pulls nor modifies it. It installs to the separate standalone
root, switches the launcher only after success, and reports the preserved
legacy path. Removing that path remains a separate explicit user action.

## Explicit apply algorithm

`triss update --apply` performs the following transaction:

1. acquire the exclusive update lock and evaluate any journal through
   `can_recover` before evaluating normal `can_apply`;
2. after confirmed recovery, re-read and validate standalone ownership, active
   receipt state, current pointer, and current version integrity inventory;
3. fetch a fresh release manifest and validate every field;
4. reject no-op, downgrade, prerelease, unsupported platform, or oversized
   targets; a locally Node-incompatible target stops here with the documented
   upgrade-Node guidance rather than a manifest error;
5. present the exact target, retained version count, and current/projected
   retained payload bytes, then obtain confirmation unless `--yes` is valid;
6. use `fs.statfs` on the standalone root and require documented safety headroom
   above `artifact.size + artifact.expanded_size` before download;
7. create a unique staging directory inside the standalone root;
8. download with separate connect/header and resettable inactivity deadlines,
   a bounded five-minute total deadline, response-size enforcement, and
   restrictive file mode;
9. verify actual size and SHA-256 before decompression;
10. extract the bounded artifact format into the staging directory while
    rejecting every unsupported record or path before its file is created;
    fsync each payload after its final mode, all created directories bottom-up,
    the staging root, and its parent before publication;
11. build the canonical integrity inventory, hash every staged file, reject
    missing/extra paths, and derive the tree digest;
12. only after integrity succeeds, run the staged `--version` smoke using the
    current Node executable and a sanitized environment;
13. compute canonical old/new receipt bytes and persist a `PREPARED` journal
    containing their hashes, version metadata, staging/final paths, pointer
    targets, and last durable phase; fsync the journal and parent directory;
14. rename staging to `versions/<version>`, fsync the versions directory, and
    advance the journal to `VERSION_PUBLISHED`;
15. atomically anchor the public launcher directly to the old verified entry,
    create and rename a temporary `current` link, and advance the flushed
    journal; the public command remains executable from committed code;
16. re-verify and smoke the candidate by its direct path without routing the
    public launcher through uncommitted code;
17. if candidate smoke fails, atomically restore the exact lexical old launcher
    and current link and advance the journal through rollback;
18. atomically publish and fsync the precomputed new receipt with the old target
    as `previous`, then advance the journal to `RECEIPT_COMMITTED`;
19. normalize the public launcher through `root/current`, smoke it, mark the
    journal committed, update the cache, and remove the journal only after both
    receipt and launcher are durable;
20. release the lock in `finally` and report whether an MCP host restart is
    required.

The updater never executes scripts from `package.json`, runs a package manager,
or evaluates downloaded shell. It invokes only the staged Triss entry point
after integrity and containment checks.

A killed process can stop between any two durable phases, because version
directory, pointer, receipt, and journal cannot be switched as one filesystem
operation. `PREPARED` is durable before the first final version-directory
rename, so every published final directory is covered by a journal. Recovery
validates the journal, expected receipt hash, pointer, and required per-version
integrity, then completes commit or restores the old state according to the
last durable phase. It never routes through normal `can_apply` first.

A final `versions/<version>` collision without a matching valid journal and
receipt entry is not adopted, overwritten, or automatically deleted. The
operation fails closed and reports the exact orphan path. Pre-journal staging
directories are also never adopted as final versions; an explicit operation
may remove only a staging directory carrying its validated ownership marker and
transaction nonce after confirmation. Passive checks only report
recovery-required state. The first release retains all installed versions;
automatic pruning requires a separate bounded-retention contract.

## Rollback and concurrency

`triss update --rollback` is explicit and standalone-only. It validates that
the receipt's previous version has its own version entry and integrity
inventory. Before executing any previous-version code or switching `current`,
Triss validates the inventory digest anchored in the receipt, hashes every
expected file, rejects missing/extra files or mode drift, and matches the tree
digest. Only then may it run `--version` as a compatibility smoke. A self-report
from unverified rollback code is never integrity evidence.

Rollback uses the same confirmation, lock, `PREPARED` journal, expected receipt
hashes, durable phase transitions, and recovery authority as apply. It does not
fetch the network and does not delete the version being rolled back from. When
no previous version is recorded, it exits before mutation with
`No previous standalone version is available for rollback.`

Only one installer, apply, or rollback transaction may hold the update lock.
Lock metadata contains pid, start time, and operation but no secrets. A live
owner causes a concise failure. To distinguish PID reuse, the lock records and
the platform-specific probe compares both pid and process-start identity. A
stale lock is never broken solely by age. Even when the process is proven absent
and identity checks agree, `--yes` alone never breaks it. The caller must add
`--break-lock` to apply or rollback. In a TTY this produces a distinct
lock-break prompt; non-interactive use requires both `--break-lock` and `--yes`.
If process-start identity is unavailable or ambiguous, neither flag combination
breaks the lock; Triss prints the exact lock path and inspection steps for
manual recovery.

Installed versions are retained without automatic pruning in the first release.
Free-space checks already observe disk consumed by older trees through
`statfs`, but every standalone status and mutation confirmation also exposes the
receipt-recorded version count and managed payload bytes. This makes cumulative
growth visible before another explicit update. Safe deletion, retention caps,
and filesystem-allocation accounting require a separately reviewed pruning
contract.

After recovery, command status and apply decisions re-read the active version
from the verified receipt rather than retaining the version of the process that
happened to start. The running process continues from already loaded files
while links change.
All writes and renames remain below the validated standalone root and use
same-filesystem staging so atomic rename guarantees apply.

## Release workflow

The tag workflow remains gated by the full lint and test suite. It gains a
standalone build job and a publication job with this sequence:

1. verify `v<version>` equals `package.json`;
2. expand the current Node-24-only publish test job into a Node 22/24 matrix and
   run `npm ci`, lint, and full tests on both supported versions with the pinned
   release npm version;
3. in one canonical Node 22 build job using that pinned npm, run two independent
   clean `npm ci --omit=dev` installations in separate empty directories and
   stage the package allowlist plus production dependencies from each;
4. fail if either staged tree contains excluded files, secrets, native modules,
   or platform constraints;
5. compare the two canonical staged-tree inventories and tree digests, build an
   artifact from each tree, and require byte-identical archives and checksums;
6. upload that single canonical artifact, its builder metadata, and checksum as
   one workflow artifact; no smoke job may rebuild it;
7. in an Ubuntu/macOS and Node 22/24 matrix, download the same workflow artifact,
   verify its digest against both metadata and checksum, install it into a
   temporary HOME with npm, pnpm, yarn, and git unavailable on PATH, and smoke
   `triss --version`, `triss --help`, `triss status`, MCP tool listing, and
   representative dynamic integration loading;
8. publish the npm package with existing provenance from Node 24;
9. make the release job download and verify that same canonical workflow
   artifact, then create the matching GitHub Release as a draft and upload its
   immutable artifact, checksum, and manifest;
10. verify draft assets through the authenticated API, including byte-for-byte
    checksum and tag/manifest/package agreement;
11. publish the already complete draft as a non-draft stable release with
    `make_latest: "false"`; the previous latest alias remains authoritative;
12. without authentication, fetch the public release-by-tag API and tag-specific
    `/releases/download/v<version>/...` manifest, checksum, and artifact through
    the exact client redirect policy, then verify all bytes and metadata;
13. only after tag-specific anonymous verification succeeds, update the Release
    to `make_latest: "true"`;
14. verify without authentication that the public latest-release API and
    `/releases/latest/download/...` resolve to the same already-verified tag and
    bytes.

The release job is strictly rerunnable after any transient failure. Its
get-or-create gate requires an existing Release to match the tag, target commit,
non-prerelease state, and incident status; it verifies every existing asset by
name and bytes, uploads only missing assets while the Release is still a draft,
and never overwrites an existing asset. A rerun resumes from the observed
state: complete draft assets continue through publication, a published
non-latest Release continues through tag verification and compare-and-set
promotion, and an already-latest Release only repeats latest verification.
Published assets or a Release marked with an incident annotation fail closed.
The promotion step also performs an authenticated compare-and-set immediately
before `make_latest`: it re-reads `/releases/latest` and requires both the
snapshotted previous tag and release id, plus a strictly newer stable candidate
tag. A mismatch makes no release mutation and is not eligible for promotion
recovery; recovery is allowed only after the candidate is subsequently observed
as latest.

The manifest `published_at` is deterministic: the release workflow reads the
tag commit's `%cI` timestamp, normalizes it to canonical ISO-8601, and passes it
explicitly to `write-manifest`. Independent generation therefore produces
byte-identical JSON for the same artifact and tag.

Promotion recovery state is persisted in the authenticated candidate Release
body as one canonical base64url v2 marker containing the previous latest tag,
release id, asset names, manifest digest, and phase (`prepared` or
`incident_pending`). It is not a public asset and is never included in the
exact immutable public asset set. Before any demotion or recovery mutation,
the gate atomically changes `prepared` to `incident_pending` and re-reads the
Release to verify that exact marker. A lost response is therefore resumable:
an already `incident_pending` marker is accepted and re-verified, while a
malformed, duplicate, old-schema, non-canonical, or conflicting marker fails
closed. The workflow's authenticated status preflight handles
`incident_pending` before tag verification or promotion, invokes bounded
automatic recovery, and exits nonzero so the incident is never reported as a
successful promotion. The final recovery PATCH removes the state marker and
adds the idempotent incident annotation together; if that PATCH fails, the
`incident_pending` marker remains for the next attempt. Successful latest
verification clears a prepared marker.

GitHub Actions permissions remain least-privilege: test/build jobs are
read-only; only the final release job receives `contents: write`, and npm
publication alone receives `id-token: write`. Artifact attestations should be
generated when the chosen GitHub mechanism supports verification for this
archive. The user-facing security documentation must distinguish provenance,
transport trust, and checksum integrity.

A partial release is never advertised as updateable. If npm publication or
draft verification fails, the draft stays unpublished. If anonymous
tag-specific verification fails after publication with `make_latest:false`, the
workflow does not promote it and returns it to draft where the current GitHub
API permits; otherwise it marks the Release failed and stops. In every case the
latest stable Release remains the previous complete version and passive checks
do not announce the incomplete one.

Each anonymous verification retries boundedly to distinguish CDN propagation
from a persistent mismatch. A persistent latest-alias failure after promotion
first runs bounded automatic recovery: demote the affected Release, verify that
the latest endpoint again resolves to the snapshotted previous complete
release, and add the idempotent incident annotation. Only if that recovery
fails does the workflow stop for release-owner manual response using the
retained state file; the owner must complete the same checks before publishing
a new patch release through the full pipeline. Automation does not delete the
tag, rewrite an immutable asset, hide the npm publication, or silently reuse
the failed version.

## Security and privacy invariants

- Passive checks issue a GET only to the fixed allowlisted release endpoint.
- No API key, project path, repository name, command arguments, prompt, usage
  record, or integration configuration is attached.
- A minimal User-Agent may include only `triss/<version>` and platform class;
  documentation discloses that GitHub necessarily observes request metadata
  such as IP address.
- Response bodies are size-capped before parsing and are never printed on
  error.
- Remote version, URL, filename, artifact record, and receipt values are
  untrusted until validated.
- Apply requires both explicit user intent and validated standalone ownership.
- Package-manager and unknown paths remain read-only even when writable.
- Download and extraction stay inside a validated root; path traversal,
  duplicate paths, links, device files, unexpected record types, and resource
  cap violations fail closed.
- Checksums are compared in constant-time-compatible byte form after strict
  decoding.
- Child smoke tests receive a sanitized environment and no provider or tracker
  credentials.
- Cache and receipt writes are atomic; receipt corruption disables apply.
- Update failures never weaken the current installation or normal command
  behavior.

## Failure contract

Passive failures are recorded by category and otherwise silent:

- timeout or DNS/transport failure;
- non-success HTTP status;
- redirect policy violation;
- response too large;
- invalid JSON or manifest;
- unsupported schema or Node range;
- cache read, lock, or write failure.

Explicit check/apply failures name the failed phase without dumping response
bodies or secrets. Before activation, failure removes only the transaction's
known temporary files where safe and leaves the active version unchanged.
After activation, failed launcher validation restores the prior pointer and
receipt. If rollback itself cannot be proven, the command fails closed and
prints the exact retained paths for manual inspection; it does not guess.

## Documentation-first implementation phases

### Phase 0 - artifact feasibility and contract lock

Before production code:

- build a disposable staged artifact from the current package and round-trip it
  through the proposed bounded NDJSON extractor;
- prove dynamic integration loading and MCP startup from that artifact;
- inventory production dependencies for native/platform-specific content;
- measure compressed and extracted size and set explicit caps above measured
  values with documented headroom;
- verify the pinned MCP SDK's `server.oninitialized` lifecycle with a local
  client harness and prove no logging notification precedes initialized;
- verify the pinned MCP SDK logging API against a local client harness;
- decide the exact GitHub Release upload/attestation mechanism and re-verify
  draft, prerelease, and `make_latest` semantics against the current official
  GitHub REST documentation;
- record the evidence and final constants in this plan.

If the portable staged artifact fails, stop and amend the plan. Do not silently
substitute a single-file bundle, Node SEA, or per-platform binary distribution.

### Phase 1 - public documentation

Update before source behavior changes:

- `README.md`: automatic notices, incompatible-Node guidance, retained payload
  reporting, `triss update`, `TRISS_STANDALONE_HOME`, installation ownership,
  standalone migration, restart requirement, and npm-free guarantee;
- `docs/configuration.md`: `TRISS_UPDATE_CHECK=0`, cache location, intervals,
  privacy, and failure behavior;
- `docs/mcp.md`: logging capability, automatic MCP notices, cached status, and
  unchanged tool content;
- `SECURITY.md`: release trust, checksum limits, extraction rules, and receipt
  boundary;
- `.env.example`: the passive-check opt-out;
- `templates/claude-full.md` and `templates/codex-full.md`, which name status or
  installation commands; the two short templates are audited but unchanged;
- `CHANGELOG.md`: user-visible contract and migration note.

The public docs must not describe self-update as available to managed or legacy
installs.

### Phase 2 - focused RED

Add focused failing tests for:

1. canonical stable semver parsing and numeric comparison;
2. manifest schema, exact URL/redirect hosts, compressed/expanded/file-count
   caps, timeout, `>=MAJOR` grammar, and separate invalid/Node-incompatible/
   compatible states with reachable text and JSON guidance;
3. cache freshness, persisted failure count/current delay/separate passive and
   explicit attempt times, explicit success/failure reset rules, corruption
   recovery, atomic writes, abandoned lock recovery with
   PID/start identity/nonce, fully-written temporary metadata published by an
   exclusive same-directory hard link, and concurrent
   stale-response ordering;
4. CLI TTY/CI/opt-out/success/failure suppression, suppression for every update
   mode, fresh-cache no-network behavior, due-cache awaited fetch, the
   1.1-second wall-time ceiling, no detached work, human update stdout, and
   strict stdout purity for every other command;
5. one-notice-per-version throttling and cached-version re-comparison;
6. MCP logging capability, no notification before `oninitialized`, initialized
   cache/check scheduling, periodic check, one notice per version/surface,
   intentional stderr redundancy, unreferenced timer, shutdown cleanup,
   additive `triss_status` text, absence of a new status JSON mode, and
   unchanged normal tool result content;
7. explicit command text/JSON contracts and fresh-check behavior;
8. every install classification, normal fail-closed `can_apply`, journal-first
   `can_recover`, invalid-journal refusal, and recovery of every durable phase;
9. receipt containment, symlink escape, mismatched active version, corrupt
   receipt, realpath errors, bootstrap ownership, `PREPARED` before final
   rename, and refusal to adopt an unjournaled final version directory;
10. apply/rollback confirmation, both non-interactive `--yes` forms, proof that
    `--yes` alone cannot break a lock, separate `--break-lock` prompts and flag
    combinations, PID reuse/ambiguous recovery, disk-space precheck, checksum,
    bounded extraction, staging smoke, journaled activation, and no-previous
    rollback behavior;
11. per-version inventory anchoring, missing/extra/mode/hash detection, and
    proof that rollback code is never executed before full target-tree
    integrity;
12. `TRISS_STANDALONE_HOME`/legacy `TRISS_HOME` separation, preservation of
    default and non-default legacy git checkouts, unowned root/launcher refusal,
    separate-root migration, exact endpoint constants, and the transition
    installer's fresh-root-only fallback after both an exact 404 and a valid
    latest Release that does not advertise the manifest; malformed, absent,
    wrong-repository, and advertised-but-404 Release states fail closed. The
    bridge uses only the fixed repository URL and `main` ref, and installs its
    legacy dependencies with `--ignore-scripts`;
13. installer behavior with npm, pnpm, yarn, git, tar, and unzip absent after a
    complete standalone manifest exists;
14. two independent clean dependency installations, matching canonical staged
    trees, deterministic artifact bytes, exclusions, dynamic imports, MCP
    startup, and Node 22/24 smoke;
15. release ordering: draft verification, non-latest publication, anonymous
    tag-specific verification, latest promotion, alias verification, and
    failure/demotion paths;
16. retained version count/current and projected managed payload bytes in human
    and JSON status without claiming exact filesystem allocation;
17. strict update-client public-DNS checks on every redirect hop, exact hosts,
    and proof that `TRISS_ALLOW_PRIVATE_NETWORKS` cannot weaken them while
    existing agent-controlled fetch behavior remains compatible.

Tests mock fetch, clocks, filesystem roots, process detection, MCP transport,
and subprocess calls. Unit and integration tests make no live network requests
and never use the developer's real HOME, cache, install root, or launcher.

Record the focused RED command and assertions. RED must fail for missing update
behavior, not missing dependencies or an uncreated fixture.

### Phase 3 - minimum GREEN vertical slices

Implement in this order, keeping the focused tests green:

1. centralized package version and stable semver helpers;
2. strict public-DNS redirect primitive and fixed-endpoint manifest client;
3. cache, backoff, and notification decision logic;
4. passive CLI hook with stderr/output guards;
5. `oninitialized`-gated MCP logging notification, scheduler, and cached status
   reporting;
6. read-only `triss update` text and JSON output;
7. receipt parser and installation classifier;
8. standalone artifact builder and CI smoke without publication;
9. transition installer with the 404-plus-latest-Release compatibility bridge
   and separate standalone root variable;
10. bootstrap receipt, per-version integrity, and npm-free standalone install;
11. explicit apply transaction, journal-first recovery authority, and locks;
12. rollback transaction, full-tree integrity, and recovery diagnostics;
13. non-latest release publication, anonymous verification, promotion, and
    post-promotion gates.

No slice may make `can_apply` true before receipt validation, artifact smoke,
and rollback tests are green.

### Phase 4 - full validation and review

Run focused suites explicitly, then:

```bash
npm run lint
npm test
npm pack --dry-run
```

Run standalone artifact smoke on Node 22 and 24 in a temporary HOME with
package managers and git unavailable. Run installer idempotency, upgrade,
failed-upgrade rollback, explicit rollback, legacy-preservation, and two-process
lock/PID-reuse scenarios. Build two staging trees through independent clean
dependency installs from the same commit and lockfile; compare their canonical
inventories, tree digests, and artifact bytes. Verify stdout/stderr bytes for
representative CLI JSON, human update, coder, completion, help, version, error,
MCP transport, and MCP tool calls.

Review the final diff against this plan, public docs, release workflow, artifact
inventory, and generated public assets. Perform an independent code review of
the security-sensitive fetch, extraction, receipt, symlink, lock, and rollback
boundaries. A real release remains a separate explicitly authorized action.

## Expected file map

Exact names may be refined during RED, but responsibilities should remain
separated:

- `src/version.js`: centralized running package identity;
- `src/net.js`: reusable strict public-DNS and redirect validation primitive;
- `src/update/manifest.js`: fixed-endpoint fetch and validation;
- `src/update/cache.js`: cache, backoff, and notice state;
- `src/update/artifact.js`: bounded NDJSON generation/extraction primitives;
- `src/update/integrity.js`: per-version inventory and complete tree validation;
- `src/update/install.js`: receipt, ownership, journaled transaction, and
  rollback;
- `src/commands/update.js`: CLI presentation and confirmation;
- `bin/triss.js`: command registration and passive CLI boundary;
- `src/mcp/server.js`: logging capability, scheduler, and shutdown behavior;
- `src/mcp/handlers.js`: cached update status only;
- `scripts/build-standalone.*`: deterministic artifact staging and inventory;
- `scripts/standalone-bootstrap.*`: canonical npm-free installer bootstrap;
- `install.sh`: npm-free standalone bootstrap;
- `.github/workflows/test.yml`: artifact and npm-absent smoke;
- `.github/workflows/publish.yml`: complete-release publication gates;
- focused test files under `test/` mirroring the update modules;
- README, configuration, MCP, security, env example, templates, and changelog.

Avoid placing filesystem mutation, network fetch, presentation, and MCP
scheduling in one module. Do not add a general background-job framework.

## Acceptance criteria

The implementation is complete only when all of the following are true:

1. An interactive CLI user learns about a newer complete stable release during
   ordinary successful use without invoking `triss update`.
2. A fresh CLI cache adds no network wait; a due passive check is awaited,
   finishes or aborts within the documented 1.1-second wall-time budget, and
   leaves no detached work after command exit.
3. A long-running MCP server starts checks and logging only from
   `server.oninitialized`, emits no pre-initialization notification, and does
   not change ordinary tool result content.
4. Discovery works when `npm`, `pnpm`, `yarn`, `npx`, `git`, and `gh` are
   absent.
5. Passive failures never change normal output, exit status, or command success.
6. CLI stdout remains byte-compatible for existing JSON, coder, completion,
   help, and version surfaces; human `triss update` output uses stdout by
   explicit new contract.
7. MCP stdio remains valid JSON-RPC with no stray protocol bytes, and only
   `triss_status` receives the documented additive cached text section.
8. Opt-out, cache interval, persisted deterministic retry backoff, abandoned
   cache-lock recovery, and notification throttling match the public contract.
9. Invalid manifests, valid Node-incompatible releases, and valid compatible
   releases remain distinct in passive, human, JSON, and apply behavior.
10. The update client applies strict public-DNS, HTTPS, exact-host, redirect,
    timeout, and size rules that cannot be weakened by
    `TRISS_ALLOW_PRIVATE_NETWORKS`.
11. Only a validated active standalone receipt with no journal can make normal
    `can_apply` true; a journal is handled first by the distinct fail-closed
    `can_recover` authority.
12. Every durable transaction phase, including the final-directory rename, is
    preceded by a fsynced `PREPARED` journal and has a tested recovery result;
    the public launcher remains on receipt-committed code until the new receipt
    is durable, including missing/truncated candidate crash fixtures.
13. Managed, ephemeral, source, legacy, and unknown installations are never
    modified by `triss update`.
14. The standalone installer uses `TRISS_STANDALONE_HOME`, never treats legacy
    `TRISS_HOME` as standalone authority, requires Node 22, and requires no
    package manager, git, tar, unzip, or external checksum utility.
15. The transition installer falls back only after both an absent-manifest 404
    and a valid latest Release that does not advertise that asset, and only into
    a fresh empty legacy target; every other state fails closed.
16. Legacy git checkout contents, including dirty files, remain untouched during
    standalone migration and transition operation.
17. An unowned install root or launcher is never overwritten; failure provides
    a safe alternate-root/bin instruction.
18. Manifest and artifact validation enforce schema, stable semver, exact Node
    grammar, host/redirect allowlist, compressed/expanded/file-count caps,
    directory/object/depth/byte caps, checksum, record types, path containment,
    locale-independent UTF-8 ordering, and durable payload/directory flushes.
19. Every installed version retains receipt-anchored inventory metadata, and
    every target tree is bounded and fully verified before its code executes;
    an active bootstrap update validates the old tree, pointer, rollback target,
    and launcher under lock before network or staging work.
20. Apply is explicit, disk-space-checked, staged, smoke-tested, and journaled
    across version/pointer/receipt writes. It shows current/projected retained
    version counts and managed payload bytes before confirmation.
21. `--yes` skips operation confirmation only; breaking a proven-stale update
    lock requires the separate `--break-lock` authorization and cannot bypass
    ambiguous owner identity.
22. A failed or killed transaction leaves the previous launcher usable or
    provides exact retained recovery paths without destructive guessing;
    recovery restores the recorded lexical launcher shape and refreshes command
    version identity from the verified receipt.
23. Rollback is explicit, offline, validates the complete target tree before
    executing it, accepts `--rollback --yes`, remains non-destructive, and
    reports the no-previous-version state before mutation.
24. Release CI independently installs and stages dependencies twice with pinned
    npm, compares canonical trees and artifact bytes, then makes Ubuntu/macOS on
    Node 22/24 and the release job verify and consume the exact same uploaded
    artifact with package managers absent before advertising the release.
25. npm publication and standalone publication agree on tag, version, and
    tested source; incomplete releases are not announced.
26. A release is publicly verified through tag-specific anonymous URLs while
    `make_latest:false`; only then is it promoted and the latest alias verified.
27. A persistent post-promotion verification failure follows the documented
    demotion and patch-release runbook without rewriting the failed version.
28. Public documentation and the two named full agent templates distinguish
    notification, Node compatibility, package-manager guidance, standalone
    apply, integrity, provenance, retained size, and host restart requirements.
29. Focused tests demonstrate RED before GREEN; lint, full tests, package smoke,
    and standalone matrix smoke pass with real non-zero counts.
30. Independent review finds no unresolved security or data-loss blocker.
31. The final diff contains no unrelated changes and the original dirty main
    checkout remains untouched.

## Rollout sequence

1. Land notification, manifest parsing, cache, and read-only command behavior;
   do not publish a new stable manifest until its required artifact exists.
2. Land artifact build and npm-absent smoke without changing the installer or
   GitHub's latest stable Release.
3. Publish a canary draft artifact and exercise fresh install, upgrade,
   rollback, MCP restart, and failure recovery outside user paths.
4. Land the transition installer and receipt-backed apply path. Until a complete
   manifest exists, the public `main/install.sh` may use its tested legacy
   git/npm compatibility path only after an asset 404, validation of the fixed
   latest-Release API, confirmation that the asset is unadvertised, and an empty
   `TRISS_HOME` target. It never pulls an existing legacy checkout, and all
   other states fail closed.
5. Through the protected release process, publish the first complete Release as
   non-draft with `make_latest:false`, then anonymously verify its tag-specific
   manifest, checksum, artifact, installer, and npm-free smoke.
6. Promote that already verified Release with `make_latest:true`, verify the
   public latest API and download alias, and activate standalone install/update
   guidance only after the alias matches the verified tag and bytes.
7. Keep the 404-plus-latest-Release compatibility bridge throughout a documented
   observation window. Remove it in a later independently releasable change
   only after latest-alias health and npm-free installation are re-verified.
8. Observe manifest failures, cache behavior, update completion, and support
   reports without collecting project or prompt telemetry.

At every stage, disabling or rolling back standalone apply must leave passive
notification and package-manager guidance functional. Publishing, creating a
GitHub Release, changing `latest`, or updating npm remains outside plan-writing
scope and requires explicit release authorization.

# Threat Model

## Assets

- model and integration credentials;
- repository source, diffs, prompts, and issue content;
- local Git worktrees and user files;
- session, result, update, and usage records;
- npm, companion, and standalone release artifacts.

## Trust boundaries

Boundaries exist between Triss and repository content, tracker content, model
providers, child coder engines, local same-UID processes, GitHub, npm, and the
host operating system. Crossing a boundary requires explicit command intent or
the documented passive update check.

## Attacker capabilities

The design assumes repository files and issue/PR text may be malicious. A
provider response or child engine may attempt prompt injection, path escape,
credential discovery, command execution, excessive output, or persistence.
A local same-UID process may race or replace files and processes that Triss
cannot protect with an OS-enforced ownership primitive. Release accounts and
CI dependencies may be compromised.

## Security expectations

- Repository and integration content is data, never authority to expand scope.
- Raw provider credentials are not intentionally passed to supported child
  engines when the credential proxy is required.
- File, response, process, and artifact operations are bounded and fail closed
  when required enforcement cannot be established.
- The default coder isolation path does not silently downgrade. Best-effort
  execution requires an explicit operator acknowledgement.
- The SSRF address classifier and its literal parsers in `src/net.js` are
  exercised by property-based fuzz tests (`test/fuzz.test.js`) in addition to
  the example-based suite; changes there must keep the fuzz properties green
  and extend them for any newly enforced special-use range.
- Release jobs minimize privileges, use OIDC for npm publication, and verify
  the bytes promoted between jobs.

## Explicit non-guarantees

- Best-effort isolation is not a hardened sandbox or kernel security boundary.
- Triss cannot control provider retention, jurisdiction, or staff access.
- Triss cannot defend against a fully compromised same-UID account, operating
  system, GitHub/npm account, or trusted CI action.
- Checksums authenticate bytes only relative to their trusted manifest and
  publication infrastructure.
- Network policy is not a substitute for host-level egress controls.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

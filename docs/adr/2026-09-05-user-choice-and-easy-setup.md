# User choice, best-effort execution, and easy setup

- Status: Accepted; binding owner decision.
- Date: 2026-09-05.
- Scope: CLI, MCP, provider runtime, coding engines, config wizard, tests, and documentation.

## Context

Triss has a shared provider runtime, but some execution paths reject engines
because a verified read-only projection or isolation guarantee is unavailable.
The wizard redesign initially treated those existing gates as product requirements
and proposed a large first-run settings menu. The owner explicitly rejected both.
Existing implementation restrictions are not evidence that users should lose a
choice. Ordinary users should be able to install Triss and start using it without
understanding its internal architecture.

## Decision

### Users choose providers, models, and engines

- All Triss providers and execution engines must be available for coding and
  non-coding tasks. Do not create task-specific allowlists merely because a
  route lacks a verified read-only projection or complete safety guarantees.
- Provider and engine are separate choices. Implement the adapters and transport
  mappings needed to support those choices; a missing adapter is implementation
  work, not a permanent product prohibition.
- Do not silently substitute a different provider, model, or engine. Recommended
  defaults help users start; they do not remove alternatives or override an
  existing selection.
- Distinguish actual inability to execute from incomplete safety guarantees.
  Missing credentials, an unavailable executable, or an API that cannot perform
  the requested operation must be reported accurately with an actionable remedy.
  Do not invent support, fabricate success, or label a policy preference as a
  technical impossibility.

### Incomplete guarantees mean best effort and disclosure, not a ban

- When execution is possible but full safety or isolation cannot be guaranteed,
  use the available best-effort path and explain the concrete limitation. The
  user decides whether to use it; do not impose a blanket prohibition.
- Keep working protections enabled. Best effort is not a reason to discard
  protections that are available or to expose unrelated credentials.
- Warnings must identify what is not guaranteed and its practical consequence,
  without claiming verified isolation or read-only enforcement that is absent.
  Keep them concise and actionable; expose them in CLI output and structured
  MCP results, not only in hidden logs.
- Honor explicit user choices about execution and protection. Never silently
  downgrade a guarantee the user specifically required. Offer the best-effort
  alternative with its limitations instead of choosing on the user's behalf.
- Do not introduce extra mandatory confirmation loops or an opt-in flag solely
  because a route is best effort. Surface the limitation without turning normal
  setup into a sequence of alarming security prompts.
- This decision supersedes older documentation and tests that require rejecting
  a provider or engine solely for incomplete safety guarantees. It does not
  authorize secret disclosure, disregard of user intent, or unrelated removal
  of input validation and release-integrity checks.

### Easy by default; Advanced by choice

- The default wizard path is Easy: minimal choices, sensible recommendations,
  reuse of existing configuration, and a direct path to the first usable setup.
- Do not open first-run setup with a large settings dashboard, an exhaustive
  provider/engine matrix, or a list of environment variables.
- Ask only for information needed to complete the user's selected setup. Infer
  what can be established reliably; do not require users to understand model
  roles, execution projections, endpoints, or isolation internals just to start.
- Offer Advanced as an optional path for complete supported configuration,
  including providers, models, engines, scopes, integrations, and operational
  settings. Users can enter it immediately or revisit it after Easy setup.
- Easy and Advanced must share resolution, setup, persistence, and verification
  logic. They differ in the detail exposed, not in correctness or user choice.
- Explain consequential actions and concrete execution limitations briefly when
  relevant. Keep technical detail available without overwhelming the main flow.
- Re-running Easy must preserve explicit existing choices unless the user asks
  to change them. Report incomplete setup honestly rather than printing a
  misleading success message.

## Consequences and implementation status

This is the required direction for implementation and review, not a claim that
all routes already work. At acceptance, non-coder projections still reject
OpenCode 2, OMP, and Crush; registry providers lack a direct transport; and the
wizard retains its existing Standard/Advanced behavior. Those limitations must
be addressed as implementation gaps, not carried forward as product policy.
This documentation change does not itself remove runtime gates.

Changes must be judged against user-observable behavior: selected routes are
honored, executable best-effort paths remain available with truthful warnings,
and Easy reaches a usable setup without an administration menu. Tests that
encode arbitrary bans must change with the implementation, not preserve the bans.

## Alternatives rejected

- Treating current engine allowlists as immutable security requirements.
- Blocking executable routes until every safety property can be verified.
- Hiding unsupported guarantees behind a silent fallback or a false success.
- Making a comprehensive settings dashboard the default first-run experience.
- Maintaining separate setup implementations for Easy and Advanced.

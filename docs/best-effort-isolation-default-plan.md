# Best-effort OpenCode credential mode by default

Status: implementation plan only. No runtime behavior is changed by this
document.

## Objective

Make the OpenCode behavior currently selected by
`TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=1` the default for both `opencode` and
`opencode2`. The current proxy-backed, fail-closed mode must remain available
through a new explicit configuration flag:

```text
TRISS_CODER_REQUIRE_PROTECTED_PROXY=1
```

In this plan, "flag" means a reloadable Triss environment/config flag. It uses
the existing shell > project `.triss.env` > global
`~/.config/triss/.env` precedence. Adding a separate CLI or MCP per-call switch
is intentionally out of scope; every existing entry point already resolves the
credential mode through the shared config snapshot.

## Current behavior and evidence

- `src/coder-providers.js::resolveCoderCredentialMode` returns
  `best_effort_raw` only for the literal old value `1`; unset, `0`, and every
  other value return `protected_proxy`.
- `src/config.js::readCoderCredentialMode` reloads that decision from the parent
  shell and the selected local/global env-file scope. `coder init`, the config
  wizard, long-lived MCP calls, and `coder run` all consume this shared path.
- `src/commands/coder.js::runCoderRun` derives `protectedRouting`, provider
  overlays, raw-key forwarding, the credential proxy requirement, readable
  credential-store checks, warnings, and the envelope's `credential_mode` from
  the resolved mode.
- OpenCode raw mode passes only the selected provider credential to the child,
  skips the parent proxy, reports
  `execution_capabilities.credential_isolation: "unavailable"`, and emits
  `TRISS_CODER_CREDENTIAL_ISOLATION_DOWNGRADED`.
- OpenCode protected mode starts the parent-owned loopback proxy, passes its
  run-scoped token instead of the raw key, rejects readable raw credential
  stores, and reports the proxy capability honestly as `best_effort`, not
  `enforced`.
- OpenCode 2 additionally uses the mode in `src/opencode2-preflight.js` and
  `src/commands/coder.js` to choose the shared `opencode.json` policy and to
  admit or reject plugins, agents, custom tools, MCP blocks, and live shell
  rules.
- Crush is different: it always requires its credential proxy. The OpenCode
  default inversion must not change Crush behavior.

The existing `--allow-best-effort-caller-worktree` option is unrelated. It
controls a fallback from requested Git worktree isolation to the caller
worktree; it must not select or imply a credential mode.

## Target contract

### Stable runtime semantics

For `opencode` and `opencode2`:

| Effective selection | `credential_mode` | Raw provider key in child | Proxy | Credential capability |
|---|---|---:|---:|---|
| No credential-mode flag | `best_effort_raw` | yes, selected key only | no | `unavailable` |
| `TRISS_CODER_REQUIRE_PROTECTED_PROXY=1` | `protected_proxy` | no | required | `best_effort` |

The default raw route must retain every current raw-mode safeguard:

- resolve exactly one canonical provider and credential;
- remove every unrelated provider credential from the child environment;
- retain endpoint, model, package, header, and credential-binding audits;
- retain OpenCode 2 structural/config-shape checks;
- retain the stable downgrade warning in stderr and envelope `warnings`;
- never claim credential isolation above `unavailable`;
- never make raw mode eligible for a verified protected-credential claim.

Protected mode must retain the current behavior byte-for-byte where practical:

- proxy startup is mandatory and fails before engine spawn if unavailable;
- only the run-scoped proxy token reaches the child;
- readable raw credential stores still fail closed;
- OpenCode 2 still rejects unverified executable surfaces and live allow/ask
  policy;
- a fresh protected OpenCode 2 init still writes the deny-everything shared
  policy and emits its V1 degradation warning;
- the envelope continues to say `credential_mode: "protected_proxy"` and
  reports only the capability the proxy actually provides.

For `crush`, ignore both OpenCode mode flags and preserve its unconditional
proxy requirement, current worktree-isolation default, and current envelope.

### Flag parsing and migration

Use one shared, pure resolver and one exported default constant rather than
scattered string defaults. Literal new value `1` selects protected mode and
literal `0` explicitly keeps the raw default. Any other non-empty value is a
configuration error; do not silently downgrade a misspelled protection request
to raw mode.

Preserve explicitly configured old behavior for one deprecation window so the
default inversion does not silently weaken an installation that deliberately
stored the old value `0`:

| New flag | Deprecated old flag | Result during transition |
|---|---|---|
| unset | unset | `best_effort_raw` (new default) |
| `0` | unset | `best_effort_raw` |
| `1` | unset | `protected_proxy` |
| unset | `1` | `best_effort_raw` plus deprecation warning |
| unset | `0` | `protected_proxy` plus deprecation warning |
| `0` or `1` | `0` or `1` | fail closed because both selectors are explicitly present |
| invalid non-empty value | any | fail before init mutation, proxy startup, credential read, or engine spawn |

The deprecation warning needs a stable code, for example
`TRISS_CODER_CREDENTIAL_MODE_FLAG_DEPRECATED`. `coder run` must put it in stderr
and envelope `warnings`; init/wizard paths must print it before any mode-specific
mutation. Do not rewrite `TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION` automatically
because Triss must not mutate user configuration during an unrelated run.

After the documented compatibility window, remove the legacy `0`/`1` branches
and the old flag. That removal is a separate change with its own release note.

## Implementation packages

### 1. Centralize and invert mode resolution

Update `src/coder-providers.js`:

1. Export a canonical default such as
   `DEFAULT_CODER_CREDENTIAL_MODE = 'best_effort_raw'`.
2. Extend `resolveCoderCredentialMode` to read both flags and return the mode
   plus enough provenance/deprecation metadata for callers to warn without
   re-reading `process.env`.
3. Validate contradictory and malformed explicit values at this boundary.
4. Keep `protected_proxy` and `best_effort_raw` as the internal and envelope
   enum values; renaming them would create unrelated compatibility churn.
5. Skip OpenCode flag validation entirely for Crush so an OpenCode-only setting
   cannot change or block a Crush init/run.

If retaining the current string return type is important for callers, add a
second detailed resolver and keep `resolveCoderCredentialMode` as the string
projection. Do not duplicate the matrix in init, run, or MCP code.

Update `src/config.js`:

1. Add `TRISS_CODER_REQUIRE_PROTECTED_PROXY` to `PROVIDER_ENV_KEYS` and the
   immutable import-time parent snapshot.
2. Make `readCoderCredentialMode` read both old and new keys in one scope-aware
   snapshot so shell/local/global precedence and conflict detection are atomic.
3. Return the shared resolver result on every call so a long-lived MCP process
   observes file edits and deletions without restart.

Update `src/commands/coder.js`:

1. Add the new flag to `NON_SECRET_CODER_STORE_KEYS`; the control flag alone
   must not make a protected run classify an env file as credential-bearing.
2. Replace messages that instruct users to opt into old best-effort mode with
   the new default/protected-mode guidance.
3. Thread deprecation metadata to init/wizard output and run warnings.
4. Keep `deps.allowBestEffortIsolation` as a test-only readable-store-gate seam;
   it is not a public mode selector.

### 2. Align every internal default and OpenCode 2 policy

Audit all default parameters and pure helpers that currently embed
`'protected_proxy'`, including:

- `src/commands/coder.js::staticOpenCode2Preflight`;
- `runCoderSetupUnlocked` and `writeOpencodeConfig`;
- the run/envelope helper defaults in `src/commands/coder.js`;
- `src/opencode2-preflight.js::computeEffectivePermissionPolicy`,
  `assertV2DocumentShape`, `auditOpenCode2Documents`, and `auditOpenCode2Run`;
- `src/coder-orchestration.js::buildExecutionCapabilities`.

Prefer passing the resolved mode explicitly into security-sensitive helpers.
Where a public pure helper intentionally supports omission, use the one
exported default constant. There must be no path where a bare top-level run is
raw but an omitted nested helper silently applies protected policy.

Re-run both init paths with the new default:

- bare `triss coder init` / wizard setup for OpenCode 1 writes the existing V1
  deny-first allowlist and follows raw provider routing;
- bare `triss coder init --engine opencode2` accepts the same executable
  surfaces as today's explicit raw mode and does not emit the protected shared-
  config degradation warning;
- protected OpenCode 2 init selected by the new flag preserves today's strict
  preflight and deny-everything output;
- setup failures occur before credential/config writes exactly as today.

No CLI changes are required in `bin/triss.js`, no new MCP schema field is
required in `src/mcp/tools.js`, and no handler-only mode override should be
added. CLI, `triss exec`, wizard, and MCP must all see the same scoped flag via
the config resolver. If a future per-call override is desired, design it as a
separate CLI/MCP parity change rather than bypassing the shared resolver here.

### 3. Rebase the regression suite around the new default

Update the focused mode and precedence tests first:

- `test/coder-provider-registry.test.js`: lock the full transition matrix,
  invalid values, conflicts, and the new default.
- `test/secrets.test.js`: prove shell > local > global precedence for both flags,
  reload after edit/delete, and cross-scope conflict handling.
- `test/coder-isolation-gate.test.js`: make bare OpenCode runs reach the raw
  child; run every old fail-closed store/proxy case under the new flag; prove
  the flag itself is non-secret but does not exempt a real credential in the
  same store.
- `test/coder-best-effort-routing-matrix.test.js`: remove the old env opt-in
  from default raw cases and retain the complete two-engine/six-provider route,
  one-selected-key, endpoint, warning, and envelope assertions.
- `test/coder-envelope.test.js` and `test/coder-orchestration.test.js`: assert
  raw capability/warning values by default and protected values only under the
  new flag.
- OpenCode 2 init/preflight/config tests: swap assumptions so omitted mode is
  raw and protected fixtures pass the explicit new flag.
- `test/wizard-full.test.js`: preserve scoped snapshot behavior, but use the new
  resolver matrix and prove the default wizard writes the raw-compatible policy.
- `test/mcp-coder.test.js`: prove a bare long-lived MCP call is raw, the new
  scoped flag selects protected mode, edits/deletions are observed, and Crush is
  unchanged.

Update every remaining fixture returned by
`rg -l 'TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION|protected_proxy|best_effort_raw' test`
according to what it is actually proving. Do not blindly replace old `=1` with
the new flag: raw fixtures normally need no flag, while protected fixtures need
the new flag.

Restructure the test scripts without losing the old protected suite:

- add a protected-proxy suite that explicitly sets
  `TRISS_CODER_REQUIRE_PROTECTED_PROXY=1`, and retain `test:secure-default` as a
  deprecated alias for one compatibility window so external CI does not break;
- run `best-effort-*` and the routing/default tests with both flags unset;
- keep `npm test` running both modes;
- update `scripts/run-tests.js` so it clears the old selector where appropriate
  and cannot inherit a developer's real mode flags accidentally.

Add a black-box CLI fixture using an isolated HOME and fake engine spawn for
each mode. It must prove the actual process boundary, not only the pure
resolver: default raw passes exactly one fake selected key and no proxy token;
protected mode passes a proxy token and no raw key.

### 4. Update current contracts and migration documentation

Update current user-facing documentation together:

- `README.md`: default behavior, capability warning, provider table, setup/run
  examples, and the statement that unavailable credential isolation always
  blocks;
- `docs/configuration.md`: remove the old flag as the active selector, add the
  new flag with default `0`/unset, and document the transition matrix and
  precedence;
- `docs/engines/opencode2.md`: invert the mode descriptions, init policy,
  executable-surface behavior, and troubleshooting actions;
- `docs/glm-clients.md`: safety matrix, env table, rule-of-thumb prose, and
  sub-agent/plugin behavior;
- `docs/reliable-delegation-contract.md` and `docs/security-model.md`: distinguish
  default raw OpenCode credential handling from the still-fail-closed protected
  proxy mode and from caller-worktree isolation;
- `docs/troubleshooting.md`: tell users to set the new flag when they require the
  proxy-backed mode and explain its readable-store prerequisite;
- `CHANGELOG.md` `[Unreleased]`: call out the security-relevant default inversion,
  the honest warning/capability fields, the new flag, and old-flag deprecation.

Historical implementation plans such as
`docs/opencode-provider-routing-recovery-plan.md` and
`docs/reliable-delegation-contract-plan.md` should remain historical evidence.
Add a short supersession note only where a reader could mistake their old
default for the current contract; do not rewrite their original acceptance
criteria.

Run the generated/default documentation checks even if the generator does not
currently own these two variables, so an undocumented generated surface is not
missed.

## Verification

Run from the implementation worktree with no real provider keys inherited:

```bash
npm run typecheck
npm run lint
node --test test/coder-provider-registry.test.js test/secrets.test.js
node --test test/coder-isolation-gate.test.js test/coder-best-effort-routing-matrix.test.js
node --test test/coder-envelope.test.js test/coder-orchestration.test.js
node --test test/coder-opencode2-init.test.js test/coder-opencode2.test.js
node --test test/opencode2-provenance-regressions.test.js test/wizard-full.test.js
node --test test/mcp-coder.test.js
npm run check:config-docs
npm run check:docs
npm test
```

Then run two hermetic fake-provider smokes through the real CLI boundary:

1. With both flags unset, confirm one OpenCode child spawn,
   `credential_mode: "best_effort_raw"`, downgrade warning present,
   `credential_isolation: "unavailable"`, exactly one selected raw credential,
   and no proxy token.
2. With `TRISS_CODER_REQUIRE_PROTECTED_PROXY=1`, confirm one proxy-backed child
   spawn, `credential_mode: "protected_proxy"`, no raw credential in child
   env/argv/config, and the honest proxy capability.
3. Repeat the mode selection through a long-lived MCP test process after
   editing and deleting the local flag between calls.
4. Confirm Crush produces the same proxy-backed envelope and child environment
   with the new flag unset, set, and malformed OpenCode-only values absent from
   its effective decision.

Finally inspect:

```bash
git diff --check
git diff --stat origin/main...HEAD
rg -n 'TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION|TRISS_CODER_REQUIRE_PROTECTED_PROXY|protected proxy by default|Protected mode is the default' README.md docs src test package.json scripts
```

Every remaining old-flag reference must be either a migration test, a
deprecation notice, a changelog/history entry, or a superseded-plan note.

## Acceptance criteria

- A bare OpenCode 1 or OpenCode 2 init/run resolves to `best_effort_raw`.
- The default child receives exactly the selected raw credential and no other
  provider secret; endpoint/model/package/header audits still fail closed.
- Default runs retain the downgrade warning and never overstate credential
  isolation.
- Literal `TRISS_CODER_REQUIRE_PROTECTED_PROXY=1` reproduces today's protected
  proxy, readable-store gate, and OpenCode 2 executable-surface policy.
- Shell/project/global precedence and long-lived MCP reload behavior are covered
  for both transition flags.
- Contradictory or malformed explicit mode configuration fails before mutation,
  credential read, proxy start, or engine spawn.
- Explicit legacy `0` does not silently downgrade during the compatibility
  window; old `1` remains raw and both legacy uses warn.
- Crush behavior and caller-worktree isolation semantics are unchanged.
- CLI, wizard, `triss exec`, and MCP agree on the same effective mode.
- The complete protected and raw routing matrices, documentation checks, lint,
  typecheck, and full test suite pass.

## Rollout and rollback

Treat this as a security-relevant breaking default and release it with an
explicit changelog/migration note. Before upgrading, users who require the
current proxy-backed behavior can set
`TRISS_CODER_REQUIRE_PROTECTED_PROXY=1` in the appropriate project or global
Triss env file. No data migration is required.

Operational rollback is configuration-only: set the new flag to `1` to restore
the old mode without downgrading the package. A code rollback must restore the
resolver, tests, and current contract documentation together; do not roll back
only the warning or capability projection.

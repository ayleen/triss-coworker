# DeepSeek Harness provider bundle and ecosystem proposal plan

> **Historical pre-0.42 design record.** Legacy provider names, environment
> variables, model selectors, and commands below are migration history, not
> valid runtime guidance. See [`configuration.md`](configuration.md).

Implementation contract for an opt-in DeepSeek Harness bundle that activates existing OpenCode and Z.AI catalogue routes without hand-written provider profiles.

## Status and verified baseline

This plan was verified against `deepseek-ai/deepseek-harness` commit `47f943859bef60e4160492346772ded9b24f765a` on 2026-08-14.

At that commit, `@deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.5` declares `@earendil-works/pi-ai` with the semver range `^0.82.1`; the inspected upstream `pnpm-lock.yaml` resolves `pi-ai@0.82.1`.

The resolved `pi-ai@0.82.1` catalogue contains the `opencode`, `opencode-go`, and `zai` provider ids.

Its `opencode-go` catalogue contains `deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5.1`, and `glm-5.2`, while its `opencode` catalogue contains `deepseek-v4-flash` and other models.

The Harness base bundle mounts `@deepseek-ai/dsh-llm-pi-ai` with no active routes and exposes its catalogue providers through the configurable-provider directory.

The missing product layer is an installable provider-profile bundle, not another LLM transport adapter.

The current Harness `CONTRIBUTING.md` does not accept external pull requests.

The supported contribution route is a community ecosystem plugin, a GitHub Discussion, and the `dsh-plugin` repository topic.

The npm registry returned `E404` for `triss-dsh-provider-bundle` during planning, but absence is not a reservation; availability must be checked again immediately before publication.

## Accepted decisions

- Build a configuration-only `dsh.bundle`; do not duplicate endpoints, protocols, model catalogues, or authentication logic owned by `pi-ai`.
- Publish the bundle under the distinct npm identity `triss-dsh-provider-bundle`.
- Develop and release the companion package from the Triss repository and coordinated Triss release train, while keeping it out of the `triss-coworker` tarball.
- Activate three catalogue routes in v1: OpenCode Zen (`opencode`), OpenCode Go (`opencode-go`), and direct Z.AI (`zai`).
- Reuse `OPENCODE_API_KEY` for both OpenCode routes and use `ZAI_API_KEY` for direct Z.AI.
- Leave the Harness default provider and model unchanged because the bundle cannot infer the user's entitlement or preferred route.
- Treat provider ids and credential references as the stable bundle contract.
- Treat exact model ids as release evidence for the dependency version actually resolved during acceptance, not as an independently maintained catalogue.
- Publish and maintain the bundle as a standalone community ecosystem plugin.
- Propose possible official adoption through a GitHub Discussion; prepare an upstream PR only after a direct maintainer invitation or an upstream contribution-policy change.
- Keep Triss runtime, coder-engine, CLI, MCP, templates, and provider routing unchanged.

## Why the bundle needs a separate package identity

Harness resolves every bundle from the running `dsh` installation before it tries the profile's `node_modules`.

The same resolver is used after `dsh plugin add` to decide whether an installed dependency declares `dsh.bundle`.

Publishing the bundle inside `triss-coworker` would make a globally installed Triss package eligible at the installation-first anchor before the profile-local version.

An older global Triss without the manifest could make the profile dependency look bundle-less, while a different global bundled version could load the wrong patch.

The distinct identity `triss-dsh-provider-bundle` prevents an ordinary global `triss-coworker` installation from colliding with the profile bundle lookup.

The companion package must be installed only into Harness profiles; globally installing the companion package is unsupported because it would recreate an installation-anchor ambiguity for its own name.

## Goals

- Let a Harness user install one profile dependency instead of authoring an `llm-pi-ai.providers` mapping.
- Make one OpenCode credential reference available to both Zen and Go without copying the secret.
- Expose DeepSeek V4 and GLM 5.x through the model catalogue resolved by the user's Harness installation.
- Support direct Z.AI GLM access through the catalogue-owned `zai` route.
- Keep credentials in Harness credential sources and references, never in bundle configuration or package contents.
- Keep the community package close enough to a possible official bundle that future adoption requires repository integration rather than a behavioral rewrite.
- Prove package resolution, configuration layering, provider routing, model selection, and tool use before publication.
- Release the companion package through the same reviewed Triss version and tag while preserving its separate npm identity.

## Non-goals

- Adding a `deepseek-harness` engine to `triss coder` in this change.
- Embedding `dsh.bundle` metadata or bundle assets in `triss-coworker`.
- Replacing OpenCode or changing existing Triss OpenCode and Z.AI behavior.
- Forking or patching `pi-ai` provider implementations.
- Maintaining a second model catalogue in this repository.
- Selecting a default provider, model, reasoning effort, or tool policy for a Harness profile.
- Buying subscriptions, enabling regional hosting, changing privacy settings, or treating a configured key as proof of entitlement.
- Supporting arbitrary custom providers in v1; Harness already exposes that through settings and patch layers.
- Creating an upstream pull request while upstream policy rejects external PRs.
- Publishing an npm version, GitHub tag, GitHub Discussion, or future upstream PR without separate authorization for that external action.

## Package and release topology

The repository becomes an npm workspace with the existing root package and one publishable companion package:

```text
packages/dsh-provider-bundle/
├── package.json
├── cordis.patch.yml
├── README.md
└── LICENSE

test/
└── dsh-provider-bundle.test.js
```

The root `package.json` adds `packages/dsh-provider-bundle` to `workspaces` but does not add the companion to `files`, dependencies, optional dependencies, or bundled dependencies.

The root `triss-coworker` tarball therefore remains the Triss CLI package and contains no Harness manifest or bundle patch.

The companion manifest declares:

```json
{
  "name": "triss-dsh-provider-bundle",
  "version": "<release-version>",
  "type": "module",
  "files": ["cordis.patch.yml", "README.md", "LICENSE"],
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

The companion has no JavaScript entry point, runtime dependency, peer dependency, build output, `prepare`, preinstall, install, postinstall, or second release script.

The root and companion manifests use the same selected release version and are published from one exact `v<version>` tag.

Before the publication authorization gate, implementation must:

- select a new version greater than the currently published Triss version;
- update the version in root `package.json`;
- update the top-level and root-package version fields in `package-lock.json`;
- add the workspace package and its matching version to `package-lock.json` through npm, not by manual lockfile editing;
- set the same version in `packages/dsh-provider-bundle/package.json`;
- move the relevant `CHANGELOG.md` content from `Unreleased` into the dated release section and recreate an empty `Unreleased` section;
- describe both the companion bundle and the unchanged Triss runtime boundary in the changelog;
- update release workflow tests and `.github/workflows/publish.yml` so tag-to-version checks cover both manifests, both tarballs are inspected, and both npm packages publish with provenance.

The release workflow must be safely retryable when one npm publication succeeds before the other.

An already-published target version is acceptable only when registry metadata and tarball integrity match the locally verified artifact; any mismatch fails closed and requires a new version.

### Release authorization: fresh vs retry (review round 4, §1)

Because an already-used `package@version` combination can never be published
again, a partially published release train MUST remain completable even after
`main` has moved past the tag. The publish workflow therefore authorizes a
tag in one of two modes, decided from live registry state BEFORE any step
needs `id-token` permissions:

- **fresh** — neither package exists on the registry yet: the tag SHA must
  equal the current `origin/main` SHA (a new release is only ever authorized
  at the exact tip), and the tagged `install.sh` must match `origin/main`.
- **retry** — at least one package is already published with byte-identical
  content: the tag SHA must merely be an ancestor of current `origin/main`
  (`git merge-base --is-ancestor`), so the remaining package can be
  published and the release completed.

`scripts/publish-gate.js authorize-tag` implements this decision as a pure,
unit-tested function over the `plan-publish` result plus two booleans
(`--exact-main`, `--ancestor-main`).

### Verified-bytes publication (review round 4, §7)

The workflow publishes exactly the bytes that were inspected by the gates:
the unprivileged `release-gates` job packs and hashes both tarballs, and the
publish job re-packs with `npm pack --ignore-scripts` (no lifecycle hooks,
no repository scripts, no `npm ci`) and byte-compares the SHA-256 of both
repacked tarballs against the gates artifact before `npm publish
--ignore-scripts --provenance` runs from the checked-out directories.
`npm pack` output is byte-deterministic, and `npm publish` packs through the
same code path, so the published tarball equals the inspected artifact.
Provenance requires publishing from a git checkout in CI, which is why the
publish step uses verified directories rather than the pre-packed tarball
files.

### Environment and required gates (review round 4, §3–4)

The tag publish workflow calls the same reusable bundle-checks workflow
(bundle matrix + real Harness lifecycle) as PR CI, aggregates them in a
`release-gates` job, and only the minimal `npm-publish` job — which runs no
repository scripts — holds `id-token: write` and the `npm-production`
environment. Owner-side settings (not expressible in this repository's
code) are required before the first tag: make the aggregate checks required
in the repository ruleset, add required reviewers to the `npm-production`
environment, bind the npm trusted publisher to that environment, and
protect `v*` tags. If the companion package does not yet exist on npm,
trusted publishing cannot be configured for it: a one-time bootstrap
publication of the exact verified tarball (followed by enabling the trusted
publisher and disabling token publishing) must be authorized first.

## Compatibility evidence contract

Every local tarball acceptance, CI run, and registry smoke records this tuple:

```text
Node version
pnpm version
@deepseek-ai/dsh version
@deepseek-ai/dsh-llm-pi-ai version
resolved @earendil-works/pi-ai version
resolved pi-ai package integrity from the profile lockfile
triss-dsh-provider-bundle version and tarball integrity
```

The isolated profile smoke retains the output of `pnpm list @earendil-works/pi-ai --depth Infinity --json` and the relevant integrity entry from its lockfile.

Release evidence must not call `pi-ai` pinned merely because the adapter declares `^0.82.1`.

Provider-id and credential-reference assertions always run.

Exact model-id assertions are derived from and reported with the resolved `pi-ai` version.

If the resolved catalogue removes or renames an acceptance model, implementation selects a current model and updates evidence rather than declaring a stale local model.

Compatibility is never claimed from the Harness version alone.

## Runtime prerequisites

Normal Triss CLI installation retains its current `Node >=22` contract.

Using the companion bundle through Harness requires Node `^22.19.0 || >=24.0.0`, matching the verified Harness engine range.

Bundle CI and tarball acceptance run on at least Node `22.19.0` and Node `24`; Node `26` is included while upstream supports it.

The `dsh plugin` command forwards directly to `pnpm`, so `pnpm` must be installed and available on `PATH`.

The bundle README lists Node, pnpm, tested `dsh`, resolved `dsh-llm-pi-ai`, and resolved `pi-ai` versions before the installation command.

## Bundle contract

The bundle replaces the dormant base row's complete composition configuration:

```yaml
- id: llm-pi-ai
  config:
    providers:
      opencode:
        apiKeyEnv: OPENCODE_API_KEY
      opencode-go:
        apiKeyEnv: OPENCODE_API_KEY
      zai:
        apiKeyEnv: ZAI_API_KEY
```

The bundle-owned composition base declares exactly `opencode`, `opencode-go`, and `zai`.

The bundle must not declare `baseURL`, `api`, models, headers, context windows, output limits, reasoning formats, or pricing.

Omitting those fields makes `dsh-llm-pi-ai` reuse each resolved catalogue provider's protocol, endpoint, model metadata, compatibility settings, and authentication support.

The bundle does not override the `agent-default-model` row.

## Configuration layering contract

Harness resolves provider profiles through schema defaults, the bundle-owned composition base, user settings, and later patch layers.

The effective runtime configuration may therefore contain additional routes or override bundle-owned fields.

A user setting may change `opencode.apiKeyEnv`, override its endpoint or models, or keep a route active after the bundle is removed.

Removing the bundle restores the dormant base posture only in a clean isolated profile with no user `llm-pi-ai` settings and no later patch that activates routes.

Removing the bundle never deletes user settings.

A provider route registered by another adapter family conflicts with the same route from this bundle and must fail loud with the upstream duplicate-adapter contract; the bundle never silently takes ownership.

## Credential and security contract

The bundle stores credential references only.

It never receives, reads, copies, logs, serializes, or publishes credential values.

Both OpenCode routes reference `OPENCODE_API_KEY`, allowing one managed Harness credential or inherited environment value to serve Zen and Go without duplication.

Direct Z.AI references `ZAI_API_KEY`, the name owned by the resolved `pi-ai` provider.

Triss uses `ZHIPU_API_KEY` for its own Z.AI integration, but the companion bundle does not copy, rename, or alias that secret.

A user who wants the same underlying credential in both products explicitly stores it under each product's expected reference.

Live tests receive only the credential required by the selected route and never retain a credential value in logs, fixtures, snapshots, package metadata, release evidence, or a Discussion.

## User contract

Installation into an existing Harness profile is:

```bash
pnpm --version
node --version
dsh plugin --profile headless add -w triss-dsh-provider-bundle@<version>
dsh --profile headless --dump-config
```

`dsh plugin add` forwards to `pnpm add`, and pnpm 9 treats the Harness
profile directory (its `pnpm-workspace.yaml` declares `packages: [.]`) as a
workspace root, so the command needs `-w` — the form the lifecycle CI job
verifies — or `NPM_CONFIG_IGNORE_WORKSPACE_ROOT_CHECK=true` in the
environment. The verified tuple is dsh `0.1.0-rc.6` × pnpm `9.0.0`.

The companion package can be installed into any profile that already includes `@deepseek-ai/dsh-base`; it does not own the runner or UI layer.

The README documents these release-acceptance routes:

| Route | Credential reference | Initial acceptance model for resolved `pi-ai@0.82.1` |
| --- | --- | --- |
| `opencode` | `OPENCODE_API_KEY` | `nemotron-3-ultra-free` (free tier; the paid `deepseek-v4-flash` is balance-blocked on the acceptance workspace — see the acceptance status) |
| `opencode-go` | `OPENCODE_API_KEY` | `deepseek-v4-flash`, `glm-5.2` |
| `zai` | `ZAI_API_KEY` | `glm-5.2` |

The table is release evidence, not a package-owned static catalogue.

Model availability, billing, quota, regional hosting, and provider policy remain service-owned runtime facts.

An HTTP 401, 403, 429, billing rejection, free-usage limit, or regional-opt-in response is surfaced without mutating configuration or falling back to a different route.

## Keyless package and composition tests

### Package contract

Focused tests prove:

- the companion owns a distinct package name and the root tarball contains neither its manifest nor patch;
- the package manifest resolves `cordis.patch.yml` from the packed tarball;
- the public file allowlist contains only the manifest plus `cordis.patch.yml`, README, and license;
- the companion has no executable lifecycle hooks or undeclared dependency closure;
- its Node engine matches the verified Harness range;
- the bundle patch declares only the three intended catalogue profiles and credential references;
- forbidden duplicated provider fields are absent;
- installation does not change the Harness default provider or model.

### Package-resolution isolation matrix

End-to-end fixtures exercise both globally installed and `npx`-style Harness layouts with:

1. no global `triss-coworker` installation;
2. an older global Triss without `dsh.bundle`;
3. an older global Triss carrying a deliberately different bundle patch;
4. a newer global Triss than the profile companion;
5. companion installation into a new profile;
6. companion update between two fixture versions with different non-secret marker metadata;
7. companion removal;
8. companion reinstallation.

Every case asserts that Harness resolves `triss-dsh-provider-bundle` from the profile's `node_modules`, never from a `triss-coworker` package at the installation anchor.

The update case must change the effective companion patch, and removal must delete the companion from `dsh.profile.bundles`.

### Settings-layer matrix

Composition tests cover:

1. a clean profile, where the bundle base activates the three routes;
2. user settings that add a fourth provider, which remains present beside the three base routes;
3. user settings that override `opencode.apiKeyEnv`, which win in the effective configuration;
4. bundle removal with retained user settings, which preserves user-owned routes and values;
5. bundle reinstallation, which restores the composition base without deleting user overrides;
6. a route collision with another adapter family, which fails loud with the duplicate-adapter error;
7. clean-profile removal, which alone restores the dormant `llm-pi-ai` posture.

## Live and tool-use acceptance

Every live request explicitly names its provider and model and captures session or event evidence proving the resolved pair.

Before publishing, the configured acceptance account must complete successful minimal text requests through:

- `opencode/deepseek-v4-flash`;
- `opencode-go/deepseek-v4-flash`;
- `opencode-go/glm-5.2`;
- `zai/glm-5.2`.

If the resolved catalogue changes, the exact replacements are selected from that catalogue and recorded with the compatibility tuple.

An entitlement or billing failure proves error propagation but does not satisfy successful live acceptance.

Coding-tool acceptance runs two disposable tasks with explicit routing:

1. provider `opencode-go`, model `deepseek-v4-flash`;
2. provider `opencode-go`, model `glm-5.2`.

Each task must produce captured evidence containing the selected provider and model, at least one tool call, the matching tool result, and the expected disposable file diff.

A successful final diff without route and tool-event evidence is a failed acceptance test.

No live test may silently retry through `deepseek-official` or another provider.

### Acceptance status (pre-release, 2026-08-15)

Recorded honestly rather than rounded up to green:

- `opencode` route — SATISFIED (2026-08-15, late evening) via an
  owner-approved catalogue substitution: `opencode/nemotron-3-ultra-free`
  completed a successful minimal text request ("pong") through the bundle
  profile (dump-config proves provider `opencode` + model
  `nemotron-3-ultra-free`; resolved `pi-ai@0.82.1`). A second free-tier
  model, `laguna-s-2.1-free`, also returned a successful response. The
  original paid `deepseek-v4-flash` stays 401 `CreditsError` on this Zen
  workspace (insufficient balance — an account fact, not a code defect),
  and some free catalogue entries are not enabled for the workspace
  (`ling-3.0-flash-free`, `north-mini-code-free` → 401 `ModelError`);
  `deepseek-v4-flash-free` and `mimo-v2.5-free` returned 429 under their
  per-model free quotas. Credential: the account's only key (opencode CLI
  auth; `gai1.opencode.env` holds the same value).
- `opencode-go/deepseek-v4-flash` — passed (text and coding-tool);
- `opencode-go/glm-5.2` — passed (text and coding-tool);
- `zai/glm-5.2` — passed.

All four text routes and both coding-tool cases are green. Live acceptance
is complete; publishing is now gated only on the explicit tag/publication
authorization (plan step 15) and the owner-side release prerequisites.

The registry smokes recorded alongside this status ran against a local
`npm pack` tarball (byte-identical to the future registry artifact) BEFORE
publication. They are pre-release evidence, not the post-publication
registry install that a complete step 16 requires. The publish workflow's
`registry-acceptance` job covers the automatable half of step 16 after
publication: install the registry companion into fresh profiles on Node
`22.19.0` and `24`, verify add/remove/reinstall through `dsh plugin`, assert
the three routes by PARSING the dumped `llm-pi-ai.config.providers` object
(exact provider set and `apiKeyEnv` mapping — substring greps accepted
partial configurations, review round 4 §2), byte-verify both published
packages against the gates artifact, and record the full compatibility
tuple plus registry integrity and provenance attestations as an evidence
artifact. The evidence step is FAIL-CLOSED: every tuple field is required
(the job dies on any missing value), the profile `pnpm list --depth
Infinity --json` output and the profile `pnpm-lock.yaml` are uploaded as
artifacts, and the companion's integrity is taken from that lockfile. The
adapters (`dsh-llm-pi-ai`, resolved `pi-ai`) resolve from the running dsh
INSTALLATION, not from profile dependencies (verified live: the profile
carries only the companion and the template bundles) — their versions are
recorded from the installation and the resolved `pi-ai`'s registry
integrity for that exact version is recorded alongside. Provenance is
verified rather than assumed: attestations are read from
`dist.attestations` (where npm/pacote store them) and additionally checked
cryptographically by installing the exact released version into a throwaway
project and running `npm audit signatures --json --include-attestations`
(the companion must show verified statuses with nothing invalid or
missing). The registry UPDATE path runs whenever a previous registry version
exists (install previous, then update in place to the exact released
version); for the FIRST release of the companion no previous version can
exist, and update mechanics are guaranteed by the real-Harness lifecycle
job's in-place v1→v2 proof — an explicit amendment of this contract. Live
provider-model smokes on the published package remain credential-bound
recorded acceptance evidence and are not part of CI.

## Community ecosystem proposal

The bundle is published and documented as an independently maintained community plugin, not as a temporary copy awaiting an official package.

After registry acceptance, and only with explicit authorization, create a GitHub Discussion that includes:

- the configuration gap and why a transport adapter is unnecessary;
- the three provider profiles and credential references;
- the package-resolution, layering, and live acceptance evidence;
- the published package and repository link;
- the compatibility tuple;
- a question asking whether maintainers want an official provider-preset bundle or prefer the ecosystem package to remain external.

Associate the Triss repository with the `dsh-plugin` topic after separate authorization.

Do not prepare an upstream branch, Agent Note, bilingual upstream documentation, repository tests, or pull request while `CONTRIBUTING.md` rejects external PRs.

A future upstream implementation begins only after a direct maintainer invitation or a verified policy change and follows the then-current repository instructions rather than this snapshot.

## Implementation sequence

1. Re-verify current Harness contribution policy, engine range, plugin resolution, `dsh-llm-pi-ai` dependency range, and resolved catalogue.
2. Re-check npm availability for `triss-dsh-provider-bundle`; stop before implementation if the name is no longer available.
3. Add RED tests for package identity, workspace metadata, public files, lifecycle-hook absence, patch shape, route ids, credentials, default preservation, and forbidden duplicated fields.
4. Add RED package-resolution fixtures for every global-Triss, install, update, remove, and reinstall scenario.
5. Add RED composition fixtures for clean, added-provider, overridden-key, retained-settings removal, reinstall, duplicate-adapter, and clean removal behavior.
6. Add the minimal workspace package, patch, README, and license needed to make those tests pass without changing Triss runtime code.
7. Update release-gate tests and workflows to version, pack, inspect, provenance-publish, retry, and registry-verify both package identities from one tag.
8. Add the dedicated Node `22.19.0`, `24`, and `26` bundle matrix and verify `pnpm`-missing diagnostics separately.
9. Run focused tests, the complete root Triss suite, lint, `git diff --check`, workspace lockfile validation, and packed-tarball inspection.
10. Install the packed companion into isolated global and `npx`-style Harness fixtures and run the package-resolution and settings-layer matrices.
11. Record the complete dependency and integrity tuple from each accepted tarball installation.
12. Run all four explicit text-route smokes and both explicit coding-tool smokes, retaining only redacted route, model, tool-event, and result evidence.
13. Select the release version, update both manifests and generated lockfile fields, move the changelog entry out of `Unreleased`, and rerun every release and tarball gate.
14. Review the final diff and both tarballs for secrets, unrelated files, generated debris, root-package contamination, and any Triss runtime integration.
15. Ask for explicit authorization to create the coordinated version tag and publish both npm packages.
16. After publication, install the registry companion into fresh isolated profiles on Node `22.19.0` and `24`, verify install/update/remove, and repeat all three provider-route families with explicit model evidence.
17. Ask separately for authorization to add the `dsh-plugin` topic and publish the maintainer Discussion.

The coordinated npm release and ecosystem proposal are separate external actions and require separate approval.

## Deferred Triss integration

This plan adds no Triss runtime or coder-engine support.

The following surfaces remain unchanged during bundle implementation and publication:

- `src/coder.js` and all coder engine/provider routing;
- CLI commands, help, completion, status, and config wizard behavior;
- MCP tool schemas and descriptions;
- agent instruction templates and `triss init` output;
- `TRISS_CODER_*`, worker, OpenCode, and Z.AI environment contracts;
- the root `triss-coworker` published-file allowlist and runtime dependency graph.

A later Triss integration plan begins only when:

1. the companion package is publicly installable and registry-verified;
2. its packed contents and installation path are stable;
3. fresh profiles pass all required provider and tool-use smokes;
4. Harness invocation satisfies Triss deny-first command policy, credential isolation, non-interactive execution, output capture, cancellation, and worktree rules;
5. the user explicitly authorizes integration work.

That later plan decides whether Harness becomes a new coder engine, a user-managed external engine, or a documented manual option.

## Acceptance criteria

- The bundle publishes as `triss-dsh-provider-bundle`, not as part of `triss-coworker`.
- Both packages live in the Triss repository, share the selected version and tag, and have independently inspected tarballs.
- Global or `npx` Triss installations at older, newer, bundle-less, and different-patch versions cannot change which companion package the Harness profile resolves.
- Install, update, remove, and reinstall behavior is verified through `dsh plugin` with `pnpm` on `PATH`.
- The bundle-owned composition base declares exactly `opencode`, `opencode-go`, and `zai`; effective settings may add or override routes.
- Clean, overridden, additive, retained-settings removal, reinstall, clean removal, and adapter-conflict fixtures have explicit expected outcomes.
- OpenCode Zen and Go base profiles use `OPENCODE_API_KEY`; direct Z.AI uses `ZAI_API_KEY`.
- No secret copying or `ZHIPU_API_KEY` aliasing occurs.
- Installing the bundle does not change the Harness default provider or model.
- Compatibility evidence records exact Node, pnpm, Harness, adapter, resolved `pi-ai`, lockfile integrity, package version, and tarball integrity facts.
- Exact model assertions are tied to the recorded resolved catalogue.
- Successful live text acceptance explicitly proves `opencode`, `opencode-go`, and `zai` routes with captured provider/model evidence.
- Coding-tool acceptance explicitly proves `opencode-go/deepseek-v4-flash` and `opencode-go/glm-5.2`, including tool call, tool result, provider/model evidence, and expected file diff.
- Bundle validation passes on Node `22.19.0`, `24`, and `26`; normal Triss retains `Node >=22`.
- The README requires `pnpm` on `PATH` and reports the tested compatibility tuple.
- Root and companion manifest versions, generated lockfile versions, tag, and changelog release section agree before publication authorization.
- Release gates pack, inspect, publish, and registry-verify both packages with provenance and safe retry semantics.
- The root Triss tarball contains no companion manifest or patch, and Triss runtime tests remain green without Harness integration.
- The community package is presented as an independent ecosystem plugin.
- No upstream PR artifacts are required or created while upstream rejects external PRs.
- Neither npm publication nor the Discussion/topic write occurs without explicit authorization.

## Validation for this planning change

This document-only correction requires:

```bash
git diff --check
git status --short --branch
git diff -- docs/deepseek-harness-provider-bundle-plan.md
```

No package, source, workflow, lockfile, changelog, or runtime configuration change belongs in the planning commit.

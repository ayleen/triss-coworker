# DeepSeek Harness provider bundle and upstream contribution plan

Implementation contract for an opt-in DeepSeek Harness bundle that makes the existing OpenCode and Z.AI catalogue routes usable without hand-writing provider profiles.

## Status

The plan is based on upstream `deepseek-ai/deepseek-harness` commit `47f943859bef60e4160492346772ded9b24f765a` and its pinned `@earendil-works/pi-ai@0.82.1` dependency.

That `pi-ai` release already ships the `opencode`, `opencode-go`, and `zai` providers.

The `opencode-go` catalogue includes `deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5.1`, and `glm-5.2`, and its native credential discovery uses `OPENCODE_API_KEY`.

The Harness base bundle already mounts `@deepseek-ai/dsh-llm-pi-ai` in a dormant state and registers its complete catalogue as configurable providers.

The missing product layer is therefore an installable profile bundle, not another LLM transport adapter.

## Accepted decisions

- Build a configuration-only `dsh.bundle`; do not implement endpoints, wire protocols, model catalogues, or authentication logic already owned by `pi-ai`.
- Activate three catalogue routes in v1: OpenCode Zen (`opencode`), OpenCode Go (`opencode-go`), and direct Z.AI (`zai`).
- Reuse `OPENCODE_API_KEY` for both OpenCode routes and use the upstream-native `ZAI_API_KEY` reference for the direct Z.AI route.
- Leave the Harness default provider and model unchanged because the package cannot know which subscription or key the user has.
- Distribute the community bundle inside the existing `triss-coworker` npm package before upstream acceptance.
- Contribute the same behavior upstream as an official opt-in bundle, proposed as `@deepseek-ai/dsh-opencode-zai` under `packages/bundle/opencode-zai`.
- Change only Triss npm distribution metadata, bundle assets, tests, and the bundle's own documentation; keep Triss runtime, CLI, MCP, templates, and provider configuration unchanged.
- Treat later Triss support as a separate change with its own plan and approval.

## Goals

- Let a Harness user install one package instead of hand-authoring an `llm-pi-ai.providers` mapping.
- Make one existing OpenCode key available to both Zen and Go routes without copying the secret.
- Expose DeepSeek V4 and GLM 5.x models through the catalogue owned by the installed `pi-ai` version.
- Support direct Z.AI GLM access through the catalogue-owned `zai` route.
- Keep provider credentials in Harness credential sources and references, never in the bundle or settings values.
- Keep the embedded bundle assets structurally close enough to the upstream package that upstream acceptance requires packaging and repository metadata changes rather than a behavioral rewrite.
- Provide keyless composition tests and opt-in live acceptance without making CI depend on paid services.

## Non-goals

- Adding a `deepseek-harness` engine to `triss coder` in this change.
- Publishing or maintaining a second Triss-owned npm package for the bundle.
- Replacing OpenCode, changing Triss's existing OpenCode or Z.AI behavior, or migrating Triss users automatically.
- Forking or patching `pi-ai` provider implementations.
- Maintaining a second model catalogue in this repository.
- Selecting a default provider, model, reasoning effort, or tool policy for the user's Harness profile.
- Buying subscriptions, enabling regional hosting, changing privacy settings, or treating a configured key as proof of entitlement.
- Supporting arbitrary provider definitions in v1; Harness already exposes that through user settings and patch layers.
- Publishing a GitHub pull request, npm package, or release without the user's separate authorization for that external action.

## Package topology

### Triss npm distribution

The community bundle lives under `dsh/providers/` and ships in the existing `triss-coworker` tarball.

The root manifest remains the single package manifest and release authority.

The distribution-specific files are:

```text
dsh/providers/
├── cordis.patch.yml
└── README.md

test/
└── dsh-provider-bundle.test.js
```

The root `package.json` adds `dsh/providers/` to `files` and declares `dsh.bundle.patch: ./dsh/providers/cordis.patch.yml` alongside the existing Triss CLI metadata.

No JavaScript entry point, generated output, `prepare`, postinstall hook, runtime dependency, peer dependency, new npm script, or second version number is needed for the bundle.

The root package already requires Node 22 or newer, matching the current Harness requirement.

Because Harness is in developer preview, the bundle README and Triss release evidence name the exact tested Harness version, and compatibility claims widen only after the same `triss-coworker` tarball passes against the newer release.

Installing `triss-coworker` normally continues to install the Triss CLI.

Installing the same package through `dsh plugin add` additionally activates the manifest-declared bundle in that Harness profile; no Triss process participates at runtime.

### Upstream package

The upstream PR adds the equivalent package at `packages/bundle/opencode-zai/` with the repository's current version, publish metadata, bilingual README pair, and workspace conventions.

The upstream package name proposed in the PR is `@deepseek-ai/dsh-opencode-zai`.

Maintainers may request a different official name, but the package responsibility remains fixed: it is an opt-in provider-profile bundle and not a new adapter.

The upstream package owns no model-facing prompt text and has no direct KV-cache effect.

## Bundle contract

The bundle replaces the dormant base row's entire configuration, as required by Harness patch layering:

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

The route keys must match the installed `pi-ai` provider ids exactly.

The bundle must not declare `baseURL`, `api`, `models`, headers, context windows, output limits, reasoning formats, or pricing.

Omitting those fields makes `dsh-llm-pi-ai` reuse each catalogue provider's protocol implementation, endpoint, model metadata, compatibility settings, and authentication support.

The package does not override the `agent-default-model` row.

Users select a provider and model through existing Harness settings, the Web Models surface, a later profile patch, or the relevant CLI surface.

Because a later profile patch wins by row id and replaces the whole config, users can retain only a subset or change credential references by restating the `llm-pi-ai` row in their profile's `cordis.patch.yml`.

Removing the npm bundle removes all three base profiles; user-layer provider settings remain user-owned and are not deleted by package removal.

## Credential and security contract

The bundle stores only credential references.

It never receives, reads, copies, logs, serializes, or publishes credential values.

Both OpenCode routes reference `OPENCODE_API_KEY`, allowing one managed Harness credential or inherited environment value to serve Zen and Go without duplication.

The direct Z.AI route uses `ZAI_API_KEY` because that is the environment name owned by the pinned `pi-ai` provider.

Triss currently uses `ZHIPU_API_KEY` for its Z.AI integration, but the bundle must not add a Triss-specific alias to an upstream package.

A user who wants the same underlying Z.AI credential in both products explicitly stores it under the Harness reference `ZAI_API_KEY`; this plan does not copy it between stores.

No credential value may appear in tests, fixtures, snapshots, package metadata, `npm pack` output inspection, logs, documentation examples, or an upstream PR.

Live tests inherit only the credential required for the selected route and redact provider responses before retaining evidence.

## User contract

Installation into an existing Harness profile is:

```bash
dsh plugin --profile headless add triss-coworker@<version>
dsh --profile headless --dump-config
```

The same package can be added to any profile that already includes `@deepseek-ai/dsh-base`; it does not own the runner or UI layer.

The README documents the active routes and their model-qualified identities:

| Route | Credential reference | Initial live acceptance models |
| --- | --- | --- |
| `opencode` | `OPENCODE_API_KEY` | one model currently returned by the installed catalogue |
| `opencode-go` | `OPENCODE_API_KEY` | `deepseek-v4-flash`, `glm-5.2` |
| `zai` | `ZAI_API_KEY` | `glm-5.2` |

The table names acceptance targets, not a package-owned static catalogue.

The README states that model availability, billing, quota, regional hosting, and provider policy are runtime facts controlled by each service.

An HTTP 401, 403, 429, billing rejection, free-usage limit, or regional-opt-in response is surfaced as the provider's failure and does not trigger configuration mutation or fallback to another route.

## Upstream contribution

### Problem statement

Harness can already serve these providers after a user writes `llm-pi-ai` settings, but headless and reproducible profiles have no small official bundle that activates the common OpenCode and Z.AI catalogue routes with their conventional credential references.

The PR must describe that configuration gap accurately and must not claim to introduce the underlying transports or models.

### Upstream file scope

The expected upstream change contains:

- `packages/bundle/opencode-zai/package.json` with the official `dsh.bundle` manifest and repository metadata;
- `packages/bundle/opencode-zai/cordis.patch.yml` with the three provider profiles;
- `packages/bundle/opencode-zai/README.md` and `README.zh.md` describing installation, routes, credential references, override behavior, and limitations;
- an implemented feature Agent Note and Chinese counterpart under `.agents/notes/implemented/feature/`, recording the accepted bundle boundary and rejected adapter/default-model alternatives;
- the Agent Note consistency sidecar required by upstream gates;
- focused composition tests that install or compose the bundle over `dsh-base` and inspect the effective row and provider directory;
- an app-level keyless snapshot or equivalent observable composition fixture showing the three dormant-to-active route transitions without issuing network requests;
- the minimal workspace, release, documentation-navigation, and package-limitations gate updates required by upstream checks.

The implementation must inspect upstream at its then-current HEAD before editing because package version, dependency conventions, documentation budgets, and Agent Note policy may change during developer preview.

### Upstream tests

The upstream test contour proves:

- the bundle manifest resolves `cordis.patch.yml` from the packed package;
- composing it after `@deepseek-ai/dsh-base` leaves the existing plugin identity intact and replaces only the `llm-pi-ai` config;
- `llm.providers` reports `opencode`, `opencode-go`, and `zai` as active;
- both OpenCode profiles resolve the exact reference `OPENCODE_API_KEY`;
- the Z.AI profile resolves `ZAI_API_KEY`;
- `llm.models` derives entries from the pinned catalogue and includes `opencode-go/deepseek-v4-flash` and `opencode-go/glm-5.2` when those ids remain present in the pinned dependency;
- no provider becomes the agent default merely because the bundle is installed;
- removing the bundle layer restores the dormant base posture;
- no test performs a billable request unless its explicit live-test credential is present.

If an upstream dependency update removes or renames an acceptance model, implementation updates the evidence and acceptance target rather than adding a stale local model declaration.

### Upstream validation

Run the package-focused tests first, followed by the repository-required documentation, constraints, type, lint, build, and hygiene gates.

The expected full validation includes the current equivalents of:

```bash
pnpm run doc-sync
pnpm run constraints
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run hygiene
```

The final command list must come from the upstream HEAD's contributing instructions and package scripts, not from this historical snapshot.

Before publication, build the package tarball and install that tarball into an isolated Harness home and profile.

## Triss distribution implementation sequence

1. Re-verify the current upstream Harness release and exact pinned `pi-ai` catalogue.
2. Add RED tests for the root `dsh.bundle` manifest, published-file allowlist, exact patch shape, route ids, credential references, forbidden duplicated provider fields, and absence of bundle lifecycle code.
3. Add `dsh/providers/cordis.patch.yml`, its focused README, the root manifest field, and the `files` allowlist entry needed to make the tests pass.
4. Run the focused test, complete root Triss tests, lint, `git diff --check`, and a packed-tarball inspection.
5. Prove the tarball still exposes the existing `triss` binary and contains the two declared bundle assets without unrelated files or secrets.
6. Install that tarball into a temporary Harness profile with an isolated `DSH_HOME`, inspect `--dump-config`, list providers and models, and prove that the default model is unchanged.
7. With already-configured credentials, run minimal live text requests through `opencode-go/deepseek-v4-flash`, `opencode-go/glm-5.2`, and `zai/glm-5.2`.
8. Run one isolated coding-tool task that changes a disposable fixture and verify the expected file diff.
9. Review the final diff against this contract and prove that no Triss runtime, engine, CLI, MCP, template, or provider-resolution path changed.
10. Only after all local and tarball gates pass, ask for explicit authorization to publish the new `triss-coworker` version.
11. After publication, install the registry version into a fresh isolated profile and repeat the keyless composition check plus one minimal live OpenCode Go request.
12. Only after the registry smoke passes, prepare the upstream branch and PR from the current upstream HEAD, reusing the proven bundle behavior and adapting only packaging, naming, and repository conventions.

The npm release and upstream PR are separate publication actions and require separate explicit approval.

## Upstream and embedded-bundle lifecycle

The embedded bundle in `triss-coworker` is the usable distribution channel while upstream review is pending.

Its focused README links to the upstream proposal once that PR exists and states that the bundle is community-maintained.

If upstream accepts and publishes the official bundle with equivalent behavior, a later Triss release may:

- update the bundle README to recommend the official package;
- document the explicit profile migration command;
- retain the embedded bundle for a documented compatibility window;
- remove the embedded manifest and assets only through a separately reviewed migration plan.

Users migrate explicitly by removing `triss-coworker` from the Harness profile and adding the official bundle to that profile; this does not uninstall any separately installed Triss CLI.

If upstream rejects the package because the behavior belongs in documentation or settings rather than a bundle, the embedded community bundle remains maintained with Triss and its README records the upstream decision without claiming endorsement.

## Deferred Triss integration

This plan intentionally adds no Triss runtime or coder-engine support; Triss is only the npm distribution envelope for the Harness bundle.

The following files and surfaces remain unchanged during bundle implementation and publication:

- `src/coder.js` and all coder engine/provider routing;
- CLI commands, help, completion, status, and config wizard behavior;
- MCP tool schemas and descriptions;
- agent instruction templates and `triss init` output;
- `TRISS_CODER_*`, worker, OpenCode, and Z.AI environment contracts;
- the root package dependency graph; only the `dsh` manifest field and published bundle-file allowlist change.

A later Triss integration plan begins only when all of these facts are true:

1. a registry version of `triss-coworker` containing the bundle is publicly installable;
2. its packed contents and install path are stable;
3. a fresh Harness profile passes the required OpenCode Go and GLM smoke;
4. the intended Harness invocation can satisfy Triss's deny-first command policy, credential isolation, non-interactive execution, output capture, cancellation, and worktree rules;
5. the user explicitly authorizes Triss integration work.

That later plan decides whether DeepSeek Harness is a new coder engine, a user-managed external engine, or an unsupported manual recipe.

This provider bundle must not pre-commit that architectural decision.

## Acceptance criteria

- The implementation is developed in an isolated worktree and preserves the main Triss worktree's unrelated untracked files.
- The only artifact produced by this planning change is this document.
- The bundle ships inside `triss-coworker`; no second Triss-owned npm package, version, or release pipeline exists.
- The bundle is configuration-only and contains no provider transport, endpoint, protocol, or model catalogue duplication.
- Its effective `llm-pi-ai` configuration activates exactly `opencode`, `opencode-go`, and `zai`.
- OpenCode Zen and OpenCode Go both use the credential reference `OPENCODE_API_KEY`.
- Direct Z.AI uses `ZAI_API_KEY` and no automatic `ZHIPU_API_KEY` copying or aliasing occurs.
- Installing the bundle does not change the Harness default provider or model.
- The packed `triss-coworker` tarball retains the existing CLI files, adds only the declared bundle assets, and contains no bundle-specific install-time executable hooks.
- Keyless tests prove composition, provider activation, credential-reference names, override behavior, removal behavior, and unchanged defaults.
- Live acceptance proves one DeepSeek V4 request and one GLM 5.2 request through OpenCode Go, plus one GLM 5.2 request through direct Z.AI when the corresponding configured keys are available.
- A disposable coding task proves Harness tool use through at least one activated route.
- Provider entitlement, billing, quota, and regional errors are surfaced without mutating settings or trying a different provider.
- Root Triss tests and lint remain green without any Triss runtime integration.
- The upstream PR includes its required Agent Note, bilingual durable docs, real composition test, observable keyless snapshot, and current repository gates.
- Neither npm publication nor upstream PR creation occurs without explicit authorization.
- Triss integration remains absent until the published package and engine contract satisfy the deferred-entry gates.

## Validation for this planning change

This document must be checked with:

```bash
git diff --check
git status --short --branch
git diff -- docs/deepseek-harness-provider-bundle-plan.md
```

No package, source, test, lockfile, or runtime configuration change belongs in the planning commit.

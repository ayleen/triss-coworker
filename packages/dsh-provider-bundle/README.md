# triss-dsh-provider-bundle

A configuration-only [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) provider bundle. It activates three provider routes that already exist in the `@earendil-works/pi-ai` catalogue resolved by your Harness installation — no new transport adapter, endpoints, or model metadata are bundled.

## What it does

The bundle replaces the dormant `llm-pi-ai` composition row so these catalogue routes become active:

| Route | Credential reference | Initial acceptance model for resolved `pi-ai@0.82.1` |
| --- | --- | --- |
| `opencode` | `OPENCODE_API_KEY` | `deepseek-v4-flash` |
| `opencode-go` | `OPENCODE_API_KEY` | `deepseek-v4-flash`, `glm-5.2` |
| `zai` | `ZAI_API_KEY` | `glm-5.2` |

The table is release evidence tied to the resolved `pi-ai` version, not a package-owned catalogue. Model availability, billing, quota, and provider policy remain service-owned runtime facts.

The bundle declares only `id` + credential references. Endpoints, protocols, model catalogues, and authentication logic stay owned by `pi-ai`; the bundle never duplicates `baseURL`, `api`, `models`, `headers`, context windows, output limits, reasoning formats, or pricing. It does not change the Harness default provider or model. Both OpenCode routes share one `OPENCODE_API_KEY` reference without copying the secret. Triss's own `ZHIPU_API_KEY` is deliberately not aliased; if you want the same underlying credential in both products, store it under each product's expected reference.

## Prerequisites

- Node `^22.19.0 || >=24.0.0` (verified against the DeepSeek Harness engine range)
- `pnpm` installed and on `PATH` (the `dsh plugin` command forwards to `pnpm`)
- A Harness profile that already includes `@deepseek-ai/dsh-base` (this bundle does not own the runner or UI layer)

Tested with: `@deepseek-ai/dsh` at commit `47f9438`, `@deepseek-ai/dsh-llm-pi-ai@0.1.0-rc.5`, resolved `@earendil-works/pi-ai@0.82.1`. This package installs only into Harness profiles; global installation is unsupported because it would recreate an installation-anchor ambiguity.

## Install

Prerequisites check, then install into a profile whose template boots a one-shot application. **Profile name selects the application template** in DeepSeek Harness: `headless` boots the one-shot CLI application; any other profile name boots the interactive web application, which waits for a browser client forever. If you smoke-test this bundle from a terminal, create or use a `headless` profile:

```bash
pnpm --version
node --version
dsh plugin --profile headless add triss-dsh-provider-bundle@0.35.0
dsh --profile headless --dump-config
```

Removing the bundle never deletes your user settings; in a clean profile with no user `llm-pi-ai` settings and no later activating patch, removal restores the dormant base posture.

## Compatibility evidence

Every acceptance records Node, pnpm, `@deepseek-ai/dsh`, `@deepseek-ai/dsh-llm-pi-ai`, resolved `pi-ai` version + lockfile integrity, and this package's version + tarball integrity. Compatibility is never claimed from the Harness version alone.

Tested tuple (packed-tarball fixture, `dsh plugin` full cycle — add, remove, reinstall):

| Fact | Value |
| --- | --- |
| Node | `v22.23.1` (satisfies `^22.19.0`) |
| pnpm | `9.0.0` (lockfileVersion `9.0`) |
| `@deepseek-ai/dsh` | `0.1.0-rc.6` |
| Profile template | `dsh-headless@0.1.0-rc.6` (bundles: `dsh-base` + `dsh-headless`) |
| This package | `0.35.0` |

Artifact integrity (tarball sha256/sha512) for each release is recorded in the
root repository `CHANGELOG.md` release entry — it cannot be embedded here,
because this README ships inside the tarball it would describe.

The `llm-pi-ai` adapter and its `pi-ai` dependency are supplied by the profile's `dsh-base` bundle, not by this package (the companion declares no dependencies).

## License

MIT — see [LICENSE](./LICENSE).

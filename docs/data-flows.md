# Data flows

Triss has no developer telemetry. It does send data when a user invokes a
network-backed command, and it performs one credential-free passive update
check unless disabled.

| Command or mode | Recipient | Data sent | When | Disable or avoid |
| --- | --- | --- | --- | --- |
| `ask`, `chat`, `write`, `review`, model-backed `fetch` and `commit-msg` | Selected model provider | Prompt plus explicitly selected files, diff, URL content, or other context | On explicit request | Choose an offline/self-hosted provider or do not invoke a model-backed command |
| Integrations | Configured GitHub, GitLab, Jira, Confluence, or Linear service | Query or mutation payload and that service's authentication token | On explicit integration operation | Do not configure or invoke the integration |
| Passive update check | GitHub Releases | Current version and ordinary HTTP metadata; GitHub also receives connection metadata | Automatically when the cache is due | Set `TRISS_UPDATE_CHECK=0` |
| Approved engine setup | Registry/installer endpoint of the selected engine (for example `omp.sh` or the npm registry) | Download request and ordinary connection metadata; no provider or integration credentials are placed in the installer environment | Only on an explicit apply/approved install in the setup wizard; headless runs install nothing without `--install` | Skip the install step in the plan, or run headless without `--install` |
| `triss coder`; model-backed command with any non-direct engine (`TRISS_DEFAULT_ENGINE=opencode`/`opencode2`/`omp`/`crush`) | Selected local engine, then model provider | Task, selected context, engine protocol events, and either the selected raw credential or a proxy token | On explicit engine selection or persisted `TRISS_DEFAULT_ENGINE` | Keep `TRISS_DEFAULT_ENGINE=direct`; or use the verified OpenCode projection. Triss injects and verifies an active primary agent pinned as `default_agent`; its deny-by-default policy has no ambient file, shell, edit, skill, or delegation tools because selected context is supplied in the prompt. `opencode2`, `omp`, and `crush` execute the same non-coder tasks best-effort and attach a warning naming the limitation that is not verified. `--protect-credentials` keeps eligible keys behind the parent-owned proxy; otherwise warnings report raw same-UID exposure. |
| `coder run --engine omp` | Local OMP binary, then the selected model provider | Task, repository/tool context, OMP protocol events, and either one selected raw provider credential (`best_effort_raw`) or a short-lived proxy token (`--protect-credentials`) | On explicit OMP coder request | Do not use OMP; or use protected mode. Worktree isolation and run-private config do not confine the host filesystem. |

Approved engine setup is not developer telemetry and is distinct from the
credential-free passive update check: it runs only inside an explicit,
user-approved setup plan, contacts the endpoint published by the selected
engine's installer, and can execute installer-provided code on the machine
before any model request is made.

Repository content can therefore leave the machine and be processed by a
third-party model provider. Review the provider's retention, training,
residency, and access policies before sending confidential code. Triss cannot
enforce those external policies.

See [PRIVACY.md](https://github.com/ayleen/triss-coworker/blob/main/PRIVACY.md)
for local storage and deletion controls.

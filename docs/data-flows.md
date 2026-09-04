# Data flows

Triss has no developer telemetry. It does send data when a user invokes a
network-backed command, and it performs one credential-free passive update
check unless disabled.

| Command or mode | Recipient | Data sent | When | Disable or avoid |
| --- | --- | --- | --- | --- |
| `ask`, `chat`, `write`, `review`, model-backed `fetch` and `commit-msg` | Selected model provider | Prompt plus explicitly selected files, diff, URL content, or other context | On explicit request | Choose an offline/self-hosted provider or do not invoke a model-backed command |
| Integrations | Configured GitHub, GitLab, Jira, Confluence, or Linear service | Query or mutation payload and that service's authentication token | On explicit integration operation | Do not configure or invoke the integration |
| Passive update check | GitHub Releases | Current version and ordinary HTTP metadata; GitHub also receives connection metadata | Automatically when the cache is due | Set `TRISS_UPDATE_CHECK=0` |
| `triss coder`; model-backed command with a non-`direct` engine | Selected local engine, then model provider | Task, selected context, tool results, and engine protocol events | On explicit engine selection or persisted `TRISS_DEFAULT_ENGINE` | Keep `TRISS_DEFAULT_ENGINE=direct`; or select an approved engine/provider. OpenCode projections request the read-only `researcher` agent but still run as the current OS user. |
| `coder run --engine omp` | Local OMP binary, then the selected model provider | Task, repository/tool context, OMP protocol events, and either one selected raw provider credential (`best_effort_raw`) or a short-lived proxy token (`--protect-credentials`) | On explicit OMP coder request | Do not use OMP; or use protected mode. Worktree isolation and run-private config do not confine the host filesystem. |

Repository content can therefore leave the machine and be processed by a
third-party model provider. Review the provider's retention, training,
residency, and access policies before sending confidential code. Triss cannot
enforce those external policies.

See [PRIVACY.md](https://github.com/ayleen/triss-coworker/blob/main/PRIVACY.md)
for local storage and deletion controls.

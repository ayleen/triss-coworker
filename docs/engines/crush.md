# Crush engine

Crush is a provider-neutral coder engine: any canonical provider
(`openai-compatible`, `zai`, `opencode-zen`, `opencode-go`, `moonshot`,
`kimi-for-coding`) can run on it. Triss projects the selected provider onto a
run-scoped crush config whose `api_key` is a native `$ENV` credential
reference — the real credential or the one-run proxy token never lands in the
JSON.

```bash
triss coder init --engine crush --provider zai
triss coder init --engine crush --provider opencode-go
triss coder run --engine crush "Describe the task"
```

The native provider `type` follows the resolved wire protocol: chat
completions and Anthropic Messages map to crush's native provider types, and
Responses-protocol upstreams ride a bounded chat→responses bridge in the
credential proxy (see below). Persistent role models come from the selected
provider profile. Rerun `coder init` after changing them so the engine
projection remains aligned.

## Isolation and restriction

Crush defaults to worktree isolation. `--restrict` opts into the engine CLI restriction flags; `--no-restrict` disables them for one run. `TRISS_CODER_CRUSH_RESTRICT=1` sets the default. The generated `permissions.run` block remains forward-compatible metadata; the CLI flags are the enforced path for supported versions.

Non-coder model projections (`ask`, `review`, `chat`, …) on crush run
single-agent with the restrict allowlist enabled. Crush's `permissions.run`
config is inert, so restriction relies on the CLI flags; the run reports that
limitation as a warning instead of refusing to execute.

## Credential boundary

Crush defaults to the recommended protected proxy mode: Triss replaces the raw
credential with a run-scoped proxy token and loopback endpoint before spawn.
Version, provider, endpoint, and model projection checks happen before the
credential-bearing child starts. An explicit `--no-protect-credentials`
(CLI flag, MCP boolean `false`, or the persisted `TRISS_PROTECT_CREDENTIALS` /
`TRISS_CODER_PROTECT_CREDENTIALS` tri-state set to `false`) runs crush raw
through the same run-scoped native config with the real selected credential —
a best-effort choice that is warned in the result. An unset value keeps the
protected default.

### chat→responses bridge

Some providers serve specific models over the OpenAI Responses protocol while
crush speaks Chat Completions. In protected mode the loopback credential proxy
translates between the two: model identity, credential, and endpoint pass
through verbatim, and message-only rounds are translated. The bridge is
bounded — any request carrying tool definitions or tool-call history is
refused with a precise error instead of being silently degraded. Use a chat-
or anthropic-protocol model for tool-using runs on this engine.

If engine configuration is stale, rerun:

```bash
triss coder init --engine crush --provider <canonical-id>
```

See [Configuration](../configuration.md) for provider fields and precedence.

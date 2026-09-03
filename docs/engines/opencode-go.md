# OpenCode Go provider

OpenCode Go is the canonical `opencode-go` provider. It shares `OPENCODE_API_KEY` with Zen but owns an independent endpoint and model roles.

```bash
triss coder init --engine opencode --provider opencode-go
triss coder run --engine opencode \
  --model opencode-go/deepseek-v4-flash \
  "Implement the task"
```

## Configuration

| Field | Value |
|---|---|
| Credential | `OPENCODE_API_KEY` |
| Endpoint | `TRISS_OPENCODE_GO_BASE_URL` |
| Main role | `TRISS_OPENCODE_GO_MODEL` |
| Small role | `TRISS_OPENCODE_GO_SMALL_MODEL` |

Initialization fetches the authenticated catalogue. HTTP 401/403, malformed data, an authoritative empty catalogue, and unsupported model transport metadata fail closed. A temporary catalogue failure can use the documented `--allow-unverified` init path only where the CLI explicitly permits it; it never bypasses authentication failures.

Protected execution admits only models with audited transport metadata. OpenAI Chat, OpenAI Responses, and Anthropic Messages projections are selected per model rather than guessed from the provider.

## Account state

A catalogue entry does not prove account entitlement, quota, balance, or regional-hosting opt-in. Triss reports the provider response and never changes account, billing, privacy, or regional settings.

Update roles with canonical fields, then rerun init:

```bash
triss config set TRISS_OPENCODE_GO_MODEL <native-id>
triss config set TRISS_OPENCODE_GO_SMALL_MODEL <native-id>
triss coder init --engine opencode --provider opencode-go
```

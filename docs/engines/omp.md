# Oh My Pi engine

The `omp` engine projects the shared Triss provider runtime into a run-private OMP agent directory. Triss does not mutate the user's persistent OMP configuration.

```bash
triss coder init --engine omp --provider opencode-go
triss coder status
triss coder run --engine omp \
  --model opencode-go/deepseek-v4-flash \
  --effort high \
  "Create result.txt containing OMP_OK"
```

## Provider projection

OMP accepts all six canonical providers:

| Provider | Credential | Projection |
|---|---|---|
| `openai-compatible` | `TRISS_OPENAI_COMPATIBLE_API_KEY` | transient OpenAI-compatible route |
| `zai` | `ZHIPU_API_KEY` | transient OpenAI-compatible route |
| `opencode-zen` | `OPENCODE_API_KEY` | audited transient route or fail-closed |
| `opencode-go` | `OPENCODE_API_KEY` | audited transient route or fail-closed |
| `moonshot` | `MOONSHOT_API_KEY` | transient OpenAI-compatible route |
| `kimi-for-coding` | `KIMI_API_KEY` | transient Anthropic Messages route |

Main and small models come from the selected provider profile; an explicit `--model` overrides only the main role for that run. OMP receives the resolved small role through its native small-model input. Different main/small transports receive separate transient provider entries and separate scoped proxies.

## Runtime isolation

Each invocation receives a fresh `PI_CODING_AGENT_DIR`. Generated `models.yml`, settings, and policy files contain environment indirection or run-scoped proxy tokens, never a persistent provider secret. The configured OMP minimum is raise-only and the capability probe must pass before spawn.

## Sessions and worktrees

```bash
triss coder run --engine omp --session task-a "Remember ALPHA"
triss coder run --engine omp --session task-a "Repeat the remembered value"
triss coder session list --engine omp
```

OMP follows the isolated-worktree default. Use `--no-isolate` only when intentionally running in the current checkout.

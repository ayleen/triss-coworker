# OpenCode Zen provider

OpenCode Zen is the canonical `opencode-zen` provider for the `opencode`, `opencode2`, and `omp` engines.

```bash
triss coder init --engine opencode --provider opencode-zen
triss coder run --engine opencode \
  --model opencode-zen/deepseek-v4-flash-free \
  "Implement the task"
```

## Configuration

| Field | Value |
|---|---|
| Credential | `OPENCODE_API_KEY` |
| Endpoint | `TRISS_OPENCODE_ZEN_BASE_URL` |
| Main role | `TRISS_OPENCODE_ZEN_MODEL` |
| Small role | `TRISS_OPENCODE_ZEN_SMALL_MODEL` |

Zen's catalogue changes over time. Init fetches the authenticated catalogue and selects only supported model ids. Protected mode additionally requires audited protocol/package metadata; an unknown catalogue model is not silently treated as OpenAI Chat.

Free-model data handling can differ from paid services. Review the current [OpenCode Zen terms](https://opencode.ai/docs/zen/) before sending confidential repositories.

## Stale models

If a configured model disappears, Triss reports the stale id and a current replacement when one is available. Update the canonical provider role fields and align `model` / `small_model` in the relevant `opencode.json`, then rerun init. Triss does not silently overwrite an existing user-owned engine file.

```bash
triss config set TRISS_OPENCODE_ZEN_MODEL <native-id>
triss config set TRISS_OPENCODE_ZEN_SMALL_MODEL <native-id>
triss coder init --engine opencode --provider opencode-zen
```

## Security boundary

Each run forwards only `OPENCODE_API_KEY`. Protected execution verifies the model transport, endpoint, effective provider projection, deny-first permissions, plugins, agents, and executable config sources before credential forwarding.

# OpenCode 2 engine

OpenCode 2 is a beta coder engine selected with `--engine opencode2`. It consumes the same canonical provider profiles as the other engines and shares `opencode.json` with OpenCode 1.

```bash
triss coder init --engine opencode2 --provider opencode-zen
triss coder run --engine opencode2 \
  --model opencode-zen/deepseek-v4-flash-free \
  "Implement the task"
```

## Version and capability gate

The installed binary must satisfy the raise-only `TRISS_CODER_OPENCODE2_VERSION` minimum and the required capability probe. Unsupported development/TUI variants fail closed. Detection also verifies that read-only probes leave no resident service.

## Shared configuration

OpenCode 1 and OpenCode 2 share the same engine configuration file. Protected OpenCode 2 requires deny-everything shell permissions; a normal OpenCode 1 allowlist is intentionally rejected at the beta credential boundary. Reinitializing one engine can therefore change whether the shared file is acceptable to the other. Triss reports this explicitly.

OpenCode 2 has no native small-model role in the supported beta. The canonical provider still owns a `smallModel` role for runtime parity, but the OpenCode 2 projection does not silently claim the engine consumed it.

## Preflight

Before reading or forwarding a credential, Triss verifies:

- the final canonical provider/model route;
- exact managed endpoint, package, and credential placeholder;
- absence of unrelated provider definitions;
- model-level transport overrides;
- deny-first permissions for reachable agents;
- plugins, custom tools, agent sources, and other executable configuration;
- a second full audit immediately before the credential-bearing spawn.

Protected runs use transient provider overlays and run-scoped proxy credentials. Best-effort raw mode is explicit and reports its weaker boundary.

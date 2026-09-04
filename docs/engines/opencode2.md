# OpenCode 2 engine

OpenCode 2 is a beta coder engine selected with `--engine opencode2`. It consumes the same canonical provider profiles as the other engines and shares `opencode.json` with OpenCode 1.

```bash
triss coder init --engine opencode2 --provider opencode-zen
triss coder run --engine opencode2 \
  --model opencode-zen/deepseek-v4-flash-free \
  "Implement the task"
```

## Version and capability gate

**Immutable compatibility rule:** Triss never pins OpenCode 2 to one exact
build. It always supports the current qualified version and every newer
parseable version. The built-in floor is currently
`0.0.0-beta-19059`; `TRISS_CODER_OPENCODE2_VERSION` can only raise that floor,
never lower it. A newer version is not rejected merely for being newer.

The lightweight capability probe verifies the required CLI surface before a
credential-bearing run. Unsupported development/TUI channels still fail
closed, and detection verifies that its read-only probes leave no resident
service.

## Reasoning effort and model variants

The supported beta encodes an explicit effort in the runtime model selector:
`provider/model#variant`; it does not expose a separate `--variant` flag.
Keep `--model` on the base canonical model and pass the logical value through
`--effort low|medium|high|xhigh|max`. Triss adds the private suffix only to the
OpenCode 2 subprocess argument, while routing, credential proxy, usage, and
result identities remain on the base model.

Variant availability is model-specific. A compatible CLI supports the selector
grammar, but a selected model may not implement every logical effort. OpenCode
2 returns an explicit `VariantUnavailableError` in that case; Triss does not
silently retry with a different effort. The current beta generates `high` and
`max` for transient OpenAI-compatible GLM-5.2 models. A model value already
containing `#variant` is rejected before engine side effects—use `--effort`
instead.

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

# Crush engine

Crush is a Z.A.I-only coder engine. It consumes the canonical `zai` provider profile and does not accept another provider.

```bash
triss coder init --engine crush --provider zai
triss coder run --engine crush "Describe the task"
```

Persistent Z.A.I role models are `TRISS_ZAI_MODEL` and `TRISS_ZAI_SMALL_MODEL`. Rerun `coder init` after changing them so the engine projection remains aligned.

## Isolation and restriction

Crush defaults to worktree isolation. `--restrict` opts into the engine CLI restriction flags; `--no-restrict` disables them for one run. `TRISS_CODER_CRUSH_RESTRICT=1` sets the default. The generated `permissions.run` block remains forward-compatible metadata; the CLI flags are the enforced path for supported versions.

## Credential boundary

Crush receives only the selected Z.A.I credential. In protected mode, Triss replaces the raw credential with a run-scoped proxy token and loopback endpoint before spawn. Version, provider, endpoint, and model projection checks happen before the credential-bearing child starts.

If engine configuration is stale, rerun:

```bash
triss coder init --engine crush --provider zai
```

See [Configuration](../configuration.md) for provider fields and precedence.

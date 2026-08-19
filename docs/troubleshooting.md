# Troubleshooting

Run `triss status` first; it reports provider and integration readiness without
printing secret values. Then run the affected command with the smallest safe
input and capture the exit code and redacted error.

- Missing model credentials: run `triss config wizard`.
- MCP changes not visible: restart the MCP host after installation or update.
- Coder isolation unavailable: fix the isolation prerequisite. Use the
  best-effort acknowledgement only when its limited boundary is acceptable.
- Update disabled: unset `TRISS_UPDATE_CHECK=0` or invoke `triss update`
  explicitly.

Provider outages, subscription limits, and retention policies are controlled
by the provider.

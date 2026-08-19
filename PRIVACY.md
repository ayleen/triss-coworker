# Privacy

Triss is local software, but selected code, diffs, prompts, and tracker content
may be sent to configured providers. The authoritative outbound-data table is
[docs/data-flows.md](docs/data-flows.md).

Locally, Triss may store configuration, session/result state, update receipts
and cache metadata, and a usage log. The usage log contains counters and an
optional working-directory path, not prompt or file content. Use
`TRISS_USAGE_LOG_CWD=0`, `TRISS_USAGE_LOG=0`, or `triss usage --reset` to
minimize or clear it. Session and result cleanup commands are described by
`triss coder --help`.

Child engines can see the task and context supplied to them and can modify the
authorized worktree. Provider retention, training, residency, and staff access
are governed by the user's agreement with that provider, not by Triss.
